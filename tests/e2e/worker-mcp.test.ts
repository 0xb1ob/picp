/**
 * cp-fl8b: MCP in a real pi process. A read-only worker reaches every server of its inherited agent
 * dir's mcp.json through `mcp_call`, only for tools declared read-only; the operator argv has `/mcp`.
 * The fixture server is tests/fixtures/mcp-probe-server.mjs; the agent dir is a throwaway one.
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
	const server = (label: string) => ({ command: process.execPath, args: [SERVER, label, log] });
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { probe: server("probe"), other: server("other") } }));
}

test("a read-only worker lists and calls only read-only MCP tools, of every server", { timeout: 120_000 }, async (t) => {
	const provider = await MockProvider.start();
	const work = mkdtempSync(join(tmpdir(), "cp-worker-mcp-"));
	const log = join(work, "calls.log");
	const call = (args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name: MCP_CALL_TOOL, args }] });
	const model = provider.addScript("worker-mcp", [
		call({}),
		call({ tool: "mcp__probe__read_thing", arguments: {} }),
		call({ tool: "mcp__other__read_thing" }),
		call({ tool: "mcp__probe__plain" }),
		call({ tool: "mcp__probe__delete_thing" }),
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
	assert.equal(ends.length, 6, child.stderr());

	assert.equal(ends[0]?.isError, false);
	assert.match(text(0), /mcp__probe__read_thing/);
	assert.match(text(0), /mcp__other__read_thing/);
	assert.doesNotMatch(text(0), /plain|delete_thing/);
	assert.equal(ends[1]?.isError, false);
	assert.match(text(1), /ok:read_thing/);
	assert.match(text(2), /ok:read_thing/);
	assert.equal(ends[3]?.isError, true);
	assert.match(text(3), /readOnlyHint/);
	assert.equal(ends[4]?.isError, true);
	assert.match(text(4), /destructiveHint/);
	assert.equal(ends[5]?.isError, true);
	assert.match(text(5), /not a connected MCP tool/);

	const lines = readFileSync(log, "utf8").trim().split("\n").sort();
	assert.deepEqual(lines, ["call other read_thing", "call probe read_thing", "start other", "start probe"], "refused calls never reach a server");
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
