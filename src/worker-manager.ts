/**
 * Spawn trust and safety, plus the fleet's spawn gate.
 *
 * Everything here is fail-closed policy that no dispatch path may bypass:
 *  - trust: `--no-approve --no-extensions --no-skills` (contract flags), so a
 *    leased clone can never inject settings, extensions, skills or a system
 *    prompt into our worker
 *  - tools: the profile allowlist, and nothing else; `report_result` is
 *    mandatory (a worker that cannot report cannot finish)
 *  - budgets: per-job token/cost budget resolved from profile then config, and
 *    handed to the worker's record (soft-gate enforcement is T18)
 *  - env hygiene: job identity in, parent session identity and stray CP_*
 *    inheritance out; briefs are scanned for secret shapes before they are sent
 *  - spawn cap: a ceiling on concurrent workers, with three reviewer-only slots
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	ASK_OPERATOR_TOOL,
	type BudgetConfig,
	DEFAULT_BUDGET_CONFIG,
	type Delivery,
	type JobKind,
	type CpEventKind,
	type Role,
	terminatingToolForRole,
	type ThinkingLevel,
	WORKER_FORBIDDEN_FLAGS,
	WORKER_REQUIRED_FLAGS,
	type WorkerProfile,
} from "./contracts.ts";
import { assertNotDraining } from "./drain.ts";
import { PARENT_BUILTIN_TOOLS } from "./session-tools.ts";
import { ASKING_ROLES, type QuestionRelay } from "./questions.ts";
import { SECRET_PATTERNS } from "./secret-patterns.ts";
import {
	activePackagesForRole,
	type DetectedWorkerPackages,
	NO_DETECTED_WORKER_PACKAGES,
	type OptionalWorkerPackages,
	type WorkerPackageResolution,
} from "./worker-packages.ts";
import {
	buildWorkerArgs,
	type WorkerDialogAnswer,
	type WorkerDialogRequest,
	WorkerProcess,
	type WorkerSpawnOptions,
} from "./worker-process.ts";

/** Why a spawn was refused; the message text is unchanged, the code is for callers that branch (cp_dispatch queues `spawn_cap`). */
export type SpawnRefusalCode = "spawn_cap" | "review_reserve" | "closing" | "duplicate";

export class SpawnSafetyError extends Error {
	readonly code?: SpawnRefusalCode;
	constructor(message: string, options?: { code?: SpawnRefusalCode }) {
		super(message);
		if (options?.code !== undefined) this.code = options.code;
	}
}

/**
 * The terminating tool a role must hold — and the ones it must not. Exactly
 * one per role: an implementer cannot emit a verdict, a reviewer cannot emit a
 * job envelope.
 */
export const TERMINATING_TOOLS: readonly string[] = Object.freeze(["report_result", "report_verdict"]);

/**
 * The one non-terminating tool the parent grants at spawn time (T31).
 *
 * Defined in `src/contracts.ts` and re-exported here, where every caller has
 * always imported it: the wedged-call detector needs the same name (an open
 * `ask_operator` call is a human thinking, not a wedge — cp-ft3d) and must not
 * import the spawn path to get it.
 */
export { ASK_OPERATOR_TOOL };

/** Parent-session facts a worker must not inherit. */
export const STRIPPED_ENV_KEYS: readonly string[] = Object.freeze([
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_MODEL",
	"PI_PROVIDER",
	"PI_REASONING_LEVEL",
	/** A worker's beads database comes only from dispatch (the project's own tracker), never the parent's environment. */
	"BEADS_DIR",
	"BEADS_DB",
]);

/**
 * A worker must be structurally incapable of hanging on an editor or a pager.
 * `timeout` does not exist on this machine (BSD userland, no coreutils on
 * PATH), so a worker cannot defensively bound a command that might open one —
 * avoiding the hang is the only strategy available, and it belongs where the
 * process is constructed, not in a brief or as guidance a worker might skip.
 *
 *  - GIT_EDITOR / EDITOR / VISUAL = true: accepts whatever default text is
 *    already staged (e.g. a rebase's default commit message) instead of
 *    opening an interactive editor that blocks forever on stdin.
 *  - GIT_PAGER / PAGER = cat: paginated output (`git log`, `git diff`, ...)
 *    cannot block on a pager waiting for a keypress.
 *  - GIT_TERMINAL_PROMPT = 0: git never blocks asking for credentials.
 *
 * Applied after the inherited parent environment and before any caller-supplied
 * `extra`, so a test can still override it, but nothing upstream of this
 * function can leave it unset.
 */
export const NONINTERACTIVE_WORKER_ENV: Readonly<Record<string, string>> = Object.freeze({
	GIT_EDITOR: "true",
	EDITOR: "true",
	VISUAL: "true",
	GIT_PAGER: "cat",
	PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
});

export interface JobIdentity {
	jobId: string;
	kind: JobKind;
	delivery: Delivery;
	/** Set by the manager from the profile; decides the terminating tool. */
	role?: Role;
	/** Absolute `state/runs/<job-id>` — where the worker writes its envelope. */
	runDir: string;
	worktree: string;
	artifactPath?: string;
	/** Set by the manager (T31): this role may ask, and an operator is attached. */
	mayAskOperator?: boolean;
}

export interface JobBudget {
	tokens: number;
	cost_usd: number;
}

/**
 * A budget config the caller may hand over as a live value, or as a getter
 * that re-reads it (e.g. from `data/budgets.json`) on every call. Anything
 * that spawns or sends into a running job must accept the latter: a value
 * captured once at construction is the exact staleness bug this type exists
 * to rule out (cp-sr5) — a raise made after the parent started would
 * otherwise sit on disk, unread, until the parent restarted.
 */
export type BudgetSource = BudgetConfig | (() => BudgetConfig);

export function resolveBudgetSource(source: BudgetSource | undefined): BudgetConfig {
	if (source === undefined) return DEFAULT_BUDGET_CONFIG;
	return typeof source === "function" ? source() : source;
}

/**
 * Per-job budget: the profile may only be STRICTER than the fleet config.
 * A profile asking for more than the config allows is clamped, loudly in the
 * returned value (the caller records it), never silently expanded.
 */
export function resolveJobBudget(profile: WorkerProfile, config: BudgetConfig = DEFAULT_BUDGET_CONFIG): JobBudget {
	const wanted = profile.frontmatter.budget ?? {};
	const tokens = Math.min(wanted.tokens ?? config.per_job_tokens, config.per_job_tokens);
	const cost = Math.min(wanted.cost_usd ?? config.per_job_cost_usd, config.per_job_cost_usd);
	return { tokens, cost_usd: cost };
}

export interface BudgetClamp {
	tokens: boolean;
	cost: boolean;
}

/**
 * Did the config win the min() in `resolveJobBudget`, clamping what the
 * profile actually asked for? `resolveJobBudget` returns only the winning
 * numbers on purpose (a caller that wants the stricter value should not have
 * to unpick which side supplied it) — this is the separate, explicit answer
 * to "was anything actually clamped", so a clamp can be surfaced instead of
 * silently taking effect (cp-sr5).
 */
export function detectBudgetClamp(profile: WorkerProfile, config: BudgetConfig = DEFAULT_BUDGET_CONFIG): BudgetClamp {
	const wanted = profile.frontmatter.budget ?? {};
	return {
		tokens: (wanted.tokens ?? config.per_job_tokens) > config.per_job_tokens,
		cost: (wanted.cost_usd ?? config.per_job_cost_usd) > config.per_job_cost_usd,
	};
}

/**
 * Briefs are model input and end up in a session file on disk. A secret in a
 * brief is a leak with a long half-life, so the send fails closed.
 *
 * The refusal names which pattern matched and the 1-indexed line it matched
 * on — never the matched text itself. That is enough for whoever wrote the
 * brief to find and fix the line without anyone (the parent included) reading
 * the body back (cp-n7w): a line number is a coordinate, not content.
 */
export function assertBriefIsSafe(brief: string, source = "brief"): void {
	const found = SECRET_PATTERNS.map((pattern) => {
		const match = pattern.re.exec(brief);
		if (!match) return undefined;
		const line = brief.slice(0, match.index).split("\n").length;
		return `${pattern.name} (line ${line})`;
	}).filter((entry): entry is string => entry !== undefined);
	if (found.length > 0) {
		throw new SpawnSafetyError(
			`${source} appears to contain ${found.join(", ")} — briefs never carry credentials. Pass secrets through the worker environment instead.`,
		);
	}
}

/** The tool allowlist actually passed to `pi --tools`. */
export function resolveWorkerTools(profile: WorkerProfile, options: { mayAskOperator?: boolean } = {}): string[] {
	const tools = [...profile.frontmatter.tools];
	const required = terminatingToolForRole(profile.frontmatter.role);
	// T31: `ask_operator` is granted by the parent per spawn, never by a profile
	// on disk — the tool only exists in the worker when a human is attached, and a
	// profile cannot know that. Listing it in a profile is a mistake we name.
	if (tools.includes(ASK_OPERATOR_TOOL)) {
		throw new SpawnSafetyError(
			`profile ${profile.frontmatter.name} lists ${ASK_OPERATOR_TOOL}; the parent grants it per spawn (only when an operator is attached), so remove it from the profile`,
		);
	}
	if (options.mayAskOperator) tools.push(ASK_OPERATOR_TOOL);
	if (!tools.includes(required)) {
		throw new SpawnSafetyError(
			`profile ${profile.frontmatter.name} (role ${profile.frontmatter.role}) must include ${required} in tools — a worker that cannot report cannot finish a job`,
		);
	}
	const wrong = tools.filter((tool) => TERMINATING_TOOLS.includes(tool) && tool !== required);
	if (wrong.length > 0) {
		throw new SpawnSafetyError(
			`profile ${profile.frontmatter.name} (role ${profile.frontmatter.role}) grants ${wrong.join(", ")}; a role holds exactly one terminating tool (${required})`,
		);
	}
	if (profile.frontmatter.readOnly === true) {
		const writers = tools.filter((tool) => ["write", "edit", "apply_patch", "multi_edit", "ast_grep_replace", "lens_diagnostic_mark", "replace", "insert", "undo_last_change"].includes(tool));
		if (writers.length > 0) {
			throw new SpawnSafetyError(
				`profile ${profile.frontmatter.name} is readOnly but grants ${writers.join(", ")}`,
			);
		}
	}
	return tools;
}

/**
 * Worker environment: job identity in, parent identity out.
 * Provider credentials are inherited on purpose — the worker calls the model.
 */
export function workerEnvironment(
	identity: JobIdentity,
	options: { home: string; parentEnv?: NodeJS.ProcessEnv; extra?: NodeJS.ProcessEnv } = { home: "" },
): NodeJS.ProcessEnv {
	const parentEnv = options.parentEnv ?? process.env;
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parentEnv)) {
		if (STRIPPED_ENV_KEYS.includes(key)) continue;
		// Never inherit another job's identity.
		if (key.startsWith("CP_")) continue;
		env[key] = value;
	}
	Object.assign(env, NONINTERACTIVE_WORKER_ENV);
	env.CP_HOME = options.home;
	env.CP_JOB_ID = identity.jobId;
	env.CP_KIND = identity.kind;
	env.CP_DELIVERY = identity.delivery;
	env.CP_RUN_DIR = identity.runDir;
	env.CP_WORKTREE = identity.worktree;
	if (identity.role) env.CP_ROLE = identity.role;
	if (identity.artifactPath) env.CP_ARTIFACT_PATH = identity.artifactPath;
	// T31: the ask tool exists only when the parent both allows this role to ask
	// AND has a human attached. A worker that cannot reach an operator must never
	// be handed a tool that says it can.
	if (identity.mayAskOperator) env.CP_ASK_OPERATOR = "1";
	return { ...env, ...(options.extra ?? {}) };
}

/**
 * Self-check on the final argv. This exists so a future refactor cannot quietly
 * drop a trust flag: if the policy is not in the argv, nothing spawns.
 */
export function assertTrustPolicy(args: readonly string[]): void {
	for (const flag of WORKER_REQUIRED_FLAGS) {
		if (!args.includes(flag)) {
			throw new SpawnSafetyError(`worker argv is missing required trust flag ${flag}`);
		}
	}
	for (const flag of WORKER_FORBIDDEN_FLAGS) {
		if (args.includes(flag)) {
			throw new SpawnSafetyError(`worker argv contains forbidden flag ${flag}`);
		}
	}
}

/** Does the leased clone carry project-local config we are refusing to load? */
export function untrustedResources(worktree: string): string[] {
	const candidates = [
		".pi/settings.json",
		".pi/extensions",
		".pi/skills",
		".pi/prompts",
		".pi/themes",
		".pi/SYSTEM.md",
		".pi/APPEND_SYSTEM.md",
		".agents/skills",
	];
	return candidates.filter((candidate) => existsSync(join(worktree, candidate)));
}

export interface SpawnPlan {
	args: string[];
	env: NodeJS.ProcessEnv;
	tools: string[];
	budget: JobBudget;
	/**
	 * Whether the fleet config clamped what the profile asked for (cp-sr5). Not
	 * a failure — the clamp is documented policy — but a caller that dispatches
	 * silently on a clamped budget is the exact defect this exists to prevent:
	 * the dispatcher logs it as an event so the operator sees it, not just the
	 * winning number.
	 */
	budgetClamp: BudgetClamp;
	/** Project-local config found in the clone and deliberately not loaded. */
	refusedResources: string[];
	/** Profile tools with no builtin, reporter, or activated package provider. */
	unresolvedTools?: string[];
	/** Why optional packages are missing from this spawn (pi could not resolve them, or had not yet); absent when resolved. */
	packagesError?: string;
}

export interface SpawnRequest {
	identity: JobIdentity;
	/**
	 * Registry key for this worker slot. Defaults to the job id, which is the
	 * one-worker-per-job rule. A gate reviewer (T20) reviews a job that may still
	 * have a live planner, so it takes a distinct key (`<job-id>#gate-<n>`)
	 * while keeping the job's identity in its environment.
	 */
	key?: string;
	profile: WorkerProfile;
	/** Resolved model id (`provider/model-id`) from routing. */
	model: string;
	/**
	 * Effort level from the routing decision (cp-eff). Absent means "use the
	 * profile's": a caller that did not decide must not silently reset it.
	 */
	thinking?: ThinkingLevel;
	/** The first brief; scanned for secrets before it can be sent. */
	brief?: string;
	sessionDir?: string;
	sessionFile?: string;
	sessionName?: string;
	extensions?: readonly string[];
	extraArgs?: readonly string[];
	parentEnv?: NodeJS.ProcessEnv;
	extraEnv?: NodeJS.ProcessEnv;
}

export interface WorkerManagerOptions {
	/** Command post home. */
	home: string;
	/** Path to the worker-reporter extension entry point. */
	workerReporterPath: string;
	/**
	 * A live value or a getter (cp-sr5). Pass a getter that re-reads
	 * `data/budgets.json` so a raise takes effect on the very next spawn or
	 * send — not only after the parent process restarts.
	 */
	budget?: BudgetSource;
	piBin?: string;
	parentEnv?: NodeJS.ProcessEnv;
	/** Injected for tests; production uses WorkerProcess.spawn. */
	spawnFn?: (options: WorkerSpawnOptions) => WorkerProcess;
	/**
	 * Operator questions (T31). When absent, worker dialogs keep failing closed
	 * exactly as they did before: the manager is the only place that decides a
	 * worker may reach a human, and it decides per role.
	 */
	questions?: QuestionRelay;
	/**
	 * Optional user-level packages this home has installed, already detected by
	 * the caller (`resolveWorkerPackages()`), keyed by package name, or the
	 * pending `tryResolveWorkerPackages()` — every spawn path awaits `ready()`
	 * first, so no worker spawns in the window before it settles. Absent means
	 * none: a home with neither installed spawns exactly the argv it spawned
	 * before, with no added flags and no warning (cp-5hui).
	 *
	 * This is **availability**. Which of them a given worker loads is decided
	 * per role and per profile at plan/spawn time (`activePackagesForRole`), so
	 * an installed package is not an activated one.
	 */
	optionalPackages?: DetectedWorkerPackages | Promise<WorkerPackageResolution>;
	/** Run-log sink for spawn-time markers (`worker_packages_unresolved`); absent: not logged. */
	recordEvent?: (jobId: string, kind: CpEventKind, payload: Record<string, unknown>) => void;
}

export interface ManagedWorker {
	/** The registry key (job id, unless the caller named a slot). */
	key: string;
	jobId: string;
	worker: WorkerProcess;
	plan: SpawnPlan;
	model: string;
	profile: string;
	startedAt: number;
}

/**
 * The drain projection: "N workers, M busy". Deliberately tiny and free of
 * judgement — `src/status.ts` renders it, a broker reads it, and neither of
 * them is told what to do about it.
 */
export interface DrainProjection {
	active: number;
	/** Fleet keys of the workers mid-turn, sorted. Empty means drained. */
	busy: string[];
}

export class WorkerManager {
	readonly #options: WorkerManagerOptions;
	readonly #workers = new Map<string, ManagedWorker>();
	/** Set by `shutdownAll`: a closing manager spawns nothing, ever again. */
	#closing = false;
	/** Slots held for a dispatch/revive between makeRoom and its spawn. */
	readonly #reserved = new Set<string>();
	/** Keys mid-shutdown → the shutdown's promise. */
	readonly #stoppingDone = new Map<string, Promise<void>>();
	readonly #slotFree = new Set<() => void>();

	/** The settled package resolution; a still-pending one reads as an error, never as "nothing installed". */
	#packages: WorkerPackageResolution;
	#packagesPending: Promise<void> | undefined;

	constructor(options: WorkerManagerOptions) {
		this.#options = options;
		const packages = options.optionalPackages;
		if (packages instanceof Promise) {
			this.#packages = { packages: NO_DETECTED_WORKER_PACKAGES, error: "optional worker packages were still resolving" };
			this.#packagesPending = packages.then(
				(resolved) => { this.#packages = resolved; },
				(error: unknown) => { this.#packages = { packages: NO_DETECTED_WORKER_PACKAGES, error: String(error) }; },
			).finally(() => { this.#packagesPending = undefined; });
		} else {
			this.#packages = { packages: packages ?? NO_DETECTED_WORKER_PACKAGES };
		}
	}

	/** Resolves once optional packages are known; every spawn path awaits it (cached: instant after the first). */
	async ready(): Promise<void> {
		await this.#packagesPending;
	}

	/**
	 * Resolved fresh on every read (cp-sr5): when the caller handed a getter,
	 * this calls it now rather than returning whatever was true when the
	 * manager was constructed. That is what makes a mid-session raise to
	 * `data/budgets.json` reach the very next spawn or send.
	 */
	get budgetConfig(): BudgetConfig {
		return resolveBudgetSource(this.#options.budget);
	}

	get spawnCap(): number {
		return this.budgetConfig.spawn_cap;
	}

	/** Live workers this manager owns (dead ones are dropped on observed close). */
	get active(): ManagedWorker[] {
		return [...this.#workers.values()];
	}

	get(key: string): ManagedWorker | undefined {
		return this.#workers.get(key);
	}

	/**
	 * May this parent die now? (cp-epy2 §4.2 item 3.)
	 *
	 * Read-only, and an **observation, never a verdict**: `active` is the workers
	 * this manager owns, `busy` is the subset that is between `agent_start` and
	 * its matching `agent_settled`. A worker with an envelope in is idle by
	 * definition, so `busy` empty is what "drained" means — an episodic parent may
	 * shut down, leaving `held`/`waiting` records that reconcile classifies
	 * `revivable`. Nothing here decides that; it hands over the fact.
	 *
	 * The keys are the fleet keys (a job id for an ordinary job), so a drain line
	 * names the job an operator would `/watch`.
	 */
	quiesce(): DrainProjection {
		this.reap();
		const workers = [...this.#workers.values()];
		return {
			active: workers.length,
			busy: workers.filter((managed) => managed.worker.busy).map((managed) => managed.key).sort(),
		};
	}

	/** May this role ask a human, and is there a human? Both, or the tool is off. */
	#mayAsk(role: Role): boolean {
		const relay = this.#options.questions;
		return relay !== undefined && relay.hasOperator && ASKING_ROLES.includes(role);
	}

	/**
	 * Optional packages this home has. Absent is the ordinary case and is
	 * silent: nothing is added to the argv and nothing is logged (cp-5hui).
	 */
	#optionalPackages(profile: WorkerProfile): OptionalWorkerPackages {
		return activePackagesForRole(
			this.#packages.packages,
			profile.frontmatter.role,
			profile.frontmatter.packages,
		);
	}

	/** Pure: everything the spawn will use, with every policy check applied. */
	plan(request: SpawnRequest): SpawnPlan {
		// cur.3.1: planner questions are a blocked envelope, not ask_operator.
		// The dialog relay stays for the plan-review console until that ticket lands.
		const optional = this.#optionalPackages(request.profile);
		// An activated package's own tools (pi-web-access) join the profile's allowlist.
		const tools = resolveWorkerTools({
			...request.profile,
			frontmatter: { ...request.profile.frontmatter, tools: [...new Set([...request.profile.frontmatter.tools, ...(optional.tools ?? [])])] },
		});
		const available = new Set([...PARENT_BUILTIN_TOOLS, terminatingToolForRole(request.profile.frontmatter.role), ...(optional.tools ?? [])]);
		const unresolvedTools = tools.filter((tool) => !available.has(tool));
		const extraArgs = [...(request.extraArgs ?? []), ...(optional.flags ?? [])];
		if (request.brief !== undefined) {
			assertBriefIsSafe(request.brief, `brief for ${request.identity.jobId}`);
		}
		const budgetConfig = this.budgetConfig;
		const budget = resolveJobBudget(request.profile, budgetConfig);
		const budgetClamp = detectBudgetClamp(request.profile, budgetConfig);
		// Role always comes from the profile: the caller cannot mislabel a worker.
		const role = request.profile.frontmatter.role;
		const identity: JobIdentity = {
			...request.identity,
			role,
		};
		const env = workerEnvironment(identity, {
			home: this.#options.home,
			parentEnv: request.parentEnv ?? this.#options.parentEnv,
			extra: { ...optional.env, ...request.extraEnv },
		});
		const spawnOptions: WorkerSpawnOptions = {
			cwd: request.identity.worktree,
			model: request.model,
			tools,
			extensions: [this.#options.workerReporterPath, ...(request.extensions ?? []), ...optional.extensions],
			...(optional.skills.length > 0 ? { skills: optional.skills } : {}),
			env,
			...(request.thinking ?? request.profile.frontmatter.thinking
				? { thinking: (request.thinking ?? request.profile.frontmatter.thinking) as ThinkingLevel }
				: {}),
			...(request.sessionFile ? { sessionFile: request.sessionFile } : {}),
			...(request.sessionDir ? { sessionDir: request.sessionDir } : {}),
			...(request.sessionName ? { sessionName: request.sessionName } : {}),
			appendSystemPrompt: request.profile.systemPrompt,
			...(extraArgs.length > 0 ? { extraArgs } : {}),
		};
		const args = buildWorkerArgs(spawnOptions);
		assertTrustPolicy(args);
		return {
			args,
			env,
			tools,
			budget,
			budgetClamp,
			refusedResources: untrustedResources(request.identity.worktree),
			...(unresolvedTools.length ? { unresolvedTools } : {}),
			...(this.#packages.error ? { packagesError: this.#packages.error } : {}),
		};
	}

	/**
	 * Spawn a worker for a job. Fails closed on the spawn cap and on a job that
	 * already has a live worker (promote instead of spawning a second one).
	 */
	spawn(request: SpawnRequest): ManagedWorker {
		this.reap();
		const jobId = request.identity.jobId;
		const key = request.key ?? jobId;
		if (this.#closing) {
			// A worker stopped by shutdown looks like a death; bounded recovery would
			// otherwise revive it after the snapshot below and orphan a live child.
			throw new SpawnSafetyError(`job ${key}: the worker manager is shutting down — nothing is spawned during shutdown`, { code: "closing" });
		}
		// Backstop for every process start (dispatch, revive, recovery, reviewers): a drain spawns nothing.
		assertNotDraining(this.#options.home, `worker process for ${key}`);
		const existing = this.#workers.get(key);
		if (existing) {
			throw new SpawnSafetyError(
				`job ${key} already has a live worker (pid ${existing.worker.pid ?? "?"}) — promote it instead of spawning a second worker`,
				{ code: "duplicate" },
			);
		}
		const cap = this.spawnCap;
		const reviewer = request.profile.frontmatter.role === "gate-reviewer";
		// Held authors keep their process for repairs; reviews must still be able to start.
		const limit = cap + (reviewer ? 3 : 0);
		// A slot reserved for another job (HeldRelease.makeRoom) counts as taken.
		const taken = this.#workers.size + this.#reservedFor(key);
		if (taken >= limit) {
			const reason = reviewer
				? "review reserve exhausted"
				: "spawn cap reached";
			const next = reviewer
				? "The three extra review slots are full. Finish a review first."
				: "Three extra slots are reserved for gate-reviewer (review/gate/quality). Finish or tear down a job first.";
			const reserved = this.#reservedFor(key) > 0 ? `, reserved for ${[...this.#reserved].filter((k) => k !== key).join(", ")}` : "";
			throw new SpawnSafetyError(
				`${reason} (${taken}/${limit} workers): ${[...this.#workers.keys()].join(", ")}${reserved}. ${next}`,
				{ code: reviewer ? "review_reserve" : "spawn_cap" },
			);
		}
		const plan = this.plan(request);
		if (plan.packagesError || plan.unresolvedTools) this.#options.recordEvent?.(jobId, "worker_packages_unresolved", {
			key,
			error: [plan.packagesError, ...(plan.unresolvedTools ? [
				`profile ${request.profile.frontmatter.name} tools resolve to nothing: ${plan.unresolvedTools.join(", ")}; enable/install their worker package or correct the profile, then restart the parent`,
			] : [])].filter(Boolean).join("; "),
		});
		const spawnFn = this.#options.spawnFn ?? ((options: WorkerSpawnOptions) => WorkerProcess.spawn(options));
		const role = request.profile.frontmatter.role;
		const relay = this.#options.questions;
		// The relay is wired only for a role that may ask. Every other worker keeps
		// the blanket cancel, so "an implementer cannot stop to ask" is transport
		// policy rather than a hope about prompts.
		const onDialog =
			relay && this.#mayAsk(role)
				? async (dialog: WorkerDialogRequest): Promise<WorkerDialogAnswer> =>
						(await relay.handle({ jobId, role, request: dialog })).answer
				: undefined;
		const optional = this.#optionalPackages(request.profile);
		const worker = spawnFn({
			cwd: request.identity.worktree,
			model: request.model,
			tools: plan.tools,
			...(onDialog ? { onDialog } : {}),
			extensions: [this.#options.workerReporterPath, ...(request.extensions ?? []), ...optional.extensions],
			...(optional.skills.length > 0 ? { skills: optional.skills } : {}),
			env: plan.env,
			...(request.thinking ?? request.profile.frontmatter.thinking
				? { thinking: (request.thinking ?? request.profile.frontmatter.thinking) as ThinkingLevel }
				: {}),
			...(request.sessionFile ? { sessionFile: request.sessionFile } : {}),
			...(request.sessionDir ? { sessionDir: request.sessionDir } : {}),
			...(request.sessionName ? { sessionName: request.sessionName } : {}),
			appendSystemPrompt: request.profile.systemPrompt,
			...(optional.flags || request.extraArgs
				? { extraArgs: [...(request.extraArgs ?? []), ...(optional.flags ?? [])] }
				: {}),
			...(this.#options.piBin ? { piBin: this.#options.piBin } : {}),
		});
		const managed: ManagedWorker = {
			key,
			jobId,
			worker,
			plan,
			model: request.model,
			profile: request.profile.frontmatter.name,
			startedAt: Date.now(),
		};
		this.#workers.set(key, managed);
		// The reserved slot (if any) is now this worker's: consumed, no notify.
		this.#reserved.delete(key);
		// The registry follows observed reality, not intent.
		void worker.closed.then(() => {
			if (this.#workers.get(key) !== managed) return;
			this.#workers.delete(key);
			this.notifySlotFree();
		});
		return managed;
	}

	/** Drop records whose process is already known dead. */
	reap(): void {
		for (const [key, managed] of [...this.#workers]) {
			if (!managed.worker.alive) this.#workers.delete(key);
		}
	}

	/** True from the first `shutdownAll`: closes after this are the parent stopping, not deaths. */
	get closing(): boolean {
		return this.#closing;
	}

	/**
	 * Graceful shutdown of one worker slot; resolves with the observed exit. The key is
	 * `stopping` from the synchronous prefix until the exit, so nothing selects it (HeldRelease)
	 * or delivers into it (Sender awaits `whenStopped`) in between.
	 */
	shutdown(key: string): Promise<void> {
		const managed = this.#workers.get(key);
		if (!managed) return Promise.resolve();
		const pending = this.#stoppingDone.get(key);
		if (pending) return pending;
		const done = (async () => {
			try {
				// Deferred one microtask: a synchronous throw from shutdown() must reach `finally` only after
				// `#stoppingDone.set` below, or the key would stay `stopping` forever.
				await Promise.resolve();
				await managed.worker.shutdown();
			} finally {
				this.#stoppingDone.delete(key);
				// The close handler may have dropped it (and notified) first; notify once either way.
				if (this.#workers.get(key) === managed) {
					this.#workers.delete(key);
					this.notifySlotFree();
				}
			}
		})();
		this.#stoppingDone.set(key, done);
		return done;
	}

	/** True while `shutdown(key)` is awaiting the worker's exit. */
	stopping(key: string): boolean {
		return this.#stoppingDone.has(key);
	}

	/** The in-flight shutdown of `key`, or undefined when it is not stopping. */
	whenStopped(key: string): Promise<void> | undefined {
		return this.#stoppingDone.get(key);
	}

	/** Slots reserved by `reserve` and not yet consumed or released. */
	get reserved(): number {
		return this.#reserved.size;
	}

	/** Reservations held for keys other than `key` (a key's own reservation is its slot). */
	#reservedFor(key: string): number {
		return this.#reserved.size - (this.#reserved.has(key) ? 1 : 0);
	}

	/**
	 * Hold one slot for `key` (HeldRelease.makeRoom only). The returned release is
	 * idempotent: its first call frees the slot and notifies; a successful
	 * `spawn(key)` consumes the slot silently instead.
	 */
	reserve(key: string): () => void {
		if (this.#reserved.has(key)) throw new SpawnSafetyError(`job ${key} already holds a reserved slot`, { code: "duplicate" });
		this.#reserved.add(key);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.#reserved.delete(key)) this.notifySlotFree();
		};
	}

	/** Subscribe to "a slot may have freed"; returns the unsubscribe. */
	onSlotFree(listener: () => void): () => void {
		this.#slotFree.add(listener);
		return () => {
			this.#slotFree.delete(listener);
		};
	}

	/** Tell every slot-free listener; a throwing listener is recorded, never rethrown. */
	notifySlotFree(): void {
		for (const listener of [...this.#slotFree]) {
			try {
				listener();
			} catch (error) {
				this.#options.recordEvent?.("", "failure", { reason: `slot-free listener failed: ${(error as Error).message}` });
			}
		}
	}

	/** session_shutdown cleanup: never leave orphaned children behind. */
	async shutdownAll(): Promise<void> {
		this.#closing = true;
		await Promise.all([...this.#workers.keys()].map((key) => this.shutdown(key)));
	}
}
