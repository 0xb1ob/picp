/**
 * The implementer routing composition (routing T2, riskkw) is a leaf module:
 * the frozen task impact, the planner's `self_assessment` and the gate
 * reviewer's own flags go in, and what the implementer dispatch is told comes
 * out. Moved here verbatim from `src/pipeline.ts`, which was 2093 lines against
 * its 2090 pin after #360 and #363 landed from separate bases, so the pipeline
 * keeps headroom under its size cap. `src/pipeline.ts` imports and re-exports
 * `composeImplementationRouting`, so the public import path and every existing
 * test are unchanged. Nothing here imports `src/pipeline.ts`.
 */
import type { GateFlags, JobRouting, Risk, RoutingProvenance, Scope, SelfAssessment, TaskImpact } from "./contracts.ts";
import type { PipelineRecordedRisk } from "./risk-warning.ts";

/**
 * The provenance of one axis of a `JobRouting`, including for records written
 * before `provenance` existed. A legacy record carries only the one-bit
 * `inferred` flag, which cannot say *which* axis was inferred — so the weaker
 * claim is made for both, never the stronger one.
 */
function axisProvenance(routing: JobRouting | undefined, axis: "scope" | "risk"): RoutingProvenance | undefined {
	if (!routing) return undefined;
	return routing.provenance?.[axis] ?? (routing.inferred ? "inferred" : "explicit");
}

/** The planner's own reasons to want a better model, in its own words. */
function plannerEscalations(assessment: SelfAssessment): string[] {
	return [
		...(assessment.destructive_scope === true ? ["destructive scope"] : []),
		...(assessment.blocking_unknowns === true ? ["blocking unknowns"] : []),
		...(assessment.confidence === "low" ? ["low confidence"] : []),
	];
}

/** What the implementer dispatch is told, and where each half of it came from. */
export interface ComposedRouting {
	scope?: Scope;
	risk?: Risk;
	/** Per-axis label for `DispatchRequest.inputsFrom`; only supplied axes matter. */
	inputsFrom: { scope?: RoutingProvenance; risk?: RoutingProvenance };
	/** Bounded, human-readable, for the checkpoint evidence and the advance message. */
	reasons: string[];
	/** H6: a low the operator or planner recorded; never routes, only the risk:high gate reads it (`DispatchRequest.recordedRisk`). */
	recordedRisk?: PipelineRecordedRisk;
}

/**
 * The routing inputs the implementer is dispatched with (routing T2).
 *
 * Two different things used to be conflated into one boolean, and the
 * conflation is the bug: the planner's `self_assessment` measures **the plan**
 * (how big it is, whether its author believes it, whether it is blocked), while
 * `task_impact` measures **the work** (does it touch production, credentials,
 * money, data). `routingInputsFrom` read only the first and emitted
 * `risk: "low"` whenever the planner was confident and non-destructive — so a
 * good plan for rotating production credentials routed as low risk, and,
 * because an emitted axis switches off dispatch's own inference, the task's
 * words could not put it back.
 *
 * So the two are composed rather than merged:
 *
 *  - **Known impact is never lowered.** A task whose risk is `high` from any
 *    source but `defaulted` stays `high`, whatever the planner reports. The
 *    absence of a destructive flag is not evidence that production went away.
 *  - **Uncertainty may only escalate.** `destructive_scope`,
 *    `blocking_unknowns` or `confidence: "low"` raise risk to `high`; nothing
 *    the planner can report lowers it.
 *  - **`risk: "low"` is never emitted here at all.** Silence leaves the axis to
 *    `resolveRoutingInputs` at dispatch, which re-reads the ship job's own words
 *    (its br title and description are the original task) and defaults to `low`
 *    only when it finds nothing. A confident planner therefore cannot suppress
 *    the task's own evidence, and a genuinely low-impact task still routes low.
 *  - **Scope may shrink.** The planner measured the implementation; a plan that
 *    narrows an `L` task to an `S` change is exactly the evidence scope is for,
 *    so the planner's `scope` wins its own axis. The frozen task's scope is the
 *    fallback for a planner that measured none — not a floor to max against.
 *
 * Deliberate reclassification is still available and unchanged: it is an
 * explicit `cp_dispatch <ship-id> --scope/--risk`, recorded as `explicit`
 * provenance with a human behind it. Nothing in an automatic advance can do it.
 *
 * `suggested_implementer_model` is deliberately NOT read here. A worker naming
 * its successor's model is a worker choosing its own budget, with an obvious
 * incentive and nothing able to check the claim. It travels as checkpoint
 * evidence instead, where a human is already deciding.
 */
export function composeImplementationRouting(input: {
	/** The frozen task impact, or `undefined` when none could be recovered. */
	task?: TaskImpact;
	/** The planner's own measurements of its plan. */
	assessment?: SelfAssessment;
	/** riskkw (cp-yxgl review): the gate reviewer's own flags for that plan — escalating evidence exactly like the planner's. */
	flags?: GateFlags;
}): ComposedRouting {
	const { task, assessment } = input;
	const known = task?.routing;
	const knownRiskFrom = axisProvenance(known, "risk");
	const knownScopeFrom = axisProvenance(known, "scope");
	const reasons: string[] = [];
	const planner = assessment ? plannerEscalations(assessment) : [];
	const flagged = [...(input.flags?.destructive_scope ? ["destructive scope"] : []), ...(input.flags?.blocking_unknowns ? ["blocking unknowns"] : [])];
	const escalations = [...new Set([...planner, ...flagged])];

	let risk: Risk | undefined;
	let riskFrom: RoutingProvenance | undefined;
	if (known?.risk === "high" && knownRiskFrom !== undefined && knownRiskFrom !== "defaulted") {
		risk = "high";
		riskFrom = knownRiskFrom;
		const why = (known.reasons ?? []).find((reason) => reason.startsWith("risk "));
		reasons.push(`risk high retained from the task (${knownRiskFrom}, ${task?.source})${why ? `: ${why}` : ""}`.slice(0, 200));
	} else if (escalations.length > 0) {
		risk = "high";
		riskFrom = "assessed";
		const why = [...(planner.length > 0 ? [`the planner reports ${planner.join(", ")}`] : []), ...(flagged.length > 0 ? [`the gate flags ${flagged.join(", ")}`] : [])];
		reasons.push(`risk high: ${why.join("; ")}`.slice(0, 200));
	}

	let scope: Scope | undefined;
	let scopeFrom: RoutingProvenance | undefined;
	if (assessment?.scope) {
		scope = assessment.scope;
		scopeFrom = "assessed";
		if (known?.scope && known.scope !== assessment.scope && knownScopeFrom !== "defaulted") {
			reasons.push(`scope ${assessment.scope}: the planner measured the implementation (task said ${known.scope})`);
		}
	} else if (known?.scope && knownScopeFrom !== undefined && knownScopeFrom !== "defaulted") {
		scope = known.scope;
		scopeFrom = knownScopeFrom;
	}

	// H6: an explicit/assessed low at start, or a planner that recorded nothing destructive or uncertain.
	// The axis provenance travels with it: a `defaulted`/`inferred` low is nobody's record, and the planner's half says so.
	const operatorLow = known?.risk === "low" && (knownRiskFrom === "explicit" || knownRiskFrom === "assessed");
	const plannerLow = assessment?.destructive_scope === false && escalations.length === 0;
	const recordedLow = (risk === undefined || riskFrom === "inferred") && (operatorLow || plannerLow);
	const lowFrom = operatorLow ? ("pipeline" as const) : ("planner" as const);
	const lowProvenance: RoutingProvenance = operatorLow ? (knownRiskFrom ?? "explicit") : "assessed";

	return {
		...(scope ? { scope } : {}),
		...(risk ? { risk } : {}),
		...(recordedLow ? { recordedRisk: { risk: "low" as const, from: lowFrom, provenance: lowProvenance } } : {}),
		inputsFrom: {
			...(scopeFrom ? { scope: scopeFrom } : {}),
			...(riskFrom ? { risk: riskFrom } : {}),
		},
		reasons: reasons.slice(0, 4),
	};
}
