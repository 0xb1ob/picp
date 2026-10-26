/** Retained from awaiting_merge PR1: cross-field validators, kept for CI evidence no surface reads (P18b). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	LAYOUT,
	paths,
	validateAwaitingMergeWatchFile,
	validateCiEvidenceFile,
	validateParkIntent,
	validateStackFollowupsFile,
} from "../src/contracts.ts";

const HEAD = "a".repeat(40);
const AT = "2026-10-15T10:00:00Z";
test("intent, watch, stack and CI evidence records enforce their cross-field rules", () => {
	const intent = { schema_version: 1, job_id: "cp-park", cycle: 1, stage: "intent", pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-park", head_sha: HEAD, base: "main", created_at: AT, updated_at: AT };
	assert.equal(validateParkIntent(intent).ok, true);
	assert.equal(validateParkIntent({ ...intent, stage: "parked" }).ok, false);

	const pr = { job_id: "cp-park", cycle: 1, pr_url: intent.pr_url, state: "open", head_sha: HEAD, base: "main", approvals: 1, approvals_required: null, cursors: { comments: "Y3Vyc29y" }, observed_at: AT };
	const watch = (...prs: unknown[]) => ({ schema_version: 1, updated_at: AT, prs });
	assert.equal(validateAwaitingMergeWatchFile(watch(pr)).ok, true, "unknown required approvals is null, not zero");
	assert.equal(validateAwaitingMergeWatchFile(watch({ ...pr, state: "merged" })).ok, false, "a merge needs its sha");
	assert.equal(validateAwaitingMergeWatchFile(watch({ ...pr, state: "merged", merge_sha: "b".repeat(40) })).ok, true);
	assert.equal(validateAwaitingMergeWatchFile(watch(pr, pr)).ok, false, "one row per job");

	const edge = { parent_job: "cp-park", child_job: "cp-child", repo: "o/r", parent_branch: "cp-park", child_branch: "cp-child", observed_at: AT };
	const action = { id: `cp-park:cp-child:${HEAD}`, parent_job: "cp-park", child_job: "cp-child", repo: "o/r", child_branch: "cp-child", previous_base: "cp-park", target_base: "main", merge_sha: HEAD, queued_at: AT, status: "pending" };
	const stack = (edges: unknown[], actions: unknown[]) => ({ schema_version: 1, updated_at: AT, edges, actions });
	assert.equal(validateStackFollowupsFile(stack([edge], [action])).ok, true);
	assert.equal(validateStackFollowupsFile(stack([{ ...edge, child_job: "cp-park" }], [])).ok, false);
	assert.equal(validateStackFollowupsFile(stack([], [{ ...action, id: "x" }])).ok, false);
	assert.equal(validateStackFollowupsFile(stack([], [{ ...action, status: "done" }])).ok, false, "settled needs settled_at");
	assert.equal(validateStackFollowupsFile(stack([], [action, action])).ok, false);

	const ci = (observation: object) => ({ schema_version: 1, job_id: "cp-park", repo: "o/r", observations: [{ head_sha: HEAD, result: "success", observed_at: AT, ...observation }] });
	assert.equal(validateCiEvidenceFile(ci({ source: "actions" })).ok, true);
	assert.equal(validateCiEvidenceFile(ci({ source: "forwarded" })).ok, false, "forwarded CI needs its operator quote");
	assert.equal(validateCiEvidenceFile(ci({ source: "forwarded", operator_quote: "CI is green on aaaa" })).ok, true);
	assert.equal(validateCiEvidenceFile(ci({ source: "actions", operator_quote: "x" })).ok, false);
	assert.equal(paths.parkIntentFile("cp-park"), `${LAYOUT.runs}/cp-park/park-intent.json`);
	assert.equal(paths.ciEvidenceFile("cp-park"), `${LAYOUT.runs}/cp-park/ci-evidence.json`);
});
