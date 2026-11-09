/**
 * A stand-in `claude` CLI for CI (no login, no network): the Agent SDK's stream-json control protocol over stdio,
 * each turn's model calls sent to tests/harness/claude-mock-provider.ts. It keeps the behaviour the native parent
 * relies on: hooks and SDK MCP calls one tool at a time, `--replay-user-messages` echoes, a `priority: "next"` message
 * joining after the next tool batch (else its own queued turn), `interrupt`, `get_context_usage` and `--resume`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "2.1.318";
type Json = Record<string, unknown>;
type Block = Json & { type: string };
type ApiMessage = { role: "user" | "assistant"; content: Block[] };
type Queued = { message: { role: "user"; content: unknown }; priority?: string; uuid?: string };

const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i]!;
	if (!arg.startsWith("--")) continue;
	const eq = arg.indexOf("=");
	if (eq > 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
	else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags.set(arg.slice(2), argv[++i]!);
	else flags.set(arg.slice(2), "");
}
if (flags.has("version")) {
	process.stdout.write(`${VERSION} (Claude Code)\n`);
	process.exit(0);
}

const write = (line: Json): void => void process.stdout.write(`${JSON.stringify(line)}\n`);
const settings = ((): Json => {
	const file = flags.get("settings");
	try { return file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Json) : {}; } catch { return {}; }
})();
const env = { ...process.env, ...((settings.env as Record<string, string> | undefined) ?? {}) };
const baseUrl = env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const model = flags.get("model") ?? "claude-stub";
const maxTurns = Number(flags.get("max-turns") ?? 100);
const replay = flags.has("replay-user-messages");
const builtins = (flags.get("tools") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const store = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "stub-sessions");

const resumed = flags.get("resume");
const sessionId = resumed ?? randomUUID();
let messages: ApiMessage[] = [];
if (resumed) {
	try {
		messages = (JSON.parse(readFileSync(join(store, `${resumed}.json`), "utf8")) as { messages: ApiMessage[] }).messages;
	} catch {
		write({ type: "result", subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${resumed}`], session_id: sessionId, num_turns: 0, uuid: randomUUID() });
		process.exit(1);
	}
}
const save = (): void => {
	mkdirSync(store, { recursive: true, mode: 0o700 });
	writeFileSync(join(store, `${sessionId}.json`), JSON.stringify({ messages }), { mode: 0o600 });
};

let systemPrompt = "";
let hookIds: string[] = [];
const servers = new Map<string, Array<{ name: string; description?: string; inputSchema?: unknown }>>();
const queue: Queued[] = [];
const waiting = new Map<string, (response: { ok: boolean; body: Json }) => void>();
let busy = false;
let closed = false;
let turnAbort: AbortController | undefined;
let interrupted = false;

/** One control request to the SDK, answered by its control_response. */
function ask(request: Json): Promise<{ ok: boolean; body: Json }> {
	const id = randomUUID();
	write({ type: "control_request", request_id: id, request });
	return new Promise((resolve) => waiting.set(id, resolve));
}

const tools = (): Json[] => [
	...builtins.map((name) => ({ name, description: `${name} (stub)`, input_schema: { type: "object", properties: {} } })),
	...[...servers].flatMap(([server, list]) => list.map((each) => ({ name: `mcp__${server}__${each.name}`, description: each.description ?? "", input_schema: each.inputSchema ?? { type: "object" } }))),
];
const textOf = (content: unknown): string => typeof content === "string" ? content
	: Array.isArray(content) ? (content as Block[]).filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n") : "";
const blocksOf = (content: unknown): Block[] => typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];
const emitUser = (content: Block[], extra: Json = {}): void => write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), ...extra });

/** Queued input enters the conversation: each message is replayed (when asked) as the CLI takes it. */
function take(items: Queued[]): Block[] {
	return items.flatMap((item) => {
		if (replay) write({ type: "user", message: item.message, parent_tool_use_id: null, session_id: sessionId, uuid: item.uuid ?? randomUUID(), isReplay: true });
		return blocksOf(item.message.content);
	});
}

async function callModel(signal: AbortSignal): Promise<{ status: number; body: Json }> {
	const token = env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_AUTH_TOKEN;
	const response = await fetch(`${baseUrl}/v1/messages?beta=true`, {
		method: "POST",
		signal,
		headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(token ? { authorization: `Bearer ${token}` } : { "x-api-key": env.ANTHROPIC_API_KEY ?? "" }) },
		body: JSON.stringify({ model, max_tokens: 32_000, system: [{ type: "text", text: systemPrompt }], messages, tools: tools(), stream: false }),
	});
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Json };
}

/** One tool call: the PreToolUse hook, else can_use_tool, then the SDK MCP server; never two at once. */
async function runTool(block: Block): Promise<Block> {
	const name = String(block.name), id = String(block.id), input = block.input as Json;
	let decision: string | undefined;
	let reason = "";
	for (const callback of hookIds) {
		const hook = await ask({ subtype: "hook_callback", callback_id: callback, tool_use_id: id, input: { session_id: sessionId, cwd: process.cwd(), permission_mode: "default", hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id } });
		const output = hook.body.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
		if (output?.permissionDecision) { decision = output.permissionDecision; reason = output.permissionDecisionReason ?? ""; }
		if (decision === "deny") break;
	}
	if (decision !== "allow" && decision !== "deny") {
		const permission = await ask({ subtype: "can_use_tool", tool_name: name, input, tool_use_id: id, permission_suggestions: [] });
		decision = permission.ok && permission.body.behavior === "allow" ? "allow" : "deny";
		reason = String(permission.body.message ?? `${name} was denied`);
	}
	if (decision === "deny") return { type: "tool_result", tool_use_id: id, content: reason, is_error: true };
	const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
	if (!match || !servers.has(match[1]!)) return { type: "tool_result", tool_use_id: id, content: `No such tool available: ${name}`, is_error: true };
	const call = await ask({ subtype: "mcp_message", server_name: match[1], message: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: match[2], arguments: input, _meta: { "claudecode/toolUseId": id } } } });
	const result = ((call.body.mcp_response as Json | undefined)?.result ?? {}) as { content?: unknown; isError?: boolean };
	return { type: "tool_result", tool_use_id: id, content: result.content ?? "", ...(result.isError ? { is_error: true } : {}) };
}

/** One turn: the queued input, model calls and tool batches until the model stops, then one result. */
async function turn(items: Queued[]): Promise<void> {
	turnAbort = new AbortController();
	interrupted = false;
	const started = Date.now();
	write({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: tools().map((each) => each.name), mcp_servers: [...servers.keys()].map((name) => ({ name, status: "connected" })), model, permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: VERSION, uuid: randomUUID() });
	messages.push({ role: "user", content: take(items) });
	// Saved as it grows, like the CLI's transcript: a turn killed midway still resumes.
	save();
	let turns = 0;
	let last = "";
	let error: string | undefined;
	let failed = false;
	const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	try {
		for (;;) {
			turns += 1;
			const { status, body } = await callModel(turnAbort.signal);
			if (status !== 200) {
				const message = ((body.error as Json | undefined)?.message as string | undefined) ?? `status ${status}`;
				last = `API Error: ${status} ${message}`;
				write({ type: "assistant", message: { id: `msg_stub_${randomUUID()}`, role: "assistant", model, content: [{ type: "text", text: last }], stop_reason: "stop_sequence" }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), error: status === 401 ? "authentication_failed" : "unknown" });
				failed = true;
				break;
			}
			const content = (body.content as Block[] | undefined) ?? [];
			for (const [key, value] of Object.entries((body.usage as Record<string, number> | undefined) ?? {})) if (key in usage) usage[key as keyof typeof usage] += value;
			write({ type: "assistant", message: body, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
			messages.push({ role: "assistant", content });
			save();
			last = textOf(content) || last;
			const calls = content.filter((block) => block.type === "tool_use");
			if (body.stop_reason !== "tool_use" || calls.length === 0) break;
			const results: Block[] = [];
			for (const call of calls) {
				const result = interrupted ? { type: "tool_result", tool_use_id: call.id, content: "Interrupted", is_error: true } : await runTool(call);
				results.push(result);
				emitUser([result], { tool_use_result: result.content });
			}
			// The pass between tool batches: messages sent mid-turn at priority "next" join the next model call.
			const steered = queue.filter((item) => item.priority !== "later");
			queue.splice(0, queue.length, ...queue.filter((item) => item.priority === "later"));
			messages.push({ role: "user", content: [...results, ...take(steered)] });
			save();
			if (interrupted) throw new Error("interrupted");
			if (turns >= maxTurns) { error = "error_max_turns"; break; }
		}
	} catch (caught) {
		if (!interrupted) { failed = true; last = `API Error: ${(caught as Error).message}`; }
	}
	if (interrupted) {
		const note: Block = { type: "text", text: "[Request interrupted by user]" };
		messages.push({ role: "user", content: [note] });
		emitUser([note]);
	}
	save();
	const subtype = interrupted ? "error_during_execution" : error ?? "success";
	write({ type: "result", subtype, is_error: interrupted || failed || error !== undefined, result: last, session_id: sessionId, num_turns: turns, duration_ms: Date.now() - started, duration_api_ms: 0, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], stop_reason: interrupted ? "tool_use" : "end_turn", uuid: randomUUID() });
}

async function pump(): Promise<void> {
	if (busy) return;
	busy = true;
	try {
		while (queue.length > 0) await turn(queue.splice(0));
	} finally {
		busy = false;
		turnAbort = undefined;
	}
	if (closed) process.exit(0);
}

function control(id: string, request: Json): void {
	const reply = (response: Json) => write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
	if (request.subtype === "initialize") {
		systemPrompt = Array.isArray(request.systemPrompt) ? (request.systemPrompt as string[]).join("\n\n") : String(request.systemPrompt ?? "");
		hookIds = (((request.hooks as Json | undefined)?.PreToolUse as Array<{ hookCallbackIds?: string[] }> | undefined) ?? []).flatMap((matcher) => matcher.hookCallbackIds ?? []);
		for (const [name, manifest] of Object.entries((request.sdkMcpServerManifests as Record<string, { toolsListResult?: { tools?: [] } }> | undefined) ?? {})) servers.set(name, manifest.toolsListResult?.tools ?? []);
		for (const name of (request.sdkMcpServers as string[] | undefined) ?? []) if (!servers.has(name)) servers.set(name, []);
		return reply({ commands: [], agents: [], models: [], account: { apiProvider: "firstParty" }, pid: process.pid, claude_code_version: VERSION });
	}
	if (request.subtype === "interrupt") {
		if (busy) { interrupted = true; turnAbort?.abort(); }
		return reply({ still_queued: [] });
	}
	if (request.subtype === "get_context_usage") {
		const totalTokens = Math.ceil(JSON.stringify(messages).length / 4);
		return reply({ totalTokens, maxTokens: 200_000, percentage: (totalTokens / 200_000) * 100, categories: [] });
	}
	reply({});
}

createInterface({ input: process.stdin }).on("line", (line) => {
	let record: Json;
	try { record = JSON.parse(line) as Json; } catch { return; }
	if (record.type === "control_request") return control(String(record.request_id), record.request as Json);
	if (record.type === "control_response") {
		const response = record.response as { subtype?: string; request_id?: string; response?: Json; error?: string };
		const resolve = waiting.get(String(response.request_id));
		waiting.delete(String(response.request_id));
		return resolve?.({ ok: response.subtype === "success", body: response.response ?? { message: response.error } });
	}
	if (record.type === "user") {
		queue.push({ message: record.message as Queued["message"], ...(typeof record.priority === "string" ? { priority: record.priority } : {}), ...(typeof record.uuid === "string" ? { uuid: record.uuid } : {}) });
		void pump();
	}
}).on("close", () => {
	// As the real CLI does, a turn in flight when stdin ends runs to its result first: a dead parent's child lingers.
	closed = true;
	if (!busy) process.exit(0);
});
