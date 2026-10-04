/**
 * unload-parent PR3: the send-first wake hold (src/send-first-gate.ts), pure state.
 * The hook wiring is covered in tests/stale-notice-context.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { frameBatch } from "../src/parent-outbox.ts";
import { SEND_FIRST_HOLD_MS, SendFirstGate } from "../src/send-first-gate.ts";

const SEND = { id: "ps-20300101000000-0000000a", text: "SYNTH operator question" };
const cleanEnd = { type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] };
const toolEnd = { type: "turn_end", message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ role: "toolResult" }] };

test("nothing is held while no operator send is unanswered", () => {
	const gate = new SendFirstGate<string>(() => 0);
	assert.equal(gate.offer("ci", "W1"), "send");
	gate.userMessage("custom", frameBatch([SEND]));
	gate.userMessage("assistant", frameBatch([SEND]));
	assert.equal(gate.offer("ci", "W2"), "send", "only a user message carries a landed send");
	assert.deepEqual(gate.flush(), []);
});

test("a landed send holds every wake but answered until a clean turn_end answers it", () => {
	const gate = new SendFirstGate<string>(() => 0);
	gate.userMessage("user", frameBatch([SEND]));
	assert.equal(gate.unanswered, 1);
	assert.equal(gate.offer("envelope", "W1"), "hold");
	assert.equal(gate.offer("recovery", "W2"), "hold");
	assert.equal(gate.offer("answered", "A1"), "send", "an answered decision is never held");
	gate.turnEnd(toolEnd);
	assert.deepEqual(gate.flush(), [], "a tool-call turn does not answer the send");
	gate.turnEnd(cleanEnd);
	assert.equal(gate.unanswered, 0);
	assert.deepEqual(gate.flush(), ["W1", "W2"], "released in offer order");
	assert.deepEqual(gate.flush(), [], "released once");
	assert.equal(gate.offer("ci", "W3"), "send");
});

test("a settled run releases held wakes even without a clean answer", () => {
	const gate = new SendFirstGate<string>(() => 0);
	gate.userMessage("user", frameBatch([SEND]));
	assert.equal(gate.offer("ci", "W1"), "hold");
	gate.settled();
	assert.deepEqual(gate.flush(), ["W1"]);
});

test("held wakes go out after SEND_FIRST_HOLD_MS even while the send is still unanswered", () => {
	let now = 1_000;
	const gate = new SendFirstGate<string>(() => now);
	gate.userMessage("user", frameBatch([SEND]));
	assert.equal(gate.offer("ci", "W1"), "hold");
	now += SEND_FIRST_HOLD_MS - 1;
	assert.equal(gate.offer("wedged", "W2"), "hold");
	assert.deepEqual(gate.flush(), []);
	now += 1;
	assert.deepEqual(gate.flush(), ["W1", "W2"], "the oldest hold sets the deadline");
	assert.ok(SEND_FIRST_HOLD_MS <= 120_000, "the hold stays within the 120 s acceptance bound");
	assert.equal(gate.offer("ci", "W3"), "hold", "still unanswered: a new wake starts a new hold");
	now += SEND_FIRST_HOLD_MS;
	assert.deepEqual(gate.flush(), ["W3"]);
});
