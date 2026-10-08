/**
 * cp-diffgate-redo-hxb: Stage A (contract additions, the generalized
 * `readPriorAttempts`, `materializeDiff`) and Stage B1 (the reviewer-spawn
 * orchestrator, `DiffReview`).
 *
 * The orchestrator suite follows `tests/gate.test.ts`'s style: a real
 * `pi --mode rpc` gate-reviewer worker whose model is the scriptable mock
 * provider, plus `createScratchRepo` for the git facts. The whole path runs
 * for real — canonical clone, fetch, three-dot materialization, scratch cwd,
 * `report_verdict`, write-once verdict.json, policy, review-N.json — and only
 * the model's answer is canned.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	type DiffReviewConfig,
	DiffReviewConfigSchema,
	DIFF_REVIEW_MAX_BYTES,
	DIFF_REVIEW_MAX_STAT_FILES,
	type DiffVerdict,
	DiffVerdictSchema,
	EMPTY_USAGE,
	GATE_MAX_REVISE,
	GATE_REASONS_MAX_ITEMS,
	LAYOUT,
	REVIEW_MAX_ATTEMPTS,
	REVIEW_ORIGINAL_TASK_MAX_BYTES,
	type GateFlags,
	type GateReview,
	GateVerdictSchema,
	isoTimestamp,
	type JobRouting,
	paths,
	type RoutingConfig,
	validate,
} from "../src/contracts.ts";
import {
	DiffReview,
	diffOriginalTaskBlock,
	diffReviseMessage,
	formatDiffReview,
	isDiffReviewWait,
	materializeDiff,
} from "../src/diff-review.ts";
import { gateCapExhausted, ORIGINAL_TASK_COPY, reviewCapExhausted } from "../src/gate.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { finalFixMessage, requestFinalFix } from "../src/final-fix.ts";
import { FleetStore } from "../src/fleet.ts";
import { capPayload, decideGate, nextAction, readPriorAttempts } from "../src/gate.ts";
import { MandateError, MandateStore } from "../src/mandate.ts";
import { assembleBrief, loadProfile, readBriefTemplate } from "../src/profiles.ts";
import { readReviewPassHeads, readReviewPassVerdict } from "../src/merge-ask.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { DEFAULT_ROUTING_CONFIG, type ModelProbe } from "../src/routing.ts";
import { listPendingReviews, readPendingReview, ReviewRuns, type ReviewWakeup } from "../src/review-runs.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender } from "../src/send.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	argOf,
	captureSpawns,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	REPO_ROOT,
	type ScratchRepo,
	type ScriptOptions,
	type ScriptStep,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

// ---------------------------------------------------------------------------
// Contract additions — additive, backward compatible
// ---------------------------------------------------------------------------

test("DiffReviewConfigSchema: absent/false means off, mirrors QualityConfigSchema's shape", () => {
	const off: DiffReviewConfig = {};
	assert.ok(validate<DiffReviewConfig>(DiffReviewConfigSchema, off).ok);
	const on: DiffReviewConfig = { enabled: true, model: "anthropic/claude-opus-5" };
	assert.ok(validate<DiffReviewConfig>(DiffReviewConfigSchema, on).ok);
	assert.equal(validate<DiffReviewConfig>(DiffReviewConfigSchema, { enabled: true, extra: 1 }).ok, false);
});

test("DiffVerdictSchema: a new, parallel schema carrying head_sha + diff_stat", () => {
	const verdict: DiffVerdict = {
		schema_version: 1,
		job_id: "cp-a",
		attempt: 1,
		verdict: "pass",
		cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["scoped and tested"],
		decided_at: "2024-01-01T00:00:00Z",
		head_sha: "a".repeat(40),
		diff_stat: { files: 3, truncated: false },
	};
	assert.ok(validate<DiffVerdict>(DiffVerdictSchema, verdict).ok);
});

test("paths.checkpointFile: backward compatible — a bare call is unchanged, 'diff' gets a distinct path", () => {
	assert.equal(paths.checkpointFile("cp-a"), ".pi-command-post/state/checkpoints/cp-a.json");
	assert.equal(paths.checkpointFile("cp-a", "ship"), ".pi-command-post/state/checkpoints/cp-a.json");
	assert.equal(paths.checkpointFile("cp-a", "diff"), ".pi-command-post/state/checkpoints/cp-a.diff.json");
});

test("paths.review*: parallel to the gate's own path helpers, never the same file", () => {
	assert.equal(paths.reviewFile("cp-a", 1), ".pi-command-post/state/runs/cp-a/review-1.json");
	assert.equal(paths.reviewRunDir("cp-a", 1), ".pi-command-post/state/runs/cp-a/review-1");
	assert.equal(paths.reviewVerdictFile("cp-a", 1), ".pi-command-post/state/runs/cp-a/review-1/verdict.json");
	assert.equal(paths.reviewScratchDir("cp-a", 1), ".pi-command-post/state/runs/cp-a/review-1/review");
	assert.notEqual(paths.reviewFile("cp-a", 1), paths.gateFile("cp-a", 1));
});

// ---------------------------------------------------------------------------
// Pure policy reuse, proven by import, not by copy (Test plan item 1)
// ---------------------------------------------------------------------------

const NO_PRIOR = { priorRevise: false, priorCause: null } as const;

test("decideGate/nextAction/capPayload are subject-agnostic: the same functions score a diff-shaped review", () => {
	const pass = decideGate({
		jobId: "cp-diff-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: {
			job_id: "cp-diff-a",
			verdict: "pass",
			flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
			reasons: ["diff is scoped"],
		},
	});
	assert.equal(pass.verdict, "pass");
	assert.equal(pass.cause, null);
	assert.equal(nextAction(pass), "proceed");

	const capped = capPayload(["a short reason"], undefined);
	assert.deepEqual(capped.reasons, ["a short reason"]);

	// cp-unknowns-no-veto, on the subject that produced the incident: a diff that
	// defers work to a sibling ticket trips `blocking_unknowns` by construction.
	// The reviewer's `revise` must stay a revise the implementer can answer, not
	// the escalate/policy that nobody could authorize.
	const deferring = decideGate({
		jobId: "cp-diff-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: {
			job_id: "cp-diff-a",
			verdict: "revise",
			flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: true },
			reasons: ["the hub this script feeds is cp-b1's job"],
			revisions: ["name the sibling ticket in the header comment"],
		},
	});
	assert.equal(deferring.verdict, "revise");
	assert.equal(deferring.cause, null);
	assert.equal(nextAction(deferring), "revise");
	assert.equal(deferring.flags.blocking_unknowns, true, "still reported, on this subject too");
	assert.ok(deferring.reasons.some((reason) => reason.includes("flag reported, no veto: blocking_unknowns")));
});

// ---------------------------------------------------------------------------
// readPriorAttempts generalization (Test plan item 2)
// ---------------------------------------------------------------------------

test("readPriorAttempts(pathFn): plan-gate and diff-review attempts never leak into each other", () => {
	const home = createScratchHome();
	try {
		const jobId = "cp-shared";
		mkdirSync(join(home.path, LAYOUT.runs, jobId), { recursive: true });
		writeFileSync(
			join(home.path, paths.gateFile(jobId, 1)),
			JSON.stringify({
				schema_version: 1,
				job_id: jobId,
				attempt: 1,
				verdict: "pass",
				cause: null,
				flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
				reasons: ["ok"],
				decided_at: "2024-01-01T00:00:00Z",
			}),
		);

		const gatePrior = readPriorAttempts(home.path, jobId, paths.gateFile);
		assert.equal(gatePrior.attempt, 2);

		const reviewPrior = readPriorAttempts(home.path, jobId, paths.reviewFile);
		assert.equal(reviewPrior.attempt, 1, "no review-*.json exists yet: the plan gate's attempt must not be visible here");

		// default (no pathFn) still reproduces today's exact behaviour.
		const defaulted = readPriorAttempts(home.path, jobId);
		assert.equal(defaulted.attempt, gatePrior.attempt);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// materializeDiff (Test plan item 3)
// ---------------------------------------------------------------------------

function pushBranch(repo: ScratchRepo, branch: string, from = repo.branch): void {
	repo.git("checkout", "-b", branch, from);
	repo.git("push", "--quiet", "-u", "origin", branch);
}

test("materializeDiff: a small diff is captured in full, well under both caps", async () => {
	const repo = createScratchRepo({ name: "small" });
	try {
		pushBranch(repo, "feature");
		repo.write("a.txt", "one\ntwo\nthree\n");
		repo.write("b.txt", "hello\n");
		repo.commitAll("small change");
		repo.git("push", "--quiet", "origin", "feature");

		const out = join(repo.path, "..", "diff.md");
		const result = await materializeDiff({ cwd: repo.path, branch: "feature", out });
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.equal(result.files, 2);
		assert.equal(result.truncated, false);
		assert.deepEqual(result.omitted, []);
		const written = readFileSync(out, "utf8");
		assert.match(written, /a\.txt/);
		assert.match(written, /b\.txt/);
		assert.match(written, /## Stat/);
		assert.match(written, /## Hunks/);
		assert.doesNotMatch(written, /## Omitted/);
	} finally {
		repo.cleanup();
	}
});

test("materializeDiff: a non-ASCII path is shown in full; a path git must quote is omitted, never silently dropped", async () => {
	const repo = createScratchRepo({ name: "paths" });
	try {
		pushBranch(repo, "feature");
		repo.write("ä.ts", "export const a = 1;\n");
		repo.write('we"ird.ts', "export const w = 1;\n");
		repo.commitAll("odd names");
		repo.git("push", "--quiet", "origin", "feature");

		const out = join(repo.path, "..", "diff.md");
		const result = await materializeDiff({ cwd: repo.path, branch: "feature", out });
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.equal(result.files, 2);
		assert.match(readFileSync(out, "utf8"), /export const a = 1/, "the non-ASCII file's hunk reached the subject");
		assert.equal(result.truncated, true, "a hunk the parser could not attribute makes the subject incomplete");
		assert.equal(result.omitted.length, 1);
	} finally {
		repo.cleanup();
	}
});

test("materializeDiff: over DIFF_REVIEW_MAX_STAT_FILES, no diff is written — the caller gets stat_overflow", async () => {
	const repo = createScratchRepo({ name: "wide" });
	try {
		pushBranch(repo, "feature");
		const count = DIFF_REVIEW_MAX_STAT_FILES + 1;
		for (let i = 0; i < count; i += 1) repo.write(`file-${i}.txt`, "x\n");
		repo.commitAll("touch many files");
		repo.git("push", "--quiet", "origin", "feature");

		const out = join(repo.path, "..", "diff.md");
		const result = await materializeDiff({ cwd: repo.path, branch: "feature", out });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "stat_overflow");
		assert.equal(result.files, count);
		assert.equal(result.cap, DIFF_REVIEW_MAX_STAT_FILES);
		assert.equal(existsSync(out), false, "no diff file is written on stat overflow");
	} finally {
		repo.cleanup();
	}
});

test("materializeDiff: under the file cap but over the byte cap, hunks are truncated at a file boundary and omissions are named", async () => {
	const repo = createScratchRepo({ name: "big" });
	try {
		pushBranch(repo, "feature");
		repo.write("small.txt", "tiny\n");
		// One generated file whose diff alone exceeds a tiny byte cap.
		repo.write("generated.txt", `${"line\n".repeat(2000)}`);
		repo.commitAll("one huge file, one tiny file");
		repo.git("push", "--quiet", "origin", "feature");

		const out = join(repo.path, "..", "diff.md");
		const result = await materializeDiff({ cwd: repo.path, branch: "feature", out, maxBytes: 200 });
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.equal(result.files, 2);
		assert.equal(result.truncated, true);
		assert.ok(result.omitted.length > 0);
		const written = readFileSync(out, "utf8");
		assert.match(written, /## Stat/);
		assert.match(written, /small\.txt/);
		assert.match(written, /## Omitted/);
		for (const path of result.omitted) {
			assert.ok(written.includes(path), `omitted file ${path} must still be named in the output`);
		}
	} finally {
		repo.cleanup();
	}
});

test("materializeDiff: three-dot — commits made only on base after the branch diverged are excluded", async () => {
	const repo = createScratchRepo({ name: "threedot" });
	try {
		pushBranch(repo, "feature");
		repo.write("feature-only.txt", "feature change\n");
		repo.commitAll("feature work");
		repo.git("push", "--quiet", "origin", "feature");

		// Base moves on with its own, unrelated commit after the fork point.
		repo.git("checkout", repo.branch);
		repo.write("base-only.txt", "base moved on\n");
		repo.commitAll("base-only work");
		repo.git("push", "--quiet", "origin", repo.branch);

		const out = join(repo.path, "..", "diff.md");
		const result = await materializeDiff({ cwd: repo.path, branch: "feature", out });
		assert.ok(result.ok);
		if (!result.ok) return;
		const written = readFileSync(out, "utf8");
		assert.match(written, /feature-only\.txt/);
		assert.doesNotMatch(written, /base-only\.txt/, "a three-dot diff must exclude base-only commits");
	} finally {
		repo.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The orchestrator (Stage B1) — a real `pi --mode rpc` gate-reviewer worker
// whose model is the scriptable mock provider, a real canonical clone, and
// real git facts. Only the model's answer is canned.
// ---------------------------------------------------------------------------

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");
const PROJECT = "demo";

/** Only the mock models exist, so a real routing decision is still made. */
const MOCK_ONLY: ModelProbe = { isAvailable: (model) => model.startsWith("mock/") };

const NO_FLAGS: GateFlags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };

/** A string that only ever appears inside the diff body, never in a verdict. */
const BODY_MARKER = "canary_diff_body_marker";

/** The same canary for the frozen original task's body (do8.4). */
const TASK_MARKER = "canary_original_task_marker";

function diffReview(overrides: Partial<GateReview> & { job_id: string }): GateReview {
	return {
		verdict: "pass",
		flags: { ...NO_FLAGS },
		reasons: ["scoped to one file"],
		...overrides,
	} as GateReview;
}

function verdictCall(jobId: string, overrides: Partial<GateReview> = {}): ScriptStep {
	return {
		kind: "tool_calls",
		calls: [{ name: "report_verdict", args: { ...diffReview({ job_id: jobId, ...overrides }) } }],
		usage: { prompt_tokens: 900, completion_tokens: 40 },
	};
}

interface ReviewBench {
	home: string;
	repo: ScratchRepo;
	provider: MockProvider;
	fleet: FleetStore;
	manager: WorkerManager;
	runs: RunRegistry;
	review: DiffReview;
	sent: ReviewWakeup[];
	reviews: ReviewRuns;
	/** The review's own mandate store: empty unless a test issues a grant. */
	mandates: MandateStore;
	registry: ProjectRegistry;
	/** The very object the review routes with; rows can only name a mock model once its script exists. */
	routing: RoutingConfig;
	script(name: string, steps: ScriptStep[], options?: ScriptOptions): string;
	seal(): void;
	/** Cut `jobId` from the base, commit `files`, push it. Returns the head sha. */
	pushJobBranch(jobId: string, files?: Record<string, string>): string;
	/** A ship dispatch record for `jobId`, exactly as cp_dispatch would leave it. */
	shipRecord(
		jobId: string,
		overrides?: { kind?: "ship" | "research"; worktree?: string; routing?: JobRouting },
	): Promise<string>;
	/** A live "implementer" worker for the promote path. */
	liveImplementer(jobId: string): Promise<void>;
}

async function reviewBenchOf(t: { after(fn: () => void | Promise<void>): void }, options: { probe?: ModelProbe } = {}): Promise<ReviewBench> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: PROJECT });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const sender = new Sender({ fleet, manager, runs, home: home.path });
	const sent: ReviewWakeup[] = [];
	const reviews = new ReviewRuns({ home: home.path, runs, wakeup: (wakeup) => (sent.push(wakeup), true) });
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: PROJECT, clone_url: repo.remote as string, delivery: "pr" });
	const routing: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, rubric: [] };
	const mandates = new MandateStore(home.path);
	const review = new DiffReview({
		home: home.path,
		profilesDir: PROFILES_DIR,
		briefsDir: BRIEFS_DIR,
		manager,
		routing,
		probe: options.probe ?? MOCK_ONLY,
		fleet,
		runs,
		sender,
		registry,
		reviews,
		mandates,
		reviewTimeoutMs: 20_000,
	});

	t.after(async () => {
		await manager.shutdownAll();
		runs.closeAll();
		agentDir.cleanup();
		await provider.stop();
		repo.cleanup();
		home.cleanup();
	});

	return {
		home: home.path,
		repo,
		provider,
		fleet,
		manager,
		runs,
		review,
		sent,
		reviews,
		mandates,
		registry,
		routing,
		script: (name, steps, options) => provider.addScript(name, steps, options),
		seal: () => agentDir.writeModels(provider),
		pushJobBranch(jobId, files) {
			repo.git("checkout", "--quiet", "-b", jobId, repo.branch);
			for (const [path, content] of Object.entries(files ?? { "src/app.ts": `export const x = "${BODY_MARKER}";\n` })) {
				repo.write(path, content);
			}
			repo.commitAll(`work for ${jobId}`);
			repo.git("push", "--quiet", "-u", "origin", jobId);
			repo.git("checkout", "--quiet", repo.branch);
			return repo.head(jobId);
		},
		async shipRecord(jobId, overrides = {}) {
			const worktree = overrides.worktree ?? mkdtempSync(join(tmpdir(), "cp-wt-"));
			await fleet.add({
				job_id: jobId,
				project: PROJECT,
				kind: overrides.kind ?? "ship",
				delivery: "pr",
				origin: DEFAULT_ORIGIN,
				phase: "held",
				reported_at: isoTimestamp(),
				worker: {
					pid: process.pid,
					session_id: "s",
					session_file: join(home.path, "s.jsonl"),
					profile: "implementer",
					role: "implementer",
					model: "mock/implementer",
					started_at: isoTimestamp(),
				},
				worktree,
				branch: jobId,
				dispatched_at: isoTimestamp(),
				usage: EMPTY_USAGE,
				...(overrides.routing ? { routing: overrides.routing } : {}),
			});
			return worktree;
		},
		async liveImplementer(jobId) {
			const managed = manager.spawn({
				identity: {
					jobId,
					kind: "ship",
					delivery: "pr",
					runDir: join(home.path, paths.runDir(jobId)),
					worktree: home.path,
				},
				profile: loadProfile(PROFILES_DIR, "implementer"),
				model: "mock/implementer",
				brief: "stand by",
			});
			await managed.worker.getState(20_000);
		},
	};
}

// ---------------------------------------------------------------------------
// Reuse, pinned (Test plan item 1): the ladder is imported, never re-declared
// ---------------------------------------------------------------------------

test("the diff-review ladder is gate.ts's, by import: no fork, no copy, no second revise constant", () => {
	const source = readFileSync(join(REPO_ROOT, "src/diff-review.ts"), "utf8");

	const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*"\.\/gate\.ts";/.exec(source);
	assert.ok(importBlock, "src/diff-review.ts must import its policy from ./gate.ts");
	for (const name of ["decideGate", "nextAction", "capPayload", "readPriorAttempts", "awaitVerdict"]) {
		assert.match(importBlock[1] as string, new RegExp(`\\b${name}\\b`), `${name} must come from ./gate.ts`);
	}

	// A fork would show up as a local declaration of any of these.
	for (const name of ["decideGate", "nextAction", "capPayload", "readPriorAttempts", "awaitVerdict"]) {
		assert.doesNotMatch(
			source,
			new RegExp(`(export\\s+)?(async\\s+)?function\\s+${name}\\b`),
			`${name} is re-declared in src/diff-review.ts — the ladder must be imported, not copied`,
		);
	}

	// The two ladders have different *budgets* and one implementation of the
	// policy that spends them: the plan gate keeps its one revise per artifact,
	// the diff review gets REVIEW_MAX_ATTEMPTS reviews per branch, and both are
	// declared in contracts.ts and applied by gate.ts — never re-decided here.
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
	// And GateVerdictSchema was not grown to carry a diff's fields.
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

test("configured diff preferences reach spawn/argv, preserve inherited axes/effort and reread settings", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const cases = ["project", "mandate", "explicit", "reread"] as const;
	const models = cases.map((source) => b.script(`review-pref-${source}`, [verdictCall(`cp-diffpref-${source}`)]));
	b.seal();
	const spawns = captureSpawns(b.manager);
	for (const [index, source] of cases.entries()) {
		const jobId = `cp-diffpref-${source}`, model = models[index]!;
		b.pushJobBranch(jobId); await b.shipRecord(jobId, { routing: { scope: "L", risk: "high", inferred: false } });
		await b.registry.setReviewerModel(PROJECT, source === "reread" ? model : models[0]!);
		if (source === "mandate" || source === "explicit") b.mandates.issue({ projects: [PROJECT], job_ids: [jobId], objective: "review", reviewer_model: models[1]!, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
		const result = await b.review.reviewAndWait({ jobId, ...(source === "explicit" ? { model } : {}) });
		assert.equal(result.model, model);
		assert.equal(result.verdict.verdict, "pass");
		assert.equal(argOf(spawns[index]?.args ?? [], "--model"), model);
		assert.equal(argOf(spawns[index]?.args ?? [], "--thinking"), "high");
		const events = readFileSync(join(b.home, paths.reviewRunDir(jobId, 1), "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const selected = events.find((event) => event.type === "reviewer_model_selected");
		assert.equal(selected?.payload.source, source === "reread" ? "project" : source);
		assert.equal(selected?.payload.model, model);
		const routing = events.find((event) => event.type === "routing_resolved")?.payload;
		assert.deepEqual([routing.scope, routing.risk, routing.provenance], ["L", "high", { scope: "inherited", risk: "inherited" }]);
		await b.registry.setReviewerModel(PROJECT, "unavailable/reviewer");
		const grant = b.mandates.list().find((grant) => grant.job_ids?.includes(jobId));
		if (grant) b.mandates.setReviewerModel(grant.id, "unavailable/reviewer");
		const reused = await b.review.start({ jobId });
		assert.ok(!isDiffReviewWait(reused));
		assert.equal(reused.verdict.model, model, "the same-head complete pass survives a preference change");
		assert.equal(spawns.length, index + 1);
	}
});

for (const refusal of ["allowlist", "availability", "effort"] as const) {
	test(`configured diff preference refuses ${refusal} without fallback`, async (t) => {
		let chosen = "";
		const b = await reviewBenchOf(t, { probe: { isAvailable: (model) => refusal !== "availability" || model !== chosen, supportedThinking: (model) => refusal === "effort" && model === chosen ? ["low"] : ["high"] } });
		const jobId = `cp-diffpref-${refusal}`;
		chosen = b.script(`review-refuse-${refusal}`, [verdictCall(jobId)]);
		const spare = b.script(`review-spare-${refusal}`, [verdictCall(jobId)]);
		b.routing.rubric.push({ id: "available-spare", role: "gate-reviewer", model: spare, fallbacks: [spare] });
		if (refusal === "allowlist") b.routing.allow = [spare];
		b.pushJobBranch(jobId); await b.shipRecord(jobId);
		await b.registry.setReviewerModel(PROJECT, chosen);
		b.seal();
		const spawns = captureSpawns(b.manager);
		await assert.rejects(() => b.review.start({ jobId }));
		assert.equal(spawns.length, 0);
	});
}

test("role deny refuses a configured and an explicit cp_review model without fallback (cp-7re9)", async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-diffpref-deny";
	const chosen = b.script("review-deny-chosen", [verdictCall(jobId)]);
	const spare = b.script("review-deny-spare", [verdictCall(jobId)]);
	b.routing.rubric.push({ id: "available-spare", role: "gate-reviewer", model: spare, fallbacks: [spare] });
	b.routing.deny_by_role = { "gate-reviewer": [chosen] };
	b.pushJobBranch(jobId); await b.shipRecord(jobId);
	await b.registry.setReviewerModel(PROJECT, chosen);
	b.seal();
	const spawns = captureSpawns(b.manager);
	await assert.rejects(() => b.review.start({ jobId }), /not allowed for role gate-reviewer/);
	await assert.rejects(() => b.review.start({ jobId, model: chosen }), /not allowed for role gate-reviewer/);
	assert.equal(spawns.length, 0, "a denied reviewer model never spawns and never falls back to the spare");
});

// ---------------------------------------------------------------------------
// cp-reviewer-routing: the reviewer inherits the ship job's own route
// ---------------------------------------------------------------------------

test(
	"cp-reviewer-routing: a read-only reviewer still inherits the ship job's high-impact axes",
	{ timeout: 120_000 },
	async (t) => {
		const b = await reviewBenchOf(t);
		const jobId = "cp-review-routed";
		const head = b.pushJobBranch(jobId);
		const narrow = b.script("review-narrow", [verdictCall(jobId)]);
		const broad = b.script("review-broad", [verdictCall(jobId)]);
		b.seal();
		b.routing.rubric.push(
			{ id: "reviews-large", role: "gate-reviewer", scope: ["L"], risk: "high", model: narrow, thinking: "medium" },
			{ id: "reviews-default", role: "gate-reviewer", model: broad, thinking: "low" },
		);
		// The subject is a ship job routed L/high. The reviewer only reads — but what
		// it reads is that job's diff, so the impact is the same impact.
		await b.shipRecord(jobId, {
			routing: { scope: "L", risk: "high", inferred: false, provenance: { scope: "explicit", risk: "inferred" } },
		});
		const spawns = captureSpawns(b.manager);

		const result = await b.review.reviewAndWait({ jobId });

		assert.equal(result.verdict.verdict, "pass");
		assert.equal(result.verdict.head_sha, head);
		assert.equal(result.model, narrow, "the L/high row fired for the reviewer too");
		assert.equal(spawns.length, 1);
		assert.equal(spawns[0]?.request.model, narrow);
		assert.equal(spawns[0]?.request.thinking, "medium");
		assert.equal(argOf(spawns[0]?.args ?? [], "--thinking"), "medium", "the resolved effort reaches the argv");
		// The reviewer is still a research-shaped worker: inheriting the route is not
		// inheriting the kind.
		assert.equal(spawns[0]?.request.identity.kind, "research");

		const payload = readFileSync(join(b.home, paths.reviewRunDir(jobId, 1), "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
			.filter((event) => event.type === "routing_resolved");
		assert.equal(payload.length, 1, "recorded once per attempt");
		assert.deepEqual(payload[0]?.payload, {
			surface: "review",
			attempt: 1,
			model: narrow,
			source: "rubric",
			rule: "reviews-large",
			thinking: "medium",
			scope: "L",
			risk: "high",
			provenance: { scope: "inherited", risk: "inherited" },
			subject_provenance: { scope: "explicit", risk: "inferred" },
			line: `source=rubric model=${narrow} rule=reviews-large thinking=medium`,
		});
	},
);

test(
	"pi-command-post-0a9: the diff reviewer spawns the fallback candidate and records the attempt",
	{ timeout: 120_000 },
	async (t) => {
		const b = await reviewBenchOf(t);
		const jobId = "cp-review-fallback";
		b.pushJobBranch(jobId);
		const spare = b.script("review-spare", [verdictCall(jobId)]);
		b.seal();
		// The preferred candidate's provider is unauthenticated here (MOCK_ONLY).
		b.routing.rubric.push({
			id: "reviews",
			role: "gate-reviewer",
			model: "unauth/opus",
			fallbacks: [spare],
			thinking: "low",
		});
		await b.shipRecord(jobId);
		const spawns = captureSpawns(b.manager);

		const result = await b.review.reviewAndWait({ jobId });

		assert.equal(result.model, spare, "the diff got read, on the reachable candidate");
		assert.equal(argOf(spawns[0]?.args ?? [], "--model"), spare);
		assert.equal(argOf(spawns[0]?.args ?? [], "--thinking"), "low");
		const payload = readFileSync(join(b.home, paths.reviewRunDir(jobId, 1), "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
			.find((event) => event.type === "routing_resolved")?.payload;
		assert.deepEqual(payload?.attempted, [{ model: "unauth/opus", refusal: "availability" }]);
	},
);

// ---------------------------------------------------------------------------
// Preconditions (Constraints §1) — refusals, each naming the fix
// ---------------------------------------------------------------------------

test("no dispatch record is a refusal that names cp_dispatch, not a verdict", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	b.seal();
	await assert.rejects(
		() => b.review.reviewAndWait({ jobId: "cp-review-unknown" }),
		(error: Error) => {
			assert.match(error.message, /no dispatch record for cp-review-unknown — cannot review/);
			assert.match(error.message, /cp_dispatch/, "the refusal must name the fix");
			return true;
		},
	);
	assert.equal(existsSync(join(b.home, paths.reviewFile("cp-review-unknown", 1))), false);
});

test("a research job is refused: there is no diff to review, and cp_gate is named", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	b.seal();
	const jobId = "cp-review-research";
	await b.shipRecord(jobId, { kind: "research" });
	await assert.rejects(
		() => b.review.reviewAndWait({ jobId }),
		(error: Error) => {
			assert.match(error.message, /kind:research/);
			assert.match(error.message, /cp_gate/, "the refusal must name the fix");
			return true;
		},
	);
	assert.equal(existsSync(join(b.home, paths.reviewFile(jobId, 1))), false);
});

test("an unpushed branch is refused, and the refusal names the push", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	b.seal();
	const jobId = "cp-review-unpushed";
	await b.shipRecord(jobId);
	await assert.rejects(
		() => b.review.reviewAndWait({ jobId }),
		(error: Error) => {
			assert.match(error.message, /branch not pushed — cannot review/);
			assert.match(error.message, new RegExp(`git push -u origin ${jobId}`), "the refusal must name the fix");
			return true;
		},
	);
	assert.equal(existsSync(join(b.home, paths.reviewFile(jobId, 1))), false);
});

// ---------------------------------------------------------------------------
// headSha: the freshness signal a caller needs before it trusts a verdict
// (cp-diffgate-pipeline-step-g3k)
// ---------------------------------------------------------------------------

test("headSha answers from the canonical clone, and says 'cannot answer' rather than guessing", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	b.seal();
	const jobId = "cp-review-head";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);

	assert.equal(await b.review.headSha(jobId), head, "the head is origin/<branch> in the clone, never a worktree");

	// A second commit moves it: this is exactly the signal that makes a verdict
	// about the previous commit stale.
	b.repo.git("checkout", "--quiet", jobId);
	b.repo.write("src/app.ts", "export const x = 2;\n");
	b.repo.commitAll("a fix commit");
	b.repo.git("push", "--quiet", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);
	const moved = await b.review.headSha(jobId);
	assert.notEqual(moved, head, "a pushed fix commit moves the head");
	assert.equal(moved, b.repo.head(jobId));

	// The three "cannot answer" cases are undefined, never a throw and never a
	// stale answer: no dispatch record, not a ship job, branch not pushed.
	assert.equal(await b.review.headSha("cp-review-head-unknown"), undefined);
	await b.shipRecord("cp-review-head-research", { kind: "research" });
	assert.equal(await b.review.headSha("cp-review-head-research"), undefined);
	await b.shipRecord("cp-review-head-unpushed");
	assert.equal(await b.review.headSha("cp-review-head-unpushed"), undefined);
});

// ---------------------------------------------------------------------------
// The ladder, end to end
// ---------------------------------------------------------------------------

test("pass: the verdict is recorded with head_sha + diff_stat, and the diff body never leaves the scratch dir", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-pass";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const model = b.script("review-pass", [verdictCall(jobId, { reasons: ["one file, tested", "no risk"] })]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });

	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.cause, null);
	assert.equal(result.next, "proceed");
	assert.equal(result.model, model);
	assert.equal(result.verdict.attempt, 1);
	assert.equal(result.verdict.head_sha, head, "the verdict names the commit it reviewed");
	assert.equal(result.verdict.diff_stat.files, 1);
	assert.equal(result.verdict.diff_stat.truncated, false);

	// On disk, schema-valid, and countable by the next attempt.
	const decision = JSON.parse(readFileSync(join(b.home, paths.reviewFile(jobId, 1)), "utf8")) as DiffVerdict;
	assert.ok(validate<DiffVerdict>(DiffVerdictSchema, decision).ok);
	assert.equal(readPriorAttempts(b.home, jobId, paths.reviewFile, DiffVerdictSchema).attempt, 2);
	assert.equal(readPriorAttempts(b.home, jobId, paths.gateFile).attempt, 1, "a review is not a gate attempt");

	// The verdict is exactly what the shared ladder would decide for this review,
	// minus `rubric` (cp-950e): that field names the gate's implementation-plan
	// rubric, which a diff review does not apply, so `diff-review.ts` strips it
	// and `DiffVerdictSchema` admits no such property.
	const { raw: _raw, rubric: _rubric, ...expected } = decideGate({
		jobId,
		attempt: 1,
		prior: NO_PRIOR,
		model,
		review: result.review as GateReview,
		at: decision.decided_at,
	});
	assert.ok(!("rubric" in decision), "a diff verdict never carries the gate's plan rubric");
	assert.deepEqual(
		{ ...decision, head_sha: undefined, patch_id: undefined, diff_stat: undefined },
		{ ...expected, head_sha: undefined, patch_id: undefined, diff_stat: undefined },
	);

	// The reviewer's own run: its write-once verdict, its events, its scratch cwd.
	assert.ok(existsSync(join(b.home, paths.reviewVerdictFile(jobId, 1))));
	assert.ok(existsSync(join(b.home, paths.reviewRunDir(jobId, 1), "events.jsonl")));
	const scratch = join(b.home, paths.reviewScratchDir(jobId, 1));
	// This job froze no task, so the packet is the diff alone (do8.4) — and the
	// brief says so rather than letting the reviewer assume it saw what was asked.
	assert.deepEqual(readdirSync(scratch), ["diff.md"], "the reviewer's cwd holds the diff and nothing else");
	const materialized = readFileSync(join(scratch, "diff.md"), "utf8");
	assert.ok(materialized.includes(BODY_MARKER), "the reviewer really was given the diff body");

	// The brief pointed at the materialized copy, never at the clone or a worktree.
	const brief = readFileSync(join(b.home, paths.reviewRunDir(jobId, 1), "brief.md"), "utf8");
	assert.ok(brief.includes(join(scratch, "diff.md")));
	assert.ok(!brief.includes(BODY_MARKER), "the brief points at the diff; it never inlines it");
	assert.match(brief, /Original task: not available/);
	assert.ok(!brief.includes("${"), "no unsubstituted placeholder reaches a reviewer");

	// The job's own log learns the outcome, never the diff.
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.match(events, /review_decided/);
	assert.ok(!events.includes(BODY_MARKER), "a diff body must never reach a log line");

	// One-shot, and relayable without the body.
	assert.equal(b.manager.get(`${jobId}#review-1`), undefined);
	const rendered = formatDiffReview(result);
	assert.match(rendered, /diff review attempt 1: pass/);
	assert.ok(!rendered.includes(BODY_MARKER));
});

test("pass with a decision_summary: the gate-only field is projected out, the verdict persists and wakes the parent", { timeout: 120_000 }, async (t) => {
	// Incident cp-review-receipt-diagnosis: a reviewer's schema-valid
	// `decision_summary` rode into `DiffVerdict` (additionalProperties: false),
	// `#persist` threw, and the held PR waited on a verdict that never landed.
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-summary";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const model = b.script("review-summary", [
		verdictCall(jobId, {
			decision_summary: {
				would_make_wrong: "Omitting verification would approve unseen behavior.",
				verified: "Inspected the one-file diff and its test.",
			},
		}),
	]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });

	assert.equal(result.next, "proceed");
	const decision = JSON.parse(readFileSync(join(b.home, paths.reviewFile(jobId, 1)), "utf8")) as DiffVerdict;
	assert.ok(validate<DiffVerdict>(DiffVerdictSchema, decision).ok);
	assert.equal(decision.verdict, "pass");
	assert.equal(decision.head_sha, head);
	assert.ok(!("decision_summary" in decision), "a diff verdict never carries the gate-only summary");
	assert.equal(readPriorAttempts(b.home, jobId, paths.reviewFile, DiffVerdictSchema).attempt, 2);
	assert.equal(b.sent.length, 1, "exactly one cp-verdict wake-up");
	assert.equal(b.sent[0]?.headSha, head);
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.doesNotMatch(events, /review_orphaned/);
});

test("incident replay: a stranded review-1/verdict.json with a decision_summary is decided once on the unchanged head", { timeout: 120_000 }, async (t) => {
	// The orphan shape the incident left behind: the reviewer's write-once scratch
	// verdict on disk, no review-1.json, the PR held. One cp_review settles it.
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-stranded";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const stranded = join(b.home, paths.reviewVerdictFile(jobId, 1));
	mkdirSync(join(stranded, ".."), { recursive: true });
	const review = diffReview({
		job_id: jobId,
		decision_summary: { would_make_wrong: "An unseen hunk.", verified: "Read the whole one-file diff." },
	});
	writeFileSync(stranded, JSON.stringify({ schema_version: 1, job_id: jobId, received_at: isoTimestamp(), attempt: 1, review }));
	const model = b.script("review-stranded", [verdictCall(jobId)]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });

	assert.equal(result.next, "proceed");
	assert.equal(result.verdict.attempt, 1);
	assert.ok(existsSync(stranded), "the scratch verdict is evidence; nothing deletes it");
	const decision = JSON.parse(readFileSync(join(b.home, paths.reviewFile(jobId, 1)), "utf8")) as DiffVerdict;
	assert.ok(validate<DiffVerdict>(DiffVerdictSchema, decision).ok);
	assert.equal(decision.head_sha, head);
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.headSha, head);
	assert.equal(listPendingReviews(b.home, jobId).length, 0, "one reviewer, and it is gone");
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

test("a patch-identical rebased head inherits a pass without spawning or spending an attempt", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-equivalent";
	const firstHead = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const model = b.script("review-equivalent", [verdictCall(jobId)]);
	const changedModel = b.script("review-after-equivalent", [verdictCall(jobId)]);
	b.seal();
	const spawns = captureSpawns(b.manager);
	const first = await b.review.reviewAndWait({ jobId, model });

	b.repo.git("checkout", "--quiet", b.repo.branch);
	b.repo.write("base-only.txt", "base moved\n");
	b.repo.commitAll("move base");
	b.repo.git("push", "--quiet", "origin", b.repo.branch);
	b.repo.git("checkout", "--quiet", jobId);
	b.repo.git("rebase", b.repo.branch);
	b.repo.git("push", "--quiet", "--force", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);
	const rebasedHead = b.repo.head(jobId);

	const equivalent = await b.review.reviewAndWait({ jobId, model });
	assert.notEqual(rebasedHead, firstHead);
	assert.equal(equivalent.verdict.head_sha, rebasedHead);
	assert.deepEqual(equivalent.verdict.equivalent_to, { head_sha: firstHead, attempt: 1 });
	assert.equal(equivalent.verdict.patch_id, first.verdict.patch_id);
	assert.equal(spawns.length, 1, "equivalence never spawns a second reviewer");
	assert.equal(readPriorAttempts(b.home, jobId, paths.reviewFile, DiffVerdictSchema).attempt, 2, "equivalence spends no attempt");
	assert.ok(readReviewPassHeads(b.home, jobId).includes(rebasedHead));
	assert.equal(readReviewPassVerdict(b.home, jobId, rebasedHead)?.equivalent_to?.head_sha, firstHead);

	b.repo.git("checkout", "--quiet", jobId);
	b.repo.write("src/after-rebase.ts", "export const afterRebase = true;\n");
	b.repo.commitAll("change after rebase");
	b.repo.git("push", "--quiet", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);
	const changed = await b.review.reviewAndWait({ jobId, model: changedModel });
	assert.equal(changed.verdict.delta_from, rebasedHead, "the latest equivalent head is the delta base");
	assert.match(readFileSync(join(b.home, paths.reviewScratchDir(jobId, 2), "diff.md"), "utf8"), /after-rebase/);
});

test("a paused or revoked covering mandate refuses new reviewer spend; a newer active grant lets it run", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-mandate";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const model = b.script("review-mandate", [verdictCall(jobId)]);
	b.seal();
	const spawns = captureSpawns(b.manager);
	const grant = (objective: string) =>
		b.mandates.issue({ projects: [PROJECT], objective, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 20, tokens: 1_000_000 }, job_cap: 10 });

	const old = grant("the old grant");
	b.mandates.pause(old.id, "spend_cap");
	await assert.rejects(
		() => b.review.start({ jobId, model }),
		(error: Error) => error instanceof MandateError && /is paused \(spend_cap\) .*no new reviewer spend/.test(error.message),
	);
	b.mandates.revoke(old.id);
	await assert.rejects(() => b.review.start({ jobId, model }), /is revoked .*no new reviewer spend/);
	assert.equal(spawns.length, 0, "no reviewer was spawned under a paused or revoked grant");

	grant("the replacement grant");
	const result = await b.review.reviewAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "pass", "the active grant covers the job, whatever the old one says");
	assert.equal(spawns.length, 1);
});

test("a changed head reviews only its delta and retains prior findings plus a full-diff fallback", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-delta";
	const firstHead = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const first = b.script("review-delta-1", [verdictCall(jobId, { reasons: ["[severity: medium] [confidence: high] src/app.ts:1 — prior finding"] })]);
	const second = b.script("review-delta-2", [verdictCall(jobId)]);
	b.seal();
	await b.review.reviewAndWait({ jobId, model: first });

	b.repo.git("checkout", "--quiet", jobId);
	b.repo.write("src/fix.ts", "export const fixed = true;\n");
	b.repo.commitAll("follow-up fix");
	b.repo.git("push", "--quiet", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);
	const result = await b.review.reviewAndWait({ jobId, model: second });
	const scratch = join(b.home, paths.reviewScratchDir(jobId, 2));

	assert.equal(result.verdict.delta_from, firstHead);
	assert.match(readFileSync(join(scratch, "diff.md"), "utf8"), /src\/fix\.ts/);
	assert.doesNotMatch(readFileSync(join(scratch, "diff.md"), "utf8"), /src\/app\.ts/);
	assert.match(readFileSync(join(scratch, "full-diff.md"), "utf8"), /src\/app\.ts/);
	assert.match(readFileSync(join(scratch, "prior-verdict.json"), "utf8"), /prior finding/);
	assert.match(readFileSync(join(b.home, paths.reviewRunDir(jobId, 2), "brief.md"), "utf8"), /delta review/);
});

// ---------------------------------------------------------------------------
// The review packet (do8.4): the diff plus the frozen original task, bounded,
// handed over as files and never inlined into the brief.
// ---------------------------------------------------------------------------

test("the packet is the diff and the frozen original task, both as files, neither inlined", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-task";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	// Exactly what cp_dispatch freezes beside the brief.
	mkdirSync(join(b.home, paths.runDir(jobId)), { recursive: true });
	const task = `Bound every retry. ${TASK_MARKER}\n`;
	writeFileSync(join(b.home, paths.originalTaskFile(jobId)), task);
	const model = b.script("review-task", [verdictCall(jobId)]);
	b.seal();

	await b.review.reviewAndWait({ jobId, model });

	const scratch = join(b.home, paths.reviewScratchDir(jobId, 1));
	assert.deepEqual(
		readdirSync(scratch).sort(),
		["diff.md", ORIGINAL_TASK_COPY],
		"the reviewer's cwd holds the diff and the frozen task, and nothing else",
	);
	assert.equal(readFileSync(join(scratch, ORIGINAL_TASK_COPY), "utf8"), task, "copied file-to-file, in full");

	const brief = readFileSync(join(b.home, paths.reviewRunDir(jobId, 1), "brief.md"), "utf8");
	assert.ok(brief.includes(join(scratch, ORIGINAL_TASK_COPY)), "the brief names the task file");
	assert.ok(!brief.includes(TASK_MARKER), "the brief points at the task; it never inlines it");
	assert.match(brief, /source of truth for what was asked/);
	assert.ok(!brief.includes("${"), "no unsubstituted placeholder reaches a reviewer");
	assert.equal(brief, assembleBrief({
		profile: loadProfile(PROFILES_DIR, "gate-reviewer"),
		template: readBriefTemplate(BRIEFS_DIR, "diff-review-rubric"), templatePath: "diff-review-rubric",
		values: {
			job_id: jobId, project: PROJECT, branch: jobId, artifact_path: join(scratch, "diff.md"),
			original_task: diffOriginalTaskBlock(join(scratch, ORIGINAL_TASK_COPY)),
			review_context: "This is the first review on the branch; diff.md is the complete branch diff.",
		},
	}), "no addenda produces the identical pre-amendment brief");

	// The task body is a file the reviewer reads, never a thing the parent logs.
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.ok(!events.includes(TASK_MARKER), "an original task must never reach a log line");
});

test("the diff-review brief includes ordered authorized addenda with provenance", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-addenda";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	mkdirSync(join(b.home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(join(b.home, paths.originalTaskFile(jobId)), "Original scope.");
	const addenda = [1, 2].map((n) => ({ schema_version: 1, n, added_at: "2026-09-24T10:00:00Z", by: "operator-quote", quote: "approved", reason: "coverage", text: `Extra scope ${n}.` }));
	writeFileSync(join(b.home, paths.taskAddendaFile(jobId)), addenda.map((row) => JSON.stringify(row) + "\n").join(""));
	const model = b.script("review-addenda", [verdictCall(jobId)]);
	b.seal();
	await b.review.reviewAndWait({ jobId, model });
	const scratch = join(b.home, paths.reviewScratchDir(jobId, 1));
	const brief = readFileSync(join(b.home, paths.reviewRunDir(jobId, 1), "brief.md"), "utf8");
	assert.ok(brief.includes(join(scratch, ORIGINAL_TASK_COPY)));
	assert.ok(brief.includes(join(scratch, "task-addenda.md")));
	assert.match(brief, /Addendum 1 \(operator-quote, 2026-09-24T10:00:00Z\)/);
	assert.match(brief, /authorized scope/);
	assert.match(brief, /not their presence as scope growth/);
	assert.ok(brief.indexOf("Addendum 1") < brief.indexOf("Addendum 2"));
	const body = readFileSync(join(scratch, "task-addenda.md"), "utf8");
	assert.match(body, /Extra scope 1\./);
	assert.match(body, /Extra scope 2\./);
	assert.match(body, /Quote: "approved"/);
	assert.ok(!brief.includes("Extra scope 1."));
});

test("diffOriginalTaskBlock is a pointer and a boundary, never a body", () => {
	const absent = diffOriginalTaskBlock(undefined);
	assert.match(absent, /Original task: not available/);
	assert.match(absent, /claim nothing about requirement coverage/);

	const block = diffOriginalTaskBlock("/tmp/cp/review-1/review/original-task.md");
	assert.ok(block.includes("/tmp/cp/review-1/review/original-task.md"), "the block names the path");
	assert.match(block, /Read that file first, in full/);
	assert.match(block, /never evidence of what was asked/);
});

test("an oversized frozen task is bounded before it reaches the packet, and says so", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-task-big";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	mkdirSync(join(b.home, paths.runDir(jobId)), { recursive: true });
	const line = `${"requirement ".repeat(8)}\n`;
	const huge = line.repeat(Math.ceil((REVIEW_ORIGINAL_TASK_MAX_BYTES * 1.5) / line.length)) + `tail ${TASK_MARKER}\n`;
	writeFileSync(join(b.home, paths.originalTaskFile(jobId)), huge);
	const model = b.script("review-task-big", [verdictCall(jobId)]);
	b.seal();

	await b.review.reviewAndWait({ jobId, model });

	const copy = readFileSync(join(b.home, paths.reviewScratchDir(jobId, 1), ORIGINAL_TASK_COPY), "utf8");
	assert.ok(
		Buffer.byteLength(copy, "utf8") < Buffer.byteLength(huge, "utf8"),
		"an oversized task is not copied whole into a reviewer's packet",
	);
	assert.ok(!copy.includes(TASK_MARKER), "the tail past the cap is not shown");
	assert.match(copy, /bounded review packet/, "the truncation is stated in the file the reviewer reads");
	assert.match(copy, new RegExp(`${Buffer.byteLength(huge, "utf8")} bytes`), "the note names the real size");
	assert.ok(copy.startsWith("requirement"), "what is shown is the head of the task, unaltered");
});

test("revise: the live implementer is promoted for a fix commit on the same branch", { timeout: 180_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-revise";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const first = b.script("review-revise-1", [
		verdictCall(jobId, { verdict: "revise", reasons: ["[severity: high] [confidence: high] no test for the new branch"], revisions: ["add a test for src/app.ts"] }),
	]);
	const second = b.script("review-revise-2", [
		verdictCall(jobId, { verdict: "revise", reasons: ["[severity: high] [confidence: high] still untested"], revisions: ["again"] }),
	]);
	b.script("implementer", [{ kind: "text", text: "standing by" }], { onExhausted: "repeat" });
	b.seal();
	await b.liveImplementer(jobId);

	const result = await b.review.reviewAndWait({ jobId, model: first });
	assert.equal(result.verdict.verdict, "revise");
	assert.equal(result.next, "revise");
	assert.deepEqual(result.verdict.revisions, ["add a test for src/app.ts"]);
	assert.equal(result.revise_receipt, "delivered", `revise not delivered: ${result.revise_error}`);
	assert.equal(result.revise_error, undefined);

	// The promote says: same branch, one more commit, never a second PR, and how
	// much of the branch's review budget is left (cp-review-until-clean-sq68).
	const message = diffReviseMessage(result.verdict);
	assert.match(message, /add a test for src\/app\.ts/);
	assert.match(message, new RegExp(`same branch \\(${jobId}\\)`));
	assert.match(message, /never a second PR/);
	assert.match(message, new RegExp(`review 1 of ${REVIEW_MAX_ATTEMPTS}`));
	assert.match(message, /4 reviews remain/);
	assert.doesNotMatch(message, /only revision available/, "the loop continues until pass or the cap");

	// The run log records a delivered promote as a receipt, never as a payload.
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.match(events, /"type":"prompt_sent","payload":\{"receipt":"delivered"/);
	assert.ok(!events.includes("add a test for src/app.ts"));

	// Second attempt: still a review, still a revise. A prior revise is not the
	// cap any more — the branch is reviewed until it comes back clean.
	const again = await b.review.reviewAndWait({ jobId, model: second });
	assert.equal(again.verdict.attempt, 2);
	assert.equal(again.verdict.verdict, "revise");
	assert.equal(again.next, "revise");
	assert.equal(again.revise_receipt, "delivered", `second revise not delivered: ${again.revise_error}`);
	assert.match(diffReviseMessage(again.verdict), new RegExp(`review 2 of ${REVIEW_MAX_ATTEMPTS}`));
});

test("revise with the worker gone: revise_error and surface — never a retry, never a re-dispatch", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-revise-gone";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	// A record, but no live worker in this session: exactly the state a torn-down
	// or crashed implementer leaves behind.
	const model = b.script("review-revise-gone", [
		verdictCall(jobId, { verdict: "revise", reasons: ["[severity: high] [confidence: high] needs a test"], revisions: ["add one"] }),
	]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "revise", "the verdict is still what the reviewer said");
	assert.equal(result.revise_receipt, undefined);
	assert.ok(result.revise_error);
	assert.match(result.revise_error as string, /no live worker/);
	assert.equal(result.next, "surface", "an undelivered revise goes to the operator, never round the loop again");

	// Nothing was re-run and nothing was re-dispatched: one attempt, one reviewer.
	assert.equal(readPriorAttempts(b.home, jobId, paths.reviewFile, DiffVerdictSchema).attempt, 2);
	assert.equal(existsSync(join(b.home, paths.reviewFile(jobId, 2))), false);
	assert.equal(b.provider.requests("review-revise-gone").length, 1, "the review ran exactly once");
	assert.match(formatDiffReview(result), /revise NOT delivered/);
});

test("flags: a reviewer pass with a flag is reported, never a veto", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-flag";
	b.pushJobBranch(jobId, { "migrations/001-drop.sql": "DROP TABLE users;\n" });
	await b.shipRecord(jobId);
	const model = b.script("review-flag", [
		verdictCall(jobId, { verdict: "pass", flags: { ...NO_FLAGS, destructive_scope: true }, reasons: ["the diff drops a table"] }),
	]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.cause, null);
	assert.equal(result.verdict.flags.destructive_scope, true);
	assert.ok(result.verdict.reasons.some((reason) => reason.includes("flag reported, no veto: destructive_scope")));
	assert.ok(!result.verdict.reasons.some((reason) => reason.includes("flag forced escalate")));
	assert.equal(result.next, "proceed");
});

test("escalate/policy: a stat overflow decides itself — no reviewer is spawned at all", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-wide";
	const files: Record<string, string> = {};
	for (let i = 0; i <= DIFF_REVIEW_MAX_STAT_FILES; i += 1) files[`file-${i}.txt`] = "x\n";
	const head = b.pushJobBranch(jobId, files);
	await b.shipRecord(jobId);
	// A model is offered and must go unused: the decision is the orchestrator's.
	const model = b.script("review-wide", [verdictCall(jobId)]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });

	assert.equal(result.verdict.verdict, "escalate");
	assert.equal(result.verdict.cause, "policy");
	assert.equal(result.next, "surface");
	assert.equal(result.model, undefined, "no reviewer model was used");
	assert.equal(result.review, undefined);
	assert.equal(result.verdict.head_sha, head);
	assert.equal(result.verdict.diff_stat.files, DIFF_REVIEW_MAX_STAT_FILES + 1);
	const reasons = result.verdict.reasons.join(" ");
	assert.match(reasons, new RegExp(`${DIFF_REVIEW_MAX_STAT_FILES + 1} file`), "the reason names the file count");
	assert.match(reasons, /DIFF_REVIEW_MAX_STAT_FILES/, "the reason names the cap");

	// Nothing was materialized, nothing was briefed, nothing was asked of a model.
	assert.equal(existsSync(join(b.home, paths.reviewScratchDir(jobId, 1), "diff.md")), false);
	assert.equal(existsSync(join(b.home, paths.reviewRunDir(jobId, 1), "brief.md")), false);
	assert.equal(b.provider.requests("review-wide").length, 0, "a stat overflow must never reach a model");
	assert.equal(b.provider.remaining("review-wide"), 1, "the reviewer's script was never consumed");
	// The decision is still a first-class attempt on disk.
	assert.ok(validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(readFileSync(join(b.home, paths.reviewFile(jobId, 1)), "utf8"))).ok);
});

/** A generated-results file that alone exceeds the byte cap (the PR #6 shape). */
function bigCsv(bytes: number): string {
	const row = "2026-09-22,backtest,0.123456,0.654321,filler-filler-filler\n";
	return row.repeat(Math.ceil(bytes / row.length));
}

test("escalate/policy: omitted hunks under the file cap stop the review — no reviewer, the omitted code is named", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-bytes";
	// `data/` sorts before `src/`: the CSV fills the budget and hides the code.
	const head = b.pushJobBranch(jobId, {
		"data/results.csv": bigCsv(DIFF_REVIEW_MAX_BYTES - 20_000),
		"src/check.ts": `export const check = "${BODY_MARKER}";\n// ${"x".repeat(30_000)}\n`,
	});
	await b.shipRecord(jobId);
	const model = b.script("review-bytes", [verdictCall(jobId)]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });

	assert.deepEqual([result.verdict.verdict, result.verdict.cause, result.next], ["escalate", "policy", "surface"]);
	assert.equal(result.model, undefined, "no reviewer model was used");
	assert.equal(result.verdict.head_sha, head);
	assert.deepEqual(result.verdict.diff_stat, { files: 2, truncated: true });
	const reasons = result.verdict.reasons.join(" ");
	assert.match(reasons, /DIFF_REVIEW_MAX_BYTES/);
	assert.match(reasons, new RegExp(String(DIFF_REVIEW_MAX_BYTES)));
	assert.match(reasons, /omitted: src\/check\.ts/, "the hidden code is named, not the visible CSV passed");
	assert.doesNotMatch(reasons, /omitted: data\/results\.csv/, "the CSV fit; the code behind it did not");
	assert.equal(existsSync(join(b.home, paths.reviewRunDir(jobId, 1), "brief.md")), false);
	assert.equal(b.provider.requests("review-bytes").length, 0, "a partial subject never reaches a model");
	assert.equal(readReviewPassVerdict(b.home, jobId, head), undefined);
	assert.equal(b.sent.length, 0, "decided synchronously: no pending, no wake-up");
});

test("a historical truncated pass with the same patch-id is never inherited: the rebased head is reviewed in full", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-old-partial";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const first = b.script("review-old-partial-1", [verdictCall(jobId)]);
	const second = b.script("review-old-partial-2", [verdictCall(jobId)]);
	b.seal();
	await b.review.reviewAndWait({ jobId, model: first });
	// A pass persisted before this rule existed, over a truncated subject.
	const file = join(b.home, paths.reviewFile(jobId, 1));
	const old = JSON.parse(readFileSync(file, "utf8")) as DiffVerdict;
	writeFileSync(file, JSON.stringify({ ...old, diff_stat: { ...old.diff_stat, truncated: true } }));

	b.repo.git("checkout", "--quiet", b.repo.branch);
	b.repo.write("base-only.txt", "base moved\n");
	b.repo.commitAll("move base");
	b.repo.git("push", "--quiet", "origin", b.repo.branch);
	b.repo.git("checkout", "--quiet", jobId);
	b.repo.git("rebase", b.repo.branch);
	b.repo.git("push", "--quiet", "--force", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);
	const rebased = b.repo.head(jobId);

	const result = await b.review.reviewAndWait({ jobId, model: second });
	assert.equal(result.verdict.equivalent_to, undefined, "no equivalence to a partial pass");
	assert.equal(result.verdict.attempt, 2);
	assert.equal(result.verdict.delta_from, undefined, "a partial pass is not a delta baseline either");
	assert.equal(b.provider.requests("review-old-partial-2").length > 0, true, "the complete subject was reviewed");
	assert.equal(readReviewPassVerdict(b.home, jobId, rebased)?.attempt, 2);
});

test("a small complete delta over an oversized branch history is still reviewed; only full-diff.md is bounded", { timeout: 180_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-big-history";
	const firstHead = b.pushJobBranch(jobId, { "data/results.csv": bigCsv(DIFF_REVIEW_MAX_BYTES - 20_000) });
	await b.shipRecord(jobId);
	const first = b.script("review-big-1", [verdictCall(jobId)]);
	const second = b.script("review-big-2", [verdictCall(jobId)]);
	b.seal();
	const opening = await b.review.reviewAndWait({ jobId, model: first });
	assert.equal(opening.verdict.diff_stat.truncated, false, "the first subject was complete");

	b.repo.git("checkout", "--quiet", jobId);
	b.repo.write("data/more.csv", bigCsv(30_000));
	b.repo.write("src/fix.ts", "export const fixed = true;\n");
	b.repo.commitAll("more results and a fix");
	b.repo.git("push", "--quiet", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);

	const result = await b.review.reviewAndWait({ jobId, model: second });
	const scratch = join(b.home, paths.reviewScratchDir(jobId, 2));
	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.delta_from, firstHead);
	assert.equal(result.verdict.diff_stat.truncated, false, "the delta subject is complete");
	assert.match(readFileSync(join(scratch, "diff.md"), "utf8"), /src\/fix\.ts/);
	assert.match(readFileSync(join(scratch, "full-diff.md"), "utf8"), /## Omitted/, "the supplemental history is bounded");
	assert.ok(existsSync(join(scratch, "prior-verdict.json")));
});

test("an incomplete-subject stop on an unchanged head is returned again, never re-spending an attempt", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-bytes-again";
	b.pushJobBranch(jobId, { "data/results.csv": bigCsv(DIFF_REVIEW_MAX_BYTES + 10_000) });
	await b.shipRecord(jobId);
	b.seal();
	const first = await b.review.reviewAndWait({ jobId });
	const again = await b.review.reviewAndWait({ jobId });
	assert.deepEqual([again.verdict.attempt, again.verdict.cause, again.next], [first.verdict.attempt, "policy", "surface"]);
	assert.equal(existsSync(join(b.home, paths.reviewFile(jobId, 2))), false, "no second attempt was spent");
	assert.equal(readPriorAttempts(b.home, jobId, paths.reviewFile, DiffVerdictSchema).attempt, 2);
});

test("a rebase-with-edit onto a base that grew a huge file is reviewed on its own three-dot subject, not a polluted delta", { timeout: 180_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-rebase-edit";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const first = b.script("review-rebase-edit-1", [verdictCall(jobId)]);
	const second = b.script("review-rebase-edit-2", [verdictCall(jobId)]);
	b.seal();
	await b.review.reviewAndWait({ jobId, model: first });

	b.repo.git("checkout", "--quiet", b.repo.branch);
	b.repo.write("upstream/big.csv", bigCsv(DIFF_REVIEW_MAX_BYTES + 10_000));
	b.repo.commitAll("a data batch lands on the base");
	b.repo.git("push", "--quiet", "origin", b.repo.branch);
	b.repo.git("checkout", "--quiet", jobId);
	b.repo.git("rebase", b.repo.branch);
	b.repo.write("src/app.ts", "export const x = 2;\n");
	b.repo.commitAll("conflict-fix style edit");
	b.repo.git("push", "--quiet", "--force", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);

	const result = await b.review.reviewAndWait({ jobId, model: second });
	assert.equal(result.verdict.verdict, "pass", result.verdict.reasons.join(" | "));
	assert.equal(result.verdict.delta_from, undefined, "the old head is not an ancestor: no tree-diff delta");
	assert.equal(result.verdict.diff_stat.truncated, false);
	assert.doesNotMatch(readFileSync(join(b.home, paths.reviewScratchDir(jobId, 2), "diff.md"), "utf8"), /upstream\/big\.csv/);
});

test("a merge of a base that grew a huge file is reviewed on its own three-dot subject, not a polluted delta", { timeout: 180_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-merge-base";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const first = b.script("review-merge-base-1", [verdictCall(jobId)]);
	const second = b.script("review-merge-base-2", [verdictCall(jobId)]);
	b.seal();
	await b.review.reviewAndWait({ jobId, model: first });

	b.repo.git("checkout", "--quiet", b.repo.branch);
	b.repo.write("upstream/big.csv", bigCsv(DIFF_REVIEW_MAX_BYTES + 10_000));
	b.repo.commitAll("a data batch lands on the base");
	b.repo.git("push", "--quiet", "origin", b.repo.branch);
	b.repo.git("checkout", "--quiet", jobId);
	b.repo.git("merge", "--quiet", "--no-edit", b.repo.branch);
	b.repo.write("src/app.ts", "export const x = 2;\n");
	b.repo.commitAll("a small branch-own edit");
	b.repo.git("push", "--quiet", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);

	const result = await b.review.reviewAndWait({ jobId, model: second });
	assert.equal(result.verdict.verdict, "pass", result.verdict.reasons.join(" | "));
	assert.equal(result.verdict.delta_from, undefined, "the fork point moved: no tree-diff delta");
	assert.equal(result.verdict.diff_stat.truncated, false);
	const diff = readFileSync(join(b.home, paths.reviewScratchDir(jobId, 2), "diff.md"), "utf8");
	assert.doesNotMatch(diff, /upstream\/big\.csv/);
	assert.match(diff, /src\/app\.ts/);
});

test("a base that advanced without being merged keeps the delta", { timeout: 180_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-base-advanced";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const first = b.script("review-base-advanced-1", [verdictCall(jobId)]);
	const second = b.script("review-base-advanced-2", [verdictCall(jobId)]);
	b.seal();
	const firstResult = await b.review.reviewAndWait({ jobId, model: first });

	b.repo.git("checkout", "--quiet", b.repo.branch);
	b.repo.write("upstream/other.ts", "export const other = 1;\n");
	b.repo.commitAll("the base advances");
	b.repo.git("push", "--quiet", "origin", b.repo.branch);
	b.repo.git("checkout", "--quiet", jobId);
	b.repo.write("src/fix.ts", "export const fix = 1;\n");
	b.repo.commitAll("a fix commit");
	b.repo.git("push", "--quiet", "origin", jobId);
	b.repo.git("checkout", "--quiet", b.repo.branch);

	const result = await b.review.reviewAndWait({ jobId, model: second });
	assert.equal(result.verdict.delta_from, firstResult.verdict.head_sha);
	const diff = readFileSync(join(b.home, paths.reviewScratchDir(jobId, 2), "diff.md"), "utf8");
	assert.match(diff, /src\/fix\.ts/);
	assert.doesNotMatch(diff, /upstream\/other\.ts/);
});

for (const [label, badHead] of [
	["an unknown", "0".repeat(40)],
	["a malformed", "--not-a-sha"],
] as const) {
	test(`${label} prior head is no delta baseline`, { timeout: 180_000 }, async (t) => {
		const b = await reviewBenchOf(t);
		const jobId = `cp-review-bad-head-${label.split(" ")[1]}`;
		b.pushJobBranch(jobId);
		await b.shipRecord(jobId);
		const first = b.script(`${jobId}-1`, [verdictCall(jobId)]);
		const second = b.script(`${jobId}-2`, [verdictCall(jobId)]);
		b.seal();
		await b.review.reviewAndWait({ jobId, model: first });
		const file = join(b.home, paths.reviewFile(jobId, 1));
		writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), head_sha: badHead }));

		b.repo.git("checkout", "--quiet", jobId);
		b.repo.write("src/fix.ts", "export const fix = 1;\n");
		b.repo.commitAll("a fix commit");
		b.repo.git("push", "--quiet", "origin", jobId);
		b.repo.git("checkout", "--quiet", b.repo.branch);

		const result = await b.review.reviewAndWait({ jobId, model: second });
		assert.equal(result.verdict.delta_from, undefined);
		assert.match(readFileSync(join(b.home, paths.reviewScratchDir(jobId, 2), "diff.md"), "utf8"), /src\/app\.ts/);
	});
}

test("operational ladder: no verdict -> retry -> surface, bounded at two", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-op";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	// A reviewer that talks instead of reporting: no verdict file, ever.
	const silent = b.script("review-silent", [{ kind: "text", text: "the diff looks fine to me" }]);
	b.seal();

	const first = await b.review.reviewAndWait({ jobId, model: silent });
	assert.equal(first.verdict.verdict, "escalate");
	assert.equal(first.verdict.cause, "operational");
	assert.equal(first.next, "retry");
	assert.match(first.verdict.reasons.join(" "), /settled without reporting a verdict/);

	const second = await b.review.reviewAndWait({ jobId, model: silent });
	assert.equal(second.verdict.attempt, 2);
	assert.equal(second.verdict.cause, "operational_persistent");
	assert.equal(second.verdict.delta_from, undefined, "an operational verdict is never a content-review delta base");
	assert.equal(second.next, "surface", "a persistent tool failure stops looping");
	assert.match(
		readFileSync(join(b.home, paths.reviewScratchDir(jobId, 2), "diff.md"), "utf8"),
		new RegExp(BODY_MARKER),
		"a same-head operational retry receives the full three-dot branch subject",
	);
	assert.equal(existsSync(join(b.home, paths.reviewScratchDir(jobId, 2), "full-diff.md")), false);
});

test("the diff is materialized from the canonical clone — the leased worktree is already gone", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-recycled";
	const head = b.pushJobBranch(jobId);
	const worktree = await b.shipRecord(jobId);
	// Teardown returned the lease and the pool recycled the tree, exactly as it
	// does the instant a ship job finishes.
	rmSync(worktree, { recursive: true, force: true });
	assert.equal(existsSync(worktree), false);

	const model = b.script("review-recycled", [verdictCall(jobId)]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.head_sha, head);
	assert.equal(result.diff?.files, 1);
	const materialized = readFileSync(join(b.home, paths.reviewScratchDir(jobId, 1), "diff.md"), "utf8");
	assert.ok(materialized.includes(BODY_MARKER), "the diff came from projects/<name>, not from the recycled worktree");
});

// ---------------------------------------------------------------------------
// Review until clean, bounded at REVIEW_MAX_ATTEMPTS (cp-review-until-clean-sq68)
// ---------------------------------------------------------------------------

/**
 * `n` decisions already on disk for `jobId`, exactly as `n` earlier reviews
 * would have left them. The cap is counted from these files, so seeding them is
 * the same thing as having run the reviews — and it is what makes a
 * five-deep ladder testable without five real reviewer processes.
 */
function seedReviews(home: string, jobId: string, n: number, verdict: "revise" | "pass" = "revise"): void {
	mkdirSync(join(home, LAYOUT.runs, jobId), { recursive: true });
	for (let attempt = 1; attempt <= n; attempt += 1) {
		const decision: DiffVerdict = {
			schema_version: 1,
			job_id: jobId,
			attempt,
			verdict,
			cause: null,
			flags: { ...NO_FLAGS },
			reasons: [`seeded attempt ${attempt}`],
			...(verdict === "revise" ? { revisions: [`fix ${attempt}`] } : {}),
			decided_at: "2024-01-01T00:00:00Z",
			head_sha: "a".repeat(40),
			diff_stat: { files: 1, truncated: false },
		};
		assert.ok(validate<DiffVerdict>(DiffVerdictSchema, decision).ok, "the seeded decision must be schema-valid");
		writeFileSync(join(home, paths.reviewFile(jobId, attempt)), JSON.stringify(decision));
	}
}

test("the cap is reviews-per-branch, not revises-per-branch: the predicate says so before any process runs", () => {
	const asVerdicts = (n: number) => Array.from({ length: n }, () => ({ verdict: "revise" }) as never);
	// The plan gate is untouched: one revise spends its budget.
	assert.equal(gateCapExhausted(asVerdicts(0)), false);
	assert.equal(gateCapExhausted(asVerdicts(1)), true);
	// The diff review's budget is spent on the attempt that IS the cap, so that
	// review surfaces instead of asking for a sixth-review revision.
	for (let prior = 0; prior < REVIEW_MAX_ATTEMPTS - 1; prior += 1) {
		assert.equal(reviewCapExhausted(asVerdicts(prior)), false, `review ${prior + 1} of ${REVIEW_MAX_ATTEMPTS} may revise`);
	}
	assert.equal(reviewCapExhausted(asVerdicts(REVIEW_MAX_ATTEMPTS - 1)), true, "the last permitted review never revises");

	// And the shared policy turns that into escalate/policy -> surface, with the
	// cap named in the reasons the operator reads.
	const decided = decideGate({
		jobId: "cp-review-cap",
		attempt: REVIEW_MAX_ATTEMPTS,
		prior: { priorRevise: true, priorCause: null },
		model: "m",
		capReason: `review cap: this is review ${REVIEW_MAX_ATTEMPTS} of ${REVIEW_MAX_ATTEMPTS} on cp-review-cap`,
		review: {
			job_id: "cp-review-cap",
			verdict: "revise",
			flags: { ...NO_FLAGS },
			reasons: ["still untested"],
			revisions: ["add a test"],
		},
	});
	assert.equal(decided.verdict, "escalate");
	assert.equal(decided.cause, "policy");
	assert.equal(nextAction(decided), "surface");
	assert.match(decided.reasons.join(" "), /review cap/);
	assert.ok(!decided.reasons.join(" ").includes("a prior revise already exists"), "the gate's wording is not the review's");
});

test("a 3rd review runs after two prior revises, and still promotes the live implementer", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-third";
	b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	seedReviews(b.home, jobId, 2);
	const model = b.script("review-third", [
		verdictCall(jobId, { verdict: "revise", reasons: ["[severity: high] [confidence: high] one more thing"], revisions: ["rename the flag"] }),
	]);
	b.script("implementer", [{ kind: "text", text: "standing by" }], { onExhausted: "repeat" });
	b.seal();
	await b.liveImplementer(jobId);

	const result = await b.review.reviewAndWait({ jobId, model });
	assert.equal(result.verdict.attempt, 3, "two revises no longer end the loop");
	assert.equal(result.verdict.verdict, "revise");
	assert.equal(result.next, "revise");
	assert.equal(result.revise_receipt, "delivered", `revise not delivered: ${result.revise_error}`);
	assert.match(diffReviseMessage(result.verdict), new RegExp(`review 3 of ${REVIEW_MAX_ATTEMPTS}`));
	assert.match(formatDiffReview(result), new RegExp(`review 3 of ${REVIEW_MAX_ATTEMPTS}`));
});

test(`a pass on review ${REVIEW_MAX_ATTEMPTS - 2} still proceeds: pass ends the loop, whenever it arrives`, { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-clean";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	seedReviews(b.home, jobId, REVIEW_MAX_ATTEMPTS - 3);
	const model = b.script("review-clean", [verdictCall(jobId, { reasons: ["the earlier findings are fixed"] })]);
	b.seal();

	const result = await b.review.reviewAndWait({ jobId, model });
	assert.equal(result.verdict.attempt, REVIEW_MAX_ATTEMPTS - 2);
	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.cause, null);
	assert.equal(result.next, "proceed");
	assert.equal(result.verdict.head_sha, head);
	assert.equal(result.revise_receipt, undefined, "a pass is never promoted");
});

test(`review ${REVIEW_MAX_ATTEMPTS} with findings surfaces: no revise is delivered, and no sixth review is allowed`, { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-capped";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const prUrl = "https://github.com/o/r/pull/9";
	await b.fleet.patch(jobId, { receipts: [{ kind: "pr", status: "open", title: "PR", url: prUrl }] });
	seedReviews(b.home, jobId, REVIEW_MAX_ATTEMPTS - 1);
	const model = b.script("review-capped", [
		verdictCall(jobId, { verdict: "revise", reasons: ["[severity: high] [confidence: high] still not tested"], revisions: ["add the test"] }),
	]);
	// A live implementer stands by on purpose: the reason nothing is promoted
	// must be the cap, not a missing worker.
	b.script("implementer", [{ kind: "text", text: "standing by" }], { onExhausted: "repeat" });
	const sixth = b.script("review-sixth", [verdictCall(jobId)]);
	b.seal();
	await b.liveImplementer(jobId);

	const capped = await b.review.reviewAndWait({ jobId, model });
	assert.equal(capped.verdict.attempt, REVIEW_MAX_ATTEMPTS);
	assert.equal(capped.verdict.verdict, "escalate");
	assert.equal(capped.verdict.cause, "policy");
	assert.equal(capped.next, "surface");
	assert.equal(capped.revise_receipt, undefined, "the last permitted review never asks for another revision");
	assert.equal(capped.revise_error, undefined);
	assert.match(capped.verdict.reasons.join(" "), /review cap/);
	assert.match(capped.verdict.reasons.join(" "), /REVIEW_MAX_ATTEMPTS/);
	assert.ok(!capped.verdict.revisions, "an escalate carries no revisions");
	// jje.3: the complete capped review declares its one operator-only exit, bound to the capped head, findings verbatim.
	const finalFix = new CheckpointStore(b.home, { kind: "final_fix" }).get(jobId, { scope: head.slice(0, 12) });
	assert.equal(finalFix?.decision, "pending");
	assert.equal(finalFix?.pr_url, prUrl, "bound to the job's PR");
	assert.match(finalFix?.question ?? "", /Operator text only/);
	assert.ok(finalFix?.evidence?.includes("add the test"), "the reviewer's revision is the evidence");
	assert.ok(finalFix?.evidence?.includes("[severity: high] [confidence: high] still not tested"));

	// The sixth is refused before anything is materialized or spawned: a loop is
	// exactly what the cap exists to stop.
	await assert.rejects(
		() => b.review.reviewAndWait({ jobId, model: sixth }),
		(error: Error) => {
			assert.match(error.message, new RegExp(`already had ${REVIEW_MAX_ATTEMPTS} diff reviews`));
			assert.match(error.message, /REVIEW_MAX_ATTEMPTS/);
			assert.match(error.message, new RegExp(paths.reviewFile(jobId, REVIEW_MAX_ATTEMPTS)), "the refusal names the last verdict");
			return true;
		},
	);
	assert.equal(existsSync(join(b.home, paths.reviewFile(jobId, REVIEW_MAX_ATTEMPTS + 1))), false);
	assert.equal(b.provider.requests("review-sixth").length, 0, "a refused review must never reach a model");
	assert.equal(existsSync(join(b.home, paths.reviewScratchDir(jobId, REVIEW_MAX_ATTEMPTS + 1), "diff.md")), false);
});

test("jje.3: only a complete fifth review whose reviewer still asked for revisions is eligible for a final fix", (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	{
		const prUrl = "https://github.com/o/r/pull/1";
		const jobId = "cp-final-fix";
		const review = { job_id: jobId, verdict: "revise" as const, flags: { ...NO_FLAGS }, reasons: ["x"], revisions: ["fix x"] };
		const capped: DiffVerdict = {
			schema_version: 1, job_id: jobId, attempt: REVIEW_MAX_ATTEMPTS, verdict: "escalate", cause: "policy", flags: { ...NO_FLAGS },
			reasons: ["x", "review cap: this is review 5 of 5"], model: "m", decided_at: "2024-01-01T00:00:00Z",
			head_sha: "a".repeat(40), diff_stat: { files: 1, truncated: false },
		};
		const ineligible: Array<[string, DiffVerdict, typeof review | undefined]> = [
			["an earlier attempt", { ...capped, attempt: REVIEW_MAX_ATTEMPTS - 1 }, review],
			["a truncated subject", { ...capped, diff_stat: { files: 1, truncated: true } }, review],
			["no reviewer ran", { ...capped, model: undefined } as DiffVerdict, undefined],
			["the reviewer's own escalate", capped, { ...review, verdict: "escalate" as never }],
			["a pass", { ...capped, verdict: "pass", cause: null }, review],
		];
		for (const [label, verdict, observed] of ineligible) {
			assert.equal(requestFinalFix(home, { verdict, prUrl, ...(observed ? { review: observed } : {}) }), undefined, label);
		}
		assert.equal(requestFinalFix(home, { verdict: capped, review }), undefined, "no PR, nothing to bind to");
		const asked = requestFinalFix(home, { verdict: capped, review, prUrl });
		assert.deepEqual([asked?.kind, asked?.scope, asked?.pr_url], ["final_fix", "a".repeat(12), prUrl]);
		assert.deepEqual(asked?.evidence, ["fix x", "x"], "findings verbatim, the cap's own reason left out");
		// Boundary: a maximum-sized fifth review (10 revisions + 10 reasons at the 400-char item cap) loses nothing.
		const big = (tag: string) => Array.from({ length: GATE_REASONS_MAX_ITEMS }, (_, i) => `${tag} ${i} ${"x".repeat(393)}`);
		const max = { ...capped, job_id: "cp-final-max" };
		const full = requestFinalFix(home, { verdict: max, review: { ...review, job_id: max.job_id, revisions: big("rev"), reasons: big("why") }, prUrl });
		assert.deepEqual(full?.evidence, [...big("rev"), ...big("why")], "all 20 findings are persisted on the decision");
		const promote = full ? finalFixMessage({ capped: max, checkpoint: full }) : "";
		for (const finding of [...big("rev"), ...big("why")]) assert.ok(promote.includes(`- ${finding}`), "and delivered verbatim");
	}
});

test("start returns wait with the head under review; the wake-up carries that head", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-async";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const model = b.script("review-async", [verdictCall(jobId, { reasons: ["diff is small and tested"] })]);
	b.seal();

	const started = await b.review.start({ jobId, model });
	assert.ok(isDiffReviewWait(started), JSON.stringify(started));
	assert.equal(started.surface, "review");
	assert.equal(started.head_sha, head);
	const pending = readPendingReview(b.home, jobId, "review", 1);
	assert.equal(pending?.subject?.head_sha, head);
	assert.equal(pending?.subject?.branch, jobId);
	assert.equal(listPendingReviews(b.home, jobId).length, 1);

	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);
	assert.equal(readPendingReview(b.home, jobId, "review", 1), undefined);
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.headSha, head);
	assert.match(b.sent[0]?.content ?? "", /review attempt 1: pass/);
	assert.ok(!b.sent[0]?.content.includes(BODY_MARKER), "the wake-up never carries the diff");
});

test("a second start while one is pending is refused, and the refusal names the head and the wake-up", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-inflight";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const model = b.script("review-inflight", [verdictCall(jobId, { reasons: ["diff is small and tested"] })]);
	b.seal();

	const started = await b.review.start({ jobId, model });
	assert.ok(isDiffReviewWait(started), JSON.stringify(started));

	await b.registry.setReviewerModel(PROJECT, "unavailable/reviewer");
	await assert.rejects(
		() => b.review.start({ jobId }),
		(error: Error) => {
			assert.match(error.message, new RegExp(head));
			assert.match(error.message, /wait for its cp-verdict wake-up instead of starting another; do not re-issue/);
			return true;
		},
	);

	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);
});

test("a stat overflow is decided synchronously: no pending, no wake-up", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-wide";
	// A real overflow, over the real cap: the refusal is a policy decision the
	// orchestrator takes with no reviewer at all, so it must not be reachable
	// only through a knob that exists for this test.
	const wide: Record<string, string> = {};
	for (let i = 0; i <= DIFF_REVIEW_MAX_STAT_FILES; i += 1) wide[`file-${i}.txt`] = "x\n";
	b.pushJobBranch(jobId, wide);
	await b.shipRecord(jobId);
	b.seal();
	const started = await b.review.start({ jobId });
	assert.ok(!isDiffReviewWait(started));
	assert.equal(started.verdict.cause, "policy");
	assert.equal(started.model, undefined, "no reviewer was spawned");
	assert.equal(readPendingReview(b.home, jobId, "review", 1), undefined);
	assert.equal(b.sent.length, 0);
});
