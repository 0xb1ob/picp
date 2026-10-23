import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import "./harness/fake-parent-tracker.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHooks } from "../extensions/command-post/session-hooks.ts";
import { createSessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { CommandPost } from "../src/command-post.ts";
import { drainFile } from "../src/drain.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { LAYOUT } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

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
