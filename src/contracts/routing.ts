/** Routing: the scope/risk/thinking axes, a job's recorded routing and data/routing.json. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { type Role, RoleSchema } from "./core.ts";
import type { Narrow, Replace } from "./internal.ts";

/** Reviewer preferences enter the existing override tier; they add no routing pins. */
export const ReviewerModelSchema = Type.String({ minLength: 3, maxLength: 128, pattern: "^[^\\s/]+/[^\\s]+$" });
/**
 * Effort level, the model's and the rubric row's (T13/cp-eff). Defined here,
 * ahead of `FleetRecordSchema`/`StatusJobSchema`, because both need it for the
 * scope/risk/thinking a job was routed with (cp-status-scope-risk); it used to
 * live down with the profile frontmatter, which is still where it is used most.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const ThinkingLevelSchema = StringEnum([...THINKING_LEVELS]);

/**
 * Routing rubric inputs (T13/cp-rte). Defined here for the same reason as
 * `ThinkingLevel` above — `JobRoutingSchema` needs them before the routing
 * section proper introduces the rubric that matches on them.
 */
export const SCOPES = ["S", "M", "L"] as const;
export type Scope = (typeof SCOPES)[number];
export const ScopeSchema = StringEnum([...SCOPES]);

export const RISKS = ["low", "high"] as const;
export type Risk = (typeof RISKS)[number];
export const RiskSchema = StringEnum([...RISKS]);

/**
 * What the two enums above *mean*, in the words the parent reads (routing T6).
 *
 * The parent used to be handed bare enums: `scope: S|M|L`, `risk: low|high`,
 * with the criteria nowhere near the call. So these live here, beside the
 * enums, and the tool parameters that accept them use them verbatim as their
 * description — one text, whether it is read in a tool schema, in AGENTS.md or
 * in docs/contracts.md.
 *
 * Both say the same two things about *not* answering: an axis you do not know
 * stays absent (`resolveRoutingInputs` then assesses it from the task's own
 * words and records `inferred`/`defaulted` — inventing `S`/`low` to satisfy a
 * schema is the one input that cannot be distinguished from a measurement),
 * and naming one axis never silences the other.
 */
export const SCOPE_CRITERIA =
	"How much work this is. S = a bounded, known change. M = cross-component work or substantial investigation. " +
	"L = explicitly broad or deep multi-stage work. Scope is not a file count: a one-file concurrency fix can be M. " +
	"Leave it absent when you do not know — an absent axis is assessed from the task's own words and recorded as " +
	"inferred or defaulted, and naming one axis never silences the other. Use planner evidence for sizing that " +
	"depends on the repository.";

export const RISK_CRITERIA =
	"What a mistake costs. high = security or auth, credentials, money, production, or destructive and irreversible " +
	"operations. low = work a rerun undoes. Uncertainty is not impact: it is separately recorded evidence for " +
	"stronger resources, so leave risk absent rather than raising it because you are unsure. Leave it absent when " +
	"you do not know, and never lower a known-high impact.";

/**
 * Where ONE routing axis (scope or risk) actually came from (cp-routing-provenance).
 *
 * Per field, never per decision: a caller who names only `scope` still gets
 * `risk` assessed from the job's own words, and calling that whole decision
 * "inferred" mislabels the axis the caller did name. The four values are the
 * only four ways an axis can be decided:
 *
 *  - `explicit`   — the caller named this axis on the dispatch call
 *  - `assessed`   — a planner's own `self_assessment` named it (cp-rte)
 *  - `inferred`   — `inferScopeAndRisk` found a signal for it in the task text
 *  - `defaulted`  — nothing named it and nothing was found, so routing's
 *                   standing default (`S` / `low`) was used
 */
export const ROUTING_PROVENANCE = ["explicit", "assessed", "inferred", "defaulted"] as const;
export type RoutingProvenance = (typeof ROUTING_PROVENANCE)[number];
export const RoutingProvenanceSchema = StringEnum([...ROUTING_PROVENANCE]);

/**
 * The scope/risk/thinking that decided a job's model, captured once at
 * dispatch time (cp-status-scope-risk). This is the ONLY place that decision
 * is recorded: `/status` and the status block read it back rather than
 * re-inferring it, so a rendered value can never drift from what actually
 * routed the job.
 *
 * `scope`/`risk` are the values routing was ACTUALLY given — including the
 * standing `S`/`low` defaults, which used to be substituted invisibly inside
 * `pickModel` and recorded nowhere. `provenance` says where each of them came
 * from, per axis (cp-routing-provenance), and `reasons` carries the bounded
 * keyword evidence for the axes that were inferred.
 *
 * `inferred` is the legacy one-bit summary: true when *any* axis came from
 * `inferScopeAndRisk`. It stays required so every record written before
 * `provenance` existed keeps validating and keeps rendering; a reader that has
 * `provenance` should prefer it, because one inferred axis must never relabel
 * an explicit one. A job dispatched before any of this existed carries no
 * `routing` at all: render that as unknown, never as a guessed default (the
 * exact bug cp-rte fixed for routing itself).
 */
export const JobRoutingSchema = Type.Object(
	{
		scope: Type.Optional(ScopeSchema),
		risk: Type.Optional(RiskSchema),
		thinking: Type.Optional(ThinkingLevelSchema),
		inferred: Type.Boolean(),
		/**
		 * Present or absent as a whole, never half-written: both axes are REQUIRED
		 * inside it. A partial object would be the same ambiguity this field exists
		 * to remove — a reader would have to fall back to the one-bit `inferred`
		 * flag for the missing axis, which is exactly how an explicit axis got
		 * relabelled inferred. Legacy records stay readable because the *object* is
		 * optional, not because its halves are.
		 */
		provenance: Type.Optional(
			Type.Object(
				{ scope: RoutingProvenanceSchema, risk: RoutingProvenanceSchema },
				{ additionalProperties: false },
			),
		),
		/** Why an axis was inferred, verbatim from `inferScopeAndRisk`. Bounded. */
		reasons: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 4 })),
		/** H6: a risk a planner recorded that routing was not given (src/risk-warning.ts); only the risk:high gate reads it. */
		recorded_risk: Type.Optional(RiskSchema),
	},
	{ additionalProperties: false },
);
export type JobRouting = Replace<
	Static<typeof JobRoutingSchema>,
	{
		scope?: Scope;
		risk?: Risk;
		thinking?: ThinkingLevel;
		provenance?: { scope: RoutingProvenance; risk: RoutingProvenance };
	}
>;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Routing (T13) — data/routing.json
// ---------------------------------------------------------------------------

export const ROUTING_SOURCES = ["override", "rubric", "profile"] as const;
export type RoutingSource = (typeof ROUTING_SOURCES)[number];
export const RoutingSourceSchema = StringEnum([...ROUTING_SOURCES]);

// `Scope`/`SCOPES` and `Risk`/`RISKS` moved up next to the other primitives
// (see the comment by `OriginSchema`) so `JobRoutingSchema` could use them too.

/**
 * One routing rule. **The only policy surface** (cp-cxt): pins were removed
 * because two mechanisms decided one thing, and the identity-based one silently
 * short-circuited the size-based one.
 *
 * `role` is required; `project`, `scope` and `risk` narrow it. Absent keys match
 * anything, so a row with only a role is the broad default and a row with a
 * project is per-repo policy. First matching row wins, so order narrow-to-broad.
 *
 * The one-off escape hatch is the caller's explicit `override` (resolution step
 * 1), which is where a single job's exception belongs: in the dispatch that
 * needs it, not in a config file nobody prunes.
 */
export const RoutingRuleSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64 }),
		role: RoleSchema,
		/** Registered project name; absent means every project. */
		project: Type.Optional(Type.String({ minLength: 1 })),
		scope: Type.Optional(Type.Array(ScopeSchema, { maxItems: 3 })),
		risk: Type.Optional(RiskSchema),
		model: Type.String({ minLength: 1 }),
		/**
		 * Effort for jobs this row matches; falls back to the profile's level when
		 * absent. Model and effort are one decision, so they live in one row.
		 *
		 * pi maps the level to whatever the provider supports (extended-thinking
		 * budgets on Claude Haiku 4.5, adaptive effort on the opus/sonnet/fable
		 * line), and a level on a non-reasoning model is inert, not an error — which
		 * is why this is not validated against a model table that would rot the day a
		 * model ships. It IS checked against pi's own live metadata for the resolved
		 * model at resolution time (cp-reviewer-routing): a level that model reports
		 * it cannot serve is refused before the spawn, exactly as an explicitly
		 * requested one is. Absent metadata is ignorance, never a refusal.
		 */
		thinking: Type.Optional(ThinkingLevelSchema),
		/**
		 * Ordered candidates tried after `model`, in file order
		 * (pi-command-post-0a9). Resolution walks `[model, ...fallbacks]` and takes
		 * the first candidate that passes the allowlist, the availability probe and
		 * the effort check. The effort is the row's either way: a fallback never
		 * substitutes a level, it is skipped when it cannot serve the one in force.
		 */
		fallbacks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 4 })),
		note: Type.Optional(Type.String({ maxLength: 300 })),
	},
	{ additionalProperties: false },
);
export type RoutingRule = Replace<
	Static<typeof RoutingRuleSchema>,
	{ role: Role; scope?: Scope[]; risk?: Risk; thinking?: ThinkingLevel; fallbacks?: string[] }
>;

export const RoutingConfigSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		/** minimatch patterns on `provider/model-id`; empty = allow nothing. */
		allow: Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 }),
		rubric: Type.Array(RoutingRuleSchema, { maxItems: 64 }),
	},
	{ additionalProperties: false },
);
export type RoutingConfig = Replace<Static<typeof RoutingConfigSchema>, { rubric: RoutingRule[] }>;

/** What dispatch prints and stores: source=/model=/rule=. */
export const RoutingDecisionSchema = Type.Object(
	{
		model: Type.String({ minLength: 1 }),
		source: RoutingSourceSchema,
		rule: Type.String({ minLength: 1 }),
		requested: Type.Optional(Type.String({ minLength: 1 })),
		/** Effort for this job: the caller's level, else the row's, else the profile's (cp-eff, cp-ot3b). */
		thinking: Type.Optional(ThinkingLevelSchema),
		/**
		 * The effort the caller explicitly asked for (cp-ot3b). Recorded whenever an
		 * override named one, so a level that ended up differing from the request is
		 * visible in the routing line instead of being noticeable only to a reader
		 * comparing `thinking=` against what they typed. An override's effort is
		 * honoured or refused, never substituted — this field exists so the
		 * difference can never be silent.
		 */
		requested_thinking: Type.Optional(ThinkingLevelSchema),
		/**
		 * The candidates skipped before the selected one, in order, with the gate
		 * that skipped each (pi-command-post-0a9). Present only when a fallback was
		 * actually taken, so a decision without one prints and records exactly as it
		 * did before fallback existed.
		 *
		 * Bounded by construction (one preferred model plus at most four
		 * `fallbacks`) and made of model refs and enum words only: an automatic
		 * downgrade was refused (cp-eff) because it would be visible nowhere, so
		 * the provenance is the price of the ladder, and it can never carry a
		 * credential.
		 */
		/** Capacity scores used for this decision; never raw gateway data or credentials. */
		quota: Type.Optional(Type.Object({
			providers: Type.Array(Type.Object({
				provider: Type.String({ minLength: 1, maxLength: 128 }),
				five_hour: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
				seven_day: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
				tight: Type.Boolean(),
			}, { additionalProperties: false })),
			balance_margin: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
			balance_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
			reason: Type.Optional(StringEnum(["off:no admin key", "auth rejected", "unreadable", "timeout"])),
		}, { additionalProperties: false })),
		capacity: Type.Optional(Type.Object({
			source: StringEnum(["admin", "fleet"]),
			scores: Type.Array(Type.Object({ provider: Type.String({ minLength: 1, maxLength: 128 }), score: Type.Number() }, { additionalProperties: false }), { minItems: 1, maxItems: 5 }),
			reason: Type.Optional(StringEnum(["capacity auth rejected", "capacity response unreadable"])),
		}, { additionalProperties: false })),
		attempted: Type.Optional(
			Type.Array(
				Type.Object(
					{
						model: Type.String({ minLength: 1, maxLength: 128 }),
						refusal: StringEnum(["allowlist", "availability", "effort"]),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 8 },
			),
		),
	},
	{ additionalProperties: false },
);
export type RoutingDecision = Narrow<Static<typeof RoutingDecisionSchema>, "source", RoutingSource>;
