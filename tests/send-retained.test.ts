/**
 * Retained from send.test.ts (P9g): rows that stub a worker's send, read the reviewer's copy, or drive the release
 * hook with fake workers. tests/e2e/send-p9g.test.ts owns every consumer-visible send outcome.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, paths } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { copyOriginalTask } from "../src/gate.ts";
import { EnvelopeIntake } from "../src/intake.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadProfile } from "../src/profiles.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender, SendError } from "../src/send.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readRunEvents,
	REPO_ROOT,
	type ScratchRepo,
	type ScriptStep,
	WORKER_REPORTER_EXTENSION,
	type FakeWorker,
	fakeWorker,
	fakeWorkerManager,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

interface Bench {
	home: string;
	fleet: FleetStore;
	manager: WorkerManager;
	sender: Sender;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	model: string;
	jobId: string;
	worker: import("../src/worker-process.ts").WorkerProcess;
	/** Job ids whose wall-clock round the sender restarted (`onPromptDelivered`). */
	rearmed: string[];
}

async function bench(
	t: { after(fn: () => void | Promise<void>): void },
	script: ScriptStep[],
	options: { jobId?: string; repo?: ScratchRepo } = {},
): Promise<Bench> {
	const jobId = options.jobId ?? "cp-send";
	const home = createScratchHome();
	const repo = options.repo ?? createScratchRepo({ name: "send" });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const model = provider.addScript("send", script);
	agentDir.writeModels(provider);

	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const runDir = join(home.path, paths.runDir(jobId));
	const profile = loadProfile(PROFILES_DIR, "implementer");
	const managed = manager.spawn({
		identity: { jobId, kind: "ship", delivery: "local", runDir, worktree: repo.path },
		profile,
		model,
		sessionDir: join(home.path, "sessions"),
	});
	const runs = new RunRegistry(home.path);
	runs.open(jobId).markSpawned({ pid: managed.worker.pid, model, profile: profile.frontmatter.name });
	runs.open(jobId).attach(managed.worker);

	const fleet = new FleetStore({ home: home.path });
	// Intake is wired the way the parent wires it: from the worker's own event
	// stream. Nothing here polls, and a script that never reports never fires it.
	const intake = new EnvelopeIntake({
		home: home.path,
		fleet,
		runs,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
	});
	const detach = intake.watch(jobId, managed.worker);
	const record: FleetRecord = {
		job_id: jobId,
		project: "send",
		kind: "ship",
		delivery: "local",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: managed.worker.pid as number,
			session_id: "s",
			session_file: join(home.path, "sessions/s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model,
			started_at: isoTimestamp(),
		},
		worktree: repo.path,
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
	await fleet.add(record);

	t.after(async () => {
		detach();
		await manager.shutdownAll();
		runs.closeAll();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	await managed.worker.getState(30_000);
	const rearmed: string[] = [];
	return {
		rearmed,
		home: home.path,
		fleet,
		manager,
		runs,
		intake,
		model,
		jobId,
		worker: managed.worker,
		sender: new Sender({ fleet, manager, runs, home: home.path, onPromptDelivered: (id) => rearmed.push(id) > 0 }),
	};
}

test("busy worker: steer and follow_up queue, a bare prompt fails honestly", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 2 && echo slept" } }] },
		{ kind: "text", text: "done with the slow thing" },
		{ kind: "text", text: "and the queued one" },
		{ kind: "text", text: "and the other queued one" },
	]);

	await b.sender.send({ jobId: b.jobId, message: "start the slow job" });
	await b.worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
	assert.equal(b.worker.busy, true);
	assert.deepEqual(b.rearmed, [b.jobId]);

	const steered = await b.sender.send({ jobId: b.jobId, message: "also check the tests" });
	assert.equal(steered.mode, "steer", "auto mode steers a busy worker");
	assert.equal(steered.receipt, "queued");
	assert.equal(steered.busy_before, true);

	const followUp = await b.sender.send({ jobId: b.jobId, message: "afterwards, update the README", mode: "follow_up" });
	assert.equal(followUp.receipt, "queued");

	// An explicit bare prompt while streaming is refused by pi; we report that.
	const bare = await b.sender.send({ jobId: b.jobId, message: "bare prompt", mode: "prompt" });
	assert.equal(bare.receipt, "failed");
	assert.ok(bare.error);

	const markers = readRunEvents(b.home, b.jobId)
		.filter((event) => event.source === "cp")
		.map((event) => event.type);
	assert.ok(markers.includes("steer_sent"));
	assert.ok(markers.includes("follow_up_sent"));
	assert.equal(markers.filter((type) => type === "prompt_sent").length, 2, "the refused prompt is logged too");
	assert.equal(
		(readRunEvents(b.home, b.jobId).find((e) => e.source === "cp" && e.type === "steer_sent")?.payload as { disposition?: string }).disposition,
		"queued",
	);
	// Steer, follow_up (queued) and the failed bare prompt never restart the wall clock.
	assert.deepEqual(b.rearmed, [b.jobId]);

	// pi started a run while the local busy flag still reads true: the receipt, not busy, decides the rearm.
	const real = b.worker.send.bind(b.worker);
	b.worker.send = async () => ({ receipt: "delivered", disposition: "started" });
	const late = await b.sender.send({ jobId: b.jobId, message: "busy flag lags", mode: "prompt" });
	assert.equal(late.receipt, "delivered");
	assert.deepEqual(b.rearmed, [b.jobId, b.jobId], "a delivered prompt rearms even when busy read true");
	b.worker.send = real;
});


test("a task replacement is applied only on a delivered receipt; a failed send mutates nothing", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }]);
	const originalTaskPath = join(b.home, paths.originalTaskFile(b.jobId));
	writeFileSync(originalTaskPath, "Original scope.");

	const managed = b.manager.get(b.jobId);
	assert.ok(managed);
	// Force the delivery itself to fail after every guard has already passed
	// (idle worker, mode resolves to "prompt"), so the only thing left to prove
	// is that the frozen-task replacement is gated on the receipt, not on
	// having validated and reached the send call.
	const originalSend = managed.worker.send.bind(managed.worker);
	managed.worker.send = async () => ({ receipt: "failed" as const, error: "simulated delivery failure" });
	t.after(() => {
		managed.worker.send = originalSend;
	});

	const result = await b.sender.send({ jobId: b.jobId, message: "scope change", task: "A different job entirely." });
	assert.equal(result.receipt, "failed");
	assert.equal(result.task_updated, undefined);
	assert.deepEqual(b.rearmed, [], "a failed delivery never restarts the wall clock");
	assert.equal(readFileSync(originalTaskPath, "utf8"), "Original scope.", "the frozen task is untouched by a failed delivery");
	assert.equal(b.fleet.require(b.jobId).task_generations, undefined);
	assert.equal(existsSync(join(b.home, paths.supersededOriginalTaskFile(b.jobId, 1))), false);
	assert.equal(
		readRunEvents(b.home, b.jobId).filter((event) => event.type === "original_task_updated").length,
		0,
	);
});


test("the diff reviewer/plan gate reads the latest generation, not a stale copy", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [
		{ kind: "text", text: "first" },
		{ kind: "text", text: "second" },
	]);
	writeFileSync(join(b.home, paths.originalTaskFile(b.jobId)), "Bump x to 2 in src/app.ts.");

	await b.sender.send({ jobId: b.jobId, message: "scope grew", task: "Bump x to 2 AND update the README." });
	await b.worker.waitForSettled(60_000);

	const scratch1 = mkdtempSync(join(tmpdir(), "cp-send-review-input-"));
	const copy1 = copyOriginalTask({ home: b.home, jobId: b.jobId, scratch: scratch1 });
	assert.equal(readFileSync(copy1 as string, "utf8"), "Bump x to 2 AND update the README.");

	const dir = mkdtempSync(join(tmpdir(), "cp-send-task-"));
	const taskFile = join(dir, "task.md");
	writeFileSync(taskFile, "Bump x to 2, update the README, and add a changelog entry.");
	await b.sender.send({ jobId: b.jobId, message: "one more scope change", taskFile, model: b.model });

	const scratch2 = mkdtempSync(join(tmpdir(), "cp-send-review-input-"));
	const copy2 = copyOriginalTask({ home: b.home, jobId: b.jobId, scratch: scratch2 });
	assert.equal(
		readFileSync(copy2 as string, "utf8"),
		"Bump x to 2, update the README, and add a changelog entry.",
		"the reviewer's copy reflects generation 2, not generation 1 or the original dispatch text",
	);
});


// ---------------------------------------------------------------------------
// 4b-1 (4B1-T5): restore on send — fake workers, no child process
// ---------------------------------------------------------------------------

async function releaseBench(t: { after(fn: () => void | Promise<void>): void }, options: { reviveFails?: boolean; mandates?: (home: string) => MandateStore } = {}) {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	const fleet = new FleetStore({ home: home.path });
	const workers = fakeWorkerManager(home.path, 3);
	t.after(async () => {
		await workers.manager.shutdownAll();
		runs.closeAll();
		home.cleanup();
	});
	const jobId = "cp-aaa1";
	await fleet.add({
		job_id: jobId, project: "example-app", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held",
		worker: { pid: 4242, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/unused", started_at: isoTimestamp() },
		worktree: home.path, branch: jobId, dispatched_at: isoTimestamp(new Date(Date.now() - 30_000)), reported_at: isoTimestamp(), usage: EMPTY_USAGE,
	});
	const released = new Set<string>();
	const revived: string[] = [];
	let restored: FakeWorker | undefined;
	const sender = new Sender({
		fleet, manager: workers.manager, runs, home: home.path,
		...(options.mandates ? { mandates: options.mandates(home.path) } : {}),
		released: (id) => released.has(id),
		revive: async (id) => {
			revived.push(id);
			if (options.reviveFails) throw new Error(`cannot revive ${id} (pid_alive)`);
			restored = workers.spawn(id);
		},
	});
	return { home: home.path, jobId, workers, sender, released, revived, restored: () => restored };
}

test("4B1-T5: a send during a release never reaches the stopping worker; it waits, restores, then delivers", async (t) => {
	const b = await releaseBench(t);
	let exit!: () => void;
	const old = b.workers.spawn(b.jobId, fakeWorker({ shutdown: (worker) => new Promise<void>((resolve) => {
		exit = () => {
			worker.exit();
			resolve();
		};
	}) }));
	const stopping = b.workers.manager.shutdown(b.jobId);
	b.released.add(b.jobId);
	const sending = b.sender.send({ jobId: b.jobId, message: "fix the review findings" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(b.sender.sending(b.jobId), true);
	assert.deepEqual(old.sent, [], "nothing is delivered into a worker being released");
	assert.deepEqual(b.revived, []);
	exit();
	await stopping;
	const result = await sending;
	assert.equal(result.receipt, "delivered");
	assert.deepEqual(b.revived, [b.jobId], "restored once");
	assert.match(b.restored()?.sent[0] ?? "", /^fix the review findings/);
	assert.deepEqual(old.sent, []);
	assert.equal(b.sender.sending(b.jobId), false);
});

test("4B1-T5: a dead job that was not released keeps today's cp_revive refusal; sending() clears after a throw", async (t) => {
	const b = await releaseBench(t);
	await assert.rejects(b.sender.send({ jobId: b.jobId, message: "go" }), (error: unknown) => {
		assert.ok(error instanceof SendError);
		assert.match(error.message, /has no live worker in this session.*cp_revive cp-aaa1/s);
		return true;
	});
	assert.deepEqual(b.revived, []);
	assert.equal(b.sender.sending(b.jobId), false);
});

test("4B1-T5: a repair refusal comes before any revive; a revive refusal is surfaced", async (t) => {
	const refused = await releaseBench(t, { mandates: (home) => {
		const store = new MandateStore(home);
		const grant = store.issue({ projects: ["example-app"], objective: "Repair original work",
			expiry: isoTimestamp(new Date(Date.now() - 2_000)), at: isoTimestamp(new Date(Date.now() - 60_000)),
			spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 1, ask_on: [] });
		store.pause(grant.id, "spend_cap");
		return store;
	} });
	refused.released.add(refused.jobId);
	await assert.rejects(refused.sender.send({ jobId: refused.jobId, message: "fix CI", purpose: "repair" }), /paused/);
	assert.deepEqual(refused.revived, []);

	const failing = await releaseBench(t, { reviveFails: true });
	failing.released.add(failing.jobId);
	await assert.rejects(failing.sender.send({ jobId: failing.jobId, message: "go" }), (error: unknown) => {
		assert.ok(error instanceof SendError);
		assert.match(error.message, /has no live worker in this session/);
		assert.match(error.message, /Restoring the released worker failed: cannot revive cp-aaa1 \(pid_alive\)/);
		return true;
	});
});

// ---------------------------------------------------------------------------
// P2 (cp-35d0 S5): a policy-blocked transcript takes no new work
// ---------------------------------------------------------------------------

const POLICY_MARKER = JSON.stringify({ type: "custom", customType: "worker-compaction-policy-block", data: { errorMessage: "content_filter" } });

test("S5: every send mode refuses a policy-blocked session before restore, envelope reopen, settle clear or delivery", async (t) => {
	const b = await releaseBench(t);
	const sessionFile = join(b.home, "s.jsonl");
	writeFileSync(sessionFile, `{"type":"session"}\n${POLICY_MARKER}\n`);
	const fleet = new FleetStore({ home: b.home });
	await fleet.patch(b.jobId, { unreported_settles: 1 });
	const before = fleet.require(b.jobId);
	const live = b.workers.spawn(b.jobId);
	const sends = [
		{ message: "go" },
		...(["auto", "prompt", "steer", "follow_up"] as const).map((mode) => ({ message: "go", mode })),
		{ message: "go", task: "new scope" },
		{ message: "fix CI", purpose: "repair" as const },
	];
	for (const request of sends) {
		await assert.rejects(b.sender.send({ jobId: b.jobId, ...request }), (error: unknown) => {
			assert.ok(error instanceof SendError);
			assert.ok(error.message.includes(sessionFile) && /worker-compaction-policy-block.*keep the lease/s.test(error.message), error.message);
			return true;
		});
	}
	assert.deepEqual(live.sent, [], "nothing delivered");
	assert.deepEqual(new FleetStore({ home: b.home }).require(b.jobId), before, "no envelope reopen or settle clear");

	await b.workers.manager.shutdown(b.jobId);
	b.released.add(b.jobId);
	await assert.rejects(b.sender.send({ jobId: b.jobId, message: "go" }), /worker-compaction-policy-block/);
	assert.deepEqual(b.revived, [], "a released worker is never restored onto a blocked transcript");
});

test("S5: a malformed session is a named refusal; marker-looking prose and an unwritten session still deliver", async (t) => {
	const b = await releaseBench(t);
	const sessionFile = join(b.home, "s.jsonl");
	const live = b.workers.spawn(b.jobId);
	writeFileSync(sessionFile, `{"type":"session"}\n{"type":"cust\n`);
	await assert.rejects(b.sender.send({ jobId: b.jobId, message: "go" }), (error: unknown) => {
		assert.ok(error instanceof SendError);
		assert.match(error.message, /worker session .*s\.jsonl line 2 is not valid JSON/);
		return true;
	});
	assert.deepEqual(live.sent, []);

	const prose = { type: "message", message: { role: "user", content: [{ type: "text", text: POLICY_MARKER }] } };
	writeFileSync(sessionFile, `${JSON.stringify(prose)}\n`);
	assert.equal((await b.sender.send({ jobId: b.jobId, message: "first" })).receipt, "delivered");
	rmSync(sessionFile);
	assert.equal((await b.sender.send({ jobId: b.jobId, message: "second" })).receipt, "delivered", "pi has not written the file yet");
	assert.equal(live.sent.length, 2);
});
