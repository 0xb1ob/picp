#!/usr/bin/env node
// Minimal MCP stdio server for tests (cp-fl8b): newline-delimited JSON-RPC 2.0.
// argv: <label> <log file>. Appends "start <label>" once and "call <label> <tool>" per tools/call.
import { appendFileSync } from "node:fs";

const [label = "probe", log] = process.argv.slice(2);
const note = (line) => log && appendFileSync(log, `${line}\n`);
note(`start ${label}`);

const object = { type: "object", properties: {} };
const tools = [
	{ name: "read_thing", description: "Read a thing", inputSchema: object, annotations: { readOnlyHint: true } },
	{ name: "delete_thing", description: "Delete a thing", inputSchema: object, annotations: { destructiveHint: true } },
	{ name: "plain", description: "No hints", inputSchema: object },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line) continue;
		const { id, method, params } = JSON.parse(line);
		if (id === undefined) continue; // notifications
		if (method === "initialize") {
			send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: label, version: "1.0.0" } } });
		} else if (method === "tools/list") {
			send({ id, result: { tools } });
		} else if (method === "tools/call") {
			note(`call ${label} ${params.name}`);
			send({ id, result: { content: [{ type: "text", text: `ok:${params.name}` }] } });
		} else if (method === "ping") {
			send({ id, result: {} });
		} else {
			send({ id, error: { code: -32601, message: `method not found: ${method}` } });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
