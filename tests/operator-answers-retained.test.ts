/**
 * Answers-journal units cp_parent answer cannot reach (P10b), test bodies moved verbatim from
 * tests/operator-answers.test.ts; bench() drops the unused FleetStore jobs option. Secrets are built at runtime.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { OperatorAnswers } from "../src/operator-answers.ts";
import { appendAnswerLine } from "../src/viewer/control-audit.ts";
import { operatorAnswersFile, readAnswers } from "../src/viewer/control-files.ts";
import { createScratchHome } from "./harness/index.ts";

const ghShaped = `gh${"p"}_${"A".repeat(36)}`;
const keyHeader = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;

async function bench(t: TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	const answers = new OperatorAnswers(stateDir);
	return { home: home.path, stateDir, answers, file: operatorAnswersFile(stateDir), lines: () => readFileSync(operatorAnswersFile(stateDir), "utf8").split("\n").filter(Boolean) };
}

const input = { project: "demo", question: "Does it work?", answer: "Yes." };

test("PR1: a schedule result card is keyed by its source, redacted, and read back with its source; a bad source is skipped", async (t) => {
	const b = await bench(t);
	const source = { kind: "schedule" as const, schedule_id: "sch-123456", run_id: "run-20260701060000-abcdef", source_key: "run-20260701060000-abcdef:closed", outcome: "partial" };
	const card = { project: "demo", title: "Nightly report — run partial", text: `token ${ghShaped} here`, evidence_paths: [], job_id: null, source };
	const first = b.answers.postScheduleResult(card);
	assert.equal(b.answers.postScheduleResult(card).state, "duplicate", "a retry after a crash reuses the first card");
	assert.equal(b.lines().length, 1);
	const line = JSON.parse(b.lines()[0]!);
	assert.deepEqual([line.by, line.source, line.answer.includes(ghShaped)], ["schedule", source, false]);
	assert.deepEqual(b.answers.list().map((item) => [item.id, item.source]), [[first.answer.id, source]]);
	assert.throws(() => b.answers.postScheduleResult({ ...card, source: { ...source, source_key: "other" }, text: `${keyHeader}\nMIIE` }), /private key block/);
	appendAnswerLine(b.stateDir, { ...line, id: "ans-bbbbbbbbbbbb", source: { ...source, extra: 1 } });
	assert.equal(readAnswers(b.stateDir).skipped, 1);
});

test("fold: ack sets acked_at once; unknown acks and garbage count as skipped; a torn last line is ignored", async (t) => {
	const b = await bench(t);
	const { answer } = b.answers.post(input);
	const ack = (id: string, at: string) => appendAnswerLine(b.stateDir, { type: "acked", by: "viewer", id, at, peer: "127.0.0.1" });
	ack(answer.id, "2026-01-01T00:00:00Z");
	ack(answer.id, "2026-02-02T00:00:00Z"); // a repeat is ignored, not counted
	ack("ans-000000000000", "2026-01-01T00:00:00Z");
	appendFileSync(b.file, "not json\n");
	assert.deepEqual(readAnswers(b.stateDir).answers.map((item) => [item.acked_at, item.acked_peer]), [["2026-01-01T00:00:00Z", "127.0.0.1"]]);
	assert.equal(readAnswers(b.stateDir).skipped, 2);
	assert.deepEqual(b.answers.open(), []);
	appendFileSync(b.file, '{"type":"posted","by":"bridge","id":"ans-0123');
	assert.deepEqual([readAnswers(b.stateDir).answers.length, readAnswers(b.stateDir).skipped], [1, 2]);
	assert.deepEqual(readAnswers(join(b.stateDir, "missing")), { exists: false, answers: [], skipped: 0, error: null });
});

test("no push: the push sweep never reads the answers journal, and posting creates no ask", async (t) => {
	const b = await bench(t);
	b.answers.post(input);
	assert.doesNotMatch(readFileSync(join(import.meta.dirname, "..", "src", "push", "sweep.ts"), "utf8"), /answers\.jsonl|operator-answers|readAnswers/);
	assert.equal(existsSync(join(b.stateDir, "operator", "asks.jsonl")), false);
});
