/**
 * N3a step-2 gates: the real installed `claude` against the loopback fake model, through `runClaudeSpike`. G1 shell
 * write scope, G2 resume and interrupt, G3 loaded-surface lockdown with synthetic config only. Skipped without `claude`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { whichAll } from "../../src/doctor.ts";
import { runClaudeSpike, type SpikeRunOptions } from "../../src/drivers/claude-spike.ts";
import { type ClaudeMockProvider, type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";

const skip = whichAll("claude", process.env)[0] === undefined ? "claude is not on PATH" : false;
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
			job: { job_id: JOB, delivery: "local", runDir: join(root, "run"), worktree, artifactPath },
			prompt: "Research the repo.",
			providerEnv: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN },
			userSettings: null,
			maxTurns: 20,
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
		assert.deepEqual(readdirSync(worktree), ["README.md"]);
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
		// L2: init shows only picp's surface and the CLI's built-ins; no skill, agent, command or CLAUDE.md reached the model.
		assert.equal(result.lockdown?.verdict, "ok", result.lockdown?.refusal);
		assert.ok(Object.values(result.lockdown?.extra ?? { missing: 1 }).every((count) => count === 0), JSON.stringify(result.lockdown));
		assert.equal(result.lockdown?.seen?.hooks, 0);
		const bodies = provider.requests.map((request) => JSON.stringify(request.body)).join("\n");
		for (const marker of ["MARKER-SKILL", "MARKER-AGENT", "MARKER-CMD", "MARKER-CLAUDEMD"]) assert.equal(bodies.includes(marker), false, marker);
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
