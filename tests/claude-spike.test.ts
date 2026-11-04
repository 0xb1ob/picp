/**
 * N2 spike units that CI reaches without a `claude` binary: the env allow-list, the guard-to-hook mapping,
 * the version advisory and usage normalization. The driver has no product entry point yet (not wired, step 2).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { HookCallback, SDKResultMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { readOnlyBashRefusal, secretPaths } from "../src/drivers/claude-bash-policy.ts";
import { CLI_BUILTIN_AGENTS, type InitSurface, lockdownVerdict } from "../src/drivers/claude-lockdown.ts";
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
	const locked = preToolUseHook(spikeGuards(job), () => {}, Promise.resolve("Refused: lockdown"));
	assert.equal((await call(locked, "Read", { file_path: "/repo/README.md" }))?.permissionDecisionReason, "Refused: lockdown");
});

const SECRETS = secretPaths("/op/settings.json", ["/op", "/op"]);
const bashRefusal = (command: string) => readOnlyBashRefusal(command, "/repo", SECRETS);

test("readOnlyBashRefusal: named read-only commands run; expansions, writers, env dumps and secret paths are refused", () => {
	assert.deepEqual(SECRETS, ["/op/settings.json", "/op/.claude", "/op/.config/claude", "/proc", "/dev/fd"]);
	for (const command of [
		"rg -n foo src | head -5",
		"cat README.md | wc -l && ls 2>/dev/null",
		"git log --oneline -3; git status",
		"gh pr view 7 --json title",
		"ls nope || echo none $?",
		"grep 'a > b $HOME ${X} {a,b} ~' file",
		"find . -name '*.ts'",
		"sort -nr -k 2 f",
		"git grep -n -e x; tail -5 f; head -n5 f",
		"git log -n 3 --format=%H -- src",
		"git show --pretty=oneline HEAD; git diff -U3 HEAD",
	]) assert.equal(bashRefusal(command), undefined, command);
	for (const [command, why] of [
		["echo x > f", "a redirect"],
		["echo x >> f", "a redirect"],
		["cat < f", "a redirect"],
		["echo x | tee f", "`tee`"],
		["cat $(touch f)", "a command substitution"],
		["cat \"`touch f`\"", "a command substitution"],
		["(touch f)", "a subshell"],
		["sleep 9 &", "a background job"],
		["FOO=1 cat f", "an env assignment"],
		["cp a b", "`cp`"],
		["sed -i s/a/b/ f", "`sed`"],
		["git commit -m x", "`git commit`"],
		["git -C /x status", "`git -C`"],
		["git diff --output=f", "`git diff` option `--output`"],
		["git log --outp=f", "`git log` option `--outp`"],
		["git grep -nOrm x", "`git grep` option `-O`"],
		["git grep -O rm x", "`git grep` option `-O`"],
		["git grep --open-files-in-pager=rm x", "`git grep` option `--open-files-in-pager`"],
		["git log --pretty --output=/repo/f", "`git log` option `--pretty`"],
		["git show --format --output=/repo/f", "`git show` option `--format`"],
		["git diff -U --output=f", "`git diff` option `-U`"],
		["git diff -U3 --output=f", "`git diff` option `--output`"],
		["git log -n --output=f", "`git log` option `-n`"],
		["git log --since --output=f", "`git log` option `--since`"],
		["rg -e -- --pre=sh x", "`rg` option `-e`"],
		["head -n", "`head` option `-n`"],
		["file -C -m f", "`file` (not on the read-only list)"],
		["find . -delete", "`find` option `-delete`"],
		["find . -name x -fprint f", "`find` option `-fprint`"],
		["sort -o f g", "`sort` option `-o`"],
		["sort -S 1 f", "`sort` option `-S`"],
		["sort -nT /tmp f", "`sort` option `-T`"],
		["sort --compress-program=sh f", "`sort` option `--compress-program`"],
		["rg --pre sh x", "`rg` option `--pre`"],
		["rg -nz x", "`rg` option `-z`"],
		["rg --hostname-bin=sh x", "`rg` option `--hostname-bin`"],
		["gh pr view 7 --web", "`gh pr view` option `--web`"],
		["cat *", "an unquoted glob"],
		["ls src/?.ts", "an unquoted glob"],
		["ls [ab]", "an unquoted glob"],
		["gh pr merge 7", "`gh pr merge`"],
		["echo 'open", "an unterminated quote"],
		["find /repo ${U:--delete}", "a parameter expansion"],
		["find /repo $'-\\x64elete'", "an ANSI-C or locale quote"],
		["find /repo $\"-delete\"", "an ANSI-C or locale quote"],
		["echo $[1+1]", "an arithmetic expansion"],
		["find /repo {-delete,}", "a brace expansion"],
		["git log ${U:---output=/repo/f}", "a parameter expansion"],
		["echo $ANTHROPIC_AUTH_TOKEN", "a variable expansion"],
		["echo \"$CP_SENTINEL_SECRET\"", "a variable expansion"],
		["cat ~op/.claude/settings.json", "a tilde expansion"],
		["printenv", "`printenv` (not on the read-only list)"],
		["env", "`env` (not on the read-only list)"],
		["cd /repo/src", "`cd` (not on the read-only list)"],
		["cat /proc/self/environ", "a secret path"],
		["grep -a SECRET /proc/1/environ", "a secret path"],
		["cat ../../proc/self/environ", "a secret path"],
		["cat /op/settings.json", "a secret path"],
		["head /op/.claude.json", "a secret path"],
		["rg x '/op/.cl*/s'", "a secret path"],
		["rg x /op", "a secret path"],
		["grep --file=/op/.config/claude/x y", "a secret path"],
		["cat /dev/fd/3", "a secret path"],
	] as Array<[string, string]>) assert.match(bashRefusal(command) ?? "", new RegExp(`; ${why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), command);
});

const INIT: InitSurface = {
	tools: ["Read", REPORT_TOOL],
	mcp_servers: [{ name: "picp", status: "connected" }],
	skills: ["doctor"],
	plugins: [{ name: "cc-plugin-privacy", path: "builtin" }],
	agents: [],
	slash_commands: ["doctor", "compact"],
	output_style: "default",
};
const COMMANDS = [{ name: "doctor", builtin: true }, { name: "compact", builtin: true }] as SlashCommand[];
const LOCKED = { hooks: [], policy: { managedOnly: true, policyHookCount: 0 } };

test("lockdownVerdict: only picp's surface and CLI built-ins pass; any extra, a missing listing or an unbound lock refuses", () => {
	const ok = lockdownVerdict(INIT, ["Read", REPORT_TOOL], COMMANDS, [], LOCKED);
	assert.equal(ok.verdict, "ok");
	assert.deepEqual(ok.seen, { tools: 2, mcpServers: 1, skills: 1, plugins: 1, agents: 0, slashCommands: 2, hooks: 0, managedHooks: 0 });
	assert.equal(Object.keys(CLI_BUILTIN_AGENTS).length, 5);
	// A loaded agent that reuses a built-in name is still an extra: its description does not match the pinned digest.
	const loaded = lockdownVerdict({
		...INIT,
		tools: ["Read", "Bash"],
		mcp_servers: [{ name: "other", status: "connected" }],
		skills: ["doctor", "x"],
		plugins: [{ name: "p", path: "/home/op/p" }],
		agents: ["y", "Plan"],
		output_style: "Explanatory",
	}, ["Read", REPORT_TOOL], [...COMMANDS, { name: "doctor" } as SlashCommand], [{ name: "Plan", description: "impostor" }], { hooks: [{}], policy: { managedOnly: true } });
	assert.deepEqual(loaded.extra, { tools: 2, mcpServers: 2, skills: 2, plugins: 1, agents: 2, slashCommands: 1, hooks: 1, outputStyle: 1 });
	assert.match(loaded.refusal ?? "", /^Refused: the Claude CLI lockdown failed: it loaded a surface picp did not pass \(tools 2, mcpServers 2/);
	assert.doesNotMatch(loaded.refusal ?? "", /home|Explanatory|other|impostor|Plan/);
	assert.match(lockdownVerdict(INIT, ["Read", REPORT_TOOL], COMMANDS, [], undefined).refusal ?? "", /no hook listing/);
	assert.match(lockdownVerdict(INIT, ["Read", REPORT_TOOL], COMMANDS, [], { hooks: [], policy: { managedOnly: false } }).refusal ?? "", /did not bind/);
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
	const usage = spikeUsage(RESULT, new Set(["claude-picp-fake"]), new Map());
	assert.equal(usage.usageStatus, "complete");
	assert.equal(usage.inputTokens, 72);
	assert.equal(usage.outputTokens, 42);
	assert.deepEqual(usage.otherUsage, { inputTokens: 12, outputTokens: 7 });
	assert.deepEqual(usage.models, ["claude-picp-fake"]);
	for (const unknown of [spikeUsage(undefined, new Set(), new Map()), spikeUsage({ ...RESULT, usage: {} } as unknown as SDKResultMessage, new Set(), new Map())]) {
		assert.equal(unknown.usageStatus, "unavailable");
		assert.equal("inputTokens" in unknown, false);
	}
	const failed = { ...RESULT, subtype: "error_during_execution", usage: { input_tokens: 0, output_tokens: 0 } } as unknown as SDKResultMessage;
	assert.equal(spikeUsage(failed, new Set(), new Map()).usageStatus, "unavailable");
	// A resumed process restores the session's modelUsage: the prior run's ledger keeps it from counting twice.
	const prior = new Map([["claude-side-model", { input: 12, output: 7 }]]);
	assert.deepEqual(spikeUsage(RESULT, new Set(["claude-picp-fake"]), prior).otherUsage, { inputTokens: 0, outputTokens: 0 });
	assert.equal("otherUsage" in spikeUsage(RESULT, new Set(["claude-picp-fake"]), undefined), false);
});
