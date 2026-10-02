/** Reviews and gates: plan gate verdicts, diff review, the quality pass, gate config and pending reviews. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, SCHEMA_VERSION, validate, type ValidationResult } from "./core.ts";
import { DecisionSummarySchema } from "./envelope.ts";
import { CI_WATCH_MAX_BACKOFF_MS } from "./integration.ts";
import type { Narrow, Replace } from "./internal.ts";

/** Gate: one revise, then escalate (enforced in code by T20). */
export const GATE_MAX_REVISE = 1;
/**
 * Diff review: how many reviews one ship branch may get, in total.
 *
 * The plan gate's subject is a document that is either sound or is not, so one
 * revise settles it. A diff is not that: an implementer fixes what the reviewer
 * named, pushes, and the *new* head is a different subject — refusing to look at
 * it after a single revise ended the loop with the findings still unfixed and
 * the operator holding a branch nobody had re-read. So `cp_review` keeps
 * reviewing the same branch until a review comes back with no unfixed findings
 * (`pass`), and stops at this many reviews whatever happens, because "keep
 * going" without a bound is a loop.
 *
 * Counted per branch from `state/runs/<job-id>/review-<n>.json`, so the cap
 * survives a parent restart. The last permitted review never delivers another
 * revise: findings that remain there surface to the operator, and a review
 * beyond the cap is refused outright.
 */
export const REVIEW_MAX_ATTEMPTS = 5;
/** Gate verdict payload stays small enough to relay verbatim. */
export const GATE_VERDICT_WORD_CAP = 300;
/**
 * `reasons`/`revisions` item cap, shared by the reviewer's raw observation
 * (`GateReviewSchema`) and the parent's decided verdict (`GateVerdictSchema`).
 *
 * cp-yg2: the reviewer's own array already respects this bound, but the
 * parent's policy layer (`decideGate`) appends its OWN reasons on top (a
 * flag-forced-escalate note, the one-revise-cap note) — so a review that
 * arrived at the cap could still overflow it by the time the decision is
 * assembled, and `capPayload`'s word budget alone did not catch that: a
 * dozen short reasons fit easily under 300 words while still being 12 items.
 * The decision failed schema validation on the way to disk, and because
 * validation ran before persistence, the whole verdict — a real, completed
 * review — was discarded rather than degraded. `capPayload` now enforces
 * this item cap directly, and gate.ts persists the pre-cap decision
 * unabridged next to the capped one whenever anything was dropped, so a
 * truncated verdict is never the only copy.
 */
export const GATE_REASONS_MAX_ITEMS = 10;

/**
 * cp-950e: the gate scores EVERY artifact against the implementation-plan
 * rubric (`prompts/briefs/gate-rubric.md`), whatever kind of artifact it is —
 * documented in AGENTS.md and docs/contracts.md, but until now invisible in
 * the verdict itself. A 17-finding code review gated on 2026-09-01 (cp-d2n)
 * came back `escalate`/`policy` citing "test plan not runnable as written":
 * correct about plan-readiness, and read as a verdict on the review.
 *
 * The statement travels as its own field on the verdict, never as a reason:
 * a reason would consume the capped payload budget (`GATE_REASONS_MAX_ITEMS`,
 * see cp-yg2 above) and could drop a reviewer's own reason. It is constant
 * prose for a human reader, and the parent still branches on `cause`.
 */
export const GATE_RUBRIC_STATEMENT =
	"scored against the implementation-plan rubric (prompts/briefs/gate-rubric.md), which the gate applies to every artifact whatever its kind";

/**
 * Diff review (cp-diffgate-redo-hxb): the maximum number of file entries a
 * `git diff --stat`/`--name-status` summary may contain before the
 * orchestrator refuses to review at all (a diff this wide has already broken
 * "freeze scope"). A generous, defensible ceiling, not a per-job guess.
 */
export const DIFF_REVIEW_MAX_STAT_FILES = 300;
/**
 * Diff review: the maximum size (bytes) of the unified-diff hunk section
 * shown to the reviewer. Generous for a well-scoped ship job's patch text,
 * small enough to stay well inside one reviewer prompt's budget. Retune with
 * evidence, same as `BLOCKER_MAX_CHARS` above.
 */
export const DIFF_REVIEW_MAX_BYTES = 300_000;
/**
 * The maximum size (bytes) of the frozen original task copied into a
 * reviewer's scratch cwd beside the thing under review (do8.3, do8.4).
 *
 * The packet a reviewer reads is bounded in every dimension or it is not
 * bounded at all: the diff already is (`DIFF_REVIEW_MAX_BYTES` above), and a
 * task file is dispatch input whose size nothing else caps — a plan handed
 * over with `task_file` can be arbitrarily long. Generous for a plan or an
 * issue body, small enough that task + diff stays inside one reviewer's
 * prompt budget. Over the cap the copy is a stated truncation, never a silent
 * one, for the same reason the diff names its omitted files by path.
 */
export const REVIEW_ORIGINAL_TASK_MAX_BYTES = 100_000;

// ---------------------------------------------------------------------------
// Gate verdict (T20)
// ---------------------------------------------------------------------------

export const GATE_VERDICTS = ["pass", "revise", "escalate"] as const;
export type GateVerdictValue = (typeof GATE_VERDICTS)[number];
export const GateVerdictValueSchema = StringEnum([...GATE_VERDICTS]);

/**
 * `flagged` (cp-n10): a reviewer that found the artifact sound on every
 * quality criterion (`verdict: "pass"`) but whose `destructive_scope` and/or
 * `scope_growth` flag forced an escalate anyway. It is NOT a judgment
 * that the plan is wrong — that stays `policy`, and only `policy` (plus the
 * two operational causes) keeps surfacing forever, unauthorizable. A
 * `flagged` escalate is the one shape that may still reach a checkpoint: the
 * danger travels into the evidence, and a human decides with it in full view.
 */
export const GATE_CAUSES = ["policy", "operational", "operational_persistent", "flagged"] as const;
export type GateCause = (typeof GATE_CAUSES)[number] | null;
export const GateCauseSchema = Type.Union([Type.Null(), StringEnum([...GATE_CAUSES])]);

export const GateFlagsSchema = Type.Object(
	{
		destructive_scope: Type.Boolean(),
		scope_growth: Type.Boolean({ description: "plan exceeds the stated Goal/File list" }),
		blocking_unknowns: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type GateFlags = Static<typeof GateFlagsSchema>;

/**
 * The flags that **veto**: a true one forces `escalate` in `decideGate`,
 * whatever the reviewer's own verdict was (T20 policy rule 1).
 *
 * `blocking_unknowns` is deliberately absent (cp-unknowns-no-veto). The rubric
 * defines it as "an assumption that nothing in the diff (or its tests)
 * resolves", which a correctly decomposed ticket satisfies **by
 * construction** — it defers the rest to its sibling tickets. A veto on it
 * therefore turned incremental delivery into an escalate, and because the
 * reviewer's verdict in that situation is usually `revise` rather than `pass`,
 * the cause was `policy`: unauthorizable, surfacing forever. It stays a
 * reported observation — persisted in `flags`, with its own line in `reasons`
 * — and the reviewer's own verdict decides what happens.
 *
 * `scope_growth` keeps its veto **on the plan gate**: unlike `blocking_unknowns`
 * it is never true by construction, it takes an active reviewer assertion that
 * the plan exceeded what was asked, and where that boundary should be is a
 * human's call. DiffReview passes `vetoFlags: []` — every raised flag is
 * reported, none force escalate.
 */
export const GATE_VETO_FLAGS = ["destructive_scope", "scope_growth"] as const satisfies ReadonlyArray<keyof GateFlags>;

/**
 * The gate-reviewer worker's `report_verdict` payload: OBSERVATION only.
 * The reviewer never decides `cause`, never applies the flags-force-escalate
 * rule and never counts revise attempts — that is parent policy (T20).
 */
export const GateReviewSchema = Type.Object(
	{
		job_id: JobIdSchema,
		verdict: GateVerdictValueSchema,
		flags: GateFlagsSchema,
		// cp-verdict-bounds-in-brief-s64: the bounds are also stated in prose on the
		// field, not just as `maxLength`, because the model reads the description
		// and pays a whole extra turn when a 401-character reason is rejected by
		// pi's own parameter validation — before any repair path here can run.
		reasons: Type.Array(
			Type.String({
				minLength: 1,
				maxLength: 400,
				description: "One finding, at most 400 characters. Split a long finding into two items rather than pad one.",
			}),
			{
				minItems: 1,
				maxItems: GATE_REASONS_MAX_ITEMS,
				description: `Why you reached this verdict: 1 to ${GATE_REASONS_MAX_ITEMS} items, each at most 400 characters.`,
			},
		),
		revisions: Type.Optional(
			Type.Array(
				Type.String({
					minLength: 1,
					maxLength: 400,
					description: "One required change, at most 400 characters, concrete enough to act on without you.",
				}),
				{
					maxItems: GATE_REASONS_MAX_ITEMS,
					description:
						`Only when verdict is "revise", where it is required and non-empty; omit the key entirely on "pass" ` +
						`and "escalate". At most ${GATE_REASONS_MAX_ITEMS} items, each at most 400 characters.`,
				},
			),
		),
		decision_summary: Type.Optional(DecisionSummarySchema),
	},
	{ additionalProperties: false },
);
export type GateReview = Narrow<Static<typeof GateReviewSchema>, "verdict", GateVerdictValue>;

/** Persisted at state/runs/<job-id>/verdict.json by the reviewer worker. */
export const VerdictRecordSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		received_at: IsoTimestampSchema,
		attempt: Type.Integer({ minimum: 1 }),
		review: GateReviewSchema,
	},
	{ additionalProperties: false },
);
export type VerdictRecord = Narrow<Static<typeof VerdictRecordSchema>, "review", GateReview>;

/** Post-policy verdict written by the gate module and relayed to the operator. */
export const GateVerdictSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		attempt: Type.Integer({ minimum: 1 }),
		verdict: GateVerdictValueSchema,
		cause: GateCauseSchema,
		flags: GateFlagsSchema,
		reasons: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: GATE_REASONS_MAX_ITEMS }),
		revisions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: GATE_REASONS_MAX_ITEMS })),
		/**
		 * Which rubric produced this verdict (cp-950e). Optional so verdicts
		 * persisted before this field existed still validate when prior attempts
		 * are read back from disk; always written by `decideGate`.
		 */
		rubric: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		decided_at: IsoTimestampSchema,
		decision_summary: Type.Optional(DecisionSummarySchema),
	},
	{ additionalProperties: false },
);
export type GateVerdict = Replace<
	Static<typeof GateVerdictSchema>,
	{ verdict: GateVerdictValue; cause: GateCause }
>;

// ---------------------------------------------------------------------------
// Diff review (cp-diffgate-redo-hxb) — a fresh-context review of a pushed
// branch's actual diff, distinct from the gate above (which reviews a
// research *plan* before any code exists). Reuses the gate's verdict/cause
// vocabulary verbatim (GateFlagsSchema, GateCauseSchema, GATE_CAUSES,
// GateVerdictValueSchema, GATE_VERDICTS) rather than forking it; only the
// persisted shape differs, because a diff verdict needs two fields
// (`head_sha`, `diff_stat`) that GateVerdictSchema never needs and must not
// grow just to carry.
// ---------------------------------------------------------------------------

/** Per-pipeline opt-in (mirrors QualityConfigSchema). Absent/false means off. */
export const DiffReviewConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		/** Reviewer model override; routing decides when absent. */
		model: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export type DiffReviewConfig = Static<typeof DiffReviewConfigSchema>;

/**
 * Post-policy diff-review verdict, written by the (future) diff-review
 * orchestrator and relayed to the operator — a new, parallel schema, not an
 * extension of `GateVerdictSchema` (settled: see the module comment above).
 */
export const DiffVerdictSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		attempt: Type.Integer({ minimum: 1 }),
		verdict: GateVerdictValueSchema,
		cause: GateCauseSchema,
		flags: GateFlagsSchema,
		reasons: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: GATE_REASONS_MAX_ITEMS }),
		revisions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: GATE_REASONS_MAX_ITEMS })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		decided_at: IsoTimestampSchema,
		/** The branch commit this verdict reviewed — the "has the code changed" signal. */
		head_sha: Type.String({ minLength: 1 }),
		/** Stable git patch-id of the complete branch diff against its base. */
		patch_id: Type.Optional(Type.String({ minLength: 1 })),
		/** Present when no reviewer ran because this patch already passed. */
		equivalent_to: Type.Optional(
			Type.Object(
				{
					head_sha: Type.String({ minLength: 1 }),
					attempt: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false },
			),
		),
		/** Changed-head reviews score only this delta; first reviews score the full branch. */
		delta_from: Type.Optional(Type.String({ minLength: 1 })),
		diff_stat: Type.Object(
			{
				files: Type.Integer({ minimum: 0 }),
				truncated: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type DiffVerdict = Replace<
	Static<typeof DiffVerdictSchema>,
	{ verdict: GateVerdictValue; cause: GateCause }
>;

// ---------------------------------------------------------------------------
// Research quality pass (T22) — optional, off by default, per-job opt-in
// ---------------------------------------------------------------------------

/** Default panel size and threshold, ported from pi-dynamic-workflows `verify`. */
export const DEFAULT_QUALITY_VOTERS = 2;
export const DEFAULT_QUALITY_THRESHOLD = 0.5;

/**
 * The angles a voter is asked to judge. Each voter gets one lens, so
 * disagreement is visible per angle instead of averaged into a single opinion.
 */
export const QUALITY_LENSES = ["evidence", "file_list", "test_plan", "scope", "unknowns"] as const;
export type QualityLens = (typeof QUALITY_LENSES)[number];
export const QualityLensSchema = StringEnum([...QUALITY_LENSES]);

export const QualityConfigSchema = Type.Object(
	{
		/** N cheap voters on the artifact before the expensive gate. */
		verify: Type.Optional(Type.Boolean()),
		/** One pass asking whether the artifact covers the task it was given. */
		completeness: Type.Optional(Type.Boolean()),
		voters: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
		/** Fraction of votes that must be "sound" (>=). */
		threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		/** Cheap model for the panel; routing decides when absent. */
		model: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export type QualityConfig = Static<typeof QualityConfigSchema>;

export const QualityVoteSchema = Type.Object(
	{
		lens: QualityLensSchema,
		/** A vote, not a verdict: did this voter find the artifact sound? */
		sound: Type.Boolean(),
		reasons: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 10 }),
		model: Type.String({ minLength: 1 }),
		/** Set when the voter never voted; it still counts against the threshold. */
		abstained: Type.Optional(Type.Boolean()),
		note: Type.Optional(Type.String({ maxLength: 400 })),
	},
	{ additionalProperties: false },
);
export type QualityVote = Narrow<Static<typeof QualityVoteSchema>, "lens", QualityLens>;

/** state/runs/<job-id>/quality.json — written once per job. */
export const QualityReportSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		ran_at: IsoTimestampSchema,
		/** Everything below the gate agreed on: the artifact may proceed. */
		passed: Type.Boolean(),
		verify: Type.Optional(
			Type.Object(
				{
					sound: Type.Boolean(),
					sound_count: Type.Integer({ minimum: 0 }),
					total: Type.Integer({ minimum: 1 }),
					ratio: Type.Number({ minimum: 0, maximum: 1 }),
					threshold: Type.Number({ minimum: 0, maximum: 1 }),
					votes: Type.Array(QualityVoteSchema, { maxItems: 5 }),
				},
				{ additionalProperties: false },
			),
		),
		completeness: Type.Optional(
			Type.Object(
				{
					complete: Type.Boolean(),
					missing: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 10 }),
					model: Type.String({ minLength: 1 }),
					abstained: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
		/** What the planner was asked to fix, when the pass failed. */
		fixes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 20 })),
	},
	{ additionalProperties: false },
);
export type QualityReport = Replace<Static<typeof QualityReportSchema>, { verify?: { sound: boolean; sound_count: number; total: number; ratio: number; threshold: number; votes: QualityVote[] } }>;

// ---------------------------------------------------------------------------
// Gate config (cp-gate-timeout) — data/gate.json
// ---------------------------------------------------------------------------

/** Below this, a "timeout" is really just a flaky reviewer with extra steps. */
export const GATE_REVIEW_TIMEOUT_MIN_MS = 1_000;
/**
 * Above this, a hung reviewer stops being a bounded retry and starts being a
 * hung pipeline: the ladder already caps retries at `operational_persistent`
 * after two attempts, so 30 minutes per attempt is generous slack for a slow
 * model without turning one stuck reviewer into an hours-long silent stall.
 */
export const GATE_REVIEW_TIMEOUT_MAX_MS = 1_800_000;

export const GateConfigSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		/**
		 * Milliseconds a one-shot reviewer gets before `#awaitVerdict` counts it as
		 * `operational`. Absent means the built-in default
		 * (`DEFAULT_REVIEW_TIMEOUT_MS`, 300_000ms) — no behaviour change for an
		 * operator who never opts in.
		 */
		review_timeout_ms: Type.Optional(
			Type.Integer({ minimum: GATE_REVIEW_TIMEOUT_MIN_MS, maximum: GATE_REVIEW_TIMEOUT_MAX_MS }),
		),
	},
	{ additionalProperties: false },
);
export type GateConfig = Static<typeof GateConfigSchema>;

export const DEFAULT_GATE_CONFIG: GateConfig = {
	schema_version: SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// Pending reviews (spec 2026-09-05-async-reviewers)
// ---------------------------------------------------------------------------

/** The three reviewer surfaces that run in the background and wake the parent. */
export const REVIEW_SURFACES = ["gate", "review", "quality"] as const;
export type ReviewSurface = (typeof REVIEW_SURFACES)[number];
export const ReviewSurfaceSchema = StringEnum([...REVIEW_SURFACES]);

/** One file per attempt directory while a reviewer is running; deleted by `finish`. */
export const PENDING_REVIEW_FILE = "pending.json";
/** The quality panel's own attempt slot; the votes keep `verify-<n>` and `completeness`. */
export const QUALITY_PANEL_SLOT = "panel";
/** The sixth unasked wake-up: a reviewer's verdict landed (D6). */
export const VERDICT_MESSAGE_TYPE = "cp-verdict";
/** An unconfirmed `cp-verdict` is re-derived from disk and sent once more after this. */
export const VERDICT_DELIVERY_RETRY_SECONDS = 120;
/**
 * How long a `cp-verdict` the staleness check keeps withholding stays eligible
 * for another attempt, measured from its first send (pi-command-post-b04).
 *
 * A *delivered* copy still buys exactly one resend — two copies is the bound,
 * not a stream — but a withheld send put nothing in front of anybody, so it
 * spends no copy and this window, not a send count, is what bounds it. The
 * window is **derived from the watcher's own cadence**: the fact a suppressed
 * verdict is usually waiting on is a CI observation, and that observation can
 * be as much as `CI_WATCH_MAX_BACKOFF_MS` (15 minutes) away when the watcher
 * is backing off, plus a few ticks of slack. A count-based bound at the
 * delivery interval expired before the watcher had even looked again.
 */
export const VERDICT_SUPPRESSED_RETRY_MAX_SECONDS = CI_WATCH_MAX_BACKOFF_MS / 1000 + 300;

export const PendingReviewSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		surface: ReviewSurfaceSchema,
		attempt: Type.Integer({ minimum: 1 }),
		model: Type.String({ minLength: 1 }),
		/** Absent when the spawn never produced a pid (the brief was refused first). */
		pid: Type.Optional(Type.Integer({ minimum: 1 })),
		started_at: IsoTimestampSchema,
		deadline: IsoTimestampSchema,
		/** Flipped by `ReviewRuns.handBack` once the caller has its `wait` result (D7). */
		handed_back: Type.Boolean(),
		/**
		 * `surface: review` only: what the reviewer was pointed at, so an orphaned
		 * attempt can still be decided as a schema-valid `DiffVerdict` (which
		 * requires `head_sha` and `diff_stat`) and so the wake-up can carry the head.
		 */
		subject: Type.Optional(
			Type.Object(
				{
					head_sha: Type.String({ minLength: 1 }),
					branch: Type.String({ minLength: 1 }),
					files: Type.Integer({ minimum: 0 }),
					truncated: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type PendingReview = Replace<Static<typeof PendingReviewSchema>, { surface: ReviewSurface }>;

export function validatePendingReview(value: unknown): ValidationResult<PendingReview> {
	return validate<PendingReview>(PendingReviewSchema, value);
}
