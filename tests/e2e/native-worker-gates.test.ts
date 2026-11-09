/**
 * N3a step-2 gates: the real installed `claude` against the loopback fake model, through `runClaudeSpike`. G1 shell
 * write scope, G2 resume and interrupt, G3 loaded-surface lockdown, R1 env and secret paths; synthetic config only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { whichAll } from "../../src/doctor.ts";
import { buildChildEnv, REPORT_TOOL, runClaudeSpike, SPIKE_TOOLS, type SpikeRunOptions } from "../../src/drivers/claude-spike.ts";
import { CLI_BUILTIN_AGENTS } from "../../src/drivers/claude-lockdown.ts";
import { commitIdentityEnv } from "../../src/drivers/claude-forge-tools.ts";
import { roleMcpTools, roleTools } from "../../src/drivers/claude-roles.ts";
import { nativeDenials } from "../../src/drivers/claude-usage.ts";
import { type ClaudeMockProvider, type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";
import { createScratchRepo } from "../harness/scratch-repo.ts";

const claudePath = whichAll("claude", process.env)[0];
const skip = claudePath === undefined ? "claude is not on PATH" : false;

const JOB = "cp-native-gates-e2e";
const step = (name: string, input: unknown): ClaudeStep => ({ kind: "tool_use", calls: [{ name, input }] });
const bash = (command: string) => step("Bash", { command });

interface Fixture {
	root: string;
	worktree: string;
	artifactPath: string;
	run: (provider: ClaudeMockProvider, extra?: Partial<SpikeRunOptions>) => ReturnType<typeof runClaudeSpike>;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "cp-native-gates-"));
	try {
		const worktree = join(root, "repo");
		const artifactPath = join(root, "artifacts", "report.md");
		mkdirSync(worktree, { recursive: true, mode: 0o700 });
		mkdirSync(join(root, "artifacts"), { mode: 0o700 });
		writeFileSync(join(worktree, "README.md"), "gates repo readme\n");
		const run = (provider: ClaudeMockProvider, extra: Partial<SpikeRunOptions> = {}) => runClaudeSpike({
			job: { job_id: JOB, kind: "research", role: "planner", delivery: "local", runDir: join(root, "run"), worktree, artifactPath },
			prompt: "Research the repo.",
			providerEnv: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN },
			userSettings: null,
			maxTurns: 40,
			timeoutMs: 150_000,
			...extra,
		});
		await body({ root, worktree, artifactPath, run });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("G1: a research run's Bash cannot write the worktree or anywhere else; named read-only commands still run", { skip, timeout: 180_000 }, async () => {
	await withFixture(async ({ root, worktree, run }) => {
		// A real repo, so the git `--output` shapes (controls n and o) would write into it if they ran.
		execFileSync("git", ["init", "-q", worktree]);
		const writes = [
			`echo x > ${worktree}/redirect.txt`,
			`echo x >> ${worktree}/append.txt`,
			`echo x | tee ${worktree}/tee.txt`,
			`cp ${worktree}/README.md ${worktree}/cp.txt`,
			`mv ${worktree}/README.md ${worktree}/moved.md`,
			`ln -s ${worktree}/README.md ${worktree}/link.md`,
			`sed -i s/gates/owned/ ${worktree}/README.md`,
			`touch ${root}/outside.txt`,
			`git -C ${worktree} init`,
			`cat $(touch ${worktree}/subst.txt)`,
			`find ${worktree} -name README.md -exec touch ${worktree}/find.txt ;`,
			`sort -o ${worktree}/sort.txt ${worktree}/README.md`,
			`rg --pre "touch ${worktree}/pre.txt" gates ${worktree}`,
			`FOO=1 cat ${worktree}/README.md`,
			`(touch ${worktree}/subshell.txt)`,
			`python3 -c "open('${worktree}/py.txt','w')"`,
			`find ${worktree} \${U:--delete}`,
			`find ${worktree} $'-\\x64elete'`,
			`find ${worktree} {-delete,}`,
			`git log \${U:---output=${worktree}/f}`,
			`sort -S 1 --compress-program=sh ${worktree}/README.md`,
			`git grep --no-index -nOrm gates`,
			`file -C -m /dev/null`,
			`git log --pretty --output=${worktree}/pretty.txt`,
			`git show --format --output=${worktree}/format.txt`,
			`git diff -U --output=${worktree}/diff.txt`,
		];
		const provider = await startClaudeMockProvider([
			...writes.map(bash),
			bash(`cat ${worktree}/README.md | wc -l && ls ${worktree} 2>/dev/null`),
			{ kind: "text", text: "done" },
		]);
		const result = await run(provider);
		await provider.close();
		assert.equal(result.lockdown?.verdict, "ok", result.error);
		// Every write shape was denied before it ran: the worktree and its parent hold only what the test made.
		assert.deepEqual(readdirSync(worktree).sort(), [".git", "README.md"]);
		assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "gates repo readme\n");
		assert.deepEqual(readdirSync(root).sort(), ["artifacts", "repo"]);
		assert.equal(result.denials.length, writes.length, result.denials.map((denial) => denial.reason).join("\n"));
		for (const denial of result.denials) assert.match(`${denial.tool}: ${denial.reason}`, /^Bash: Refused: a research worker's Bash runs only read-only/);
		assert.ok(toolResults(provider.requests).some((text) => /^1\nREADME\.md/.test(text)), toolResults(provider.requests).join("\n---\n"));
	});
});

test("G3: synthetic settings and worktree .claude config never load; a surface picp did not pass refuses before any tool", { skip, timeout: 180_000 }, async (t) => {
	await withFixture(async ({ root, worktree, artifactPath, run }) => {
		const sentinel = (tag: string) => ({ hooks: [{ type: "command", command: `touch ${join(root, `sentinel-${tag}`)}` }] });
		const hooks = (tag: string) => ({
			PreToolUse: [{ matcher: "*", ...sentinel(`${tag}-pre`) }],
			SessionStart: [sentinel(`${tag}-start`)],
			UserPromptSubmit: [sentinel(`${tag}-prompt`)],
			Stop: [sentinel(`${tag}-stop`)],
		});
		const claudeDir = join(worktree, ".claude");
		for (const dir of ["skills/x", "agents", "commands"]) mkdirSync(join(claudeDir, dir), { recursive: true });
		writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks: hooks("project") }));
		writeFileSync(join(claudeDir, "skills/x/SKILL.md"), "---\nname: x\ndescription: MARKER-SKILL\n---\nMARKER-SKILL\n");
		writeFileSync(join(claudeDir, "agents/y.md"), "---\nname: y\ndescription: MARKER-AGENT\n---\nMARKER-AGENT\n");
		writeFileSync(join(claudeDir, "commands/z.md"), "---\ndescription: MARKER-CMD\n---\nMARKER-CMD\n");
		writeFileSync(join(worktree, "CLAUDE.md"), "MARKER-CLAUDEMD\n");
		const settings = join(root, "settings.json");
		writeFileSync(settings, JSON.stringify({
			hooks: hooks("settings"),
			enabledPlugins: { "synthetic-plugin@synthetic-market": true },
			permissions: { allow: ["Bash(*)", "Write(*)", "Edit(*)"] },
			env: { PICP_SYNTHETIC_ENV: "1" },
		}));
		const provider = await startClaudeMockProvider([
			step("Write", { file_path: join(worktree, "widened.txt"), content: "x\n" }),
			bash(`echo x > ${worktree}/widened-bash.txt`),
			step("Write", { file_path: artifactPath, content: "# ok\n" }),
			{ kind: "text", text: "done" },
		]);
		const result = await run(provider, { userSettings: settings });
		await provider.close();
		t.diagnostic(`lockdown: ${JSON.stringify({ seen: result.lockdown?.seen, checkMs: result.lockdown?.checkMs, coldStartMs: result.coldStartMs })}`);

		// L1: no settings-file or project hook ran, SessionStart included.
		assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("sentinel-")), []);
		// L2: init shows only picp's surface and the CLI's built-ins; no skill, agent, command or CLAUDE.md is sent.
		assert.equal(result.lockdown?.verdict, "ok", result.lockdown?.refusal);
		assert.ok(Object.values(result.lockdown?.extra ?? { missing: 1 }).every((count) => count === 0), JSON.stringify(result.lockdown));
		assert.equal(result.lockdown?.seen?.hooks, 0);
		const bodies = provider.requests.map((request) => JSON.stringify(request.body)).join("\n");
		for (const marker of ["MARKER-SKILL", "MARKER-AGENT", "MARKER-CMD", "MARKER-CLAUDEMD"]) assert.equal(bodies.includes(marker), false, marker);
		// R2: the model is offered picp's tools only (plus the CLI's never-called deferred-loading placeholder), and no
		// built-in skill or agent listing reaches its prompt: those exist in init only, with no Skill, Agent or Task tool.
		const first = provider.requests.find((request) => request.path.startsWith("/v1/messages"))?.body as { tools?: Array<{ name: string }>; system?: unknown; messages?: unknown };
		assert.deepEqual(first.tools?.map((tool) => tool.name).filter((name) => name !== "DeferredToolPlaceholder").sort(), [...SPIKE_TOOLS, REPORT_TOOL].sort());
		const prompt = JSON.stringify({ system: first.system, messages: first.messages });
		assert.equal(/skill/i.test(prompt), false);
		for (const agent of Object.keys(CLI_BUILTIN_AGENTS).filter((name) => name !== "claude")) assert.equal(new RegExp(`\\b${agent}\\b`).test(prompt), false, agent);
		// L3: the permissions.allow widening let no denied action through; the in-scope write still ran.
		assert.deepEqual(result.denials.map((denial) => denial.tool), ["Write", "Bash"]);
		assert.deepEqual(readdirSync(worktree).sort(), [".claude", "CLAUDE.md", "README.md"]);
		assert.equal(readFileSync(artifactPath, "utf8"), "# ok\n");

		// L2 refusal: a settings file that changes the output style is refused before its first tool runs.
		const styled = join(root, "styled.json");
		writeFileSync(styled, JSON.stringify({ outputStyle: "Explanatory" }));
		rmSync(artifactPath);
		const refusedProvider = await startClaudeMockProvider([step("Write", { file_path: artifactPath, content: "# no\n" }), { kind: "text", text: "done" }]);
		const refused = await run(refusedProvider, { userSettings: styled });
		await refusedProvider.close();
		assert.equal(refused.lockdown?.verdict, "refused");
		assert.equal(refused.lockdown?.extra?.outputStyle, 1);
		assert.match(refused.error ?? "", /^Refused: the Claude CLI lockdown failed: it loaded a surface picp did not pass \(outputStyle 1\)/);
		assert.equal(readdirSync(join(root, "artifacts")).length, 0);
		assert.deepEqual(toolResults(refusedProvider.requests).filter((text) => !text.startsWith("[error]")), []);
		assert.notEqual(refused.exit, undefined);
	});
});

test("G2: a resumed session's usage is counted once across both runs; an interrupt stops the turn before its tool runs", { skip, timeout: 180_000 }, async (t) => {
	await withFixture(async ({ root, worktree, artifactPath, run }) => {
		const scratchDir = join(root, "..", `${root.split("/").pop()}-session`);
		mkdirSync(scratchDir, { mode: 0o700 });
		try {
			const provider = await startClaudeMockProvider([
				step("Read", { file_path: join(worktree, "README.md") }), { kind: "text", text: "first" },
				step("Read", { file_path: join(worktree, "README.md") }), { kind: "text", text: "second" },
			]);
			const first = await run(provider, { scratchDir });
			const resumed = await run(provider, { scratchDir, resume: { sessionId: first.sessionId ?? "", ...(first.ledger ? { ledger: first.ledger } : {}) } });
			await provider.close();
			assert.equal(resumed.sessionId, first.sessionId);
			assert.equal(resumed.resultSubtype, "success");
			// The fake answers every model request with 12 in / 7 out; the two runs' normalized usage must sum to that.
			const calls = provider.requests.filter((request) => request.path.split("?")[0] === "/v1/messages").length;
			const counted = [first.usage, resumed.usage].map((usage) => ({
				input: (usage.inputTokens ?? Number.NaN) + (usage.otherUsage?.inputTokens ?? 0),
				output: (usage.outputTokens ?? Number.NaN) + (usage.otherUsage?.outputTokens ?? 0),
			}));
			t.diagnostic(`resume usage per run: ${JSON.stringify(counted)} over ${calls} model calls`);
			assert.deepEqual({ input: (counted[0]?.input ?? 0) + (counted[1]?.input ?? 0), output: (counted[0]?.output ?? 0) + (counted[1]?.output ?? 0) }, { input: calls * 12, output: calls * 7 });
		} finally {
			rmSync(scratchDir, { recursive: true, force: true });
		}

		const interrupt = new AbortController();
		let interruptedAt = 0;
		const provider = await startClaudeMockProvider([{
			kind: "tool_use",
			calls: [{ name: "Write", input: { file_path: artifactPath, content: "# after interrupt\n" } }],
			beforeAnswer: async () => {
				interruptedAt = Date.now();
				interrupt.abort();
				await sleep(500);
			},
		}, { kind: "text", text: "done" }]);
		const result = await run(provider, { signal: interrupt.signal });
		const exitMs = Date.now() - interruptedAt;
		const requestsAtExit = provider.requests.length;
		await sleep(300);
		await provider.close();
		t.diagnostic(`interrupt: exit ${JSON.stringify(result.exit)} after ${exitMs} ms`);
		assert.ok(interruptedAt > 0);
		assert.notEqual(result.exit, undefined);
		assert.equal(result.exit?.killedByDriver, false);
		assert.equal(readdirSync(join(root, "artifacts")).length, 0);
		assert.deepEqual(result.denials, []);
		assert.equal(provider.requests.length, requestsAtExit);
	});
});

test("N4m: a resumed follow-up in the kept scratch sees the first run's surface, not the settings' enabled plugin", { skip, timeout: 240_000 }, async (t) => {
	await withFixture(async ({ root, run }) => {
		// The operator's HOME: a git marketplace holding one plugin with one skill, enabled in the settings file.
		const home = join(root, "operator-home");
		const market = join(home, "market");
		for (const dir of [".claude-plugin", "plugins/demo/.claude-plugin", "plugins/demo/skills/hello"]) mkdirSync(join(market, dir), { recursive: true });
		writeFileSync(join(market, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "seeded", owner: { name: "op" }, plugins: [{ name: "demo", source: "./plugins/demo", description: "d" }] }));
		writeFileSync(join(market, "plugins/demo/.claude-plugin/plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0", description: "d" }));
		writeFileSync(join(market, "plugins/demo/skills/hello/SKILL.md"), "---\nname: hello\ndescription: MARKER-PLUGIN-SKILL\n---\nhi\n");
		const git = (...args: string[]) => execFileSync("git", ["-C", market, "-c", "user.name=op", "-c", "user.email=op@example.invalid", ...args]);
		execFileSync("git", ["init", "-q", market]);
		git("add", "-A");
		git("commit", "-qm", "seed");
		const settings = join(home, ".claude", "settings.json");
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(settings, JSON.stringify({ enabledPlugins: { "demo@seeded": true }, extraKnownMarketplaces: { seeded: { source: { source: "git", url: `file://${market}` } } } }));
		const scratchDir = join(root, "..", `${root.split("/").pop()}-n4m`);
		mkdirSync(scratchDir, { mode: 0o700 });
		try {
			// Each turn stays up a few seconds, long enough for the CLI's background plugin reconcile to finish.
			const slow = (text: string): ClaudeStep => ({ kind: "text", text, beforeAnswer: () => sleep(4_000) });
			const provider = await startClaudeMockProvider([slow("first"), slow("second"), slow("third")]);
			const first = await run(provider, { scratchDir, userSettings: settings });
			const runs = [first];
			// Unfixed, the reconcile clones the marketplace in run 1, installs the plugin in run 2, and run 3 loads it.
			for (let i = 0; i < 2; i++) runs.push(await run(provider, { scratchDir, userSettings: settings, resume: { sessionId: first.sessionId ?? "" } }));
			await provider.close();
			t.diagnostic(`seen: ${JSON.stringify(runs.map((result) => result.lockdown?.seen))}`);
			for (const result of runs) assert.equal(result.lockdown?.verdict, "ok", result.lockdown?.refusal ?? result.error);
			assert.deepEqual(runs.map((result) => result.lockdown?.seen), runs.map(() => first.lockdown?.seen));
			assert.deepEqual(runs.map((result) => result.sessionId), runs.map(() => first.sessionId), "the follow-ups did not resume");
			assert.equal(provider.requests.some((request) => JSON.stringify(request.body).includes("MARKER-PLUGIN-SKILL")), false);
			const plugins = join(scratchDir, "config", "plugins");
			assert.deepEqual((existsSync(plugins) ? readdirSync(plugins) : []).filter((name) => ["cache", "marketplaces"].includes(name)), []);
		} finally {
			rmSync(scratchDir, { recursive: true, force: true });
		}
	});
});

test("R1: Bash and Read never reach the settings env, /proc environ or the settings file; no secret reaches the model", { skip, timeout: 180_000 }, async (t) => {
	await withFixture(async ({ root, worktree, run }) => {
		const secret = `sentinel-${randomBytes(12).toString("hex")}`;
		const token = `synthetic-${randomBytes(12).toString("hex")}`;
		const settings = join(root, "settings.json");
		writeFileSync(settings, JSON.stringify({ env: { CP_SENTINEL_SECRET: secret, ANTHROPIC_AUTH_TOKEN: token } }));
		// A planted link only a shell glob reaches: `cat <worktree>/*` would print the settings file through it.
		symlinkSync(settings, join(worktree, "notes"));
		const probes = [
			bash("printenv"),
			bash("env"),
			bash("echo $ANTHROPIC_AUTH_TOKEN"),
			bash("echo ${CP_SENTINEL_SECRET}"),
			bash("cat /proc/self/environ"),
			bash("grep -a SECRET /proc/self/environ"),
			step("Read", { file_path: settings }),
			bash(`cat ${settings}`),
			bash(`cat ${worktree}/*`),
		];
		const provider = await startClaudeMockProvider([...probes, { kind: "text", text: "done" }]);
		const result = await run(provider, { userSettings: settings });
		await provider.close();
		const bodies = provider.requests.map((request) => JSON.stringify(request.body)).join("\n");
		assert.equal(bodies.includes(secret) || bodies.includes(token), false, "a settings env value reached the model");
		assert.equal(result.lockdown?.verdict, "ok", result.error);
		assert.deepEqual(result.denials.map((denial) => denial.tool), ["Bash", "Bash", "Bash", "Bash", "Bash", "Bash", "Read", "Bash", "Bash"]);

		// The CLI scrub alone, no picp guard: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 keeps the provider token out of Bash.
		// It needs the OS sandbox (bwrap + socat); without socat every Bash call fails closed, so nothing prints either way.
		const scrubProvider = await startClaudeMockProvider([bash("printenv; echo T=$ANTHROPIC_AUTH_TOKEN"), { kind: "text", text: "done" }]);
		const dirs = { home: join(root, "scrub-home"), configDir: join(root, "scrub-config"), tmp: join(root, "scrub-tmp") };
		for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
		const env = { ...buildChildEnv(dirs, process.env, { ANTHROPIC_BASE_URL: scrubProvider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN }), CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" };
		const options = { cwd: worktree, env, settingSources: [], settings, managedSettings: { disableAllHooks: true }, strictMcpConfig: true, tools: ["Bash"], allowedTools: ["Bash"], maxTurns: 3 };
		for await (const message of query({ prompt: "go", options: { ...options, pathToClaudeCodeExecutable: claudePath ?? "claude", permissionMode: "dontAsk" } })) void message;
		await scrubProvider.close();
		const scrubbed = toolResults(scrubProvider.requests).join("\n");
		t.diagnostic(`scrub: ${/socat/.test(scrubbed) ? "Bash failed closed (sandbox needs socat)" : "Bash ran scrubbed"}; sentinel ${scrubbed.includes(secret) ? "visible" : "absent"}`);
		assert.ok(scrubProvider.requests.length > 1, "the scrubbed run never answered the tool call");
		assert.equal(scrubbed.includes(token), false);
	});
});

// N4b: the report tool's context is the job's own kind and role, not a research/planner literal.
test("N4b: a report is checked against the SpikeJob's kind and role", { skip, timeout: 180_000 }, async () => {
	await withFixture(async ({ root, worktree, artifactPath }) => {
		const provider = await startClaudeMockProvider([
			step(REPORT_TOOL, { job_id: JOB, kind: "research", status: "done", summary: "Done.", artifact_path: artifactPath }),
			{ kind: "text", text: "done" },
		]);
		const result = await runClaudeSpike({
			job: { job_id: JOB, kind: "ship", role: "implementer", delivery: "local", runDir: join(root, "run"), worktree, artifactPath, excludePaths: [] },
			prompt: "Report.",
			providerEnv: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN },
			userSettings: null,
			maxTurns: 5,
			timeoutMs: 150_000,
		});
		await provider.close();
		assert.equal(result.report, undefined);
		assert.match(result.reportRefusals.join("\n"), /kind: must be "ship" for this job, got "research"/);
	});
});

// N4c: an implementer run gets the implementer tool set and its guards; only the in-worktree Edit lands.
test("N4c: an implementer's Edit inside the worktree lands; a Write outside is denied by name; the lockdown holds", { skip, timeout: 180_000 }, async () => {
	await withFixture(async ({ root, worktree, artifactPath }) => {
		const file = join(worktree, "src", "x.ts");
		mkdirSync(join(worktree, "src"));
		writeFileSync(file, "export const x = 1;\n");
		const outside = join(root, "outside.txt");
		const provider = await startClaudeMockProvider([
			step("Read", { file_path: file }),
			step("Edit", { file_path: file, old_string: "x = 1", new_string: "x = 2" }),
			step("Write", { file_path: outside, content: "escaped\n" }),
			{ kind: "text", text: "done" },
		]);
		const result = await runClaudeSpike({
			job: { job_id: JOB, kind: "ship", role: "implementer", delivery: "pr", runDir: join(root, "run"), worktree, artifactPath, excludePaths: [".github/workflows/"] },
			prompt: "Edit src/x.ts.",
			providerEnv: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN },
			userSettings: null,
			maxTurns: 10,
			timeoutMs: 150_000,
		});
		await provider.close();
		assert.equal(result.lockdown?.verdict, "ok", result.lockdown?.refusal ?? result.error);
		const first = provider.requests.find((request) => request.path.startsWith("/v1/messages"))?.body as { tools?: Array<{ name: string }> };
		const offered = first.tools?.map((tool) => tool.name).filter((name) => name !== "DeferredToolPlaceholder").sort();
		assert.deepEqual(offered, [...roleTools("implementer"), REPORT_TOOL, ...roleMcpTools("implementer")].sort());
		assert.equal(readFileSync(file, "utf8"), "export const x = 2;\n");
		assert.deepEqual(readdirSync(root).sort(), ["artifacts", "repo"]);
		assert.deepEqual(nativeDenials(result.denials), ["Write: Refused: an implementer edits only inside its worktree <path>, outside .git, and inside its own artifact directory <path>; a path outside the worktree (<path>) is denied."]);
	});
});

// N4d: the implementer ships through the forge tools in this process; the CLI child gets the commit identity, no token.
test("N4d: an implementer commits, git_push lands origin/<job> at HEAD, pr_create opens the draft; no token in the CLI env", { skip, timeout: 180_000 }, async () => {
	const repo = createScratchRepo({ name: "forge-e2e" });
	const root = mkdtempSync(join(tmpdir(), "cp-native-forge-"));
	try {
		const bin = join(root, "bin");
		mkdirSync(bin);
		copyFileSync(join(import.meta.dirname, "..", "fixtures", "forge-gh"), join(bin, "gh"));
		chmodSync(join(bin, "gh"), 0o755);
		const log = join(root, "gh.log");
		repo.git("checkout", "-q", "-b", JOB);
		repo.write("src/x.ts", "export const x = 1;\n");
		repo.commitAll("x");
		// Only the global config names the committer, and the child's scratch HOME has none: the identity env must carry it.
		for (const key of ["user.name", "user.email"]) repo.git("config", "--unset", key);
		writeFileSync(join(root, "gitconfig"), "[user]\n\tname = forge e2e\n\temail = forge@test.invalid\n");
		const identity = commitIdentityEnv(repo.path, { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig") });
		const token = `ghp_${randomBytes(18).toString("hex")}`;
		const prUrl = "https://github.com/picp-e2e/forge/pull/7";
		const head = () => repo.git("rev-parse", "HEAD");
		const provider = await startClaudeMockProvider([
			step("Edit", { file_path: join(repo.path, "src", "x.ts"), old_string: "x = 1", new_string: "x = 2" }),
			bash("git add -A && git commit -q -m x2"),
			step("mcp__picp__git_push", {}),
			step("mcp__picp__pr_create", { title: "x = 2", body: "Native forge e2e." }),
			{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => ({ job_id: JOB, kind: "ship", status: "done", summary: "Shipped.", branch: JOB, head_sha: head(), pr_url: prUrl }) }] },
			{ kind: "text", text: "done" },
		]);
		const result = await runClaudeSpike({
			job: { job_id: JOB, kind: "ship", role: "implementer", delivery: "pr", runDir: join(root, "run"), worktree: repo.path, artifactPath: join(root, "art", "report.md"), excludePaths: [] },
			prompt: "Ship src/x.ts.",
			providerEnv: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN, ...identity },
			hostEnv: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FORGE_GH_LOG: log, GH_TOKEN: token, GITHUB_TOKEN: token, CP_BASE_BRANCH: "main" },
			userSettings: null,
			maxTurns: 12,
			timeoutMs: 150_000,
		});
		await provider.close();
		assert.equal(result.lockdown?.verdict, "ok", result.lockdown?.refusal ?? result.error);
		const first = provider.requests.find((request) => request.path.startsWith("/v1/messages"))?.body as { tools?: Array<{ name: string }> };
		const offered = first.tools?.map((tool) => tool.name).filter((name) => name !== "DeferredToolPlaceholder").sort();
		assert.deepEqual(offered, [...roleTools("implementer"), REPORT_TOOL, ...roleMcpTools("implementer")].sort());
		assert.deepEqual(result.denials, []);
		assert.equal(repo.git("log", "-1", "--format=%an <%ae>"), "forge e2e <forge@test.invalid>");
		assert.equal(repo.git("ls-remote", "origin", `refs/heads/${JOB}`).split("\t")[0], head());
		assert.equal(result.report?.head_sha, head(), result.reportRefusals.join("\n"));
		assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`pr create --draft --head ${JOB} --base main --title x = 2 --body Native forge e2e.`]);
		assert.ok(toolResults(provider.requests).some((text) => text === `Draft PR for ${JOB}: ${prUrl}`), toolResults(provider.requests).join("\n---\n"));
		for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) assert.equal(result.spawnedEnvKeys?.includes(key), false, key);
		assert.ok(result.spawnedEnvKeys?.includes("GIT_AUTHOR_NAME"));
		assert.equal(provider.requests.some((request) => JSON.stringify(request.body).includes(token)), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		repo.cleanup();
	}
});
