/**
 * The outer-prompt span (`HumanPrompt`, `applyPromptWorking`) only reaches the interactive TUI: setWorkingVisible is a
 * no-op in RPC mode and nothing reads `open`, so no e2e entry point observes it. Moved verbatim from awaiting-ui.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPromptWorking, HumanPrompt } from "../src/awaiting-ui.ts";

test("HumanPrompt start then end clears open", () => {
	const prompt = new HumanPrompt();
	assert.equal(prompt.open, false);
	prompt.start();
	assert.equal(prompt.open, true);
	prompt.end();
	assert.equal(prompt.open, false);
});

test("applyPromptWorking records setWorkingVisible(false) then (true) and pairs the flag", () => {
	const prompt = new HumanPrompt();
	const calls: boolean[] = [];
	const ui = { setWorkingVisible: (visible: boolean) => calls.push(visible) };
	applyPromptWorking(ui, prompt, "start");
	assert.equal(prompt.open, true);
	assert.deepEqual(calls, [false]);
	applyPromptWorking(ui, prompt, "end");
	assert.equal(prompt.open, false);
	assert.deepEqual(calls, [false, true]);
});
