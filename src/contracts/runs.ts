/** Run artifacts — state/runs/<job-id>/{events.jsonl,status.json}. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, normalizeLegacyRoles, UsageSchema, validate, type ValidationResult } from "./core.ts";
import { type Failure, FailureSchema } from "./limits.ts";
import type { Narrow, Replace } from "./internal.ts";

// ---------------------------------------------------------------------------
// Run artifacts — state/runs/<job-id>/{events.jsonl,status.json}
// ---------------------------------------------------------------------------

/**
 * Run phase is LIVENESS, derived only from observed events. It is not the job
 * phase (policy). Mapping is documented in docs/contracts.md.
 *  starting — process spawned, no agent_start yet
 *  working  — agent_start seen, not settled
 *  idle     — agent_settled seen, process alive
 *  exited   — child close OBSERVED
 */
export const RUN_PHASES = ["starting", "working", "idle", "exited"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export const RunPhaseSchema = StringEnum([...RUN_PHASES]);

/** Manager-authored markers interleaved with the teed pi events. */
export const CP_EVENT_KINDS = [
	"spawned",
	"prompt_sent",
	/**
	 * H1 (Pier 2.6): pi's own agent-level retry ladder exhausted on a transient
	 * provider error (overloaded/rate-limit/5xx/network), so command-post's own
	 * outer ladder (`OUTER_RETRY_DELAYS_MS`, src/provider-retry.ts) sent a resume
	 * nudge instead of the original brief. Carries `attempt` and `delayMs`.
	 */
	"outer_retry_attempt",
	/**
	 * A resume nudge sent under `outer_retry_attempt` got a real answer out of
	 * the provider (no `stopReason: "error"` on the next settle): the ladder
	 * resets and this attempt is the last one recorded for that failure.
	 */
	"outer_retry_succeeded",
	/**
	 * The outer ladder's attempt cap (`MAX_OUTER_RETRIES`) was spent without a
	 * successful resume: the run is left exactly as pi left it, for the
	 * ordinary failure classification (`provider_limit`) to pick up.
	 */
	"outer_retry_exhausted",
	"steer_sent",
	"follow_up_sent",
	"envelope_received",
	"envelope_rejected",
	/**
	 * A promote reopened a reported job's envelope slot: the filed envelope was
	 * archived and `reported_at` cleared, so the work that follows can be
	 * reported instead of silently lost (cp-held-cannot-report).
	 */
	"envelope_superseded",
	/**
	 * A valid promotion (`cp_send` with `task`/`taskFile`, mode `prompt`)
	 * replaced the frozen original task this job was dispatched with
	 * (cp-promote-task-record). The prior generation was archived, never
	 * destroyed, at `paths.supersededOriginalTaskFile`. An ordinary steer or
	 * follow_up never produces this event.
	 */
	"original_task_updated",
	/**
	 * A worker settled with its envelope slot still open and nothing filed, and
	 * was prompted once to file it (cp-settle-without-report). Exactly one nudge
	 * per brief: the next unreported settle is recorded, not re-prompted.
	 */
	"report_nudged",
	/**
	 * A settled worker with an open envelope slot was found to have work sitting
	 * in its worktree, and was sent the automatic recovery prompt with that
	 * evidence (cp-0dhw). Bounded by `MAX_RECOVERY_PROMPTS` per generation: after
	 * that the fact is recorded and the operator gets it, never another prompt.
	 */
	"recovery_prompted",
	/**
	 * The nudge did not produce an envelope (or could not be delivered): the run
	 * finished without reporting, recorded as the fact it is.
	 */
	"settled_without_report",
	/**
	 * The automatic recovery bound is spent for this generation (cp-0dhw): the
	 * work observed on disk is recorded with its evidence and no further prompt
	 * will ever be sent for it. The job stays `waiting`; a human decides next.
	 */
	"recovery_exhausted",
	/**
	 * Bounded recovery (cur.4.2) auto-revived (or auto-briefed) this job after a
	 * death or a hard bound, with no operator message: the attempt number and
	 * the bound it is counted against travel with it.
	 */
	"recovery_attempted",
	/**
	 * Bounded recovery's attempt bound is spent for this (job, class) pair, or
	 * the class/risk was never auto-recoverable in the first place (cur.4.2):
	 * an escalation was raised and no automatic action was taken.
	 */
	"recovery_escalated",
	/**
	 * Bounded recovery itself threw, or its outcome notice could not be written
	 * (zh7.4): an operational failure, recorded so it never disappears in a catch.
	 */
	"recovery_failed",
	/** A gate attempt decided (post-policy verdict + cause). */
	"gate_decided",
	/**
	 * A passed gate attempt's reviewer scratch cwd was removed (cp-yi73), or a
	 * removal was refused/failed. The deletion is bounded and observable: it
	 * only ever names `state/runs/<job-id>/gate-<n>/review`, and it never changes
	 * a verdict.
	 */
	"gate_scratch_removed",
	/** A diff-review attempt decided (post-policy verdict + cause). */
	"review_decided",
	/** A reviewer was spawned and handed to the background (spec 2026-09-05). */
	"review_started",
	/** The `cp-verdict` wake-up for an attempt was handed to the transport. */
	"verdict_wakeup_sent",
	/** That wake-up was observed landing in the parent's context (cp-nx7). */
	"verdict_wakeup_delivered",
	/**
	 * An attempt whose reviewer died with a previous parent session was finished
	 * as an operational fault, with no worker (D4). The ladder decides what next.
	 */
	"review_orphaned",
	"budget_warning",
	"budget_exceeded",
	"failure",
	/** A teardown that was refused by a gate: nothing changed, on purpose. */
	"teardown_refused",
	/** The routing decision and the inputs it was given (cp-rte). */
	"routing_resolved",
	/** The exact reviewer preference selected for this attempt, beside routing_resolved. */
	"reviewer_model_selected",
	/**
	 * The task this job was dispatched with, frozen to
	 * `state/runs/<id>/original-task.md` (do8.3). The payload is a path, a byte
	 * count and which source it came from — never the task itself, which is a
	 * file the parent writes and never reads back.
	 */
	"original_task_frozen",
	/**
	 * The profile asked for more tokens or cost than the fleet ceiling allows,
	 * and got the ceiling instead (cp-sr5). A clamp is documented policy, but a
	 * dispatch that clamps silently is the defect: this is the loud version.
	 */
	"budget_clamped",
	/** pi's package manager could not resolve optional worker packages; the worker spawned without them (H4). */
	"worker_packages_unresolved",
	/** A worker asked the operator a bounded question (T31). */
	"question_asked",
	/** That question was answered, cancelled, timed out or refused by policy. */
	"question_closed",
	/**
	 * Historical run-log events `/watch` still renders (counts and a duration).
	 * The console that wrote them is deleted (cur.3.4); new runs do not emit these.
	 */
	"attach_opened",
	"attach_closed",
	/** A declared Awaiting-you item opened, or one was answered/withdrawn (cp-av8). */
	"awaiting_opened",
	"awaiting_answered",
	"awaiting_withdrawn",
	"shutdown_requested",
	"process_exit",
	/**
	 * A job's PR was observed merged and the receipt recorded (cp-vk1). The
	 * evidence behind a `merged` teardown pass, journaled where a forced teardown
	 * would otherwise have been the only trace.
	 */
	"merge_recorded",
	/** A dead worker was relaunched on its own session file (cp-8km). */
	"worker_revived",
	/** `cp_revive` refused to relaunch a worker; nothing changed. */
	"revive_refused",
	/** A live, idle held author's process was stopped to free a spawn slot (phase and lease kept); `cp_send` restores it. */
	"held_released",
	/**
	 * A wake-up was not sent, or was rewritten on delivery, because the facts it
	 * described had already moved on (cp-p6m). Silence is acceptable for a stale
	 * wake-up; silence about the silence is not.
	 */
	"wakeup_suppressed",
	/**
	 * A fact source a wake-up check reads **threw** (pi-command-post-b04). Absent
	 * and broken must never look alike: a degraded head reading supersedes
	 * nothing, and this is where the failure is visible instead of being a
	 * `catch` that returns `undefined` and reads as an ordinary missing fact.
	 */
	"wakeup_source_failed",
	/** Dispatch refreshed (or skipped, or failed to refresh) a leased worktree's node_modules before the worker started. */
	"deps_prepared",
	/** Dispatch held the worktree's HEAD at its hidden checkpoint ref (`{ ref, sha }`), or could not (`{ error }`); t3code adoption 7. */
	"checkpoint_captured",
	/**
	 * The CI/PR watcher observed a new fact about a held job's PR (cp-e2d): CI
	 * finished for the branch's current pushed head, or the PR merged or closed.
	 * Evidence, never authorization — the watcher merges nothing.
	 */
	"ci_observed",
	/**
	 * One step of `cp_integrate` performed its action and its postcondition held
	 * (cp-uug). The merge sequence is a chain of checkable facts, so every link is
	 * journaled where a model's claim about it would otherwise have been the only
	 * trace.
	 */
	"integration_advanced",
	/**
	 * `cp_integrate` stopped and handed the job back to a human (a conflict a
	 * second promote will not fix, a closed PR, a missing `gh`, an unanswered
	 * merge authorization). Nothing was mutated on this path, on purpose.
	 */
	"integration_surfaced",
	/**
	 * `cp_integrate` decided whether the repository permits a merge (cp-e0c),
	 * written BEFORE `gh pr merge` is ever issued so a crash between the
	 * decision and the merge still leaves a readable record of which rule
	 * this home believed permitted it.
	 */
	"integration_permitted",
	/**
	 * The held-PR continuation ran one trigger (envelope, CI/PR fact, passing
	 * review, startup) through `cp_integrate`'s sequence, or skipped it as stale,
	 * coalesced or off (pi-command-post-epic-pr-a-jje.2).
	 */
	"continuation",
	/** One CI/PR watch query failed for this job; the watch backs off and keeps going. */
	"ci_watch_failed",
	/**
	 * A failed dispatch removed the job branch it had just created, or left it in
	 * place because it was not provably empty (cp-bw4). The destructive half of
	 * the dispatch error path is journaled either way: what was deleted, and at
	 * which sha, so "the branch is gone" is never something only a model said.
	 */
	"job_branch_cleaned",
	/**
	 * A `delivery:answer` job's card was queued for the operator, and later that
	 * it actually reached a surface (cp-6lg7). Two answers were lost with no
	 * trace but a `wakeup_suppressed` line about a different message; "did the
	 * operator ever see the answer?" is now a fact in the job's own run log,
	 * whatever the job's phase has since become.
	 */
	"answer_card_queued",
	"answer_card_delivered",
	/**
	 * Intake resolved a `delivery:pr` envelope's PR from gh and it differed from the
	 * worker's reported `pr_url` (pi-command-post-fbn). The canonical url is the one every
	 * downstream reader (the CI watch, cp_integrate, cp_merged, the status block) keys on,
	 * so the correction is journaled here — never applied silently.
	 */
	"pr_url_corrected",
	/**
	 * Intake could not check a `delivery:pr` envelope's `pr_url` against the project's
	 * origin remote (pi-command-post-fbn): `gh` was unreachable, or the origin is not a
	 * GitHub remote. The url is kept and marked unverified — ignorance is never a pass.
	 */
	"pr_url_unverified",
] as const;
export type CpEventKind = (typeof CP_EVENT_KINDS)[number];
export const CpEventKindSchema = StringEnum([...CP_EVENT_KINDS]);

/**
 * One line of events.jsonl. Append-only, LF-delimited, one JSON object per
 * line. `payload` is the verbatim pi RPC event (source "pi") or a manager
 * marker body (source "cp") and is intentionally unconstrained.
 */
export const RunEventSchema = Type.Object(
	{
		seq: Type.Integer({ minimum: 1 }),
		ts: IsoTimestampSchema,
		job_id: JobIdSchema,
		source: StringEnum(["pi", "cp"]),
		type: Type.String({ minLength: 1 }),
		payload: Type.Unknown(),
	},
	{ additionalProperties: false },
);
export type RunEventSource = "pi" | "cp";
export type RunEvent = Narrow<Static<typeof RunEventSchema>, "source", RunEventSource>;

export const CurrentToolSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		tool_call_id: Type.String({ minLength: 1 }),
		started_at: IsoTimestampSchema,
		/**
		 * The most recent `tool_execution_update` observed for THIS
		 * `tool_call_id` — i.e. the last time the call proved it was still
		 * making progress. Absent means there has been none since the start,
		 * so `started_at` is the last thing we know (that is the fallback every
		 * reader uses, and it is also how a projection written before this
		 * field existed keeps working).
		 */
		last_progress_at: Type.Optional(IsoTimestampSchema),
	},
	{ additionalProperties: false },
);

/** state/runs/<job-id>/status.json — the only read surface for run state. */
export const RunStatusSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		phase: RunPhaseSchema,
		session_id: Type.Optional(Type.String({ minLength: 1 })),
		session_file: Type.Optional(Type.String({ minLength: 1 })),
		pid: Type.Optional(Type.Integer({ minimum: 1 })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		profile: Type.Optional(Type.String({ minLength: 1 })),
		current_tool: Type.Optional(Type.Union([CurrentToolSchema, Type.Null()])),
		/**
		 * True between an observed `auto_retry_start` and its `auto_retry_end`:
		 * pi is retrying after a transient model/API failure. The agent loop
		 * restarts, so the log legitimately shows a pause with no tool activity
		 * and an `agent_start` with no matching `agent_end`. Absent means no
		 * retry is in flight (a completed retry leaves nothing behind).
		 */
		retrying: Type.Optional(Type.Boolean()),
		turns: Type.Integer({ minimum: 0 }),
		tool_calls: Type.Integer({ minimum: 0 }),
		usage: UsageSchema,
		started_at: IsoTimestampSchema,
		last_activity_at: IsoTimestampSchema,
		settled_at: Type.Optional(IsoTimestampSchema),
		exited_at: Type.Optional(IsoTimestampSchema),
		exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		event_count: Type.Integer({ minimum: 0 }),
		reported: Type.Boolean({ description: "a valid envelope has been accepted" }),
		failure: Type.Optional(FailureSchema),
	},
	{ additionalProperties: false },
);
export type RunStatus = Replace<Static<typeof RunStatusSchema>, { phase: RunPhase; failure?: Failure }>;

export function validateRunStatus(value: unknown): ValidationResult<RunStatus> {
	const result = validate<RunStatus>(RunStatusSchema, normalizeLegacyRoles(value));
	if (!result.ok) return result;
	const status = result.value;
	const errors: string[] = [];
	if (status.phase === "exited" && !status.exited_at) {
		errors.push("/phase: \"exited\" requires exited_at — dead means observed, never inferred");
	}
	if (status.phase !== "exited" && status.exited_at) {
		errors.push("/exited_at: set, but phase is not \"exited\"");
	}
	return errors.length === 0 ? result : { ok: false, errors };
}
