/** Saved schedule policy contract only: no persistence or production authority (docs/contracts.md). */
import {
	boolean, cronTrigger, GRANT_TEMPLATE_ACTIONS, GRANT_TEMPLATE_ASK_ON, GRANT_TEMPLATE_FORCED_ASK_ON,
	GRANT_TEMPLATE_MAX_HOURS, isObject, ISO_SECOND, line, lines, manualTrigger, number, object, oneOf,
	operatorStop, orgReviewConfig, orgReviewMaxReviewers, pattern, SCHEDULE_DELIVERIES, SCHEDULE_ID,
	SCHEDULE_JOB_KINDS, SCHEDULE_MANDATE_ID, SCHEDULE_SKILLS, subset, text, watchTrigger,
	type GrantTemplate, type OrgReviewConfig, type Schedule,
} from "./schedule-core.ts";

export const SCHEDULE_POLICY_SCHEMA_VERSION = 1;
export const SCHEDULE_EFFECTS = ["answer", "board_publish", "report", "branch_push", "pull_request", "pipeline", "org_review_approve"] as const;
export type ScheduleEffect = (typeof SCHEDULE_EFFECTS)[number];
export interface SchedulePolicy {
	schedule_id: string;
	revision: number;
	saved_at: string;
	saved_by: "operator-quote" | "operator-delegated" | "dashboard" | "migration";
	provenance: { channel: "dashboard" | "cp_schedule" | "migration"; request_id?: string; tool_call_id?: string; send_id?: string; delegation_rule?: string; quote_sha?: string; legacy_seed?: string; recipe_sha?: string };
	approval: GrantTemplate["approval"];
	project: string;
	recipe: Omit<Schedule["job"], "skill"> & { skill: (typeof SCHEDULE_SKILLS)[number] | null };
	recipe_config: OrgReviewConfig | null;
	trigger: Schedule["trigger"];
	effects: ScheduleEffect[];
	permitted_start_channels: { slot: boolean; dashboard: boolean; cp_schedule: boolean };
	effect_channels: { org_review_approve?: ["dashboard"] };
	limits: { usd: number; tokens: number; child_jobs: number; parallelism: number; run_hours: number };
	model_policy: { mode: "routing-default" } | { mode: "pinned"; by_role: { implementer?: string; planner?: string; reviewer?: string } };
	allowed_actions: GrantTemplate["allowed_actions"];
	ask_on: GrantTemplate["ask_on"];
	exclusions: NonNullable<GrantTemplate["exclusions"]>;
}

type Recipe = Omit<Schedule["job"], "skill"> & { skill?: Schedule["job"]["skill"] | null };
/** Base effects only; org approval requires separate dashboard clearance. */
export function recipeEffects(job: Recipe): ScheduleEffect[] {
	if (job.delivery === "pipeline") return ["pipeline"];
	if (job.skill === "cp-self-review" || job.skill === "cp-pr-review") return ["board_publish"];
	if (job.kind === "research") return job.delivery === "answer" ? ["answer"] : job.delivery === "board" ? ["board_publish"] : job.delivery === "local" ? ["report"] : [];
	return job.delivery === "local" ? ["branch_push"] : job.delivery === "pr" ? ["pull_request"] : [];
}

/** Same anchor + fan-out floor as server skillJobFloor; pinned by tests. */
export function skillChildFloor(job: Recipe): number | undefined {
	if (job.skill === "cp-self-review") return 8;
	if (job.skill === "cp-pr-review") return (job.description ?? "").split("\n").filter((entry) => /^pr:/i.test(entry.trim())).length + 2;
	if (job.skill === "cp-org-pr-review") return orgReviewMaxReviewers(job.description) + 2;
	return undefined;
}

const positiveInteger = number(1, Number.MAX_SAFE_INTEGER, true);
const policyShape = object({
	schedule_id: pattern(SCHEDULE_ID), revision: positiveInteger, saved_at: pattern(ISO_SECOND),
	saved_by: oneOf(["operator-quote", "operator-delegated", "dashboard", "migration"]),
	provenance: object({
		channel: oneOf(["dashboard", "cp_schedule", "migration"]), "request_id?": line(200), "tool_call_id?": line(200),
		"send_id?": pattern(/^ps-[0-9]{14}-[0-9a-f]{8}$/), "delegation_rule?": text(300),
		"quote_sha?": pattern(/^[0-9a-f]{12}$/), "legacy_seed?": pattern(SCHEDULE_MANDATE_ID), "recipe_sha?": pattern(/^[0-9a-f]{64}$/),
	}),
	approval: object({ operator_quote: text(4000), decided_by: oneOf(["operator-quote", "operator-delegated"]), approved_at: pattern(ISO_SECOND), "delegation_rule?": text(300), "send_id?": pattern(/^ps-[0-9]{14}-[0-9a-f]{8}$/) }),
	project: line(64),
	recipe: object({
		skill: oneOf([null, ...SCHEDULE_SKILLS]), title: line(200), kind: oneOf(SCHEDULE_JOB_KINDS), delivery: oneOf(SCHEDULE_DELIVERIES),
		"description?": (v, path, errors) => { if (typeof v !== "string" || v.length > 4000) errors.push(`${path}: must be a string of at most 4000 characters`); }, "script_path?": line(1000),
	}),
	recipe_config: (v, path, errors) => {
		if (v === null) return;
		object({ org: line(39), user: (u, p, e) => { if (u !== null) line(39)(u, p, e); }, teams: lines(100, 10), holds: lines(1000, 50), max_reviewers: number(1, 3, true) })(v, path, errors);
	},
	trigger: (v, path, errors) => (isObject(v) && v.type === "watch" ? watchTrigger : isObject(v) && v.type === "manual" ? manualTrigger : cronTrigger)(v, path, errors),
	effects: subset(SCHEDULE_EFFECTS, SCHEDULE_EFFECTS.length),
	permitted_start_channels: object({ slot: boolean, dashboard: boolean, cp_schedule: boolean }),
	effect_channels: object({ "org_review_approve?": (v, path, errors) => { if (!Array.isArray(v) || v.length !== 1 || v[0] !== "dashboard") errors.push(`${path}: must be exactly [dashboard]`); } }),
	limits: object({ usd: number(0, Number.MAX_SAFE_INTEGER, false, true), tokens: positiveInteger, child_jobs: positiveInteger, parallelism: number(1, 32, true), run_hours: number(1, GRANT_TEMPLATE_MAX_HOURS, true) }),
	model_policy: (v, path, errors) => {
		(isObject(v) && v.mode === "pinned" ? object({ mode: oneOf(["pinned"]), by_role: object({ "implementer?": line(200), "planner?": line(200), "reviewer?": line(200) }) }) : object({ mode: oneOf(["routing-default"]) }))(v, path, errors);
		if (isObject(v) && v.mode === "pinned" && isObject(v.by_role) && !Object.keys(v.by_role).length) errors.push(`${path}/by_role: must pin at least one role`);
	},
	allowed_actions: subset(GRANT_TEMPLATE_ACTIONS, 8), ask_on: subset(GRANT_TEMPLATE_ASK_ON, 16, GRANT_TEMPLATE_FORCED_ASK_ON),
	exclusions: object({ "paths?": lines(200, 32), "subsystems?": lines(80, 32), "job_kinds?": (v, path, errors) => {
		if (!Array.isArray(v) || v.length > 4) errors.push(`${path}: must be an array of at most 4`);
		else v.forEach((item, i) => oneOf(SCHEDULE_JOB_KINDS)(item, `${path}/${i}`, errors));
	} }),
});

/** Unknown fields and invalid shapes fail closed before semantic validation. */
export function schedulePolicyErrors(value: unknown): string[] {
	const errors: string[] = [];
	policyShape(value, "", errors);
	if (errors.length) return errors;
	const policy = value as SchedulePolicy;
	const { recipe } = policy;
	const expected = recipeEffects(recipe);
	const base = policy.effects.filter((effect) => effect !== "org_review_approve");
	if (!expected.length || base.length !== expected.length || expected.some((effect) => !base.some((item) => item === effect))) errors.push("/effects: must match the recipe's effects");
	const approve = policy.effects.includes("org_review_approve");
	if (approve && (recipe.skill !== "cp-org-pr-review" || !policy.effect_channels.org_review_approve || !policy.permitted_start_channels.dashboard)) errors.push("/effects: org_review_approve requires cp-org-pr-review and dashboard-only effect clearance");
	if (!approve && policy.effect_channels.org_review_approve) errors.push("/effect_channels: org_review_approve needs its effect");
	if (recipe.skill && (recipe.kind !== "research" || recipe.delivery !== "local" || recipe.script_path !== undefined || policy.trigger.type !== "manual")) errors.push("/recipe: skills require a manual research/local anchor without script_path");
	const floor = skillChildFloor(recipe);
	if (floor !== undefined && policy.limits.child_jobs < floor) errors.push(`/limits/child_jobs: must be at least the skill floor ${floor}`);
	if (recipe.skill === "cp-org-pr-review") {
		try {
			const config = orgReviewConfig(recipe.description ?? "");
			if (!policy.recipe_config || config.org !== policy.recipe_config.org || config.user !== policy.recipe_config.user || config.max_reviewers !== policy.recipe_config.max_reviewers || JSON.stringify(config.teams) !== JSON.stringify(policy.recipe_config.teams) || JSON.stringify(config.holds) !== JSON.stringify(policy.recipe_config.holds)) errors.push("/recipe_config: must match orgReviewConfig(recipe.description)");
		} catch (error) { errors.push(`/recipe_config: ${(error as Error).message}`); }
	} else if (policy.recipe_config !== null) errors.push("/recipe_config: non-null only for cp-org-pr-review");
	return errors;
}

/** Pure legacy snapshot; omitted parallelism retains the existing serial fallback. No adoption or writes. */
export function policyFromLegacy(schedule: Schedule, template: GrantTemplate, seed?: { id: string; schedule_grant?: boolean; schedule_fire?: unknown; status?: unknown; pause_reason?: unknown; revoked_by?: unknown; risk_preapproval?: { scope?: unknown; operator_quote?: unknown; granted_at?: unknown } }): SchedulePolicy {
	const pre = seed?.risk_preapproval;
	const approve = schedule.job.skill === "cp-org-pr-review" && seed?.id === template.seed_mandate_id && seed.schedule_grant === true && seed.schedule_fire === undefined && !operatorStop(seed) && pre?.scope === "mandate_jobs" && typeof pre.operator_quote === "string" && pre.operator_quote.length > 0 && typeof pre.granted_at === "string" && pre.granted_at.length > 0;
	return structuredClone({
		schedule_id: schedule.id, revision: 1, saved_at: template.approval.approved_at, saved_by: "migration",
		provenance: { channel: "migration", legacy_seed: template.seed_mandate_id }, approval: template.approval, project: schedule.project,
		recipe: { ...schedule.job, skill: schedule.job.skill ?? null }, recipe_config: schedule.job.skill === "cp-org-pr-review" ? orgReviewConfig(schedule.job.description ?? "") : null,
		trigger: schedule.trigger, effects: [...recipeEffects(schedule.job), ...(approve ? ["org_review_approve" as const] : [])],
		permitted_start_channels: { slot: schedule.trigger.type !== "manual", dashboard: true, cp_schedule: true }, effect_channels: approve ? { org_review_approve: ["dashboard"] } : {},
		limits: { usd: template.spend_usd, tokens: template.spend_tokens, child_jobs: template.job_cap, parallelism: template.dispatch_parallelism ?? 1, run_hours: template.expiry_hours },
		model_policy: { mode: "routing-default" }, allowed_actions: template.allowed_actions, ask_on: template.ask_on, exclusions: template.exclusions ?? {},
	});
}
