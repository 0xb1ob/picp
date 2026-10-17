import assert from "node:assert/strict";
import { test } from "node:test";
import { THINKING_LEVELS } from "../src/contracts.ts";
import { keepsHead } from "../src/dispatch-queue.ts";
import { EscalationStore } from "../src/escalation.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { PipelineRunner, type PipelineOptions } from "../src/pipeline.ts";
import { selectReviewerModel } from "../src/reviewer-model.ts";
import { ScheduleAuthorityError, scheduleRunVerdict } from "../src/schedule-authority.ts";
import { resolveExecution, startScheduledPipeline, withRunExecution } from "../src/schedule-native.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { Scheduler } from "../src/scheduler.ts";
import { isNativePolicy, RUN_THINKING_LEVELS, schedulePolicyErrors, type NativeSchedulePolicy } from "../src/viewer/schedule-policy.ts";
import { RUN_OPTION_THINKING, runOverrides } from "../viewer-app/schedule-control.ts";
import { scheduleControlFieldError } from "../src/viewer/control-files.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const ACTION = { saved_by: "operator-quote" as const, provenance: { channel: "cp_schedule" as const, tool_call_id: "call-add", quote_sha: "abcdef123456" } };

async function bench(t: import("node:test").TestContext, job: { kind: "research" | "ship"; delivery: "answer" | "pipeline" | "pr" } = { kind: "research", delivery: "answer" }) {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const ledger = createScratchLedger({ home: home.path, knownProjects: ["demo"] }).ledger;
	const now = new Date(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
	const runs = openScheduleRunStore(home.path);
	const mandates = new MandateStore(home.path, { runs, now: () => now });
	const defaults = structuredClone(loadMandateDefaults(home.path));
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, runs, usageJobs: () => [], cloneOf: () => home.path, now: () => now, mintContext: () => ({ defaults, ceiling: defaults.token_ceiling! }) });
	const schedule = await scheduler.add({ name: "nightly", project: "demo", native: { action: ACTION, limits: { parallelism: 2 } }, manual: true, title: "Nightly report", description: "Summarize the day.", ...job });
	return { home, ledger, runs, mandates, scheduler, schedule, now };
}

test("native add saves an activated native revision 1 and writes no grant", async (t) => {
	const b = await bench(t);
	assert.equal(b.schedule.mandate_id, undefined);
	assert.equal(b.schedule.grant_template, undefined);
	assert.deepEqual(b.mandates.list(), [], "no seed, no fire grant");
	const policy = b.runs.activePolicy(b.schedule.id);
	assert.ok(isNativePolicy(policy));
	assert.equal(policy.revision, 1); assert.equal(policy.mode, "report-only"); assert.deepEqual(policy.kinds, ["research"]);
	assert.equal(policy.limits.parallelism, 2);
	assert.equal("approval" in policy || "ask_on" in policy || "allowed_actions" in policy, false);
	await assert.rejects(b.scheduler.add({ name: "nightly", project: "demo", native: { action: ACTION, limits: {} }, manual: true, title: "x", kind: "research", delivery: "answer" }), /already has a schedule named/);
	await assert.rejects(b.scheduler.add({ name: "quoteless", project: "demo", manual: true, title: "x", kind: "research", delivery: "answer" }), /needs the operator's quote/);
	// The schedule is written first; a failed policy save removes it again, leaving neither schedule nor policy.
	const save = b.runs.savePolicyRevision.bind(b.runs);
	b.runs.savePolicyRevision = async () => { throw new Error("policy journal unwritable"); };
	await assert.rejects(b.scheduler.add({ name: "broken", project: "demo", native: { action: ACTION, limits: {} }, manual: true, title: "x", kind: "research", delivery: "answer" }), /unwritable/);
	b.runs.savePolicyRevision = save;
	assert.deepEqual(b.scheduler.list().map((entry) => entry.name), ["nightly"]);
	assert.ok((await b.scheduler.add({ name: "broken", project: "demo", native: { action: ACTION, limits: {} }, manual: true, title: "x", kind: "research", delivery: "answer" })).id);
});

test("native run_now needs no quote, freezes overrides, replays a start key and refuses stale or invalid input first", async (t) => {
	const b = await bench(t);
	const first = await b.scheduler.fireNow(b.schedule.id, { via: "cp_schedule", tool_call_id: "call-1" });
	assert.equal(first.outcome, "fired"); assert.equal(first.native, true);
	const run = b.runs.run(first.run_id!)!;
	assert.equal(run.start_key, "cp_schedule:call-1");
	assert.deepEqual(run.execution, { requested: {}, effective: { parallelism: 2 } });
	assert.deepEqual(b.mandates.list(), [], "a native start writes no grant");
	// A different request while the run is open is refused; the same request again (a restart) returns the original run.
	const busy = await b.scheduler.fireNow(b.schedule.id, { via: "dashboard", request_id: "sc-1", peer: null });
	assert.equal(busy?.outcome, "skipped"); assert.match(busy?.reason ?? "", /already_running/);
	const replay = await b.scheduler.fireNow(b.schedule.id, { via: "cp_schedule", tool_call_id: "call-1" });
	assert.equal(replay.replayed, true); assert.equal(replay.run_id, run.id);
	await b.runs.closeRun(run.id, "completed", b.now.toISOString().replace(/\.\d{3}Z$/, "Z"));
	await assert.rejects(b.scheduler.fireNow(b.schedule.id, { via: "cp_schedule", tool_call_id: "call-2", revision: 9 }), /Schedule changed/);
	const invalid = await b.scheduler.fireNow(b.schedule.id, { via: "cp_schedule", tool_call_id: "call-3", overrides: { parallelism: 99 } });
	assert.equal(invalid?.outcome, "skipped"); assert.match(invalid?.reason ?? "", /parallelism/);
	assert.equal(b.runs.runs().length, 1, "refused before any run is created");
	const second = await b.scheduler.fireNow(b.schedule.id, { via: "dashboard", request_id: "sc-2", peer: null, revision: 1, overrides: { model: "mock/fast", thinking: "low", parallelism: 1 } });
	assert.deepEqual(b.runs.run(second.run_id!)!.execution, { requested: { model: "mock/fast", thinking: "low", parallelism: 1 }, effective: { model: "mock/fast", thinking: "low", parallelism: 1 } });
	assert.equal(b.runs.activePolicy(b.schedule.id)?.revision, 1, "overrides never edit the saved policy");
});

test("native authority: risk:high runs without an ask; undeclared kind, report-only implement, merge and hard stops refuse", async (t) => {
	const b = await bench(t);
	const fired = await b.scheduler.fireNow(b.schedule.id, { via: "cp_schedule", tool_call_id: "call-1" });
	const job = { jobId: fired.job_id!, project: "demo", kind: "research" as const, risk: "high" as const };
	await b.mandates.assertDispatchAllowed(job);
	assert.equal(b.mandates.wouldAskRiskHigh(job, "high"), false);
	assert.deepEqual(new EscalationStore({ home: b.home.path }).list(), [], "no risk escalation");
	assert.deepEqual(b.mandates.list(), [], "no grant write");
	const ctx = b.mandates.runContext();
	const code = (fn: () => unknown): string => { try { fn(); return "permitted"; } catch (error) { assert.ok(error instanceof ScheduleAuthorityError); return error.code; } };
	assert.equal(code(() => scheduleRunVerdict(ctx, "implement", job, [])), "mode_refused");
	assert.equal(code(() => scheduleRunVerdict(ctx, "merge", job, [])), "action_not_allowed");
	assert.equal(code(() => scheduleRunVerdict(ctx, "dispatch", { ...job, text: "then force-push the branch" }, [])), "hard_stop");
	const ship = await b.ledger.create({ title: "ship it", project: "demo", kind: "ship", delivery: "pr", labels: [`schedule:${b.schedule.id}`] });
	await b.runs.admitMember(fired.run_id!, { job_id: ship.id, role: "ship", admitted_at: ship.created_at });
	assert.equal(code(() => scheduleRunVerdict(ctx, "dispatch", { jobId: ship.id, project: "demo", kind: "ship" }, [])), "kind_not_declared");
	assert.equal(keepsHead(new ScheduleAuthorityError("parallelism_full", "full")), true, "a full run keeps the dispatch queue head");
});

test("run execution reaches dispatch and the reviewer; a script recipe refuses model overrides", async (t) => {
	const b = await bench(t);
	const fired = await b.scheduler.fireNow(b.schedule.id, { via: "cp_schedule", tool_call_id: "call-1", overrides: { model: "mock/run", thinking: "high" } });
	const request = withRunExecution({ jobId: fired.job_id!, model: "mock/asked", task: "x" }, b.runs, "research");
	assert.equal(request.model, "mock/run"); assert.equal((request as { thinking?: string }).thinking, "high");
	const record = { job_id: fired.job_id!, project: "demo", kind: "research" } as Parameters<typeof selectReviewerModel>[0]["record"];
	assert.deepEqual(selectReviewerModel({ record, mandates: b.mandates }), { model: "mock/run", source: "schedule-run", run_id: fired.run_id, thinking: "high" });
	// The frozen run model beats an explicit reviewer model, as dispatch's withRunExecution does for the worker.
	assert.deepEqual(selectReviewerModel({ model: "mock/explicit", record, mandates: b.mandates }), { model: "mock/run", source: "schedule-run", run_id: fired.run_id, thinking: "high" });
	const policy = { ...structuredClone(b.runs.activePolicy(b.schedule.id) as NativeSchedulePolicy), recipe: { ...b.schedule.job, skill: null, script_path: "scripts/x.sh" } };
	assert.match(String((resolveExecution(policy, { model: "mock/x" }) as { refusal?: string }).refusal), /script/);
});

test("a native pipeline starts in code: one bound ship, labelled and admitted, never duplicated on replay", async (t) => {
	const b = await bench(t, { kind: "research", delivery: "pipeline" });
	const policy = b.runs.activePolicy(b.schedule.id) as NativeSchedulePolicy;
	assert.deepEqual(policy.kinds, ["research", "ship"]); assert.ok(policy.effects.includes("pull_request"));
	const fired = await b.scheduler.fireNow(b.schedule.id, { via: "cp_schedule", tool_call_id: "call-1" });
	const dispatched: string[] = [];
	const runner = new PipelineRunner({ home: b.home.path, ledger: b.ledger, dispatcher: () => ({ dispatch: async (r: { jobId: string }) => { dispatched.push(r.jobId); return { job_id: r.jobId }; } }) } as unknown as PipelineOptions);
	const starter = { start: runner.start.bind(runner), started: (id: string) => runner.store.get(id) !== undefined };
	// A crash after admitMember and addDep but before the pipeline store write: the replay finds that ship by its
	// run-suffixed title, admits it no second time and creates no other ship.
	const title = `ship: ${policy.recipe.title} (${fired.run_id})`;
	const early = await b.ledger.create({ title, project: "demo", kind: "ship", delivery: "pr", labels: [`schedule:${b.schedule.id}`] });
	await b.runs.admitMember(fired.run_id!, { job_id: early.id, role: "ship", admitted_at: early.created_at });
	await b.ledger.addDep(early.id, fired.job_id!);
	const membersBefore = b.runs.run(fired.run_id!)!.members.length;
	assert.match(await startScheduledPipeline(starter, b.runs, b.schedule, fired), /pipeline started/);
	const ships = (await b.ledger.list({ all: true })).filter((job) => job.title === title);
	assert.deepEqual(ships.map((job) => job.id), [early.id]);
	assert.deepEqual(dispatched, [fired.job_id]);
	const members = b.runs.run(fired.run_id!)!.members;
	assert.equal(members.length, membersBefore, "the replay admits nothing twice");
	assert.deepEqual(members.filter((member) => member.job_id === early.id).map((member) => member.role), ["ship"]);
	assert.deepEqual((await b.ledger.show(early.id))?.blocked_by, [fired.job_id], "one dependency, not two");
	assert.match(await startScheduledPipeline(starter, b.runs, b.schedule, fired), /already started/);
	assert.deepEqual(dispatched, [fired.job_id], "a replay dispatches nothing");
	// The plan checkpoint auto-authorizes under the write-mode policy; a flagged one and a merge still need a human.
	const ctx = b.mandates.runContext(), plan = { jobId: early.id, project: "demo", kind: "ship" as const, checkpoint: "ship" as const };
	assert.equal(scheduleRunVerdict(ctx, "implement", plan, []).source, "schedule-run");
	assert.throws(() => scheduleRunVerdict(ctx, "implement", { ...plan, gateFlags: { blocking_unknowns: false, destructive_scope: false, scope_growth: true } }, []), /flagged or final-fix/);
	assert.throws(() => scheduleRunVerdict(ctx, "merge", plan, []), /never merges/);
});

test("a native pipeline needs child_jobs >= 2, and a full run refuses its ship before the ship job exists", async (t) => {
	const b = await bench(t, { kind: "research", delivery: "pipeline" });
	const policy = b.runs.activePolicy(b.schedule.id) as NativeSchedulePolicy;
	assert.deepEqual(schedulePolicyErrors({ ...policy, limits: { ...policy.limits, child_jobs: 2 } }), []);
	assert.match(schedulePolicyErrors({ ...policy, limits: { ...policy.limits, child_jobs: 1 } }).join("; "), /child_jobs: a pipeline admits its anchor and its ship/);
	// A run whose cap is already spent (anchor + other members) must not leave an orphan ship behind the refusal.
	const fired = await b.scheduler.fireNow(b.schedule.id, { via: "cp_schedule", tool_call_id: "call-1" });
	const run = b.runs.run(fired.run_id!)!;
	for (let i = run.members.length; i < policy.limits.child_jobs; i++) await b.runs.admitMember(run.id, { job_id: `cp-fill-${i}`, role: null, admitted_at: run.members[0]!.admitted_at });
	const runner = new PipelineRunner({ home: b.home.path, ledger: b.ledger, dispatcher: () => ({ dispatch: async (r: { jobId: string }) => ({ job_id: r.jobId }) }) } as unknown as PipelineOptions);
	const starter = { start: runner.start.bind(runner), started: (id: string) => runner.store.get(id) !== undefined };
	await assert.rejects(startScheduledPipeline(starter, b.runs, b.schedule, fired), /cannot admit the ship/);
	assert.deepEqual((await b.ledger.list({ all: true })).filter((job) => job.title.startsWith("ship:")), [], "no ship created");
});

test("run thinking levels mirror the routing contract and the dashboard's run options", () => {
	assert.deepEqual([...RUN_THINKING_LEVELS], [...THINKING_LEVELS]);
	assert.deepEqual([...RUN_OPTION_THINKING], [...THINKING_LEVELS]);
	assert.equal(runOverrides(" ", "", ""), undefined);
	assert.deepEqual(runOverrides("mock/m", "low", "3"), { model: "mock/m", thinking: "low", parallelism: 3 });
	assert.equal(scheduleControlFieldError({ op: "run_now", overrides: { model: "mock/m", parallelism: 2 } }), undefined);
	assert.match(scheduleControlFieldError({ op: "enable", overrides: { parallelism: 2 } }) ?? "", /only for run_now/);
	assert.match(scheduleControlFieldError({ op: "run_now", overrides: { model: "no-provider" } }) ?? "", /provider\/model/);
	assert.match(scheduleControlFieldError({ op: "run_now", overrides: { thinking: "huge" } }) ?? "", /invalid run overrides/);
});
