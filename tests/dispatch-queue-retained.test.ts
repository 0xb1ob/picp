import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DISPATCH_QUEUE_MAX, type FleetRecord, type Job, LAYOUT } from "../src/contracts.ts";
import { DispatchQueue, toDispatchRequest } from "../src/dispatch-queue.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
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

test("skill mentions PR2: a queued request keeps skill names, refuses a path-shaped one, and replays them", async (t) => {
	const b = queueBench(t);
	assert.throws(() => b.queue.enqueue("cp-bad", { skills: ["../etc"] }), /refusing to write an invalid/);
	assert.throws(() => b.queue.enqueue("cp-bad", { skills: ["tdd-x", "tdd-x"] }), /refusing to write an invalid/);
	b.queue.enqueue("cp-sk1", { task: "x", skills: ["tdd-x", "writing-plans"] });
	assert.deepEqual(toDispatchRequest({ job_id: "cp-sk1", request: { task: "x", skills: ["tdd-x", "writing-plans"] } }), { jobId: "cp-sk1", task: "x", skills: ["tdd-x", "writing-plans"] });
	assert.deepEqual(toDispatchRequest({ job_id: "cp-sk2", request: { task: "x" } }), { jobId: "cp-sk2", task: "x" }, "no skills, no key");
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



test("4B2-T1: concurrent drains dispatch each entry once", async (t) => {
	const b = queueBench(t, { dispatch: async () => (await new Promise((resolve) => setImmediate(resolve)), { state: "dispatched" }) });
	b.queue.enqueue("cp-aaa1", {});
	b.queue.enqueue("cp-aaa2", {});
	await Promise.all([b.queue.drain(), b.queue.drain(), b.queue.drain()]);
	await b.queue.settled();
	assert.deepEqual(b.calls, ["cp-aaa1", "cp-aaa2"]);
});
