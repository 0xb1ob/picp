/**
 * P8b retained from tests/worker-mcp.test.ts: agent-dir defaults and config shaping no e2e worker can observe. The
 * rest is pinned by tests/e2e/worker-lifecycle-p8b.test.ts (docs/testing-migration/p8b.md).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { agentDirOf, workerMcpConfig } from "../src/worker-mcp.ts";

test("agentDirOf follows PI_CODING_AGENT_DIR like pi's getAgentDir", () => {
	assert.equal(agentDirOf({ HOME: "/h" }), join("/h", ".pi", "agent"));
	assert.equal(agentDirOf({ HOME: "/h", PI_CODING_AGENT_DIR: "/x/agent" }), "/x/agent");
	assert.equal(agentDirOf({ HOME: "/h", PI_CODING_AGENT_DIR: "~/a" }), join("/h", "a"));
	assert.equal(agentDirOf({ PI_CODING_AGENT_DIR: "/x/agent" }), "/x/agent");
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

