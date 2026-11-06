/**
 * N2 spike units that CI reaches without a `claude` binary: the env allow-list, the guard-to-hook mapping,
 * the version advisory and usage normalization. The driver has no product entry point yet (not wired, step 2).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HookCallback, SDKResultMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import workerReporter, { VERDICT_FILE, VERDICT_RAW_FILE } from "../extensions/worker-reporter/index.ts";
import { type Delivery, type FleetRecord, type JobKind, paths, type Role, type RoutingConfig } from "../src/contracts.ts";
import { verdictReport } from "../src/drivers/claude-verdict.ts";
import { holdReviewerSlot, resolveReviewerRoute } from "../src/reviewer-route.ts";
import { ALWAYS_AVAILABLE } from "../src/routing.ts";
import { nativeSpawn } from "../src/dispatch-driver.ts";
import { assertNativeSelection, nativeAddendum, nativeBaseEnv, NativeDriverError, nativeMaxConcurrent, nativeSelectionRefusal, nativeSlotRefusal } from "../src/drivers/claude.ts";
import { nativeRevivePrompt, nativeReviveBase, nativeSessionMoved, writeNativeSession } from "../src/drivers/claude-followup.ts";
import { readOnlyBashRefusal, secretPaths } from "../src/drivers/claude-bash-policy.ts";
import { CLI_BUILTIN_AGENTS, type InitSurface, lockdownVerdict } from "../src/drivers/claude-lockdown.ts";
import {
	buildChildEnv,
	CHILD_MANAGED_SETTINGS,
	claudeVersionRefusal,
	parseClaudeVersion,
	preToolUseHook,
	REPORT_TOOL,
	spikeGuards,
	spikeUsage,
} from "../src/drivers/claude-spike.ts";
import { nativeQuotaLine } from "../src/viewer/native-quota.ts";
import { loadNativeConfig, nativeConfigFile } from "../src/worker-driver.ts";

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
	// N4m: no marketplace auto-install, and policy settings that keep a settings-enabled plugin out of the kept scratch.
	assert.equal(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, "1");
	assert.deepEqual(CHILD_MANAGED_SETTINGS, { disableAllHooks: true, strictKnownMarketplaces: [] });
});

const call = async (hook: HookCallback, tool_name: string, tool_input: unknown) => {
	const input = { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/" };
	const out = (await hook(input as Parameters<HookCallback>[0], "t1", { signal: new AbortController().signal })) as {
		hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
	};
	return out.hookSpecificOutput;
};

test("preToolUseHook: guards deny, a throwing guard denies, an unknown tool denies, a clean call is allowed", async () => {
	const job = { job_id: "cp-unit", kind: "research" as const, role: "planner" as const, delivery: "local" as const, runDir: "/run/cp-unit", worktree: "/repo", artifactPath: "/art/cp-unit/report.md" };
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

const WORKER = fileURLToPath(new URL("../src/drivers/claude-worker.ts", import.meta.url));
const startWorker = (env: Record<string, string>) =>
	spawnSync(process.execPath, [WORKER], { input: `${JSON.stringify({ id: 1, type: "prompt", message: "go" })}\n`, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 60_000 });

// N4f/N4h: the worker takes the pairs selection allows (research planner, research gate-reviewer, ship implementer); any
// other pair, a missing or empty role contract is a named start error, each exiting 1 before any claude process starts.
test("claude-worker: a role/kind pair selection never allows and a missing or empty system prompt file are named start errors", () => {
	const dir = mkdtempSync(join(tmpdir(), "cp-native-start-"));
	try {
		const job = { CP_JOB_ID: "cp-unit", CP_RUN_DIR: dir, CP_WORKTREE: dir, CP_ARTIFACT_PATH: join(dir, "report.md"), CP_DELIVERY: "local" };
		for (const [kind, role] of [["ship", "planner"], ["research", "implementer"], ["ship", "gate-reviewer"]]) {
			const refused = startWorker({ ...job, CP_KIND: kind!, CP_ROLE: role! });
			assert.equal(refused.status, 1, refused.stderr);
			assert.match(refused.stderr, new RegExp(`refused: native claude runs research/planner, research/gate-reviewer and ship/implementer jobs only, not ${kind}/${role}`));
		}
		const reviewer = startWorker({ ...job, CP_ARTIFACT_PATH: "", CP_KIND: "research", CP_ROLE: "gate-reviewer" });
		assert.match(reviewer.stderr, /started without its system prompt file/, "a reviewer with no artifact passes the pair check");
		const ship = startWorker({ ...job, CP_ARTIFACT_PATH: "", CP_KIND: "ship", CP_ROLE: "implementer" });
		assert.equal(ship.status, 1, ship.stderr);
		assert.match(ship.stderr, /started without its system prompt file/, "a ship implementer with no artifact passes the pair check");
		const research = { ...job, CP_KIND: "research", CP_ROLE: "planner" };
		const missing = startWorker(research);
		assert.equal(missing.status, 1, missing.stderr);
		assert.match(missing.stderr, /started without its system prompt file \(CP_NATIVE_SYSTEM_PROMPT_FILE\)/);
		const file = join(dir, "system-prompt.md");
		writeFileSync(file, " \n");
		const empty = startWorker({ ...research, CP_NATIVE_SYSTEM_PROMPT_FILE: file });
		assert.equal(empty.status, 1, empty.stderr);
		assert.match(empty.stderr, /system prompt .*system-prompt\.md is empty/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("N4f native.json: absent is every class off at concurrency 1; switches are booleans, max_concurrent 1-4, unknown keys refused", (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-native-config-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const file = nativeConfigFile(home);
	mkdirSync(dirname(file), { recursive: true });
	assert.deepEqual(loadNativeConfig(file), { claude_research: false, claude_ship: false, claude_review: false, max_concurrent: 1 });
	const load = (value: unknown) => (writeFileSync(file, JSON.stringify(value)), loadNativeConfig(file));
	assert.deepEqual(load({ claude_ship: true, max_concurrent: 4 }), { claude_research: false, claude_ship: true, claude_review: false, max_concurrent: 4 });
	assert.equal(load({ claude_review: true }).claude_review, true);
	for (const bad of [0, 5, 1.5, "2", null]) assert.throws(() => load({ max_concurrent: bad }), /max_concurrent must be an integer from 1 to 4/, String(bad));
	assert.throws(() => load({ claude_ship: "yes" }), /claude_ship must be true or false/);
	assert.throws(() => load({ claude_research: true, claude_deploy: true }), /unknown key claude_deploy/);
	// The dashboard's Claude item read the file with only claude_research allowed; the new keys keep it visible.
	const state = join(dirname(dirname(file)), "state");
	mkdirSync(state);
	writeFileSync(file, JSON.stringify({ claude_ship: true, max_concurrent: 2 }));
	assert.equal(nativeQuotaLine(state, Date.now())?.state, "unknown");
	writeFileSync(file, JSON.stringify({ claude_ship: true, extra: 1 }));
	assert.equal(nativeQuotaLine(state, Date.now()), undefined);
	writeFileSync(file, JSON.stringify({ claude_ship: false, claude_review: false }));
	assert.equal(nativeQuotaLine(state, Date.now()), undefined);
});

test("N4f eligibility: research, ship and review map to their own switch; a disabled class or another pair refuses by name", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-native-class-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	mkdirSync(dirname(nativeConfigFile(home)), { recursive: true });
	const toggle = (value: Record<string, boolean>) => writeFileSync(nativeConfigFile(home), JSON.stringify(value));
	// An empty PATH makes a passing selection end at the CLI check, so `cli_missing` means every class gate passed.
	const refusal = (kind: JobKind, role: Role, delivery: Delivery) =>
		nativeSelectionRefusal({ home, jobId: "cp-class", driver: "claude", kind, role, delivery, jobs: [], env: { PATH: "" } });
	toggle({ claude_research: true });
	assert.equal((await refusal("research", "planner", "local"))?.category, "cli_missing");
	assert.match((await refusal("research", "planner", "pr"))?.why ?? "", /this is research\/planner\/pr$/);
	assert.match((await refusal("ship", "implementer", "pr"))?.why ?? "", /^the switch workers\.native_claude_ship is off \(data\/native\.json claude_ship\)$/);
	toggle({ claude_ship: true });
	assert.equal((await refusal("ship", "implementer", "pr"))?.category, "cli_missing");
	assert.equal((await refusal("ship", "implementer", "local"))?.category, "cli_missing");
	assert.match((await refusal("research", "planner", "answer"))?.why ?? "", /workers\.native_claude_research is off/);
	for (const [kind, role, delivery] of [["ship", "implementer", "answer"], ["research", "implementer", "local"], ["ship", "planner", "pr"]] as const) {
		const refused = await refusal(kind, role, delivery);
		assert.equal(refused?.category, "ineligible", `${kind}/${role}/${delivery}`);
		assert.match(refused?.why ?? "", new RegExp(`this is ${kind}/${role}/${delivery}$`));
	}
	assert.match((await refusal("ship", "gate-reviewer", "pr"))?.why ?? "", /workers\.native_claude_review is off/);
	toggle({ claude_review: true });
	// N4h: claude_review on is a passing selection, a pipeline-owned subject included (its gate never takes sends).
	assert.equal((await refusal("research", "gate-reviewer", "pr"))?.category, "cli_missing");
	mkdirSync(dirname(join(home, paths.pipelineFile("cp-class"))), { recursive: true });
	writeFileSync(join(home, paths.pipelineFile("cp-class")), "{}");
	assert.equal((await refusal("research", "gate-reviewer", "pipeline"))?.category, "cli_missing");
});

test("N4i concurrency: max_concurrent N admits N native jobs, refuses the next by name, and never counts a job's own slot", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-native-slots-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	mkdirSync(dirname(nativeConfigFile(home)), { recursive: true });
	const live = (id: string, phase = "waiting") => ({ job_id: id, phase, worker: { driver: "claude" } }) as unknown as FleetRecord;
	const select = (jobId: string, jobs: FleetRecord[]) =>
		({ home, jobId, driver: "claude" as const, kind: "ship" as const, role: "implementer" as const, delivery: "pr" as const, jobs, env: { PATH: "" } });
	// The default stays 1: one live native job fills the home.
	writeFileSync(nativeConfigFile(home), JSON.stringify({ claude_ship: true }));
	assert.equal(nativeMaxConcurrent(home), 1);
	assert.match((await nativeSelectionRefusal(select("cp-b", [live("cp-a")])))?.why ?? "", /^native concurrency is 1 and cp-a is live/);
	writeFileSync(nativeConfigFile(home), JSON.stringify({ claude_ship: true, max_concurrent: 2 }));
	assert.equal(nativeMaxConcurrent(home), 2);
	// N=2: the second passes every slot gate (it ends at the empty PATH), the third is occupied naming both holders.
	assert.equal((await nativeSelectionRefusal(select("cp-b", [live("cp-a")])))?.category, "cli_missing");
	const third = await nativeSelectionRefusal(select("cp-c", [live("cp-a"), live("cp-b", "held")]));
	assert.deepEqual(third, { category: "occupied", why: "native concurrency is 2 and cp-a, cp-b are live; tear one down first" });
	// A held job's own repair resumes its own slot; an explicit request is refused by name, never moved.
	assert.equal((await nativeSelectionRefusal(select("cp-b", [live("cp-a"), live("cp-b", "held")])))?.category, "cli_missing");
	await assert.rejects(assertNativeSelection(select("cp-c", [live("cp-a"), live("cp-b", "held")])),
		(error: NativeDriverError) => error.category === "occupied" && /^refused: cp-c cannot run on the native claude driver: native concurrency is 2/.test(error.message));
	// Admission reservations and live records count once each; an unreadable file keeps the safe 1.
	assert.equal(nativeSlotRefusal(["cp-a", "cp-a"], "cp-c", 2), undefined);
	assert.equal(nativeSlotRefusal(["cp-a", "cp-b"], "cp-c", 2, "live or being admitted")?.why, "native concurrency is 2 and cp-a, cp-b are live or being admitted; tear one down first");
	writeFileSync(nativeConfigFile(home), "{");
	assert.equal(nativeMaxConcurrent(home), 1);
});

test("N4i ship addendum by delivery: pr pushes and opens the PR, local only commits, research writes its artifact", () => {
	const rows = [["ship", "pr", true], ["ship", "local", false]] as const;
	for (const [kind, delivery, forge] of rows) {
		const text = nativeAddendum(kind, delivery);
		assert.match(text, /report_result once with\s+head_sha = git rev-parse HEAD/, delivery);
		assert.equal(/push only with git_push, open the draft PR with pr_create/.test(text), forge, delivery);
	}
	assert.match(nativeAddendum("ship", "local"), /commit with git in Bash and stop there\. Never call\s+git_push or pr_create/);
	assert.match(nativeAddendum("research", "local"), /Write the research artifact/);
});

test("N4i revive base: the bound PR base wins, then the recorded dispatch base (non-default), then the project base", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cp-native-base-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "native-claude");
	const project = () => "main";
	writeNativeSession(file, { driver: "claude", scratch_dir: "/tmp/cp-claude-native-abc123", cwd: dir, base: "release/2.x" });
	assert.equal(nativeReviveBase("hotfix", file, project), "hotfix");
	assert.equal(nativeReviveBase(undefined, file, project), "release/2.x");
	writeNativeSession(file, { driver: "claude", scratch_dir: "/tmp/cp-claude-native-abc123", cwd: dir });
	assert.equal(nativeReviveBase(undefined, file, project), "main", "a pre-N4i record falls back to the project base");
	assert.equal(nativeReviveBase(undefined, join(dir, "absent"), project), "main");
});

test("N4f follow-ups: the revive prompt names the job's kind, a moved worktree refuses the session resume, the base rides the env", () => {
	assert.match(nativeRevivePrompt("research"), /Continue the research/);
	const ship = nativeRevivePrompt("ship");
	assert.doesNotMatch(ship, /research/);
	assert.match(ship, /Continue the implementation[\s\S]*git_push[\s\S]*report_result once with head_sha\.$/);
	const session = { driver: "claude" as const, scratch_dir: "/tmp/cp-claude-native-x", cwd: "/leases/1/picp" };
	assert.equal(nativeSessionMoved(session, "/leases/1/picp/"), undefined);
	assert.equal(nativeSessionMoved({ ...session, cwd: undefined }, "/leases/2/picp"), undefined, "a pre-N4f record keeps resuming");
	assert.match(nativeSessionMoved(session, "/leases/2/picp") ?? "", /started in \/leases\/1\/picp and the worktree is now \/leases\/2\/picp; .*resume is refused/);
	const decision = { model: "anthropic/claude-x", source: "rubric", rule: "r", driver: "claude", thinking: "high" } as const;
	assert.deepEqual(nativeSpawn(decision, "release"), { driver: "claude", extraEnv: { CP_NATIVE_THINKING: "high", CP_BASE_BRANCH: "release" } });
	assert.deepEqual(nativeSpawn({ ...decision, driver: "pi" }, "release"), {});
	assert.deepEqual(nativeBaseEnv(" "), {});
});

/** pi's own `report_verdict` (the worker-reporter extension, registered for a gate-reviewer) bound to `runDir`. */
function piVerdictTool(runDir: string): (payload: unknown) => Promise<{ text: string; isError: boolean }> {
	const env = { CP_JOB_ID: "cp-rev", CP_KIND: "research", CP_DELIVERY: "pr", CP_RUN_DIR: runDir, CP_ROLE: "gate-reviewer", CP_WORKTREE: runDir };
	const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
	let execute: ((id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>) | undefined;
	Object.assign(process.env, env);
	try {
		workerReporter({ on: () => {}, registerTool: (def: { name: string; execute: typeof execute }) => { if (def.name === "report_verdict") execute = def.execute; } } as never);
	} finally {
		for (const [key, value] of saved) value === undefined ? delete process.env[key] : (process.env[key] = value);
	}
	return async (payload) => {
		try {
			return { text: (await execute!("t", payload)).content.map((part) => part.text).join("\n"), isError: false };
		} catch (error) {
			return { text: (error as Error).message, isError: true };
		}
	};
}

// N4h: the native report_verdict and pi's run one handler, so the same calls give the same answers and files: an over-long
// reason is clamped with the raw payload kept, a wrong job is refused by name, a different second call is refused.
test("N4h report_verdict: native and pi clamp, check, refuse and write the same verdict files", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-native-verdict-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const [piDir, nativeDir] = [join(root, "pi"), join(root, "native")];
	const state = { refusals: [] as string[] };
	const native = verdictReport({ job_id: "cp-rev", kind: "research", delivery: "pr", role: "gate-reviewer", runDir: nativeDir, worktree: nativeDir }, state);
	const pi = piVerdictTool(piDir);
	const flags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
	const calls = [
		{ job_id: "cp-other", verdict: "pass", flags, reasons: ["ok"] },
		{ job_id: "cp-rev", verdict: "pass", flags, reasons: ["x".repeat(450)] },
		{ job_id: "cp-rev", verdict: "pass", flags, reasons: ["x".repeat(450)] },
		{ job_id: "cp-rev", verdict: "revise", flags, reasons: ["changed"], revisions: ["r"] },
	];
	for (const call of calls) {
		const [a, b] = [await pi(call), await native(call)];
		assert.deepEqual(b, { text: a.text.replaceAll(piDir, nativeDir), isError: a.isError }, JSON.stringify(call).slice(0, 80));
	}
	assert.match(state.refusals[0] ?? "", /job_id/, "the wrong job is refused by name");
	assert.match(state.refusals.at(-1) ?? "", /already filed/, "a different second call is refused");
	const read = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
	assert.deepEqual({ ...read(nativeDir, VERDICT_FILE), received_at: 0 }, { ...read(piDir, VERDICT_FILE), received_at: 0 });
	assert.deepEqual(read(nativeDir, VERDICT_RAW_FILE), read(piDir, VERDICT_RAW_FILE));
	assert.equal((await native({ job_id: "cp-rev", verdict: "pass", flags, reasons: ["x".repeat(3_000)] })).isError, true, "pi's lenient bound holds");
});

// N4h: a reviewer goes native only for a `driver: "claude"` row with claude_review on and the slot free; the subject's own
// pi driver never binds it. A fake `claude` on PATH makes the CLI check pass without the binary.
test("N4h reviewer route: off is pi, on is claude, a pi row is pi, a live native worker holds the slot", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-native-review-route-"));
	const path = process.env.PATH;
	t.after(() => { process.env.PATH = path; rmSync(home, { recursive: true, force: true }); });
	mkdirSync(join(home, "bin"));
	writeFileSync(join(home, "bin", "claude"), "#!/bin/sh\necho '2.1.318 (Claude Code)'\n", { mode: 0o755 });
	process.env.PATH = `${join(home, "bin")}${delimiter}${path ?? ""}`;
	mkdirSync(dirname(nativeConfigFile(home)), { recursive: true });
	const config = (row: Record<string, unknown>) =>
		({ schema_version: 1, allow: ["anthropic/*"], rubric: [{ id: "reviews", role: "gate-reviewer", model: "anthropic/claude-x", ...row }] }) as RoutingConfig;
	const profile = { frontmatter: { name: "gate-reviewer", role: "gate-reviewer" } } as never;
	const subject = { job_id: "cp-subj", kind: "ship", delivery: "pr", worker: { role: "implementer" } } as never;
	const route = (row: Record<string, unknown>, live: string[] = []) => resolveReviewerRoute({ profile, jobId: "cp-subj", project: "demo", kind: "research" },
		config(row), ALWAYS_AVAILABLE, undefined, { home, jobId: "cp-subj", record: subject, jobs: [subject], manager: { active: live.map((key) => ({ key, driver: "claude" })) } as never });
	writeFileSync(nativeConfigFile(home), JSON.stringify({ claude_review: false }));
	const off = await route({ driver: "claude" });
	assert.deepEqual([off.driver, off.requested_driver], ["pi", "claude"]);
	assert.match(off.driver_reason ?? "", /^switch: the switch workers\.native_claude_review is off/);
	writeFileSync(nativeConfigFile(home), JSON.stringify({ claude_review: true }));
	assert.equal((await route({ driver: "claude" })).driver, "claude");
	assert.equal((await route({})).driver, undefined, "a row on pi never asks for claude");
	const busy = await route({ driver: "claude" }, ["cp-other"]);
	assert.match(`${busy.driver} ${busy.driver_reason}`, /^pi occupied: native concurrency is 1 and cp-other is live or being admitted/);
	const own = await route({ driver: "claude" }, ["cp-subj"]);
	assert.match(`${own.driver} ${own.driver_reason}`, /^pi occupied: .* cp-subj is live/, "the subject's own native worker holds a slot");
	// Unfixed, a review routed native held nothing until its spawn, so a racing second review also routed native and
	// failed at WorkerManager.spawn; a reserving route now holds the slot until its start settles.
	const reserving = (jobId: string) => resolveReviewerRoute({ profile, jobId, project: "demo", kind: "research" }, config({ driver: "claude" }),
		ALWAYS_AVAILABLE, undefined, { home, jobId, record: subject, jobs: [subject], manager: { active: [] } as never, reserve: true });
	await holdReviewerSlot(home, "cp-a", async () => {
		assert.equal((await reserving("cp-a")).driver, "claude");
		const raced = await reserving("cp-b");
		assert.match(`${raced.driver} ${raced.driver_reason}`, /^pi occupied: .* cp-a\/review is live or being admitted/);
	});
	assert.equal(await holdReviewerSlot(home, "cp-b", async () => (await reserving("cp-b")).driver), "claude", "the settled start released its slot");
});
