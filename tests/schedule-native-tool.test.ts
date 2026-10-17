/**
 * Native schedules through the real cp_schedule host (registerScheduleTools): add without mandate_id, run_now ignoring
 * operator_quote, and a fired native pipeline started by the host through startPipeline/handle, not by a parent wake.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { registerScheduleTools } from "../extensions/command-post/tools-schedule.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { PipelineRunner, type PipelineOptions } from "../src/pipeline.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { isNativePolicy } from "../src/viewer/schedule-policy.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

type Execute = (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;

function bench(t: { after(fn: () => void): void }, failStart = false) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const runs = openScheduleRunStore(home.path);
	const mandates = new MandateStore(home.path, { runs });
	const fleet = new FleetStore({ home: home.path });
	const dispatched: string[] = [];
	const dispatcher = () => ({ dispatch: async (request: { jobId: string }) => { dispatched.push(request.jobId); return { job_id: request.jobId }; } });
	const runner = new PipelineRunner({ home: home.path, ledger, dispatcher } as unknown as PipelineOptions);
	if (failStart) runner.start = async () => { throw new Error("pipeline store unwritable"); };
	const post = {
		home: home.path, ledger: () => ledger, mandates, fleet, pipeline: () => runner,
		registry: { pathOf: () => home.path, archivedNames: () => [], get: (name: string) => (name === "demo" ? {} : undefined) },
		dispatchQueue: { drain: async () => {} }, dispatch: async (request: { jobId: string }) => { dispatched.push(request.jobId); },
	};
	const sent: Array<{ content: string }> = [];
	let execute: Execute | undefined;
	registerScheduleTools(
		{ on: () => {}, registerTool: (tool: { name: string; execute: Execute }) => { if (tool.name === "cp_schedule") execute = tool.execute; }, sendMessage: (message: { content: string }) => { sent.push(message); } } as never,
		{ commandPost: () => post, setLive: () => {} } as never,
		() => true, () => {}, () => {}, (deliver) => deliver(),
	);
	const said: string[] = [];
	const call = async (params: Record<string, unknown>, id = "call-x") => {
		const ctx = { sessionManager: { getEntries: () => said.map((content) => ({ type: "message", message: { role: "user", content } })) } };
		return (await execute!(id, params, undefined, undefined, ctx)).content[0]!.text;
	};
	const add = (name: string, kind: string, delivery: string) => {
		said.push(`Add the ${name} schedule.`);
		return call({ action: "add", name, project: "demo", title: `${name} job`, kind, delivery, manual: true, operator_quote: `Add the ${name} schedule.`, limits: { parallelism: 2 } }, `add-${name}`);
	};
	const idOf = (text: string) => /\b(sch-[0-9a-z]+)/.exec(text)![1]!;
	return { ledger, runs, mandates, runner, dispatched, sent, said, call, add, idOf };
}

test("native add needs no mandate_id: a quote naming it saves an active native revision and writes no grant", async (t) => {
	const b = bench(t);
	b.said.push("Add a schedule.");
	await assert.rejects(b.call({ action: "add", name: "nightly", project: "demo", title: "x", kind: "ship", delivery: "pr", manual: true, operator_quote: "Add a schedule." }), /whole token/);
	await assert.rejects(b.call({ action: "add", name: "nightly", project: "demo", title: "x", kind: "ship", delivery: "pr", manual: true }), /needs operator_quote/);
	await assert.rejects(b.call({ action: "add", name: "nightly", project: "demo", title: "x", kind: "ship", delivery: "pr", manual: true, mandate_id: "md-x", limits: { usd: 1 } }), /unknown parameter mandate_id/);
	const text = await b.add("nightly", "ship", "pr");
	assert.match(text, /native policy revision 1 saved and active/);
	const policy = b.runs.activePolicy(b.idOf(text));
	assert.ok(isNativePolicy(policy)); assert.equal(policy.limits.parallelism, 2);
	assert.deepEqual(b.mandates.list(), [], "no seed grant");
});

test("native run_now ignores operator_quote, takes overrides and mints no grant", async (t) => {
	const b = bench(t);
	const id = b.idOf(await b.add("nightly", "ship", "pr"));
	const text = await b.call({ action: "run_now", id, operator_quote: "never said by anyone", overrides: { model: "mock/fast", parallelism: 1 } }, "call-run");
	assert.match(text, /fired/); assert.match(text, /operator_quote is ignored; the saved native policy authorizes the run/);
	const run = b.runs.openRun(id)!;
	assert.equal(run.start_key, "cp_schedule:call-run");
	assert.deepEqual(run.execution?.effective, { model: "mock/fast", parallelism: 1 });
	assert.deepEqual(b.mandates.list(), [], "no fire grant");
});

test("a fired native pipeline is started by the host through handle; only a failed start wakes the parent", async (t) => {
	const b = bench(t);
	const id = b.idOf(await b.add("research", "research", "pipeline"));
	await b.call({ action: "run_now", id }, "call-run");
	const run = b.runs.openRun(id)!;
	for (let i = 0; i < 50 && !b.runner.store.get(run.anchor_job_id!); i++) await tick();
	const record = b.runner.store.get(run.anchor_job_id!);
	assert.ok(record, "the host started the pipeline on the fired anchor");
	assert.deepEqual(b.dispatched, [run.anchor_job_id], "the planner was dispatched once");
	const ship = await b.ledger.show(record.ship_id);
	assert.ok(ship?.labels.includes(`schedule:${id}`));
	assert.ok(b.runs.run(run.id)!.members.some((member) => member.job_id === record.ship_id && member.role === "ship"));
	assert.deepEqual(b.sent, [], "a started pipeline wakes no parent");

	const broken = bench(t, true);
	const brokenId = broken.idOf(await broken.add("research", "research", "pipeline"));
	await broken.call({ action: "run_now", id: brokenId }, "call-run");
	for (let i = 0; i < 50 && broken.sent.length === 0; i++) await tick();
	assert.equal(broken.sent.length, 1);
	assert.match(broken.sent[0]!.content, /could not start its pipeline .*pipeline store unwritable/);
});
