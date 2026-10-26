/**
 * Ledger units no parent entry point reaches, verbatim from ledger.test.ts: recordAssessedRisk (classify-owned),
 * mintJobId's seeded draws, Ledger.history and importJobs (no production caller), and the legacy-strip sweep.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Job, LAYOUT } from "../src/contracts.ts";
import { initJobsDocument, Ledger, mintJobId, readJobsDocument } from "../src/ledger.ts";
import { recordAssessedRisk } from "../src/ledger-filter.ts";
import { createScratchLedger } from "./harness/index.ts";

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

// Retained subset of "list filters AND labels and statuses, limit 0 is unlimited, history is newest-closed first":
// P15-jobs-lifecycle pins the filters, limits, ready and the unlabel refusal through cp_job; these lines have no tool.
test("history is newest-closed first and list takes a status array", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["a", "b"] });
	t.after(() => scratch.cleanup());
	let tick = 0;
	const ledger = new Ledger({ home: scratch.path, now: () => new Date(NOW.getTime() + tick++ * 1000) });
	const a1 = await ledger.create({ title: "a1", project: "a", delivery: "pr", kind: "ship" });
	const a2 = await ledger.create({ title: "a2", project: "a", delivery: "local", kind: "research" });
	const b1 = await ledger.create({ title: "b1", project: "b", delivery: "pr" });
	await ledger.claim(b1.id, b1.id);
	await ledger.update(a2.id, { status: "deferred", notes: "later", addLabels: ["phase:7"] });

	assert.deepEqual((await ledger.list({ status: ["open", "deferred"] })).map((j) => j.title), ["a1", "a2"]);

	await ledger.close(a1.id, "first");
	await ledger.close(b1.id, "second");
	assert.deepEqual((await ledger.history()).map((j) => j.title), ["b1", "a1"]);
});

test("importJobs appends pre-built records and refuses a duplicate id", async (t) => {
	const scratch = createScratchLedger();
	t.after(() => scratch.cleanup());
	await scratch.ledger.importJobs([JOB, { ...JOB, id: "cp-b", blocked_by: ["cp-a"] }]);
	assert.equal(scratch.document().jobs.length, 2);
	await assert.rejects(scratch.ledger.importJobs([JOB]), /already in the ledger: cp-a/);
	assert.equal(scratch.document().jobs.length, 2, "a refused import writes nothing");
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
