/**
 * cp-fl8b, cp-z402: MCP in a real pi process. A worker reaches every enabled server of its inherited agent dir's
 * mcp.json through `mcp_call`, every exposed tool whatever its hints; hidden exposures stay out. The operator argv
 * has `/mcp`. The fixture server is tests/fixtures/mcp-probe-server.mjs; the agent dir is a throwaway one.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { operatorPiArgs } from "../../src/cp-bridge.ts";
import { PACKAGE_ROOT } from "../../src/home.ts";
import { OPERATOR_BUILTIN_EXTENSIONS } from "../../src/viewer/operator.ts";
import { MCP_CALL_TOOL, WORKER_MCP_EXTENSION } from "../../src/worker-mcp.ts";
import { createAgentDir, MockProvider, startPiChild, startRpc } from "../harness/index.ts";

const SERVER = join(PACKAGE_ROOT, "tests/fixtures/mcp-probe-server.mjs");

function mcpJson(dir: string, log: string): void {
	const server = (label: string, extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [SERVER, label, log], ...extra });
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
		probe: server("probe"),
		other: server("other", { toolExposure: { delete_thing: "hidden" } }),
		secret: server("secret", { exposure: "hidden" }),
	} }));
}

test("a worker lists and calls every exposed MCP tool, whatever its hints, of every server", { timeout: 120_000 }, async (t) => {
	const provider = await MockProvider.start();
	const work = mkdtempSync(join(tmpdir(), "cp-worker-mcp-"));
	const log = join(work, "calls.log");
	const call = (args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name: MCP_CALL_TOOL, args }] });
	const exposed = ["read_thing", "plain", "write_thing", "delete_thing", "odd_thing"];
	const model = provider.addScript("worker-mcp", [
		call({}),
		...exposed.map((tool) => call({ tool: `mcp__probe__${tool}`, arguments: {} })),
		call({ tool: "mcp__other__read_thing" }),
		call({ tool: "mcp__other__delete_thing" }),
		call({ tool: "mcp__secret__read_thing" }),
		call({ tool: "mcp__probe__nope" }),
		{ kind: "text", text: "done" },
	]);
	const agentDir = createAgentDir({ provider });
	mcpJson(agentDir.path, log);
	const child = startPiChild({ cwd: work, model, env: agentDir.env, extensions: [WORKER_MCP_EXTENSION], tools: ["read", MCP_CALL_TOOL] });
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		rmSync(work, { recursive: true, force: true });
	});

	await child.prompt("use MCP");
	await child.waitForSettled(90_000);
	const ends = child.eventsOfType("tool_execution_end").filter((r) => r.toolName === MCP_CALL_TOOL) as Array<{ isError?: boolean; result?: unknown }>;
	const text = (i: number) => JSON.stringify(ends[i]?.result ?? {});
	assert.equal(ends.length, 10, child.stderr());

	assert.equal(ends[0]?.isError, false);
	for (const tool of exposed) assert.match(text(0), new RegExp(`mcp__probe__${tool}`), `listed: ${tool}`);
	assert.match(text(0), /mcp__other__read_thing/);
	assert.match(text(0), /\\"input\\": \{/, "listed with input schemas");
	assert.doesNotMatch(text(0), /mcp__other__delete_thing|mcp__secret__/, "hidden tool and server exposures stay unlisted");
	exposed.forEach((tool, i) => {
		assert.equal(ends[i + 1]?.isError, false, tool);
		assert.match(text(i + 1), new RegExp(`ok:${tool}`), tool);
	});
	assert.match(text(6), /ok:read_thing/);
	for (const i of [7, 8, 9]) {
		assert.equal(ends[i]?.isError, true, text(i));
		assert.match(text(i), /not a connected MCP tool/);
	}

	const lines = readFileSync(log, "utf8").trim().split("\n").filter((line) => line.startsWith("call ")).sort();
	assert.deepEqual(lines, ["call other read_thing", ...exposed.map((tool) => `call probe ${tool}`).sort()], "hidden and unknown calls never reach a server");
	assert.equal(existsSync(join(agentDir.path, "mcp-auth.json")), false);
});

test("the operator argv loads pi's built-in MCP: /mcp is registered", { timeout: 60_000 }, async (t) => {
	const work = mkdtempSync(join(tmpdir(), "cp-operator-mcp-"));
	const agentDir = createAgentDir();
	mcpJson(agentDir.path, join(work, "calls.log"));
	const rpc = startRpc({ cwd: work, args: operatorPiArgs(PACKAGE_ROOT, ["--no-session"], [...OPERATOR_BUILTIN_EXTENSIONS]), env: agentDir.env });
	t.after(async () => {
		await rpc.close();
		agentDir.cleanup();
		rmSync(work, { recursive: true, force: true });
	});
	rpc.send({ id: "cmds", type: "get_commands" });
	const commands = await rpc.waitFor((record) => record.type === "response" && record.id === "cmds");
	const names = ((commands.data as { commands?: Array<{ name: string }> } | undefined)?.commands ?? []).map((command) => command.name);
	assert.ok(names.includes("mcp"), names.join(","));
	assert.ok(names.includes("cp-bridge"), names.join(","));
});
