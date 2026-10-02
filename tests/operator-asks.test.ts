import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperatorAsks } from "../src/operator-asks.ts";

const input = { project: "example", question: "Proceed?", options: [{ label: "yes", consequence: "Changes scope" }], recommendation: "yes" };

function store(t: import("node:test").TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "operator-asks-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return new OperatorAsks(join(dir, "asks.jsonl"));
}

test("operator asks persist open, answer and withdraw events without rewriting history", (t) => {
	const asks = store(t);
	assert.deepEqual(asks.open(), []);
	const first = asks.open({ ...input, source_escalation: "es-example", job_ids: ["cp-example"], evidence_paths: ["report.md"] });
	assert.match(first.id, /^ask-[a-f0-9]+$/);
	const before = readFileSync(asks.file, "utf8");
	const words = "  Yes, proceed.\nWith care.  ";
	asks.answer(first.id, words);
	const second = asks.open(input);
	asks.withdraw(second.id, "No longer needed");
	const reloaded = new OperatorAsks(asks.file);
	assert.deepEqual(reloaded.open(), []);
	assert.equal(reloaded.list()[0]!.answer, words);
	assert.equal(reloaded.list()[1]!.reason, "No longer needed");
	assert.equal(reloaded.recent(1)[0]!.id, second.id);
	assert.ok(readFileSync(asks.file, "utf8").startsWith(before));
	assert.equal(readFileSync(asks.file, "utf8").trim().split("\n").length, 4);
	assert.throws(() => asks.answer(first.id, "again"), /not open/);
	assert.throws(() => asks.answer("ask-unknown", "yes"), /unknown/);
	assert.throws(() => asks.withdraw("ask-unknown", "gone"), /unknown/);
});

test("operator asks validate before append and shorten consequences with an ellipsis", (t) => {
	const asks = store(t);
	for (const invalid of [{ ...input, question: " " }, { ...input, options: [] }, { ...input, options: Array(6).fill(input.options[0]) }]) {
		assert.throws(() => asks.open(invalid));
	}
	const opened = asks.open({ ...input, options: [{ label: "yes", consequence: "x".repeat(201) }] });
	assert.equal(opened.options[0]!.consequence, "x".repeat(199) + "\u2026");
	assert.throws(() => asks.answer(opened.id, " "));
	assert.throws(() => asks.withdraw(opened.id, " "));
	assert.equal(asks.open().length, 1);
});
