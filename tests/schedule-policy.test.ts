import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SCAFFOLD_MANDATE_DEFAULTS } from "../src/mandate-defaults.ts";
import { effectivePolicyBounds } from "../src/schedule-policy.ts";
import { withSkillJobFloor } from "../src/schedule-grant.ts";
import { policyFromLegacy, recipeEffects, schedulePolicyErrors, skillChildFloor, SCHEDULE_POLICY_SCHEMA_VERSION, type SchedulePolicy } from "../src/viewer/schedule-policy.ts";
import { scheduleFileErrors, SCHEDULE_SKILLS, type GrantTemplate, type Schedule } from "../src/viewer/schedule-core.ts";

const at = "2026-07-01T00:00:00Z";
const template: GrantTemplate = {
	seed_mandate_id: "md-8e7ec8", channel: "operator_chat", objective: "Review the project",
	expiry_hours: 168, spend_usd: 40, spend_tokens: 10_000_000, job_cap: 8, dispatch_parallelism: 6,
	allowed_actions: ["plan", "implement", "review", "repair"], ask_on: ["merge", "risk:high"],
	exclusions: { paths: ["private/"], subsystems: ["billing"], job_kinds: ["ship"] },
	approval: { operator_quote: "Review the project", decided_by: "operator-delegated", approved_at: at, delegation_rule: "schedule migration: seed objective verbatim", send_id: "ps-20260701000000-12345678" },
};
const schedule: Schedule = {
	id: "sch-514530", name: "self-review", project: "demo", mandate_id: "md-8e7ec8", enabled: true, created_at: at,
	trigger: { type: "manual" }, job: { skill: "cp-self-review", title: "Review the project", kind: "research", delivery: "local", description: "Review the last 36 hours" }, grant_template: template,
};
const policy = () => policyFromLegacy(schedule, template);
const orgSchedule = (): Schedule => ({ ...structuredClone(schedule), job: { skill: "cp-org-pr-review", title: "Org queue", kind: "research", delivery: "local", description: "org: acme\nteam: core\nhold: https://github.com/acme/repo/pull/7\nmax_reviewers: 2" } });

test("live-shaped sch-514530 maps without mutating or losing saved bounds and approval", () => {
	const before = structuredClone({ schedule, template });
	const mapped = policy();
	assert.equal(SCHEDULE_POLICY_SCHEMA_VERSION, 1);
	assert.deepEqual(schedulePolicyErrors(mapped), []);
	assert.deepEqual(mapped.limits, { usd: 40, tokens: 10_000_000, child_jobs: 8, parallelism: 6, run_hours: 168 });
	assert.deepEqual({ ...mapped.recipe, skill: mapped.recipe.skill ?? undefined }, schedule.job);
	assert.deepEqual(mapped.trigger, schedule.trigger);
	assert.deepEqual(mapped.approval, template.approval);
	assert.deepEqual(mapped.allowed_actions, template.allowed_actions);
	assert.deepEqual(mapped.ask_on, template.ask_on);
	assert.deepEqual(mapped.exclusions, template.exclusions);
	assert.equal(mapped.provenance.legacy_seed, template.seed_mandate_id);
	assert.equal(mapped.saved_by, "migration");
	assert.deepEqual(mapped.effects, ["board_publish"]);
	mapped.exclusions.paths!.push("more/");
	mapped.approval.operator_quote = "changed";
	assert.deepEqual({ schedule, template }, before, "snapshot is detached from legacy inputs");
	const serial = { ...template, dispatch_parallelism: undefined };
	assert.equal(policyFromLegacy(schedule, serial).limits.parallelism, 1);
});

test("validator rejects unknown fields, invalid budgets, fan-out, pins and exclusions", () => {
	const invalid: Array<[string, (p: SchedulePolicy) => void]> = [
		["allowed_actions", (p) => (p.allowed_actions as string[]).push("merge")],
		["ask_on", (p) => { p.ask_on = ["merge"]; }],
		["ask_on", (p) => { p.ask_on = ["risk:high"]; }],
		["effects", (p) => { p.effects.push("org_review_approve"); p.effect_channels = { org_review_approve: ["dashboard"] }; }],
		["effects", (p) => { p.effects = ["pull_request"]; }],
		["child_jobs", (p) => { p.limits.child_jobs = 7; }],
		["usd", (p) => { p.limits.usd = 0; }],
		["usd", (p) => { p.limits.usd = NaN; }],
		["tokens", (p) => { p.limits.tokens = Infinity; }],
		["tokens", (p) => { p.limits.tokens = 0; }],
		["tokens", (p) => { p.limits.tokens = 1.5; }],
		["parallelism", (p) => { p.limits.parallelism = 0; }],
		["parallelism", (p) => { p.limits.parallelism = 33; }],
		["run_hours", (p) => { p.limits.run_hours = 169; }],
		["run_hours", (p) => { p.limits.run_hours = 0; }],
		["revision", (p) => { p.revision = 0; }],
		["model_policy", (p) => { p.model_policy = { mode: "pinned", by_role: { reviewer: "" } }; }],
		["model_policy", (p) => { p.model_policy = { mode: "pinned", by_role: {} }; }],
		["model_policy", (p) => { p.model_policy = { mode: "pinned", by_role: { other: "p/m" } } as unknown as SchedulePolicy["model_policy"]; }],
		["paths", (p) => { p.exclusions.paths = Array(33).fill("secret/"); }],
		["job_kinds", (p) => { p.exclusions.job_kinds = ["unknown"] as never; }],
		["unexpected property", (p) => { Object.assign(p, { unknown: true }); }],
		["unexpected property", (p) => { Object.assign(p.limits, { unknown: true }); }],
	];
	for (const [expected, mutate] of invalid) {
		const value = policy();
		mutate(value);
		assert.match(schedulePolicyErrors(value).join("; "), new RegExp(expected), expected);
	}
	for (const value of [null, [], "policy", {}, { recipe: null }]) assert.ok(schedulePolicyErrors(value).length);
	const pinned = policy();
	pinned.model_policy = { mode: "pinned", by_role: { implementer: "provider/model", planner: "provider/model", reviewer: "provider/unlisted" } };
	assert.deepEqual(schedulePolicyErrors(pinned), [], "P1 checks shape; dispatch will validate availability in P2b");
});

test("org-review config is parsed, bounded and agrees with the recipe", () => {
	const p = policyFromLegacy(orgSchedule(), template);
	assert.deepEqual(schedulePolicyErrors(p), []);
	assert.deepEqual(p.effects, ["report"]);
	for (const max of [0, 4]) {
		const bad = structuredClone(p);
		bad.recipe_config!.max_reviewers = max;
		assert.match(schedulePolicyErrors(bad).join("; "), /max_reviewers/);
	}
	const mismatch = structuredClone(p);
	mismatch.recipe_config!.teams = ["other"];
	assert.match(schedulePolicyErrors(mismatch).join("; "), /must match orgReviewConfig/);
	const belowFloor = structuredClone(p);
	belowFloor.limits.child_jobs = 3;
	assert.match(schedulePolicyErrors(belowFloor).join("; "), /skill floor 4/);
	const nonOrg = policy();
	nonOrg.recipe_config = p.recipe_config;
	assert.match(schedulePolicyErrors(nonOrg).join("; "), /non-null only/);
});

test("legacy org approval appears only under runNowClearance seed conditions, and only dashboard may approve", () => {
	const seed = { id: template.seed_mandate_id, schedule_grant: true, status: "active", risk_preapproval: { scope: "mandate_jobs", operator_quote: "Approve qualifying reviews", granted_at: at } };
	const org = orgSchedule();
	for (const status of ["active", "expired", "revoked", "paused"]) {
		const mapped = policyFromLegacy(org, template, { ...seed, status, revoked_by: { by: "system" }, pause_reason: "spend_cap" });
		assert.deepEqual(schedulePolicyErrors(mapped), []);
		assert.deepEqual(mapped.effects, ["report", "org_review_approve"]);
		assert.deepEqual(mapped.effect_channels, { org_review_approve: ["dashboard"] });
		assert.equal(mapped.ask_on.includes("risk:high"), true, "saved effect never removes risk gate");
		const bad = structuredClone(mapped);
		bad.effect_channels = { org_review_approve: ["cp_schedule"] } as never;
		assert.match(schedulePolicyErrors(bad).join("; "), /exactly \[dashboard\]/);
		mapped.permitted_start_channels.dashboard = false;
		assert.match(schedulePolicyErrors(mapped).join("; "), /dashboard-only/);
	}
	for (const invalid of [undefined, { ...seed, id: "md-other" }, { ...seed, schedule_grant: false }, { ...seed, schedule_fire: {} }, { ...seed, status: "revoked" }, { ...seed, status: "revoked", revoked_by: { by: "operator" } }, { ...seed, status: "paused", pause_reason: "operator" }, { ...seed, risk_preapproval: { ...seed.risk_preapproval, scope: "named_jobs" } }, { ...seed, risk_preapproval: { ...seed.risk_preapproval, operator_quote: "" } }, { ...seed, risk_preapproval: { ...seed.risk_preapproval, granted_at: "" } }]) {
		assert.deepEqual(policyFromLegacy(org, template, invalid).effects, ["report"]);
	}
	assert.deepEqual(policyFromLegacy(schedule, template, seed).effects, ["board_publish"]);
});

test("effects matrix, skill floors and legacy pipeline compatibility", () => {
	for (const [kind, delivery, effect] of [["research", "answer", "answer"], ["research", "board", "board_publish"], ["research", "local", "report"], ["ship", "local", "branch_push"], ["ship", "pr", "pull_request"], ["ship", "pipeline", "pipeline"]] as const) {
		const legacy = { ...schedule, job: { title: "work", kind, delivery } };
		const mapped = policyFromLegacy(legacy, template);
		assert.deepEqual(recipeEffects(legacy.job), [effect]);
		assert.deepEqual(schedulePolicyErrors(mapped), []);
		assert.deepEqual(scheduleFileErrors({ schema_version: 1, schedules: [legacy] }), [], "existing schedule reader unchanged, including pipeline");
	}
	for (const skill of SCHEDULE_SKILLS) {
		for (const description of ["pr: https://github.com/acme/r/pull/1\n PR: https://github.com/acme/r/pull/2", "org: acme\nmax_reviewers: 1", "org: acme\nmax_reviewers: 3", ""]) {
			const job = { ...schedule.job, skill, description };
			assert.equal(skillChildFloor(job), withSkillJobFloor({ ...template, job_cap: 1 }, job).template.job_cap);
		}
	}
	assert.equal(skillChildFloor({ title: "plain", kind: "research", delivery: "local" }), undefined);
});

test("live bounds only narrow: exclusion union, clamp, excluded kind, path overflow and invalid ceiling", () => {
	const p = policy();
	const before = structuredClone(p);
	const context = { defaults: { ...SCAFFOLD_MANDATE_DEFAULTS, exclude_paths: ["private/", ".env"] }, projectOverride: { exclude_paths: ["infra/"] }, ceiling: 500_000 };
	const bounded = effectivePolicyBounds(p, context, "demo", "research", new Date(at));
	assert.ok(!("refusal" in bounded));
	assert.deepEqual(bounded.limits, { ...p.limits, tokens: 500_000 });
	assert.deepEqual(bounded.exclusions, { ...p.exclusions, paths: ["private/", ".env", "infra/"] });
	assert.match(bounded.notes.join("; "), /clamped.*500000/);
	assert.match(bounded.notes.join("; "), /exclusions add/);
	assert.deepEqual(p, before);
	const unchanged = effectivePolicyBounds(p, { ...context, ceiling: 100_000_000 }, "demo", "research", new Date(at));
	assert.ok(!("refusal" in unchanged));
	assert.equal(unchanged.limits.tokens, p.limits.tokens);
	assert.match(JSON.stringify(effectivePolicyBounds(p, context, "demo", "ship", new Date(at))), /excludes ship/);
	assert.match(JSON.stringify(effectivePolicyBounds(p, { ...context, defaults: { ...context.defaults, exclude_paths: Array.from({ length: 32 }, (_, i) => `p${i}/`) } }, "demo", "research", new Date(at))), /over the 32.*none is dropped/);
	for (const ceiling of [0, -1, NaN, Infinity, 1.5]) assert.match(JSON.stringify(effectivePolicyBounds(p, { ...context, ceiling }, "demo", "research", new Date(at))), /nothing to spend/);
	assert.match(JSON.stringify(effectivePolicyBounds({ ...p, limits: { ...p.limits, usd: 0 } }, context, "demo", "research", new Date(at))), /violates the contract/);
	assert.match(JSON.stringify(effectivePolicyBounds(p, context, "other", "research", new Date(at))), /belongs to demo/);
});

test("policy modules contain no banned approval identifier", () => {
	for (const file of ["src/viewer/schedule-policy.ts", "src/schedule-policy.ts"]) {
		assert.equal(readFileSync(file, "utf8").includes(["approval", "quote"].join("_")), false);
	}
});
