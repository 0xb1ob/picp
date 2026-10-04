/**
 * cp-8km acceptance: revival is relaunch-not-reattach, explicit, re-probed at
 * revive time, and refuses on a hazardous worktree rather than silently
 * handing a resumed conversation back into a repo it knows nothing about.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, paths } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { loadProfile } from "../src/profiles.ts";
import {
	childPids,
	formatRevivePlan,
	inspectWorktree,
	readInterruptedTool,
	ReviveError,
	Reviver,
} from "../src/revive.ts";
import { RunRegistry } from "../src/runs.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { fakeWorker, fakeWorkerManager, readRunEvents } from "./harness/index.ts";
import { HeldRelease } from "../src/held-release.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	git,
	MockProvider,
	type ScratchRepo,
	waitFor,
	REPO_ROOT,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

/** A pid that existed and has been reaped: cheap and, unlike a guess, true. */
function reapedPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	if (!result.pid || result.pid <= 0) throw new Error("could not obtain a reaped pid for the fixture");
	return result.pid;
}

const DEAD_PID = reapedPid();

function makeRecord(overrides: Partial<FleetRecord> = {}, home: string): FleetRecord {
	const jobId = overrides.job_id ?? "cp-revive";
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "held",
		reported_at: isoTimestamp(),
		worker: {
			pid: DEAD_PID,
			session_id: "sess-1",
			session_file: join(home, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/mock-model",
			started_at: isoTimestamp(),
		},
		worktree: join(home, "worktrees", jobId),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		...overrides,
	};
}

function bench(t: { after(fn: () => void | Promise<void>): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const manager = new WorkerManager({ home: home.path, workerReporterPath: WORKER_REPORTER_EXTENSION });
	const runs = new RunRegistry(home.path);
	t.after(async () => {
		await manager.shutdownAll();
		runs.closeAll();
	});
	return { home: home.path, fleet, manager, runs };
}

// ---------------------------------------------------------------------------
// plan(): the refusal ladder
// ---------------------------------------------------------------------------

test("plan refuses: no record, wrong phase, missing session, live pid, missing worktree", async (t) => {
	const b = bench(t);
	const reviver = new Reviver({
		home: b.home,
		profilesDir: PROFILES_DIR,
		fleet: b.fleet,
		manager: b.manager,
		runs: b.runs,
		isPidAlive: () => false,
	});

	const missing = await reviver.plan("cp-nope");
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.equal(missing.code, "not_found");

	await b.fleet.add(makeRecord({ job_id: "cp-done", phase: "done", closed_at: isoTimestamp() }, b.home));
	const wrongPhase = await reviver.plan("cp-done");
	assert.equal(wrongPhase.ok, false);
	if (!wrongPhase.ok) assert.equal(wrongPhase.code, "not_revivable_phase");

	await b.fleet.add(makeRecord({ job_id: "cp-nosession" }, b.home)); // session_file never written
	const noSession = await reviver.plan("cp-nosession");
	assert.equal(noSession.ok, false);
	if (!noSession.ok) assert.equal(noSession.code, "session_missing");

	const worktree = join(b.home, "worktrees", "cp-alive");
	mkdirSync(worktree, { recursive: true });
	const sessionFile = join(b.home, "alive.jsonl");
	writeFileSync(sessionFile, "{}\n");
	await b.fleet.add(makeRecord({ job_id: "cp-alive", worktree, worker: { ...makeRecord({}, b.home).worker, session_file: sessionFile, pid: process.pid } }, b.home));
	const aliveReviver = new Reviver({
		home: b.home,
		profilesDir: PROFILES_DIR,
		fleet: b.fleet,
		manager: b.manager,
		runs: b.runs,
		isPidAlive: () => true,
		childPids: () => [],
	});
	const livePid = await aliveReviver.plan("cp-alive");
	assert.equal(livePid.ok, false);
	if (!livePid.ok) assert.equal(livePid.code, "pid_alive");

	const missingWorktreeSession = join(b.home, "gone.jsonl");
	writeFileSync(missingWorktreeSession, "{}\n");
	await b.fleet.add(
		makeRecord(
			{ job_id: "cp-noworktree", worktree: join(b.home, "worktrees", "never-created"), worker: { ...makeRecord({}, b.home).worker, session_file: missingWorktreeSession } },
			b.home,
		),
	);
	const noWorktree = await reviver.plan("cp-noworktree");
	assert.equal(noWorktree.ok, false);
	if (!noWorktree.ok) assert.equal(noWorktree.code, "worktree_missing");
});

test("plan refuses tool_child_alive while a child of the stored pid lives; the stored pid only, nothing signalled", async (t) => {
	const b = bench(t);
	const worktree = join(b.home, "worktrees", "cp-child");
	mkdirSync(worktree, { recursive: true });
	const sessionFile = join(b.home, "child.jsonl");
	writeFileSync(sessionFile, "{}\n");
	await b.fleet.add(makeRecord({ job_id: "cp-child", worktree, worker: { ...makeRecord({}, b.home).worker, session_file: sessionFile, pid: 4242 } }, b.home));
	const asked: number[] = [];
	const planWith = (live: readonly number[]) =>
		new Reviver({
			home: b.home,
			profilesDir: PROFILES_DIR,
			fleet: b.fleet,
			manager: b.manager,
			runs: b.runs,
			isPidAlive: (pid) => live.includes(pid),
			childPids: (pid) => {
				asked.push(pid);
				return [4243, 4244];
			},
		}).plan("cp-child");

	const child = await planWith([4242, 4243]);
	assert.equal(child.ok, false);
	if (!child.ok) {
		assert.equal(child.code, "tool_child_alive");
		assert.match(child.message, /pid 4242 has live child process\(es\) 4243 /);
		assert.match(child.message, /Nothing was signalled/);
	}
	assert.deepEqual(asked, [4242], "only the stored pid is asked about");

	// Children that already exited do not refuse; the live pid itself still does.
	const exited = await planWith([4242]);
	assert.equal(exited.ok ? "" : exited.code, "pid_alive");

	// A dead stored pid has no attributable children: its children are not asked for.
	asked.length = 0;
	const dead = await planWith([]);
	assert.notEqual(dead.ok ? "" : dead.code, "tool_child_alive");
	assert.deepEqual(asked, []);
});

test("childPids reads a real child of this process from procfs", { skip: !existsSync("/proc/self/task") }, async (t) => {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
	t.after(() => child.kill()); // the pid this test started, nothing else
	assert.ok(child.pid);
	assert.ok(childPids(process.pid).includes(child.pid as number));
	assert.deepEqual(childPids(DEAD_PID), []);
});

test("plan refuses a worktree with a rebase/merge/cherry-pick in progress or a detached HEAD; dirty is surfaced, not refused", async (t) => {
	const b = bench(t);
	const repo: ScratchRepo = createScratchRepo({ name: "revive-worktree" });
	t.after(() => repo.cleanup());

	async function planFor(jobId: string, worktree: string): Promise<Awaited<ReturnType<Reviver["plan"]>>> {
		const sessionFile = join(b.home, `${jobId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		await b.fleet.add(makeRecord({ job_id: jobId, worktree, worker: { ...makeRecord({}, b.home).worker, session_file: sessionFile } }, b.home));
		const reviver = new Reviver({
			home: b.home,
			profilesDir: PROFILES_DIR,
			fleet: b.fleet,
			manager: b.manager,
			runs: b.runs,
			isPidAlive: () => false,
		});
		return reviver.plan(jobId);
	}

	// Fabricate a mid-rebase worktree: a plain clone (not a linked worktree) is
	// enough, since inspectWorktree resolves the real git-dir via `rev-parse
	// --git-dir` rather than assuming `.git` is a directory.
	const rebaseTree = join(b.home, "worktrees", "cp-rebase");
	git(repo.path, "clone", "--quiet", repo.path, rebaseTree);
	const gitDir = git(rebaseTree, "rev-parse", "--git-dir");
	mkdirSync(join(rebaseTree, gitDir, "rebase-merge"), { recursive: true });
	const rebasePlan = await planFor("cp-rebase", rebaseTree);
	assert.equal(rebasePlan.ok, false);
	if (!rebasePlan.ok) {
		assert.equal(rebasePlan.code, "repo_operation_in_progress");
		assert.match(rebasePlan.message, /rebase/);
	}

	const detachedTree = join(b.home, "worktrees", "cp-detached");
	git(repo.path, "clone", "--quiet", repo.path, detachedTree);
	git(detachedTree, "checkout", "--quiet", "--detach", "HEAD");
	const detachedPlan = await planFor("cp-detached", detachedTree);
	assert.equal(detachedPlan.ok, false);
	if (!detachedPlan.ok) assert.equal(detachedPlan.code, "repo_detached_head");

	// Uncommitted changes are the ordinary shape of a ship job mid-work: refusing
	// on it would make revival useless for the exact case it exists for, so it
	// is surfaced on the plan instead of refused.
	const dirtyTree = join(b.home, "worktrees", "cp-dirty");
	git(repo.path, "clone", "--quiet", repo.path, dirtyTree);
	writeFileSync(join(dirtyTree, "scratch.txt"), "uncommitted\n");
	const dirtyPlan = await planFor("cp-dirty", dirtyTree);
	assert.equal(dirtyPlan.ok, true);
	if (dirtyPlan.ok) assert.equal(dirtyPlan.worktreeDirty, true);

	// A clean worktree on its own branch is unaffected by any of the above.
	const cleanTree = join(b.home, "worktrees", "cp-clean");
	git(repo.path, "clone", "--quiet", repo.path, cleanTree);
	const cleanState = await inspectWorktree(cleanTree);
	assert.deepEqual(cleanState, { dirty: false, detachedHead: false, inProgressOp: undefined, clean: true });
});

test("readInterruptedTool parses a real dangling-tool-call session (spike shape)", async (t) => {
	const b = bench(t);
	const sessionFile = join(b.home, "dangling.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "s1", timestamp: isoTimestamp(), cwd: "/tmp" },
		{ type: "message", id: "m1", parentId: null, timestamp: isoTimestamp(), message: { role: "user", content: [{ type: "text", text: "run it" }] } },
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: isoTimestamp(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "git rebase --continue" } }],
			},
		},
	];
	writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

	const tool = readInterruptedTool(sessionFile);
	assert.deepEqual(tool, { name: "bash", arguments: { command: "git rebase --continue" }, toolCallId: "call_1" });

	// A resolved call is not reported as interrupted.
	writeFileSync(
		sessionFile,
		[...lines, { type: "message", id: "m3", parentId: "m2", timestamp: isoTimestamp(), message: { role: "toolResult", toolCallId: "call_1", content: [] } }]
			.map((line) => JSON.stringify(line))
			.join("\n") + "\n",
	);
	assert.equal(readInterruptedTool(sessionFile), undefined);
});

test("formatRevivePlan names the refusal code and, on success, the interrupted tool", () => {
	const refusal = formatRevivePlan({ ok: false, job_id: "cp-x", code: "pid_alive", message: "still running" });
	assert.match(refusal, /cp-x: revive refused \(pid_alive\) — still running/);

	const plan = formatRevivePlan({
		ok: true,
		job_id: "cp-y",
		session_file: "/s/y.jsonl",
		worktree: "/wt/y",
		model: "anthropic/claude",
		profile: "implementer",
		role: "implementer",
		worktreeDirty: false,
		interruptedTool: { name: "bash", arguments: { command: "git rebase --continue" }, toolCallId: "c1" },
	});
	assert.match(plan, /cp-y: revivable/);
	assert.match(plan, /interrupted tool: bash/);
	assert.match(plan, /told this call produced no result/);
});

// ---------------------------------------------------------------------------
// revive(): a real killed pi child, relaunched
// ---------------------------------------------------------------------------

test(
	"kill mid-tool-call, then revive: new pid, same session, idle until prompted, the interrupted call is surfaced",
	{ timeout: 120_000 },
	async (t) => {
		const jobId = "cp-revive-e2e";
		const provider = await MockProvider.start();
		const repo = createScratchRepo({ name: "revive-e2e" });
		const home = createScratchHome();
		const agentDir = createAgentDir({ provider });
		const model = provider.addScript("revive-e2e", [
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo RAN >> marker.log && sleep 600" } }] },
			{ kind: "text", text: "resumed" },
		]);
		agentDir.writeModels(provider);

		const manager = new WorkerManager({
			home: home.path,
			workerReporterPath: WORKER_REPORTER_EXTENSION,
			parentEnv: { ...process.env, ...agentDir.env },
		});
		const runDir = join(home.path, paths.runDir(jobId));
		mkdirSync(runDir, { recursive: true });
		const profile = loadProfile(PROFILES_DIR, "implementer");
		const sessionDir = join(home.path, "sessions");
		const managed = manager.spawn({
			identity: { jobId, kind: "ship", delivery: "pr", runDir, worktree: repo.path },
			profile,
			model,
			sessionDir,
		});

		t.after(async () => {
			await manager.shutdownAll();
			agentDir.cleanup();
			repo.cleanup();
			home.cleanup();
			await provider.stop();
		});

		await managed.worker.prompt("run the command");
		await managed.worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
		const state = await managed.worker.getState(30_000);
		const sessionFile = state.sessionFile as string;
		const pid = managed.worker.pid as number;
		await waitFor(() => existsSync(sessionFile), (ok) => ok, { what: "worker session file" });
		await waitFor(() => existsSync(join(repo.path, "marker.log")), (ok) => ok, { what: "tool actually ran" });

		const fleet = new FleetStore({ home: home.path });
		await fleet.add({
			job_id: jobId,
			project: "revive-e2e",
			kind: "ship",
			delivery: "pr",
			origin: DEFAULT_ORIGIN,
			phase: "waiting",
			worker: {
				pid,
				session_id: (state.sessionId as string | undefined) ?? "unknown",
				session_file: sessionFile,
				profile: profile.frontmatter.name,
				role: profile.frontmatter.role,
				model,
				started_at: isoTimestamp(),
			},
			worktree: repo.path,
			branch: jobId,
			dispatched_at: isoTimestamp(),
			usage: EMPTY_USAGE,
		});

		// kill -9: exactly what a dead worker leaves behind.
		await managed.worker.kill("SIGKILL");

		// A brand-new manager, standing in for the restarted parent.
		const manager2 = new WorkerManager({
			home: home.path,
			workerReporterPath: WORKER_REPORTER_EXTENSION,
			parentEnv: { ...process.env, ...agentDir.env },
		});
		const runs2 = new RunRegistry(home.path);
		t.after(async () => {
			await manager2.shutdownAll();
			runs2.closeAll();
		});
		const reviver = new Reviver({
			home: home.path,
			profilesDir: PROFILES_DIR,
			fleet,
			manager: manager2,
			runs: runs2,
			isPidAlive: () => false, // the real pid is gone; this pins the "gone" branch deterministically
		});

		const plan = await reviver.plan(jobId);
		assert.equal(plan.ok, true);
		if (plan.ok) {
			assert.equal(plan.session_file, sessionFile);
			assert.equal(plan.interruptedTool?.name, "bash");
		}

		const result = await reviver.revive(jobId);
		assert.notEqual(result.pid, pid, "a new process, not a reattachment");
		assert.equal(result.session_file, sessionFile);
		assert.equal(result.interruptedTool?.name, "bash");

		const revived = manager2.get(jobId);
		assert.ok(revived, "the revived worker is registered under the job's key");

		// Idle until prompted (spike Evidence S3): give it a moment and confirm
		// nothing ran and the interrupted tool did not re-execute.
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
		const markerContents = execFileSync("cat", [join(repo.path, "marker.log")]).toString();
		assert.equal(markerContents.split("\n").filter((line) => line.length > 0).length, 1, "the interrupted tool must not re-run on revival");

		const record = fleet.require(jobId);
		assert.equal(record.worker.pid, result.pid);
		assert.equal(record.worker.session_file, sessionFile, "revival never rewrites the session file");
		assert.equal(record.worker.model, model, "revival never rewrites the model");

		// The revived worker answers a fresh prompt normally.
		await revived?.worker.prompt("continue");
		await revived?.worker.waitForSettled(30_000);
	},
);

test("revive() writes the worker_revived marker before it tees a single event (cp-0wq7)", async (t) => {
	// The marker is what reopens the projection's liveness after the previous
	// attempt's observed close. An event teed ahead of it is an event about a
	// process the projection still believes is dead: it would be swallowed as
	// post-exit noise, and the run would read `exited` while a live worker worked.
	// A fake child emits on registration, which is the tightest version of that
	// race a real buffered stdout chunk can produce.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => runs.closeAll());

	const jobId = "cp-revive-order";
	const worktree = join(home.path, "worktrees", jobId);
	mkdirSync(worktree, { recursive: true });
	const sessionFile = join(home.path, `${jobId}.jsonl`);
	writeFileSync(sessionFile, "{}\n");
	await fleet.add(
		makeRecord(
			{ job_id: jobId, phase: "waiting", worktree, worker: { ...makeRecord({}, home.path).worker, session_file: sessionFile } },
			home.path,
		),
	);

	// The previous attempt: it ran, settled and its close was OBSERVED.
	const recorder = runs.open(jobId);
	recorder.cp("spawned", { pid: DEAD_PID, model: "mock/mock-model", profile: "implementer" });
	recorder.record("pi", "agent_start", {});
	recorder.record("pi", "agent_settled", {});
	recorder.cp("process_exit", { code: 0, signal: null });
	assert.equal(recorder.status.phase, "exited");

	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		// No child process: a fake that emits the moment a listener is registered.
		spawnFn: () =>
			({
				pid: DEAD_PID + 1,
				alive: true,
				busy: false,
				closed: new Promise(() => {}),
				onEvent(listener: (event: { type: string }) => void) {
					listener({ type: "agent_start" });
					return () => {};
				},
				shutdown: async () => ({ code: 0, signal: null, at: Date.now() }),
			}) as unknown as ReturnType<WorkerManager["spawn"]>["worker"],
	});
	t.after(async () => manager.shutdownAll());

	const reviver = new Reviver({
		home: home.path,
		profilesDir: PROFILES_DIR,
		fleet,
		manager,
		runs,
		isPidAlive: () => false,
		git: async (_cwd, args) =>
			// clean tree, on a branch, no rebase/merge in flight
			args[0] === "rev-parse" ? { status: 0, stdout: join(worktree, ".git"), stderr: "" } : { status: 0, stdout: "", stderr: "" },
	});

	await reviver.revive(jobId);

	const types = readRunEvents(home.path, jobId).map((event) => `${event.source}:${event.type}`);
	const marker = types.indexOf("cp:worker_revived");
	const firstNewEvent = types.indexOf("pi:agent_start", types.indexOf("cp:process_exit"));
	assert.ok(marker > types.indexOf("cp:process_exit"), "the marker belongs to the new attempt");
	assert.ok(marker < firstNewEvent, `worker_revived must precede the revived worker's events: ${types.join(", ")}`);
	// And the consequence the ordering exists for: the run is live again.
	assert.equal(runs.open(jobId).status.phase, "working");
	assert.equal(runs.open(jobId).status.exited_at, undefined);
});

test("revive() throws with the refusal code and message when the plan refuses", async (t) => {
	const b = bench(t);
	await b.fleet.add(makeRecord({ job_id: "cp-refuse" }, b.home)); // session file never written
	const reviver = new Reviver({
		home: b.home,
		profilesDir: PROFILES_DIR,
		fleet: b.fleet,
		manager: b.manager,
		runs: b.runs,
		isPidAlive: () => false,
	});
	await assert.rejects(() => reviver.revive("cp-refuse"), (error: unknown) => {
		assert.ok(error instanceof ReviveError);
		assert.match((error as Error).message, /session_missing/);
		return true;
	});
});

// ---------------------------------------------------------------------------
// continueFailed: the operator's continuation of a failed job on its lease
// ---------------------------------------------------------------------------

const CRASH = { class: "crash" as const, message: "worker exited 137", at: isoTimestamp() };

/** A fake child: registered, alive, silent. `throws` stands in for a spawn that fails. */
function fakeManager(home: string, t: { after(fn: () => void | Promise<void>): void }, throws = false): WorkerManager {
	const manager = new WorkerManager({
		home,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		spawnFn: () => {
			if (throws) throw new Error("spawn failed");
			return {
				pid: DEAD_PID + 1,
				alive: true,
				busy: false,
				closed: new Promise(() => {}),
				onEvent: () => () => {},
				shutdown: async () => ({ code: 0, signal: null, at: Date.now() }),
			} as unknown as ReturnType<WorkerManager["spawn"]>["worker"];
		},
	});
	t.after(async () => manager.shutdownAll());
	return manager;
}

/** Clean tree on a branch unless told otherwise; the git-dir is a real directory so op markers can be planted. */
function fakeGit(gitDir: string, detached = false) {
	return async (_cwd: string, args: readonly string[]) =>
		args[0] === "rev-parse"
			? { status: 0, stdout: gitDir, stderr: "" }
			: args[0] === "symbolic-ref" && detached
				? { status: 1, stdout: "", stderr: "" }
				: { status: 0, stdout: "", stderr: "" };
}

async function addFailed(home: string, fleet: FleetStore, jobId: string, overrides: Partial<FleetRecord> = {}): Promise<FleetRecord> {
	const worktree = join(home, "worktrees", jobId);
	mkdirSync(join(worktree, ".git"), { recursive: true });
	const sessionFile = join(home, `${jobId}.jsonl`);
	const lines = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "git push" } }] } },
	];
	writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	const base = makeRecord({}, home);
	const { reported_at: _reported, ...rest } = base;
	return fleet.add({
		...rest,
		job_id: jobId,
		branch: jobId,
		phase: "failed",
		failure: CRASH,
		worktree,
		worker: { ...base.worker, session_file: sessionFile },
		...overrides,
	});
}

test("continueFailed: a failed job continues on its original session, worktree and lease; failed clears only after the recorded spawn", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => runs.closeAll());
	const jobId = "cp-continue";
	const before = await addFailed(home.path, fleet, jobId);
	const reviver = new Reviver({
		home: home.path,
		profilesDir: PROFILES_DIR,
		fleet,
		manager: fakeManager(home.path, t),
		runs,
		isPidAlive: () => false,
		git: fakeGit(join(before.worktree, ".git")),
	});

	// Without the explicit option a failed job is refused, and the refusal names the sanctioned path.
	const refused = await reviver.plan(jobId);
	assert.equal(refused.ok, false);
	if (!refused.ok) {
		assert.equal(refused.code, "not_revivable_phase");
		assert.match(refused.message, /continue_failed:true/);
	}

	const plan = await reviver.plan(jobId, { continueFailed: true });
	assert.equal(plan.ok, true);
	if (plan.ok) {
		assert.equal(plan.session_file, before.worker.session_file);
		assert.equal(plan.worktree, before.worktree);
		assert.deepEqual(plan.continuesFailure, CRASH);
		assert.equal(plan.interruptedTool?.name, "bash");
		const text = formatRevivePlan(plan);
		assert.match(text, /continues failed job \(crash: worker exited 137\)/);
		assert.match(text, /counter is not reset/);
		assert.match(text, /interrupted tool: bash/);
		assert.match(text, /told this call produced no result/);
	}
	// Planning mutates nothing.
	assert.deepEqual(fleet.require(jobId), before);

	const result = await reviver.revive(jobId, { continueFailed: true });
	assert.equal(result.pid, DEAD_PID + 1);
	assert.deepEqual(result.continuedFailure, CRASH);
	assert.equal(result.interruptedTool?.name, "bash");

	const after = fleet.require(jobId);
	assert.equal(after.phase, "waiting");
	assert.equal(after.failure, undefined);
	assert.equal(after.worker.pid, DEAD_PID + 1);
	assert.equal(after.worker.session_file, before.worker.session_file, "same session");
	assert.equal(after.worktree, before.worktree, "same worktree (lease)");
	assert.equal(after.branch, before.branch, "no new branch");

	const marker = readRunEvents(home.path, jobId).find((event) => event.type === "worker_revived");
	const payload = marker?.payload as Record<string, unknown> | undefined;
	assert.equal(payload?.continuation, "operator", "operator continuation is distinguishable from bounded recovery");
	assert.deepEqual(payload?.prior_failure, CRASH);
	assert.equal(existsSync(join(home.path, LAYOUT.state, "recovery-attempts.json")), false, "the automatic attempt counter is untouched");
});

test("continueFailed refuses without mutation: live pid, script job, missing session, hazardous git, unresolved envelope", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => runs.closeAll());
	const manager = fakeManager(home.path, t);

	async function refusal(
		jobId: string,
		options: { overrides?: Partial<FleetRecord>; alive?: boolean; detached?: boolean; rebase?: boolean; setup?: (record: FleetRecord) => void } = {},
	): Promise<string> {
		const record = await addFailed(home.path, fleet, jobId, options.overrides);
		options.setup?.(record);
		const gitDir = join(record.worktree, ".git");
		if (options.rebase) mkdirSync(join(gitDir, "rebase-merge"), { recursive: true });
		const reviver = new Reviver({
			home: home.path,
			profilesDir: PROFILES_DIR,
			fleet,
			manager,
			runs,
			isPidAlive: () => options.alive ?? false,
			git: fakeGit(gitDir, options.detached),
		});
		const before = fleet.require(jobId);
		const plan = await reviver.plan(jobId, { continueFailed: true });
		await assert.rejects(() => reviver.revive(jobId, { continueFailed: true }), ReviveError);
		assert.deepEqual(fleet.require(jobId), before, `${jobId}: a refusal mutates nothing`);
		assert.equal(manager.get(jobId), undefined, `${jobId}: nothing spawned`);
		assert.equal(plan.ok, false);
		return plan.ok ? "" : plan.code;
	}

	assert.equal(await refusal("cp-live", { alive: true }), "pid_alive");
	// A script job's unknown exit is never replayed, continuation or not.
	// SAFETY: the fleet contract validates this script record without a worker; FleetRecord still types model readers.
	const script = { job_id: "cp-script", project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: "failed", failure: { ...CRASH, class: "script_exit" }, executor: "script", script_path: "scripts/run.sh", script_process: { pid: DEAD_PID, started_at: isoTimestamp() }, worktree: home.path, branch: "cp-script", dispatched_at: isoTimestamp(), usage: EMPTY_USAGE } as unknown as FleetRecord;
	await fleet.add(script);
	const scriptBefore = fleet.require("cp-script");
	const scriptPlan = await new Reviver({ home: home.path, profilesDir: PROFILES_DIR, fleet, manager, runs, isPidAlive: () => false }).plan("cp-script", { continueFailed: true });
	assert.equal(scriptPlan.ok ? "" : scriptPlan.code, "not_revivable_phase");
	assert.deepEqual(fleet.require("cp-script"), scriptBefore);
	assert.equal(await refusal("cp-nosess", { overrides: { worker: { ...makeRecord({}, home.path).worker, session_file: join(home.path, "never.jsonl") } } }), "session_missing");
	assert.equal(await refusal("cp-detach", { detached: true }), "repo_detached_head");
	assert.equal(await refusal("cp-rebasing", { rebase: true }), "repo_operation_in_progress");
	assert.equal(
		await refusal("cp-unaccepted", {
			setup: () => {
				mkdirSync(join(home.path, paths.runDir("cp-unaccepted")), { recursive: true });
				writeFileSync(join(home.path, paths.envelopeFile("cp-unaccepted")), "{}");
			},
		}),
		"envelope_unresolved",
	);
	assert.equal(
		await refusal("cp-rejected", {
			setup: () => {
				mkdirSync(join(home.path, paths.runDir("cp-rejected")), { recursive: true });
				writeFileSync(join(home.path, paths.runDir("cp-rejected"), "envelope-rejected.json"), "{}");
			},
		}),
		"envelope_unresolved",
	);
});

test("continueFailed: a spawn that fails keeps the failure and the lease", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => runs.closeAll());
	const before = await addFailed(home.path, fleet, "cp-nospawn");
	const reviver = new Reviver({
		home: home.path,
		profilesDir: PROFILES_DIR,
		fleet,
		manager: fakeManager(home.path, t, true),
		runs,
		isPidAlive: () => false,
		git: fakeGit(join(before.worktree, ".git")),
	});
	await assert.rejects(() => reviver.revive("cp-nospawn", { continueFailed: true }), /spawn failed/);
	assert.deepEqual(fleet.require("cp-nospawn"), before);
});

// ---------------------------------------------------------------------------
// 4b-1 (4B1-T7): a revive at the spawn cap releases another held author
// ---------------------------------------------------------------------------

async function capBench(t: { after(fn: () => void | Promise<void>): void }) {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const workers = fakeWorkerManager(home.path, 2);
	t.after(async () => {
		await workers.manager.shutdownAll();
		runs.closeAll();
		home.cleanup();
	});
	const worktree = join(home.path, "worktrees", "cp-aaa1");
	mkdirSync(join(worktree, ".git"), { recursive: true });
	writeFileSync(join(home.path, "s.jsonl"), "{}\n");
	await fleet.add(makeRecord({ job_id: "cp-aaa1", worktree }, home.path));
	await fleet.add(makeRecord({ job_id: "cp-aaa2" }, home.path));
	await fleet.add(makeRecord({ job_id: "cp-aaa3" }, home.path));
	// cp-aaa1 was released earlier; cp-aaa2 is a live idle author, cp-aaa3 busy: the cap (2) is full.
	runs.open("cp-aaa1").cp("held_released", { for_job: "cp-aaa9", reason: "spawn cap" });
	const idle = workers.spawn("cp-aaa2");
	workers.spawn("cp-aaa3", fakeWorker({ busy: true }));
	const held = new HeldRelease({
		home: home.path, fleet, manager: workers.manager,
		busy: { sending: () => false, promoting: () => false, driving: () => false },
		integration: () => undefined, journal: (id, kind, payload) => runs.open(id).cp(kind, payload),
	});
	const reviver = new Reviver({
		home: home.path, profilesDir: PROFILES_DIR, fleet, manager: workers.manager, runs, isPidAlive: () => false,
		git: fakeGit(join(worktree, ".git")),
		makeRoom: (id, role) => held.makeRoom(id, role), released: (id) => held.wasReleased(id),
	});
	return { home: home.path, fleet, workers, idle, reviver };
}

test("4B1-T7: a revive at the cap releases another idle author (never itself) and spawns into the reserved slot", async (t) => {
	const b = await capBench(t);
	await b.reviver.revive("cp-aaa1");
	assert.equal(b.idle.shutdownCalls, 1, "the other idle author was released");
	assert.ok(b.workers.manager.get("cp-aaa1"));
	assert.equal(b.workers.manager.reserved, 0, "the spawn consumed the reservation");
	const revived = readRunEvents(b.home, "cp-aaa1").find((event) => event.type === "worker_revived");
	assert.equal((revived?.payload as { continuation?: string }).continuation, "held_release");
	assert.equal(b.fleet.require("cp-aaa2").phase, "held", "the released author keeps its phase");
});

test("4B1-T7: a failed revive spawn after makeRoom leaves no reservation", async (t) => {
	const b = await capBench(t);
	b.workers.failNext();
	await assert.rejects(() => b.reviver.revive("cp-aaa1"), /spawn failed/);
	assert.equal(b.workers.manager.reserved, 0);
	assert.equal(b.workers.manager.get("cp-aaa1"), undefined);
});
