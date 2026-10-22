/**
 * Hard bounds e2e: a looping worker trips the tool-call cap; a sleeping tool
 * trips the wall-clock. Both leave uncommitted files and record `failed`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type Failure, type UnreportedWork, paths, LAYOUT, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readFleet,
	REPO_ROOT,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "bounds e2e needs treehouse on PATH";

interface Fleet {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	bounds: Array<{ jobId: string; failure: Failure; notice: string }>;
	unreported: string[];
	intake(title: string, slug: string): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
}

async function fleet(t: { after(fn: () => void | Promise<void>): void }, displaceOnBound = false, budgetLimit = false): Promise<Fleet> {
	const home = createScratchHome();
	const repo = createScratchRepo({
		name: "demo",
		files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" },
	});
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const bounds: Fleet["bounds"] = [];
	const unreported: string[] = [];
	if (budgetLimit) {
		mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
		writeFileSync(join(home.path, LAYOUT.budgetsFile), JSON.stringify({ schema_version: SCHEMA_VERSION, per_job_tokens: 1, per_job_cost_usd: 20, warn_ratio: 0.8, spawn_cap: 10 }));
	}
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
		parentEnv: { ...process.env, ...agentDir.env },
		onUnreportedSettle: (_jobId, outcome) => {
			if (outcome.action === "recorded") unreported.push(outcome.failure?.class ?? "settled_without_report");
		},
		onHardBound: (jobId, failure, _work: UnreportedWork, notice) => {
			bounds.push({ jobId, failure, notice });
			if (displaceOnBound) {
				const worktree = post.fleet.require(jobId).worktree;
				renameSync(worktree, `${worktree}-displaced`);
			}
		},
	});
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 3 });
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
		bounds,
		unreported,
		async intake(title, slug) {
			const issue = await post.ledger().create({ title, project: "demo", delivery: "local", kind: "ship", slug });
			return issue.id;
		},
		script(name, steps) {
			const model = provider.addScript(name, steps);
			agentDir.writeModels(provider);
			return model;
		},
	};
}

test("a looping worker trips the tool-call cap, keeps the file, wakes once", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("loop tools", "loopy");
	const model = f.script("bound-tools", [
		{
			kind: "tool_calls",
			calls: [{ name: "bash", args: { command: "printf 'keep-me\\n' > leftover.txt && echo wrote" } }],
		},
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo two" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo three" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo four" } }] },
	]);
	const dispatched = await f.post.dispatch({
		jobId,
		task: "Loop.",
		model,
		fetch: false,
		toolCallCap: 3,
		wallClockSeconds: 600,
	});
	const failed = await waitFor(
		() => readFleet(f.home).jobs[0],
		(record) => record?.phase === "failed",
		{ timeoutMs: 90_000, what: "tool-call cap to fail the job" },
	);
	await waitFor(
		() => f.bounds.length,
		(n) => n === 1,
		{ timeoutMs: 15_000, what: "one bound wake-up" },
	);
	assert.equal(failed?.failure?.class, "tool_call_cap_exceeded");
	assert.match(failed?.failure?.message ?? "", /tool_call_cap/);
	assert.equal(existsSync(join(dispatched.worktree, "leftover.txt")), true);
	assert.equal(readFileSync(join(dispatched.worktree, "leftover.txt"), "utf8"), "keep-me\n");
	assert.equal(f.bounds.length, 1);
	assert.equal(f.bounds[0]?.failure.class, "tool_call_cap_exceeded");
	assert.match(f.bounds[0]?.notice ?? "", /HARD BOUND/);
});

test("a long-sleeping tool trips the wall-clock, keeps the file, wakes once", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("sleep forever", "sleepy");
	const model = f.script("bound-clock", [
		{
			kind: "tool_calls",
			calls: [{ name: "bash", args: { command: "printf 'keep-me\\n' > leftover.txt && echo wrote" } }],
		},
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 60" } }] },
	]);
	const dispatched = await f.post.dispatch({
		jobId,
		task: "Sleep.",
		model,
		fetch: false,
		wallClockSeconds: 20,
		toolCallCap: 900,
	});
	const failed = await waitFor(
		() => readFleet(f.home).jobs[0],
		(record) => record?.phase === "failed",
		{ timeoutMs: 120_000, what: "wall-clock to fail the job" },
	);
	await waitFor(
		() => f.bounds.length,
		(n) => n === 1,
		{ timeoutMs: 15_000, what: "one bound wake-up" },
	);
	assert.equal(failed?.failure?.class, "wall_clock_exceeded");
	assert.match(failed?.failure?.message ?? "", /wall_clock/);
	assert.equal(existsSync(join(dispatched.worktree, "leftover.txt")), true);
	assert.equal(readFileSync(join(dispatched.worktree, "leftover.txt"), "utf8"), "keep-me\n");
	assert.equal(f.bounds.length, 1);
	assert.match(f.bounds[0]?.notice ?? "", /HARD BOUND/);
});


test("S21: a real bound whose checkout disappears journals its recovery outcome once", { skip: SKIP, timeout: 110_000 }, async (t) => {
	const f = await fleet(t, true);
	const jobId = await f.intake("bound with displaced checkout", "displaced");
	const model = f.script("displaced-bound", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo retained > leftover.txt" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo bound" } }] },
	]);
	const dispatched = await f.post.dispatch({ jobId, task: "Write, then stop at the bound.", model, fetch: false, toolCallCap: 2, wallClockSeconds: 90 });
	const entries = await waitFor(
		() => f.post.durableWakeups.pending().filter((entry) => entry.job_id === jobId),
		(rows) => rows.length > 0,
		{ timeoutMs: 30_000, what: "displaced checkout bound outcome" },
	);
	const failure = f.post.fleet.require(jobId).failure;
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.kind, "bound");
	assert.equal(entries[0]?.id, `bound:${jobId}:tool_call_cap_exceeded:${failure?.at}`);
	assert.equal(entries[0]?.generation, 1);
	assert.deepEqual(entries[0]?.keys, ["tool_call_cap_exceeded"]);
	assert.match(entries[0]?.content ?? "", /automatic recovery: attempted, not revived/);
	assert.match(entries[0]?.content ?? "", /lease and worktree kept/);
	assert.doesNotMatch(entries[0]?.content ?? "", /did not stick|next: cp_teardown/);
	assert.equal(readFileSync(join(`${dispatched.worktree}-displaced`, "leftover.txt"), "utf8"), "retained\n");
});


test("S21: a rejected envelope and an observed worker loop emit durable deaths", { skip: SKIP, timeout: 110_000 }, async (t) => {
	for (const cls of ["envelope_invalid", "tool_loop"] as const) {
		const f = await fleet(t);
		const jobId = await f.intake(cls, cls.replaceAll("_", "-"));
		const model = f.script(`emitter-${cls}`, cls === "envelope_invalid"
			? [{ kind: "hang", ms: 1000 }]
			: [{ kind: "tool_calls", calls: Array.from({ length: 6 }, () => ({ name: "bash", args: { command: "echo identical" } })) }, { kind: "hang" }]);
		await f.post.dispatch({ jobId, task: "Exercise the worker emitter.", model, fetch: false, toolCallCap: 100, wallClockSeconds: 90 });
		if (cls === "envelope_invalid") {
			const rejected = join(f.home, paths.runDir(jobId), "envelope-rejected.json");
			mkdirSync(join(rejected, ".."), { recursive: true });
			writeFileSync(rejected, "{}");
		} else {
			await waitFor(() => readFileSync(join(f.home, paths.eventsFile(jobId)), "utf8"),
				(log) => (log.match(/tool_execution_start/g) ?? []).length >= 6,
				{ timeoutMs: 15_000, what: "six real identical tool calls" });
			await waitFor(() => f.provider.requests(`emitter-${cls}`).length, (n) => n >= 2,
				{ timeoutMs: 15_000, what: "worker waiting after six completed calls" });
			const pid = f.post.manager.get(jobId)?.worker.pid;
			assert.ok(pid, "the worker PID belongs to this dispatch");
			process.kill(pid, "SIGKILL");
		}
		const entries = await waitFor(() => f.post.durableWakeups.pending().filter((entry) => entry.job_id === jobId),
			(rows) => rows.some((entry) => entry.keys?.includes(cls)), { timeoutMs: 10_000, what: `${cls} durable death` }).catch((error) => {
				throw new Error(`${error.message}; fleet=${JSON.stringify(f.post.fleet.require(jobId))}`);
			});
		assert.equal(f.post.fleet.require(jobId).failure?.class, cls);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind, "death");
		assert.deepEqual(entries[0]?.keys, [cls]);
		assert.match(entries[0]?.content ?? "", /on disk:/);
		assert.match(entries[0]?.content ?? "", /cp_teardown/);
		assert.doesNotMatch(entries[0]?.content ?? "", /poll/i);
	}
});

test("S21: parent shutdown preserves the interrupted worker without a death or spent recovery", { skip: SKIP, timeout: 110_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("shutdown owns the close", "own-close");
	const model = f.script("shutdown-owned", [{ kind: "hang" }]);
	await f.post.dispatch({ jobId, task: "Wait for the parent.", model, fetch: false, toolCallCap: 100, wallClockSeconds: 90 });
	await waitFor(() => f.provider.requests("shutdown-owned").length, (n) => n > 0, { timeoutMs: 15_000, what: "worker request before shutdown" });
	await f.post.shutdown();
	await f.post.failures.evaluate(jobId);
	assert.equal(readFleet(f.home).jobs[0]?.phase, "waiting");
	assert.deepEqual(f.post.durableWakeups.pending(), []);
	assert.equal(existsSync(join(f.home, paths.recoveryAttemptsFile(jobId))), false);
});


test("S21: budget and provider failures reach the durable death journal", { skip: SKIP, timeout: 110_000 }, async (t) => {
	for (const cls of ["budget_exceeded", "model_call_failed"] as const) {
		const f = await fleet(t, false, cls === "budget_exceeded");
		const jobId = await f.intake(cls, cls.replaceAll("_", "-"));
		const model = f.script(`failure-${cls}`, cls === "model_call_failed"
			? [{ kind: "error", status: 401, message: "401 Invalid API key", repeat: 20 }]
			: [{ kind: "text", text: "budgeted turn", usage: { prompt_tokens: 900, completion_tokens: 200 } }, { kind: "hang" }]);
		await f.post.dispatch({ jobId, task: "Exercise a public worker failure.", model, fetch: false, toolCallCap: 100, wallClockSeconds: 90 });
		if (cls === "budget_exceeded") {
			await waitFor(() => f.provider.requests(`failure-${cls}`).length, (n) => n >= 2,
				{ timeoutMs: 15_000, what: "budgeted turn settled before the report nudge" });
			await f.post.send({ jobId, message: "Observe the exceeded budget." });
			await waitFor(() => readFileSync(join(f.home, paths.eventsFile(jobId)), "utf8").includes('"budget_exceeded"'),
				(Boolean), { timeoutMs: 15_000, what: "real usage crossing the home budget" });
			const pid = f.post.manager.get(jobId)?.worker.pid;
			assert.ok(pid);
			process.kill(pid, "SIGKILL");
		}
		const entries = await waitFor(() => f.post.durableWakeups.pending().filter((entry) => entry.job_id === jobId),
			(rows) => rows.some((entry) => entry.keys?.includes(cls)), { timeoutMs: 25_000, what: `${cls} durable emitter` });
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind, "death");
		assert.equal(f.post.fleet.require(jobId).failure?.class, cls);
		assert.match(entries[0]?.content ?? "", /on disk:/);
		assert.match(entries[0]?.content ?? "", /cp_teardown/);
	}
});


test("S21: an idle worker that ignores its report nudge emits one unreported outcome", { skip: SKIP, timeout: 110_000 }, async (t) => {
	const f = await fleet(t);
	const jobId = await f.intake("silent worker", "silent-worker");
	const model = f.script("s21-silent", [{ kind: "text", text: "No report yet." }, { kind: "text", text: "Still no report." }]);
	await f.post.dispatch({ jobId, task: "Exercise the report boundary.", model, fetch: false, toolCallCap: 100, wallClockSeconds: 90 });
	await waitFor(() => f.unreported, (rows) => rows.includes("settled_without_report"),
		{ timeoutMs: 20_000, what: "real unreported-settle emitter" });
	assert.deepEqual(f.unreported, ["settled_without_report"]);
	assert.equal(f.post.fleet.require(jobId).phase, "waiting");
	assert.equal(f.provider.requests("s21-silent").length, 2);
});
