/**
 * Retained verbatim from tests/schedule-runs.test.ts (P13c): a ScheduleRunStore built inactive, and two store
 * instances admitting into one run at once. Every parent opens one active store.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { ScheduleRunStore, ScheduleRunsInactiveError, SCHEDULE_RUNS_ACTIVE } from "../src/schedule-runs.ts";
import { policyFromLegacy, type SchedulePolicy } from "../src/viewer/schedule-policy.ts";
import type { ScheduleRun } from "../src/viewer/schedule-run-core.ts";
import { createScratchHome } from "./harness/index.ts";

const at = "2026-07-01T06:00:00Z";
function policy(): SchedulePolicy {
	return policyFromLegacy({ id: "sch-123456", name: "Nightly report", project: "demo", mandate_id: "md-123456", enabled: true, created_at: at, trigger: { type: "manual" }, job: { title: "Nightly report", kind: "research", delivery: "answer", description: "Keep natural spaces in metadata" } }, {
		seed_mandate_id: "md-123456", channel: "operator_chat", objective: "Nightly report", expiry_hours: 1, spend_usd: 10, spend_tokens: 1000, job_cap: 3,
		allowed_actions: ["plan", "review"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "Run the nightly report", decided_by: "operator-quote", approved_at: at },
	});
}
function run(): ScheduleRun {
	return { schema_version: 1, id: "run-20260701060000-abcdef", schedule_id: "sch-123456", policy_revision: 1, policy: policy(), trigger: { via: "slot", at }, anchor_job_id: null, members: [], phase: "accepted", outcome: null, started_at: at, deadline_at: "2026-07-01T07:00:00Z", risk_preapproved: [], authority_log: [], cap_notices: [] };
}
const member = (job_id: string) => ({ job_id, role: null, admitted_at: at });

test("explicit inactive store writes throw before touching either file; absent reads are empty", (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	assert.equal(SCHEDULE_RUNS_ACTIVE, true);
	const store = new ScheduleRunStore({home:home.path,active:false});
	assert.deepEqual(store.runs(), []);
	assert.equal(store.run("missing"), undefined);
	assert.equal(store.runOfJob("missing"), undefined);
	assert.equal(store.openRun("sch-123456"), undefined);
	assert.equal(store.policyRecord("sch-123456"), undefined);
	assert.equal(store.activePolicy("sch-123456"), undefined);
	const writes = [
		() => store.createRun(run()), () => store.attachAnchor("missing", member("cp-a")), () => store.admitMember("missing", member("cp-b")),
		() => store.setPhase("missing", "running"), () => store.closeRun("missing", "completed", at),
		() => store.appendAuthority("missing", { at, use: "dispatch", job_id: "cp-a", decision: "allowed" }), () => store.noteCap("missing", "usd"),
		() => store.editRun("missing", () => {}),
		() => store.savePolicyRevision(policy()), () => store.activatePolicy("sch-123456", 1, at, { channel: "dashboard", request_id: "sc-1" }), () => store.deactivatePolicy("sch-123456"),
	];
	for (const write of writes) assert.throws(write, (e) => e instanceof ScheduleRunsInactiveError && /SCHEDULE_RUNS_ACTIVE=false/.test(e.message));
	assert.equal(existsSync(store.runsFile), false); assert.equal(existsSync(store.policiesFile), false);
});

test("concurrent admissions across store instances serialize and cannot overrun the cap", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const a = new ScheduleRunStore({ home: home.path, active: true }), b = new ScheduleRunStore({ home: home.path, active: true });
	const r = run(); await a.createRun(r); await a.attachAnchor(r.id, member("cp-anchor"));
	const results = await Promise.allSettled([a.admitMember(r.id, member("cp-one")), b.admitMember(r.id, member("cp-one")), a.admitMember(r.id, member("cp-two")), b.admitMember(r.id, member("cp-three"))]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
	assert.deepEqual(a.run(r.id)?.members.map((m) => m.job_id), ["cp-anchor", "cp-one", "cp-two"]);
	assert.match((results[3] as PromiseRejectedResult).reason.message, /child_jobs/);
});
