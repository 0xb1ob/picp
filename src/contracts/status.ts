/** Observation reports: the status snapshot, the status block's Shipped memory and doctor. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { type Delivery, DeliverySchema, IsoTimestampSchema, JobIdSchema, type JobKind, JobKindSchema, OriginSchema, type Role, RoleSchema, SCHEMA_VERSION, UsageSchema, validate, type ValidationResult } from "./core.ts";
import { type Failure, FailureSchema } from "./limits.ts";
import { type JobRouting, JobRoutingSchema } from "./routing.ts";
import { JOB_PHASES, type JobPhase, JobPhaseSchema, ReceiptSchema, ScriptObservedExitSchema, ScriptProcessSchema, UnreportedWorkSchema } from "./fleet.ts";
import { QUESTION_MAX_CHARS, QUESTION_METHODS } from "./questions.ts";
import { ReviewSurfaceSchema } from "./reviews.ts";
import { type RunPhase, RunPhaseSchema } from "./runs.ts";
import type { Narrow, Replace } from "./internal.ts";

/**
 * How many sessions' Shipped memories `state/status-block-shipped.json` keeps
 * (cp-b5eg). One entry per session, a few dozen bytes each: the bound exists so
 * the file cannot grow without limit, not because an old session's set is
 * expensive. The oldest entries are dropped first.
 */
export const SHIPPED_SEEN_KEEP_SESSIONS = 12;

/**
 * Ids kept per session. A session that ships more than this has already had
 * every one of them reported once; dropping the oldest re-reports a very old
 * job at worst, which is the safe direction (a duplicated row, never an
 * 80-row replay).
 */
export const SHIPPED_SEEN_MAX_IDS = 500;

// ---------------------------------------------------------------------------
// Status block Shipped memory (cp-b5eg) — state/status-block-shipped.json
// ---------------------------------------------------------------------------

/**
 * What the status block has already reported under Shipped, per session.
 *
 * It is **persisted**, and that is the whole fix (cp-b5eg): the set used to
 * live in an extension-instance variable reset on every `session_start`, which
 * includes `reason: "reload"` — the same session, the same conversation, a new
 * extension instance. Any reload, and any other re-instantiation inside a
 * session, dropped the memory and made the very next block replay the entire
 * session's shipped history (observed: ~80 rows), after which the block was
 * correct again because the set had been refilled. Keyed by session id so a
 * genuinely new session still starts empty, which is the contract in AGENTS.md
 * §Status block.
 */
export const ShippedSeenSessionSchema = Type.Object(
	{
		/** pi's own session id (`ctx.sessionManager.getSessionId()`). */
		session_id: Type.String({ minLength: 1, maxLength: 200 }),
		/** job ids already rendered under Shipped in this session, oldest first. */
		shipped_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 })),
		updated_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type ShippedSeenSession = Static<typeof ShippedSeenSessionSchema>;

/** `state/status-block-shipped.json` — every remembered session, newest last. */
export const ShippedSeenFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		sessions: Type.Array(ShippedSeenSessionSchema),
	},
	{ additionalProperties: false },
);
export type ShippedSeenFile = Narrow<Static<typeof ShippedSeenFileSchema>, "sessions", ShippedSeenSession[]>;

export const EMPTY_SHIPPED_SEEN_FILE: ShippedSeenFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	sessions: [],
};

export function validateShippedSeenFile(value: unknown): ValidationResult<ShippedSeenFile> {
	const result = validate<ShippedSeenFile>(ShippedSeenFileSchema, value);
	if (!result.ok) return result;
	const seen = new Set<string>();
	const errors: string[] = [];
	for (const session of result.value.sessions) {
		if (seen.has(session.session_id)) {
			errors.push(`/sessions: duplicate session_id "${session.session_id}" — the memory is keyed by session`);
		}
		seen.add(session.session_id);
	}
	return errors.length === 0 ? result : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Status snapshot (T23) — state/fleet.json + state/runs/*/status.json, joined
// ---------------------------------------------------------------------------

/**
 * Where a job's age is measured from. Ported from `cmdp status`
 * (`resolveTimestamp`): a dispatched job is aged from its dispatch, and a job
 * only the ledger knows about is aged from br's own `updated_at`.
 */
export const STATUS_TIME_SOURCES = ["dispatched_at", "br_updated_at"] as const;
export type StatusTimeSource = (typeof STATUS_TIME_SOURCES)[number];
export const StatusTimeSourceSchema = StringEnum([...STATUS_TIME_SOURCES]);

/** Which jobs a snapshot covers. `active` hides jobs that were torn down. */
export const STATUS_INCLUDES = ["active", "all"] as const;
export type StatusInclude = (typeof STATUS_INCLUDES)[number];
export const StatusIncludeSchema = StringEnum([...STATUS_INCLUDES]);

/** Job phases a default (`active`) snapshot shows: everything not torn down. */
export const STATUS_ACTIVE_PHASES: readonly JobPhase[] = Object.freeze(["launching", "waiting", "held", "failed"]);

/**
 * One row of the fleet view. Two liveness facts are kept apart on purpose:
 * `phase` is job policy (fleet.json), `run_phase` is process liveness
 * (status.json, observed events), and `alive` is a pid probe taken now. A
 * renderer may combine them; the snapshot never does.
 */
export const StatusJobSchema = Type.Object(
	{
		job_id: JobIdSchema,
		project: Type.String({ minLength: 1 }),
		kind: JobKindSchema,
		delivery: DeliverySchema,
		origin: OriginSchema,
		phase: JobPhaseSchema,
		/** From the ledger join; null when br is unavailable or does not know the id. */
		title: Type.Union([Type.String(), Type.Null()]),
		br_status: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		profile: Type.Optional(Type.String({ minLength: 1 })),
		role: Type.Optional(RoleSchema),
		model: Type.Optional(Type.String({ minLength: 1 })),
		executor: Type.Optional(StringEnum(["script", "model"])),
		script_path: Type.Optional(Type.String({ minLength: 1 })),
		script_process: Type.Optional(ScriptProcessSchema),
		script_observed_exit: Type.Optional(ScriptObservedExitSchema),
		/** Projection of the run's event log; null when the run has no status.json. */
		run_phase: Type.Union([RunPhaseSchema, Type.Null()]),
		current_tool: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		/**
		 * Seconds the current tool call has been open, measured against the same
		 * `current_tool.started_at` the run projection already records. Null when
		 * there is no tool in flight. An observed duration, not a phase: see
		 * LONG_TOOL_CALL_SECONDS.
		 */
		current_tool_seconds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		/**
		 * Seconds since the current tool call last proved progress
		 * (`current_tool.last_progress_at`, falling back to `started_at`). This
		 * is the number the wedged-call watch measures, and it is why a long
		 * call that is still emitting output is never flagged: only *silence*
		 * accumulates here. Optional so that a snapshot assembled before this
		 * field existed still validates; null when no tool is in flight.
		 */
		current_tool_idle_seconds: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
		/**
		 * Carried verbatim from the run projection: pi is mid-`auto_retry`. Only
		 * ever present when true, so a snapshot without it is simply a job with
		 * no retry in flight.
		 */
		retrying: Type.Optional(Type.Boolean()),
		turns: Type.Integer({ minimum: 0 }),
		tool_calls: Type.Integer({ minimum: 0 }),
		/**
		 * pid probe taken when the snapshot was assembled. An observed close
		 * outranks it: a record with `worker.exited_at` is never probed and is
		 * always `false` (pids are reused, observations are not).
		 */
		alive: Type.Boolean(),
		pid: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
		session_id: Type.Optional(Type.String({ minLength: 1 })),
		worktree: Type.String({ minLength: 1 }),
		branch: Type.String({ minLength: 1 }),
		timestamp: IsoTimestampSchema,
		time_source: StatusTimeSourceSchema,
		age_seconds: Type.Integer({ minimum: 0 }),
		last_activity_at: Type.Union([IsoTimestampSchema, Type.Null()]),
		usage: UsageSchema,
		reported_at: Type.Optional(IsoTimestampSchema),
		closed_at: Type.Optional(IsoTimestampSchema),
		failure: Type.Optional(FailureSchema),
		receipts: Type.Optional(Type.Array(ReceiptSchema, { maxItems: 20 })),
		/**
		 * Settles with an open envelope slot and nothing filed (see
		 * `FleetRecordSchema`). Carried through so `/status`, the widget and the
		 * status block can say `unreported` instead of `idle` for a worker that
		 * finished and never reported.
		 */
		unreported_settles: Type.Optional(Type.Integer({ minimum: 1 })),
		/**
		 * What that settle found on disk (cp-0dhw), carried straight through from
		 * the fleet record — never re-derived here. It is what lets `/status` say
		 * `unreported (4 files uncommitted)` instead of `unreported`.
		 */
		unreported_work: Type.Optional(UnreportedWorkSchema),
		/** How a `done` job was closed (cp-8km); see `FleetRecordSchema`. */
		closed_reason: Type.Optional(StringEnum(["gated", "forced"])),
		/**
		 * A question this job has asked the operator and nobody has answered yet
		 * (T31). A fact with a timestamp, not a phase: the worker is still `waiting`
		 * and still alive, and nothing here is inferred from age.
		 */
		open_question: Type.Optional(
			Type.Object(
				{
					seq: Type.Integer({ minimum: 1 }),
					question: Type.String({ minLength: 1, maxLength: QUESTION_MAX_CHARS }),
					asked_at: IsoTimestampSchema,
					method: Type.Optional(StringEnum([...QUESTION_METHODS])),
				},
				{ additionalProperties: false },
			),
		),
		/**
		 * How many blockers a waiting planner filed (cur.3.4). Not a phase: the job
		 * stays `waiting`. Absent means none.
		 */
		blockers: Type.Optional(Type.Integer({ minimum: 1 })),
		/**
		 * The scope/risk/thinking that decided this job's model (cp-status-scope-risk),
		 * carried straight through from the fleet record's own `routing` — never
		 * recomputed here. Absent for a job dispatched before this field existed;
		 * render that as unknown, not a guessed default.
		 */
		routing: Type.Optional(JobRoutingSchema),
		/**
		 * A reviewer is running for this job in the background (spec
		 * 2026-09-05-async-reviewers). Read from the attempt directory's
		 * `pending.json`, files only; absent means no review is in flight.
		 */
		pending_review: Type.Optional(
			Type.Object(
				{
					surface: ReviewSurfaceSchema,
					attempt: Type.Integer({ minimum: 1 }),
					started_at: IsoTimestampSchema,
					deadline: IsoTimestampSchema,
				},
				{ additionalProperties: false },
			),
		),
		/**
		 * What this home has already observed about the branch's CI, carried
		 * straight through from `state/ci-watch.json` and this job's own review
		 * verdict files (cp-status-wait-reasons). Files only, never a `gh` call on
		 * a render path, and never a phase: it is what lets a held row say *why*
		 * it cannot advance (`waiting on: CI on d48a81d`) instead of `exited`.
		 *
		 * `state` is the watcher's own last classification (`MergeAskCi`), kept as
		 * a bounded string so the contract does not depend on the gate's union.
		 * `reviewed` is true when a `cp_review` pass exists for `head_sha`.
		 */
		ci: Type.Optional(
			Type.Object(
				{
					head_sha: Type.Optional(Type.String({ minLength: 7, maxLength: 64 })),
					state: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
					reviewed: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type StatusJob = Replace<
	Static<typeof StatusJobSchema>,
	{
		kind: JobKind;
		delivery: Delivery;
		phase: JobPhase;
		role?: Role;
		run_phase: RunPhase | null;
		time_source: StatusTimeSource;
		failure?: Failure;
		routing?: JobRouting;
	}
>;

/**
 * A job the ledger calls `in_progress` that the fleet has no record of. Ported
 * from the `orphaned` nodes `cmdp status` synthesized from br — but it is NOT
 * given a job phase: the four phases describe records this home owns, and
 * inventing a fifth for something we cannot observe is the guessing the RPC
 * rebuild exists to end.
 */
export const StatusUnclaimedSchema = Type.Object(
	{
		job_id: Type.String({ minLength: 1 }),
		title: Type.Union([Type.String(), Type.Null()]),
		br_status: Type.String({ minLength: 1 }),
		project: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		timestamp: Type.Union([IsoTimestampSchema, Type.Null()]),
		time_source: StatusTimeSourceSchema,
		age_seconds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	},
	{ additionalProperties: false },
);
export type StatusUnclaimed = Narrow<Static<typeof StatusUnclaimedSchema>, "time_source", StatusTimeSource>;

/**
 * `/status --json`. The ledger join is allowed to be **degraded** (ported: the
 * "BROKER degraded — nodes below may be stale" banner): a read-only view of the
 * fleet must still render when br is missing, so the failure is reported in the
 * payload instead of refusing to answer.
 */
export const StatusLedgerSchema = Type.Object(
	{
		ok: Type.Boolean(),
		error: Type.Optional(Type.String({ maxLength: 500 })),
		/** False when the caller asked for no titles; then `ok` says nothing. */
		queried: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type StatusLedger = Static<typeof StatusLedgerSchema>;

export const StatusSnapshotSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		generated_at: IsoTimestampSchema,
		home: Type.String({ minLength: 1 }),
		filter: Type.Object(
			{
				include: StatusIncludeSchema,
				project: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
			},
			{ additionalProperties: false },
		),
		counts: Type.Object(
			{
				jobs: Type.Integer({ minimum: 0 }),
				launching: Type.Integer({ minimum: 0 }),
				waiting: Type.Integer({ minimum: 0 }),
				held: Type.Integer({ minimum: 0 }),
				done: Type.Integer({ minimum: 0 }),
				failed: Type.Integer({ minimum: 0 }),
				/** Workers whose pid answered the probe. */
				live: Type.Integer({ minimum: 0 }),
				working: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
		/** Sum over the shown jobs, so a filtered view's totals match its rows. */
		usage: UsageSchema,
		ledger: StatusLedgerSchema,
		jobs: Type.Array(StatusJobSchema),
		unclaimed: Type.Array(StatusUnclaimedSchema, { maxItems: 100 }),
	},
	{ additionalProperties: false },
);
export type StatusSnapshot = Replace<
	Static<typeof StatusSnapshotSchema>,
	{
		filter: { include: StatusInclude; project: string | null };
		jobs: StatusJob[];
		unclaimed: StatusUnclaimed[];
	}
>;

// ---------------------------------------------------------------------------
// Doctor (T25) — environment diagnosis
// ---------------------------------------------------------------------------

/**
 * `ok` needs no action. `warn` is advisory: something is degraded or absent by
 * choice, and doctor still exits 0 (ported rule — a fresh home with no optional
 * config must be green). `error` is broken and exits 2.
 */
export const DOCTOR_SEVERITIES = ["ok", "warn", "error"] as const;
export type DoctorSeverity = (typeof DOCTOR_SEVERITIES)[number];
export const DoctorSeveritySchema = StringEnum([...DOCTOR_SEVERITIES]);

/**
 * One finding. `check` is the stable id to branch on (never the prose), and a
 * non-`ok` finding must carry a `fix`: the ported `{what, kind, fix}` shape
 * existed because a diagnosis nobody can act on is just bad news.
 */
export const DoctorFindingSchema = Type.Object(
	{
		check: Type.String({ minLength: 1, maxLength: 64 }),
		severity: DoctorSeveritySchema,
		what: Type.String({ minLength: 1, maxLength: 200 }),
		detail: Type.Optional(Type.String({ maxLength: 2000 })),
		fix: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ additionalProperties: false },
);
export type DoctorFinding = Narrow<Static<typeof DoctorFindingSchema>, "severity", DoctorSeverity>;

export const DoctorReportSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		generated_at: IsoTimestampSchema,
		home: Type.String({ minLength: 1 }),
		package_root: Type.String({ minLength: 1 }),
		counts: Type.Object(
			{
				ok: Type.Integer({ minimum: 0 }),
				warn: Type.Integer({ minimum: 0 }),
				error: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
		/** False when any finding is an `error`. This is the exit code, too. */
		ok: Type.Boolean(),
		findings: Type.Array(DoctorFindingSchema),
	},
	{ additionalProperties: false },
);
export type DoctorReport = Narrow<Static<typeof DoctorReportSchema>, "findings", DoctorFinding[]>;

/**
 * The `/status --json` contract. Beyond shape: a snapshot is keyed by job id
 * like the fleet it projects, and its counts must equal its rows — a view that
 * disagrees with itself is worse than no view.
 */
export function validateStatusSnapshot(value: unknown): ValidationResult<StatusSnapshot> {
	const result = validate<StatusSnapshot>(StatusSnapshotSchema, value);
	if (!result.ok) return result;
	const snapshot = result.value;
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const job of snapshot.jobs) {
		if (seen.has(job.job_id)) errors.push(`/jobs: duplicate job_id "${job.job_id}" — the fleet is keyed by job id`);
		seen.add(job.job_id);
	}
	for (const entry of snapshot.unclaimed) {
		if (seen.has(entry.job_id)) {
			errors.push(`/unclaimed: "${entry.job_id}" also has a fleet record — it is claimed, not unclaimed`);
		}
	}
	if (snapshot.counts.jobs !== snapshot.jobs.length) {
		errors.push(`/counts/jobs: ${snapshot.counts.jobs} does not match ${snapshot.jobs.length} rows`);
	}
	for (const phase of JOB_PHASES) {
		const counted = snapshot.counts[phase];
		const actual = snapshot.jobs.filter((job) => job.phase === phase).length;
		if (counted !== actual) errors.push(`/counts/${phase}: ${counted} does not match ${actual} rows`);
	}
	return errors.length === 0 ? result : { ok: false, errors };
}

/**
 * A report's counts must match its findings, `ok` must mean "no errors", and
 * every non-`ok` finding must name a fix. The last rule is the ported one: a
 * finding without a fix is how `cmdp doctor` used to send people to Slack.
 */
export function validateDoctorReport(value: unknown): ValidationResult<DoctorReport> {
	const result = validate<DoctorReport>(DoctorReportSchema, value);
	if (!result.ok) return result;
	const report = result.value;
	const errors: string[] = [];
	for (const severity of DOCTOR_SEVERITIES) {
		const counted = report.counts[severity];
		const actual = report.findings.filter((finding) => finding.severity === severity).length;
		if (counted !== actual) errors.push(`/counts/${severity}: ${counted} does not match ${actual} findings`);
	}
	if (report.ok !== (report.counts.error === 0)) {
		errors.push(`/ok: ${report.ok} contradicts ${report.counts.error} error finding(s)`);
	}
	for (const finding of report.findings) {
		if (finding.severity !== "ok" && !finding.fix) {
			errors.push(`/findings/${finding.check}: a ${finding.severity} finding must name a fix`);
		}
	}
	return errors.length === 0 ? result : { ok: false, errors };
}
