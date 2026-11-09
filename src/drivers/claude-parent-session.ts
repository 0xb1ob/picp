/**
 * The native parent's session record (the claude session id and the operator-texts log, one JSONL file at the path the
 * bridge tracks) and the headless host that runs extensions/command-post on it: pi's extension API, narrowed to the
 * calls the extension makes, with the RPC-mode UI (notify lines on stdout, dialogs answered "no answer").
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "../worker-process.ts";

type RecordLine =
	| { type: "record"; driver: "claude"; created_at: string }
	| { type: "session"; session_id: string; at: string }
	| { type: "operator_text"; id: string; text: string; at: string }
	| { type: "thinking"; level: string; at: string }
	| { type: "model"; id: string; launch: string; at: string }
	| ({ type: "usage"; at: string } & ContextUsage);

/** `get_session_stats` `contextUsage`: the last `getContextUsage()` reading, null tokens before any. */
export type ContextUsage = { tokens: number | null; contextWindow?: number; percent?: number };

/** Append-only, so a death mid-write loses at most its own last line; an unparsable line is skipped. */
export class ParentRecord {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
		mkdirSync(dirname(file), { recursive: true });
		if (!existsSync(file)) this.#append({ type: "record", driver: "claude", created_at: new Date().toISOString() });
	}

	#append(line: RecordLine): void {
		appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
		chmodSync(this.file, 0o600);
	}

	lines(): RecordLine[] {
		const out: RecordLine[] = [];
		for (const raw of readFileSync(this.file, "utf8").split("\n")) {
			if (!raw.trim()) continue;
			try {
				out.push(JSON.parse(raw) as RecordLine);
			} catch {
				process.stderr.write(`[native claude parent] skipped an unreadable line in ${this.file}\n`);
			}
		}
		return out;
	}

	/** The last claude session id recorded, which the next turn resumes. */
	sessionId(): string | undefined {
		return this.lines().reduce<string | undefined>((id, line) => (line.type === "session" ? line.session_id : id), undefined);
	}

	setSessionId(id: string): void {
		if (this.sessionId() !== id) this.#append({ type: "session", session_id: id, at: new Date().toISOString() });
	}

	/** Logged when the text enters the model's input, before its echo: a crash after the echo still finds it. */
	addOperatorText(text: string): void {
		this.#append({ type: "operator_text", id: `ot-${randomUUID()}`, text, at: new Date().toISOString() });
	}

	operatorTexts(): string[] {
		return this.lines().flatMap((line) => (line.type === "operator_text" ? [line.text] : []));
	}

	/** The thinking level `set_thinking_level` last applied (a relaunch keeps it, as pi's session does). */
	thinking(): string | undefined {
		return this.lines().reduce<string | undefined>((level, line) => (line.type === "thinking" ? line.level : level), undefined);
	}

	setThinking(level: string): void {
		this.#append({ type: "thinking", level, at: new Date().toISOString() });
	}

	/**
	 * The model `set_model` last applied while the parent ran on `--model launch`: a relaunch on that same `--model`
	 * keeps the switch, as pi's session does; a launch on another model is the operator's newer choice and wins.
	 */
	model(launch: string): string | undefined {
		const last = this.lines().filter((line) => line.type === "model").at(-1);
		return last?.type === "model" && last.launch === launch ? last.id : undefined;
	}

	setModel(id: string, launch: string): void {
		this.#append({ type: "model", id, launch, at: new Date().toISOString() });
	}

	/** The last context reading, so `get_session_stats` after a relaunch answers before the first turn. */
	usage(): ContextUsage {
		const last = this.lines().filter((line) => line.type === "usage").at(-1);
		if (last?.type !== "usage") return { tokens: null };
		const { type: _type, at: _at, ...usage } = last;
		return usage;
	}

	setUsage(usage: ContextUsage): void {
		this.#append({ type: "usage", ...usage, at: new Date().toISOString() });
	}

	/** pi's `get_entries` rows for the operator texts; `since` is an entry id, and an unknown one is refused as pi does. */
	entries(since?: string): SessionEntry[] {
		const all = this.lines().flatMap((line): SessionEntry[] => line.type === "operator_text"
			? [{ type: "message", id: line.id, timestamp: line.at, message: { role: "user", content: [{ type: "text", text: line.text }], timestamp: Date.parse(line.at) } } as SessionEntry]
			: []);
		if (since === undefined) return all;
		const at = all.findIndex((entry) => entry.id === since);
		if (at === -1) throw new Error(`unknown entry id ${since}`);
		return all.slice(at + 1);
	}
}

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
export type CustomMessage = { customType: string; content: unknown; display?: boolean; details?: unknown };
export type SendOptions = { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };

/** What the host needs from the entry: stdout lines, pi's `sendMessage`, and the live state a ctx reads. */
export interface HostPorts {
	write: (record: Record<string, unknown>) => void;
	sendMessage: (message: CustomMessage, options: SendOptions) => void;
	isIdle: () => boolean;
	abort: () => void;
	sessionId: () => string;
	contextTokens: () => number | null;
	entries: () => SessionEntry[];
}

/** The calls extensions/command-post makes on pi, recorded or forwarded; `fire` runs one event's handlers in order. */
export class HeadlessHost {
	readonly tools: ToolDefinition[] = [];
	readonly commands = new Map<string, unknown>();
	readonly #handlers = new Map<string, Handler[]>();
	readonly ctx: ExtensionContext;
	readonly ports: HostPorts;

	constructor(ports: HostPorts, cwd: string) {
		this.ports = ports;
		this.ctx = headlessContext(ports, cwd);
	}

	api(): ExtensionAPI {
		const api = {
			on: (event: string, handler: Handler) => void this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler]),
			registerTool: (tool: ToolDefinition) => void this.tools.push(tool),
			registerCommand: (name: string, options: unknown) => void this.commands.set(name, options),
			registerEntryRenderer: () => undefined,
			appendEntry: () => undefined,
			sendMessage: (message: CustomMessage, options?: SendOptions) => this.ports.sendMessage(message, options ?? {}),
			getAllTools: () => this.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: { source: "extension" } })),
		};
		// SAFETY: the extension calls only these members of pi's API (grep `pi\.` in extensions/command-post).
		return api as unknown as ExtensionAPI;
	}

	/** Every handler for `event`, awaited in registration order; a throw is reported as pi's `extension_error`. */
	async fire(event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.#handlers.get(event) ?? []) {
			try {
				results.push(await handler({ type: event, ...payload }, this.ctx));
			} catch (error) {
				this.ports.write({ type: "extension_error", extensionPath: "extensions/command-post", event, error: (error as Error).message });
				// A guard that cannot decide denies.
				if (event === "tool_call") results.push({ block: true, reason: `Refused: a tool_call guard failed (${(error as Error).message}).` });
			}
		}
		return results;
	}
}

/** pi's RPC-mode ctx: `notify` is an `extension_ui_request` line, dialogs resolve unanswered, the widget is a no-op. */
function headlessContext(ports: HostPorts, cwd: string): ExtensionContext {
	const ui = {
		notify: (message: string, notifyType?: string) => ports.write({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType }),
		select: async () => undefined,
		input: async () => undefined,
		confirm: async () => false,
		editor: async () => undefined,
		custom: async () => undefined,
		setWidget: () => undefined,
		setStatus: () => undefined,
		setTitle: () => undefined,
		setWorkingMessage: () => undefined,
		setWorkingVisible: () => undefined,
		onTerminalInput: () => () => undefined,
	};
	const ctx = {
		ui,
		mode: "rpc",
		hasUI: true,
		cwd,
		modelRegistry: undefined,
		model: undefined,
		isIdle: ports.isIdle,
		abort: ports.abort,
		getContextUsage: () => ({ tokens: ports.contextTokens() }),
		sessionManager: { getSessionId: ports.sessionId, getEntries: ports.entries, getBranch: () => [] },
	};
	// SAFETY: the extension reads only these ctx members on a headless parent (grep `ctx\.` in extensions/command-post).
	return ctx as unknown as ExtensionContext;
}
