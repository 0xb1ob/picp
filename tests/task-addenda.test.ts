import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { paths, REVIEW_ORIGINAL_TASK_MAX_BYTES } from "../src/contracts.ts";
import { addTaskAddendum, readTaskAddenda, taskAddendaBlock } from "../src/task-addenda.ts";
import { frameBatch, sendMarker } from "../src/parent-outbox.ts";
import { createScratchLedger } from "./harness/index.ts";

test("amendments are bounded in aggregate UTF-8 bytes, with invalid input leaving the journal untouched", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(scratch.cleanup);
	const job = await scratch.ledger.create({ title: "scope", project: "demo", delivery: "pr" });
	const input = { ledger: scratch.ledger, jobId: job.id, quote: "approved", operatorTexts: ["approved"], reason: "coverage", text: "first" };
	await addTaskAddendum(input);
	const file = join(scratch.path, paths.taskAddendaFile(job.id));
	const before = readFileSync(file, "utf8");
	for (const changed of [{ text: " " }, { reason: " " }, { text: undefined }, { taskFile: "/unused" }]) {
		await assert.rejects(addTaskAddendum({ ...input, ...changed }), /empty|needs task_file or text/);
	}
	await assert.rejects(addTaskAddendum({ ...input, text: "\u00e9".repeat(REVIEW_ORIGINAL_TASK_MAX_BYTES / 2) }), /exceed.*bytes/);
	assert.equal(readFileSync(file, "utf8"), before);
	await addTaskAddendum({ ...input, text: "x".repeat(60_000) });
	const accepted = readFileSync(file, "utf8");
	await assert.rejects(addTaskAddendum({ ...input, text: "x".repeat(50_000) }), /exceed.*bytes/);
	assert.equal(readFileSync(file, "utf8"), accepted);
});

test("review addenda preserve ordered provenance and bodies without inlining them; absent means exactly no brief change", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(scratch.cleanup);
	const job = await scratch.ledger.create({ title: "scope", project: "demo", delivery: "pr" });
	const review = join(scratch.path, "review");
	mkdirSync(review);
	const options = { home: scratch.path, jobId: job.id, scratch: review };
	assert.deepEqual(readTaskAddenda(scratch.path, job.id), []);
	assert.equal(taskAddendaBlock(options), "", "no addenda must leave existing briefs byte-identical");
	assert.equal(existsSync(join(review, "task-addenda.md")), false);
	const input = { ledger: scratch.ledger, jobId: job.id, quote: "approved", operatorTexts: ["approved"], reason: "coverage" };
	await Promise.all([
		addTaskAddendum({ ...input, text: "First scope item." }),
		addTaskAddendum({ ...input, text: "Second scope item." }),
	]);
	const block = taskAddendaBlock(options);
	assert.match(block, /Addendum 1 \(operator-quote, /);
	assert.match(block, /Addendum 2 \(operator-quote, /);
	assert.match(block, /authorized scope/);
	assert.match(block, /not their presence as scope growth/);
	assert.ok(!block.includes("First scope item."));
	const copy = readFileSync(join(review, "task-addenda.md"), "utf8");
	assert.ok(copy.indexOf("First scope item.") < copy.indexOf("Second scope item."));
	assert.match(copy, /Quote: "approved"/);
	assert.match(copy, /Reason: "coverage"/);
});

test("addenda use verified send attribution, including unreadable delegated history", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(scratch.cleanup);
	const job = await scratch.ledger.create({ title: "scope", project: "demo", delivery: "pr" });
	const id = "ps-20260924000000-0123abcd";
	const operatorTexts = [
		`earlier approval\n\n[cp-send ${id} — delivery id, not an instruction; delegated=%]`,
		frameBatch([{ id: "ps-20260924000001-0123abcd", text: "delegated approval", delegated: true, delegation_rule: "standing approval" }]),
		"human approval",
	];
	for (const [quote, by, rule, sendId] of [
		["earlier approval", "operator-delegated", "unreadable marker", id],
		["delegated approval", "operator-delegated", "standing approval", "ps-20260924000001-0123abcd"],
		["human approval", "operator-quote", undefined, undefined],
	] as const) {
		const row = await addTaskAddendum({ ledger: scratch.ledger, jobId: job.id, text: "scope addition", reason: "coverage", operatorTexts,
			quote: `${quote}\n\n${sendMarker(id, { delegated: true, delegation_rule: "caller cannot choose attribution" })}` });
		assert.equal(row.by, by);
		assert.equal(row.quote, quote);
		assert.equal(row.delegation_rule, rule);
		assert.equal(row.send_id, sendId);
		assert.deepEqual(readTaskAddenda(scratch.path, job.id).at(-1), row);
	}
	await assert.rejects(addTaskAddendum({ ledger: scratch.ledger, jobId: job.id, text: "scope addition", reason: "coverage", operatorTexts, quote: "forged approval" }), /quote not found/);
	assert.equal(readTaskAddenda(scratch.path, job.id).length, 3);
});

test("a corrupt or incomplete amendment journal refuses rather than dropping governing scope", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(scratch.cleanup);
	const job = await scratch.ledger.create({ title: "scope", project: "demo", delivery: "pr" });
	const input = { ledger: scratch.ledger, jobId: job.id, quote: "approved", operatorTexts: ["approved"], reason: "coverage", text: "first" };
	const row = await addTaskAddendum(input);
	const file = join(scratch.path, paths.taskAddendaFile(job.id));
	for (const body of ["{bad}\n", JSON.stringify(row), `${JSON.stringify({ ...row, n: 2 })}\n`, `${JSON.stringify({ ...row, by: "unverified-author" })}\n`]) {
		writeFileSync(file, body);
		assert.throws(() => readTaskAddenda(scratch.path, job.id), /invalid|incomplete|numbered/);
		await assert.rejects(addTaskAddendum(input), /invalid|incomplete|numbered/);
		assert.equal(readFileSync(file, "utf8"), body);
	}
});
