/**
 * cp-drain-stale-record-2: a drained `state/drain.json` this process did not write is cleared first at session start,
 * by the start gates when it is provably spent, and by the `cp_parent` drain_cancel action — never a record it owns.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import "./harness/fake-parent-tracker.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHooks } from "../extensions/command-post/session-hooks.ts";
import { createSessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { CommandPost } from "../src/command-post.ts";
import { assertNotDraining, type DrainRecord, drainFile, DrainError, readDrain, setRunningVersion } from "../src/drain.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { LAYOUT } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

function writeDrain(home: string, overrides: Partial<DrainRecord> = {}): void {
	mkdirSync(dirname(drainFile(home)), { recursive: true });
	const record: DrainRecord = { state: "drained", started_at: "2020-01-01T00:00:00.000Z", finished_at: "2020-01-01T00:00:01.000Z", deadline: "x", timeout_s: 1, reported: true, jobs: [], ...overrides };
	writeFileSync(drainFile(home), JSON.stringify(record));
}

function post(t: { after(fn: () => unknown): void }, home: string): CommandPost {
	const made = new CommandPost({ home, packageRoot: PACKAGE_ROOT, holdsParentLock: () => true });
	t.after(() => made.shutdown());
	return made;
}

test("the gate clears a foreign drained record that finished before this parent started, journals it, and opens", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const made = post(t, home.path);
	writeDrain(home.path);
	assert.doesNotThrow(() => assertNotDraining(home.path, "dispatch"));
	assert.equal(existsSync(drainFile(home.path)), false);
	assert.equal(made.durableWakeups.pending().filter((entry) => entry.content.startsWith("RESTART AFTER DRAIN")).length, 1, "one notice");
});

test("the gate clears a drained auto-update record whose target is the running version, and only then", (t) => {
	const home = createScratchHome();
	t.after(() => {
		setRunningVersion(undefined);
		home.cleanup();
	});
	post(t, home.path);
	const fresh = { finished_at: new Date().toISOString(), cause: { reason: "auto-update" as const, target_sha: "5487011ab472" } };
	writeDrain(home.path, fresh);
	setRunningVersion("0123456789abcdef");
	assert.throws(() => assertNotDraining(home.path, "dispatch"), DrainError, "another version is still draining");
	setRunningVersion("5487011ab47272c39ea19f973d2fe5c12ae6893c");
	assert.doesNotThrow(() => assertNotDraining(home.path, "dispatch"));
	assert.equal(existsSync(drainFile(home.path)), false);
});

test("the gate never clears a record this process wrote, nor a draining one", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const made = post(t, home.path);
	made.drain.start(); // idle: drained at once, finished just now
	assert.throws(() => assertNotDraining(home.path, "dispatch"), DrainError);
	rmSync(drainFile(home.path));
	writeDrain(home.path, { state: "draining" });
	assert.throws(() => assertNotDraining(home.path, "dispatch"), DrainError, "draining is a live flag, whatever its age");
	assert.equal(readDrain(home.path)?.state, "draining");
});

test("after an external rm the next dispatch gate in the same process is open", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const made = post(t, home.path);
	made.drain.start();
	assert.throws(() => assertNotDraining(home.path, "dispatch"), DrainError);
	rmSync(drainFile(home.path));
	assert.doesNotThrow(() => assertNotDraining(home.path, "dispatch"));
});

/** Real session hooks over a scratch home whose broken schedules file ends every session_start before reconcile. */
function sessionHarness(t: { after(fn: () => unknown): void }) {
	const home = createScratchHome();
	const previous = { home: process.env.CP_HOME, mode: process.env.CP_MODE };
	process.env.CP_HOME = home.path;
	process.env.CP_MODE = "multi";
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerEntryRenderer() {}, registerTool() {}, getAllTools: () => [], sendMessage() {},
	} as unknown as ExtensionAPI;
	const state = createSessionState();
	const made = new CommandPost({ home: home.path, packageRoot: PACKAGE_ROOT, holdsParentLock: () => true });
	state.post = made;
	state.parentLock = { release() {} } as never;
	state.installNudgeShown = state.piVersionNudgeShown = state.routingNudgeShown = true;
	const wakeups = createWakeupSurfaces(pi, state, { commandPost: () => made, repaintWidget: () => {} });
	registerSessionHooks(pi, state, createSessionPost(pi, state, wakeups), wakeups);
	let reconciled = false;
	const reconcile = made.reconcile.bind(made);
	made.reconcile = async (...args) => { reconciled = true; return reconcile(...args); };
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({}, { hasUI: false, cwd: home.path, sessionManager: { getSessionId: () => "A", getBranch: () => [] } });
	};
	t.after(async () => {
		await fire("session_shutdown");
		for (const [key, value] of [["CP_HOME", previous.home], ["CP_MODE", previous.mode]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		home.cleanup();
	});
	mkdirSync(`${home.path}/${LAYOUT.state}`, { recursive: true });
	writeFileSync(`${home.path}/${LAYOUT.state}/schedules.json`, "{");
	return { home: home.path, made, fire, reconciled: () => reconciled };
}

test("session_start clears a foreign drained record first, even when a later startup step ends the session early", async (t) => {
	const h = sessionHarness(t);
	writeDrain(h.home);
	await h.fire("session_start");
	assert.equal(h.reconciled(), false, "the startup ended before reconcile, so only the first-step clear can have run");
	assert.equal(existsSync(drainFile(h.home)), false);
});

test("a second session_start in the same process clears the drain the first session's parent wrote", async (t) => {
	const h = sessionHarness(t);
	await h.fire("session_start");
	h.made.drain.start(); // idle: drained; this process owns it until the session shuts down
	await h.fire("session_start");
	assert.equal(existsSync(drainFile(h.home)), true, "the owning session keeps its own drain");
	await h.fire("session_shutdown");
	await h.fire("session_start");
	assert.equal(h.reconciled(), false);
	assert.equal(existsSync(drainFile(h.home)), false, "the relaunched session is not an owner any more");
});
