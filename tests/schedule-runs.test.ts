import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, type RiskPreapproval, type RiskPreapprovedRow } from "../src/contracts.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import type { Ledger } from "../src/ledger.ts";
import { Scheduler } from "../src/scheduler.ts";
import { openScheduleRunStore, reconcileRun, runIsSettled, runSpend, ScheduleRunStore, ScheduleRunsInactiveError, SCHEDULE_RUNS_ACTIVE } from "../src/schedule-runs.ts";
import { policyFromLegacy, type SchedulePolicy } from "../src/viewer/schedule-policy.ts";
import { readSchedulePolicies, readScheduleRuns, ScheduleRunError, scheduleRunErrors, type ScheduleRun } from "../src/viewer/schedule-run-core.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

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

test("active injection: durable round trip, membership cap and phase invariants", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const store = new ScheduleRunStore({ home: home.path, active: true });
	const input = run();
	await store.createRun(input);
	input.policy.recipe.title = "changed";
	assert.equal(store.run(input.id)?.policy.recipe.title, "Nightly report");
	await assert.rejects(store.createRun(run()), /duplicate run id/);
	await store.attachAnchor(input.id, member("cp-anchor"));
	await store.admitMember(input.id, { ...member("cp-child"), role: "reviewer" });
	await store.admitMember(input.id, member("cp-child"));
	await store.admitMember(input.id, member("cp-third"));
	await assert.rejects(store.admitMember(input.id, member("cp-over")), /child_jobs/);
	assert.equal(store.runOfJob("cp-child")?.id, input.id);
	assert.equal(store.openRun(input.schedule_id)?.id, input.id);
	await assert.rejects(store.attachAnchor(input.id, member("cp-child")), /anchor already/);
	await store.setPhase(input.id, "running");
	await assert.rejects(store.setPhase(input.id, "accepted"), /phase transition/);
	await assert.rejects(store.setPhase(input.id, "closed"), /closeRun/);
	for (let i = 0; i < 201; i++) await store.appendAuthority(input.id, { at, use: "dispatch", job_id: "cp-child", decision: "allowed", code: `row ${i}` });
	await store.noteCap(input.id, "token cap"); await store.noteCap(input.id, "token cap");
	assert.equal(store.run(input.id)?.authority_log.length, 200);
	assert.equal(store.run(input.id)?.authority_log[0]?.code, "row 1");
	assert.deepEqual(store.run(input.id)?.cap_notices, ["token cap"]);
	await store.closeRun(input.id, "completed", "2026-07-01T06:30:00Z");
	await assert.rejects(store.admitMember(input.id, member("cp-late")), /closed/);
	await assert.rejects(store.setPhase(input.id, "running"), /phase transition/);
	assert.equal(store.openRun(input.schedule_id), undefined);
	assert.equal(readScheduleRuns(store.runsFile)[0]?.outcome, "completed");
	assert.deepEqual(new ScheduleRunStore({ home: home.path, active: true }).runs(), store.runs());
});

test("policies preserve revisions, active pointer, snapshots and natural spaces", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const store = new ScheduleRunStore({ home: home.path, active: true });
	const p = policy();
	await store.savePolicyRevision(p);
	assert.equal(store.activePolicy(p.schedule_id), undefined);
	await store.activatePolicy(p.schedule_id, 1, at, { channel: "dashboard", request_id: "sc-1" });
	await store.createRun(run());
	p.revision = 2; p.recipe.title = "Next nightly report";
	await store.savePolicyRevision(p);
	await assert.rejects(store.activatePolicy(p.schedule_id, 1, at, { channel: "dashboard" }), /stale/);
	await assert.rejects(store.savePolicyRevision(p), /consecutive/);
	await store.activatePolicy(p.schedule_id, 2, at, { channel: "cp_schedule", tool_call_id: "tool 1" });
	assert.equal(store.activePolicy(p.schedule_id)?.recipe.title, "Next nightly report");
	assert.equal(store.runs()[0]?.policy.recipe.title, "Nightly report");
	assert.equal(store.activePolicy(p.schedule_id)?.recipe.description, "Keep natural spaces in metadata");
	await store.deactivatePolicy(p.schedule_id);
	assert.equal(store.activePolicy(p.schedule_id), undefined);
	assert.equal(readSchedulePolicies(store.policiesFile)[0]?.revisions.length, 2);
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

test("corrupt JSON and invalid contracts are named errors; failed validation preserves files", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const store = new ScheduleRunStore({ home: home.path, active: true });
	await store.createRun(run()); await store.savePolicyRevision(policy());
	const before = readFileSync(store.runsFile, "utf8");
	const bad = run(); bad.schedule_id = "sch-654321";
	await assert.rejects(store.createRun(bad), ScheduleRunError);
	assert.equal(readFileSync(store.runsFile, "utf8"), before);
	for (const file of [store.runsFile, store.policiesFile]) {
		writeFileSync(file, "{");
		assert.throws(() => file === store.runsFile ? store.runs() : store.policyRecord("sch-123456"), (e) => e instanceof ScheduleRunError && e.message.includes(file));
		writeFileSync(file, JSON.stringify({ schema_version: 99, runs: [] }));
		assert.throws(() => file === store.runsFile ? store.runs() : store.policyRecord("sch-123456"), ScheduleRunError);
	}
});

test("validators fail closed for nested fields, cap, audit bounds and dashboard-only preapproval", () => {
	for (const mutate of [
		(r: ScheduleRun) => Object.assign(r, { unknown: true }), (r: ScheduleRun) => Object.assign(r.trigger, { unknown: true }),
		(r: ScheduleRun) => { r.policy_revision = 2; }, (r: ScheduleRun) => { r.members = [member("cp-a"), member("cp-a")]; },
		(r: ScheduleRun) => { r.anchor_job_id = "cp-a"; }, (r: ScheduleRun) => { r.risk_preapproved = Array(201).fill({}); },
		(r: ScheduleRun) => { r.authority_log = Array(201).fill({}); }, (r: ScheduleRun) => { r.deadline_at = at; },
		(r: ScheduleRun) => { r.risk_preapproval = { operator_quote: "Review the queue", decided_by: "operator-quote", scope: "mandate_jobs", granted_at: at }; },
	]) { const r = run(); mutate(r); assert.ok(scheduleRunErrors(r).length); }
	// Compile-time parity with the contracts' dependency-bearing types.
	const pre: RiskPreapproval = { operator_quote: "Review the queue", decided_by: "operator-quote", scope: "mandate_jobs", granted_at: at };
	const row: RiskPreapprovedRow = { at, job_id: "cp-a", use: "dispatch", decided_by: "operator-delegated", quote_sha: "123456abcdef", evidence: [] };
	const r = run(); r.risk_preapproval = pre; r.risk_preapproved = [row];
});

test("spend includes worker and reviewer non-cached usage, settlement is membership-only, reconciliation is pure", () => {
	const r = run(); r.members = [member("cp-a"), member("cp-b"), member("cp-unstarted")];
	assert.deepEqual(runSpend(r, [
		{ job_id: "cp-a", project: "demo", phase: "waiting", usage: { cost_usd: 2, total_tokens: 100, cache_read: 60 }, reviewer_usage: { cost_usd: 3, total_tokens: 50, cache_read: 10 } },
		{ job_id: "cp-b", project: "demo", phase: "held", usage: { cost_usd: 1, total_tokens: 10, cache_read: 20 } },
		{ job_id: "cp-outside", project: "demo", phase: "launching", usage: { cost_usd: 100, total_tokens: 1000 } },
	]), { usd: 6, tokens: 80, inFlight: 1, members: 3 });
	assert.equal(runIsSettled(run(), []), false);
	assert.equal(runIsSettled(r, [{ id: "cp-a", status: "closed" }, { id: "cp-b", status: "closed" }]), false);
	assert.equal(runIsSettled(r, r.members.map((m) => ({ id: m.job_id, status: "closed" }))), true);
	const before = structuredClone(r);
	const recovered = reconcileRun(r, [{ id: "cp-wrong", status: "open", notes: `under run ${r.id}0` }, { id: "cp-a", status: "open", notes: `Created under run ${r.id}` }]);
	assert.equal(recovered.anchor_job_id, "cp-a"); assert.equal(recovered.members.length, 3); assert.deepEqual(r, before);
	const fresh = reconcileRun(run(), [{ id: "cp-anchor", status: "open", notes: `under run ${r.id}` }]);
	assert.equal(fresh.members[0]?.job_id, "cp-anchor");
});

test("S1: full legacy Scheduler fire mints normally and leaves both new files absent", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	let now = new Date(at);
	const mandates = new MandateStore(home.path, { now: () => now });
	const seed = mandates.issue({ projects: ["demo"], objective: "nightly", expiry: "2026-12-31T00:00:00Z", spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 5, at: "2026-06-01T00:00:00Z", schedule_grant: true });
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, usageJobs: () => [], cloneOf: () => home.path, now: () => now, startedAt: now, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }) });
	await scheduler.add({ name: "nightly", project: "demo", mandate_id: seed.id, cron: "0 7 * * *", tz: "UTC", title: "Nightly report", kind: "research", delivery: "answer" });
	now = new Date("2026-07-01T07:00:20Z");
	const [event] = await scheduler.tick();
	assert.equal(event?.outcome, "fired"); assert.notEqual(event?.mandate_id, seed.id);
	assert.match((await ledger.show(event!.job_id!)).notes ?? "", /under fire grant/);
	const store = openScheduleRunStore(home.path);
	assert.equal(existsSync(join(home.path, LAYOUT.state, "schedule-runs.json")), false);
	assert.equal(existsSync(store.policiesFile), false); assert.deepEqual(store.runs(), []);
});
