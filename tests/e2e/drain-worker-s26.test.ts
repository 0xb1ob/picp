import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { hostUpdatePorts, runUpdate } from "../../src/service/update.ts";
import type { FleetRecord } from "../../src/contracts.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { parseDrainArgs, readDrain } from "../../src/drain.ts";
import { randomUUID } from "node:crypto";
import { createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, MockProvider, readRunEvents, REPO_ROOT, waitFor } from "../harness/index.ts";

for (const [mode, name] of [
	["delete", "S26: an external delete while actual outcome journaling blocks is never resurrected"],
	["activity", "S26: production updater dry-run classifies real busy, idle, unknown and script processes"],
	["spawn-race", "S26: a drain that starts during dispatch prevents the real worker spawn"],
	["death", "S26: a real worker death during drain refuses recovery without spending an attempt"],
	["settle", "S26: real worker reports while draining and produces one outcome"],
	["timeout", "S26: real worker times out and cancel retracts its outcome"],
	["cancel", "S26: cancelling a running drain leaves its real worker able to report"],
] as const) test(name, { timeout: 110_000 }, async (t) => {
	const timeout = mode === "timeout" || mode === "delete";
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
	const dispatch = post.dispatch({ jobId: job.id, model, task: "Report the supplied findings", fetch: false });
	if (mode === "spawn-race") {
		post.drain.start(30);
		await assert.rejects(dispatch, /no worker process.*starts/);
		assert.equal(provider.requests(script).length, 0);
		assert.equal(post.manager.active.length, 0);
		return;
	}
	await dispatch;
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 30_000, what: "real worker enters its model turn" });
	if (mode === "activity") {
		repo.git("commit", "--allow-empty", "-m", "Update candidate");
		repo.git("push", "origin", "main");
		const dataDir = join(home.path, LAYOUT.data);
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "update.json"), JSON.stringify({ enabled: true, interval_min: 1, quiet_min: 0 }));
		const update = () => runUpdate({ app: post.registry.pathOf("demo"), dataDir, stateDir: join(home.path, LAYOUT.state), dryRun: true }, hostUpdatePorts(home.path, { ...process.env, ...agent.env }));
		const busy = await update();
		assert.equal(busy?.last_result, "skipped_busy");
		assert.ok(busy?.detail?.includes(`mid-turn worker(s): ${job.id}`));
		await waitFor(() => post.fleet.get(job.id)?.reported_at, Boolean, { timeoutMs: 30_000, what: "worker report before idle update classification" });
		await waitFor(() => post.manager.quiesce().busy, (keys) => keys.length === 0, { timeoutMs: 30_000, what: "worker idle" });
		assert.equal(await update(), undefined, "idle live workers let a dry-run reach would drain/update");
		const { CP_BRIDGE_EXTENSION, startPiChild } = await import("../harness/index.ts");
		const { saveOperatorTarget } = await import("../../extensions/cp-bridge/index.ts");
		const { stopParentHosts } = await import("../harness/parent-hosts.ts");
		const previousHome = process.env.PI_HOME;
		process.env.PI_HOME = agent.path;
		saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
		if (previousHome === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previousHome;
		const parentModel = provider.addScript("s26-activity-parent", [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
		const operatorModel = provider.addScript("s26-activity-operator", [{ kind: "text", text: "Ready." }, { kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "start", home: home.path, mode: "multi", model: parentModel } }] }, { kind: "text", text: "Started." }, { kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "stop" } }] }, { kind: "text", text: "Stopped." }]);
		agent.writeModels(provider);
		const operator = startPiChild({ cwd: home.path, model: operatorModel, extensions: [CP_BRIDGE_EXTENSION], env: { ...agent.env, PI_HOME: agent.path, CP_HOME: home.path, CP_MODE: "multi" } });
		try {
			await operator.prompt("Persist the operator session.");
			await operator.waitForSettled(20_000);
			const startAt = operator.records().length;
			await operator.prompt("Start the parent.");
			const started = await operator.waitFor((row) => operator.records().indexOf(row) >= startAt && row.type === "tool_execution_end" && row.toolName === "cp_parent", 20_000);
			assert.match(JSON.stringify(started.result), /started pid=/);
			await operator.waitFor((row) => operator.records().indexOf(row) >= startAt && row.type === "agent_settled", 20_000);
			const before = operator.records().length;
			await operator.prompt("Stop the parent.");
			const reply = await operator.waitFor((row) => operator.records().indexOf(row) >= before && row.type === "tool_execution_end" && row.toolName === "cp_parent", 20_000);
			assert.match(JSON.stringify(reply.result), /warning: not drained; this kills 1 live worker/);
			await operator.waitFor((row) => operator.records().indexOf(row) >= before && row.type === "agent_settled", 20_000);
		} finally { await operator.close(); await stopParentHosts(home.path); }
		const statusFile = join(home.path, paths.statusFile(job.id));
		const status = readFileSync(statusFile, "utf8");
		for (const damaged of [undefined, "{broken status"]) {
			if (damaged === undefined) rmSync(statusFile); else writeFileSync(statusFile, damaged);
			const unknown = await update();
			assert.equal(unknown?.last_result, "skipped_busy");
			assert.ok(unknown?.detail?.includes(job.id), "absent/unreadable status fails closed");
		}
		writeFileSync(statusFile, status);
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		try {
			await once(child, "spawn");
			const { worker, ...base } = post.fleet.get(job.id)!;
			await post.fleet.add({ ...base, job_id: "cp-script", branch: "cp-script", kind: "ship", delivery: "local", executor: "script", script_path: "scripts/check.sh", script_process: { pid: child.pid!, started_at: isoTimestamp() } } as unknown as FleetRecord);
			const script = await update();
			assert.equal(script?.last_result, "skipped_busy");
			assert.match(script?.detail ?? "", /live script job\(s\): cp-script/);
			await post.fleet.mutate((jobs) => { const record = jobs.find((row) => row.job_id === "cp-script")!; record.script_process!.exited_at = isoTimestamp(); });
			await post.fleet.add({ ...post.fleet.get(job.id)!, job_id: "cp-done", branch: "cp-done", phase: "done" });
			await post.fleet.add({ ...post.fleet.get(job.id)!, job_id: "cp-exited", branch: "cp-exited", worker: { ...worker, exited_at: isoTimestamp() } });
			assert.equal(await update(), undefined, "exited script/worker and completed jobs do not hold an update");
		} finally {
			const closed = once(child, "exit");
			child.kill("SIGKILL");
			await closed;
		}
		await post.fleet.add({ ...post.fleet.get(job.id)!, job_id: "cp-dead", branch: "cp-dead", worker: { ...post.fleet.get(job.id)!.worker, pid: child.pid! } });
		assert.equal(await update(), undefined, "an unobserved dead worker with no status is not restart activity");
		return;
	}
	const started = post.drain.start(timeout ? 0 : 30);
	assert.equal(started.state, "draining");
	await post.reconcile();
	assert.equal(readDrain(home.path)?.state, "draining", "reconcile never clears this process's own drain");
	if (mode === "delete") {
		const outbox = join(home.path, LAYOUT.wakeupsFile);
		const contents = JSON.stringify(post.durableWakeups.read());
		rmSync(outbox, { force: true });
		execFileSync("mkfifo", [outbox]);
		// A FIFO holds real journal I/O while another process removes the drain.
		const writer = spawn(process.execPath, ["-e", "const fs = require('node:fs'); const fd = fs.openSync(process.argv[1], 'w'); fs.writeSync(fd, process.argv[3]); fs.rmSync(process.argv[2], {force:true}); fs.closeSync(fd);", outbox, join(home.path, LAYOUT.state, "drain.json"), contents], { stdio: "ignore" });
		const closed = once(writer, "exit");
		try {
			assert.equal(post.drain.check(), undefined, "the journal outlived an external delete");
			assert.equal(existsSync(join(home.path, LAYOUT.state, "drain.json")), false);
			assert.equal(post.durableWakeups.pending().filter((entry) => entry.id.endsWith(":timeout")).length, 1);
		} finally { writer.kill("SIGKILL"); await closed; }
		return;
	}
	if (mode === "death") {
		await post.manager.get(job.id)!.worker.kill("SIGKILL");
		const recovery = await post.recovery.onDeath(job.id, { class: "crash", message: "owned worker was killed", at: isoTimestamp() });
		assert.equal(recovery.action, "revive_refused");
		assert.match("reason" in recovery ? recovery.reason : "", /no automatic recovery.*starts/);
		assert.equal("attempted" in recovery && recovery.attempted, false);
		return;
	}
	if (mode === "settle") {
		await assert.rejects(post.send({ jobId: job.id, message: "After this turn", mode: "follow_up" }), /no promotion or follow_up send to busy/);
		await assert.rejects(post.send({ jobId: job.id, message: "New brief", task: "new scope" }), /no promotion or auto send to busy/);
		await assert.doesNotReject(post.send({ jobId: job.id, message: "Complete the original report." }));
	}
	await assert.rejects(post.dispatch({ jobId: "cp-refused", task: "No new worker" }), /no dispatch starts/);
	assert.equal(post.drain.check()?.state, timeout ? "timeout" : "draining");
	if (mode === "cancel") {
		assert.match(post.drain.cancel(), /\(draining\) is withdrawn/);
		assert.equal(readDrain(home.path), undefined);
		assert.equal(post.durableWakeups.pending().filter((entry) => entry.id.endsWith(":cancelled")).length, 1);
	}
	if (timeout) {
		assert.deepEqual(post.drain.check()?.survivors, [job.id]);
		assert.match(post.drain.cancel(), /\(timeout\) is withdrawn/);
		assert.equal(existsSync(join(home.path, ".pi-command-post/state/drain.json")), false);
		assert.equal(post.durableWakeups.pending().filter((entry) => entry.id.startsWith(`drain:${started.started_at}:timeout`)).length, 0);
		assert.equal(post.durableWakeups.pending().filter((entry) => entry.id.endsWith(":cancelled")).length, 1);
	}
	if (mode !== "settle") {
		await assert.rejects(post.dispatch({ jobId: "cp-refused", task: "No new worker" }), /unknown|no such|not found|does not exist/i);
		if (timeout) {
			await waitFor(() => isoTimestamp(), (stamp) => stamp !== started.started_at, { timeoutMs: 5000, what: "replacement drain gets its own timestamp" });
			const replacement = post.drain.start(30);
			assert.notEqual(replacement.started_at, started.started_at);
			assert.equal(replacement.state, "draining");
			assert.deepEqual(post.durableWakeups.pending().filter((entry) => entry.id.startsWith("drain:")).map((entry) => entry.id), [`drain:${started.started_at}:cancelled`]);
		}
	}
	await waitFor(() => post.fleet.get(job.id)?.reported_at, Boolean, { timeoutMs: 30_000, what: "report lands despite drain" });
	await waitFor(() => post.manager.quiesce().busy, (busy) => busy.length === 0, { timeoutMs: 30_000, what: "reporting turn settles" });
	if (mode === "settle") {
		await assert.rejects(post.send({ jobId: job.id, message: "New brief" }), /no promotion.*idle/);
		await assert.rejects(post.send({ jobId: job.id, message: "Idle steer", mode: "steer" }), /no promotion or steer send to idle/);
		const legacy = post.fleet.get(job.id)!;
		await post.fleet.mutate((jobs) => { delete jobs.find((row) => row.job_id === job.id)!.lease_id; });
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
		assert.deepEqual(readDrain(home.path)?.jobs, [{ job_id: job.id, phase: "held", lease: legacy.worktree, head: null }]);
		let stopped = false;
		const stop = post.manager.shutdown(job.id).then(() => { stopped = true; });
		await assert.rejects(post.send({ jobId: job.id, message: "Do not wait for the stop" }), /drain/);
		assert.equal(stopped, false, "a draining send refuses before waiting for the actual worker stop");
		await stop;
		await post.shutdown();
		await assert.rejects(post.revive(job.id), /drain/);
		const next = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
		try {
			await next.reconcile();
			assert.equal(readDrain(home.path), undefined, "a fresh parent clears the previous drain");
			const recovery = () => next.durableWakeups.pending().filter((entry) => entry.content.startsWith("RESTART AFTER DRAIN"));
			assert.equal(recovery().length, 1);
			assert.equal(recovery()[0]!.kind, "recovery");
			assert.ok(recovery()[0]!.content.includes(`${job.id} held, lease `));
			assert.match(recovery()[0]!.content, /head none/);
			await next.reconcile();
			assert.equal(recovery().length, 1, "the fresh parent's recovery is reported once");
			assert.equal(next.durableWakeups.pending().filter((entry) => entry.id.endsWith(":drained")).length, 0, "startup retracts the undelivered drain outcome");
			assert.equal(next.drain.start().state, "drained");
			assert.equal(next.drain.start().state, "drained", "starting again after settlement answers immediately");
			assert.equal(next.durableWakeups.pending().filter((entry) => entry.id.endsWith(":drained")).length, 0, "the immediate answer does not enqueue another outcome");
		} finally { await next.shutdown(); }
	}
	assert.equal(provider.remaining(script), 0);
});

test("S26: a freeze drain steers each mid-turn implementer to push its WIP, files no envelope and sends no nudge", { timeout: 150_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "demo\n" } });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env }, holdsParentLock: () => true });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const pool = enableTreehouse(post.registry.pathOf("demo"), { maxTrees: 2 });
	t.after(async () => { await post.shutdown(); pool.cleanup(); agent.cleanup(); repo.cleanup(); home.cleanup(); await provider.stop(); });
	// The first tool call holds each turn open until the test writes the gate, so the steer lands mid-turn.
	const gate = join(home.path, `freeze-gate-${randomUUID()}`);
	const hold = `node -e "const f=process.argv[1];const t=setInterval(()=>{if(require('fs').existsSync(f))clearInterval(t)},50)" ${gate}`;
	const jobs: Array<{ id: string; name: string; model: string }> = [];
	for (const n of [1, 2]) {
		const job = await post.ledger().create({ title: `Freeze ${n}`, project: "demo", kind: "ship", delivery: "pr", slug: `s26-freeze-${n}` });
		const name = `s26-freeze-${n}-${randomUUID()}`;
		const model = provider.addScript(name, [
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command: hold } }] },
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `printf 'wip ${n}\\n' > wip.txt && git add -A && git commit -q -m wip && git push -q -u origin ${job.id}` } }] },
			{ kind: "text", text: "Frozen." },
		]);
		jobs.push({ id: job.id, name, model });
	}
	agent.writeModels(provider);
	for (const job of jobs) await post.dispatch({ jobId: job.id, model: job.model, task: "Implement the change", fetch: false });
	await waitFor(() => post.manager.quiesce().busy, (busy) => busy.length === 2, { timeoutMs: 30_000, what: "both implementers mid-turn" });
	const parsed = parseDrainArgs("120 freeze")!;
	assert.deepEqual(parsed, { timeoutS: 120, cause: { reason: "freeze" } });
	assert.equal(post.drain.start(parsed.timeoutS, parsed.cause).state, "draining");
	const steered = await post.drain.freeze();
	for (const job of jobs) assert.ok(steered.some((line) => line.startsWith(`  freeze: ${job.id} steered (`)), steered.join("\n"));
	writeFileSync(gate, "open\n");
	for (const job of jobs) {
		const settled = await waitFor(() => readRunEvents(home.path, job.id).filter((event) => ["settled_without_report", "report_nudged"].includes(event.type)), (rows) => rows.length > 0, { timeoutMs: 60_000, what: `${job.id} settles` });
		assert.deepEqual(settled.map((event) => event.type), ["settled_without_report"]);
		assert.match(JSON.stringify(provider.requests(job.name)[1]?.body.messages ?? null), /FREEZE: /);
		assert.equal(provider.requests(job.name).length, 3, "no nudge restarts a frozen turn");
		assert.equal(readRunEvents(home.path, job.id).filter((event) => event.type === "report_nudged").length, 0);
		assert.equal(post.fleet.get(job.id)?.reported_at, undefined, "no envelope, so the job is never held");
	}
	assert.equal(post.drain.check()?.state, "drained");
	for (const job of jobs) {
		const pushed = repo.git("ls-remote", "origin", `refs/heads/${job.id}`).split("\t")[0]!.trim();
		assert.equal(readDrain(home.path)?.jobs.find((row) => row.job_id === job.id)?.head, pushed);
	}
});
