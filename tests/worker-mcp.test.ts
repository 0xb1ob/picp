/**
 * cp-fl8b: MCP for read-only workers — config, read-only refusal, and the spawn plan. The pi-process
 * half (gateway, guard, real servers) is tests/e2e/worker-mcp.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProfile } from "../src/profiles.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { NO_OPTIONAL_WORKER_PACKAGES } from "../src/worker-packages.ts";
import { agentDirOf, enabledServers, MCP_CALL_TOOL, mcpReadOnlyRefusal, readUserMcpServers, WORKER_MCP_EXTENSION, withWorkerMcp, workerMcpConfig } from "../src/worker-mcp.ts";
import { REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

const PROFILES = join(REPO_ROOT, "profiles");

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

test("mcpReadOnlyRefusal fails closed: only readOnlyHint true and not destructive passes", () => {
	assert.equal(mcpReadOnlyRefusal("mcp__a__r", { readOnlyHint: true }), undefined);
	assert.equal(mcpReadOnlyRefusal("mcp__a__r", { readOnlyHint: true, destructiveHint: false }), undefined);
	assert.match(mcpReadOnlyRefusal("mcp__a__p", undefined) as string, /readOnlyHint/);
	assert.match(mcpReadOnlyRefusal("mcp__a__p", {}) as string, /readOnlyHint/);
	assert.match(mcpReadOnlyRefusal("mcp__a__p", { readOnlyHint: false }) as string, /readOnlyHint/);
	assert.match(mcpReadOnlyRefusal("mcp__a__d", { readOnlyHint: true, destructiveHint: true }) as string, /destructiveHint/);
});

test("withWorkerMcp: read-only profiles only, and only when the agent dir has an enabled server", (t) => {
	const env = { PI_CODING_AGENT_DIR: agentDir(t, { a: { command: "x" } }) };
	for (const name of ["planner", "qa", "gate-reviewer"]) {
		const added = withWorkerMcp(NO_OPTIONAL_WORKER_PACKAGES, loadProfile(PROFILES, name), env);
		assert.deepEqual(added.extensions, [WORKER_MCP_EXTENSION], name);
		assert.deepEqual(added.tools, [MCP_CALL_TOOL], name);
	}
	assert.equal(withWorkerMcp(NO_OPTIONAL_WORKER_PACKAGES, loadProfile(PROFILES, "implementer"), env), NO_OPTIONAL_WORKER_PACKAGES);
	assert.equal(withWorkerMcp(NO_OPTIONAL_WORKER_PACKAGES, loadProfile(PROFILES, "planner"), { PI_CODING_AGENT_DIR: agentDir(t) }), NO_OPTIONAL_WORKER_PACKAGES);
	assert.equal(withWorkerMcp(NO_OPTIONAL_WORKER_PACKAGES, loadProfile(PROFILES, "planner"), { PI_CODING_AGENT_DIR: agentDir(t, { off: { command: "x", enabled: false } }) }), NO_OPTIONAL_WORKER_PACKAGES);
});

test("a planner's spawn plan carries the gateway next to report_result; an implementer's does not", (t) => {
	const parentEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir(t, { a: { command: "x" } }) };
	const manager = new WorkerManager({ home: "/unused", parentEnv, workerReporterPath: WORKER_REPORTER_EXTENSION });
	const request = (name: string) => {
		const worktree = agentDir(t);
		return { identity: { jobId: "cp-wmcp", kind: "research" as const, delivery: "local" as const, runDir: worktree, worktree }, profile: loadProfile(PROFILES, name), model: "anthropic/claude-x" };
	};
	const planner = manager.plan(request("planner"));
	assert.ok(planner.tools.includes(MCP_CALL_TOOL));
	assert.ok(planner.tools.includes("report_result"));
	assert.equal(planner.unresolvedTools, undefined);
	assert.ok(planner.args.join(" ").includes(`-e ${WORKER_MCP_EXTENSION}`));
	assert.equal(planner.env.PI_CODING_AGENT_DIR, parentEnv.PI_CODING_AGENT_DIR, "the worker reads the same agent dir in place");
	const implementer = manager.plan(request("implementer"));
	assert.equal(implementer.tools.includes(MCP_CALL_TOOL), false);
	assert.equal(implementer.args.join(" ").includes("worker-mcp"), false);
});
