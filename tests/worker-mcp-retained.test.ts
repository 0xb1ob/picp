/**
 * P8b retained from tests/worker-mcp.test.ts: agent-dir resolution and config shaping no worker can observe. The
 * rest is pinned by tests/e2e/worker-lifecycle-p8b.test.ts (docs/testing-migration/p8b.md).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDirOf, enabledServers, readUserMcpServers, workerMcpConfig } from "../src/worker-mcp.ts";

function agentDir(t: { after(fn: () => void): void }, servers?: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-wmcp-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (servers) writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
	return dir;
}

test("agentDirOf follows PI_CODING_AGENT_DIR like pi's getAgentDir", () => {
	assert.equal(agentDirOf({ HOME: "/h" }), join("/h", ".pi", "agent"));
	assert.equal(agentDirOf({ HOME: "/h", PI_CODING_AGENT_DIR: "/x/agent" }), "/x/agent");
	assert.equal(agentDirOf({ HOME: "/h", PI_CODING_AGENT_DIR: "~/a" }), join("/h", "a"));
	assert.equal(agentDirOf({ PI_CODING_AGENT_DIR: "/x/agent" }), "/x/agent");
});

test("readUserMcpServers: missing is none, invalid is an error without the content", (t) => {
	assert.deepEqual(readUserMcpServers(agentDir(t)).servers, {});
	const bad = agentDir(t);
	writeFileSync(join(bad, "mcp.json"), "{ nope");
	assert.ok(readUserMcpServers(bad).error);
	const dir = agentDir(t, { a: { command: "x" }, off: { command: "y", enabled: false } });
	assert.deepEqual(enabledServers(readUserMcpServers(dir).servers), ["a"]);
});

test("workerMcpConfig keeps every server, credentials and all, and makes non-hidden tools direct", () => {
	const loaded = workerMcpConfig({
		path: "/a/mcp.json",
		servers: {
			stdio: { command: "srv", env: { K: "!pass show k", V: "${TOKEN}" }, exposure: "deferred", toolExposure: { "get_*": "codemode", "drop_*": "hidden" } },
			oauth: { url: "https://mcp.example.com/mcp" },
			hidden: { url: "https://h.example.com/mcp", headers: { Authorization: "Bearer ${T}" }, exposure: "hidden" },
			broken: { args: [] },
		},
	});
	assert.equal(loaded.autoEnableCodemode, false);
	assert.deepEqual(loaded.servers.map((s) => s.name), ["stdio", "oauth", "hidden"]);
	const [stdio, oauth, hidden] = loaded.servers;
	assert.deepEqual(stdio?.config, { command: "srv", env: { K: "!pass show k", V: "${TOKEN}" }, exposure: "direct", toolExposure: { "get_*": "direct", "drop_*": "hidden" } });
	assert.equal(oauth?.config.exposure, "direct");
	assert.equal(hidden?.config.exposure, "hidden");
	assert.equal(loaded.errors.length, 1);
	assert.match(loaded.errors[0] as string, /"broken"/);
});

