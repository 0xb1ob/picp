/**
 * Doctor (T25) — diagnose the environment, name the fix.
 *
 * Ported from `cmdp doctor` (minus muxa, tmux, worker CLIs and Slack, which do
 * not exist here). Three rules carried over, and they are the whole design:
 *
 *  1. **A finding names its fix.** The old shape was `{what, kind, fix}` and it
 *     existed because a diagnosis nobody can act on is just bad news;
 *     `validateDoctorReport` now refuses a non-ok finding without a fix.
 *  2. **Advisory stays green.** Optional config that is absent (no
 *     `data/routing.json`, no jobs in flight) is `ok`/`warn`, never `error`, so
 *     a fresh home passes. `error` is reserved for "this home cannot dispatch".
 *  3. **Read-only.** Doctor creates nothing and repairs nothing. It is the one
 *     command an operator runs when they already do not trust the state.
 *
 * The ledger checks (spec 2026-09-04) are read-only over the jobs document:
 * does it parse, are the ids and the dependency graph sound, does the
 * environment's prefix agree with the document's, is it outgrowing whole-file
 * rewrites, and is a leftover `.beads/` named for what it now is — an archive.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
	type BudgetConfig,
	BudgetConfigSchema,
	DEFAULT_BUDGET_CONFIG,
	type DoctorFinding,
	type DoctorReport,
	type DoctorSeverity,
	type GateConfig,
	GateConfigSchema,
	GATE_REVIEW_TIMEOUT_MAX_MS,
	GATE_REVIEW_TIMEOUT_MIN_MS,
	isInside,
	isoTimestamp,
	JOBS_SIZE_WARNING,
	jobsInvariantErrors,
	type JobsDocument,
	JobsDocumentSchema,
	LAYOUT,
	NEVER_COMMIT_PATHS,
	paths,
	type Risk,
	RISKS,
	type Role,
	type Runtime,
	ROLES,
	type Scope,
	SCOPES,
	SCHEMA_VERSION,
	stripLegacyJobFields,
	type TrackerConnection,
	validate,
	validateDoctorReport,
	isScriptFleetRecord,
	type WorkerProfile,
} from "./contracts.ts";
import { jobToolCallCap, jobWallClockSeconds } from "./bounds.ts";
import { DEFAULT_REVIEW_TIMEOUT_MS } from "./gate.ts";
import { type FleetStore, isPidAlive as probePid } from "./fleet.ts";
import { ENV_TREEHOUSE_ROOT } from "./contracts.ts";
import { readParentLock } from "./parent-lock.ts";
import { DEFAULT_PARENT_COMPACT_TOKENS, parentContextStatus, parentSettings, standingOrdersFile } from "./parent-context.ts";
import { viewerFindings } from "./viewer/doctor-check.ts";
import { pushFindings } from "./push/status.ts";
import { storageFindings } from "./storage.ts";
import { jobIdMigrationFinding } from "./state-migrations.ts";
import { detectBudgetClamp, resolveJobBudget } from "./worker-manager.ts";
import { ROLE_PACKAGES, WORKER_PACKAGES_LOADED_AT } from "./worker-packages.ts";
import { webAccessFindings } from "./web-access.ts";
import { describeHome, homeCheckoutFinding, isManagedInstall } from "./home.ts";
import { jobsFile } from "./ledger.ts";
import { describeRuntime } from "./mode.ts";
import { listProfiles } from "./profiles.ts";
import { ProjectRegistry } from "./projects.ts";
import { resolveLedgerPrefix } from "./scaffold.ts";
import { activeTrackerUnder } from "./trackers/config.ts";
import {
	boundedList,
	describeEffortDrift,
	effortPolicyDrift,
	loadRoutingConfig,
	type ModelProbe,
	pickModel,
	resolveModel,
	type RoutingRefusal,
	RoutingError,
	shadowedRubricRows,
} from "./routing.ts";
import { installScriptHint, OPTIONAL_TOOL_INFO, OPTIONAL_TOOLS, PI_LENS_TOOLS, REQUIRED_TOOLS, type RequiredTool } from "./tool-manifest.ts";
import {
	foreignSessionTools,
	isUncovered,
	type RecordedSessionTool,
} from "./session-tools.ts";

export class DoctorError extends Error {}

// The finding caps live in `./doctor-caps.ts`, shared with src/service/status.ts.
import { CHECK_MAX, cappedCheck, cappedFix, cappedWhat, DETAIL_MAX, FIX_MAX, WHAT_MAX } from "./doctor-caps.ts";
export { CHECK_MAX, DETAIL_MAX, FIX_MAX };

// REQUIRED_TOOLS is re-exported here so existing imports of it from
// `doctor.ts` (tests, callers) keep working; its one definition lives in
// `./tool-manifest.ts`, shared with `scripts/install-tools.ts` (cp-lvo).
export { REQUIRED_TOOLS };

/**
 * The context doctor resolves models with. A probe is not a job: it names itself
 * so an operator reading routing decisions can tell which rows came from here,
 * and `#models()` says out loud that job_id pins cannot be exercised (cp-2bm).
 */
export const DOCTOR_PROBE_PROJECT = "doctor";
export const DOCTOR_PROBE_JOB_ID = "cp-doctor";

/** Exit code an operator's script can branch on (ported from `cmdp doctor`). */
export const DOCTOR_EXIT_BROKEN = 2;

/** Version probes per tool. A PATH with 40 shims must not stall a diagnosis. */
export const MAX_PATH_PROBES = 5;

/**
 * The routing inputs doctor resolves every profile and project against
 * (routing T5): the whole grid the rubric can distinguish, because a row that
 * only fires for `L` or for `risk: high` is exactly the row an `S`/`low` probe
 * reported nothing about — and a model that cannot be reached is discovered
 * either here or by the first big job of the day.
 *
 * Bounded by construction (3 scopes x 2 risks = 6 pure, in-memory resolutions
 * per profile per project) and deduplicated on the way out: combinations that
 * resolve to the same answer share one finding.
 */
export const PROBE_COMBOS: ReadonlyArray<{ scope: Scope; risk: Risk }> = Object.freeze(
	SCOPES.flatMap((scope) => RISKS.map((risk) => ({ scope, risk }))),
);

/** How many rubric ids (or project names) a bounded finding lists before it counts the rest. */
export const MAX_LINT_DETAIL = 10;

/**
 * What a refused resolution is *about*, in the summary line and in the fix.
 *
 * Read from `RoutingError.refusal`, never sniffed out of the message: doctor's
 * whole contract is that a finding names **its** fix, and "authenticate the
 * provider" is the wrong instruction for a model the operator's own allowlist
 * rejects or an effort level the model does not serve.
 */
const REFUSAL_SUMMARY: Readonly<Record<RoutingRefusal, string>> = Object.freeze({
	allowlist: "model refused by the allowlist",
	availability: "no usable model",
	effort: "effort the model cannot serve",
	exhausted: "every candidate refused",
});

function refusalFix(refusal: RoutingRefusal | undefined, who: string): string {
	if (refusal === "allowlist") {
		return `the row fired and its model is not in \`allow\`: add a pattern that covers it in ${LAYOUT.routingFile}, or point that row at an allowed model (nothing here is unauthenticated — the model was never tried)`;
	}
	if (refusal === "effort") {
		return `name an effort level this model serves (the row's \`thinking\`, or ${who}'s own in its profile), or route to a model that serves it; routing never substitutes a level`;
	}
	if (refusal === "exhausted") {
		return `no candidate for this route is usable — the detail names each one and the gate that refused it: authenticate one of those providers (\`pi auth\`), widen \`allow\`, or edit the \`fallbacks\` of that row (or of ${who}'s profile) in ${LAYOUT.routingFile}`;
	}
	return `authenticate the provider (\`pi auth\`) or set a reachable model for ${who} in ${LAYOUT.routingFile}`;
}

/** One distinct answer from a profile's scope/risk grid, and what produced it. */
interface ModelOutcome {
	finding: DoctorFinding;
	summary: string;
	/** The `scope/risk` labels that resolved to this answer, in grid order. */
	combos: string[];
}

/**
 * Worktrees probed per project pool. A pool is small by design (`max_trees`),
 * and a diagnosis must not turn into a `git` storm on a machine where it did
 * grow: the finding is "this pool is shared", which one foreign worktree
 * already proves.
 */
export const MAX_POOL_PROBES = 20;

export interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[], cwd: string) => CommandResult;

/** Real execution. Bounded: doctor must not hang on a wedged tool. */
export const execRunner: CommandRunner = (command, args, cwd) => {
	try {
		const stdout = execFileSync(command, [...args], {
			cwd,
			encoding: "utf8",
			timeout: 20_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number | null; stdout?: string; stderr?: string; message?: string };
		return {
			status: failure.status ?? null,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message ?? "",
		};
	}
};

/** Every match on PATH, in order; one file behind two spellings (usrmerge `/bin`, fnm symlinks) counts once. */
export function whichAll(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const found = new Map<string, string>(); // real path -> first PATH spelling
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, command);
		try {
			accessSync(candidate, constants.X_OK);
			const real = realpathSync(candidate);
			if (statSync(candidate).isFile() && !found.has(real)) found.set(real, candidate);
		} catch {
			// not here; keep looking
		}
	}
	return [...found.values()];
}

export interface DoctorOptions {
	home: string;
	packageRoot: string;
	fleet: FleetStore;
	/**
	 * pi's model registry probe. Absent means "no live registry in this
	 * context": model availability is then reported as unprobed, never as broken
	 * — claiming a model is missing because we could not ask is a false alarm.
	 */
	probe?: ModelProbe;
	run?: CommandRunner;
	which?: (command: string) => string[];
	isPidAlive?: (pid: number) => boolean;
	now?: () => Date;
	/** pi's own version, when the caller already knows it (the extension does). */
	piVersion?: string;
	/** Injected in tests: the environment the home was resolved from. */
	env?: NodeJS.ProcessEnv;
	/** Injected in tests: where the `service.*` lines find the cp-* units (HOME/XDG_CONFIG_HOME) and the legacy home (PI_HOME). Default process.env. */
	serviceEnv?: NodeJS.ProcessEnv;
	/**
	 * This home's treehouse pool root (`CP_TREEHOUSE_ROOT`), when it has one.
	 * Doctor must ask the same pool `LeaseManager` leases from, or the foreign-
	 * worktree check would diagnose a pool nobody uses.
	 */
	poolRoot?: string;
	/** The session's runtime (spec 2026-09-04). Absent means multi mode on `home`, as every caller before modes did. */
	runtime?: Runtime;
	/**
	 * Tools registered in the parent session at `session_start`. Absent means
	 * this diagnosis was not run from a live parent (tests, a headless caller)
	 * and the check reports "not recorded", never a false foreign-tool alarm.
	 */
	sessionTools?: readonly RecordedSessionTool[];
}

export class Doctor {
	readonly #options: DoctorOptions;
	readonly #run: CommandRunner;
	readonly #which: (command: string) => string[];
	readonly #isPidAlive: (pid: number) => boolean;
	readonly #now: () => Date;
	readonly #runtime: Runtime;

	constructor(options: DoctorOptions) {
		this.#options = options;
		this.#runtime = options.runtime ?? {
			mode: "multi",
			home: options.home,
			source: "checkout",
			reason: "no runtime supplied; multi mode on the given home",
		};
		this.#run = options.run ?? execRunner;
		this.#which = options.which ?? ((command) => whichAll(command));
		this.#isPidAlive = options.isPidAlive ?? probePid;
		this.#now = options.now ?? (() => new Date());
	}

	/** Run every check. Never throws for a broken environment — that is the output. */
	async run(): Promise<DoctorReport> {
		const checkout = homeCheckoutFinding(this.#options.home, this.#options.packageRoot, this.#run);
		const findings: DoctorFinding[] = [
			...(checkout ? [checkout] : []),
			...this.#hostTools(),
			...this.#piLensTools(),
			...(await webAccessFindings({ packageRoot: this.#options.packageRoot, ...(this.#options.env ? { env: this.#options.env } : {}) })),
			...this.#sessionTools(),
			...this.#ledger(),
			...this.#packageResources(),
			...this.#config(),
			...this.#models(),
			...this.#scaffold(),
			...this.#parentLock(),
			...this.#parentContext(),
			...this.#migrations(),
			...this.#pool(),
			...this.#fleetConsistency(),
			...viewerFindings(this.#run, this.#options.home, this.#options.serviceEnv),
			...pushFindings(this.#options.home, this.#now()),
			...storageFindings(this.#options.home, this.#run),
		];
		const counts = {
			ok: findings.filter((finding) => finding.severity === "ok").length,
			warn: findings.filter((finding) => finding.severity === "warn").length,
			error: findings.filter((finding) => finding.severity === "error").length,
		};
		const report: DoctorReport = {
			schema_version: SCHEMA_VERSION,
			generated_at: isoTimestamp(this.#now()),
			home: this.#options.home,
			package_root: this.#options.packageRoot,
			counts,
			ok: counts.error === 0,
			findings,
		};
		const result = validateDoctorReport(report);
		if (!result.ok) {
			throw new DoctorError(`doctor produced an invalid report:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	#parentContext(): DoctorFinding[] {
		const home = this.#options.home;
		const file = join(home, LAYOUT.data, "parent.json");
		const context = parentContextStatus(home);
		const findings: DoctorFinding[] = [];
		if (existsSync(file)) {
			const limit = parentSettings(home).compact_at_tokens;
			findings.push(limit
				? { check: "parent.compact_threshold", severity: "ok", what: `parent compacts at ${limit} context tokens` }
				: { check: "parent.compact_threshold", severity: "warn", what: "parent compact threshold invalid", fix: `set compact_at_tokens to a positive integer in ${file}` });
		} else findings.push({ check: "parent.compact_threshold", severity: "ok", what: `no parent.json; parent compacts at default ${DEFAULT_PARENT_COMPACT_TOKENS} context tokens` });
		findings.push({ check: "parent.context", severity: "ok", what: `parent context tokens: ${context.contextTokens ?? "unknown"}; last turn cost: ${context.lastTurnCostUsd === undefined ? "unknown" : `$${context.lastTurnCostUsd.toFixed(3)}`}; last compact: ${context.lastCompactAt ?? "never"}; last rotate: ${context.lastRotateAt ?? "never"}` });
		const orders = standingOrdersFile(home);
		try {
			const modified = statSync(orders).mtime.toISOString();
			findings.push({ check: "parent.standing_orders", severity: "ok", what: `standing orders present (modified ${modified})`, detail: orders });
		} catch {
			findings.push({ check: "parent.standing_orders", severity: "warn", what: "standing orders absent", fix: `add home-local preferences to ${orders}; AGENTS.md remains binding` });
		}
		return findings;
	}

	// -- host tools ---------------------------------------------------------

	#hostTools(): DoctorFinding[] {
		const findings: DoctorFinding[] = [];
		for (const tool of REQUIRED_TOOLS) {
			const matches = this.#which(tool);
			if (matches.length === 0) {
				findings.push({ check: `host.${tool}`, severity: TOOL_SEVERITY[tool], what: `${tool} is not on PATH`, fix: TOOL_FIX[tool] });
				continue;
			}
			const version = this.#version(tool, matches[0] as string);
			findings.push({
				check: `host.${tool}`,
				severity: "ok",
				what: `${tool} ${version ?? "(version unknown)"}`,
				detail: matches.length > 1 ? `${matches[0]} (+${matches.length - 1} more on PATH)` : matches[0],
			});
			findings.push(...this.#conflictingVersions(tool, matches));
		}
		for (const tool of OPTIONAL_TOOLS) {
			const found = this.#which(tool)[0];
			findings.push(found ? { check: `host.${tool}`, severity: "ok", what: `${tool} (optional) on PATH`, detail: found } : { check: `host.${tool}`, severity: "ok", what: `${tool} (optional) is not on PATH: ${OPTIONAL_TOOL_INFO[tool].why}`, fix: OPTIONAL_TOOL_INFO[tool].install });
		}
		return findings;
	}

	// -- pi-lens prerequisites ----------------------------------------------

	#piLensTools(): DoctorFinding[] {
		const implementer = listProfiles(join(this.#options.packageRoot, "profiles")).find((profile) => profile.frontmatter.role === "implementer");
		if (!implementer) return [];
		const packages = implementer.frontmatter.packages ?? ROLE_PACKAGES.implementer;
		if (!packages.includes("pi-lens")) return [];
		const missing = PI_LENS_TOOLS.commands.filter((command) => this.#which(command).length === 0);
		if (missing.length === 0) return [{ check: "pi-lens.tools", severity: "ok", what: `${PI_LENS_TOOLS.commands.join(" and ")} are on PATH` }];
		return [{
			check: "pi-lens.tools",
			severity: "warn",
			what: `pi-lens implementer tools missing from PATH: ${missing.join(", ")}`,
			fix: `npm i -g ${PI_LENS_TOOLS.packages.join(" ")}`,
		}];
	}

	// -- parent session tools -----------------------------------------------

	#sessionTools(): DoctorFinding[] {
		const recorded = this.#options.sessionTools;
		if (recorded === undefined) {
			return [
				{
					check: "session.tools",
					severity: "ok",
					what: "parent session tools not recorded (not a live parent)",
				},
			];
		}
		const foreign = foreignSessionTools(recorded);
		if (foreign.length === 0) {
			return [
				{
					check: "session.tools",
					severity: "ok",
					what: "no foreign tools",
				},
			];
		}
		const uncovered = foreign.filter((tool) => isUncovered(tool));
		const lines = foreign.map((tool) => {
			const caps = tool.capabilities.length > 0 ? tool.capabilities.join(",") : "unknown";
			const flag = isUncovered(tool) ? ", outside guard coverage" : "";
			return `${tool.name} (${caps}${flag})`;
		});
		const { what, detail } = cappedWhat(
			`${foreign.length} foreign tool(s); ${uncovered.length} can read files or run a shell (outside guard coverage)`,
			boundedList(lines, { max: MAX_LINT_DETAIL, cap: DETAIL_MAX }),
		);
		return [
			{
				check: "session.tools",
				severity: "warn",
				what,
				...(detail ? { detail } : {}),
				fix: cappedFix(
					"warn only — unload the extra extension, or start this parent with --no-extensions -e extensions/command-post (the bridge launcher). Artifact-body guards hook only read and bash",
				),
			},
		];
	}

	/**
	 * The recorded incident: a homebrew `br` 0.2.19 and a `~/.local/bin` 0.5.2,
	 * where which one answered depended on the shell's PATH order, so `br ready`
	 * worked in one terminal and failed in another.
	 *
	 * What is flagged is **conflicting versions**, not duplicate paths: version
	 * managers (fnm, asdf, mise) legitimately put several shims for the *same*
	 * build on PATH, and calling that broken would train an operator to ignore
	 * doctor. Same version behind many paths is a fact worth noting, not a fault.
	 */
	#conflictingVersions(tool: string, matches: readonly string[]): DoctorFinding[] {
		if (matches.length < 2) return [];
		// Every path is probed the same way, including the first: comparing a
		// caller-supplied version string against probed ones would invent conflicts
		// out of two spellings of the same build.
		const byVersion = new Map<string, string[]>();
		for (const path of matches.slice(0, MAX_PATH_PROBES)) {
			const version = this.#versionOf(path) ?? "(version unknown)";
			byVersion.set(version, [...(byVersion.get(version) ?? []), path]);
		}
		if (byVersion.size < 2) return [];
		const detail = [...byVersion.entries()].map(([version, paths]) => `${version}: ${paths.join(", ")}`).join(" | ");
		return [
			{
				check: `host.${tool}.conflict`,
				severity: "error",
				what: `${byVersion.size} different ${tool} versions on PATH`,
				detail,
				fix: `keep exactly one ${tool}: PATH order decides which one answers, so a second version fails only in some shells (the first entry wins here)`,
			},
		];
	}

	#version(tool: string, path: string): string | undefined {
		if (tool === "pi" && this.#options.piVersion) return this.#options.piVersion;
		return this.#versionOf(path);
	}

	#versionOf(path: string): string | undefined {
		const result = this.#run(path, ["--version"], this.#options.home);
		if (result.status !== 0) return undefined;
		const line = result.stdout.split("\n")[0]?.trim();
		return line && line.length > 0 ? line : undefined;
	}

	// -- ledger -------------------------------------------------------------

	/**
	 * The jobs document (spec 2026-09-04). Six findings, all read-only: the file
	 * parses and validates; ids are unique and carry the prefix; the dependency
	 * graph is closed and acyclic; the environment's prefix agrees with the
	 * document's; the document is not outgrowing whole-file rewrites; and a
	 * leftover `.beads/` is named for what it is now — an archive.
	 */
	#ledger(): DoctorFinding[] {
		const home = this.#options.home;
		const file = jobsFile(home);
		if (!existsSync(file)) {
			return [
				{
					check: "ledger.file",
					severity: "error",
					what: "no jobs document in this home",
					detail: file,
					fix: "start a pi session in this home: session_start scaffolds an empty ledger (dispatch needs one)",
				},
			];
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			return [
				{
					check: "ledger.file",
					severity: "error",
					what: "the jobs document is not JSON",
					detail: `${file}: ${(error as Error).message}`,
					fix: "restore the document from a backup, or move it aside and start a session to scaffold an empty one (jobs would be lost)",
				},
			];
		}
		const shape = validate<JobsDocument>(JobsDocumentSchema, stripLegacyJobFields(parsed));
		if (!shape.ok) {
			return [
				{
					check: "ledger.file",
					severity: "error",
					what: "the jobs document violates the jobs contract",
					detail: shape.errors.join("; ").slice(0, 2000),
					fix: "fix the named fields by hand (every job needs id, title, status, labels, blocked_by, comments, created_at, updated_at)",
				},
			];
		}
		const doc = shape.value;
		const findings: DoctorFinding[] = [
			{ check: "ledger.file", severity: "ok", what: `jobs document: ${doc.jobs.length} job(s), prefix ${doc.prefix}`, detail: file },
		];
		const invariants = jobsInvariantErrors(doc);
		findings.push(
			invariants.ids.length === 0
				? { check: "ledger.ids", severity: "ok", what: "every job id is unique, well-formed and carries the prefix" }
				: {
						check: "ledger.ids",
						severity: "error",
						what: `${invariants.ids.length} id problem(s) in the jobs document`,
						detail: invariants.ids.join("; ").slice(0, 2000),
						fix: "edit the document by hand: a duplicate or foreign id cannot be minted by this build, so one was written by something else",
					},
		);
		findings.push(
			invariants.deps.length === 0
				? { check: "ledger.deps", severity: "ok", what: "every dependency names a known job and the graph is acyclic" }
				: {
						check: "ledger.deps",
						severity: "error",
						what: `${invariants.deps.length} dependency problem(s) in the jobs document`,
						detail: invariants.deps.join("; ").slice(0, 2000),
						fix: "remove the offending edge with `cp_job dep_remove` (or by hand): a blocked job whose blocker does not exist can never become ready",
					},
		);
		const resolved = resolveLedgerPrefix(this.#options.env ?? process.env);
		if ("error" in resolved) {
			findings.push({
				check: "ledger.prefix",
				severity: "warn",
				what: "CP_LEDGER_PREFIX is not a usable prefix",
				detail: resolved.error,
				fix: "unset it, or set a value matching the pattern; the document keeps minting with its recorded prefix either way",
			});
		} else if (resolved.prefix !== doc.prefix) {
			findings.push({
				check: "ledger.prefix",
				severity: "warn",
				what: `CP_LEDGER_PREFIX=${resolved.prefix} but the document mints ${doc.prefix}-`,
				fix: `the recorded prefix wins (ids are branch names); unset CP_LEDGER_PREFIX or set it to ${doc.prefix} to silence this`,
			});
		} else {
			findings.push({ check: "ledger.prefix", severity: "ok", what: `ids are minted as ${doc.prefix}-…` });
		}
		findings.push(
			doc.jobs.length > JOBS_SIZE_WARNING
				? {
						check: "ledger.size",
						severity: "warn",
						what: `${doc.jobs.length} jobs in one document (whole-file rewrites past ${JOBS_SIZE_WARNING} get slow)`,
						fix: "archive closed jobs (not automated yet; see the spec's out-of-scope list)",
					}
				: { check: "ledger.size", severity: "ok", what: `${doc.jobs.length} job(s) (warning past ${JOBS_SIZE_WARNING})` },
		);
		const beads = join(home, ".beads");
		if (existsSync(beads)) {
			let live: TrackerConnection | undefined;
			try {
				live = activeTrackerUnder(home, beads);
			} catch (error) {
				findings.push({ check: "ledger.beads_archive", severity: "warn", what: ".beads/ may be a live tracker endpoint: the tracker connections cannot be read", detail: (error as Error).message, fix: "do not delete .beads/; repair data/trackers.json, then re-run /doctor" });
				return findings;
			}
			findings.push(
				live
					? { check: "ledger.beads_archive", severity: "ok", what: `.beads/ is the live endpoint of tracker ${live.id}`, detail: live.endpoint, fix: "never delete it: it holds live tracker state" }
					: doc.jobs.length > 0
						? { check: "ledger.beads_archive", severity: "warn", what: ".beads/ is still present beside the jobs document", detail: beads, fix: "no active tracker connection uses it: it is a frozen archive of closed br issues and is safe to delete once you no longer want to read it" }
						: { check: "ledger.beads_archive", severity: "ok", what: ".beads/ present and the jobs document is empty — not imported yet", detail: beads, fix: "run `/cp-jobs import-beads` once to carry the open br issues over" },
			);
		}
		return findings;
	}

	// -- package resources --------------------------------------------------

	#packageResources(): DoctorFinding[] {
		const findings: DoctorFinding[] = [];
		const profilesDir = join(this.#options.packageRoot, "profiles");
		const briefsDir = join(this.#options.packageRoot, "prompts/briefs");
		const reporter = join(this.#options.packageRoot, "extensions/worker-reporter/index.ts");

		if (!existsSync(reporter)) {
			findings.push({
				check: "package.worker_reporter",
				severity: "error",
				what: "worker-reporter extension is missing",
				detail: reporter,
				fix: "reinstall the package: without it a worker has no way to report (no envelope, no verdict)",
			});
		} else {
			findings.push({ check: "package.worker_reporter", severity: "ok", what: "worker-reporter extension present" });
		}

		let profiles: ReturnType<typeof listProfiles> = [];
		try {
			profiles = listProfiles(profilesDir);
			const newer = profiles.filter((profile) => statSync(profile.path).mtimeMs > WORKER_PACKAGES_LOADED_AT);
			if (newer.length) findings.push({
				check: "package.profiles_newer",
				severity: "warn",
				what: "profiles newer than the loaded code: worker tools and packages may disagree",
				detail: boundedList(newer.map((profile) => profile.path), { max: MAX_LINT_DETAIL, cap: DETAIL_MAX }),
				fix: "drain active workers, then restart the parent to load matching code and worker packages",
			});
			findings.push({
				check: "package.profiles",
				severity: "ok",
				what: `${profiles.length} profile(s) load and validate`,
				detail: profiles.map((profile) => `${profile.frontmatter.name} (${profile.frontmatter.role})`).join(", "),
			});
		} catch (error) {
			findings.push({
				check: "package.profiles",
				severity: "error",
				what: "a worker profile is invalid",
				detail: (error as Error).message.slice(0, 600),
				fix: `fix the frontmatter in ${profilesDir} (roles, tools allowlist and readOnly are contract, see docs/contracts.md)`,
			});
		}

		// The rule here is `profileForRole`'s, not a second opinion about it
		// (cp-u3o4): every role must RESOLVE, which means exactly one profile
		// carries it, or — when several do — exactly one of them is named after the
		// role. `profiles/qa.md` is `role: planner` on purpose (ROLES is fixed at
		// three), and it is asked for by name; a doctor that called that a broken
		// package would be diagnosing a supported shape.
		for (const role of ROLES) {
			const forRole = profiles.filter((profile) => profile.frontmatter.role === role);
			const named = forRole.filter((profile) => profile.frontmatter.name === role);
			const resolves = forRole.length === 1 || named.length === 1;
			if (!resolves) {
				findings.push({
					check: "package.roles",
					severity: "error",
					what:
						forRole.length === 0
							? `no profile for role ${role} (exactly one is required)`
							: `${forRole.length} profiles for role ${role} and none named "${role}" (the default cannot be resolved)`,
					fix: `add or remove profiles in ${profilesDir} so each role resolves: one profile per role, or exactly one named after the role`,
				});
			}
		}

		for (const profile of profiles) {
			const template = join(briefsDir, `${profile.frontmatter.briefTemplate}.md`);
			if (!existsSync(template)) {
				findings.push({
					check: "package.briefs",
					severity: "error",
					what: `profile ${profile.frontmatter.name} names a missing brief template`,
					detail: template,
					fix: `create ${template} or point briefTemplate at an existing one (a worker with no brief cannot start)`,
				});
			}
		}
		if (profiles.length > 0 && !findings.some((finding) => finding.check === "package.briefs")) {
			findings.push({ check: "package.briefs", severity: "ok", what: "every profile's brief template exists" });
		}
		return findings;
	}

	// -- operator config ----------------------------------------------------

	#config(): DoctorFinding[] {
		const findings: DoctorFinding[] = [];
		// Routing: a missing file is policy-not-configured (documented default),
		// an invalid one is a refusal — loadRoutingConfig fails closed.
		const routingFile = join(this.#options.home, LAYOUT.routingFile);
		if (!existsSync(routingFile)) {
			findings.push({
				check: "config.routing",
				severity: "ok",
				what: `no ${LAYOUT.routingFile} (profile defaults only)`,
			});
		} else {
			try {
				const config = loadRoutingConfig(this.#options.home);
				findings.push({
					check: "config.routing",
					severity: "ok",
					what: `routing config: ${config.rubric.length} rubric row(s)`,
					detail: `allow: ${config.allow.join(", ") || "(nothing)"}`,
				});
				if (config.allow.length === 0) {
					findings.push({
						check: "config.routing.allow",
						severity: "warn",
						what: "routing allowlist is empty: no model may be used",
						fix: `add at least one pattern to allow in ${routingFile} (an empty allow list is honoured as written)`,
					});
				}
				findings.push(...this.#routingLint(config, routingFile));
			} catch (error) {
				findings.push({
					check: "config.routing",
					severity: "error",
					what: `${LAYOUT.routingFile} is invalid`,
					detail: (error as Error).message.slice(0, 600),
					fix: `fix ${routingFile} (see docs/contracts.md §Routing config); dispatch refuses to guess a model`,
				});
			}
		}

		for (const [check, file] of [
			["config.budgets", LAYOUT.budgetsFile],
			["config.projects", LAYOUT.projectsFile],
		] as const) {
			const path = join(this.#options.home, file);
			if (!existsSync(path)) {
				findings.push({ check, severity: "ok", what: `no ${file} (defaults)` });
				continue;
			}
			try {
				JSON.parse(readFileSync(path, "utf8"));
				findings.push({ check, severity: "ok", what: `${file} parses` });
			} catch (error) {
				findings.push({
					check,
					severity: "error",
					what: `${file} is not valid JSON`,
					detail: (error as Error).message.slice(0, 300),
					fix: `fix or move aside ${path}`,
				});
			}
		}
		findings.push(...this.#effectiveBudgets());
		findings.push(...this.#effectiveGateTimeout());
		findings.push(...this.#effectiveHardBounds());
		return findings;
	}

	/**
	 * Policy the config is allowed to hold and dispatch would still refuse
	 * (routing T5). Two checks, both read-only and neither of them a reordering:
	 *
	 *  - **shadowed rows** — a row an earlier row provably covers entirely can
	 *    never fire. Warned, never fixed: precedence is the operator's, and
	 *    intentional overlap is how narrow-to-broad ordering is supposed to read,
	 *    so only a proof is reported (`shadowedRubricRows`).
	 *  - **effective-effort drift** — a configured level pi's own metadata says
	 *    the model cannot serve. This is an error because it is not advice: the
	 *    same rule refuses that spawn at dispatch (T3), so the job would fail
	 *    before its lease. It needs the live registry, and absent metadata is
	 *    ignorance rather than proof — with no probe nothing is claimed at all.
	 *
	 * Duplicate ids are not here: `loadRoutingConfig` refuses them outright, so
	 * they arrive as the `config.routing` error above, naming the colliding rows.
	 */
	#routingLint(config: ReturnType<typeof loadRoutingConfig>, routingFile: string): DoctorFinding[] {
		const findings: DoctorFinding[] = [];
		const shadowed = shadowedRubricRows(config);
		if (shadowed.length > 0) {
			findings.push({
				check: "config.routing.shadowed",
				severity: "warn",
				what: `${shadowed.length} rubric row(s) can never fire: an earlier row matches everything they do`,
				detail: boundedList(
					shadowed.map((row) => `${row.id} (rubric[${row.row}]) <- ${row.by} (rubric[${row.byRow}])`),
					{ max: MAX_LINT_DETAIL, cap: DETAIL_MAX },
				),
				fix: cappedFix(
					`narrow the earlier row, or delete the shadowed one, in ${routingFile}; first match wins and nothing here reorders your rubric for you`,
				),
			});
		}
		const probe = this.#options.probe;
		if (!probe) return findings;
		let profiles: ReturnType<typeof listProfiles>;
		try {
			profiles = listProfiles(join(this.#options.packageRoot, "profiles"));
		} catch {
			return findings; // reported by package.profiles
		}
		const drift = effortPolicyDrift(config, profiles, probe);
		findings.push(
			drift.length === 0
				? {
						check: "config.routing.effort",
						severity: "ok",
						what: "every configured model/effort pair pi could answer for is serviceable",
					}
				: {
						check: "config.routing.effort",
						severity: "error",
						what: `${drift.length} configured model/effort pair(s) the model cannot serve`,
						detail: boundedList(drift.map(describeEffortDrift), { max: MAX_LINT_DETAIL, cap: DETAIL_MAX }),
						fix: cappedFix(
							`name a level the model serves, or route to a model that serves it, in ${routingFile} (or the profile's own frontmatter); routing never substitutes an effort level, so this refuses the spawn before the lease`,
						),
					},
		);
		return findings;
	}

	/**
	 * `data/gate.json`, validated fully (unlike the JSON-parse-only loop above):
	 * a value outside `GateConfigSchema`'s bounds (zero, negative, non-numeric,
	 * above the cap) is exactly the kind of mistake an operator editing this file
	 * by hand will make, and "the file parses" is not the same fact as "the gate
	 * will accept it" — `loadGateConfig` itself refuses it the same way. Also
	 * reports the value a review attempt starting right now would actually get
	 * (`resolveReviewTimeoutMs`, re-read per attempt, never cached at parent
	 * startup) — same reasoning as `#effectiveBudgets` and cp-sr5.
	 */
	#effectiveGateTimeout(): DoctorFinding[] {
		const gateFile = join(this.#options.home, LAYOUT.gateConfigFile);
		if (!existsSync(gateFile)) {
			return [
				{ check: "config.gate", severity: "ok", what: `no ${LAYOUT.gateConfigFile} (defaults)` },
				{
					check: "config.gate.review_timeout_ms",
					severity: "ok",
					what: `gate reviewer timeout: ${DEFAULT_REVIEW_TIMEOUT_MS}ms (default)`,
				},
			];
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(gateFile, "utf8"));
		} catch (error) {
			return [
				{
					check: "config.gate",
					severity: "error",
					what: `${LAYOUT.gateConfigFile} is not valid JSON`,
					detail: (error as Error).message.slice(0, 300),
					fix: `fix or move aside ${gateFile}`,
				},
			];
		}
		const result = validate<GateConfig>(GateConfigSchema, parsed);
		if (!result.ok) {
			return [
				{
					check: "config.gate",
					severity: "error",
					what: `${LAYOUT.gateConfigFile} is invalid`,
					detail: result.errors.join("; ").slice(0, 600),
					fix: `review_timeout_ms must be an integer between ${GATE_REVIEW_TIMEOUT_MIN_MS} and ${GATE_REVIEW_TIMEOUT_MAX_MS} (ms); fix or remove ${gateFile} (see docs/contracts.md §Gate config)`,
				},
			];
		}
		const effective = result.value.review_timeout_ms ?? DEFAULT_REVIEW_TIMEOUT_MS;
		return [
			{ check: "config.gate", severity: "ok", what: `${LAYOUT.gateConfigFile} parses` },
			{
				check: "config.gate.review_timeout_ms",
				severity: "ok",
				what: `gate reviewer timeout: ${effective}ms${result.value.review_timeout_ms === undefined ? " (default)" : ""}`,
				...(result.value.review_timeout_ms !== undefined ? { detail: `set in ${gateFile}` } : {}),
			},
		];
	}

	#effectiveHardBounds(): DoctorFinding[] {
		const env = this.#options.env ?? process.env;
		const wall = jobWallClockSeconds(env);
		const tools = jobToolCallCap(env);
		return [
			{
				check: "config.bounds.wall_clock",
				severity: "ok",
				what: `per-job wall-clock cap: ${wall}s`,
			},
			{
				check: "config.bounds.tool_call_cap",
				severity: "ok",
				what: `per-job tool-call cap: ${tools} starts`,
			},
		];
	}

	/**
	 * The per-job ceiling each profile would actually get **right now**, so a
	 * raise that is not taking effect is visible before a dispatch or a send
	 * discovers it the hard way (cp-sr5): min(profile, data/budgets.json) is a
	 * silent clamp otherwise, and the fleet config is read fresh here — the same
	 * `data/budgets.json` `WorkerManager`/`Sender` re-read per operation, never
	 * a value cached from parent startup.
	 */
	#effectiveBudgets(): DoctorFinding[] {
		const findings: DoctorFinding[] = [];
		const budgetsFile = join(this.#options.home, LAYOUT.budgetsFile);
		let config: BudgetConfig = DEFAULT_BUDGET_CONFIG;
		if (existsSync(budgetsFile)) {
			try {
				const result = validate<BudgetConfig>(BudgetConfigSchema, JSON.parse(readFileSync(budgetsFile, "utf8")));
				if (result.ok) config = result.value;
			} catch {
				// Already reported as config.budgets above; nothing more to say here.
				return findings;
			}
		}
		const profilesDir = join(this.#options.packageRoot, "profiles");
		let profiles: ReturnType<typeof listProfiles>;
		try {
			profiles = listProfiles(profilesDir);
		} catch {
			return findings; // reported by package.profiles
		}
		for (const profile of profiles) {
			const effective = resolveJobBudget(profile, config);
			const clamp = detectBudgetClamp(profile, config);
			const wanted = profile.frontmatter.budget;
			const check = `config.budget.${profile.frontmatter.name}`;
			if (clamp.tokens || clamp.cost) {
				const clampedOn = [clamp.tokens ? "tokens" : undefined, clamp.cost ? "cost_usd" : undefined]
					.filter((v): v is string => v !== undefined)
					.join(", ");
				findings.push({
					check,
					severity: "warn",
					what: `${profile.frontmatter.name}'s own budget is clamped by the fleet ceiling to ${effective.tokens} tokens / $${effective.cost_usd}`,
					detail: `profile asks for ${JSON.stringify(wanted)}; clamped on: ${clampedOn} (${budgetsFile})`,
					fix: `raise per_job_${clamp.tokens ? "tokens" : "cost_usd"} in ${LAYOUT.budgetsFile} to match, or lower profiles/${profile.frontmatter.name}.md's own budget`,
				});
			} else {
				findings.push({
					check,
					severity: "ok",
					what: `${profile.frontmatter.name} effective budget: ${effective.tokens} tokens / $${effective.cost_usd} (not clamped)`,
				});
			}
		}
		return findings;
	}

	// -- models -------------------------------------------------------------

	/**
	 * Can each role actually reach a model? This is the check that catches the
	 * expensive mistake: a lease and a branch cut for a worker whose provider has
	 * no credentials. Without a live registry we say "unprobed" and stay green.
	 *
	 * Routing T5 widened *what* is asked, not what is called: every profile is
	 * resolved against every registered project across the whole `PROBE_COMBOS`
	 * grid, so an unreachable model that only an `L` or a `risk: high` row routes
	 * to is found here instead of by the first big job of the day. Still no
	 * inference call, no auth refresh and no write — `resolveModel` is pure over
	 * the config and the registry probe.
	 *
	 * The output is deduplicated rather than multiplied: combinations that
	 * resolve to the same answer share one finding that names them, and a project
	 * whose answers are the baseline's adds no row at all.
	 */
	#models(): DoctorFinding[] {
		const probe = this.#options.probe;
		const profilesDir = join(this.#options.packageRoot, "profiles");
		let profiles: ReturnType<typeof listProfiles>;
		try {
			profiles = listProfiles(profilesDir);
		} catch {
			return []; // already reported by #packageResources
		}
		if (!probe) {
			return [
				{
					check: "models.probe",
					severity: "ok",
					what: "model availability not probed (no live model registry in this context)",
					// cp-u3o4: keyed on the profile NAME, not its role. Two profiles can
					// share a role (qa.md is `role: planner`), and keying on the role
					// rendered the same word twice with no way to tell them apart.
					detail: profiles.map((profile) => `${profile.frontmatter.name}: ${profile.frontmatter.model}`).join(", "),
				},
			];
		}
		let routing: ReturnType<typeof loadRoutingConfig>;
		try {
			routing = loadRoutingConfig(this.#options.home);
		} catch {
			return []; // already reported by #config
		}
		// cp-2bm: routing pins match on role/project/kind/job_id, so probing with a
		// synthetic project reported the model a *fake* job would get. A home that
		// pins per project would have had those rows silently skipped — doctor could
		// say green while a real project's pinned model was unauthenticated. So every
		// registered project is resolved, and a project whose answer differs from the
		// role default gets its own row.
		const findings: DoctorFinding[] = [];
		let projects: string[] = [];
		try {
			projects = new ProjectRegistry({ home: this.#options.home }).names();
		} catch (error) {
			// Silence here would be the same bug this check exists to fix: an
			// unreadable registry means the project-scoped pins were NOT exercised,
			// so say that rather than reporting role defaults as the whole story.
			findings.push({
				check: "models.projects",
				severity: "warn",
				what: "registered projects could not be read; only role-level model resolution was checked",
				detail: (error as Error).message.slice(0, 400),
				fix: "fix data/projects.json (the registry contract is in docs/contracts.md §Project registry), then re-run /doctor",
			});
		}
		// Every rubric id a probe actually resolved to, so "not exercised" below is
		// derived from what happened rather than guessed from the row's shape.
		const fired = new Set<string>();
		for (const profile of profiles) {
			const role: Role = profile.frontmatter.role;
			const who = profile.frontmatter.name;
			// The baseline grid first: it is what a project's answers are compared
			// against, and its rows carry no project name.
			const baseline = this.#grid(profile, role, DOCTOR_PROBE_PROJECT, routing, probe, fired);
			for (const outcome of baseline.values()) {
				findings.push(this.#modelFinding(`models.${who}`, who, outcome));
			}
			// A project whose whole grid answers the way the baseline does adds no row
			// — one line per profile per project would bury the finding that matters.
			// Projects that answer the SAME way as each other share one row and are
			// **all named in it**: suppressing the second one would leave a project
			// whose model cannot be reached mentioned nowhere at all, which is the
			// bug this check exists to catch (cp-2bm), one level up.
			const scoped = new Map<string, ModelOutcome & { projects: string[] }>();
			for (const project of projects) {
				for (const [key, outcome] of this.#grid(profile, role, project, routing, probe, fired)) {
					if (baseline.has(key)) continue;
					const known = scoped.get(key);
					if (known) known.projects.push(project);
					else scoped.set(key, { ...outcome, projects: [project] });
				}
			}
			for (const outcome of scoped.values()) {
				// The names are bounded twice over: by count, and by what `what` may hold
				// (a project name is 64 chars on its own, so ten of them cannot go in raw).
				const named = boundedList(outcome.projects, { max: MAX_LINT_DETAIL, cap: WHAT_MAX - 80, separator: ", " });
				findings.push(this.#modelFinding(`models.${who}.${outcome.projects[0]}`, `${who} in ${named}`, outcome));
			}
		}

		// The honest half of the same finding (cp-2bm, kept through cp-cxt, rewritten
		// by routing T5): the grid above exercises every scope and risk, so what is
		// left unexercised is a row no probe could reach at all — it names a project
		// this home has not registered, or an earlier row shadows it
		// (`config.routing.shadowed` says which). Not a fault, and not silence either.
		const unexercised = routing.rubric.filter((rule) => !fired.has(rule.id));
		if (unexercised.length > 0) {
			findings.push({
				check: "models.rubric",
				severity: "warn",
				what: `${unexercised.length} rubric row(s) were not exercised: no registered project and scope/risk combination reaches them`,
				detail: boundedList(
					unexercised.map((rule) => `${rule.id} -> ${rule.model}`),
					{ max: MAX_LINT_DETAIL, cap: DETAIL_MAX, separator: ", " },
				),
				fix: "register the project the row names, or check `config.routing.shadowed`; to see the exact route a real job would take, run cp_dispatch with dry_run (it takes nothing)",
			});
		}
		return findings;
	}

	/**
	 * One profile's whole `PROBE_COMBOS` grid over one project, folded to its
	 * distinct answers. Keyed by the answer **and** the combinations that produced
	 * it, so "these two projects say the same thing" means the same thing about
	 * the same sizes, never a coincidence of wording.
	 *
	 * `fired` collects the rubric ids that actually matched, so `models.rubric`'s
	 * "not exercised" is derived from what happened rather than guessed.
	 */
	#grid(
		profile: WorkerProfile,
		role: Role,
		project: string,
		routing: ReturnType<typeof loadRoutingConfig>,
		probe: ModelProbe,
		fired: Set<string>,
	): Map<string, ModelOutcome> {
		const bySignature = new Map<string, ModelOutcome>();
		for (const combo of PROBE_COMBOS) {
			const resolved = this.#resolveFor(profile, role, project, combo, routing, probe);
			if (resolved.rule) fired.add(resolved.rule);
			const label = `${combo.scope}/${combo.risk}`;
			const known = bySignature.get(resolved.signature);
			if (known) known.combos.push(label);
			else bySignature.set(resolved.signature, { finding: resolved.finding, summary: resolved.summary, combos: [label] });
		}
		return new Map(
			[...bySignature].map(([signature, outcome]) => [`${signature}\u0000${outcome.combos.join(",")}`, outcome]),
		);
	}

	/**
	 * One grid answer as a finding: who it is about, what it resolved to, and
	 * where. Every field is put through the contract's own bounds — a 64-char
	 * project name in the `check`, several of them in the `what` — because
	 * `validateDoctorReport` refuses the whole report over one long finding.
	 */
	#modelFinding(check: string, where: string, outcome: ModelOutcome): DoctorFinding {
		const detail = [`scope/risk: ${outcome.combos.join(", ")}`, outcome.finding.detail]
			.filter((part): part is string => part !== undefined)
			.join(" | ");
		return {
			...outcome.finding,
			check: cappedCheck(check),
			...cappedWhat(`${where}: ${outcome.summary}`, detail),
		};
	}

	/** One profile/project/scope/risk resolution, as a finding plus a comparable signature. */
	#resolveFor(
		profile: WorkerProfile,
		role: Role,
		project: string,
		combo: { scope: Scope; risk: Risk },
		routing: ReturnType<typeof loadRoutingConfig>,
		probe: ModelProbe,
	): { finding: DoctorFinding; signature: string; summary: string; rule?: string } {
		const request = {
			profile,
			jobId: DOCTOR_PROBE_JOB_ID,
			project,
			kind: role === "implementer" ? ("ship" as const) : ("research" as const),
			scope: combo.scope,
			risk: combo.risk,
		};
		// Which row *matched* is a fact even when the model it names is refused:
		// `pickModel` is the same first-match walk `resolveModel` runs, minus the
		// probe, so an exercised-but-broken row is never reported as unexercised.
		// A row whose model the allowlist rejects makes `pickModel` throw, and the
		// refusal carries the row's id for exactly this reason (`RoutingError.rule`)
		// — without it, doctor advised "register the project" about a row that fired
		// perfectly well and was refused for an entirely different reason.
		let matched: string | undefined;
		try {
			const picked = pickModel(request, routing);
			if (picked.source === "rubric") matched = picked.rule;
		} catch (error) {
			if (error instanceof RoutingError && error.rule) matched = error.rule;
		}
		try {
			const decision = resolveModel(request, routing, probe);
			// A resolvable model is simply ok, and a route with no usable candidate
			// throws — caught below as the error it is. When the answer came from a
			// fallback (pi-command-post-0a9) the summary says so and names what was
			// preferred: "ok" on a one-provider machine is the contract working, but an
			// operator still has to be able to see that today's Anthropic route is
			// running on OpenAI.
			const preferred = decision.attempted?.[0]?.model;
			const summary =
				`${decision.model} (source=${decision.source}${decision.thinking ? `, thinking=${decision.thinking}` : ""}` +
				`${preferred ? `, fallback from ${preferred}` : ""})`;
			// cp-u3o4: the finding is identified by the profile's own name (unique by
			// construction — `parseProfile` pins name to filename), so two profiles
			// sharing a role are two distinguishable rows. For the three profiles
			// named after their role this is the same string as before.
			const who = profile.frontmatter.name;
			return {
				signature: `ok:${summary}`,
				summary,
				finding: { check: `models.${who}`, severity: "ok", what: `${who}: ${summary}` },
				...(matched ? { rule: matched } : {}),
			};
		} catch (error) {
			const message = (error as Error).message.slice(0, 600);
			const who = profile.frontmatter.name;
			const refusal = error instanceof RoutingError ? error.refusal : undefined;
			if (error instanceof RoutingError && error.rule) matched = error.rule;
			return {
				signature: `error:${message}`,
				summary: refusal === undefined ? "no usable model" : REFUSAL_SUMMARY[refusal],
				finding: {
					check: `models.${who}`,
					severity: "error",
					what: `${who} has no usable model`,
					detail: message,
					fix: cappedFix(refusalFix(refusal, who)),
				},
				...(matched ? { rule: matched } : {}),
			};
		}
	}

	// -- scaffold and home hygiene -----------------------------------------

	#scaffold(): DoctorFinding[] {
		const findings: DoctorFinding[] = [];

		const modeLine = describeRuntime(this.#runtime);
		findings.push({ check: "mode", severity: "ok", ...cappedWhat(modeLine) });

		// T30: where the home came from, and whether it is a place pi will delete.
		// An installed package whose home is inside its own clone loses the fleet on
		// the next `pi update --extensions` (docs/packages.md: pi "resets and cleans
		// the clone"), so this is an error, not a note.
		const resolution = describeHome(this.#options.env ?? process.env, this.#options.packageRoot);
		const homeInsidePackage = isInside(resolve(this.#options.home), resolve(this.#options.packageRoot));
		if (isManagedInstall(this.#options.packageRoot) && homeInsidePackage) {
			findings.push({
				check: "home.location",
				severity: "error",
				what: "the home is inside an installed package clone, which pi resets on update",
				detail: `home ${this.#options.home} is inside ${this.#options.packageRoot}`,
				fix: `move the home out of the clone: unset CP_HOME to use ${resolution.home}, or set CP_HOME to a directory you own`,
			});
		} else {
			findings.push({
				check: "home.location",
				severity: "ok",
				...cappedWhat(`home (${resolution.source}): ${this.#options.home}`, resolution.reason),
			});
		}
		const dirs: Array<[string, string]> = [
			["data", LAYOUT.data],
			["state", LAYOUT.state],
			["projects", LAYOUT.projects],
		];
		for (const [key, dir] of dirs) {
			const path = join(this.#options.home, dir);
			if (!existsSync(path)) {
				findings.push({
					check: `scaffold.${key}`,
					severity: "warn",
					what: `${dir}/ does not exist yet`,
					detail: path,
					fix: "start a pi session in this home: session_start scaffolds it (idempotently)",
				});
				continue;
			}
			try {
				accessSync(path, constants.W_OK);
				findings.push({ check: `scaffold.${key}`, severity: "ok", what: `${dir}/ present and writable` });
			} catch {
				findings.push({
					check: `scaffold.${key}`,
					severity: "error",
					what: `${dir}/ is not writable`,
					detail: path,
					fix: `fix permissions on ${path} (the fleet cannot record what it is doing)`,
				});
			}
		}

		// The T19 guards refuse to stage runtime state, but a .gitignore that
		// does not list it means one `git add` in another tool leaks the fleet.
		const gitignore = join(this.#options.home, ".gitignore");
		if (existsSync(gitignore)) {
			const text = readFileSync(gitignore, "utf8");
			const missing = NEVER_COMMIT_PATHS.filter(
				(entry) => !text.split("\n").some((line) => {
					const rule = line.trim();
					return rule === entry || rule === entry.replace(/\/$/, "");
				}),
			);
			// Uniform over NEVER_COMMIT_PATHS (cp-rnr): the T19 guard refuses to
			// stage any of them, so a .gitignore that omits one is a real gap. The
			// build-time exemption for `.beads/` is gone with the tracked ledger.
			if (missing.length > 0) {
				findings.push({
					check: "home.gitignore",
					severity: "warn",
					what: `.gitignore does not list ${missing.join(", ")}`,
					fix: `add ${missing.join(", ")} to ${gitignore} (runtime state must never be committed)`,
				});
			} else {
				findings.push({ check: "home.gitignore", severity: "ok", what: ".gitignore covers runtime state" });
			}
		}
		return findings;
	}

	// -- one parent per home ------------------------------------------------

	/**
	 * `state/parent.lock` (cp-epy2 §4.2 item 2). Three facts, three different
	 * pieces of advice, and none of them is "probably fine": a lock this build
	 * cannot read refuses every parent start, so it must be *visible* here or an
	 * operator would only meet it as a session that will not begin.
	 */
	#parentLock(): DoctorFinding[] {
		const read = readParentLock(this.#options.home);
		if (read.state === "absent") {
			return [{ check: "parent.lock", severity: "ok", what: "no parent lock held for this home", detail: read.path }];
		}
		if (read.state === "unreadable") {
			return [
				{
					check: "parent.lock",
					severity: "warn",
					what: "the parent lock cannot be read as a lock",
					detail: read.reason.slice(0, 400),
					fix: `inspect it and remove it if no parent session is running (\`rm ${read.path}\`): a lock this build cannot read is refused rather than assumed free, so no parent can start on this home until it is gone`,
				},
			];
		}
		const holder = read.record;
		if (holder.pid === process.pid) {
			return [
				{
					check: "parent.lock",
					severity: "ok",
					what: `parent lock held by this session (pid ${holder.pid})`,
					detail: `since ${holder.started_at} (${read.path})`,
				},
			];
		}
		if (this.#isPidAlive(holder.pid)) {
			return [
				{
					check: "parent.lock",
					severity: "warn",
					what: `another parent process holds this home (pid ${holder.pid})`,
					detail: `since ${holder.started_at} (${read.path})`,
					fix: "one parent per home is a contract (cp-ga6j: two of them orphan live workers) — use that session, or stop it before starting another",
				},
			];
		}
		return [
			{
				check: "parent.lock",
				severity: "warn",
				what: `stale parent lock: pid ${holder.pid} is not alive`,
				detail: `held since ${holder.started_at} (${read.path})`,
				fix: `the next session_start reclaims it after probing the pid; remove it by hand (\`rm ${read.path}\`) if you would rather not wait`,
			},
		];
	}

	// -- state migrations ---------------------------------------------------

	/** The job_id -> job_id sweep (spec 2026-09-04, PR 1): has this home been moved? */
	#migrations(): DoctorFinding[] {
		return [jobIdMigrationFinding(this.#options.home)];
	}

	// -- worktree pool ------------------------------------------------------

	/**
	 * Is this project's treehouse pool ours alone? (cp-b8el Experiment B.)
	 *
	 * The pool is keyed by clone-dir basename plus a hash of the origin URL, so
	 * two homes that clone one remote into `projects/<name>` draw slots from ONE
	 * pool — and a home can be handed a worktree of the *other* home's clone.
	 * `LeaseManager#verify` fails closed on that (the lease is returned and the
	 * dispatch refused), which is safe and completely mystifying; this is where
	 * the cause is named.
	 *
	 * Silent by design when there is nothing to say: no registry, no clone, no
	 * treehouse, no pool, or an unparseable answer all produce **no finding**. A
	 * read-only check must not invent a fault out of a question it could not ask.
	 */
	#pool(): DoctorFinding[] {
		let names: string[];
		try {
			names = new ProjectRegistry({ home: this.#options.home }).names();
		} catch {
			return []; // already reported by models.projects
		}
		const findings: DoctorFinding[] = [];
		for (const name of names) {
			const clone = join(this.#options.home, paths.projectDir(name));
			if (!existsSync(clone)) continue; // preflight's business, not the pool's
			const cloneCommon = this.#gitCommonDir(clone);
			if (!cloneCommon) continue;
			const poolRoot = this.#options.poolRoot;
			const result = this.#run(
				"treehouse",
				[...(poolRoot ? ["--root", poolRoot] : []), "status", "--json"],
				clone,
			);
			if (result.status !== 0) continue;
			const entries = parsePoolStatus(result.stdout);
			if (!entries || entries.length === 0) continue;
			const foreign: string[] = [];
			for (const entry of entries.slice(0, MAX_POOL_PROBES)) {
				if (!existsSync(entry)) continue;
				const common = this.#gitCommonDir(entry);
				if (!common || common === cloneCommon) continue;
				foreign.push(`${entry} -> ${common}`);
			}
			if (foreign.length === 0) {
				findings.push({
					check: `pool.${name}`,
					severity: "ok",
					what: `${name}'s worktree pool: ${entries.length} worktree(s), all this home's clone`,
					detail: cloneCommon,
				});
				continue;
			}
			findings.push({
				check: `pool.${name}`,
				severity: "warn",
				what: `${foreign.length} worktree(s) in ${name}'s pool belong to another clone, not ${clone}`,
				detail: `${foreign.join(" | ")} (expected git-common-dir ${cloneCommon})`,
				fix: `another home shares this pool: give each home its own by setting ${ENV_TREEHOUSE_ROOT} to a directory per home (a lease from a foreign clone is refused at dispatch, so this shows up as an unexplained lease failure)`,
			});
		}
		return findings;
	}

	/** `git rev-parse --git-common-dir`, absolute, or `undefined` if unaskable. */
	#gitCommonDir(cwd: string): string | undefined {
		const result = this.#run("git", ["rev-parse", "--git-common-dir"], cwd);
		if (result.status !== 0) return undefined;
		const raw = result.stdout.trim();
		if (raw.length === 0) return undefined;
		return resolve(cwd, raw);
	}

	// -- fleet consistency --------------------------------------------------

	/**
	 * Read-only consistency, not reconcile: doctor reports, `session_start`
	 * repairs. A dead worker here is a finding with the fix; it is not silently
	 * moved to `failed`.
	 */
	#fleetConsistency(): DoctorFinding[] {
		let jobs: ReturnType<FleetStore["read"]>["jobs"];
		try {
			jobs = this.#options.fleet.read().jobs;
		} catch (error) {
			return [
				{
					check: "fleet.file",
					severity: "error",
					what: "state/fleet.json cannot be read",
					detail: (error as Error).message.slice(0, 600),
					fix: "move state/fleet.json aside to start clean; in-flight jobs are still in br and in state/runs/",
				},
			];
		}
		const findings: DoctorFinding[] = [
			{ check: "fleet.file", severity: "ok", what: `fleet: ${jobs.length} record(s)` },
		];
		for (const job of jobs) {
			const runDir = join(this.#options.home, paths.runDir(job.job_id));
			if (!existsSync(runDir)) {
				findings.push({
					check: "fleet.run_dir",
					severity: "warn",
					what: `${job.job_id} has no run directory`,
					detail: runDir,
					fix: `nothing was ever observed for this job; tear it down (\`cp_teardown ${job.job_id}\`) once you know why`,
				});
			}
			if (job.phase === "done" || job.phase === "failed") continue;

			if (isScriptFleetRecord(job)) {
				const handle = job.script_process;
				const exit = handle ?? job.script_observed_exit;
				const observed = exit?.exited_at ? `exited ${exit.exited_at} (${exit.exit_code ?? exit.signal ?? "unknown"})` : handle ? this.#isPidAlive(handle.pid) ? "running" : "no observed exit" : "launch outcome unknown; no pid observed";
				findings.push({
					check: "fleet.worker", severity: !exit || observed === "no observed exit" ? "warn" : "ok",
					what: `${job.job_id} script ${job.script_path} (pid ${handle?.pid ?? "unknown"}): ${observed}`,
					...(!exit || observed === "no observed exit" ? { fix: `restart the parent to reconcile, or inspect ${job.worktree}; never replay the script` } : {}),
				});
			} else {
				const alive = job.worker.exited_at ? false : this.#isPidAlive(job.worker.pid);
				if (!alive) {
					const session = existsSync(job.worker.session_file);
					findings.push({
						check: "fleet.worker", severity: "warn",
						what: `${job.job_id} is ${job.phase} but its worker (pid ${job.worker.pid}) is gone`,
						...(session ? { detail: `session survives: ${job.worker.session_file}` } : {}),
						fix: session
							? `restart the parent to reconcile, or revive it with \`cp_revive ${job.job_id}\``
							: `restart the parent to reconcile, then re-dispatch or tear ${job.job_id} down`,
					});
				}
			}
			if (!existsSync(job.worktree)) {
				findings.push({
					check: "fleet.worktree",
					severity: "warn",
					what: `${job.job_id}'s worktree is gone`,
					detail: job.worktree,
					fix: `\`cp_teardown ${job.job_id} --force\` (force is authorization to close a job whose worktree vanished)`,
				});
			}
		}
		return findings;
	}
}

/**
 * How loudly a missing tool reads. `error` means **this home cannot dispatch**,
 * which is exactly what the footer says, so a tool that only blocks a later
 * step must not claim it: a home with no `gh` dispatches, runs and reports every
 * job perfectly well — it simply cannot record a merge or run `cp_integrate`,
 * and calling that "cannot dispatch" would train an operator to ignore doctor
 * (the same reason `#conflictingVersions` refuses to flag duplicate paths).
 *
 * Typechecked against `REQUIRED_TOOLS` like `TOOL_FIX` and `TOOL_INSTALL`: a
 * tool added without a severity is a compile error, not a silent default.
 */
const TOOL_SEVERITY: Readonly<Record<RequiredTool, "error" | "warn">> = Object.freeze({
	git: "error",
	treehouse: "error",
	pi: "error",
	gh: "warn",
});

const TOOL_FIX: Readonly<Record<(typeof REQUIRED_TOOLS)[number], string>> = Object.freeze({
	git: `install git (\`${installScriptHint("git")}\` on macOS via Homebrew; Linux needs your package manager by hand): every project is a clone and every job is a branch`,
	treehouse: `install treehouse (\`${installScriptHint("treehouse")}\`): worktrees come from treehouse and only from treehouse (there is no \`git worktree add\` fallback, by contract)`,
	pi: `install pi and put it on PATH (\`${installScriptHint("pi")}\`): every worker is a \`pi --mode rpc\` child`,
	gh: `install the GitHub CLI (\`${installScriptHint("gh")}\`): merge receipts and cp_integrate read the PR and its CI from \`gh\`, and without it a landed job can only be closed with force`,
});

const SEVERITY_GLYPH: Readonly<Record<DoctorSeverity, string>> = Object.freeze({ ok: "✓", warn: "!", error: "✗" });

/**
 * The worktree paths in `treehouse status --json`.
 *
 * treehouse prints an update banner on stdout before the JSON, so the array is
 * located rather than assumed to start at byte 0 (the same rule the test
 * harness's `poolStatus` follows). `undefined` means "could not be read",
 * which every caller treats as no finding — never as an empty pool.
 */
export function parsePoolStatus(stdout: string): string[] | undefined {
	const start = stdout.indexOf("[");
	if (start < 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.slice(start));
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const paths: string[] = [];
	for (const entry of parsed) {
		const path = (entry as { path?: unknown }).path;
		if (typeof path === "string" && path.length > 0) paths.push(path);
	}
	return paths;
}

/** Human output: problems first, then what is fine. Fixes are indented under. */
export function formatDoctor(report: DoctorReport): string {
	const lines = [
		`DOCTOR ${report.ok ? "ok" : "BROKEN"} · ${report.counts.error} error · ${report.counts.warn} warn · ${report.counts.ok} ok (at ${report.generated_at})`,
		`home: ${report.home}`,
		`package: ${report.package_root}`,
		"",
	];
	for (const severity of ["error", "warn", "ok"] as const) {
		const group = report.findings.filter((finding) => finding.severity === severity);
		if (group.length === 0) continue;
		for (const finding of group) {
			lines.push(`${SEVERITY_GLYPH[severity]} [${finding.check}] ${finding.what}`);
			if (finding.detail) lines.push(`    ${finding.detail}`);
			if (finding.fix) lines.push(`    fix: ${finding.fix}`);
		}
		lines.push("");
	}
	if (!report.ok) lines.push("this home cannot dispatch until the errors above are fixed");
	return lines.join("\n").trimEnd();
}

export function formatDoctorJson(report: DoctorReport): string {
	return JSON.stringify(report, null, 2);
}
