// Retained injected hooks and invalid/future wake-ups; see testing-migration-s19.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../src/awaiting.ts";
import { type AwaitingItem, type GateFlags, type GateReview, LAYOUT } from "../src/contracts.ts";
import { DiffReview } from "../src/diff-review.ts";
import { reviewCapExhausted } from "../src/gate.ts";
import { type CiRun, createMergeAskProbe, readReviewPassHeads } from "../src/merge-ask.ts";
import {
	isPassingDiffReview,
	recheckDeferred,
	recheckDeferredBounded,
	releasesDeferredAsks,
} from "../src/deferred-recheck.ts";
import { ReviewRuns, type ReviewAttempt, type ReviewWakeup } from "../src/review-runs.ts";
import { DEFAULT_ROUTING_CONFIG, type ModelProbe } from "../src/routing.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { createScratchHome, REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

const HEAD = "8c7d0141f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const JOB = "cp-x";

function run(overrides: Partial<CiRun> = {}): CiRun {
	return { status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci", ...overrides };
}

interface CiState {
	head: string | undefined;
	runs: CiRun[];
	reviewed?: string[];
	beforeRuns?: () => Promise<void>;
}

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
const NO_FLAGS: GateFlags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
const MOCK_ONLY: ModelProbe = { isAvailable: (model) => model.startsWith("mock/") };

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

function assertFileIsSound(store: AwaitingStore, home: string): AwaitingItem[] {
	const raw = readFileSync(join(home, LAYOUT.state, "awaiting.json"), "utf8");
	const parsed = JSON.parse(raw) as { items?: unknown };
	assert.ok(Array.isArray(parsed.items), "awaiting.json is not the file it claims to be");
	// `read()` throws on a contract violation, so this is the schema check too.
	const items = store.read().items;
	assert.equal(items.length, new Set(items.map((item) => item.id)).size, "a duplicate id survived the race");
	return items;
}

function neverSettles<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

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

// N2 (cp-c1ur): the held continuation's merge step used to run in `beforeWakeup`, so a PR could merge
// before the parent read the verdict that allowed it. `afterWakeup` runs after the send; a throw costs nothing.
test("afterWakeup runs after the wake-up is sent, and a throwing one is reported, not fatal", async (t) => {
	const home = createScratchHome();
	try {
		const order: string[] = [];
		const failures: string[] = [];
		const registry = new ReviewRuns({
			home: home.path,
			beforeWakeup: () => void order.push("before"),
			afterWakeup: () => {
				order.push("after");
				throw new Error("merge failed");
			},
			onBeforeWakeupFailure: (reason) => void failures.push(reason),
			wakeup: () => (order.push("send"), true),
		});
		const pass = await reviewWakeup(t, home.path, { verdict: "pass" });
		const started = registry.start(attemptOf(pass));
		registry.handBack(started.key);
		await registry.settled(started.key);
		assert.deepEqual(order, ["before", "send", "after"]);
		assert.deepEqual(failures, ["afterWakeup threw: merge failed"]);
	} finally {
		home.cleanup();
	}
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
