import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import bridge, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { isToolAdditionRejection } from "../src/operator-compact.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Tool = { execute: (id: string, params: { instructions: string }, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<unknown> };

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

test("S1: pi's benign compact skips never count as failures, release waiters and leave the next settle eligible", async (t) => {
	const f = setup(t);
	f.tokens(280000);
	await f.emit("agent_settled");
	for (let i = 0; i < 5; i++) {
		await f.emit("agent_settled");
		f.compacts[i]?.onError?.(new Error(i % 2 ? "Already compacted" : "Nothing to compact (session too small)"));
	}
	assert.equal(f.compacts.length, 5, "each later settle retries; no immediate retry, never exhausted");
	assert.match(f.notices.join("\n"), /automatic compaction.*skipped: Nothing to compact \(session too small\)/);
	assert.doesNotMatch(f.notices.join("\n"), /failed|completed/);
	assert.equal(f.messages.length, 1, "only the threshold request; no failure record");
	assert.doesNotMatch(f.statuses.join("\n"), /last self-compact: \d/, "a skip never stamps lastCompactAt");
	const { registerOperatorCompact } = await import("../src/operator-compact.ts");
	const handlers = new Map<string, Handler>();
	const control = registerOperatorCompact({ on: (name: string, handler: Handler) => handlers.set(name, handler), registerTool: () => {}, sendMessage: () => {} } as unknown as ExtensionAPI, () => ({ home: f.home, mode: "multi" }));
	const compacts: CompactOptions[] = [];
	const ctx = { ...f.ctx, getContextUsage: () => ({ tokens: 300000 }), compact: (o: CompactOptions) => compacts.push(o) } as unknown as ExtensionContext;
	await handlers.get("agent_settled")!({}, ctx);
	await handlers.get("agent_settled")!({}, ctx);
	const woke: string[] = [];
	control.whenIdle(() => woke.push("queued"));
	assert.equal(woke.length, 0);
	compacts[0]?.onError?.(new Error("Already compacted"));
	assert.deepEqual(woke, ["queued"], "queued whenIdle callbacks release on a skip");
	let calls = 0;
	const throwing = { ...ctx, compact: () => { calls++; throw new Error("Already compacted"); } } as unknown as ExtensionContext;
	for (let i = 0; i < 4; i++) await handlers.get("agent_settled")!({}, throwing);
	control.whenIdle(() => woke.push("idle"));
	assert.equal(calls, 4, "a synchronous throw takes the same skip path, and stays eligible");
	assert.deepEqual(woke, ["queued", "idle"], "nothing left running");
});

const REJECTED = { role: "assistant", stopReason: "error", errorMessage: "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.684.content.0: `tool_addition` blocks require anthropic-beta: inline-tools-2026-09-15\"}}" };

test("N5: isToolAdditionRejection matches only an assistant error naming tool_addition with a 400", () => {
	assert.equal(isToolAdditionRejection(REJECTED), true);
	assert.equal(isToolAdditionRejection({ ...REJECTED, errorMessage: "messages.4: `tool_addition` blocks require anthropic-beta (invalid_request_error)" }), true);
	assert.equal(isToolAdditionRejection({ ...REJECTED, role: "user" }), false);
	assert.equal(isToolAdditionRejection({ ...REJECTED, stopReason: "stop" }), false);
	assert.equal(isToolAdditionRejection({ ...REJECTED, errorMessage: "529 overloaded" }), false);
	assert.equal(isToolAdditionRejection({ ...REJECTED, errorMessage: "tool_addition blocks are not supported" }), false);
	assert.equal(isToolAdditionRejection(undefined), false);
});
