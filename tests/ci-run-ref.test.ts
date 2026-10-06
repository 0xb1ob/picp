/**
 * picp-wzq Part B: the failing run named by a red CI fact — the same not-green rule the merge
 * ask refuses on, and a run URL derived from the PR URL.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ciRunRef, failedRunOn, formatRunRef, runUrl } from "../src/ci-run-ref.ts";
import type { CiRun } from "../src/merge-ask.ts";

const HEAD = "d48a81d1f4d3aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0123456789abbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("failedRunOn skips green conclusions, unfinished runs and runs on other heads", () => {
	const runs: CiRun[] = [
		{ status: "completed", conclusion: "failure", headSha: OTHER, databaseId: 1, workflowName: "other-head" },
		{ status: "completed", conclusion: "skipped", headSha: HEAD, databaseId: 2, workflowName: "lint" },
		{ status: "completed", conclusion: "neutral", headSha: HEAD, databaseId: 3 },
		{ status: "completed", conclusion: "success", headSha: HEAD, databaseId: 4 },
		{ status: "in_progress", conclusion: null, headSha: HEAD, databaseId: 5 },
		{ status: "completed", conclusion: "failure", headSha: HEAD, databaseId: 6, workflowName: "ci" },
	];
	assert.equal(failedRunOn(runs, HEAD)?.databaseId, 6);
	assert.equal(failedRunOn(runs.slice(0, 5), HEAD), undefined);
	assert.equal(failedRunOn(runs, undefined), undefined);
});

test("runUrl derives the Actions URL from a github.com PR URL, and nothing from any other shape", () => {
	assert.equal(runUrl("https://github.com/o/r/pull/61", 9), "https://github.com/o/r/actions/runs/9");
	assert.equal(runUrl("https://ghe.example.com/o/r/pull/61", 9), undefined);
	assert.equal(runUrl("cp-branch", 9), undefined);
	assert.equal(runUrl(undefined, 9), undefined);
});

test("ciRunRef names the failing run only when it has an id; formatRunRef renders it", () => {
	const failing: CiRun = { status: "completed", conclusion: "failure", headSha: HEAD, databaseId: 37458827243 };
	const ref = ciRunRef([failing], HEAD, "https://github.com/o/r/pull/61");
	assert.deepEqual(ref, { run_id: 37458827243, run_url: "https://github.com/o/r/actions/runs/37458827243" });
	assert.equal(formatRunRef(ref), " (run 37458827243 https://github.com/o/r/actions/runs/37458827243)");
	assert.deepEqual(ciRunRef([failing], HEAD, "https://ghe.example.com/o/r/pull/61"), { run_id: 37458827243 });
	assert.equal(formatRunRef({ run_id: 5 }), " (run 5)");
	const { databaseId: _, ...legacy } = failing;
	assert.deepEqual(ciRunRef([legacy], HEAD, "https://github.com/o/r/pull/61"), {});
	assert.equal(formatRunRef({}), "");
});
