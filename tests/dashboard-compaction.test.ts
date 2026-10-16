import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { CompactOptions } from "@earendil-works/pi-coding-agent";
import bridgeExtension, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { LAYOUT } from "../src/contracts.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import { controlJournalFile, readControlRecord } from "../src/viewer/control-files.ts";
import { readPendingSends } from "../src/viewer/control-pending.ts";
import { createScratchHome } from "./harness/index.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Tool = { name: string; execute: (id: string, params: { instructions: string }, signal: undefined, update: undefined, ctx: unknown) => Promise<unknown> };
type Message = { customType?: string; content?: unknown };
const instructions = "Operator delegated cp-b7m6 under the standing mandate. The draft PR awaits review on its pushed head; no merge is authorized yet. Preserve the open decision, held work and next review step. Latest handoff: /home/ubuntu/reports/handoffs/operator.md.";
const tick = () => new Promise((done) => setImmediate(done));
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

// A fake pi 1.1.0 (dist/core/agent-session.js): a turn sent inside agent_settled runs after it (1803-1806, 696-701),
// _runAgentPrompt marks the run active synchronously (1388), prompt() refuses while compacting (1534) and, after one
// await, refuses an idle prompt once a turn started (1538-1555); pi.sendUserMessage returns void and only emitError
// sees a refusal (2712-2719).
function fakePi(home: string) {
	const s = { active: false, compacting: false, emitting: false, refusals: 0, tokens: 270000, deferred: [] as Array<() => Promise<void>>, followUps: [] as string[], thrown: [] as string[], prompts: [] as string[], compacts: [] as CompactOptions[] };
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const ctx = {
		hasUI: true, cwd: home, abort: () => {},
		isIdle: () => !s.active && !s.compacting,
		hasPendingMessages: () => s.followUps.length > 0,
		sessionManager: { getSessionFile: () => join(home, "operator-session.jsonl"), getEntries: () => [] },
		getContextUsage: () => ({ tokens: s.tokens, contextWindow: 1_000_000, percent: s.tokens / 10000 }),
		compact: (options: CompactOptions) => { s.compacting = true; s.compacts.push(options); },
		ui: { notify: () => {}, setStatus: () => {} },
	};
	const emit = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	const settle = async (): Promise<void> => {
		s.active = false;
		s.emitting = true;
		await emit("agent_settled");
		s.emitting = false;
		for (const action of s.deferred.splice(0)) {
			try { await action(); } catch (error) { s.thrown.push((error as Error).message); break; }
		}
	};
	const turn = async (first: unknown, body?: () => Promise<unknown>): Promise<void> => {
		s.active = true;
		await emit("message_start", { message: first });
		await tick(); // the model call
		await body?.();
		for (let next = s.followUps.shift(); next !== undefined; next = s.followUps.shift()) await emit("message_start", { message: user(next) });
		await settle();
	};
	const prompt = async (text: string, deliverAs?: string): Promise<void> => {
		if (s.emitting) { s.deferred.push(() => prompt(text, deliverAs)); return; }
		if (s.compacting || (s.refusals > 0 && s.refusals--)) throw new Error("Cannot submit a prompt while compaction is in progress.");
		await Promise.resolve(); // _runInputHandlers
		if (s.active) {
			if (!deliverAs) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
			s.followUps.push(text);
			return;
		}
		s.prompts.push(text);
		await turn(user(text));
	};
	const selfCompact = () => tools.get("self_compact")!.execute("call", { instructions }, undefined, undefined, ctx);
	bridgeExtension({
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: (message: Message, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
			if (options?.deliverAs === "nextTurn" || s.active || !options?.triggerTurn) return;
			const run = () => turn({ role: "custom", ...message }, message.customType === "operator-compact-request" ? selfCompact : undefined);
			if (s.emitting) s.deferred.push(run);
			else void run().catch((error: Error) => s.thrown.push(error.message));
		},
		sendUserMessage: (content: unknown, options?: { deliverAs?: string }) => {
			const text = typeof content === "string" ? content : JSON.stringify(content);
			void prompt(text, options?.deliverAs).catch((error: Error) => s.thrown.push(error.message));
		},
	} as never);
	return { s, emit, settle, turn };
}

async function operator(t: TestContext) {
	const scratch = createScratchHome();
	const home = scratch.path;
	const stateDir = join(home, LAYOUT.state);
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = join(home, "pi-home");
	t.after(() => { if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous; scratch.cleanup(); });
	saveOperatorTarget({ home, mode: "multi", hostPid: 0, parentPid: 0 });
	const pi = fakePi(home);
	await pi.emit("session_start");
	t.after(() => pi.emit("session_shutdown"));
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	const control = (record as { record: Parameters<typeof controlRequest>[0] }).record;
	const journal = (id: string) => {
		const file = controlJournalFile(stateDir);
		return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.id === id && l.type !== "edited") : [];
	};
	const states = (id: string) => journal(id).map((l) => l.type === "outcome" ? l.state : l.type);
	/** A composer message sent while a turn runs: dashboard-held. */
	const queue = async (text: string): Promise<string> => {
		pi.s.active = true;
		const sent = await controlRequest(control, "send", { kind: "message", text });
		assert.ok(sent.ok && (sent.result as { state: string }).state === "queued", JSON.stringify(sent));
		return (sent.result as { id: string }).id;
	};
	const finishCompaction = async () => {
		pi.s.compacting = false;
		pi.s.tokens = 1000;
		pi.s.compacts.at(-1)!.onComplete?.({ summary: "s", firstKeptEntryId: "k", tokensBefore: 270000 });
		for (let i = 0; i < 6; i++) await tick();
	};
	return { ...pi, stateDir, control, journal, states, queue, finishCompaction };
}

test("order 1: the compact request starts its turn first; the queued message is held through the compaction, then delivered once", async (t) => {
	const op = await operator(t);
	const id = await op.queue("list the validator owner wallets");
	await op.settle();
	assert.equal(op.s.compacts.length, 1, "the settle's deferred compact-request turn called self_compact");
	assert.ok(op.s.compacting);
	const edit = await controlRequest(op.control, "queue_edit", { id, text: "list the validator owner wallets" });
	assert.ok(edit.ok && (edit.result as { editable: boolean }).editable, `still dashboard-held while compacting: ${JSON.stringify(edit)}`);

	await op.finishCompaction();
	assert.deepEqual(op.s.thrown, [], "no prompt was refused");
	assert.equal(op.s.prompts.filter((text) => text.includes(`[cp-dashboard ${id} `)).length, 1, "pi got the message once");
	assert.deepEqual(op.states(id), ["request", "queued", "injected", "delivered"]);
	assert.equal(readPendingSends(op.stateDir).sends.find((send) => send.id === id)?.state, "delivered");
});

// Order 2: the handoff reaches pi first and a compaction turn starts before pi takes it. A provider-rejection compaction
// releases the held handoff, then its nudge turn starts while pi's prompt() is still awaiting: pi throws "already
// processing" into emitError and the journal said `injected` forever. The nudge turn's settle must re-hand it.
test("order 2: a handoff pi drops because the compaction's own turn started first is re-handed at that turn's settle, delivered once", async (t) => {
	const op = await operator(t);
	const id = await op.queue("is the FVG scan limit order still open?");
	await op.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: '400 {"type":"invalid_request_error","message":"tool_addition is not supported"}' } });
	await op.settle();
	assert.equal(op.s.compacts.length, 1, "the provider-rejection compaction started on that settle");
	await tick(); // the summarizer runs for minutes: the settle's macrotask handoff is long held by then

	await op.finishCompaction();
	assert.equal(op.s.thrown.length, 1, `pi dropped the first handoff: ${JSON.stringify(op.s.thrown)}`);
	assert.match(op.s.thrown[0]!, /already processing/);
	assert.equal(op.s.prompts.filter((text) => text.includes(`[cp-dashboard ${id} `)).length, 1, "the re-handed message reached pi once");
	const lines = op.journal(id);
	assert.deepEqual(op.states(id), ["request", "queued", "injected", "injected", "delivered"]);
	assert.equal(lines[3].reason, "re-handed: not seen in the session when the turn settled");
	assert.equal(readPendingSends(op.stateDir).sends.find((send) => send.id === id)?.state, "delivered");
});

test("a handoff pi drops twice is failed with a reason, never left injected", async (t) => {
	const op = await operator(t);
	op.s.tokens = 1000;
	op.s.refusals = 2;
	const id = await op.queue("sorry, in general can they access MCP");
	await op.settle();
	await tick();
	assert.deepEqual(op.states(id), ["request", "queued", "injected"]);
	await op.turn({ role: "custom", customType: "cp-bridge", content: "relay" });
	await tick();
	assert.deepEqual(op.states(id), ["request", "queued", "injected", "injected"]);
	await op.turn({ role: "custom", customType: "cp-bridge", content: "relay" });
	await tick();

	assert.equal(op.s.thrown.length, 2);
	assert.deepEqual(op.states(id), ["request", "queued", "injected", "injected", "failed"]);
	assert.equal(op.journal(id).at(-1).reason, "handed to the session twice, never seen in its transcript");
	const send = readPendingSends(op.stateDir).sends.find((row) => row.id === id);
	assert.equal(send?.state, "failed");
	await op.turn({ role: "custom", customType: "cp-bridge", content: "relay" });
	await tick();
	assert.equal(op.states(id).length, 5, "no third handoff");
});
