/**
 * 4b-1 (4B1-T2, 4B1-T3): which held authors may be released, the single
 * makeRoom condition, and that no failure path leaks a reservation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_USAGE, type FleetRecord, type IntegrationRecord, isoTimestamp } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { HeldRelease } from "../src/held-release.ts";
import { readEventLog } from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnSafetyError } from "../src/worker-manager.ts";
import { createScratchHome, type FakeFleet, fakeWorker, fakeWorkerManager } from "./harness/index.ts";

function held(jobId: string, overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: jobId,
		project: "example-app",
		kind: "ship",
		delivery: "pr",
		origin: "terminal",
		phase: "held",
		worker: { pid: 4242, session_id: jobId, session_file: `/sessions/${jobId}.jsonl`, profile: "implementer", role: "implementer", model: "mock/unused", started_at: "2026-01-01T00:00:00Z" },
		worktree: `/wt/${jobId}`,
		branch: jobId,
		dispatched_at: "2026-01-01T00:00:00Z",
		reported_at: "2026-01-01T01:00:00Z",
		usage: EMPTY_USAGE,
		...overrides,
	};
}

interface Bench {
	home: string;
	fleet: FleetStore;
	workers: FakeFleet;
	release: HeldRelease;
	busy: { sending: Set<string>; promoting: Set<string>; driving: Set<string> };
	integration: Map<string, IntegrationRecord>;
	notified: () => number;
	journalThrows: { on: boolean };
}

async function bench(t: { after(fn: () => void): void }, cap: number, records: FleetRecord[]): Promise<Bench> {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	const fleet = new FleetStore({ home: home.path });
	for (const record of records) await fleet.add(record);
	const workers = fakeWorkerManager(home.path, cap);
	let notified = 0;
	workers.manager.onSlotFree(() => {
		notified += 1;
	});
	const busy = { sending: new Set<string>(), promoting: new Set<string>(), driving: new Set<string>() };
	const integration = new Map<string, IntegrationRecord>();
	const journalThrows = { on: false };
	const release = new HeldRelease({
		home: home.path,
		fleet,
		manager: workers.manager,
		busy: { sending: (id) => busy.sending.has(id), promoting: (id) => busy.promoting.has(id), driving: (id) => busy.driving.has(id) },
		integration: (id) => integration.get(id),
		journal: (id, kind, payload) => {
			if (journalThrows.on) throw new Error("journal unwritable");
			runs.open(id).cp(kind, payload);
		},
	});
	return { home: home.path, fleet, workers, release, busy, integration, notified: () => notified, journalThrows };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const releasedEvents = (home: string, id: string) => readEventLog(home, id).filter((event) => event.type === "held_released");

test("4B1-T2: releasable keeps only live, idle, not-stopping held ship/pr authors, oldest reported first", async (t) => {
	const b = await bench(t, 20, [
		held("cp-newer", { reported_at: "2026-01-01T03:00:00Z" }),
		held("cp-older", { reported_at: "2026-01-01T02:00:00Z" }),
		held("cp-waiting", { phase: "waiting" }),
		held("cp-research", { kind: "research" }),
		held("cp-local", { delivery: "local" }),
		held("cp-failed", { failure: { class: "crash", message: "x", at: isoTimestamp() } }),
		held("cp-restart"),
		held("cp-dead"),
		held("cp-busy"),
		held("cp-stopping"),
		held("cp-sending"),
		held("cp-promoting"),
		held("cp-driving"),
		held("cp-resolve"),
		held("cp-old-resolve"),
	]);
	for (const id of ["cp-newer", "cp-older", "cp-waiting", "cp-research", "cp-local", "cp-failed", "cp-sending", "cp-promoting", "cp-driving", "cp-resolve", "cp-old-resolve"]) b.workers.spawn(id);
	b.workers.spawn("cp-dead", fakeWorker({ alive: true })).alive = false; // dead but not reaped
	b.workers.spawn("cp-busy", fakeWorker({ busy: true }));
	const exit = deferred();
	b.workers.spawn("cp-stopping", fakeWorker({ shutdown: () => exit.promise }));
	const stopping = b.workers.manager.shutdown("cp-stopping");
	b.busy.sending.add("cp-sending");
	b.busy.promoting.add("cp-promoting");
	b.busy.driving.add("cp-driving");
	const record = (updated_at: string): IntegrationRecord => ({ schema_version: 1, job_id: "x", branch: "x", step: "start", next: "resolve", resolve_attempts: 1, facts: [], reason: "r", started_at: updated_at, updated_at });
	b.integration.set("cp-resolve", record("2026-01-01T05:00:00Z"));
	b.integration.set("cp-old-resolve", record("2025-12-31T00:00:00Z"));

	const order = b.release.releasable();
	assert.deepEqual(new Set(order), new Set(["cp-older", "cp-newer", "cp-old-resolve"]));
	assert.ok(order.indexOf("cp-older") < order.indexOf("cp-newer"), "oldest reported_at first");
	assert.deepEqual(b.release.releasable("cp-older").includes("cp-older"), false, "the caller is never its own victim");

	// 14 spawned; reap drops the dead one, the stopping one stays registered until its exit.
	b.workers.manager.reap();
	assert.equal(b.workers.manager.active.length, 13, "the dead one is reaped; the stopping one stays until its exit");
	assert.equal(b.release.capacityFree(), true);
	exit.resolve();
	await stopping;
});

test("4B1-T2: capacityFree counts only releasable authors as free (dead, busy, stopping never)", async (t) => {
	const b = await bench(t, 2, [held("cp-busy"), held("cp-idle")]);
	b.workers.spawn("cp-busy", fakeWorker({ busy: true }));
	b.workers.spawn("cp-idle");
	assert.equal(b.release.capacityFree(), true, "one idle author is releasable");
	b.busy.sending.add("cp-idle");
	assert.equal(b.release.capacityFree(), false);
});

test("4B1-T2: makeRoom — reviewer, below the cap, and nothing releasable all do nothing", async (t) => {
	const b = await bench(t, 2, [held("cp-h")]);
	b.workers.spawn("cp-h");
	assert.equal(await b.release.makeRoom("cp-x", "gate-reviewer"), undefined);
	assert.equal(await b.release.makeRoom("cp-x", "implementer"), undefined, "below the cap");
	assert.equal(b.workers.manager.reserved, 0);
	b.workers.spawn("cp-other", fakeWorker({ busy: true }));
	b.busy.sending.add("cp-h");
	assert.equal(await b.release.makeRoom("cp-x", "implementer"), undefined, "at the cap, nothing releasable");
	assert.equal(b.workers.manager.reserved, 0);
	assert.ok(b.workers.manager.get("cp-h"), "nothing shut down");
});

test("4B1-T2: makeRoom at the cap releases the oldest author, journals it, and reserves the slot", async (t) => {
	const b = await bench(t, 2, [held("cp-h")]);
	const victim = b.workers.spawn("cp-h");
	b.workers.spawn("cp-b", fakeWorker({ busy: true }));
	const release = await b.release.makeRoom("cp-x", "implementer");
	assert.equal(typeof release, "function");
	assert.equal(b.workers.manager.reserved, 1);
	assert.equal(victim.shutdownCalls, 1);
	assert.equal(b.workers.manager.get("cp-h"), undefined);
	const [event] = releasedEvents(b.home, "cp-h");
	assert.deepEqual(event?.payload, { for_job: "cp-x", reason: "spawn cap" });
	assert.equal(b.release.wasReleased("cp-h"), true);
	const record = b.fleet.get("cp-h");
	assert.equal(record?.phase, "held", "phase unchanged");
	assert.equal(record?.worktree, "/wt/cp-h", "lease unchanged");
	// 4B1-T3(d): the slot stays reserved until the caller spawns or releases.
	b.workers.spawn("cp-x");
	assert.equal(b.workers.manager.reserved, 0);
	release?.();
	assert.equal(b.workers.manager.reserved, 0);
});

test("4B1-T2: two concurrent makeRoom calls with one releasable author — exactly one wins", async (t) => {
	const b = await bench(t, 2, [held("cp-h")]);
	const victim = b.workers.spawn("cp-h");
	b.workers.spawn("cp-b", fakeWorker({ busy: true }));
	const [first, second] = await Promise.all([b.release.makeRoom("cp-x", "implementer"), b.release.makeRoom("cp-y", "implementer")]);
	assert.equal([first, second].filter((value) => typeof value === "function").length, 1);
	assert.equal(victim.shutdownCalls, 1);
	assert.equal(b.workers.manager.reserved, 1);
});

test("4B1-T3(a): a journal failure rejects before any shutdown and leaks no reservation", async (t) => {
	const b = await bench(t, 2, [held("cp-h")]);
	const victim = b.workers.spawn("cp-h");
	b.workers.spawn("cp-b", fakeWorker({ busy: true }));
	b.journalThrows.on = true;
	await assert.rejects(b.release.makeRoom("cp-x", "implementer"), /journal unwritable/);
	assert.equal(victim.shutdownCalls, 0);
	assert.equal(b.workers.manager.reserved, 0);
	assert.equal(b.notified(), 1);
});

test("4B1-T3(b): a shutdown that rejects leaks no reservation and leaves nothing stopping", async (t) => {
	const b = await bench(t, 2, [held("cp-h")]);
	b.workers.spawn("cp-h", fakeWorker({ shutdown: async () => {
		throw new Error("kill refused");
	} }));
	b.workers.spawn("cp-b", fakeWorker({ busy: true }));
	await assert.rejects(b.release.makeRoom("cp-x", "implementer"), /kill refused/);
	assert.equal(b.workers.manager.reserved, 0);
	assert.equal(b.workers.manager.stopping("cp-h"), false);
	// One notify for the reservation's release; the failed shutdown's own deregistration notifies too.
	assert.ok(b.notified() >= 1);
});

test("4B1-T3(c): busy flips between selection and re-check — refused, nothing shut down or journaled", async (t) => {
	const b = await bench(t, 2, [held("cp-h")]);
	let reads = 0;
	const flipping = fakeWorker();
	Object.defineProperty(flipping, "busy", { get: () => ++reads > 1 });
	b.workers.spawn("cp-h", flipping);
	b.workers.spawn("cp-b", fakeWorker({ busy: true }));
	await assert.rejects(b.release.makeRoom("cp-x", "implementer"), (error: unknown) => {
		assert.ok(error instanceof SpawnSafetyError);
		assert.equal(error.code, "spawn_cap");
		assert.match(error.message, /no longer releasable/);
		return true;
	});
	assert.equal(reads, 2, "one selection read, one re-check read");
	assert.equal(flipping.shutdownCalls, 0);
	assert.deepEqual(releasedEvents(b.home, "cp-h"), []);
	assert.equal(b.workers.manager.reserved, 0);
	assert.equal(b.notified(), 1);
});

test("wasReleased: the last lifecycle marker decides", async (t) => {
	const b = await bench(t, 2, []);
	const runs = new RunRegistry(b.home);
	t.after(() => runs.closeAll());
	assert.equal(b.release.wasReleased("cp-aaa1"), false);
	runs.open("cp-aaa1").cp("spawned", {});
	runs.open("cp-aaa1").cp("held_released", {});
	assert.equal(b.release.wasReleased("cp-aaa1"), true);
	runs.open("cp-aaa1").cp("worker_revived", {});
	assert.equal(b.release.wasReleased("cp-aaa1"), false);
});
