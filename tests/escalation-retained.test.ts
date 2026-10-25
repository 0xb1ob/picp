/**
 * Escalation retained (P10d): queue-timed supersede races and an injected awaiting follow-up failure have no entry
 * point a mock-model parent reaches; the rest moved to tests/e2e/decisions-p10d.test.ts, phase3 m3 and S15.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckpointStore } from "../src/checkpoint.ts";
import { EscalationStore } from "../src/escalation.ts";
import { queued } from "../src/json-store.ts";
import type { AwaitingStore } from "../src/awaiting.ts";
import { AnsweredOutbox } from "../src/answered.ts";
import type { AnsweredDecision } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

const OPTIONS = [
	{ id: "approve", label: "approve", consequence: "proceed", cost: "none" },
	{ id: "decline", label: "decline", consequence: "stop", cost: "sunk" },
];

/** Hold the escalation file's queue so a supersede can land while an answer waits on it. */
async function holdQueue(file: string): Promise<{ held: Promise<void>; release: () => void }> {
	let release!: () => void;
	let started!: () => void;
	const running = new Promise<void>((resolve) => { started = resolve; });
	const held = queued(file, () => new Promise<void>((resolve) => { release = resolve; started(); }));
	await running;
	return { held, release: () => release() };
}

/** An `onAnswered` sink that records each decision and queues it in the home's real outbox. */
function wakeRecorder(home: string): { seen: AnsweredDecision[]; outbox: AnsweredOutbox; sink: (decision: AnsweredDecision) => void } {
	const seen: AnsweredDecision[] = [];
	const outbox = new AnsweredOutbox({ home });
	return { seen, outbox, sink: (decision) => { seen.push(decision); outbox.enqueue(decision); } };
}

test("a supersede landing while an answer waits on the queue wins: the answer is refused and nothing is recorded", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const wakes = wakeRecorder(home.path);
	const store = new EscalationStore({ home: home.path, onAnswered: wakes.sink });
	const raised = await store.raise({ job_ids: ["cp-synth1"], kind: "product_ambiguity", question: "which copy?", options: OPTIONS, recommended: "approve" });
	const gate = await holdQueue(store.file);
	const pending = store.answer(raised.id, { answer: "approve", by: "operator command" });
	store.supersede((item) => (item.id === raised.id ? "synthetic grant revoked" : undefined));
	gate.release();
	await gate.held;
	await assert.rejects(pending, /superseded/);
	assert.deepEqual([store.get(raised.id)?.status, store.get(raised.id)?.answer], ["superseded", undefined]);
	assert.deepEqual(wakes.seen, [], "a refused answer reports nothing");
	assert.deepEqual(wakes.outbox.pending(), [], "and queues no wake in answered.json");
});

test("a supersede landing while a linked answer waits leaves the linked checkpoint pending", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const wakes = wakeRecorder(home.path);
	const checkpoints = new CheckpointStore(home.path, { onAnswered: wakes.sink });
	checkpoints.request({ jobId: "cp-synth1", question: "authorize cp-synth1?" });
	const store = new EscalationStore({ home: home.path, checkpoints: () => checkpoints, onAnswered: wakes.sink });
	const raised = await store.raise({ job_ids: ["cp-synth1"], kind: "conflicting_acceptance", question: "ship anyway?", options: OPTIONS, recommended: "approve", checkpoint_job_id: "cp-synth1" });
	const gate = await holdQueue(store.file);
	const pending = store.answer(raised.id, { answer: "approve", by: "operator command" });
	store.supersede((item) => (item.id === raised.id ? "synthetic grant revoked" : undefined));
	gate.release();
	await gate.held;
	await assert.rejects(pending, /superseded/);
	assert.equal(store.get(raised.id)?.status, "superseded");
	assert.equal(checkpoints.get("cp-synth1")?.decision, "pending", "a refused answer never authorized");
	assert.deepEqual(wakes.seen, [], "neither the escalation nor the checkpoint reports a refused answer");
	assert.deepEqual(wakes.outbox.pending(), [], "and answered.json holds no wake");
});

test("a linked awaiting follow-up that failed after the claim is completed by an identical retry; a contrary retry is still refused", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const calls: Array<{ id: string; answer: string }> = [];
	let failures = 1;
	const awaiting = {
		answer: async (id: string, options: { answer: string }) => {
			calls.push({ id, answer: options.answer });
			if (failures-- > 0) throw new Error("synthetic awaiting write failure");
			return {};
		},
	} as unknown as AwaitingStore;
	const store = new EscalationStore({ home: home.path, awaiting: () => awaiting });
	const raised = await store.raise({ job_ids: ["cp-synth1"], kind: "product_ambiguity", question: "which copy?", options: OPTIONS, recommended: "approve", awaiting_id: "aw-synth-0a0a0a" });
	await store.answer(raised.id, { answer: "approve", by: "operator command" });
	assert.equal(store.get(raised.id)?.status, "answered", "the claim stands though the follow-up failed");
	assert.equal(calls.length, 1);
	await store.answer(raised.id, { answer: "approve", by: "operator command" });
	assert.deepEqual(calls, [{ id: "aw-synth-0a0a0a", answer: "approve" }, { id: "aw-synth-0a0a0a", answer: "approve" }], "the retry re-runs the follow-up");
	await assert.rejects(() => store.answer(raised.id, { answer: "decline", by: "operator command" }), /already answered/);
	assert.equal(calls.length, 2, "a contrary retry never reaches the awaiting row");
	assert.equal(store.get(raised.id)?.answer, "approve");
});
