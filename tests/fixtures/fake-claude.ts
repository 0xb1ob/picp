/**
 * A stand-in `claude` CLI for the Agent SDK (stream-json over stdio, the control protocol included) that sends each
 * model call to tests/harness/claude-mock-provider.ts, so native e2e cases run where Claude Code is not installed.
 * Covers what the native parent drives: turns, cp_* tools over the SDK's MCP relay with PreToolUse hooks, `--resume`,
 * `/compact <instructions>` (as claude 2.1.318 runs it), `getContextUsage`, `interrupt`, `--replay-user-messages` and
 * a mid-turn message joining after the next tool batch (else its own queued turn); for the operator, Bash/Read/Write,
 * Stop hooks, image blocks, `--mcp-config` stdio servers and the lockdown's hook listing. Each spawn's argv is logged.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { CLAUDE_VERSION_FLOOR } from "../../src/drivers/claude-cli.ts";

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant" | "system"; content: string | Block[] };
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };
type Queued = { message: Message; priority?: string; uuid?: string };

const MAX_TOKENS = 200_000;
const args = process.argv.slice(2);
if (args.includes("--version")) {
	process.stdout.write(`${CLAUDE_VERSION_FLOOR} (Claude Code)\n`);
	process.exit(0);
}

function flag(name: string): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === name) return args[i + 1];
		if (args[i]!.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
	}
	return undefined;
}

const store = join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? ".", ".claude"), "fake-claude");
mkdirSync(join(store, "sessions"), { recursive: true });
appendFileSync(join(store, "spawns.jsonl"), `${JSON.stringify({ argv: args, at: new Date().toISOString() })}\n`);

const settingsArg = flag("--settings");
const settings = settingsArg === undefined ? {} : JSON.parse(settingsArg.startsWith("{") ? settingsArg : readFileSync(settingsArg, "utf8")) as { env?: Record<string, string> };
const env = { ...process.env, ...settings.env };
const model = flag("--model") ?? "claude-picp-fake";
/** claude 2.1.318 sends `--effort` as the request's `output_config.effort`. */
const effort = flag("--effort");
const replay = args.includes("--replay-user-messages");
const builtins = flag("--tools")?.split(",").filter(Boolean) ?? [];
/** Test knob (settings env): `off` skips every SDK hook callback, PreToolUse and Stop alike (a negative control). */
const hooksOff = env.FAKE_CLAUDE_HOOKS === "off";
/** Stop-hook continuations one turn takes before it ends anyway (claude has no cap; this fake must never spin). */
const MAX_STOP_BLOCKS = 3;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** `--managed-settings`: claude binds `disableAllHooks` as the managed-only hook lock its hook listing reports. */
const managedOnly = (JSON.parse(flag("--managed-settings") ?? "{}") as { disableAllHooks?: unknown }).disableAllHooks === true;
/** `--mcp-config` stdio servers, spawned on first use; an http entry is listed as failed (this fake has no client). */
const configured = (JSON.parse(flag("--mcp-config") ?? "{}") as { mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; env?: Record<string, string> }> }).mcpServers ?? {};
const external = Object.entries(configured).filter(([, server]) => server.type !== "sdk");
/** Test knob (settings env): JSON merged into every `system/init`, a surface picp never passed (the lockdown's case). */
const initExtra = JSON.parse(env.FAKE_CLAUDE_INIT_EXTRA ?? "{}") as Record<string, unknown>;
const resumed = flag("--resume");
const sessionId = resumed ?? randomUUID();
const sessionPath = join(store, "sessions", `${sessionId}.json`);
let history: Message[] = [];
let contextTokens = 0;

const send = (line: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(line)}\n`);
const result = (fields: Record<string, unknown>): void => send({
	type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: "",
	stop_reason: null, session_id: sessionId, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	modelUsage: {}, permission_denials: [], uuid: randomUUID(), ...fields,
});

if (resumed !== undefined) {
	if (!existsSync(sessionPath)) {
		result({ subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${resumed}`] });
		process.exit(1);
	}
	({ history, contextTokens } = JSON.parse(readFileSync(sessionPath, "utf8")) as { history: Message[]; contextTokens: number });
}
const save = (): void => writeFileSync(sessionPath, JSON.stringify({ history, contextTokens }));

let ids = 0;
const pending = new Map<string, Pending>();
/** A control request to the SDK (an MCP relay or a hook callback); resolves with its `response`. */
function request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const id = `fake-claude-${++ids}`;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ type: "control_request", request_id: id, request: body });
	});
}

let hookIds: string[] = [];
let stopIds: string[] = [];
let servers: string[] = [];
let systemPrompt = "";
type ToolDef = { name: string; description?: string; input_schema: unknown };
let tools: ToolDef[] | undefined;
let interrupted = false;
let turnAbort: AbortController | undefined;
/** Input not yet taken: a turn takes one, and the pass after each tool batch takes those not sent at "later". */
const inbox: Queued[] = [];
/** The input enters the conversation; with `--replay-user-messages` it is echoed under its own uuid, as claude does. */
function take(item: Queued): Message["content"] {
	if (replay) send({ type: "user", message: item.message, parent_tool_use_id: null, session_id: sessionId, uuid: item.uuid ?? randomUUID(), isReplay: true });
	return item.message.content;
}

type Rpc = { result?: Record<string, unknown>; error?: { message?: string } };
const stdioNames = external.filter(([, server]) => typeof server.command === "string").map(([name]) => name);
const stdio = new Map<string, { child: ChildProcessWithoutNullStreams; waiting: Map<number, (rpc: Rpc) => void> }>();
/** A `--mcp-config` stdio server over newline-delimited JSON-RPC, started on first use. */
function stdioServer(name: string): { child: ChildProcessWithoutNullStreams; waiting: Map<number, (rpc: Rpc) => void> } {
	const running = stdio.get(name);
	if (running) return running;
	const config = configured[name]!;
	const child = spawn(config.command!, config.args ?? [], { env: { ...process.env, ...config.env }, stdio: "pipe" });
	child.stderr.resume();
	const waiting = new Map<number, (rpc: Rpc) => void>();
	createInterface({ input: child.stdout }).on("line", (line) => {
		const message = JSON.parse(line) as Rpc & { id?: number };
		if (message.id !== undefined) waiting.get(message.id)?.(message);
	});
	stdio.set(name, { child, waiting });
	return { child, waiting };
}

async function mcp(server: string, method: string, params?: unknown): Promise<Record<string, unknown>> {
	const id = ++ids;
	const message = { jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id }), method, ...(params === undefined ? {} : { params }) };
	let response: Rpc;
	if (stdioNames.includes(server)) {
		const { child, waiting } = stdioServer(server);
		child.stdin.write(`${JSON.stringify(message)}\n`);
		if (!("id" in message)) return {};
		response = await new Promise<Rpc>((done) => waiting.set(id, done));
	} else response = ((await request({ subtype: "mcp_message", server_name: server, message })).mcp_response ?? {}) as Rpc;
	if (response.error) throw new Error(`${server} ${method}: ${response.error.message ?? "error"}`);
	return response.result ?? {};
}

/** The SDK and stdio servers' tools as the CLI names them (`mcp__<server>__<tool>`), listed once per process. */
async function listTools(): Promise<ToolDef[]> {
	if (tools) return tools;
	const listed: ToolDef[] = [];
	for (const server of [...servers, ...stdioNames]) {
		await mcp(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: CLAUDE_VERSION_FLOOR } });
		await mcp(server, "notifications/initialized");
		const { tools: found = [] } = await mcp(server, "tools/list") as { tools?: Array<{ name: string; description?: string; inputSchema: unknown }> };
		for (const each of found) listed.push({ name: `mcp__${server}__${each.name}`, description: each.description, input_schema: each.inputSchema });
	}
	return (tools = listed);
}

async function callModel(messages: Message[]): Promise<{ status: number; body: Record<string, unknown> }> {
	const base = env.ANTHROPIC_BASE_URL;
	if (!base) throw new Error("fake claude: no ANTHROPIC_BASE_URL in the environment or --settings");
	const response = await fetch(`${base}/v1/messages`, {
		method: "POST",
		...(turnAbort ? { signal: turnAbort.signal } : {}),
		headers: { "content-type": "application/json", authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN ?? ""}` },
		body: JSON.stringify({ model, max_tokens: 4096, system: [{ type: "text", text: systemPrompt }], messages, tools: await listTools(), stream: false, ...(effort ? { output_config: { effort } } : {}) }),
	});
	return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const textOf = (content: Message["content"]): string => typeof content === "string" ? content
	: content.filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");

const failed = (status: number, body: Record<string, unknown>): string =>
	`API Error: ${status} ${(body.error as { message?: string } | undefined)?.message ?? JSON.stringify(body)}`;

/** The built-ins `--tools` names that a case drives (Bash, Read, Write), run for real; any other is not available. */
function builtin(name: string, input: Record<string, unknown>, toolUseId: string): Block {
	const done = (content: string, isError = false): Block => ({ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content });
	try {
		const file = String(input.file_path ?? "");
		if (name === "Read") return done(readFileSync(file, "utf8"));
		if (name === "Write") {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, String(input.content ?? ""));
			return done(`File created successfully at: ${file}`);
		}
		if (name === "Bash") return done(execFileSync("sh", ["-c", String(input.command ?? "")], { encoding: "utf8" }));
	} catch (error) {
		return done((error as Error).message, true);
	}
	return done(`No such tool available: ${name}`, true);
}

/** One tool_use: the PreToolUse hooks first (a deny is the result), then the SDK server's `tools/call`. */
async function runTool(use: Block): Promise<Block> {
	const name = String(use.name);
	const toolUseId = String(use.id);
	for (const callback of hooksOff ? [] : hookIds) {
		const input = { session_id: sessionId, transcript_path: sessionPath, cwd: process.cwd(), permission_mode: "default", hook_event_name: "PreToolUse", tool_name: name, tool_input: use.input, tool_use_id: toolUseId };
		const out = await request({ subtype: "hook_callback", callback_id: callback, input, tool_use_id: toolUseId }) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
		if (out.hookSpecificOutput?.permissionDecision === "deny") {
			return { type: "tool_result", tool_use_id: toolUseId, is_error: true, content: out.hookSpecificOutput.permissionDecisionReason ?? "denied" };
		}
	}
	if (builtins.includes(name)) return builtin(name, (use.input ?? {}) as Record<string, unknown>, toolUseId);
	// Test knob (settings env): hold the first allowed call to this tool before it runs, until an interrupt ends the turn.
	if (env.FAKE_CLAUDE_HOLD_AFTER_ALLOW === name && !existsSync(join(store, "held"))) {
		writeFileSync(join(store, "held"), toolUseId);
		const signal = turnAbort?.signal;
		if (signal && !signal.aborted) await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
		return { type: "tool_result", tool_use_id: toolUseId, is_error: true, content: "Interrupted before the tool ran" };
	}
	const server = [...servers, ...stdioNames].find((each) => name.startsWith(`mcp__${each}__`));
	if (!server) return { type: "tool_result", tool_use_id: toolUseId, is_error: true, content: `No such tool available: ${name}` };
	// Test knob: FAKE_CLAUDE_NO_TOOL_META=1 sends no tool_use id with tools/call, as a CLI without the meta would.
	const meta = env.FAKE_CLAUDE_NO_TOOL_META === "1" ? {} : { _meta: { "claudecode/toolUseId": toolUseId } };
	const params = { name: name.slice(`mcp__${server}__`.length), arguments: use.input ?? {}, ...meta };
	const called = await mcp(server, "tools/call", params) as { content?: Block[]; isError?: boolean };
	return { type: "tool_result", tool_use_id: toolUseId, is_error: called.isError === true, content: called.content ?? [] };
}

const init = (): void => send({
	type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: [...builtins, ...(tools ?? []).map((each) => each.name)],
	mcp_servers: [...servers, ...external.map(([name]) => name)].map((name) => ({ name, status: servers.includes(name) || stdioNames.includes(name) ? "connected" : "failed" })),
	permissionMode: "default", slash_commands: ["compact"], apiKeySource: "none", claude_code_version: CLAUDE_VERSION_FLOOR, output_style: "default", uuid: randomUUID(),
	...initExtra,
});

const validImage = (block: Block): boolean => {
	const source = block.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
	return source?.type === "base64" && IMAGE_TYPES.includes(String(source.media_type)) && typeof source.data === "string" && source.data.length > 0;
};

/** The Stop hooks in order; the first `decision: "block"` is the reason the turn goes on. */
async function stopBlock(active: boolean): Promise<string | undefined> {
	for (const callback of hooksOff ? [] : stopIds) {
		const input = { session_id: sessionId, transcript_path: sessionPath, cwd: process.cwd(), permission_mode: "default", hook_event_name: "Stop", stop_hook_active: active };
		const out = await request({ subtype: "hook_callback", callback_id: callback, input }) as { decision?: string; reason?: string };
		if (out.decision === "block") return out.reason ?? "";
	}
	return undefined;
}

async function turn(item: Queued): Promise<void> {
	await listTools();
	init();
	interrupted = false;
	const content = take(item);
	// The API's own check: a user image is a base64 source of a supported type, never pi's `{ data, mimeType }` shape.
	if (Array.isArray(content) && content.some((block) => block.type === "image" && !validImage(block))) {
		return result({ is_error: true, result: "API Error: 400 messages: an image must be a base64 source of a png, jpeg, gif or webp media_type", num_turns: 0 });
	}
	turnAbort = new AbortController();
	history.push({ role: "user", content });
	// Saved as it grows, like claude's transcript: a turn killed midway still resumes.
	save();
	let text = "";
	let rounds = 0;
	let stops = 0;
	while (!interrupted) {
		rounds++;
		let reply: Awaited<ReturnType<typeof callModel>>;
		try {
			reply = await callModel(history);
		} catch (error) {
			if (interrupted) break;
			throw error;
		}
		const { status, body } = reply;
		if (status !== 200) {
			send({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "text", text: failed(status, body) }], stop_reason: "stop_sequence", usage: {} }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), error: status === 401 ? "authentication_failed" : "unknown" });
			history.pop();
			turnAbort = undefined;
			save();
			return result({ is_error: true, result: failed(status, body), num_turns: rounds });
		}
		send({ type: "assistant", message: body, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
		const blocks = (body.content as Block[] | undefined) ?? [];
		history.push({ role: "assistant", content: blocks });
		save();
		const usage = (body.usage ?? {}) as Record<string, number | undefined>;
		contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
		text = blocks.filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");
		const uses = blocks.filter((block) => block.type === "tool_use");
		if (uses.length === 0) {
			// The Stop hooks: a block is fed back as a user turn and the model runs again, as claude does.
			const reason = stops < MAX_STOP_BLOCKS ? await stopBlock(stops > 0) : undefined;
			if (reason === undefined) break;
			stops++;
			history.push({ role: "user", content: [{ type: "text", text: `Stop hook feedback:\n${reason}` }] });
			save();
			continue;
		}
		const results: Block[] = [];
		for (const use of uses) results.push(await runTool(use));
		send({ type: "user", message: { role: "user", content: results }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
		history.push({ role: "user", content: results });
		// The pass between tool batches: input sent mid-turn (not at "later") joins the next model call as claude 2.1.318
		// sends it (observed): a system-role message after the tool results, not a user turn.
		const joining = inbox.filter((each) => each.priority !== "later" && !textOf(each.message.content).startsWith("/compact"));
		for (const each of joining) {
			inbox.splice(inbox.indexOf(each), 1);
			const text = `The user sent a new message while you were working:\n${textOf(take(each))}\n\nThis is how Claude Code surfaces messages the user sends mid-turn.`;
			history.push({ role: "system", content: [{ type: "text", text }] });
		}
		save();
	}
	if (interrupted) {
		const note = [{ type: "text", text: "[Request interrupted by user]" }];
		history.push({ role: "user", content: note });
		send({ type: "user", message: { role: "user", content: note }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
	}
	turnAbort = undefined;
	save();
	result(interrupted ? { subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: rounds } : { result: text, stop_reason: "end_turn", num_turns: rounds });
}

/** `/compact <instructions>`: one summary call, then the history is the summary alone (claude's own event order). */
async function compact(instructions: string): Promise<void> {
	await listTools();
	send({ type: "system", subtype: "status", status: "compacting", session_id: sessionId, uuid: randomUUID() });
	const ask = `Your task is to create a detailed summary of the conversation so far.${instructions ? `\n\nAdditional Instructions:\n${instructions}` : ""}`;
	const { status, body } = await callModel([...history, { role: "user", content: ask }]);
	if (status !== 200) {
		send({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: failed(status, body), session_id: sessionId, uuid: randomUUID() });
		return result({ is_error: true, result: failed(status, body), num_turns: 0 });
	}
	const summary = ((body.content as Block[] | undefined) ?? []).filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");
	const before = contextTokens;
	history = [{ role: "user", content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}` }];
	contextTokens = Math.ceil(JSON.stringify(history).length / 4);
	save();
	send({ type: "system", subtype: "status", status: null, compact_result: "success", session_id: sessionId, uuid: randomUUID() });
	init();
	send({ type: "system", subtype: "compact_boundary", session_id: sessionId, uuid: randomUUID(), compact_metadata: { trigger: "manual", pre_tokens: before, post_tokens: contextTokens } });
	result({ num_turns: 0 });
}

function control(line: { request_id: string; request: Record<string, unknown> }): void {
	const reply = (response: Record<string, unknown>) => send({ type: "control_response", response: { subtype: "success", request_id: line.request_id, response } });
	const body = line.request;
	if (body.subtype === "initialize") {
		const hooks = (body.hooks ?? {}) as Record<string, Array<{ hookCallbackIds?: string[] }> | undefined>;
		hookIds = (hooks.PreToolUse ?? []).flatMap((matcher) => matcher.hookCallbackIds ?? []);
		stopIds = (hooks.Stop ?? []).flatMap((matcher) => matcher.hookCallbackIds ?? []);
		servers = Array.isArray(body.sdkMcpServers) ? body.sdkMcpServers.map(String) : [];
		systemPrompt = Array.isArray(body.systemPrompt) ? body.systemPrompt.join("\n\n") : String(body.systemPrompt ?? "");
		return reply({ commands: [{ name: "compact", description: "Compact the conversation", argumentHint: "<instructions>", builtin: true }], output_style: "default", available_output_styles: ["default"], models: [], account: {} });
	}
	if (body.subtype === "get_hooks_listing") return reply({ hooks: [], policy: { managedOnly, policyHookCount: 0 } });
	if (body.subtype === "get_context_usage") {
		return reply({ totalTokens: contextTokens, maxTokens: MAX_TOKENS, rawMaxTokens: MAX_TOKENS, percentage: (contextTokens / MAX_TOKENS) * 100, categories: [], model, memoryFiles: [], mcpTools: [], agents: [] });
	}
	if (body.subtype === "interrupt" && turnAbort) {
		interrupted = true;
		turnAbort.abort();
		return reply({ still_queued: [] });
	}
	reply({});
}

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (raw) => {
	if (!raw.trim()) return;
	const line = JSON.parse(raw) as { type: string; request_id?: string; request?: Record<string, unknown>; response?: Record<string, unknown>; message?: Message; priority?: unknown; uuid?: unknown };
	if (line.type === "control_request") return control(line as { request_id: string; request: Record<string, unknown> });
	if (line.type === "control_response") {
		const response = line.response as { subtype: string; request_id: string; response?: Record<string, unknown>; error?: string };
		const waiter = pending.get(response.request_id);
		pending.delete(response.request_id);
		return response.subtype === "success" ? waiter?.resolve(response.response ?? {}) : waiter?.reject(new Error(response.error ?? "control request failed"));
	}
	if (line.type !== "user" || !line.message) return;
	const item: Queued = { message: line.message, ...(typeof line.priority === "string" ? { priority: line.priority } : {}), ...(typeof line.uuid === "string" ? { uuid: line.uuid } : {}) };
	inbox.push(item);
	const text = textOf(line.message.content);
	const step = (): Promise<void> => {
		// Taken already by a tool-batch pass of the turn it arrived during.
		if (!inbox.includes(item)) return Promise.resolve();
		inbox.splice(inbox.indexOf(item), 1);
		return text.startsWith("/compact") ? compact(text.slice("/compact".length).trim()) : turn(item);
	};
	chain = chain.then(step).catch((error: unknown) => result({ subtype: "error_during_execution", is_error: true, errors: [(error as Error).message] }));
}).on("close", () => void chain.then(() => process.exit(0)));
