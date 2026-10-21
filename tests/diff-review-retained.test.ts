import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, DiffVerdictSchema, EMPTY_USAGE, GATE_MAX_REVISE, GateVerdictSchema, isoTimestamp, paths, REVIEW_MAX_ATTEMPTS, validate, type DiffVerdict, type GateReview } from "../src/contracts.ts";
import { DiffReview } from "../src/diff-review.ts";
import { gateCapExhausted } from "../src/gate.ts";
import { FleetStore } from "../src/fleet.ts";
import { MandateStore } from "../src/mandate.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.ts";
import { ReviewRuns, type ReviewWakeup } from "../src/review-runs.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender } from "../src/send.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { readPriorAttempts } from "../src/gate.ts";
import { readReviewPassVerdict } from "../src/merge-ask.ts";
import { createAgentDir, createScratchHome, createScratchRepo, MockProvider, REPO_ROOT, WORKER_REPORTER_EXTENSION, type ScriptStep } from "./harness/index.ts";

const NO_FLAGS = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };

async function reviewBenchOf(t: { after(fn: () => void | Promise<void>): void }) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo" });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const manager = new WorkerManager({ home: home.path, workerReporterPath: WORKER_REPORTER_EXTENSION, parentEnv: { ...process.env, ...agentDir.env } });
	const sender = new Sender({ fleet, manager, runs, home: home.path });
	const sent: ReviewWakeup[] = [];
	const reviews = new ReviewRuns({ home: home.path, runs, wakeup: (wakeup) => (sent.push(wakeup), true) });
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	const review = new DiffReview({ home: home.path, profilesDir: join(REPO_ROOT, "profiles"), briefsDir: join(REPO_ROOT, "prompts/briefs"), manager, routing: { ...DEFAULT_ROUTING_CONFIG, rubric: [] }, probe: { isAvailable: (model) => model.startsWith("mock/") }, fleet, runs, sender, registry, reviews, mandates: new MandateStore(home.path), reviewTimeoutMs: 20_000 });
	t.after(async () => { await manager.shutdownAll(); runs.closeAll(); agentDir.cleanup(); await provider.stop(); repo.cleanup(); home.cleanup(); });
	return {
		home: home.path, manager, review, sent,
		script: (name: string, steps: ScriptStep[]) => provider.addScript(name, steps),
		seal: () => agentDir.writeModels(provider),
		pushJobBranch(jobId: string) {
			repo.git("checkout", "--quiet", "-b", jobId, repo.branch);
			repo.write("src/app.ts", "export const x = 1;\n");
			repo.commitAll(jobId);
			repo.git("push", "--quiet", "-u", "origin", jobId);
			repo.git("checkout", "--quiet", repo.branch);
			return repo.head(jobId);
		},
		async shipRecord(jobId: string, overrides: { kind?: "ship" | "research" } = {}) {
			const worktree = join(home.path, "recycled", jobId);
			await fleet.add({ job_id: jobId, project: "demo", kind: overrides.kind ?? "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: isoTimestamp(), worker: { pid: process.pid, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/implementer", started_at: isoTimestamp() }, worktree, branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE });
			return worktree;
		},
	};
}

function verdictCall(jobId: string): ScriptStep {
	return { kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: jobId, verdict: "pass", flags: { ...NO_FLAGS }, reasons: ["scoped to one file"] } satisfies GateReview }], usage: { prompt_tokens: 900, completion_tokens: 40 } };
}

// Source identity is structural; runtime review budgets are pinned by the S05 cap and promotion scenarios.
test("the diff-review ladder is gate.ts's, by import: no fork, no copy, no second revise constant", () => {
	const source = readFileSync(join(REPO_ROOT, "src/diff-review.ts"), "utf8");

	const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*"\.\/gate\.ts";/.exec(source);
	assert.ok(importBlock, "src/diff-review.ts must import its policy from ./gate.ts");
	for (const name of ["decideGate", "nextAction", "capPayload", "readPriorAttempts", "awaitVerdict"]) {
		assert.match(importBlock[1] as string, new RegExp(`\\b${name}\\b`), `${name} must come from ./gate.ts`);
	}

	for (const name of ["decideGate", "nextAction", "capPayload", "readPriorAttempts", "awaitVerdict"]) {
		assert.doesNotMatch(
			source,
			new RegExp(`(export\\s+)?(async\\s+)?function\\s+${name}\\b`),
			`${name} is re-declared in src/diff-review.ts — the ladder must be imported, not copied`,
		);
	}

	assert.equal(GATE_MAX_REVISE, 1, "cp_gate's one-revise-per-artifact rule is untouched");
	assert.equal(REVIEW_MAX_ATTEMPTS, 5);
	assert.equal(gateCapExhausted([]), false);
	for (const file of ["src/diff-review.ts", "src/command-post.ts"]) {
		assert.doesNotMatch(readFileSync(join(REPO_ROOT, file), "utf8"), /DIFF_REVIEW_MAX_REVISE/);
	}
	for (const name of ["reviewCapExhausted", "reviewCapReason"]) {
		assert.match(importBlock[1] as string, new RegExp(`\\b${name}\\b`), `${name} must come from ./gate.ts`);
		assert.doesNotMatch(
			source,
			new RegExp(`(export\\s+)?function\\s+${name}\\b`),
			`${name} is re-declared in src/diff-review.ts — the cap lives beside the gate's own`,
		);
	}
	assert.equal(validate(GateVerdictSchema, {
		schema_version: 1,
		job_id: "cp-a",
		attempt: 1,
		verdict: "pass",
		cause: null,
		flags: { ...NO_FLAGS },
		reasons: ["ok"],
		decided_at: "2024-01-01T00:00:00Z",
		head_sha: "a".repeat(40),
		diff_stat: { files: 1, truncated: false },
	}).ok, false, "a DiffVerdict must not validate as a GateVerdict — the two schemas stay separate");
});

test("a real DiffReview finish that throws before persisting is decided operational; the same-head retry is attempt 2", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-finish-throws";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const model = b.script("review-finish-throws", [verdictCall(jobId)]);
	const retry = b.script("review-finish-throws-retry", [verdictCall(jobId)]);
	b.seal();
	// The first thing `finish` does is shut the reviewer down: fail that once.
	const shutdown = b.manager.shutdown.bind(b.manager);
	let failures = 1;
	b.manager.shutdown = async (key: string) => {
		if (failures-- > 0) throw new Error("shutdown refused");
		return shutdown(key);
	};
	const first = await b.review.reviewAndWait({ jobId, model });
	assert.deepEqual([first.verdict.verdict, first.verdict.cause, first.next], ["escalate", "operational", "retry"]);
	assert.match(first.verdict.reasons.join(" "), /reviewer finish failed: shutdown refused/);
	const decision = JSON.parse(readFileSync(join(b.home, paths.reviewFile(jobId, 1)), "utf8")) as DiffVerdict;
	assert.ok(validate<DiffVerdict>(DiffVerdictSchema, decision).ok);
	assert.equal(decision.head_sha, head);
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.headSha, head);
	assert.equal(readReviewPassVerdict(b.home, jobId, head), undefined, "an operational decision never satisfies integration");
	assert.equal(readPriorAttempts(b.home, jobId, paths.reviewFile, DiffVerdictSchema).attempt, 2);
	const second = await b.review.reviewAndWait({ jobId, model: retry });
	assert.equal(second.verdict.attempt, 2, "a fresh attempt, never a replay of attempt 1's scratch verdict");
	assert.equal(second.verdict.verdict, "pass");
	assert.ok(existsSync(join(b.home, paths.reviewVerdictFile(jobId, 2))));
	assert.equal(readReviewPassVerdict(b.home, jobId, head)?.attempt, 2);
});

test("headSha guards for callers without a reported ship subject", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	b.seal();
	assert.equal(await b.review.headSha("cp-review-head-unknown"), undefined);
});
