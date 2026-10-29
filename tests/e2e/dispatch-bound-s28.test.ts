import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, git, readFleet, readRunEvents, startPiChild, treehouseAvailable, waitFor } from "../harness/index.ts";
import { json, startStack } from "./landing-helpers.ts";

for (const [kind, title] of [["queue", "S28: queued bound PR replays onto its existing branch"], ["armed", "S28: armed bound PR replays onto its existing branch"]] as const) {
	test(title, { skip: !treehouseAvailable(), timeout: 120_000 }, async (t) => {
		const f = await startStack(t, { github: true });
		git(f.repo.path, "branch", "bound-head");
		git(f.repo.path, "push", "origin", "bound-head");
		const head = git(f.repo.path, "rev-parse", "bound-head");
		f.setGh({ routes: [{ match: "pr view 169", replies: [json({ number: 169, url: "https://github.com/example/demo/pull/169", state: "OPEN", isDraft: true, isCrossRepository: false, headRefName: "bound-head", headRefOid: head, baseRefName: "main" })] }] });
		const job = await f.post.ledger().create({ title: "finish bound PR", project: "demo", kind: "ship", delivery: "pr" });
		const worker = f.provider.addScript(`bound-${kind}-worker`, [{ kind: "hang" }]);
		const parent = f.provider.addScript(`bound-${kind}-parent`, [{ kind: "text", text: "observed startup" }], { onExhausted: "repeat" });
		f.agentDir.writeModels(f.provider);
		const file = join(f.home, kind === "queue" ? LAYOUT.dispatchQueueFile : LAYOUT.armedDispatchFile);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ schema_version: 1, entries: [{ job_id: job.id, request: { task: "finish existing PR", pr: "169", model: worker }, ...(kind === "queue" ? { queued_at: "2026-10-04T15:00:00Z", attempts: 0 } : { armed_at: "2026-10-04T15:00:00Z", blockers: [] }) }] }));
		const child = startPiChild({ cwd: f.home, model: parent, env: { ...f.agentDir.env, CP_HOME: f.home }, extensions: [COMMAND_POST_EXTENSION] });
		t.after(() => child.close());
		await child.prompt("inspect the replayed bound PR");
		const record = await waitFor(() => readFleet(f.home).jobs.find((entry) => entry.job_id === job.id), (entry) => entry?.worker !== undefined, { timeoutMs: 60_000, what: "bound replay reaches worker" });
		assert.equal(record?.branch, "bound-head");
		assert.equal(record?.bound_pr?.number, 169);
		const routed = readRunEvents(f.home, job.id).findLast((event) => event.type === "routing_resolved")?.payload as Record<string, unknown>;
		assert.deepEqual([routed.source, routed.model], ["override", worker], "the replayed request's model stays the explicit override");
		assert.equal(git(record!.worktree, "branch", "--show-current"), "bound-head");
		await waitFor(() => JSON.parse(readFileSync(file, "utf8")).entries, (entries: unknown[]) => entries.length === 0, { timeoutMs: 30_000, what: "replayed entry removed" });
	});
}

test("S28: manual dispatch supersedes its armed request after removing the blocker", { skip: !treehouseAvailable(), timeout: 120_000 }, async (t) => {
	const f = await startStack(t);
	const blocker = await f.post.ledger().create({ title: "blocker", project: "demo", kind: "ship", delivery: "local" });
	const job = await f.post.ledger().create({ title: "dependent", project: "demo", kind: "ship", delivery: "local" });
	await f.post.ledger().addDep(job.id, blocker.id);
	const worker = f.provider.addScript("manual-worker", [{ kind: "hang" }]);
	const model = f.provider.addScript("manual-parent", [
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "manual task", model: worker } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_job", args: { action: "dep_remove", job_id: job.id, blocker_id: blocker.id } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "new manual task", model: worker } }] },
		{ kind: "text", text: "started" },
	]);
	f.agentDir.writeModels(f.provider);
	const child = startPiChild({ cwd: f.home, model, env: { ...f.agentDir.env, CP_HOME: f.home }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => child.close());
	await child.prompt("arm, remove the dependency, then dispatch the same job");
	await child.waitForSettled(60_000);
	const ends = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_dispatch") as Array<{ isError?: boolean; result?: unknown }>;
	assert.equal(ends.length, 2);
	for (const end of ends) assert.notEqual(end.isError, true, JSON.stringify(end.result));
	assert.match(JSON.stringify(ends[0]!.result), /"state":"armed"/);
	assert.match(JSON.stringify(ends[1]!.result), /"state":"dispatched"/);
	assert.deepEqual(JSON.parse(readFileSync(join(f.home, LAYOUT.armedDispatchFile), "utf8")).entries, [], "manual dispatch clears the old armed request");
	assert.equal(f.provider.remaining("manual-parent"), 0);
});

for (const [kind, title] of [["queue", "S28: queue rereads ownership between replayed entries"], ["armed", "S28: armed release rereads ownership between entries"]] as const) {
	test(title, { skip: !treehouseAvailable(), timeout: 120_000 }, async (t) => {
		const f = await startStack(t);
		const first = await f.post.ledger().create({ title: "first", project: "demo", kind: "ship", delivery: "local" });
		const second = await f.post.ledger().create({ title: "second", project: "demo", kind: "ship", delivery: "local" });
		const models = [first, second].map((job) => f.provider.addScript(`ownership-${job.id}`, [{ kind: "hang" }]));
		const model = f.provider.addScript(`ownership-parent-${kind}`, [{ kind: "text", text: "ownership checked" }], { onExhausted: "repeat" });
		f.agentDir.writeModels(f.provider);
		const file = join(f.home, kind === "queue" ? LAYOUT.dispatchQueueFile : LAYOUT.armedDispatchFile);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ schema_version: 1, entries: [first, second].map((job, n) => ({ job_id: job.id, request: { task: "check ownership", model: models[n] }, ...(kind === "queue" ? { queued_at: "2026-10-04T15:00:00Z", attempts: 0 } : { armed_at: "2026-10-04T15:00:00Z", blockers: [] }) })) }));
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const bin = join(f.home, "bin", "git");
		const lock = join(f.home, LAYOUT.parentLock);
		const takeover = JSON.stringify({ schema_version: 1, pid: process.pid, home: f.home, started_at: "2026-10-04T15:00:00Z" });
		writeFileSync(bin, `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args.includes("fetch")) fs.writeFileSync(${JSON.stringify(lock)}, ${JSON.stringify(takeover)});\nconst result = require("node:child_process").spawnSync(${JSON.stringify(realGit)}, args, {stdio:"inherit"});\nprocess.exit(result.status ?? 1);\n`);
		chmodSync(bin, 0o755);
		const child = startPiChild({ cwd: f.home, model, env: { ...f.agentDir.env, CP_HOME: f.home }, extensions: [COMMAND_POST_EXTENSION] });
		t.after(() => child.close());
		await child.prompt("inspect replay ownership");
		await waitFor(() => JSON.parse(readFileSync(file, "utf8")).entries, (entries) => entries.length === 1, { timeoutMs: 60_000, what: "first replay finishes after external git changes the owner" });
		await new Promise((resolve) => setTimeout(resolve, 5_000));
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries.map((entry: { job_id: string }) => entry.job_id), [second.id]);
		assert.equal(readFleet(f.home).jobs.filter((job) => job.job_id === first.id).length, 1);
		assert.equal(readFleet(f.home).jobs.some((job) => job.job_id === second.id), false);
	});
}
