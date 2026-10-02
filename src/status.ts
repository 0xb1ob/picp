/**
 * Status (T23) — the read-only fleet view, ported from `cmdp status`.
 *
 * Three layers, deliberately separated:
 *
 *  1. `assembleStatus()` — pure. Facts in (fleet records, run projections, pid
 *     probes, a ledger join), one `StatusSnapshot` out. This is what the golden
 *     files pin.
 *  2. `StatusReporter` — collects those facts from the only sanctioned read
 *     surfaces (`state/fleet.json`, `state/runs/<id>/status.json`) plus an
 *     optional ledger `list()` join, and never writes anything.
 *  3. `formatStatusTable()` — rendering. Glyphs and column widths live here,
 *     not in the payload. The widget is its own renderer (`widget.ts`), over
 *     the same snapshot and the same cell vocabulary (`status-render.ts`).
 *
 * What the port dropped, and why:
 *
 *  - **The broker block.** There is no paste broker; delivery receipts are
 *    facts (T3/T15). Its *shape* survives as the `ledger` block: a read-only
 *    view must still render when a dependency is missing, so a failed join is
 *    reported as degraded instead of refusing to answer.
 *  - **`stalled`.** It meant "idle pane + old dispatch + no reported_at", i.e.
 *    a guess about an unobservable pane. Phases here are exactly
 *    `waiting|held|done|failed`; liveness is the run projection plus a pid
 *    probe, and nothing is inferred from age.
 *  - **`joined_via`, `cli`, `pane`, `session`, `drawing`.** The join is not a
 *    heuristic any more (fleet.json is keyed by job id), there is one CLI, and
 *    there are no panes.
 *  - **`glyph` in the payload.** It was a dashboard field, and the HTML
 *    dashboard is out of scope. The renderer owns glyphs.
 *  - **`orphaned` nodes** synthesized from the ledger keep their *meaning* —
 *    the ledger says work is in flight that this home has no record of — but
 *    land in `unclaimed[]` rather than becoming a fifth job phase.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	describeUnreportedWork,
	type FleetRecord,
	isoTimestamp,
	type JobPhase,
	paths,
	type PendingReview,
	type QuestionMethod,
	type RunStatus,
	SCHEMA_VERSION,
	STATUS_ACTIVE_PHASES,
	type StatusInclude,
	type StatusJob,
	type StatusLedger,
	type StatusSnapshot,
	type StatusUnclaimed,
	type Usage,
	unreportedWorkPresent,
	validateStatusSnapshot,
	isScriptFleetRecord,
} from "./contracts.ts";
export type { JobRouting } from "./contracts.ts";
import { CiWatchStore } from "./ci-watch.ts";
import { type FleetStore, isPidAlive as probePid } from "./fleet.ts";
import { readReviewPassHeads, shaMatches } from "./merge-ask.ts";
import { listPendingReviews } from "./review-runs.ts";
// The cell vocabulary lives in one module so the table, the widget and the
// status block can never disagree about a job's state (cp-8tu). Re-exported
// here because `src/status.ts` has been every caller's import site since T23.
import {
	ageSeconds,
	formatAge,
	formatCost,
	formatScopeRisk,
	formatThinking,
	formatTokens,
	isLongToolCall,
	isWedgedToolCall,
	runLabel,
	settledWithoutReport,
	shortModel,
	toolCell,
	waitReason,
} from "./status-render.ts";
export {
	ageSeconds,
	chooseTokenUnit,
	formatAge,
	formatCost,
	formatScopeRisk,
	formatThinking,
	formatTokens,
	formatTokensIn,
	isLongToolCall,
	isWedgedToolCall,
	jobState,
	runLabel,
	settledWithoutReport,
	shortModel,
	toolCell,
	waitingOnOperator,
	WAIT_REASON_MAX_CHARS,
	waitReason,
} from "./status-render.ts";
export type { JobState, JobStateKind, TokenUnit, WidgetSection } from "./status-render.ts";
import { type Job, type Ledger, parseJobLabels } from "./ledger.ts";
import { groupByProject } from "./project-report.ts";
import type { QuestionStore } from "./questions.ts";
import { readStatusFile } from "./run-artifacts.ts";
import type { DrainProjection } from "./worker-manager.ts";
export type { DrainProjection } from "./worker-manager.ts";

export class StatusError extends Error {}

/**
 * Cap for the **cosmetic** half of the ledger join (titles of finished jobs).
 * The membership half is never capped — see `snapshot()`.
 */
export const STATUS_LEDGER_LIMIT = 200;

/** Ordering: what needs attention first, then oldest first, then by id. */
const PHASE_RANK: Readonly<Record<JobPhase, number>> = Object.freeze({
	launching: 0,
	waiting: 1,
	held: 2,
	failed: 3,
	done: 4,
});

// ---------------------------------------------------------------------------
// Pure assembly
// ---------------------------------------------------------------------------

export interface StatusFacts {
	home: string;
	generated_at: string;
	include: StatusInclude;
	project?: string;
	/** Every record in the fleet; filtering happens here, not at the reader. */
	records: readonly FleetRecord[];
	/** Run projections, keyed by job id. Absent = the run has no status.json. */
	runs: ReadonlyMap<string, RunStatus>;
	/** pid probe results, keyed by job id. Absent = not probed = not alive. */
	alive: ReadonlyMap<string, boolean>;
	ledger: StatusLedger;
	/** Ledger jobs from the join, used for titles and for `unclaimed`. */
	issues?: readonly Job[];
	/**
	 * Unanswered operator questions, keyed by job id (T31). A job waiting on a
	 * human is still `waiting` — this is the detail that says *why*, so an
	 * operator does not read a quiet worker as a stuck one.
	 */
	questions?: ReadonlyMap<string, { seq: number; question: string; asked_at: string; method?: QuestionMethod }>;
	/** Blocker counts for waiting planners, keyed by job id. Absent means none. */
	blockers?: ReadonlyMap<string, number>;
	/**
	 * The first pending reviewer attempt per job (spec 2026-09-05), read from
	 * each attempt directory's `pending.json`. Files only, like everything here.
	 */
	pendingReviews?: ReadonlyMap<string, PendingReview>;
	/**
	 * What this home has already observed about each job's CI and review
	 * (cp-status-wait-reasons): `state/ci-watch.json` plus the job's own review
	 * verdict files. Carried, never re-derived, and files only — `/status` and
	 * the widget must never issue a `gh` call.
	 */
	ci?: ReadonlyMap<string, StatusJob["ci"]>;
}

function addUsage(total: Usage, add: Usage): Usage {
	return {
		input: total.input + add.input,
		output: total.output + add.output,
		cache_read: total.cache_read + add.cache_read,
		cache_write: total.cache_write + add.cache_write,
		total_tokens: total.total_tokens + add.total_tokens,
		cost_usd: total.cost_usd + add.cost_usd,
	};
}

/** Labels are best-effort here: a malformed issue must not break the view. */
function issueProject(issue: Job): string | null {
	try {
		return parseJobLabels(issue.labels ?? []).project ?? null;
	} catch {
		return null;
	}
}

function isContractTimestamp(value: unknown): value is string {
	return typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value);
}

/**
 * The ledger writes RFC3339 second precision already; truncate rather than
 * reject anyway — an age we can compute beats a field we drop.
 */
function toContractTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || value.length < 20) return null;
	const truncated = `${value.slice(0, 19)}Z`;
	return isContractTimestamp(truncated) ? truncated : null;
}

/**
 * One snapshot from one set of facts. Deterministic: the only inputs are the
 * arguments, and the row order is fully specified.
 */
export function assembleStatus(facts: StatusFacts): StatusSnapshot {
	const project = facts.project ?? null;
	const phases = facts.include === "all" ? undefined : STATUS_ACTIVE_PHASES;
	const issuesById = new Map<string, Job>();
	for (const issue of facts.issues ?? []) issuesById.set(issue.id, issue);

	const jobs: StatusJob[] = [];
	let usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost_usd: 0 };
	let live = 0;
	let working = 0;

	for (const record of facts.records) {
		if (phases && !phases.includes(record.phase)) continue;
		if (project !== null && record.project !== project) continue;
		const run = facts.runs.get(record.job_id);
		const issue = issuesById.get(record.job_id);
		// An observed close outranks a live pid: pids get reused, observations
		// do not. A record that already exited is never probed.
		const script = isScriptFleetRecord(record);
		const alive = script ? (record.script_process?.exited_at || !record.script_process ? false : (facts.alive.get(record.job_id) ?? false)) : record.worker.exited_at ? false : (facts.alive.get(record.job_id) ?? false);
		const runPhase = run?.phase ?? null;
		// See the `usage` field comment below for why the run projection wins.
		const jobUsage = run?.usage ?? record.usage;
		const job: StatusJob = {
			job_id: record.job_id,
			project: record.project,
			kind: record.kind,
			delivery: record.delivery,
			origin: record.origin,
			phase: record.phase,
			title: issue?.title ?? null,
			br_status: issue?.status ?? null,
			...(script ? { executor: "script" as const, script_path: record.script_path, script_process: record.script_process, ...(record.script_observed_exit ? { script_observed_exit: record.script_observed_exit } : {}) } : { profile: record.worker.profile, role: record.worker.role, model: run?.model ?? record.worker.model }),
			// One source of truth, same rule as `usage` above: the run projection is
			// what a live worker updates on every event (including an override), the
			// fleet record is dispatch-time-only. Fall back to the record only when
			// there is no run projection yet.
			run_phase: runPhase,
			current_tool: run?.current_tool?.name ?? null,
			// Observed, not inferred: the same started_at the run projection already
			// records, measured against generated_at. Null when nothing is in flight.
			current_tool_seconds: run?.current_tool ? ageSeconds(run.current_tool.started_at, facts.generated_at) : null,
			// Same observed source, different question: how long has this call been
			// SILENT. `last_progress_at` is the last tool_execution_update for this
			// exact call; with none, the start is the last thing we know.
			current_tool_idle_seconds: run?.current_tool
				? ageSeconds(run.current_tool.last_progress_at ?? run.current_tool.started_at, facts.generated_at)
				: null,
			// Only ever carried when true: a completed auto-retry leaves nothing
			// behind, and absent is the ordinary case.
			...(run?.retrying ? { retrying: true } : {}),
			turns: run?.turns ?? 0,
			tool_calls: run?.tool_calls ?? 0,
			alive,
			pid: script ? (record.script_process?.pid ?? null) : record.worker.pid,
			...(!script ? { session_id: record.worker.session_id } : {}),
			worktree: record.worktree,
			branch: record.branch,
			timestamp: record.dispatched_at,
			time_source: "dispatched_at",
			age_seconds: ageSeconds(record.dispatched_at, facts.generated_at),
			last_activity_at: run?.last_activity_at ?? null,
			// One source of truth: the run projection (status.json) is what a live
			// worker updates on every event, and it is what /watch and the cp_send
			// budget gate already read (see run-artifacts.ts, send.ts#checkBudget).
			// The fleet record's usage is only patched at intake/teardown, so for a
			// job still running it is stale (often still EMPTY_USAGE) -- reading it
			// here was the bug: /status showed 0/$0.00 while the run had real spend.
			// Fall back to the fleet record only when there is no run projection at
			// all (a job with no status.json, e.g. before its first event).
			usage: jobUsage,
			...(record.reported_at ? { reported_at: record.reported_at } : {}),
			...(record.closed_at ? { closed_at: record.closed_at } : {}),
			...(record.failure ? { failure: record.failure } : {}),
			...(record.receipts ? { receipts: record.receipts } : {}),
			// cp-settle-without-report: carried straight through, never recomputed.
			// It is what makes a finished-but-unreported job say `unreported` instead
			// of `idle` while its worker is still standing there, promotable.
			...(record.unreported_settles ? { unreported_settles: record.unreported_settles } : {}),
			// cp-0dhw: and what that settle found on disk. Same rule — carried, never
			// re-derived: `/status` must not run git of its own.
			...(record.unreported_work ? { unreported_work: record.unreported_work } : {}),
			...(record.closed_reason ? { closed_reason: record.closed_reason } : {}),
			...(facts.questions?.get(record.job_id) ? { open_question: facts.questions.get(record.job_id) } : {}),
			...(facts.blockers?.get(record.job_id) ? { blockers: facts.blockers.get(record.job_id) } : {}),
			// cp-status-scope-risk: carried through from the fleet record, never
			// recomputed — the record IS the routing decision's own scope/risk/
			// thinking, captured once at dispatch time. Absent means dispatched
			// before this field existed, and stays absent (rendered as unknown).
			...(record.routing ? { routing: record.routing } : {}),
			// spec 2026-09-05: a reviewer running in the background. Read from
			// `pending.json`, carried through, never a phase of its own.
			// cp-status-wait-reasons: carried through, never re-derived here.
			...(facts.ci?.get(record.job_id) ? { ci: facts.ci.get(record.job_id) } : {}),
			...(facts.pendingReviews?.get(record.job_id)
				? {
						pending_review: (({ surface, attempt, started_at, deadline }) => ({
							surface,
							attempt,
							started_at,
							deadline,
						}))(facts.pendingReviews.get(record.job_id) as PendingReview),
					}
				: {}),
		};
		jobs.push(job);
		usage = addUsage(usage, jobUsage);
		if (alive) live += 1;
		if (alive && runPhase === "working") working += 1;
	}

	jobs.sort((a, b) => {
		const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
		if (rank !== 0) return rank;
		if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
		return a.job_id < b.job_id ? -1 : 1;
	});

	// Unclaimed is measured against the WHOLE fleet, never the filtered view:
	// a job hidden by `--project` is still claimed.
	const known = new Set(facts.records.map((record) => record.job_id));
	const unclaimed: StatusUnclaimed[] = [];
	for (const issue of issuesById.values()) {
		if (issue.status !== "in_progress" || known.has(issue.id)) continue;
		const issueProjectName = issueProject(issue);
		if (project !== null && issueProjectName !== project) continue;
		const timestamp = toContractTimestamp(issue.updated_at);
		unclaimed.push({
			job_id: issue.id,
			title: issue.title ?? null,
			br_status: issue.status,
			project: issueProjectName,
			timestamp,
			time_source: "br_updated_at",
			age_seconds: timestamp ? ageSeconds(timestamp, facts.generated_at) : null,
		});
	}
	unclaimed.sort((a, b) => (a.job_id < b.job_id ? -1 : 1));

	const snapshot: StatusSnapshot = {
		schema_version: SCHEMA_VERSION,
		generated_at: facts.generated_at,
		home: facts.home,
		filter: { include: facts.include, project },
		counts: {
			jobs: jobs.length,
			launching: jobs.filter((job) => job.phase === "launching").length,
			waiting: jobs.filter((job) => job.phase === "waiting").length,
			held: jobs.filter((job) => job.phase === "held").length,
			done: jobs.filter((job) => job.phase === "done").length,
			failed: jobs.filter((job) => job.phase === "failed").length,
			live,
			working,
		},
		usage,
		ledger: facts.ledger,
		jobs,
		unclaimed,
	};
	const result = validateStatusSnapshot(snapshot);
	if (!result.ok) {
		// Our own output disagreeing with its contract is a bug, not a view.
		throw new StatusError(`assembled an invalid status snapshot:\n  ${result.errors.join("\n  ")}`);
	}
	return result.value;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------


/** Blockers on a waiting planner's filed envelope, or undefined. A bad file is none, never a throw. */
function blockerCount(home: string, record: FleetRecord): number | undefined {
	if (record.phase !== "waiting" || !record.planner_blocked_rounds) return undefined;
	try {
		const raw = JSON.parse(readFileSync(join(home, paths.envelopeFile(record.job_id)), "utf8")) as {
			envelope?: { blockers?: unknown };
		};
		const blockers = raw.envelope?.blockers;
		return Array.isArray(blockers) && blockers.length > 0 ? blockers.length : undefined;
	} catch {
		return undefined;
	}
}

export interface StatusReporterOptions {
	home: string;
	fleet: FleetStore;
	/**
	 * Built per call, because the registry gate changes with the project
	 * registry. Absent means no ledger join is possible.
	 */
	ledger?: () => Ledger;
	now?: () => Date;
	/** Injected in tests; production probes the real process table. */
	isPidAlive?: (pid: number) => boolean;
	/** Operator questions (T31); absent means the column is simply never shown. */
	questions?: QuestionStore;
}

export interface StatusQuery {
	/** `active` (default) hides torn-down jobs; `all` shows the whole file. */
	include?: StatusInclude;
	project?: string;
	/** Join the ledger for titles and unclaimed jobs. Default on for `snapshot()`. */
	titles?: boolean;
}

export class StatusReporter {
	readonly home: string;
	readonly #options: StatusReporterOptions;
	readonly #now: () => Date;
	readonly #isPidAlive: (pid: number) => boolean;

	constructor(options: StatusReporterOptions) {
		this.home = options.home;
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
		this.#isPidAlive = options.isPidAlive ?? probePid;
	}

	/**
	 * The file-only snapshot: fleet.json, the run projections and a pid probe.
	 * Synchronous and cheap enough to run on a widget refresh.
	 */
	collect(query: StatusQuery = {}): StatusSnapshot {
		return this.#assemble(query, { ok: false, queried: false }, undefined);
	}

	/**
	 * `collect()` plus the ledger join (titles, and jobs the ledger calls
	 * in_progress that this home has no record of). A join failure degrades the
	 * snapshot instead of failing it: a fleet view that refuses to render
	 * because the ledger is unreadable tells the operator nothing about the
	 * workers that are running.
	 */
	async snapshot(query: StatusQuery = {}): Promise<StatusSnapshot> {
		if (query.titles === false) return this.collect(query);
		const build = this.#options.ledger;
		if (!build) {
			return this.#assemble(query, { ok: false, queried: true, error: "no ledger configured for this home" }, undefined);
		}
		try {
			const ledger = build();
			// `unclaimed` decides *membership* ("the ledger says in_progress and this
			// fleet has no record"), so this query must not be capped: `ready`/
			// `blocked`/`list` are never paged (src/ledger.ts), and a
			// capped page would silently under-report exactly the jobs nobody owns.
			// The set is inherently small — an in_progress issue is a claimed job.
			const issues = await ledger.list({ status: "in_progress", limit: 0 });
			if ((query.include ?? "active") === "all") {
				// Titles for torn-down jobs are cosmetic, so this one may be capped.
				issues.push(...(await ledger.list({ status: "closed", limit: STATUS_LEDGER_LIMIT })));
			}
			return this.#assemble(query, { ok: true, queried: true }, issues);
		} catch (error) {
			return this.#assemble(query, { ok: false, queried: true, error: (error as Error).message }, undefined);
		}
	}

	#assemble(query: StatusQuery, ledger: StatusLedger, issues: readonly Job[] | undefined): StatusSnapshot {
		const records = this.#options.fleet.read().jobs;
		const runs = new Map<string, RunStatus>();
		const alive = new Map<string, boolean>();
		for (const record of records) {
			const run = readStatusFile(this.home, record.job_id);
			if (run) runs.set(record.job_id, run);
			const handle = isScriptFleetRecord(record) ? record.script_process : record.worker;
			if (handle && !handle.exited_at) alive.set(record.job_id, this.#isPidAlive(handle.pid));
		}
		const questions = new Map<string, { seq: number; question: string; asked_at: string; method?: QuestionMethod }>();
		const store = this.#options.questions;
		if (store) {
			for (const record of records) {
				const open = store.open(record.job_id);
				if (open) {
					questions.set(record.job_id, {
						seq: open.seq,
						question: open.question,
						asked_at: open.asked_at,
						method: open.method,
					});
				}
			}
		}
		const blockers = new Map<string, number>();
		for (const record of records) {
			const count = blockerCount(this.home, record);
			if (count) blockers.set(record.job_id, count);
		}
		const pendingReviews = new Map<string, PendingReview>();
		for (const record of records) {
			const first = listPendingReviews(this.home, record.job_id)[0];
			if (first) pendingReviews.set(record.job_id, first);
		}
		// cp-status-wait-reasons: two local files per job at most — the watcher's
		// last observation, and this job's own review verdicts — so a held row can
		// say what it is waiting on without asking `gh` anything.
		const ci = new Map<string, StatusJob["ci"]>();
		for (const watched of new CiWatchStore({ home: this.home }).read().jobs) {
			const head = watched.head_sha;
			ci.set(watched.job_id, {
				...(head ? { head_sha: head } : {}),
				...(watched.last_ci ? { state: watched.last_ci } : {}),
				...(head && readReviewPassHeads(this.home, watched.job_id).some((sha) => shaMatches(sha, head))
					? { reviewed: true }
					: {}),
			});
		}
		return assembleStatus({
			home: this.home,
			generated_at: isoTimestamp(this.#now()),
			include: query.include ?? "active",
			...(query.project ? { project: query.project } : {}),
			records,
			runs,
			alive,
			ledger,
			...(issues ? { issues } : {}),
			...(questions.size > 0 ? { questions } : {}),
			...(blockers.size > 0 ? { blockers } : {}),
			...(pendingReviews.size > 0 ? { pendingReviews } : {}),
			...(ci.size > 0 ? { ci } : {}),
		});
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
	const text = value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;
	return text.padEnd(width);
}

function truncate(value: string, width: number): string {
	return value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;
}

const COLUMNS: ReadonlyArray<{ header: string; width: number }> = Object.freeze([
	{ header: "JOB", width: 24 },
	{ header: "PROJECT", width: 14 },
	{ header: "KIND", width: 8 },
	{ header: "MODEL", width: 16 },
	// The routing inputs that decided MODEL, so the choice is explainable next
	// to it (cp-status-scope-risk) instead of only in the run log.
	{ header: "SCOPE/RISK", width: 11 },
	{ header: "THINK", width: 8 },
	{ header: "PHASE", width: 8 },
	{ header: "RUN", width: 8 },
	{ header: "TOOL", width: 10 },
	{ header: "AGE", width: 5 },
	{ header: "TOKENS", width: 7 },
	{ header: "COST", width: 7 },
]);

function row(cells: readonly string[], title: string): string {
	const padded = COLUMNS.map((column, index) => pad(cells[index] ?? "-", column.width));
	return `${padded.join(" ")} ${title}`.trimEnd();
}

/**
 * The one-line fleet headline, shared by the table and the widget.
 *
 * `waiting`/`held`/`failed`/`done` are disjoint job phases and sum to the
 * total; `live` and `working` are not a second job count, they are facets of
 * the SAME jobs (a held job can be live, a live job can be working). Rendering
 * them all in one flat list ('1 job · 1 held · 1 live · 1 working') reads as
 * three jobs instead of one job counted three ways, so the phase breakdown and
 * the liveness facets are split into two clearly-labelled clauses.
 */
export function statusHeadline(snapshot: StatusSnapshot): string {
	const { counts } = snapshot;
	const total = `${counts.jobs} job${counts.jobs === 1 ? "" : "s"}`;
	const phaseParts: string[] = [];
	for (const phase of ["waiting", "held", "failed", "done"] as const) {
		if (counts[phase] > 0) phaseParts.push(`${counts[phase]} ${phase}`);
	}
	const livenessParts: string[] = [];
	if (counts.live > 0) livenessParts.push(`${counts.live} live`);
	if (counts.working > 0) livenessParts.push(`${counts.working} working`);
	const segments = [total];
	if (phaseParts.length > 0) segments.push(phaseParts.join(", "));
	if (livenessParts.length > 0) segments.push(`of which ${livenessParts.join(", ")}`);
	return segments.join(" · ");
}

/**
 * The drain line (cp-epy2 §4.2 item 3): may this parent die now?
 *
 * It is not part of the snapshot on purpose. `StatusSnapshot` is assembled
 * from files and is the same for anybody who reads them; the drain projection
 * is **this process's** live workers, which no file records — so it travels as
 * a render option and is simply absent for every caller that has no manager
 * (the goldens, the widget, a headless re-entry). Absent means no line, which
 * is what keeps the pinned table byte-identical.
 */
export function formatDrainLine(drain: DrainProjection): string {
	if (drain.active === 0) return "DRAIN 0 workers in this session — drained (a parent may exit; held/waiting jobs stay revivable)";
	if (drain.busy.length === 0) {
		return `DRAIN ${drain.active} worker(s) in this session, 0 busy — drained (a parent may exit; held/waiting jobs stay revivable)`;
	}
	return `DRAIN ${drain.active} worker(s) in this session, ${drain.busy.length} busy: ${drain.busy.join(", ")} — not drained (a worker is mid-turn; exiting now kills it)`;
}

export interface StatusTableOptions {
	/** This process's live workers. Absent (a golden, the widget) means no line. */
	drain?: DrainProjection;
}

/** `/status` without `--json`: the ported table, minus the broker block. */
export function formatStatusTable(snapshot: StatusSnapshot, options: StatusTableOptions = {}): string {
	const lines: string[] = [];
	const scope = snapshot.filter.project ? ` project=${snapshot.filter.project}` : "";
	lines.push(`FLEET ${statusHeadline(snapshot)} (${snapshot.filter.include}${scope}, at ${snapshot.generated_at})`);
	if (snapshot.ledger.queried && !snapshot.ledger.ok) {
		// Ported banner: name the degradation instead of quietly showing blanks.
		lines.push(`LEDGER degraded (${snapshot.ledger.error ?? "unavailable"}) -- titles unavailable; worker rows are still facts`);
	}
	lines.push("");
	if (snapshot.jobs.length === 0) {
		lines.push(`no jobs (${snapshot.filter.include})`);
	} else {
		lines.push(row(COLUMNS.map((column) => column.header), "TITLE"));
		// cp-project-grouped-reporting: several projects print one `[project]`
		// section each; a single-project table is unchanged.
		const groups = groupByProject(snapshot.jobs, (job) => job.project);
		let section: string | undefined;
		for (const job of groups.flatMap(([, jobs]) => jobs)) {
			if (groups.length > 1 && job.project !== section) {
				section = job.project;
				lines.push(`[${section}]`);
			}
			lines.push(
				row(
					[
						job.job_id,
						job.project,
						job.kind,
						job.executor === "script" ? "script" : shortModel(job.model ?? "unknown"),
						formatScopeRisk(job),
						formatThinking(job),
						job.phase,
						runLabel(job),
						toolCell(job),
						formatAge(job.age_seconds),
						formatTokens(job.usage.total_tokens),
						formatCost(job.usage.cost_usd),
					],
					job.title ?? "-",
				),
			);
			if (job.executor === "script") {
				const observed = job.script_process ?? job.script_observed_exit;
				lines.push(`  script ${job.script_path} pid ${job.pid ?? "unknown"}${observed?.exited_at ? ` exited ${observed.exited_at} (${observed.exit_code ?? observed.signal ?? "unknown"})` : " running or unobserved"}`);
			}
			if (job.failure) lines.push(`  ! ${job.failure.class}: ${truncate(job.failure.message, 100)}`);
			// The mirror image of the wedged note below: that one is a run still
			// mid-call, this one is a run that stopped and said nothing. They are
			// disjoint by construction (`settledWithoutReport` excludes `working`),
			// so a row never carries both (cp-settle-without-report).
			if (settledWithoutReport(job)) {
				// cp-0dhw: with an observation on the record, the row says which of the
				// two unreported situations this is — nothing on disk, or work sitting
				// in the worktree that a recovery prompt has already been sent for.
				if (unreportedWorkPresent(job.unreported_work) && job.unreported_work) {
					lines.push(
						`  ! settled without filing an envelope (${job.unreported_settles ?? 1}x) WITH WORK ON DISK: ${describeUnreportedWork(job.unreported_work)} in ${job.worktree} -- prompted to commit/push/report; nothing is deleted`,
					);
				} else {
					lines.push(
						`  ! settled without filing an envelope (${job.unreported_settles ?? 1}x, nudged once) -- the work may be done: check ${job.branch}, then cp_send ${job.job_id} or tear it down`,
					);
				}
			}
			if (job.pending_review) {
				lines.push(
					`  ${job.pending_review.surface} ${job.pending_review.attempt} running ` +
						`${formatAge(ageSeconds(job.pending_review.started_at, snapshot.generated_at))} ` +
						`(deadline ${job.pending_review.deadline})`,
				);
			}
			// Why a held job cannot advance, from files alone (cp-status-wait-reasons).
			// Null while a reviewer is in flight, so this never restates the line
			// above: the suppression is `waitReason`'s, not this renderer's.
			const wait = waitReason(job);
			if (wait) lines.push(`  waiting on: ${wait}`);
			// An observed fact, not an inferred phase: this call has been running a
			// long time. No verdict about why -- a real build and a wedged editor look
			// identical from here, which is exactly why nothing is auto-killed.
			// `isLongToolCall` rather than the inline comparison it used to be: it is
			// the shared cell (cp-8tu), and it is where the one exclusion lives — an
			// open `ask_operator` call is a human thinking, not a slow tool (cp-ft3d).
			if (isLongToolCall(job) && job.current_tool_seconds !== null) {
				lines.push(
					`  ! long-running tool call: ${job.current_tool} for ${formatAge(job.current_tool_seconds)} (still running, not stalled -- verify with /watch)`,
				);
			}
			// One step further along the same observation: the call has produced no
			// output at all for a long time. Still not a phase, still nothing killed
			// -- but it is the shape a wedged call has, and it says so out loud.
			if (isWedgedToolCall(job)) {
				lines.push(
					`  ! no progress from ${job.current_tool} for ${formatAge(job.current_tool_idle_seconds as number)} (possibly wedged -- /watch ${job.job_id}, then decide)`,
				);
			}
		}
		lines.push("");
		lines.push(
			`TOTAL ${formatTokens(snapshot.usage.total_tokens)} tokens ${formatCost(snapshot.usage.cost_usd)}`,
		);
	}
	if (options.drain) {
		lines.push("");
		lines.push(formatDrainLine(options.drain));
	}
	if (snapshot.unclaimed.length > 0) {
		lines.push("");
		lines.push("UNCLAIMED (ledger says in_progress; this fleet has no record)");
		for (const entry of snapshot.unclaimed) {
			const age = entry.age_seconds === null ? "-" : formatAge(entry.age_seconds);
			lines.push(`  ${pad(entry.job_id, 24)} ${pad(entry.project ?? "-", 14)} ${pad(age, 5)} ${entry.title ?? "-"}`.trimEnd());
		}
	}
	return lines.join("\n");
}

/** `/status --json`: the snapshot verbatim, pretty-printed. */
export function formatStatusJson(snapshot: StatusSnapshot): string {
	return JSON.stringify(snapshot, null, 2);
}
