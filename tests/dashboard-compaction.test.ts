import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CompactOptions } from "@earendil-works/pi-coding-agent";
import bridgeExtension, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { LAYOUT } from "../src/contracts.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import { controlJournalFile, readControlRecord } from "../src/viewer/control-files.ts";
import { readPendingSends } from "../src/viewer/control-pending.ts";
import { createScratchHome } from "./harness/index.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Tool = { name: string; execute: (id: string, params: { instructions: string }, signal: undefined, update: undefined, ctx: unknown) => Promise<unknown> };
const instructions = "Operator delegated cp-b7m6 under the standing mandate. The draft PR awaits review on its pushed head; no merge is authorized yet. Preserve the open decision, held work and next review step. Latest handoff: /home/ubuntu/reports/handoffs/operator.md.";
const tick = () => new Promise((done) => setImmediate(done));

// A fake pi 1.0.4: prompts sent inside agent_settled are deferred behind the settle's own turns (agent-session.js
// 693-701), and a prompt submitted while compacting throws before any `input` event (agent-session.js 1529-1531).
function fakePi(home: string) {
	const s = { active: false, compacting: false, emitting: false, tokens: 270000, deferred: [] as Array<() => Promise<void>>, thrown: [] as string[], prompts: [] as string[], compacts: [] as CompactOptions[] };
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const ctx = {
		hasUI: true, cwd: home, abort: () => {},
		isIdle: () => !s.active && !s.compacting,
		hasPendingMessages: () => false,
		sessionManager: { getSessionFile: () => join(home, "operator-session.jsonl"), getEntries: () => [] },
		getContextUsage: () => ({ tokens: s.tokens, contextWindow: 1_000_000, percent: s.tokens / 10000 }),
		compact: (options: CompactOptions) => { s.compacting = true; s.compacts.push(options); },
		ui: { notify: () => {}, setStatus: () => {} },
	};
	const emit = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	const settle = async (): Promise<void> => {
		s.emitting = true;
		await emit("agent_settled");
		s.emitting = false;
		for (const action of s.deferred.splice(0)) {
			try { await action(); } catch (error) { s.thrown.push((error as Error).message); break; }
		}
	};
	const run = async (text: string): Promise<void> => {
		if (s.compacting) throw new Error("Cannot submit a prompt while compaction is in progress.");
		await emit("input", { type: "input", text, source: "extension" });
		s.active = true;
		s.prompts.push(text);
		await emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
		s.active = false;
		await settle();
	};
	const compactTurn = async (): Promise<void> => {
		s.active = true;
		await tick();
		await tools.get("self_compact")!.execute("call", { instructions }, undefined, undefined, ctx);
		s.active = false;
		await settle();
	};
	bridgeExtension({
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: (message: { customType?: string }, options?: { triggerTurn?: boolean }) => {
			if (options?.triggerTurn && s.emitting && message.customType === "operator-compact-request") s.deferred.push(compactTurn);
		},
		sendUserMessage: (content: unknown) => {
			const text = typeof content === "string" ? content : JSON.stringify(content);
			if (s.emitting) s.deferred.push(() => run(text));
			else void run(text).catch((error: Error) => s.thrown.push(error.message));
		},
	} as never);
	return { s, emit, settle };
}

test("a dashboard message queued mid-turn survives the compaction its settle starts: held, then handed over after it ends, delivered once", async (t) => {
	const scratch = createScratchHome();
	const home = scratch.path;
	const stateDir = join(home, LAYOUT.state);
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = join(home, "pi-home");
	t.after(() => { if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous; scratch.cleanup(); });
	saveOperatorTarget({ home, mode: "multi", hostPid: 0, parentPid: 0 });
	const { s, emit, settle } = fakePi(home);
	await emit("session_start");
	t.after(() => emit("session_shutdown"));
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	const control = (record as { record: Parameters<typeof controlRequest>[0] }).record;

	s.active = true;
	const sent = await controlRequest(control, "send", { kind: "message", text: "list the validator owner wallets" });
	assert.ok(sent.ok && (sent.result as { state: string }).state === "queued", JSON.stringify(sent));
	const id = (sent.result as { id: string }).id;
	s.active = false;
	await settle();
	assert.equal(s.compacts.length, 1, "the settle's deferred compact-request turn called self_compact");
	assert.ok(s.compacting);
	const edit = await controlRequest(control, "queue_edit", { id, text: "list the validator owner wallets" });
	assert.ok(edit.ok && (edit.result as { editable: boolean }).editable, `still dashboard-held while compacting: ${JSON.stringify(edit)}`);

	await emit("session_compact", {});
	s.compacting = false;
	s.tokens = 1000;
	s.compacts[0]!.onComplete?.({ summary: "s", firstKeptEntryId: "k", tokensBefore: 270000 });
	for (let i = 0; i < 3; i++) await tick();

	assert.deepEqual(s.thrown, [], "no deferred prompt was refused");
	assert.equal(s.prompts.filter((text) => text.includes(`[cp-dashboard ${id} `)).length, 1, "pi got the message once");
	const file = controlJournalFile(stateDir);
	const states = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.id === id).map((l) => l.type === "outcome" ? l.state : l.type) : [];
	assert.deepEqual(states.filter((state) => state !== "edited"), ["request", "queued", "injected", "delivered"]);
	assert.equal(readPendingSends(stateDir).sends.find((send) => send.id === id)?.state, "delivered");
});
