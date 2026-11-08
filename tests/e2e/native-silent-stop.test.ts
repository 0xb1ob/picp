/**
 * Native workers that ended turns unreported: a woken turn's tools denied with Claude Code's "wait for the user" text,
 * permission-layer refusals without picp's words, and no Stop hook. The installed `claude` against the loopback fake.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { whichAll } from "../../src/doctor.ts";
import { REPORT_TOOL, runClaudeSpike, STOP_REPORT_REASON, type SpikeJob } from "../../src/drivers/claude-spike.ts";
import { type ClaudeMockProvider, type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, type RecordedClaudeRequest, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";

const skip = whichAll("claude", process.env)[0] === undefined ? "claude is not on PATH" : false;
const JOB = "cp-native-silent-stop-e2e";
const step = (name: string, input: unknown): ClaudeStep => ({ kind: "tool_use", calls: [{ name, input }] });
const WAIT_FOR_USER = /doesn't want to take this action/;
const BLOCKER = { question: "Stop here?", why: "The scenario ends.", options: ["stop"], recommended: "stop", assume_if_unanswered: "stop" };
const blocked = (kind: "ship" | "research") => ({ job_id: JOB, kind, status: "blocked", summary: "Stopped on purpose.", blockers: [kind === "ship" ? "the scenario ends here" : BLOCKER] });
const blockedAsks = (provider: ClaudeMockProvider) =>
	provider.requests.filter((request) => JSON.stringify(request.body.messages ?? "").includes(JSON.stringify(STOP_REPORT_REASON).slice(1, -1))).length;

async function inRepo(body: (root: string, worktree: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "cp-native-silent-stop-"));
	try {
		const worktree = join(root, "repo");
		mkdirSync(join(worktree, ".scratch"), { recursive: true });
		execFileSync("git", ["init", "-q", worktree]);
		writeFileSync(join(worktree, ".gitignore"), ".scratch/\n");
		await body(root, worktree);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function run(root: string, worktree: string, provider: ClaudeMockProvider, kind: "ship" | "research") {
	const job: SpikeJob = kind === "ship"
		? { job_id: JOB, kind, role: "implementer", delivery: "pr", runDir: join(root, "run"), worktree, excludePaths: [] }
		: { job_id: JOB, kind, role: "planner", delivery: "local", runDir: join(root, "run"), worktree, artifactPath: join(root, "artifacts", "report.md") };
	return runClaudeSpike({
		job, prompt: "Do the task, then report.", userSettings: null, maxTurns: 20, timeoutMs: 120_000,
		providerEnv: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN },
	});
}

/** The task-output file the CLI named in the background Bash call's result. */
const taskOutput = (request: RecordedClaudeRequest): string =>
	/Output is being written to: (\S+\.output)/.exec(JSON.stringify(request.body.messages))?.[1] ?? "no-task-output-named";

// Scenario: an implementer reads its own scratch and task output after a background task wakes it
//   Given an implementer that started a background loop and ended its turn to wait
//   When the loop finishes and wakes it, and it reads gitignored .scratch and the Claude task-output file
//   Then every Read/Grep/Glob succeeds, no "wait for the user" denial lands, and its report is accepted
test("woken turn: Read/Grep/Glob of the worktree scratch and the task output succeed, and the worker reports", { skip, timeout: 180_000 }, async () => {
	await inRepo(async (root, worktree) => {
		writeFileSync(join(worktree, "loop.js"), "setTimeout(() => { require('fs').writeFileSync('.scratch/loop.log', 'loop finished\\n'); console.log('bg done'); }, 3000);\n");
		const provider = await startClaudeMockProvider([
			step("Bash", { command: "node loop.js", run_in_background: true }),
			{ kind: "text", text: "Waiting for the background loop; it will wake me." },
			step("Read", { file_path: join(worktree, ".scratch", "loop.log") }),
			step("Grep", { pattern: "bg done", path: taskOutput, output_mode: "content" }),
			step("Glob", { pattern: ".scratch/*.log" }),
			step(REPORT_TOOL, blocked("ship")),
			{ kind: "text", text: "Reported." },
		]);
		const result = await run(root, worktree, provider, "ship");
		await provider.close();
		const results = toolResults(provider.requests);
		assert.equal(results.filter((text) => WAIT_FOR_USER.test(text)).length, 0, results.join("\n---\n"));
		assert.match(results[1] ?? "", /loop finished/);
		assert.match(results[2] ?? "", /bg done/);
		assert.match(results[3] ?? "", /loop\.log/);
		assert.deepEqual(result.denials, []);
		assert.equal(result.report?.status, "blocked");
		assert.equal(blockedAsks(provider), 0, "a stop while the loop ran was blocked");
		assert.equal(provider.overrun(), 0);
	});
});

// Scenario: a permission-layer refusal carries picp's words and is recorded
//   Given an implementer whose guards allow a Write to the worktree's .claude/settings.json
//   When Claude Code's own permission check holds that Write
//   Then the model reads picp's "Refused: … call report_result if you are blocked", never "Let the user decide",
//   And the refusal is in the run's denials
test("permission layer: a refusal Claude Code itself makes carries picp's text and is recorded as a denial", { skip, timeout: 180_000 }, async () => {
	await inRepo(async (root, worktree) => {
		const provider = await startClaudeMockProvider([
			step("Write", { file_path: join(worktree, ".claude", "settings.json"), content: "{}\n" }),
			step(REPORT_TOOL, blocked("ship")),
			{ kind: "text", text: "Reported." },
		]);
		const result = await run(root, worktree, provider, "ship");
		await provider.close();
		const [refusal = ""] = toolResults(provider.requests);
		assert.match(refusal, /^\[error\] Refused: Claude Code's permission check holds Write .*Continue the task another way, or call report_result if you are blocked\.$/s);
		assert.doesNotMatch(refusal, /Let the user decide|wait for the user/);
		assert.deepEqual(result.denials.map((denial) => denial.tool), ["Write"]);
		assert.equal(result.denials[0]?.reason, refusal.replace("[error] ", ""));
		assert.equal(result.report?.status, "blocked");
	});
});

// Scenario: an unreported stop is blocked once, then allowed
//   Given a research worker whose turn ends with no report and no background task
//   When it stops, the Stop hook blocks once and tells it to report; a second unreported stop is allowed (no loop)
//   Then the first run's model reads the reason and reports; the second run ends unreported after exactly one block
test("Stop hook: an unreported stop with no background task is blocked once with the report reason, never twice", { skip, timeout: 180_000 }, async () => {
	await inRepo(async (root, worktree) => {
		const reports = await startClaudeMockProvider([
			{ kind: "text", text: "All done here." },
			step(REPORT_TOOL, blocked("research")),
			{ kind: "text", text: "Reported." },
		]);
		const reported = await run(root, worktree, reports, "research");
		await reports.close();
		assert.equal(reported.report?.status, "blocked", reported.reportRefusals.join("\n"));
		assert.equal(blockedAsks(reports), 2, "the reason reached the model once (and stays in the later request's history)");
		assert.equal(reports.overrun(), 0);

		const stubborn = await startClaudeMockProvider([{ kind: "text", text: "Done." }, { kind: "text", text: "Still done." }]);
		const unreported = await run(root, worktree, stubborn, "research");
		await stubborn.close();
		assert.equal(unreported.report, undefined);
		assert.equal(unreported.resultSubtype, "success");
		assert.equal(blockedAsks(stubborn), 1, "the one block reached the model");
		assert.equal(stubborn.overrun(), 0, "a second stop was blocked again");
	});
});
