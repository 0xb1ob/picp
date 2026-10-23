import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, type Job } from "../src/contracts.ts";
import { DispatchQueue, wireSlotFree } from "../src/dispatch-queue.ts";
import { HeldRelease } from "../src/held-release.ts";
import { SpawnSafetyError } from "../src/worker-manager.ts";
import { createScratchHome, fakeWorker, fakeWorkerManager } from "./harness/index.ts";

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
