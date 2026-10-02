/**
 * The in-house ledger (spec 2026-09-04). Hermetic: a scratch home, no binary.
 *
 * What is asserted is the contract: project/delivery labels are mandatory,
 * ids are minted collision-free, deps gate `ready`, closing carries a reason
 * and is a transition, dropped work is closed and never deleted, and every
 * write goes to disk atomically as a valid document.
 */

import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Job, LAYOUT } from "../src/contracts.ts";
import {
	formatJobLabels,
	initJobsDocument,
	legacyArchiveFile,
	isReady,
	jobsFile,
	Ledger,
	LedgerError,
	mintJobId,
	normalizeExternalRef,
	normalizeJobTitle,
	openBlockersOf,
	parseJobLabels,
	readJobsDocument,
	requireJobLabels,
} from "../src/ledger.ts";
import { recordAssessedRisk } from "../src/ledger-filter.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

/** True when a usable `br` is on PATH (harness pattern for treehouse; see harness/treehouse.ts). */
function brAvailable(): boolean {
	try {
		execFileSync("br", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const NOW = new Date("2026-09-04T10:00:00Z");

const JOB: Job = {
	id: "cp-a",
	title: "job",
	status: "open",
	labels: ["project:demo", "delivery:pr", "kind:ship"],
	blocked_by: [],
	comments: [],
	created_at: "2026-09-04T10:00:00Z",
	updated_at: "2026-09-04T10:00:00Z",
};

// ---------------------------------------------------------------------------
// labels (unchanged contract)
// ---------------------------------------------------------------------------

test("job labels round trip and are read fail-closed", () => {
	assert.deepEqual(formatJobLabels({ project: "demo", delivery: "pr", kind: "ship" }), ["project:demo", "delivery:pr", "kind:ship"]);
	assert.deepEqual(requireJobLabels(JOB), { project: "demo", delivery: "pr", kind: "ship" });
	assert.deepEqual(parseJobLabels(["project:demo"]), { project: "demo" });
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["delivery:pr"] }), /missing project:/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["project:demo"] }), /missing delivery:/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["project:demo", "delivery:carrier-pigeon"] }), /not one of/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["project:demo", "delivery:pr", "kind:vibes"] }), /kind:vibes is not one of/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["project:a", "project:b", "delivery:pr"] }), /2 project: labels/);
	// riskkw-f10: risk:<low|high> reads like kind:, fail-closed.
	assert.equal(parseJobLabels(["project:demo", "risk:low"]).risk, "low");
	assert.equal(requireJobLabels({ ...JOB, labels: [...JOB.labels, "risk:high"] }).risk, "high");
	assert.throws(() => requireJobLabels({ ...JOB, labels: [...JOB.labels, "risk:medium"] }), /risk:medium is not one of low\|high/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: [...JOB.labels, "risk:low", "risk:high"] }), /2 risk: labels/);
});

test("riskkw-f10: create records risk as a label and refuses a second or malformed one", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const job = await scratch.ledger.create({ title: "r", project: "demo", delivery: "pr", risk: "high" });
	assert.deepEqual(job.labels, ["project:demo", "delivery:pr", "risk:high"]);
	await assert.rejects(scratch.ledger.create({ title: "r2", project: "demo", delivery: "pr", risk: "high", labels: ["risk:low"] }), /at most one risk:/);
	await assert.rejects(scratch.ledger.create({ title: "r3", project: "demo", delivery: "pr", labels: ["risk:bogus"] }), /at most one risk:/);
	await assert.rejects(scratch.ledger.create({ title: "r4", project: "demo", delivery: "pr", risk: "medium" as never }), /risk .* must be one of/);
	const before = JSON.stringify(scratch.document());
	await assert.rejects(scratch.ledger.update(job.id, { addLabels: ["risk:bogus"] }));
	assert.equal(JSON.stringify(scratch.document()), before, "a refused label edit writes nothing");
});

// riskkw (cp-yxgl review): the label a composed risk writes follows the *assessed* value only.
test("riskkw: only an assessed high writes a `risk:` label, and it replaces a stale low", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const plain = await scratch.ledger.create({ title: "ship", project: "demo", delivery: "pr", kind: "ship" });
	// A `defaulted` low is "nobody named it" and an `inferred` high is the task's own words:
	// neither is a record, so neither is written.
	await recordAssessedRisk(scratch.ledger, plain.id, { risk: "low", inputsFrom: { risk: "defaulted" } });
	await recordAssessedRisk(scratch.ledger, plain.id, { risk: "high", inputsFrom: { risk: "inferred" } });
	assert.deepEqual((await scratch.ledger.show(plain.id)).labels, ["project:demo", "delivery:pr", "kind:ship"]);
	// An assessed high is recorded, replacing a stale low rather than sitting beside it, and a
	// second call is a no-op.
	const low = await scratch.ledger.create({ title: "ship 2", project: "demo", delivery: "pr", kind: "ship", risk: "low" });
	await recordAssessedRisk(scratch.ledger, low.id, { risk: "high", inputsFrom: { risk: "assessed" } });
	assert.deepEqual((await scratch.ledger.show(low.id)).labels, ["project:demo", "delivery:pr", "kind:ship", "risk:high"]);
	await recordAssessedRisk(scratch.ledger, low.id, { risk: "high", inputsFrom: { risk: "assessed" } });
	assert.equal((await scratch.ledger.show(low.id)).labels.filter((label) => label === "risk:high").length, 1);
});

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

test("initJobsDocument creates an empty document once and never rewrites it", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const first = initJobsDocument(home.path, "cp");
	assert.equal(first.created, true);
	assert.deepEqual(first.document, { schema_version: 1, prefix: "cp", jobs: [] });
	assert.equal(jobsFile(home.path), join(home.path, LAYOUT.jobsFile));
	assert.ok(existsSync(jobsFile(home.path)));

	writeFileSync(jobsFile(home.path), JSON.stringify({ schema_version: 1, prefix: "cp", jobs: [JOB] }));
	const second = initJobsDocument(home.path, "cps");
	assert.equal(second.created, false);
	assert.equal(second.document.prefix, "cp", "an existing document wins over a new prefix");
	assert.equal(second.document.jobs.length, 1);

	assert.throws(() => initJobsDocument(join(home.path, "other"), "Not-Ok"), /not a usable ledger prefix/);
});

test("readJobsDocument fails closed: missing, not JSON, invalid shape, broken invariant", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.throws(() => readJobsDocument(home.path), /no ledger at .*jobs\.json/);
	mkdirSync(join(home.path, LAYOUT.runtimeDir), { recursive: true });
	writeFileSync(jobsFile(home.path), "{not json");
	assert.throws(() => readJobsDocument(home.path), /is not JSON/);
	writeFileSync(jobsFile(home.path), JSON.stringify({ schema_version: 1, prefix: "cp", jobs: [{ id: "cp-a" }] }));
	assert.throws(() => readJobsDocument(home.path), /violates the jobs contract/);
	writeFileSync(jobsFile(home.path), JSON.stringify({ schema_version: 1, prefix: "cp", jobs: [JOB, JOB] }));
	assert.throws(() => readJobsDocument(home.path), /duplicate id cp-a/);
});

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

test("mintJobId draws four lowercase base36 characters, redraws on collision and lengthens after eight", () => {
	const fixed = (values: number[]) => {
		let index = 0;
		return (_max: number) => values[index++ % values.length] as number;
	};
	assert.equal(mintJobId("cp", new Set(), { random: fixed([0, 1, 2, 3]) }), "cp-abcd");
	assert.equal(mintJobId("cp", new Set(), { slug: "t02-contracts", random: fixed([0, 1, 2, 3]) }), "cp-t02-contracts-abcd");
	// First draw collides, second does not.
	assert.equal(mintJobId("cp", new Set(["cp-aaaa"]), { random: fixed([0, 0, 0, 0, 0, 0, 0, 1]) }), "cp-aaab");
	// Eight collisions in a row: the ninth draw is five characters long.
	const always = (_max: number) => 0;
	assert.equal(mintJobId("cp", new Set(["cp-aaaa"]), { random: always }), "cp-aaaaa");
	assert.throws(() => mintJobId("cp", new Set(["cp-aaaa", "cp-aaaaa"]), { random: always }), /could not mint a unique id/);
	assert.throws(() => mintJobId("cp", new Set(), { slug: "Has Spaces" }), /slug .* must match/);
	// Real randomness: 200 mints, all unique, all path-safe.
	const seen = new Set<string>();
	for (let i = 0; i < 200; i += 1) {
		const id = mintJobId("cp", seen);
		assert.match(id, /^cp-[a-z0-9]{4}$/);
		seen.add(id);
	}
	assert.equal(seen.size, 200);
});

// ---------------------------------------------------------------------------
// intake
// ---------------------------------------------------------------------------

test("create accepts a research board delivery", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const job = await scratch.ledger.create({ title: "Board", project: "demo", delivery: "board", kind: "research" });
	assert.deepEqual(job.labels, ["project:demo", "delivery:board", "kind:research"]);
	assert.equal(requireJobLabels(job).delivery, "board");
});

test("intake refuses what the contract forbids, before anything is written", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	await assert.rejects(ledger.create({ title: "  ", project: "demo", delivery: "pr" }), /needs a title/);
	await assert.rejects(ledger.create({ title: "x", project: "bad name", delivery: "pr" }), /not a valid label value/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "fax" as never }), /delivery .* must be one of/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "pr", kind: "vibes" as never }), /kind .* must be one of/);
	await assert.rejects(ledger.create({ title: "x", project: "unknown", delivery: "pr" }), /unknown project "unknown" — register it first; known: demo/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "pr", externalRef: "   " }), /external ref must be one non-empty line/);
	await assert.rejects(
		ledger.create({ title: "x", project: "demo", delivery: "pr", externalRef: "line one\nline two" }),
		/external ref must be one non-empty line/,
	);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "pr", labels: ["a,b"] }), /may not contain a comma/);
	assert.deepEqual(scratch.document().jobs, [], "nothing was written");
});

test("create writes a valid record with the job labels, defaults and the actor-free shape", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], now: () => NOW });
	const job = await ledger.create({
		title: "  fix the thing  ",
		project: "demo",
		delivery: "pr",
		kind: "ship",
		description: "d",
		externalRef: "https://github.com/o/r/issues/1",
		labels: ["phase:7"],
		slug: "fix-thing",
	});
	assert.match(job.id, /^cp-fix-thing-[a-z0-9]{4}$/);
	assert.equal(job.title, "fix the thing");
	assert.equal(job.status, "open");
	assert.equal("type" in job, false, "the ledger has no job type");
	assert.equal("priority" in job, false, "the ledger has no job priority");
	assert.deepEqual(job.labels, ["project:demo", "delivery:pr", "kind:ship", "phase:7"]);
	assert.equal(job.external_ref, "https://github.com/o/r/issues/1");
	assert.deepEqual(job.blocked_by, []);
	assert.equal(job.created_at, "2026-09-04T10:00:00Z");
	assert.deepEqual(scratch.document().jobs, [job], "what was returned is what is on disk");
	assert.deepEqual(await ledger.show(job.id), job);
	await assert.rejects(ledger.show("cp-nope"), /cp-nope: no such job/);
});

test("script declarations persist only for ship/local with a safe repository-relative path", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	for (const path of ["/tmp/run.sh", "../run.sh", "a/../run.sh", "./run.sh", "a//run.sh", "a\\run.sh", "run.sh\nignore", ""]) {
		await assert.rejects(ledger.create({ title: "run", project: "demo", delivery: "local", kind: "ship", scriptPath: path }), /script path/i, path);
	}
	for (const [kind, delivery] of [["research", "local"], ["ship", "pr"], [undefined, "local"]] as const) {
		await assert.rejects(ledger.create({ title: "run", project: "demo", kind, delivery, scriptPath: "scripts/run.sh" }), /ship.*local/i);
	}
	assert.deepEqual(scratch.document().jobs, []);
	const job = await ledger.create({ title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
	assert.deepEqual(job.script, { path: "scripts/run.sh" });
	assert.deepEqual((await ledger.show(job.id)).script, { path: "scripts/run.sh" });
	await ledger.update(job.id, { notes: "keep action" });
	assert.deepEqual((await ledger.show(job.id)).script, { path: "scripts/run.sh" });
});

test("findDuplicate: project+title or external_ref, open jobs only", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo", "other"] });
	t.after(() => scratch.cleanup());
	const dbPath = "/abs/demo/.beads/beads.db";
	const ledger = new Ledger({
		home: scratch.path,
		knownProjects: ["demo", "other"],
		beadsDbFor: (project) => (project === "demo" ? dbPath : undefined),
	});
	assert.equal(normalizeJobTitle("  Fix   the Thing "), "fix the thing");
	const job = await ledger.create({
		title: "fix the thing",
		project: "demo",
		delivery: "pr",
		externalRef: "br show cp-nz95 --json",
	});
	const pinned = `br --db '${dbPath}' show cp-nz95 --json`;
	assert.equal(job.external_ref, pinned);
	assert.equal(ledger.findDuplicate({ title: "FIX  the thing", project: "demo" })?.id, job.id);
	assert.equal(ledger.findDuplicate({ title: "unrelated", project: "demo", externalRef: "br show cp-nz95 --json" })?.id, job.id);
	assert.equal(ledger.findDuplicate({ title: "fix the thing", project: "other" }), undefined);
	await ledger.close(job.id, "done");
	assert.equal(ledger.findDuplicate({ title: "fix the thing", project: "demo" }), undefined, "closed jobs do not match");
});

test("direct create dedupes matching action and refuses a changed script action", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const ledger = scratch.ledger;
	const input = { title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/a.sh" } as const;
	const job = await ledger.create(input);
	assert.notEqual((await ledger.create(input)).id, job.id, "matching action preserves direct create's existing mint semantics");
	await assert.rejects(ledger.create({ ...input, scriptPath: "scripts/b.sh" }), /action mismatch/);
	await assert.rejects(ledger.create({ ...input, scriptPath: undefined }), /action mismatch/);
	assert.equal(scratch.document().jobs.length, 2);
});

test("external_ref is a pointer to wherever the issue lives: a url, a path, or the command that shows it", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	const refs = ["https://github.com/o/r/issues/1", "docs/issues/42.md", "br show cp-nz95 --json", "ENG-123"];
	for (const ref of refs) {
		const job = await ledger.create({ title: `for ${ref}`, project: "demo", delivery: "pr", externalRef: `  ${ref}  ` });
		assert.equal(job.external_ref, ref, "stored trimmed, otherwise verbatim");
	}
	assert.equal(scratch.document().jobs.length, refs.length);
});

// ---------------------------------------------------------------------------
// br --db pinning (pi-command-post-external-ref-br-db-52x): a bare `br show
// <id> --json` only works from the project's own checkout, because a leased
// worktree's `.beads/` is gitignored. Pin it with `--db` and the project's
// absolute beads.db path instead, at create time and (for older jobs) on show.
// ---------------------------------------------------------------------------

test("normalizeExternalRef pins a bare `br show <id> --json`, shell-quoted; every other shape passes through unchanged", () => {
	const db = "/projects/demo/.beads/beads.db";
	assert.equal(normalizeExternalRef("br show cp-nz95 --json", db), `br --db '${db}' show cp-nz95 --json`);
	assert.equal(normalizeExternalRef("br show cp-nz95 --json", undefined), "br show cp-nz95 --json", "no resolvable DB: unchanged");
	assert.equal(normalizeExternalRef("https://github.com/o/r/issues/1", db), "https://github.com/o/r/issues/1", "a url is not a br command");
	assert.equal(normalizeExternalRef("docs/issues/42.md", db), "docs/issues/42.md", "a file path is not a br command");
	assert.equal(normalizeExternalRef("ENG-123", db), "ENG-123", "another tracker's id is not a br command");
	assert.equal(
		normalizeExternalRef("br --db /already/pinned.db show cp-nz95 --json", db),
		"br --db /already/pinned.db show cp-nz95 --json",
		"already pinned: unchanged, even to a different DB",
	);
	assert.equal(normalizeExternalRef("br list --status open", db), "br list --status open", "a different br command: unchanged");
	// A path with a space, a `$`, and a literal single quote: still one shell word, safely.
	const weird = "/projects/My Demo $HOME's Repo/.beads/beads.db";
	assert.equal(
		normalizeExternalRef("br show cp-nz95 --json", weird),
		`br --db '/projects/My Demo $HOME'\\''s Repo/.beads/beads.db' show cp-nz95 --json`,
	);
});

test("create pins a bare br show ref to the project's beads DB when the caller wires one", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const dbPath = "/projects/demo/.beads/beads.db";
	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], beadsDbFor: (project) => (project === "demo" ? dbPath : undefined) });
	const job = await ledger.create({ title: "x", project: "demo", delivery: "pr", externalRef: "br show cp-nz95 --json" });
	assert.equal(job.external_ref, `br --db '${dbPath}' show cp-nz95 --json`);
	const other = await ledger.create({ title: "y", project: "demo", delivery: "pr", externalRef: "https://github.com/o/r/issues/1" });
	assert.equal(other.external_ref, "https://github.com/o/r/issues/1", "a url is never rewritten");
});

test("an older job stored with a bare br show ref reads pinned through every query path, with no write and no updated_at bump", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const dbPath = "/projects/demo/.beads/beads.db";
	// Written by a caller with no resolver (an older job, or a bare-ref command run before this DB was pinned).
	const created = await new Ledger({ home: scratch.path, knownProjects: ["demo"] }).create({
		title: "old job",
		project: "demo",
		delivery: "pr",
		externalRef: "br show cp-old --json",
	});
	const onDiskBefore = readFileSync(scratch.ledger.file, "utf8");
	assert.equal(scratch.document().jobs.find((j) => j.id === created.id)?.external_ref, "br show cp-old --json");

	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], beadsDbFor: (project) => (project === "demo" ? dbPath : undefined) });
	const pinned = `br --db '${dbPath}' show cp-old --json`;

	// Every query path projects the same pinned view — not just show().
	const shown = await ledger.show(created.id);
	assert.equal(shown.external_ref, pinned, "show");
	const [listed] = await ledger.list({ project: "demo" });
	assert.equal(listed?.external_ref, pinned, "list");
	const [ready] = await ledger.ready({ project: "demo" });
	assert.equal(ready?.external_ref, pinned, "ready");
	const [history] = await ledger.history({ project: "demo" });
	assert.equal(history, undefined, "not closed yet, so absent from history");

	// A read never mutates: the document on disk, byte for byte, and updated_at, are untouched.
	assert.equal(readFileSync(scratch.ledger.file, "utf8"), onDiskBefore, "show/list/ready wrote nothing to disk");
	assert.equal(scratch.document().jobs.find((j) => j.id === created.id)?.external_ref, "br show cp-old --json", "still bare on disk");
	assert.equal(scratch.document().jobs.find((j) => j.id === created.id)?.updated_at, created.updated_at, "updated_at did not move");

	// Calling it again is exactly as pure: same projected value, same untouched disk.
	const again = await ledger.show(created.id);
	assert.equal(again.external_ref, pinned);
	assert.equal(again.updated_at, created.updated_at);
	assert.equal(readFileSync(scratch.ledger.file, "utf8"), onDiskBefore);
});

test("a closed job with a bare br show ref is projected pinned through history() and blocked()", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const dbPath = "/projects/demo/.beads/beads.db";
	const plain = new Ledger({ home: scratch.path, knownProjects: ["demo"] });
	const closed = await plain.create({ title: "old, closed", project: "demo", delivery: "pr", externalRef: "br show cp-closed --json" });
	await plain.close(closed.id, "done");
	const blockedOne = await plain.create({ title: "blocked", project: "demo", delivery: "pr", externalRef: "br show cp-blocked --json" });
	const blockerOne = await plain.create({ title: "blocker", project: "demo", delivery: "pr" });
	await plain.addDep(blockedOne.id, blockerOne.id);

	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], beadsDbFor: (project) => (project === "demo" ? dbPath : undefined) });
	const [history] = await ledger.history({ project: "demo" });
	assert.equal(history?.external_ref, `br --db '${dbPath}' show cp-closed --json`);
	const blockedRows = await ledger.blocked();
	const row = blockedRows.find((j) => j.id === blockedOne.id);
	assert.equal(row?.external_ref, `br --db '${dbPath}' show cp-blocked --json`);
});

test(
	"the pinned form runs from a fresh leased worktree with no .beads/; the bare form does not (root cause, not just the string)",
	{ skip: brAvailable() ? false : "br must be on PATH" },
	async (t) => {
		const projectDir = mkdtempSync(join(tmpdir(), "cp-beads-project-"));
		const worktreeDir = mkdtempSync(join(tmpdir(), "cp-beads-worktree-"));
		t.after(() => {
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(worktreeDir, { recursive: true, force: true });
		});
		execFileSync("git", ["init", "-q"], { cwd: projectDir });
		execFileSync("br", ["init", "--prefix", "test", "-q"], { cwd: projectDir });
		const created = JSON.parse(execFileSync("br", ["create", "hello", "--json"], { cwd: projectDir, encoding: "utf8" })) as
			| { id: string }
			| Array<{ id: string }>;
		const issueId = Array.isArray(created) ? created.at(0)!.id : created.id;
		const dbPath = join(projectDir, ".beads", "beads.db");

		assert.equal(normalizeExternalRef(`br show ${issueId} --json`, dbPath), `br --db '${dbPath}' show ${issueId} --json`);

		// The bug this fixes: the bare form fails from a worktree with no .beads/.
		assert.throws(() => execFileSync("br", ["show", issueId, "--json"], { cwd: worktreeDir, stdio: ["ignore", "pipe", "pipe"] }));

		// The pinned form succeeds from that same fresh worktree: no cd, no br init.
		const shownOut = execFileSync("br", ["--db", dbPath, "show", issueId, "--json"], { cwd: worktreeDir, encoding: "utf8" });
		const shown = JSON.parse(shownOut) as { id: string } | Array<{ id: string }>;
		assert.equal(Array.isArray(shown) ? shown.at(0)!.id : shown.id, issueId);
	},
);

test(
	"the stored ref is one valid shell word even when the project's checkout path has a space in it",
	{ skip: brAvailable() ? false : "br must be on PATH" },
	async (t) => {
		const projectDir = mkdtempSync(join(tmpdir(), "cp beads project "));
		const worktreeDir = mkdtempSync(join(tmpdir(), "cp-beads-worktree-"));
		t.after(() => {
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(worktreeDir, { recursive: true, force: true });
		});
		assert.ok(projectDir.includes(" "), "the fixture path must actually contain a space to test anything");
		execFileSync("git", ["init", "-q"], { cwd: projectDir });
		execFileSync("br", ["init", "--prefix", "test", "-q"], { cwd: projectDir });
		const created = JSON.parse(execFileSync("br", ["create", "hello", "--json"], { cwd: projectDir, encoding: "utf8" })) as
			| { id: string }
			| Array<{ id: string }>;
		const issueId = Array.isArray(created) ? created.at(0)!.id : created.id;
		const dbPath = join(projectDir, ".beads", "beads.db");

		const ref = normalizeExternalRef(`br show ${issueId} --json`, dbPath);
		assert.equal(ref, `br --db '${dbPath}' show ${issueId} --json`);

		// The stored ref is meant to be run verbatim in a shell; prove it actually
		// parses as one command and resolves to the right DB from a fresh worktree.
		const out = execSync(ref, { cwd: worktreeDir, encoding: "utf8" });
		const shown = JSON.parse(out) as { id: string } | Array<{ id: string }>;
		assert.equal(Array.isArray(shown) ? shown.at(0)!.id : shown.id, issueId);
	},
);

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test("the full job lifecycle: create -> ready -> claim -> comment -> close, and a close is a transition", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	const job = await ledger.create({ title: "a", project: "demo", delivery: "pr", kind: "ship" });

	assert.deepEqual((await ledger.ready()).map((j) => j.id), [job.id]);
	const claimed = await ledger.claim(job.id, job.id);
	assert.equal(claimed.status, "in_progress");
	assert.equal(claimed.assignee, job.id);
	assert.deepEqual(await ledger.ready(), [], "a claimed job is not ready");

	const commented = await ledger.comment(job.id, "blocker: waiting on the operator");
	assert.equal(commented.comments.length, 1);
	assert.equal(commented.comments[0]?.author, "cp-test");
	assert.equal(commented.comments[0]?.text, "blocker: waiting on the operator");
	await assert.rejects(ledger.comment(job.id, "   "), /empty comment/);

	await assert.rejects(ledger.update(job.id, { status: "closed" }), /refusing to set .* to closed through update/);
	await assert.rejects(ledger.update(job.id, {}), /nothing to change/);
	await assert.rejects(ledger.close(job.id, " "), /a reason is required/);

	const closed = await ledger.close(job.id, "merged: https://github.com/o/r/pull/1");
	assert.equal(closed.status, "closed");
	assert.equal(closed.close_reason, "merged: https://github.com/o/r/pull/1");
	assert.ok(closed.closed_at);
	assert.deepEqual(await ledger.close(job.id, "merged: https://github.com/o/r/pull/1"), closed, "same reason: idempotent");
	await assert.rejects(ledger.close(job.id, "something else"), /already closed .* a close is a fact/);
	assert.deepEqual((await ledger.history()).map((j) => j.id), [job.id]);
	assert.deepEqual(await ledger.list(), [], "closed jobs are hidden without all");
	assert.equal((await ledger.list({ all: true })).length, 1);
});

test("drop closes with a reason and never deletes", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const job = await scratch.ledger.create({ title: "a", project: "demo", delivery: "local" });
	await assert.rejects(scratch.ledger.drop(job.id, ""), /say why it was dropped/);
	const dropped = await scratch.ledger.drop(job.id, "superseded by cp-b");
	assert.equal(dropped.close_reason, "dropped: superseded by cp-b");
	assert.equal(scratch.document().jobs.length, 1);
	const again = await scratch.ledger.drop(job.id, "dropped: superseded by cp-b");
	assert.equal(again.close_reason, "dropped: superseded by cp-b", "an already-prefixed reason is not double-prefixed");
});

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

test("a dropped close keeps dependents blocked; a landed close alone satisfies them", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	const blocker = await ledger.create({ title: "base", project: "demo", delivery: "pr" });
	const dependent = await ledger.create({ title: "follow-up", project: "demo", delivery: "pr" });
	await ledger.addDep(dependent.id, blocker.id);
	await ledger.drop(blocker.id, "result not delivered");
	assert.deepEqual(await ledger.ready(), [], "dropping work must not silently unblock its dependent");
	assert.deepEqual(await ledger.blockersOf(dependent.id), [blocker.id]);
	assert.deepEqual((await ledger.blocked()).map((job) => job.id), [dependent.id]);
	assert.deepEqual((await ledger.dependenciesOf(dependent.id)).map((job) => [job.status, job.close_reason]), [["closed", "dropped: result not delivered"]]);
});

test("dependencies gate ready, blockersOf is fail-closed, and the graph refuses self, unknown and cycles", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	const research = await ledger.create({ title: "research", project: "demo", delivery: "pipeline", kind: "research" });
	const ship = await ledger.create({ title: "ship", project: "demo", delivery: "pr", kind: "ship" });

	await ledger.addDep(ship.id, research.id);
	await ledger.addDep(ship.id, research.id); // idempotent
	assert.deepEqual((await ledger.show(ship.id)).blocked_by, [research.id]);
	assert.deepEqual((await ledger.ready()).map((j) => j.id), [research.id]);
	assert.deepEqual((await ledger.blocked()).map((j) => j.id), [ship.id]);
	assert.deepEqual(await ledger.blockersOf(ship.id), [research.id]);
	assert.deepEqual(await ledger.blockersOf("cp-unknown"), []);

	await assert.rejects(ledger.addDep(ship.id, ship.id), /cannot depend on itself/);
	await assert.rejects(ledger.addDep(ship.id, "cp-nope"), /cp-nope: no such job/);
	await assert.rejects(ledger.addDep(research.id, ship.id), /dependency cycle/);

	await ledger.close(research.id, "gate pass");
	assert.deepEqual(await ledger.blockersOf(ship.id), [], "a landed blocker blocks nothing");
	assert.deepEqual((await ledger.dependenciesOf(ship.id)).map((job) => [job.status, job.close_reason]), [["closed", "gate pass"]]);
	assert.deepEqual((await ledger.ready()).map((j) => j.id), [ship.id]);
	assert.deepEqual(await ledger.blocked(), []);

	await ledger.removeDep(ship.id, research.id);
	await ledger.removeDep(ship.id, research.id); // idempotent
	assert.deepEqual((await ledger.show(ship.id)).blocked_by, []);

	const doc = scratch.document();
	assert.equal(isReady(doc, doc.jobs.find((j) => j.id === ship.id) as Job), true);
	assert.deepEqual(openBlockersOf(doc, ship.id), []);
});

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

test("list filters AND labels and statuses, limit 0 is unlimited, history is newest-closed first", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["a", "b"] });
	t.after(() => scratch.cleanup());
	let tick = 0;
	const ledger = new Ledger({ home: scratch.path, now: () => new Date(NOW.getTime() + tick++ * 1000) });
	const a1 = await ledger.create({ title: "a1", project: "a", delivery: "pr", kind: "ship" });
	const a2 = await ledger.create({ title: "a2", project: "a", delivery: "local", kind: "research" });
	const b1 = await ledger.create({ title: "b1", project: "b", delivery: "pr" });
	await ledger.claim(b1.id, b1.id);
	await ledger.update(a2.id, { status: "deferred", notes: "later", addLabels: ["phase:7"] });

	assert.deepEqual((await ledger.list({ project: "a" })).map((j) => j.title), ["a1", "a2"]);
	assert.deepEqual((await ledger.list({ project: "a", delivery: "pr" })).map((j) => j.title), ["a1"]);
	assert.deepEqual((await ledger.list({ kind: "research" })).map((j) => j.title), ["a2"]);
	assert.deepEqual((await ledger.list({ labels: ["phase:7"] })).map((j) => j.title), ["a2"]);
	assert.deepEqual((await ledger.list({ status: "in_progress" })).map((j) => j.title), ["b1"]);
	assert.deepEqual((await ledger.list({ status: ["open", "deferred"] })).map((j) => j.title), ["a1", "a2"]);
	assert.equal((await ledger.list({ limit: 0 })).length, 3, "limit 0 is unlimited");
	assert.equal((await ledger.list({ limit: 2 })).length, 2);
	assert.deepEqual((await ledger.ready({ project: "a" })).map((j) => j.title), ["a1"], "deferred is not ready");

	await ledger.close(a1.id, "first");
	await ledger.close(b1.id, "second");
	assert.deepEqual((await ledger.history()).map((j) => j.title), ["b1", "a1"]);
	assert.deepEqual((await ledger.list({ status: "closed", project: "a" })).map((j) => j.title), ["a1"]);
	assert.equal((await ledger.show(a2.id)).notes, "later");
	await assert.rejects(ledger.update(a2.id, { removeLabels: ["project:a"] }), /not dispatchable: missing project:/);
});

// ---------------------------------------------------------------------------
// import surface and atomicity
// ---------------------------------------------------------------------------

test("importJobs appends pre-built records and refuses a duplicate id", async (t) => {
	const scratch = createScratchLedger();
	t.after(() => scratch.cleanup());
	await scratch.ledger.importJobs([JOB, { ...JOB, id: "cp-b", blocked_by: ["cp-a"] }]);
	assert.equal(scratch.document().jobs.length, 2);
	await assert.rejects(scratch.ledger.importJobs([JOB]), /already in the ledger: cp-a/);
	assert.equal(scratch.document().jobs.length, 2, "a refused import writes nothing");
});

test(
	"a write that cannot land leaves the previous document intact",
	{ skip: process.getuid?.() === 0 ? "root ignores directory modes" : false },
	async (t) => {
		const scratch = createScratchLedger({ knownProjects: ["demo"] });
		t.after(() => scratch.cleanup());
		const before = readFileSync(jobsFile(scratch.path), "utf8");
		const dir = join(scratch.path, LAYOUT.runtimeDir);
		chmodSync(dir, 0o500);
		try {
			await assert.rejects(scratch.ledger.create({ title: "a", project: "demo", delivery: "pr" }), LedgerError);
			assert.equal(readFileSync(jobsFile(scratch.path), "utf8"), before);
		} finally {
			// Restore before the scratch cleanup runs, or rmSync cannot remove the dir.
			chmodSync(dir, 0o700);
		}
	},
);

test("a document written with type and priority still reads, and the next mutation writes it without them", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const file = join(scratch.path, LAYOUT.jobsFile);
	writeFileSync(
		file,
		JSON.stringify({
			schema_version: 1,
			prefix: "cp",
			jobs: [{ ...JOB, type: "epic", priority: 2 }],
		}),
	);
	const read = readJobsDocument(scratch.path);
	assert.equal("type" in (read.jobs[0] ?? {}), false);
	assert.equal("priority" in (read.jobs[0] ?? {}), false);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).jobs[0].type, "epic", "a read alone does not rewrite the file");

	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], now: () => NOW });
	await ledger.comment("cp-a", "touch");
	const onDisk = JSON.parse(readFileSync(file, "utf8"));
	assert.equal("type" in onDisk.jobs[0], false, "the mutation persisted the cleaned shape");
	assert.equal("priority" in onDisk.jobs[0], false);
	assert.equal(onDisk.jobs[0].comments.length, 1);
});

test("the retired type and priority values are archived durably before the mutation that drops them", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const file = join(scratch.path, LAYOUT.jobsFile);
	const archive = legacyArchiveFile(scratch.path);
	writeFileSync(
		file,
		JSON.stringify({
			schema_version: 1,
			prefix: "cp",
			jobs: [
				{ ...JOB, type: "epic", priority: 2 },
				{ ...JOB, id: "cp-b", priority: 0 },
				{ ...JOB, id: "cp-c" },
			],
		}),
	);
	assert.equal(existsSync(archive), false, "nothing is archived until a mutation is about to drop something");
	readJobsDocument(scratch.path);
	assert.equal(existsSync(archive), false, "a read drops the fields in memory only; it archives nothing and rewrites nothing");

	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], now: () => NOW });
	await ledger.comment("cp-a", "touch");

	const records = readFileSync(archive, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records.length, 1, "one record per mutation that dropped something");
	assert.equal(records[0].at, "2026-09-04T10:00:00Z");
	assert.equal(records[0].source, ledger.file, "the record names the canonical document it was taken from");
	assert.deepEqual(records[0].jobs, [
		{ id: "cp-a", fields: { type: "epic", priority: 2 } },
		{ id: "cp-b", fields: { priority: 0 } },
	], "every retired value survives, verbatim, and a job that carried none is not named");

	const onDisk = JSON.parse(readFileSync(file, "utf8"));
	assert.equal("type" in onDisk.jobs[0], false, "the document was cleaned only after the archive landed");
	assert.equal("priority" in onDisk.jobs[0], false);

	await ledger.comment("cp-a", "again");
	assert.equal(readFileSync(archive, "utf8").trim().split("\n").length, 1, "a cleaned document has nothing left to archive");
});

test("a mutation refuses and rewrites nothing when the retired fields cannot be archived", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const file = join(scratch.path, LAYOUT.jobsFile);
	writeFileSync(file, JSON.stringify({ schema_version: 1, prefix: "cp", jobs: [{ ...JOB, type: "epic", priority: 2 }] }));
	const before = readFileSync(file, "utf8");
	// A directory where the archive belongs: the append fails, the document does not.
	mkdirSync(legacyArchiveFile(scratch.path), { recursive: true });

	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], now: () => NOW });
	await assert.rejects(ledger.comment("cp-a", "touch"), (error: Error) => {
		assert.ok(error instanceof LedgerError);
		assert.match(error.message, /could not be archived/);
		assert.match(error.message, /cp-a/, "the refusal names the job whose values would have been lost");
		return true;
	});
	assert.equal(readFileSync(file, "utf8"), before, "failure-closed: the retired values are still on disk");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).jobs[0].comments.length, 0, "and the mutation did not land");
});

test("every path that reads a jobs document from disk goes through the legacy strip", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const legacy = { schema_version: 1, prefix: "cp", jobs: [{ ...JOB, type: "epic", priority: 2 }] };
	const write = () => writeFileSync(join(scratch.path, LAYOUT.jobsFile), JSON.stringify(legacy));

	write();
	assert.equal("type" in (readJobsDocument(scratch.path).jobs[0] ?? {}), false, "readJobsDocument");
	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], now: () => NOW });
	assert.equal("type" in (ledger.read().jobs[0] ?? {}), false, "Ledger.read");
	assert.equal("type" in (await ledger.show("cp-a")), false, "every query reads through Ledger.read");
	assert.equal("type" in (await ledger.comment("cp-a", "touch")), false, "Ledger#mutate drafts from Ledger.read");

	write();
	assert.equal(initJobsDocument(scratch.path, "cp").created, false, "an existing document is read, never recreated");
	assert.equal("type" in (initJobsDocument(scratch.path, "cp").document.jobs[0] ?? {}), false, "initJobsDocument");
});
