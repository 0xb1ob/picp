/**
 * cp-runtime-deferred-recheck acceptance: a deferred merge ask is released by
 * the *event*, not by a parent remembering to render a status block — and it is
 * released **before** the wake-up that announces the event is delivered.
 *
 * Two things this suite refuses to fake:
 *
 *  - the **reviewer payload**. `DiffReview.finish` builds the real
 *    `ReviewWakeup` (and writes the real `review-<n>.json` the merge-ask gate
 *    reads), so `isPassingDiffReview` is tested against the object production
 *    actually hands it, not against a hand-written stand-in that could drift.
 *  - the **delivery path**. The ordering claim is proved through `ReviewRuns`
 *    itself, whose `#run` awaits `beforeWakeup` before `#send`, and through
 *    `CommandPost`'s plumbing of that option.
 *
 * Everything else is hermetic: the CI facts are whatever the case says they
 * are, the awaiting store is a real one on a scratch home, and `cp_status_block`
 * is never called anywhere in this file — which is the point being pinned.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../src/awaiting.ts";
import { CommandPost } from "../src/command-post.ts";
import { type AwaitingItem, type GateFlags, type GateReview, LAYOUT, paths } from "../src/contracts.ts";
import { DiffReview } from "../src/diff-review.ts";
import { reviewCapExhausted } from "../src/gate.ts";
import { type CiRun, createMergeAskProbe, readReviewPassHeads } from "../src/merge-ask.ts";
import {
	DEFERRED_RECHECK_MAX_WAIT_MS,
	formatRaisedNotice,
	isPassingDiffReview,
	recheckDeferred,
	recheckDeferredBounded,
	releasesDeferredAsks,
} from "../src/deferred-recheck.ts";
import { BEFORE_WAKEUP_MAX_WAIT_MS, ReviewRuns, type ReviewAttempt, type ReviewWakeup } from "../src/review-runs.ts";
import { DEFAULT_ROUTING_CONFIG, type ModelProbe } from "../src/routing.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { commandPostSource, createScratchHome, REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

const HEAD = "8c7d0141f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const OLD = "0d03ad1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const JOB = "cp-x";

function run(overrides: Partial<CiRun> = {}): CiRun {
	return { status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci", ...overrides };
}

interface CiState {
	head: string | undefined;
	runs: CiRun[];
	reviewed?: string[];
	/**
	 * Ran inside the CI query, so a test can hold every in-flight recheck at one
	 * point and let them race the write deliberately. A barrier, never a sleep:
	 * nothing here is timing-dependent.
	 */
	beforeRuns?: () => Promise<void>;
}

/** A store whose CI facts are whatever the test currently says they are. */
function storeWith(home: string, state: CiState) {
	let probes = 0;
	const store = new AwaitingStore({
		home,
		mergeAsk: createMergeAskProbe({
			head: async () => (state.head ? { sha: state.head } : { reason: "not pushed" }),
			runs: async () => {
				probes += 1;
				await state.beforeRuns?.();
				return state.runs;
			},
			// The real reader, over the real verdict files: a review-pass test that
			// stubbed this would prove nothing about the payload it is about.
			reviewedHeads: (jobId) => (state.reviewed ? state.reviewed : readReviewPassHeads(home, jobId)),
		}),
	});
	return { store, probes: () => probes };
}

const MERGE_ASK = {
	type: "approval" as const,
	decision: "Ship cp-x (PR 58), drop it, or open a follow-up?",
	why: "the change is verified",
	blocks: "cp-x delivery",
	job_id: JOB,
};

const CI_EVENT = { kind: "ci" } as const;

// ---------------------------------------------------------------------------
// The real reviewer payload
// ---------------------------------------------------------------------------

const NO_FLAGS: GateFlags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
const MOCK_ONLY: ModelProbe = { isAvailable: (model) => model.startsWith("mock/") };

/**
 * A genuine `ReviewWakeup` for a diff review, built by the production code that
 * builds them — and, as a side effect, the genuine `review-<n>.json` a pass
 * writes. No worker is spawned: `finish` is everything *after* the wait.
 */
async function reviewWakeup(
	t: { after(fn: () => void | Promise<void>): void },
	home: string,
	options: { verdict: "pass" | "revise"; headSha?: string; attempt?: number },
): Promise<ReviewWakeup> {
	const manager = new WorkerManager({ home, workerReporterPath: WORKER_REPORTER_EXTENSION });
	t.after(() => manager.shutdownAll());
	const review = new DiffReview({
		home,
		profilesDir: join(REPO_ROOT, "profiles"),
		briefsDir: join(REPO_ROOT, "prompts/briefs"),
		manager,
		routing: { ...DEFAULT_ROUTING_CONFIG },
		probe: MOCK_ONLY,
	});
	const attempt = options.attempt ?? 1;
	const head = options.headSha ?? HEAD;
	const observed: GateReview = {
		verdict: options.verdict,
		flags: { ...NO_FLAGS },
		// Diff review's high-only bar downgrades a revise with no high/high finding
		// to pass. A fixture that means to stay a revise has to carry one.
		reasons:
			options.verdict === "revise"
				? ["[severity: high] [confidence: high] src/app.ts:1 — missing test → broken merge → name the failing case"]
				: ["scoped to one file"],
		...(options.verdict === "revise" ? { revisions: ["name the failing case"] } : {}),
	} as GateReview;
	const finished = await review.finish({
		jobId: JOB,
		attempt,
		model: "mock/reviewer",
		prior: { decisions: [], attempt, priorRevise: reviewCapExhausted([]), priorCause: null },
		branch: JOB,
		subject: { head_sha: head, branch: JOB, files: 1, truncated: false },
		outcome: { review: observed },
		deliverRevise: false,
		directive: "act on next",
	});
	return finished.wakeup;
}

// ---------------------------------------------------------------------------
// Which events release a deferral — read off the real payload
// ---------------------------------------------------------------------------

test("a real passing diff-review wake-up releases; a real revise does not", async (t) => {
	const home = createScratchHome();
	try {
		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		assert.equal(pass.surface, "review");
		assert.equal((pass.details as { next?: string }).next, "proceed");
		assert.equal(isPassingDiffReview(pass), true);
		// And the pass is on disk under the head it reviewed, which is the fact the
		// merge-ask gate actually reads.
		assert.deepEqual(readReviewPassHeads(home.path, JOB), [HEAD]);

		const revise = await reviewWakeup(t, home.path, { verdict: "revise", attempt: 2 });
		assert.equal(isPassingDiffReview(revise), false, "a revise moves the head, it does not clear it");
		assert.equal(releasesDeferredAsks({ kind: "verdict", wakeup: revise }), false);
		assert.equal(releasesDeferredAsks({ kind: "verdict", wakeup: pass }), true);
		assert.equal(releasesDeferredAsks(CI_EVENT), true);
	} finally {
		home.cleanup();
	}
});

test("a malformed, absent or foreign payload never throws and never releases", () => {
	for (const payload of [
		undefined,
		null,
		"proceed",
		42,
		{},
		{ surface: "review" },
		{ surface: "review", details: undefined },
		{ surface: "review", details: null },
		{ surface: "review", details: "proceed" },
		{ surface: "review", details: 7 },
		{ surface: "review", details: {} },
		{ surface: "review", details: { next: null } },
		{ surface: "review", details: { next: "revise" } },
		{ surface: "review", details: { next: "surface" } },
		// The surfaces that say nothing about a head's reviewedness.
		{ surface: "gate", details: { next: "proceed" } },
		{ surface: "quality", details: { next: "proceed" } },
		{ surface: undefined, details: { next: "proceed" } },
		// A payload that disagrees with itself is not evidence of a pass.
		{ surface: "review", details: { next: "proceed", verdict: { verdict: "revise" } } },
		{ surface: "review", details: { next: "proceed", verdict: { verdict: "escalate" } } },
	]) {
		assert.equal(isPassingDiffReview(payload), false, `released on ${JSON.stringify(payload)}`);
		assert.equal(releasesDeferredAsks({ kind: "verdict", wakeup: payload }), false);
	}
	// A verdict field of an unexpected shape is tolerated, not fatal: `next` is
	// still the field the ladder derived.
	assert.equal(isPassingDiffReview({ surface: "review", details: { next: "proceed", verdict: null } }), true);
	assert.equal(isPassingDiffReview({ surface: "review", details: { next: "proceed", verdict: { verdict: "pass" } } }), true);
});

// ---------------------------------------------------------------------------
// The two events, end to end
// ---------------------------------------------------------------------------

test("a row deferred on running CI is opened by the cp-ci event, exactly once, with no render", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })], reviewed: [HEAD] };
		const { store } = storeWith(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);
		assert.equal(deferred.raised, false);
		assert.equal(deferred.item.state, "deferred");

		state.runs = [run()];
		const raised = await recheckDeferred(store, CI_EVENT);
		assert.deepEqual(
			raised.map((item) => item.id),
			[deferred.item.id],
			"the row opens under the id it was deferred under",
		);
		assert.equal(store.list("open").length, 1);

		// The same event again (the watch re-derives an unconfirmed fact) raises
		// nothing: the row is open, so there is nothing to announce twice.
		assert.deepEqual(await recheckDeferred(store, CI_EVENT), []);
		assert.equal(store.list("open").length, 1);
	} finally {
		home.cleanup();
	}
});

test("a 'green but unreviewed' row is opened by the real passing verdict, and only once", async (t) => {
	const home = createScratchHome();
	try {
		// No `reviewed` override: the gate reads the verdict files this test writes.
		const { store } = storeWith(home.path, { head: HEAD, runs: [run()] });
		const deferred = await store.declareGated(MERGE_ASK);
		assert.equal(deferred.raised, false);
		assert.match(deferred.gate?.reason ?? "", /no passing cp_review/);

		// A review that passed on a SUPERSEDED head is a real pass and still does
		// not release the row: the gate compares it with the head that would merge.
		const stale = await reviewWakeup(t, home.path, { verdict: "pass", headSha: OLD, attempt: 1 });
		assert.deepEqual(await recheckDeferred(store, { kind: "verdict", wakeup: stale }), []);
		assert.equal(store.list("deferred").length, 1);

		const pass = await reviewWakeup(t, home.path, { verdict: "pass", headSha: HEAD, attempt: 2 });
		const raised = await recheckDeferred(store, { kind: "verdict", wakeup: pass });
		assert.deepEqual(raised.map((item) => item.id), [deferred.item.id]);
		assert.equal(store.list("open").length, 1);

		// Re-delivery of the same verdict (the one sanctioned resend) raises nothing.
		assert.deepEqual(await recheckDeferred(store, { kind: "verdict", wakeup: pass }), []);
		assert.equal(store.list("open").length, 1);
		assert.equal(store.read().items.length, 1, "one decision, one row");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The delivery path: open BEFORE the parent is woken
// ---------------------------------------------------------------------------

/** An attempt whose reviewer is already finished: `finish` just hands back `wakeup`. */
function attemptOf(wakeup: ReviewWakeup | undefined): ReviewAttempt<string> {
	return {
		jobId: JOB,
		surface: "review",
		attempt: wakeup?.attempt ?? 1,
		model: "mock/reviewer",
		deadline: "2026-09-05T10:15:00Z",
		wait: async () => "done",
		finish: async () => wakeup,
	};
}

test("ReviewRuns awaits the recheck before it sends the wake-up", async (t) => {
	const home = createScratchHome();
	try {
		const { store } = storeWith(home.path, { head: HEAD, runs: [run()] });
		await store.declareGated(MERGE_ASK);
		assert.equal(store.list("deferred").length, 1);

		const openAtDelivery: number[] = [];
		let rechecks = 0;
		const registry = new ReviewRuns({
			home: home.path,
			beforeWakeup: async (wakeup) => {
				rechecks += 1;
				await recheckDeferred(store, { kind: "verdict", wakeup });
			},
			wakeup: (wakeup) => {
				openAtDelivery.push(store.list("open").length);
				assert.equal(wakeup.surface, "review");
				return true;
			},
		});

		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		const started = registry.start(attemptOf(pass));
		registry.handBack(started.key);
		await registry.settled(started.key);

		assert.equal(rechecks, 1, "one verdict, one recheck");
		assert.deepEqual(openAtDelivery, [1], "the row is already open when the parent is woken");
	} finally {
		home.cleanup();
	}
});

test("a hook that throws costs the row, never the wake-up", async (t) => {
	const home = createScratchHome();
	try {
		const sent: ReviewWakeup[] = [];
		const registry = new ReviewRuns({
			home: home.path,
			beforeWakeup: () => {
				throw new Error("gh: 403");
			},
			wakeup: (wakeup) => (sent.push(wakeup), true),
		});
		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		const started = registry.start(attemptOf(pass));
		registry.handBack(started.key);
		await registry.settled(started.key);
		assert.equal(sent.length, 1, "the verdict still reaches the parent");
	} finally {
		home.cleanup();
	}
});

test("CommandPost plumbs beforeWakeup into the reviewer delivery path", async (t) => {
	const home = createScratchHome();
	try {
		const seen: ReviewWakeup[] = [];
		const order: string[] = [];
		const post = new CommandPost({
			home: home.path,
			packageRoot: REPO_ROOT,
			beforeWakeup: (wakeup) => {
				order.push("recheck");
				seen.push(wakeup);
			},
			sendWakeup: () => (order.push("send"), true),
		});
		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		const started = post.reviewRuns.start(attemptOf(pass));
		post.reviewRuns.handBack(started.key);
		await post.reviewRuns.settled(started.key);
		assert.deepEqual(order, ["recheck", "send"]);
		assert.equal(seen[0]?.surface, "review");
		assert.equal((seen[0]?.details as { next?: string }).next, "proceed");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Two events at once, against one state/awaiting.json
// ---------------------------------------------------------------------------

/**
 * A rendezvous, not a sleep: `enter()` blocks every caller until `expected` of
 * them have arrived and the test releases them, and `all` resolves the moment
 * the last one arrives. Nothing here reads a clock, so the interleaving is the
 * same on a loaded CI runner as on an idle laptop.
 */
function barrier(expected: number) {
	let seen = 0;
	let arrived: () => void = () => {};
	const all = new Promise<void>((resolve) => (arrived = resolve));
	let open: () => void = () => {};
	const released = new Promise<void>((resolve) => (open = resolve));
	return {
		all,
		seen: () => seen,
		release: () => open(),
		async enter(): Promise<void> {
			seen += 1;
			if (seen >= expected) arrived();
			await released;
		},
	};
}

/** What the extension does with a recheck's result, minus pi: one notice per raise. */
function announcer() {
	const notices: string[] = [];
	return {
		notices,
		announce(raised: readonly AwaitingItem[]): readonly AwaitingItem[] {
			if (raised.length > 0) notices.push(formatRaisedNotice(raised));
			return raised;
		},
	};
}

/** The file as bytes, and as the contract sees it. Both must survive a race. */
function assertFileIsSound(store: AwaitingStore, home: string): AwaitingItem[] {
	const raw = readFileSync(join(home, LAYOUT.state, "awaiting.json"), "utf8");
	const parsed = JSON.parse(raw) as { items?: unknown };
	assert.ok(Array.isArray(parsed.items), "awaiting.json is not the file it claims to be");
	// `read()` throws on a contract violation, so this is the schema check too.
	const items = store.read().items;
	assert.equal(items.length, new Set(items.map((item) => item.id)).size, "a duplicate id survived the race");
	return items;
}

test("a cp-ci tick and a passing review racing the same file raise one row, once", async (t) => {
	const home = createScratchHome();
	try {
		// A real pass on the current head, on disk before either event runs.
		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		// Deferred on CI, which is the state both events are about to change.
		const state: CiState = { head: HEAD, runs: [run({ status: "queued", conclusion: null })] };
		const { store } = storeWith(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);
		assert.equal(deferred.item.state, "deferred");

		// Both events now see a green head with a passing review — and both are held
		// inside their CI query until the other has read the row as `deferred` and
		// decided to raise it. That is the interleaving that could notify twice.
		state.runs = [run()];
		const gate = barrier(2);
		state.beforeRuns = () => gate.enter();

		const { notices, announce } = announcer();
		const ci = recheckDeferred(store, CI_EVENT).then(announce);
		let fromReview: readonly AwaitingItem[] = [];
		const registry = new ReviewRuns({
			home: home.path,
			beforeWakeup: async (wakeup) => {
				fromReview = announce(await recheckDeferred(store, { kind: "verdict", wakeup }));
			},
			wakeup: () => true,
		});
		const started = registry.start(attemptOf(pass));
		registry.handBack(started.key);

		await gate.all;
		assert.equal(gate.seen(), 2, "both rechecks are in flight, both past the read");
		// A third writer on the same file, released into the same window: a merge row
		// promoted by one racer must not drop somebody else's row.
		const unrelated = store.declare({
			type: "design",
			decision: "postgres or sqlite for the ledger?",
			why: "it decides the migration",
			blocks: "cp-y",
			job_id: "cp-y",
		});
		gate.release();
		const [fromCi] = await Promise.all([ci, registry.settled(started.key), unrelated]);

		// Exactly one of the two racers owns the promotion, and it announced once.
		assert.equal(fromCi.length + fromReview.length, 1, "the row was raised by both racers");
		assert.equal(notices.length, 1, "the operator was told twice about one decision");

		const items = assertFileIsSound(store, home.path);
		const merge = items.filter((item) => item.id === deferred.item.id);
		assert.equal(merge.length, 1, "one decision, one durable row");
		assert.equal(merge[0]?.state, "open");
		assert.equal(merge[0]?.deferred_reason, undefined, "a promoted row keeps no deferral reason");
		assert.equal(store.list("open").length, 2, "the unrelated row was lost by the race");
		assert.ok(
			items.some((item) => item.job_id === "cp-y" && item.state === "open"),
			"the concurrent unrelated write was clobbered",
		);
		assert.equal(items.length, 2);
	} finally {
		home.cleanup();
	}
});

test("when both racers fail to read CI the row stays deferred, and a later event still raises it once", async (t) => {
	const home = createScratchHome();
	try {
		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		const state: CiState = { head: HEAD, runs: [run({ status: "queued", conclusion: null })] };
		const { store } = storeWith(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);

		// Both events land while `gh` is down: ignorance defers, in both racers, and
		// the concurrent writes must still leave one intact row.
		state.runs = [run()];
		const gate = barrier(2);
		state.beforeRuns = async () => {
			await gate.enter();
			throw new Error("gh: 403");
		};
		const { notices, announce } = announcer();
		const ci = recheckDeferred(store, CI_EVENT).then(announce);
		const registry = new ReviewRuns({
			home: home.path,
			beforeWakeup: async (wakeup) => {
				announce(await recheckDeferred(store, { kind: "verdict", wakeup }));
			},
			wakeup: () => true,
		});
		const started = registry.start(attemptOf(pass));
		registry.handBack(started.key);
		await gate.all;
		gate.release();
		await Promise.all([ci, registry.settled(started.key)]);

		assert.deepEqual(notices, [], "an unreadable CI state must never raise an ask");
		const afterFailure = assertFileIsSound(store, home.path);
		assert.equal(afterFailure.length, 1);
		assert.equal(afterFailure[0]?.state, "deferred");
		assert.match(afterFailure[0]?.deferred_reason ?? "", /403/);

		// The fault clears; the next event raises the same row, exactly once.
		state.beforeRuns = undefined as unknown as CiState["beforeRuns"];
		const raised = announce(await recheckDeferred(store, CI_EVENT));
		assert.deepEqual(raised.map((item) => item.id), [deferred.item.id]);
		assert.equal(notices.length, 1);
		assert.deepEqual(await recheckDeferred(store, CI_EVENT), []);
		const items = assertFileIsSound(store, home.path);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.state, "open");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Bounded waits: a re-gate that never settles costs the row, never the wake-up
//
// Deterministic by construction, with no sleeps anywhere: the bound is injected
// (`beforeWakeupTimeoutMs`, `timeoutMs`) and the work under it is a promise that
// *never* settles, so the timeout branch is the only branch that can run. No
// test here races a real duration against another.
// ---------------------------------------------------------------------------

/** A promise that never settles, and a note that nothing is waiting on a clock. */
function neverSettles<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

test("the bounds are real durations, and the tests inject their own", () => {
	assert.ok(DEFERRED_RECHECK_MAX_WAIT_MS > 0 && DEFERRED_RECHECK_MAX_WAIT_MS <= 60_000);
	assert.ok(BEFORE_WAKEUP_MAX_WAIT_MS > 0 && BEFORE_WAKEUP_MAX_WAIT_MS <= 60_000);
});

test("a beforeWakeup that never settles still delivers the verdict and releases the slot", async (t) => {
	const home = createScratchHome();
	try {
		const state: CiState = { head: HEAD, runs: [run({ status: "queued", conclusion: null })], reviewed: [HEAD] };
		const { store } = storeWith(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);
		assert.equal(deferred.item.state, "deferred");

		const sent: ReviewWakeup[] = [];
		const failures: string[] = [];
		let entered = 0;
		const registry = new ReviewRuns({
			home: home.path,
			beforeWakeupTimeoutMs: 0,
			beforeWakeup: () => {
				entered += 1;
				return neverSettles<void>();
			},
			onBeforeWakeupFailure: (reason) => failures.push(reason),
			wakeup: (wakeup) => (sent.push(wakeup), true),
		});

		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		const started = registry.start(attemptOf(pass));
		registry.handBack(started.key);
		// This is the assertion: it returns at all.
		await registry.settled(started.key);

		assert.equal(entered, 1);
		assert.equal(sent.length, 1, "the verdict must reach the parent regardless");
		assert.equal(failures.length, 1);
		assert.match(failures[0] ?? "", /did not finish within 0ms/);
		assert.equal(registry.pending(JOB, "review"), undefined, "the slot leaked");

		// No row was opened without evidence, and none was duplicated.
		const afterTimeout = assertFileIsSound(store, home.path);
		assert.equal(afterTimeout.length, 1);
		assert.equal(afterTimeout[0]?.state, "deferred");

		// And the row is not lost: the next event re-gates it, exactly once.
		state.runs = [run()];
		const raised = await recheckDeferredBounded(store, CI_EVENT);
		assert.deepEqual(raised.map((item) => item.id), [deferred.item.id]);
		assert.deepEqual(await recheckDeferredBounded(store, CI_EVENT), []);
		const items = assertFileIsSound(store, home.path);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.state, "open");
	} finally {
		home.cleanup();
	}
});

test("a beforeWakeup that throws synchronously is reported and the verdict still goes", async (t) => {
	const home = createScratchHome();
	try {
		const sent: ReviewWakeup[] = [];
		const failures: string[] = [];
		const registry = new ReviewRuns({
			home: home.path,
			beforeWakeup: () => {
				throw new Error("gh: 403");
			},
			onBeforeWakeupFailure: (reason) => failures.push(reason),
			wakeup: (wakeup) => (sent.push(wakeup), true),
		});
		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		const started = registry.start(attemptOf(pass));
		registry.handBack(started.key);
		await registry.settled(started.key);
		assert.equal(sent.length, 1);
		assert.equal(failures.length, 1);
		assert.match(failures[0] ?? "", /threw: gh: 403/);
		assert.equal(registry.pending(JOB, "review"), undefined);
	} finally {
		home.cleanup();
	}
});

test("a cp-ci re-gate that never settles lets the tick's notice and wake-up continue", async () => {
	const home = createScratchHome();
	try {
		const state: CiState = { head: HEAD, runs: [run({ status: "queued", conclusion: null })], reviewed: [HEAD] };
		const { store } = storeWith(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);

		// The gate wedges inside its CI query, exactly as an unkillable `gh` would.
		state.runs = [run()];
		state.beforeRuns = () => neverSettles<void>();

		const { notices, announce } = announcer();
		const failures: string[] = [];
		// What `surfaceCi` does, in order: re-gate, then notify, then wake the parent.
		const order: string[] = [];
		announce(
			await recheckDeferredBounded(store, CI_EVENT, {
				timeoutMs: 0,
				onFailure: (reason) => (order.push("failure"), failures.push(reason)),
			}),
		);
		order.push("notice", "wakeup");

		assert.deepEqual(order, ["failure", "notice", "wakeup"], "the tick must carry on past a wedged re-gate");
		assert.equal(failures.length, 1);
		assert.match(failures[0] ?? "", /did not finish within 0ms/);
		assert.deepEqual(notices, [], "a row nobody re-gated is never announced as open");

		const afterTimeout = assertFileIsSound(store, home.path);
		assert.equal(afterTimeout.length, 1);
		assert.equal(afterTimeout[0]?.state, "deferred", "a spent bound must not open a row");

		// The wedge clears; the next tick raises the same row, once, with no
		// duplicate. This one runs under the real bound: an injected 0 is a bound
		// nothing can finish inside, which is exactly why it is only used above.
		state.beforeRuns = undefined as unknown as CiState["beforeRuns"];
		const raised = announce(await recheckDeferredBounded(store, CI_EVENT));
		assert.deepEqual(raised.map((item) => item.id), [deferred.item.id]);
		assert.equal(notices.length, 1);
		const items = assertFileIsSound(store, home.path);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.state, "open");
	} finally {
		home.cleanup();
	}
});

test("a bounded re-gate that fails reports once, opens nothing, and never throws", async () => {
	const home = createScratchHome();
	try {
		const state: CiState = { head: HEAD, runs: [run({ status: "queued", conclusion: null })] };
		const { store, probes } = storeWith(home.path, state);
		await store.declareGated(MERGE_ASK);
		state.runs = [run()];
		state.beforeRuns = async () => {
			throw new Error("gh: 403");
		};
		const failures: string[] = [];
		// The probe turns its own failure into `defer`, so this path reports nothing
		// and simply leaves the row alone — the fail-closed direction, unchanged.
		assert.deepEqual(await recheckDeferredBounded(store, CI_EVENT, { onFailure: (r) => failures.push(r) }), []);
		assert.equal(store.list("deferred").length, 1);
		assert.match(store.list("deferred")[0]?.deferred_reason ?? "", /403/);

		// An irrelevant event still costs nothing: no read, no timer, no report.
		const before = probes();
		assert.deepEqual(await recheckDeferredBounded(store, { kind: "verdict", wakeup: undefined }), []);
		assert.equal(probes(), before);
		assert.deepEqual(failures, []);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Late completion: the deadline stops the wait, it does not throw the news away
//
// Still deterministic and still sleepless: the bound is injected, the work under
// it is held on a barrier the test releases by hand, and the late announcement
// is awaited through a promise the callback resolves — never through a delay.
// ---------------------------------------------------------------------------

/** A promise plus its resolver: how a test waits for a callback, not for a clock. */
function signal<T>() {
	let fire: (value: T) => void = () => {};
	const fired = new Promise<T>((resolve) => (fire = resolve));
	return { fired, fire };
}

/** The extension's continuation, minus pi: one notice and one repaint per raise. */
function surface() {
	const notices: string[] = [];
	let repaints = 0;
	const late = signal<readonly AwaitingItem[]>();
	return {
		notices,
		repaints: () => repaints,
		late: late.fired,
		announceRaised(raised: readonly AwaitingItem[]): readonly AwaitingItem[] {
			if (raised.length === 0) return raised;
			notices.push(formatRaisedNotice(raised));
			repaints += 1;
			late.fire(raised);
			return raised;
		},
	};
}

test("a cp-ci re-gate that lands after the deadline opens and announces exactly once", async () => {
	const home = createScratchHome();
	try {
		const state: CiState = { head: HEAD, runs: [run({ status: "queued", conclusion: null })], reviewed: [HEAD] };
		const { store } = storeWith(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);

		// The query is slow, not broken: held until this test releases it.
		state.runs = [run()];
		const slow = barrier(1);
		state.beforeRuns = () => slow.enter();

		const ui = surface();
		const failures: string[] = [];
		const atDeadline = ui.announceRaised(
			await recheckDeferredBounded(store, CI_EVENT, {
				timeoutMs: 0,
				onFailure: (reason) => failures.push(reason),
				onLate: ui.announceRaised,
			}),
		);

		// At the deadline: the caller is free, and nothing has been opened or said.
		assert.deepEqual(atDeadline, []);
		assert.equal(failures.length, 1);
		assert.deepEqual(ui.notices, []);
		assert.equal(ui.repaints(), 0);
		assert.equal(store.list("deferred").length, 1, "the deadline must open nothing");

		// The slow query lands. The gate opens the row on its ordinary evidence, and
		// the late rows take the same announcement path the in-bound ones take.
		slow.release();
		const late = await ui.late;
		assert.deepEqual(late.map((item) => item.id), [deferred.item.id]);
		assert.equal(ui.notices.length, 1, "the late raise was announced twice");
		assert.equal(ui.repaints(), 1);
		assert.equal(failures.length, 1, "a late success must not report a second failure");

		const items = assertFileIsSound(store, home.path);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.state, "open");
		// And nothing is left to raise: the next event is a no-op.
		state.beforeRuns = undefined as unknown as CiState["beforeRuns"];
		assert.deepEqual(await recheckDeferredBounded(store, CI_EVENT), []);
		assert.equal(ui.notices.length, 1);
	} finally {
		home.cleanup();
	}
});

test("a review re-gate that lands after the wake-up still opens and announces exactly once", async (t) => {
	const home = createScratchHome();
	try {
		const state: CiState = { head: HEAD, runs: [run({ status: "queued", conclusion: null })], reviewed: [HEAD] };
		const { store } = storeWith(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);
		state.runs = [run()];
		const slow = barrier(1);
		state.beforeRuns = () => slow.enter();

		const ui = surface();
		const sent: ReviewWakeup[] = [];
		const failures: string[] = [];
		// Exactly the extension's wiring: the hook is the shared helper, bounded by
		// the re-gate's own deadline (injected to 0 here). The hook therefore returns
		// promptly with nothing, the registry sends on its ordinary path — no second
		// bound racing the first — and the only route left for the news is the late
		// continuation.
		const registry = new ReviewRuns({
			home: home.path,
			beforeWakeup: async (wakeup) => {
				ui.announceRaised(
					await recheckDeferredBounded(
						store,
						{ kind: "verdict", wakeup },
						{ timeoutMs: 0, onFailure: (reason) => failures.push(reason), onLate: ui.announceRaised },
					),
				);
			},
			onBeforeWakeupFailure: (reason) => failures.push(`hook: ${reason}`),
			wakeup: (wakeup) => (sent.push(wakeup), true),
		});

		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		const started = registry.start(attemptOf(pass));
		registry.handBack(started.key);
		await registry.settled(started.key);

		// The verdict went out once the re-gate's bound was spent, the slot is free,
		// and nothing is open.
		assert.equal(sent.length, 1);
		assert.equal(failures.length, 1, "one bounded line, from the re-gate's own deadline");
		assert.match(failures[0] ?? "", /did not finish within 0ms/);
		assert.equal(registry.pending(JOB, "review"), undefined, "the slot leaked");
		assert.deepEqual(ui.notices, []);
		assert.equal(store.list("deferred").length, 1);

		slow.release();
		const late = await ui.late;
		assert.deepEqual(late.map((item) => item.id), [deferred.item.id]);
		assert.equal(ui.notices.length, 1);
		assert.equal(ui.repaints(), 1);
		const items = assertFileIsSound(store, home.path);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.state, "open");
	} finally {
		home.cleanup();
	}
});

test("a re-gate that fails after the deadline opens nothing, says nothing twice, and leaks no rejection", async () => {
	const home = createScratchHome();
	try {
		// A real deferred row on the side, to prove the failing path opens nothing.
		const { store } = storeWith(home.path, { head: HEAD, runs: [run({ status: "queued", conclusion: null })], reviewed: [HEAD] });
		await store.declareGated(MERGE_ASK);
		const slow = barrier(1);
		// A store whose re-gate rejects, and only after the bound is long spent. The
		// rejection must be consumed: an unhandled one fails this test on its own.
		const rejecting = {
			reviewDeferred: async () => {
				await slow.enter();
				throw new Error("awaiting.json vanished");
			},
		} as unknown as AwaitingStore;

		const ui = surface();
		const failures: string[] = [];
		const atDeadline = await recheckDeferredBounded(rejecting, CI_EVENT, {
			timeoutMs: 0,
			onFailure: (reason) => failures.push(reason),
			onLate: ui.announceRaised,
		});
		assert.deepEqual(atDeadline, []);
		assert.equal(failures.length, 1);

		slow.release();
		// Give the late continuation the turn it needs to run, without a timer.
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(ui.notices, [], "a late failure must announce nothing");
		assert.equal(ui.repaints(), 0);
		assert.equal(failures.length, 1, "one call, one failure line");
		assert.equal(store.list("open").length, 0, "nothing was opened without evidence");
		assert.equal(store.list("deferred").length, 1, "and nothing was dropped either");
	} finally {
		home.cleanup();
	}
});

test("a re-gate that finishes inside the bound never takes the late path", async () => {
	const home = createScratchHome();
	try {
		const state: CiState = { head: HEAD, runs: [run({ status: "queued", conclusion: null })], reviewed: [HEAD] };
		const { store } = storeWith(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);
		state.runs = [run()];

		const ui = surface();
		let lateCalls = 0;
		const raised = ui.announceRaised(
			await recheckDeferredBounded(store, CI_EVENT, {
				onLate: (rows) => {
					lateCalls += 1;
					ui.announceRaised(rows);
				},
			}),
		);
		assert.deepEqual(raised.map((item) => item.id), [deferred.item.id]);
		// Two microtask turns are more than the late continuation would need.
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(lateCalls, 0, "an in-bound completion must not also fire onLate");
		assert.equal(ui.notices.length, 1, "one raise, one notice");
		assert.equal(ui.repaints(), 1);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Quiet by default, fail-closed under every gate that was already there
// ---------------------------------------------------------------------------

test("an unrelated event neither reads the gate nor touches the file", async (t) => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "queued", conclusion: null })], reviewed: [HEAD] };
		const { store, probes } = storeWith(home.path, state);
		await store.declareGated(MERGE_ASK);
		const before = readFileSync(join(home.path, LAYOUT.state, "awaiting.json"), "utf8");
		const probesBefore = probes();

		// Everything else a session delivers: a plan-gate verdict, a quality panel
		// verdict, a revise, and a payload from a surface that does not exist yet.
		state.runs = [run()];
		const revise = await reviewWakeup(t, home.path, { verdict: "revise" });
		for (const wakeup of [
			{ ...revise, surface: "gate" as const, details: { next: "proceed" } },
			{ ...revise, surface: "quality" as const, details: { next: "proceed" } },
			revise,
			{ ...revise, surface: "future" as unknown as ReviewWakeup["surface"] },
		]) {
			assert.deepEqual(await recheckDeferred(store, { kind: "verdict", wakeup }), []);
		}
		assert.equal(probes(), probesBefore, "an unrelated event costs no CI query");
		assert.equal(readFileSync(join(home.path, LAYOUT.state, "awaiting.json"), "utf8"), before, "and mutates no row");
		assert.equal(store.list("deferred").length, 1);
	} finally {
		home.cleanup();
	}
});

test("red, still-running and unreviewed heads stay deferred through both events", async (t) => {
	const home = createScratchHome();
	const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
	home.cleanup();
	for (const state of [
		{ head: HEAD, runs: [run({ conclusion: "failure" })], reviewed: [HEAD] },
		{ head: HEAD, runs: [run({ status: "in_progress", conclusion: null })], reviewed: [HEAD] },
		{ head: HEAD, runs: [run({ headSha: OLD })], reviewed: [HEAD] },
		{ head: HEAD, runs: [run()], reviewed: [] },
		{ head: undefined, runs: [run()], reviewed: [HEAD] },
	]) {
		const scratch = createScratchHome();
		try {
			const { store } = storeWith(scratch.path, state);
			await store.declareGated(MERGE_ASK);
			assert.deepEqual(await recheckDeferred(store, CI_EVENT), [], `raised on ${JSON.stringify(state.runs)}`);
			assert.deepEqual(await recheckDeferred(store, { kind: "verdict", wakeup: pass }), []);
			assert.equal(store.list("open").length, 0);
			assert.equal(store.list("deferred").length, 1);
		} finally {
			scratch.cleanup();
		}
	}
});

test("the notice is one bounded line naming the decision, never a table", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "queued", conclusion: null })], reviewed: [HEAD] };
		const { store } = storeWith(home.path, state);
		await store.declareGated(MERGE_ASK);
		state.runs = [run()];
		const notice = formatRaisedNotice(await recheckDeferred(store, CI_EVENT));
		assert.match(notice, /1 decision is now ready/);
		assert.match(notice, /Ship cp-x \(PR 58\)/);
		assert.match(notice, /cp_decide/);
		assert.equal(notice.split("\n").length, 1);
		assert.ok(notice.length <= 300);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Wiring lint, and the prose it replaced
// ---------------------------------------------------------------------------

/**
 * **Not the evidence** — the behaviour is proved above, against the real
 * payload and through `ReviewRuns`/`CommandPost`. This is a lint over the one
 * seam a test cannot reach without a live pi session (`surfaceCi` is a closure
 * inside the extension's activation function): that the `cp-ci` path *awaits*
 * the recheck before it sends anything, and that the verdict path is the
 * awaited `beforeWakeup` hook rather than a fire-and-forget call. It counts
 * nothing; it reads order and shape.
 */
test("wiring lint: the cp-ci path awaits the recheck before it sends, and the verdict path is not fire-and-forget", () => {
	const source = commandPostSource();
	const surfaceCi = source.slice(source.indexOf("const surfaceCi = "), source.indexOf("const confirmCiArrival = "));
	assert.ok(surfaceCi.length > 0, "surfaceCi not found");
	const recheck = surfaceCi.indexOf('await recheckDeferredRows({ kind: "ci" })');
	const send = surfaceCi.indexOf("sendWakeup(");
	assert.ok(recheck >= 0, "the cp-ci path does not await the recheck");
	assert.ok(send > recheck, "the recheck must complete before the wake-up is sent");
	assert.match(source, /beforeWakeup: \(wakeup\) => recheckDeferredRows\(\{ kind: "verdict", wakeup \}\)/);
	assert.doesNotMatch(source, /void recheckDeferredRows/, "the verdict path must not be fire-and-forget");
	// One continuation for both events and both timings: the in-bound result and
	// the late one go through the same `announceRaised`.
	assert.match(source, /onLate: announceRaised/);
	assert.equal((source.match(/const announceRaised = /g) ?? []).length, 1, "one shared continuation, not two");
	// The obsolete instructions: the runtime does this now, so the prompt must
	// not claim a render is what releases a row.
	assert.doesNotMatch(source, /Always end a cp-ci wake-up turn with cp_status_block/);
	assert.doesNotMatch(source, /Always end a turn carrying a passing cp_review verdict/);
	// The manual fallback for a transient unknown CI state stays: no event
	// announces observability coming back.
	assert.match(source, /unknown CI state may become readable with no event at all/);
	// And the review verdict files this suite writes are read by the gate through
	// the same path names production uses.
	assert.equal(paths.reviewFile(JOB, 1).includes(JOB), true);
});
