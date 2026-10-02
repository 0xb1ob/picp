/**
 * T26 acceptance: the skill loads in pi, and the scaffold is idempotent.
 *
 * Plus the parts of the ported memory contract that are now code rather than
 * prose discipline: capture can only append to candidates, archiving is a move
 * with provenance, decay is dated arithmetic, and the session-start digest is
 * bounded by the budget it exists to enforce.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT, WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";
import {
	AGING_STALE_DAYS,
	archiveEntry,
	CANDIDATE_MAX_CHARS,
	captureCandidate,
	daysBetween,
	decayCandidates,
	ensureMemoryScaffold,
	formatMemoryStatus,
	LEARNINGS_MAX_LINES,
	MALFORMED_CANDIDATES_MAX,
	MEMORY_FILES,
	MemoryError,
	memoryStatus,
	parseLearnings,
	PERISHABLE_STALE_DAYS,
	readMemoryFile,
	scanCandidates,
	sessionStartDigest,
	today,
} from "../src/memory.ts";
import { memoryArgumentCompletions } from "../extensions/command-post/index.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, REPO_ROOT, startRpc } from "./harness/index.ts";

const AT = new Date("2026-08-27T12:00:00Z");

function learningsPath(home: string): string {
	return join(home, LAYOUT.learningsFile);
}

function writeLearnings(home: string, entries: readonly string[]): void {
	ensureMemoryScaffold(home);
	const header = readFileSync(learningsPath(home), "utf8");
	writeFileSync(learningsPath(home), `${header}\n${entries.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

test("the scaffold creates the three files and is idempotent", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const first = ensureMemoryScaffold(home.path);
	assert.deepEqual(
		first.created.sort(),
		[LAYOUT.archiveFile, LAYOUT.candidatesFile, LAYOUT.learningsFile].sort(),
	);
	assert.deepEqual(first.kept, []);
	for (const file of MEMORY_FILES) assert.ok(existsSync(join(home.path, file.path)), `${file.path} missing`);

	// Every file carries its own contract, so the rules travel with the memory.
	const learnings = readMemoryFile(home.path, "learnings") ?? "";
	assert.match(learnings, /Budget: max ~60 lines/);
	assert.match(learnings, /<!--P-->/);
	assert.match(readMemoryFile(home.path, "candidates") ?? "", /append-only/);
	assert.match(readMemoryFile(home.path, "archive") ?? "", /Never delete/);

	// The unforgivable scaffold bug: overwriting curated memory.
	writeLearnings(home.path, ["- 2026-08-01 a real learning; keep it; evidence: me. <!--P-->"]);
	const before = readFileSync(learningsPath(home.path), "utf8");
	const second = ensureMemoryScaffold(home.path);
	assert.deepEqual(second.created, []);
	assert.equal(second.kept.length, 3);
	assert.equal(readFileSync(learningsPath(home.path), "utf8"), before, "an existing file must be byte-identical");
});

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

// ---------------------------------------------------------------------------
// Parsing, tiers and decay
// ---------------------------------------------------------------------------

test("entries parse with their tier; the contract header is never memory", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeLearnings(home.path, [
		"- 2026-08-01 pinned thing; do it; evidence: a. <!--P-->",
		"- 2026-08-02 aging thing; do it; evidence: b. <!--a:2026-08-20-->",
		"- 2026-08-03 perishable thing; do it until cp-x closes; evidence: c. <!--p:2026-08-25-->",
		"- 2026-08-04 untiered thing; do it; evidence: d.",
		"not an entry at all",
	]);
	const entries = parseLearnings(readFileSync(learningsPath(home.path), "utf8"));
	assert.deepEqual(
		entries.map((entry) => entry.tier),
		["pinned", "aging", "perishable", "untiered"],
		"the header's HTML comment block must not be parsed as entries",
	);
	assert.equal(entries[1]?.since, "2026-08-20");
	assert.equal(entries[2]?.date, "2026-08-03");

	const status = memoryStatus(home.path, AT);
	assert.deepEqual(status.tiers, { pinned: 1, aging: 1, perishable: 1, untiered: 1 });
	assert.equal(status.untiered.length, 1);
	assert.match(formatMemoryStatus(status), /untiered \(contract wants/);
});

test("decay is dated arithmetic: pinned never, perishable at 7d, aging at 30d", () => {
	const entries = parseLearnings(
		[
			"- 2026-01-01 pinned; never decays; evidence: a. <!--P-->",
			"- 2026-08-20 perishable, 7 days old; evidence: b. <!--p:2026-08-20-->",
			"- 2026-08-25 perishable, 2 days old; evidence: c. <!--p:2026-08-25-->",
			"- 2026-07-28 aging, 30 days old; evidence: d. <!--a:2026-07-28-->",
			"- 2026-08-10 aging, 17 days old; evidence: e. <!--a:2026-08-10-->",
			"- 2026-01-01 untiered and ancient; evidence: f.",
		].join("\n"),
	);
	const stale = decayCandidates(entries, "2026-08-27");
	assert.deepEqual(
		stale.map((entry) => entry.since),
		["2026-08-20", "2026-07-28"],
		"exactly the two entries at their window; untiered is reported, never decayed",
	);
	assert.equal(daysBetween("2026-08-20", "2026-08-27"), PERISHABLE_STALE_DAYS);
	assert.equal(daysBetween("2026-07-28", "2026-08-27"), AGING_STALE_DAYS);
	assert.equal(daysBetween("nonsense", "2026-08-27"), undefined);
	assert.equal(today(AT), "2026-08-27");
});

// ---------------------------------------------------------------------------
// The session-start read
// ---------------------------------------------------------------------------

test("the session-start digest carries the entries and warns about decay", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeLearnings(home.path, [
		"- 2026-08-01 treehouse pool lives on the external disk here; evidence: cp-t11. <!--P-->",
		"- 2026-07-01 stale note; evidence: x. <!--a:2026-07-01-->",
	]);
	const digest = sessionStartDigest(home.path, AT) ?? "";
	assert.match(digest, /data\/learnings\.md \(2 entries, machine-local\)/);
	assert.match(digest, /treehouse pool lives on the external disk/);
	assert.match(digest, /1 entry past their decay window/);
	assert.ok(!digest.includes("Budget: max"), "the contract header never enters the session");
});

test("over budget, the digest truncates and says so — it is loaded every session", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const many = Array.from({ length: LEARNINGS_MAX_LINES + 5 }, (_, index) => `- 2026-08-01 lesson ${index}; do it; evidence: e. <!--P-->`);
	writeLearnings(home.path, many);
	const status = memoryStatus(home.path, AT);
	assert.equal(status.over_budget, true);
	assert.match(formatMemoryStatus(status), /OVER BUDGET/);
	assert.match(formatMemoryStatus(status), /pinned entries are not dropped for space/);

	const digest = sessionStartDigest(home.path, AT) ?? "";
	const lines = digest.split("\n");
	// header + budget's worth of entries + the truncation notice
	assert.equal(lines.length, LEARNINGS_MAX_LINES + 2);
	assert.match(lines.at(-1) ?? "", /5 entries beyond the 60-line budget were not loaded/);
});

// ---------------------------------------------------------------------------
// Capture: the only append, and it cannot reach learnings
// ---------------------------------------------------------------------------

test("capture appends one dated line to candidates and never touches learnings", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeLearnings(home.path, ["- 2026-08-01 keep me; evidence: a. <!--P-->"]);
	const learningsBefore = readFileSync(learningsPath(home.path), "utf8");

	const first = captureCandidate(home.path, "treehouse leases fail on the external disk when it is unmounted", AT);
	assert.equal(first.file, LAYOUT.candidatesFile);
	assert.equal(first.line, "2026-08-27 treehouse leases fail on the external disk when it is unmounted");
	assert.equal(first.candidates, 1);

	const second = captureCandidate(home.path, "second lesson", AT);
	assert.equal(second.candidates, 2, "append-only: two captures are two lines");

	const candidates = readMemoryFile(home.path, "candidates") ?? "";
	assert.ok(candidates.includes(first.line) && candidates.includes(second.line));
	assert.equal(readFileSync(learningsPath(home.path), "utf8"), learningsBefore, "capture is not promotion");
});

test("a candidate that is not the contract shape is reported, never silently dropped", (t) => {
	// cp-2lh: curation reads what the file says it contains, so a line the counter
	// cannot see is a lesson that will never be promoted — invisible, not merely
	// uncounted. Same treatment as an untiered learning: reported, not repaired.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	ensureMemoryScaffold(home.path);
	writeFileSync(
		join(home.path, LAYOUT.candidatesFile),
		[
			"# Candidates",
			"",
			"<!-- append-only; /memory capture writes here -->",
			"2026-08-27 a well-formed candidate",
			"- 2026-08-27 written as a list item",
			"no date at all",
			"2026-8-7 sloppy date",
			"",
			"<!-- a multi-line",
			"     comment is not a candidate -->",
			"## a heading is not a candidate",
			"",
		].join("\n"),
	);

	const status = memoryStatus(home.path, AT);
	assert.equal(status.candidates, 1, "only the contract-shaped line counts");
	assert.deepEqual(status.malformed_candidates, [
		"- 2026-08-27 written as a list item",
		"no date at all",
		"2026-8-7 sloppy date",
	]);

	const rendered = formatMemoryStatus(status);
	assert.match(rendered, /candidates that will never be promoted \(want `YYYY-MM-DD <lesson>`\)/);
	assert.match(rendered, /- 2026-08-27 written as a list item/);
	assert.ok(!/nothing to curate/.test(rendered), "a file with invisible lines is not curated");

	// The scanner is pure, so the cap is provable without writing 40 lines twice.
	const flood = scanCandidates(["# Candidates", ...Array.from({ length: 40 }, (_, n) => `bad ${n}`)].join("\n"));
	assert.equal(flood.counted, 0);
	assert.equal(flood.malformed.length, MALFORMED_CANDIDATES_MAX);
	assert.match(
		formatMemoryStatus({ ...status, malformed_candidates: flood.malformed }),
		/… more; open the file/,
	);

	// A clean file says nothing about candidates at all.
	const clean = scanCandidates("# Candidates\n\n2026-08-27 fine\n");
	assert.deepEqual(clean, { counted: 1, lines: ["2026-08-27 fine"], malformed: [] });
});

test("capture refuses a body, an empty lesson and an essay", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.throws(() => captureCandidate(home.path, "   ", AT), MemoryError);
	assert.throws(() => captureCandidate(home.path, "line one\nline two", AT), /one line/);
	assert.throws(() => captureCandidate(home.path, "x".repeat(CANDIDATE_MAX_CHARS + 1), AT), /at most 300 chars/);
});

test("capture scaffolds on demand, so a fresh home can capture immediately", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const result = captureCandidate(home.path, "first lesson on a fresh home", AT);
	assert.equal(result.candidates, 1);
	for (const file of MEMORY_FILES) assert.ok(existsSync(join(home.path, file.path)));
});

// ---------------------------------------------------------------------------
// Archive: a move with provenance, never a delete
// ---------------------------------------------------------------------------

test("archiving writes provenance first, then removes the line", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const keep = "- 2026-08-01 keep me; evidence: a. <!--P-->";
	const drop = "- 2026-07-01 workaround for cp-x; drop when it closes; evidence: b. <!--p:2026-07-01-->";
	writeLearnings(home.path, [keep, drop]);

	const result = archiveEntry(home.path, drop, {
		reason: "cp-x closed, the workaround is obsolete",
		now: "AGENTS.md §Teardown",
		at: AT,
	});
	assert.equal(result.remaining, 1);
	const archive = readMemoryFile(home.path, "archive") ?? "";
	assert.match(archive, /\(from \.pi-command-post\/data\/learnings\.md, <!--p:2026-07-01-->, archived 2026-08-27\)/);
	assert.match(archive, /Reason: cp-x closed, the workaround is obsolete/);
	assert.match(archive, /Now: AGENTS\.md §Teardown/);

	const learnings = readFileSync(learningsPath(home.path), "utf8");
	assert.ok(learnings.includes(keep), "the other entry is untouched");
	assert.ok(!learnings.includes("workaround for cp-x"), "the archived line is gone from learnings");
	assert.ok(archive.includes("workaround for cp-x"), "…because it is in the archive now");
});

// ---------------------------------------------------------------------------
// cp-nqj: no memory write may truncate the file it is writing
// ---------------------------------------------------------------------------

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

test("archiveEntry and captureCandidate preserve existing content and leave no staging file behind", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const keep = "- 2026-08-01 keep me; evidence: a. <!--P-->";
	const drop = "- 2026-07-01 archive me; evidence: b. <!--p:2026-07-01-->";
	writeLearnings(home.path, [keep, drop]);
	captureCandidate(home.path, "an earlier capture", AT);
	const archiveBefore = readMemoryFile(home.path, "archive") ?? "";
	const candidatesBefore = readMemoryFile(home.path, "candidates") ?? "";

	captureCandidate(home.path, "a second capture", AT);
	const candidatesAfter = readMemoryFile(home.path, "candidates") ?? "";
	assert.ok(candidatesAfter.startsWith(candidatesBefore), "capture only ever adds to the end");

	archiveEntry(home.path, drop, { reason: "it decayed", at: AT });
	const archiveAfter = readMemoryFile(home.path, "archive") ?? "";
	assert.ok(archiveAfter.startsWith(archiveBefore), "the archive only ever grows");
	const learnings = readFileSync(learningsPath(home.path), "utf8");
	assert.ok(learnings.includes(keep), "the entry that was not archived survives the rewrite");
	assert.match(learnings, /Budget: max ~60 lines/, "…and so does the contract header");

	assert.deepEqual(stagingFiles(home.path), [], "a completed write leaves no .tmp behind");
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

test("a torn final line is visible in status rather than silently absorbed", (t) => {
	// The one tear an append can still leave (a host crash losing an unflushed
	// page): the last line arrives without its tier comment. It is reported as
	// untiered — the same treatment as any off-contract entry — so a curation
	// pass sees it instead of inheriting it.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeLearnings(home.path, [
		"- 2026-08-01 whole line; evidence: a. <!--a:2026-08-01-->",
		"- 2026-08-27 a truncated tail with no tier and no ev",
	]);
	const status = memoryStatus(home.path, AT);
	assert.equal(status.untiered.length, 1);
	assert.match(status.untiered[0]?.line ?? "", /a truncated tail/);
	assert.match(formatMemoryStatus(status), /a truncated tail with no tier/);
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

// ---------------------------------------------------------------------------
// The skill, in pi
// ---------------------------------------------------------------------------

test("the cp-memory skill loads in pi and /memory works", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	// Hermetic agent dir: without it pi loads the operator's installed ~/.pi package, whose cp_send collides with ours.
	const agentDir = createAgentDir();
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION, "--skill", join(REPO_ROOT, "skills/cp-memory/SKILL.md")],
		env: { CP_HOME: home.path, ...agentDir.env },
	});
	// Close the child before removing the home it writes into: a cleanup hook
	// that throws skips every later hook (cp-widget-test-hangs).
	t.after(async () => {
		await rpc.close();
		home.cleanup();
		agentDir.cleanup();
	});

	rpc.send({ id: "cmds", type: "get_commands" });
	const response = (await rpc.waitFor((r) => r.type === "response" && r.id === "cmds")) as {
		data?: { commands?: Array<{ name: string; source: string }> };
	};
	const commands = response.data?.commands ?? [];
	assert.ok(
		commands.some((command) => command.name === "skill:cp-memory" && command.source === "skill"),
		`cp-memory did not load as a skill; got: ${commands.map((command) => command.name).join(",")}`,
	);
	assert.ok(commands.some((command) => command.name === "memory"), "/memory is not registered");

	// session_start scaffolds the three files in the (fresh) home.
	for (const file of MEMORY_FILES) {
		assert.ok(existsSync(join(home.path, file.path)), `${file.path} was not scaffolded by session_start`);
	}

	rpc.send({ id: "cap", type: "prompt", message: "/memory capture rpc-captured lesson" });
	const captured = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("captured in"),
		60_000,
	);
	assert.match(String(captured.message), /data\/candidates\.md \(1 candidate\(s\)\)/);
	assert.match(readMemoryFile(home.path, "candidates") ?? "", /rpc-captured lesson/);
	assert.ok(!(readMemoryFile(home.path, "learnings") ?? "").includes("rpc-captured"), "capture never reaches learnings");

	rpc.send({ id: "st", type: "prompt", message: "/memory status" });
	const status = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("MEMORY"),
		60_000,
	);
	assert.match(String(status.message), /0\/60 learning line\(s\).*1 candidate\(s\)/s);
	// The status read carries the curation pass's arithmetic too, so the operator
	// sees what the parent's own pass is allowed to do today.
	assert.match(String(status.message), /CURATION .* 1 pending candidate\(s\)/s);

	rpc.send({ id: "cur", type: "prompt", message: "/memory curate" });
	const plan = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("CURATION"),
		60_000,
	);
	assert.match(String(plan.message), /rpc-captured lesson/, "the pending candidate is the pass's worklist");

	rpc.send({ id: "aud", type: "prompt", message: "/memory audit" });
	const audit = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("AUDIT"),
		60_000,
	);
	assert.match(String(audit.message), /no curation decisions recorded yet/);
});

// ---------------------------------------------------------------------------
// cp-kzu: a tool-level capture path for the parent, plus the /memory UX trap
// ---------------------------------------------------------------------------

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

test("/memory capture with no lesson (the dropdown trap) errors with usage, not the bare contract message", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const agentDir = createAgentDir();
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		env: { CP_HOME: home.path, ...agentDir.env },
	});
	// Close the child before removing the home it writes into: a cleanup hook
	// that throws skips every later hook (cp-widget-test-hangs).
	t.after(async () => {
		await rpc.close();
		home.cleanup();
		agentDir.cleanup();
	});

	// This is exactly what selecting "capture " from the completion dropdown and
	// hitting enter without typing a lesson sends.
	rpc.send({ id: "empty-cap", type: "prompt", message: "/memory capture " });
	const error = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && r.notifyType === "error",
		60_000,
	);
	assert.match(String(error.message), /needs a one-line lesson.*usage: \/memory capture <one-line lesson>/s);
	assert.ok(!(readMemoryFile(home.path, "candidates") ?? "").match(/^\d{4}-\d{2}-\d{2} $/m), "an empty capture must not append a dateless or blank line");
});

test("cp_memory is a parent-only tool: a worker profile can never hold it", () => {
	// data/ is the parent's home only. cp_project is the existing precedent
	// (registering a project would let a worker clone repositories of its
	// choosing); cp_memory's write is smaller in blast radius but the same rule
	// applies — a worker must never be the one appending to candidates.md.
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_memory"));
});

test("the tool-level capture path shares captureCandidate's invariants: append-only, dated, candidates-only", (t) => {
	// cp_memory's execute() is a thin wrapper over captureCandidate/memoryStatus
	// (extensions/command-post/index.ts) — this proves the underlying function it
	// calls cannot violate the contract regardless of caller (slash command or
	// tool): one dated line, never touching learnings, append-only.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeLearnings(home.path, ["- 2026-08-01 keep me; evidence: a. <!--P-->"]);
	const learningsBefore = readFileSync(learningsPath(home.path), "utf8");

	const first = captureCandidate(home.path, "parent captured this without a human typing /memory", AT);
	assert.equal(first.file, LAYOUT.candidatesFile);
	assert.match(first.line, /^\d{4}-\d{2}-\d{2} parent captured this without a human typing \/memory$/);

	const second = captureCandidate(home.path, "a second parent-side capture", AT);
	assert.equal(second.candidates, 2, "append-only: the tool-level path is still one append per call");

	assert.equal(readFileSync(learningsPath(home.path), "utf8"), learningsBefore, "the tool-level path is not promotion either");
	assert.throws(() => captureCandidate(home.path, "", AT), MemoryError, "the same empty-lesson guard applies regardless of caller");
});
