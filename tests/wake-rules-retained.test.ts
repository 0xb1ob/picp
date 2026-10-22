// Retained S20 injected-input contracts; assertion boundaries are listed in docs/testing-migration-s20.md.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CiObservation } from "../src/ci-watch.ts";
import { CommandPost } from "../src/command-post.ts";
import { LAYOUT } from "../src/contracts.ts";
import type { ContinuationAction, ContinuationOutcome } from "../src/held-continuation.ts";
import type { cpNext, NextActionKind, NextResult } from "../src/next.ts";
import { RunRegistry } from "../src/runs.ts";
import { createWakeRules, isRelayOnlyNotice, journalWakeRule, NextCache, relayOnlyMessage, type WakeRulesPost, wakeRulesEnabled } from "../src/wake-rules.ts";
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

test("isRelayOnlyNotice and relayOnlyMessage", () => {
	assert.equal(isRelayOnlyNotice("HELD PR LANDED — cp-x"), true);
	assert.equal(isRelayOnlyNotice("[demo] HELD PR STOPPED — cp-x (continuation, next: resolve)\n  why"), true);
	assert.equal(isRelayOnlyNotice("HELD PR STOPPED — cp-x (continuation, next: surface)"), false);
	assert.equal(isRelayOnlyNotice("[demo] CI GREEN — cp-x: cp_review attempt 1 started on abc — handled in code, no parent turn. https://x/7"), true);
	assert.equal(isRelayOnlyNotice("CI/PR OBSERVED — 1 new fact about a held PR"), false);
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

type BenchOptions = { switchFile?: string; next?: () => Promise<NextResult>; wait?: number; outcome?: () => Promise<ContinuationOutcome> | undefined };

function rulesBench(t: { after(fn: () => void): void }, options: BenchOptions = {}) {
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
		continuation: { ciOutcome: () => options.outcome?.() },
	} as unknown as WakeRulesPost;
	const override = (async () => {
		calls++;
		return options.next ? options.next() : { ready: [], action: { kind: "wait", reason: "x" } };
	}) as unknown as typeof cpNext;
	let settled: () => void = () => {};
	const resweptOnce = new Promise<void>((resolve) => (settled = resolve));
	const rules = createWakeRules({
		home: () => home, post: () => post, override, now: () => clock, refreshWaitMs: options.wait ?? 1_000, ciWaitMs: options.wait ?? 1_000,
		resweep: () => {
			resweeps++;
			settled();
		},
	});
	return { rules, journal, resweptOnce, calls: () => calls, resweeps: () => resweeps, tick: (ms: number) => (clock += ms) };
}

const next = (kind: NextActionKind): Promise<NextResult> => Promise.resolve({ ready: [], action: { kind, reason: kind } });

test("createWakeRules: a relay whose send failed, then woke the parent, journals woke", async (t) => {
	const kinds: NextActionKind[] = ["wait", "dispatch"];
	const b = rulesBench(t, { next: () => next(kinds.shift() ?? "dispatch") });
	const entry = { id: RESOLVE_ID, job_id: "cp-x" };
	await b.rules.next();
	assert.equal(b.rules.relayOnly(entry), true, "the send throws here, so delivered is never called");
	await b.rules.next();
	assert.equal(b.rules.relayOnly(entry), false);
	b.rules.delivered(entry);
	assert.deepEqual(b.journal.map((line) => [line.payload.decision, line.payload.reason]), [["woke", "cp_next dispatch"]]);
});

test("createWakeRules: a refresh that never settles times out, re-sweeps once, and the stop wakes the parent", async (t) => {
	const b = rulesBench(t, { next: () => new Promise<NextResult>(() => {}), wait: 10 });
	assert.equal(b.rules.deferSweep(), true);
	await b.resweptOnce;
	assert.equal(b.resweeps(), 1);
	assert.equal(b.rules.deferSweep(), false, "one refresh per 60 s: the deferral never loops");
	assert.equal(b.rules.relayOnly({ id: RESOLVE_ID, job_id: "cp-x" }), false);
	b.rules.delivered({ id: RESOLVE_ID, job_id: "cp-x" });
	assert.deepEqual(b.journal.map((line) => [line.payload.decision, line.payload.reason]), [["woke", "cp_next unavailable: timed out"]]);
});

test("createWakeRules: a stale cache wakes the parent", async (t) => {
	const b = rulesBench(t);
	await b.rules.next();
	b.tick(61_000);
	assert.equal(b.rules.relayOnly({ id: RESOLVE_ID, job_id: "cp-x" }), false);
	b.rules.delivered({ id: RESOLVE_ID, job_id: "cp-x" });
	assert.deepEqual(b.journal.map((line) => line.payload.reason), ["cp_next stale"]);
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

const KEY = "cp-x|aaaa|ci_green";
const green: CiObservation = { job_id: "cp-x", event: "ci_green", key: KEY, branch: "cp-x", head_sha: "a".repeat(40), reason: "CI green", pr_url: "https://github.com/o/r/pull/7" };
const outcome = (action: ContinuationAction, next?: ContinuationOutcome["next"], jobId = "cp-x"): Promise<ContinuationOutcome> =>
	Promise.resolve({ job_id: jobId, key: KEY, action, steps: 1, reason: `${jobId}: cp_review attempt 1 started on aaaaaaaaaaaa`, ...(next ? { next } : {}) });

test("ciGreen: every off-rule single green fact wakes the parent and journals why", async (t) => {
	const cases: Array<[string, BenchOptions, string]> = [
		["switch off", { switchFile: '{"enabled":false}', outcome: () => outcome("review_started", "review") }, "kill switch"],
		["no outcome", {}, "no continuation outcome"],
		["never settles", { outcome: () => new Promise<ContinuationOutcome>(() => {}), wait: 10 }, "continuation unsettled after 10ms"],
		["stopped", { outcome: () => outcome("stopped", "surface") }, "outcome stopped/surface"],
		["done", { outcome: () => outcome("done", "done") }, "outcome done/done"],
		["wait", { outcome: () => outcome("wait", "wait") }, "outcome wait/wait"],
		["coalesced", { outcome: () => outcome("coalesced") }, "outcome coalesced/none"],
		["other job", { outcome: () => outcome("review_started", "review", "cp-y") }, "outcome review_started/review"],
		["dispatch", { outcome: () => outcome("review_started", "review"), next: () => next("dispatch") }, "cp_next dispatch"],
		["mission_end", { outcome: () => outcome("review_started", "review"), next: () => next("mission_end") }, "cp_next mission_end"],
		["throws", { outcome: () => outcome("review_started", "review"), next: () => Promise.reject(new Error("down\nstack")) }, "cp_next failed: down"],
	];
	for (const [name, options, reason] of cases) {
		const b = rulesBench(t, options);
		assert.deepEqual(await b.rules.ciGreen([green]), { suppress: false }, name);
		assert.deepEqual(b.journal.map((line) => [line.payload.wake_rule, line.payload.decision, line.payload.reason]), [["ci_green", "woke", reason]], name);
	}
});

test("CommandPost.observeCi, the CiWatch onObserved wiring, records ciOutcome(key) on the real continuation", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const post = new CommandPost({ home: home.path, packageRoot: process.cwd() });
	t.after(() => post.shutdown());
	assert.equal(post.continuation.ciOutcome(KEY), undefined);
	post.observeCi("cp-x", green);
	const recorded = await post.continuation.ciOutcome(KEY);
	assert.equal(recorded?.job_id, "cp-x");
	assert.equal(recorded?.action, "disabled", "continuation is off here; the outcome is still recorded under the key");
});
