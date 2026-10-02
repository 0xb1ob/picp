/**
 * Hard bounds e2e: a looping worker trips the tool-call cap; a sleeping tool
 * trips the wall-clock. Both leave uncommitted files and record `failed`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type Failure, type UnreportedWork } from "../../src/contracts.ts";
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
	intake(title: string, slug: string): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
}

async function fleet(t: { after(fn: () => void | Promise<void>): void }): Promise<Fleet> {
	const home = createScratchHome();
	const repo = createScratchRepo({
		name: "demo",
		files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" },
	});
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const bounds: Fleet["bounds"] = [];
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...agentDir.env },
		onHardBound: (jobId, failure, _work: UnreportedWork, notice) => {
			bounds.push({ jobId, failure, notice });
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
