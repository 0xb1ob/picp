/**
 * P23: the declarations of tests/memory.test.ts kept verbatim (V2). Each one needs a fault or a pure helper no parent
 * entry point reaches; tests/e2e/memory.test.ts holds the rest. docs/testing-migration/p23.md names the function per row.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import {
	archiveEntry,
	captureCandidate,
	ensureMemoryScaffold,
	formatMemoryStatus,
	memoryStatus,
	readMemoryFile,
	sessionStartDigest,
} from "../src/memory.ts";
import { memoryArgumentCompletions } from "../extensions/command-post/index.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const AT = new Date("2026-08-27T12:00:00Z");

function learningsPath(home: string): string {
	return join(home, LAYOUT.learningsFile);
}

function writeLearnings(home: string, entries: readonly string[]): void {
	ensureMemoryScaffold(home);
	const header = readFileSync(learningsPath(home), "utf8");
	writeFileSync(learningsPath(home), `${header}\n${entries.join("\n")}\n`);
}

const CRASH_FIXTURE = join(REPO_ROOT, "tests/fixtures/memory-crash.mjs");

/** Staging files left by a crashed write. Litter is allowed; loss is not. */
function stagingFiles(home: string): string[] {
	const dir = dirname(join(home, LAYOUT.learningsFile));
	return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function crash(home: string, op: "archive" | "capture", point: "write" | "rename", nth: number, line?: string) {
	const result = spawnSync(process.execPath, [CRASH_FIXTURE, home, op, point, String(nth), ...(line ? [line] : [])], {
		encoding: "utf8",
	});
	assert.equal(
		result.signal,
		"SIGKILL",
		`the fixture must die at the injected syscall, not finish (stdout: ${result.stdout}, stderr: ${result.stderr})`,
	);
	return result;
}

test("status on an unscaffolded home is empty, not an error", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const status = memoryStatus(home.path, AT);
	assert.deepEqual(status.present, { learnings: false, candidates: false, archive: false });
	assert.equal(status.lines, 0);
	assert.equal(status.over_budget, false);
	assert.match(formatMemoryStatus(status), /not scaffolded yet/);
	assert.equal(sessionStartDigest(home.path, AT), undefined, "a fresh home does not announce that it has no memory");
});

test("a process killed inside archiveEntry's learnings write leaves the file whole, not empty (cp-nqj)", (t) => {
	// The reachable total-loss path this fix closes. `writeFileSync` opens
	// `O_TRUNC`: the file was zero bytes between the open and the write, so a
	// kill in that window destroyed every curated learning — the whole file, not
	// a line of it. The crash is real (SIGKILL, in a child process) and the code
	// under test is the shipped `archiveEntry`, not a mock of it.
	//
	// Note what the pre-fix code could not have passed: there was no instant to
	// inject at. `writeFileSync` truncates and writes inside one opaque call, so
	// every point a crash could land between "file intact" and "file written"
	// left it empty. Having a crash point that is safe *is* the fix.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const keep = "- 2026-08-01 keep me; evidence: a. <!--P-->";
	const drop = "- 2026-07-01 archive me; evidence: b. <!--p:2026-07-01-->";
	writeLearnings(home.path, [keep, drop]);
	const before = readFileSync(learningsPath(home.path), "utf8");

	// Write 1 is `archive.md` (archiving is a move: provenance first), write 2 is
	// `learnings.md` — the one that used to truncate.
	crash(home.path, "archive", "write", 2, drop);

	assert.equal(
		readFileSync(learningsPath(home.path), "utf8"),
		before,
		"learnings.md must be byte-identical after a crash inside its own write",
	);
	const status = memoryStatus(home.path, AT);
	assert.equal(status.lines, 2, "…and still readable: both entries parse");
	assert.match(readMemoryFile(home.path, "archive") ?? "", /archive me/, "the archive write landed before the crash");

	// A crashed atomic write can leave an empty staging file. That is litter in
	// `data/`, never the live file, and the next write uses a fresh name.
	for (const name of stagingFiles(home.path)) {
		assert.match(name, /\.tmp$/);
		assert.ok(name !== "learnings.md", "the live file is never the staging file");
	}
});

test("a crash between the staging write and the rename leaves the previous learnings intact (cp-nqj)", (t) => {
	// The atomic write's own window: the new content is on disk and fsynced, but
	// not yet visible. A reader — the next session's digest — sees the old file,
	// whole, which is the property `writeFileSync` could not offer at all.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const keep = "- 2026-08-01 keep me; evidence: a. <!--P-->";
	const drop = "- 2026-07-01 archive me; evidence: b. <!--p:2026-07-01-->";
	writeLearnings(home.path, [keep, drop]);
	const before = readFileSync(learningsPath(home.path), "utf8");

	crash(home.path, "archive", "rename", 2, drop);

	assert.equal(readFileSync(learningsPath(home.path), "utf8"), before, "the pre-archive file survives the crash");
	assert.equal(memoryStatus(home.path, AT).lines, 2);
});

test("a process killed inside captureCandidate's write leaves candidates.md whole (cp-nqj)", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	captureCandidate(home.path, "an earlier capture nobody may lose", AT);
	const before = readMemoryFile(home.path, "candidates") ?? "";

	crash(home.path, "capture", "write", 1);

	assert.equal(readMemoryFile(home.path, "candidates"), before, "candidates.md is byte-identical after the crash");
	assert.equal(memoryStatus(home.path, AT).candidates, 1, "…and the earlier capture is still countable");
});

test("no memory write goes through a truncating call, and the learnings write is still an append", () => {
	// The crash tests above prove the window is closed on the code as it stands;
	// this one keeps it closed. `writeFileSync` opens `O_TRUNC` (total loss on a
	// kill) and a read-modify-write of `learnings.md` would trade that tear for
	// lost updates, so both mechanisms are named here rather than left to review.
	const memory = readFileSync(join(REPO_ROOT, "src/memory.ts"), "utf8");
	const curation = readFileSync(join(REPO_ROOT, "src/curation.ts"), "utf8");
	const importsOf = (source: string, module: string) =>
		new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${module}"`).exec(source)?.[1] ?? "";

	for (const [name, source] of [
		["src/memory.ts", memory],
		["src/curation.ts", curation],
	] as const) {
		const imported = importsOf(source, "node:fs");
		assert.ok(
			!/\bwriteFileSync\b/.test(imported),
			`${name} must not import writeFileSync: it opens O_TRUNC, so the file is empty between the open and the write (cp-nqj)`,
		);
	}

	assert.match(memory, /atomicWriteText/, "whole-file memory writes go through the tmp -> fsync -> rename path");
	assert.match(
		curation,
		/durableAppend\(path, after\.slice\(before\.length\)\)/,
		"the learnings write stays an O_APPEND append of exactly the new suffix",
	);
	assert.ok(
		!/atomicWriteText/.test(curation),
		"a read-modify-write of learnings.md loses concurrent writes; the append is the mechanism (cp-nqj)",
	);
});

test("archiving refuses an inexact match, an empty reason, and an unscaffolded home", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.throws(() => archiveEntry(home.path, "- 2026-08-01 anything", { reason: "why" }), /does not exist yet/);

	writeLearnings(home.path, ["- 2026-08-01 exact line; evidence: a. <!--P-->"]);
	assert.throws(
		() => archiveEntry(home.path, "- 2026-08-01 exact line", { reason: "why" }),
		/match the line exactly/,
	);
	assert.throws(
		() => archiveEntry(home.path, "- 2026-08-01 exact line; evidence: a. <!--P-->", { reason: "  " }),
		/needs a reason/,
	);
	assert.equal(memoryStatus(home.path, AT).lines, 1, "a refused archive changes nothing");
});

test("/memory's argument completion never offers a bare 'capture' that would submit an empty lesson", () => {
	// Before cp-kzu: picking "capture" from the dropdown submitted `/memory
	// capture` verbatim, with nothing after it, and errored. The fix completes to
	// "capture " (trailing space) so the cursor waits for the lesson instead.
	const atEmpty = memoryArgumentCompletions("");
	const captureItem = atEmpty?.find((item) => item.label === "capture");
	assert.ok(captureItem, "no 'capture' completion offered at all");
	assert.equal(captureItem?.value, "capture ", "completion value must leave a trailing space, not submit bare 'capture'");

	const atPrefix = memoryArgumentCompletions("cap");
	assert.deepEqual(atPrefix, [{ value: "capture ", label: "capture" }]);

	const atStatusPrefix = memoryArgumentCompletions("stat");
	assert.deepEqual(atStatusPrefix, [{ value: "status", label: "status" }]);

	assert.equal(memoryArgumentCompletions("zzz"), null, "an unmatched prefix offers nothing");
});
