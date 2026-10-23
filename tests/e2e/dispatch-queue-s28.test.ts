import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type Job, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, MockProvider, REPO_ROOT, startPiChild, treehouseAvailable, waitFor, type ScriptStep } from "../harness/index.ts";

for (const [fence, title] of [
	["none", "S28: real spawn cap queues FIFO and arms dependencies"],
	["foreign-owner", "S28: a foreign owner fences queue release"],
	["drain", "S28: a drain fences queue release"],
	["mandate", "S28: mandate parallelism keeps the FIFO head"],
] as const) {
test(title, { skip: !treehouseAvailable(), timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "demo\n" } });
	const provider = await MockProvider.start();
	for (const name of ["tdd-x", "writing-plans"]) {
		const directory = join(home.path, "skills", name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: scratch acceptance skill\n---\nFollow the task.\n`);
	}
	const workerModels = Array.from({ length: 70 }, (_, n) => provider.addScript(`s28-busy-worker-${n}`, [{ kind: "hang" }]));
	initJobsDocument(home.path, "cp");
	const setup = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await setup.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = setup.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 2 });
	const jobs: Job[] = [];
	for (let n = 0; n < 70; n++) jobs.push(await setup.ledger().create({ title: `queue ${n}`, project: "demo", delivery: "local", kind: "ship" }));
	for (let n = 35; n < 70; n++) await setup.ledger().addDep(jobs[n]!.id, jobs[0]!.id);
	setup.pipelines.write({ schema_version: 1, research_id: jobs[68]!.id, ship_id: jobs[34]!.id, project: "demo", delivery: "local", state: "researching", created_at: "2026-10-04T15:00:00Z", updated_at: "2026-10-04T15:00:00Z" });
	await setup.shutdown();
	mkdirSync(dirname(join(home.path, LAYOUT.budgetsFile)), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.budgetsFile), JSON.stringify({ schema_version: SCHEMA_VERSION, per_job_tokens: 100000, per_job_cost_usd: 10, warn_ratio: 0.8, spawn_cap: 1 }));
	const args = (n: number) => ({ job_id: jobs[n]!.id, task: `hold ${n}`, model: workerModels[n]!, ...(n === 1 ? { skills: ["tdd-x", "writing-plans"] } : {}) });
	const steps: ScriptStep[] = [
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(0) }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args(34), pr: "" } }] },
		...Array.from({ length: 32 }, (_, n): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(n + 1) }] })),
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(1) }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args(33), queue: false } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(34) }] },
		...Array.from({ length: 32 }, (_, n): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(n + 35) }] })),
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args(35), task: "newer" } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args(67), when_ready: false } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(68) }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(69) }] },
		{ kind: "text", text: "queued" },
	];
	const model = provider.addScript("s28-queue-parent", steps);
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); pool.cleanup(); repo.cleanup(); home.cleanup(); await provider.stop(); });
	await child.prompt("dispatch the scripted queue");
	await child.waitForSettled(90_000);
	const allEnds = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_dispatch") as Array<{ isError?: boolean; result?: unknown }>;
	const invalid = allEnds.filter((end) => JSON.stringify(end.result).includes("not queued: refusing to write an invalid"));
	assert.equal(invalid.length, 1, "an empty PR request cannot corrupt the persisted queue");
	const ends = allEnds.filter((end) => !invalid.includes(end));
	assert.equal(ends.length, 72);
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
	assert.deepEqual(queue.entries[0].request, { task: "hold 1", model: workerModels[1], skills: ["tdd-x", "writing-plans"] });
	assert.equal("skills" in queue.entries[1].request, false);
	for (let n = 36; n < 68; n++) {
		assert.notEqual(ends[n]!.isError, true, JSON.stringify(ends[n]));
		assert.match(JSON.stringify(ends[n]!.result), /"state":"armed"/);
	}
	assert.match(JSON.stringify(ends[68]!.result), /"rearmed":true/);
	assert.equal(ends[69]!.isError, true, "when_ready:false keeps the blocked refusal");
	assert.match(JSON.stringify(ends[70]!.result), /belongs to a pipeline/);
	assert.match(JSON.stringify(ends[71]!.result), /32 dispatches are already armed/);
	const armed = JSON.parse(readFileSync(join(home.path, LAYOUT.armedDispatchFile), "utf8"));
	assert.equal(armed.entries.length, 32);
	assert.equal(armed.entries.at(-1).job_id, jobs[35]!.id);
	assert.deepEqual(armed.entries.at(-1).request, { task: "newer", model: workerModels[35] });
	assert.deepEqual(armed.entries.at(-1).blockers, [jobs[0]!.id]);
	assert.equal(provider.remaining("s28-queue-parent"), 0);
	if (fence === "none") {
		await setup.ledger().close(jobs[1]!.id, "dropped: superseded");
		await waitFor(() => JSON.parse(readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8")).entries.length, (length) => length === 31, { timeoutMs: 35_000, what: "closed head drops while spawn cap remains full" });
	}
	if (fence === "mandate") {
		setup.mandates.issue({ projects: ["demo"], objective: "ship queued jobs", expiry: new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, "Z"), spend_cap: { usd: 100, tokens: 1000000 }, job_cap: 100, dispatch_parallelism: 1 });
		const budgetFile = join(home.path, LAYOUT.budgetsFile);
		writeFileSync(budgetFile, JSON.stringify({ ...JSON.parse(readFileSync(budgetFile, "utf8")), spawn_cap: 2 }));
		const bytes = readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8");
		await new Promise((resolve) => setTimeout(resolve, 31000));
		assert.equal(readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8"), bytes, "parallelism refusal keeps FIFO head byte-identical with a free worker slot");
	}
	const lockFile = join(home.path, LAYOUT.parentLock);
	const originalLock = readFileSync(lockFile, "utf8");
	const drainFile = join(home.path, LAYOUT.state, "drain.json");
	if (fence === "foreign-owner") {
		await setup.ledger().close(jobs[35]!.id, "dropped: superseded");
		writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(originalLock), pid: process.pid }));
		const bytes = readFileSync(join(home.path, LAYOUT.armedDispatchFile), "utf8");
		await new Promise((resolve) => setTimeout(resolve, 31000));
		assert.equal(readFileSync(join(home.path, LAYOUT.armedDispatchFile), "utf8"), bytes, "foreign owner cannot release even a stale armed entry");
	}
	if (fence === "drain") writeFileSync(drainFile, JSON.stringify({ state: "draining", started_at: new Date().toISOString(), deadline: new Date(Date.now() + 60000).toISOString(), timeout_s: 60, jobs: [] }));
	if (fence === "drain" || fence === "mandate") {
		const bytes = readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8");
		steps.push({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: args(33) }] }, { kind: "text", text: "refused" });
		const count = child.eventsOfType("tool_execution_end").length;
		const settled = child.eventsOfType("agent_settled").length;
		await child.prompt("try another dispatch while capacity is fenced");
		await child.waitFor(() => child.eventsOfType("tool_execution_end").length > count, 60_000);
		const end = child.eventsOfType("tool_execution_end").at(-1) as { isError?: boolean; result?: unknown };
		assert.equal(end.isError, true);
		assert.match(JSON.stringify(end.result), fence === "drain" ? /draining/ : /parallelism/);
		assert.equal(readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8"), bytes, "other refusals never enqueue");
		await child.waitFor(() => child.eventsOfType("agent_settled").length > settled, 60_000);
	}
	steps.push(
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: jobs[0]!.id, force: true, operator_quote: `Force teardown ${jobs[0]!.id} and discard its unreported result.` } }] },
		{ kind: "text", text: "released" },
	);
	await child.prompt(`Force teardown ${jobs[0]!.id} and discard its unreported result.`);
	await child.waitFor((event) => event.type === "tool_execution_end" && event.toolName === "cp_teardown", 60_000);
	const teardown = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_teardown").at(-1) as { isError?: boolean; result?: unknown };
	assert.notEqual(teardown.isError, true, JSON.stringify(teardown.result));
	if (fence === "foreign-owner" || fence === "drain") {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8")).entries.length, 32, `${fence} keeps queue on observed close`);
		if (fence === "foreign-owner") writeFileSync(lockFile, originalLock);
		else unlinkSync(drainFile);
	}
	const after = await waitFor(() => JSON.parse(readFileSync(join(home.path, LAYOUT.dispatchQueueFile), "utf8")), (queue) => queue.entries.length < (fence === "none" ? 31 : 32), { timeoutMs: fence === "none" ? 5_000 : 35_000, what: "observed close drains queue" });
	assert.deepEqual(after.entries.map((entry: { job_id: string }) => entry.job_id), jobs.slice(fence === "none" ? 3 : 2, 33).map((job) => job.id), "observed close starts only the FIFO head");
	const brief = readFileSync(join(home.path, paths.briefFile(jobs[fence === "none" ? 2 : 1]!.id)), "utf8");
	if (fence === "none") assert.doesNotMatch(brief, /Skills the operator named for this job/);
	else assert.match(brief, /Skills the operator named for this job:.*tdd-x.*writing-plans/);
});
}
