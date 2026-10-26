/**
 * Retained from tests/viewer-schedules.test.ts (P20, cp-e2e-migration-p20-ov8o): the schedule schema's constant mirrors
 * of the contracts, which no entry point exposes. Behavior lives in tests/e2e/viewer-settings.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scheduleFileErrors } from "../src/scheduler.ts";
import { GRANT_TEMPLATE_ACTIONS, GRANT_TEMPLATE_ASK_ON, MANDATE_CHANNEL_VALUES, SCHEDULE_DELIVERIES, SCHEDULE_JOB_KINDS, SCHEDULE_MANDATE_ID, SCHEDULE_SCHEMA_VERSION, SCHEDULE_SKILL_ANCHOR, SCHEDULE_SKILLS } from "../src/viewer/schedule-core.ts";
import { PARENT_SKILLS } from "../src/cp-bridge.ts";
import { SCHEDULE_ANSWER_MAX_BYTES } from "../src/viewer/schedules-view.ts";
import { ANSWER_MAX_BYTES, DELIVERIES, JOB_KINDS, MANDATE_ACTIONS, MANDATE_ASK_ON, MANDATE_CHANNELS, MANDATE_ID_PATTERN, SCHEMA_VERSION } from "../src/contracts.ts";
import { REPO_ROOT } from "./harness/index.ts";

const template = {
	seed_mandate_id: "md-seed1", channel: "operator_chat", objective: "triage", expiry_hours: 24, spend_usd: 10, spend_tokens: 500000, job_cap: 2,
	allowed_actions: ["plan", "implement"], ask_on: ["merge", "risk:high"],
	approval: { operator_quote: `Yes, triage. ${"long-unbroken-quote-".repeat(60)}`, decided_by: "operator-quote", approved_at: "2026-09-01T00:00:00Z" },
};
const cron = {
	id: "sch-aaaaaa", name: "weekly digest", project: "demo", mandate_id: "md-live1",
	trigger: { type: "cron", cron: "0 6 * * 1", tz: "Europe/Warsaw" },
	job: { title: "Digest", kind: "research", delivery: "answer" },
	enabled: true, created_at: "2026-09-01T00:00:00Z", last_checked_at: "2026-09-28T01:40:00Z",
	last_fire: { at: "2026-09-21T04:00:10Z", slot: "2026-09-21T04:00:00.000Z", job_id: "cp-fire2", missed: true },
	grant_template: template,
};
const watch = {
	id: "sch-bbbbbb", name: "dep watch", project: "demo", mandate_id: "md-paus1",
	trigger: { type: "watch", script_path: "scripts/x.sh", every_seconds: 300, on: "changed" },
	job: { title: "Bump deps", kind: "ship", delivery: "pr" },
	enabled: false, created_at: "2026-09-01T00:00:00Z", last_checked_at: "2026-09-28T01:00:00Z", last_output_sha: "abc",
	last_skip: { at: "2026-09-28T01:00:00Z", reason: "fire at 2026-09-28T01:00Z not recorded: md-paus1 is paused" },
	grant_template: template,
};
const file = (...schedules: unknown[]) => JSON.stringify({ schema_version: SCHEMA_VERSION, schedules });

test("the dependency-free schedule schema mirrors the contracts and refuses what the typebox schema refused", () => {
	assert.deepEqual([...SCHEDULE_JOB_KINDS], [...JOB_KINDS]);
	assert.deepEqual([...SCHEDULE_DELIVERIES], [...DELIVERIES]);
	assert.equal(SCHEDULE_MANDATE_ID.source, MANDATE_ID_PATTERN);
	assert.equal(SCHEDULE_SCHEMA_VERSION, 2, "schedules v2 evolves independently of mandate schemas");
	assert.deepEqual([...GRANT_TEMPLATE_ASK_ON], [...MANDATE_ASK_ON]);
	assert.deepEqual([...GRANT_TEMPLATE_ACTIONS], MANDATE_ACTIONS.filter((action) => action !== "merge"), "a fire grant template never carries merge");
	assert.deepEqual([...MANDATE_CHANNEL_VALUES], [...MANDATE_CHANNELS]);
	assert.deepEqual(scheduleFileErrors(JSON.parse(file(cron, watch))), []);
	const bad = (patch: Record<string, unknown>) => scheduleFileErrors({ schema_version: SCHEMA_VERSION, schedules: [{ ...cron, ...patch }] });
	assert.match(bad({ extra: 1 }).join(), /\/schedules\/0\/extra: unexpected property/);
	assert.match(bad({ name: "two\nlines" }).join(), /\/schedules\/0\/name/);
	assert.match(bad({ mandate_id: "md-X" }).join(), /mandate_id/);
	assert.match(bad({ job: { ...cron.job, kind: "deploy" } }).join(), /job\/kind/);
	assert.match(bad({ trigger: { ...watch.trigger, every_seconds: 10 } }).join(), /every_seconds/);
	assert.match(bad({ trigger: { type: "cron", cron: "* * * * *" } }).join(), /trigger\/tz: is required/);
	assert.match(bad({ last_fire: { at: "x", slot: "x", job_id: "x" } }).join(), /last_fire\/missed: is required/);
	assert.deepEqual(scheduleFileErrors({ schema_version: 2, schedules: [] }), []);
	assert.match(scheduleFileErrors({ schema_version: 3, schedules: [] }).join(), /schema_version/);
	assert.match(scheduleFileErrors({ schema_version: SCHEMA_VERSION, schedules: {} }).join(), /schedules: must be an array/);
});

test("the expander registry and the answer cap mirror their sources (verbatim from two viewer-schedules tests)", () => {
	// The expander registry: every schedule skill is a parent skill shipped as skills/<name>/SKILL.md, with a research/local anchor.
	for (const skill of SCHEDULE_SKILLS) {
		assert.ok((PARENT_SKILLS as readonly string[]).includes(skill), `${skill} is a parent skill`);
		assert.match(readFileSync(join(REPO_ROOT, "skills", skill, "SKILL.md"), "utf8"), new RegExp(`^name: ${skill}$`, "m"));
		assert.deepEqual(SCHEDULE_SKILL_ANCHOR[skill], { kind: "research", delivery: "local" });
	}
	assert.equal(SCHEDULE_ANSWER_MAX_BYTES, ANSWER_MAX_BYTES, "the viewer's cap mirrors the contract");
});
