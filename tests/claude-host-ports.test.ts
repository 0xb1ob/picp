/**
 * O1 unit: HeadlessHost's optional ports. Only the Claude CLI operator (O2) will pass them, so no product entry point
 * reaches them yet; the parent passes none, and native-parent*.test.ts pin that path end to end.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadlessHost, type HostModel, type HostPorts } from "../src/drivers/claude-parent-session.ts";
import type { SessionEntry } from "../src/worker-process.ts";

const base = (): HostPorts => ({
	write: () => undefined,
	sendMessage: () => undefined,
	isIdle: () => true,
	abort: () => undefined,
	sessionId: () => "sid",
	contextTokens: () => null,
	entries: () => [],
});

type Ctx = Record<string, unknown> & { sessionManager: Record<string, unknown> };
type Api = Record<string, unknown>;

// Scenario: Given a host with every optional port, When an extension reads its pi API and ctx,
// Then each port surfaces under pi's name, ctx.model follows the port live,
// And modelRegistry.find resolves only an anthropic/claude-* ref (to {provider, id}).
test("O1: each given port surfaces through the host's api and headlessContext", async () => {
	const calls: string[] = [];
	let model: HostModel | undefined = { provider: "anthropic", id: "claude-opus-5-5" };
	const branch = [{ type: "message", id: "e1" }] as unknown as SessionEntry[];
	const host = new HeadlessHost({
		...base(),
		sendUserMessage: (content) => void calls.push(`send:${String(content)}`),
		hasPendingMessages: () => true,
		sessionFile: () => "/tmp/record.jsonl",
		branch: () => branch,
		model: () => model,
		getThinking: () => "high",
		setThinking: (level) => void calls.push(`thinking:${level}`),
		setModel: async (next) => (calls.push(`model:${next.provider}/${next.id}`), true),
		compact: (options) => void calls.push(`compact:${options?.customInstructions}`),
		shutdown: () => void calls.push("shutdown"),
	}, "/work");
	const ctx = host.ctx as unknown as Ctx;
	const api = host.api() as unknown as Api;
	(api.sendUserMessage as (content: string) => void)("hi");
	(api.setThinkingLevel as (level: string) => void)("low");
	assert.equal((api.getThinkingLevel as () => string)(), "high");
	assert.equal(await (api.setModel as (m: HostModel) => Promise<boolean>)({ provider: "anthropic", id: "claude-x" }), true);
	(ctx.compact as (options: { customInstructions: string }) => void)({ customInstructions: "keep asks" });
	(ctx.shutdown as () => void)();
	assert.deepEqual(calls, ["send:hi", "thinking:low", "model:anthropic/claude-x", "compact:keep asks", "shutdown"]);
	assert.equal((ctx.hasPendingMessages as () => boolean)(), true);
	assert.equal((ctx.sessionManager.getSessionFile as () => string)(), "/tmp/record.jsonl");
	assert.equal((ctx.sessionManager.getBranch as () => SessionEntry[])(), branch);
	assert.deepEqual(ctx.model, { provider: "anthropic", id: "claude-opus-5-5" });
	model = { provider: "anthropic", id: "claude-sonnet-5" };
	assert.deepEqual(ctx.model, model, "ctx.model reads the port on each access, not once at mount");
	const registry = ctx.modelRegistry as { find: (provider: string, id: string) => unknown };
	assert.deepEqual(registry.find("anthropic", "claude-opus-5-5"), { provider: "anthropic", id: "claude-opus-5-5" });
	assert.equal(registry.find("openai", "gpt-5"), undefined, "a non-Claude ref is not in the native registry");
});

// Scenario: Given a host built with only the parent's required ports (as claude-parent.ts builds it),
// When an extension reads its pi API and ctx, Then every value is today's: no added API member, modelRegistry and model
// undefined, getBranch empty, and no hasPendingMessages, shutdown, compact or getSessionFile.
test("O1: an omitted port keeps the parent's headless values", () => {
	const host = new HeadlessHost(base(), "/work");
	const ctx = host.ctx as unknown as Ctx;
	const api = host.api() as unknown as Api;
	for (const name of ["sendUserMessage", "getThinkingLevel", "setThinkingLevel", "setModel"]) assert.equal(name in api, false, `api.${name}`);
	for (const name of ["hasPendingMessages", "shutdown", "compact"]) assert.equal(name in ctx, false, `ctx.${name}`);
	assert.equal("getSessionFile" in ctx.sessionManager, false);
	assert.equal(ctx.modelRegistry, undefined);
	assert.equal(ctx.model, undefined);
	assert.deepEqual((ctx.sessionManager.getBranch as () => unknown[])(), []);
	assert.equal((ctx.sessionManager.getSessionId as () => string)(), "sid");
	assert.equal(ctx.mode, "rpc");
});
