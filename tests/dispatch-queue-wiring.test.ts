/**
 * cp-itl4 4b-2 (4B2-T3, T3b, T4, T5): who drains the dispatch queue. An observed
 * close drains it through `wireSlotFree`; only the parent-lock owner dispatches
 * (a real CommandPost, no injection); the scheduler tick drains despite a
 * scheduler fault; and a slot reserved by HeldRelease is never taken by the queue.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { registerScheduleTools } from "../extensions/command-post/tools-schedule.ts";
import { CommandPost } from "../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, type Job, LAYOUT } from "../src/contracts.ts";
import { DispatchQueue, wireSlotFree } from "../src/dispatch-queue.ts";
import { HeldRelease } from "../src/held-release.ts";
import { acquireParentLock, holdsParentLock, releaseParentLock } from "../src/parent-lock.ts";
import { SpawnSafetyError } from "../src/worker-manager.ts";
import { createScratchHome, fakeWorker, fakeWorkerManager, REPO_ROOT } from "./harness/index.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const openJob = { show: async (id: string) => ({ id, status: "open" }) as Job };

test("4B2-T3: an observed close drains the queue exactly once through wireSlotFree; the unsubscribe stops it", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const workers = fakeWorkerManager(home.path, 4);
	t.after(() => workers.manager.shutdownAll());
	let drains = 0;
	const unsubscribe = wireSlotFree(workers.manager, { drain: async () => void drains++ });
	workers.spawn("cp-aaa1").exit();
	await tick();
	assert.equal(drains, 1);
	unsubscribe();
	workers.spawn("cp-aaa2").exit();
	await tick();
	assert.equal(drains, 1, "unsubscribed");
});

function postOn(home: string) {
	const post = new CommandPost({ home, packageRoot: REPO_ROOT });
	const calls: string[] = [];
	// Instance overrides: the queue calls `this.dispatch` / `this.ledger()` at drain time.
	Object.assign(post, {
		ledger: () => openJob,
		dispatch: async (request: { jobId: string }) => (calls.push(request.jobId), { state: "dispatched" }),
	});
	return { post, calls };
}

test("4B2-T3: the parent-lock owner (real lock, no injection) dispatches a queued job exactly once on a slot-free", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.equal(acquireParentLock({ home: home.path }).ok, true);
	t.after(() => void releaseParentLock({ home: home.path }));
	const { post, calls } = postOn(home.path);
	t.after(() => post.shutdown());
	post.dispatchQueue.enqueue("cp-aaa1", { task: "one" });
	post.manager.notifySlotFree();
	await post.dispatchQueue.settled();
	assert.deepEqual(calls, ["cp-aaa1"]);
	assert.deepEqual(post.dispatchQueue.ids(), []);
});

test("4B2-T3b: a non-owner CommandPost (the real lock names another live pid) dispatches nothing and leaves the file byte-identical", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.equal(acquireParentLock({ home: home.path, pid: 999_999, isPidAlive: () => true }).ok, true);
	t.after(() => void releaseParentLock({ home: home.path, pid: 999_999 }));
	assert.equal(holdsParentLock({ home: home.path }), false);
	const { post, calls } = postOn(home.path);
	t.after(() => post.shutdown());
	post.dispatchQueue.enqueue("cp-aaa1", { task: "one" });
	const file = join(home.path, LAYOUT.dispatchQueueFile);
	const before = readFileSync(file, "utf8");
	post.manager.notifySlotFree();
	await post.dispatchQueue.settled();
	await post.dispatchQueue.drain();
	assert.deepEqual(calls, []);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.equal(existsSync(join(home.path, LAYOUT.wakeupsFile)), false, "no wake-up journaled");
});

test("4B2-T4: the scheduler tick drains the queue despite a scheduler fault, and only while holding the lock", async (t) => {
	for (const holds of [true, false]) {
		let drains = 0;
		let releases = 0;
		const hooks = new Map<string, () => Promise<void>>();
		const post = {
			home: "/nonexistent",
			ledger: () => {
				throw new Error("ledger down");
			},
			dispatchQueue: { drain: async () => void drains++ },
			// unload-parent PR2: the same tick releases armed dependents, after the queue drain.
			armedDispatches: { release: async () => void releases++ },
		};
		registerScheduleTools(
			{ on: (event: string, fn: () => Promise<void>) => hooks.set(event, fn), registerTool: () => {}, sendMessage: () => {} } as never,
			{ commandPost: () => post } as never,
			() => holds, () => {}, () => {},
		);
		t.after(() => hooks.get("session_shutdown")!());
		await hooks.get("session_start")!();
		await tick();
		assert.equal(drains, holds ? 1 : 0);
		assert.equal(releases, holds ? 1 : 0);
	}
});

test("4B2-T5: a slot HeldRelease reserved is never taken by the queue; a released reservation lets the head spawn", async (t) => {
	for (const variant of ["spawn", "release"] as const) {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const workers = fakeWorkerManager(home.path, 2);
		t.after(() => workers.manager.shutdownAll());
		workers.spawn("cp-h");
		workers.spawn("cp-b", fakeWorker({ busy: true }));
		const records = [{
			job_id: "cp-h", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held",
			worker: { pid: 1, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "mock/unused", started_at: isoTimestamp() },
			worktree: home.path, branch: "cp-h", dispatched_at: isoTimestamp(), reported_at: isoTimestamp(), usage: EMPTY_USAGE,
		}] as FleetRecord[];
		const held = new HeldRelease({
			home: home.path, fleet: { list: () => records }, manager: workers.manager,
			busy: { sending: () => false, promoting: () => false, driving: () => false },
			integration: () => undefined, journal: () => {},
		});
		const spawned: string[] = [];
		const queue = new DispatchQueue({
			home: home.path, owns: () => true, capacityFree: () => held.capacityFree(),
			ledger: () => openJob, fleet: { get: () => undefined }, journal: () => {},
			dispatch: async (request) => (workers.spawn(request.jobId), spawned.push(request.jobId), { state: "dispatched" }),
		});
		wireSlotFree(workers.manager, queue);
		queue.enqueue("cp-q", {});

		const release = await held.makeRoom("cp-x", "implementer");
		assert.ok(release, "the idle held author was released into a reservation");
		await tick();
		await queue.settled();
		assert.deepEqual(spawned, [], "the queue never takes the reserved slot");
		assert.deepEqual(queue.ids(), ["cp-q"]);
		assert.throws(() => workers.spawn("cp-q"), (error: unknown) => error instanceof SpawnSafetyError && error.code === "spawn_cap");

		if (variant === "spawn") {
			workers.spawn("cp-x");
			assert.ok(workers.manager.get("cp-x"), "the reserving job spawns into its slot");
		} else {
			release!();
			await tick();
			await queue.settled();
			assert.deepEqual(spawned, ["cp-q"], "a released reservation frees the slot for the queue head");
		}
	}
});
