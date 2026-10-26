/**
 * Retained from tests/viewer-schedules.test.ts (P20, cp-e2e-migration-p20b-hj5g): the schedule schema's constant
 * mirrors of the contracts and the expander registry, which no entry point exposes. Behavior lives in
 * tests/e2e/viewer-settings.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GRANT_TEMPLATE_ACTIONS, GRANT_TEMPLATE_ASK_ON, MANDATE_CHANNEL_VALUES, SCHEDULE_DELIVERIES, SCHEDULE_JOB_KINDS, SCHEDULE_MANDATE_ID, SCHEDULE_SCHEMA_VERSION, SCHEDULE_SKILL_ANCHOR, SCHEDULE_SKILLS } from "../src/viewer/schedule-core.ts";
import { PARENT_SKILLS } from "../src/cp-bridge.ts";
import { SCHEDULE_ANSWER_MAX_BYTES } from "../src/viewer/schedules-view.ts";
import { ANSWER_MAX_BYTES, DELIVERIES, JOB_KINDS, MANDATE_ACTIONS, MANDATE_ASK_ON, MANDATE_CHANNELS, MANDATE_ID_PATTERN } from "../src/contracts.ts";
import { REPO_ROOT } from "./harness/index.ts";

test("the dependency-free schedule schema mirrors the contracts (the refusals themselves are P20-schedules-file)", () => {
	assert.deepEqual([...SCHEDULE_JOB_KINDS], [...JOB_KINDS]);
	assert.deepEqual([...SCHEDULE_DELIVERIES], [...DELIVERIES]);
	assert.equal(SCHEDULE_MANDATE_ID.source, MANDATE_ID_PATTERN);
	assert.equal(SCHEDULE_SCHEMA_VERSION, 2, "schedules v2 evolves independently of mandate schemas");
	assert.deepEqual([...GRANT_TEMPLATE_ASK_ON], [...MANDATE_ASK_ON]);
	assert.deepEqual([...GRANT_TEMPLATE_ACTIONS], MANDATE_ACTIONS.filter((action) => action !== "merge"), "a fire grant template never carries merge");
	assert.deepEqual([...MANDATE_CHANNEL_VALUES], [...MANDATE_CHANNELS]);
});

test("the expander registry and the answer cap mirror their sources (verbatim from two viewer-schedules tests)", () => {
	// Every schedule skill is a parent skill shipped as skills/<name>/SKILL.md, with a research/local anchor.
	for (const skill of SCHEDULE_SKILLS) {
		assert.ok((PARENT_SKILLS as readonly string[]).includes(skill), `${skill} is a parent skill`);
		assert.match(readFileSync(join(REPO_ROOT, "skills", skill, "SKILL.md"), "utf8"), new RegExp(`^name: ${skill}$`, "m"));
		assert.deepEqual(SCHEDULE_SKILL_ANCHOR[skill], { kind: "research", delivery: "local" });
	}
	assert.equal(SCHEDULE_ANSWER_MAX_BYTES, ANSWER_MAX_BYTES, "the viewer's cap mirrors the contract");
});
