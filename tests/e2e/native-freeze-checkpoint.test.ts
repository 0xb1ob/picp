/**
 * J6: a freeze drain checkpoints a mid-turn native implementer instead of steering it (a native steer is refused).
 * The worker aborts its turn, commits the WIP as `WIP: freeze checkpoint`, reports the head and settles idle.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { type FleetRecord, layoutForHome } from "../../src/contracts.ts";
import { DrainControl, FREEZE_STEER, workerCheckpoint } from "../../src/drain.ts";
import { whichAll } from "../../src/doctor.ts";
import { FAKE_CLAUDE_AUTH_TOKEN, startClaudeMockProvider } from "../harness/claude-mock-provider.ts";
import { waitFor } from "../harness/index.ts";

const skip = whichAll("claude", process.env)[0] === undefined ? "claude is not on PATH" : false;
const WORKER = join(import.meta.dirname, "..", "..", "src", "drivers", "claude-worker.ts");
type Line = { type?: string; id?: unknown; success?: boolean; data?: { disposition?: string }; error?: string; head?: string; stop?: string };

// Scenario: a freeze drain checkpoints a native implementer and steers a pi one
//   Given a freeze drain on disk with a busy native implementer and a busy pi implementer
//   When the parent runs the freeze
//   Then the native one gets the checkpoint RPC, never the FREEZE steer, and the pi one is steered as before
test("J6 freeze: a busy native implementer is checkpointed, a busy pi implementer is steered", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-j6-drain-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const record = (job_id: string, driver?: "claude") => ({ job_id, worker: { role: "implementer", ...(driver ? { driver } : {}) } }) as unknown as FleetRecord;
	const steered: string[] = [];
	const checkpointed: string[] = [];
	const drain = new DrainControl({
		home, fleet: { list: () => [record("cp-native", "claude"), record("cp-pi")] }, busy: () => ["cp-native", "cp-pi"], head: () => undefined, journal: () => {},
		steer: async (jobId, message) => (assert.equal(message, FREEZE_STEER), steered.push(jobId), { receipt: "delivered" }),
		checkpoint: async (jobId) => (checkpointed.push(jobId), { success: true, data: { head: "abc123" } }),
	});
	assert.equal(drain.start(60, { reason: "freeze" }).state, "draining");
	const lines = await drain.freeze();
	assert.deepEqual([checkpointed, steered], [["cp-native"], ["cp-pi"]], lines.join("\n"));
	assert.deepEqual(lines, ["  freeze: cp-native checkpointed (Claude CLI at abc123)", "  freeze: cp-pi steered (delivered)"]);
});

// Scenario: a refused checkpoint reply is named on the drain line
//   Given a freeze drain whose native implementer's worker answers the checkpoint RPC with success false
//   When the parent runs the freeze through the command-post wiring (`workerCheckpoint`)
//   Then the line reads "not checkpointed: <why>", never "checkpointed"; a missing worker is named the same way
test("J6 wiring: a refused or missing checkpoint reply prints not checkpointed with the reason", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-j6-wiring-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const record = (job_id: string) => ({ job_id, worker: { role: "implementer", driver: "claude" } }) as unknown as FleetRecord;
	const refusing = { request: async () => ({ success: false, error: "cp-a: the native worker is idle; there is no turn to checkpoint" }) };
	const drain = new DrainControl({
		home, fleet: { list: () => [record("cp-a"), record("cp-b")] }, busy: () => ["cp-a", "cp-b"], head: () => undefined, journal: () => {},
		checkpoint: (jobId) => workerCheckpoint(jobId === "cp-a" ? refusing : undefined),
	});
	drain.start(60, { reason: "freeze" });
	assert.deepEqual(await drain.freeze(), [
		"  freeze: cp-a not checkpointed: cp-a: the native worker is idle; there is no turn to checkpoint",
		"  freeze: cp-b not checkpointed: no live worker in this process",
	]);
});

// Scenario: a checkpoint during a pending resume admission is refused, so no freeze outlives a refused admission
//   Given a revived native worker whose resume admission is still pending (it then refuses)
//   When the checkpoint RPC arrives before the admission settles
//   Then the checkpoint is refused by name and the admission's own refusal follows; no turn is left frozen
test("J6 admission: a checkpoint while the resume admission is pending is refused by name", (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-j6-admission-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, ".pi-command-post");
	const fleet = join(home, layoutForHome("multi", home).fleetFile);
	mkdirSync(dirname(fleet), { recursive: true });
	writeFileSync(fleet, "{");
	const input = [{ id: 1, type: "prompt", message: "go" }, { id: 2, type: "checkpoint" }].map((line) => `${JSON.stringify(line)}\n`).join("");
	const env = { PATH: process.env.PATH ?? "", CP_HOME: home, CP_NATIVE_RESUME: "1", CP_JOB_ID: "cp-j6", CP_RUN_DIR: root, CP_WORKTREE: root, CP_KIND: "ship", CP_ROLE: "implementer" };
	const worker = spawnSync(process.execPath, [WORKER], { input, env, encoding: "utf8", timeout: 60_000 });
	const replies = worker.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Line).filter((line) => line.type === "response");
	assert.deepEqual(replies.map((line) => [line.id, line.success]), [[2, false], [1, false]], worker.stdout + worker.stderr);
	assert.match(replies[0]?.error ?? "", /a resume admission is pending; no turn to checkpoint yet/);
	assert.match(replies[1]?.error ?? "", /Nothing was resumed\.$/);
});

// Scenario: a turn that throws still answers its pending checkpoint
//   Given a native implementer whose turn throws (started without CP_HOME) with a checkpoint pending
//   When serve() fails
//   Then the checkpoint is answered success false naming the failure, never left to the RPC timeout
test("J6 throw: a checkpoint pending when the turn throws is answered with the error", (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-j6-throw-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "system.md"), "You are a test implementer.\n");
	const input = [{ id: 1, type: "prompt", message: "go" }, { id: 2, type: "checkpoint" }].map((line) => `${JSON.stringify(line)}\n`).join("");
	// No CP_HOME: the implementer's exclude paths cannot be read, so the turn throws before claude starts.
	const env = { PATH: process.env.PATH ?? "", HOME: root, CP_JOB_ID: "cp-j6", CP_RUN_DIR: root, CP_WORKTREE: root, CP_KIND: "ship", CP_ROLE: "implementer", CP_NATIVE_SYSTEM_PROMPT_FILE: join(root, "system.md") };
	const worker = spawnSync(process.execPath, [WORKER], { input, env, encoding: "utf8", timeout: 60_000 });
	const replies = worker.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Line).filter((line) => line.type === "response");
	assert.deepEqual(replies.map((line) => [line.id, line.success]), [[1, true], [2, false]], worker.stdout + worker.stderr);
	assert.match(replies[1]?.error ?? "", /^the turn failed before a checkpoint: Claude CLI worker started without CP_HOME/);
	assert.equal(worker.status, 1, worker.stderr);
});

// Scenario: a checkpoint aborts the native turn, commits and pushes the WIP, and leaves the worker idle and alive
//   Given a native ship implementer mid-turn (its model call held open) with an uncommitted file in its worktree
//   When the parent sends the checkpoint RPC, Then claude exits, `WIP: freeze checkpoint` holds the file,
//   agent_settled follows native_checkpoint's head, And the WIP head is on the remote job branch
test("J6 checkpoint: a mid-turn native implementer commits its WIP, reports the head and settles idle", { skip, timeout: 120_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-j6-checkpoint-"));
	let release: () => void = () => {};
	const held = new Promise<void>((done) => (release = done));
	let reached = false;
	const provider = await startClaudeMockProvider([{ kind: "text", text: "never sent", beforeAnswer: () => ((reached = true), held) }]);
	let worker: ChildProcessWithoutNullStreams | undefined;
	t.after(async () => {
		release();
		if (worker && worker.exitCode === null) worker.kill("SIGKILL");
		await provider.close();
		rmSync(root, { recursive: true, force: true });
	});
	const worktree = join(root, "repo");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
	execFileSync("git", ["init", "-q", worktree]);
	git("config", "user.name", "j6 e2e");
	git("config", "user.email", "j6@test.invalid");
	writeFileSync(join(worktree, "README.md"), "demo\n");
	git("add", "-A");
	git("commit", "-q", "-m", "base");
	const base = git("rev-parse", "HEAD");
	execFileSync("git", ["init", "-q", "--bare", join(root, "origin.git")]);
	git("remote", "add", "origin", join(root, "origin.git"));
	writeFileSync(join(worktree, "wip.txt"), "half done\n");
	const fakeHome = join(root, "home");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN } }));
	const runDir = join(root, "run");
	mkdirSync(runDir);
	writeFileSync(join(runDir, "system.md"), "You are a test implementer.\n");
	worker = spawn(process.execPath, [WORKER], {
		env: {
			PATH: process.env.PATH ?? "", HOME: fakeHome, CP_HOME: join(root, "cp-home"), CP_JOB_ID: "cp-j6", CP_RUN_DIR: runDir, CP_WORKTREE: worktree,
			CP_KIND: "ship", CP_ROLE: "implementer", CP_DELIVERY: "pr", CP_NATIVE_SYSTEM_PROMPT_FILE: join(runDir, "system.md"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const out: Line[] = [];
	let stderr = "";
	worker.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
	createInterface({ input: worker.stdout }).on("line", (line) => void out.push(JSON.parse(line) as Line));
	const send = (record: Record<string, unknown>) => worker!.stdin.write(`${JSON.stringify(record)}\n`);
	const reply = (id: number) => out.find((line) => line.type === "response" && line.id === id);
	send({ id: 1, type: "prompt", message: "Write the feature." });
	await waitFor(() => reached, Boolean, { timeoutMs: 60_000, what: "the turn reaches the model" });
	assert.equal(reply(1)?.data?.disposition, "started");

	send({ id: 2, type: "checkpoint" });
	await waitFor(() => out.some((line) => line.type === "agent_settled"), Boolean, { timeoutMs: 60_000, what: "the frozen worker settles" });
	const types = out.map((line) => line.type);
	const checkpoint = out.find((line) => line.type === "native_checkpoint");
	assert.ok(types.indexOf("native_run") < types.indexOf("native_checkpoint"), "the checkpoint follows the observed claude exit");
	assert.ok(types.indexOf("native_checkpoint") < types.indexOf("agent_settled"), types.join(","));
	assert.equal(out.find((line) => line.type === "native_run")?.stop, undefined, "a frozen turn is no named failure");
	assert.equal(checkpoint?.head, git("rev-parse", "HEAD"), JSON.stringify(checkpoint));
	assert.deepEqual([reply(2)?.success, reply(2)?.data], [true, { head: checkpoint?.head, pushed: true }], "the RPC answers once the commit is pushed");
	assert.equal(git("ls-remote", "origin", "refs/heads/cp-j6").split("\t")[0], checkpoint?.head, "the WIP head is on the remote job branch");
	assert.deepEqual([git("log", "-1", "--format=%s"), git("rev-parse", "HEAD~1"), git("status", "--porcelain")], ["WIP: freeze checkpoint", base, ""]);
	assert.equal(git("show", "HEAD:wip.txt"), "half done");

	// Idle, not exited: a second checkpoint is refused by name and get_state still answers.
	send({ id: 3, type: "checkpoint" });
	send({ id: 4, type: "get_state" });
	await waitFor(() => reply(4), Boolean, { timeoutMs: 10_000, what: "the idle worker answers" });
	assert.match(reply(3)?.error ?? "", /is idle; there is no turn to checkpoint/);
	assert.equal(worker.exitCode, null, stderr);
	const exited = new Promise<number | null>((done) => worker!.once("exit", (code) => done(code)));
	worker.stdin.end();
	assert.equal(await exited, 0, stderr);
});
