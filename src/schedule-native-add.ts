/** Native schedule creation: limits from the live mandate-defaults ladder, revision 1 authorized by the add itself. */
import { isoTimestamp } from "./contracts.ts";
import { effectivePolicyBounds } from "./schedule-policy.ts";
import { refused, skillJobFloor, type MintContext, type Refusal } from "./schedule-grant.ts";
import type { PolicyAction } from "./schedule-run-fire.ts";
import { GRANT_TEMPLATE_MAX_HOURS, orgReviewConfig, type Schedule } from "./viewer/schedule-core.ts";
import { nativePolicyDraft, schedulePolicyErrors, type NativeSchedulePolicy } from "./viewer/schedule-policy.ts";

/** Explicit per-schedule limits; each omitted one falls back to the project override, then the home default. */
export interface NativeAddLimits { spend_usd?: number; spend_tokens?: number; job_cap?: number; dispatch_parallelism?: number; run_hours?: number }

/** The policy a native add saves and activates, narrowed by the live home bounds; never a grant. */
export function nativeAddPolicy(input: { schedule: Schedule; limits: NativeAddLimits; context: MintContext; action: PolicyAction; now: Date }): NativeSchedulePolicy | Refusal {
	const { schedule, context, now } = input;
	const home = context.defaults, project = context.projectOverride;
	const limits = {
		usd: input.limits.spend_usd ?? project?.spend_usd ?? home.spend_usd,
		tokens: Math.min(input.limits.spend_tokens ?? project?.spend_tokens ?? home.spend_tokens, context.ceiling),
		// One skill fan-out plus its anchor always fits; a lower cap is raised, as the legacy template did.
		child_jobs: Math.max(input.limits.job_cap ?? project?.job_cap ?? home.job_cap, skillJobFloor(schedule.job) ?? 1),
		parallelism: Math.min(32, input.limits.dispatch_parallelism ?? project?.dispatch_parallelism ?? home.dispatch_parallelism),
		run_hours: Math.min(GRANT_TEMPLATE_MAX_HOURS, Math.max(1, Math.round(input.limits.run_hours ?? project?.expiry_hours ?? home.expiry_hours))),
	};
	const { skill, ...job } = schedule.job;
	const policy = nativePolicyDraft({
		schedule_id: schedule.id, project: schedule.project, recipe: { ...job, skill: skill ?? null }, trigger: schedule.trigger, limits,
		recipe_config: skill === "cp-org-pr-review" ? orgReviewConfig(job.description ?? "") : null,
	}, { revision: 1, saved_at: isoTimestamp(now), saved_by: input.action.saved_by, provenance: input.action.provenance });
	const errors = schedulePolicyErrors(policy);
	if (errors.length) return { refusal: `invalid schedule policy: ${errors.join("; ")}` };
	const bounds = effectivePolicyBounds(policy, context, schedule.project, schedule.job.kind, now);
	return refused(bounds) ? bounds : { ...policy, limits: bounds.limits, exclusions: bounds.exclusions };
}
