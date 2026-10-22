import assert from "node:assert/strict";
import { test } from "node:test";
import { AwaitingStore, MergeAskDeferredError } from "../src/awaiting.ts";
import { type CiRun, createMergeAskProbe, evaluateAlreadyMerged, isJobGoneError, MergeAskJobGoneError, type MergeAskMergedEvidence, parseCiRuns } from "../src/merge-ask.ts";
import { createScratchHome } from "./harness/index.ts";
import { resolvedMergeAskRows } from "../src/status-block.ts";
import { DiffVerdictSchema, paths } from "../src/contracts.ts";

const HEAD = "8c7d0141f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";

function run(overrides: Partial<CiRun> = {}): CiRun {
	return { status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci", ...overrides };
}

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

// These helper contracts have no consumer entry point; see the S12/S13 retained rows.
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

test("cp-to39: the job-gone cause is structural, not an error message or a single class identity", () => {
	assert.equal(isJobGoneError(new MergeAskJobGoneError("cp-x")), true);
	assert.equal(isJobGoneError({ mergeAskJobGone: true, message: "from another module instance" }), true);
	assert.equal(isJobGoneError(new Error("no fleet record for cp-x")), false, "never string-matched");
	assert.equal(isJobGoneError(undefined), false);
});


test("S13 retained: declare() reports a resolved merge as already happened", async () => {
	const home = createScratchHome();
	try {
		await assert.rejects(
			() => new AwaitingStore({ home: home.path, mergeAsk: async () => ({ action: "resolved", ci: "already_merged", reason: "PR #59 already merged as abc1234" }) }).declare({ ...MERGE_ASK, decision: "Merge PR #59 for cp-other?", job_id: "cp-other" }),
			(error: Error) => error instanceof MergeAskDeferredError && /already happened/.test(error.message),
		);
	} finally { home.cleanup(); }
});

test("S13 retained: resolved notice fallback when a caller supplies no verdict", () => {
	assert.equal(
		resolvedMergeAskRows([{ id: "aw-1", decision: "Merge PR #58?" }])[0]!.reason,
		"the merge already happened",
	);
});

test("S13 retained: review writer schema and exact path contract", () => {
	const properties = Object.keys((DiffVerdictSchema as unknown as { properties: Record<string, unknown> }).properties);
	assert.ok(properties.includes("verdict"), "DiffVerdictSchema still names the verdict field `verdict`");
	assert.ok(properties.includes("head_sha"), "DiffVerdictSchema still names the reviewed commit `head_sha`");
	assert.equal(paths.reviewFile("cp-dlw7", 1), ".pi-command-post/state/runs/cp-dlw7/review-1.json");
});


test("S13 retained: structural helper rejects a blank merge commit", () => {
	const MERGE_COMMIT = "1f2e3d4c5b6a79880123456789abcdef01234567";
	function evidence(overrides: Partial<MergeAskMergedEvidence> = {}): MergeAskMergedEvidence {
		return { merge_commit_sha: MERGE_COMMIT, pr_number: 58, pr_url: "https://github.com/o/r/pull/58", head_sha: HEAD, ...overrides };
	}
	assert.equal(
		evaluateAlreadyMerged({ jobId: "cp-x", evidence: evidence({ merge_commit_sha: "   " }) }),
		undefined,
		"a receipt with no merge commit proves nothing",
	);
});
