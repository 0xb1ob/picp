/** Mandates — operator-issued bounded authority and its home defaults. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, type JobKind, JobKindSchema, PROJECT_NAME_PATTERN } from "./core.ts";
import { type CheckpointKind, CheckpointKindSchema, DelegationProvenanceFields } from "./escalations.ts";
import type { Replace } from "./internal.ts";
import { ReviewerModelSchema } from "./routing.ts";

// ---------------------------------------------------------------------------
// Mandate — operator-issued bounded authority (autonomy-programme-cur.2.1)
// ---------------------------------------------------------------------------

export const MANDATE_ID_PATTERN = "^md-[a-z0-9]{4,16}$";
const MANDATE_ID_RE = new RegExp(MANDATE_ID_PATTERN);
export const MandateIdSchema = Type.String({ pattern: MANDATE_ID_PATTERN });
export function isSafeMandateId(value: string): boolean {
	return MANDATE_ID_RE.test(value);
}

export const MANDATE_STATUSES = ["active", "paused", "revoked", "expired"] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];
export const MandateStatusSchema = StringEnum([...MANDATE_STATUSES]);

export const MANDATE_CHANNELS = ["operator_chat", "bridge"] as const;
export type MandateChannel = (typeof MANDATE_CHANNELS)[number];
export const MandateChannelSchema = StringEnum([...MANDATE_CHANNELS]);

export const MANDATE_ACTIONS = ["plan", "implement", "review", "repair", "merge"] as const;
export type MandateAction = (typeof MANDATE_ACTIONS)[number];
export const MandateActionSchema = StringEnum([...MANDATE_ACTIONS]);

export const MANDATE_ASK_ON = ["plan_approval", "merge", "risk:high"] as const;
export type MandateAskOn = (typeof MANDATE_ASK_ON)[number];
export const MandateAskOnSchema = StringEnum([...MANDATE_ASK_ON]);

/**
 * Mandate defaults (autonomy-programme-cur.2.5): the fields `cp_mandate issue`
 * resolves through the home -> project -> explicit ladder instead of asking a
 * human to name them. Keyed by the `data/mandate-defaults.json` / project
 * `mandate` override field name, not the stored `Mandate` field name (e.g.
 * `expiry_hours` resolves into `expiry`, `exclude_paths` into
 * `exclusions.paths`).
 */
export const MANDATE_DEFAULTABLE_FIELDS = [
	"expiry_hours",
	"spend_usd",
	"spend_tokens",
	"job_cap",
	"dispatch_parallelism",
	"allowed_actions",
	"ask_on",
	"exclude_paths",
] as const;
export type MandateDefaultableField = (typeof MANDATE_DEFAULTABLE_FIELDS)[number];

export const MANDATE_FIELD_SOURCES = ["explicit", "project", "home"] as const;
export type MandateFieldSource = (typeof MANDATE_FIELD_SOURCES)[number];
export const MandateFieldSourceSchema = StringEnum([...MANDATE_FIELD_SOURCES]);
export type MandateProvenance = Partial<Record<MandateDefaultableField, MandateFieldSource>>;

export const MandateDecisionRecordSchema = Type.Object(
	{
		at: IsoTimestampSchema,
		job_id: JobIdSchema,
		kind: CheckpointKindSchema,
		clause: Type.String({ minLength: 1, maxLength: 400 }),
		checkpoint: Type.String({ minLength: 1, maxLength: 200 }),
	},
	{ additionalProperties: false },
);
export type MandateDecisionRecord = Replace<
	Static<typeof MandateDecisionRecordSchema>,
	{ kind: CheckpointKind }
>;

export const MandateEscalationSchema = Type.Object(
	{
		at: IsoTimestampSchema,
		kind: Type.String({ minLength: 1, maxLength: 40 }),
		reason: Type.String({ minLength: 1, maxLength: 400 }),
	},
	{ additionalProperties: false },
);
export type MandateEscalation = Static<typeof MandateEscalationSchema>;

/**
 * Operator pre-approval of risk:high on a grant (unload-parent PR0, `src/risk-preapproval.ts`): one verified,
 * verbatim operator quote that lets a covered job's risk:high dispatch or promotion pass `ask_on: risk:high`
 * without a per-job escalation. Dispatch and promotion only — never a merge, a checkpoint or a script dispatch.
 * `named_jobs` covers `job_ids` only; `mandate_jobs` covers the grant's own `job_ids` and jobs created at or
 * after its `issued_at` in its projects.
 */
export const RISK_PREAPPROVAL_SCOPES = ["named_jobs", "mandate_jobs"] as const;
export type RiskPreapprovalScope = (typeof RISK_PREAPPROVAL_SCOPES)[number];
export const RiskPreapprovalSchema = Type.Object(
	{
		operator_quote: Type.String({ minLength: 1, maxLength: 4000 }),
		decided_by: StringEnum(["operator-quote", "operator-delegated"]),
		...DelegationProvenanceFields,
		job_ids: Type.Optional(Type.Array(JobIdSchema, { minItems: 1, maxItems: 64 })),
		scope: StringEnum([...RISK_PREAPPROVAL_SCOPES]),
		granted_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type RiskPreapproval = Replace<Static<typeof RiskPreapprovalSchema>, { decided_by: "operator-quote" | "operator-delegated"; scope: RiskPreapprovalScope }>;

export const RISK_PREAPPROVED_USES = ["dispatch", "promote"] as const;
export type RiskPreapprovedUse = (typeof RISK_PREAPPROVED_USES)[number];
/** One audit row per risk:high gate a pre-approval passed. `quote_sha` is the first 12 hex of sha256(quote), never the quote. */
export const RiskPreapprovedRowSchema = Type.Object(
	{
		at: IsoTimestampSchema,
		job_id: JobIdSchema,
		use: StringEnum([...RISK_PREAPPROVED_USES]),
		decided_by: Type.Literal("operator-delegated"),
		quote_sha: Type.String({ pattern: "^[0-9a-f]{12}$" }),
		evidence: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 8 }),
	},
	{ additionalProperties: false },
);
export type RiskPreapprovedRow = Replace<Static<typeof RiskPreapprovedRowSchema>, { use: RiskPreapprovedUse }>;

const SCHEDULE_ID_PATTERN = "^sch-[0-9a-f]{6}$";
const QuoteDecidedBySchema = StringEnum(["operator-quote", "operator-delegated"]);
/**
 * A schedule's fire grant (one per fire, every trigger): which schedule minted it in its fire lane, from which seed
 * grant's saved template, the template's approval verbatim, and the trigger of this fire (a cron slot, a watch
 * observation, the dashboard click or the run_now quote). Written only by `Scheduler` through `MandateStore.issue`;
 * `cp_mandate` never accepts it.
 */
export const ScheduleFireSchema = Type.Object(
	{
		schedule_id: Type.String({ pattern: SCHEDULE_ID_PATTERN }),
		seed_mandate_id: MandateIdSchema,
		previous_mandate_id: Type.Optional(MandateIdSchema),
		fired_at: IsoTimestampSchema,
		approval: Type.Object(
			{ operator_quote: Type.String({ minLength: 1, maxLength: 4000 }), decided_by: QuoteDecidedBySchema, approved_at: IsoTimestampSchema, ...DelegationProvenanceFields },
			{ additionalProperties: false },
		),
		trigger: Type.Union([
			Type.Object({ via: Type.Literal("cron"), slot: IsoTimestampSchema, missed: Type.Boolean() }, { additionalProperties: false }),
			Type.Object({ via: Type.Literal("watch"), at: IsoTimestampSchema, output_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })) }, { additionalProperties: false }),
			Type.Object({ via: Type.Literal("dashboard"), request_id: Type.String({ minLength: 1, maxLength: 200 }), peer: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]) }, { additionalProperties: false }),
			Type.Object(
				{ via: Type.Literal("cp_schedule"), operator_quote: Type.String({ minLength: 1, maxLength: 4000 }), decided_by: QuoteDecidedBySchema, source_sha: Type.String({ pattern: "^[0-9a-f]{12}$" }), ...DelegationProvenanceFields },
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);
type QuoteDecidedBy = "operator-quote" | "operator-delegated";
export type MandateRevokedBy =
	| { by: "operator"; operator_quote: string; decided_by: QuoteDecidedBy; delegation_rule?: string; send_id?: string }
	| { by: "parent" | "system" };
export interface ScheduleFire {
	schedule_id: string;
	seed_mandate_id: string;
	previous_mandate_id?: string;
	fired_at: string;
	approval: { operator_quote: string; decided_by: QuoteDecidedBy; approved_at: string; delegation_rule?: string; send_id?: string };
	trigger:
		| { via: "cron"; slot: string; missed: boolean }
		| { via: "watch"; at: string; output_sha?: string }
		| { via: "dashboard"; request_id: string; peer: string | null }
		| { via: "cp_schedule"; operator_quote: string; decided_by: QuoteDecidedBy; source_sha: string; delegation_rule?: string; send_id?: string };
}

export const MandateSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		id: MandateIdSchema,
		issued_by: Type.Object({ channel: MandateChannelSchema }, { additionalProperties: false }),
		issued_at: IsoTimestampSchema,
		expiry: IsoTimestampSchema,
		projects: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 32 }),
		objective: Type.String({ minLength: 1, maxLength: 2000 }),
		reviewer_model: Type.Optional(ReviewerModelSchema),
		job_ids: Type.Optional(Type.Array(JobIdSchema, { maxItems: 64 })),
		/** A schedule-only grant (schedlater S3): covers only the jobs of the one schedule naming it; a grant without it covers no scheduled job. */
		schedule_grant: Type.Optional(Type.Literal(true)),
		allowed_actions: Type.Array(MandateActionSchema, { minItems: 1, maxItems: 8 }),
		dispatch_parallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
		exclusions: Type.Optional(
			Type.Object(
				{
					paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32 })),
					subsystems: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 32 })),
					job_kinds: Type.Optional(Type.Array(JobKindSchema, { maxItems: 4 })),
				},
				{ additionalProperties: false },
			),
		),
		/** `tokens` counts non-cached tokens only (`mandateTokens`, src/mandate.ts). */
		spend_cap: Type.Object({ usd: Type.Number({ minimum: 0 }), tokens: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
		job_cap: Type.Integer({ minimum: 1 }),
		ask_on: Type.Array(MandateAskOnSchema, { maxItems: 16 }),
		status: MandateStatusSchema,
		paused_at: Type.Optional(IsoTimestampSchema),
		revoked_at: Type.Optional(IsoTimestampSchema),
		/**
		 * Who revoked: `operator` (`cp_mandate revoke` with a verified operator_quote), `parent` (`cp_mandate revoke`
		 * without one) or `system` (mission end, a decision, the scheduler retiring a pointer no schedule names). Absent on
		 * a legacy revoke (before it was recorded). A schedule re-mints past only a `parent` or `system` revoke (`operatorStop`).
		 */
		revoked_by: Type.Optional(
			Type.Union([
				Type.Object(
					{ by: Type.Literal("operator"), operator_quote: Type.String({ minLength: 1, maxLength: 4000 }), decided_by: QuoteDecidedBySchema, ...DelegationProvenanceFields },
					{ additionalProperties: false },
				),
				Type.Object({ by: StringEnum(["parent", "system"]) }, { additionalProperties: false }),
			]),
		),
		pause_reason: Type.Optional(Type.String({ maxLength: 400 })),
		decisions: Type.Array(MandateDecisionRecordSchema, { maxItems: 500 }),
		escalations: Type.Array(MandateEscalationSchema, { maxItems: 32 }),
		/** Parent-side token-cap raises (`cp_mandate raise_tokens`), each journaled with its reason; the USD cap has no such path. */
		token_raises: Type.Optional(Type.Array(Type.Object({ at: IsoTimestampSchema, from: Type.Integer({ minimum: 0 }), to: Type.Integer({ minimum: 0 }), reason: Type.String({ minLength: 1, maxLength: 400 }) }, { additionalProperties: false }), { maxItems: 64 })),
		/** Operator risk:high pre-approval (`cp_mandate preapprove_risk`) and its audit rows, newest 500 kept. Optional: older grants validate. */
		risk_preapproval: Type.Optional(RiskPreapprovalSchema),
		risk_preapproved: Type.Optional(Type.Array(RiskPreapprovedRowSchema, { maxItems: 500 })),
		/** Each covered fleet job's usage at issue (`usageBaseline`, src/mandate-accounting.ts): the grant counts only what
		 * accrues past it. Absent on grants issued before it existed, which count lifetime usage. */
		usage_baseline: Type.Optional(
			Type.Array(
				Type.Object(
					{
						job_id: JobIdSchema,
						usd: Type.Number({ minimum: 0 }),
						tokens: Type.Integer({ minimum: 0 }),
						reviewer_usd: Type.Optional(Type.Number({ minimum: 0 })),
						reviewer_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
					},
					{ additionalProperties: false },
				),
			),
		),
		/** Which of `explicit` (the `cp_mandate issue` call), `project` (data/projects.json's `mandate`
		 * override) or `home` (data/mandate-defaults.json) each defaultable field came from (cur.2.5). */
		provenance: Type.Optional(
			Type.Object(
				Object.fromEntries(MANDATE_DEFAULTABLE_FIELDS.map((field) => [field, Type.Optional(MandateFieldSourceSchema)])),
				{ additionalProperties: false },
			),
		),
		/** A schedule's fire grant (one per fire): its schedule, seed, approval and trigger. Absent on every other grant. */
		schedule_fire: Type.Optional(ScheduleFireSchema),
	},
	{ additionalProperties: false },
);
export type Mandate = Replace<
	Static<typeof MandateSchema>,
	{
		issued_by: { channel: MandateChannel };
		allowed_actions: MandateAction[];
		ask_on: MandateAskOn[];
		status: MandateStatus;
		decisions: MandateDecisionRecord[];
		exclusions?: { paths?: string[]; subsystems?: string[]; job_kinds?: JobKind[] };
		provenance?: MandateProvenance;
		risk_preapproval?: RiskPreapproval;
		risk_preapproved?: RiskPreapprovedRow[];
		schedule_fire?: ScheduleFire;
		revoked_by?: MandateRevokedBy;
	}
>;

/**
 * File-only machine grant policy in `data/mandate-defaults.json` (cp-7re9):
 * `scope_policy` (named-only grants) and `deny_projects`. Hand-edited, never
 * settable through `cp_mandate defaults_set` or the Settings catalog; absent
 * keys keep today's behaviour.
 */
export const GRANT_SCOPE_POLICIES = ["project_wide_allowed", "named_jobs_only"] as const;
export type GrantScopePolicy = (typeof GRANT_SCOPE_POLICIES)[number];
export const MandatePolicySchema = Type.Object(
	{
		scope_policy: Type.Optional(StringEnum([...GRANT_SCOPE_POLICIES])),
		deny_projects: Type.Optional(Type.Array(Type.String({ pattern: PROJECT_NAME_PATTERN }), { maxItems: 64 })),
	},
	{ additionalProperties: false },
);

/**
 * `data/mandate-defaults.json` (autonomy-programme-cur.2.5): the home-level
 * knobs `cp_mandate issue` falls back to when the operator names only a
 * project and an objective. Scaffolded once with conservative values
 * (`src/mandate-defaults.ts`); an existing file is never rewritten.
 */
export const MandateDefaultsSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		expiry_hours: Type.Number({ minimum: 0.1, maximum: 24 * 30 }),
		spend_usd: Type.Number({ minimum: 0 }),
		spend_tokens: Type.Integer({ minimum: 0 }),
		token_ceiling: Type.Optional(Type.Integer({ minimum: 0 })), // the parent's own raise_tokens bound; absent = 100M
		job_cap: Type.Integer({ minimum: 1 }),
		dispatch_parallelism: Type.Integer({ minimum: 1, maximum: 32 }),
		allowed_actions: Type.Array(MandateActionSchema, { minItems: 1, maxItems: 8 }),
		ask_on: Type.Array(MandateAskOnSchema, { maxItems: 16 }),
		exclude_paths: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32 }),
		/** One line per field above, explaining why it defaults the way it does \u2014 the comment JSON has no room for. */
		notes: Type.Record(Type.String(), Type.String({ maxLength: 400 })),
		...MandatePolicySchema.properties,
	},
	{ additionalProperties: false },
);
export type MandateDefaults = Replace<
	Static<typeof MandateDefaultsSchema>,
	{ allowed_actions: MandateAction[]; ask_on: MandateAskOn[]; scope_policy?: GrantScopePolicy }
>;
