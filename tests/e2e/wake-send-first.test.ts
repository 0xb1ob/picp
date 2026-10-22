import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AnsweredOutbox } from "../../src/answered.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { frameBatch } from "../../src/parent-outbox.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, MockProvider, startPiChild, waitFor } from "../harness/index.ts";
import { JOB, seedHeldHome } from "../harness/held-home.ts";
import type { ScriptStep } from "../harness/mock-provider.ts";

const SEND = frameBatch([{ id: "ps-20300101000000-0000000a", text: "S19 operator question" }]);

async function parent(t: TestContext, steps: ScriptStep[]) {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	const provider = await MockProvider.start();
	const model = provider.addScript("s19-send-first", steps);
	const agent = createAgentDir({ provider });
	new IntegrationHolds(held.home.path).hold(JOB, "S19 isolates wake delivery");
	const child = startPiChild({ cwd: held.home.path, model, env: { ...agent.env, CP_HOME: held.home.path,
		PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "3600" }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); held.repo.cleanup(); held.home.cleanup(); });
	const outbox = new DurableWakeupOutbox({ home: held.home.path });
	const enqueue = (id: string, content: string) => outbox.enqueue({ id, kind: "recovery", job_id: JOB, keys: [JOB], content });
	let sequence = 0;
	const request = async (type: "get_state" | "clear_queue") => {
		const id = `s19-rpc-${++sequence}`;
		child.send({ type, id });
		const response = await child.waitFor((record) => record.type === "response" && record.id === id, 5_000);
		assert.equal(response.success, true);
		return response.data as Record<string, unknown>;
	};
	const requests = () => provider.requests("s19-send-first");
	return { ...held, child, provider, outbox, enqueue, request, requests };
}

test("wake S19: assistant and custom send markers do not hold ordinary parent wakes", { timeout: 60_000 }, async (t) => {
	const p = await parent(t, [{ kind: "text", text: SEND }, { kind: "hang", ms: 10_000 }, { kind: "text", text: "Unexpected held wake." }]);
	await p.child.prompt("Acknowledge readiness."); await p.child.waitForSettled();
	p.enqueue("s19-custom-marker", frameBatch([{ id: "ps-20300101000000-0000000b", text: "S19 custom marker" }]));
	await waitFor(p.requests, (requests) => requests.length === 2, { timeoutMs: 10_000, what: "idle wake after assistant marker" });
	p.enqueue("s19-idle-next", "S19_IDLE_NEXT");
	await waitFor(() => p.outbox.read().sends ?? [], (entries) => entries.some((entry) => entry.id === "s19-idle-next"),
		{ timeoutMs: 10_000, what: "ordinary wake offered after custom marker" });
	await p.request("clear_queue");
	await waitFor(() => p.child.eventsOfType("agent_settled"), (events) => events.length >= 2,
		{ timeoutMs: 20_000, what: "custom wake run settles after queue clear" });
	await new Promise((done) => setTimeout(done, 1_500));
	assert.equal(p.requests().length, 2, "custom markers must not preserve a wake behind pi's cleared queue");
});

test("wake S19: user sends hold wakes through tools, answered decisions bypass and clean replies release once", { timeout: 60_000 }, async (t) => {
	const p = await parent(t, [
		{ kind: "tool_calls", calls: [
			{ name: "cp_job", args: { action: "create", title: "S19 ready follow-up", project: "demo", delivery: "local", kind: "research" } },
			{ name: "cp_mandate", args: { action: "issue", projects: ["demo"], objective: "S19 ready follow-up" } },
		] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "node -e 'setTimeout(() => {}, 3000)'" } }] },
		{ kind: "hang", ms: 12_000 }, { kind: "text", text: "Wakes received." }, { kind: "text", text: "All received." },
	]);
	await p.child.prompt(SEND);
	await p.child.waitFor((record) => record.type === "tool_execution_start" && record.toolName === "bash");
	p.enqueue("s19-clean-one", "S19_WAKE_ONE"); p.enqueue("s19-clean-two", "S19_WAKE_TWO");
	await waitFor(() => p.outbox.read().sends ?? [], (entries) => entries.filter((entry) => entry.id.startsWith("s19-clean")).length === 2,
		{ timeoutMs: 10_000, what: "ordinary wakes are offered before a clean reply" });
	await waitFor(p.requests, (requests) => requests.length === 3, { timeoutMs: 10_000, what: "tool turn ends without answering send" });
	const answered = new AnsweredOutbox({ home: p.home.path });
	answered.enqueue({ id: "aw-s19-answer", type: "approval", job_id: JOB,
		decision: "S19 answered decision", answer: "hold", answered_by: "operator" });
	await waitFor(() => answered.read().sends ?? [], (entries) => entries.some((entry) => entry.id === "aw-s19-answer"),
		{ timeoutMs: 10_000, what: "answered decision offered while send remains unanswered" });
	assert.equal((await p.request("get_state")).isStreaming, true);
	await p.request("clear_queue");
	await waitFor(p.requests, (requests) => requests.length >= 4, { timeoutMs: 20_000, what: "clean reply releases held wakes despite earlier queue clear" });
	await p.child.waitForSettled();
	const body = JSON.stringify(p.requests().at(-1)!.body);
	assert.equal(body.match(/S19_WAKE_ONE/g)?.length, 1); assert.equal(body.match(/S19_WAKE_TWO/g)?.length, 1);
	assert.ok(!body.includes("aw-s19-answer"), "answered decision reached pi's queue before clear, while ordinary wakes stayed held");
	assert.ok(body.indexOf("S19_WAKE_ONE") < body.indexOf("S19_WAKE_TWO"), "held wakes arrive in offer order");
});

test("wake S19: an aborted send releases held wakes before another clean answer", { timeout: 60_000 }, async (t) => {
	const p = await parent(t, [{ kind: "hang" }, { kind: "hang", ms: 8_000 }, { kind: "text", text: "Unexpected held wake." }]);
	await p.child.prompt(SEND);
	await waitFor(p.requests, (requests) => requests.length === 1, { timeoutMs: 10_000, what: "unanswered send streams" });
	p.enqueue("s19-abort", "S19_ABORT_HELD");
	await waitFor(() => p.outbox.read().sends ?? [], (entries) => entries.some((entry) => entry.id === "s19-abort"),
		{ timeoutMs: 10_000, what: "wake is held before abort" });
	p.child.send({ type: "abort", id: "s19-abort-request" });
	await p.child.waitForSettled();
	await p.child.prompt("Resume after the aborted send.");
	await waitFor(p.requests, (requests) => requests.length === 2, { timeoutMs: 10_000, what: "resumed prompt streams without a clean answer" });
	await p.request("clear_queue");
	await waitFor(() => p.child.eventsOfType("agent_settled"), (events) => events.length >= 2,
		{ timeoutMs: 20_000, what: "resumed run settles after queue clear" });
	await new Promise((done) => setTimeout(done, 1_500));
	assert.equal(p.requests().length, 2, "settled hold must be removable from pi's queue before another clean answer");
});

test("wake S19: the oldest held wake reaches pi's queue within 120 seconds while its send still streams", { timeout: 180_000 }, async (t) => {
	const p = await parent(t, [{ kind: "hang", ms: 110_000 }, { kind: "text", text: "Wakes received." }, { kind: "text", text: "Remaining wake received." }]);
	await p.child.prompt(SEND);
	await waitFor(p.requests, (requests) => requests.length === 1, { timeoutMs: 10_000, what: "long unanswered send streams" });
	p.enqueue("s19-expiry-one", "S19_EXPIRY_ONE");
	await waitFor(() => p.outbox.read().sends ?? [], (entries) => entries.some((entry) => entry.id === "s19-expiry-one"),
		{ timeoutMs: 10_000, what: "oldest wake starts its actual hold" });
	const begin = Date.now();
	await new Promise((done) => setTimeout(done, 45_000));
	p.enqueue("s19-expiry-middle", "S19_EXPIRY_MIDDLE");
	await new Promise((done) => setTimeout(done, 47_000));
	p.enqueue("s19-expiry-two", "S19_EXPIRY_TWO");
	await waitFor(() => p.outbox.read().sends ?? [], (entries) => entries.some((entry) => entry.id === "s19-expiry-two"),
		{ timeoutMs: 10_000, what: "new wake flushes the oldest expired hold" });
	assert.equal((await p.request("get_state")).isStreaming, true);
	assert.ok(Date.now() - begin <= 120_000);
	await p.request("clear_queue");
	await waitFor(p.requests, (requests) => requests.length >= 2, { timeoutMs: 30_000, what: "remaining quiet and newly held wakes reach model after long reply" });
	const body = JSON.stringify(p.requests().at(-1)!.body);
	assert.ok(!body.includes("S19_EXPIRY_ONE"), "oldest wake was already queued and removable before its send settled");
	assert.equal(body.match(/S19_EXPIRY_MIDDLE/g)?.length, 1);
	assert.equal(body.match(/S19_EXPIRY_TWO/g)?.length, 1);
});
