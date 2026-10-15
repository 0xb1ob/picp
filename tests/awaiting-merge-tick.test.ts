/** awaiting_merge PR6 follow-up: the parked-PR sweep timer gates each tick on the lock, not its start. */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAwaitingMergeTick } from "../extensions/command-post/awaiting-merge-tick.ts";
import { ciWatchIntervalMs } from "../src/ci-watch.ts";
import type { ExtensionDeps } from "../extensions/command-post/shared.ts";

function bench(t: TestContext) {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const handlers = new Map<string, () => Promise<void>>();
	const pi = { on: (event: string, handler: () => Promise<void>) => void handlers.set(event, handler) } as unknown as ExtensionAPI;
	let sweeps = 0;
	const lock = { held: false };
	const deps = { commandPost: () => ({ awaitingMerge: { sweep: async () => void (sweeps += 1) } }) } as unknown as ExtensionDeps;
	registerAwaitingMergeTick(pi, deps, () => lock.held);
	const emit = (event: string) => handlers.get(event)!();
	return { emit, lock, sweeps: () => sweeps, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("a lock taken after session_start still sweeps on the next interval", async (t) => {
	// Regression: the interval was only armed when the lock was held at start, so a later lock never swept.
	const b = bench(t);
	await b.emit("session_start");
	b.tick(0);
	assert.equal(b.sweeps(), 0, "no lock, no sweep");
	b.lock.held = true;
	b.tick(ciWatchIntervalMs());
	await Promise.resolve();
	assert.equal(b.sweeps(), 1);
	b.lock.held = false;
	b.tick(ciWatchIntervalMs());
	await Promise.resolve();
	assert.equal(b.sweeps(), 1, "a released lock stops sweeping");
	await b.emit("session_shutdown");
});

test("session_shutdown clears the startup catch-up and the interval", async (t) => {
	const b = bench(t);
	b.lock.held = true;
	await b.emit("session_start");
	await b.emit("session_shutdown");
	b.tick(ciWatchIntervalMs() * 2);
	await Promise.resolve();
	assert.equal(b.sweeps(), 0, "no tick after shutdown, the startup pass included");
});
