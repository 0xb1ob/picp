/** The /cp-awaiting listing text: rows, optional context under a row, and the answer/inspect hints. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DECIDE_ANSWER_HINT, DECIDE_INSPECT_HINT, formatDecideListing } from "../extensions/command-post/index.ts";

test("the listing indents context under its row and ends with the answer and inspect hints", () => {
	const lines = formatDecideListing([{ line: "aw-1 ship it?", context: ["evidence for cp-x"] }]).split("\n");
	assert.equal(lines[0], "Awaiting you:");
	assert.equal(lines[1], "  - aw-1 ship it?");
	assert.equal(lines[2], "      evidence for cp-x");
	assert.equal(lines.at(-2), DECIDE_ANSWER_HINT);
	assert.equal(lines.at(-1), DECIDE_INSPECT_HINT);
});

test("an empty listing says none", () => {
	assert.equal(formatDecideListing([]), "Awaiting you: none");
});
