import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { paths, REVIEW_MERGE_WINDOW_MS } from "../src/contracts.ts";
import { readReviewMergeWindow } from "../src/review-merge-window.ts";
import { createScratchHome } from "./harness/index.ts";
import { writeWindowPass } from "./harness/review-window.ts";

const HEAD = "a".repeat(40), OTHER = "b".repeat(40), AT = "2026-10-07T10:00:00Z";
test("a complete pass owns a fixed deadline: before/at boundary, replay and restart, head change", (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	assert.equal(readReviewMergeWindow(home.path, "cp-window", HEAD, new Date(AT)), undefined);
	writeWindowPass(home.path, "cp-window", HEAD, AT);
	const file = join(home.path, paths.reviewFile("cp-window", 1));
	const original = readFileSync(file, "utf8");
	const now = new Date(Date.parse(AT) + REVIEW_MERGE_WINDOW_MS - 1);
	const window = readReviewMergeWindow(home.path, "cp-window", HEAD, now);
	assert.equal(window?.review_resume_at, "2026-10-07T10:00:30.000Z");
	assert.deepEqual(readReviewMergeWindow(home.path, "cp-window", HEAD, now), window, "fresh reads use the original durable time");
	assert.equal(readReviewMergeWindow(home.path, "cp-window", OTHER, now), undefined);
	assert.equal(readReviewMergeWindow(home.path, "cp-window", HEAD, new Date(now.getTime() + 1)), undefined);
	assert.equal(readReviewMergeWindow(home.path, "cp-window", HEAD, new Date(now.getTime() + 60_000)), undefined);
	assert.equal(readFileSync(file, "utf8"), original);
	writeWindowPass(home.path, "cp-window", OTHER, "2026-10-07T10:01:00Z", { equivalent_to: { head_sha: HEAD, attempt: 1 } });
	assert.equal(readReviewMergeWindow(home.path, "cp-window", OTHER, new Date("2026-10-07T10:01:01Z"))?.review_resume_at, "2026-10-07T10:01:30.000Z");
});

test("incomplete, malformed and mismatched equivalence evidence cannot arm a window", (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	writeWindowPass(home.path, "cp-window", HEAD, AT, { diff_stat: { files: 1, truncated: true } });
	assert.equal(readReviewMergeWindow(home.path, "cp-window", HEAD, new Date(AT)), undefined);
	const file = join(home.path, paths.reviewFile("cp-window", 1));
	for (const text of ["{", JSON.stringify({ verdict: "pass" })]) {
		writeFileSync(file, text);
		assert.equal(readReviewMergeWindow(home.path, "cp-window", HEAD, new Date(AT)), undefined);
	}
	const equivalent = join(home.path, paths.reviewEquivalenceFile("cp-window", HEAD));
	mkdirSync(dirname(equivalent), { recursive: true });
	const wrong = writeWindowPass(home.path, "cp-window", OTHER, AT, { equivalent_to: { head_sha: HEAD, attempt: 1 } });
	writeFileSync(equivalent, JSON.stringify(wrong));
	assert.equal(readReviewMergeWindow(home.path, "cp-window", HEAD, new Date(AT)), undefined);
});
