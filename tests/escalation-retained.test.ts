/**
 * Escalation retained (P10d): queue-timed supersede races, an injected awaiting follow-up failure, the worker deny
 * list, the batch refresh count and raiseForGate's own record; the rest moved to tests/e2e/decisions-p10d.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckpointStore } from "../src/checkpoint.ts";
import {
	type GateVerdict,
	isoTimestamp,
	SCHEMA_VERSION,
	WORKER_FORBIDDEN_TOOLS,
} from "../src/contracts.ts";
import {
	EscalationStore,
	kindForGate,
	raiseForGate,
} from "../src/escalation.ts";
import { queued } from "../src/json-store.ts";
import type { AwaitingStore } from "../src/awaiting.ts";
import { AnsweredOutbox } from "../src/answered.ts";
import type { AnsweredDecision } from "../src/contracts.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionDeps } from "../extensions/command-post/shared.ts";
import { registerMandateTools } from "../extensions/command-post/tools-mandate.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";
import { MandateStore } from "../src/mandate.ts";
import { readFileSync } from "node:fs";

const OPTIONS = [
	{ id: "approve", label: "approve", consequence: "proceed", cost: "none" },
	{ id: "decline", label: "decline", consequence: "stop", cost: "sunk" },
];

function policyVerdict(jobId = "cp-research1"): GateVerdict {
	return {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		attempt: 1,
		verdict: "escalate",
		cause: "policy",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["the plan skips a rollback step"],
		decided_at: isoTimestamp(),
	};
}

test("cp_escalate is parent-only", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_escalate"));
});

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

test("cp_escalate action batch_risk_high (6B-T2): every refusal writes nothing and refreshes nothing; a valid batch withdraws the per-job rows", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const mandates = new MandateStore(home.path);
	const { ledger } = createScratchLedger({ home: home.path, knownProjects: ["example-app"] });
	mandates.issue({ projects: ["example-app"], objective: "ship the example change", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"] });
	const ids: string[] = [];
	for (const slug of ["aaa1", "aaa2", "aaa3"]) ids.push((await ledger.create({ title: `example ${slug}`, project: "example-app", delivery: "pr", kind: "ship", slug, ...(slug === "aaa1" ? { risk: "high" as const } : {}) })).id);
	const [a1, a2, a3] = ids as [string, string, string];
	for (const jobId of [a2, a3]) {
		await assert.rejects(() => mandates.assertDispatchAllowed({ jobId, project: "example-app", kind: "ship", risk: "high", evidence: ["risk high: production"] }), /risk:high under ask_on/);
	}
	const tools = new Map<string, { parameters: unknown; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }>();
	const pi = { on: () => {}, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<never> }) => tools.set(tool.name, tool as never) };
	let refreshed = 0;
	const deps = {
		commandPost: () => ({ escalations: store, mandates, ledger: () => ledger, fleet: { read: () => ({ jobs: [] }) }, runs: { get: () => undefined } }),
		setLive: () => {},
		refreshWidget: () => {
			refreshed += 1;
		},
		projectOf: () => () => undefined,
		createdThisTurn: [],
	} as unknown as ExtensionDeps;
	registerMandateTools(pi as unknown as ExtensionAPI, deps);
	assert.match(JSON.stringify(tools.get("cp_escalate")!.parameters), /batch_risk_high/);
	const escalate = (params: Record<string, unknown>) => tools.get("cp_escalate")!.execute("call-1", params, undefined, undefined, {});

	const before = readFileSync(store.file, "utf8");
	for (const [params, pattern] of [
		[{ action: "batch_risk_high" }, /needs job_ids/],
		[{ action: "batch_risk_high", job_ids: [a1] }, /got 1/],
		[{ action: "batch_risk_high", job_ids: [a1, "cp-zzz9"] }, /unknown job ids/],
		[{ action: "batch_risk_high", job_ids: [a1, a1] }, /duplicate job ids/],
	] as const) {
		await assert.rejects(() => escalate(params), pattern);
		assert.equal(readFileSync(store.file, "utf8"), before, `${pattern} wrote nothing`);
	}
	assert.equal(refreshed, 0);

	const result = await escalate({ action: "batch_risk_high", job_ids: ids });
	const batch = store.open();
	assert.equal(batch.length, 1);
	assert.match(result.content[0]!.text, new RegExp(`^${batch[0]!.id} batch risk:high: 3 jobs .*withdrew 2 per-job rows`));
	assert.equal(refreshed, 1);
});

test("a gate escalate/policy verdict produces an escalation without the parent composing one", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const verdict = policyVerdict();
	assert.equal(kindForGate(verdict), "conflicting_acceptance");
	const first = await raiseForGate(store, verdict);
	assert.ok(first);
	assert.equal(first.kind, "conflicting_acceptance");
	assert.equal(first.job_ids[0], "cp-research1");
	const again = await raiseForGate(store, verdict);
	assert.equal(again?.id, first.id);
	assert.equal(store.list({ jobId: "cp-research1", kind: "conflicting_acceptance" }).length, 1);
});
