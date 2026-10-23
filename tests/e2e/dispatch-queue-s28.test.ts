import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type Job, LAYOUT, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, MockProvider, REPO_ROOT, startPiChild, treehouseAvailable, waitFor, type ScriptStep } from "../harness/index.ts";

test("S28: real spawn cap queues FIFO requests and arms blocked requests through cp_dispatch", { skip: !treehouseAvailable(), timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "demo\n" } });
	const provider = await MockProvider.start();
	const worker = provider.addScript("s28-busy-worker", [{ kind: "hang" }]);
	initJobsDocument(home.path, "cp");
	const setup = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await setup.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = setup.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 2 });
	const jobs: Job[] = [];
	for (let n = 0; n < 69; n++) jobs.push(await setup.ledger().create({ title: `queue ${n}`, project: "demo", delivery: "local", kind: "ship" }));
	for (let n = 35; n < 69; n++) await setup.ledger().addDep(jobs[n]!.id, jobs[0]!.id);
	await setup.shutdown();
	mkdirSync(dirname(join(home.path, LAYOUT.budgetsFile)), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.budgetsFile), JSON.stringify({ schema_version: SCHEMA_VERSION, per_job_tokens: 100000, per_job_cost_usd: 10, warn_ratio: 0.8, spawn_cap: 1 }));
	const args = (n: number) => ({ job_id: jobs[n]!.id, task: `hold ${n}`, model: worker });
	const steps: ScriptStep[] = [
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(0) }] },
		...Array.from({ length: 32 }, (_, n): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(n + 1) }] })),
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(1) }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args(33), queue: false } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(34) }] },
		...Array.from({ length: 32 }, (_, n): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(n + 35) }] })),
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args(35), task: "newer" } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args(67), when_ready: false } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(68) }] },
		{ kind: "text", text: "queued" },
	];
	const model = provider.addScript("s28-queue-parent", steps);
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); pool.cleanup(); repo.cleanup(); home.cleanup(); await provider.stop(); });
	await child.prompt("dispatch the scripted queue");
	await child.waitForSettled(90_000);
	const ends = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_dispatch") as Array<{ isError?: boolean; result?: unknown }>;
	assert.equal(ends.length, 71);
	assert.notEqual(ends[0]!.isError, true, JSON.stringify(ends[0]));
	for (let n = 1; n <= 32; n++) {
		assert.notEqual(ends[n]!.isError, true, JSON.stringify(ends[n]));
		assert.match(JSON.stringify(ends[n]!.result), new RegExp(`"position":${n}\\b`));
	}
	assert.match(JSON.stringify(ends[33]!.result), /already queued at position 1/);
	assert.match(JSON.stringify(ends[34]!.result), /spawn cap reached/);
	assert.match(JSON.stringify(ends[35]!.result), /queue is full/);
	const queue = JSON.parse(readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8"));
	assert.deepEqual(queue.entries.map((entry: { job_id: string }) => entry.job_id), jobs.slice(1, 33).map((job) => job.id));
	assert.deepEqual(queue.entries[0].request, { task: "hold 1", model: worker });
	for (let n = 36; n < 68; n++) {
		assert.notEqual(ends[n]!.isError, true, JSON.stringify(ends[n]));
		assert.match(JSON.stringify(ends[n]!.result), /"state":"armed"/);
	}
	assert.match(JSON.stringify(ends[68]!.result), /"rearmed":true/);
	assert.equal(ends[69]!.isError, true, "when_ready:false keeps the blocked refusal");
	assert.match(JSON.stringify(ends[70]!.result), /32 dispatches are already armed/);
	const armed = JSON.parse(readFileSync(join(home.path, LAYOUT.armedDispatchFile), "utf8"));
	assert.equal(armed.entries.length, 32);
	assert.equal(armed.entries.at(-1).job_id, jobs[35]!.id);
	assert.deepEqual(armed.entries.at(-1).request, { task: "newer", model: worker });
	assert.deepEqual(armed.entries.at(-1).blockers, [jobs[0]!.id]);
	assert.equal(provider.remaining("s28-queue-parent"), 0);
	steps.push(
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: jobs[0]!.id, force: true, operator_quote: `Force teardown ${jobs[0]!.id} and discard its unreported result.` } }] },
		{ kind: "text", text: "released" },
	);
	await child.prompt(`Force teardown ${jobs[0]!.id} and discard its unreported result.`);
	await child.waitFor((event) => event.type === "tool_execution_end" && event.toolName === "cp_teardown", 60_000);
	const teardown = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_teardown").at(-1) as { isError?: boolean; result?: unknown };
	assert.notEqual(teardown.isError, true, JSON.stringify(teardown.result));
	const after = await waitFor(() => JSON.parse(readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8")), (queue) => queue.entries.length !== 32, { timeoutMs: 30_000, what: "observed close drains queue" });
	assert.deepEqual(after.entries.map((entry: { job_id: string }) => entry.job_id), jobs.slice(2, 33).map((job) => job.id), "observed close starts only the FIFO head");
});
