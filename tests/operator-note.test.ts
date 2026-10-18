/**
 * autonomy-programme-cur.5.3: the operator note stays under its line cap and
 * carries both ask/decide lists verbatim (structure test — no model needed).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	OPERATOR_ASK_LIST,
	OPERATOR_DECIDE_LIST,
	OPERATOR_NOTE,
	OPERATOR_NOTE_MAX_LINES,
	OPERATOR_REMOTE_DEVICE_RULE,
} from "../src/operator-note.ts";
import bridgeExtension from "../extensions/cp-bridge/index.ts";

test("the operator note is at or under its line cap", () => {
	const lines = OPERATOR_NOTE.split("\n").filter((line, i, all) => i < all.length - 1 || line !== "");
	assert.ok(
		lines.length <= OPERATOR_NOTE_MAX_LINES,
		`operator note is ${lines.length} lines, cap is ${OPERATOR_NOTE_MAX_LINES}`,
	);
});

test("the operator note carries both ask/decide lists verbatim", () => {
	assert.ok(OPERATOR_NOTE.includes(OPERATOR_ASK_LIST));
	assert.ok(OPERATOR_NOTE.includes(OPERATOR_DECIDE_LIST));
	// Every escalation kind the ticket names must appear as a distinct item.
	for (const item of [
		"mandate creation for work the human did not ask for",
		"product ambiguity",
		"scope expansion",
		"risk high/irreversible",
		"loop exhausted",
		"budget",
		"conflicting acceptance",
		"merge refused",
		"mission end",
	]) {
		assert.ok(OPERATOR_ASK_LIST.includes(item), `ask list missing "${item}"`);
	}
	for (const item of [
		"in-scope plan approval",
		"how-questions",
		"review findings",
		"test failures",
		"next job",
		"merge when repo permits",
		"bounded recovery",
		"token-cap raise within the ceiling",
	]) {
		assert.ok(OPERATOR_DECIDE_LIST.includes(item), `decide list missing "${item}"`);
	}
});

// #322: an owner-reported defect or asked-for feature was carded "Fix now?" because the list asked on every mandate
// creation. The grant clause and the kept card (ambiguity, research-to-build) must both reach the main LLM.
test("a named defect or feature is the grant; ambiguous and research-to-build asks keep the card", () => {
	const asks = OPERATOR_NOTE.split("## Ask vs decide")[1]?.split("## Plan review")[0] ?? "";
	assert.ok(asks.includes("a message naming a defect or feature in a registered project is the grant"));
	assert.ok(asks.includes("an ambiguous request or a research-to-build choice still asks"));
	assert.equal(OPERATOR_ASK_LIST.startsWith("mandate creation, "), false, "bare mandate creation is an ask again");
});

test("the note never mentions fleet tools or state/ as things to call or touch", () => {
	assert.equal(OPERATOR_NOTE.includes("cp_dispatch"), false);
	assert.equal(OPERATOR_NOTE.includes("cp_integrate"), false);
	assert.match(OPERATOR_NOTE, /never touch `state\/`/);
	assert.ok(OPERATOR_NOTE.includes("`<home>/.pi-command-post/operator/`"), "the note must name the operator workspace (docs/storage.md)");
});

// autonomy-programme-cur.2.5: the note must never tell the main LLM to ask for
// caps/expiry, and must pin the operator's exact mandate-template sentence.
test("the mandate template tells the main LLM not to ask for caps, expiry or actions", () => {
	const sentence =
		"The human names a project (or the several projects one topic spans) and an objective; that is the whole mandate. Do not " +
		"ask for caps, expiry or actions \u2014 they come from the home's defaults. Issue " +
		"it, then echo the effective grant in one line (fields and their sources) and " +
		"say `stop` revokes it. Ask only if the objective is genuinely ambiguous about " +
		"*what* to do.";
	assert.ok(
		OPERATOR_NOTE.replace(/\s+/g, " ").includes(sentence.replace(/\s+/g, " ")),
		"operator note is missing (or has drifted from) the mandate-defaults sentence",
	);
});

test("the mandate template never asks for expiry, spend_cap or job_cap by name", () => {
	const section = OPERATOR_NOTE.split("## Mandate template")[1]?.split("## Ask vs decide")[0] ?? "";
	for (const stale of ["expiry,", "spend_cap", "job_cap,"]) {
		assert.equal(section.includes(stale), false, `mandate template still names ${stale}`);
	}
});

test("the note routes preferences to standing orders and lessons to a capture: line, with no hiccups store", () => {
	const capped = OPERATOR_NOTE.split("\n").slice(0, OPERATOR_NOTE_MAX_LINES).join("\n");
	assert.ok(capped.includes("capture:"), "capture: line must be inside the first 60 lines");
	assert.ok(capped.includes("data/standing-orders.md"), "standing-orders line must be inside the first 60 lines");
	assert.doesNotMatch(OPERATOR_NOTE, /hiccups/);
});

test("the operator note carries exactly one verbatim dashboard thread instruction", () => {
	const sentence = "A dashboard message with thread=<tag> means: pass thread=<tag> on its answer/ask, and cp_parent thread_bind any job it creates.";
	assert.equal(OPERATOR_NOTE.split("\n").filter(line => line === sentence).length, 1);
});

// cp-c1ur N4/N13: a restart asked for only in chat never happened, and the operator re-read diffs cp_review owned.
// Both rules must sit inside the 60-line cap, in the sections the main LLM reads for asks and for file access.
test("the note makes a human-only step a cp_parent ask and leaves the diff to cp_review", () => {
	const capped = OPERATOR_NOTE.split("\n").slice(0, OPERATOR_NOTE_MAX_LINES).join("\n");
	const asks = capped.split("## Ask vs decide")[1]?.split("## Plan review")[0] ?? "";
	assert.match(asks, /a step only the human can take \(restart, login, a click on a host\) is a `cp_parent ask`/);
	assert.match(capped, /`cp_review` owns the diff: rely on its verdict, read a diff only when a wake escalates it/);
});

// Remote dashboard (Decision es-6a78c3): the note carries the remote device-management prohibition once, inside the cap,
// and the bridge still injects that exact note. This proves the instruction is delivered, not that a model obeys it.
test("the operator note forbids device pairing and device-list edits on a remote-originated request", async () => {
	const sentence = "On a remote-originated request, never pair devices, run `cp-tunnel pair`, or edit the device list, including through delegated or equivalent shell/file operations.";
	assert.equal(OPERATOR_REMOTE_DEVICE_RULE, sentence);
	const capped = OPERATOR_NOTE.split("\n").slice(0, OPERATOR_NOTE_MAX_LINES);
	assert.equal(capped.filter((line) => line === sentence).length, 1);
	assert.equal(OPERATOR_NOTE.split(sentence).length, 2, "exactly once");
	const handlers: Array<(event: unknown) => unknown> = [];
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown) => unknown) => { if (event === "before_agent_start") handlers.push(handler); },
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as never);
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
	for (const handler of handlers) await handler(event);
	assert.equal(event.systemPromptOptions.sections.operator_note, OPERATOR_NOTE);
	assert.ok(event.systemPromptOptions.sections.operator_note?.includes(sentence));
});
