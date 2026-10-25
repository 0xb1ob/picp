/**
 * Behavior 09, P10c: what cp_status_block tells the operator awaits them, through a real pi parent and a mock model.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../../src/awaiting.ts";
import { isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { MAX_CELL_CHARS } from "../../src/status-block.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "../harness/index.ts";

const REWORD = "Ship cp-x, drop it, or open a follow-up?";
const LINTED = [
	"Authorize the 5 destructive findings before the sweep?",
	"Should I go ahead with the destructive sweep across every registered project now?",
	"ok to deploy the sweep?",
	"go / no-go on the sweep?",
	"Please approve the sweep",
];
const LONG = `Postgres or sqlite for ${"x".repeat(MAX_CELL_CHARS - 24)}?`;

type Row = { type: string; decision: string; why: string; blocks: string; job_id?: string };
const row = (type: string, decision: string, job_id?: string): Row => ({ type, decision, why: "w", blocks: "b", ...(job_id ? { job_id } : {}) });
const status = (awaiting: Row[] | (() => Row[])) => ({
	kind: "tool_calls" as const,
	calls: [{ name: "cp_status_block", args: typeof awaiting === "function" ? () => ({ width: 200, awaiting: awaiting() }) : { width: 200, awaiting } }],
});

/** The Awaiting-you section, from its first line to the blank line after it. */
function awaitingSection(text: string): string[] {
	const lines = text.split("\n");
	const rest = lines.slice(lines.findIndex((line) => line.startsWith("Awaiting you")));
	const end = rest.indexOf("");
	return end === -1 ? rest : rest.slice(0, end);
}

/** Rows rendered as open questions: the bullets above the cp_decide hint and the notices. */
function openRows(text: string): string[] {
	const section = awaitingSection(text);
	const stop = section.findIndex((line) => line.startsWith("answer with cp_decide") || line.startsWith("Not asked"));
	return (stop === -1 ? section : section.slice(0, stop)).filter((line) => line.startsWith("  - "));
}

test("decisions: cp_status_block renders a row open only when the store holds it open, and every other row as a notice", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const store = new AwaitingStore({ home: home.path });
	const provider = await MockProvider.start();
	const model = provider.addScript("p10c-rows", [
		status([row("authorization", "Ship the destructive findings?", "cp-x")]),
		status(LINTED.map((decision) => row("approval", decision, "cp-y"))),
		status([
			row("design", "Postgres or sqlite?", "cp-db"),
			row("authorization", "Ship cp-x?", "cp-x"),
			row("approval", "Approve the sweep?", "cp-y"),
			row("approval", "Merge PR #47 and drop cp-to39?", "cp-z"),
			row("approval", "Ship cp-q, drop it, or open a follow-up?", "cp-q"),
		]),
		status([row("approval", "Merge PR #9?")]),
		status([row("design", LONG)]),
		status(() => {
			// The operator answers the long design row between turns, as /cp-awaiting would.
			const file = join(home.path, LAYOUT.awaitingFile);
			const doc = JSON.parse(readFileSync(file, "utf8"));
			Object.assign(doc.items.find((item: { decision: string }) => item.decision === LONG), {
				state: "answered", answer: "postgres", answered_at: isoTimestamp(), answered_by: "operator dialog (tui)",
			});
			writeFileSync(file, JSON.stringify(doc));
			return [row("design", LONG)];
		}),
		{ kind: "text", text: "Status rendered." },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agentDir.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		home.cleanup();
	});

	await child.prompt("Render the status block.");
	await child.waitForSettled(90_000);
	const ends = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "cp_status_block");
	assert.equal(ends.length, 6, JSON.stringify(ends.map((end) => end.isError)));
	for (const end of ends) assert.notEqual(end.isError, true, JSON.stringify(end.result));
	const texts = ends.map((end) => (end.result as { content: { text: string }[] }).content[0]!.text);

	// An authorization row is refused, never rendered open, and mints nothing (cp-nz95).
	assert.equal(openRows(texts[0]!).length, 0);
	assert.match(texts[0]!, /Awaiting you: none/);
	assert.match(texts[0]!, /Not asked \u2014 refused by the awaiting store \(1\)/);
	assert.match(texts[0]!, /refused: authorization items are derived from state\/checkpoints.*never declared.*cp_decide/);
	assert.equal(store.list().some((item) => item.job_id === "cp-x"), false, "the status block must not mint an authorization");

	// Authorization-shaped prose is stored open with a lint quoting the trigger and keeping the rewording.
	assert.equal(openRows(texts[1]!).length, LINTED.length);
	assert.match(texts[1]!, /lint: wording "Authorize"/);
	const lints = texts[1]!.split("\n").filter((line) => line.trim().startsWith("lint: wording"));
	assert.equal(lints.length, LINTED.length, texts[1]);
	for (const lint of lints) assert.ok(lint.includes(REWORD), `lint lost its rewording: ${lint}`);
	assert.equal(store.list("open").filter((item) => LINTED.includes(item.decision)).length, LINTED.length);

	// Mixed batch: every row rendered open is open in the store; the deferred merge ask and the refusal are notices.
	const open = new Set(store.list("open").map((item) => item.id));
	const rendered = openRows(texts[2]!).map((line) => /^ {2}- (aw-\S+) /.exec(line)?.[1]);
	assert.equal(rendered.length, 3, texts[2]);
	for (const id of rendered) assert.ok(id && open.has(id), `${id} was rendered open but is not open in the store`);
	assert.match(texts[2]!, /answer with cp_decide \(3 open\)/);
	assert.match(texts[2]!, /Not asked yet \u2014 not ready to merge \(1/);
	assert.match(texts[2]!, /Not asked \u2014 refused by the awaiting store \(1\)/);
	assert.equal(store.list("deferred").filter((item) => item.job_id === "cp-z").length, 1);

	// A store that throws is a refusal carrying its message, not an unanswerable open row.
	assert.equal(openRows(texts[3]!).length, 0);
	assert.match(texts[3]!, /refused: a merge\/ship ask must name the job it concerns/);

	// Re-rendering an answered max-length decision is a bounded notice that keeps its actionable clause.
	assert.equal(openRows(texts[4]!).length, 1);
	assert.equal(openRows(texts[5]!).length, 0);
	const notice = texts[5]!.split("\n").find((line) => line.trim().startsWith("refused:"));
	assert.ok(notice?.includes("already answered in state/awaiting.json"), notice);
	assert.ok(notice?.includes("Ask a new question if it needs deciding again"), `the actionable clause was cut: ${notice}`);
	assert.equal(store.list("answered").length, 1, "nothing was re-asked");
});
