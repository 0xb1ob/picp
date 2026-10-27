/**
 * P11d behavior 10: the opt-in diff gate between "the implementer reported" and "done", through a real CommandPost's
 * advancePipeline and cp_review with mock-model reviewers on a scratch repo; moved from tests/pipeline.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, type DiffReviewConfig, type DiffVerdict, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, REVIEW_MAX_ATTEMPTS, SCHEMA_VERSION } from "../../src/contracts.ts";
import { isDiffReviewWait } from "../../src/diff-review.ts";
import { finalFixFile, readFinalFixRecord } from "../../src/final-fix.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { readReviewPassVerdict } from "../../src/merge-ask.ts";
import { ReviewRuns } from "../../src/review-runs.ts";
import { createAgentDir, createScratchHome, createScratchRepo, MockProvider, REPO_ROOT } from "../harness/index.ts";
import { until } from "../harness/dashboard.ts";

const NO_FLAGS = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
const FLAGGED = { verdict: "escalate", cause: "flagged", flags: { ...NO_FLAGS, destructive_scope: true }, reasons: ["the diff drops the legacy_accounts table"] };
/** A diff review's revise below the high/high bar is downgraded to a pass. */
const REVISE = { verdict: "revise", revisions: ["[severity: high] [confidence: high] drop the debug log"] };

async function stack(t: TestContext) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo" });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env }, holdsParentLock: () => true, sendWakeup: () => true });
	t.after(async () => { await post.shutdown(); agent.cleanup(); await provider.stop(); repo.cleanup(); home.cleanup(); });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [] }));
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	let sequence = 0;
	const push = (jobId: string) => {
		repo.git("checkout", "--quiet", jobId);
		repo.write(`${jobId}-${++sequence}.ts`, `export const v = ${sequence};\n`);
		repo.commitAll(`push ${sequence}`);
		repo.git("push", "--quiet", "-u", "origin", jobId);
		repo.git("checkout", "--quiet", repo.branch);
		return repo.head(jobId);
	};
	/** A reported ship job (its branch pushed unless `pushed` is false) and a `plan()` writing its pipeline record. */
	async function seed(pushed = true) {
		const jobId = `cp-dg-${++sequence}`;
		if (pushed) {
			repo.git("checkout", "--quiet", "-b", jobId, repo.branch);
			repo.git("checkout", "--quiet", repo.branch);
		}
		const head = pushed ? push(jobId) : "";
		const now = isoTimestamp();
		await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: now, dispatched_at: now, usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "legacy", session_file: join(home.path, "legacy.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: now }, worktree: join(home.path, "recycled", jobId), branch: jobId });
		const researchId = `${jobId}-plan`;
		const plan = (review?: DiffReviewConfig, extra: Record<string, unknown> = {}) => post.pipelines.write({ schema_version: SCHEMA_VERSION, research_id: researchId, ship_id: jobId,
			project: "demo", delivery: "pr", state: "implementing", created_at: now, updated_at: now, ...(review ? { review } : {}), ...extra });
		return { jobId, researchId, head, plan };
	}
	/** Register a mock model script and publish it to the agent's models file. */
	const script = (...args: Parameters<MockProvider["addScript"]>) => {
		const model = provider.addScript(...args);
		agent.writeModels(provider);
		return model;
	};
	/** A scripted reviewer model that files one verdict per review it is asked for. */
	const reviewer = (jobId: string, ...observations: Array<Record<string, unknown>>) =>
		script(`reviewer-${jobId}-${++sequence}`, observations.map((observation) => ({ kind: "tool_calls" as const, calls: [{ name: "report_verdict",
			args: { job_id: jobId, verdict: "pass", flags: NO_FLAGS, reasons: ["reviewed complete subject"], ...observation } }] })));
	/** cp_review's own path: a real reviewer on the current head, handed back and settled. */
	async function review(jobId: string, observation: Record<string, unknown> = {}): Promise<DiffVerdict> {
		const started = await post.diffReview({ jobId, model: reviewer(jobId, observation) });
		if (!isDiffReviewWait(started)) return started.verdict;
		post.reviewRuns.handBack(started.key);
		await post.reviewRuns.settled(started.key);
		return JSON.parse(readFileSync(join(home.path, paths.reviewFile(jobId, started.attempt)), "utf8")) as DiffVerdict;
	}
	/** Rewrite one persisted verdict as a later reviewer could have filed it; the replaced pass's equivalence goes too. */
	const rewrite = (base: DiffVerdict, attempt: number, patch: Record<string, unknown>) => {
		rmSync(join(home.path, paths.reviewEquivalenceFile(base.job_id, base.head_sha)), { force: true });
		writeFileSync(join(home.path, paths.reviewFile(base.job_id, attempt)), `${JSON.stringify({ ...base, attempt, ...patch })}\n`);
	};
	/** One advance; a review it starts is handed back and settled, then advanced once more. */
	async function advance(researchId: string) {
		const result = await post.advancePipeline(researchId);
		if (result.pending?.surface !== "review") return result;
		const key = ReviewRuns.key(result.ship_id, "review", result.pending.attempt);
		post.reviewRuns.handBack(key);
		await post.reviewRuns.settled(key);
		return post.advancePipeline(researchId);
	}
	const used = (model: string) => provider.requests().filter((request) => model.endsWith(`/${provider.modelId(request.script)}`)).length;
	return { home: home.path, post, repo, provider, seed, push, script, reviewer, review, rewrite, advance, used, spent: () => provider.requests().length };
}

test("P11d-diff-head: a verdict on the current head replays, a moved head is reviewed by the record's model, and only a pass is done", { timeout: 180_000 }, async (t) => {
	const s = await stack(t);
	const { jobId, researchId, plan } = await s.seed();
	plan({ enabled: true });
	await s.review(jobId, REVISE);
	const spent = s.spent();
	const idle = await s.post.advancePipeline(researchId);
	assert.deepEqual([idle.state, idle.next, idle.review], ["implementing", "wait", undefined], "a revise is not done");
	assert.match(idle.message, /replaying diff review attempt 1/);
	assert.equal(s.spent(), spent, "a fresh verdict is never re-reviewed");

	const head = s.push(jobId);
	const model = s.reviewer(jobId, {});
	plan({ enabled: true, model });
	const done = await s.advance(researchId);
	assert.deepEqual([done.state, done.next], ["done", "done"]);
	assert.equal(readReviewPassVerdict(s.home, jobId, head)?.attempt, 2, "the moved head has its own pass");
	assert.match(done.message, new RegExp(`Diff review passed at ${head.slice(0, 12)}`));
	assert.ok(s.used(model) > 0, "the record's reviewer model override travels");

	// Absent or false, the gate behaves exactly as before it existed: no review, no head read, the historical message.
	for (const review of [undefined, { enabled: false }]) {
		const off = await s.seed();
		off.plan(review);
		const before = s.spent();
		const reported = await s.post.advancePipeline(off.researchId);
		assert.deepEqual([reported.state, reported.next, reported.message], ["done", "done", `${off.jobId}: implementer reported; the pipeline is done.`]);
		assert.deepEqual([reported.review, reported.checkpoint, s.spent()], [undefined, undefined, before]);
		assert.equal(existsSync(join(s.home, paths.checkpointFile(off.jobId, "diff"))), false);
	}

	// Opted in on a branch that was never pushed: there is nothing to review yet, and the hold names why.
	const unpushed = await s.seed(false);
	unpushed.plan({ enabled: true });
	const before = s.spent();
	const unresolved = await s.post.advancePipeline(unpushed.researchId);
	assert.deepEqual([unresolved.state, unresolved.next, s.spent()], ["implementing", "wait", before], "an opt-in gate is never waved through");
	assert.match(unresolved.message, /does not resolve in the canonical clone/);
});

test("P11d-diff-stop: a truncated pass is reviewed again, a policy stop or a spent budget surfaces, an operational fault retries then stops", { timeout: 180_000 }, async (t) => {
	const s = await stack(t);
	// A pass scored from visible hunks only is not a pass on the head.
	const partial = await s.seed();
	s.rewrite(await s.review(partial.jobId), 1, { diff_stat: { files: 2, truncated: true }, reasons: ["scored from the visible hunks only"] });
	const policy = s.reviewer(partial.jobId, { verdict: "escalate", reasons: ["the diff spans 41 files, over the review cap"] });
	partial.plan({ enabled: true, model: policy });
	const stopped = await s.advance(partial.researchId);
	assert.ok(s.used(policy) > 0, "the partial pass was not reused; the head was reviewed again");
	assert.deepEqual([stopped.state, stopped.next], ["escalated", "surface"]);
	assert.match(stopped.message, /over the review cap/);
	assert.equal(s.post.diffCheckpoints.get(partial.jobId), undefined, "a policy escalate never reaches a checkpoint");
	const spent = s.spent();
	assert.deepEqual([(await s.post.advancePipeline(partial.researchId)).next, s.spent()], ["surface", spent], "the policy stop replays");

	// The branch spent its whole budget and was pushed again since: advance surfaces, it never reviews again.
	const capped = await s.seed();
	const first = await s.review(capped.jobId, REVISE);
	for (let attempt = 2; attempt <= REVIEW_MAX_ATTEMPTS; attempt += 1) {
		const last = attempt === REVIEW_MAX_ATTEMPTS;
		s.rewrite(first, attempt, { verdict: last ? "escalate" : "revise", cause: last ? "policy" : null, reasons: [`attempt ${attempt}`] });
	}
	s.push(capped.jobId);
	capped.plan({ enabled: true });
	const before = s.spent();
	const surfaced = await s.post.advancePipeline(capped.researchId);
	assert.deepEqual([surfaced.state, surfaced.next, s.spent()], ["escalated", "surface", before], "a capped branch is never reviewed again");
	for (const named of [`${REVIEW_MAX_ATTEMPTS} diff reviews have run`, "REVIEW_MAX_ATTEMPTS", paths.reviewFile(capped.jobId, REVIEW_MAX_ATTEMPTS)]) assert.ok(surfaced.message.includes(named), named);

	// A reviewer fault is not a judgment about the diff: it is retried at the same head, and a repeat stops.
	const faulted = await s.seed();
	const silent = s.script(`silent-${faulted.jobId}`, [{ kind: "text", text: "no verdict" }], { onExhausted: "repeat" });
	faulted.plan({ enabled: true, model: silent });
	const fault = await s.advance(faulted.researchId);
	assert.deepEqual([fault.state, fault.pending?.attempt], ["implementing", 2], "the fault is retried at the same head, never replayed");
	assert.match(fault.message, /review attempt 2 is running/);
	const retried = await s.advance(faulted.researchId);
	assert.deepEqual([retried.state, retried.next, s.used(silent) >= 2], ["escalated", "surface", true], "a repeated fault stops");

	// A reviewer that cannot even start (the reserve is full) is a synchronous fault: wait, then a repeat stops.
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	t.after(() => release());
	writeFileSync(join(s.home, LAYOUT.budgetsFile), JSON.stringify({ schema_version: 1, per_job_tokens: 1_000_000, per_job_cost_usd: 3, warn_ratio: 0.8, spawn_cap: 1 }));
	for (let n = 0; n < 4; n += 1) {
		const busy = await s.seed();
		assert.ok(isDiffReviewWait(await s.post.diffReview({ jobId: busy.jobId, model: s.script(`busy-${busy.jobId}`, [{ kind: "hang", until: held }]) })));
	}
	const starved = await s.seed();
	starved.plan({ enabled: true, model: s.script(`never-${starved.jobId}`, [{ kind: "text", text: "never" }]) });
	const refused = await until(() => s.post.advancePipeline(starved.researchId), (r) => r.pending === undefined, "the reserve refusal to settle");
	assert.deepEqual([refused.state, refused.next], ["implementing", "wait"]);
	assert.match(refused.message, /operational fault[^]*uses a different model/);
	assert.match(readFileSync(join(s.home, paths.reviewFile(starved.jobId, 1)), "utf8"), /reviewer could not run: review reserve exhausted/);
	const stopped2 = await s.post.advancePipeline(starved.researchId);
	assert.deepEqual([stopped2.state, stopped2.next], ["escalated", "surface"], "a repeated fault stops");
});

test("P11d-diff-authorize: a flagged diff asks its own second question; a decline stops; a risk:high grant never decides it", { timeout: 180_000 }, async (t) => {
	const s = await stack(t);
	const flagged = await s.seed();
	flagged.plan({ enabled: true });
	s.post.checkpoints.request({ jobId: flagged.jobId, researchId: flagged.researchId, question: "Authorize implementation?", evidence: ["gate: pass (attempt 1)"] });
	s.post.checkpoints.decide(flagged.jobId, true, { by: "operator dialog", note: "ship the plan" });
	const shipFile = join(s.home, paths.checkpointFile(flagged.jobId));
	const first = readFileSync(shipFile, "utf8");
	s.rewrite(await s.review(flagged.jobId), 1, FLAGGED);
	const spent = s.spent();
	for (let round = 0; round < 2; round += 1) {
		const asked = await s.post.advancePipeline(flagged.researchId);
		assert.deepEqual([asked.state, asked.next, asked.checkpoint?.decision], ["awaiting_authorization", "authorize", "pending"], "evidence is not authorization");
	}
	assert.equal(s.spent(), spent, "advancing again re-asks nothing and reviews nothing");
	const diffFile = join(s.home, paths.checkpointFile(flagged.jobId, "diff"));
	const question = JSON.parse(readFileSync(diffFile, "utf8")) as { question: string; evidence: string[] };
	assert.notEqual(diffFile, shipFile);
	assert.equal(readFileSync(shipFile, "utf8"), first, "the pre-implementation checkpoint is untouched");
	assert.match(question.question, /destructive_scope/);
	for (const item of ["the diff drops the legacy_accounts table", "escalate (flagged"]) assert.ok(question.evidence.some((line) => line.includes(item)), item);
	s.post.diffCheckpoints.decide(flagged.jobId, true, { by: "operator command", note: "accepted the risk" });
	const done = await s.post.advancePipeline(flagged.researchId);
	assert.deepEqual([done.state, done.next, s.spent()], ["done", "done", spent], "an authorized flagged verdict is not re-reviewed");
	assert.equal(readFileSync(shipFile, "utf8"), first);

	const declined = await s.seed();
	declined.plan({ enabled: true });
	s.rewrite(await s.review(declined.jobId), 1, FLAGGED);
	await s.post.advancePipeline(declined.researchId);
	s.post.diffCheckpoints.decide(declined.jobId, false, { by: "operator command", note: "revert the deletion first" });
	const stopped = await s.post.advancePipeline(declined.researchId);
	assert.deepEqual([stopped.state, stopped.next, stopped.checkpoint?.decision], ["awaiting_authorization", "surface", "declined"]);
	assert.match(stopped.message, /declined: revert the deletion first/);
	assert.deepEqual([(await s.post.advancePipeline(declined.researchId)).next, s.post.diffCheckpoints.get(declined.jobId)?.decision], ["surface", "declined"]);

	s.post.mandates.issue({ projects: ["demo"], objective: "ship the handoff", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 50, tokens: 1_000_000 }, job_cap: 10 });
	const high = await s.seed();
	high.plan({ enabled: true }, { task_impact: { source: "start", routing: { risk: "high", inferred: false, provenance: { scope: "explicit", risk: "explicit" } } } });
	s.rewrite(await s.review(high.jobId), 1, FLAGGED);
	const held = await s.post.advancePipeline(high.researchId);
	assert.deepEqual([held.next, held.checkpoint?.decision, s.post.diffCheckpoints.get(high.jobId)?.decided_by], ["authorize", "pending", undefined]);
});

test("P11d-diff-final-fix: past the review cap, only the one operator-approved final fix head clears the hold", { timeout: 180_000 }, async (t) => {
	const s = await stack(t);
	const { jobId, researchId, plan } = await s.seed();
	const prUrl = "https://github.com/o/r/pull/7";
	await s.post.fleet.patch(jobId, { receipts: [{ kind: "pr", status: "open", title: "PR", url: prUrl }] });
	plan({ enabled: true });
	const first = await s.review(jobId, REVISE);
	const capped = first.head_sha;
	for (let attempt = 2; attempt <= REVIEW_MAX_ATTEMPTS; attempt += 1) {
		const last = attempt === REVIEW_MAX_ATTEMPTS;
		s.rewrite(first, attempt, { verdict: last ? "escalate" : "revise", cause: last ? "policy" : null, reasons: [`attempt ${attempt}`] });
	}
	const store = new CheckpointStore(s.home, { kind: "final_fix" });
	store.request({ jobId, scope: capped.slice(0, 12), prUrl, question: "one final fix?" });
	const fixed = s.push(jobId);
	const spent = s.spent();
	const pending = await s.post.advancePipeline(researchId);
	assert.deepEqual([pending.next, /awaits a human/.test(pending.message)], ["surface", true], "no approval: the hold stands");

	store.decide(jobId, true, { by: "operator-quote", basis: { operator_quote: "one fix" }, scope: capped.slice(0, 12) });
	atomicWriteJson(join(s.home, finalFixFile(jobId)), { schema_version: SCHEMA_VERSION, job_id: jobId, capped_head: capped, pr_url: prUrl,
		checkpoint: `aw-checkpoint-${jobId}.final-fix-${capped.slice(0, 12)}`, decided_by: "operator-quote", promoted_at: isoTimestamp(), fix_generation: 1, fix_head: fixed, bound_at: isoTimestamp() });
	s.push(jobId);
	const moved = await s.post.advancePipeline(researchId);
	assert.deepEqual([moved.state === "done", /is void/.test(moved.message)], [false, true], "a push after the fix report is never the approved head");

	atomicWriteJson(join(s.home, finalFixFile(jobId)), { ...readFinalFixRecord(s.home, jobId), invalidated: undefined });
	s.repo.git("push", "--quiet", "--force", "origin", `${fixed}:refs/heads/${jobId}`);
	const done = await s.post.advancePipeline(researchId);
	assert.equal(done.state, "done");
	assert.match(done.message, new RegExp(`operator-approved final fix at ${fixed.slice(0, 12)}`));
	assert.equal(s.spent(), spent, "no sixth review is ever spent");
});
