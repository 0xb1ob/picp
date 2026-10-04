/**
 * cp-autonomous-memory-curation: curation without a human approval step.
 *
 * Every test here pins one safety property that the removed human gate was
 * nominally holding. If a property is deleted from `src/curation.ts`, the test
 * named after it fails — that is the whole point of the file, because
 * `data/learnings.md` is loaded into every future session and a session that
 * inherits a wrong lesson has no way to notice.
 *
 * Hermetic by construction: every test runs against a fresh temp home
 * (`createScratchHome`), never the repo's real `data/`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import {
	assertAppendOnly,
	candidateDisposition,
	countOnDate,
	CurationError,
	curationPlan,
	formatCurationAudit,
	formatCurationPlan,
	LEARNING_MAX_CHARS,
	pendingCandidates,
	pendingNotice,
	PROMOTABLE_TIERS,
	promoteCandidate,
	PROMOTIONS_PER_DAY_MAX,
	readCurationLog,
	REJECT_CAUSES,
	rejectCandidate,
	requireEvidence,
	retireLearning,
	RETIREMENTS_PER_DAY_MAX,
	traceLearning,
} from "../src/curation.ts";
import {
	CANDIDATE_MAX_CHARS,
	captureCandidate,
	ensureMemoryScaffold,
	LEARNINGS_MAX_LINES,
	memoryStatus,
	parseLearnings,
	readMemoryFile,
} from "../src/memory.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const AT = new Date("2026-08-27T12:00:00Z");
const LATER = new Date("2026-08-28T09:00:00Z");

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

// ---------------------------------------------------------------------------
// Property 1: a promoted line carries its date, its evidence and a tier
// ---------------------------------------------------------------------------

test("a promotion composes a dated, evidenced, tiered line — there is no path that writes one without them", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidate = capture(home.path, "treehouse leases fail when the external disk is unmounted");

	const result = promoteCandidate(home.path, {
		candidate,
		lesson: "treehouse leases fail when the external disk is unmounted; remount before dispatching",
		evidence: EVIDENCE,
		at: AT,
	});

	assert.equal(
		result.line,
		"- 2026-08-27 treehouse leases fail when the external disk is unmounted; remount before dispatching; evidence: cp-t26; PR #39; src/memory.ts. <!--a:2026-08-27-->",
	);
	const entries = parseLearnings(readFileSync(learningsPath(home.path), "utf8"));
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.tier, "aging", "an autonomous promotion is always decayable");
	assert.equal(entries[0]?.date, "2026-08-27");
	assert.equal(entries[0]?.since, "2026-08-27");
	assert.equal(result.entries, 1);
	assert.equal(result.budget, LEARNINGS_MAX_LINES);
});

test("promotion refuses a lesson with no evidence, and evidence that names no checkable source", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidate = capture(home.path, "something happened once");

	assert.throws(
		() => promoteCandidate(home.path, { candidate, lesson: "a lesson", evidence: "  ", at: AT }),
		/needs evidence/,
	);
	assert.throws(
		() => promoteCandidate(home.path, { candidate, lesson: "a lesson", evidence: "it seemed true at the time", at: AT }),
		/checkable source/,
	);
	assert.equal(memoryStatus(home.path, AT).lines, 0, "a refused promotion writes nothing");
	assert.deepEqual(readCurationLog(home.path), [], "…and journals nothing");

	// The shape of the guard itself: a source, or nothing.
	assert.equal(requireEvidence("cp-t26", "x"), "cp-t26");
	assert.equal(requireEvidence("https://github.com/o/r/pull/39", "x"), "https://github.com/o/r/pull/39");
	assert.equal(requireEvidence("merged 2026-08-27", "x"), "merged 2026-08-27");
	assert.throws(() => requireEvidence("obvious", "x"), CurationError);
});

test("an autonomous promotion can never be pinned: everything it writes has a shelf life", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidate = capture(home.path, "a lesson worth keeping forever, allegedly");

	assert.throws(
		() =>
			promoteCandidate(home.path, {
				candidate,
				lesson: "keep this forever",
				evidence: EVIDENCE,
				// The type forbids it too; a caller from JS must still be refused.
				tier: "pinned" as unknown as (typeof PROMOTABLE_TIERS)[number],
				at: AT,
			}),
		/permanence is the operator's call/,
	);
	assert.equal(memoryStatus(home.path, AT).lines, 0);
});

test("a perishable promotion must name a checkable expiry condition", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidate = capture(home.path, "workaround while cp-x is open");

	assert.throws(
		() => promoteCandidate(home.path, { candidate, lesson: "use the workaround", evidence: EVIDENCE, tier: "perishable", at: AT }),
		/expiry condition/,
	);
	const ok = promoteCandidate(home.path, {
		candidate,
		lesson: "use the workaround",
		evidence: EVIDENCE,
		tier: "perishable",
		expires: "cp-x closes",
		at: AT,
	});
	assert.match(ok.line, /; expires: cp-x closes; evidence: /);
	assert.match(ok.line, /<!--p:2026-08-27-->$/);
	assert.equal(parseLearnings(readFileSync(learningsPath(home.path), "utf8"))[0]?.tier, "perishable");
});

// ---------------------------------------------------------------------------
// Property 2: append-only — nothing already in learnings is rewritten or lost
// ---------------------------------------------------------------------------

test("promotion is append-only: every existing line survives byte-identically", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	// Includes a hand-written, off-contract line: a promotion must not "fix" it.
	seedLearnings(home.path, [
		"- 2026-08-01 pinned by the operator; evidence: a. <!--P-->",
		"- 2026-08-02 an untiered line somebody wrote by hand; evidence: b.",
		"a stray note that is not an entry at all",
	]);
	const before = readFileSync(learningsPath(home.path), "utf8");
	const candidate = capture(home.path, "a new observation about this machine");

	const result = promoteCandidate(home.path, {
		candidate,
		lesson: "a new observation about this machine; do the thing",
		evidence: EVIDENCE,
		at: AT,
	});

	const after = readFileSync(learningsPath(home.path), "utf8");
	assert.ok(after.startsWith(before), "the previous content must be an exact prefix of the new content");
	assert.equal(after.slice(before.length), `${result.line}\n`, "…and the only difference is the appended line");

	// The guard is exported so its refusal is provable directly.
	assert.throws(() => assertAppendOnly("- a\n- b\n", "- a\n- B\n"), /not an append/);
	assert.doesNotThrow(() => assertAppendOnly("- a\n", "- a\n- b\n"));
});

test("promotion refuses a duplicate rather than appending a second copy", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const first = capture(home.path, "the pool lives on the external disk");
	promoteCandidate(home.path, { candidate: first, lesson: "the pool lives on the external disk", evidence: EVIDENCE, at: AT });

	const second = capture(home.path, "the pool lives on the external disk (again)", LATER);
	assert.throws(
		() => promoteCandidate(home.path, { candidate: second, lesson: "the pool lives on the external disk", evidence: EVIDENCE, at: LATER }),
		/already in \.pi-command-post\/data\/learnings\.md/,
	);
	assert.equal(memoryStatus(home.path, LATER).lines, 1);
});

// ---------------------------------------------------------------------------
// Property 3: bounded growth
// ---------------------------------------------------------------------------

test("at most PROMOTIONS_PER_DAY_MAX promotions land in a day; tomorrow is a new allowance", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidates = Array.from({ length: PROMOTIONS_PER_DAY_MAX + 1 }, (_, index) =>
		capture(home.path, `distinct machine-local lesson number ${index}`),
	);

	for (let index = 0; index < PROMOTIONS_PER_DAY_MAX; index += 1) {
		const result = promoteCandidate(home.path, {
			candidate: candidates[index] as string,
			lesson: `distinct machine-local lesson number ${index}`,
			evidence: EVIDENCE,
			at: AT,
		});
		assert.equal(result.promotions_remaining, PROMOTIONS_PER_DAY_MAX - index - 1);
	}
	assert.throws(
		() =>
			promoteCandidate(home.path, {
				candidate: candidates[PROMOTIONS_PER_DAY_MAX] as string,
				lesson: `distinct machine-local lesson number ${PROMOTIONS_PER_DAY_MAX}`,
				evidence: EVIDENCE,
				at: AT,
			}),
		/promotions already landed today/,
	);
	assert.equal(memoryStatus(home.path, AT).lines, PROMOTIONS_PER_DAY_MAX);

	const tomorrow = promoteCandidate(home.path, {
		candidate: candidates[PROMOTIONS_PER_DAY_MAX] as string,
		lesson: `distinct machine-local lesson number ${PROMOTIONS_PER_DAY_MAX}`,
		evidence: EVIDENCE,
		at: LATER,
	});
	assert.equal(tomorrow.promotions_remaining, PROMOTIONS_PER_DAY_MAX - 1);
	assert.equal(memoryStatus(home.path, LATER).lines, PROMOTIONS_PER_DAY_MAX + 1);
});

test("the budget is a ceiling: at LEARNINGS_MAX_LINES nothing can be promoted until something is retired", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	seedLearnings(
		home.path,
		Array.from({ length: LEARNINGS_MAX_LINES }, (_, index) => `- 2026-08-01 existing lesson ${index}; evidence: e. <!--P-->`),
	);
	const candidate = capture(home.path, "one more thing that will not fit");

	assert.throws(
		() => promoteCandidate(home.path, { candidate, lesson: "one more thing", evidence: EVIDENCE, at: AT }),
		new RegExp(`at budget \\(${LEARNINGS_MAX_LINES}/${LEARNINGS_MAX_LINES}\\)`),
	);
	assert.equal(memoryStatus(home.path, AT).lines, LEARNINGS_MAX_LINES, "the file did not grow past its ceiling");

	// Retiring one makes exactly one slot, and no more.
	retireLearning(home.path, {
		line: "- 2026-08-01 existing lesson 0; evidence: e. <!--P-->",
		reason: "superseded by merged code",
		evidence: "PR #39",
		at: AT,
	});
	const promoted = promoteCandidate(home.path, { candidate, lesson: "one more thing", evidence: EVIDENCE, at: AT });
	assert.equal(promoted.entries, LEARNINGS_MAX_LINES);
});

// ---------------------------------------------------------------------------
// Property 4: a superseded or disproven candidate is never promotable
// ---------------------------------------------------------------------------

test("a rejected candidate can never be promoted, and rejection never rewrites candidates.md", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidate = capture(home.path, "workers must always rebase twice");
	const candidatesBefore = readMemoryFile(home.path, "candidates") ?? "";

	const rejected = rejectCandidate(home.path, {
		candidate,
		cause: "superseded",
		reason: "the brief now says it; the code merged the same day",
		evidence: "PR #39",
		at: AT,
	});
	assert.equal(rejected.cause, "superseded");
	assert.equal(
		readMemoryFile(home.path, "candidates"),
		candidatesBefore,
		"candidates.md is append-only: the disposition lives in the journal",
	);

	assert.throws(
		() => promoteCandidate(home.path, { candidate, lesson: "rebase twice", evidence: EVIDENCE, at: LATER }),
		/rejected as superseded .* never promoted/s,
	);
	assert.equal(memoryStatus(home.path, LATER).lines, 0);

	// And a decision is made once: a second disposition is refused too.
	assert.throws(
		() => rejectCandidate(home.path, { candidate, cause: "noise", reason: "changed my mind", at: LATER }),
		/already rejected .* decided once/,
	);
});

test("a superseded or disproven rejection must name what superseded or disproved it", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const one = capture(home.path, "a claim that merged code made false");
	const two = capture(home.path, "a claim the next run disproved");
	const three = capture(home.path, "a claim that belongs in AGENTS.md");

	assert.throws(
		() => rejectCandidate(home.path, { candidate: one, cause: "superseded", reason: "code landed", at: AT }),
		/needs evidence/,
	);
	assert.throws(
		() => rejectCandidate(home.path, { candidate: two, cause: "disproven", reason: "it did not reproduce", evidence: "trust me", at: AT }),
		/checkable source/,
	);
	// `generalizes` and `noise` are judgment calls with no external referent, so
	// they need a reason and no citation.
	const routed = rejectCandidate(home.path, { candidate: three, cause: "generalizes", reason: "contract edit, not a learning", at: AT });
	assert.equal(routed.cause, "generalizes");
	assert.deepEqual([...REJECT_CAUSES], ["superseded", "disproven", "generalizes", "noise"]);
});

test("promotion refuses a candidate nobody captured, and one already promoted", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidate = capture(home.path, "a real captured lesson");

	assert.throws(
		() => promoteCandidate(home.path, { candidate: "2026-08-27 invented on the spot", lesson: "x", evidence: EVIDENCE, at: AT }),
		/no such candidate/,
	);
	promoteCandidate(home.path, { candidate, lesson: "a real captured lesson; act on it", evidence: EVIDENCE, at: AT });
	assert.throws(
		() => promoteCandidate(home.path, { candidate, lesson: "a real captured lesson; act on it", evidence: EVIDENCE, at: LATER }),
		/already promoted/,
	);
	assert.equal(memoryStatus(home.path, LATER).lines, 1);
});

test("rejecting a promoted candidate names the retire path; pendingNotice counts pending candidates", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.equal(pendingNotice(home.path), undefined);
	const candidate = capture(home.path, "a real captured lesson");
	assert.match(pendingNotice(home.path) ?? "", /^\(1 pending candidate\(s\) — cp_memory curate\)$/);
	const promoted = promoteCandidate(home.path, { candidate, lesson: "a real captured lesson; act on it", evidence: EVIDENCE, at: AT });
	assert.equal(pendingNotice(home.path), undefined);
	assert.throws(
		() => rejectCandidate(home.path, { candidate, cause: "noise", reason: "changed my mind", at: LATER }),
		(error: Error) => error.message.includes(`cp_memory retire line: ${promoted.line}`),
	);
});

// ---------------------------------------------------------------------------
// Property 5: everything is auditable, and a bad line is traceable
// ---------------------------------------------------------------------------

test("every promotion, rejection and retirement is journalled, and the audit is written before the file", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const promoted = capture(home.path, "a lesson to promote");
	const rejected = capture(home.path, "a lesson to reject");

	const result = promoteCandidate(home.path, { candidate: promoted, lesson: "a lesson to promote; do it", evidence: EVIDENCE, at: AT });
	rejectCandidate(home.path, { candidate: rejected, cause: "noise", reason: "one-off, not a pattern", at: AT });
	const retired = retireLearning(home.path, {
		line: result.line,
		reason: "made false by merged code",
		evidence: "PR #39 merged 2026-08-28",
		now: "AGENTS.md §Memory",
		at: LATER,
	});

	const log = readCurationLog(home.path);
	assert.deepEqual(log.map((record) => record.action), ["promote", "reject", "retire"]);
	assert.deepEqual(log.map((record) => record.id), ["cur-20260827-1", "cur-20260827-2", "cur-20260828-1"]);
	assert.equal(log[0]?.line, result.line, "the audit record holds the exact line that was written");
	assert.equal(log[0]?.candidate, promoted, "…and the candidate it came from");
	assert.equal(log[0]?.evidence, EVIDENCE);
	assert.equal(log[2]?.now, "AGENTS.md §Memory");
	assert.ok(existsSync(join(home.path, LAYOUT.curationLog)));

	// A line in the digest that reads wrong is one lookup from its decision.
	const trace = traceLearning(home.path, result.line);
	assert.deepEqual(trace.map((record) => record.action), ["promote", "retire"]);
	assert.equal(trace[0]?.id, "cur-20260827-1");
	assert.equal(countOnDate(log, "promote", "2026-08-27"), 1);
	assert.equal(retired.id, "cur-20260828-1");

	const rendered = formatCurationAudit(log);
	assert.match(rendered, /cur-20260827-1 2026-08-27 promote:/);
	assert.match(rendered, /cur-20260827-2 2026-08-27 reject\/noise:/);
	assert.match(rendered, /cur-20260828-1 2026-08-28 retire:/);
	assert.match(formatCurationAudit([]), /no curation decisions recorded yet/);
});

test("a mangled journal line is skipped, not fatal — the bounds still compute", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidate = capture(home.path, "a lesson after a torn write");
	writeFileSync(join(home.path, LAYOUT.curationLog), "{not json\n\n");
	const result = promoteCandidate(home.path, { candidate, lesson: "a lesson after a torn write; act", evidence: EVIDENCE, at: AT });
	assert.equal(result.promotions_remaining, PROMOTIONS_PER_DAY_MAX - 1);
	assert.equal(readCurationLog(home.path).length, 1);
});

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

// ---------------------------------------------------------------------------
// Property 6: decay and supersession — a false lesson can leave, safely
// ---------------------------------------------------------------------------

test("retirement is a move with provenance: journalled, archived, never deleted", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const keep = "- 2026-08-01 keep me; evidence: a. <!--P-->";
	const drop = "- 2026-07-01 stale claim; evidence: b. <!--a:2026-07-01-->";
	seedLearnings(home.path, [keep, drop]);

	const result = retireLearning(home.path, {
		line: drop,
		reason: "made false by merged code",
		evidence: "PR #39",
		now: "docs/contracts.md §Memory",
		at: AT,
	});
	assert.equal(result.remaining, 1);
	assert.equal(result.retirements_remaining, RETIREMENTS_PER_DAY_MAX - 1);

	const learnings = readFileSync(learningsPath(home.path), "utf8");
	assert.ok(learnings.includes(keep), "the other entry is untouched");
	assert.ok(!learnings.includes("stale claim"));

	const archive = readMemoryFile(home.path, "archive") ?? "";
	assert.ok(archive.includes("stale claim"), "nothing is deleted; it is in the archive");
	assert.match(archive, /Reason: made false by merged code \(cur-20260827-1; evidence: PR #39\)/);
	assert.match(archive, /Now: docs\/contracts\.md §Memory/);
});

test("retirement is held to the promotion path's standard: reason, evidence, an exact line, and a daily bound", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const lines = Array.from(
		{ length: RETIREMENTS_PER_DAY_MAX + 1 },
		(_, index) => `- 2026-07-01 stale lesson ${index}; evidence: e. <!--a:2026-07-01-->`,
	);
	seedLearnings(home.path, lines);

	assert.throws(() => retireLearning(home.path, { line: lines[0] as string, reason: " ", evidence: "PR #39", at: AT }), /reason is required/);
	assert.throws(() => retireLearning(home.path, { line: lines[0] as string, reason: "stale", evidence: "  ", at: AT }), /needs evidence/);
	assert.throws(
		() => retireLearning(home.path, { line: "- 2026-07-01 stale lesson 0", reason: "stale", evidence: "PR #39", at: AT }),
		/match the line exactly/,
	);
	assert.equal(memoryStatus(home.path, AT).lines, lines.length, "a refused retirement changes nothing");

	for (let index = 0; index < RETIREMENTS_PER_DAY_MAX; index += 1) {
		retireLearning(home.path, { line: lines[index] as string, reason: "decayed with no reinforcement", evidence: "2026-08-27", at: AT });
	}
	assert.throws(
		() =>
			retireLearning(home.path, {
				line: lines[RETIREMENTS_PER_DAY_MAX] as string,
				reason: "decayed with no reinforcement",
				evidence: "2026-08-27",
				at: AT,
			}),
		/retirements already landed today/,
	);
	assert.equal(memoryStatus(home.path, AT).lines, 1, "the last line survived the bound");
});

// ---------------------------------------------------------------------------
// The pass itself
// ---------------------------------------------------------------------------

test("the plan is the pass's worklist: pending candidates, stale learnings, and what today still allows", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	seedLearnings(home.path, [
		"- 2026-07-01 a lesson that has decayed; evidence: e. <!--a:2026-07-01-->",
		"- 2026-08-26 a fresh lesson; evidence: e. <!--a:2026-08-26-->",
	]);
	const promote = capture(home.path, "candidate one, worth promoting");
	const reject = capture(home.path, "candidate two, superseded the same day");
	capture(home.path, "candidate three, still pending");

	const before = curationPlan(home.path, AT);
	assert.equal(before.pending.length, 3);
	assert.equal(before.stale.length, 1);
	assert.equal(before.promotions_remaining, PROMOTIONS_PER_DAY_MAX);
	assert.equal(before.retirements_remaining, RETIREMENTS_PER_DAY_MAX);
	assert.equal(before.budget_remaining, LEARNINGS_MAX_LINES - 2);
	assert.match(formatCurationPlan(before), /3 pending candidate\(s\) · 1 stale learning\(s\)/);
	assert.match(formatCurationPlan(before), /candidate three, still pending/);

	promoteCandidate(home.path, { candidate: promote, lesson: "candidate one, worth promoting; act on it", evidence: EVIDENCE, at: AT });
	rejectCandidate(home.path, { candidate: reject, cause: "superseded", reason: "merged the same day", evidence: "PR #39", at: AT });

	const after = curationPlan(home.path, AT);
	assert.deepEqual(after.pending, ["2026-08-27 candidate three, still pending"], "a decided candidate leaves the worklist");
	assert.equal(after.promotions_remaining, PROMOTIONS_PER_DAY_MAX - 1);
	assert.equal(after.recent.length, 2);
	assert.deepEqual(pendingCandidates(home.path), after.pending);
	assert.ok(candidateDisposition(readCurationLog(home.path), reject));

	// Nothing to do reads as nothing to do, not as an empty table.
	const quiet = createScratchHome();
	t.after(() => quiet.cleanup());
	ensureMemoryScaffold(quiet.path);
	assert.match(formatCurationPlan(curationPlan(quiet.path, AT)), /nothing to curate/);
});

test("curation only ever touches the home it is given", (t) => {
	// The whole module takes `home` as its first argument (the repo's DI style),
	// so a test can prove the real data/ directory is unreachable from here:
	// every write above landed in a temp dir, and this asserts the scratch home
	// is where the files actually are.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const candidate = capture(home.path, "a lesson that must not escape the scratch home");
	promoteCandidate(home.path, { candidate, lesson: "a lesson that must not escape; act", evidence: EVIDENCE, at: AT });

	for (const relative of [LAYOUT.learningsFile, LAYOUT.candidatesFile, LAYOUT.archiveFile, LAYOUT.curationLog]) {
		assert.ok(existsSync(join(home.path, relative)), `${relative} should exist under the scratch home`);
	}
	assert.ok(isAbsolute(home.path), "sanity: the home is an absolute temp path");
	assert.ok(!home.path.includes("pi-command-post/data"), "never the repo's own data/");
});

// ---------------------------------------------------------------------------
// Fix for cp-73w: stuck candidates (lesson length approaching 300 chars)
// ---------------------------------------------------------------------------

test("capturing a lesson at the maximum length (300 chars) can be rejected using just the lesson text", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	// Create a lesson exactly at the max capture length
	const longLesson = "a".repeat(CANDIDATE_MAX_CHARS);
	const candidateLine = capture(home.path, longLesson);

	// The full line must be 11 chars (date) + 300 chars (lesson) = 311 chars
	const expectedLength = 11 + CANDIDATE_MAX_CHARS;
	assert.equal(candidateLine.length, expectedLength, `full line is ${expectedLength} chars`);

	// Rejection using just the lesson text should work (the new behavior)
	const result = rejectCandidate(home.path, {
		candidate: longLesson,
		cause: "noise",
		reason: "not useful",
		at: AT,
	});

	assert.equal(result.candidate, candidateLine, "rejection resolves the lesson to the full line");
	const log = readCurationLog(home.path);
	assert.equal(log.length, 1);
	assert.equal(log[0]?.action, "reject");
	assert.equal(log[0]?.candidate, candidateLine);
	assert.equal(pendingCandidates(home.path).length, 0, "the rejected candidate is no longer pending");
});

test("capturing a lesson at the maximum length (300 chars) can be promoted using just the lesson text", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const longLesson = "a".repeat(CANDIDATE_MAX_CHARS);
	capture(home.path, longLesson);

	// Promotion using just the lesson text should work (the new behavior)
	const result = promoteCandidate(home.path, {
		candidate: longLesson,
		lesson: longLesson,
		evidence: EVIDENCE,
		at: AT,
	});

	assert.equal(result.line.length > LEARNING_MAX_CHARS, true, "the resulting learning line exceeds 300 chars and is allowed");
	const entries = parseLearnings(readFileSync(learningsPath(home.path), "utf8"));
	assert.equal(entries.length, 1);
	assert.equal(pendingCandidates(home.path).length, 0, "the promoted candidate is no longer pending");
});

test("a candidate at 298-299 chars (old stuck scenario) can be decided using the lesson text", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	ensureMemoryScaffold(home.path);

	// Simulate the old stuck candidates by manually writing them to candidates.md
	const lesson298 = "a".repeat(298);
	const lesson299 = "b".repeat(299);
	const candidatesPath = join(home.path, LAYOUT.candidatesFile);
	const existing = readFileSync(candidatesPath, "utf8");
	const line298 = `2026-08-27 ${lesson298}`;
	const line299 = `2026-08-27 ${lesson299}`;
	writeFileSync(candidatesPath, `${existing}${line298}\n${line299}\n`);

	// Both should be rejectable using just the lesson text
	const result298 = rejectCandidate(home.path, {
		candidate: lesson298,
		cause: "noise",
		reason: "not useful",
		at: AT,
	});
	assert.equal(result298.candidate, line298);

	const result299 = rejectCandidate(home.path, {
		candidate: lesson299,
		cause: "noise",
		reason: "not useful",
		at: AT,
	});
	assert.equal(result299.candidate, line299);

	const log = readCurationLog(home.path);
	assert.equal(log.length, 2, "both rejections were recorded");
	assert.deepEqual(pendingCandidates(home.path), [], "no pending candidates remain");
});

test("the relationship between capture and decide bounds: a lesson cannot become undecidable through drift", (t) => {
	// This test asserts the contract: whatever can be captured must be decidable.
	// The full line is always "YYYY-MM-DD " + lesson, so the relationship is:
	// candidateLine.length === 11 + lessonLength
	// If we can capture a lesson of length L, we must be able to promote/reject it,
	// which means accepting the full line of length 11 + L.

	const home = createScratchHome();
	t.after(() => home.cleanup());

	// Test at the boundary: a lesson of exactly CANDIDATE_MAX_CHARS
	const maxLesson = "x".repeat(CANDIDATE_MAX_CHARS);
	const captured = capture(home.path, maxLesson);
	const fullLineLength = captured.length;

	// The contract: the full line length is 11 chars (date prefix) + lesson length
	const expectedFullLineLength = 11 + CANDIDATE_MAX_CHARS;
	assert.equal(fullLineLength, expectedFullLineLength, "full line = 11 + lesson length");

	// Key assertion: either way of calling promote/reject should work
	// Method 1: using the full line (backward compatible)
	ensureMemoryScaffold(home.path);
	const lesson2 = "y".repeat(CANDIDATE_MAX_CHARS);
	const captured2 = capture(home.path, lesson2);
	promoteCandidate(home.path, {
		candidate: captured2, // full line
		lesson: lesson2,
		evidence: EVIDENCE,
		at: AT,
	});

	// Method 2: using just the lesson text (new behavior)
	const lesson3 = "z".repeat(CANDIDATE_MAX_CHARS);
	capture(home.path, lesson3);
	rejectCandidate(home.path, {
		candidate: lesson3, // just the lesson
		cause: "noise",
		reason: "test",
		at: AT,
	});

	assert.equal(pendingCandidates(home.path).length, 1, "one candidate remains (the first one):");
	const log = readCurationLog(home.path);
	assert.equal(log.filter((r) => r.action === "promote").length, 1);
	assert.equal(log.filter((r) => r.action === "reject").length, 1);
});
