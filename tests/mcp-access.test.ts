/** cp-fl8b: `/doctor`'s `mcp.operator` and `mcp.workers` lines (src/mcp-access.ts). */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandRunner } from "../src/doctor.ts";
import { mcpFindings } from "../src/mcp-access.ts";
import { REPO_ROOT } from "./harness/index.ts";

function agentDir(t: { after(fn: () => void): void }, servers?: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-mcpdoc-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (servers) writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
	return dir;
}

function recording(stdout: string, calls: string[][]): CommandRunner {
	return (command, args) => {
		calls.push([command, ...args]);
		return { status: 0, stdout, stderr: "" };
	};
}

test("no enabled server: no probe, and the workers line says so", (t) => {
	const calls: string[][] = [];
	for (const servers of [undefined, { off: { command: "x", enabled: false } }]) {
		const [operator, workers] = mcpFindings({ packageRoot: REPO_ROOT, env: { PI_CODING_AGENT_DIR: agentDir(t, servers) }, run: recording("", calls) });
		assert.equal(operator?.severity, "ok");
		assert.equal(workers?.what, "read-only workers: no MCP servers configured");
	}
	assert.deepEqual(calls, [], "pi mcp list never runs without an enabled server");
});

test("servers: one live `pi mcp list --json`, all N servers for read-only workers, no config value printed", (t) => {
	const secret = "sk-live-0123456789abcdefghij";
	const dir = agentDir(t, { docs: { url: "https://mcp.internal.example/mcp", headers: { Authorization: `Bearer ${secret}` } }, local: { command: "/opt/secret-tool", args: ["--token", secret] } });
	const listed = {
		servers: [
			{ name: "docs", enabled: true, state: "connected", tools: ["a", "b"], transport: "https://mcp.internal.example/mcp" },
			{ name: "local", enabled: true, state: "failed", tools: [], error: `spawn /opt/secret-tool --token ${secret} ENOENT` },
		],
		errors: [],
	};
	const calls: string[][] = [];
	const [operator, workers] = mcpFindings({ packageRoot: REPO_ROOT, env: { PI_CODING_AGENT_DIR: dir }, run: recording(JSON.stringify(listed), calls) });
	assert.deepEqual(calls, [["pi", "mcp", "list", "--json"]]);
	assert.equal(workers?.check, "mcp.workers");
	assert.equal(workers?.what, "read-only workers: all 2 servers, read-only tools only");
	assert.match(String(workers?.detail), /gate-reviewer, planner, qa via mcp_call/);
	assert.doesNotMatch(String(workers?.what) + String(workers?.detail), /allowlist/);
	assert.equal(operator?.severity, "warn");
	assert.ok(operator?.fix);
	assert.match(String(operator?.what), /connected 1\/2; tools 2/);
	assert.match(String(operator?.detail), /local: failed/);
	const printed = JSON.stringify([operator, workers]);
	for (const value of [secret, "/opt/secret-tool", "mcp.internal.example"]) assert.equal(printed.includes(value), false, value);
});

test("a probe without a report and an invalid mcp.json are warnings that name a fix, never the content", (t) => {
	const [noReport] = mcpFindings({ packageRoot: REPO_ROOT, env: { PI_CODING_AGENT_DIR: agentDir(t, { a: { command: "/opt/hidden-cmd" } }) }, run: () => ({ status: null, stdout: "", stderr: "spawn /opt/hidden-cmd ETIMEDOUT" }) });
	assert.equal(noReport?.severity, "warn");
	assert.ok(noReport?.fix);
	assert.equal(JSON.stringify(noReport).includes("/opt/hidden-cmd"), false);
	const bad = agentDir(t);
	writeFileSync(join(bad, "mcp.json"), '{"mcpServers": {"x": "Bearer sk-live-0123456789abcdefghij"');
	const [invalid, workers] = mcpFindings({ packageRoot: REPO_ROOT, env: { PI_CODING_AGENT_DIR: bad }, run: () => assert.fail("no probe") });
	assert.equal(invalid?.severity, "warn");
	assert.ok(invalid?.fix);
	assert.equal(JSON.stringify([invalid, workers]).includes("sk-live"), false);
});
