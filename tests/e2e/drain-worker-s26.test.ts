import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { readDrain } from "../../src/drain.ts";
import { createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, MockProvider, REPO_ROOT, waitFor } from "../harness/index.ts";

for (const timeout of [false, true]) test(`S26: real worker ${timeout ? "times out and cancel retracts its outcome" : "reports while draining and produces one outcome"}`, { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "demo\n" } });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env }, holdsParentLock: () => true });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const pool = enableTreehouse(post.registry.pathOf("demo"), { maxTrees: 1 });
	t.after(async () => { await post.shutdown(); pool.cleanup(); agent.cleanup(); repo.cleanup(); home.cleanup(); await provider.stop(); });
	const job = await post.ledger().create({ title: "Drain worker", project: "demo", kind: "research", delivery: "pipeline", slug: "s26-drain" });
	const artifact = join(home.path, paths.artifactDir(job.id), "report.md");
	mkdirSync(join(home.path, paths.artifactDir(job.id)), { recursive: true });
	writeFileSync(artifact, "# Findings\nNo changes needed.\n");
	const script = timeout ? "s26-worker-timeout" : "s26-worker-settle";
	const model = provider.addScript(script, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "node -e 'setTimeout(() => {}, 4000)'" } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: job.id, kind: "research", status: "done", summary: "Drain evidence", artifact_path: artifact,
			plan_summary: { goal: "Verify drain", approach: ["Observe the worker report"], touched: ["README.md"], acceptance: ["Worker reports"], risk: "None" } } }] },
	]);
	agent.writeModels(provider);
	await post.dispatch({ jobId: job.id, model, task: "Report the supplied findings", fetch: false });
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 30_000, what: "real worker enters its model turn" });
	const started = post.drain.start(timeout ? 0 : 30);
	assert.equal(started.state, "draining");
	await assert.rejects(post.dispatch({ jobId: "cp-refused", task: "No new worker" }), /no dispatch starts/);
	assert.equal(post.drain.check()?.state, timeout ? "timeout" : "draining");
	if (timeout) {
		assert.deepEqual(post.drain.check()?.survivors, [job.id]);
		assert.match(post.drain.cancel(), /\(timeout\) is withdrawn/);
		assert.equal(existsSync(join(home.path, ".pi-command-post/state/drain.json")), false);
		assert.equal(post.durableWakeups.pending().filter((entry) => entry.id.startsWith(`drain:${started.started_at}:timeout`)).length, 0);
		assert.equal(post.durableWakeups.pending().filter((entry) => entry.id.endsWith(":cancelled")).length, 1);
	}
	await waitFor(() => post.fleet.get(job.id)?.reported_at, Boolean, { timeoutMs: 30_000, what: "report lands despite drain" });
	await waitFor(() => post.manager.quiesce().busy, (busy) => busy.length === 0, { timeoutMs: 30_000, what: "reporting turn settles" });
	if (!timeout) {
		const outboxPath = join(home.path, LAYOUT.wakeupsFile);
		const saved = existsSync(outboxPath) ? readFileSync(outboxPath, "utf8") : undefined;
		writeFileSync(outboxPath, "{broken");
		assert.throws(() => post.drain.check(), /JSON|json/);
		assert.equal(readDrain(home.path)?.reported, false, "a failed journal remains retryable");
		if (saved === undefined) rmSync(outboxPath); else writeFileSync(outboxPath, saved);
		assert.equal(post.drain.check()?.state, "drained");
		post.drain.check();
		const outcome = post.durableWakeups.pending().filter((entry) => entry.id === `drain:${started.started_at}:drained`);
		assert.equal(outcome.length, 1);
		assert.match(outcome[0]!.content, /safe to restart/);
		assert.match(outcome[0]!.content, new RegExp(job.id));
		assert.throws(() => post.drain.cancel(), /this parent drained/);
	}
	assert.equal(provider.remaining(script), 0);
});
