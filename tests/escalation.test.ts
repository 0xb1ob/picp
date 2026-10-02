/**
 * Escalation store: one record per (job, kind); answer resolves a linked
 * checkpoint; withdrawn cannot be answered; gate escalate/policy mints one.
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
	EscalationError,
	EscalationStore,
	kindForGate,
	raiseForGate,
	raiseMissionEnd,
} from "../src/escalation.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionDeps } from "../extensions/command-post/shared.ts";
import { registerMandateTools } from "../extensions/command-post/tools-mandate.ts";
import { createScratchHome } from "./harness/index.ts";

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
test("answered escalations preserve the supplied quote basis across reload and retry", async t => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const raised = await store.raise({ job_ids: ["cp-job1"], kind: "product_ambiguity", question: "Proceed?", options: OPTIONS, recommended: "approve" });
	const basis = { operator_quote: "Proceed with the approved change." };
	await store.answer(raised.id, { answer: "approve", by: "operator-delegated", basis });
	assert.deepEqual(new EscalationStore({ home: home.path }).get(raised.id)?.basis, basis);
	await store.answer(raised.id, { answer: "approve", by: "operator-quote", basis: { operator_quote: "A different quote." } });
	assert.deepEqual(store.get(raised.id)?.basis, basis);
});


test("raising the same question twice for one job and kind yields one record", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const raise = () => store.raise({ job_ids: ["cp-job1"], kind: "product_ambiguity", question: "which copy?", options: OPTIONS, recommended: "approve" });
	const first = await raise();
	assert.equal((await raise()).id, first.id);
	assert.equal(store.list({ jobId: "cp-job1", kind: "product_ambiguity" }).length, 1);
});

test("a new question for the same job and kind files its own record, never merged into the older one", async (t) => {
	// The incident: es-12172b, keyed job+kind, kept "md-a70d44 job cap reached (3)" and swallowed a USD budget question.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const raise = (question: string) => store.raise({ job_ids: ["cp-job1"], kind: "budget_exhausted", question, options: OPTIONS, recommended: "approve" });
	const old = await raise("md-a70d44 job cap reached (3)");
	const fresh = await raise("md-b81e55 spend cap reached (usd 20)");
	assert.notEqual(fresh.id, old.id);
	assert.equal(fresh.question, "md-b81e55 spend cap reached (usd 20)");
	assert.equal(store.get(old.id)?.question, "md-a70d44 job cap reached (3)", "the older record keeps its own title");
});

test("a mandate-keyed question with changing numbers (mission_end cost) stays one open record, updated to the latest numbers", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const first = await raiseMissionEnd(store, { jobIds: ["cp-a", "cp-b"], mandateId: "md-a70d44", summary: "landed 2, dropped 0, cost $3.10" });
	const again = await raiseMissionEnd(store, { jobIds: ["cp-b", "cp-a"], mandateId: "md-a70d44", summary: "landed 2, dropped 0, cost $3.85" });
	assert.equal(again.id, first.id);
	assert.deepEqual(store.open().map((item) => item.id), [first.id], "one open record, whatever the numbers");
	assert.match(store.get(first.id)?.question ?? "", /cost \$3\.85/, "the open record carries the latest numbers");
	const other = await raiseMissionEnd(store, { jobIds: ["cp-a", "cp-b"], mandateId: "md-b81e55", summary: "landed 2, dropped 0, cost $4.00" });
	assert.notEqual(other.id, first.id, "another grant's question is its own record");
});

test("two different questions under one grant stay separate records; a refresh replaces options, recommendation and evidence with the question", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const raise = (question: string, options = OPTIONS, recommended = "approve", evidence_paths: string[] = []) =>
		store.raise({ job_ids: ["cp-a"], kind: "budget_exhausted", question, options, recommended, evidence_paths, mandate_id: "md-a70d44" });
	const tokens = await raise("md-a70d44 token cap reached (3000000 non-cached; token_ceiling 100000000)");
	const usd = await raise("md-a70d44 spend cap reached (usd 20)");
	assert.notEqual(usd.id, tokens.id, "a USD cap after a token cap on one grant is its own question");
	assert.equal(store.open().length, 2);

	const fresher = [{ id: "stop", label: "stop", consequence: "halt", cost: "sunk" }, { id: "widen", label: "widen", consequence: "new grant", cost: "spend" }];
	const refreshed = await raise("md-a70d44 spend cap reached (usd 25)", fresher, "widen", ["state/mandates/md-a70d44.json"]);
	assert.equal(refreshed.id, usd.id, "the same subject with fresher numbers refreshes the open record");
	const record = store.get(usd.id);
	assert.deepEqual(
		[record?.question, record?.options.map((o) => o.id), record?.recommended, record?.evidence_paths],
		["md-a70d44 spend cap reached (usd 25)", ["stop", "widen"], "widen", ["state/mandates/md-a70d44.json"]],
		"never answered against options written for an older question",
	);
});

test("a superseded escalation leaves the open list, records why, and cannot be answered", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const raised = await store.raise({ job_ids: ["cp-job1"], kind: "budget_exhausted", question: "md-a70d44 job cap reached (3)", options: OPTIONS, recommended: "approve" });
	const kept = await store.raise({ job_ids: ["cp-job2"], kind: "budget_exhausted", question: "other", options: OPTIONS, recommended: "approve" });
	const closed = store.supersede((item) => (item.id === raised.id ? "md-a70d44 was revoked" : undefined));
	assert.deepEqual(closed.map((item) => item.id), [raised.id]);
	assert.deepEqual(store.open().map((item) => item.id), [kept.id]);
	const record = store.get(raised.id);
	assert.deepEqual([record?.status, record?.superseded_reason, record?.answer], ["superseded", "md-a70d44 was revoked", undefined]);
	assert.ok(record?.superseded_at);
	await assert.rejects(() => store.answer(raised.id, { answer: "approve", by: "operator command" }), /superseded/);
	assert.deepEqual(store.supersede(() => "again").map((item) => item.id), [kept.id], "only open records are ever superseded");
});

test("answering resolves the linked checkpoint in one write", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const checkpoints = new CheckpointStore(home.path);
	checkpoints.request({ jobId: "cp-ship1", question: "authorize cp-ship1?" });
	const store = new EscalationStore({ home: home.path, checkpoints: () => checkpoints });
	const raised = await store.raise({
		job_ids: ["cp-ship1"],
		kind: "conflicting_acceptance",
		question: "ship anyway?",
		options: OPTIONS,
		recommended: "approve",
		checkpoint_job_id: "cp-ship1",
	});
	const answered = await store.answer(raised.id, { answer: "approve", by: "operator command" });
	assert.equal(answered.status, "answered");
	assert.equal(answered.answer, "approve");
	assert.equal(checkpoints.get("cp-ship1")?.decision, "approved");
	assert.equal(checkpoints.get("cp-ship1")?.decided_by, "operator command");
});

test("a withdrawn escalation cannot be answered", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const raised = await store.raise({
		job_ids: ["cp-job1"],
		kind: "mission_end",
		question: "end it?",
		options: OPTIONS,
		recommended: "decline",
	});
	await store.withdraw(raised.id);
	await assert.rejects(
		() => store.answer(raised.id, { answer: "approve", by: "operator command" }),
		(error: Error) => error instanceof EscalationError && /withdrawn/.test(error.message),
	);
});

test("withdrawing an open escalation linked to a checkpoint leaves the checkpoint pending and the record unanswerable", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const checkpoints = new CheckpointStore(home.path);
	checkpoints.request({ jobId: "cp-ship1", question: "authorize cp-ship1?" });
	const store = new EscalationStore({ home: home.path, checkpoints: () => checkpoints });
	const linked = await store.raise({ job_ids: ["cp-ship1"], kind: "conflicting_acceptance", question: "ship anyway?", options: OPTIONS, recommended: "approve", checkpoint_job_id: "cp-ship1" });
	const kept = await store.raise({ job_ids: ["cp-job2"], kind: "product_ambiguity", question: "which copy?", options: OPTIONS, recommended: "approve" });
	const withdrawn = await store.withdraw(linked.id);
	assert.equal(withdrawn.status, "withdrawn");
	assert.equal(withdrawn.answer, undefined, "a withdrawal is never an answer");
	assert.deepEqual(store.open().map((item) => item.id), [kept.id], "gone from what Awaiting derives");
	assert.equal(checkpoints.get("cp-ship1")?.decision, "pending", "withdrawal never decides the linked checkpoint");
	await assert.rejects(() => store.answer(linked.id, { answer: "approve", by: "operator command" }), /withdrawn/);
	assert.equal(checkpoints.get("cp-ship1")?.decision, "pending");
});

test("withdraw refuses an unknown id, an answered record and a superseded one", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	await assert.rejects(() => store.withdraw("es-nope00"), /no escalation es-nope00/);
	const answered = await store.raise({ job_ids: ["cp-a"], kind: "product_ambiguity", question: "a?", options: OPTIONS, recommended: "approve" });
	await store.answer(answered.id, { answer: "approve", by: "operator command" });
	await assert.rejects(() => store.withdraw(answered.id), /already answered/);
	assert.equal(store.get(answered.id)?.status, "answered");
	const superseded = await store.raise({ job_ids: ["cp-b"], kind: "product_ambiguity", question: "b?", options: OPTIONS, recommended: "approve" });
	store.supersede((item) => (item.id === superseded.id ? "md-x was revoked" : undefined));
	await assert.rejects(() => store.withdraw(superseded.id), /superseded/);
	assert.equal(store.get(superseded.id)?.status, "superseded");
});

test("an answer and a withdrawal racing on one record: exactly one wins, and the record reads as the winner", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	for (const order of ["answer-first", "withdraw-first"] as const) {
		const raised = await store.raise({ job_ids: ["cp-race"], kind: "product_ambiguity", question: `race ${order}?`, options: OPTIONS, recommended: "approve" });
		const answer = () => store.answer(raised.id, { answer: "approve", by: "operator command" });
		const withdraw = () => store.withdraw(raised.id);
		const settled = await Promise.allSettled(order === "answer-first" ? [answer(), withdraw()] : [withdraw(), answer()]);
		assert.deepEqual(settled.map((entry) => entry.status).sort(), ["fulfilled", "rejected"], order);
		const record = store.get(raised.id);
		if (record?.status === "answered") assert.equal(record.answer, "approve");
		else assert.deepEqual([record?.status, record?.answer], ["withdrawn", undefined], order);
	}
});

test("cp_escalate action withdraw: needs an id and a reason, withdraws by id, carries the reason in its result only", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new EscalationStore({ home: home.path });
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }>();
	const pi = { on: () => {}, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<never> }) => tools.set(tool.name, tool) };
	let refreshed = 0;
	const deps = {
		commandPost: () => ({ escalations: store }),
		setLive: () => {},
		refreshWidget: () => {
			refreshed += 1;
		},
		projectOf: () => () => undefined,
		createdThisTurn: [],
	} as unknown as ExtensionDeps;
	registerMandateTools(pi as unknown as ExtensionAPI, deps);
	const escalate = (params: Record<string, unknown>) => tools.get("cp_escalate")!.execute("call-1", params, undefined, undefined, {});

	const raised = await store.raise({ job_ids: ["cp-a"], kind: "product_ambiguity", question: "which copy?", options: OPTIONS, recommended: "approve" });
	await assert.rejects(() => escalate({ action: "withdraw", escalation_id: raised.id, reason: "  " }), /escalation_id and a nonempty reason/);
	await assert.rejects(() => escalate({ action: "withdraw", reason: "moot" }), /escalation_id and a nonempty reason/);
	await assert.rejects(() => escalate({ action: "withdraw", escalation_id: "es-nope00", reason: "moot" }), /no escalation es-nope00/);
	assert.equal(store.get(raised.id)?.status, "open", "a refused withdraw writes nothing");

	const result = await escalate({ action: "withdraw", escalation_id: raised.id, reason: "the copy question was settled in the PR" });
	assert.match(result.content[0]!.text, new RegExp(`${raised.id} withdrawn: the copy question was settled in the PR .* not an answer`));
	assert.equal(result.details.reason, "the copy question was settled in the PR");
	assert.equal(store.get(raised.id)?.status, "withdrawn");
	assert.equal(refreshed, 1);
	await assert.rejects(() => escalate({ action: "raise", job_ids: ["cp-a"] }), /raise needs job_ids, kind, question, options and recommended/);
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
