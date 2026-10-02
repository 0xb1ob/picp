/**
 * cp-mub7: a model-call failure must not leave its worker registered.
 *
 * The incident (48 h audit, section 4a): a provider 503 marked cp-1vij and
 * cp-knj9 `failed` but left their idle `pi` registered, so `cp_send` refused
 * them as failed ("use cp_revive continue_failed") while `cp_revive` refused
 * them as `worker_already_live`. Only a manual `kill -TERM` broke the circle.
 * And cp-ppio, which had already done work, had the same exhausted 503 booked
 * as "settled without a report" and was nudged twice into more failed calls.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, type SendReceipt } from "../src/contracts.ts";
import { attachWorkerObservers } from "../src/dispatch.ts";
import { FleetStore } from "../src/fleet.ts";
import { loadProfile } from "../src/profiles.ts";
import { MAX_OUTER_RETRIES, OUTER_RETRY_DELAYS_MS } from "../src/provider-retry.ts";
import { Reviver } from "../src/revive.ts";
import { RunRegistry } from "../src/runs.ts";
import { formatSettleOutcome, type NudgeableWorker, REPORT_NUDGE_TEXT, SettleWatcher } from "../src/settle.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import type { WorkerEvent, WorkerProcess } from "../src/worker-process.ts";
import { createScratchHome, readRunEvents, REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const JOB_ID = "cp-503";
const PID = 4_000_001;

/** A registered, alive, silent child; `shutdown` makes it not alive and counts. */
function fakeManager(home: string, t: { after(fn: () => void | Promise<void>): void }) {
	const shutdowns: number[] = [];
	let nextPid = PID;
	const manager = new WorkerManager({
		home,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		spawnFn: () => {
			const worker = {
				pid: nextPid++,
				alive: true,
				busy: false,
				closed: new Promise(() => {}),
				onEvent: () => () => {},
				send: async () => ({ receipt: "delivered" as SendReceipt }),
				shutdown: async () => {
					worker.alive = false;
					shutdowns.push(worker.pid);
					return { code: 0, signal: null, at: Date.now() };
				},
			};
			return worker as unknown as WorkerProcess;
		},
	});
	t.after(async () => manager.shutdownAll());
	return { manager, shutdowns };
}

function spawnInto(manager: WorkerManager, record: FleetRecord, runs: RunRegistry) {
	return manager.spawn({
		identity: { jobId: record.job_id, kind: record.kind, delivery: record.delivery, runDir: runs.open(record.job_id).runDir, worktree: record.worktree },
		profile: loadProfile(PROFILES_DIR, "implementer"),
		model: record.worker.model,
		sessionFile: record.worker.session_file,
	});
}

async function setup(t: { after(fn: () => void | Promise<void>): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => runs.closeAll());
	const worktree = join(home.path, "worktrees", JOB_ID);
	mkdirSync(join(worktree, ".git"), { recursive: true });
	const sessionFile = join(home.path, `${JOB_ID}.jsonl`);
	writeFileSync(sessionFile, "{}\n");
	const record: FleetRecord = {
		job_id: JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: PID,
			session_id: "s",
			session_file: sessionFile,
			profile: "implementer",
			role: "implementer",
			model: "mock/mock-model",
			started_at: isoTimestamp(),
		},
		worktree,
		branch: JOB_ID,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
	await fleet.add(record);
	const fail = (jobId: string, failure: Parameters<FleetStore["markFailed"]>[1]) => fleet.markFailed(jobId, failure);
	const git = async (_cwd: string, args: readonly string[]) =>
		args[0] === "rev-parse" ? { status: 0, stdout: join(worktree, ".git"), stderr: "" } : { status: 0, stdout: "", stderr: "" };
	return { home: home.path, fleet, runs, record, fail, git };
}

function failedTurn(errorMessage: string): Record<string, unknown> {
	return {
		message: {
			role: "assistant",
			content: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "error",
			errorMessage,
		},
	};
}

test("deadlock reproduction: a dead-on-arrival 503 stops its worker, so cp_revive continue_failed plans without a manual kill", async (t) => {
	const s = await setup(t);
	const { manager, shutdowns } = fakeManager(s.home, t);
	const managed = spawnInto(manager, s.record, s.runs);
	const recorder = s.runs.open(JOB_ID);
	recorder.record("pi", "agent_start", {});
	recorder.record("pi", "message_end", failedTurn('503 {"message":"No available accounts"}'));

	const settle = new SettleWatcher({ fleet: s.fleet, runs: s.runs, fail: s.fail, shutdown: (jobId) => manager.shutdown(jobId) });
	const outcome = await settle.settled(JOB_ID, managed.worker as unknown as NudgeableWorker);
	assert.equal(outcome.action === "recorded" ? outcome.failure?.class : undefined, "model_call_failed");
	assert.equal(s.fleet.require(JOB_ID).phase, "failed");
	assert.deepEqual(shutdowns, [PID], "the failed job's worker is stopped");
	assert.equal(manager.get(JOB_ID), undefined, "and unregistered");

	// The pid is really gone once shut down; the registry no longer claims it.
	const reviver = new Reviver({
		home: s.home,
		profilesDir: PROFILES_DIR,
		fleet: s.fleet,
		manager,
		runs: s.runs,
		isPidAlive: () => false,
		git: s.git,
	});
	const plan = await reviver.plan(JOB_ID, { continueFailed: true });
	assert.equal(plan.ok, true, plan.ok ? "" : `${plan.code}: ${plan.message}`);
	const revived = await reviver.revive(JOB_ID, { continueFailed: true });
	assert.equal(revived.pid, PID + 1);
	assert.equal(s.fleet.require(JOB_ID).phase, "waiting");
});

test("cp_revive continue_failed closes a failed job's still-registered worker instead of worker_already_live", async (t) => {
	const s = await setup(t);
	const { manager, shutdowns } = fakeManager(s.home, t);
	spawnInto(manager, s.record, s.runs);
	// A failure path that did not stop its worker (the pre-fix settle path).
	await s.fleet.markFailed(JOB_ID, { class: "model_call_failed", message: "503", at: isoTimestamp() });
	// The registered worker's pid is alive while it is registered.
	const reviver = new Reviver({
		home: s.home,
		profilesDir: PROFILES_DIR,
		fleet: s.fleet,
		manager,
		runs: s.runs,
		isPidAlive: (pid) => pid === PID && manager.get(JOB_ID) !== undefined,
		git: s.git,
	});

	const plain = await reviver.plan(JOB_ID, { recovering: true });
	assert.equal(plain.ok ? "" : plain.code, "worker_already_live", "bounded recovery keeps its own ordering");

	const plan = await reviver.plan(JOB_ID, { continueFailed: true });
	assert.equal(plan.ok, true, plan.ok ? "" : `${plan.code}: ${plan.message}`);
	assert.equal(plan.ok && plan.closesWorker, true);
	assert.deepEqual(shutdowns, [], "planning stops nothing");

	const revived = await reviver.revive(JOB_ID, { continueFailed: true });
	assert.deepEqual(shutdowns, [PID], "the stale worker is closed before the relaunch");
	assert.equal(revived.pid, PID + 1);
	assert.equal(manager.get(JOB_ID)?.worker.pid, PID + 1);
});

/** Exactly what `watchOuterProviderRetry` and `SettleWatcher` use. */
class StubWorker {
	alive = true;
	readonly sent: string[] = [];
	/** Never resolves: nothing here observes a close. */
	readonly closed = new Promise<never>(() => {});
	readonly #listeners = new Set<(event: WorkerEvent) => void>();
	async send(message: string): Promise<{ receipt: SendReceipt }> {
		this.sent.push(message);
		return { receipt: "delivered" };
	}
	onEvent(listener: (event: WorkerEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	emit(event: WorkerEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}
	failedTurn(message: string): void {
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_end", ...failedTurn(message) } as unknown as WorkerEvent);
		this.emit({ type: "agent_settled" });
	}
}

test("a 503 that outlives the outer ladder after prior work is a failure, never a report nudge", async (t) => {
	const timers = mock.timers;
	timers.enable({ apis: ["setTimeout"] });
	t.after(() => timers.reset());
	const s = await setup(t);
	const recorder = s.runs.open(JOB_ID);
	// Real prior work: the run is not dead on arrival.
	recorder.record("pi", "agent_start", {});
	recorder.record("pi", "tool_execution_start", { toolName: "bash", toolCallId: "c1" });
	recorder.record("pi", "tool_execution_end", { toolCallId: "c1" });
	const stopped: string[] = [];
	const lines: string[] = [];
	const settle = new SettleWatcher({
		fleet: s.fleet,
		runs: s.runs,
		fail: s.fail,
		inspect: async () => ({ state: "clean", files: [], file_count: 0, commits_ahead: 0, observed_at: isoTimestamp() }),
		shutdown: async (jobId) => {
			stopped.push(jobId);
		},
		onUnreported: (jobId, outcome) => lines.push(formatSettleOutcome(jobId, outcome) ?? ""),
	});
	const worker = new StubWorker();
	attachWorkerObservers({ recorder, worker: worker as unknown as WorkerProcess, jobId: JOB_ID, settle });

	for (let i = 0; i < MAX_OUTER_RETRIES; i++) {
		worker.failedTurn('503 {"message":"No available accounts"}');
		await timers.tick(OUTER_RETRY_DELAYS_MS[i] as number);
		await Promise.resolve();
	}
	assert.equal(s.fleet.require(JOB_ID).phase, "waiting", "not failed while the ladder still runs");
	worker.failedTurn('503 {"message":"No available accounts"}');
	for (let i = 0; i < 20 && s.fleet.require(JOB_ID).phase !== "failed"; i++) await new Promise((resolve) => setImmediate(resolve));

	const record = s.fleet.require(JOB_ID);
	assert.equal(record.phase, "failed");
	assert.equal(record.failure?.class, "model_call_failed");
	assert.match(record.failure?.message ?? "", /No available accounts/);
	assert.match(record.failure?.message ?? "", /continue_failed/);
	assert.equal(record.unreported_settles, undefined, "the report budget is untouched");
	assert.equal(worker.sent.includes(REPORT_NUDGE_TEXT), false, "no report nudge");
	assert.equal(worker.sent.length, MAX_OUTER_RETRIES, "only the ladder's own resume nudges were sent");
	assert.deepEqual(stopped, [JOB_ID], "the worker is stopped");
	const events = readRunEvents(s.home, JOB_ID).map((event) => event.type);
	assert.equal(events.includes("report_nudged"), false);
	assert.equal(events.includes("settled_without_report"), false);
	assert.equal(events.includes("outer_retry_exhausted"), true);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /model call failed/);
	assert.doesNotMatch(lines[0] ?? "", /not a failure|dead on arrival/);
});
