/**
 * The operator session record (cp-sessions-operator-transcript-9giu): what the
 * cp-bridge appends and what the viewer then lists. Append-only, deduped on the
 * newest entry, junk-tolerant.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordOperatorSession } from "../src/operator-session-log.ts";
import { operatorSessionsFile, readOperatorSessions } from "../src/viewer/operator-sessions.ts";

test("the operator session record keeps one line per file, newest first, and skips junk", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cp-operator-sessions-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const lines = () => readFileSync(operatorSessionsFile(dir), "utf8").split("\n").filter(Boolean);

	assert.deepEqual(readOperatorSessions(dir), [], "no record yet is an empty list, never a crash");
	recordOperatorSession(dir, undefined);
	recordOperatorSession(dir, "relative.jsonl");
	recordOperatorSession(dir, "/home/op/notes.txt");
	assert.equal(existsSync(operatorSessionsFile(dir)), false, "only an absolute .jsonl path is recorded");

	recordOperatorSession(dir, "/home/op/one.jsonl", new Date("2026-09-26T10:00:00Z"));
	recordOperatorSession(dir, "/home/op/one.jsonl", new Date("2026-09-26T11:00:00Z"));
	assert.equal(lines().length, 1, "the file already recorded newest is not appended twice");
	recordOperatorSession(dir, "/home/op/two.jsonl", new Date("2026-09-27T10:00:00Z"));
	assert.deepEqual(readOperatorSessions(dir).map((row) => [row.id, row.at]), [
		["two.jsonl", "2026-09-27T10:00:00.000Z"],
		["one.jsonl", "2026-09-26T10:00:00.000Z"],
	], "newest first, id is the basename the viewer links by");

	// A hand-edited or half-written line is skipped; the good rows still read.
	appendFileSync(operatorSessionsFile(dir), "not json\n{\"at\":\"2026-09-28T00:00:00Z\",\"session_file\":\"/etc/passwd\"}\n{\"session_file\":\"/home/op/three.jsonl\"}\n{\"at\":\"2026-09-25T10:00:00Z\",\"session_file\":\"/home/op/three.jsonl\"}\n");
	assert.deepEqual(readOperatorSessions(dir).map((row) => row.id), ["two.jsonl", "one.jsonl", "three.jsonl"], "a rejected line and a time-less line are skipped, not fatal");
	assert.deepEqual(readOperatorSessions(dir).map((row) => row.file), ["/home/op/two.jsonl", "/home/op/one.jsonl", "/home/op/three.jsonl"], "and every row carries the full path to read");
	assert.equal(lines().length, 6, "the reader never rewrites the record");
});
