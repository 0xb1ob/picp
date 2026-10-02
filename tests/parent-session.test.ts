/**
 * Headless parent session: display timers stay hasUI-gated; orchestration
 * timers (CI watch, reconcile sweeps) run in every mode.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENV_HEADLESS } from "../src/contracts.ts";
import {
	formatParentSession,
	isHeadlessParent,
	parentSession,
	type RunningTimers,
} from "../src/parent-session.ts";
import { commandPostSource } from "./harness/index.ts";

const RUNNING_ALL: RunningTimers = { widget: true, keys: true, ciWatch: true, orchestration: true };
const RUNNING_HEADLESS: RunningTimers = { widget: false, keys: false, ciWatch: true, orchestration: true };

test("TUI with UI: display and orchestration timers", () => {
	const session = parentSession({ mode: "tui", hasUI: true });
	assert.equal(session.headless, false);
	assert.equal(session.widget, true);
	assert.equal(session.keys, true);
	assert.equal(session.ciWatch, true);
	assert.equal(session.orchestration, true);
});

test("RPC: headless, no keys, orchestration and CI watch still on", () => {
	const withUi = parentSession({ mode: "rpc", hasUI: true });
	assert.equal(withUi.headless, true);
	assert.equal(withUi.widget, true, "display timers stay hasUI-gated");
	assert.equal(withUi.keys, false);
	assert.equal(withUi.ciWatch, true);
	assert.equal(withUi.orchestration, true);

	const noUi = parentSession({ mode: "rpc", hasUI: false });
	assert.equal(noUi.headless, true);
	assert.equal(noUi.widget, false);
	assert.equal(noUi.keys, false);
	assert.equal(noUi.ciWatch, true);
	assert.equal(noUi.orchestration, true);
});

test("print/json: no display timers, orchestration still on", () => {
	for (const mode of ["print", "json"]) {
		const session = parentSession({ mode, hasUI: false });
		assert.equal(session.widget, false, mode);
		assert.equal(session.keys, false, mode);
		assert.equal(session.ciWatch, true, mode);
		assert.equal(session.orchestration, true, mode);
	}
});

test("CP_HEADLESS=1 forces bridge-driven even in a TUI", () => {
	assert.equal(isHeadlessParent({ mode: "tui" }, { [ENV_HEADLESS]: "1" }), true);
	const session = parentSession({ mode: "tui", hasUI: true }, { [ENV_HEADLESS]: "1" });
	assert.equal(session.headless, true);
	assert.equal(session.keys, false, "no key listeners when bridge-driven");
	assert.equal(session.widget, true, "widget still hasUI-gated");
	assert.equal(session.ciWatch, true);
});

test("formatParentSession names the mode and which timers are running", () => {
	const tui = formatParentSession(parentSession({ mode: "tui", hasUI: true }), RUNNING_ALL);
	assert.match(tui, /session: tui/);
	assert.doesNotMatch(tui, /headless/);
	assert.match(tui, /ci-watch on/);
	assert.match(tui, /widget on/);
	assert.match(tui, /keys on/);

	const rpc = formatParentSession(parentSession({ mode: "rpc", hasUI: false }), RUNNING_HEADLESS);
	assert.match(rpc, /session: rpc/);
	assert.match(rpc, /headless/);
	assert.match(rpc, /ci-watch on/);
	assert.match(rpc, /orchestration on/);
	assert.match(rpc, /widget off/);
	assert.match(rpc, /keys off/);
});

test("wiring: CI watch is not gated on hasUI; widget timer still is", () => {
	const source = commandPostSource();
	assert.doesNotMatch(source, /if \(ctx\.hasUI && !s\.ciWatchTimer\)/);
	assert.match(source, /if \(!s\.ciWatchTimer\)/);
	assert.match(source, /if \(ctx\.hasUI && !s\.widgetTimer\)/);
});
