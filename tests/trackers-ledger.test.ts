import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJobsDocument } from "../src/contracts.ts";
import { createScratchLedger } from "./harness/index.ts";

const input = (item_id: string, title = `bead ${item_id}`) => ({
	title, project: "demo", delivery: "pr" as const, kind: "ship" as const,
	externalRef: `br --db '/dbs/demo.db' show ${item_id} --json`, tracker: { connection_id: "demo-beads", item_id },
});

test("createTracked mints exactly one job per (connection_id, item_id), even under concurrency", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const [a, b] = await Promise.all([scratch.ledger.createTracked(input("b-1")), scratch.ledger.createTracked(input("b-1"))]);
	assert.equal(a.job.id, b.job.id);
	assert.deepEqual([a.created, b.created].sort(), [false, true]);
	assert.equal(scratch.document().jobs.length, 1);
	assert.deepEqual({ ...scratch.document().jobs[0]!.tracker, linked_at: "x" }, { connection_id: "demo-beads", item_id: "b-1", linked_at: "x" });
	assert.equal(scratch.ledger.findTracked("demo-beads", "b-1")?.id, a.job.id);
	assert.equal(scratch.ledger.findTracked("demo-beads", "b-2"), undefined);
});

test("closed and dropped linked jobs still dedupe; equal titles on different keys are distinct jobs", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const closed = await scratch.ledger.createTracked(input("b-1", "same title"));
	await scratch.ledger.close(closed.job.id, "https://github.com/o/r/pull/1");
	assert.deepEqual(await scratch.ledger.createTracked(input("b-1", "same title")), { job: await scratch.ledger.show(closed.job.id), created: false });
	const dropped = await scratch.ledger.createTracked(input("b-2", "same title"));
	assert.equal(dropped.created, true, "an equal title on another key is not a duplicate");
	await scratch.ledger.drop(dropped.job.id, "not needed");
	assert.equal((await scratch.ledger.createTracked(input("b-2"))).created, false);
	assert.equal(scratch.document().jobs.length, 2);
});

test("an open unlinked job with the same ref is refused, never linked automatically", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const legacy = await scratch.ledger.create({ title: "hand filed", project: "demo", delivery: "pr", externalRef: input("b-1").externalRef });
	await assert.rejects(scratch.ledger.createTracked(input("b-1")), new RegExp(`${legacy.id} already tracks .* without a tracker link; not linked automatically`));
	assert.equal(scratch.document().jobs.length, 1);
	assert.equal(scratch.document().jobs[0]!.tracker, undefined);
});

test("ordinary create is unchanged by tracker links, and the document refuses a duplicate key", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const tracked = await scratch.ledger.createTracked(input("b-1", "shared title"));
	await scratch.ledger.close(tracked.job.id, "done");
	const plain = await scratch.ledger.create({ title: "shared title", project: "demo", delivery: "pr" });
	assert.notEqual(plain.id, tracked.job.id);
	assert.equal(plain.tracker, undefined);
	const doc = scratch.document();
	const duplicate = { ...doc, jobs: [...doc.jobs, { ...doc.jobs[0]!, id: "cp-dupe", status: "open" as const, closed_at: undefined, close_reason: undefined }] };
	const result = validateJobsDocument(JSON.parse(JSON.stringify(duplicate)));
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.errors.join("\n"), /cp-dupe and .* link the same tracker item demo-beads\/b-1/);
});
