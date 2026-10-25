/** P9 retained: parent-control units no entry point reaches (bridge start spawns with --session and refuses a
 * corrupt record first, src/cp-bridge.ts:317); moved verbatim from tests/parent-control.test.ts. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { parentControlFile, recordSpawnedSession } from "../src/parent-control.ts";

function scratch(t: { after: (fn: () => void) => void }): string {
	const home = mkdtempSync(join(tmpdir(), "cp-parent-control-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

test("an existing reported path is written, the spawned one too; an empty or absent report never replaces the record", (t) => {
	const home = scratch(t);
	const lines: string[] = [];
	const log = (line: string) => lines.push(line);
	const spawned = join(home, "cp-parent.jsonl");
	recordSpawnedSession(home, undefined, "p/m", log);
	recordSpawnedSession(home, "", "p/m", log);
	recordSpawnedSession(home, spawned, "p/m", log);
	assert.equal(existsSync(parentControlFile(home)), false, "empty, non-string or not-on-disk reported path writes nothing");
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.includes(`${spawned} is not on disk`), lines[0]);
	const reported = join(home, "2026-10-04_01a1054b.jsonl");
	writeFileSync(reported, "");
	recordSpawnedSession(home, reported, "p/m", log);
	assert.deepEqual(JSON.parse(readFileSync(parentControlFile(home), "utf8")), { sessionFile: reported, model: "p/m" });
	recordSpawnedSession(home, join(home, "gone.jsonl"), "p/m", log);
	recordSpawnedSession(home, "", "p/m", log);
	assert.deepEqual(JSON.parse(readFileSync(parentControlFile(home), "utf8")), { sessionFile: reported, model: "p/m" }, "a missing or empty report keeps the old record");
});


test("a corrupt control file is logged and still rewritten with the reported path", (t) => {
	const home = scratch(t);
	mkdirSync(join(home, LAYOUT.sessions), { recursive: true });
	writeFileSync(parentControlFile(home), '{"sessionFile": "/gone.js');
	const reported = join(home, "cp-parent.jsonl");
	writeFileSync(reported, "");
	const lines: string[] = [];
	recordSpawnedSession(home, reported, "p/m", (line) => lines.push(line));
	assert.deepEqual(JSON.parse(readFileSync(parentControlFile(home), "utf8")), { sessionFile: reported, model: "p/m" });
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /parent control .* unreadable .*; rewriting it for/);
});
