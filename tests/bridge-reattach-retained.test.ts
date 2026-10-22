import assert from "node:assert/strict";
import { test } from "node:test";
import { reattachLoop } from "../src/bridge-reattach.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
