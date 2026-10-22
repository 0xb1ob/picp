import assert from "node:assert/strict";
import { test } from "node:test";
import { reattachLoop } from "../src/bridge-reattach.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("reattachLoop defaults read CP_BRIDGE_REATTACH_FIRST_SECONDS", async (t) => {
	// A default that bypassed the knob would wait 1 s and miss the first attempt below.
	process.env.CP_BRIDGE_REATTACH_FIRST_SECONDS = "0.01";
	t.after(() => delete process.env.CP_BRIDGE_REATTACH_FIRST_SECONDS);
	let attempts = 0;
	const loop = reattachLoop(async () => { attempts++; });
	loop.schedule();
	await sleep(200);
	loop.cancel();
	assert.equal(attempts, 1);
});
