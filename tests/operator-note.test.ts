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
} from "../src/operator-note.ts";

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
		"mandate creation",
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
