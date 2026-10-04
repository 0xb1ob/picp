/** Awaiting you: declared decisions, the dialog, decision pane, plan pager and suggested answers. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, SCHEMA_VERSION, validate, type ValidationResult } from "./core.ts";
import { DecisionBasisSchema, DelegationProvenanceFields } from "./escalations.ts";
import type { Narrow, Replace } from "./internal.ts";

// ---------------------------------------------------------------------------
// Awaiting you (cp-av8) — state/awaiting.json
// ---------------------------------------------------------------------------

/**
 * The three cell types the Awaiting-you table renders. Only two of them are
 * ever *persisted* here (see AWAITING_DECLARED_TYPES below): `authorization`
 * is always derived from `state/checkpoints/*.json` at render time, never
 * written into this store, so an authorization decision has exactly one
 * record — the checkpoint file, decided only by CheckpointStore.decide.
 */
export const AWAITING_TYPES = ["approval", "design", "authorization", "escalation"] as const;
export type AwaitingType = (typeof AWAITING_TYPES)[number];
export const AwaitingTypeSchema = StringEnum([...AWAITING_TYPES]);

/** Types this store may hold. `authorization` is refused by AwaitingStore.declare. */
export const AWAITING_DECLARED_TYPES = ["approval", "design"] as const;
export type AwaitingDeclaredType = (typeof AWAITING_DECLARED_TYPES)[number];
export const AwaitingDeclaredTypeSchema = StringEnum([...AWAITING_DECLARED_TYPES]);

/**
 * `deferred` (cp-gmy) is a row that EXISTS but has not been asked yet: a merge
 * approval whose PR's CI has not finished for the branch's current head. It is
 * durable on purpose — a deferred ask that lived only in a model's next prompt
 * would be an ask that silently never appears, which is worse than the
 * premature ask it replaces. It is never rendered as an open decision, never
 * counted by the widget marker, and never answerable; it is promoted to `open`
 * by `AwaitingStore.reviewDeferred` the moment CI completes on that head.
 */
export const AWAITING_STATES = ["open", "answered", "withdrawn", "deferred"] as const;
export type AwaitingState = (typeof AWAITING_STATES)[number];
export const AwaitingStateSchema = StringEnum([...AWAITING_STATES]);

/** Same bound as the status block's judgment cells (MAX_CELL_CHARS). */
export const AWAITING_DECISION_MAX_CHARS = 100;
export const AWAITING_ANSWER_MAX_CHARS = 1000;
export const AWAITING_MAX_OPTIONS = 6;
export const AWAITING_OPTION_MAX_CHARS = 120;
/** Answered items are pruned to the most recent N so the file cannot grow forever. */
export const AWAITING_KEEP_ANSWERED = 50;
/** A human is never load-bearing for a dialog's liveness; mirrors QUESTION_DEFAULT_TIMEOUT_MS. */
export const AWAITING_DIALOG_TIMEOUT_MS = 600_000;
/**
 * The same deadline, on the **unattended** overlay (cp-gb3w, review 2). The
 * `agent_settled` auto-open opens a surface nobody asked for, so it may not
 * wait on a human forever: on expiry the overlay is closed and the batch is a
 * skip — nothing is written anywhere and every item simply reappears. It is
 * deliberately the same number the plain dialog carried on this path (600s),
 * not a longer one. A typed `/cp-decide` and the checkpoint ask carry no
 * deadline: a human asked for those.
 */
export const AWAITING_AUTO_OPEN_OVERLAY_TIMEOUT_MS = AWAITING_DIALOG_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// Suggested answers (cp-9zj / cp-7t7) — model-generated candidates in the
// /cp-decide answer menu. Numbers only; the invariants live in
// docs/contracts.md §Suggested answers and in src/suggest.ts's own header.
// ---------------------------------------------------------------------------

/** How many generated candidates the menu ever shows for one item. */
export const SUGGEST_MAX_CANDIDATES = 3;
/** Default deadline for one item's generation, once per item per session. */
export const SUGGEST_DEADLINE_MS = 2_000;
export const SUGGEST_DEADLINE_MIN_MS = 200;
export const SUGGEST_DEADLINE_MAX_MS = 15_000;
/** Cap passed to the model call — cost bound, not a UX one. */
export const SUGGEST_MAX_OUTPUT_TOKENS = 256;
/** The whole prompt (system + user) is capped here, after per-field truncation. */
export const SUGGEST_PROMPT_MAX_CHARS = 1_200;
/** Every whitelisted field is truncated to this before it reaches the prompt. */
export const SUGGEST_FIELD_MAX_CHARS = 200;
/** Session-scoped LRU cap on the suggestion cache; never persisted. */
export const SUGGEST_CACHE_MAX_ENTRIES = 200;
/** How many items the headless `/cp-decide` listing may generate for, per call. */
export const SUGGEST_MAX_ITEMS_PER_LISTING = 5;
/** Cheap-model default; overridable in `data/suggest.json`. */
export const SUGGEST_DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

// ---------------------------------------------------------------------------
// The decision details pane (pi-command-post-4mn) — the bounded evidence block
// `/cp-decide` shows beside one item. Numbers and one label only; the
// invariants live in docs/contracts.md §The decision details pane and in
// src/decision-context.ts's own header.
// ---------------------------------------------------------------------------

/**
 * Lines in the whole pane. Big enough that every actionable finding a verdict
 * may carry (`GATE_REASONS_MAX_ITEMS` reasons plus revisions, capped at
 * `DECISION_CONTEXT_MAX_FINDINGS`) fits beside the header and the
 * recommendation; small enough that the block is still a pane on a narrow
 * terminal and not a document.
 */
export const DECISION_CONTEXT_MAX_LINES = 20;
/** One line, after whitespace collapse and redaction. A pane never wraps forever. */
export const DECISION_CONTEXT_LINE_MAX_CHARS = 160;
/**
 * How many findings are rendered before the pane says how many it withheld.
 * A verdict may carry `GATE_REASONS_MAX_ITEMS` reasons *and* as many revisions,
 * so this is the point where "all of them" stops being renderable — and it is
 * an explicit `+N more` line, never a silent drop.
 */
export const DECISION_CONTEXT_MAX_FINDINGS = 12;
/**
 * The recommendation is always prefixed with this, and it is always a line in
 * the pane rather than an option in the menu: a recommendation that could be
 * selected would be a preselected authorization, which is the one thing an
 * Awaiting-you surface may never offer.
 */
export const DECISION_CONTEXT_RECOMMENDATION_LABEL = "recommendation (not a decision, nothing preselected):";
/**
 * Rows the pane leaves for everything that is not the pane, when a caller knows
 * the terminal size: the overlay's chrome and header, the question's own three
 * lines, the answer rows and the key legend.
 *
 * Measured on a real pi TUI (docs/tui-verification/pi-command-post-4mn.md): with
 * a 20-line pane on a 40x24 terminal the answer rows were pushed off screen and
 * the overlay did not scroll to the selection, so the operator could navigate
 * but not see what they were about to answer. The pane yields first — it is
 * context, and the decision is the thing that must stay visible.
 */
export const DECISION_PANE_RESERVED_ROWS = 14;
/** Floor on the pane's row budget: below this it is not worth rendering a pane. */
export const DECISION_PANE_MIN_ROWS = 3;
/**
 * How many gate attempt slots the details pane scans for the newest verdict.
 * The ladder itself is bounded far below this (`GATE_MAX_REVISE`); the scan is
 * deliberately wider so a hand-pruned or partially restored run directory still
 * yields the verdict that is on disk.
 */
export const GATE_MAX_ATTEMPTS_SCANNED = 8;

// ---------------------------------------------------------------------------
// Reading the plan (cp-9c5) — an operator-only, mode-gated pager over a
// research artifact or a gate decision, wired nowhere a model can reach it.
// See docs/contracts.md §Reading the plan for the invariants; these are just
// the numbers.
// ---------------------------------------------------------------------------

/** Above this many bytes the viewer opens on a head slice and says so. */
export const PLAN_VIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Same liveness rule as the Awaiting-you dialog: nobody is load-bearing forever. */
export const PLAN_VIEW_IDLE_TIMEOUT_MS = AWAITING_DIALOG_TIMEOUT_MS;
/** Floor on the scrollable body, even on a tiny terminal. */
export const PLAN_VIEW_MIN_ROWS = 4;
/** Header + footer lines the viewer always reserves, outside the body rows. */
export const PLAN_VIEW_CHROME_ROWS = 2;
/** Rows subtracted from the terminal height before computing the viewport. */
export const PLAN_VIEW_RESERVED_ROWS = 6;
/** The `/cp-decide` answer-menu option that opens the viewer, compared by identity. */
export const PLAN_VIEW_OPTION = "View the plan…";
/**
 * Re-opening the viewer, offered *after* the plan has been read once. It is a
 * separate string from `PLAN_VIEW_OPTION` on purpose: once the operator has
 * been in the pager, the menu's first (default-highlighted) option must be
 * `PLAN_VIEW_BACK_OPTION`, not the viewer again — a stray Enter that reopens
 * the pager is what "I clicked done and we are still stuck on this decide"
 * looks like from the keyboard (cp-viewer-scroll-stuck).
 */
export const PLAN_VIEW_AGAIN_OPTION = "View the plan again…";
/**
 * The non-destructive way out of one item's answer menu: back to the list,
 * nothing recorded, the item still open. Compared by identity, like every
 * other sentinel here, so it can never be stored as an answer or a note.
 */
export const PLAN_VIEW_BACK_OPTION = "Done reading \u2014 back to the list";
/** Free-text answer, and "leave it open": both sentinels, both never answers. */
export const AWAITING_TYPE_OPTION = "Type an answer…";
export const AWAITING_SKIP_OPTION = "Skip";
/** The item-list option that ends the dialog. */
export const AWAITING_DONE_OPTION = "Done";
/**
 * Every sentinel the Awaiting-you dialog may show; compared by identity before anything is written.
 */
export const AWAITING_SENTINEL_OPTIONS = [
	PLAN_VIEW_OPTION,
	PLAN_VIEW_AGAIN_OPTION,
	PLAN_VIEW_BACK_OPTION,
	AWAITING_TYPE_OPTION,
	AWAITING_SKIP_OPTION,
	AWAITING_DONE_OPTION,
] as const;

/**
 * The three rows the checkpoint authorization ask has always offered, now
 * named once so the overlay (cp-gb3w) and the plain `ctx.ui.select` dialog
 * offer the identical menu rather than two hand-typed copies of it. Only the
 * first two are verdicts; `CHECKPOINT_LATER_OPTION` is T21's "not now" and
 * leaves the checkpoint pending.
 */
export const CHECKPOINT_APPROVE_OPTION = "approve";
export const CHECKPOINT_DECLINE_OPTION = "decline";
export const CHECKPOINT_LATER_OPTION = "not now";

/** Rounds the dialog may take before it gives up rather than spin forever. */
export const AWAITING_DIALOG_MAX_ROUNDS = 200;
/** Presentations of one item's answer menu before the dialog gives up on it. */
export const AWAITING_ITEM_MAX_STEPS = 50;

/**
 * The widest id this store may hold: `aw-` plus a hash for a declared row, or
 * `aw-research-<job-id>` for a *derived* row materialised when a human answers
 * it. A job id may be 128 characters, and the derived id must stay byte-for-byte
 * the id the operator was shown — that identity is the invariant — so the bound
 * has to hold the longest such id rather than truncate one. The longest derived
 * id of all is a checkpoint's (`aw-checkpoint-<job-id>.diff`, cp-khf), and it
 * fits here too; authorization rows are never stored in this file, but they are
 * carried verbatim by the answered wake-up, which shares this bound.
 */
export const AWAITING_ID_MAX_CHARS = 160;

/**
 * The widest *subject* a row may carry (cp-nx7). A subject is the decision's
 * identity — what is being decided — not the prose describing it, so it is a
 * key, not a sentence.
 */
export const AWAITING_SUBJECT_MAX_CHARS = 200;

/**
 * One line of `state/awaiting.json`. `id` is stable and caller-reusable: a
 * model that upserts the same *subject* (`{job_id,type,subject}`) next turn
 * gets the same row back rather than a duplicate, even if it reworded the
 * question in the meantime (cp-nx7). Free text on an authorization item is
 * never expressed here — authorization items never enter this store at all.
 */
export const AwaitingItemSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		id: Type.String({ minLength: 1, maxLength: AWAITING_ID_MAX_CHARS }),
		type: AwaitingDeclaredTypeSchema,
		decision: Type.String({ minLength: 1, maxLength: AWAITING_DECISION_MAX_CHARS }),
		why: Type.String({ minLength: 1, maxLength: AWAITING_DECISION_MAX_CHARS }),
		blocks: Type.String({ minLength: 1, maxLength: AWAITING_DECISION_MAX_CHARS }),
		/** Optional: the no-job case (a routing/design question) is first class. */
		job_id: Type.Optional(JobIdSchema),
		options: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: AWAITING_OPTION_MAX_CHARS }), { maxItems: AWAITING_MAX_OPTIONS }),
		),
		state: AwaitingStateSchema,
		opened_at: IsoTimestampSchema,
		answer: Type.Optional(Type.String({ maxLength: AWAITING_ANSWER_MAX_CHARS })),
		/** `mandate:<id>`, `operator-quote` or `operator-delegated`. */
		answered_by: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
		...DelegationProvenanceFields,
		basis: Type.Optional(DecisionBasisSchema),
		answered_at: Type.Optional(IsoTimestampSchema),
		/** Set once the answer landed as a br comment. Absent = not yet audited. */
		audit_ref: Type.Optional(Type.String({ maxLength: 200 })),
		/**
		 * cp-gmy: why this row is `deferred` — the CI state that made the ask
		 * unanswerable, in the operator's language. Rendered under the Awaiting-you
		 * table so a deferral is loud, never a dropped row. Refreshed on every
		 * review; cleared when the row is promoted to `open`.
		 *
		 * cp-p1sh: it also carries the reason a row was closed *unasked* — a merge
		 * ask whose merge had already happened is `withdrawn` with the evidence in
		 * this field, so the disposition is readable on the row and not only in the
		 * one render that decided it.
		 */
		deferred_reason: Type.Optional(Type.String({ maxLength: AWAITING_DECISION_MAX_CHARS })),
		deferred_at: Type.Optional(IsoTimestampSchema),
		/**
		 * cp-nx7: the caller's *explicit* subject, when it gave one. Absent means
		 * the subject is derived from `{job_id,type,decision}` on every read, so an
		 * improvement to the derivation reaches rows written before it — which is
		 * why a derived subject is deliberately NOT persisted here.
		 */
		subject: Type.Optional(Type.String({ minLength: 1, maxLength: AWAITING_SUBJECT_MAX_CHARS })),
	},
	{ additionalProperties: false },
);
export type AwaitingItem = Replace<
	Static<typeof AwaitingItemSchema>,
	{ type: AwaitingDeclaredType; state: AwaitingState }
>;

export const AwaitingFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		items: Type.Array(AwaitingItemSchema),
	},
	{ additionalProperties: false },
);
export type AwaitingFile = Narrow<Static<typeof AwaitingFileSchema>, "items", AwaitingItem[]>;

export const EMPTY_AWAITING_FILE: AwaitingFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	items: [],
};

export function validateAwaitingFile(value: unknown): ValidationResult<AwaitingFile> {
	return validate<AwaitingFile>(AwaitingFileSchema, value);
}

// ---------------------------------------------------------------------------
// Suggest config (cp-7t7) — data/suggest.json
// ---------------------------------------------------------------------------

/**
 * Operator knobs for the /cp-decide suggestion generator. Mirrors
 * data/gate.json's own shape and its own rule: absent means "no suggestions
 * configured", not "suggestions off by policy" — `enabled` alone decides that,
 * and it defaults to true so an operator who never opts in still gets the
 * generated-candidates surface (best-effort, degrading to today's menu on any
 * failure). Read fresh on every call, never cached (cp-sr5's rule, again).
 */
export const SuggestConfigSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		/** Off switch. Absent/true means suggestions are attempted. */
		enabled: Type.Optional(Type.Boolean()),
		/** Cheap-model override; still allowlisted and still probed. */
		model: Type.Optional(Type.String({ minLength: 1 })),
		/** Per-item generation deadline, bounded so a slow provider never blocks the dialog. */
		deadline_ms: Type.Optional(Type.Integer({ minimum: SUGGEST_DEADLINE_MIN_MS, maximum: SUGGEST_DEADLINE_MAX_MS })),
		/** How many candidates to ask for/keep, at most SUGGEST_MAX_CANDIDATES. */
		max_candidates: Type.Optional(Type.Integer({ minimum: 1, maximum: SUGGEST_MAX_CANDIDATES })),
	},
	{ additionalProperties: false },
);
export type SuggestConfig = Static<typeof SuggestConfigSchema>;

export const DEFAULT_SUGGEST_CONFIG: SuggestConfig = {
	schema_version: SCHEMA_VERSION,
};
