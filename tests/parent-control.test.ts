import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { existingSavedSession, parentControlFile, recordSpawnedSession } from "../src/parent-control.ts";

function scratch(t: { after: (fn: () => void) => void }): string {
	const home = mkdtempSync(join(tmpdir(), "cp-parent-control-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

test("a saved session path whose file is gone is not returned, and one log line names it", (t) => {
	const home = scratch(t);
	const lines: string[] = [];
	const missing = join(home, "cp-parent-gone.jsonl");
	assert.equal(existingSavedSession(missing, (line) => lines.push(line)), undefined);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.includes(`${missing} is missing`), lines[0]);
	const present = join(home, "cp-parent.jsonl");
	writeFileSync(present, "");
	assert.equal(existingSavedSession(present, (line) => lines.push(line)), present);
	assert.equal(existingSavedSession(undefined, (line) => lines.push(line)), undefined);
	assert.equal(lines.length, 1, "an existing or absent saved path logs nothing");
});

test("a getState path that differs from the spawned one is what gets written", (t) => {
	const home = scratch(t);
	const spawned = join(home, "cp-parent.jsonl");
	recordSpawnedSession(home, spawned, spawned, "p/m");
	recordSpawnedSession(home, spawned, undefined, "p/m");
	recordSpawnedSession(home, spawned, "", "p/m");
	assert.equal(existsSync(parentControlFile(home)), false, "same, missing or empty reported path writes nothing");
	const reported = join(home, "2026-10-04_01a1054b.jsonl");
	recordSpawnedSession(home, spawned, reported, "p/m");
	assert.deepEqual(JSON.parse(readFileSync(parentControlFile(home), "utf8")), { sessionFile: reported, model: "p/m" });
});

test("a control write that fails is logged, never thrown into the spawn", (t) => {
	const home = scratch(t);
	// A home that is a regular file: the control write cannot create its directory.
	writeFileSync(join(home, "blocker"), "");
	const lines: string[] = [];
	recordSpawnedSession(join(home, "blocker"), "a.jsonl", "b.jsonl", "p/m", (line) => lines.push(line));
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /parent control write failed for b\.jsonl/);
});
