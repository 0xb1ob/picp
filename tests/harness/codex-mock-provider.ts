/**
 * A loopback Responses API (C1 probe E15) that plays the model for the real `codex` CLI: each POST to `/v1/responses`
 * answers the next scripted turn as SSE and is kept for the test to read. No login, no network, zero tokens.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One model turn: function calls (`name`, JSON `arguments`, a tool `namespace`), custom tool calls (`input` text, as
 * the code-mode `exec` takes JavaScript), or an assistant message.
 */
export type MockModelTurn =
	| { calls: Array<{ name: string; arguments: Record<string, unknown>; namespace?: string }> }
	| { custom: Array<{ name: string; input: string; namespace?: string }> }
	| { message: string };
/** Picks a turn from the raw request body; undefined falls through to the scripted order. */
export type MockRouter = (body: string) => MockModelTurn | undefined;

export interface CodexMockProvider {
	/** The provider's base URL, for `-c model_providers.mock={…,base_url=…}`. */
	url: string;
	/** Every request body the CLI sent, parsed, in order. */
	requests: Array<Record<string, unknown>>;
	/** The `-c` flags that point the CLI at this provider. */
	config: string[];
	close: () => Promise<void>;
}

const body = (req: IncomingMessage): Promise<string> =>
	new Promise((done, fail) => {
		let text = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => (text += chunk));
		req.on("end", () => done(text));
		req.on("error", fail);
	});

const sse = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Starts the provider on 127.0.0.1; past the script every turn is the message `done`. */
export async function startCodexMockProvider(turns: readonly MockModelTurn[], route?: MockRouter): Promise<CodexMockProvider> {
	const requests: Array<Record<string, unknown>> = [];
	let next = 0;
	const server = createServer((req, res) => {
		void body(req).then((text) => {
			if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
				res.writeHead(404).end();
				return;
			}
			requests.push(JSON.parse(text || "{}") as Record<string, unknown>);
			const routed = route?.(text);
			const turn = routed ?? turns[next] ?? { message: "done" };
			const n = requests.length;
			if (routed === undefined) next++;
			const id = `resp_mock_${n}`;
			const ns = (namespace?: string) => (namespace === undefined ? {} : { namespace });
			const items = "message" in turn
				? [{ type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: turn.message, annotations: [] }] }]
				: "custom" in turn
					? turn.custom.map((call, i) => ({ type: "custom_tool_call", id: `ctc_${n}_${i}`, call_id: `call_${n}_${i}`, name: call.name, input: call.input, ...ns(call.namespace) }))
					: turn.calls.map((call, i) => ({ type: "function_call", id: `fc_${n}_${i}`, call_id: `call_${n}_${i}`, name: call.name, arguments: JSON.stringify(call.arguments), ...ns(call.namespace) }));
			const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(sse("response.created", { response: { id } }));
			for (const item of items) res.write(sse("response.output_item.done", { item }));
			res.end(sse("response.completed", { response: { id, usage } }));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	return {
		url,
		requests,
		config: ["-c", 'model_provider="mock"', "-c", `model_providers.mock={name="mock",base_url=${JSON.stringify(url)},wire_api="responses"}`],
		close: () => new Promise((done) => server.close(() => done())),
	};
}
