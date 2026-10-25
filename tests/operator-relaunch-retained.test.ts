/**
 * Restart session (cp-aqxl), src/operator-relaunch.ts: the bridge's ports. Kept because no entry point accepts a
 * restart while a bridge-started compaction runs, so the whenIdle deferral is unit-only; the rest is S27 e2e.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RELAUNCH_ENV, relaunchPorts } from "../src/operator-relaunch.ts";
import { createScratchHome } from "./harness/index.ts";

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return home.path;
}

test("relaunchPorts: the relaunch file only when absolute; shutdown goes through whenIdle to ctx.shutdown", (t) => {
	const home = scratch(t);
	let shutdowns = 0;
	const deferred: Array<() => void> = [];
	const ports = relaunchPorts({ target: () => ({ home, mode: "multi" }), ctx: () => ({ shutdown: () => { shutdowns += 1; } }), whenIdle: (fn) => deferred.push(fn), env: { [RELAUNCH_ENV]: "/abs/relaunch.json" } });
	assert.equal(ports.relaunchFile(), "/abs/relaunch.json");
	assert.equal(relaunchPorts({ target: () => ({ home, mode: "multi" }), ctx: () => undefined, whenIdle: (fn) => fn(), env: { [RELAUNCH_ENV]: "rel/relaunch.json" } }).relaunchFile(), undefined, "relative: unsupported");
	assert.equal(relaunchPorts({ target: () => ({ home, mode: "multi" }), ctx: () => undefined, whenIdle: (fn) => fn(), env: {} }).relaunchFile(), undefined, "plain pi: unsupported");
	ports.shutdown();
	assert.equal(shutdowns, 0, "deferred while compaction runs");
	deferred.shift()!();
	assert.equal(shutdowns, 1);
	assert.deepEqual(ports.parentSends(), { ids: [], error: null });
});
