/** Checkpoints and escalations — the two ways a decision reaches a human. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JOB_ID_PATTERN, JobIdSchema, SCHEMA_VERSION, validate, type ValidationResult } from "./core.ts";
import { DecisionSummarySchema, PlanSummarySchema } from "./envelope.ts";
import type { Narrow, Replace } from "./internal.ts";
const JOB_ID_RE = new RegExp(JOB_ID_PATTERN);

export const CHECKPOINT_DECISIONS = ["pending", "approved", "declined"] as const;
export type CheckpointDecision = (typeof CHECKPOINT_DECISIONS)[number];
export const CheckpointDecisionSchema = StringEnum([...CHECKPOINT_DECISIONS]);

/**
 * Which authorization a checkpoint file holds. One job may need more than one,
 * and they are different questions asked at different moments, so they are
 * different files: `decide()` refuses to overwrite an answer, and two questions
 * sharing one record would make the second unanswerable.
 *
 *  - `ship` — the pre-implementation one (the pipeline's): "act on this plan?"
 *  - `diff` — the post-implementation one a flagged diff review raises
 *    (cp-khf): "accept the diff that was pushed?"
 *  - `merge` — cp-uug: authorization to merge one PR, at one head sha. It is
 *    the only kind that carries a `scope`, and it carries one for a reason:
 *    an approval names the commit it approved, so a force-push after the
 *    answer cannot inherit it.
 *
 *  - `final_fix` — pi-command-post-epic-pr-a-jje.3: one operator-approved fix
 *    after the fifth review, scoped to the capped head like `merge`
 *    (`src/final-fix.ts`). Only a human answers it; a mandate never can.
 *
 * They are decisions about one `job_id`, never one decision asked three times,
 * which is why they live in separate files and carry separate Awaiting-you
 * identities.
 */
export const CHECKPOINT_KINDS = ["ship", "diff", "merge", "final_fix"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];
export const CheckpointKindSchema = StringEnum([...CHECKPOINT_KINDS]);

/** A checkpoint scope: a head sha, lower-case hex, 7–40 chars. */
export const CHECKPOINT_SCOPE_PATTERN = "^[0-9a-f]{7,40}$";
const CHECKPOINT_SCOPE_RE = new RegExp(CHECKPOINT_SCOPE_PATTERN);
export const CheckpointScopeSchema = Type.String({ pattern: CHECKPOINT_SCOPE_PATTERN });

/**
 * state/checkpoints/<ship-id>.json — a journaled human authorization.
 *
 * Ported rule: **evidence is not authorization.** A passed gate says the plan
 * is good; it never says "ship it". The record is written `pending` *before*
 * anyone is asked, so a crash mid-question can never look like a yes.
 *
 * There is deliberately **no standing, session-scoped or blanket form** of this
 * record (cp-uug): every authorization names one job, and a merge authorization
 * additionally names one commit. Bounded standing authority lives in the mandate
 * store (`state/mandates/`) and, when it permits, calls `decide()` with
 * `decided_by: mandate:<id>` — that is still one named job, never "always allow".
 * `cp_decide` stores the cited basis beside the decision.
 */
export const DELEGATION_RULE_MAX = 300;
export const DelegationRuleSchema = Type.String({ minLength: 1, maxLength: DELEGATION_RULE_MAX });
export const DelegationProvenanceFields = {
	delegation_rule: Type.Optional(DelegationRuleSchema),
	send_id: Type.Optional(Type.String({ pattern: "^ps-[0-9]{14}-[0-9a-f]{8}$" })),
};
export interface DelegationProvenance { delegation_rule: string; send_id: string }

export const DecisionBasisSchema = Type.Union([
	Type.Object(
		{
			mandate: Type.String({ pattern: "^md-[a-z0-9]{4,16}$" }),
			clause: Type.String({ minLength: 1, maxLength: 400 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operator_quote: Type.String({ minLength: 1, maxLength: 4000 }),
		},
		{ additionalProperties: false },
	),
]);
export type DecisionBasis = Static<typeof DecisionBasisSchema>;

export const CheckpointSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		/** The job this authorizes — the ship job. */
		job_id: JobIdSchema,
		/**
		 * Which authorization this is. Absent means `ship`, so every checkpoint
		 * written before this field existed still validates and still reads as the
		 * pre-implementation one it was.
		 */
		kind: Type.Optional(CheckpointKindSchema),
		/** `merge` only: the head sha this authorization is bound to. */
		scope: Type.Optional(CheckpointScopeSchema),
		/** `final_fix` only: the PR this authorization is bound to (jje.3). */
		pr_url: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
		research_id: Type.Optional(JobIdSchema),
		question: Type.String({ minLength: 1, maxLength: 1000 }),
		/** Headline evidence only. Never an artifact body. */
		evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 20 })),
		requested_at: IsoTimestampSchema,
		decision: CheckpointDecisionSchema,
		decided_at: Type.Optional(IsoTimestampSchema),
		/** Who answered: `mandate:<id>`, `operator-quote` or `operator-delegated`. */
		decided_by: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
		...DelegationProvenanceFields,
		note: Type.Optional(Type.String({ maxLength: 1000 })),
		basis: Type.Optional(DecisionBasisSchema),
	},
	{ additionalProperties: false },
);
export type Checkpoint = Replace<
	Static<typeof CheckpointSchema>,
	{ decision: CheckpointDecision; kind?: CheckpointKind }
>;

// ---------------------------------------------------------------------------
// Escalation — one schema for "ask the human" (autonomy-programme-cur.2.3)
// ---------------------------------------------------------------------------

/** The synthetic job anchor of a `service_health` escalation (the schema needs one job id); no such job exists. */
export const SERVICE_HEALTH_JOB_ID = "cp-service-health";

export const ESCALATION_ID_PATTERN = "^es-[a-z0-9]{4,16}$";
const ESCALATION_ID_RE = new RegExp(ESCALATION_ID_PATTERN);
export const EscalationIdSchema = Type.String({ pattern: ESCALATION_ID_PATTERN });
export function isSafeEscalationId(value: string): boolean {
	return ESCALATION_ID_RE.test(value);
}

export const ESCALATION_KINDS = [
	"product_ambiguity",
	"scope_expansion",
	"risk_high_irreversible",
	"loop_exhausted",
	"budget_exhausted",
	"conflicting_acceptance",
	"merge_refused",
	"mission_end",
	"plan_approval",
	"service_health",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];
export const EscalationKindSchema = StringEnum([...ESCALATION_KINDS]);

export const ESCALATION_STATUSES = ["open", "answered", "withdrawn", "superseded"] as const; // superseded: its mandate was revoked, expired or replaced (MandateStore.supersedeEscalations)
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];
export const EscalationStatusSchema = StringEnum([...ESCALATION_STATUSES]);

/** Mandate field when no grant covers the decision. */
export const ESCALATION_NO_MANDATE = "no mandate";

export const ESCALATION_QUESTION_MAX_CHARS = 1000;
export const ESCALATION_OPTION_MAX_CHARS = 200;
export const ESCALATION_MAX_OPTIONS = 6;
export const ESCALATION_MAX_EVIDENCE = 20;
export const ESCALATION_MESSAGE_TYPE = "cp-escalation";

/**
 * Every operator-facing "ask" surface and the kind it raises.
 * AGENTS.md may only name an ask that appears here; docs/contracts.md restates it.
 */
export const ESCALATION_KIND_SURFACES = [
	{ kind: "product_ambiguity", surface: "product ambiguity", agents: "product ambiguity" },
	{ kind: "scope_expansion", surface: "scope expansion", agents: "scope expansion" },
	{ kind: "risk_high_irreversible", surface: "risk high/irreversible", agents: "risk:high" },
	{ kind: "loop_exhausted", surface: "loop exhausted / 5th review / operational_persistent", agents: "loop exhausted" },
	{ kind: "budget_exhausted", surface: "budget breach / mandate cap", agents: "budget exhausted" },
	{ kind: "conflicting_acceptance", surface: "gate escalate/policy", agents: "escalate / `policy`" },
	{ kind: "merge_refused", surface: "integrate surface / repo refuses merge", agents: "merge refused" },
	{ kind: "mission_end", surface: "mission end", agents: "mission end" },
	{ kind: "plan_approval", surface: "plan approval", agents: "plan approval" },
	{ kind: "service_health", surface: "service health (cp-health failing / rollback_failed)", agents: "service health" },
] as const satisfies readonly { kind: EscalationKind; surface: string; agents: string }[];

export const EscalationOptionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 40 }),
		label: Type.String({ minLength: 1, maxLength: ESCALATION_OPTION_MAX_CHARS }),
		consequence: Type.String({ minLength: 1, maxLength: ESCALATION_OPTION_MAX_CHARS }),
		cost: Type.String({ minLength: 1, maxLength: ESCALATION_OPTION_MAX_CHARS }),
	},
	{ additionalProperties: false },
);
export type EscalationOption = Static<typeof EscalationOptionSchema>;

export const EscalationSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		id: EscalationIdSchema,
		job_ids: Type.Array(JobIdSchema, { minItems: 1, maxItems: 16 }),
		kind: EscalationKindSchema,
		question: Type.String({ minLength: 1, maxLength: ESCALATION_QUESTION_MAX_CHARS }),
		options: Type.Array(EscalationOptionSchema, { minItems: 1, maxItems: ESCALATION_MAX_OPTIONS }),
		recommended: Type.String({ minLength: 1, maxLength: 40 }),
		mandate_id: Type.String({ minLength: 1, maxLength: 40 }),
		mandate_clause: Type.String({ minLength: 1, maxLength: 400 }),
		evidence_paths: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: ESCALATION_MAX_EVIDENCE }),
		/** Exact verified br refs whose deferred status an override may admit (picp-t4n). */
		deferred_refs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000, pattern: "^[^\\r\\n]+$" }))),
		created_at: IsoTimestampSchema,
		status: EscalationStatusSchema,
		answer: Type.Optional(Type.String({ maxLength: 1000 })),
		answered_by: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
		...DelegationProvenanceFields,
		basis: Type.Optional(DecisionBasisSchema),
		answered_at: Type.Optional(IsoTimestampSchema),
		superseded_at: Type.Optional(IsoTimestampSchema),
		superseded_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
		/** Dropped-dependency decision; ordered pair, independent of covering grant. */
		dropped_dependency: Type.Optional(Type.Object({ job_id: JobIdSchema, blocker_id: JobIdSchema }, { additionalProperties: false })),
		checkpoint_job_id: Type.Optional(JobIdSchema),
		checkpoint_kind: Type.Optional(CheckpointKindSchema),
		checkpoint_scope: Type.Optional(CheckpointScopeSchema),
		awaiting_id: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
		plan_summary: Type.Optional(PlanSummarySchema),
		decision_summary: Type.Optional(DecisionSummarySchema),
		/** Full pre-trim escalation text when schema-capped fields were normalized at intake. */
		original_text: Type.Optional(Type.Object({
			question: Type.Optional(Type.String()),
			options: Type.Optional(Type.Array(Type.Object({
				id: Type.String(),
				label: Type.String(),
				consequence: Type.String(),
				cost: Type.String(),
			}, { additionalProperties: false }), { maxItems: ESCALATION_MAX_OPTIONS })),
		}, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
export type Escalation = Replace<
	Static<typeof EscalationSchema>,
	{ kind: EscalationKind; status: EscalationStatus; options: EscalationOption[]; checkpoint_kind?: CheckpointKind }
>;

export const EscalationFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		items: Type.Array(EscalationSchema),
	},
	{ additionalProperties: false },
);
export type EscalationFile = Narrow<Static<typeof EscalationFileSchema>, "items", Escalation[]>;

export const EMPTY_ESCALATION_FILE: EscalationFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	items: [],
};

export function validateEscalation(value: unknown): ValidationResult<Escalation> {
	return validate<Escalation>(EscalationSchema, value);
}
export function validateEscalationFile(value: unknown): ValidationResult<EscalationFile> {
	return validate<EscalationFile>(EscalationFileSchema, value);
}

/**
 * The Awaiting-you row id for one checkpoint (cp-khf; extended by cp-uug). The
 * one definition, so the id in the menu, the id `/cp-decide` answers, the id
 * `/cp-authorize` accepts and the id the answered wake-up carries are the same
 * string.
 *
 * The suffix mirrors the file name (`<id>.diff.json`,
 * `<id>.merge-<head12>.json`) and is safe for the very reason those names are:
 * a job id can never contain a `.` (`JOB_ID_PATTERN`), so `aw-checkpoint-<id>.diff`
 * cannot collide with the ship row of a differently-named job. A `-diff-` infix
 * could: `diff-x` is a legal job id.
 *
 * A merge id additionally carries the head sha it authorizes, because a job may
 * have more than one merge authorization over its life (a force-push voids the
 * previous one) and two rows sharing an id would make one of them unanswerable.
 */
export function checkpointAwaitingId(jobId: string, kind: CheckpointKind = "ship", scope?: string): string {
	if (kind === "diff") return `aw-checkpoint-${jobId}.diff`;
	if (kind === "merge") return `aw-checkpoint-${jobId}.merge-${(scope ?? "unscoped").slice(0, 40)}`;
	if (kind === "final_fix") return `aw-checkpoint-${jobId}.final-fix-${(scope ?? "unscoped").slice(0, 40)}`;
	return `aw-checkpoint-${jobId}`;
}

/** The inverse of `checkpointAwaitingId`, or undefined for any other id. */
export function parseCheckpointAwaitingId(
	id: string,
): { job_id: string; kind: CheckpointKind; scope?: string } | undefined {
	const prefix = "aw-checkpoint-";
	if (!id.startsWith(prefix)) return undefined;
	const rest = id.slice(prefix.length);
	const dot = rest.indexOf(".");
	const jobId = dot === -1 ? rest : rest.slice(0, dot);
	if (!JOB_ID_RE.test(jobId)) return undefined;
	if (dot === -1) return { job_id: jobId, kind: "ship" };
	const suffix = rest.slice(dot + 1);
	if (suffix === "diff") return { job_id: jobId, kind: "diff" };
	if (suffix.startsWith("merge-")) {
		const scope = suffix.slice("merge-".length);
		if (!CHECKPOINT_SCOPE_RE.test(scope)) return undefined;
		return { job_id: jobId, kind: "merge", scope };
	}
	if (suffix.startsWith("final-fix-")) {
		const scope = suffix.slice("final-fix-".length);
		return CHECKPOINT_SCOPE_RE.test(scope) ? { job_id: jobId, kind: "final_fix", scope } : undefined;
	}
	return undefined;
}
