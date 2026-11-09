/**
 * The native Claude parent's process (driver `claude`): it runs extensions/command-post on a headless host, serves its
 * cp_* tools over an in-process MCP server, takes one SDK `query()` per turn resumed by the recorded session id, and
 * speaks the pi RPC lines and events the bridge reads (tests/fixtures/fake-parent.mjs is the protocol reference).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createSdkMcpServer, type HookCallback, type Options, query, type Query, type SDKAssistantMessage, type SDKResultMessage, type SDKUserMessage, type SdkMcpToolDefinition, type SpawnOptions, tool } from "@anthropic-ai/claude-agent-sdk";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { registerCommandPost } from "../../extensions/command-post/index.ts";
import { configureLayout } from "../contracts.ts";
import { pendingNotice } from "../curation.ts";
import { PACKAGE_ROOT } from "../home.ts";
import { standingOrdersDigest } from "../parent-context.ts";
import { messageText } from "../parent-outbox.ts";
import { recentWorkContext } from "../recent-work.ts";
import { resolveClaude } from "./claude-cli.ts";
import { type CustomMessage, HeadlessHost, ParentRecord, type SendOptions } from "./claude-parent-session.ts";
import { buildChildEnv, CHILD_MANAGED_SETTINGS } from "./claude-spike.ts";
import { nativeModelId } from "./claude.ts";

// stdout is the RPC channel: nothing the extension logs may land on it.
console.log = console.error;
console.info = console.error;

const MCP_PREFIX = "mcp__cp__";
const MAX_TURNS = 100;
const SHUTDOWN_WAIT_MS = 5_000;
/** Digests pi delivers as context messages; here they are system-prompt sections, re-read on each turn. */
const PROMPT_SECTIONS = ["cp-parent-guidance", "cp-memory", "cp-standing-orders", "cp-recent-work", "cp-user-context"] as const;
const NATIVE_PARENT_ADDENDUM = [
	"Native parent: your tools are the cp_* tools (served as mcp__cp__cp_*); there is no shell, read or edit tool here.",
	"A user message that opens with `[fleet wake-up <type> — …]` is a fleet notice (an envelope, CI, a verdict, a recovery),",
	"never an operator message; operator sends carry a `[cp-send …]` delivery-id line.",
].join("\n");

const write = (record: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(record)}\n`);
const fail = (message: string): never => {
	process.stderr.write(`[native claude parent] refused to start: ${message}\n`);
	process.exit(2);
};

let sessionFile = "";
let modelId = "";
let promptFile = "";
try {
	const { values } = parseArgs({ options: { session: { type: "string" }, model: { type: "string" }, "system-prompt-file": { type: "string" } }, strict: true });
	if (!values.session || !values.model || !values["system-prompt-file"]) throw new Error("--session, --model and --system-prompt-file are required");
	sessionFile = values.session;
	modelId = nativeModelId(values.model);
	promptFile = values["system-prompt-file"];
} catch (error) {
	fail((error as Error).message);
}
const home = process.env.CP_HOME ?? fail("CP_HOME is unset");
configureLayout("multi", home);

type Message = { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number } | (CustomMessage & { role: "custom"; timestamp: number });
type Assistant = Record<string, unknown> & { role: "assistant"; stopReason: string };

const record = new ParentRecord(sessionFile);
let sessionId = record.sessionId();
let busy = false;
let stopping = false;
let messageCount = 0;
let turnIndex = 0;
let usage: { tokens: number | null; contextWindow?: number; percent?: number } = { tokens: null };
/** Waiting to start a turn: operator texts and triggering wake-ups, in arrival order. */
const queue: Message[] = [];
/** Quiet wake-ups already landed (pi appends them to context at once); they ride the next turn. */
const backlog: Message[] = [];
const promptSections = new Map<string, string>();
const toolCallIds = new Map<string, string[]>();
let current: AbortController | undefined;
let running: Promise<void> | undefined;

const host = new HeadlessHost({
	write,
	sendMessage: deliver,
	isIdle: () => !busy,
	abort: () => current?.abort(),
	sessionId: () => sessionId ?? sessionFile,
	contextTokens: () => usage.tokens,
	entries: () => record.entries(),
}, process.cwd());
const { session } = registerCommandPost(host.api(), (_ctx, base) => ({
	registry: undefined,
	operatorTexts: () => record.operatorTexts(),
	cwd: base.cwd,
	headless: base.headless,
	sessionId: () => sessionId ?? sessionFile,
	notify: base.notify,
	setLive: base.setLive,
	refresh: base.refresh,
}));

/** pi's `sendMessage`: digests become prompt sections; a quiet notice lands now, a triggering one starts or queues a turn. */
function deliver(message: CustomMessage, options: SendOptions): void {
	if ((PROMPT_SECTIONS as readonly string[]).includes(message.customType)) {
		promptSections.set(message.customType, messageText(message));
		return;
	}
	const custom: Message = { role: "custom", customType: message.customType, content: message.content, display: message.display ?? true, details: message.details, timestamp: Date.now() };
	if (options.triggerTurn !== true) {
		backlog.push(custom);
		void land(custom);
		return;
	}
	queue.push(custom);
	pump();
}

/** A message enters the parent's context: the extension sees `message_start`, the bridge its `message_end`. */
async function land(message: Message): Promise<void> {
	if (message.role === "user") record.addOperatorText(messageText(message));
	await host.fire("message_start", { message });
	write({ type: "message_end", message });
}

function pump(): void {
	if (busy || stopping || queue.length === 0) return;
	busy = true;
	running = runTurn(queue.splice(0))
		.catch((error: unknown) => void process.stderr.write(`[native claude parent] turn failed outside the query: ${(error as Error).message}\n`))
		.finally(() => {
			busy = false;
			running = undefined;
			pump();
		});
}

/** What the model reads for one message: an operator text as sent, a wake-up behind its fleet marker. */
function blockOf(message: Message): string {
	const text = messageText(message);
	return message.role === "custom" ? `[fleet wake-up ${message.customType} — from the fleet, not an operator message]\n${text}` : text;
}

/** One turn: pi's before_agent_start, agent_start, the landed messages and context review, the query, then the settle. */
async function runTurn(items: Message[]): Promise<void> {
	await host.fire("before_agent_start", {
		prompt: items.map(messageText).join("\n\n"),
		images: [],
		systemPromptOptions: { contextFiles: [{ path: join(PACKAGE_ROOT, "AGENTS.md"), content: "" }], sections: {} },
	});
	write({ type: "agent_start" });
	await host.fire("agent_start");
	for (const message of items) await land(message);
	const reviewed = await reviewContext([...backlog.splice(0), ...items]);
	await host.fire("before_provider_request", { payload: {} });
	const assistants: Assistant[] = [];
	let last: Assistant = { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() };
	const emit = (message: Assistant): void => {
		assistants.push(message);
		last = message;
		messageCount += 1;
		write({ type: "message_end", message });
	};
	const turnEnd = async (toolResults: unknown[]): Promise<void> => {
		const event = { turnIndex: turnIndex++, message: last, toolResults };
		write({ type: "turn_end", ...event });
		await host.fire("turn_end", event);
	};
	try {
		const blocks = reviewed.map(blockOf).filter((text) => text.trim().length > 0);
		if (blocks.length > 0) await ask(blocks, emit, turnEnd);
	} catch (error) {
		emit(errorAssistant((error as Error).message));
	}
	// A stopping process dies mid-turn, as pi does: the bridge reconciles its sends after the relaunch.
	if (stopping) return;
	await turnEnd([]);
	write({ type: "agent_end", messages: assistants });
	await host.fire("agent_end", { messages: assistants });
	write({ type: "agent_settled" });
	await host.fire("agent_settled");
}

/** pi's delivery-time `context` review: a handler may withhold a stale wake-up or replace it with a stand-in. */
async function reviewContext(messages: Message[]): Promise<Message[]> {
	for (const result of await host.fire("context", { messages })) {
		const replaced = (result as { messages?: unknown } | undefined)?.messages;
		if (Array.isArray(replaced)) return replaced as Message[];
	}
	return messages;
}

const errorAssistant = (errorMessage: string): Assistant => ({ role: "assistant", content: [], stopReason: "error", errorMessage, timestamp: Date.now() });

/** The claude query for one turn; its events become pi's `message_end`/`turn_end` lines as they arrive. */
async function ask(blocks: string[], emit: (message: Assistant) => void, turnEnd: (toolResults: unknown[]) => Promise<void>): Promise<void> {
	const claude = resolveClaude(process.env);
	const abort = new AbortController();
	current = abort;
	let settle: () => void = () => {};
	const settled = new Promise<void>((done) => (settle = done));
	abort.signal.addEventListener("abort", () => settle(), { once: true });
	async function* input(): AsyncGenerator<SDKUserMessage> {
		yield { type: "user", message: { role: "user", content: blocks.map((text) => ({ type: "text" as const, text })) }, parent_tool_use_id: null };
		await settled;
	}
	let result: SDKResultMessage | undefined;
	try {
		const q = query({ prompt: input(), options: sdkOptions(claude.path, abort) });
		for await (const message of q) {
			if (message.type === "system" && message.subtype === "init" && message.session_id !== sessionId) {
				sessionId = message.session_id;
				record.setSessionId(message.session_id);
			} else if (message.type === "assistant" && message.parent_tool_use_id === null) {
				emit(piAssistant(message));
			} else if (message.type === "user" && message.parent_tool_use_id === null && Array.isArray(message.message.content)) {
				const results = (message.message.content as unknown as Array<Record<string, unknown>>).filter((block) => block.type === "tool_result");
				if (results.length > 0) await turnEnd(results.map((block) => ({ toolCallId: block.tool_use_id, isError: block.is_error === true })));
			} else if (message.type === "result") {
				result = message;
				await readUsage(q);
				settle();
			}
		}
	} finally {
		settle();
		if (current === abort) current = undefined;
	}
	if (abort.signal.aborted) emit({ ...errorAssistant("aborted"), stopReason: "aborted" });
	else if (!result) emit(errorAssistant("the claude query ended without a result"));
	else if (result.is_error || result.subtype !== "success") emit(errorAssistant(resultError(result)));
}

function resultError(result: SDKResultMessage): string {
	if (result.subtype === "success") return result.result || "the claude turn ended in error";
	const errors = (result as { errors?: unknown }).errors;
	return Array.isArray(errors) && errors.length > 0 ? errors.map(String).join("; ") : result.subtype;
}

/** `getContextUsage()` of the turn's live query, cached for `get_session_stats`; bounded, never a hang. */
async function readUsage(q: Query): Promise<void> {
	try {
		const read = await Promise.race([q.getContextUsage(), sleep(SHUTDOWN_WAIT_MS, undefined, { ref: false })]);
		if (read) usage = { tokens: read.totalTokens, contextWindow: read.maxTokens, percent: read.percentage };
	} catch (error) {
		process.stderr.write(`[native claude parent] context usage unread: ${(error as Error).message}\n`);
	}
}

const STOP_REASONS: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", pause_turn: "stop", refusal: "stop", tool_use: "toolUse", max_tokens: "length", model_context_window_exceeded: "length" };

/** An SDK assistant message as pi's: text, thinking and tool calls (cp names unprefixed), stop reason, usage. */
function piAssistant(message: SDKAssistantMessage): Assistant {
	const body = message.message as unknown as { content?: unknown; stop_reason?: string | null; usage?: Record<string, number | undefined>; model?: string };
	const blocks = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];
	const content = blocks.flatMap((block): Array<Record<string, unknown>> => block.type === "text" ? [{ type: "text", text: String(block.text ?? "") }]
		: block.type === "tool_use" ? [{ type: "toolCall", id: block.id, name: String(block.name).replace(MCP_PREFIX, ""), arguments: block.input }]
		: block.type === "thinking" ? [{ type: "thinking", thinking: String(block.thinking ?? "") }] : []);
	const stop = (body.stop_reason && STOP_REASONS[body.stop_reason]) ?? (blocks.some((block) => block.type === "tool_use") ? "toolUse" : "stop");
	const u = body.usage ?? {};
	const [input, output, cacheRead, cacheWrite] = [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
	const text = content.flatMap((block) => (block.type === "text" ? [String(block.text)] : [])).join("\n");
	return {
		role: "assistant", content, stopReason: message.error ? "error" : stop,
		...(message.error ? { errorMessage: text || message.error } : {}),
		usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite },
		provider: "anthropic", model: body.model ?? modelId, timestamp: Date.now(),
	};
}

/** The system prompt, rebuilt per turn: the contract file, the native addendum, then the digests read fresh. */
function systemPrompt(): string {
	const read = (name: string, get: () => string | undefined): string | undefined => {
		try {
			return get();
		} catch (error) {
			process.stderr.write(`[native claude parent] ${name} unavailable this turn: ${(error as Error).message}\n`);
			return undefined;
		}
	};
	const sections: Record<(typeof PROMPT_SECTIONS)[number], string | undefined> = {
		"cp-parent-guidance": promptSections.get("cp-parent-guidance"),
		"cp-memory": read("memory", () => [session.commandPost().memoryDigest(), pendingNotice(home)].filter(Boolean).join("\n") || undefined),
		"cp-standing-orders": read("standing orders", () => standingOrdersDigest(home)),
		"cp-recent-work": read("recent work", () => recentWorkContext(home)),
		"cp-user-context": promptSections.get("cp-user-context"),
	};
	const parts = Object.entries(sections).flatMap(([name, text]) => (text ? [`<${name}>\n${text.trim()}\n</${name}>`] : []));
	return [readFileSync(promptFile, "utf8").trimEnd(), NATIVE_PARENT_ADDENDUM, ...parts].join("\n\n");
}

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });

/** The parent's `tool_call` guards (the lock for fleet-mutating tools, then `checkToolCall`), before every call. */
const preToolUse: HookCallback = async (input) => {
	if (input.hook_event_name !== "PreToolUse") return {};
	const name = input.tool_name.replace(MCP_PREFIX, "");
	let reason: string | undefined;
	if (!input.tool_name.startsWith(MCP_PREFIX) || !host.tools.some((each) => each.name === name)) {
		reason = `Refused: ${input.tool_name} is not one of the parent's cp_* tools.`;
	} else {
		const results = await host.fire("tool_call", { toolCallId: input.tool_use_id, toolName: name, input: input.tool_input });
		const blocked = results.find((each) => (each as { block?: unknown } | undefined)?.block === true) as { reason?: string } | undefined;
		if (blocked) reason = blocked.reason ?? `${name} was refused by the parent's guard`;
	}
	if (reason === undefined) {
		toolCallIds.set(name, [...(toolCallIds.get(name) ?? []), input.tool_use_id]);
		return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
	}
	write({ type: "tool_execution_start", toolCallId: input.tool_use_id, toolName: name, args: input.tool_input });
	write({ type: "tool_execution_end", toolCallId: input.tool_use_id, toolName: name, isError: true, result: { content: [{ type: "text", text: reason }], details: {} } });
	return deny(reason);
};

/** A TypeBox property schema as zod for the MCP listing; one zod cannot express falls back to any (pi validates after). */
function zodShape(schema: unknown): Record<string, z.ZodType> {
	const object = JSON.parse(JSON.stringify(schema), (key, value) => (key.startsWith("~") ? undefined : value)) as { properties?: Record<string, unknown>; required?: string[] };
	const required = new Set(object.required ?? []);
	return Object.fromEntries(Object.entries(object.properties ?? {}).map(([key, property]) => {
		let field: z.ZodType;
		try {
			field = z.fromJSONSchema(property as Parameters<typeof z.fromJSONSchema>[0]);
		} catch {
			field = z.any();
		}
		return [key, required.has(key) ? field : field.optional()];
	}));
}

/** One cp_* tool over MCP: pi's argument validation, the extension's execute, and pi's tool_execution_* lines. */
function mcpTool(definition: ToolDefinition): SdkMcpToolDefinition<Record<string, z.ZodType>> {
	const guidelines = definition.promptGuidelines?.length ? `\n${definition.promptGuidelines.map((line) => `- ${line}`).join("\n")}` : "";
	return tool(definition.name, `${definition.description}${guidelines}`, zodShape(definition.parameters), async (args) => {
		const toolCallId = toolCallIds.get(definition.name)?.shift() ?? `cp-${definition.name}-${Date.now()}`;
		write({ type: "tool_execution_start", toolCallId, toolName: definition.name, args });
		await host.fire("tool_execution_start", { toolCallId, toolName: definition.name, args });
		let result: { content?: unknown; details?: unknown; isError?: boolean };
		try {
			const raw = definition.prepareArguments ? definition.prepareArguments(args) : args;
			// SAFETY: pi's validator reads the tool's name and parameters and the call's JSON arguments.
			const params = validateToolArguments(definition as never, { type: "toolCall", id: toolCallId, name: definition.name, arguments: raw as never });
			// SAFETY: the cp_* bodies read their ctx only through ParentToolContext (deps.toolContext), never its tool members.
			result = await definition.execute(toolCallId, params, current?.signal, undefined, host.ctx as unknown as Parameters<ToolDefinition["execute"]>[4]);
		} catch (error) {
			result = { content: [{ type: "text", text: (error as Error).message }], details: {}, isError: true };
		}
		const isError = result.isError === true;
		const end = { toolCallId, toolName: definition.name, isError, result: { content: result.content, details: result.details } };
		write({ type: "tool_execution_end", ...end });
		await host.fire("tool_execution_end", end);
		const text = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>).filter((block) => block.type === "text").map((block) => ({ type: "text" as const, text: String(block.text ?? "") })) : [];
		return { content: text.length > 0 ? text : [{ type: "text" as const, text: isError ? "error" : "ok" }], isError };
	});
}

const mcpTools = (): SdkMcpToolDefinition<Record<string, z.ZodType>>[] => host.tools.map(mcpTool);
let served: ReturnType<typeof mcpTools> | undefined;

/** The CLI's own dirs live beside the record, so a relaunch resumes the same transcript store. */
function sdkOptions(claudePath: string, abort: AbortController): Options {
	const root = join(dirname(sessionFile), "native-parent-claude");
	const dirs = { home: join(root, "home"), configDir: join(root, "config"), tmp: join(root, "tmp") };
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const settings = join(homedir(), ".claude", "settings.json");
	served ??= mcpTools();
	return {
		cwd: process.cwd(),
		pathToClaudeCodeExecutable: claudePath,
		spawnClaudeCodeProcess: (options: SpawnOptions) => {
			const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
			child.stderr.resume();
			return child;
		},
		env: buildChildEnv(dirs, process.env),
		settingSources: [],
		...(existsSync(settings) ? { settings } : {}),
		managedSettings: CHILD_MANAGED_SETTINGS,
		strictMcpConfig: true,
		mcpServers: { cp: createSdkMcpServer({ name: "cp", version: "0.0.0", tools: served }) },
		tools: [],
		disallowedTools: ["Agent", "Task", "WebFetch", "WebSearch"],
		agents: {},
		plugins: [],
		skills: [],
		permissionMode: "default",
		canUseTool: async (toolName) => ({ behavior: "deny", message: `Refused: ${toolName} is not one of the parent's cp_* tools.` }),
		hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
		maxTurns: MAX_TURNS,
		abortController: abort,
		model: modelId,
		systemPrompt: systemPrompt(),
		...(sessionId ? { resume: sessionId } : {}),
	};
}

function command(line: string): void {
	let request: { id?: unknown; type?: unknown; message?: unknown; since?: unknown };
	try {
		request = JSON.parse(line) as typeof request;
	} catch {
		return;
	}
	const reply = (body: Record<string, unknown>) => write({ type: "response", id: request.id, command: request.type, ...body });
	const type = String(request.type);
	if (type === "get_state") {
		return reply({ success: true, data: { sessionFile, sessionId: sessionId ?? null, isStreaming: busy, model: { provider: "anthropic", id: modelId }, messageCount, pendingMessageCount: queue.length } });
	}
	// The diagnostics (/doctor, /cp-drain, /cp-quota, /cp-version) are Stage 2: none is registered, so none is sent here.
	if (type === "get_commands") return reply({ success: true, data: { commands: [] } });
	if (type === "get_session_stats") return reply({ success: true, data: { sessionFile, sessionId: sessionId ?? null, contextUsage: usage } });
	if (type === "get_entries") {
		try {
			const entries = record.entries(typeof request.since === "string" ? request.since : undefined);
			return reply({ success: true, data: { entries, leafId: entries.at(-1)?.id ?? null } });
		} catch (error) {
			return reply({ success: false, error: (error as Error).message });
		}
	}
	if (type === "prompt" || type === "follow_up" || type === "steer") {
		if (typeof request.message !== "string") return reply({ success: false, error: `${type} needs a message` });
		const disposition = type === "steer" || busy ? "queued" : "started";
		queue.push({ role: "user", content: [{ type: "text", text: request.message }], timestamp: Date.now() });
		reply({ success: true, data: { disposition } });
		return pump();
	}
	reply({ success: false, error: `the native claude parent does not take ${type} yet` });
}

/** Stdin end or SIGTERM: the live query is aborted, then pi's session_shutdown releases the lock and the workers. */
async function shutdown(): Promise<void> {
	if (stopping) return;
	stopping = true;
	current?.abort();
	await Promise.race([running ?? Promise.resolve(), sleep(SHUTDOWN_WAIT_MS, undefined, { ref: false })]);
	await host.fire("session_shutdown", { reason: "quit" });
	process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
await host.fire("session_start", { reason: "startup" });
createInterface({ input: process.stdin }).on("line", command).on("close", () => void shutdown());
