import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiffVerdict, DiffVerdictSchema, isoTimestamp, SCHEMA_VERSION, validate } from "../src/contracts.ts";
import type { DiffReviewResult } from "../src/diff-review.ts";
import { diffReviewToolPayload } from "../extensions/command-post/index.ts";

const HEAD = "b".repeat(40);
function verdictOf(overrides: Partial<DiffVerdict> = {}): DiffVerdict {
	return {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-review-payload",
		attempt: 1,
		verdict: "pass",
		cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["scoped to the brief", "tests cover the new branch"],
		decided_at: isoTimestamp(new Date("2026-01-01T00:00:00Z")),
		head_sha: HEAD,
		diff_stat: { files: 2, truncated: false },
		...overrides,
	};
}
function resultOf(overrides: Partial<DiffReviewResult> = {}): DiffReviewResult {
	return {
		verdict: verdictOf(),
		next: "proceed",
		path: `state/runs/cp-review-payload/${"review-1.json"}`,
		model: "anthropic/claude-opus-5",
		diff: {
			path: "/tmp/home/state/runs/cp-review-payload/review-1/review/diff.md",
			base: "main",
			branch: "cp-review-payload",
			head_sha: HEAD,
			files: 2,
			truncated: false,
			omitted: [],
		},
		...overrides,
	};
}

test("details.verdict round-trips through validate<DiffVerdict>(DiffVerdictSchema, …)", () => {
	const payload = diffReviewToolPayload(resultOf());
	const roundTrip = validate<DiffVerdict>(DiffVerdictSchema, payload.details.verdict);
	assert.ok(roundTrip.ok, roundTrip.ok ? "" : roundTrip.errors.join("; "));
	assert.equal(roundTrip.ok && roundTrip.value.head_sha, HEAD);
	assert.equal(payload.details.next, "proceed");
	assert.equal(validate(DiffVerdictSchema, { ...verdictOf(), next: "proceed" }).ok, false);
});

test("a verdict that does not satisfy the schema is refused by the tool, not shipped as details", () => {
	const broken = resultOf({ verdict: { ...verdictOf(), diff_stat: { files: -1, truncated: false } } });
	assert.throws(
		() => diffReviewToolPayload(broken),
		(error: Error) => {
			assert.match(error.message, /cp_review/);
			assert.match(error.message, /DiffVerdictSchema/);
			return true;
		},
	);
});

test("no diff text, and no path to it, travels in content or details", () => {
	const hunk = "@@ -1,3 +1,4 @@\n+const SECRET_FROM_THE_DIFF = 1;";
	const result = resultOf({
		verdict: verdictOf({ verdict: "revise", cause: null, reasons: ["one file lacks a test"], revisions: ["add it"] }),
		next: "revise",
		revise_receipt: "delivered",
		review: {
			job_id: "cp-review-payload",
			verdict: "revise",
			flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
			reasons: [`the hunk reads ${hunk}`],
			revisions: ["add it"],
		},
	});
	const payload = diffReviewToolPayload(result);
	const serialized = JSON.stringify(payload);
	assert.ok(!serialized.includes(hunk), "diff text reached the tool's payload");
	assert.ok(!serialized.includes("SECRET_FROM_THE_DIFF"), "a fragment of the diff reached the tool's payload");
	assert.ok(
		!serialized.includes(result.diff?.path as string),
		"the materialized diff's path travelled — Stage E's guard blocks reading it, so nothing should hand it over",
	);
	assert.ok(!serialized.includes("diff.md"), "the payload names the diff file");
	assert.match(payload.content[0]?.text as string, /attempt 1: revise/);
	assert.equal(payload.details.review_file, result.path);
	assert.equal(payload.details.revise_receipt, "delivered");
	assert.equal((payload.details.subject as { files: number }).files, 2);
	assert.equal(payload.details.review, undefined, "the uncapped observation is not part of the interface");
});
