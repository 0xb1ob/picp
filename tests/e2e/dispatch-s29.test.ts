import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MOCK_PROVIDER_ID, MockProvider, startPiChild } from "../harness/index.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ProjectRegistry } from "../../src/projects.ts";
import { createScratchRepo, enableTreehouse, git, readFleet, readRunEvents } from "../harness/index.ts";

test("S29: cp_dispatch rejects ambiguous and missing task files without allocating resources", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const job = await scratch.ledger.create({ title: "task handover", project: "demo", delivery: "local", kind: "ship" });
	const provider = await MockProvider.start();
	const script = "s29-task-refusals";
	const model = `${MOCK_PROVIDER_ID}/${provider.modelId(script)}`;
	const missing = join(home.path, "missing.md");
	provider.addScript(script, [
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x.", task_file: missing, model, queue: false, when_ready: false } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task_file: missing, model, queue: false, when_ready: false } }] },
		{ kind: "text", text: "refusals observed" },
	]);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: [`${MOCK_PROVIDER_ID}/*`], rubric: [] }));
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); scratch.cleanup(); home.cleanup(); });
	await child.prompt(`dispatch ${job.id}`);
	await child.waitForSettled(60_000);
	const ends = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_dispatch") as Array<{ isError?: boolean; result?: unknown }>;
	assert.equal(ends.length, 2);
	for (const end of ends) assert.equal(end.isError, true, JSON.stringify(end.result));
	assert.match(JSON.stringify(ends[0]!.result), /pass task or taskFile, not both/);
	assert.ok(JSON.stringify(ends[1]!.result).includes(`task file ${missing} does not exist`));
	for (const path of [LAYOUT.fleetFile, paths.runDir(job.id), paths.briefFile(job.id), LAYOUT.sessions]) assert.equal(existsSync(join(home.path, path)), false, `refusal wrote ${path}`);
	assert.equal((await scratch.ledger.show(job.id)).status, "open");
	assert.equal(provider.remaining(script), 0);
});

for (const base of ["main", "trunk"]) {
	test(`S29: cp_dispatch freezes task handover and promotes the existing worker on ${base}`, { timeout: 120_000 }, async (t) => {
		const home = createScratchHome();
		const repo = createScratchRepo({ name: "demo", branch: base, files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
		const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
		const registry = new ProjectRegistry({ home: home.path });
		await registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
		const clone = registry.pathOf("demo");
		execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
		const pool = enableTreehouse(clone);
		const provider = await MockProvider.start();
		const workerModel = provider.addScript("s29-worker", [{ kind: "text", text: "task received" }]);
		const job = await scratch.ledger.create({ title: "handover", project: "demo", delivery: "local", kind: "ship" });
		const taskFile = join(home.path, "task.md");
		const body = "# Plan\n\nBump x to 2 in src/app.ts.\n";
		writeFileSync(taskFile, body);
		const model = provider.addScript("s29-parent", [
			{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task_file: taskFile, model: workerModel } }] },
			{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "do it again", model: workerModel } }] },
			{ kind: "text", text: "handover complete" },
		]);
		mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
		writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: [`${MOCK_PROVIDER_ID}/*`], rubric: [] }));
		const agent = createAgentDir({ provider });
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); pool.cleanup(); scratch.cleanup(); repo.cleanup(); home.cleanup(); });
		await child.prompt(`dispatch ${job.id}`);
		await child.waitForSettled(90_000);
		const ends = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_dispatch") as Array<{ isError?: boolean; result?: { details?: Record<string, unknown> } }>;
		assert.equal(ends.length, 2);
		for (const end of ends) assert.notEqual(end.isError, true, JSON.stringify(ends));
		const first = ends[0]!.result!.details!;
		assert.equal(first.state, "dispatched");
		assert.equal(first.receipt, "accepted");
		assert.equal(first.branch, job.id);
		assert.equal(first.model, workerModel);
		assert.equal(first.profile, "implementer");
		assert.equal(ends[1]!.result!.details!.state, "promote");
		assert.match(JSON.stringify(ends[1]!.result), /cp_send/);
		const records = readFleet(home.path).jobs;
		assert.equal(records.length, 1, "promotion takes no second lease");
		const record = records[0]!;
		assert.equal(record.schedule_id, undefined);
		assert.equal(record.worker.model, workerModel);
		assert.equal(record.worker.pid, first.pid);
		assert.ok(record.lease_id);
		assert.equal(git(record.worktree, "symbolic-ref", "--short", "HEAD"), job.id);
		assert.equal(git(record.worktree, "rev-parse", "HEAD"), git(clone, "rev-parse", `origin/${base}`));
		assert.equal(record.checkpoint_ref, `refs/cp-checkpoints/${job.id}`);
		assert.equal(git(record.worktree, "rev-parse", record.checkpoint_ref!), git(clone, "rev-parse", `origin/${base}`));
		const brief = readFileSync(join(home.path, paths.briefFile(job.id)), "utf8");
		assert.ok(brief.includes(taskFile));
		assert.ok(!brief.includes(body.trim()), "task file body stays out of the brief");
		assert.ok(brief.includes(`git merge origin/${base}`));
		assert.ok(brief.includes(`git rev-parse origin/${base}`));
		if (base === "trunk") assert.ok(!brief.includes("origin/main"));
		assert.ok(!brief.includes("${"));
		assert.equal(readFileSync(join(home.path, paths.originalTaskFile(job.id)), "utf8"), body);
		assert.equal(readFileSync(taskFile, "utf8"), body);
		assert.equal((await scratch.ledger.show(job.id)).status, "in_progress");
		const types = readRunEvents(home.path, job.id).map((event) => event.type);
		for (const type of ["spawned", "prompt_sent", "checkpoint_captured", "original_task_frozen", "routing_resolved"]) assert.ok(types.includes(type), type);
		assert.equal(provider.remaining("s29-parent"), 0);
	});
}
