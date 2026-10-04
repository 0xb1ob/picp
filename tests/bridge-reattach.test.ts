import assert from "node:assert/strict";
import { test } from "node:test";
import { reattachLoop } from "../src/bridge-reattach.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the loop retries with doubling delay up to the cap, one loop at a time, until an attempt succeeds", async () => {
	const at: number[] = [];
	const begin = Date.now();
	let inFlight = 0;
	let overlap = false;
	const loop = reattachLoop(async () => {
		overlap ||= ++inFlight > 1;
		at.push(Date.now() - begin);
		await sleep(5);
		inFlight--;
		if (at.length < 5) throw new Error("no host");
	}, 40, 100);
	loop.schedule();
	await sleep(700);
	assert.equal(at.length, 5, `attempts: ${at}`);
	assert.equal(overlap, false);
	const gaps = at.slice(1).map((time, index) => time - at[index]!);
	// 40, 80, 100 (capped), 100 — each gap includes the 5 ms attempt itself.
	assert.ok(gaps[0]! >= 80 && gaps[0]! < 130, `gaps: ${gaps}`);
	assert.ok(gaps[1]! >= 100 && gaps[1]! < 150, `gaps: ${gaps}`);
	assert.ok(gaps[3]! >= 100 && gaps[3]! < 150, `capped: ${gaps}`);
	await sleep(250);
	assert.equal(at.length, 5, "a success ends the loop");
	loop.schedule();
	await sleep(120);
	assert.equal(at.length, 6, "a later close starts a fresh loop");
});

test("cancel stops the loop, including an attempt already in flight", async () => {
	let attempts = 0;
	const loop = reattachLoop(async () => { attempts++; await sleep(30); throw new Error("no host"); }, 10, 20);
	loop.schedule();
	await sleep(25);
	loop.cancel();
	await sleep(200);
	assert.equal(attempts, 1, "no attempt after cancel");
});

test("a close during the attempt that just succeeded schedules one more attempt", async () => {
	let attempts = 0;
	let loop!: ReturnType<typeof reattachLoop>;
	loop = reattachLoop(async () => { if (++attempts === 1) loop.schedule(); }, 10, 20);
	loop.schedule();
	await sleep(150);
	assert.equal(attempts, 2);
});
