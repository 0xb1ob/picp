/**
 * Parent-expanded schedules (src/schedule-expand.ts): which deferred anchors still need the parent, which schedules
 * the runner must leave alone, the `schedule:` label refusal, and the shipped cp-self-review recipe's content.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, type Job } from "../src/contracts.ts";
import { formatExpansionWake, parentExpandedIds, pendingExpansions, readParentExpanded, readSchedulesOrEmpty, scheduleLabelRefusal } from "../src/schedule-expand.ts";
import type { Schedule } from "../src/viewer/schedule-core.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const expanded = { id: "sch-abc123", name: "self-review", project: "demo", mandate_id: "md-abcd", trigger: { type: "manual" }, job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" }, enabled: true, created_at: "2026-01-01T00:00:00Z" } as Schedule;
const cron = { ...expanded, id: "sch-def456", name: "nightly", trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, job: { title: "nightly", kind: "research", delivery: "answer" } } as Schedule;
const job = (overrides: Partial<Job>): Job => ({ id: "cp-a1b2", title: "t", project: "demo", status: "deferred", labels: ["schedule:sch-abc123"], comments: [], ...overrides }) as Job;

test("pendingExpansions: a deferred anchor without an `expanded:` comment, until it is marked or closed", () => {
	const schedules = [expanded, cron];
	const anchor = job({});
	assert.deepEqual(pendingExpansions([anchor], schedules).map((row) => [row.anchor.id, row.schedule.id]), [["cp-a1b2", "sch-abc123"]]);
	assert.deepEqual(pendingExpansions([job({ comments: [{ text: "note", at: "x", author: "y" }] })], schedules).length, 1, "another comment does not mark it");
	assert.deepEqual(pendingExpansions([job({ comments: [{ text: "expanded: L1 cp-1, S1 cp-2", at: "x", author: "y" }] })], schedules), []);
	assert.deepEqual(pendingExpansions([job({ status: "closed" })], schedules), []);
	assert.deepEqual(pendingExpansions([job({ status: "open" })], schedules), [], "only a deferred job is an anchor");
	assert.deepEqual(pendingExpansions([job({ labels: ["schedule:sch-def456"] })], schedules), [], "a cron schedule has no anchors");
	assert.deepEqual(pendingExpansions([anchor], []), []);
	assert.deepEqual([...parentExpandedIds(schedules)], ["sch-abc123"]);
	const wake = formatExpansionWake(anchor, expanded);
	assert.match(wake, /^\[demo\] schedule self-review \(sch-abc123\): cp-a1b2 is a parent-expanded run — use skill cp-self-review/);
	assert.match(wake, /Never dispatch cp-a1b2/);
});

test("readParentExpanded and readSchedulesOrEmpty: a missing or invalid schedules.json is the empty, fail-closed answer", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.deepEqual([...readParentExpanded(home.path)], []);
	const file = join(home.path, LAYOUT.state, "schedules.json");
	mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
	writeFileSync(file, "{not json");
	assert.deepEqual(readSchedulesOrEmpty(home.path), []);
	writeFileSync(file, JSON.stringify({ schema_version: 1, schedules: [expanded, cron] }));
	assert.deepEqual([...readParentExpanded(home.path)], ["sch-abc123"]);
});

test("scheduleLabelRefusal: a malformed id, a cron schedule's id, a schedule with no open anchor; allowed with one", () => {
	const schedules = [expanded, cron];
	assert.equal(scheduleLabelRefusal(["kind:research", "delivery:local"], [], schedules), undefined, "no schedule label, nothing to check");
	assert.match(scheduleLabelRefusal(["schedule:nope"], [], schedules) ?? "", /schedule:nope is not a schedule label/);
	assert.match(scheduleLabelRefusal(["schedule:sch-def456"], [job({ labels: ["schedule:sch-def456"] })], schedules) ?? "", /minted by a fire/);
	assert.match(scheduleLabelRefusal(["schedule:sch-ffffff"], [], schedules) ?? "", /minted by a fire/);
	assert.match(scheduleLabelRefusal(["schedule:sch-abc123"], [], schedules) ?? "", /no open run of schedule sch-abc123 \(Run now first\)/);
	assert.match(scheduleLabelRefusal(["schedule:sch-abc123"], [job({ status: "closed" })], schedules) ?? "", /no open run/);
	assert.equal(scheduleLabelRefusal(["schedule:sch-abc123"], [job({})], schedules), undefined);
});

test("the cp-self-review skill documents the recipe the plan fixes", () => {
	const text = readFileSync(join(REPO_ROOT, "skills/cp-self-review/SKILL.md"), "utf8");
	for (const part of [
		"name: cp-self-review", "L1", "L2", "L3-L5", "L6", "S1", "xai/grok-4.7", "xhigh", "10800", "36", "NEW", "ALREADY COVERED", "PARTIALLY COVERED",
		"[REDACTED]", "schedule:<id>", "expanded:", "window_hours", "never bare `br`", "no builds",
		"Context usage", "Context & compaction", "compactAtTokens", "self_compact", "cp-parent-control.json",
	]) assert.ok(text.includes(part), `SKILL.md mentions ${part}`);
});
