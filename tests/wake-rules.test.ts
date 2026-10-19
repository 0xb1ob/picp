import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import type { cpNext, NextActionKind, NextResult } from "../src/next.ts";
import { RunRegistry } from "../src/runs.ts";
import { boundedWakeupId } from "../src/wakeup-outbox.ts";
import {
	createWakeRules,
	isRelayOnlyNotice,
	isResolveStop,
	journalWakeRule,
	NextCache,
	relayOnlyMessage,
	type WakeRulesPost,
	wakeRulesEnabled,
} from "../src/wake-rules.ts";
import { createScratchHome, readRunEvents } from "./harness/index.ts";

const RESOLVE_ID = "continuation:cp-x:1:abc123def456:ci:resolve";

function homeWith(t: { after(fn: () => void): void }, switchFile?: string): string {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	if (switchFile !== undefined) {
		mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
		writeFileSync(join(home.path, LAYOUT.data, "wake-rules.json"), switchFile);
	}
	return home.path;
}

test("wakeRulesEnabled: absent is on, false or anything malformed is off", (t) => {
	assert.equal(wakeRulesEnabled(homeWith(t)), true);
	assert.equal(wakeRulesEnabled(homeWith(t, '{"enabled":false}')), false);
	assert.equal(wakeRulesEnabled(homeWith(t, '{"enabled":true}')), true);
	assert.equal(wakeRulesEnabled(homeWith(t, "{}")), true);
	assert.equal(wakeRulesEnabled(homeWith(t, "not json")), false);
	assert.equal(wakeRulesEnabled(homeWith(t, '{"enabled":"no"}')), false);
	assert.equal(wakeRulesEnabled(undefined), false);
});

test("isResolveStop matches only resolve stops; a hashed long id fails safe", () => {
	assert.equal(isResolveStop(RESOLVE_ID), true);
	for (const id of ["continuation:cp-x:1:abc123def456:ci:surface", "continuation:cp-x:1:abc123def456:ci:retry", "continuation:done:cp-x:1", "continuation:window:x"]) {
		assert.equal(isResolveStop(id), false, id);
	}
	assert.equal(isResolveStop(boundedWakeupId(`continuation:cp-${"x".repeat(150)}:1:abc123def456:ci:resolve`)), false);
});

test("isRelayOnlyNotice and relayOnlyMessage", () => {
	assert.equal(isRelayOnlyNotice("HELD PR LANDED — cp-x"), true);
	assert.equal(isRelayOnlyNotice("[demo] HELD PR STOPPED — cp-x (continuation, next: resolve)\n  why"), true);
	assert.equal(isRelayOnlyNotice("HELD PR STOPPED — cp-x (continuation, next: surface)"), false);
	assert.equal(relayOnlyMessage({ details: { relay_only: true } }), true);
	assert.equal(relayOnlyMessage({ details: {} }), false);
	assert.equal(relayOnlyMessage(undefined), false);
});

test("NextCache: fresh for 60 s, failure reported, refresh attempts remembered", () => {
	const cache = new NextCache();
	assert.deepEqual(cache.fresh(0), { reason: "cp_next unavailable: never computed" });
	cache.remember("wait", 0);
	assert.deepEqual(cache.fresh(59_000), { kind: "wait" });
	assert.deepEqual(cache.fresh(61_000), { reason: "cp_next stale" });
	cache.fail("x", 0);
	assert.deepEqual(cache.fresh(1), { reason: "cp_next unavailable: x" });
	assert.equal(cache.attemptedRecently(0), false);
	cache.attempt(1_000);
	assert.equal(cache.attemptedRecently(60_000), true);
	assert.equal(cache.attemptedRecently(61_000), false);
});

function rulesBench(t: { after(fn: () => void): void }, options: { switchFile?: string; next?: () => Promise<NextResult>; wait?: number } = {}) {
	const home = homeWith(t, options.switchFile);
	const journal: Array<{ job: string; kind: string; payload: Record<string, unknown> }> = [];
	let calls = 0;
	let resweeps = 0;
	let clock = 1_000_000;
	const post = {
		durableWakeups: { pending: () => [{ id: RESOLVE_ID, job_id: "cp-x" }] },
		runs: { open: (job: string) => ({ cp: (kind: string, payload: Record<string, unknown>) => journal.push({ job, kind, payload }) }) },
		ledger: () => undefined,
		dispatchQueue: { ids: () => [] },
	} as unknown as WakeRulesPost;
	const override = (async () => {
		calls++;
		return options.next ? options.next() : { ready: [], action: { kind: "wait", reason: "x" } };
	}) as unknown as typeof cpNext;
	let settled: () => void = () => {};
	const resweptOnce = new Promise<void>((resolve) => (settled = resolve));
	const rules = createWakeRules({
		home: () => home, post: () => post, override, now: () => clock, refreshWaitMs: options.wait ?? 1_000,
		resweep: () => {
			resweeps++;
			settled();
		},
	});
	return { rules, journal, resweptOnce, calls: () => calls, resweeps: () => resweeps, tick: (ms: number) => (clock += ms) };
}

const next = (kind: NextActionKind): Promise<NextResult> => Promise.resolve({ ready: [], action: { kind, reason: kind } });

test("createWakeRules: a pending resolve with no cache defers one sweep for one refresh, then relays on a quiet next", async (t) => {
	const b = rulesBench(t);
	assert.equal(b.rules.deferSweep(), true);
	assert.equal(b.rules.deferSweep(), true, "still deferred while the refresh runs");
	await b.resweptOnce;
	assert.equal(b.calls(), 1);
	assert.equal(b.resweeps(), 1);
	assert.equal(b.rules.deferSweep(), false, "a fresh cache sweeps");
	assert.equal(b.rules.relayOnly({ id: RESOLVE_ID, job_id: "cp-x" }), true);
	assert.equal(b.rules.relayOnly({ id: RESOLVE_ID, job_id: "cp-x" }), true);
	assert.deepEqual(b.journal, [{ job: "cp-x", kind: "continuation", payload: { wake_rule: "held_stop_resolve", decision: "relayed", reason: "cp_next wait", next_kind: "wait" } }]);
});

test("createWakeRules: a refresh that never settles times out, re-sweeps once, and the stop wakes the parent", async (t) => {
	const b = rulesBench(t, { next: () => new Promise<NextResult>(() => {}), wait: 10 });
	assert.equal(b.rules.deferSweep(), true);
	await b.resweptOnce;
	assert.equal(b.resweeps(), 1);
	assert.equal(b.rules.deferSweep(), false, "one refresh per 60 s: the deferral never loops");
	assert.equal(b.rules.relayOnly({ id: RESOLVE_ID, job_id: "cp-x" }), false);
	assert.deepEqual(b.journal.map((line) => [line.payload.decision, line.payload.reason]), [["woke", "cp_next unavailable: timed out"]]);
});

test("createWakeRules: another job's work pending wakes the parent and journals why", async (t) => {
	const b = rulesBench(t, { next: () => next("dispatch") });
	await b.rules.next();
	assert.equal(b.rules.deferSweep(), false);
	assert.equal(b.rules.relayOnly({ id: RESOLVE_ID, job_id: "cp-x" }), false);
	assert.deepEqual(b.journal.map((line) => [line.payload.decision, line.payload.reason]), [["woke", "cp_next dispatch"]]);
	assert.equal(b.rules.relayOnly({ id: "continuation:cp-x:1:abc123def456:ci:surface", job_id: "cp-x" }), false);
	assert.equal(b.journal.length, 1, "a non-resolve id is no candidate and journals nothing");
});

test("createWakeRules: a stale cache wakes the parent", async (t) => {
	const b = rulesBench(t);
	await b.rules.next();
	b.tick(61_000);
	assert.equal(b.rules.relayOnly({ id: RESOLVE_ID, job_id: "cp-x" }), false);
	assert.deepEqual(b.journal.map((line) => line.payload.reason), ["cp_next stale"]);
});

test("createWakeRules: the kill switch off restores today's wake with no cp_next and no journal", async (t) => {
	const b = rulesBench(t, { switchFile: '{"enabled":false}' });
	assert.equal(b.rules.deferSweep(), false);
	assert.equal(b.rules.relayOnly({ id: RESOLVE_ID, job_id: "cp-x" }), false);
	assert.equal(b.calls(), 0);
	assert.equal(b.journal.length, 0);
});

test("journalWakeRule writes one continuation event and never throws for an unsafe id", (t) => {
	const home = homeWith(t);
	const runs = new RunRegistry(home);
	t.after(() => runs.closeAll());
	journalWakeRule(runs, "cp-x", { wake_rule: "held_stop_resolve", decision: "woke", reason: "cp_next dispatch" });
	journalWakeRule(runs, "../escape", { wake_rule: "held_stop_resolve", decision: "woke", reason: "x" });
	journalWakeRule(undefined, "cp-x", { wake_rule: "held_stop_resolve", decision: "woke", reason: "x" });
	const events = readRunEvents(home, "cp-x").filter((event) => event.type === "continuation");
	assert.equal(events.length, 1);
	assert.equal((events[0]!.payload as Record<string, unknown>).wake_rule, "held_stop_resolve");
});
