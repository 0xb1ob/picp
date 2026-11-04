/**
 * N2 spike acceptance: the real installed `claude` against the loopback fake model, through `runClaudeSpike`.
 * Skipped by name when `claude` is not on PATH (CI has none). Every run's scratch lives in a 0700 temp dir.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { whichAll } from "../../src/doctor.ts";
import { REPORT_TOOL, runClaudeSpike, type SpikeGuard } from "../../src/drivers/claude-spike.ts";
import { type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";

const CLAUDE = whichAll("claude", process.env)[0];
const JOB = "cp-native-spike-e2e";

test("native spike: one research run reports once, refuses bad reports, denies forbidden calls before they run, keeps host env out and records the exit",
	{ skip: CLAUDE === undefined ? "claude is not on PATH" : false, timeout: 180_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "cp-native-spike-e2e-"));
	const PARENT_KEYS = ["TMPDIR", "PATH", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"] as const;
	const saved = Object.fromEntries(PARENT_KEYS.map((key) => [key, process.env[key]]));
	const host = await startClaudeMockProvider([]);
	try {
		const worktree = join(root, "repo");
		const artifactDir = join(root, "artifacts");
		const fakebin = join(root, "bin");
		const hostAuth = join(root, "hosthome", ".pi", "agent", "auth.json");
		const driverTmp = join(root, "driver-tmp");
		for (const dir of [worktree, artifactDir, fakebin, join(root, "hosthome", ".pi", "agent"), driverTmp]) mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(worktree, "README.md"), "spike repo readme\n");
		writeFileSync(hostAuth, "HOST-AUTH-SENTINEL\n");
		writeFileSync(join(fakebin, "gh"), `#!/bin/sh\necho "$@" > ${join(root, "gh-called")}\n`);
		chmodSync(join(fakebin, "gh"), 0o755);
		const artifactPath = join(artifactDir, "report.md");
		const report = (overrides: Record<string, unknown>) => ({
			job_id: JOB, kind: "research", status: "done", summary: "Spike findings filed.", artifact_path: artifactPath,
			plan_summary: { goal: "g", approach: ["a"], acceptance: ["x"], risk: "r", touched: ["t"] }, ...overrides,
		});
		const step = (name: string, input: unknown): ClaudeStep => ({ kind: "tool_use", calls: [{ name, input }] });
		const provider = await startClaudeMockProvider([
			step("Read", { file_path: join(worktree, "README.md") }),
			step("Bash", { command: `cp ${hostAuth} ${join(root, "stolen-auth.json")}` }),
			step("Bash", { command: "gh pr merge 7 --admin" }),
			step("Write", { file_path: join(root, "outside.txt"), content: "escaped\n" }),
			step("Write", { file_path: join(artifactDir, "throw-me.md"), content: "x\n" }),
			step("Write", { file_path: artifactPath, content: "# Findings\n\nok\n" }),
			step("Bash", { command: "printenv ANTHROPIC_API_KEY || echo no-host-api-key; printenv ANTHROPIC_BASE_URL" }),
			step(REPORT_TOOL, report({ job_id: "cp-someone-else" })),
			step(REPORT_TOOL, report({ summary: undefined })),
			step(REPORT_TOOL, report({})),
			step(REPORT_TOOL, report({ summary: "A different report." })),
			step(REPORT_TOOL, report({})),
			{ kind: "text", text: "finished" },
		]);
		// A guard that throws on one path stands in for a broken detector: the call must be denied, not allowed.
		const throwing: SpikeGuard = (call) => {
			if (String(call.input.path).endsWith("throw-me.md")) throw new Error("detector crashed");
			return undefined;
		};
		// (6) sets the host sentinels in the real parent process.env; the driver reads it as its default host env.
		Object.assign(process.env, {
			TMPDIR: driverTmp,
			PATH: `${fakebin}:${saved.PATH ?? ""}`,
			ANTHROPIC_API_KEY: "host-api-key-sentinel",
			ANTHROPIC_BASE_URL: host.url,
			CLAUDE_CONFIG_DIR: join(root, "hosthome", ".claude"),
		});
		const result = await runClaudeSpike({
			job: { job_id: JOB, delivery: "local", runDir: join(root, "run"), worktree, artifactPath },
			prompt: "Research the repo and report.",
			providerEnv: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN },
			extraGuards: [throwing],
			maxTurns: 20,
			timeoutMs: 150_000,
		});
		await provider.close();
		const results = toolResults(provider.requests);

		// (1) accepted once; the identical re-report is a no-op. (2) wrong-job, invalid and conflicting are refused.
		assert.equal(result.report?.job_id, JOB);
		assert.equal(result.report?.summary, "Spike findings filed.");
		assert.equal(result.reportRefusals.length, 3, result.reportRefusals.join("\n"));
		assert.match(result.reportRefusals[0] ?? "", /job_id: must be "cp-native-spike-e2e"/);
		assert.match(result.reportRefusals[1] ?? "", /summary/);
		assert.match(result.reportRefusals[2] ?? "", /already filed/);
		assert.ok(results.some((text) => /Already recorded \(no-op\)/.test(text)), results.join("\n---\n"));
		const filed = JSON.parse(readFileSync(join(root, "run", "envelope.json"), "utf8")) as { envelope: { summary: string } };
		assert.equal(filed.envelope.summary, "Spike findings filed.");

		// (3) credential copy, merge and out-of-scope write were denied before they ran.
		assert.equal(existsSync(join(root, "stolen-auth.json")), false);
		assert.equal(readFileSync(hostAuth, "utf8"), "HOST-AUTH-SENTINEL\n");
		assert.equal(existsSync(join(root, "gh-called")), false);
		assert.equal(existsSync(join(root, "outside.txt")), false);
		const reasons = result.denials.map((denial) => `${denial.tool}: ${denial.reason}`);
		assert.equal(reasons.length, 4, reasons.join("\n"));
		assert.match(reasons[0] ?? "", /^Bash: [\s\S]*auth/i);
		assert.match(reasons[1] ?? "", /^Bash: Refused: a worker never merges/);
		assert.match(reasons[2] ?? "", /^Write: [\s\S]*artifact directory/);
		// (5) the throwing guard denied, and its write never happened.
		assert.match(reasons[3] ?? "", /^Write: [\s\S]*a guard failed \(detector crashed\)/);
		assert.equal(existsSync(join(artifactDir, "throw-me.md")), false);

		// (4) the repo read and the artifact write succeeded.
		assert.ok(results.some((text) => text.includes("spike repo readme")), results.join("\n---\n"));
		assert.equal(readFileSync(artifactPath, "utf8"), "# Findings\n\nok\n");

		// (6) no host ANTHROPIC_* reached the child: its env, the host endpoint and every request's credentials.
		assert.ok(results.some((text) => text.includes(`no-host-api-key\n${provider.url}`)), results.join("\n---\n"));
		assert.equal(host.requests.length, 0);
		assert.ok(provider.requests.length > 0);
		for (const request of provider.requests) {
			assert.equal(request.apiKey, undefined);
			assert.equal(request.authorization, `Bearer ${FAKE_CLAUDE_AUTH_TOKEN}`);
		}

		// (7) the observed exit of the installed claude, never a bundled binary; the scratch dir is gone.
		assert.equal(result.spawnedCommand, result.claudePath);
		assert.equal(result.claudePath, CLAUDE);
		assert.deepEqual(result.exit, { code: 0, signal: null, killedByDriver: false });
		assert.equal(result.resultSubtype, "success");
		assert.equal(result.usage.usageStatus, "complete");
		assert.deepEqual(readdirSync(driverTmp), []);
		assert.equal(provider.overrun(), 0);
	} finally {
		for (const key of PARENT_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		await host.close();
		rmSync(root, { recursive: true, force: true });
	}
});
