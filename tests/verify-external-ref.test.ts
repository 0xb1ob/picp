/**
 * `verifyExternalRef` — read-only facts, no policy (pi-command-post-autonomy-programme-cur.4.5).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeRefMismatch, describeRefVerification, verifyExternalRef } from "../src/verify-external-ref.ts";

test("github issue url: open issue verifies clean, no mismatch", async () => {
	const verification = await verifyExternalRef("https://github.com/o/r/issues/12", {
		exec: async () => JSON.stringify({ title: "fix the thing", state: "open" }),
	});
	assert.deepEqual(verification, { status: "found", kind: "issue", state: "open", title: "fix the thing", url: "https://github.com/o/r/issues/12" });
	assert.equal(describeRefMismatch("https://github.com/o/r/issues/12", verification), undefined);
});

test("github issue url that is actually a merged PR: wrong kind, mismatch", async () => {
	const verification = await verifyExternalRef("https://github.com/o/r/issues/12", {
		exec: async () => JSON.stringify({ title: "landed work", state: "closed", pull_request: { merged_at: "2026-09-01T00:00:00Z" } }),
	});
	assert.equal(verification.status, "found");
	assert.equal((verification as { kind: string }).kind, "pr");
	assert.equal((verification as { state: string }).state, "merged");
	const mismatch = describeRefMismatch("https://github.com/o/r/issues/12", verification);
	assert.match(mismatch ?? "", /pr/);
	assert.match(mismatch ?? "", /merged/);
	assert.match(mismatch ?? "", /landed work/);
});

test("github 404: not found, mismatch", async () => {
	const verification = await verifyExternalRef("https://github.com/o/r/issues/999", {
		exec: async () => {
			throw new Error("gh api repos/o/r/issues/999 failed: gh: Not Found (HTTP 404: Not Found)");
		},
	});
	assert.deepEqual(verification, { status: "not_found", url: "https://github.com/o/r/issues/999" });
	assert.match(describeRefMismatch("https://github.com/o/r/issues/999", verification) ?? "", /404|resolve/);
});

test("gh unreachable: note-worthy, never a mismatch", async () => {
	const verification = await verifyExternalRef("https://github.com/o/r/issues/12", {
		exec: async () => {
			throw new Error("gh api repos/o/r/issues/12 failed: connect ETIMEDOUT");
		},
	});
	assert.equal(verification.status, "unreachable");
	assert.equal(describeRefMismatch("https://github.com/o/r/issues/12", verification), undefined);
	assert.match(describeRefVerification(verification), /could not be verified/);
});

test("br show ref: closed status is a mismatch; open is not", async () => {
	const closed = await verifyExternalRef("br show cp-abcd --json", {
		exec: async () => JSON.stringify({ status: "closed", title: "ship it" }),
	});
	assert.equal(closed.status, "found");
	assert.match(describeRefMismatch("br show cp-abcd --json", closed) ?? "", /closed/);

	const open = await verifyExternalRef("br show cp-abcd --json", {
		exec: async () => JSON.stringify({ status: "open", title: "ship it" }),
	});
	assert.equal(describeRefMismatch("br show cp-abcd --json", open), undefined);
});

test("br --db pinned ref: the db path is unquoted and passed through as one arg", async () => {
	let seenArgs: readonly string[] = [];
	await verifyExternalRef(`br --db '/abs/path with space/.beads/beads.db' show cp-abcd --json`, {
		exec: async (_command, args) => {
			seenArgs = args;
			return JSON.stringify({ status: "open", title: "t" });
		},
	});
	assert.deepEqual(seenArgs, ["--db", "/abs/path with space/.beads/beads.db", "--no-auto-flush", "--no-auto-import", "show", "cp-abcd", "--json"]);
});

test("bare file path: missing is a mismatch, existing is not", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "verify-ref-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "notes.md");
	writeFileSync(file, "hi");

	const missing = await verifyExternalRef(join(dir, "missing.md"));
	assert.equal(missing.status, "not_found");
	assert.ok(describeRefMismatch(join(dir, "missing.md"), missing));

	const exists = await verifyExternalRef(file);
	assert.deepEqual(exists, { status: "found", kind: "file", state: "exists", url: file });
	assert.equal(describeRefMismatch(file, exists), undefined);
});

test("anything else is unverifiable, never a mismatch", async () => {
	const verification = await verifyExternalRef("https://jira.example.com/BROWSE-1");
	assert.deepEqual(verification, { status: "unverifiable" });
	assert.equal(describeRefMismatch("https://jira.example.com/BROWSE-1", verification), undefined);
});

test("br arrays preserve open and closed states; malformed responses stay diagnostic", async () => {
	for (const state of ["open", "closed"]) {
		const ref = "br show cp-array --json";
		const result = await verifyExternalRef(ref, { exec: async () => JSON.stringify([{ status: state, title: "Array bead" }]) });
		assert.equal(result.status, "found");
		assert.equal(Boolean(describeRefMismatch(ref, result)), state === "closed");
	}
	for (const raw of ["null", "[]", "[null]", "{}", "not JSON"]) {
		const result = await verifyExternalRef("br show cp-array --json", { exec: async () => raw });
		assert.equal(result.status, "unreachable");
		assert.match(describeRefVerification(result), /br show/);
	}
});
