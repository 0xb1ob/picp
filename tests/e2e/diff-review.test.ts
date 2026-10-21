import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, DIFF_REVIEW_MAX_BYTES, DIFF_REVIEW_MAX_STAT_FILES, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, type DiffVerdict } from "../../src/contracts.ts";
import { isDiffReviewWait } from "../../src/diff-review.ts";
import { createAgentDir, createScratchHome, createScratchRepo, MockProvider, REPO_ROOT } from "../harness/index.ts";

async function stack(t: TestContext) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo" });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env }, holdsParentLock: () => true });
	t.after(async () => { await post.shutdown(); agent.cleanup(); await provider.stop(); repo.cleanup(); home.cleanup(); });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [] }));
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	let sequence = 0;
	async function seed(files: Record<string, string>) {
		const jobId = `cp-s04-${++sequence}`;
		repo.git("checkout", "--quiet", "-b", jobId, repo.branch);
		for (const [path, content] of Object.entries(files)) repo.write(path, content);
		repo.commitAll(jobId);
		repo.git("push", "--quiet", "-u", "origin", jobId);
		repo.git("checkout", "--quiet", repo.branch);
		const now = isoTimestamp();
		await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: now, dispatched_at: now, usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "legacy", session_file: join(home.path, "legacy.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: now }, worktree: join(home.path, "recycled", jobId), branch: jobId });
		return jobId;
	}
	async function review(jobId: string) {
		const name = `review-${jobId}`;
		const model = provider.addScript(name, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["reviewed complete subject"] } }] }]);
		agent.writeModels(provider);
		const started = await post.diffReview({ jobId, model });
		if (isDiffReviewWait(started)) {
			post.reviewRuns.handBack(started.key);
			await post.reviewRuns.settled(started.key);
		}
		const verdict = JSON.parse(readFileSync(join(home.path, paths.reviewFile(jobId, 1)), "utf8")) as DiffVerdict;
		return { verdict, requests: provider.requests(name), scratch: join(home.path, paths.reviewScratchDir(jobId, 1)) };
	}
	return { post, repo, seed, review };
}

test("S04: cp_review gives the reviewer a complete three-dot subject from the canonical clone", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "a.txt": "one\ntwo\nthree\n", "b.txt": "hello\n", "ä.ts": "export const a = 1;\n" });
	s.repo.write("base-only.txt", "base moved\n");
	s.repo.commitAll("base advances");
	s.repo.git("push", "--quiet", "origin", s.repo.branch);
	const result = await s.review(job);
	assert.equal(result.verdict.verdict, "pass");
	assert.deepEqual(result.verdict.diff_stat, { files: 3, truncated: false });
	assert.ok(result.requests.length > 0);
	const diff = readFileSync(join(result.scratch, "diff.md"), "utf8");
	for (const text of ["a.txt", "b.txt", "ä.ts", "export const a = 1", "## Stat", "## Hunks"]) assert.ok(diff.includes(text), text);
	assert.doesNotMatch(diff, /base-only\.txt|## Omitted/);
});

test("S04: cp_review stops wide, oversized and unparseable subjects before a model sees them", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	for (const [label, files, pattern] of [
		["wide", Object.fromEntries(Array.from({ length: DIFF_REVIEW_MAX_STAT_FILES + 1 }, (_, n) => [`file-${n}.txt`, "x\n"])), /DIFF_REVIEW_MAX_STAT_FILES/],
		["bytes", { "generated.txt": "line\n".repeat(DIFF_REVIEW_MAX_BYTES), "small.txt": "tiny\n" }, /DIFF_REVIEW_MAX_BYTES/],
		["quoted", { "ä.ts": "export const a = 1;\n", 'we"ird.ts': "export const w = 1;\n" }, /omitted/],
	] as const) {
		const job = await s.seed(files);
		const result = await s.review(job);
		assert.deepEqual([result.verdict.verdict, result.verdict.cause], ["escalate", "policy"], label);
		assert.match(result.verdict.reasons.join(" "), pattern, label);
		assert.equal(result.requests.length, 0, label);
		if (label !== "wide") {
			const diff = readFileSync(join(result.scratch, "diff.md"), "utf8");
			assert.match(diff, /## Omitted/);
			if (label === "bytes") assert.match(diff, /tiny/);
			else assert.match(diff, /export const a = 1/);
		}
	}
});
