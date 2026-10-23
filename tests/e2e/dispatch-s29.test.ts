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
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { EMPTY_USAGE, isoTimestamp } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { MandateStore } from "../../src/mandate.ts";

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

test("S29: public validation refuses unavailable routing, effort, skills and inactive jobs", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const model = b.provider.addScript("worker", [{ kind: "text", text: "must not start" }]);
	const ordinary = await b.ledger.create({ title: "ordinary", project: "demo", delivery: "local", kind: "ship" });
	const blocker = await b.ledger.create({ title: "blocker", project: "demo", delivery: "local", kind: "ship" });
	const blocked = await b.ledger.create({ title: "blocked", project: "demo", delivery: "local", kind: "ship" });
	await b.ledger.addDep(blocked.id, blocker.id);
	const closed = await b.ledger.create({ title: "closed", project: "demo", delivery: "local", kind: "ship" });
	await b.ledger.close(closed.id, "done");
	const deferred = await b.ledger.create({ title: "deferred", project: "demo", delivery: "local", kind: "ship" });
	await b.ledger.update(deferred.id, { status: "deferred" });
	const variants = [
		{ job_id: ordinary.id, model: "mock/not-installed", expected: /no available model/ },
		{ job_id: ordinary.id, thinking: "xhigh", expected: /thinking=xhigh/ },
		{ job_id: ordinary.id, skills: ["not-installed"], expected: /skill not-installed is not installed/ },
		{ job_id: ordinary.id, skills: ["pi-subagents"], expected: /pi-subagents is never given/ },
		{ job_id: blocked.id, expected: /is blocked by/ },
		{ job_id: closed.id, expected: /is closed/ },
		{ job_id: deferred.id, expected: /is deferred/ },
	];
	const ends = await b.run(variants.map(({ expected, ...args }) => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { task: "Bump x.", model, queue: false, when_ready: false, ...args } }] })));
	assert.equal(ends.length, variants.length);
	for (let i = 0; i < variants.length; i++) await t.test(String(i), () => {
		assert.equal(ends[i]!.isError, true);
		assert.match(JSON.stringify(ends[i]!.result), variants[i]!.expected);
	});
	assert.deepEqual(readFleet(b.home).jobs, []);
	assert.equal(b.provider.remaining("worker"), 1);
	for (const job of [ordinary, blocked, deferred]) assert.equal(git(b.clone, "branch", "--list", job.id), "");
});

for (const profile of [undefined, "planner"] as const) {
	test(`S29: delivery answer selects ${profile ?? "qa"} and declares the artifact`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		if (profile) git(b.clone, "config", "--local", "command-post.repoMap", "false");
		const job = await b.ledger.create({ title: "Where is retry configured?", project: "demo", delivery: "answer", kind: "research" });
		const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Where is retry configured?", model, ...(profile ? { profile } : {}) } }] }]);
		assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends));
		assert.equal(ends[0]?.result.details?.profile, profile ?? "qa");
		const record = readFleet(b.home).jobs[0]!;
		assert.equal(record.kind, "research");
		assert.equal(record.delivery, "answer");
		assert.equal(record.worker.role, "planner");
		assert.ok(existsSync(join(b.home, paths.artifactDir(job.id))));
		const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
		assert.ok(brief.includes(join(b.home, paths.artifactFile(job.id))));
		if (!profile) {
			assert.match(brief, /a question about demo \(delivery: answer\)/);
			assert.match(brief, /under 8 KiB/);
		} else assert.doesNotMatch(brief, /## Repo map/);
	});
}

for (const capped of [true, false]) {
	test(`S29: selected grant ${capped ? "cap refuses" : "dispatches"} after public preview`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
		const job = await b.ledger.create({ title: "selected", project: "demo", delivery: "local", kind: "ship" });
		const mandates = new MandateStore(b.home);
		const base = { projects: ["demo"], objective: "dispatch", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 };
		mandates.issue({ ...base, at: isoTimestamp(new Date(Date.now() - 60_000)) });
		const selected = mandates.issue({ ...base, job_ids: [job.id, "cp-counted"], job_cap: capped ? 1 : 10 });
		await new FleetStore({ home: b.home }).add({ job_id: "cp-counted", project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase: "done", branch: "cp-counted", worktree: "/wt", dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, worker: { pid: 4242, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model, started_at: isoTimestamp() } });
		const args = { job_id: job.id, task: "Bump x.", model, queue: false, when_ready: false };
		const ends = await b.run([
			{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args, dry_run: true } }] },
			{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args }] },
		]);
		assert.equal(ends.length, 2);
		assert.equal(ends[0]!.result.details?.mandate_id, selected.id);
		if (capped) {
			assert.equal(ends[1]!.isError, true);
			assert.match(JSON.stringify(ends[1]!.result), new RegExp(`mandate ${selected.id} job cap 1 reached`));
			assert.equal(readFleet(b.home).jobs.some((record) => record.job_id === job.id), false);
			assert.equal(git(b.clone, "branch", "--list", job.id), "");
		} else {
			assert.notEqual(ends[1]!.isError, true, JSON.stringify(ends));
			assert.equal(ends[1]!.result.details?.mandate_id, selected.id);
		}
	});
}

test("S29: relative artifact handover preserves bytes while inline credentials refuse without echo", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const secret = "sk-ant-" + "abcdefghijklmnopqrstuvwxyz0123456789";
	const body = `# Plan\n\nExample credential: ${secret}\n`;
	writeFileSync(join(b.home, "task.md"), body);
	writeFileSync(join(b.home, "empty.md"), "  \n");
	const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
	const job = await b.ledger.create({ title: "artifact", project: "demo", delivery: "local", kind: "ship" });
	const refused = await b.ledger.create({ title: "inline", project: "demo", delivery: "local", kind: "ship" });
	const ends = await b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: refused.id, task: `line one\nline two\n${secret}\n`, model } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: refused.id, task_file: "empty.md", model } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task_file: "task.md", model } }] },
	]);
	assert.equal(ends[0]!.isError, true);
	assert.match(JSON.stringify(ends[0]!.result), /anthropic-style key \(line \d+\)/);
	assert.ok(!JSON.stringify(ends[0]!.result).includes(secret));
	assert.equal(ends[1]!.isError, true);
	assert.ok(JSON.stringify(ends[1]!.result).includes(`task file ${join(b.home, "empty.md")} is empty`));
	assert.notEqual(ends[2]!.isError, true, JSON.stringify(ends));
	const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
	assert.ok(brief.includes(join(b.home, "task.md")));
	assert.ok(!brief.includes(secret));
	assert.equal(readFileSync(join(b.home, paths.originalTaskFile(job.id)), "utf8"), body);
	assert.equal(readFileSync(join(b.home, "task.md"), "utf8"), body);
	assert.deepEqual(readFleet(b.home).jobs.map((record) => record.job_id), [job.id]);
});

test("S29: explicitly named skills reach a real planner worker and script jobs refuse them", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	for (const name of ["writing-plans", "tdd-x"]) {
		const dir = join(b.agent.path, "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: does ${name}\n---\nSkill text.\n`);
	}
	const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
	const job = await b.ledger.create({ title: "plan", project: "demo", delivery: "local", kind: "research" });
	const script = await b.ledger.create({ title: "script", project: "demo", delivery: "local", kind: "ship", scriptPath: "scripts/run.sh" });
	const args = { job_id: job.id, task: "Plan x.", model, profile: "planner", skills: ["writing-plans", "tdd-x"] };
	const ends = await b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { ...args, dry_run: true } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: script.id, skills: ["tdd-x"], dry_run: true } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: script.id, skills: ["tdd-x"] } }] },
	]);
	for (const i of [0, 1]) assert.notEqual(ends[i]!.isError, true, JSON.stringify(ends));
	assert.deepEqual(ends[0]!.result.details?.skills, ["writing-plans", "tdd-x"].map((name) => ({ name, dir: join(b.agent.path, "skills", name) })));
	assert.deepEqual(ends[1]!.result.details?.skills, ["writing-plans", "tdd-x"]);
	assert.deepEqual(readFleet(b.home).jobs[0]?.skills, ends[0]!.result.details?.skills);
	const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
	assert.match(brief, /writing-plans.*was attached by explicit operator mention/);
	assert.doesNotMatch(brief, /tdd-x.*was attached by explicit operator mention/);
	for (const i of [2, 3]) {
		assert.equal(ends[i]!.isError, true);
		assert.match(JSON.stringify(ends[i]!.result), /skills apply to pi workers/);
	}
});
