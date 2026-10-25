/** Retained from tests/model-call-failure-recovery.test.ts (P8): the bounded-recovery `recovering` door. */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, type SendReceipt } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { loadProfile } from "../src/profiles.ts";
import { Reviver } from "../src/revive.ts";
import { RunRegistry } from "../src/runs.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import type { WorkerProcess } from "../src/worker-process.ts";
import { createScratchHome, REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

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
