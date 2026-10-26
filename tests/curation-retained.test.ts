/**
 * P23: the declarations of tests/curation.test.ts kept verbatim (V2): a failed learnings write and four concurrent
 * writer processes, neither of which a single parent can inject. tests/e2e/memory.test.ts holds the rest.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { promoteCandidate, readCurationLog, traceLearning } from "../src/curation.ts";
import { captureCandidate, ensureMemoryScaffold, memoryStatus } from "../src/memory.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const AT = new Date("2026-08-27T12:00:00Z");

function learningsPath(home: string): string {
	return join(home, LAYOUT.learningsFile);
}

function seedLearnings(home: string, entries: readonly string[]): void {
	ensureMemoryScaffold(home);
	const header = readFileSync(learningsPath(home), "utf8");
	writeFileSync(learningsPath(home), `${header}\n${entries.join("\n")}\n`);
}

/** Capture a candidate and hand back the exact line, which promote requires. */
function capture(home: string, lesson: string, at: Date = AT): string {
	return captureCandidate(home, lesson, at).line;
}

const EVIDENCE = "cp-t26; PR #39; src/memory.ts";

test("journal-before-file survives a failed learnings write: the record exists, the file is untouched (cp-nqj)", (t) => {
	// Invariant 6, exercised rather than asserted: the journal record is on disk
	// (and fsynced) before the learnings write begins, so a failure at the second
	// write leaves a traceable record for a line that does not exist — visible and
	// conservative — rather than a line nobody can trace back to a decision.
	if (process.getuid?.() === 0) return; // root ignores the mode bit this test needs
	const home = createScratchHome();
	t.after(() => {
		chmodSync(learningsPath(home.path), 0o644);
		home.cleanup();
	});
	seedLearnings(home.path, ["- 2026-08-01 an entry that must survive; evidence: a. <!--P-->"]);
	const candidate = capture(home.path, "a lesson whose file write will fail");
	const before = readFileSync(learningsPath(home.path), "utf8");

	chmodSync(learningsPath(home.path), 0o444);
	assert.throws(
		() =>
			promoteCandidate(home.path, {
				candidate,
				lesson: "a lesson whose file write will fail; act anyway",
				evidence: EVIDENCE,
				at: AT,
			}),
		/EACCES|EPERM/,
	);

	const log = readCurationLog(home.path);
	assert.equal(log.length, 1, "the journal record was written first, and it stays");
	assert.equal(log[0]?.action, "promote");
	const line = log[0]?.line ?? "";
	assert.equal(readFileSync(learningsPath(home.path), "utf8"), before, "learnings.md is byte-identical");
	assert.ok(!before.includes(line), "…so the journal names a line the file does not have");
	assert.equal(memoryStatus(home.path, AT).lines, 1, "and the file still parses");
	assert.deepEqual(
		traceLearning(home.path, line).map((record) => record.id),
		["cur-20260827-1"],
		"the audit trail is what makes the half-done promotion recoverable",
	);
});

/** Run one writer fixture to completion; the four of them run at once. */
function runWriter(args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

test("concurrent promotions from separate processes all land: the write is an append, never a rewrite (cp-nqj)", { timeout: 120_000 }, async (t) => {
	// The measurement that decides the mechanism, run as the real thing: four
	// processes promoting into one `data/learnings.md` through `promoteCandidate`.
	// `O_APPEND` makes concurrent appenders atomic at the kernel; a
	// read-modify-write has a lost-update window between the read and the write
	// (measured on this defect: 424 of 1600 writes survived). This test is what a
	// future refactor to read-modify-write would have to get past.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const seeded = "- 2026-08-01 an entry that predates every writer; evidence: a. <!--P-->";
	seedLearnings(home.path, [seeded]);
	const before = readFileSync(learningsPath(home.path), "utf8");

	const WRITERS = 4;
	const PER_WRITER = 11; // 44 lines + the seeded one, comfortably under the 60-line budget
	const owned: string[][] = [];
	for (let writer = 0; writer < WRITERS; writer += 1) {
		const lines: string[] = [];
		for (let n = 0; n < PER_WRITER; n += 1) {
			// Fixed-width ids, so no lesson is a prefix of another and the duplicate
			// check refuses nothing it should not.
			lines.push(capture(home.path, `concurrent lesson w${writer}n${String(n).padStart(2, "0")} stands on its own`));
		}
		owned.push(lines);
	}

	// Each process owns its own days, so the per-day bound (3) never refuses a
	// write and what the test measures is the file mechanism, nothing else.
	const fixture = join(REPO_ROOT, "tests/fixtures/memory-writer.mjs");
	const children = await Promise.all(
		owned.map((lines, writer) => {
			const first = new Date(Date.UTC(2026, 0, 1) + writer * PER_WRITER * 86_400_000).toISOString().slice(0, 10);
			return runWriter([fixture, home.path, JSON.stringify(lines), first]);
		}),
	);

	const expected: string[] = [];
	for (const child of children) {
		assert.equal(child.status, 0, `a writer failed: ${child.stderr}`);
		expected.push(...(JSON.parse(child.stdout.trim()) as string[]));
	}
	assert.equal(expected.length, WRITERS * PER_WRITER);

	const after = readFileSync(learningsPath(home.path), "utf8");
	assert.ok(after.startsWith(before), "every writer appended; nobody rewrote what was already there");
	const written = new Set(after.split("\n").map((line) => line.trim()));
	const lost = expected.filter((line) => !written.has(line.trim()));
	assert.deepEqual(lost, [], `${lost.length} of ${expected.length} concurrent promotions were lost`);
	assert.equal(
		memoryStatus(home.path, AT).lines,
		WRITERS * PER_WRITER + 1,
		"the seeded entry plus one line per promotion, and nothing duplicated",
	);
	assert.equal(readCurationLog(home.path).length, WRITERS * PER_WRITER, "every promotion is journalled too");
});
