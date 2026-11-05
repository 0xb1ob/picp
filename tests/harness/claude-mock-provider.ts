/**
 * Loopback fake of the Anthropic Messages API for the real `claude` CLI (native worker spike), synthetic credentials
 * only. A scripted step answers each request that offers tools; others get a short text. Auth headers are recorded.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { LAYOUT } from "../../src/contracts.ts";
import { routeNamed } from "./routing-names.ts";

export const FAKE_CLAUDE_AUTH_TOKEN = "picp-synthetic-claude-token";
export const FAKE_CLAUDE_MODEL = "claude-picp-fake";
/** The routed ref a native dispatch names: an explicit `anthropic/claude-…` id, as S1 requires. */
export const FAKE_NATIVE_MODEL = `anthropic/${FAKE_CLAUDE_MODEL}`;

/** Allows and routes `models` (default the fake native model) in `home`'s data/routing.json, so a native dispatch may name them. */
export function routeNativeModel(home: string, models: readonly string[] = [FAKE_NATIVE_MODEL]): void {
	routeNamed(home, models);
	const file = join(home, LAYOUT.routingFile);
	const config = JSON.parse(readFileSync(file, "utf8")) as { allow: string[] };
	config.allow = [...new Set([...config.allow, ...models])];
	writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export interface RecordedClaudeRequest {
	method: string;
	path: string;
	apiKey?: string;
	authorization?: string;
	body: Record<string, unknown>;
}

export interface ClaudeToolUse {
	name: string;
	/** A function reads the triggering request (to echo back a runtime id, say). */
	input: unknown | ((request: RecordedClaudeRequest) => unknown);
}

/** `beforeAnswer` runs, and is awaited, after the request is recorded and before the step's answer is sent. */
export type ClaudeStep = { kind: "tool_use"; calls: ClaudeToolUse[]; beforeAnswer?: () => Promise<void> } | { kind: "text"; text: string };

export interface ClaudeMockProvider {
	url: string;
	requests: RecordedClaudeRequest[];
	/** Requests answered past the script's end (fail-closed tests assert this stays 0). */
	overrun: () => number;
	close: () => Promise<void>;
}

/** Text of every `tool_result` block the CLI sent back, in order. */
export function toolResults(requests: readonly RecordedClaudeRequest[]): string[] {
	const seen = new Map<string, string>();
	for (const request of requests) {
		for (const message of (request.body.messages as Array<{ content?: unknown }> | undefined) ?? []) {
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content as Array<Record<string, unknown>>) {
				if (block.type !== "tool_result") continue;
				const content = block.content;
				const text = typeof content === "string"
					? content
					: Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("\n") : "";
				seen.set(String(block.tool_use_id), `${block.is_error ? "[error] " : ""}${text}`);
			}
		}
	}
	return [...seen.values()];
}

function sse(res: ServerResponse, event: string, data: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const USAGE = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function answer(res: ServerResponse, body: Record<string, unknown>, blocks: Array<Record<string, unknown>>, stop: string, id: string, usage: boolean): void {
	const counts = (value: Record<string, number>) => (usage ? { usage: value } : {});
	const model = typeof body.model === "string" ? body.model : FAKE_CLAUDE_MODEL;
	if (body.stream !== true) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ id, type: "message", role: "assistant", model, content: blocks, stop_reason: stop, stop_sequence: null, ...counts(USAGE) }));
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	sse(res, "message_start", {
		type: "message_start",
		message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, ...counts({ ...USAGE, output_tokens: 1 }) },
	});
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else {
			sse(res, "content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		}
		sse(res, "content_block_stop", { type: "content_block_stop", index });
	});
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, ...counts({ output_tokens: USAGE.output_tokens }) });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		return { unparsed: text };
	}
}

/** Starts the fake on 127.0.0.1; `script` steps are consumed by tool-offering requests in order;
 * `usage: false` omits usage. */
export async function startClaudeMockProvider(script: readonly ClaudeStep[], options: { usage?: boolean } = {}): Promise<ClaudeMockProvider> {
	const usage = options.usage ?? true;
	const requests: RecordedClaudeRequest[] = [];
	let cursor = 0;
	let overrun = 0;
	let ids = 0;
	const server = createServer((req, res) => {
		void (async () => {
			const body = await readBody(req);
			const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
			const recorded: RecordedClaudeRequest = { method: req.method ?? "", path: req.url ?? "", body };
			const apiKey = header("x-api-key");
			const authorization = header("authorization");
			if (apiKey !== undefined) recorded.apiKey = apiKey;
			if (authorization !== undefined) recorded.authorization = authorization;
			requests.push(recorded);
			const path = (req.url ?? "").split("?")[0];
			if (req.method === "POST" && path === "/v1/messages/count_tokens") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ input_tokens: 12 }));
				return;
			}
			if (req.method !== "POST" || path !== "/v1/messages") {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `fake: no route ${req.method} ${path}` } }));
				return;
			}
			const id = `msg_fake_${++ids}`;
			const offersTools = Array.isArray(body.tools) && body.tools.length > 0;
			const step = offersTools ? script[cursor++] : undefined;
			if (offersTools && step === undefined) overrun++;
			if (step?.kind === "tool_use") {
				await step.beforeAnswer?.();
				const blocks = step.calls.map((call, index) => ({
					type: "tool_use",
					id: `toolu_fake_${ids}_${index}`,
					name: call.name,
					input: typeof call.input === "function" ? (call.input as (r: RecordedClaudeRequest) => unknown)(recorded) : call.input,
				}));
				answer(res, body, blocks, "tool_use", id, usage);
				return;
			}
			answer(res, body, [{ type: "text", text: step?.kind === "text" ? step.text : "ok" }], "end_turn", id, usage);
		})().catch((error: unknown) => {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(error) } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		overrun: () => overrun,
		close: () => new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}
