/**
 * `cp_schedule run_now` starts a run of the schedule's active native revision from the session that holds the parent
 * lock: no quote, grant or ask (PR4 retired the legacy quote-per-run path). The real host (registerScheduleTools),
 * a real ledger, run store and scheduler.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerScheduleTools } from "../extensions/command-post/tools-schedule.ts";
import type { Delivery } from "../src/contracts.ts";
import { ParentCompactHold } from "../src/parent-compact-hold.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

type Execute = (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;

async function bench(t: { after(fn: () => void): void }, delivery: Delivery = "pr", deferParentWake: (deliver: () => void) => void = (deliver) => deliver()) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path, { runs: openScheduleRunStore(home.path) });
	const fleet = new FleetStore({ home: home.path });
	const dispatched: Array<{ jobId: string; task?: string }> = [];
	const post = { home: home.path, ledger: () => ledger, mandates, fleet, registry: { pathOf: () => home.path, archivedNames: () => [], get: (name: string) => (name === "demo" ? {} : undefined) }, dispatchQueue: { drain: async () => {} }, dispatch: async (request: { jobId: string; task?: string }) => { dispatched.push(request); } };
	const lock = { held: true };
	const sent: Array<{ customType: string; content: string; display: boolean; details: Record<string, unknown> }> = [];
	const options: Array<{ deliverAs: string; triggerTurn: boolean }> = [];
	let execute: Execute | undefined;
	registerScheduleTools(
		{ on: () => {}, registerTool: (tool: { name: string; execute: Execute }) => { if (tool.name === "cp_schedule") execute = tool.execute; }, sendMessage: (message: typeof sent[number], opts: typeof options[number]) => { sent.push(message); options.push(opts); } } as never,
		{ commandPost: () => post, setLive: () => {} } as never,
		() => lock.held, () => {}, () => {}, deferParentWake,
	);
	const said: string[] = [];
	const call = async (params: Record<string, unknown>, id = "call-x") => {
		const ctx = { sessionManager: { getEntries: () => said.map((content) => ({ type: "message", message: { role: "user", content } })) } };
		return (await execute!(id, params, undefined, undefined, ctx)).content[0]!.text;
	};
	said.push("Add the nightly schedule.");
	const kind = delivery === "answer" || delivery === "board" ? "research" : "ship"; // native ship never answers or publishes a board
	const added = await call({ action: "add", name: "nightly", project: "demo", manual: true, title: "Nightly fix", kind, delivery, operator_quote: "Add the nightly schedule." }, "call-add");
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, runs: mandates.scheduleRuns, usageJobs: () => fleet.read().jobs, cloneOf: () => home.path });
	const schedule = scheduler.list().find((entry) => added.includes(entry.id))!;
	const run = async (id = schedule.id, callId = "call-1", extra: Record<string, unknown> = {}) => call({ action: "run_now", id, ...extra }, callId);
	const jobs = () => ledger.list({ labels: [`schedule:${schedule.id}`], all: true });
	return { ledger, mandates, scheduler, schedule, added, lock, said, run, call, jobs, sent, options, dispatched };
}

test("adopt/deactivate tools require one naming quote, bind revisions and never mint a grant for a run", async (t) => {
	const b = await bench(t, "pr");
	const adopt = `Adopt ${b.schedule.id}.`;
	await assert.rejects(b.call({ action: "adopt", id: b.schedule.id, operator_quote: adopt, revision: 1 }), /quote not found/);
	b.said.push(adopt, "Yes, please.");
	await assert.rejects(b.call({ action: "adopt", id: b.schedule.id, operator_quote: "Yes, please.", revision: 1 }), /whole token/);
	b.lock.held = false; await assert.rejects(b.call({ action: "adopt", id: b.schedule.id, operator_quote: adopt, revision: 1 }), /fleet lock/); b.lock.held = true;
	await assert.rejects(b.call({ action: "adopt", id: b.schedule.id, operator_quote: adopt }), /needs revision/);
	assert.match(await b.call({ action: "adopt", id: b.schedule.id, operator_quote: adopt, revision: 1 }), /revision 2/);
	await assert.rejects(b.call({ action: "deactivate", id: b.schedule.id, operator_quote: adopt }), /already used/);
	await assert.rejects(b.run(b.schedule.id, "call-1", { revision: 1 }), /Schedule changed/);
	assert.match(await b.run(b.schedule.id, "call-2", { revision: 2 }), /no grant minted/);
	assert.deepEqual(b.mandates.list(), []);
	assert.equal(b.mandates.scheduleRuns.openRun(b.schedule.id)?.policy_revision, 2);
});

test("run_now starts a native run with no quote, wakes the parent for a pr fire, and replays its own tool call", async (t) => {
	const { schedule, added, run, jobs, sent, mandates } = await bench(t);
	assert.match(added, /native policy revision 1 saved and active/);
	const text = await run(schedule.id, "call-1", { operator_quote: "Run it." });
	assert.match(text, new RegExp(`schedule nightly \\(${schedule.id}\\) fired: created cp-\\S+ under run .*run now via cp_schedule \\(call-1\\)`));
	assert.match(text, /operator_quote is ignored; the saved native policy authorizes the run/);
	const [job] = await jobs();
	assert.match(job!.notes ?? "", new RegExp(`run now via cp_schedule \\(call-1\\) for ${schedule.id} \\(nightly\\) under run`));
	assert.deepEqual(job!.comments, [], "no quote is recorded: none authorized the run");
	assert.equal(sent.length, 1, "a pr fire wakes the parent like any other fire");
	assert.equal(sent[0]!.customType, "cp-schedule");
	assert.match(await run(schedule.id, "call-1"), /replayed/);
	assert.match(await run(schedule.id, "call-2"), /run now not recorded: already_running/);
	assert.equal((await jobs()).length, 1);
	assert.deepEqual(mandates.list(), []);
});

test("run_now refusals are each named and create no job", async (t) => {
	const { scheduler, schedule, lock, run, jobs } = await bench(t);
	lock.held = false;
	await assert.rejects(run(), /does not hold the parent lock/);
	lock.held = true;
	await assert.rejects(run("sch-ffffff"), /no schedule sch-ffffff/);
	await scheduler.setEnabled(schedule.id, false);
	await assert.rejects(run(), new RegExp(`schedule ${schedule.id} is disabled`));
	assert.deepEqual(await jobs(), []);
});

test("cp_schedule add: removed params (refire, approval_quote, mandate_id) are refused as unknown, and a quote is required", async (t) => {
	const { mandates, said, call } = await bench(t);
	said.push("Add triage.");
	const add = { action: "add", name: "triage", project: "demo", manual: true, title: "Triage", kind: "research", delivery: "answer", operator_quote: "Add triage." };
	await assert.rejects(call({ ...add, refire: true }), /cp_schedule add refused: unknown parameter refire; a schedule's bounds are its saved policy/);
	await assert.rejects(call({ ...add, approval_quote: "Yes." }), /cp_schedule add refused: unknown parameter approval_quote/);
	await assert.rejects(call({ ...add, mandate_id: "md-123456" }), /unknown parameter mandate_id/);
	await assert.rejects(call({ ...add, operator_quote: undefined }), /needs operator_quote/);
	assert.match(await call(add), /added sch-[0-9a-f]{6}.*\nnative policy revision 1 saved and active/s);
	assert.deepEqual(mandates.list(), [], "no seed, no grant");
});

test("held pr wake delays transport only: the job and run exist before release", async (t) => {
	const hold = new ParentCompactHold({ timer: () => () => {} });
	hold.settled({ over: true, raw: 210000, effective: 210000, threshold: 200000 });
	const b = await bench(t, "pr", (deliver) => { if (hold.offer(deliver) === "send") deliver(); });
	const text = await b.run();
	assert.match(text, /fired: created cp-/);
	assert.equal(b.sent.length, 0, "no parent transport during compaction hold");
	const [job] = await b.jobs();
	assert.ok(job);
	assert.match(await b.run(b.schedule.id, "call-2"), /already_running/);
	assert.equal((await b.jobs()).length, 1);
	hold.compacted();
	assert.equal(b.sent.length, 1);
	assert.deepEqual([b.sent[0]!.customType, b.sent[0]!.content, b.sent[0]!.details.job_id], ["cp-schedule", text, job.id]);
	assert.deepEqual(b.options, [{ deliverAs: "followUp", triggerTurn: true }]);
	hold.compacted();
	assert.equal(b.sent.length, 1);
	assert.deepEqual(b.mandates.list(), [], "release mints no grant");
});

for (const delivery of ["answer", "board", "local"] as const) test(`held parent still dispatches runner-owned ${delivery} fire immediately`, async (t) => {
	const offered: Array<() => void> = [];
	const b = await bench(t, delivery, (deliver) => { offered.push(deliver); });
	assert.match(await b.run(), /fired: created cp-/);
	const [job] = await b.jobs();
	assert.deepEqual(b.dispatched.map((request) => [request.jobId, request.task]), [[job!.id, "Nightly fix"]]);
	assert.deepEqual(offered, []);
	assert.deepEqual(b.sent, []);
});
