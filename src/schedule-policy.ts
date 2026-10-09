/** Pure live narrowing of a saved policy; no caller activates schedule authority here. */
import type { JobKind } from "./contracts.ts";
import { liveFireBounds, refused, type MintContext, type Refusal } from "./schedule-grant.ts";
import { schedulePolicyErrors, type SchedulePolicy } from "./viewer/schedule-policy.ts";

/** Reuse the fire validator's exclusion union, path limit, ceiling clamp and named refusals. */
export function effectivePolicyBounds(policy: SchedulePolicy, context: MintContext, project: string, kind: JobKind, now: Date): { limits: SchedulePolicy["limits"]; exclusions: SchedulePolicy["exclusions"]; notes: string[] } | Refusal {
	const errors = schedulePolicyErrors(policy);
	if (errors.length) return { refusal: `schedule policy violates the contract: ${errors.join("; ")}` };
	if (project !== policy.project) return { refusal: `schedule policy ${policy.schedule_id} belongs to ${policy.project}, not ${project}` };
	if (!Number.isSafeInteger(context.ceiling) || context.ceiling < 1) return { refusal: `the home's token_ceiling is ${context.ceiling}: a fire grant would have nothing to spend` };
	if (!Number.isFinite(now.getTime())) return { refusal: "schedule policy bounds need a valid fire time" };
	const result = liveFireBounds({
		seed_mandate_id: policy.provenance.legacy_seed ?? policy.schedule_id,
		channel: "operator_chat", objective: policy.recipe.title, approval: policy.approval,
		expiry_hours: policy.limits.run_hours, spend_usd: policy.limits.usd, spend_tokens: policy.limits.tokens,
		job_cap: policy.limits.child_jobs, dispatch_parallelism: policy.limits.parallelism,
		allowed_actions: policy.allowed_actions, ask_on: policy.ask_on, exclusions: policy.exclusions,
	}, context, project, kind, now);
	if (refused(result)) return result;
	return { limits: { ...policy.limits, tokens: result.input.spend_cap.tokens }, exclusions: structuredClone(result.input.exclusions ?? {}), notes: result.notes };
}
