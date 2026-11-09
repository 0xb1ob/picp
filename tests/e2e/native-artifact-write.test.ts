/**
 * cp-native-artifact-write: a native implementer writes its own `state/artifacts/<job id>/report.md` and reports it,
 * through the real native worker process against the loopback fake model; another job's artifact dir stays refused.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { ENVELOPE_FILE } from "../../extensions/worker-reporter/index.ts";
import { type EnvelopeRecord, layoutForHome } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";
import { waitFor } from "../harness/index.ts";

const skip = whichAll("claude", process.env)[0] === undefined ? "claude is not on PATH" : false;
const WORKER = join(import.meta.dirname, "..", "..", "src", "drivers", "claude-worker.ts");
const JOB = "cp-native-artifact-e2e";
const OTHER = "cp-native-artifact-other";
const write = (file_path: string, content: string): ClaudeStep => ({ kind: "tool_use", calls: [{ name: "Write", input: { file_path, content } }] });
type Line = { type?: string; denied?: string[]; report?: boolean };

// Scenario: a native implementer writes and reports its own artifact; every other home path stays refused
//   Given a native ship implementer for JOB in a home that already holds another job's artifact dir
//   When it Writes OTHER's report.md, a file in state/, then its own state/artifacts/JOB/report.md, and reports it
//   Then only its own report.md lands, both other Writes are refused by name, and the report naming it is accepted
test("native implementer: its own artifact dir is writable and reportable; another job's dir and state/ are refused", { skip, timeout: 180_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-native-artifact-"));
	const home = join(root, "cp-home");
	const layout = layoutForHome("multi", home);
	const own = join(home, layout.artifacts, JOB, "report.md");
	const other = join(home, layout.artifacts, OTHER, "report.md");
	const stateFile = join(home, layout.state, "sneak.json");
	mkdirSync(join(home, layout.artifacts, OTHER), { recursive: true });
	const worktree = join(root, "repo");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
	execFileSync("git", ["init", "-q", worktree]);
	git("config", "user.name", "artifact e2e");
	git("config", "user.email", "artifact@test.invalid");
	writeFileSync(join(worktree, "README.md"), "demo\n");
	git("add", "-A");
	git("commit", "-q", "-m", "base");
	const provider = await startClaudeMockProvider([
		write(other, "# not mine\n"),
		write(stateFile, "{}\n"),
		write(own, "# Own artifact\nDetails live here.\n"),
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => ({ job_id: JOB, kind: "ship", status: "done", summary: "Shipped with an artifact.", branch: JOB, head_sha: git("rev-parse", "HEAD"), artifact_path: own }) }] },
		{ kind: "text", text: "Reported." },
	]);
	let worker: ChildProcessWithoutNullStreams | undefined;
	t.after(async () => {
		if (worker && worker.exitCode === null) worker.kill("SIGKILL");
		await provider.close();
		rmSync(root, { recursive: true, force: true });
	});
	const fakeHome = join(root, "home");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN } }));
	const runDir = join(root, "run");
	mkdirSync(runDir);
	writeFileSync(join(runDir, "system.md"), "You are a test implementer.\n");
	worker = spawn(process.execPath, [WORKER], {
		env: {
			PATH: process.env.PATH ?? "", HOME: fakeHome, CP_HOME: home, CP_JOB_ID: JOB, CP_RUN_DIR: runDir, CP_WORKTREE: worktree,
			CP_KIND: "ship", CP_ROLE: "implementer", CP_DELIVERY: "local", CP_NATIVE_SYSTEM_PROMPT_FILE: join(runDir, "system.md"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const out: Line[] = [];
	let stderr = "";
	worker.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
	createInterface({ input: worker.stdout }).on("line", (line) => void out.push(JSON.parse(line) as Line));
	worker.stdin.write(`${JSON.stringify({ id: 1, type: "prompt", message: "Ship it and write the details to your artifact." })}\n`);
	await waitFor(() => out.some((line) => line.type === "agent_settled"), Boolean, { timeoutMs: 150_000, what: "the reported worker settles" });

	const results = toolResults(provider.requests);
	assert.match(results[0] ?? "", new RegExp(`^\\[error\\] .*Refused: an implementer edits only inside its worktree .*, and inside its own artifact directory .*${JOB}; a path outside the worktree \\(.*${OTHER}/report\\.md\\)`, "s"));
	assert.match(results[1] ?? "", /^\[error\] .*Refused: an implementer edits only inside its worktree .*sneak\.json/s);
	assert.equal(existsSync(other), false, "another job's artifact dir was written");
	assert.equal(existsSync(stateFile), false, "state/ outside the own artifact dir was written");
	assert.equal(readFileSync(own, "utf8"), "# Own artifact\nDetails live here.\n");
	const run = out.find((line) => line.type === "native_run");
	assert.equal(run?.report, true, stderr);
	assert.deepEqual(run?.denied?.map((line) => line.slice(0, 22)), ["Write: Refused: an imp", "Write: Refused: an imp"], JSON.stringify(run));
	const filed = (JSON.parse(readFileSync(join(runDir, ENVELOPE_FILE), "utf8")) as EnvelopeRecord).envelope;
	assert.deepEqual([filed.status, filed.artifact_path], ["done", own]);
	// The report tool tells the model the same path its Write guard admits.
	const first = provider.requests.find((request) => request.path.startsWith("/v1/messages"))?.body as { tools?: Array<{ name: string; description?: string }> };
	assert.ok(first.tools?.find((tool) => tool.name === REPORT_TOOL)?.description?.includes(`Details go in your own artifact ${own}`), JSON.stringify(first.tools?.map((tool) => tool.name)));

	const exited = new Promise<number | null>((done) => worker!.once("exit", (code) => done(code)));
	worker.stdin.end();
	assert.equal(await exited, 0, stderr);
});
