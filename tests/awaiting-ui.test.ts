/**
 * The Awaiting-you overlay is retired; what stays is the outer-prompt span
 * (`HumanPrompt`, `applyPromptWorking`) that session hooks still drive, and the
 * guard that no overlay command is registered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { commandPostSource } from "./harness/pi-child.ts";
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

test("decision overlay is not a live production path", () => {
	const source = commandPostSource();
	assert.ok(source.includes('name: "cp_decide"'));
	assert.ok(!source.includes('registerCommand("cp-decide"'));
	assert.ok(!source.includes('registerCommand("cp-authorize"'));
	assert.match(source, /Overlay retired/);
});
