/** What stops, escalates or recovers a job: hard bounds, budgets, the failure taxonomy and bounded recovery. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, SCHEMA_VERSION } from "./core.ts";
import type { Narrow } from "./internal.ts";

/** Default max concurrent workers (T7 spawn cap). */
export const DEFAULT_SPAWN_CAP = 10;

/**
 * Default per-job budgets (T18 soft gate; escalate, never silent kill).
 * The fleet-wide default is a ceiling `resolveJobBudget` clamps a profile's
 * own budget to (the stricter of the two wins) — it must stay at least as
 * high as the highest per-profile budget (profiles/*.md), or a profile raised
 * on its own is silently reclamped back down by a stale fleet default.
 */
export const DEFAULT_JOB_TOKEN_BUDGET = 50_000_000;
export const DEFAULT_JOB_COST_BUDGET_USD = 50;
/** Warn once at this fraction of a budget before breaching it. */
export const DEFAULT_BUDGET_WARN_RATIO = 0.8;

/**
 * Hard per-job caps (not the T18 soft budget). Wall-clock since spawn, and
 * a count of `tool_execution_start` events. Overridable per home with
 * `data/worker-bounds.json` (wall clock), `CP_JOB_WALL_CLOCK_SECONDS` /
 * `CP_JOB_TOOL_CALL_CAP` (same env path as `CP_WEDGED_TOOL_CALL_SECONDS`) and
 * per dispatch (`resolveJobHardBounds`). A breach records `failed`
 * and stops the worker; the worktree is left alone.
 *
 * Mission-level caps (total spend, total jobs) are a contract of the mandate
 * and are not enforced here.
 */
export const DEFAULT_JOB_WALL_CLOCK_SECONDS = 5400;
export const DEFAULT_JOB_TOOL_CALL_CAP = 900;

export const JobHardBoundsSchema = Type.Object(
	{
		wall_clock_seconds: Type.Integer({ minimum: 1 }),
		tool_call_cap: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type JobHardBounds = Static<typeof JobHardBoundsSchema>;

/**
 * A single tool call running this long is surfaced in /status and /watch as a
 * measured fact ("this call has been running for Nm"), never as an inferred
 * phase: there is no `stalled`, nothing is inferred from silence, and nobody
 * is auto-killed. A worker legitimately mid-build can run past this; the
 * point is only that the duration stops being invisible.
 */
export const LONG_TOOL_CALL_SECONDS = 300;

/**
 * A tool call with **no progress at all** for this long is surfaced to the
 * parent as a *wedged* call (cp-wedged-tool-call). Default 30 minutes.
 *
 * This is deliberately a different measurement from LONG_TOOL_CALL_SECONDS,
 * and it is deliberately NOT a phase inference:
 *
 *  - The fact being reported is **structural, not temporal**: the run's
 *    append-only log holds a `tool_execution_start` with no matching
 *    `tool_execution_end`. That is an observation about a matched pair, the
 *    same kind of fact as an observed process exit. The retired `stalled`
 *    phase had no such fact underneath it — it guessed at an unobservable
 *    pane purely from a dispatch timestamp.
 *  - Duration here is only the **reporting threshold**: how long the parent
 *    waits before deciding that an already-observed open call is worth an
 *    operator's attention. Job phases are still exactly
 *    `waiting|held|done|failed`, and none of them moves because of this.
 *  - **Progress resets the clock.** A `tool_execution_update` for the same
 *    `tool_call_id` refreshes `current_tool.last_progress_at`, so a
 *    legitimately long call that is still emitting output (a build, a
 *    backtest) is never surfaced no matter how long it runs. Silence, not
 *    age, is what is measured.
 *  - Surfacing is not killing. The 30-minute notice does not terminate
 *    anyone. A call still open at the per-job wall-clock cap is a
 *    `wall_clock_exceeded` failure (`src/bounds.ts`), not an observation forever.
 *
 * Overridable per home with `CP_WEDGED_TOOL_CALL_SECONDS` (see
 * `wedgedToolCallSeconds()` in src/wedged.ts).
 */
export const WEDGED_TOOL_CALL_SECONDS = 1800;

/**
 * The one non-terminating tool the parent grants a planner at spawn (T31), and
 * the one open tool call that is **never** a wedge (cp-ft3d).
 *
 * It lives here rather than in `src/worker-manager.ts` (which re-exports it)
 * because two unrelated modules now need to agree about the name: the spawn
 * path that grants the tool, and the wedged-call detector that must not report
 * it. An `ask_operator` call is open for exactly as long as a human takes to
 * answer — the silence belongs to the operator, not to the worker — so an
 * unmatched `tool_execution_start` for this tool is evidence of a question
 * waiting, never of a wedge. See `isWedgedToolCall` and `src/wedged.ts`.
 */
export const ASK_OPERATOR_TOOL = "ask_operator";

// ---------------------------------------------------------------------------
// Failure taxonomy (vocabulary only; recovery ladders are T18)
// ---------------------------------------------------------------------------

export const FAILURE_CLASSES = [
	"agent_empty_output",
	"provider_limit",
	"timeout",
	"crash",
	"tool_loop",
	"budget_exceeded",
	"envelope_invalid",
	/**
	 * The run finished its work and ended without calling `report_result`
	 * (cp-settle-without-report). Deliberately NOT `crash`: a crash is an exit
	 * with no settle, and calling a run that pushed a green PR "crash" is the
	 * dishonesty that let four merge-ready PRs sit unseen for 14 hours. The
	 * work is usually finished; only the envelope is missing.
	 */
	"settled_without_report",
	/**
	 * The model call itself failed, so the worker never ran a turn (cp-0wq7):
	 * pi answered the prompt, the agent loop started, and every assistant
	 * message came back `stopReason: "error"` with zero tokens — an invalid API
	 * key, an unroutable model, a provider refusing the request outright.
	 *
	 * Deliberately NOT `settled_without_report`: a dead-on-arrival worker has no
	 * work on disk to recover and nothing to promote, and prompting it again only
	 * repeats the failed call (four such workers each burned a nudge, a recovery
	 * prompt and a revive before anyone read the error out of the log). It is
	 * also not `provider_limit`: pi's own retry ladder declined to retry, so the
	 * cause is configuration, not congestion.
	 */
	"model_call_failed",
	/** Per-job wall-clock since spawn (`src/bounds.ts`). */
	"wall_clock_exceeded",
	/** Script's observed nonzero exit; never retried automatically. */
	"script_exit",
	/** Script's observed signal; never retried automatically. */
	"script_signal",
	/** Script's failed spawn; never retried automatically. */
	"spawn_failed",
	/** Per-job `tool_execution_start` count (`src/bounds.ts`). */
	"tool_call_cap_exceeded",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
export const FailureClassSchema = StringEnum([...FAILURE_CLASSES]);

/**
 * Whether a class may be retried at all. A `true` here is permission, not an
 * instruction: bounded ladders and caps live in T18.
 */
export const FAILURE_RECOVERABLE: Readonly<Record<FailureClass, boolean>> = Object.freeze({
	agent_empty_output: true,
	provider_limit: true,
	timeout: true,
	crash: true,
	tool_loop: false,
	budget_exceeded: false,
	envelope_invalid: true,
	// Not retryable, and not because it is hopeless: re-running the brief would
	// redo work that is very likely already delivered. The recovery is to look
	// at the branch/PR and then promote, revive, or tear down — a decision, not
	// another attempt.
	settled_without_report: false,
	// A retry re-issues the same call with the same credentials against the same
	// model: it fails identically. A human fixes the key or the routing.
	model_call_failed: false,
	wall_clock_exceeded: false,
	script_exit: false,
	script_signal: false,
	spawn_failed: false,
	tool_call_cap_exceeded: false,
});

// ---------------------------------------------------------------------------
// Bounded recovery (pi-command-post-autonomy-programme-cur.4.2) — one
// automatic action per failure class per job, no operator involved.
// ---------------------------------------------------------------------------

/**
 * What the parent does about a classified failure with nobody watching:
 *  - `revive`      — relaunch on the same session file (as `cp_revive`),
 *                     then prompt it to finish from what is on disk.
 *  - `redispatch`  — a fresh worker into the SAME worktree/branch a hard
 *                     bound stopped (never a new lease, never a new branch),
 *                     briefed with what is already there.
 *  - `none`        — never auto-recovered; a human decides.
 * Distinct from `FAILURE_RECOVERABLE` above, which answers a narrower
 * question ("may the same brief be retried?"): a settled-without-report
 * worker is not safe to retry with the same brief, but it is safe to revive,
 * because reviving resumes the run rather than redoing it.
 */
export const RECOVERY_POLICY_ACTIONS = ["revive", "redispatch", "none"] as const;
export type RecoveryPolicyAction = (typeof RECOVERY_POLICY_ACTIONS)[number];

/** Per-job, per-class bound on automatic recovery attempts. One, by default. */
export const RECOVERY_ATTEMPT_BOUND = 1;

/**
 * The recovery policy table (Scope bullet 1 of cur.4.2), also in
 * `docs/contracts.md`. `tool_loop`, `budget_exceeded`, `envelope_invalid`,
 * `spawn_failed` and `model_call_failed` are policy causes: a human decision,
 * never another automatic attempt (matching each class's own doc comment
 * above). A `risk:high` job never auto-recovers either, whatever the class —
 * checked by the caller, not this table, since risk lives on the job, not
 * the failure.
 */
export const RECOVERY_POLICY: Readonly<Record<FailureClass, RecoveryPolicyAction>> = Object.freeze({
	agent_empty_output: "revive",
	provider_limit: "revive",
	timeout: "revive",
	crash: "revive",
	tool_loop: "none",
	budget_exceeded: "none",
	envelope_invalid: "none",
	// Not a retry (see FAILURE_RECOVERABLE above) — a revive resumes the same
	// run so it can still call report_result, exactly what cp_revive is for.
	settled_without_report: "revive",
	model_call_failed: "none",
	wall_clock_exceeded: "redispatch",
	script_exit: "none",
	script_signal: "none",
	spawn_failed: "none",
	tool_call_cap_exceeded: "redispatch",
});

export const FailureSchema = Type.Object(
	{
		class: FailureClassSchema,
		message: Type.String({ maxLength: 2000 }),
		at: IsoTimestampSchema,
		attempt: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
export type Failure = Narrow<Static<typeof FailureSchema>, "class", FailureClass>;

// ---------------------------------------------------------------------------
// Budgets (T18) — data/budgets.json
// ---------------------------------------------------------------------------

export const BudgetConfigSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		per_job_tokens: Type.Integer({ minimum: 1 }),
		per_job_cost_usd: Type.Number({ minimum: 0 }),
		/** Cumulative ceiling across the fleet since the last operator reset. */
		cumulative_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
		warn_ratio: Type.Number({ minimum: 0, maximum: 1 }),
		spawn_cap: Type.Integer({ minimum: 1, maximum: 32 }),
	},
	{ additionalProperties: false },
);
export type BudgetConfig = Static<typeof BudgetConfigSchema>;

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
	schema_version: SCHEMA_VERSION,
	per_job_tokens: DEFAULT_JOB_TOKEN_BUDGET,
	per_job_cost_usd: DEFAULT_JOB_COST_BUDGET_USD,
	warn_ratio: DEFAULT_BUDGET_WARN_RATIO,
	spawn_cap: DEFAULT_SPAWN_CAP,
};
