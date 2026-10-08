/**
 * `cp_dispatch` — the whole path from a job id to a working worker.
 *
 *   ledger check -> routing (probe BEFORE the lease) -> preflight -> lease ->
 *   branch = job id -> preflight on the worktree -> brief -> spawn -> RPC prompt
 *   -> fleet record -> ledger claim
 *
 * Two properties are worth more than the code that produces them:
 *
 *  - **No orphans.** The model is probed and the preflight runs before a lease
 *    exists. Anything that fails *after* the lease releases it, and the fleet
 *    never records a job whose worker did not start.
 *  - **The receipt is a fact.** Delivery is an id-correlated RPC response, so
 *    `receipt: "accepted"` means pi took the message — not that a pane looked
 *    busy. (Command-post's `unconfirmed`/`unknown` receipts are gone.)
 *
 * This module composes; the policy lives in the modules it calls (ledger T9,
 * projects T10, leases T11, preflight T12, routing T13, spawn safety T7).
 */
import { captureCheckpoint, checkpointRef, deleteCheckpoint } from "./checkpoint-ref.ts";
import { referencedMaterial } from "./task-references.ts";
import { repoMap } from "./repo-map.ts";
import type { CommandRunner } from "./merge-ask.ts";
import type { CapacityReader } from "./capacity.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	JOB_ID_PATTERN,
	type Delivery,
	type FleetRecord,
	isoTimestamp,
	type JobKind,
	type JobRouting,
	type Risk,
	type Role,
	type RoutingConfig,
	type RoutingDecision,
	type Scope,
	type ThinkingLevel, type Usage,
	EMPTY_USAGE,
	type JobHardBounds,
	LAYOUT, paths,
	type WorkerProfile,
} from "./contracts.ts";
import { type HardBoundsWatch, resolveJobHardBounds } from "./bounds.ts";
import type { FailureMonitor } from "./failures.ts";
import type { FleetStore } from "./fleet.ts";
import type { EnvelopeIntake } from "./intake.ts";
import type { LeaseManager } from "./leases.ts";
import type { SettleWatcher } from "./settle.ts";
import { type Job, type Ledger, requireJobLabels } from "./ledger.ts";
import { formatPreflight, type Preflight, type PreflightResult } from "./preflight.ts";
// The routing-input resolution lives with the other intake heuristics
// (`inferScopeAndRisk`) in pipeline.ts, because the pipeline needs it too and a
// value import in both directions would be a runtime cycle. It is re-exported
// below so `src/dispatch.ts` stays the import path every caller already uses.
import { routingRecord, type SuppliedBy } from "./pipeline.ts";
import { assembleBrief, loadProfile, profileForRole, readBriefTemplate } from "./profiles.ts";
import type { ProjectRegistry } from "./projects.ts";
import { formatRoutingDecision, type ModelProbe, resolveWithCapacity, RoutingError } from "./routing.ts";
import type { RunRecorder } from "./run-artifacts.ts";
import { RunRegistry } from "./runs.ts";
import type { WorkerManager } from "./worker-manager.ts";
import type { WorkerProcess } from "./worker-process.ts";
import { type DepsPorts, prepareNodeDeps } from "./worktree-deps.ts";
import type { MandateStore } from "./mandate.ts";
import { MandateError, scheduleRecord } from "./mandate-accounting.ts";
import { watchOuterProviderRetry } from "./provider-retry.ts";
import type { PipelineRecordedRisk } from "./risk-warning.ts";
import { composeRoutingInputs, riskGate } from "./dispatch-inputs.ts";
import { ScriptDispatcher, type ScriptDispatchResult, type ScriptPreview } from "./script-dispatch.ts";

/** A git invocation, injectable so the branch paths are testable without a repo. */
export type GitRunner = (
	cwd: string,
	args: readonly string[],
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export class DispatchError extends Error {
	readonly result: PreflightResult | undefined;
	constructor(message: string, result?: PreflightResult) {
		super(message);
		this.result = result;
	}
}

/** Refused only because open blockers remain: `cp_dispatch` arms it (src/dependency-dispatch.ts). */
export class BlockedDispatchError extends DispatchError {
	readonly blockers: string[];
	constructor(message: string, blockers: string[]) {
		super(message);
		this.blockers = blockers;
	}
}

export interface WorkerObserverOptions {
	recorder: RunRecorder;
	worker: WorkerProcess;
	jobId: string;
	/** When present, the worker is watched for its terminating report. */
	intake?: EnvelopeIntake;
	/** When present, an observed close without an envelope is classified. */
	failures?: FailureMonitor;
	/**
	 * When present, a settle with no envelope behind it gets exactly one prompt
	 * to file the report before anything is recorded (cp-settle-without-report).
	 */
	settle?: SettleWatcher;
	/** When present, wall-clock and tool-call caps are enforced on this worker. */
	bounds?: HardBoundsWatch;
	/** Resolved caps for this job; defaults from env when omitted. */
	hardBounds?: JobHardBounds;
	onUsage?: (jobId: string, previous: Usage, current: Usage) => void; // per model message that advanced run usage
}

/**
 * From here on the envelope arrives as an event, never as a poll — a settle
 * without one is prompted once, and a close without one is classified rather
 * than guessed at. Shared by `Dispatcher` and `Reviver` (cp-8km) so observation
 * wiring can never diverge between a fresh spawn and a revived one.
 */
export function attachWorkerObservers(options: WorkerObserverOptions): void {
	options.recorder.attach(options.worker);
	// H1 (Pier 2.6): command-post's own outer retry ladder, above pi's own —
	// every worker gets it, unconditionally; see src/provider-retry.ts. Attached
	// before `settle` so `isPending()` exists by the time it is handed over —
	// though correctness does not depend on this order (the flag is decided on
	// `message_end`, strictly before the `agent_settled` `settle` reacts to).
	const outerRetry = watchOuterProviderRetry({ jobId: options.jobId, worker: options.worker, recorder: options.recorder });
	options.intake?.watch(options.jobId, options.worker);
	// After intake, deliberately: intake's own settle handler is the thing that
	// makes "did it report?" a fact rather than a guess, and the nudge must never
	// fire at a worker whose envelope is already on disk.
	//
	// H1 review (finding 1): a settle the outer ladder has already claimed for a
	// pending retry must not also be nudged for an unreported envelope or
	// classified `model_call_failed` — `outerRetry.isPending` is that gate.
	// cp-mub7: `exhaustedError` is the other half — a settle the ladder gave up
	// on is a failed model call, never an unreported one to nudge.
	options.settle?.watch(options.jobId, options.worker, outerRetry.isPending, outerRetry.exhaustedError);
	options.failures?.watch(options.jobId, options.worker);
	options.bounds?.watch(options.jobId, options.worker, options.hardBounds ?? resolveJobHardBounds());
	const { onUsage, jobId } = options;
	if (onUsage) options.recorder.onUsageAdvance((previous, current) => onUsage(jobId, previous, current));
}

/**
 * The resolved task: what goes into the assembled brief's `${task}` slot, and
 * (separately) the full text used only for the parent's own in-process
 * scope/risk inference — which reads bytes without ever putting them in a
 * model's context, the same distinction `cp_artifact get` already draws.
 *
 * `forBrief` and `forInference` diverge exactly when `taskFile` was given
 * (cp-n7w): the artifact's body is entitled to be read by the worker that was
 * handed it, but it must never be *inlined* into the brief text the
 * credential guard (`assertBriefIsSafe`) scans, because a plan legitimately
 * documenting credential-shaped environment facts (a measured `gh` rate-limit
 * line, a redacted-looking example) would then trip a guard the parent has no
 * sanctioned way to resolve — it cannot read the artifact to redact, excerpt
 * or judge the match. Naming the file instead keeps the guard scanning only
 * hand-typed brief text, where it is supposed to fire.
 */
export interface ResolvedTask {
	/** Substituted into the brief. Never the raw body of a `taskFile`. */
	forBrief: string;
	/** Full text, for scope/risk keyword inference only — never sent to a model. */
	forInference: string;
}

/**
 * The minimal shape `readTask` needs. `DispatchRequest` satisfies it
 * structurally, and so does `cp_send`'s promotion path (`src/send.ts`),
 * which reuses this exact resolution and its exclusivity/emptiness checks
 * rather than growing a second one — a promoted brief's task/taskFile is the
 * same kind of input dispatch already validates, just arriving later.
 */
export interface TaskInput {
	jobId: string;
	task?: string;
	taskFile?: string;
}

/** The pointer sentence a taskFile handover puts in the brief instead of its body. */
function taskFilePointer(path: string): string {
	return [
		`Your task is the file at \`${path}\`. It was handed to you as a pointer, not inlined here — read it in full with your own read tool before doing anything else; it is the complete spec for this job.`,
		"",
		"Nothing from that file entered this brief or the parent's context: the parent that dispatched you never read it either. Read it yourself now.",
	].join("\n");
}

/**
 * The task text, from the request or from a file. Exactly one source: a caller
 * that names both has two ideas about the job, and the worker would only see
 * one of them.
 */
export function readTask(request: TaskInput): ResolvedTask {
	if (request.task !== undefined && request.taskFile !== undefined) {
		throw new DispatchError(`${request.jobId}: pass task or taskFile, not both`);
	}
	if (request.taskFile !== undefined) {
		if (!existsSync(request.taskFile)) {
			throw new DispatchError(`${request.jobId}: task file ${request.taskFile} does not exist`);
		}
		const text = readFileSync(request.taskFile, "utf8");
		if (text.trim().length === 0) {
			throw new DispatchError(`${request.jobId}: task file ${request.taskFile} is empty`);
		}
		return { forBrief: taskFilePointer(request.taskFile), forInference: text };
	}
	if (request.task === undefined || request.task.trim().length === 0) {
		throw new DispatchError(`${request.jobId}: a task (or taskFile) is required — a brief without a task is a worker without a job`);
	}
	return { forBrief: request.task, forInference: request.task };
}

/**
 * The profile a `delivery:answer` job gets when the caller names none
 * (cp-u3o4). Loaded **by name**, not by role: it shares `role: planner` with
 * `planner.md` on purpose (ROLES is fixed at three by contract).
 */
export const QA_PROFILE_NAME = "qa";

/** kind -> role. The gate reviewer is dispatched by the gate module (T20). */
export const ROLE_FOR_KIND: Readonly<Record<JobKind, Role>> = Object.freeze({
	research: "planner",
	ship: "implementer",
});

/**
 * The profile a job gets, as one function so a dispatch and its preview can
 * never disagree about it (routing T5).
 *
 * cp-u3o4: `delivery:answer` is the Q&A path — same kind (research), same role
 * (planner), a different brief. The profile default is the only place dispatch
 * needs to know that, and an explicit `profile` still wins.
 */
function selectProfile(
	profilesDir: string,
	request: DispatchRequest,
	labels: { kind: JobKind; delivery: Delivery },
): WorkerProfile {
	if (request.profile) return loadProfile(profilesDir, request.profile);
	if (labels.delivery === "answer") return loadProfile(profilesDir, QA_PROFILE_NAME);
	return profileForRole(profilesDir, ROLE_FOR_KIND[labels.kind]);
}

// The resolution boundary itself lives in pipeline.ts (see the import above);
// this keeps `import { resolveRoutingInputs } from "./dispatch.ts"` working for
// every caller and test that already reaches for it here.
export { resolveRoutingInputs } from "./pipeline.ts";

export interface DispatchRequest {
	jobId: string;
	/** The task text substituted into the brief. Use `taskFile` instead to hand over a file. */
	task?: string;
	/**
	 * A file whose contents become the task — the ported `--task-file`, and the
	 * only sanctioned way to hand a research artifact to an implementer. The
	 * body never passes through the parent's context (T19), and as of cp-n7w it
	 * never passes through the *brief* either: the assembled brief names this
	 * path and tells the worker to read it directly, so the artifact's own text
	 * (which may legitimately quote credential-shaped environment facts) never
	 * reaches `assertBriefIsSafe`. The file is read in code only to infer
	 * scope/risk keywords, never to inline it.
	 */
	taskFile?: string;
	scope?: Scope;
	risk?: Risk;
	/**
	 * How to label a supplied `scope`/`risk` (cp-routing-provenance). Defaults to
	 * `"explicit"` — a human named it. The pipeline passes `"assessed"`, because
	 * those values are the planner's own `self_assessment`, not an operator's
	 * instruction, and a reviewer reading the record should be able to tell.
	 * Axes the caller did NOT supply are unaffected: they are still inferred or
	 * defaulted on their own.
	 *
	 * One word labels both axes; an object labels them separately, which is what
	 * a pipeline handoff needs — the implementer's `scope` can be the planner's
	 * measurement while its `risk` is the *task's* known impact, retained from
	 * `cp_pipeline start` (routing T2).
	 */
	inputsFrom?: SuppliedBy;
	/** H6: a risk the pipeline recorded (`src/pipeline.ts`) that routing is not given; only the risk:high gate reads it. */
	recordedRisk?: PipelineRecordedRisk;
	/** Explicit model override (still allowlisted). */
	model?: string;
	/**
	 * Explicit effort override (cp-ot3b). Wins over the rubric row's level and the
	 * profile's, with or without `model`; a level the model cannot serve is a
	 * `RoutingError` before the lease, never a substituted level. Absent means
	 * exactly today's behaviour.
	 */
	thinking?: ThinkingLevel;
	/** Explicit profile; defaults to the profile for the job's kind. */
	profile?: string;
	base?: string;
	/** Skip `git fetch origin` (offline tests). */
	fetch?: boolean;
	/** Per-dispatch wall-clock cap in seconds; home/env default otherwise. */
	wallClockSeconds?: number;
	/** Per-dispatch tool-start cap; home/env default otherwise. */
	toolCallCap?: number;
	/** cp-wlhu S5: the foreign-CI line `CommandPost.dispatch`'s reviewer gate computed; snapshotted into the brief, never stored. */ foreignCi?: string;
}
export interface DispatchResult {
	job_id: string;
	mandate_id?: string;
	/** Session name of the worker; the job id is the alias, as on the branch. */
	worker: string;
	worktree: string;
	branch: string;
	state: "dispatched" | "promote";
	/** `accepted` = pi answered the id-correlated prompt. A fact, not a guess. */
	receipt: "accepted" | "refused";
	model?: string;
	profile?: string;
	routing?: string;
	pid?: number;
	session_id?: string;
	promote?: PreflightResult["promote"];
	findings?: PreflightResult["findings"];
	/** Effective wall-clock bound frozen on the dispatched worker. */
	wall_clock_seconds?: number;
	/** H6: an inferred-only risk:high against a recorded low dispatched under ask_on risk:high; one line naming the keywords. */
	risk_warning?: string;
}
/**
 * What `cp_dispatch dry_run` answers (routing T5): the route this request would
 * take, resolved by the same code a real dispatch runs and with **nothing
 * taken**.
 *
 * A preview carries task-file bytes and a path, never its body or credentials. It holds no lease,
 * creates no branch or job, spawns nothing, writes no routing record and refreshes no auth.
 * Dispatch recomputes from live config, so a preview authorizes nothing and can never be the
 * reason a later dispatch chose a model.
 */
export interface DispatchPreview {
	/** Always true: this record is a projection, never a dispatch receipt. */
	preview: true;
	job_id: string;
	mandate_id?: string;
	project: string;
	kind: JobKind;
	delivery: Delivery;
	profile: string;
	/** The effective inputs and their per-axis provenance, as the fleet would record them. */
	routing: JobRouting;
	/** The decision itself: model, source, rule, effort. Absent when routing refuses. */
	decision?: RoutingDecision;
	/** The `source=/model=/rule=` line dispatch would print for it. */
	line?: string;
	/** What the probe knows about the resolved model. An absent field is unknown, never "no". */
	availability?: { available: boolean; supported_thinking?: ThinkingLevel[] };
	/**
	 * The routing refusal a dispatch would raise right now, verbatim — an
	 * unavailable model, an allowlist rejection or an unserviceable effort level.
	 * Present exactly when `decision` is absent.
	 */
	error?: string;
	/** Where the task came from and how big it is — never what it says. */
	task: { source: "task" | "task_file"; bytes: number; path?: string };
	/** Open blockers. Dispatch refuses while any exist; a preview reports them. */
	blockers?: string[];
	/** Set (verbatim `"would ask: risk:high"`) when a real dispatch would hit the risk:high gate (cur.2.4); nothing is escalated for a dry run. */
	mandate_gate?: string;
}

export interface DispatcherOptions extends Pick<WorkerObserverOptions, "onUsage"> {
	capacity?: CapacityReader;
	home: string;
	profilesDir: string;
	briefsDir: string;
	ledger: Ledger;
	registry: ProjectRegistry;
	fleet: FleetStore;
	preflight: Preflight;
	leases: LeaseManager;
	manager: WorkerManager;
	routing: RoutingConfig;
	probe: ModelProbe;
	/** Shared per-job run recorders; one writer per events.jsonl. */
	runs?: RunRegistry;
	/** When present, the new worker is watched for its terminating report. */
	intake?: EnvelopeIntake;
	/** When present, an observed close without an envelope is classified. */
	failures?: FailureMonitor;
	/** When present, a settle with no envelope gets one prompt to report. */
	settle?: SettleWatcher;
	bounds?: HardBoundsWatch;
	/** Read-only reference lookup, injected in tests. */ referenceExec?: CommandRunner;
	/** git runner, injected in tests. */
	git?: GitRunner;
	now?: () => Date;
	promptTimeoutMs?: number;
	/** When present, a paused/capped mandate covering this job refuses a new spawn. */
	mandates?: MandateStore;
	/** node_modules refresh ports (`prepareNodeDeps`), injected in tests: no real npm. */
	deps?: DepsPorts;
	/** 4b-1: at the spawn cap, release one idle held author and reserve its slot (HeldRelease.makeRoom); the returned release frees it on failure. */
	makeRoom?: (jobId: string, role: Role) => Promise<(() => void) | undefined>;
}

export class Dispatcher {
	readonly #options: DispatcherOptions;
	readonly #runs: RunRegistry;

	constructor(options: DispatcherOptions) {
		this.#options = options;
		this.#runs = options.runs ?? new RunRegistry(options.home);
	}

	async previewScript(request: DispatchRequest): Promise<ScriptPreview> {
		return this.#script().preview(request);
	}

	async dispatchScript(request: DispatchRequest): Promise<ScriptDispatchResult> {
		return this.#script().dispatch(request);
	}

	#script(): ScriptDispatcher {
		const { home, ledger, fleet, preflight, leases, mandates, intake } = this.#options;
		if (!intake) throw new DispatchError("script dispatch requires result intake");
		return new ScriptDispatcher({ home, ledger, fleet, preflight, leases, mandates, intake, runs: this.#runs });
	}

	/** A preview reads routing facts only; it never reserves a lease or authorizes dispatch. */
	async preview(request: DispatchRequest): Promise<DispatchPreview> {
		const options = this.#options;
		const issue = await options.ledger.show(request.jobId);
		if (issue.script) throw new DispatchError(`${issue.id}: script jobs use CommandPost.previewDispatch`);
		const task = readTask(request);
		assertDispatchable(issue);
		const labels = requireJobLabels(issue);
		const kind: JobKind = labels.kind ?? "ship";
		const delivery: Delivery = labels.delivery;
		const blockers = await options.ledger.blockersOf(issue.id);
		const profile = selectProfile(options.profilesDir, request, { kind, delivery });
		const inputs = composeRoutingInputs(request, issue, task);
		let decision: RoutingDecision | undefined;
		let error: string | undefined;
		try {
			decision = await resolveWithCapacity(
				{
					profile,
					jobId: issue.id,
					project: labels.project,
					kind,
					scope: inputs.scope,
					risk: inputs.risk,
					...(request.model ? { override: request.model } : {}),
					...(request.thinking ? { thinking: request.thinking } : {}),
				},
				options.routing,
				options.probe,
				options.capacity,
			);
		} catch (thrown) {
			if (!(thrown instanceof RoutingError)) throw thrown;
			error = thrown.message;
		}
		// Absent supported_thinking means the probe cannot tell, never "unsupported".
		const supported = decision ? options.probe.supportedThinking?.(decision.model) : undefined;
		const selected = options.mandates?.selection("dispatch", { jobId: issue.id, project: labels.project, kind, pathHints: [task.forInference] }, options.fleet.read().jobs);
		return {
			preview: true,
			job_id: issue.id,
			...(selected ? { mandate_id: selected.grant.id } : {}),
			project: labels.project,
			kind,
			delivery,
			profile: profile.frontmatter.name,
			routing: routingRecord(inputs, decision?.thinking),
			...(decision ? { decision, line: formatRoutingDecision(decision) } : {}),
			...(decision
				? {
						availability: {
							available: options.probe.isAvailable(decision.model),
							...(supported ? { supported_thinking: supported } : {}),
						},
					}
				: {}),
			...(error ? { error } : {}),
			task: {
				source: request.taskFile === undefined ? "task" : "task_file",
				bytes: task.forInference.length,
				...(request.taskFile === undefined ? {} : { path: request.taskFile }),
			},
			...(blockers.length > 0 ? { blockers } : {}),
			...(options.mandates?.wouldAskRiskHigh({ jobId: issue.id, project: labels.project, kind, pathHints: [task.forInference] }, riskGate(undefined, request, issue, task, { jobId: issue.id, project: labels.project, kind }, inputs).risk) ? { mandate_gate: "would ask: risk:high" } : {}),
		};
	}

	async dispatch(request: DispatchRequest): Promise<DispatchResult> {
		const options = this.#options;
		const now = options.now ?? (() => new Date());
		const issue = await options.ledger.show(request.jobId);
		if (issue.script) throw new DispatchError(`${issue.id}: script jobs use CommandPost.dispatch`);
		const task = readTask(request);

		// --- 1. the ledger decides what this job is -------------------------
		assertDispatchable(issue);
		const labels = requireJobLabels(issue);
		const kind: JobKind = labels.kind ?? "ship";
		const delivery: Delivery = labels.delivery;
		const blockers = await options.ledger.blockersOf(issue.id);
		if (blockers.length > 0) {
			throw new BlockedDispatchError(`${issue.id} is blocked by ${blockers.join(", ")} — close the blocker or drop the dependency; cp_job ready is the queue`, blockers);
		}

		// --- 2. profile + model, both before anything is taken ---------------
		const profile: WorkerProfile = selectProfile(options.profilesDir, request, { kind, delivery });
		const inputs = composeRoutingInputs(request, issue, task);
		const { scope, risk } = inputs;
		const routing: RoutingDecision = await resolveWithCapacity(
			{
				profile,
				jobId: issue.id,
				project: labels.project,
				kind,
				scope,
				risk,
				...(request.model ? { override: request.model } : {}),
				...(request.thinking ? { thinking: request.thinking } : {}),
			},
			options.routing,
			options.probe,
			options.capacity,
		);

		// Frozen on the record below; an invalid data/worker-bounds.json refuses before any lease.
		let hardBounds: JobHardBounds;
		try {
			hardBounds = resolveJobHardBounds(
				{
					...(request.wallClockSeconds !== undefined ? { wall_clock_seconds: request.wallClockSeconds } : {}),
					...(request.toolCallCap !== undefined ? { tool_call_cap: request.toolCallCap } : {}),
				},
				process.env,
				options.home,
			);
		} catch (error) {
			throw new DispatchError((error as Error).message);
		}

		// --- 3. preflight before the lease (promote-not-spawn included) -------
		const pre = await options.preflight.check({
			project: labels.project,
			jobId: issue.id,
			model: routing.model,
			...(request.base ? { base: request.base } : {}),
			...(request.fetch === false ? { fetch: false } : {}),
		});
		if (pre.status === "promote") {
			return {
				job_id: issue.id,
				worker: pre.promote?.job_id ?? issue.id,
				worktree: pre.promote?.worktree ?? "",
				branch: issue.id,
				state: "promote",
				receipt: "refused",
				promote: pre.promote,
				findings: pre.findings,
			};
		}
		if (pre.status !== "ok") {
			throw new DispatchError(`preflight refused ${issue.id}:\n${formatPreflight(pre)}`, pre);
		}
		const clone = pre.clone as string;
		const base = pre.base as string;

		const gate = riskGate(options.mandates, request, issue, task, { jobId: issue.id, project: labels.project, kind }, inputs);
		let mandateId: string | undefined;
		try {
			const permission = await options.mandates?.assertDispatchAllowed(
				{ jobId: issue.id, project: labels.project, kind, pathHints: [task.forInference], risk: gate.risk, evidence: gate.evidence ? [...inputs.reasons, gate.evidence] : inputs.reasons },
				options.fleet.read().jobs,
			);
			mandateId = permission?.selected?.id;
		} catch (error) {
			throw error instanceof MandateError && error.code ? error : new DispatchError((error as Error).message); // a coded refusal keeps its code (dispatch queue)
		}

		// --- 4. lease, then everything that can fail must clean up -----------
		const lease = await options.leases.acquire(clone, { holder: issue.id, project: labels.project });
		let recorder: RunRecorder | undefined;
		let reservation: (() => void) | undefined;
		// cp-bw4: only THIS call's branch may be cleaned up on the error path. A
		// leftover branch from an older failure (or from a human) is somebody
		// else's state and is refused loudly by `#createJobBranch` instead.
		let branchCreatedHere = false;
		try {
			await this.#createJobBranch(lease.path, issue.id, base);
			branchCreatedHere = true;

			const post = await options.preflight.check({
				project: labels.project,
				jobId: issue.id,
				model: routing.model,
				worktree: lease.path,
				fetch: false,
				base,
			});
			// The job's own worktree, on the job's own branch, is not "occupied".
			const blocking = post.findings.filter(
				(finding) => finding.level === "fail" && finding.code !== "occupied_promote" && finding.code !== "occupied_refuse",
			);
			if (blocking.length > 0) {
				throw new DispatchError(`preflight refused the leased worktree:\n${formatPreflight(post)}`, post);
			}
			// t3code adoption 7: the dispatch-time HEAD, held at a hidden ref (never pushed, never restored; teardown deletes it).
			const checkpoint = await captureCheckpoint(options.git ?? defaultGit, lease.path, issue.id);

			// A pooled worktree keeps node_modules from its last job: refresh it before the worker starts. Never throws; a failure rides in the brief.
			const deps = await prepareNodeDeps(lease.path, options.deps);

			// --- 5. brief and shared reference snapshot ----------------------
			const beadsDb = options.ledger.beadsDb(labels.project);
			const references = await referencedMaterial({ task: task.forInference, externalRef: issue.external_ref, prefix: options.ledger.read().prefix,
				clone, worktree: lease.path, home: options.home, exec: options.referenceExec, ...(beadsDb ? { beadsDb } : {}), ...(request.foreignCi ? { foreignCi: request.foreignCi } : {}) });
			const originalTask = task.forInference + references;
			const runDir = join(options.home, paths.runDir(issue.id));
			mkdirSync(runDir, { recursive: true });
			const artifactPath = join(options.home, paths.artifactDir(issue.id), delivery === "board" ? "board.json" : "report.md");
			const brief = assembleBrief({
				profile,
				template: readBriefTemplate(options.briefsDir, profile.frontmatter.briefTemplate),
				values: {
					job_id: issue.id,
					branch: issue.id,
					base,
					worktree: lease.path,
					project: labels.project,
					kind,
					delivery,
					task: task.forBrief + references,
					artifact_path: artifactPath,
				},
			}) + (deps.note ? `\n\n> ${deps.note}\n` : "") + await repoMap({ home: options.home, project: labels.project, worktree: lease.path, git: options.git ?? defaultGit });
			writeFileSync(join(options.home, paths.briefFile(issue.id)), brief);
			// Freeze parent input for reviewer coverage, never worker-authored text.
			// taskFile stays out of the brief; both receive the reference snapshot.
			writeFileSync(join(options.home, paths.originalTaskFile(issue.id)), originalTask);

			// --- 6. spawn + first prompt ------------------------------------
			recorder = this.#runs.open(issue.id);
			if (kind === "research") mkdirSync(join(options.home, paths.artifactDir(issue.id)), { recursive: true });
			reservation = await options.makeRoom?.(issue.id, profile.frontmatter.role);
			await options.manager.ready();
			const managed = options.manager.spawn({
				identity: {
					jobId: issue.id, kind, delivery,
					runDir,
					worktree: lease.path,
					...(kind === "research" ? { artifactPath } : {}),
				},
				profile,
				model: routing.model,
				// The routing decision carries the effort too (cp-eff): a rubric row
				// that names `thinking` sets it for this job, and the profile's level
				// stands when the row says nothing.
				...(routing.thinking ? { thinking: routing.thinking } : {}),
				brief,
				sessionDir: join(options.home, LAYOUT.sessions),
				sessionName: issue.id,
				...(beadsDb ? { extraEnv: { BEADS_DIR: dirname(beadsDb) } } : {}),
			});
			recorder.markSpawned({
				pid: managed.worker.pid,
				model: routing.model,
				profile: profile.frontmatter.name,
			});
			// cp-sr5: a raise to the profile's own budget that the fleet ceiling
			// clamps must say so, on the job it actually happened to — not just be
			// discoverable later from doctor or a refused send.
			if (managed.plan.budgetClamp.tokens || managed.plan.budgetClamp.cost) {
				recorder.cp("budget_clamped", {
					wanted: profile.frontmatter.budget ?? {},
					effective: managed.plan.budget,
					clamped: managed.plan.budgetClamp,
				});
			}
			recorder.cp("checkpoint_captured", checkpoint);
			recorder.cp("deps_prepared", { outcome: deps.outcome, detail: deps.detail });
			recorder.cp("original_task_frozen", {
				path: paths.originalTaskFile(issue.id),
				bytes: Buffer.byteLength(originalTask),
				source: request.taskFile !== undefined ? "task_file" : "task",
			});
			// cp-rte: what routing was told, and where those inputs came from. A
			// model chosen from inferred inputs must be explainable afterwards.
			// cp-routing-provenance: `inputs` stays the one-word legacy summary that
			// older run logs and readers already carry; `provenance` is the per-axis
			// truth beside it. Same event, no second journal.
			const recorded = { ...routingRecord(inputs, routing.thinking), ...(gate.recorded && gate.recorded.risk !== risk ? { recorded_risk: gate.recorded.risk } : {}) };
			recorder.cp("routing_resolved", {
				model: routing.model,
				source: routing.source,
				rule: routing.rule,
				...(routing.thinking ? { thinking: routing.thinking } : {}),
				...(routing.attempted ? { attempted: routing.attempted } : {}),
				...(routing.capacity ? { capacity: routing.capacity } : {}), ...(routing.quota ? { quota: routing.quota } : {}),
				scope,
				risk,
				inputs: recorded.inferred ? "inferred" : "explicit",
				provenance: inputs.provenance,
				...(inputs.reasons.length > 0 ? { reasons: inputs.reasons } : {}),
				...(gate.warning ? { risk_warning: gate.warning } : {}), ...(gate.recorded ? { recorded_risk: gate.recorded.risk, recorded_risk_from: gate.recorded.from } : {}),
			});
			attachWorkerObservers({
				recorder, worker: managed.worker, jobId: issue.id,
				...(options.intake ? { intake: options.intake } : {}),
				...(options.settle ? { settle: options.settle } : {}),
				...(options.failures ? { failures: options.failures } : {}),
				...(options.bounds ? { bounds: options.bounds, hardBounds } : {}),
				...(options.onUsage ? { onUsage: options.onUsage } : {}),
			});

			const state = await managed.worker.getState(options.promptTimeoutMs ?? 60_000);
			const receipt = await managed.worker.send(brief);
			if (receipt.receipt === "failed") {
				throw new DispatchError(`worker for ${issue.id} refused the brief: ${receipt.error ?? "unknown error"}`);
			}
			recorder.cp("prompt_sent", { receipt: receipt.receipt, bytes: brief.length });

			// --- 7. record the job (facts only) ------------------------------
			const record: FleetRecord = {
				job_id: issue.id,
				project: labels.project,
				kind,
				delivery,
				origin: "terminal",
				phase: "waiting",
				worker: {
					pid: managed.worker.pid as number,
					session_id: typeof state.sessionId === "string" ? state.sessionId : issue.id,
					session_file: typeof state.sessionFile === "string" ? state.sessionFile : "",
					profile: profile.frontmatter.name,
					role: profile.frontmatter.role,
					model: routing.model,
					started_at: isoTimestamp(now()),
				},
				worktree: lease.path,
				...(lease.lease_id ? { lease_id: lease.lease_id } : {}),
				...("ref" in checkpoint ? { checkpoint_ref: checkpoint.ref } : {}),
				...scheduleRecord(issue.labels),
				branch: issue.id,
				dispatched_at: isoTimestamp(now()),
				usage: EMPTY_USAGE,
				budget: managed.plan.budget,
				bounds: hardBounds,
				// cp-status-scope-risk: the same scope/risk/thinking already recorded on
				// `cp:routing_resolved`, persisted where a read-only view (status, the
				// status block) can reach it without re-running `inferScopeAndRisk` at
				// render time. One source of truth: this IS the routing decision.
				routing: recorded,
			};
			// A re-dispatch after a failed or finished attempt replaces the old
			// record: a new worker is a new run, and the fleet holds what is true
			// now. A *live* record never gets here — preflight promotes instead.
			const previous = options.fleet.get(issue.id);
			if (previous) await options.fleet.remove(issue.id);
			await options.fleet.add(record);

			// --- 8. the ledger learns last: a claim is only true once it is ---
			await options.ledger.claim(issue.id, issue.id).catch(async (error) => { await options.fleet.remove(issue.id); throw error; });
			return {
				job_id: issue.id,
				...(mandateId ? { mandate_id: mandateId } : {}),
				worker: issue.id,
				worktree: lease.path,
				branch: issue.id,
				state: "dispatched",
				receipt: "accepted",
				model: routing.model,
				profile: profile.frontmatter.name,
				routing: formatRoutingDecision(routing),
				...(managed.worker.pid !== undefined ? { pid: managed.worker.pid } : {}),
				session_id: record.worker.session_id,
				wall_clock_seconds: hardBounds.wall_clock_seconds,
				...(gate.warning ? { risk_warning: gate.warning } : {}),
			};
		} catch (error) {
			reservation?.();
			// Nothing half-dispatched survives: kill the worker, drop the branch this
			// call created (only when it provably holds no work), return the lease.
			// Order matters: the branch goes before the lease, because after the
			// lease is returned the worktree may already belong to another job.
			await safely(() => options.manager.shutdown(issue.id));
			if (branchCreatedHere) {
				// Before `#runs.close`, so the destructive step lands in the run log
				// while the recorder still accepts events.
				await safely(async () => {
					const outcome = await cleanupCreatedJobBranch({
						git: options.git ?? defaultGit,
						worktree: lease.path,
						branch: issue.id,
						base,
					});
					safelySync(() =>
						recorder?.cp("job_branch_cleaned", {
							branch: issue.id,
							worktree: lease.path,
							deleted: outcome.deleted,
							...(outcome.at ? { at: outcome.at } : {}),
							...(outcome.note ? { reason: outcome.note } : {}),
						}),
					);
					// The original error is what escapes — same instance, same type, its
					// own message intact. A branch we could NOT remove is appended as a
					// fact the operator has to act on, never as a replacement for the
					// cause, and a branch we did remove says nothing here at all.
					if (!outcome.deleted && outcome.note && error instanceof Error) {
						error.message = `${error.message}\n${outcome.note}`;
					}
				});
			}
			if (recorder) this.#runs.close(issue.id);
			if (branchCreatedHere) await deleteCheckpoint(options.git ?? defaultGit, lease.path, checkpointRef(issue.id));
			await safely(() => options.leases.release(lease, { ignoreErrors: true }));
			throw error;
		}
	}

	/**
	 * Ported `createJobBranch`: fetch, verify `origin/<base>`, then cut the job
	 * branch from it. The branch is always the job id — that is how a worktree,
	 * a run directory and a PR are tied to one job.
	 */
	async #createJobBranch(worktree: string, branch: string, base: string): Promise<void> {
		const git = this.#options.git ?? defaultGit;
		const verify = await git(worktree, ["rev-parse", "--verify", "--quiet", `origin/${base}`]);
		if (verify.status !== 0) {
			throw new DispatchError(`origin/${base} is missing in ${worktree} — fetch first, or name a base that exists on origin`);
		}
		const switched = await git(worktree, ["switch", "--no-track", "-c", branch, `origin/${base}`]);
		if (switched.status === 0) return;
		const checkedOut = await git(worktree, ["checkout", "--no-track", "-b", branch, `origin/${base}`]);
		if (checkedOut.status === 0) return;
		throw new DispatchError(
			`cannot create branch ${branch} at origin/${base} in ${worktree}: ${lastLine(switched.stderr) || lastLine(checkedOut.stderr)} — pick a new job id or remove the leftover branch`,
		);
	}
}

function assertDispatchable(issue: Job): void {
	if (issue.status === "closed") {
		throw new DispatchError(`${issue.id} is ${issue.status}; reopen it before dispatching`);
	}
}

/** What `cleanupCreatedJobBranch` did, and why. Journaled as `job_branch_cleaned`. */
export interface JobBranchCleanup {
	deleted: boolean;
	/** The sha the branch pointed at when it was removed. Only when deleted. */
	at?: string;
	/** Why it was left alone, or why the removal failed. Only when NOT deleted. */
	note?: string;
}

/**
 * cp-bw4: undo the branch **this dispatch** created, and only when deleting it
 * provably destroys nothing.
 *
 * The guard is deliberately narrow, because this runs inside a `catch` — the
 * one place the code already knows an assumption failed:
 *
 *  - the caller must have observed `#createJobBranch` succeed in this call
 *    (that is the caller's `branchCreatedHere` flag, never inferred here from
 *    the branch merely existing);
 *  - the branch name must be a job id. It always is — it is the job id — so a
 *    name that is not is a bug upstream, and a delete is the last thing that
 *    should run on it. Nothing is executed at all in that case;
 *  - the branch tip must equal `origin/<base>`, i.e. no commit was ever made on
 *    it. A branch with commits, or a tip that cannot be read, is left alone.
 *
 * Never throws: the caller wraps it in `safely()` like every other cleanup.
 * Exported so the guard is testable without a lease, a ledger or a worker.
 */
export async function cleanupCreatedJobBranch(options: {
	git: GitRunner;
	worktree: string;
	branch: string;
	base: string;
}): Promise<JobBranchCleanup> {
	const { git, worktree, branch, base } = options;
	if (!new RegExp(JOB_ID_PATTERN).test(branch)) {
		return { deleted: false, note: `refusing to remove ${branch} in ${worktree}: not a job id` };
	}
	const left = (why: string): JobBranchCleanup => ({
		deleted: false,
		note: `branch ${branch} was left in place at ${worktree} (${why}) — remove it by hand before re-dispatching`,
	});

	const tip = await git(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	const baseTip = await git(worktree, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]);
	const head = tip.stdout.trim();
	const anchor = baseTip.stdout.trim();
	if (tip.status !== 0 || head === "") return left("its tip could not be read");
	if (baseTip.status !== 0 || anchor === "") return left(`origin/${base} could not be read`);
	if (head !== anchor) return left("it has commits on it");

	const detached = await git(worktree, ["switch", "--detach", anchor]);
	if (detached.status !== 0) return left(`the worktree could not leave it: ${lastLine(detached.stderr)}`);
	const deleted = await git(worktree, ["branch", "-D", branch]);
	if (deleted.status !== 0) return left(`the delete failed: ${lastLine(deleted.stderr)}`);
	return { deleted: true, at: head };
}

async function safely(fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch {
		// Cleanup failures must never mask the original error.
	}
}

/** `safely` for a synchronous step, so one bad record call cannot abort a cleanup. */
function safelySync(fn: () => unknown): void {
	try {
		fn();
	} catch {
		// Cleanup failures must never mask the original error.
	}
}

async function defaultGit(
	cwd: string,
	args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const { execFile } = await import("node:child_process");
	return new Promise((resolvePromise) => {
		execFile("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error?.code;
			const status = typeof code === "number" ? code : error ? 1 : 0;
			resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

function lastLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.at(-1) ?? ""
	);
}

/** Stdout parity with `cmdp dispatch`: one JSON object, no prose. */
export function formatDispatchResult(result: DispatchResult | ScriptDispatchResult): string {
	return JSON.stringify(result);
}

/** Same shape for a preview: one JSON object, no prose, no task body. */
export function formatDispatchPreview(preview: DispatchPreview | ScriptPreview): string {
	return JSON.stringify(preview);
}
