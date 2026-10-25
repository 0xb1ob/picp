/**
 * Retained from tests/revive.test.ts by P8d (cp-e2e-migration-p8d-om9z): declarations no e2e entry point reaches.
 * Each is verbatim; the ledger row in docs/testing-migration/p8d.md names why.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { HeldRelease } from "../src/held-release.ts";
import { Reviver } from "../src/revive.ts";
import { RunRegistry } from "../src/runs.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { createScratchHome, fakeWorker, fakeWorkerManager, readRunEvents, REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

/** A pid that existed and has been reaped: cheap and, unlike a guess, true. */
function reapedPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	if (!result.pid || result.pid <= 0) throw new Error("could not obtain a reaped pid for the fixture");
	return result.pid;
}

const DEAD_PID = reapedPid();

function makeRecord(overrides: Partial<FleetRecord> = {}, home: string): FleetRecord {
	const jobId = overrides.job_id ?? "cp-revive";
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "held",
		reported_at: isoTimestamp(),
		worker: {
			pid: DEAD_PID,
			session_id: "sess-1",
			session_file: join(home, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/mock-model",
			started_at: isoTimestamp(),
		},
		worktree: join(home, "worktrees", jobId),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		...overrides,
	};
}

test("revive() writes the worker_revived marker before it tees a single event (cp-0wq7)", async (t) => {
	// The marker is what reopens the projection's liveness after the previous
	// attempt's observed close. An event teed ahead of it is an event about a
	// process the projection still believes is dead: it would be swallowed as
	// post-exit noise, and the run would read `exited` while a live worker worked.
	// A fake child emits on registration, which is the tightest version of that
	// race a real buffered stdout chunk can produce.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => runs.closeAll());

	const jobId = "cp-revive-order";
	const worktree = join(home.path, "worktrees", jobId);
	mkdirSync(worktree, { recursive: true });
	const sessionFile = join(home.path, `${jobId}.jsonl`);
	writeFileSync(sessionFile, "{}\n");
	await fleet.add(
		makeRecord(
			{ job_id: jobId, phase: "waiting", worktree, worker: { ...makeRecord({}, home.path).worker, session_file: sessionFile } },
			home.path,
		),
	);

	// The previous attempt: it ran, settled and its close was OBSERVED.
	const recorder = runs.open(jobId);
	recorder.cp("spawned", { pid: DEAD_PID, model: "mock/mock-model", profile: "implementer" });
	recorder.record("pi", "agent_start", {});
	recorder.record("pi", "agent_settled", {});
	recorder.cp("process_exit", { code: 0, signal: null });
	assert.equal(recorder.status.phase, "exited");

	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		// No child process: a fake that emits the moment a listener is registered.
		spawnFn: () =>
			({
				pid: DEAD_PID + 1,
				alive: true,
				busy: false,
				closed: new Promise(() => {}),
				onEvent(listener: (event: { type: string }) => void) {
					listener({ type: "agent_start" });
					return () => {};
				},
				shutdown: async () => ({ code: 0, signal: null, at: Date.now() }),
			}) as unknown as ReturnType<WorkerManager["spawn"]>["worker"],
	});
	t.after(async () => manager.shutdownAll());

	const reviver = new Reviver({
		home: home.path,
		profilesDir: PROFILES_DIR,
		fleet,
		manager,
		runs,
		isPidAlive: () => false,
		git: async (_cwd, args) =>
			// clean tree, on a branch, no rebase/merge in flight
			args[0] === "rev-parse" ? { status: 0, stdout: join(worktree, ".git"), stderr: "" } : { status: 0, stdout: "", stderr: "" },
	});

	await reviver.revive(jobId);

	const types = readRunEvents(home.path, jobId).map((event) => `${event.source}:${event.type}`);
	const marker = types.indexOf("cp:worker_revived");
	const firstNewEvent = types.indexOf("pi:agent_start", types.indexOf("cp:process_exit"));
	assert.ok(marker > types.indexOf("cp:process_exit"), "the marker belongs to the new attempt");
	assert.ok(marker < firstNewEvent, `worker_revived must precede the revived worker's events: ${types.join(", ")}`);
	// And the consequence the ordering exists for: the run is live again.
	assert.equal(runs.open(jobId).status.phase, "working");
	assert.equal(runs.open(jobId).status.exited_at, undefined);
});

const CRASH = { class: "crash" as const, message: "worker exited 137", at: isoTimestamp() };

/** A fake child: registered, alive, silent. `throws` stands in for a spawn that fails. */
function fakeManager(home: string, t: { after(fn: () => void | Promise<void>): void }, throws = false): WorkerManager {
	const manager = new WorkerManager({
		home,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		spawnFn: () => {
			if (throws) throw new Error("spawn failed");
			return {
				pid: DEAD_PID + 1,
				alive: true,
				busy: false,
				closed: new Promise(() => {}),
				onEvent: () => () => {},
				shutdown: async () => ({ code: 0, signal: null, at: Date.now() }),
			} as unknown as ReturnType<WorkerManager["spawn"]>["worker"];
		},
	});
	t.after(async () => manager.shutdownAll());
	return manager;
}

/** Clean tree on a branch unless told otherwise; the git-dir is a real directory so op markers can be planted. */
function fakeGit(gitDir: string, detached = false) {
	return async (_cwd: string, args: readonly string[]) =>
		args[0] === "rev-parse"
			? { status: 0, stdout: gitDir, stderr: "" }
			: args[0] === "symbolic-ref" && detached
				? { status: 1, stdout: "", stderr: "" }
				: { status: 0, stdout: "", stderr: "" };
}

async function addFailed(home: string, fleet: FleetStore, jobId: string, overrides: Partial<FleetRecord> = {}): Promise<FleetRecord> {
	const worktree = join(home, "worktrees", jobId);
	mkdirSync(join(worktree, ".git"), { recursive: true });
	const sessionFile = join(home, `${jobId}.jsonl`);
	const lines = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "git push" } }] } },
	];
	writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	const base = makeRecord({}, home);
	const { reported_at: _reported, ...rest } = base;
	return fleet.add({
		...rest,
		job_id: jobId,
		branch: jobId,
		phase: "failed",
		failure: CRASH,
		worktree,
		worker: { ...base.worker, session_file: sessionFile },
		...overrides,
	});
}

test("continueFailed: a spawn that fails keeps the failure and the lease", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => runs.closeAll());
	const before = await addFailed(home.path, fleet, "cp-nospawn");
	const reviver = new Reviver({
		home: home.path,
		profilesDir: PROFILES_DIR,
		fleet,
		manager: fakeManager(home.path, t, true),
		runs,
		isPidAlive: () => false,
		git: fakeGit(join(before.worktree, ".git")),
	});
	await assert.rejects(() => reviver.revive("cp-nospawn", { continueFailed: true }), /spawn failed/);
	assert.deepEqual(fleet.require("cp-nospawn"), before);
});

// ---------------------------------------------------------------------------
// 4b-1 (4B1-T7): a revive at the spawn cap releases another held author
// ---------------------------------------------------------------------------

async function capBench(t: { after(fn: () => void | Promise<void>): void }) {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const workers = fakeWorkerManager(home.path, 2);
	t.after(async () => {
		await workers.manager.shutdownAll();
		runs.closeAll();
		home.cleanup();
	});
	const worktree = join(home.path, "worktrees", "cp-aaa1");
	mkdirSync(join(worktree, ".git"), { recursive: true });
	writeFileSync(join(home.path, "s.jsonl"), "{}\n");
	await fleet.add(makeRecord({ job_id: "cp-aaa1", worktree }, home.path));
	await fleet.add(makeRecord({ job_id: "cp-aaa2" }, home.path));
	await fleet.add(makeRecord({ job_id: "cp-aaa3" }, home.path));
	// cp-aaa1 was released earlier; cp-aaa2 is a live idle author, cp-aaa3 busy: the cap (2) is full.
	runs.open("cp-aaa1").cp("held_released", { for_job: "cp-aaa9", reason: "spawn cap" });
	const idle = workers.spawn("cp-aaa2");
	workers.spawn("cp-aaa3", fakeWorker({ busy: true }));
	const held = new HeldRelease({
		home: home.path, fleet, manager: workers.manager,
		busy: { sending: () => false, promoting: () => false, driving: () => false },
		integration: () => undefined, journal: (id, kind, payload) => runs.open(id).cp(kind, payload),
	});
	const reviver = new Reviver({
		home: home.path, profilesDir: PROFILES_DIR, fleet, manager: workers.manager, runs, isPidAlive: () => false,
		git: fakeGit(join(worktree, ".git")),
		makeRoom: (id, role) => held.makeRoom(id, role), released: (id) => held.wasReleased(id),
	});
	return { home: home.path, fleet, workers, idle, reviver };
}

test("4B1-T7: a failed revive spawn after makeRoom leaves no reservation", async (t) => {
	const b = await capBench(t);
	b.workers.failNext();
	await assert.rejects(() => b.reviver.revive("cp-aaa1"), /spawn failed/);
	assert.equal(b.workers.manager.reserved, 0);
	assert.equal(b.workers.manager.get("cp-aaa1"), undefined);
});
