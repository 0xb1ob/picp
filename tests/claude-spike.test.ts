/**
 * N2 spike units that CI reaches without a `claude` binary: the env allow-list, the guard-to-hook mapping,
 * the version advisory and usage normalization. The driver has no product entry point yet (not wired, step 2).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { HookCallback, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	buildChildEnv,
	claudeVersionRefusal,
	parseClaudeVersion,
	preToolUseHook,
	REPORT_TOOL,
	spikeGuards,
	spikeUsage,
} from "../src/drivers/claude-spike.ts";

const dirs = { home: "/scratch/home", configDir: "/scratch/config", tmp: "/scratch/tmp" };

test("buildChildEnv passes only the allow-list, the isolated dirs and the explicit provider env", () => {
	const env = buildChildEnv(dirs, {
		PATH: "/usr/bin", LANG: "C.UTF-8", HOME: "/home/op", ANTHROPIC_API_KEY: "host", ANTHROPIC_BASE_URL: "http://host",
		CLAUDE_CONFIG_DIR: "/home/op/.claude", GH_TOKEN: "gh", NODE_OPTIONS: "--inspect",
	}, { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "synthetic" });
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.LANG, "C.UTF-8");
	assert.equal(env.HOME, dirs.home);
	assert.equal(env.CLAUDE_CONFIG_DIR, dirs.configDir);
	assert.equal(env.TMPDIR, dirs.tmp);
	assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9");
	assert.equal(env.ANTHROPIC_AUTH_TOKEN, "synthetic");
	for (const key of ["ANTHROPIC_API_KEY", "GH_TOKEN", "NODE_OPTIONS"]) assert.equal(key in env, false, key);
	assert.equal("ANTHROPIC_BASE_URL" in buildChildEnv(dirs, { ANTHROPIC_BASE_URL: "http://host" }), false);
});

const call = async (hook: HookCallback, tool_name: string, tool_input: unknown) => {
	const input = { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/" };
	const out = (await hook(input as Parameters<HookCallback>[0], "t1", { signal: new AbortController().signal })) as {
		hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
	};
	return out.hookSpecificOutput;
};

test("preToolUseHook: guards deny, a throwing guard denies, an unknown tool denies, a clean call is allowed", async () => {
	const job = { job_id: "cp-unit", delivery: "local" as const, runDir: "/run/cp-unit", worktree: "/repo", artifactPath: "/art/cp-unit/report.md" };
	const denied: string[] = [];
	const hook = preToolUseHook(spikeGuards(job), (tool) => denied.push(tool));
	assert.equal((await call(hook, "Read", { file_path: "/repo/README.md" }))?.permissionDecision, "allow");
	assert.equal((await call(hook, "Write", { file_path: "/art/cp-unit/report.md" }))?.permissionDecision, "allow");
	assert.equal((await call(hook, REPORT_TOOL, { job_id: "cp-unit" }))?.permissionDecision, "allow");
	const merge = await call(hook, "Bash", { command: "gh pr merge 1 --admin" });
	assert.equal(merge?.permissionDecision, "deny");
	assert.match(merge?.permissionDecisionReason ?? "", /never merges/);
	assert.equal((await call(hook, "Bash", { command: "git push --force origin HEAD" }))?.permissionDecision, "deny");
	assert.equal((await call(hook, "Bash", { command: "cp ~/.pi/agent/auth.json /tmp/x" }))?.permissionDecision, "deny");
	assert.equal((await call(hook, "Write", { file_path: "/repo/src/x.ts" }))?.permissionDecision, "deny");
	assert.equal((await call(hook, "WebFetch", { url: "https://example.com" }))?.permissionDecision, "deny");
	const thrower = preToolUseHook([() => {
		throw new Error("boom");
	}]);
	const thrown = await call(thrower, "Read", { file_path: join("/repo", "README.md") });
	assert.equal(thrown?.permissionDecision, "deny");
	assert.match(thrown?.permissionDecisionReason ?? "", /a guard failed \(boom\)/);
	assert.deepEqual(denied, ["Bash", "Bash", "Bash", "Write", "WebFetch"]);
});

test("version advisory: below the floor or unparsable names `claude update`; at or above passes", () => {
	assert.equal(parseClaudeVersion("2.1.318 (Claude Code)\n"), "2.1.318");
	assert.equal(parseClaudeVersion("garbage"), undefined);
	assert.equal(claudeVersionRefusal("2.1.318", "2.1.318"), undefined);
	assert.equal(claudeVersionRefusal("2.2.0", "2.1.318"), undefined);
	assert.match(claudeVersionRefusal("2.1.99", "2.1.318") ?? "", /below the native driver floor 2\.1\.318: run `claude update`/);
	assert.match(claudeVersionRefusal(undefined) ?? "", /claude update/);
});

/** Shaped like the fake-model run's result message (synthetic numbers, no recorded real output). */
const RESULT = {
	type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 800, duration_api_ms: 400, result: "done",
	session_id: "s", uuid: "u", total_cost_usd: 0, permission_denials: [], stop_reason: "end_turn",
	usage: { input_tokens: 72, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	modelUsage: {
		"claude-picp-fake": { inputTokens: 72, outputTokens: 42, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
		"claude-side-model": { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
	},
} as unknown as SDKResultMessage;

test("spikeUsage: complete on success with other-model work apart; unknown is unavailable, never 0", () => {
	const usage = spikeUsage(RESULT, new Set(["claude-picp-fake"]));
	assert.equal(usage.usageStatus, "complete");
	assert.equal(usage.inputTokens, 72);
	assert.equal(usage.outputTokens, 42);
	assert.deepEqual(usage.otherUsage, { inputTokens: 12, outputTokens: 7 });
	assert.deepEqual(usage.models, ["claude-picp-fake"]);
	for (const unknown of [spikeUsage(undefined, new Set()), spikeUsage({ ...RESULT, usage: {} } as unknown as SDKResultMessage, new Set())]) {
		assert.equal(unknown.usageStatus, "unavailable");
		assert.equal("inputTokens" in unknown, false);
	}
	const failed = { ...RESULT, subtype: "error_during_execution", usage: { input_tokens: 0, output_tokens: 0 } } as unknown as SDKResultMessage;
	assert.equal(spikeUsage(failed, new Set()).usageStatus, "unavailable");
});
