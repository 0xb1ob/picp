/** cp-6fyl E: the ask guard, unit (AskGuard + OperatorAsks) and over a real pi process (agent_before_settle `continue: true`). */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AskGuard, ASK_GUARD_TYPE, DETECTED_ASK_PREFIX, detectHumanQuestion, lastAssistantText } from "../src/ask-guard.ts";
import { layoutForHome } from "../src/contracts.ts";
import { OperatorAsks } from "../src/operator-asks.ts";
import { CP_BRIDGE_EXTENSION, MockProvider, createAgentDir, createScratchHome, startRpc } from "./harness/index.ts";
import "./harness/fake-parent-tracker.ts";

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "ask-guard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new OperatorAsks(join(dir, "asks.jsonl"));
	return { store, asks: () => store, guard: new AskGuard() };
}

const askOk = { toolName: "cp_parent", isError: false, result: { details: { id: "ask-0a1b2c", state: "open", question: "A or B?" } } };

test("the detector fires on a question sentence and on a cue phrase", () => {
	assert.equal(detectHumanQuestion("Done with the plan. Should I proceed with A or B?"), "Should I proceed with A or B?");
	assert.equal(detectHumanQuestion("Two options exist.\nLet me know which option you prefer."), "Let me know which option you prefer.");
	assert.equal(detectHumanQuestion('Is it ready (see "docs")?'), 'Is it ready (see "docs")?');
	assert.equal(detectHumanQuestion("Everything is merged. Nothing else to do."), undefined);
});

test("the detector ignores a ? inside a code fence or a > quote, and a URL query", () => {
	assert.equal(detectHumanQuestion("Result:\n```\nwhat is this?\n```\nAll done."), undefined);
	assert.equal(detectHumanQuestion("> Should I proceed?\nDone."), undefined);
	assert.equal(detectHumanQuestion("See https://example.test/x?y=1 for details."), undefined);
	assert.equal(detectHumanQuestion("```\nunclosed fence: really?"), undefined);
});

test("N10: a choice with no ? — 'your (two) choices' — is the question; fenced it still is not", () => {
	const tail = "Still waiting on your two choices: hand-off merges, and the beads backlog.";
	assert.equal(detectHumanQuestion(`PR #12 merged.\n${tail}`), tail);
	assert.equal(detectHumanQuestion("Both landed. Over to your choice."), "Over to your choice.");
	assert.equal(detectHumanQuestion(`Done.\n\`\`\`\n${tail}\n\`\`\`\nAll merged.`), undefined);
	assert.equal(detectHumanQuestion(`> ${tail}\nAll merged.`), undefined);
});

test("N8: 'still waiting' with no ? is a status line, not a question; with a ? it still is", () => {
	assert.equal(detectHumanQuestion("Dispatched the readers. Still waiting on readers."), undefined);
	assert.equal(detectHumanQuestion("Still waiting on readers"), undefined);
	assert.equal(detectHumanQuestion("Done. Are you still waiting on the readers?"), "Are you still waiting on the readers?");
});

test("N8: a cue with no ? while an ask is open is not nudged; a real ? question still is", (t) => {
	const { guard, asks, store } = fixture(t);
	store.open({ project: "demo-app", question: "A or B?", options: [{ label: "A", consequence: "a" }], recommendation: "A" });
	guard.runEnded();
	assert.equal(guard.beforeSettle("Still waiting on your two choices: hand-off merges, and the beads backlog.", asks), undefined);
	assert.equal(guard.beforeSettle("Let me know which option you prefer.", asks), undefined);
	assert.equal(store.open().length, 1, "no card either");
	assert.equal(guard.beforeSettle("Should I proceed with A or B?", asks)?.continue, true, "a ? question nudges even with an ask open");
	const { guard: fresh, asks: none } = fixture(t);
	fresh.runEnded();
	assert.equal(fresh.beforeSettle("Let me know which option you prefer.", none)?.continue, true, "no ask open: the cue still nudges");
});

test("the detector reads only the last 600 characters", () => {
	assert.equal(detectHumanQuestion(`Should I proceed?\n${"filler. ".repeat(100)}`), undefined);
});

test("lastAssistantText takes the newest assistant message, string or parts", () => {
	assert.equal(lastAssistantText([{ role: "assistant", content: "old" }, { role: "assistant", content: [{ type: "text", text: "new?" }, { type: "toolCall" }] }, { role: "user", content: "x" }]), "new?");
	assert.equal(lastAssistantText(undefined), "");
});

test("a run with a successful cp_parent ask is never nudged or carded", (t) => {
	const { guard, asks } = fixture(t);
	guard.runEnded();
	guard.toolEnded(askOk);
	assert.equal(guard.beforeSettle("Should I proceed?", asks), undefined);
	assert.equal(guard.beforeSettle("Should I proceed?", asks), undefined);
});

test("a failed ask, or an ask_answer result carrying only an id, does not count as an ask", (t) => {
	const { guard, asks } = fixture(t);
	guard.runEnded();
	guard.toolEnded({ ...askOk, isError: true });
	guard.toolEnded({ toolName: "cp_parent", isError: false, result: { details: { id: "ask-0a1b2c" } } });
	guard.toolEnded({ toolName: "bash", isError: false, result: { details: { id: "ask-0a1b2c", state: "open" } } });
	assert.equal(guard.beforeSettle("Should I proceed?", asks)?.continue, true);
});

test("a detected question without an ask forces one continuation, then a card whose context carries the marker", (t) => {
	const { guard, asks, store } = fixture(t);
	guard.runEnded();
	const first = guard.beforeSettle("[demo-app] cp-1234 is blocked. Should I proceed with A or B?", asks);
	assert.equal(first?.continue, true);
	assert.equal(first?.entries?.[0]?.customType, ASK_GUARD_TYPE);
	assert.match(first?.entries?.[0]?.content ?? "", /cp_parent ask/);
	assert.deepEqual(store.open(), []);
	const second = guard.beforeSettle("I will wait.", asks, new Date("2030-01-01T00:00:00Z"));
	assert.equal(second?.continue, undefined);
	const [card] = store.open();
	assert.equal(second?.card?.id, card?.id);
	assert.equal(card?.project, "demo-app");
	assert.equal(card?.question, "Should I proceed with A or B?");
	assert.ok(card?.context?.startsWith(`${DETECTED_ASK_PREFIX} (no cp_parent ask was opened) at 2030-01-01T00:00:00.000Z:\n`));
	assert.match(card?.context ?? "", /cp-1234 is blocked/);
	assert.equal(guard.beforeSettle("still waiting", asks), undefined, "one nudge, one card per run");
	assert.equal(store.open().length, 1);
});

test("a detected question defaults to the command-post project and clips question and context", (t) => {
	const { guard, asks, store } = fixture(t);
	guard.runEnded();
	const long = `${"x".repeat(250)}[ ] ${"y".repeat(400)}?`;
	guard.beforeSettle(`${"z".repeat(3000)}\n${long}`, asks);
	guard.beforeSettle("ok", asks);
	const [card] = store.open();
	assert.equal(card?.project, "command-post");
	assert.equal(card?.question?.length, 300);
	assert.ok((card?.context?.length ?? 0) <= 2000);
});

test("a NO-ASK reply after the nudge opens no card", (t) => {
	const { guard, asks, store } = fixture(t);
	guard.runEnded();
	assert.equal(guard.beforeSettle("Should I proceed?", asks)?.continue, true);
	assert.equal(guard.beforeSettle("no-ask", asks), undefined);
	assert.deepEqual(store.open(), []);
});

test("an ask opened in reply to the nudge cancels the card", (t) => {
	const { guard, asks, store } = fixture(t);
	guard.runEnded();
	assert.equal(guard.beforeSettle("Should I proceed?", asks)?.continue, true);
	guard.toolEnded(askOk);
	assert.equal(guard.beforeSettle("Opened it.", asks), undefined);
	assert.deepEqual(store.open(), []);
});

test("a new run starts clean", (t) => {
	const { guard, asks } = fixture(t);
	guard.runEnded();
	guard.toolEnded(askOk);
	guard.runEnded();
	assert.equal(guard.beforeSettle("Should I proceed?", asks)?.continue, true);
	guard.runEnded();
	assert.equal(guard.beforeSettle("Should I proceed?", asks)?.continue, true, "the nudge is per run");
});

test("the next human message answers every open detected card verbatim, clipped to 1000", (t) => {
	const { guard, asks, store } = fixture(t);
	const real = store.open({ project: "demo-app", question: "A or B?", options: [{ label: "A", consequence: "a" }], recommendation: "A" });
	guard.runEnded();
	guard.beforeSettle("Should I proceed?", asks);
	guard.beforeSettle("ok", asks);
	assert.deepEqual(guard.userMessage({ role: "custom", content: "relay" }, asks), []);
	assert.deepEqual(guard.userMessage({ role: "user", content: "   " }, asks), []);
	const answered = guard.userMessage({ role: "user", content: [{ type: "text", text: "B".repeat(1500) }] }, asks);
	assert.equal(answered.length, 1);
	const list = store.list();
	assert.equal(list.find((ask) => ask.id === answered[0]?.id)?.answer, "B".repeat(1000));
	assert.equal(list.find((ask) => ask.id === real.id)?.state, "open", "a cp_parent ask is the LLM's to answer");
	assert.deepEqual(guard.userMessage({ role: "user", content: "again" }, asks), []);
});

test("a dashboard click on an ask is not the chat answer", (t) => {
	const { guard, asks, store } = fixture(t);
	guard.runEnded();
	guard.beforeSettle("Should I proceed?", asks);
	guard.beforeSettle("ok", asks);
	const click = "ask-1: Answer in the operator chat\n[cp-dashboard dc-20300101000000-0a1b2c3d — from the dashboard; ask=ask-0a1b2c]";
	assert.deepEqual(guard.userMessage({ role: "user", content: click }, asks), []);
	assert.equal(store.open().length, 1);
	assert.equal(guard.userMessage({ role: "user", content: "[cp-dashboard dc-20300101000000-0a1b2c3d — from the dashboard]\nB" }, asks).length, 1, "a typed dashboard message is the human talking");
});

// ---- real pi: the extension under test is the real cp-bridge, the model a scripted mock provider ----

async function realPi(t: TestContext, script: string, steps: Parameters<MockProvider["addScript"]>[1]) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript(script, steps);
	const agentDir = createAgentDir({ provider });
	const rpc = startRpc({
		cwd: home.path,
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--no-context-files", "--model", model],
		env: { ...agentDir.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" },
	});
	t.after(async () => { await rpc.close(); agentDir.cleanup(); home.cleanup(); await provider.stop(); });
	const file = join(home.path, layoutForHome("multi", home.path).state, "operator", "asks.jsonl");
	const asks = () => (existsSync(file) ? new OperatorAsks(file) : undefined);
	let seen = 0;
	const turn = async (message: string) => {
		rpc.send({ type: "prompt", id: `p${++seen}`, message });
		await rpc.waitFor((r) => r.type === "agent_settled" && rpc.records().filter((x) => x.type === "agent_settled").length >= seen, 60_000);
	};
	return { home, provider, rpc, asks, turn, requests: () => provider.requests(script) };
}

test("real pi: a prose question is forced back once, then carded; the next chat message answers the card", { timeout: 120_000 }, async (t) => {
	const f = await realPi(t, "ask-guard-card", [
		{ kind: "text", text: "[demo-app] The plan is ready. Should I proceed with A or B?" },
		{ kind: "text", text: "I will keep chatting instead." },
		{ kind: "text", text: "Understood, going with B." },
	]);
	await f.turn("what next?");
	const second = JSON.stringify(f.requests()[1]?.body);
	assert.match(second, /opened no cp_parent ask/, "agent_before_settle continue:true produced exactly one more provider request carrying the nudge");
	assert.equal(f.requests().length, 2, "one continuation, never a loop");
	const [card] = f.asks()?.open() ?? [];
	assert.ok(card, "the bridge opened the detected card");
	assert.equal(card.project, "demo-app");
	assert.ok(card.context?.startsWith(DETECTED_ASK_PREFIX));
	await f.turn("go with B");
	const [answered] = f.asks()?.list() ?? [];
	assert.equal(answered?.state, "answered");
	assert.equal(answered?.answer, "go with B");
	assert.equal(f.provider.remaining("ask-guard-card"), 0);
});

const askCall = { name: "cp_parent", args: { action: "ask", ask: { project: "demo-app", question: "A or B?", options: [{ label: "A", consequence: "does a" }, { label: "B", consequence: "does b" }], recommendation: "A" } } };

test("real pi: the model answers the nudge with cp_parent ask, so no detected card is added", { timeout: 120_000 }, async (t) => {
	const f = await realPi(t, "ask-guard-complies", [
		{ kind: "text", text: "Should I proceed with A or B?" },
		{ kind: "tool_calls", calls: [askCall] },
		{ kind: "text", text: "Asked on the dashboard." },
	]);
	await f.turn("what next?");
	assert.equal(f.provider.remaining("ask-guard-complies"), 0);
	const open = f.asks()?.open() ?? [];
	assert.equal(open.length, 1);
	assert.ok(!open[0]?.context?.startsWith(DETECTED_ASK_PREFIX));
});

test("real pi: a run that already opened a cp_parent ask is not continued", { timeout: 120_000 }, async (t) => {
	const f = await realPi(t, "ask-guard-asked", [
		{ kind: "tool_calls", calls: [askCall] },
		{ kind: "text", text: "Should I proceed with A or B? It is on the dashboard." },
	]);
	await f.turn("what next?");
	assert.equal(f.requests().length, 2, "no forced continuation");
	assert.equal(f.asks()?.open().length, 1);
});

test("real pi: a NO-ASK reply to the nudge opens no card", { timeout: 120_000 }, async (t) => {
	const f = await realPi(t, "ask-guard-noask", [
		{ kind: "text", text: "Is this what you meant? Quoting the spec." },
		{ kind: "text", text: "NO-ASK" },
	]);
	await f.turn("explain");
	assert.equal(f.provider.remaining("ask-guard-noask"), 0);
	assert.equal(f.asks(), undefined, "no ask journal at all");
});
