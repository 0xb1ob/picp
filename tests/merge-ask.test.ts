/**
 * cp-gmy acceptance: never ask a human to merge a PR while that PR's CI is
 * still running for its current head.
 *
 * Every test here is hermetic: the CI query is a fake that returns exactly the
 * `gh run list --json conclusion,status,headSha` rows the case is about, and
 * the head of the branch is whatever the case says it is. Nothing shells out.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	AwaitingStore,
	MERGE_ASK_NEEDS_JOB_REFUSAL,
	MergeAskDeferredError,
	awaitingId,
	awaitingRowsNotSupplied,
	mergeAwaiting,
} from "../src/awaiting.ts";
import { CommandPost } from "../src/command-post.ts";
import {
	type CiRun,
	createMergeAskProbe,
	isJobGoneError,
	MergeAskJobGoneError,
	type MergeAskMergedEvidence,
	evaluateAlreadyMerged,
	evaluateMergeAskCi,
	ghCiRuns,
	gitRemoteHead,
	isMergeAsk,
	parseCiRuns,
	readReviewPassHeads,
	readReviewPassVerdict,
	shaMatches,
} from "../src/merge-ask.ts";
import { resolveAwaitingRows } from "../src/awaiting-rows.ts";
import { assembleStatusBlock, resolvedMergeAskRows } from "../src/status-block.ts";
import type { Checkpoint, DiffVerdict, StatusSnapshot } from "../src/contracts.ts";
import { DiffVerdictSchema, paths, SCHEMA_VERSION, validate } from "../src/contracts.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const HEAD = "8c7d0141f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const OLD = "0d03ad1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function run(overrides: Partial<CiRun> = {}): CiRun {
	return { status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci", ...overrides };
}

/** A store whose CI facts are whatever the test currently says they are. */
function storeWithCi(home: string, state: { head: string | undefined; runs: CiRun[] }) {
	let calls = 0;
	const store = new AwaitingStore({
		home,
		mergeAsk: createMergeAskProbe({
			head: async () => (state.head ? { sha: state.head } : { reason: "not pushed" }),
			runs: async () => {
				calls += 1;
				return state.runs;
			},
		}),
	});
	return { store, probes: () => calls };
}

const MERGE_ASK = {
	type: "approval" as const,
	decision: "Merge PR #58 for cp-gmy?",
	why: "the change is verified",
	blocks: "cp-gmy delivery",
	job_id: "cp-gmy",
};

// ---------------------------------------------------------------------------
// The rule, as a pure function
// ---------------------------------------------------------------------------

test("shaMatches tolerates short shas but never matches on a stub", () => {
	assert.equal(shaMatches(HEAD, HEAD.slice(0, 7)), true);
	assert.equal(shaMatches(HEAD, OLD), false);
	assert.equal(shaMatches(HEAD, "8c7d01"), false, "six characters is not evidence");
	assert.equal(shaMatches(undefined, HEAD), false);
});

test("evaluateMergeAskCi: green on the current head is the only raise", () => {
	const verdict = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [run()] });
	assert.equal(verdict.action, "raise");
	assert.equal(verdict.ci, "green");
});

test("evaluateMergeAskCi: an in-progress run on the head defers", () => {
	const verdict = evaluateMergeAskCi({
		branch: "cp-gmy",
		head: { sha: HEAD },
		runs: [run({ status: "in_progress", conclusion: null })],
	});
	assert.equal(verdict.action, "defer");
	assert.equal(verdict.ci, "in_progress");
});

test("evaluateMergeAskCi: green on a superseded sha is not finished", () => {
	const verdict = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [run({ headSha: OLD })] });
	assert.equal(verdict.action, "defer");
	assert.equal(verdict.ci, "superseded");
});

test("evaluateMergeAskCi: a red run refuses the ask outright", () => {
	const verdict = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [run({ conclusion: "failure" })] });
	assert.equal(verdict.action, "refuse");
	assert.equal(verdict.ci, "failed");
	assert.match(verdict.reason, /merging red is forbidden/);
});

// cp-1som reverses the original ignorance rule: an unreadable CI state DEFERS.
// The parent asked at envelope time on PRs #117–#119, the gate had nothing to
// read yet, raised on `unknown`, the operator answered "ship" — and
// cp_integrate then found CI in_progress. A deferred row is never lost (it is
// stored, printed and re-reviewed every render); an answer spent on an unread
// head is.
test("cp-1som: no runs and no head DEFER with ci unknown — ignorance never raises an ask", () => {
	const noRuns = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [] });
	assert.equal(noRuns.action, "defer");
	assert.equal(noRuns.ci, "unknown");
	const noHead = evaluateMergeAskCi({ branch: "cp-gmy", head: { reason: "not pushed" }, runs: [run()] });
	assert.equal(noHead.action, "defer");
	assert.equal(noHead.ci, "unknown");
	assert.match(noHead.reason, /not pushed/);
});

test("cp-1som: green on the current head with no passing review on it defers", () => {
	const unreviewed = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [run()], reviewedHeads: [OLD] });
	assert.equal(unreviewed.action, "defer");
	assert.equal(unreviewed.ci, "unreviewed");
	assert.match(unreviewed.reason, /no passing cp_review/);

	const none = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [run()], reviewedHeads: [] });
	assert.equal(none.action, "defer", "a branch with no review at all is not askable");

	const reviewed = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [run()], reviewedHeads: [HEAD] });
	assert.equal(reviewed.action, "raise");
	assert.equal(reviewed.ci, "green");

	const notAsked = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [run()] });
	assert.equal(notAsked.action, "raise", "no reviewedHeads supplied = the review is not part of this question");
});

// cp-no-ci-repo-derived: the one narrow exception to the rule above. "No runs"
// is two conditions, and a repository that positively reports no workflows will
// never produce one — deferring there waits on an event that cannot happen.
test("cp-no-ci: only a positive 'no workflows' answer unblocks a runless branch", () => {
	const noCi = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [], ciConfigured: "none" });
	assert.equal(noCi.action, "raise");
	assert.equal(noCi.ci, "no_ci");
	assert.match(noCi.reason, /no CI is configured/);

	for (const state of ["present", "unreadable"] as const) {
		const held = evaluateMergeAskCi({ branch: "cp-gmy", head: { sha: HEAD }, runs: [], ciConfigured: state });
		assert.equal(held.action, "defer", state);
		assert.equal(held.ci, "unknown", state);
	}

	// The review precondition is untouched: no CI is not "no review".
	const unreviewed = evaluateMergeAskCi({
		branch: "cp-gmy",
		head: { sha: HEAD },
		runs: [],
		ciConfigured: "none",
		reviewedHeads: [OLD],
	});
	assert.equal(unreviewed.action, "defer");
	assert.equal(unreviewed.ci, "unreviewed");
	const reviewed = evaluateMergeAskCi({
		branch: "cp-gmy",
		head: { sha: HEAD },
		runs: [],
		ciConfigured: "none",
		reviewedHeads: [HEAD],
	});
	assert.equal(reviewed.action, "raise");
});

test("cp-no-ci: the probe asks about workflows only when the branch has no runs, and never over a red one", async () => {
	const asked: string[] = [];
	const probe = (runs: readonly ReturnType<typeof run>[]) =>
		createMergeAskProbe({
			head: async () => ({ sha: HEAD }),
			runs: async () => runs,
			ciConfigured: async (jobId) => {
				asked.push(jobId);
				return "none" as const;
			},
		});
	const subject = { type: "approval", decision: "Merge PR #7?", job_id: "cp-gmy" };

	const red = await probe([run({ conclusion: "failure" })])(subject);
	assert.equal(red.action, "refuse");
	assert.deepEqual(asked, [], "a branch with runs already has its answer");

	const none = await probe([])(subject);
	assert.equal(none.action, "raise");
	assert.equal(none.ci, "no_ci");
	assert.deepEqual(asked, ["cp-gmy"]);
});

test("cp-1som: a review pass on a SUPERSEDED head does not unlock the ask", () => {
	// A revise moves the head; a review of the old diff says as little as a green
	// run on the old sha.
	const verdict = evaluateMergeAskCi({
		branch: "cp-gmy",
		head: { sha: HEAD },
		runs: [run()],
		reviewedHeads: [OLD],
	});
	assert.equal(verdict.action, "defer");
	assert.equal(verdict.ci, "unreviewed");
});

test("cp-1som: a row whose job has no branch is deferred, never raised, and never queried", async () => {
	let ranQuery = false;
	const probe = createMergeAskProbe({
		head: async (branch) => ({ reason: `${branch} has no pushed head on origin` }),
		runs: async () => {
			ranQuery = true;
			return [run()];
		},
	});
	const noBranch = await probe({ type: "approval", decision: "Merge cp-x and drop cp-y?", job_id: "cp-x" });
	assert.equal(noBranch.action, "defer");
	assert.equal(noBranch.ci, "unknown");
	assert.match(noBranch.reason, /no pushed head on origin/);
	assert.equal(ranQuery, false, "a branchless row costs no CI query");

	const noJob = await probe({ type: "approval", decision: "Merge PR #9?" });
	assert.equal(noJob.action, "defer");
	assert.match(noJob.reason, /no job/);
});

test("a probe whose CI query throws defers the ask, with the failure named", async () => {
	const probe = createMergeAskProbe({
		head: async () => ({ sha: HEAD }),
		runs: async () => {
			throw new Error("gh: 403");
		},
	});
	const verdict = await probe({ type: "approval", decision: "merge PR #1?", job_id: "cp-x" });
	assert.equal(verdict.action, "defer");
	assert.equal(verdict.ci, "unknown");
	assert.match(verdict.reason, /403/);
});

test("a probe passes its job's reviewed heads to the rule (cp-1som)", async () => {
	const probe = createMergeAskProbe({
		head: async () => ({ sha: HEAD }),
		runs: async () => [run()],
		reviewedHeads: (jobId) => (jobId === "cp-reviewed" ? [HEAD] : []),
	});
	const reviewed = await probe({ type: "approval", decision: "Ship cp-reviewed (PR 119), drop it, or open a follow-up?", job_id: "cp-reviewed" });
	assert.equal(reviewed.action, "raise");
	const unreviewed = await probe({ type: "approval", decision: "Ship cp-x (PR 120), drop it, or open a follow-up?", job_id: "cp-x" });
	assert.equal(unreviewed.action, "defer");
	assert.equal(unreviewed.ci, "unreviewed");
});

test("isMergeAsk recognises a merge ask and only a merge ask", () => {
	assert.equal(isMergeAsk({ type: "approval", decision: "Merge PR #44 once its rebase lands green" }), true);
	assert.equal(isMergeAsk({ type: "approval", decision: "merge cp-gmy?" }), true);
	assert.equal(isMergeAsk({ type: "approval", decision: "cp-x: is #12 ready to merge?" }), true);
	assert.equal(isMergeAsk({ type: "design", decision: "postgres or sqlite?" }), false);
	assert.equal(
		isMergeAsk({ type: "authorization", decision: "merge PR #9?" }),
		false,
		"an authorization is never declared here at all",
	);
});

test("cp-1som: a SHIP row that names a PR is a merge ask; the research ship/drop row is not", () => {
	// The exact wording this session raised on PR 119 before cp_integrate found
	// CI still in_progress.
	assert.equal(isMergeAsk({ type: "approval", decision: "Ship cp-dlw7 (PR 119), drop it, or open a follow-up?", job_id: "cp-dlw7" }), true);
	assert.equal(isMergeAsk({ type: "approval", decision: "Ship PR #117 or hold it?" }), true);
	assert.equal(isMergeAsk({ type: "approval", decision: "cp-x: ship #12 now?" }), true);
	// Out of scope, deliberately: research with no PR has no head and no CI.
	assert.equal(isMergeAsk({ type: "approval", decision: "cp-x: ship, drop or follow-up?" }), false);
	assert.equal(isMergeAsk({ type: "approval", decision: "Ship cp-x, drop it, or open a follow-up?", job_id: "cp-x" }), false);
});

// ---------------------------------------------------------------------------
// The six cases from the issue, at the point a row is created
// ---------------------------------------------------------------------------

test("case 1: CI in progress for the head -> no merge-approval row is raised", async () => {
	const home = createScratchHome();
	try {
		const { store } = storeWithCi(home.path, { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] });
		const outcome = await store.declareGated(MERGE_ASK);
		assert.equal(outcome.raised, false);
		assert.equal(outcome.item.state, "deferred");
		assert.equal(outcome.gate?.ci, "in_progress");
		assert.deepEqual(store.list("open"), []);
		assert.deepEqual(mergeAwaiting({ checkpoints: [], heldResearch: [], declared: store.list() }), []);
	} finally {
		home.cleanup();
	}
});

test("case 2: the same item, once the run completes green on that exact head, is raised exactly once", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] };
		const { store } = storeWithCi(home.path, state);
		const deferred = await store.declareGated(MERGE_ASK);
		assert.equal(deferred.raised, false);

		state.runs = [run()];
		const review = await store.reviewDeferred();
		assert.deepEqual(
			review.raised.map((item) => item.id),
			[deferred.item.id],
			"the promoted row keeps the id it was deferred under",
		);
		const open = store.list("open");
		assert.equal(open.length, 1);
		assert.equal(open[0]!.id, awaitingId(MERGE_ASK));
		assert.equal(open[0]!.deferred_reason, undefined);
		// A second review after it is open changes nothing: asked once.
		const again = await store.reviewDeferred();
		assert.deepEqual(again.raised, []);
		assert.equal(store.list("open").length, 1);
	} finally {
		home.cleanup();
	}
});

test("case 3: CI green on a superseded sha is treated as not finished — no row raised", async () => {
	const home = createScratchHome();
	try {
		const { store } = storeWithCi(home.path, { head: HEAD, runs: [run({ headSha: OLD })] });
		const outcome = await store.declareGated(MERGE_ASK);
		assert.equal(outcome.raised, false);
		assert.equal(outcome.gate?.ci, "superseded");
		assert.deepEqual(store.list("open"), []);
	} finally {
		home.cleanup();
	}
});

test("case 4: CI completed and failed -> no merge-approval row at all, and the failure is what is surfaced", async () => {
	const home = createScratchHome();
	try {
		const { store } = storeWithCi(home.path, { head: HEAD, runs: [run({ conclusion: "failure" })] });
		const outcome = await store.declareGated(MERGE_ASK);
		assert.equal(outcome.raised, false);
		assert.equal(outcome.gate?.ci, "failed");
		assert.deepEqual(store.list("open"), []);
		assert.match(store.list("deferred")[0]!.deferred_reason ?? "", /failure/);
	} finally {
		home.cleanup();
	}
});

test("case 5: a deferred ask is not lost — it appears on a later render with no operator action", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "queued", conclusion: null })] };
		const { store } = storeWithCi(home.path, state);
		await store.declareGated(MERGE_ASK);

		// A whole new process: nothing survives except state/awaiting.json.
		const state2 = { head: HEAD, runs: [run()] };
		const { store: reopened } = storeWithCi(home.path, state2);
		assert.equal(reopened.list("deferred").length, 1, "the deferral is durable, not a variable in a lost turn");
		await reopened.reviewDeferred();
		const rendered = mergeAwaiting({ checkpoints: [], heldResearch: [], declared: reopened.list() });
		assert.equal(rendered.length, 1);
		assert.equal(rendered[0]!.id, awaitingId(MERGE_ASK));
		assert.equal(rendered[0]!.decision, MERGE_ASK.decision);
	} finally {
		home.cleanup();
	}
});

test("case 6: deferring the same decision twice does not mint two items when it finally appears", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] };
		const { store } = storeWithCi(home.path, state);
		const first = await store.declareGated(MERGE_ASK);
		// The parent re-asks next turn with the facts of the moment attached — the
		// exact rewording cp-nx7 made non-identity-bearing.
		const second = await store.declareGated({
			...MERGE_ASK,
			decision: "Merge PR #58 when CI goes green on 8c7d014",
			why: "still waiting",
		});
		assert.equal(first.item.id, second.item.id);
		assert.equal(store.read().items.length, 1);

		state.runs = [run()];
		await store.reviewDeferred();
		const open = store.list("open");
		assert.equal(open.length, 1, "one decision, one row");
		assert.equal(open[0]!.id, first.item.id);
		assert.equal(store.read().items.length, 1);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The gate governs raising, not retracting; and it is never silent
// ---------------------------------------------------------------------------

test("declare() throws rather than returning an unraised row — a gated ask fails loudly", async () => {
	const home = createScratchHome();
	try {
		const { store } = storeWithCi(home.path, { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] });
		await assert.rejects(() => store.declare(MERGE_ASK), MergeAskDeferredError);
		assert.equal(store.list("deferred").length, 1, "the row is stored even though the call threw");
	} finally {
		home.cleanup();
	}
});

test("an already-open merge ask is never retracted by a later CI run, and is never re-probed", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run()] };
		const { store, probes } = storeWithCi(home.path, state);
		const raised = await store.declareGated(MERGE_ASK);
		assert.equal(raised.raised, true);
		assert.equal(probes(), 1);

		state.runs = [run({ status: "in_progress", conclusion: null })];
		const again = await store.declareGated({ ...MERGE_ASK, why: "re-rendered next turn" });
		assert.equal(again.raised, true, "a question the operator can already see stays asked");
		assert.equal(probes(), 1, "an open row is not re-gated");
	} finally {
		home.cleanup();
	}
});

test("a non-merge decision is never gated, even with a store that has a probe", async () => {
	const home = createScratchHome();
	try {
		const { store, probes } = storeWithCi(home.path, { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] });
		const outcome = await store.declareGated({
			type: "design",
			decision: "postgres or sqlite?",
			why: "schema",
			blocks: "cp-db",
		});
		assert.equal(outcome.raised, true);
		assert.equal(outcome.gate, undefined);
		assert.equal(probes(), 0);
	} finally {
		home.cleanup();
	}
});

test("an answered merge ask is not re-gated or re-asked when CI restarts", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run()] };
		const { store } = storeWithCi(home.path, state);
		const raised = await store.declareGated(MERGE_ASK);
		await store.answer(raised.item.id, { answer: "merge", by: "operator" });
		state.runs = [run({ status: "in_progress", conclusion: null })];
		const again = await store.declareGated(MERGE_ASK);
		assert.equal(again.item.state, "answered");
		assert.equal(store.read().items.length, 1);
	} finally {
		home.cleanup();
	}
});

test("a store with no probe raises every ask, exactly as before the gate existed", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = await store.declare(MERGE_ASK);
		assert.equal(item.state, "open");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Rendering: a deferral is announced, never dropped
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: StatusSnapshot = {
	schema_version: 1,
	generated_at: "2026-08-31T10:00:00Z",
	home: "/tmp/home",
	jobs: [],
	counts: { waiting: 0, held: 0, done: 0, failed: 0, alive: 0 },
} as unknown as StatusSnapshot;

test("the status block prints a deferred merge ask under an empty Awaiting-you table", () => {
	const block = assembleStatusBlock(EMPTY_SNAPSHOT, {
		mergeAsks: [
			{ kind: "deferred", job_id: "cp-gmy", decision: "Merge PR #58?", reason: "CI is in_progress on 8c7d014" },
			{ kind: "ci_failed", job_id: "cp-old", decision: "Merge PR #12?", reason: "CI failure on 0d03ad1" },
		],
	});
	assert.match(block.text, /Awaiting you: none/);
	assert.match(block.text, /Not asked yet — not ready to merge \(1, raised automatically once CI is green on the current head and a review passes\):/);
	assert.match(block.text, /cp-gmy — Merge PR #58\?: CI is in_progress on 8c7d014/);
	assert.match(block.text, /Not asked — CI red \(1\)/);
	assert.match(block.text, /cp-old — Merge PR #12\?: CI failure on 0d03ad1/);
});

test("awaitingRowsNotSupplied folds a promoted row in only when the caller did not mention it", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = await store.declare(MERGE_ASK);
		assert.deepEqual(
			awaitingRowsNotSupplied([{ type: "approval", decision: "Merge PR #58 now that CI is green", job_id: "cp-gmy" }], [item]),
			[],
			"a reworded re-render of the same subject is the same row",
		);
		assert.deepEqual(
			awaitingRowsNotSupplied([{ type: "design", decision: "postgres or sqlite?" }], [item]).map((row) => row.id),
			[item.id],
		);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The production query shapes, without running them
// ---------------------------------------------------------------------------

test("ghCiRuns issues one non-blocking `gh run list` with the json fields that work in this home", async () => {
	const seen: { command: string; args: readonly string[] }[] = [];
	const runs = await ghCiRuns({
		cwd: "/tmp/repo",
		exec: async (command, args) => {
			seen.push({ command, args });
			return JSON.stringify([{ status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci" }]);
		},
	})("cp-gmy");
	assert.deepEqual(seen[0]!.command, "gh");
	assert.deepEqual(seen[0]!.args.slice(0, 4), ["run", "list", "--branch", "cp-gmy"]);
	assert.ok(seen[0]!.args.includes("conclusion,status,headSha,workflowName,databaseId,attempt"));
	assert.ok(!seen[0]!.args.some((arg) => arg === "--watch"), "never a watch; never a poll");
	assert.deepEqual(runs, [{ status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci" }]);
});

test("parseCiRuns drops rows with no headSha and normalises an empty conclusion to null", () => {
	const runs = parseCiRuns(JSON.stringify([{ status: "in_progress", conclusion: "", headSha: HEAD }, { status: "queued" }]));
	assert.deepEqual(runs, [{ status: "in_progress", conclusion: null, headSha: HEAD }]);
	assert.deepEqual(parseCiRuns("   "), []);
});

test("parseCiRuns carries the run id and attempt a re-run moves (pi-command-post-rerunwake-12z)", () => {
	assert.deepEqual(
		parseCiRuns(JSON.stringify([{ status: "completed", conclusion: "failure", headSha: HEAD, databaseId: 5001, attempt: 2 }])),
		[{ status: "completed", conclusion: "failure", headSha: HEAD, databaseId: 5001, attempt: 2 }],
	);
	// An older gh without the fields is still a fact, just one that cannot tell a re-run apart.
	assert.deepEqual(parseCiRuns(JSON.stringify([{ status: "completed", conclusion: "failure", headSha: HEAD }])), [
		{ status: "completed", conclusion: "failure", headSha: HEAD },
	]);
});

test("gitRemoteHead prefers the remote, falls back to a reported head, and says so when there is none", async () => {
	const remote = gitRemoteHead({ cwd: "/tmp/repo", exec: async () => `${HEAD}\trefs/heads/cp-gmy\n` });
	assert.deepEqual(await remote("cp-gmy", "cp-gmy"), { sha: HEAD });

	const broken = gitRemoteHead({
		cwd: "/tmp/repo",
		exec: async () => {
			throw new Error("no network");
		},
		fallback: () => OLD,
	});
	assert.deepEqual(await broken("cp-gmy", "cp-gmy"), { sha: OLD });

	const nothing = gitRemoteHead({ cwd: "/tmp/repo", exec: async () => "" });
	assert.match((await nothing("cp-gmy", "cp-gmy")).reason ?? "", /no pushed head/);
});

// ---------------------------------------------------------------------------
// cp-to39: a deferred merge ask whose job is gone
//
// The starting point: `createMergeAskProbe`'s catch-all turned *any* fact
// failure into `raise` / `ci: "unknown"`, and `reviewDeferred` promotes every
// `raise`. So a torn-down job did not leave its row deferred forever (as the
// review claimed) — it did the opposite, and raised an unanswerable merge ask
// for a job with no fleet record. The fix gives the probe a distinct *cause*
// for "this row's job is gone" and keeps the row visible instead.
// ---------------------------------------------------------------------------

/** A store whose probe fails, with whatever error the case is about. */
function storeWithFailingProbe(home: string, error: () => unknown) {
	return new AwaitingStore({
		home,
		mergeAsk: createMergeAskProbe({
			head: async () => {
				throw error();
			},
			runs: async () => [],
		}),
	});
}

test("cp-to39: the job-gone cause is structural, not an error message or a single class identity", () => {
	assert.equal(isJobGoneError(new MergeAskJobGoneError("cp-x")), true);
	assert.equal(isJobGoneError({ mergeAskJobGone: true, message: "from another module instance" }), true);
	assert.equal(isJobGoneError(new Error("no fleet record for cp-x")), false, "never string-matched");
	assert.equal(isJobGoneError(undefined), false);
});

test("cp-to39/cp-1som: an UNSIGNALLED failure is ci unknown — not the job-gone cause, and (since cp-1som) not raised", async () => {
	const home = createScratchHome();
	try {
		// The pre-fix shape exactly: a plain Error whose message happens to be the
		// missing-fleet-record one. No cause is signalled, so the gate must not read
		// it as job-gone — it is ordinary ignorance, which cp-1som defers.
		const store = storeWithFailingProbe(home.path, () => new Error("no fleet record for cp-gmy"));
		const state = { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] };
		const { store: seeder } = storeWithCi(home.path, state);
		const deferred = await seeder.declareGated(MERGE_ASK);
		assert.equal(deferred.item.state, "deferred");

		const review = await store.reviewDeferred();
		assert.deepEqual(review.raised, [], "ignorance never raises an ask (cp-1som)");
		assert.deepEqual(
			review.stillDeferred.map((item) => item.id),
			[deferred.item.id],
		);
		assert.deepEqual(review.orphaned, [], "a string-matched message is not the job-gone cause");
		assert.match(review.verdicts.get(deferred.item.id)!.reason, /no fleet record for cp-gmy/);
		assert.equal(review.verdicts.get(deferred.item.id)!.ci, "unknown");
	} finally {
		home.cleanup();
	}
});

test("cp-to39: a job-gone cause neither raises nor deletes the row — it stays deferred and stays listed", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] };
		const { store: seeder } = storeWithCi(home.path, state);
		const deferred = await seeder.declareGated(MERGE_ASK);

		const store = storeWithFailingProbe(home.path, () => new MergeAskJobGoneError("cp-gmy"));
		const review = await store.reviewDeferred();
		assert.deepEqual(review.raised, [], "an unanswerable ask is never raised");
		assert.deepEqual(
			review.orphaned.map((item) => item.id),
			[deferred.item.id],
		);
		const verdict = review.verdicts.get(deferred.item.id)!;
		assert.equal(verdict.action, "orphaned");
		assert.equal(verdict.ci, "job_gone");
		assert.match(verdict.reason, /job cp-gmy is gone — answer or withdraw/);

		// Nothing destroyed: the row is on disk, in the state a renderer reads.
		const reopened = new AwaitingStore({ home: home.path });
		const rows = reopened.list("deferred");
		assert.equal(rows.length, 1, "the row survives the pass that observed the missing job");
		assert.equal(rows[0]!.id, deferred.item.id);
		assert.equal(rows[0]!.state, "deferred");
		assert.match(rows[0]!.deferred_reason ?? "", /job cp-gmy is gone/);
		assert.equal(reopened.read().items.length, 1);
		assert.deepEqual(reopened.list("withdrawn"), [], "not withdrawn either — the operator decides that");
	} finally {
		home.cleanup();
	}
});

test("cp-to39: `gh` unreachable is not 'job gone' — it is ci unknown, and cp-1som keeps it deferred", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] };
		const { store: seeder } = storeWithCi(home.path, state);
		const deferred = await seeder.declareGated(MERGE_ASK);

		const store = storeWithFailingProbe(home.path, () => new Error("gh: 403 rate limited"));
		const review = await store.reviewDeferred();
		assert.deepEqual(review.raised, [], "an unreadable CI state is not permission to ask");
		assert.deepEqual(
			review.stillDeferred.map((item) => item.id),
			[deferred.item.id],
		);
		assert.deepEqual(review.orphaned, [], "the two causes stay distinct");
		const verdict = review.verdicts.get(deferred.item.id)!;
		assert.equal(verdict.ci, "unknown");
		assert.match(verdict.reason, /403/);
	} finally {
		home.cleanup();
	}
});

test("cp-to39: no collateral expiry — a live job's in-progress row stays deferred, and answered rows are untouched", async () => {
	const home = createScratchHome();
	try {
		const gone = { ...MERGE_ASK, decision: "Merge PR #58 for cp-gone?", job_id: "cp-gone" };
		const live = { ...MERGE_ASK, decision: "Merge PR #59 for cp-live?", job_id: "cp-live" };
		const settled = { ...MERGE_ASK, decision: "Merge PR #60 for cp-settled?", job_id: "cp-settled" };

		// Seed: two deferred rows (one whose job will vanish) and one answered row.
		const seeder = new AwaitingStore({
			home: home.path,
			mergeAsk: async () => ({ action: "defer", ci: "in_progress", reason: "CI is in_progress on 8c7d014" }),
		});
		const goneRow = (await seeder.declareGated(gone)).item;
		const liveRow = (await seeder.declareGated(live)).item;
		const plain = new AwaitingStore({ home: home.path });
		const settledRow = await plain.declare(settled);
		await plain.answer(settledRow.id, { answer: "merge", by: "operator" });

		// The pass: cp-gone has no fleet record; cp-live's CI is still running.
		const store = new AwaitingStore({
			home: home.path,
			mergeAsk: createMergeAskProbe({
				head: async (_branch, jobId) => {
					if (jobId === "cp-gone") throw new MergeAskJobGoneError("cp-gone");
					return { sha: HEAD };
				},
				runs: async () => [run({ status: "in_progress", conclusion: null })],
			}),
		});
		const review = await store.reviewDeferred();
		assert.deepEqual(
			review.orphaned.map((item) => item.job_id),
			["cp-gone"],
		);
		assert.deepEqual(
			review.stillDeferred.map((item) => item.job_id),
			["cp-live"],
		);
		assert.deepEqual(review.raised, []);

		const after = new AwaitingStore({ home: home.path });
		assert.equal(after.read().items.length, 3, "no row is expired by a pass in which another row's job is gone");
		const liveAfter = after.read().items.find((item) => item.id === liveRow.id)!;
		assert.equal(liveAfter.state, "deferred");
		assert.match(liveAfter.deferred_reason ?? "", /in_progress/);
		const answeredAfter = after.read().items.find((item) => item.id === settledRow.id)!;
		assert.equal(answeredAfter.state, "answered");
		assert.equal(answeredAfter.answer, "merge");
		assert.equal(after.read().items.find((item) => item.id === goneRow.id)!.state, "deferred");

		// An authorization row is derived from a checkpoint and has no row here at
		// all, so the pass cannot have touched it: it is still rendered.
		const checkpoint = {
			schema_version: SCHEMA_VERSION,
			job_id: "cp-auth",
			question: "authorize cp-auth?",
			state: "pending",
			requested_at: "2026-08-31T09:00:00Z",
		} as unknown as Checkpoint;
		const rendered = mergeAwaiting({ checkpoints: [checkpoint], heldResearch: [], declared: after.list() });
		assert.equal(rendered.filter((row) => row.type === "authorization").length, 1);
	} finally {
		home.cleanup();
	}
});

test("cp-to39: the production probe reports job-gone for a deferred row whose fleet record is gone", async () => {
	const home = createScratchHome();
	try {
		const ask = {
			type: "approval" as const,
			decision: "Merge PR #58 for cp-vanished?",
			why: "it was verified before teardown",
			blocks: "nothing — the job is gone",
			job_id: "cp-vanished",
		};
		// The row was deferred while the job was alive; the job was then torn down.
		const seeder = new AwaitingStore({
			home: home.path,
			mergeAsk: async () => ({ action: "defer", ci: "in_progress", reason: "CI is in_progress on 8c7d014" }),
		});
		const deferred = (await seeder.declareGated(ask)).item;

		// The real probe, wired by CommandPost: no fleet record, no `gh` call at all.
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const review = await post.awaiting.reviewDeferred();
		assert.deepEqual(review.raised, [], "no unanswerable merge ask for a job that is gone");
		assert.deepEqual(
			review.orphaned.map((item) => item.id),
			[deferred.id],
		);
		const verdict = review.verdicts.get(deferred.id)!;
		assert.equal(verdict.ci, "job_gone");
		assert.equal(verdict.action, "orphaned");
		assert.match(verdict.reason, /job cp-vanished is gone/);
		assert.equal(post.awaiting.list("deferred").length, 1, "still on disk, still visible");
	} finally {
		home.cleanup();
	}
});

test("cp-to39/cp-1som: a NEW merge ask for a job the fleet does not know is deferred as ignorance, not orphaned", async () => {
	const home = createScratchHome();
	try {
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const outcome = await post.awaiting.declareGated({
			type: "approval",
			decision: "Merge PR #58 for cp-unknown?",
			why: "green on the pushed head",
			blocks: "cp-unknown delivery",
			job_id: "cp-unknown",
		});
		assert.equal(outcome.raised, false, "nothing is asked about a head this home cannot read");
		assert.equal(outcome.item.state, "deferred");
		assert.equal(outcome.gate?.ci, "unknown", "ignorance, not the job-gone cause");
		assert.match(outcome.gate?.reason ?? "", /no fleet record for cp-unknown/);
	} finally {
		home.cleanup();
	}
});

test("cp-to39: the status block gives a job-gone row its own notice, never 'CI unfinished'", () => {
	const block = assembleStatusBlock(EMPTY_SNAPSHOT, {
		mergeAsks: [
			{ kind: "job_gone", job_id: "cp-gone", decision: "Merge PR #58?", reason: "job cp-gone is gone — answer or withdraw" },
		],
	});
	assert.match(block.text, /Not asked — the job is gone \(1\); answer or withdraw it with cp_decide:/);
	assert.match(block.text, /cp-gone — Merge PR #58\?: job cp-gone is gone/);
	assert.ok(!/not ready to merge/.test(block.text), "a torn-down job is not a CI wait");
});

// ---------------------------------------------------------------------------
// cp-p1sh: a deferred merge ask whose PR has already merged
//
// The starting point: a deferral had exactly one exit — CI finishing. So when
// the PR merged *while the row was deferred* (repo-derived authority merges
// without consuming an operator turn), the row raised itself afterwards and
// asked a human to approve a merge whose commit already existed: cp-rud / PR
// #69 and cp-n1a / PR #70, both withdrawn by hand. The fix gives the probe a
// terminal cause read from a LOCAL fact (the job's merge receipt, written only
// for a PR `gh pr view` reported MERGED) and closes the row instead of asking.
// ---------------------------------------------------------------------------

const MERGE_COMMIT = "1f2e3d4c5b6a79880123456789abcdef01234567";

function evidence(overrides: Partial<MergeAskMergedEvidence> = {}): MergeAskMergedEvidence {
	return { merge_commit_sha: MERGE_COMMIT, pr_number: 58, pr_url: "https://github.com/o/r/pull/58", head_sha: HEAD, ...overrides };
}

/** A store whose CI is unfinished, and whose merge receipt is whatever the case says. */
function storeWithMerge(home: string, merged: (jobId: string) => MergeAskMergedEvidence | undefined, runs: CiRun[] = [run({ status: "in_progress", conclusion: null })]) {
	return new AwaitingStore({
		home,
		mergeAsk: createMergeAskProbe({
			merged: (jobId) => merged(jobId),
			head: async () => ({ sha: HEAD }),
			runs: async () => runs,
		}),
	});
}

/** The one local fact the production gate reads: state/runs/<job-id>/merge.json. */
function writeMergeReceipt(home: string, jobId: string, overrides: Record<string, unknown> = {}): void {
	const file = join(home, paths.mergeFile(jobId));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			job_id: jobId,
			pr_url: "https://github.com/o/r/pull/58",
			pr_number: 58,
			merge_commit_sha: MERGE_COMMIT,
			head_sha: HEAD,
			head_branch: jobId,
			recorded_at: "2026-09-01T12:00:00Z",
			recorded_by: "gh pr view",
			...overrides,
		}),
	);
}

test("cp-p1sh: evaluateAlreadyMerged is evidence-only and matches structurally, never on prose", () => {
	assert.equal(evaluateAlreadyMerged({ jobId: "cp-x" }), undefined, "no receipt is not evidence of a merge");
	assert.equal(
		evaluateAlreadyMerged({ jobId: "cp-x", evidence: evidence({ merge_commit_sha: "   " }) }),
		undefined,
		"a receipt with no merge commit proves nothing",
	);
	const resolved = evaluateAlreadyMerged({ jobId: "cp-x", prNumber: "58", evidence: evidence() })!;
	assert.equal(
		evaluateAlreadyMerged({ jobId: "cp-x", prNumber: "58", evidence: evidence({ pr_number: undefined }) })?.ci,
		"already_merged",
		"the url names the PR when the field does not",
	);
	assert.equal(
		evaluateAlreadyMerged({
			jobId: "cp-x",
			prNumber: "58",
			evidence: evidence({ pr_number: undefined, pr_url: "https://github.com/o/r/pull/59" }),
		}),
		undefined,
		"a mismatch in the url is still a mismatch",
	);
	assert.equal(
		evaluateAlreadyMerged({
			jobId: "cp-x",
			prNumber: "59",
			evidence: evidence({ pr_number: undefined, pr_url: "https://example.invalid/no-number" }),
		})?.action,
		"resolved",
		"a receipt that names no PR number is still this job's merge: the caller looked it up by this row's job id",
	);
	assert.equal(resolved.action, "resolved");
	assert.equal(resolved.ci, "already_merged");
	assert.match(resolved.reason, /PR #58 already merged as 1f2e3d4/);
	assert.equal(
		evaluateAlreadyMerged({ jobId: "cp-x", prNumber: "59", evidence: evidence() }),
		undefined,
		"a receipt for another PR says nothing about this row",
	);
	assert.equal(
		evaluateAlreadyMerged({ jobId: "cp-x", evidence: evidence({ pr_number: undefined }) })?.action,
		"resolved",
		"a row that names no PR is resolved by its own job's receipt",
	);
});

test("cp-p1sh: a deferred merge ask whose PR has merged is resolved, never rendered as an open ask", async () => {
	const home = createScratchHome();
	try {
		const state = { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] };
		const { store: seeder } = storeWithCi(home.path, state);
		const deferred = (await seeder.declareGated(MERGE_ASK)).item;
		assert.equal(deferred.state, "deferred");

		// The merge happens while the row is deferred; CI is *still* unfinished, which
		// is exactly the shape that used to raise the ask a moment later.
		const store = storeWithMerge(home.path, () => evidence());
		const review = await store.reviewDeferred();
		assert.deepEqual(review.raised, [], "a merge that happened is not a question");
		assert.deepEqual(review.stillDeferred, []);
		assert.deepEqual(review.orphaned, []);
		assert.deepEqual(
			review.resolved.map((item) => item.id),
			[deferred.id],
		);
		const verdict = review.verdicts.get(deferred.id)!;
		assert.equal(verdict.action, "resolved");
		assert.equal(verdict.ci, "already_merged");

		// Closed, kept, and invisible as a decision: not open, not deferred, not
		// answered on anyone's behalf, and absent from the rendered Awaiting-you set.
		const reopened = new AwaitingStore({ home: home.path });
		assert.deepEqual(reopened.list("open"), []);
		assert.deepEqual(reopened.list("deferred"), []);
		assert.deepEqual(reopened.list("answered"), []);
		const row = reopened.get(deferred.id)!;
		assert.equal(row.state, "withdrawn");
		assert.match(row.deferred_reason ?? "", /already merged as 1f2e3d4/);
		assert.deepEqual(mergeAwaiting({ checkpoints: [], heldResearch: [], declared: reopened.list() }), []);

		// Idempotent: a second render neither reopens it nor mints a second row.
		const again = await storeWithMerge(home.path, () => evidence()).reviewDeferred();
		assert.deepEqual(again.resolved, []);
		assert.equal(new AwaitingStore({ home: home.path }).read().items.length, 1);
	} finally {
		home.cleanup();
	}
});

test("cp-p1sh: a NEW merge ask for a PR that already merged is recorded and closed, never asked", async () => {
	const home = createScratchHome();
	try {
		const store = storeWithMerge(home.path, () => evidence());
		const outcome = await store.declareGated(MERGE_ASK);
		assert.equal(outcome.raised, false);
		assert.equal(outcome.gate?.action, "resolved");
		assert.equal(outcome.item.state, "withdrawn");

		// And through cp-nz95's declaring loop, which is what cp_status_block calls:
		// a notice under the table, never a row rendered as an open question.
		const fresh = { ...MERGE_ASK, decision: "Merge PR #58 for cp-fresh?", job_id: "cp-fresh" };
		const partitioned = await resolveAwaitingRows(
			[{ type: "approval", decision: fresh.decision, why: fresh.why, blocks: fresh.blocks, job_id: fresh.job_id }],
			storeWithMerge(home.path, () => evidence()),
		);
		assert.deepEqual(partitioned.rendered, [], "never rendered as an open decision");
		assert.deepEqual(partitioned.refused, [], "and not scolded as a settled row either");
		assert.equal(partitioned.mergeAsks.length, 1);
		assert.equal(partitioned.mergeAsks[0]!.kind, "already_merged");
		assert.match(partitioned.mergeAsks[0]!.reason, /already merged as 1f2e3d4/);

		// A row that was already closed on an earlier turn is cp-nz95's settled case,
		// not this one: it is a notice, and it is still never rendered as open.
		const again = await resolveAwaitingRows(
			[{ type: "approval", decision: fresh.decision, why: fresh.why, blocks: fresh.blocks, job_id: fresh.job_id }],
			storeWithMerge(home.path, () => evidence()),
		);
		assert.deepEqual(again.rendered, []);
		assert.deepEqual(again.mergeAsks, [], "reported once, then it is history");
		assert.match(again.refused[0]!.reason, /already withdrawn/);
		assert.deepEqual(store.list("open"), []);
		assert.deepEqual(store.list("deferred"), [], "not a CI wait: there is nothing left to wait for");

		// declare() is still loud, and says the right thing about why.
		await assert.rejects(
			() => new AwaitingStore({ home: home.path, mergeAsk: async () => ({ action: "resolved", ci: "already_merged", reason: "PR #59 already merged as abc1234" }) }).declare({ ...MERGE_ASK, decision: "Merge PR #59 for cp-other?", job_id: "cp-other" }),
			(error: Error) => error instanceof MergeAskDeferredError && /already happened/.test(error.message),
		);
	} finally {
		home.cleanup();
	}
});

test("cp-p1sh: a terminal cause never overwrites a settled row — an answered merge ask keeps its answer", async () => {
	const home = createScratchHome();
	try {
		// The row was raised and answered by a human. Then the parent re-declares the
		// same decision (normal behaviour under delivery lag) while a merge receipt
		// exists, so the gate's terminal cause is in play for this very subject.
		const plain = new AwaitingStore({ home: home.path });
		const answered = await plain.declare(MERGE_ASK);
		await plain.answer(answered.id, { answer: "merge", by: "operator" });

		const store = storeWithMerge(home.path, () => evidence());
		const outcome = await store.declareGated(MERGE_ASK);
		assert.equal(outcome.item.id, answered.id, "same subject, same row");
		assert.equal(outcome.item.state, "answered", "a recorded answer is never closed by a gate verdict");
		assert.equal(outcome.item.answer, "merge");

		const after = new AwaitingStore({ home: home.path });
		assert.equal(after.read().items.length, 1, "and no second row is minted");
		const row = after.get(answered.id)!;
		assert.equal(row.state, "answered");
		assert.equal(row.answer, "merge");
		assert.equal(row.answered_by, "operator");
		assert.equal(row.deferred_reason, undefined, "and no closure reason is written onto it");

		// The same holds for a row a human withdrew: settled is settled.
		const other = { ...MERGE_ASK, decision: "Merge PR #62 for cp-drop?", job_id: "cp-drop" };
		const dropped = await plain.declare(other);
		await plain.withdraw(dropped.id);
		const reDeclared = await store.declareGated(other);
		assert.equal(reDeclared.item.state, "withdrawn");
		assert.equal(reDeclared.item.deferred_reason, undefined);
	} finally {
		home.cleanup();
	}
});

test("cp-p1sh: the render path reports a resolved row once, and the next render has nothing to report", async () => {
	const home = createScratchHome();
	try {
		// Exactly what cp_status_block does (extensions/command-post/index.ts): review
		// the deferred rows, map what the review closed through resolvedMergeAskRows,
		// and render. Extracted so the reporting path is testable without a pi context.
		const state = { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] };
		const { store: seeder } = storeWithCi(home.path, state);
		const deferred = (await seeder.declareGated(MERGE_ASK)).item;

		const store = storeWithMerge(home.path, () => evidence());
		const first = await store.reviewDeferred();
		const rows = resolvedMergeAskRows(first.resolved, first.verdicts);
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0], {
			kind: "already_merged",
			decision: MERGE_ASK.decision,
			reason: first.verdicts.get(deferred.id)!.reason,
			id: deferred.id,
			job_id: "cp-gmy",
		});
		const block = assembleStatusBlock(EMPTY_SNAPSHOT, { mergeAsks: rows });
		assert.match(block.text, /Not asked — already merged \(1\); the row is closed, nothing to approve:/);
		assert.match(block.text, /cp-gmy — Merge PR #58 for cp-gmy\?: PR #58 already merged/);
		assert.ok(!/Awaiting you:\s*\n.*Merge PR #58/.test(block.text), "never an open decision");

		// The next render: the row is closed, so it is neither reported nor deferred.
		const second = await storeWithMerge(home.path, () => evidence()).reviewDeferred();
		assert.deepEqual(resolvedMergeAskRows(second.resolved, second.verdicts), []);
		assert.deepEqual(store.list("deferred"), [], "nothing left for the deferred notice either");
		const quiet = assembleStatusBlock(EMPTY_SNAPSHOT, { mergeAsks: resolvedMergeAskRows(second.resolved, second.verdicts) });
		assert.ok(!/already merged/.test(quiet.text), "reported once, then gone");

		// The fallback, for a caller that has the row but not the verdict.
		assert.equal(
			resolvedMergeAskRows([{ id: "aw-1", decision: "Merge PR #58?" }])[0]!.reason,
			"the merge already happened",
		);
	} finally {
		home.cleanup();
	}
});

test("cp-p1sh: the CI gate is not weakened — unfinished CI still defers, and red CI still raises no ask", async () => {
	const home = createScratchHome();
	try {
		// No receipt: the merged check falls straight through to the CI rule.
		const unfinished = storeWithMerge(home.path, () => undefined);
		const deferred = await unfinished.declareGated(MERGE_ASK);
		assert.equal(deferred.raised, false);
		assert.equal(deferred.item.state, "deferred");
		assert.equal(deferred.gate?.ci, "in_progress");
		const review = await unfinished.reviewDeferred();
		assert.deepEqual(review.resolved, []);
		assert.deepEqual(
			review.stillDeferred.map((item) => item.id),
			[deferred.item.id],
			"CI genuinely unfinished still defers",
		);

		const red = storeWithMerge(home.path, () => undefined, [run({ conclusion: "failure" })]);
		const redReview = await red.reviewDeferred();
		assert.deepEqual(redReview.raised, [], "merging red is forbidden, so no ask at all");
		assert.deepEqual(redReview.resolved, []);
		assert.equal(redReview.verdicts.get(deferred.item.id)!.ci, "failed");
		assert.equal(new AwaitingStore({ home: home.path }).get(deferred.item.id)!.state, "deferred");
	} finally {
		home.cleanup();
	}
});

test("cp-p1sh: no collateral mutation — answered, other-deferred, job-gone and authorization rows are untouched", async () => {
	const home = createScratchHome();
	try {
		const merged = { ...MERGE_ASK, decision: "Merge PR #58 for cp-merged?", job_id: "cp-merged" };
		const live = { ...MERGE_ASK, decision: "Merge PR #59 for cp-live?", job_id: "cp-live" };
		const gone = { ...MERGE_ASK, decision: "Merge PR #60 for cp-gone?", job_id: "cp-gone" };
		const settled = { ...MERGE_ASK, decision: "Merge PR #61 for cp-settled?", job_id: "cp-settled" };

		const seeder = new AwaitingStore({
			home: home.path,
			mergeAsk: async () => ({ action: "defer", ci: "in_progress", reason: "CI is in_progress on 8c7d014" }),
		});
		const mergedRow = (await seeder.declareGated(merged)).item;
		const liveRow = (await seeder.declareGated(live)).item;
		const goneRow = (await seeder.declareGated(gone)).item;
		const plain = new AwaitingStore({ home: home.path });
		const settledRow = await plain.declare(settled);
		await plain.answer(settledRow.id, { answer: "merge", by: "operator" });

		const store = new AwaitingStore({
			home: home.path,
			mergeAsk: createMergeAskProbe({
				merged: (jobId) => (jobId === "cp-merged" ? evidence() : undefined),
				head: async (_branch, jobId) => {
					if (jobId === "cp-gone") throw new MergeAskJobGoneError("cp-gone");
					return { sha: HEAD };
				},
				runs: async () => [run({ status: "in_progress", conclusion: null })],
			}),
		});
		const review = await store.reviewDeferred();
		assert.deepEqual(
			review.resolved.map((item) => item.job_id),
			["cp-merged"],
		);
		assert.deepEqual(
			review.stillDeferred.map((item) => item.job_id),
			["cp-live"],
		);
		assert.deepEqual(
			review.orphaned.map((item) => item.job_id),
			["cp-gone"],
			"cp-to39 still holds: a gone job is kept deferred, not resolved",
		);
		assert.deepEqual(review.raised, []);

		const after = new AwaitingStore({ home: home.path });
		assert.equal(after.read().items.length, 4, "nothing is deleted by a pass that closed one row");
		assert.equal(after.get(mergedRow.id)!.state, "withdrawn");
		assert.equal(after.get(liveRow.id)!.state, "deferred");
		assert.match(after.get(liveRow.id)!.deferred_reason ?? "", /in_progress/);
		assert.equal(after.get(goneRow.id)!.state, "deferred");
		assert.match(after.get(goneRow.id)!.deferred_reason ?? "", /job cp-gone is gone/);
		const answeredAfter = after.get(settledRow.id)!;
		assert.equal(answeredAfter.state, "answered");
		assert.equal(answeredAfter.answer, "merge");

		const checkpoint = {
			schema_version: SCHEMA_VERSION,
			job_id: "cp-auth",
			question: "authorize cp-auth?",
			state: "pending",
			requested_at: "2026-08-31T09:00:00Z",
		} as unknown as Checkpoint;
		const rendered = mergeAwaiting({ checkpoints: [checkpoint], heldResearch: [], declared: after.list() });
		assert.equal(rendered.filter((row) => row.type === "authorization").length, 1);
		assert.equal(
			rendered.filter((row) => row.job_id === "cp-merged").length,
			0,
			"the closed row is not an open decision anywhere",
		);
	} finally {
		home.cleanup();
	}
});

test("cp-p1sh: the production probe reads the local merge receipt, and no receipt still means job-gone", async () => {
	const home = createScratchHome();
	try {
		const ask = { ...MERGE_ASK, decision: "Merge PR #58 for cp-landed?", job_id: "cp-landed" };
		const seeder = new AwaitingStore({
			home: home.path,
			mergeAsk: async () => ({ action: "defer", ci: "in_progress", reason: "CI is in_progress on 8c7d014" }),
		});
		const deferred = (await seeder.declareGated(ask)).item;

		// Before the receipt exists this home knows nothing about the job (no fleet
		// record), which is cp-to39's cause and must stay that way.
		const gone = await new CommandPost({ home: home.path, packageRoot: REPO_ROOT }).awaiting.reviewDeferred();
		assert.deepEqual(gone.resolved, []);
		assert.deepEqual(
			gone.orphaned.map((item) => item.id),
			[deferred.id],
		);

		// The receipt is a local fact, so the merge is seen with no `gh` call at all.
		writeMergeReceipt(home.path, "cp-landed");
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const review = await post.awaiting.reviewDeferred();
		assert.deepEqual(review.raised, [], "never an ask for a merge that already landed");
		assert.deepEqual(review.orphaned, [], "a merged job is resolved by evidence, not stranded as gone");
		assert.deepEqual(
			review.resolved.map((item) => item.id),
			[deferred.id],
		);
		assert.equal(review.verdicts.get(deferred.id)!.ci, "already_merged");
		assert.match(review.verdicts.get(deferred.id)!.reason, /PR #58 already merged/);
		assert.deepEqual(post.awaiting.list("open"), []);
		assert.equal(post.awaiting.get(deferred.id)!.state, "withdrawn");
	} finally {
		home.cleanup();
	}
});

test("cp-p1sh: an unreadable merge state is never 'merged' — a torn receipt leaves the CI rule in charge", async () => {
	const home = createScratchHome();
	try {
		const ask = { ...MERGE_ASK, decision: "Merge PR #58 for cp-torn?", job_id: "cp-torn" };
		const seeder = new AwaitingStore({
			home: home.path,
			mergeAsk: async () => ({ action: "defer", ci: "in_progress", reason: "CI is in_progress on 8c7d014" }),
		});
		const deferred = (await seeder.declareGated(ask)).item;
		const file = join(home.path, paths.mergeFile("cp-torn"));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "{ not json");

		const review = await new CommandPost({ home: home.path, packageRoot: REPO_ROOT }).awaiting.reviewDeferred();
		assert.deepEqual(review.resolved, [], "ignorance is not evidence of a merge");
		assert.deepEqual(
			review.orphaned.map((item) => item.id),
			[deferred.id],
		);
	} finally {
		home.cleanup();
	}
});

test("cp-p1sh: the status block reports an already-merged row once, under its own notice", () => {
	const block = assembleStatusBlock(EMPTY_SNAPSHOT, {
		mergeAsks: [
			{ kind: "already_merged", job_id: "cp-rud", decision: "Merge PR #69?", reason: "PR #69 already merged as 1f2e3d4" },
		],
	});
	assert.match(block.text, /Not asked — already merged \(1\); the row is closed, nothing to approve:/);
	assert.match(block.text, /cp-rud — Merge PR #69\?: PR #69 already merged as 1f2e3d4/);
	assert.ok(!/CI unfinished/.test(block.text), "a merged PR is not a CI wait");
});

// ---------------------------------------------------------------------------
// cp-1som: do not ask a human to ship/merge/drop a PR until it is ready
//
// The incident: this session raised "Ship cp-dlw7 (PR 119), drop it, or open a
// follow-up?" the moment the envelope landed and the review passed. The
// operator answered "ship"; `cp_integrate` then found CI still `in_progress` on
// 71eb531. Same on PRs #117 and #118. Two causes, both closed here: the row was
// worded *ship* and the classifier only knew "merge", and an unreadable CI
// state raised the ask instead of holding it.
// ---------------------------------------------------------------------------

const SHIP_ASK = {
	type: "approval" as const,
	decision: "Ship cp-dlw7 (PR 119), drop it, or open a follow-up?",
	why: "envelope landed, review passed",
	blocks: "cp-dlw7 delivery",
	job_id: "cp-dlw7",
};

/** A store whose CI facts and reviewed heads are both the test's to set. */
function storeWithGate(home: string, state: { head: string | undefined; runs: CiRun[]; reviewed: string[] }) {
	return new AwaitingStore({
		home,
		mergeAsk: createMergeAskProbe({
			head: async () => (state.head ? { sha: state.head } : { reason: "not pushed" }),
			runs: async () => state.runs,
			reviewedHeads: () => state.reviewed,
		}),
	});
}

test("cp-1som: the incident — a SHIP row for a PR whose CI is in_progress is deferred, not asked", async () => {
	const home = createScratchHome();
	try {
		const { store } = storeWithCi(home.path, { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })] });
		const outcome = await store.declareGated(SHIP_ASK);
		assert.equal(outcome.raised, false, "wording it 'ship' must not route around the gate");
		assert.equal(outcome.gate?.ci, "in_progress");
		assert.deepEqual(store.list("open"), []);
	} finally {
		home.cleanup();
	}
});

test("cp-1som: a SHIP row at envelope time — no run on the pushed head yet — is deferred", async () => {
	const home = createScratchHome();
	try {
		const { store } = storeWithCi(home.path, { head: HEAD, runs: [] });
		const outcome = await store.declareGated(SHIP_ASK);
		assert.equal(outcome.raised, false, "an unreadable CI state is not permission to ask");
		assert.equal(outcome.gate?.ci, "unknown");
		assert.deepEqual(store.list("open"), []);
		assert.equal(store.list("deferred").length, 1, "stored, printed and re-reviewed — never dropped");
	} finally {
		home.cleanup();
	}
});

test("cp-1som: a SHIP row whose only green run is on a superseded sha is deferred", async () => {
	const home = createScratchHome();
	try {
		const { store } = storeWithCi(home.path, { head: HEAD, runs: [run({ headSha: OLD })] });
		const outcome = await store.declareGated(SHIP_ASK);
		assert.equal(outcome.raised, false);
		assert.equal(outcome.gate?.ci, "superseded");
	} finally {
		home.cleanup();
	}
});

test("cp-1som: green + reviewed on the current head is the only shape that raises a ship ask", async () => {
	const home = createScratchHome();
	try {
		// Green on the head, but the only review pass is on the pre-revise head.
		const state = { head: HEAD, runs: [run()], reviewed: [OLD] };
		const store = storeWithGate(home.path, state);
		const outcome = await store.declareGated(SHIP_ASK);
		assert.equal(outcome.raised, false, "a review of a superseded diff is not a review of this one");
		assert.equal(outcome.gate?.ci, "unreviewed");

		// The re-review passes on the current head: the row raises itself.
		state.reviewed = [HEAD];
		const review = await store.reviewDeferred();
		assert.deepEqual(
			review.raised.map((item) => item.id),
			[outcome.item.id],
		);
		assert.equal(store.list("open").length, 1);
	} finally {
		home.cleanup();
	}
});

test("cp-1som: readReviewPassHeads counts a pass, and only a readable pass", () => {
	const home = createScratchHome();
	try {
		writeReviewVerdict(home.path, "cp-dlw7", 1, { verdict: "revise", head_sha: OLD });
		writeReviewVerdict(home.path, "cp-dlw7", 2, { verdict: "pass", head_sha: HEAD });
		assert.deepEqual(readReviewPassHeads(home.path, "cp-dlw7"), [HEAD], "a revise is not a pass");

		writeRawReviewFile(home.path, "cp-dlw7", 3, "{ not json");
		assert.deepEqual(readReviewPassHeads(home.path, "cp-dlw7"), [HEAD], "an unreadable verdict is not a pass");
		writeRawReviewFile(home.path, "cp-dlw7", 4, JSON.stringify({ verdict: "pass", reviewed_sha: HEAD }));
		assert.deepEqual(readReviewPassHeads(home.path, "cp-dlw7"), [HEAD], "a verdict the writer's schema refuses is not a pass");
		assert.deepEqual(readReviewPassHeads(home.path, "cp-none"), [], "no reviews, no passes");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// cp-1som, review attempt 1: the two unbounded deferrals are the product, not
// a gap. Each is waiting for a fact somebody produces — a `cp_review` pass the
// parent runs, a CI state the `cp-ci` watch reads — and neither may raise on
// the absence of that fact. These tests fail if either grows an escape hatch.
// ---------------------------------------------------------------------------

test("cp-1som: a job that is NEVER reviewed never raises a merge ask — and the parent's cp_review is what ends that", async () => {
	const home = createScratchHome();
	try {
		// Green on the current head, every render, forever: the only missing fact is
		// the review. Nothing in this system may invent it.
		const state = { head: HEAD, runs: [run()], reviewed: [] as string[] };
		const store = storeWithGate(home.path, state);
		const outcome = await store.declareGated(SHIP_ASK);
		assert.equal(outcome.raised, false);
		assert.equal(outcome.gate?.ci, "unreviewed");

		// Ten renders later it is still deferred, still visible, still unasked.
		for (let render = 0; render < 10; render += 1) {
			const review = await store.reviewDeferred();
			assert.deepEqual(review.raised, [], `render ${render} raised an unreviewed head`);
			assert.deepEqual(
				review.stillDeferred.map((item) => item.id),
				[outcome.item.id],
				"deferred is not dropped: the row is listed on every render",
			);
		}
		assert.deepEqual(store.list("open"), []);
		assert.equal(store.list("deferred").length, 1);
		assert.match(store.list("deferred")[0]!.deferred_reason ?? "", /no passing cp_review/);

		// The named actor: the parent runs cp_review, the pass lands on this head,
		// and the very next render raises the row with no operator action.
		state.reviewed = [HEAD];
		const promoted = await store.reviewDeferred();
		assert.deepEqual(
			promoted.raised.map((item) => item.id),
			[outcome.item.id],
		);
	} finally {
		home.cleanup();
	}
});

test("cp-1som: an unreadable CI state never raises, however many renders pass — cp-ci is the recovery", async () => {
	const home = createScratchHome();
	try {
		// `gh` is unreachable on every render. There is no attempt count, no
		// deadline and no bypass: ignorance is not evidence that a head is mergeable.
		const store = new AwaitingStore({
			home: home.path,
			mergeAsk: createMergeAskProbe({
				head: async () => ({ sha: HEAD }),
				runs: async () => {
					throw new Error("gh: 403 rate limited");
				},
			}),
		});
		const outcome = await store.declareGated(SHIP_ASK);
		assert.equal(outcome.raised, false);
		assert.equal(outcome.gate?.ci, "unknown");
		for (let render = 0; render < 10; render += 1) {
			const review = await store.reviewDeferred();
			assert.deepEqual(review.raised, [], `render ${render} raised on an unreadable CI state`);
			assert.equal(review.verdicts.get(outcome.item.id)!.ci, "unknown");
		}
		assert.deepEqual(store.list("open"), [], "no escape hatch, at any age");

		// The recovery is a fact arriving, not a timeout expiring: the `cp-ci` watch
		// observes the run for this head, the wake-up causes a parent turn, and that
		// turn's render is what raises the row.
		const readable = storeWithGate(home.path, { head: HEAD, runs: [run()], reviewed: [HEAD] });
		const raised = await readable.reviewDeferred();
		assert.deepEqual(
			raised.raised.map((item) => item.id),
			[outcome.item.id],
		);
	} finally {
		home.cleanup();
	}
});

test("cp-1som: a gap in the review-<n> numbering does not hide a later pass", async () => {
	const home = createScratchHome();
	try {
		// review-1.json is missing (hand-pruned, a partial restore, a failed write)
		// and review-2.json is the pass on the current head. Counting up and
		// stopping at the first gap would drop it and defer a ready merge ask.
		writeReviewVerdict(home.path, "cp-gap", 2, { verdict: "pass", head_sha: HEAD });
		assert.deepEqual(readReviewPassHeads(home.path, "cp-gap"), [HEAD]);

		// And the gate agrees: the ask is raised on a head whose only pass is in a
		// non-contiguous slot.
		const store = new AwaitingStore({
			home: home.path,
			mergeAsk: createMergeAskProbe({
				head: async () => ({ sha: HEAD }),
				runs: async () => [run()],
				reviewedHeads: (jobId) => readReviewPassHeads(home.path, jobId),
			}),
		});
		const outcome = await store.declareGated({ ...SHIP_ASK, job_id: "cp-gap", decision: "Ship cp-gap (PR 121), drop it, or open a follow-up?" });
		assert.equal(outcome.raised, true);
		assert.equal(outcome.gate?.ci, "green");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// cp-1som, review attempt 2: the reader reads the writer's store, and a row
// nothing could ever release is never stored.
// ---------------------------------------------------------------------------

/**
 * Write a review verdict the way `cp_review` does: a full `DiffVerdict`,
 * validated against `DiffVerdictSchema` (the writer, `DiffReview.#persist`,
 * refuses to write one that is not) at `paths.reviewFile` (the same path
 * function the writer joins onto the home). So this helper cannot drift from
 * the writer without the schema or the compiler saying so.
 */
function writeReviewVerdict(
	home: string,
	jobId: string,
	attempt: number,
	fields: { verdict: "pass" | "revise" | "escalate"; head_sha: string; truncated?: boolean },
): DiffVerdict {
	const verdict: DiffVerdict = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		attempt,
		verdict: fields.verdict,
		cause: fields.verdict === "pass" ? null : "policy",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["the diff does what the brief asked"],
		decided_at: "2026-09-05T10:30:21Z",
		head_sha: fields.head_sha,
		diff_stat: { files: 3, truncated: fields.truncated ?? false },
	} as DiffVerdict;
	const validated = validate<DiffVerdict>(DiffVerdictSchema, verdict);
	assert.ok(validated.ok, `the fixture must be what cp_review writes: ${validated.ok ? "" : validated.errors.join("; ")}`);
	writeRawReviewFile(home, jobId, attempt, JSON.stringify(verdict));
	return verdict;
}

test("a historical pass on a truncated subject is no pass: not direct, not by equivalence, not for the merge ask", () => {
	const home = createScratchHome();
	try {
		const old = writeReviewVerdict(home.path, "cp-partial", 1, { verdict: "pass", head_sha: HEAD, truncated: true });
		const equivalent = join(home.path, paths.reviewEquivalenceFile("cp-partial", OLD));
		writeFileSync(equivalent, JSON.stringify({ ...old, head_sha: OLD, equivalent_to: { head_sha: HEAD, attempt: 1 } }));
		assert.equal(readReviewPassVerdict(home.path, "cp-partial", HEAD), undefined, "omitted hunks were never reviewed");
		assert.equal(readReviewPassVerdict(home.path, "cp-partial", OLD), undefined, "equivalence to a partial pass is no pass");
		assert.deepEqual(readReviewPassHeads(home.path, "cp-partial"), [], "the merge ask stays deferred");
		writeReviewVerdict(home.path, "cp-partial", 2, { verdict: "pass", head_sha: HEAD });
		assert.equal(readReviewPassVerdict(home.path, "cp-partial", HEAD)?.attempt, 2, "a complete pass on the same head still counts");
	} finally {
		home.cleanup();
	}
});

/** The same path, with an arbitrary body: for the unreadable/invalid cases. */
function writeRawReviewFile(home: string, jobId: string, attempt: number, body: string): void {
	const file = join(home, paths.reviewFile(jobId, attempt));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body);
}

test("cp-1som: the gate reads the store cp_review writes — same path function, same schema, same field names", () => {
	const home = createScratchHome();
	try {
		// The two fields this gate depends on are the writer's own contract, not a
		// shape invented here: if `verdict` or `head_sha` were renamed in
		// DiffVerdictSchema, the fixture below would stop validating and this test
		// would fail rather than every merge ask silently deferring forever.
		const properties = Object.keys((DiffVerdictSchema as unknown as { properties: Record<string, unknown> }).properties);
		assert.ok(properties.includes("verdict"), "DiffVerdictSchema still names the verdict field `verdict`");
		assert.ok(properties.includes("head_sha"), "DiffVerdictSchema still names the reviewed commit `head_sha`");

		const written = writeReviewVerdict(home.path, "cp-dlw7", 1, { verdict: "pass", head_sha: HEAD });
		assert.deepEqual(readReviewPassHeads(home.path, "cp-dlw7"), [written.head_sha]);

		// And it is genuinely the writer's path: what `paths.reviewFile` names is
		// what the reader looked at.
		assert.equal(paths.reviewFile("cp-dlw7", 1), ".pi-command-post/state/runs/cp-dlw7/review-1.json");
	} finally {
		home.cleanup();
	}
});

test("cp-1som: a merge/ship ask with no job_id is refused, never stored as a deferred zombie", async () => {
	const home = createScratchHome();
	try {
		// Nothing could ever release such a row: the head, the CI runs and the
		// review pass are all resolved through the job's fleet record, and the
		// cp-ci watch iterates fleet records too.
		const store = storeWithGate(home.path, { head: HEAD, runs: [run()], reviewed: [HEAD] });
		for (const decision of ["Merge PR #119?", "Ship cp-dlw7 (PR 119), drop it, or open a follow-up?"]) {
			await assert.rejects(
				() => store.declare({ type: "approval", decision, why: "green", blocks: "delivery" }),
				(error: Error) => {
					assert.equal(error.message, MERGE_ASK_NEEDS_JOB_REFUSAL);
					assert.match(error.message, /job_id/, "the refusal names the fix");
					return true;
				},
			);
		}
		assert.deepEqual(store.read().items, [], "refused before any write: no row, no zombie to withdraw");

		// The refusal is a *notice* on the render path, not a thrown status block.
		const resolved = await resolveAwaitingRows(
			[{ type: "approval", decision: "Merge PR #119?", why: "green", blocks: "delivery" }],
			store,
		);
		assert.deepEqual(resolved.rendered, []);
		assert.deepEqual(resolved.mergeAsks, [], "not deferred either — it was never stored");
		assert.equal(resolved.refused.length, 1);
		assert.equal(resolved.refused[0]!.reason, MERGE_ASK_NEEDS_JOB_REFUSAL);

		// Not a hole in the gate: the same row WITH its job is still governed by CI
		// and the review, and a decision that is not about merging is unaffected.
		const unready = storeWithGate(home.path, { head: HEAD, runs: [run({ status: "in_progress", conclusion: null })], reviewed: [HEAD] });
		const deferred = await unready.declareGated({ ...SHIP_ASK, job_id: "cp-dlw7" });
		assert.equal(deferred.raised, false);
		assert.equal(deferred.gate?.ci, "in_progress");
		const design = await store.declare({ type: "design", decision: "Postgres or sqlite?", why: "schema", blocks: "cp-db" });
		assert.equal(design.state, "open", "a job-less row that is not a merge ask is untouched");
	} finally {
		home.cleanup();
	}
});
