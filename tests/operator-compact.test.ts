import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { compact, type CompactOptions, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import bridge, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { CP_BRIDGE_EXTENSION, MockProvider, createAgentDir, startRpc } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Tool = { execute: (id: string, params: { instructions: string }, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<unknown> };
const instructions = "Operator delegated cp-b7m6 under the standing mandate. The draft PR awaits review on its pushed head; no merge is authorized yet. Preserve the open decision, held work and next review step. Latest handoff: /home/ubuntu/reports/handoffs/operator.md.";

function setup(t: TestContext) {
	const home = mkdtempSync(join(tmpdir(), "operator-compact-"));
	const old = process.env.PI_HOME;
	process.env.PI_HOME = home;
	t.after(() => { if (old === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = old; rmSync(home, { recursive: true, force: true }); });
	saveOperatorTarget({ home, mode: "multi", hostPid: 0, parentPid: 0 });
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const messages: Array<{ message: { content: string }; options: unknown }> = [];
	const compacts: CompactOptions[] = [];
	const notices: string[] = [];
	const statuses: string[] = [];
	let tokens: number | null = 1000;
	const ctx = {
		hasUI: true, cwd: home,
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens === null ? null : tokens / 10000 }),
		compact: (options: CompactOptions) => compacts.push(options),
		ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, text: string) => statuses.push(text) },
	} as unknown as ExtensionContext;
	bridge({
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: (message: { content: string }, options: unknown) => messages.push({ message, options }),
	} as unknown as ExtensionAPI);
	const emit = async (name: string, event: unknown = {}) => {
		const results = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	const call = (text: string) => {
		const tool = tools.get("self_compact");
		assert.ok(tool, "operator bridge registers self_compact");
		return tool.execute("call", { instructions: text }, undefined, undefined, ctx);
	};
	return { home, ctx, emit, call, messages, compacts, notices, statuses, tokens: (value: number | null) => { tokens = value; } };
}

function beforeCompact(customInstructions?: string): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact", reason: "manual", willRetry: false, customInstructions,
		branchEntries: [], signal: new AbortController().signal,
		preparation: {
			firstKeptEntryId: "kept", tokensBefore: 270000, isSplitTurn: false,
			messagesToSummarize: [{ role: "user", content: "Current work: review cp-b7m6", timestamp: 1 }],
			turnPrefixMessages: [], previousSummary: "Existing summary",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
	};
}

test("self_compact refuses empty, short and pathless instructions before writing", async (t) => {
	const f = setup(t);
	for (const [text, reason] of [["  ", /empty/i], ["Use /handoffs/a.md", /200/], ["Current work. ".repeat(20), /handoff.*path/i]] as const) {
		await assert.rejects(async () => f.call(text), reason);
	}
	assert.equal(f.compacts.length, 0);
	assert.equal(readdirSync(f.home).includes("state"), false);
});

test("self_compact writes instructions and only compacts once after settlement, with visible outcomes", async (t) => {
	const f = setup(t);
	const result = await f.call(instructions);
	assert.match(JSON.stringify(result), /queued/i);
	assert.equal(f.compacts.length, 0);
	const dir = join(f.home, LAYOUT.state, "operator");
	const handoff = join(dir, readdirSync(dir).find((name) => /^compact-.*\.md$/.test(name))!);
	assert.ok(readFileSync(handoff, "utf8").includes(instructions));
	assert.ok(readFileSync(handoff, "utf8").includes(handoff));
	await assert.rejects(() => f.call(instructions), /already.*queued/i);
	await f.emit("turn_end");
	await f.emit("turn_end");
	await f.emit("agent_end");
	assert.equal(f.compacts.length, 0, "tool rounds and agent_end are not settlement");
	await f.emit("agent_settled");
	await f.emit("agent_settled");
	assert.equal(f.compacts.length, 1);
	await assert.rejects(() => f.call(instructions), /already.*running/i);
	assert.ok(f.compacts[0]?.customInstructions?.includes(handoff));
	assert.ok(f.compacts[0]?.customInstructions?.includes(instructions));
	f.compacts[0]?.onComplete?.({ summary: "done", firstKeptEntryId: "kept", tokensBefore: 270000 });
	assert.match(f.notices.join("\n"), /self.compact.*completed/i);
	assert.match(f.statuses.at(-1)!, /last self.compact.*\d{4}-/i);
	await f.call(instructions.replace("/home/ubuntu/reports/handoffs/operator.md", handoff));
	await f.emit("agent_settled");
	f.compacts[1]?.onError?.(new Error("provider unavailable"));
	assert.match(f.notices.join("\n"), /self.compact.*failed.*provider unavailable/i);
});

test("threshold crossing requests once, then compacts automatically if the request is ignored, and rearms below threshold", async (t) => {
	const f = setup(t);
	f.tokens(199999);
	await f.emit("agent_settled");
	f.tokens(200000);
	await f.emit("turn_end");
	assert.equal(f.messages.length, 0, "threshold requests wait for settlement too");
	await f.emit("agent_settled");
	assert.equal(f.messages.length, 1);
	assert.deepEqual(f.messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
	assert.match(f.messages[0]!.message.content, /200000.*200000/);
	assert.match(f.messages[0]!.message.content, /standing mandate.*jobs.*PRs.*heads.*decisions.*hold.*next steps.*handoff.*self_compact.*automatically/i);
	assert.equal(f.compacts.length, 0);
	await f.emit("agent_settled");
	assert.equal(f.compacts.length, 1, "an ignored request compacts on the next settle");
	assert.equal(f.compacts[0]?.customInstructions, undefined, "the backstop uses the handoff-enriched default summarizer");
	await f.emit("agent_settled");
	assert.equal(f.compacts.length, 1, "never a second compaction while one runs");
	f.compacts[0]?.onComplete?.({ summary: "done", firstKeptEntryId: "kept", tokensBefore: 200000 });
	assert.match(f.notices.join("\n"), /automatic compaction.*completed/i);
	f.tokens(null);
	await f.emit("agent_settled");
	assert.equal(f.messages.length, 1, "unknown usage neither requests nor compacts");
	f.tokens(1000);
	await f.emit("agent_settled");
	f.tokens(270000);
	await f.emit("agent_settled");
	assert.equal(f.messages.length, 2);
	assert.match(f.statuses.at(-1)!, /270000.*200000/);
});

test("a failed self_compact is recorded in the session and the next settle compacts automatically, up to three failures", async (t) => {
	const f = setup(t);
	f.tokens(280000);
	await f.emit("agent_settled");
	await f.call(instructions);
	await f.emit("agent_settled");
	f.compacts[0]?.onError?.(new Error("offline"));
	assert.equal(f.messages.length, 2);
	assert.deepEqual(f.messages[1]?.options, { deliverAs: "nextTurn" });
	assert.match(f.messages[1]!.message.content, /self_compact failed: offline.*compacts automatically/);
	await f.emit("agent_settled");
	assert.equal(f.compacts.length, 2);
	f.compacts[1]?.onError?.(new Error("offline"));
	await f.emit("agent_settled");
	f.compacts[2]?.onError?.(new Error("offline"));
	assert.match(f.messages.at(-1)!.message.content, /stopped after 3 failures/);
	for (let i = 0; i < 3; i++) await f.emit("agent_settled");
	assert.equal(f.compacts.length, 3, "persistent failure stops retrying");
});

test("bridge wakes that arrive during a compaction wait for it to end", async (t) => {
	const f = setup(t);
	const { registerOperatorCompact } = await import("../src/operator-compact.ts");
	const handlers = new Map<string, Handler>();
	const compacts: CompactOptions[] = [];
	const control = registerOperatorCompact({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: () => {}, sendMessage: () => {},
	} as unknown as ExtensionAPI, () => ({ home: f.home, mode: "multi" }));
	const ctx = { ...f.ctx, getContextUsage: () => ({ tokens: 300000 }), compact: (o: CompactOptions) => compacts.push(o) } as unknown as ExtensionContext;
	const woke: string[] = [];
	control.whenIdle(() => woke.push("idle"));
	await handlers.get("agent_settled")!({}, ctx);
	await handlers.get("agent_settled")!({}, ctx);
	assert.equal(compacts.length, 1);
	control.whenIdle(() => woke.push("a"));
	control.whenIdle(() => woke.push("b"));
	assert.deepEqual(woke, ["idle"]);
	compacts[0]?.onError?.(new Error("cancelled"));
	assert.deepEqual(woke, ["idle", "a", "b"]);
});

test("operator settings override the trigger; invalid settings use 200000", async (t) => {
	const f = setup(t);
	mkdirSync(join(f.home, LAYOUT.data), { recursive: true });
	const file = join(f.home, LAYOUT.data, "operator.json");
	for (const value of [500, 0, -1, 1.5, "500", null, Number.MAX_SAFE_INTEGER + 1]) {
		writeFileSync(file, JSON.stringify({ compact_at_tokens: value }));
		f.tokens(1);
		await f.emit("agent_settled");
		const count = f.messages.length;
		f.tokens(500);
		await f.emit("agent_settled");
		assert.equal(f.messages.length, count + (value === 500 ? 1 : 0));
		f.tokens(200000);
		await f.emit("agent_settled");
		assert.equal(f.messages.length, count + 1);
		for (const c of f.compacts.splice(0)) c.onComplete?.({ summary: "s", firstKeptEntryId: "k", tokensBefore: 200000 });
	}
	writeFileSync(file, "not JSON");
	f.tokens(1);
	await f.emit("agent_settled");
	const count = f.messages.length;
	f.tokens(200000);
	await f.emit("agent_settled");
	assert.equal(f.messages.length, count + 1);
});

test("manual and backstop compaction enrich the prepared input with the latest handoff without cancelling", async (t) => {
	const f = setup(t);
	const dir = join(f.home, LAYOUT.state, "operator");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "compact-2026-09-25T00:00:00.000Z.md"), "OLD HANDOFF");
	writeFileSync(join(dir, "compact-2026-09-26T00:00:00.000Z.md"), instructions);
	for (const reason of ["manual", "threshold", "overflow"] as const) {
		const event = beforeCompact(reason === "manual" ? "Preserve review details" : undefined);
		event.reason = reason;
		const results = await f.emit("session_before_compact", event);
		assert.ok(results.every((result) => result === undefined));
		const input = JSON.stringify(event.preparation);
		assert.ok(input.includes(instructions));
		assert.ok(input.includes(join(f.home, LAYOUT.state, "operator")));
		assert.ok(input.includes("Existing summary"));
		assert.equal(input.includes("OLD HANDOFF"), false);
		assert.equal(event.preparation.firstKeptEntryId, "kept");
	}
});

test("handoff enrichment reaches pi's actual default summarizer for normal and split compaction", async (t) => {
	const f = setup(t);
	const dir = join(f.home, LAYOUT.state, "operator");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "compact-2026-09-26T00:00:00.000Z.md"), instructions);
	const model: Parameters<typeof compact>[1] = {
		id: "mock", name: "mock", api: "anthropic-messages", provider: "mock", baseUrl: "http://unused",
		reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	for (const split of [false, true]) {
		const event = beforeCompact();
		event.preparation.isSplitTurn = split;
		if (split) event.preparation.turnPrefixMessages = event.preparation.messagesToSummarize.splice(0);
		await f.emit("session_before_compact", event);
		const inputs: Context[] = [];
		const result = await compact(event.preparation, model, "fake-key", undefined, undefined, event.signal, undefined,
			(_model, context) => {
				inputs.push(context);
				const stream = createAssistantMessageEventStream();
				stream.end({ role: "assistant", content: [{ type: "text", text: "Work summary" }], api: model.api,
					provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
				return stream;
			});
		assert.ok(JSON.stringify(inputs).includes(instructions));
		assert.ok(JSON.stringify(inputs).includes(join(f.home, LAYOUT.state, "operator")));
		assert.equal(result.firstKeptEntryId, "kept");
	}
});

test("handoff read failures notify but never cancel the backstop; write failures never queue", async (t) => {
	const f = setup(t);
	const dir = join(f.home, LAYOUT.state, "operator");
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, "compact-broken.md"));
	const event = beforeCompact();
	assert.deepEqual(await f.emit("session_before_compact", event), [undefined]);
	assert.match(f.notices.join("\n"), /handoff enrichment failed/);
	assert.match(JSON.stringify(event.preparation), /standing mandate/);
	rmSync(dir, { recursive: true });
	writeFileSync(dir, "not a directory");
	await assert.rejects(() => f.call(instructions), /handoff write failed/);
	await f.emit("agent_settled");
	assert.equal(f.compacts.length, 0);
});

test("queued self_compact lets the tool-result reply finish before compacting a real Pi run", { timeout: 90_000 }, async (t) => {
	const f = setup(t);
	const provider = await MockProvider.start();
	const model = provider.addScript("operator-compact", [
		{ kind: "tool_calls", calls: [{ name: "self_compact", args: { instructions } }] },
		{ kind: "text", text: "Run completed after the tool result." },
		{ kind: "text", text: "Compacted work summary." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	const rpc = startRpc({ cwd: f.home, env: { ...agent.env, PI_HOME: f.home },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); });
	rpc.send({ type: "prompt", id: "run", message: "Queue compaction, then finish your reply." });
	await rpc.waitFor((record) => record.type === "agent_settled", 60_000);
	const messages = rpc.records().filter((record) => record.type === "message_end").map((record) => record.message);
	assert.ok(JSON.stringify(messages).includes("Run completed after the tool result."), JSON.stringify(messages));
	assert.doesNotMatch(JSON.stringify(messages), /This operation was aborted/);
	await rpc.waitFor((record) => record.type === "extension_ui_request" && record.message === "self_compact completed", 60_000);
	const requests = provider.requests("operator-compact");
	assert.match(JSON.stringify(requests[1]?.body), /self_compact queued/);
	assert.ok(requests.length >= 3, "the summarizer ran after both conversation rounds");
	const records = rpc.records();
	assert.ok(records.findIndex((record) => record.type === "compaction_start") > records.findIndex((record) =>
		record.type === "message_end" && JSON.stringify(record.message).includes("Run completed after the tool result.")));
});

test("fresh-home compaction uses the state operator directory and honors handoffs_dir", async (t) => {
	const f = setup(t);
	const event = beforeCompact();
	await f.emit("session_before_compact", event);
	assert.match(JSON.stringify(event.preparation), /Latest operator handoff directory: .*state[\\/]+operator/);
	mkdirSync(join(f.home, LAYOUT.data), { recursive: true });
	writeFileSync(join(f.home, LAYOUT.data, "operator.json"), JSON.stringify({ handoffs_dir: "/tmp/operator-handoffs" }));
	const configured = beforeCompact();
	await f.emit("session_before_compact", configured);
	assert.ok(JSON.stringify(configured.preparation).includes("Latest operator handoff directory: /tmp/operator-handoffs"));
	await f.call(instructions);
	await f.emit("agent_settled");
	const own = beforeCompact(f.compacts[0]?.customInstructions);
	const before = JSON.stringify(own.preparation);
	await f.emit("session_before_compact", own);
	assert.equal(JSON.stringify(own.preparation), before);
});
