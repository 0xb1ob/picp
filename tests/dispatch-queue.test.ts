/**
 * cp-itl4 4b-2 (4B2-T1, 4B2-T1b): the persisted dispatch queue — FIFO, caps, the
 * outcomes that keep or drop the head, ownership per drain and per entry, and a
 * real MandateStore parallelism refusal that keeps the head byte-identical.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DISPATCH_QUEUE_MAX, type FleetRecord, type Job, LAYOUT, isoTimestamp } from "../src/contracts.ts";
import { DispatchQueue } from "../src/dispatch-queue.ts";
import { drainFile } from "../src/drain.ts";
import { MandateError } from "../src/mandate-accounting.ts";
import { MandateStore } from "../src/mandate.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
import { SpawnSafetyError } from "../src/worker-manager.ts";
import { createScratchHome } from "./harness/index.ts";

type Port = (request: { jobId: string }) => Promise<{ state: string }>;

function queueBench(t: { after(fn: () => void): void }, options: { dispatch?: Port; owns?: () => boolean; capacityFree?: () => boolean; jobs?: Record<string, Partial<Job>>; fleet?: string[] } = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const calls: string[] = [];
	const wakes: DurableWakeupInput[] = [];
	const options_ = {
		home: home.path,
		dispatch: async (request: { jobId: string }) => {
			calls.push(request.jobId);
			return options.dispatch ? options.dispatch(request) : { state: "dispatched" };
		},
		capacityFree: options.capacityFree ?? (() => true),
		owns: options.owns ?? (() => true),
		ledger: () => ({ show: async (id: string) => ({ id, status: "open", ...options.jobs?.[id] }) as Job }),
		fleet: { get: (id: string) => (options.fleet?.includes(id) ? ({ job_id: id } as FleetRecord) : undefined) },
		journal: (wake: DurableWakeupInput) => void wakes.push(wake),
	};
	const queue = new DispatchQueue(options_);
	const file = join(home.path, LAYOUT.dispatchQueueFile);
	const bytes = () => readFileSync(file, "utf8");
	return { home: home.path, queue, calls, wakes, file, bytes, reopen: () => new DispatchQueue(options_) };
}

test("4B2-T1: FIFO, positions, the duplicate and 32-entry caps, and persistence across instances", async (t) => {
	const b = queueBench(t);
	assert.deepEqual(b.queue.ids(), [], "an absent file reads as empty");
	assert.equal(b.queue.enqueue("cp-aaa1", { task: "one" }), 1);
	assert.equal(b.queue.enqueue("cp-aaa2", { task: "two", wall_clock_seconds: 60 }), 2);
	assert.throws(() => b.queue.enqueue("cp-aaa1", {}), /already queued at position 1/);
	assert.equal(b.queue.position("cp-aaa2"), 2);
	assert.equal(b.reopen().position("cp-aaa2"), 2, "the file persists across instances");
	const two = b.bytes();
	assert.throws(() => b.queue.enqueue("cp-bad", { scope: "XL" } as never), /refusing to write an invalid/);
	assert.equal(b.bytes(), two, "an invalid request never reaches disk");
	assert.equal(b.queue.position("cp-aaa2"), 2, "the queue stays readable");
	for (let n = 3; n <= DISPATCH_QUEUE_MAX; n++) b.queue.enqueue(`cp-aaa${n}`, {});
	assert.throws(() => b.queue.enqueue("cp-full", {}), /queue is full \(32 entries\)/);
	await b.queue.drain();
	assert.deepEqual(b.calls.slice(0, 2), ["cp-aaa1", "cp-aaa2"], "FIFO");
	assert.equal(b.calls.length, DISPATCH_QUEUE_MAX);
	assert.deepEqual(b.queue.ids(), []);
	assert.equal(b.wakes.filter((wake) => /QUEUED DISPATCH STARTED — cp-aaa1\b/.test(wake.content)).length, 1);
});

test("4B2-T1: spawn_cap and parallelism_full keep the head untouched and stop the drain", async (t) => {
	for (const error of [new SpawnSafetyError("spawn cap reached (2/2 workers)", { code: "spawn_cap" }), new MandateError("dispatch-parallelism 1 is full", { code: "parallelism_full" })]) {
		const b = queueBench(t, { dispatch: async () => Promise.reject(error) });
		b.queue.enqueue("cp-aaa1", { task: "one" });
		b.queue.enqueue("cp-aaa2", { task: "two" });
		const before = b.bytes();
		await b.queue.drain();
		assert.deepEqual(b.calls, ["cp-aaa1"], "the drain stops at a full head");
		assert.equal(b.bytes(), before, "a kept head is never rewritten");
		assert.deepEqual(b.wakes, []);
	}
});

test("4B2-T1: other errors, promote, a closed job and a job already in the fleet each drop with one wake-up", async (t) => {
	const b = queueBench(t, {
		dispatch: async (request) => {
			if (request.jobId === "cp-aaa1") throw new Error("preflight refused\nsecond line");
			if (request.jobId === "cp-aaa2") return { state: "promote" };
			return { state: "dispatched" };
		},
		jobs: { "cp-aaa3": { status: "closed", close_reason: "dropped: superseded" } },
		fleet: ["cp-aaa4"],
	});
	for (const id of ["cp-aaa1", "cp-aaa2", "cp-aaa3", "cp-aaa4", "cp-aaa5"]) b.queue.enqueue(id, {});
	await b.queue.drain();
	assert.deepEqual(b.calls, ["cp-aaa1", "cp-aaa2", "cp-aaa5"], "a closed or fleet-known job is dropped before any dispatch");
	assert.deepEqual(b.queue.ids(), []);
	const lines = b.wakes.map((wake) => wake.content.split("\n")[0]);
	assert.match(lines[0]!, /^QUEUED DISPATCH DROPPED: preflight refused — cp-aaa1/);
	assert.match(lines[1]!, /^QUEUED DISPATCH DROPPED: the job already has a live worker .* cp-aaa2/);
	assert.match(lines[2]!, /^QUEUED DISPATCH DROPPED: the job is closed \(dropped: superseded\) — cp-aaa3/);
	assert.match(lines[3]!, /^QUEUED DISPATCH DROPPED: the job is already in the fleet — cp-aaa4/);
	assert.match(lines[4]!, /^QUEUED DISPATCH STARTED — cp-aaa5/);
	assert.equal(new Set(b.wakes.map((wake) => wake.id)).size, 5, "one wake-up each");
});

test("4B2-T1: ownership is read at the start and per entry; a home drain and a full capacity dispatch nothing", async (t) => {
	const never = queueBench(t, { owns: () => false });
	never.queue.enqueue("cp-aaa1", {});
	await never.queue.drain();
	assert.deepEqual(never.calls, []);

	let owner = true;
	const flips = queueBench(t, {
		owns: () => owner,
		dispatch: async () => {
			owner = false;
			return { state: "dispatched" };
		},
	});
	flips.queue.enqueue("cp-aaa1", {});
	flips.queue.enqueue("cp-aaa2", {});
	await flips.queue.drain();
	assert.deepEqual(flips.calls, ["cp-aaa1"], "a lock lost mid-drain stops it before the next entry");
	assert.deepEqual(flips.queue.ids(), ["cp-aaa2"]);

	const throws = queueBench(t, {
		owns: () => {
			throw new Error("lock unreadable");
		},
	});
	throws.queue.enqueue("cp-aaa1", {});
	await throws.queue.drain();
	assert.deepEqual(throws.calls, [], "an unreadable lock fails closed");

	const draining = queueBench(t);
	draining.queue.enqueue("cp-aaa1", {});
	const file = drainFile(draining.home);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ state: "draining", started_at: isoTimestamp(), deadline: isoTimestamp(), timeout_s: 60, jobs: [] }));
	await draining.queue.drain();
	assert.deepEqual(draining.calls, [], "no dispatch during a home drain");

	const full = queueBench(t, { capacityFree: () => false });
	full.queue.enqueue("cp-aaa1", {});
	await full.queue.drain();
	assert.deepEqual(full.calls, []);
});

test("4B2-T1: concurrent drains dispatch each entry once", async (t) => {
	const b = queueBench(t, { dispatch: async () => (await new Promise((resolve) => setImmediate(resolve)), { state: "dispatched" }) });
	b.queue.enqueue("cp-aaa1", {});
	b.queue.enqueue("cp-aaa2", {});
	await Promise.all([b.queue.drain(), b.queue.drain(), b.queue.drain()]);
	await b.queue.settled();
	assert.deepEqual(b.calls, ["cp-aaa1", "cp-aaa2"]);
});

test("4B2-T1b: a real MandateStore parallelism refusal keeps the head byte-identical; freeing the slot starts both", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	store.issue({ projects: ["demo"], objective: "ship the queue", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, dispatch_parallelism: 1 });
	const jobs = [{ job_id: "cp-b", project: "demo", phase: "waiting" }];
	const calls: string[] = [];
	const caught: unknown[] = [];
	const wakes: DurableWakeupInput[] = [];
	const queue = new DispatchQueue({
		home: home.path,
		owns: () => true,
		capacityFree: () => true,
		dispatch: async (request) => {
			calls.push(request.jobId);
			try {
				await store.assertDispatchAllowed({ jobId: request.jobId, project: "demo", kind: "ship" }, jobs);
			} catch (error) {
				caught.push(error);
				throw error;
			}
			return { state: "dispatched" };
		},
		ledger: () => ({ show: async (id: string) => ({ id, status: "open" }) as Job }),
		fleet: { get: () => undefined },
		journal: (wake) => void wakes.push(wake),
	});
	queue.enqueue("cp-aaa1", { task: "one" });
	queue.enqueue("cp-aaa2", { task: "two" });
	const file = join(home.path, LAYOUT.dispatchQueueFile);
	const before = readFileSync(file, "utf8");
	await queue.drain();
	assert.deepEqual(calls, ["cp-aaa1"]);
	assert.ok(caught[0] instanceof MandateError);
	assert.equal((caught[0] as MandateError).code, "parallelism_full");
	assert.equal(readFileSync(file, "utf8"), before, "the kept head is byte-identical");
	assert.equal(wakes.length, 0, "no STARTED or DROPPED wake-up");

	jobs[0]!.phase = "held";
	await queue.drain();
	assert.deepEqual(calls, ["cp-aaa1", "cp-aaa1", "cp-aaa2"]);
	assert.deepEqual(queue.ids(), []);
	assert.deepEqual(wakes.map((wake) => wake.content.split(" — ")[0]), ["QUEUED DISPATCH STARTED", "QUEUED DISPATCH STARTED"]);
});
