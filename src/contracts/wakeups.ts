/** Durable wake-ups: answered decisions, death/bound/recovery outboxes, answer cards. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, SCHEMA_VERSION, validate, type ValidationResult } from "./core.ts";
import { SUMMARY_MAX_CHARS } from "./envelope.ts";
import { AWAITING_ANSWER_MAX_CHARS, AWAITING_DECISION_MAX_CHARS, AWAITING_ID_MAX_CHARS, type AwaitingType, AwaitingTypeSchema } from "./awaiting.ts";
import type { Replace } from "./internal.ts";

/**
 * A wake-up delivered this long after it was issued is annotated as late
 * (cp-p6m). It is not a verdict about truth — a late wake-up whose facts still
 * hold is still a real report — only a statement that the parent is reading
 * something written a while ago, so "the state has moved on" is a live
 * possibility even when nothing on disk contradicts the message.
 *
 * Staleness itself is never inferred from age: it is decided from the facts a
 * wake-up carries (its envelope generation, its `reported_at`, its tool call)
 * against the facts on disk at delivery time. See `src/wakeups.ts`.
 */
export const WAKEUP_LATE_SECONDS = 60;

/**
 * The answer card (`delivery:answer`) — bounds, in one place.
 *
 * `ANSWER_MAX_BYTES` is enforced twice on purpose: worker-side in
 * `localChecks` (repairable — the worker is told to tighten it) so an
 * essay never becomes an "answer" at all, and again at render time, so a
 * file that grew after the fact still cannot flood the transcript.
 *
 * The card is a pi custom session entry, which by contract does not
 * participate in LLM context (docs/extensions.md) — the same mechanism
 * `cp-output` already uses. The entry payload carries a **pointer** (job id,
 * path, bytes) plus the envelope headline, never the answer body: the body
 * is read from disk by the renderer, so it is never persisted in the session
 * file either.
 */
export const ANSWER_MAX_BYTES = 8192;
/** Custom entry type of an answer card. Distinct from `cp-output` so a card can never be mistaken for a plan. */
export const ANSWER_ENTRY_TYPE = "cp-answer";
/** Body lines a collapsed answer card shows before "… N more (expand)". */
export const ANSWER_CARD_COLLAPSED_LINES = 12;

/**
 * How long a queued card waits for an idle moment before it is surfaced
 * anyway (cp-6lg7). A card appended into the middle of a streaming turn is the
 * one that got lost; a card that is never appended at all because the parent
 * never went idle would be the same bug with better manners, so the wait is
 * bounded and the fallback is to deliver.
 */
export const ANSWER_CARD_DEFER_SECONDS = 90;

/**
 * Delivered card ids kept on the record. Big enough that a long-lived home
 * cannot resurrect a card it already showed, small enough that the file stays
 * a file. One Q&A job mints exactly one id per envelope generation.
 */
export const ANSWER_CARD_KEEP_DELIVERED = 200;

// ---------------------------------------------------------------------------
// Answered decisions (cp-answer-doesnt-wake) — state/answered.json
// ---------------------------------------------------------------------------

/**
 * Delivered ids kept on the record. Enough that a long session cannot replay
 * an old answer as a fresh wake-up, small enough that the file stays a file.
 */
export const ANSWERED_KEEP_DELIVERED = 200;

/**
 * The custom message type a wake-up travels on. Named here because two sides
 * depend on it: the extension that sends the message, and the arrival observer
 * that confirms it (cp-nx7 — `delivered_at` is stamped on *arrival*, so the
 * observer has to recognise the message it is observing).
 */
export const ANSWERED_MESSAGE_TYPE = "cp-answered";

/**
 * How long a sent-but-unobserved wake-up is left alone before it is sent again
 * (cp-nx7). A wake-up is not delivered when it is handed to the transport, only
 * when it reaches the parent's context, and a message that never arrives must
 * not sit silently forever: past this window the whole pending queue is sent
 * again, coalesced. Duplicate delivery is preferred over silent loss —
 * acting twice on "merge #44" is idempotent and visible; losing it is neither.
 */
export const ANSWERED_DELIVERY_RETRY_SECONDS = 120;

/**
 * One answered decision, on its way to the parent's turn. This is the *whole*
 * payload of a `cp-answered` message: the id that was answered, its type, the
 * job it concerns if any, and the answer itself — enough for the parent to act
 * without re-reading a single file, and never an artifact body.
 */
export const AnsweredDecisionSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		/** The Awaiting-you id the operator was shown (`aw-…`), verbatim. */
		id: Type.String({ minLength: 1, maxLength: AWAITING_ID_MAX_CHARS }),
		/** Including `authorization`: a checkpoint answer is an answer. */
		type: AwaitingTypeSchema,
		job_id: Type.Optional(JobIdSchema),
		/** The question that was answered, as the operator saw it. */
		decision: Type.String({ minLength: 1, maxLength: AWAITING_DECISION_MAX_CHARS }),
		/** The answer text (`approve`, `ship`, free text on a declared row). */
		answer: Type.String({ minLength: 1, maxLength: AWAITING_ANSWER_MAX_CHARS }),
		/** The human channel that answered. Never a model. */
		answered_by: Type.String({ minLength: 1, maxLength: 120 }),
		answered_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type AnsweredDecision = Replace<Static<typeof AnsweredDecisionSchema>, { type: AwaitingType }>;

/** One delivery that happened, so a restart cannot announce it again. */
export const AnsweredDeliverySchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: AWAITING_ID_MAX_CHARS }),
		delivered_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type AnsweredDelivery = Static<typeof AnsweredDeliverySchema>;

/**
 * One emission that happened (cp-5mgg): written to disk **before** the message
 * is handed to the transport, so "this answer has already been emitted once" is
 * a fact that survives the crash, the restart and the second drain that used to
 * re-emit it. It is not a delivery — only observed arrival is
 * (`AnsweredDelivery`) — it is the record that stops one answer being emitted
 * over and over while its arrival evidence is missing.
 */
export const AnsweredSendSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: AWAITING_ID_MAX_CHARS }),
		/** When the last emission was recorded. Always *before* that emission. */
		sent_at: IsoTimestampSchema,
		/** How many times this answer has been emitted. Never a delivery count. */
		attempts: Type.Integer({ minimum: 1 }),
		/**
		 * Which parent process made this emission (pi-command-post-u9q). A
		 * reservation is only a reservation while its owner is the process that is
		 * running: a record left behind by a parent that has since died was emitted
		 * into a context nobody will ever take a turn in, so the successor treats it
		 * as due rather than waiting out a window it did not open. Optional so an
		 * outbox written before this field still validates — an unowned record reads
		 * as somebody else's, which is the fail-safe direction (the answer goes out).
		 */
		owner: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	},
	{ additionalProperties: false },
);
export type AnsweredSend = Static<typeof AnsweredSendSchema>;

/**
 * `state/answered.json` — a durable outbox, not a log. `pending` is what no
 * parent has been woken by yet; `sends` is what has already been emitted for a
 * still-pending answer; `delivered` is the memory that makes delivery
 * exactly-once across a restart.
 *
 * `sends` is optional so an outbox written before cp-5mgg still validates: an
 * absent record reads as "never emitted", which is the fail-safe direction (the
 * answer goes out) rather than a silently dropped decision.
 */
export const AnsweredOutboxFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		pending: Type.Array(AnsweredDecisionSchema),
		sends: Type.Optional(Type.Array(AnsweredSendSchema)),
		delivered: Type.Array(AnsweredDeliverySchema),
	},
	{ additionalProperties: false },
);
export type AnsweredOutboxFile = Replace<
	Static<typeof AnsweredOutboxFileSchema>,
	{ pending: AnsweredDecision[]; sends?: AnsweredSend[]; delivered: AnsweredDelivery[] }
>;

export const EMPTY_ANSWERED_OUTBOX: AnsweredOutboxFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	pending: [],
	sends: [],
	delivered: [],
};

export function validateAnsweredOutboxFile(value: unknown): ValidationResult<AnsweredOutboxFile> {
	return validate<AnsweredOutboxFile>(AnsweredOutboxFileSchema, value);
}

// ---------------------------------------------------------------------------
// Durable wake-ups (death / bound / recovery) — state/wakeups.json
// ---------------------------------------------------------------------------

export const DURABLE_WAKEUP_KEEP_DELIVERED = ANSWERED_KEEP_DELIVERED;
export const DURABLE_WAKEUP_RETRY_SECONDS = ANSWERED_DELIVERY_RETRY_SECONDS;

export const DURABLE_WAKEUP_KINDS = ["death", "bound", "recovery"] as const;
export type DurableWakeupKind = (typeof DURABLE_WAKEUP_KINDS)[number];
export const DurableWakeupKindSchema = StringEnum([...DURABLE_WAKEUP_KINDS]);

export const DurableWakeupEntrySchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		id: Type.String({ minLength: 1, maxLength: 160 }),
		kind: DurableWakeupKindSchema,
		job_id: Type.Optional(JobIdSchema),
		content: Type.String({ minLength: 1, maxLength: 4000 }),
		keys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }))),
		generation: Type.Optional(Type.Integer({ minimum: 1 })),
		queued_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type DurableWakeupEntry = Replace<
	Static<typeof DurableWakeupEntrySchema>,
	{ kind: DurableWakeupKind }
>;

export const DurableWakeupOutboxFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		pending: Type.Array(DurableWakeupEntrySchema),
		sends: Type.Optional(Type.Array(AnsweredSendSchema)),
		delivered: Type.Array(AnsweredDeliverySchema),
		/** Terminal: stale suppression. Not a delivery, and not retried. */
		discarded: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: Type.String({ minLength: 1, maxLength: 160 }),
						at: IsoTimestampSchema,
						reason: Type.String({ minLength: 1, maxLength: 500 }),
					},
					{ additionalProperties: false },
				),
			),
		),
	},
	{ additionalProperties: false },
);
export type DurableWakeupDiscard = { id: string; at: string; reason: string };
export type DurableWakeupOutboxFile = Replace<
	Static<typeof DurableWakeupOutboxFileSchema>,
	{
		pending: DurableWakeupEntry[];
		sends?: AnsweredSend[];
		delivered: AnsweredDelivery[];
		discarded?: DurableWakeupDiscard[];
	}
>;

export const EMPTY_DURABLE_WAKEUP_OUTBOX: DurableWakeupOutboxFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	pending: [],
	sends: [],
	delivered: [],
};

export function validateDurableWakeupOutboxFile(value: unknown): ValidationResult<DurableWakeupOutboxFile> {
	return validate<DurableWakeupOutboxFile>(DurableWakeupOutboxFileSchema, value);
}

// ---------------------------------------------------------------------------
// Answer card delivery (cp-6lg7) — state/answer-cards.json
// ---------------------------------------------------------------------------

/**
 * One answer card owed to the operator: a **pointer**, exactly like the entry
 * payload it becomes. job id, project, the envelope headline, the artifact path
 * and its size — never the answer body, which is read from disk at render time
 * and lives in no session file, no message and no context.
 *
 * `id` is `<job-id>#<generation>`: one envelope generation, one card, forever.
 * A promote that reopens the slot mints a new generation and therefore a new
 * card; nothing else can produce a second one.
 */
export const AnswerCardRecordSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		id: Type.String({ minLength: 1, maxLength: 160 }),
		job_id: JobIdSchema,
		project: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
		generation: Type.Integer({ minimum: 1 }),
		/** The envelope headline, already bounded to three lines by the envelope contract. */
		summary: Type.String({ maxLength: SUMMARY_MAX_CHARS }),
		/** Absolute path of the stored answer, inside the artifact store. */
		path: Type.String({ minLength: 1, maxLength: 4096 }),
		bytes: Type.Integer({ minimum: 0 }),
		/** When the envelope this card carries was stamped. */
		reported_at: IsoTimestampSchema,
		/** When the card was queued — the clock the defer window runs on. */
		queued_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type AnswerCardRecord = Static<typeof AnswerCardRecordSchema>;

/** Where a delivered card was actually shown. Facts, for the run log and tests. */
export const ANSWER_CARD_CHANNELS = ["card", "notice", "schedules_page"] as const;
export type AnswerCardChannel = (typeof ANSWER_CARD_CHANNELS)[number];
export const AnswerCardChannelSchema = StringEnum([...ANSWER_CARD_CHANNELS]);

/** One card that reached the operator, so nothing can show it a second time. */
export const AnswerCardDeliverySchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 160 }),
		job_id: JobIdSchema,
		delivered_at: IsoTimestampSchema,
		channel: AnswerCardChannelSchema,
	},
	{ additionalProperties: false },
);
export type AnswerCardDelivery = Replace<Static<typeof AnswerCardDeliverySchema>, { channel: AnswerCardChannel }>;

/**
 * `state/answer-cards.json` — a durable outbox, not a log. `pending` is every
 * answer the operator is owed; `delivered` is the memory that makes the card
 * exactly-once across a teardown, a restart and a re-render.
 *
 * It is deliberately not derived from the fleet record: the whole defect
 * (cp-6lg7) is that a job's *phase* moves on — held, done, torn down, closed —
 * within seconds of the envelope, and every surface keyed on that phase judged
 * the answer to be history before anybody had read it.
 */
export const AnswerCardOutboxFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		pending: Type.Array(AnswerCardRecordSchema),
		delivered: Type.Array(AnswerCardDeliverySchema),
	},
	{ additionalProperties: false },
);
export type AnswerCardOutboxFile = Replace<
	Static<typeof AnswerCardOutboxFileSchema>,
	{ pending: AnswerCardRecord[]; delivered: AnswerCardDelivery[] }
>;

export const EMPTY_ANSWER_CARD_OUTBOX: AnswerCardOutboxFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	pending: [],
	delivered: [],
};

export function validateAnswerCardOutboxFile(value: unknown): ValidationResult<AnswerCardOutboxFile> {
	return validate<AnswerCardOutboxFile>(AnswerCardOutboxFileSchema, value);
}
/** A worker hit its wall-clock or tool-call cap (`src/bounds.ts`). */
export const BOUND_MESSAGE_TYPE = "cp-bound";
/** A worker died with a classified cause (`src/failures.ts`). */
export const DEATH_MESSAGE_TYPE = "cp-death";
/** Restart reconciliation found jobs the parent must act on (`src/fleet.ts`). */
export const RECOVERY_MESSAGE_TYPE = "cp-recovery";

/**
 * Every fleet/awaiting transition that must announce itself, and the wake-up
 * kind that does. `none` is parent-authored (the parent already knows).
 * A consistency test fails if a row is missing a kind, or if docs omit it.
 */
export const STATE_WAKEUP_ANNOUNCEMENTS = [
	{ event: "envelope_accepted", to: "held", wakeup: "envelope" },
	{ event: "worker_death", to: "failed", wakeup: "death" },
	{ event: "hard_bound", to: "failed", wakeup: "bound" },
	{ event: "envelope_invalid", to: "failed", wakeup: "death" },
	{ event: "budget_exceeded", to: "failed", wakeup: "death" },
	{ event: "model_call_failed", to: "failed", wakeup: "death" },
	{ event: "reconcile_unsalvageable", to: "failed", wakeup: "recovery" },
	{ event: "unreported_recorded", wakeup: "unreported" },
	{ event: "wedged_tool_call", wakeup: "wedged" },
	{ event: "ci_observation", wakeup: "ci" },
	{ event: "review_verdict", wakeup: "verdict" },
	{ event: "checkpoint_answered", wakeup: "answered" },
	{ event: "awaiting_answered", wakeup: "answered" },
	{ event: "deferred_regate", wakeup: "ci" },
	{ event: "checkpoint_created", wakeup: "none" },
	{ event: "awaiting_created", wakeup: "none" },
] as const;
export type StateWakeupAnnouncement = (typeof STATE_WAKEUP_ANNOUNCEMENTS)[number];
