/**
 * Behavior 04 (P8): worker provider failures, the outer retry ladder, failed-job continuation and repeated bound
 * wake-ups, driven through a real CommandPost, real pi workers on a treehouse pool and a mock provider.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { paths } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { RESUME_NUDGE } from "../../src/provider-retry.ts";
import { formatSettleOutcome, REPORT_NUDGE_TEXT, type SettleOutcome } from "../../src/settle.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readRunEvents,
	REPO_ROOT,
	type RecordedRequest,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "worker-recovery e2e needs treehouse on PATH";

interface Fleet {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	settles: Array<{ jobId: string; outcome: SettleOutcome }>;
	job(slug: string): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
	dispatch(jobId: string, model: string, extra?: { toolCallCap?: number }): Promise<string>;
	events(jobId: string, type?: string): Array<{ type: string; payload: Record<string, unknown> }>;
}

async function fleet(t: { after(fn: () => void | Promise<void>): void }, maxTrees = 3): Promise<Fleet> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	// pi's own inner retry is off so each provider error reaches command-post's outer ladder at once.
	const agentDir = createAgentDir({ provider, settings: { retry: { enabled: false } } });
	initJobsDocument(home.path, "cp");
	const settles: Fleet["settles"] = [];
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
		parentEnv: { ...process.env, ...agentDir.env },
		onUnreportedSettle: (jobId, outcome) => settles.push({ jobId, outcome }),
	});
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees });
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
		post,
		provider,
		settles,
		async job(slug) {
			return (await post.ledger().create({ title: slug, project: "demo", delivery: "local", kind: "ship", slug })).id;
		},
		script(name, steps) {
			const model = provider.addScript(name, steps, { onExhausted: "repeat" });
			agentDir.writeModels(provider);
			return model;
		},
		async dispatch(jobId, model, extra = {}) {
			const dispatched = await post.dispatch({ jobId, task: `Brief for ${jobId}.`, model, fetch: false, wallClockSeconds: 600, toolCallCap: extra.toolCallCap ?? 100 });
			return dispatched.worktree;
		},
		events(jobId, type) {
			const events = readRunEvents(home.path, jobId).filter((event) => event.source === "cp")
				.map((event) => ({ type: event.type, payload: (event.payload ?? {}) as Record<string, unknown> }));
			return type ? events.filter((event) => event.type === type) : events;
		},
	};
}

/** Every user-role message text in one provider request, in order. */
function userTexts(request: RecordedRequest): string[] {
	return (request.body.messages ?? []).filter((message) => message.role === "user").map((message) => {
		const content = message.content;
		if (typeof content === "string") return content;
		return Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? "")).join("") : "";
	});
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** The outer ladder's named policy, pinned literally: five rungs, doubling from 5 s. */
const LADDER = [5_000, 10_000, 20_000, 40_000, 80_000];

test("04-1: a transient provider error resumes the same session after the ladder's first delay, and the job still reports", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.job("transient");
	let worktree = "";
	const model = f.script("transient", [
		{ kind: "error", status: 529, message: "overloaded, try again" },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo resumed > resumed.txt && git add -A && git -c user.email=w@w -c user.name=w commit -q -m resumed && git push -q -u origin HEAD" } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: jobId, kind: "ship", status: "done", summary: "Resumed and delivered.", branch: jobId, head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim() }) }] },
		{ kind: "text", text: "reported" },
	]);
	worktree = await f.dispatch(jobId, model);
	const [attempt] = await waitFor(() => f.events(jobId, "outer_retry_attempt"), (rows) => rows.length === 1, { timeoutMs: 30_000, what: "first outer attempt" });
	assert.deepEqual([attempt?.payload.attempt, attempt?.payload.delayMs], [1, LADDER[0]]);
	assert.equal(f.post.fleet.require(jobId).phase, "waiting", "a dead-on-arrival turn the ladder claimed is not failed");
	assert.equal(f.provider.requests("transient").length, 1, "nothing is sent before the ladder's delay");

	await waitFor(() => f.post.fleet.require(jobId).phase, (phase) => phase === "held", { timeoutMs: 60_000, what: "the envelope after the resume" });
	const requests = f.provider.requests("transient");
	const resumed = requests[1]!;
	assert.equal(userTexts(resumed).at(-1), RESUME_NUDGE, "the retry is the resume nudge");
	assert.equal(userTexts(resumed).filter((text) => text.includes(`Brief for ${jobId}.`)).length, 1, "the brief is never re-sent");
	assert.ok(resumed.at - requests[0]!.at >= LADDER[0]!, "the resume waits out the first delay");
	assert.equal(requests.some((request) => userTexts(request).includes(REPORT_NUDGE_TEXT)), false, "no report nudge mid-ladder");
	assert.deepEqual(f.events(jobId, "outer_retry_succeeded").map((event) => event.payload.afterAttempts), [1]);
	assert.deepEqual(f.events(jobId, "report_nudged"), []);
	assert.deepEqual(f.settles, []);
});

test("04-2: a transient error that outlives the ladder after real work fails the job, stops its worker, and continue_failed resumes it", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.job("exhausted");
	let worktree = "";
	const model = f.script("exhausted", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo prior > prior.txt && echo wrote" } }] },
		{ kind: "error", status: 503, message: "No available accounts", repeat: 6 },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "git add -A && git -c user.email=w@w -c user.name=w commit -q -m prior && git push -q -u origin HEAD" } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: jobId, kind: "ship", status: "done", summary: "Continued after the outage.", branch: jobId, head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim() }) }] },
		{ kind: "text", text: "reported" },
	]);
	worktree = await f.dispatch(jobId, model);
	const pid = f.post.fleet.require(jobId).worker.pid;
	await waitFor(() => f.events(jobId, "outer_retry_attempt").length, (n) => n === 4, { timeoutMs: 60_000, what: "four outer attempts" });
	assert.equal(f.post.fleet.require(jobId).phase, "waiting", "not failed while the ladder still runs");
	const failed = await waitFor(() => f.post.fleet.require(jobId), (record) => record.phase === "failed", { timeoutMs: 200_000, what: "the spent ladder" });

	assert.deepEqual(f.events(jobId, "outer_retry_attempt").map((event) => [event.payload.attempt, event.payload.delayMs]), LADDER.map((delay, i) => [i + 1, delay]));
	assert.deepEqual(f.events(jobId, "outer_retry_exhausted").map((event) => event.payload.attempts), [LADDER.length]);
	assert.equal(failed.failure?.class, "model_call_failed");
	assert.match(failed.failure?.message ?? "", /No available accounts/);
	assert.match(failed.failure?.message ?? "", /continue_failed/);
	assert.equal(failed.unreported_settles, undefined, "the report budget is untouched");
	const requests = f.provider.requests("exhausted");
	assert.equal(requests.length, 2 + LADDER.length, "one resume per rung, nothing after the cap");
	assert.deepEqual(requests.slice(2).map((request) => userTexts(request).at(-1)), LADDER.map(() => RESUME_NUDGE));
	assert.equal(requests.some((request) => userTexts(request).includes(REPORT_NUDGE_TEXT)), false, "never a report nudge");
	assert.deepEqual([f.events(jobId, "report_nudged"), f.events(jobId, "settled_without_report")], [[], []]);
	await waitFor(() => f.settles.length, (n) => n > 0, { timeoutMs: 10_000, what: "the settle outcome" });
	assert.deepEqual(f.settles.map(({ jobId: id, outcome }) => [id, outcome.action, outcome.action === "recorded" ? outcome.reason : undefined]), [[jobId, "recorded", "outer provider retry exhausted"]]);
	assert.match(formatSettleOutcome(jobId, f.settles[0]!.outcome) ?? "", /model call failed — /);
	await waitFor(() => alive(pid), (live) => !live, { timeoutMs: 15_000, what: "the failed job's worker to stop" });
	assert.equal(f.post.manager.get(jobId), undefined, "and unregistered");

	const plan = await f.post.revivePlan(jobId, { continueFailed: true });
	assert.equal(plan.ok, true, JSON.stringify(plan));
	const revived = await f.post.revive(jobId, { continueFailed: true });
	assert.notEqual(revived.pid, pid);
	assert.equal(revived.continuedFailure?.class, "model_call_failed");
	await f.post.send({ jobId, message: "The provider recovered; continue from where you stopped." });
	await waitFor(() => f.post.fleet.require(jobId).phase, (phase) => phase === "held", { timeoutMs: 60_000, what: "the continued worker's envelope" });
});

const TRANSIENT: Array<[number, string]> = [[529, "overloaded"], [429, "rate limited, try again"], [502, "Bad Gateway"], [400, "ECONNRESET"], [400, "request timed out"]];
// Quota, usage and credit errors arrive on retryable statuses, so only the never-retry rule keeps them off the ladder.
const NEVER: Array<[number, string]> = [[503, "quota exceeded for this project"], [529, "usage limit reached"], [401, "Invalid API key"], [503, "insufficient credit balance"], [400, "something odd nobody has seen before"]];

test("04-3: only capacity and connectivity errors enter the ladder; quota, auth and unknown errors fail at once, stop the worker and continue on demand", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await fleet(t, 12);
	const jobs: Array<{ jobId: string; script: string; transient: boolean; message: string; pid: number }> = [];
	for (const [transient, rows] of [[true, TRANSIENT], [false, NEVER]] as const) {
		for (const [status, message] of rows) {
			const script = `${transient ? "t" : "n"}-${jobs.length}`;
			const jobId = await f.job(script);
			await f.dispatch(jobId, f.script(script, [{ kind: "error", status, message }, { kind: "hang" }]));
			jobs.push({ jobId, script, transient, message, pid: f.post.fleet.require(jobId).worker.pid });
		}
	}
	for (const job of jobs) {
		if (job.transient) {
			const rows = await waitFor(() => f.events(job.jobId, "outer_retry_attempt"), (found) => found.length === 1, { timeoutMs: 30_000, what: `${job.message} on the ladder` });
			assert.match(String(rows[0]?.payload.message), new RegExp(job.message), job.message);
			assert.equal(f.post.fleet.require(job.jobId).phase, "waiting", job.message);
			continue;
		}
		const failed = await waitFor(() => f.post.fleet.require(job.jobId), (record) => record.phase === "failed", { timeoutMs: 30_000, what: `${job.message} failed` });
		assert.equal(failed.failure?.class, "model_call_failed", job.message);
		assert.match(failed.failure?.message ?? "", /never ran a turn/, job.message);
		assert.deepEqual(f.events(job.jobId, "outer_retry_attempt"), [], `${job.message} is never retried`);
		assert.equal(f.provider.requests(job.script).length, 1, job.message);
		await waitFor(() => alive(job.pid), (live) => !live, { timeoutMs: 15_000, what: `${job.message} worker stopped` });
		assert.equal(f.post.manager.get(job.jobId), undefined, `${job.message} worker unregistered`);
	}
	const auth = jobs.find((job) => job.message === "Invalid API key")!;
	const plan = await f.post.revivePlan(auth.jobId, { continueFailed: true });
	assert.equal(plan.ok, true, JSON.stringify(plan));
	const revived = await f.post.revive(auth.jobId, { continueFailed: true });
	assert.notEqual(revived.pid, auth.pid);
	assert.equal(f.post.fleet.require(auth.jobId).phase, "waiting");
	assert.equal(f.post.manager.get(auth.jobId)?.worker.pid, revived.pid);
});

test("04-4: continue_failed closes a failed job's still-registered worker before it relaunches", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.job("stale-worker");
	const model = f.script("stale-worker", [{ kind: "hang", ms: 1000 }, { kind: "text", text: "idle" }]);
	await f.dispatch(jobId, model);
	const pid = f.post.fleet.require(jobId).worker.pid;
	await waitFor(() => f.provider.requests("stale-worker").length, (n) => n > 0, { timeoutMs: 15_000, what: "the worker's first request" });
	// The worker-reporter's own exhausted-repair record: the job fails envelope_invalid with its worker left running.
	const rejected = join(f.home, paths.runDir(jobId), "envelope-rejected.json");
	mkdirSync(join(rejected, ".."), { recursive: true });
	writeFileSync(rejected, "{}");
	await waitFor(() => f.post.fleet.require(jobId).failure?.class, (cls) => cls === "envelope_invalid", { timeoutMs: 30_000, what: "envelope_invalid" });
	assert.equal(f.post.manager.get(jobId)?.worker.pid, pid, "the failed job's worker is still registered");
	assert.equal(alive(pid), true);

	const unresolved = await f.post.revivePlan(jobId, { continueFailed: true });
	assert.equal(unresolved.ok ? "" : unresolved.code, "envelope_unresolved");
	renameSync(rejected, `${rejected}.inspected`);
	const plan = await f.post.revivePlan(jobId, { continueFailed: true });
	assert.equal(plan.ok, true, JSON.stringify(plan));
	assert.equal(plan.ok && plan.closesWorker, true);
	assert.equal(alive(pid), true, "planning stops nothing");
	const revived = await f.post.revive(jobId, { continueFailed: true });
	assert.equal(alive(pid), false, "the stale worker is closed before the relaunch");
	assert.notEqual(revived.pid, pid);
	assert.equal(f.post.manager.get(jobId)?.worker.pid, revived.pid);
	assert.equal(f.post.fleet.require(jobId).phase, "waiting");
});

test("04-5: a bound breached again after an operator continuation wakes the parent again", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.job("rebound");
	const calls: ScriptStep[] = Array.from({ length: 30 }, (_, n) => ({ kind: "tool_calls", calls: [{ name: "bash", args: { command: `echo step-${n}` } }] }));
	const model = f.script("rebound", [...calls, { kind: "hang" }]);
	await f.dispatch(jobId, model, { toolCallCap: 2 });
	const bound = () => f.post.durableWakeups.pending().filter((entry) => entry.job_id === jobId && entry.kind === "bound");
	const [first] = await waitFor(bound, (rows) => rows.length === 1, { timeoutMs: 60_000, what: "the spent bound's wake-up" });
	assert.match(first?.content ?? "", /bound spent/);
	await waitFor(() => alive(f.post.fleet.require(jobId).worker.pid), (live) => !live, { timeoutMs: 15_000, what: "bound worker stopped" });
	// Failure instants are second-precision; the next breach must be a different occurrence.
	await new Promise((resolve) => setTimeout(resolve, 1_100));

	await f.post.revive(jobId, { continueFailed: true });
	await f.post.send({ jobId, message: "Continue from where you stopped." });
	const rows = await waitFor(bound, (found) => found.length === 2, { timeoutMs: 60_000, what: "the second breach's wake-up" });
	assert.notEqual(rows[0]?.id, rows[1]?.id, "distinct occurrence, distinct id");
	assert.deepEqual(rows.map((entry) => entry.keys), [["tool_call_cap_exceeded"], ["tool_call_cap_exceeded"]]);
	assert.match(rows[1]?.content ?? "", /bound spent/);
});
