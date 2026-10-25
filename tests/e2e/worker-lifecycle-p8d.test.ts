/**
 * Behavior 04 (P8d): cp_revive's plan and relaunch, and bounded recovery after a worker death or a hard bound,
 * driven through a real CommandPost, real pi workers on a treehouse pool and the mock provider.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_BUDGET_CONFIG, DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { readRecoveryAttempts } from "../../src/recovery.ts";
import { BOUND_SPENT_PHRASE } from "../../src/failure-announcer.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { formatRevivePlan, ReviveError } from "../../src/revive.ts";
import { MAX_RECOVERY_PROMPTS } from "../../src/settle.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	git,
	MockProvider,
	readRunEvents,
	REPO_ROOT,
	type RecordedRequest,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "worker-lifecycle-p8d e2e needs treehouse on PATH";
const DEAD_PID = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
const CRASH = { class: "crash" as const, message: "worker exited 137", at: isoTimestamp() };
const POLICY_BLOCK = JSON.stringify({ type: "custom", customType: "worker-compaction-policy-block", data: {} });
const BLIND_RETRY = /retry it|treat it as failed|idempotent|safe to retry/i;
const bash = (command: string): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "bash", args: { command } }] });

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

function lastUserText(request: RecordedRequest | undefined): string {
	const users = (request?.body.messages ?? []).filter((message) => message.role === "user");
	const content = users.at(-1)?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? "")).join("") : "";
}

test("P8d revive plan: cp_revive over seeded fleet records refuses each unsafe state by code, surfaces dirt, the interrupted call and the checkpoint, and continues a failed job only on request", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	// Process groups this test starts: a child-less live pid, and a live pid with a live child.
	const lone = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
	const parent = spawn("sh", ["-c", "sleep 60 & wait"], { stdio: "ignore", detached: true });
	t.after(() => {
		for (const pid of [lone.pid, parent.pid]) {
			try {
				process.kill(-(pid as number), "SIGKILL");
			} catch {
				// already gone
			}
		}
		repo.cleanup();
		home.cleanup();
	});
	const fleet = new FleetStore({ home: home.path });
	const tree = (jobId: string): string => {
		const worktree = join(home.path, "worktrees", jobId);
		git(repo.path, "clone", "--quiet", repo.path, worktree);
		return worktree;
	};
	const session = (jobId: string, lines: unknown[] = [{ type: "session", version: 3, id: jobId, timestamp: isoTimestamp(), cwd: "/tmp" }]): string => {
		const file = join(home.path, `${jobId}.jsonl`);
		writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		return file;
	};
	const seed = async (jobId: string, overrides: Partial<FleetRecord> = {}, worker: Partial<FleetRecord["worker"]> = {}): Promise<void> => {
		await fleet.add({
			job_id: jobId, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: isoTimestamp(),
			worker: { pid: DEAD_PID, session_id: jobId, session_file: join(home.path, `${jobId}.jsonl`), profile: "implementer", role: "implementer",
				model: "mock/mock-model", started_at: isoTimestamp(), ...worker },
			worktree: join(home.path, "worktrees", jobId), branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, ...overrides,
		});
	};
	const dangling = [
		{ type: "session", version: 3, id: "s1", timestamp: isoTimestamp(), cwd: "/tmp" },
		{ type: "message", id: "m1", parentId: null, timestamp: isoTimestamp(), message: { role: "user", content: [{ type: "text", text: "run it" }] } },
		{ type: "message", id: "m2", parentId: "m1", timestamp: isoTimestamp(), message: { role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "git rebase --continue" } }] } },
	];

	await seed("cp-done", { phase: "done", closed_at: isoTimestamp() });
	await seed("cp-nosession");
	tree("cp-alive"), session("cp-alive"), await seed("cp-alive", {}, { pid: lone.pid as number });
	tree("cp-child"), session("cp-child"), await seed("cp-child", {}, { pid: parent.pid as number });
	session("cp-noworktree"), await seed("cp-noworktree");
	const rebasing = tree("cp-rebase");
	mkdirSync(join(rebasing, git(rebasing, "rev-parse", "--git-dir"), "rebase-merge"), { recursive: true });
	session("cp-rebase"), await seed("cp-rebase");
	git(tree("cp-detached"), "checkout", "--quiet", "--detach", "HEAD");
	session("cp-detached"), await seed("cp-detached");
	writeFileSync(join(tree("cp-dirty"), "scratch.txt"), "uncommitted\n");
	session("cp-dirty"), await seed("cp-dirty");
	tree("cp-dangling"), session("cp-dangling", dangling), await seed("cp-dangling");
	tree("cp-resolved"), await seed("cp-resolved");
	session("cp-resolved", [...dangling, { type: "message", id: "m3", parentId: "m2", timestamp: isoTimestamp(), message: { role: "toolResult", toolCallId: "call_1", content: [] } }]);
	const ckpt = tree("cp-ckpt");
	git(ckpt, "update-ref", "refs/cp-checkpoints/cp-ckpt", "HEAD");
	const captured = git(ckpt, "rev-parse", "HEAD");
	writeFileSync(join(ckpt, "later.txt"), "later\n");
	git(ckpt, "add", "later.txt");
	git(ckpt, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "--quiet", "-m", "later");
	const head = git(ckpt, "rev-parse", "HEAD");
	session("cp-ckpt"), await seed("cp-ckpt", { checkpoint_ref: "refs/cp-checkpoints/cp-ckpt" });
	const failed = (jobId: string, overrides: Partial<FleetRecord> = {}): Promise<void> => {
		tree(jobId);
		session(jobId, dangling);
		return seed(jobId, { reported_at: undefined, phase: "failed", failure: CRASH, ...overrides });
	};
	await failed("cp-failed");
	await failed("cp-f-live");
	await fleet.patch("cp-f-live", { worker: { ...fleet.require("cp-f-live").worker, pid: lone.pid as number } });
	await failed("cp-f-nosess");
	rmSync(join(home.path, "cp-f-nosess.jsonl"));
	await failed("cp-f-detach");
	git(join(home.path, "worktrees", "cp-f-detach"), "checkout", "--quiet", "--detach", "HEAD");
	await failed("cp-f-rebase");
	const fRebase = join(home.path, "worktrees", "cp-f-rebase");
	mkdirSync(join(fRebase, git(fRebase, "rev-parse", "--git-dir"), "rebase-merge"), { recursive: true });
	for (const [jobId, file] of [["cp-f-unaccepted", paths.envelopeFile("cp-f-unaccepted")], ["cp-f-rejected", join(paths.runDir("cp-f-rejected"), "envelope-rejected.json")]] as const) {
		await failed(jobId);
		mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });
		writeFileSync(join(home.path, file), "{}");
	}
	await failed("cp-f-blocked");
	appendFileSync(join(home.path, "cp-f-blocked.jsonl"), `${POLICY_BLOCK}\n`);
	await failed("cp-f-garbled");
	appendFileSync(join(home.path, "cp-f-garbled.jsonl"), "{\"type\":\n");
	// SAFETY: the fleet contract validates this script record without a worker; FleetRecord still types model readers.
	await fleet.add({ job_id: "cp-script", project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: "failed", failure: { ...CRASH, class: "script_exit" },
		executor: "script", script_path: "scripts/run.sh", script_process: { pid: DEAD_PID, started_at: isoTimestamp() }, worktree: home.path, branch: "cp-script",
		dispatched_at: isoTimestamp(), usage: EMPTY_USAGE } as unknown as FleetRecord);
	tree("cp-blocked"), session("cp-blocked"), await seed("cp-blocked", { phase: "waiting", reported_at: undefined });
	appendFileSync(join(home.path, "cp-blocked.jsonl"), `${POLICY_BLOCK}\n`);
	tree("cp-garbled"), writeFileSync(join(home.path, "cp-garbled.jsonl"), "not json\n"), await seed("cp-garbled", { phase: "waiting", reported_at: undefined });

	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => post.shutdown());
	const code = async (jobId: string, continueFailed = false): Promise<string> => {
		const plan = await post.revivePlan(jobId, { continueFailed });
		return plan.ok ? "ok" : plan.code;
	};

	assert.deepEqual(
		[await code("cp-nope"), await code("cp-done"), await code("cp-nosession"), await code("cp-alive"), await code("cp-noworktree"), await code("cp-detached")],
		["not_found", "not_revivable_phase", "session_missing", "pid_alive", "worktree_missing", "repo_detached_head"],
	);
	const child = await post.revivePlan("cp-child");
	assert.equal(child.ok ? "" : child.code, "tool_child_alive");
	assert.match(child.ok ? "" : child.message, new RegExp(`pid ${parent.pid} has live child process\\(es\\) \\d+ .*Nothing was signalled`, "s"));
	assert.equal(alive(parent.pid as number), true, "the refusal signals nothing");
	const rebase = await post.revivePlan("cp-rebase");
	assert.deepEqual(rebase.ok ? [] : [rebase.code, /rebase/.test(rebase.message)], ["repo_operation_in_progress", true]);
	assert.match(formatRevivePlan(rebase), /cp-rebase: revive refused \(repo_operation_in_progress\)/);
	await assert.rejects(post.revive("cp-nosession"), (error: unknown) => error instanceof ReviveError && /session_missing/.test(error.message));

	const dirty = await post.revivePlan("cp-dirty");
	assert.equal(dirty.ok && dirty.worktreeDirty, true, "dirt is surfaced, never refused");
	assert.match(formatRevivePlan(dirty), /cp-dirty: revivable .*uncommitted changes/);
	const interrupted = await post.revivePlan("cp-dangling");
	assert.deepEqual(interrupted.ok && interrupted.interruptedTool, { name: "bash", arguments: { command: "git rebase --continue" }, toolCallId: "call_1" });
	for (const text of [/interrupted tool: bash/, /told this call produced no result/]) assert.match(formatRevivePlan(interrupted), text);
	const resolved = await post.revivePlan("cp-resolved");
	assert.equal(resolved.ok && resolved.interruptedTool, undefined, "a resolved call is not interrupted");

	const checkpoint = await post.revivePlan("cp-ckpt");
	assert.deepEqual(checkpoint.ok && checkpoint.checkpoint, { ref: "refs/cp-checkpoints/cp-ckpt", sha: captured });
	assert.match(formatRevivePlan(checkpoint), new RegExp(`checkpoint refs/cp-checkpoints/cp-ckpt at ${captured} \\(dispatch-time HEAD; shown, never restored\\)`));
	assert.deepEqual([git(ckpt, "rev-parse", "HEAD"), git(ckpt, "status", "--porcelain")], [head, ""], "planning never resets HEAD");
	git(ckpt, "update-ref", "-d", "refs/cp-checkpoints/cp-ckpt");
	const missing = await post.revivePlan("cp-ckpt");
	assert.deepEqual(missing.ok && missing.checkpoint, { ref: "refs/cp-checkpoints/cp-ckpt" }, "a deleted ref is shown missing, not refused");
	assert.match(formatRevivePlan(missing), /checkpoint refs\/cp-checkpoints\/cp-ckpt missing/);

	const before = fleet.require("cp-failed");
	const refused = await post.revivePlan("cp-failed");
	assert.deepEqual(refused.ok ? [] : [refused.code, /continue_failed:true/.test(refused.message)], ["not_revivable_phase", true]);
	const continued = await post.revivePlan("cp-failed", { continueFailed: true });
	assert.deepEqual(continued.ok && [continued.session_file, continued.worktree, continued.continuesFailure, continued.interruptedTool?.name],
		[before.worker.session_file, before.worktree, CRASH, "bash"]);
	for (const text of [/continues failed job \(crash: worker exited 137\)/, /counter is not reset/]) assert.match(formatRevivePlan(continued), text);
	assert.deepEqual(new FleetStore({ home: home.path }).require("cp-failed"), before, "planning mutates nothing");

	const refusals: Record<string, string> = {
		"cp-f-live": "pid_alive", "cp-script": "not_revivable_phase", "cp-f-nosess": "session_missing", "cp-f-detach": "repo_detached_head",
		"cp-f-rebase": "repo_operation_in_progress", "cp-f-unaccepted": "envelope_unresolved", "cp-f-rejected": "envelope_unresolved",
		"cp-f-blocked": "session_policy_blocked", "cp-f-garbled": "session_scan_failed",
	};
	for (const [jobId, expected] of Object.entries(refusals)) {
		const unchanged = fleet.require(jobId);
		assert.equal(await code(jobId, true), expected, jobId);
		await assert.rejects(post.revive(jobId, { continueFailed: true }), ReviveError);
		assert.deepEqual(new FleetStore({ home: home.path }).require(jobId), unchanged, `${jobId}: a refusal mutates nothing`);
		assert.equal(post.manager.get(jobId), undefined, `${jobId}: nothing spawned`);
	}
	await assert.rejects(post.revive("cp-blocked"), /session_policy_blocked/);
	const garbled = await post.revivePlan("cp-garbled");
	assert.equal(garbled.ok ? "" : garbled.code, "session_scan_failed");
	assert.ok(!garbled.ok && garbled.message.includes(join(home.path, "cp-garbled.jsonl")), "the scan error names the path");
	assert.equal(post.manager.get("cp-blocked"), undefined);
});

interface Bench {
	home: string;
	clone: string;
	post: CommandPost;
	provider: MockProvider;
	job(slug: string, delivery?: "local" | "pr"): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
	dispatch(jobId: string, model: string, extra?: { risk?: "high"; skills?: string[]; toolCallCap?: number }): Promise<string>;
	events(jobId: string, type: string): Array<Record<string, unknown>>;
	escalations(jobId: string): string[];
	installSkill(name: string): string;
	toolStarts(jobId: string): number;
}

async function bench(t: { after(fn: () => void | Promise<void>): void }): Promise<Bench> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agentDir.env } });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 5 });
	t.after(async () => {
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// pool root is removed next
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});
	return {
		home: home.path,
		clone,
		post,
		provider,
		async job(slug, delivery = "local") {
			return (await post.ledger().create({ title: slug, project: "demo", delivery, kind: "ship", slug })).id;
		},
		script(name, steps) {
			const model = provider.addScript(name, steps);
			agentDir.writeModels(provider);
			return model;
		},
		async dispatch(jobId, model, extra = {}) {
			return (await post.dispatch({ jobId, task: `Brief for ${jobId}.`, model, fetch: false, toolCallCap: extra.toolCallCap ?? 100,
				...(extra.risk ? { risk: extra.risk } : {}), ...(extra.skills ? { skills: extra.skills } : {}) })).worktree;
		},
		events(jobId, type) {
			return readRunEvents(home.path, jobId).filter((event) => event.source === "cp" && event.type === type)
				.map((event) => (event.payload ?? {}) as Record<string, unknown>);
		},
		escalations(jobId) {
			return post.escalations.list({ jobId }).map((record) => JSON.stringify(record));
		},
		installSkill(name) {
			const dir = join(home.path, "skills", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
			return realpathSync(dir);
		},
		toolStarts(jobId) {
			return readRunEvents(home.path, jobId).filter((event) => event.source === "pi" && event.type === "tool_execution_start").length;
		},
	};
}

const attempts = (f: Bench, jobId: string): number => readRecoveryAttempts(f.home, jobId, "crash") + readRecoveryAttempts(f.home, jobId, "tool_call_cap_exceeded");

test("P8d continue: a risk:high worker killed mid-call is failed as a crash and never auto-recovered; continue_failed relaunches it idle on its session, lease and re-resolved skills", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await bench(t);
	const skillDir = f.installSkill("tdd-x");
	const jobId = await f.job("cut");
	const model = f.script("cut", [bash("echo RAN >> marker.log && sleep 20"), { kind: "text", text: "resumed" }, { kind: "hang" }]);
	const worktree = await f.dispatch(jobId, model, { risk: "high", skills: ["tdd-x"] });
	await waitFor(() => existsSync(join(worktree, "marker.log")), Boolean, { timeoutMs: 60_000, what: "the tool actually ran" });
	const before = f.post.fleet.require(jobId);
	assert.deepEqual(before.skills?.map((skill) => skill.name), ["tdd-x"]);
	assert.match(lastUserText(f.provider.requests("cut")[0]), /Skills the operator named for this job: `tdd-x`/);
	assert.ok(JSON.stringify(f.provider.requests("cut")[0]?.body.messages?.[0]?.content).includes(`${skillDir}/SKILL.md`), "pi loaded the named skill");
	assert.equal(before.checkpoint_ref, `refs/cp-checkpoints/${jobId}`);
	assert.equal(git(worktree, "for-each-ref", "--format=%(objectname)", before.checkpoint_ref), git(worktree, "rev-parse", "HEAD"), "dispatch-time HEAD");
	assert.equal(git(worktree, "branch", "--list", "--all").includes("cp-checkpoints"), false, "the ref is outside refs/heads and refs/remotes");

	process.kill(before.worker.pid, "SIGKILL");
	const dead = await waitFor(() => f.post.fleet.require(jobId), (job) => job.phase === "failed", { timeoutMs: 30_000, what: "the recorded death" });
	assert.equal(dead.failure?.class, "crash", "an exit with no settle is a crash");
	assert.match(dead.failure?.message ?? "", /without reporting/);
	await waitFor(() => f.escalations(jobId).length, (n) => n === 1, { timeoutMs: 15_000, what: "the risk:high escalation" });
	assert.match(f.escalations(jobId)[0] ?? "", /risk:high/);
	assert.deepEqual([f.events(jobId, "recovery_attempted").length, attempts(f, jobId)], [0, 0], "never auto-recovered");

	assert.equal((await f.post.revivePlan(jobId)).ok, false, "a failed job needs continue_failed");
	rmSync(join(f.home, "skills", "tdd-x"), { recursive: true });
	const vanished = await f.post.revivePlan(jobId, { continueFailed: true });
	assert.equal(vanished.ok ? "" : vanished.code, "skill_unresolved");
	assert.match(vanished.ok ? "" : vanished.message, /skill tdd-x is not installed .* reinstall it, or tear the job down and re-dispatch without it/);
	f.installSkill("tdd-x");
	await f.post.fleet.patch(jobId, { skills: [{ name: "tdd-x", dir: "/stale/recorded/dir" }] });
	const plan = await f.post.revivePlan(jobId, { continueFailed: true });
	assert.deepEqual(plan.ok && [plan.interruptedTool?.name, plan.continuesFailure?.class, plan.skills], ["bash", "crash", [{ name: "tdd-x", dir: skillDir }]]);

	const revived = await f.post.revive(jobId, { continueFailed: true });
	assert.notEqual(revived.pid, before.worker.pid, "a new process, not a reattachment");
	assert.deepEqual([revived.session_file, revived.interruptedTool?.name, revived.continuedFailure?.class], [before.worker.session_file, "bash", "crash"]);
	const after = f.post.fleet.require(jobId);
	assert.deepEqual([after.phase, after.failure, after.worker.pid, after.worker.session_file, after.worker.model, after.worktree, after.branch],
		["waiting", undefined, revived.pid, before.worker.session_file, before.worker.model, before.worktree, before.branch]);
	const marker = f.events(jobId, "worker_revived").at(-1);
	assert.deepEqual([marker?.continuation, (marker?.prior_failure as { class?: string })?.class], ["operator", "crash"]);
	assert.equal(attempts(f, jobId), 0, "the automatic counter is untouched");

	await new Promise((resolve) => setTimeout(resolve, 1_500));
	assert.equal(f.provider.requests("cut").length, 1, "idle until prompted");
	assert.equal(readFileSync(join(worktree, "marker.log"), "utf8"), "RAN\n", "the interrupted call never re-runs");
	await f.post.send({ jobId, message: "Continue from where you stopped." });
	await waitFor(() => f.provider.requests("cut").length, (n) => n === 2, { timeoutMs: 30_000, what: "the revived worker's answer" });
	assert.match(lastUserText(f.provider.requests("cut")[1]), /Continue from where you stopped/, "the revive itself prompted nothing");
	const system = JSON.stringify(f.provider.requests("cut")[1]?.body.messages?.find((message) => message.role === "system")?.content ?? "");
	assert.ok(system.includes(`${skillDir}/SKILL.md`) && !system.includes("/stale/recorded/dir"), "pi loaded the re-resolved skill, not the record's");
});

test("P8d recovery: a bound redispatches into the same worktree with its evidence, a death revives once on the same session naming the cut-off call, and the second death escalates", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await bench(t);
	let resume = (): void => {};
	const resumed = new Promise<void>((resolve) => (resume = resolve));
	const bounded = await f.job("chain");
	await f.dispatch(bounded, f.script("chain", [bash("echo work > app.txt"), bash("echo two"), bash("sleep 5"), { kind: "hang", until: resumed },
		bash("echo a"), bash("echo b"), bash("sleep 5"), { kind: "hang" }]), { toolCallCap: 2 });
	const first = f.post.fleet.require(bounded).worker;
	await waitFor(() => f.events(bounded, "recovery_attempted").length, (n) => n === 1, { timeoutMs: 60_000, what: "the bound's redispatch" });
	const redispatched = await waitFor(() => f.post.fleet.require(bounded), (job) => job.phase === "waiting" && job.worker.pid !== first.pid, { timeoutMs: 30_000, what: "the fresh worker" });
	assert.notEqual(redispatched.worker.session_file, first.session_file, "a redispatch is a fresh session, never the bound one resumed");
	const evidence = await waitFor(() => lastUserText(f.provider.requests("chain")[3]), Boolean, { timeoutMs: 30_000, what: "the redispatch brief" });
	for (const text of [/SAME worktree/, /app\.txt/, /Do NOT redo the work/]) assert.match(evidence, text);
	assert.deepEqual(f.events(bounded, "recovery_attempted").map((event) => [event.class, event.attempt]), [["tool_call_cap_exceeded", 1]]);
	const bound = () => f.post.durableWakeups.pending().filter((entry) => entry.job_id === bounded && entry.kind === "bound");
	assert.equal(bound().length, 0, "a recovered bound announces nothing");
	resume();
	const spent = await waitFor(bound, (rows) => rows.length === 1, { timeoutMs: 60_000, what: "the second bound's wake-up" });
	assert.ok(spent[0]?.content.includes(BOUND_SPENT_PHRASE), "the second bound is spent, not attempted");
	assert.deepEqual([f.escalations(bounded).length, f.events(bounded, "recovery_attempted").length], [1, 1]);
	assert.deepEqual([readRecoveryAttempts(f.home, bounded, "tool_call_cap_exceeded"), readRecoveryAttempts(f.home, bounded, "crash")], [1, 0], "counted per class");

	const idle = await f.job("idle");
	await f.dispatch(idle, f.script("idle", [{ kind: "hang" }, { kind: "hang" }]));
	await waitFor(() => f.provider.requests("idle").length, (n) => n === 1, { timeoutMs: 30_000, what: "the idle worker's request" });
	process.kill(f.post.fleet.require(idle).worker.pid, "SIGKILL");
	const blind = await waitFor(() => lastUserText(f.provider.requests("idle")[1]), Boolean, { timeoutMs: 60_000, what: "the no-call revive brief" });
	assert.match(blind, /No result provided/);
	assert.doesNotMatch(blind, /call id/);
	assert.doesNotMatch(blind, BLIND_RETRY);

	const jobId = await f.job("dies");
	await f.dispatch(jobId, f.script("dies", [bash("echo RAN >> marker.log && sleep 20 # ARG-MARKER-7"), bash("sleep 20"), { kind: "hang" }]));
	await waitFor(() => f.toolStarts(jobId), (n) => n === 1, { timeoutMs: 30_000, what: "the first call" });
	const dying = f.post.fleet.require(jobId).worker;
	process.kill(dying.pid, "SIGKILL");
	const revived = await waitFor(() => f.post.fleet.require(jobId), (job) => job.phase === "waiting" && job.worker.pid !== dying.pid, { timeoutMs: 60_000, what: "the automatic revive" });
	assert.equal(revived.worker.session_file, dying.session_file, "a revive resumes the same session");
	const brief = await waitFor(() => lastUserText(f.provider.requests("dies")[1]), Boolean, { timeoutMs: 30_000, what: "the revive brief" });
	for (const text of [/revived on this same session/, /do not redo work/, /bash \(call id [^)]+\)/, /does not say whether it ran/, /unresolved in report_result/]) assert.match(brief, text);
	assert.doesNotMatch(brief, /ARG-MARKER-7/, "the brief names the call, never its arguments");
	assert.doesNotMatch(brief, BLIND_RETRY);
	assert.deepEqual(f.events(jobId, "recovery_attempted").map((event) => [event.class, event.attempt, event.send_receipt]), [["crash", 1, "delivered"]]);
	assert.equal(f.escalations(jobId).length, 0);

	await waitFor(() => f.toolStarts(jobId), (n) => n === 2, { timeoutMs: 30_000, what: "the revived worker's call" });
	process.kill(revived.worker.pid, "SIGKILL");
	await waitFor(() => f.escalations(jobId).length, (n) => n === 1, { timeoutMs: 30_000, what: "the second death's escalation" });
	assert.match(f.escalations(jobId)[0] ?? "", /crash/);
	assert.equal(f.post.fleet.require(jobId).phase, "failed");
	assert.equal(f.events(jobId, "recovery_attempted").length, 1, "no further brief");
	assert.equal(f.provider.requests("dies").length, 2);
});

test("P8d recovery refusals: a tool loop escalates without a revive, a policy-blocked session spends its attempt and escalates, and a redispatch whose skill vanished is announced once", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await bench(t);
	const [loop, blocked, skilled] = [await f.job("loop"), await f.job("blocked"), await f.job("skilled")];
	await f.dispatch(loop, f.script("loop", [...Array.from({ length: 6 }, () => bash("echo same")), bash("sleep 20"), { kind: "hang" }]));
	await f.dispatch(blocked, f.script("blocked", [bash("sleep 20"), { kind: "hang" }]));
	f.installSkill("tdd-e");
	let release = (): void => {};
	const removed = new Promise<void>((resolve) => (release = resolve));
	await f.dispatch(skilled, f.script("skilled", [bash("echo one"), { kind: "hang", until: removed }, bash("sleep 5"), { kind: "hang" }]), { skills: ["tdd-e"], toolCallCap: 1 });

	await waitFor(() => f.toolStarts(loop), (n) => n === 7, { timeoutMs: 60_000, what: "the looping worker's last call" });
	process.kill(f.post.fleet.require(loop).worker.pid, "SIGKILL");
	await waitFor(() => f.escalations(loop).length, (n) => n === 1, { timeoutMs: 30_000, what: "the loop's escalation" });
	assert.equal(f.post.fleet.require(loop).failure?.class, "tool_loop");
	assert.match(f.post.fleet.require(loop).failure?.message ?? "", /repeated 6 times/);
	assert.match(f.escalations(loop)[0] ?? "", /policy cause/);
	assert.equal(f.events(loop, "recovery_attempted").length, 0, "never revived");

	await waitFor(() => f.toolStarts(blocked), (n) => n === 1, { timeoutMs: 30_000, what: "the blocked worker's call" });
	const worker = f.post.fleet.require(blocked).worker;
	appendFileSync(worker.session_file, `${POLICY_BLOCK}\n`);
	process.kill(worker.pid, "SIGKILL");
	await waitFor(() => f.escalations(blocked).length, (n) => n === 1, { timeoutMs: 30_000, what: "the refused revive's escalation" });
	assert.match(f.escalations(blocked)[0] ?? "", /could not revive .*session_policy_blocked/s);
	assert.deepEqual([f.post.fleet.require(blocked).phase, f.post.manager.get(blocked)], ["failed", undefined], "nothing spawned");
	assert.equal(readRecoveryAttempts(f.home, blocked, "crash"), 1, "the refused revive still spent its attempt");

	rmSync(join(f.home, "skills", "tdd-e"), { recursive: true });
	release();
	const bound = () => f.post.durableWakeups.pending().filter((entry) => entry.job_id === skilled && entry.kind === "bound");
	const rows = await waitFor(bound, (found) => found.length === 1, { timeoutMs: 60_000, what: "the refused redispatch's wake-up" });
	assert.match(rows[0]?.content ?? "", /attempted, not revived \(automatic recovery could not redispatch .*skill_unresolved/s);
	assert.doesNotMatch(rows[0]?.content ?? "", /did not stick/);
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	assert.equal(bound().length, 1, "announced once, never a preview");
	assert.equal(f.escalations(skilled).length, 1);
	assert.equal(f.post.manager.get(skilled), undefined, "nothing spawned");
});

test("P8d unreported bound: a spent count written to the fleet file by another store is the budget a live settle reads; the same job without it is prompted", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const f = await bench(t);
	let seed = (): void => {};
	const seeded = new Promise<void>((resolve) => (seed = resolve));
	const [spent, fresh] = [await f.job("spent"), await f.job("fresh")];
	for (const jobId of [spent, fresh]) await f.dispatch(jobId, f.script(jobId === spent ? "spent" : "fresh", [bash("echo x > w.txt && echo ok"), { kind: "hang", until: seeded }, { kind: "hang" }]));
	await waitFor(() => f.provider.requests("spent").length + f.provider.requests("fresh").length, (n) => n === 4, { timeoutMs: 60_000, what: "both turns held open" });
	// What a restarted parent finds: the count on disk, written by a store that shares no memory with this post.
	await new FleetStore({ home: f.home }).patch(spent, { unreported_settles: MAX_RECOVERY_PROMPTS });
	seed();

	await waitFor(() => f.events(spent, "recovery_exhausted").length, (n) => n === 1, { timeoutMs: 60_000, what: "the spent budget's record" });
	assert.deepEqual([f.events(spent, "recovery_prompted").length, f.provider.requests("spent").length], [0, 2], "a spent budget on disk is not a new one");
	assert.equal(f.post.fleet.require(spent).unreported_settles, MAX_RECOVERY_PROMPTS + 1);
	await waitFor(() => f.events(fresh, "recovery_prompted").length, (n) => n === 1, { timeoutMs: 60_000, what: "the fresh job's first prompt" });
	assert.equal(f.events(fresh, "recovery_prompted")[0]?.attempt, 1);
});

test("P8d release: a revive at the spawn cap releases the other idle held author, never itself, and spawns into the reserved slot", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await bench(t);
	writeFileSync(join(f.home, LAYOUT.budgetsFile), JSON.stringify({ ...DEFAULT_BUDGET_CONFIG, spawn_cap: 1 }));
	const sha = git(f.clone, "rev-parse", "HEAD");
	const author = async (slug: string, pr: number): Promise<string> => {
		const jobId = await f.job(slug, "pr");
		const model = f.script(slug, [bash("git push -q --set-upstream origin HEAD"), { kind: "tool_calls", calls: [{ name: "report_result", args: {
			job_id: jobId, kind: "ship", status: "done", summary: "Fixture delivery.", branch: jobId, head_sha: sha, pr_url: `https://github.com/example/demo/pull/${pr}` } }] },
			{ kind: "text", text: "reported" }, { kind: "hang" }]);
		await f.dispatch(jobId, model);
		await waitFor(() => f.post.fleet.get(jobId), (record) => record?.phase === "held" && f.post.manager.get(jobId)?.worker.busy === false, { timeoutMs: 60_000, what: `${slug} held and idle` });
		return jobId;
	};
	const first = await author("first", 1);
	const second = await author("second", 2);
	assert.equal(f.post.manager.get(first), undefined, "the second dispatch released the first author");

	const revived = await f.post.revive(first);
	assert.equal(f.post.manager.get(first)?.worker.pid, revived.pid);
	assert.equal(f.post.manager.get(second), undefined, "the other idle author was released");
	assert.equal(f.post.manager.reserved, 0, "the spawn consumed the reservation");
	assert.equal(f.events(first, "worker_revived").at(-1)?.continuation, "held_release");
	assert.deepEqual([f.post.fleet.require(first).phase, f.post.fleet.require(second).phase], ["held", "held"], "a release keeps each phase");
	assert.equal(f.events(second, "held_released").at(-1)?.for_job, first);
});
