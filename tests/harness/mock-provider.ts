/**
 * Scriptable mock model provider (openai-completions).
 *
 * Every automated milestone gate (m0-m3) runs against this: workers become
 * deterministic, every failure branch is reachable, and CI costs nothing.
 *
 * A *script* is an ordered list of steps consumed one per provider request.
 * Scripts are addressed by model id (`mock/<name>`), so each spawned pi child
 * gets its own cursor as long as tests use distinct script names.
 *
 * Fail-closed: a request for an unknown script, or one past the end of a
 * script, answers HTTP 500. A silent "model said nothing" would look like a
 * product bug in every downstream test.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_PROVIDER_ID = "mock";
export const MOCK_API_KEY = "mock-key";

export interface MockUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	cached_tokens?: number;
}

export interface MockToolCall {
	name: string;
	/**
	 * Serialized verbatim when a string (use it to inject malformed JSON).
	 *
	 * A **function** is called with the request that triggered this step and
	 * must return the args. That is the only way to script a tool call whose
	 * arguments contain an id minted at runtime (a job id from `br create`, say):
	 * the brief is in the request, so the test can read the id back out of it.
	 * Everything else stays canned.
	 */
	args: unknown | ((request: RecordedRequest) => unknown);
	id?: string;
}

export type ScriptStep =
	/** Assistant text, `finish_reason: "stop"`. */
	| { kind: "text"; text: string; usage?: MockUsage }
	/** Assistant tool calls, `finish_reason: "tool_calls"`. */
	| { kind: "tool_calls"; calls: MockToolCall[]; text?: string; usage?: MockUsage }
	/** Settles with no content at all — drives `agent_empty_output`. */
	| { kind: "empty"; usage?: MockUsage }
	/** HTTP error injection (429/500/...); `repeat` consumes N requests. */
	| { kind: "error"; status: number; message?: string; type?: string; repeat?: number }
	/** Never answers (or answers after `ms`) — drives timeout handling. */
	| { kind: "hang"; ms?: number };

export interface ScriptOptions {
	/**
	 * What to do once the steps are consumed:
	 *  "error"  (default) — HTTP 500, loudly
	 *  "repeat" — repeat the final step forever
	 */
	onExhausted?: "error" | "repeat";
}

export interface RecordedRequest {
	script: string;
	model: string;
	body: {
		model?: string;
		stream?: boolean;
		messages?: Array<Record<string, unknown>>;
		tools?: Array<Record<string, unknown>>;
		[key: string]: unknown;
	};
	at: number;
}

interface ScriptState {
	steps: ScriptStep[];
	options: ScriptOptions;
	cursor: number;
	/** Remaining repeats of the current error step. */
	errorRepeatsLeft: number;
}

let counter = 0;
function nextId(prefix: string): string {
	counter += 1;
	return `${prefix}_${counter.toString(36)}${Date.now().toString(36)}`;
}

export class MockProvider {
	readonly #server: Server;
	readonly #scripts = new Map<string, ScriptState>();
	readonly #requests: RecordedRequest[] = [];
	readonly #openConnections = new Set<ServerResponse>();
	#port = 0;

	private constructor(server: Server) {
		this.#server = server;
	}

	static async start(): Promise<MockProvider> {
		const holder: { provider?: MockProvider } = {};
		const server = createServer((req, res) => {
			holder.provider?.handle(req, res);
		});
		const provider = new MockProvider(server);
		holder.provider = provider;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		provider.#port = (server.address() as AddressInfo).port;
		return provider;
	}

	get port(): number {
		return this.#port;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.#port}/v1`;
	}

	/** Register a script; returns the `provider/model` id to pass to `--model`. */
	addScript(name: string, steps: ScriptStep[], options: ScriptOptions = {}): string {
		if (this.#scripts.has(name)) {
			throw new Error(`mock provider: script "${name}" already registered — use a fresh name per child`);
		}
		this.#scripts.set(name, { steps, options, cursor: 0, errorRepeatsLeft: 0 });
		return `${MOCK_PROVIDER_ID}/${this.modelId(name)}`;
	}

	modelId(name: string): string {
		return `script-${name}`;
	}

	/** Requests seen, optionally filtered to one script. */
	requests(script?: string): readonly RecordedRequest[] {
		return script === undefined ? this.#requests : this.#requests.filter((r) => r.script === script);
	}

	/** Remaining (unconsumed) steps of a script — useful for "script fully used" assertions. */
	remaining(script: string): number {
		const state = this.#scripts.get(script);
		if (!state) throw new Error(`mock provider: unknown script "${script}"`);
		return Math.max(0, state.steps.length - state.cursor);
	}

	/** models.json fragment registering every script known so far. */
	modelsJson(): {
		providers: Record<string, unknown>;
	} {
		const models = [...this.#scripts.keys()].map((name) => ({
			id: this.modelId(name),
			name: `mock ${name}`,
			reasoning: false,
			input: ["text"],
			contextWindow: 200_000,
			maxTokens: 8_192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
		return {
			providers: {
				[MOCK_PROVIDER_ID]: {
					baseUrl: this.baseUrl,
					api: "openai-completions",
					apiKey: MOCK_API_KEY,
					models,
				},
			},
		};
	}

	async stop(): Promise<void> {
		for (const res of this.#openConnections) {
			res.destroy();
		}
		this.#openConnections.clear();
		await new Promise<void>((resolve) => {
			this.#server.close(() => resolve());
		});
	}

	// -- internals ----------------------------------------------------------

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const url = req.url ?? "/";
		if (req.method === "GET" && url.startsWith("/v1/models")) {
			this.json(res, 200, {
				object: "list",
				data: [...this.#scripts.keys()].map((name) => ({
					id: this.modelId(name),
					object: "model",
					owned_by: MOCK_PROVIDER_ID,
				})),
			});
			return;
		}
		if (req.method !== "POST" || !url.startsWith("/v1/chat/completions")) {
			this.json(res, 404, { error: { message: `mock provider: no route for ${req.method} ${url}` } });
			return;
		}

		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			let body: RecordedRequest["body"];
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RecordedRequest["body"];
			} catch (error) {
				this.json(res, 400, { error: { message: `mock provider: bad JSON body: ${String(error)}` } });
				return;
			}
			const modelId = typeof body.model === "string" ? body.model : "";
			const script = modelId.startsWith("script-") ? modelId.slice("script-".length) : "";
			const state = this.#scripts.get(script);
			if (!state) {
				this.json(res, 500, {
					error: { message: `mock provider: unknown script for model "${modelId}"` },
				});
				return;
			}
			this.#requests.push({ script, model: modelId, body, at: Date.now() });

			const request = this.#requests[this.#requests.length - 1] as RecordedRequest;
			const step = this.takeStep(state);
			// A dynamic-args callback runs inside this handler; a throw there would
			// hang the client instead of failing the test, so it answers 500 loudly.
			const guard = <T>(fn: () => T): T | undefined => {
				try {
					return fn();
				} catch (error) {
					this.json(res, 500, { error: { message: `mock provider: script "${script}" threw: ${String(error)}` } });
					return undefined;
				}
			};
			if (!step) {
				this.json(res, 500, {
					error: {
						message: `mock provider: script "${script}" exhausted after ${state.steps.length} steps (request ${
							this.requests(script).length
						})`,
					},
				});
				return;
			}
			guard(() => this.respond(res, modelId, step, body.stream === true, request));
		});
	}

	private takeStep(state: ScriptState): ScriptStep | undefined {
		if (state.errorRepeatsLeft > 0) {
			state.errorRepeatsLeft -= 1;
			const current = state.steps[state.cursor - 1];
			if (current) return current;
		}
		let step = state.steps[state.cursor];
		if (!step) {
			if (state.options.onExhausted === "repeat") {
				step = state.steps[state.steps.length - 1];
				if (!step) return undefined;
				return step;
			}
			return undefined;
		}
		state.cursor += 1;
		if (step.kind === "error" && step.repeat && step.repeat > 1) {
			state.errorRepeatsLeft = step.repeat - 1;
		}
		return step;
	}

	private respond(res: ServerResponse, modelId: string, step: ScriptStep, stream: boolean, request: RecordedRequest): void {
		if (step.kind === "hang") {
			this.#openConnections.add(res);
			res.on("close", () => this.#openConnections.delete(res));
			if (step.ms !== undefined) {
				setTimeout(() => {
					if (!res.writableEnded) {
						this.streamSteps(res, modelId, { kind: "text", text: "late" }, request);
					}
				}, step.ms).unref?.();
			}
			return;
		}
		if (step.kind === "error") {
			this.json(res, step.status, {
				error: {
					message: step.message ?? `mock provider: injected ${step.status}`,
					type: step.type ?? (step.status === 429 ? "rate_limit_error" : "server_error"),
				},
			});
			return;
		}
		if (!stream) {
			this.json(res, 200, this.nonStreamBody(modelId, step, request));
			return;
		}
		this.streamSteps(res, modelId, step, request);
	}

	private nonStreamBody(modelId: string, step: ScriptStep, request: RecordedRequest): unknown {
		const id = nextId("chatcmpl");
		const message: Record<string, unknown> = { role: "assistant", content: null };
		let finish = "stop";
		if (step.kind === "text") {
			message.content = step.text;
		} else if (step.kind === "tool_calls") {
			if (step.text) message.content = step.text;
			message.tool_calls = step.calls.map((call, index) => ({
				id: call.id ?? nextId("call"),
				type: "function",
				index,
				function: { name: call.name, arguments: serializeArgs(call.args, request) },
			}));
			finish = "tool_calls";
		}
		return {
			id,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [{ index: 0, message, finish_reason: finish }],
			usage: usageBody(step),
		};
	}

	private streamSteps(res: ServerResponse, modelId: string, step: ScriptStep, request: RecordedRequest): void {
		const id = nextId("chatcmpl");
		const serializedCalls = step.kind === "tool_calls"
			? step.calls.map((call) => serializeArgs(call.args, request))
			: [];
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const send = (payload: unknown): void => {
			res.write(`data: ${JSON.stringify(payload)}\n\n`);
		};
		const frame = (choice: Record<string, unknown>): Record<string, unknown> => ({
			id,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [{ index: 0, ...choice }],
		});

		send(frame({ delta: { role: "assistant" }, finish_reason: null }));

		let finish = "stop";
		if (step.kind === "text") {
			for (const piece of splitForStreaming(step.text)) {
				send(frame({ delta: { content: piece }, finish_reason: null }));
			}
		} else if (step.kind === "tool_calls") {
			if (step.text) {
				send(frame({ delta: { content: step.text }, finish_reason: null }));
			}
			step.calls.forEach((call, index) => {
				const callId = call.id ?? nextId("call");
				send(
					frame({
						delta: {
							tool_calls: [
								{
									index,
									id: callId,
									type: "function",
									function: { name: call.name, arguments: "" },
								},
							],
						},
						finish_reason: null,
					}),
				);
				// Split arguments across deltas: clients must assemble, not assume.
				for (const piece of splitForStreaming(serializedCalls[index] as string)) {
					send(
						frame({
							delta: { tool_calls: [{ index, function: { arguments: piece } }] },
							finish_reason: null,
						}),
					);
				}
			});
			finish = "tool_calls";
		}

		send(frame({ delta: {}, finish_reason: finish }));
		send({
			id,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [],
			usage: usageBody(step),
		});
		res.write("data: [DONE]\n\n");
		res.end();
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(payload).toString(),
		});
		res.end(payload);
	}
}

function serializeArgs(args: MockToolCall["args"], request: RecordedRequest): string {
	const resolved = typeof args === "function" ? (args as (request: RecordedRequest) => unknown)(request) : args;
	return typeof resolved === "string" ? resolved : JSON.stringify(resolved ?? {});
}

/** Two chunks when possible, so delta assembly is actually exercised. */
function splitForStreaming(value: string): string[] {
	if (value.length < 2) return [value];
	const mid = Math.floor(value.length / 2);
	return [value.slice(0, mid), value.slice(mid)];
}

function usageBody(step: ScriptStep): Record<string, number | Record<string, number>> {
	const usage = "usage" in step ? step.usage : undefined;
	const prompt = usage?.prompt_tokens ?? 100;
	const completion = usage?.completion_tokens ?? 20;
	const body: Record<string, number | Record<string, number>> = {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
	};
	if (usage?.cached_tokens !== undefined) {
		body.prompt_tokens_details = { cached_tokens: usage.cached_tokens };
	}
	return body;
}
