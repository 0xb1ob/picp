/** Fleet state — state/fleet.json (single writer: the parent extension). Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { type Delivery, DeliverySchema, IsoTimestampSchema, JobIdSchema, type JobKind, JobKindSchema, normalizeLegacyRoles, OriginSchema, type Role, RoleSchema, SCHEMA_VERSION, UsageSchema, validate, type ValidationResult } from "./core.ts";
import { isSafeScriptPath } from "./jobs.ts";
import { type Failure, FailureSchema, JobHardBoundsSchema } from "./limits.ts";
import { type JobRouting, JobRoutingSchema } from "./routing.ts";
import type { Narrow, Replace } from "./internal.ts";

// ---------------------------------------------------------------------------
// Fleet state — state/fleet.json (single writer: the parent extension)
// ---------------------------------------------------------------------------

/**
 * Job phase (policy-level, from facts):
 *  waiting — dispatched, no envelope yet
 *  held    — envelope in, worker + lease deliberately kept alive (delivery:pr)
 *  done    — torn down: lease returned, worker observed closed
 *  failed  — worker died or a failure class was recorded; cause is on `failure`
 *
 * `stalled` from command-post is retired: with RPC facts a worker is either
 * running, settled, or observed-dead. There is nothing left to guess.
 */
export const JOB_PHASES = ["launching", "waiting", "held", "done", "failed"] as const;
export type JobPhase = (typeof JOB_PHASES)[number];
export const JobPhaseSchema = StringEnum([...JOB_PHASES]);

export const ScriptProcessSchema = Type.Object(
	{
		pid: Type.Integer({ minimum: 1 }),
		started_at: IsoTimestampSchema,
		exited_at: Type.Optional(IsoTimestampSchema),
		exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		signal: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 40 }), Type.Null()])),
	},
	{ additionalProperties: false },
);
export type ScriptProcess = Static<typeof ScriptProcessSchema>;

export const ScriptObservedExitSchema = Type.Object(
	{
		exited_at: IsoTimestampSchema,
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		signal: Type.Union([Type.String({ minLength: 1, maxLength: 40 }), Type.Null()]),
	},
	{ additionalProperties: false },
);

/** Legacy records with no executor are model workers. */
export function isScriptFleetRecord(record: unknown): record is FleetRecord & { executor: "script"; script_path: string; script_process?: ScriptProcess } {
	return typeof record === "object" && record !== null && "executor" in record && record.executor === "script";
}

export const WorkerHandleSchema = Type.Object(
	{
		pid: Type.Integer({ minimum: 1 }),
		session_id: Type.String({ minLength: 1 }),
		session_file: Type.String({ minLength: 1 }),
		profile: Type.String({ minLength: 1 }),
		role: RoleSchema,
		model: Type.String({ minLength: 1 }),
		started_at: IsoTimestampSchema,
		/** Set once the child close event is OBSERVED. Never inferred. */
		exited_at: Type.Optional(IsoTimestampSchema),
		exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
	},
	{ additionalProperties: false },
);
export type WorkerHandle = Narrow<Static<typeof WorkerHandleSchema>, "role", Role>;

/** PR/CI links attached to a job (pi-subagents receipt pattern). */
export const ReceiptSchema = Type.Object(
	{
		kind: StringEnum(["pr", "ci", "issue", "artifact", "review", "board"]),
		status: Type.String({ minLength: 1, maxLength: 64 }),
		title: Type.String({ maxLength: 300 }),
		url: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ additionalProperties: false },
);
export type Receipt = Static<typeof ReceiptSchema>;

/**
 * What a settled worker left behind in its leased worktree (cp-0dhw).
 *
 * `unreported` covered two situations that need opposite handling and could not
 * be told apart: a run that settled with **nothing** on disk (little to
 * recover), and a run that settled with **hundreds of uncommitted lines** in the
 * worktree (the work exists; only the delivery is missing). The second happened
 * seven times in one day, and every recovery was the same mechanical step — look
 * at the worktree, tell the worker what is there, tell it to commit, push and
 * report. Automating that step needs the distinction to be a **fact on the
 * record**, not a line in a log, so `/status`, `/watch` and the wake-up all read
 * one observation instead of each re-deriving it.
 *
 * The vocabulary is the teardown gate's (`dirty`, `unpushed`): the same two git
 * conditions, observed at the other end of the job.
 *
 *  clean    — porcelain empty and no commits missing from origin
 *  dirty    — modified and/or untracked files in the worktree
 *  unpushed — clean tree, but commits that no origin ref contains
 *  unknown  — git could not be asked (worktree gone, not a repo, git failed)
 *
 * `unknown` is never read as "there is work": an observation that failed is not
 * evidence, and the automatic recovery prompt is only ever sent on evidence.
 */
export const UNREPORTED_WORK_STATES = ["clean", "dirty", "unpushed", "unknown"] as const;
export type UnreportedWorkState = (typeof UNREPORTED_WORK_STATES)[number];
export const UnreportedWorkStateSchema = StringEnum([...UNREPORTED_WORK_STATES]);

/** How many file paths the observation keeps. Evidence, not an inventory. */
export const UNREPORTED_WORK_FILES_SHOWN = 12;

export const UnreportedWorkSchema = Type.Object(
	{
		state: UnreportedWorkStateSchema,
		/** Modified/untracked paths, bounded to `UNREPORTED_WORK_FILES_SHOWN`. */
		files: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: UNREPORTED_WORK_FILES_SHOWN }),
		/** How many there are in total, which `files` may not show all of. */
		file_count: Type.Integer({ minimum: 0 }),
		/** Commits reachable from HEAD that no origin ref contains. */
		commits_ahead: Type.Integer({ minimum: 0 }),
		/**
		 * Whether origin has the job branch. Absent means origin could not be
		 * asked at all — never `false`, which would claim the branch is not there
		 * (the stale-remote-ref trap cp-vk1 fixed in the teardown gate).
		 */
		branch_on_origin: Type.Optional(Type.Boolean()),
		observed_at: IsoTimestampSchema,
		/** Why the state is `unknown`, when it is. */
		reason: Type.Optional(Type.String({ maxLength: 300 })),
	},
	{ additionalProperties: false },
);
export type UnreportedWork = Narrow<Static<typeof UnreportedWorkSchema>, "state", UnreportedWorkState>;

/** How much of intake's refusal reason is kept on the record. */
export const ENVELOPE_CORRECTION_REASON_MAX_CHARS = 2000;

/**
 * One spent correction slot (pi-command-post-uad).
 *
 * The defect: a worker filed an envelope naming an artifact that did not
 * exist. Intake refused it — correctly — but `envelope.json` stayed on disk,
 * so the worker's write-once slot stayed closed and `report_result` answered
 * every retry with "already filed". A clean pushed PR and a finished worker
 * were stuck with no path back, because the only mechanism that reopened a
 * slot (a promote, `src/supersede.ts`) needs a *stamped* envelope to supersede
 * and this one was never stamped.
 *
 * So a refused, unstamped envelope is quarantined instead of left in place,
 * and this record is what makes that bounded and auditable: it names the
 * generation whose slot was reopened, when, where the refused record was kept,
 * and the validation reason. Exactly one per generation — a second refusal of
 * the same generation fails closed.
 */
export const EnvelopeCorrectionSchema = Type.Object(
	{
		/** The generation whose slot was reopened; never bumped by a correction. */
		generation: Type.Integer({ minimum: 1 }),
		at: IsoTimestampSchema,
		/** Where the refused record was kept, relative to the home. Never deleted. */
		quarantined: Type.String({ minLength: 1, maxLength: 400 }),
		/**
		 * Why intake refused it: validation errors only, bounded. The envelope body
		 * never travels, and neither does anything read out of an artifact.
		 */
		reason: Type.String({ minLength: 1, maxLength: ENVELOPE_CORRECTION_REASON_MAX_CHARS }),
	},
	{ additionalProperties: false },
);
export type EnvelopeCorrection = Static<typeof EnvelopeCorrectionSchema>;

/**
 * Is there work on disk worth recovering? Only an observation that succeeded
 * ever says yes: `unknown` is ignorance, and the recovery prompt is sent on
 * evidence or not at all.
 */
export function unreportedWorkPresent(work: UnreportedWork | undefined): boolean {
	return work?.state === "dirty" || work?.state === "unpushed";
}

/** One short evidence line: what is on disk, never a diff and never a body. */
export function describeUnreportedWork(work: UnreportedWork): string {
	if (work.state === "unknown") return `worktree not readable (${work.reason ?? "git could not be asked"})`;
	if (work.state === "clean") return "worktree clean, nothing unpushed";
	const parts: string[] = [];
	if (work.file_count > 0) parts.push(`${work.file_count} uncommitted file(s)`);
	if (work.commits_ahead > 0) parts.push(`${work.commits_ahead} unpushed commit(s)`);
	if (work.branch_on_origin === false) parts.push("branch not on origin");
	return parts.join(", ");
}

export const FleetRecordSchema = Type.Object(
	{
		job_id: JobIdSchema,
		project: Type.String({ minLength: 1 }),
		kind: JobKindSchema,
		delivery: DeliverySchema,
		origin: OriginSchema,
		phase: JobPhaseSchema,
		executor: Type.Optional(StringEnum(["model", "script"])),
		script_path: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
		script_process: Type.Optional(ScriptProcessSchema),
		script_observed_exit: Type.Optional(ScriptObservedExitSchema),
		worker: Type.Optional(WorkerHandleSchema),
		worktree: Type.String({ minLength: 1 }),
		/** The schedule that fired this job (its ledger `schedule:<id>` label): how spend and coverage tell scheduled work apart (schedlater S3). */
		schedule_id: Type.Optional(Type.String({ pattern: "^sch-[0-9a-f]{6}$" })),
		/**
		 * treehouse lease identity (T11). Optional because older treehouse does
		 * not print one; when present, teardown returns the worktree only if the
		 * pool still shows this identity.
		 */
		lease_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		branch: Type.String({ minLength: 1 }),
		dispatched_at: IsoTimestampSchema,
		/**
		 * When the CURRENT envelope generation was accepted. Stamped once per
		 * generation, and cleared when a promote reopens the slot (see
		 * `src/supersede.ts` and docs/contracts.md §Envelope supersession).
		 */
		reported_at: Type.Optional(IsoTimestampSchema),
		/**
		 * How many times this job's envelope slot has been reopened by a promote.
		 * Absent means never; the live envelope generation is `supersessions + 1`,
		 * and every superseded envelope survives at
		 * `state/runs/<id>/envelope-superseded-<n>.json`.
		 */
		supersessions: Type.Optional(Type.Integer({ minimum: 1 })),
		/**
		 * How many blocked planner envelopes this job has accepted (cur.3.1).
		 * Absent means none. The next blocked envelope after
		 * `PLANNER_BLOCKED_ROUND_CAP` escalates instead of being answered.
		 */
		planner_blocked_rounds: Type.Optional(Type.Integer({ minimum: 1 })),
		/**
		 * How many times a valid promotion (`cp_send` with `task`/`taskFile`, mode
		 * `prompt`) has replaced the frozen original task this job was dispatched
		 * with (cp-promote-task-record). Absent means never: the file at
		 * `paths.originalTaskFile` is still the one dispatch wrote. Every replaced
		 * generation survives at `state/runs/<id>/original-task-superseded-<n>.md`,
		 * so a scope change delivered through a promotion becomes the authoritative
		 * text a diff reviewer scores against without erasing what came before.
		 * An ordinary steer or follow_up never touches this counter.
		 */
		task_generations: Type.Optional(Type.Integer({ minimum: 1 })),
		/**
		 * How many times this job's worker has settled with an open envelope slot
		 * and nothing filed (cp-settle-without-report). 1 means it was nudged once;
		 * 2+ means the nudge did not produce a report and the fact was recorded.
		 *
		 * The phase deliberately stays `waiting` while the worker is alive: an idle
		 * worker with an open slot is promotable, and marking it `failed` is exactly
		 * what closed the recovery path (`cp_send` refuses anything not live).
		 * Cleared by an accepted envelope and by a promote — a fresh brief is a
		 * fresh chance to report, so the nudge budget is per brief, not per job.
		 */
		unreported_settles: Type.Optional(Type.Integer({ minimum: 1 })),
		/**
		 * What the last unreported settle found in this job's worktree (cp-0dhw).
		 * Written by the settle boundary, cleared by the same mutation that stamps
		 * `reported_at` and by a promote — it describes one generation's silence,
		 * so it can never outlive the silence it describes.
		 */
		unreported_work: Type.Optional(UnreportedWorkSchema),
		/**
		 * The one correction slot this job's CURRENT envelope generation has spent
		 * (pi-command-post-uad). Written when intake refuses an unstamped envelope
		 * and quarantines it; it is both the audit record and the budget, so a
		 * second refusal of the same generation fails closed instead of reopening
		 * the slot again. Generation-stamped, so a promote's new generation gets its
		 * own budget and a stale entry can never spend it.
		 */
		envelope_correction: Type.Optional(EnvelopeCorrectionSchema),
		closed_at: Type.Optional(IsoTimestampSchema),
		usage: UsageSchema,
		budget: Type.Optional(
			Type.Object(
				{
					tokens: Type.Integer({ minimum: 0 }),
					cost_usd: Type.Number({ minimum: 0 }),
				},
				{ additionalProperties: false },
			),
		),
		/** Resolved hard bounds for this job (home default, env, or per-dispatch). */
		bounds: Type.Optional(JobHardBoundsSchema),
		failure: Type.Optional(FailureSchema),
		receipts: Type.Optional(Type.Array(ReceiptSchema, { maxItems: 20 })),
		/** The scope/risk/thinking that decided this job's model (cp-status-scope-risk). */
		routing: Type.Optional(JobRoutingSchema),
		/**
		 * How a `done` job was closed (cp-8km). `"forced"` means the teardown gates
		 * were skipped by explicit operator authorization — nothing was proven about
		 * the work, so an unmerged PR must never render as Shipped on that record.
		 * Absent on a job never torn down; `"gated"` on every normal teardown.
		 */
		closed_reason: Type.Optional(StringEnum(["gated", "forced"])),
	},
	{ additionalProperties: false },
);
export type FleetRecord = Replace<
	Static<typeof FleetRecordSchema>,
	{ kind: JobKind; delivery: Delivery; phase: JobPhase; worker: WorkerHandle; failure?: Failure; routing?: JobRouting }
>;

export type ScriptFleetRecord = Omit<FleetRecord, "worker" | "executor" | "script_path" | "script_process"> & {
	executor: "script";
	worker?: never;
	script_path: string;
	script_process?: ScriptProcess;
};

export const FleetFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		jobs: Type.Array(FleetRecordSchema),
	},
	{ additionalProperties: false },
);
export type FleetFile = Narrow<Static<typeof FleetFileSchema>, "jobs", FleetRecord[]>;

export const EMPTY_FLEET: FleetFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	jobs: [],
};

export function validateFleetFile(value: unknown): ValidationResult<FleetFile> {
	const result = validate<FleetFile>(FleetFileSchema, normalizeLegacyRoles(value));
	if (!result.ok) return result;
	const seen = new Set<string>();
	const errors: string[] = [];
	// FleetRecord remains the model-only runtime view until PR 2 guards its readers.
	for (const job of result.value.jobs as Static<typeof FleetRecordSchema>[]) {
		if (isScriptFleetRecord(job)) {
			const missingProcessAllowed = job.phase === "launching" || job.phase === "failed" && job.failure?.class === "crash" || job.phase === "done" && job.closed_reason === "forced" || Boolean(job.reported_at && job.script_observed_exit);
			if (job.worker !== undefined || !job.script_path || !isSafeScriptPath(job.script_path) || job.kind !== "ship" || job.delivery !== "local" || job.script_observed_exit && (!job.reported_at || job.script_process) || (job.phase === "launching" ? job.script_process !== undefined || job.script_observed_exit !== undefined : !job.script_process && !missingProcessAllowed)) {
				errors.push(`/jobs/${job.job_id}: script requires ship/local, script_path and a process or stamped observed exit after launch (unless the unknown launch failed), without worker`);
			}
		} else if (!job.worker || job.phase === "launching" || job.script_process !== undefined || job.script_observed_exit !== undefined || job.script_path !== undefined) {
			errors.push(`/jobs/${job.job_id}: model requires worker and forbids script fields`);
		}
		if (seen.has(job.job_id)) {
			errors.push(`/jobs: duplicate job_id "${job.job_id}" — fleet.json is keyed by job id`);
		}
		seen.add(job.job_id);
		if (job.phase === "held" && !job.reported_at) {
			errors.push(`/jobs/${job.job_id}: phase "held" requires reported_at (a hold follows an envelope)`);
		}
		if (job.phase === "failed" && !job.failure) {
			errors.push(`/jobs/${job.job_id}: phase "failed" requires a failure with a class (never guess a cause)`);
		}
	}
	return errors.length === 0 ? result : { ok: false, errors };
}
