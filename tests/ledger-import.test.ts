/**
 * `/cp-jobs import-beads` (spec 2026-09-04 §Migrations PR 2): open rows only,
 * ids preserved, timestamps normalised, comments and blocking deps carried,
 * a dependency on a closed row dropped with a note, duplicates and a foreign
 * prefix refused before anything is written, `.beads/` never touched.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyJobsDocument } from "../src/contracts.ts";
import { formatBeadsImport, importBeads, parseBeadsJsonl, planBeadsImport } from "../src/ledger-import.ts";
import { createScratchLedger } from "./harness/index.ts";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/beads-issues.jsonl");
const NOW = () => new Date("2026-09-04T12:00:00Z");

function seedBeads(home: string, text: string = readFileSync(FIXTURE, "utf8")): string {
	const dir = join(home, ".beads");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "issues.jsonl"), text);
	return join(dir, "issues.jsonl");
}

test("parseBeadsJsonl reads one object per line, skips blank lines and names a malformed line", () => {
	const rows = parseBeadsJsonl(readFileSync(FIXTURE, "utf8"));
	assert.deepEqual(rows.map((row) => row.id), ["cp-old1", "cp-open1", "cp-open2", "cp-def1", "cp-tomb"]);
	assert.equal(parseBeadsJsonl("\n\n").length, 0);
	assert.throws(() => parseBeadsJsonl('{"id":"cp-a","title":"t","status":"open"}\n{not json'), /line 2 is not JSON/);
	assert.throws(() => parseBeadsJsonl('{"title":"no id","status":"open"}'), /line 1 has no string id/);
});

test("planBeadsImport keeps open/in_progress/deferred rows, preserves ids, maps fields and normalises timestamps", () => {
	const plan = planBeadsImport(parseBeadsJsonl(readFileSync(FIXTURE, "utf8")), emptyJobsDocument("cp"), NOW);
	assert.deepEqual(plan.skipped, [
		{ id: "cp-old1", status: "closed" },
		{ id: "cp-tomb", status: "tombstone" },
	]);
	assert.deepEqual(plan.jobs.map((job) => job.id), ["cp-open1", "cp-open2", "cp-def1"]);

	const open2 = plan.jobs.find((job) => job.id === "cp-open2");
	assert.equal(open2?.status, "in_progress");
	assert.equal(open2?.assignee, "cp-open2");
	assert.equal(open2?.description, "look at X\nand Y");
	assert.equal(open2?.created_at, "2026-09-01T09:00:00Z", "sub-second precision is dropped");
	assert.equal(open2?.updated_at, "2026-09-02T09:00:00Z");
	assert.deepEqual(open2?.comments, [{ at: "2026-09-02T09:00:00Z", author: "0xb1ob", text: "blocker: waiting on operator" }], "an empty comment is dropped");

	const def1 = plan.jobs.find((job) => job.id === "cp-def1");
	assert.equal(def1?.status, "deferred");
	assert.equal(def1?.notes, "later");
	assert.deepEqual(def1?.labels, ["project:demo", "delivery:pr", "phase:7"], "a label with a comma is not a label");

	const open1 = plan.jobs.find((job) => job.id === "cp-open1");
	assert.deepEqual(open1?.blocked_by, ["cp-open2"]);
	assert.deepEqual(plan.dependencies_kept, [["cp-open1", "cp-open2"]]);
	assert.deepEqual(plan.dependencies_dropped, [{ blocked: "cp-open1", blocker: "cp-old1", reason: "blocker is closed in .beads (blocks nothing)" }]);
});

test("planBeadsImport refuses an id already in the document and a foreign prefix, before anything is built", () => {
	const rows = parseBeadsJsonl(readFileSync(FIXTURE, "utf8"));
	const doc = { ...emptyJobsDocument("cp"), jobs: [] as ReturnType<typeof emptyJobsDocument>["jobs"] };
	doc.jobs.push({
		id: "cp-open1",
		title: "already here",
		status: "open",
		labels: ["project:demo", "delivery:pr"],
		blocked_by: [],
		comments: [],
		created_at: "2026-09-04T12:00:00Z",
		updated_at: "2026-09-04T12:00:00Z",
	});
	assert.throws(() => planBeadsImport(rows, doc, NOW), /already in the ledger: cp-open1/);
	assert.throws(() => planBeadsImport(rows, emptyJobsDocument("cps"), NOW), /prefix cps- but the rows are cp-open1/);
});

test("a row's issue_type and priority are not carried, and a row missing labels still imports", () => {
	const plan = planBeadsImport(
		parseBeadsJsonl('{"id":"cp-x","title":"t","status":"open","issue_type":"saga","priority":9}'),
		emptyJobsDocument("cp"),
		NOW,
	);
	assert.equal("type" in (plan.jobs[0] ?? {}), false);
	assert.equal("priority" in (plan.jobs[0] ?? {}), false);
	assert.deepEqual(plan.jobs[0]?.labels, []);
	assert.equal(plan.jobs[0]?.created_at, "2026-09-04T12:00:00Z", "a missing timestamp is now");
});

test("importBeads writes the plan into the ledger, is refused the second time, and never touches .beads/", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const file = seedBeads(scratch.path);
	const before = readFileSync(file, "utf8");

	const report = await importBeads(scratch.ledger, { now: NOW });
	assert.equal(report.source, file);
	assert.deepEqual(scratch.document().jobs.map((job) => job.id), ["cp-open1", "cp-open2", "cp-def1"]);
	assert.deepEqual(await scratch.ledger.blockersOf("cp-open1"), ["cp-open2"]);
	assert.equal(readFileSync(file, "utf8"), before);

	const text = formatBeadsImport(report);
	assert.match(text, /imported 3 job\(s\) from .*issues\.jsonl/);
	assert.match(text, /skipped 2 closed\/tombstone row\(s\)/);
	assert.match(text, /kept cp-open1 -> cp-open2/);
	assert.match(text, /dropped cp-open1 -> cp-old1: blocker is closed/);

	await assert.rejects(importBeads(scratch.ledger, { now: NOW }), /already in the ledger: cp-open1, cp-open2, cp-def1/);
	assert.equal(scratch.document().jobs.length, 3);
});

test("importBeads names a missing .beads/issues.jsonl", async (t) => {
	const scratch = createScratchLedger();
	t.after(() => scratch.cleanup());
	await assert.rejects(importBeads(scratch.ledger), /no \.beads\/issues\.jsonl under/);
});
