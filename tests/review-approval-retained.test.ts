import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths } from "../src/contracts.ts";
import { ReviewApprovalStore, sha256File } from "../src/review-approval.ts";
import { createScratchHome } from "./harness/index.ts";

test("review approval: written once per seq, pinned to the artifact hash, and only a byte-identical file matches", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const artifact = join(home.path, LAYOUT.artifacts, "cp-r1/report.md");
	mkdirSync(join(home.path, LAYOUT.artifacts, "cp-r1"), { recursive: true });
	writeFileSync(artifact, "# Goal\nCache.\n");
	const store = new ReviewApprovalStore(home.path);

	assert.equal(store.read("cp-r1"), undefined);
	assert.equal(store.matches("cp-r1", artifact), false, "no approval, no match");

	const written = store.write({ jobId: "cp-r1", questionSeq: 2, artifactPath: artifact, by: "operator console", at: "2026-09-13T10:00:00Z" });
	assert.equal(written.artifact_sha256, sha256File(artifact));
	assert.equal(store.file("cp-r1"), join(home.path, paths.reviewApproval("cp-r1")));
	assert.deepEqual(store.read("cp-r1"), written);
	assert.equal(store.matches("cp-r1", artifact), true);

	writeFileSync(artifact, "# Goal\nCache, but differently.\n");
	assert.equal(store.matches("cp-r1", artifact), false, "an edited plan is not the approved plan");
	assert.equal(store.matches("cp-r1", join(home.path, "missing.md")), false, "a missing file never matches");

	// A later review round overwrites: the newest approval is the one that counts.
	const again = store.write({ jobId: "cp-r1", questionSeq: 3, artifactPath: artifact, by: "operator console" });
	assert.equal(again.question_seq, 3);
	assert.equal(store.matches("cp-r1", artifact), true);
});
