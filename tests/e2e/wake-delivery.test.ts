import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, isoTimestamp, LAYOUT, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { CommandPost } from "../../src/command-post.ts";
import { FAILURE_CLASSES } from "../../src/contracts.ts";
import { checkWakeup, wakeupFacts } from "../../src/wakeups.ts";
import {
	COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor,
} from "../harness/index.ts";

test("S21: restart delivers an unobserved death once and discards obsolete fleet notices", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "s21-durable";
	const model = provider.addScript(script, [{ kind: "text", text: "Recovery notice received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => {
		for (const child of children) await child.close();
		agent.cleanup();
		home.cleanup();
		await provider.stop();
	});
	const fleet = new FleetStore({ home: home.path });
	const record = (jobId: string, phase: "failed" | "done" | "waiting"): FleetRecord => ({
		job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase,
		branch: jobId, worktree: join(home.path, "missing"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
		worker: { pid: phase === "waiting" ? process.pid : 1, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() },
		failure: { class: "crash", message: "legacy crash", at: isoTimestamp() },
	});
	await fleet.add(record("cp-live", "failed"));
	await fleet.add(record("cp-finished", "done"));
	for (const resumable of [false, true]) {
		const jobId = resumable ? "cp-revivable" : "cp-unsalvageable";
		const dead = record(jobId, "waiting");
		dead.worker.pid = 2147483647;
		if (resumable) {
			dead.worker.session_file = join(home.path, "surviving-session.jsonl");
			writeFileSync(dead.worker.session_file, "");
		}
		await fleet.add(dead);
	}
	const outbox = new DurableWakeupOutbox({ home: home.path, owner: "previous-parent" });
	outbox.enqueue({ id: "death:cp-gone:1", kind: "death", job_id: "cp-gone", keys: ["crash"], content: "S21_OBSOLETE_DEATH" });
	outbox.enqueue({ id: "death:cp-live:1", kind: "death", job_id: "cp-live", keys: ["crash"], content: "S21_LIVE_DEATH legacy crash" });
	const transportOwner = new CommandPost({ home: home.path, packageRoot: process.cwd(), holdsParentLock: () => true });
	t.after(() => transportOwner.shutdown());
	const facts = wakeupFacts({ record: (jobId) => fleet.get(jobId) });
	assert.throws(() => transportOwner.sweepDurableWakeups((entry) => {
		const verdict = checkWakeup({ kind: entry.kind, job_id: entry.job_id, keys: entry.keys, generation: entry.generation, issued_at: entry.queued_at }, facts);
		if (verdict.state === "superseded") return verdict.reason ?? "stale";
		writeFileSync(join(home.path, "absent-transport", "message"), entry.content);
		return true;
	}), /ENOENT/);
	assert.deepEqual(outbox.pending().map((entry) => entry.id), ["death:cp-live:1"]);
	assert.equal(outbox.read().discarded?.[0]?.id, "death:cp-gone:1");
	outbox.enqueue({ id: "recovery:finished", kind: "recovery", keys: ["cp-finished", "cp-gone"], content: "S21_OBSOLETE_RECOVERY" });
	for (const kind of ["death", "bound"] as const) {
		const jobId = `cp-waiting-${kind}`;
		await fleet.add(record(jobId, "waiting"));
		outbox.enqueue({ id: `${kind}:${jobId}:1`, kind, job_id: jobId, generation: 1, keys: [kind === "death" ? "crash" : "tool_call_cap_exceeded"], content: `S21_OBSOLETE_waiting_${kind}` });
	}
	outbox.enqueue({ id: "recovery:mixed", kind: "recovery", keys: ["cp-live", "cp-finished"], content: "S21_MIXED_RECOVERY" });
	assert.equal(outbox.enqueue({ id: "death:cp-live:1", kind: "death", job_id: "cp-live", keys: ["crash"], content: "S21_LIVE_DEATH legacy crash" }), false);
	outbox.drain(() => {});
	assert.equal(outbox.pending().length, 5, "transport handoff cannot confirm delivery");
	const launch = () => {
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		children.push(child);
		return child;
	};
	const first = launch();
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 10_000, what: "replayed death reaching the model" });
	await waitFor(() => outbox.read().delivered, (rows) => rows.some((row) => row.id === "death:cp-live:1") && rows.some((row) => row.id === "recovery:mixed"), { timeoutMs: 15_000, what: "observed death and mixed recovery arrivals" });
	await waitFor(() => outbox.pending().length, (n) => n === 0, { timeoutMs: 15_000, what: "startup reconciliation notice arrival" });
	const receivedText = () => JSON.stringify(provider.requests(script).map((r) =>
		(r.body.messages as Array<{ role: string }>).filter((message) => message.role !== "system")));
	await waitFor(() => receivedText().includes("RESTART RECOVERY"), Boolean,
		{ timeoutMs: 15_000, what: "reconciliation reaching the mock model" });
	const text = receivedText();
	assert.match(text, /S21_LIVE_DEATH/);
	assert.match(text, /S21_MIXED_RECOVERY/);
	assert.match(text, /RESTART RECOVERY/);
	assert.match(text, /cp-unsalvageable/);
	assert.match(text, /cp-revivable/);
	assert.match(text, /cp_revive/);
	assert.match(text, /cp_teardown/);
	assert.doesNotMatch(text, /poll/i);
	assert.equal(outbox.read().delivered.filter((row) => row.id.startsWith("recovery:cp-")).length, 1);
	assert.doesNotMatch(text, /S21_OBSOLETE/);
	assert.deepEqual(outbox.pending(), []);
	assert.equal(outbox.read().discarded?.length, 4, "obsolete notices are terminally discarded");
	await first.close();
	const before = provider.requests(script).length;
	const second = launch();
	second.send({ id: "ready", type: "get_commands" });
	await second.waitFor((r) => r.type === "response" && r.id === "ready", 30_000);
	await second.prompt("S21 restart inspection");
	await waitFor(() => provider.requests(script).length, (n) => n > before, { timeoutMs: 15_000, what: "restart inspection turn" });
	const restartText = JSON.stringify(provider.requests(script).slice(before).map((r) => r.body.messages));
	assert.doesNotMatch(restartText, /S21_LIVE_DEATH|S21_OBSOLETE/);
	assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.wakeupsFile), "utf8")).delivered.filter((row: { id: string }) => row.id === "death:cp-live:1").length, 1);
});


test("S21: host failure events survive restart with distinct CI causes and one arrival per class", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "s21-host-failures";
	const model = provider.addScript(script, [{ kind: "text", text: "Failure events received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	const post = new CommandPost({ home: home.path, packageRoot: process.cwd(), holdsParentLock: () => true });
	t.after(async () => {
		for (const child of children) await child.close();
		await post.shutdown();
		agent.cleanup();
		home.cleanup();
		await provider.stop();
	});
	for (const cls of FAILURE_CLASSES) {
		const jobId = `cp-${cls.replaceAll("_", "-")}`;
		await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase: "waiting",
			branch: jobId, worktree: join(home.path, jobId), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
			worker: { pid: 2147483647, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() } });
		if (cls === "spawn_failed") {
			// A legacy pre-event exit is replayed through the real close observer's event entry point.
			post.runs.open(jobId).cp("spawned", {});
			post.runs.open(jobId).cp("process_exit", { code: 2 });
			assert.equal((await post.failures.evaluate(jobId))?.class, cls);
		} else await post.fail(jobId, { class: cls, message: `S21_FAILURE_${cls}`, at: isoTimestamp() });
	}
	const prefix = "watch cause ".repeat(20);
	post.ciWatchFailed(new Error(`${prefix}HTTP 403`));
	post.ciWatchFailed(new Error(`${prefix}HTTP 502`));
	const pending = post.durableWakeups.pending();
	assert.equal(pending.length, FAILURE_CLASSES.length + 2);
	assert.equal(new Set(pending.map((entry) => entry.id)).size, pending.length);
	assert.ok(pending.every((entry) => entry.id.length <= 160));
	assert.ok(pending.some((entry) => entry.id.includes("HTTP 403")));
	assert.ok(pending.some((entry) => entry.id.includes("HTTP 502")));
	await post.shutdown();
	const outbox = new DurableWakeupOutbox({ home: home.path, owner: "observer" });
	const first = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	children.push(first);
	await waitFor(() => outbox.read().delivered.length, (n) => n === pending.length, { timeoutMs: 30_000, what: "every failure event arriving after restart" });
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 15_000, what: "failure consumer request" });
	const text = JSON.stringify(provider.requests(script).map((r) => (r.body.messages as Array<{ role: string }>).filter((message) => message.role !== "system")));
	for (const cls of FAILURE_CLASSES) {
		const queued = pending.find((entry) => entry.job_id === `cp-${cls.replaceAll("_", "-")}`);
		const row = outbox.read().delivered.find((entry) => entry.id === queued?.id);
		assert.ok(row, `${cls} has one durable arrival`);
		assert.equal(queued?.kind, cls === "wall_clock_exceeded" || cls === "tool_call_cap_exceeded" ? "bound" : "death");
		assert.match(text, new RegExp(cls === "spawn_failed" ? "spawn_failed" : `S21_FAILURE_${cls}`));
	}
	assert.match(text, /on disk:/);
	assert.match(text, /cp_teardown/);
	assert.doesNotMatch(text, /poll/i);
	assert.deepEqual(outbox.pending(), []);
	await first.close();
	const before = provider.requests(script).length;
	const second = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	children.push(second);
	await second.prompt("Inspect the restarted parent.");
	await waitFor(() => provider.requests(script).length, (n) => n > before, { timeoutMs: 15_000, what: "second host inspection" });
	assert.doesNotMatch(JSON.stringify(provider.requests(script).slice(before).map((r) => r.body.messages)), /S21_FAILURE_/);
});
