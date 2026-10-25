/**
 * Retained from tests/schedule-expand.test.ts (P13b): the org run cap over a legacy run (no active native policy),
 * an earlier run's jobs, an unreadable created_at and the risk-raise check. 12-9 pins the native-run cap end to end.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "../src/contracts.ts";
import { scheduleLabelRefusal, scheduleRiskRefusal } from "../src/schedule-expand.ts";
import type { Schedule } from "../src/viewer/schedule-core.ts";

const expanded = { id: "sch-abc123", name: "self-review", project: "demo", mandate_id: "md-abcd", trigger: { type: "manual" }, job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" }, enabled: true, created_at: "2026-01-01T00:00:00Z" } as Schedule;
const job = (overrides: Partial<Job>): Job => ({ id: "cp-a1b2", title: "t", project: "demo", status: "deferred", labels: ["schedule:sch-abc123"], comments: [], ...overrides }) as Job;

test("scheduleLabelRefusal: a cp-org-pr-review run holds at most max_reviewers risk:high reviewers plus one synthesis; a re-create is never refused", () => {
	const org = { ...expanded, id: "sch-0a0b0c", name: "org", job: { title: "Org review", kind: "research", delivery: "local", skill: "cp-org-pr-review", description: "org: acme\nmax_reviewers: 2" } } as Schedule;
	const label = "schedule:sch-0a0b0c";
	const anchor = job({ id: "cp-anch", labels: [label], created_at: "2026-07-01T07:00:00Z" });
	const run = (id: string, risk: boolean) => job({ id, status: "open", labels: [label, ...(risk ? ["risk:high"] : [])], created_at: "2026-07-01T07:01:00Z" });
	const old = job({ id: "cp-old1", status: "closed", labels: [label, "risk:high"], created_at: "2026-06-01T00:00:00Z" });
	const r1 = run("cp-r001", true);
	const r2 = run("cp-r002", true);
	assert.equal(scheduleLabelRefusal([label], [anchor, old, r1], [org], { risk: "high" }), undefined, "an earlier run's jobs do not count");
	assert.match(scheduleLabelRefusal([label], [anchor, r1, r2], [org], { risk: "high" }) ?? "", /already has 2 reviewer job\(s\) \(max_reviewers 2\)/);
	assert.equal(scheduleLabelRefusal([label], [anchor, r1, r2], [org]), undefined, "the synthesis is not a reviewer");
	const s1 = run("cp-s001", false);
	assert.match(scheduleLabelRefusal([label], [anchor, r1, r2, s1], [org]) ?? "", /already has 3 job\(s\) \(max_reviewers 2 plus one synthesis\)/);
	assert.equal(scheduleLabelRefusal([label], [anchor, r1, r2, s1], [org], { reuseId: "cp-s001" }), undefined, "an idempotent re-create");
	// Another skill's run has no cap.
	assert.equal(scheduleLabelRefusal(["schedule:sch-abc123"], [job({}), ...Array.from({ length: 9 }, (_, i) => job({ id: `cp-x00${i}`, status: "open", labels: ["schedule:sch-abc123", "risk:high"] }))], [expanded], { risk: "high" }), undefined);
	// risk:high counts from the label alone, without the risk parameter.
	assert.match(scheduleLabelRefusal([label, "risk:high"], [anchor, r1, r2], [org]) ?? "", /already has 2 reviewer job\(s\)/);
	// Fail closed: a run job whose created_at does not read counts toward the run.
	const unreadable = job({ id: "cp-r003", status: "open", labels: [label, "risk:high"], created_at: "not a time" });
	assert.match(scheduleLabelRefusal([label], [anchor, r1, unreadable], [org], { risk: "high" }) ?? "", /already has 2 reviewer job\(s\)/);
	// A re-create of a reviewer already in the run passes; a re-create never counts the job twice.
	assert.equal(scheduleLabelRefusal([label], [anchor, r1, r2, s1], [org], { reuseId: "cp-r002", risk: "high" }), undefined);
	// Raising a run job to risk:high (cp_job update add_labels) is held to the reviewer cap.
	assert.match(scheduleRiskRefusal("cp-s001", ["risk:high"], [anchor, r1, r2, s1], [org]) ?? "", /already has 2 reviewer job\(s\)/);
	assert.equal(scheduleRiskRefusal("cp-s001", ["risk:high"], [anchor, r1, s1], [org]), undefined);
	assert.equal(scheduleRiskRefusal("cp-r001", ["risk:high"], [anchor, r1, r2, s1], [org]), undefined, "already risk:high");
	assert.equal(scheduleRiskRefusal("cp-s001", ["note"], [anchor, r1, r2, s1], [org]), undefined);
	assert.equal(scheduleRiskRefusal("cp-old1", ["risk:high"], [anchor, r1, r2, { ...old, labels: [label] }], [org]), undefined, "an earlier run's job");
});
