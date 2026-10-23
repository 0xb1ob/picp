import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, DIFF_REVIEW_MAX_BYTES, DIFF_REVIEW_MAX_STAT_FILES, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, type DiffVerdict } from "../../src/contracts.ts";
import { DiffVerdictSchema, validate } from "../../src/contracts.ts";
import { isDiffReviewWait } from "../../src/diff-review.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchRepo, MockProvider, REPO_ROOT, startPiChild } from "../harness/index.ts";
import type { PiModelRegistryLike } from "../../src/routing.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { enableTreehouse, readRunEvents, waitFor } from "../harness/index.ts";

import { CheckpointStore } from "../../src/checkpoint.ts";
import { listPendingReviews, readPendingReview } from "../../src/review-runs.ts";
async function stack(t: TestContext, registry?: PiModelRegistryLike, transport?: (content: string) => boolean, onDurableWakeup?: () => void) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo" });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const wakes: Array<{ content: string; headSha?: string }> = [];
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env }, holdsParentLock: () => true, onDurableWakeup, sendWakeup: (wake) => (wakes.push(wake), transport ? transport(wake.content) : true), ...(registry ? { modelRegistry: () => registry } : {}) });
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
	let reviews = 0;
	async function review(jobId: string, observation: Record<string, unknown> = {}, source: "explicit" | "project" | "mandate" = "explicit") {
		const name = `review-${jobId}-${++reviews}`;
		const model = provider.addScript(name, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["reviewed complete subject"], ...observation } }] }]);
		agent.writeModels(provider);
		if (source === "project") await post.registry.setReviewerModel("demo", model);
		if (source === "mandate") post.mandates.issue({ projects: ["demo"], job_ids: [jobId], objective: "review", reviewer_model: model, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 20, tokens: 1_000_000 }, job_cap: 10 });
		let started!: Awaited<ReturnType<typeof post.diffReview>>;
		await assert.doesNotReject(async () => { started = await post.diffReview({ jobId, ...(source === "explicit" ? { model } : {}) }); });
		if (isDiffReviewWait(started)) {
			post.reviewRuns.handBack(started.key);
			await post.reviewRuns.settled(started.key);
		}
		const attempt = isDiffReviewWait(started) ? started.attempt : started.verdict.attempt;
		if (isDiffReviewWait(started)) assert.ok(existsSync(join(home.path, paths.reviewFile(jobId, attempt))), "review must persist at its public review verdict path");
		const verdict = isDiffReviewWait(started) ? JSON.parse(readFileSync(join(home.path, paths.reviewFile(jobId, attempt)), "utf8")) as DiffVerdict : started.verdict;
		return { verdict, requests: provider.requests(name), scratch: join(home.path, paths.reviewScratchDir(jobId, attempt)), run: join(home.path, paths.reviewRunDir(jobId, attempt)) };
	}
	return { home: home.path, post, repo, seed, review, provider, agent, wakes };
}

test("S04: cp_review gives the reviewer a complete three-dot subject from the canonical clone", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "a.txt": "one\ntwo\nthree\n", "b.txt": "hello\n", "ä.ts": "export const a = 1;\n" });
	s.repo.write("base-only.txt", "base moved\n");
	s.repo.commitAll("base advances");
	s.repo.git("push", "--quiet", "origin", s.repo.branch);
	let result!: Awaited<ReturnType<typeof s.review>>;
	await assert.doesNotReject(async () => { result = await s.review(job); });
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
		["hidden-code", { "data/results.csv": "row,123456789\n".repeat(19_000), "src/app.ts": "export const hidden = true;\n".repeat(3_000) }, /src\/app\.ts/],
	] as const) {
		await t.test(label, async () => {
		const job = await s.seed(files);
		const result = await s.review(job);
		assert.deepEqual([result.verdict.verdict, result.verdict.cause], ["escalate", "policy"], label);
		assert.match(result.verdict.reasons.join(" "), pattern, label);
		assert.equal(result.requests.length, 0, label);
		assert.equal(result.verdict.diff_stat.files, Object.keys(files).length, label);
		assert.equal(result.verdict.diff_stat.truncated, true, label);
		const replay = await s.review(job);
		assert.equal(replay.verdict.attempt, result.verdict.attempt, label);
		assert.equal(replay.verdict.head_sha, result.verdict.head_sha, label);
		assert.equal(replay.requests.length, 0, label);
		if (label === "wide") assert.equal(existsSync(join(result.scratch, "diff.md")), false);
		if (label !== "wide") {
			const diff = readFileSync(join(result.scratch, "diff.md"), "utf8");
			assert.match(diff, /## Omitted/);
			if (label === "bytes") assert.match(diff, /tiny/);
			if (label === "quoted") assert.match(diff, /export const a = 1/);
		}
		});
	}
});


test("S04: review packets preserve frozen scope and context while persisted verdicts exclude gate-only fields", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const gate = { schema_version: 1, job_id: "cp-s04-1", attempt: 1, verdict: "pass", cause: null, flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["plan gate only"], decided_at: isoTimestamp() };
	const job = await s.seed({ "src/app.ts": "export const marker = 'S04_BODY_CANARY';\n" });
	mkdirSync(join(s.home, paths.runDir(job)), { recursive: true });
	writeFileSync(join(s.home, paths.gateFile(job, 1)), JSON.stringify(gate));
	const task = "Keep README.md. S04_TASK_CANARY\n";
	writeFileSync(join(s.home, paths.originalTaskFile(job)), task);
	writeFileSync(join(s.home, paths.taskAddendaFile(job)), [1, 2].map((n) => JSON.stringify({ schema_version: 1, n, added_at: "2026-09-24T10:00:00Z", by: "operator-quote", quote: "approved", reason: "coverage", text: `S04 extra scope ${n}.` })).join("\n") + "\n");
	const result = await s.review(job, { decision_summary: { would_make_wrong: "Missing scope", verified: "Read the packet" } });
	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.attempt, 1);
	assert.deepEqual(JSON.parse(readFileSync(join(s.home, paths.gateFile(job, 1)), "utf8")), gate);
	assert.equal(result.verdict.head_sha, s.repo.head(job));
	assert.equal("decision_summary" in result.verdict, false);
	assert.equal("rubric" in result.verdict, false);
	assert.equal(readFileSync(join(result.scratch, "original-task.md"), "utf8"), task);
	const brief = readFileSync(join(result.run, "brief.md"), "utf8");
	assert.ok(brief.includes(join(result.scratch, "original-task.md")));
	assert.ok(brief.includes(join(result.scratch, "task-addenda.md")));
	assert.match(brief, /source of truth for what was asked/);
	assert.match(brief, /authorized scope/);
	assert.ok(brief.indexOf("Addendum 1") < brief.indexOf("Addendum 2"));
	assert.doesNotMatch(brief, /S04_BODY_CANARY|S04_TASK_CANARY|S04 extra scope|\$\{/);
	const context = readFileSync(join(result.scratch, "context.md"), "utf8");
	assert.match(context, /S04_BODY_CANARY/);
	const manifest = JSON.parse(readFileSync(join(result.scratch, "context-manifest.json"), "utf8"));
	assert.equal(manifest.fork_point, s.repo.head(s.repo.branch));
	assert.ok(manifest.entries.some((e: { path: string; side: string; state: string }) => e.path === "README.md" && e.side === "head" && e.state === "included"));
	assert.ok(!manifest.entries.some((e: { path: string; side: string }) => e.path === "README.md" && e.side === "fork"));
	for (const file of [join(result.run, "events.jsonl"), join(s.home, paths.eventsFile(job))]) assert.doesNotMatch(readFileSync(file, "utf8"), /S04_BODY_CANARY|S04_TASK_CANARY/);
	assert.match(readFileSync(join(result.scratch, "task-addenda.md"), "utf8"), /S04 extra scope 1\./);
	assert.equal(s.post.manager.get(`${job}#review-1`), undefined);
});

test("S04: cp_review refuses absent, research and unpushed subjects with their recovery action", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	await t.test("absent", async () => {
		await assert.rejects(() => s.post.diffReview({ jobId: "cp-absent" }), /no dispatch record.*cp_dispatch/);
	});
	await t.test("research", async () => {
		const research = await s.seed({ "research.txt": "note\n" });
		await s.post.fleet.patch(research, { kind: "research" });
		await assert.rejects(() => s.post.diffReview({ jobId: research }), /kind:research.*cp_gate/);
	});
	await t.test("unpushed", async () => {
		const unpushed = await s.seed({ "unpushed.txt": "note\n" });
		await s.post.fleet.patch(unpushed, { branch: "cp-never-pushed" });
		await assert.rejects(() => s.post.diffReview({ jobId: unpushed }), /branch not pushed.*git push/);
	});
});


test("S04: moved heads use complete deltas and patch-equivalent rebases reuse only complete passes", { timeout: 180_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "src/app.ts": "export const x = 1;\n" });
	const first = await s.review(job, { reasons: ["prior finding"] });
	s.repo.git("checkout", "--quiet", job);
	s.repo.write("src/fix.ts", "export const fixed = true;\n");
	s.repo.commitAll("fix");
	s.repo.git("push", "--quiet", "origin", job);
	s.repo.git("checkout", "--quiet", s.repo.branch);
	const second = await s.review(job);
	assert.equal(second.verdict.delta_from, first.verdict.head_sha);
	const delta = readFileSync(join(second.scratch, "diff.md"), "utf8");
	assert.match(delta, /src\/fix\.ts/);
	assert.doesNotMatch(delta, /src\/app\.ts/);
	assert.match(readFileSync(join(second.scratch, "full-diff.md"), "utf8"), /src\/app\.ts/);
	assert.match(readFileSync(join(second.scratch, "prior-verdict.json"), "utf8"), /prior finding/);
	assert.match(readFileSync(join(second.run, "brief.md"), "utf8"), /delta review/);
	s.repo.write("base-only.txt", "base moves\n");
	s.repo.commitAll("move base");
	s.repo.git("push", "--quiet", "origin", s.repo.branch);
	s.repo.git("checkout", "--quiet", job);
	s.repo.git("rebase", s.repo.branch);
	s.repo.git("push", "--quiet", "--force", "origin", job);
	s.repo.git("checkout", "--quiet", s.repo.branch);
	const equivalent = await s.review(job);
	assert.deepEqual(equivalent.verdict.equivalent_to, { head_sha: second.verdict.head_sha, attempt: 2 });
	assert.equal(equivalent.verdict.head_sha, s.repo.head(job));
	assert.equal(equivalent.requests.length, 0);
	assert.equal(equivalent.verdict.attempt, 2);
	const file = join(s.home, paths.reviewFile(job, 2));
	writeFileSync(file, JSON.stringify({ ...equivalent.verdict, diff_stat: { files: 2, truncated: true } }));
	const complete = await s.review(job);
	assert.equal(complete.verdict.equivalent_to, undefined);
	assert.equal(complete.verdict.delta_from, undefined);
	assert.equal(complete.verdict.attempt, 3);
	assert.ok(complete.requests.length > 0);
});

test("S04: review flags remain reported while blocking findings surface when the implementer is gone", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const flagged = await s.seed({ "migration.sql": "DROP TABLE users;\n" });
	const pass = await s.review(flagged, { flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false } });
	assert.equal(pass.verdict.verdict, "pass");
	assert.equal(pass.verdict.cause, null);
	assert.equal(pass.verdict.flags.destructive_scope, true);
	assert.match(pass.verdict.reasons.join(" "), /flag reported, no veto: destructive_scope/);
	const missing = await s.seed({ "app.ts": "export const x = 1;\n" });
	const revise = await s.review(missing, { verdict: "revise", reasons: ["[severity: high] [confidence: high] missing coverage"], revisions: ["add coverage"], flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: true } });
	assert.equal(revise.verdict.verdict, "revise");
	assert.deepEqual(revise.verdict.revisions, ["add coverage"]);
	assert.equal(revise.verdict.flags.blocking_unknowns, true);
	assert.match(s.wakes.at(-1)?.content ?? "", /no live worker/);
});


test("S04: a paused or revoked mandate refuses reviewer spend and replacement authority restores it", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "a.ts": "export const a = 1;\n" });
	const issue = (objective: string) => s.post.mandates.issue({ projects: ["demo"], objective, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 20, tokens: 1_000_000 }, job_cap: 10 });
	const old = issue("old grant");
	s.post.mandates.pause(old.id, "spend_cap");
	await assert.rejects(() => s.review(job), /is paused.*no new reviewer spend/);
	s.post.mandates.revoke(old.id);
	await assert.rejects(() => s.review(job), /is revoked.*no new reviewer spend/);
	issue("replacement grant");
	assert.equal((await s.review(job)).verdict.verdict, "pass");
});


test("S04: legacy stranded verdicts settle once and oversized frozen tasks state their boundary", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const stranded = await s.seed({ "a.ts": "export const a = 1;\n" });
	const raw = join(s.home, paths.reviewVerdictFile(stranded, 1));
	mkdirSync(join(raw, ".."), { recursive: true });
	writeFileSync(raw, JSON.stringify({ schema_version: 1, job_id: stranded, received_at: isoTimestamp(), attempt: 1, review: { job_id: stranded, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["stranded receipt"], decision_summary: { would_make_wrong: "Unseen hunk", verified: "Read the diff" } } }));
	const recovered = await s.review(stranded);
	assert.equal(recovered.verdict.attempt, 1);
	assert.equal(recovered.verdict.verdict, "pass");
	assert.equal("decision_summary" in recovered.verdict, false);
	assert.equal(s.wakes.length, 1);
	const brief = readFileSync(join(recovered.run, "brief.md"), "utf8");
	assert.match(brief, /Original task: not available/);
	assert.match(brief, /claim nothing about requirement coverage/);
	const large = await s.seed({ "b.ts": "export const b = 1;\n" });
	mkdirSync(join(s.home, paths.runDir(large)), { recursive: true });
	const huge = "requirement requirement requirement\n".repeat(30_000) + "S04_TASK_TAIL\n";
	writeFileSync(join(s.home, paths.originalTaskFile(large)), huge);
	const bounded = await s.review(large);
	const copy = readFileSync(join(bounded.scratch, "original-task.md"), "utf8");
	assert.ok(Buffer.byteLength(copy) < Buffer.byteLength(huge));
	assert.doesNotMatch(copy, /S04_TASK_TAIL/);
	assert.match(copy, /bounded review packet/);
	assert.ok(copy.includes(`${Buffer.byteLength(huge)} bytes`));
	assert.ok(copy.startsWith("requirement"));
});


test("S04: reviewer preferences reread project and mandate settings while preserving the ship route", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	for (const source of ["project", "mandate", "explicit", "project"] as const) {
		const job = await s.seed({ [`${source}-${s.post.fleet.read().jobs.length}.ts`]: "export const x = 1;\n" });
		await s.post.fleet.patch(job, { routing: { scope: "L", risk: "high", inferred: false } });
		const result = await s.review(job, {}, source);
		assert.equal(result.verdict.verdict, "pass");
		assert.ok(result.requests.length > 0, source);
		const events = readFileSync(join(result.run, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const selection = events.find((e) => e.type === "reviewer_model_selected")?.payload;
		assert.equal(selection.source, source);
		assert.equal(selection.model, result.verdict.model);
		const route = events.find((e) => e.type === "routing_resolved")?.payload;
		assert.deepEqual([route.scope, route.risk, route.provenance], ["L", "high", { scope: "inherited", risk: "inherited" }]);
		await s.post.registry.setReviewerModel("demo", "unavailable/model");
		const cached = await s.post.diffReview({ jobId: job });
		assert.ok(!isDiffReviewWait(cached));
		assert.equal(cached.verdict.model, result.verdict.model);
	}
});


test("S04: configured reviewer denials never fall back, while an unconfigured route uses its authenticated fallback", { timeout: 120_000 }, async (t) => {
	let blocked = "";
	let effort = false;
	const s = await stack(t, { find: (provider, id) => ({ provider, id, ...(effort ? { reasoning: true, thinkingLevelMap: { high: null, medium: null, xhigh: null } } : {}) }), hasConfiguredAuth: (model) => `${model.provider}/${model.id}` !== blocked });
	const job = await s.seed({ "a.ts": "export const a = 1;\n" });
	const chosen = s.provider.addScript("chosen", [{ kind: "text", text: "should not run" }]);
	const spare = s.provider.addScript("spare", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["fallback reviewed"] } }] }]);
	s.agent.writeModels(s.provider);
	const config = { schema_version: 1, allow: ["mock/*"], rubric: [{ id: "fallback", role: "gate-reviewer", model: chosen, fallbacks: [spare], thinking: "high" }] };
	const save = (value: unknown) => writeFileSync(join(s.home, LAYOUT.data, "routing.json"), JSON.stringify(value));
	await s.post.registry.setReviewerModel("demo", chosen);
	for (const mode of ["allowlist", "availability", "effort", "role"] as const) {
		blocked = mode === "availability" ? chosen : "";
		effort = mode === "effort";
		save({ ...config, ...(mode === "allowlist" ? { allow: [spare] } : {}), ...(mode === "role" ? { deny_by_role: { "gate-reviewer": [chosen] } } : {}) });
		const refusal = { allowlist: /allowlist refuses/, availability: /no available model.*is not usable/, effort: /thinking=high.*cannot serve/, role: /not allowed for role gate-reviewer/ };
		await assert.rejects(() => s.post.diffReview({ jobId: job }), refusal[mode]);
		if (mode === "role") await assert.rejects(() => s.post.diffReview({ jobId: job, model: chosen }), /not allowed for role/);
		assert.equal(s.provider.requests("chosen").length, 0, mode);
		assert.equal(s.provider.requests("spare").length, 0, mode);
	}
	effort = false;
	blocked = chosen;
	save(config);
	await s.post.registry.setReviewerModel("demo", null);
	let started!: Awaited<ReturnType<typeof s.post.diffReview>>;
	await assert.doesNotReject(async () => { started = await s.post.diffReview({ jobId: job }); });
	assert.ok(isDiffReviewWait(started));
	s.post.reviewRuns.handBack(started.key);
	await s.post.reviewRuns.settled(started.key);
	assert.ok(s.provider.requests("spare").length > 0);
	assert.equal(s.provider.requests("chosen").length, 0);
	const events = readFileSync(join(s.home, paths.reviewRunDir(job, 1), "events.jsonl"), "utf8");
	assert.match(events, /"refusal":"availability"/);
	const inherited = await s.seed({ "axis.ts": "export const axis = 1;\n" });
	await s.post.fleet.patch(inherited, { routing: { scope: "L", risk: "high", inferred: false } });
	const axis = s.provider.addScript("axis", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: inherited, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["inherited route"] } }] }]);
	s.agent.writeModels(s.provider);
	save({ ...config, rubric: [{ id: "large-risky", role: "gate-reviewer", scope: ["L"], risk: "high", model: axis, thinking: "medium" }, ...config.rubric] });
	const routed = await s.post.diffReview({ jobId: inherited });
	assert.ok(isDiffReviewWait(routed));
	s.post.reviewRuns.handBack(routed.key);
	await s.post.reviewRuns.settled(routed.key);
	const verdict = JSON.parse(readFileSync(join(s.home, paths.reviewFile(inherited, 1)), "utf8"));
	assert.equal(verdict.model, axis);
	assert.equal(verdict.verdict, "pass");
	const routing = readFileSync(join(s.home, paths.reviewRunDir(inherited, 1), "events.jsonl"), "utf8");
	assert.match(routing, /"rule":"large-risky"/);
	assert.match(routing, /"thinking":"medium"/);
});

test("S04: pipeline advance holds unresolved and moved heads until a review of the current commit exists", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "a.ts": "export const a = 1;\n" });
	await s.review(job);
	const now = isoTimestamp();
	s.post.pipelines.write({ schema_version: 1, research_id: "cp-s04-plan", ship_id: job, project: "demo", delivery: "pr", state: "implementing", created_at: now, updated_at: now, review: { enabled: true } });
	assert.equal((await s.post.advancePipeline("cp-s04-plan")).state, "done");
	await s.post.fleet.patch(job, { kind: "research" });
	assert.notEqual((await s.post.advancePipeline("cp-s04-plan")).state, "done");
	await s.post.fleet.patch(job, { kind: "ship" });
	s.repo.git("checkout", "--quiet", job);
	s.repo.write("fix.ts", "export const fix = 1;\n");
	s.repo.commitAll("move reported head");
	s.repo.git("push", "--quiet", "origin", job);
	s.repo.git("checkout", "--quiet", s.repo.branch);
	await s.post.fleet.patch(job, { branch: "never-pushed" });
	const unresolved = await s.post.advancePipeline("cp-s04-plan");
	assert.notEqual(unresolved.state, "done");
	assert.match(JSON.stringify(unresolved), /head does not resolve/);
	await s.post.fleet.patch(job, { branch: job });
	const current = await s.review(job);
	assert.equal(current.verdict.head_sha, s.repo.head(job));
	assert.equal(current.verdict.attempt, 2);
	assert.equal((await s.post.advancePipeline("cp-s04-plan")).state, "done");
	const record = s.post.pipelines.require("cp-s04-plan");
	for (const review of [{}, { enabled: false }]) {
		s.post.pipelines.write({ ...record, review });
		assert.equal((await s.post.advancePipeline("cp-s04-plan")).state, "done");
	}
	writeFileSync(join(s.home, paths.pipelineFile("cp-s04-plan")), JSON.stringify({ ...record, review: { enabled: true, extra: 1 } }));
	await assert.rejects(() => s.post.advancePipeline("cp-s04-plan"), /pipeline contract/);
	s.post.pipelines.write(record);
	const runner = s.post.pipeline();
	runner.checkpoints.request({ jobId: job, researchId: "cp-s04-plan", question: "original ship decision", evidence: ["plan"], at: now });
	const shipCheckpoint = readFileSync(join(s.home, paths.checkpointFile(job)), "utf8");
	writeFileSync(join(s.home, paths.reviewFile(job, 2)), JSON.stringify({ ...current.verdict, verdict: "escalate", cause: "flagged", flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false } }));
	assert.notEqual((await s.post.advancePipeline("cp-s04-plan")).state, "done");
	assert.equal(readFileSync(join(s.home, paths.checkpointFile(job)), "utf8"), shipCheckpoint);
	assert.equal(JSON.parse(readFileSync(join(s.home, paths.checkpointFile(job, "diff")), "utf8")).decision, "pending");
	assert.notEqual(JSON.parse(readFileSync(join(s.home, paths.checkpointFile(job, "diff")), "utf8")).question, "original ship decision");
});


test("S04: blocking review promotes the real implementer on the same branch with the remaining review budget", { timeout: 180_000 }, async (t) => {
	const s = await stack(t);
	initJobsDocument(s.home, "cp");
	const clone = await s.post.registry.ensureClone("demo");
	const pool = enableTreehouse(clone.path);
	t.after(() => pool.cleanup());
	const job = await s.post.ledger().create({ title: "review revise", project: "demo", kind: "ship", delivery: "pr" });
	const model = s.provider.addScript("implementer", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `printf 'v1\\n' > app.ts && git add -A && git commit -q -m app && git push -q -u origin ${job.id}` } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: job.id, kind: "ship", status: "done", summary: "Pushed app.", branch: job.id, pr_url: "https://github.com/example/demo/pull/1", head_sha: s.repo.git("ls-remote", "origin", `refs/heads/${job.id}`).split("\t")[0]!.trim() }) }] },
		{ kind: "text", text: "standing by" },
	], { onExhausted: "repeat" });
	s.agent.writeModels(s.provider);
	assert.equal((await s.post.dispatch({ jobId: job.id, task: "Write app.ts, push and report the PR.", model, fetch: false })).receipt, "accepted");
	await waitFor(() => s.post.fleet.get(job.id), (record) => record?.phase === "held" && !!record.reported_at, { timeoutMs: 90_000, what: "implementer held" });
	for (let attempt = 1; attempt <= 3; attempt++) {
		await t.test(`review ${attempt}`, async () => {
		const result = await s.review(job.id, { verdict: "revise", reasons: ["[severity: high] [confidence: high] missing test"], revisions: [`S04 add coverage ${attempt}`] });
		assert.equal(result.verdict.attempt, attempt);
		assert.equal(result.verdict.verdict, "revise");
		await waitFor(() => s.provider.requests("implementer"), (requests) => requests.some((request) => JSON.stringify(request.body.messages).includes(`S04 add coverage ${attempt}`)), { timeoutMs: 30_000, what: "revision delivered" });
		const received = JSON.stringify(s.provider.requests("implementer").at(-1)?.body.messages);
		assert.ok(received.includes(`same branch (${job.id})`));
		assert.match(received, /never a second PR/);
		assert.ok(received.includes(`review ${attempt} of 5`));
		assert.ok(received.includes(`${5 - attempt} reviews remain`));
		});
	}
	const reasons = Array.from({ length: 10 }, (_, n) => `[severity: high] [confidence: high] final reason ${n} `.padEnd(400, "x"));
	const revisions = Array.from({ length: 10 }, (_, n) => `final revision ${n} `.padEnd(400, "x"));
	await s.review(job.id, { verdict: "revise", reasons: ["[severity: high] [confidence: high] fourth finding"], revisions: ["fourth repair"] });
	await waitFor(() => s.provider.requests("implementer"), (requests) => JSON.stringify(requests.at(-1)?.body.messages).includes("fourth repair"), { timeoutMs: 30_000, what: "fourth repair delivered" });
	await waitFor(() => s.post.sender.sending(job.id), (sending) => !sending, { timeoutMs: 30_000, what: "fourth repair settled" });
	const capped = await s.review(job.id, { verdict: "revise", reasons, revisions });
	const head = capped.verdict.head_sha;
	new CheckpointStore(s.home, { kind: "final_fix" }).decide(job.id, true, { by: "operator", scope: head.slice(0, 12), basis: { operator_quote: "Approve one final fix." } });
	// A legacy held report admits integration after the fourth repair turn, whose mock author only acknowledged it.
	await s.post.fleet.patch(job.id, { phase: "held", reported_at: isoTimestamp() });
	const bin = join(s.home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nconst pr = ${JSON.stringify({ url: "https://github.com/example/demo/pull/1", number: 1, state: "OPEN", isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: head, headRefName: job.id, baseRefName: "main" })};\nif (a[0] === "pr" && a[1] === "view") console.log(JSON.stringify(pr));\nelse if (a[0] === "api") console.log(JSON.stringify(a[1].includes("/actions/workflows") ? {total_count: 0, workflows: []} : a[1].includes("/actions/runs") ? {total_count: 0, workflow_runs: []} : []));\nelse process.exit(1);\n`, { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	t.after(() => { process.env.PATH = previousPath; });
	let integration = await s.post.integrate({ jobId: job.id });
	for (let n = 0; n < 4 && integration.next === "advance"; n++) integration = await s.post.integrate({ jobId: job.id });
	assert.equal(integration.next, "resolve", JSON.stringify(integration));
	assert.match(JSON.stringify(integration), /final fix promoted once/);
	await waitFor(() => s.provider.requests("implementer"), (requests) => JSON.stringify(requests.at(-1)?.body.messages).includes(revisions[9]!), { timeoutMs: 30_000, what: "final findings delivered" });
	const finalMessages = JSON.stringify(s.provider.requests("implementer").at(-1)?.body.messages);
	for (const finding of [...revisions, ...reasons]) assert.ok(finalMessages.includes(finding), finding);
});


test("S04: complete deltas remain reviewable when supplemental branch history exceeds the byte cap", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "data/results.csv": "row,123456789\n".repeat(19_000) });
	const first = await s.review(job);
	assert.equal(first.verdict.diff_stat.truncated, false);
	s.repo.git("checkout", "--quiet", job);
	s.repo.write("data/more.csv", "row,123456789\n".repeat(3_000));
	s.repo.write("src/fix.ts", "export const fixed = true;\n");
	s.repo.commitAll("small delta on large history");
	s.repo.git("push", "--quiet", "origin", job);
	s.repo.git("checkout", "--quiet", s.repo.branch);
	const result = await s.review(job);
	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.delta_from, first.verdict.head_sha);
	assert.equal(result.verdict.diff_stat.truncated, false);
	assert.match(readFileSync(join(result.scratch, "diff.md"), "utf8"), /src\/fix\.ts/);
	assert.match(readFileSync(join(result.scratch, "full-diff.md"), "utf8"), /## Omitted/);
	assert.ok(existsSync(join(result.scratch, "prior-verdict.json")));
});


test("S15: a real quality waiter filesystem failure becomes an operational wakeup", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "src/quality.ts": "export const quality = 1;\n" });
	const artifact = join(s.home, "quality-input.md");
	writeFileSync(artifact, "# Proposed change\nImplement the scoped task.\n");
	s.post.artifacts.add(job, artifact);
	const model = s.provider.addScript("s15-quality-fault", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["sound"] } }] }]);
	s.agent.writeModels(s.provider);
	const target = join(s.home, paths.qualityFile(job));
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (String(to) === target) throw new Error("S15 quality write failed");
		rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		const started = await s.post.qualityPass().start({ jobId: job, task: "Implement the scoped task.", config: { verify: true, voters: 1, model } });
		assert.ok(started && "key" in started);
		s.post.reviewRuns.handBack(started.key);
		await s.post.reviewRuns.settled(started.key);
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(s.post.reviewRuns.pending(job, "quality"), undefined);
	assert.equal(existsSync(target), false);
	assert.equal(s.wakes.length, 1);
	assert.match(s.wakes[0]!.content, /quality panel failed.*reviewer wait failed: S15 quality write failed/);
	assert.ok(s.provider.requests("s15-quality-fault").length > 0);
});

test("S15: a lost caller handback cannot swallow a real review verdict or pin its slot", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "src/bounded.ts": "export const bounded = 1;\n" });
	const model = s.provider.addScript("s15-lost-handback", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["bounded handback"] } }] }]);
	s.agent.writeModels(s.provider);
	const started = await s.post.diffReview({ jobId: job, model });
	assert.ok(isDiffReviewWait(started));
	await waitFor(() => s.wakes.length, (count) => count === 1, { timeoutMs: 70_000, what: "lost handback's bounded verdict delivery" });
	await s.post.reviewRuns.settled(started.key);
	assert.equal(s.post.reviewRuns.pending(job, "review"), undefined);
	assert.equal(existsSync(join(s.home, paths.pendingReviewFile(job, "review", 1))), false);
	assert.equal(JSON.parse(readFileSync(join(s.home, paths.reviewFile(job, 1)), "utf8")).verdict, "pass");
	s.repo.git("checkout", "--quiet", job);
	s.repo.write("src/bounded.ts", "export const bounded = 2;\n");
	s.repo.commitAll("slot reuse after lost handback");
	s.repo.git("push", "--quiet", "origin", job);
	s.repo.git("checkout", "--quiet", s.repo.branch);
	assert.equal((await s.review(job)).verdict.attempt, 2);
});

test("S15: reviewers receive bounded whole-file snapshots with resolved task paths and capped consumers", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const base = {
		"docs/legacy.md": "S15_FORK_ONLY\n", "lib/unique.ts": "unique\n",
		"src/one/util.ts": "one\n", "src/two/util.ts": "two\n",
		"etc/hosts.md": "S15_ABSOLUTE\n", "x.ts": "S15_HOME\n",
		"tests/fixtures/big.json": "f".repeat(299_999) + "\n",
		"lib/core.py": "core = 1\n", "src/core.ts": "export const core = 1;\n",
	};
	for (const [path, body] of Object.entries(base)) s.repo.write(path, body);
	for (let n = 1; n <= 7; n++) s.repo.write(`src/use-${n}.ts`, 'import { core } from "./core.ts";\n');
	s.repo.commitAll("context base");
	s.repo.git("push", "--quiet", "origin", s.repo.branch);
	const job = await s.seed({ "src/core.ts": "export const core = 2;\n", "src/run.py": "r".repeat(99) + "\n", "img.bin": "PNG\0\x01binary_marker", "tests/core.test.ts": "test marker\n" });
	s.repo.git("checkout", "--quiet", job);
	s.repo.git("rm", "--quiet", "docs/legacy.md");
	s.repo.commitAll("remove legacy");
	s.repo.git("push", "--quiet", "origin", job);
	s.repo.git("checkout", "--quiet", s.repo.branch);
	mkdirSync(join(s.home, paths.runDir(job)), { recursive: true });
	writeFileSync(join(s.home, paths.originalTaskFile(job)), "Remove docs/legacy.md. Read unique.ts, util.ts, nothing.ts, tests/fixtures/big.json and lib/core.py. Ignore /etc/hosts.md, ~/x.ts and /abs/x.ts.\n");
	const bin = mkdtempSync(join(tmpdir(), "cp-s15-audit-"));
	const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const audit = join(bin, "calls");
	const oldPath = process.env.PATH;
	t.after(() => { process.env.PATH = oldPath; rmSync(bin, { recursive: true, force: true }); });
	writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${audit}'\nexec '${git}' "$@"\n`);
	chmodSync(join(bin, "git"), 0o700);
	process.env.PATH = `${bin}:${oldPath}`;
	const result = await s.review(job);
	process.env.PATH = oldPath;
	const calls = readFileSync(audit, "utf8");
	assert.doesNotMatch(calls, /^cat-file .*:(?:etc\/hosts\.md|x\.ts)$/m);
	assert.doesNotMatch(calls, /^grep .*core\.test\.ts/m);
	assert.equal(result.verdict.verdict, "pass");
	const manifest = JSON.parse(readFileSync(join(result.scratch, "context-manifest.json"), "utf8"));
	const entries = manifest.entries as Array<{ path: string; side: string; reason: string; state: string; bytes?: number; sha256?: string; candidates?: string[] }>;
	const entry = (path: string, side = "head") => entries.find((e) => e.path === path && e.side === side);
	assert.equal(manifest.status, "ok");
	assert.equal(manifest.fork_point, s.repo.head(s.repo.branch));
	assert.equal(manifest.head_sha, s.repo.head(job));
	assert.equal(entry("docs/legacy.md", "fork")?.state, "included");
	assert.equal(entry("docs/legacy.md")?.state, "absent");
	assert.equal(entry("docs/legacy.md", "fork")?.reason, "changed");
	assert.equal(entry("lib/unique.ts")?.state, "included");
	assert.equal(entry("lib/unique.ts")?.reason, "task-named");
	assert.deepEqual(entry("util.ts")?.candidates, ["src/one/util.ts", "src/two/util.ts"]);
	assert.equal(entry("util.ts")?.state, "ambiguous");
	assert.equal(entry("nothing.ts")?.state, "unresolved");
	for (const path of ["etc/hosts.md", "x.ts"]) assert.equal(entry(path), undefined, path);
	assert.equal(entry("tests/fixtures/big.json")?.state, "omitted-budget");
	assert.equal(entry("tests/fixtures/big.json")?.bytes, 300_000);
	assert.equal(entry("src/run.py")?.state, "included");
	assert.equal(entry("lib/core.py")?.state, "included");
	assert.equal(entry("lib/core.py", "fork"), undefined);
	assert.equal(entries.some((e) => e.reason === "invariant" && e.state === "absent"), false);
	assert.equal(entry("img.bin")?.state, "binary");
	assert.equal(entry("img.bin")?.bytes, 18);
	assert.deepEqual(entries.filter((e) => e.reason === "consumer").map((e) => e.path), [1, 2, 3, 4, 5].map((n) => `src/use-${n}.ts`));
	assert.equal(entry("src/run.py")?.sha256, "277cebd939b4d34e6b2e3c7a40b6f4847c6041d4c0b284f5f82265419cc0b24c");
	assert.deepEqual(entries.filter((e) => e.reason === "changed").map((e) => `${e.side}:${e.path}`), ["head", "fork"].flatMap((side) => ["docs/legacy.md", "img.bin", "src/core.ts", "src/run.py", "tests/core.test.ts"].map((path) => `${side}:${path}`)));
	const context = readFileSync(join(result.scratch, "context.md"), "utf8");
	assert.match(context, /S15_FORK_ONLY/);
	assert.doesNotMatch(context, /binary_marker|S15_ABSOLUTE|S15_HOME|ffff/);
	assert.equal(context.match(/^### /gm)?.length, entries.filter((e) => e.state === "included").length);
	assert.equal(manifest.used_bytes, entries.filter((e) => e.state === "included").reduce((sum, e) => sum + e.bytes!, 0));
	assert.ok(context.includes("r".repeat(99)));
	const brief = readFileSync(join(result.run, "brief.md"), "utf8");
	assert.ok(brief.includes(`Fork point ${manifest.fork_point.slice(0, 12)}, head ${manifest.head_sha.slice(0, 12)}.`));
	assert.match(brief, /read context-manifest\.json first, then only the context\.md sections you need/);
	assert.match(brief, /`absent` means git confirmed the path does not exist at that sha/);
	assert.match(brief, /never treat them as absent/);
	rmSync(join(s.home, paths.reviewFile(job, 1)));
	rmSync(result.run, { recursive: true });
	const repeated = await s.review(job);
	assert.ok(repeated.requests.length > 0);
	assert.deepEqual(JSON.parse(readFileSync(join(repeated.scratch, "context-manifest.json"), "utf8")), manifest);
	assert.equal(readFileSync(join(repeated.scratch, "context.md"), "utf8"), context);
});


test("S15: a git object read failure is named in reviewer context without fabricating absence", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const bin = mkdtempSync(join(tmpdir(), "cp-s15-git-"));
	const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const oldPath = process.env.PATH;
	t.after(() => { process.env.PATH = oldPath; rmSync(bin, { recursive: true, force: true }); });
	for (const command of ["cat-file", "merge-base"]) {
		const job = await s.seed({ "src/fault.ts": "export const fault = 1;\n" });
		const wrapper = join(bin, "git");
		writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = '${command}' ]${command === "cat-file" ? ' && [ "$2" = blob ]' : ""}; then\n echo 'fatal: S15 object read failed' >&2\n exit 128\nfi\nexec '${git}' "$@"\n`);
		chmodSync(wrapper, 0o700);
		process.env.PATH = `${bin}:${oldPath}`;
		const result = await s.review(job);
		process.env.PATH = oldPath;
		assert.equal(result.verdict.verdict, "pass");
		const manifest = JSON.parse(readFileSync(join(result.scratch, "context-manifest.json"), "utf8"));
		if (command === "cat-file") {
			assert.equal(manifest.status, "ok");
			assert.ok(manifest.entries.some((e: { path: string; state: string; error?: string }) => e.path === "src/fault.ts" && e.state === "unreadable" && e.error === "fatal: S15 object read failed"));
		} else {
			assert.equal(manifest.status, "unavailable");
			assert.deepEqual(manifest.entries, []);
			assert.equal(existsSync(join(result.scratch, "context.md")), false);
			assert.match(readFileSync(join(result.run, "brief.md"), "utf8"), /Repository context unavailable: .*S15 object read failed\. Judge from the diff and task only, and report the limit\./);
		}
	}
});


test("S15: real reviewer attempts persist before waiting, reject duplicates and announce only after handback", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const dir = join(s.home, "review-barrier");
	mkdirSync(dir);
	const fifo = join(dir, "reviewer-read");
	execFileSync("mkfifo", [fifo]);
	const job = await s.seed({ "src/run.ts": "export const run = 1;\n" });
	const model = s.provider.addScript("s15-barrier", [
		{ kind: "tool_calls", calls: [{ name: "read", args: { path: fifo } }] },
		{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S15 reviewed"] } }] },
	]);
	const qualityModel = s.provider.addScript("s15-independent-quality", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["sound"] } }] }]);
	s.agent.writeModels(s.provider);
	const started = await s.post.diffReview({ jobId: job, model });
	assert.ok(isDiffReviewWait(started));
	assert.deepEqual([started.next, started.surface, started.attempt, started.model], ["wait", "review", 1, model]);
	const pendingFile = join(s.home, paths.pendingReviewFile(job, "review", 1));
	const pending = JSON.parse(readFileSync(pendingFile, "utf8"));
	assert.equal(pending.schema_version, 1);
	assert.deepEqual([pending.job_id, pending.surface, pending.attempt, pending.model, pending.deadline], [job, "review", 1, model, started.deadline]);
	assert.ok(Number.isFinite(Date.parse(started.deadline)));
	assert.ok(Date.parse(pending.started_at) < Date.parse(started.deadline));
	assert.equal(typeof pending.pid, "number");
	assert.deepEqual(s.post.reviewRuns.pending(job, "review"), pending);
	assert.equal(pending.handed_back, false);
	assert.ok(pending.pid > 0);
	await assert.rejects(() => s.post.diffReview({ jobId: job, model }), /already has a diff review in flight/);
	const artifact = join(s.home, "independent-quality.md");
	writeFileSync(artifact, "# Proposed change\nImplement the scoped task.\n");
	s.post.artifacts.add(job, artifact);
	let qualityKey = "";
	await assert.doesNotReject(async () => {
		const quality = await s.post.qualityPass().start({ jobId: job, task: "Implement the scoped task.", config: { verify: true, voters: 1, model: qualityModel } });
		assert.ok(quality && "key" in quality);
		qualityKey = quality.key;
	}, "a different review surface uses its own slot");
	assert.deepEqual(listPendingReviews(s.home, job).map((pending) => pending.surface).sort(), ["quality", "review"]);
	// The reader sniffs MIME before reading the body; release it only after the path becomes a regular file.
	await new Promise<void>((resolve, reject) => execFile("sh", ["-c", 'exec 3>"$1"; rm "$1"; printf release > "$1"', "s15-fifo", fifo], { timeout: 30_000 }, (error) => error ? reject(error) : resolve()));
	await waitFor(() => existsSync(join(s.home, paths.reviewFile(job, 1))), Boolean, { timeoutMs: 30_000, what: "durable review decision" });
	assert.equal(existsSync(pendingFile), false);
	assert.equal(s.wakes.length, 0);
	s.post.reviewRuns.handBack(started.key);
	await s.post.reviewRuns.settled(started.key);
	assert.equal(s.wakes.length, 1);
	assert.match(s.wakes[0]?.content ?? "", /S15 reviewed/);
	assert.equal(s.post.reviewRuns.pending(job, "review"), undefined);
	s.post.reviewRuns.handBack(started.key);
	assert.equal(s.wakes.length, 1);
	s.post.reviewRuns.handBack(qualityKey);
	await s.post.reviewRuns.settled(qualityKey);
	assert.equal(s.wakes.length, 2);
	const ordinary = await s.seed({ "src/ordinary.ts": "export const ordinary = 1;\n" });
	await s.review(ordinary);
	assert.equal(s.wakes.length, 3);
	const events = readFileSync(join(s.home, paths.eventsFile(job)), "utf8");
	assert.match(events, /review_started/);
	assert.match(events, /verdict_wakeup_sent/);
});


test("S15: the real cp_review tool relays bounded verdicts and policy refusals without review bodies", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "src/payload.ts": "export const S15_PRIVATE_DIFF = 1;\n" });
	const medium = "[severity: medium] [confidence: high] src/payload.ts:1 — retry can stay stale; clear it";
	const reviewed = await s.review(job, { reasons: [medium] });
	const reviewerTools = reviewed.requests[0]!.body.tools as Array<{ function: { name: string } }>;
	assert.equal(reviewerTools.some((tool) => ["cp_review", "cp_gate"].includes(tool.function.name)), false);
	const wide = await s.seed(Object.fromEntries(Array.from({ length: DIFF_REVIEW_MAX_STAT_FILES + 1 }, (_, n) => [`wide-${n}.ts`, "x\n"])));
	const large = await s.seed({ "large.ts": "export const S15_PRIVATE_DIFF = 1;\n".repeat(12_000) });
	const drained = await s.seed({ "drained.ts": "export const S15_PRIVATE_DIFF = 1;\n" });
	const blockedModel = s.provider.addScript("s15-drained", [{ kind: "text", text: "must not run" }]);
	const parent = s.provider.addScript("s15-tool-parent", [
		{ kind: "tool_calls", calls: [
			{ name: "cp_review", args: { job_id: "cp-s15-unknown" } },
			{ name: "cp_review", args: { job_id: job } },
			{ name: "cp_review", args: { job_id: wide } },
			{ name: "cp_review", args: { job_id: large } },
			{ name: "cp_review", args: { job_id: drained, model: blockedModel } },
		] },
		{ kind: "text", text: "reviewed" },
	], { onExhausted: "repeat" });
	s.agent.writeModels(s.provider);
	const bin = mkdtempSync(join(tmpdir(), "cp-s15-spawn-"));
	const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const gate = join(bin, "pre-spawn");
	writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = merge-base ]; then\n touch '${gate}'\n while [ ! -f '${gate}.release' ]; do sleep 0.05; done\nfi\nexec '${git}' "$@"\n`);
	chmodSync(join(bin, "git"), 0o700);
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	const child = startPiChild({ cwd: s.home, model: parent, env: { ...s.agent.env, CP_HOME: s.home, PATH: `${bin}:${process.env.PATH}` }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => child.close());
	await child.prompt("Review all five branches.");
	await waitFor(() => existsSync(gate), Boolean, { timeoutMs: 30_000, what: "git reaches the pre-spawn boundary" });
	s.post.drain.start(120);
	writeFileSync(`${gate}.release`, "release");
	await child.waitForSettled(60_000);
	const specs = s.provider.requests("s15-tool-parent")[0]!.body.tools as Array<{ function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } }>;
	assert.deepEqual(Object.keys(specs.find((tool) => tool.function.name === "cp_review")!.function.parameters.properties).sort(), ["action", "deliver_revise", "job_id", "model"]);
	assert.deepEqual(Object.keys(specs.find((tool) => tool.function.name === "cp_gate")!.function.parameters.properties).sort(), ["action", "deliver_revise", "job_id", "model", "replacement_job_id", "replan_escalation_id"]);
	assert.doesNotMatch(specs.find((tool) => tool.function.name === "cp_review")!.function.description, /different model is chosen/);
	assert.equal(existsSync(join(s.home, paths.reviewFile("cp-s15-unknown", 1))), false);
	const offered = JSON.stringify(s.provider.requests("s15-tool-parent")[0]?.body.tools);
	assert.match(offered, /cp_review/);
	assert.match(offered, /cp_gate/);
	assert.match(offered, /no blocking high\/high/);
	const ends = () => child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_review") as Array<{ isError?: boolean; result?: { details?: Record<string, unknown>; content?: unknown } }>;
	assert.equal(ends()[0]?.isError, true);
	assert.match(JSON.stringify(ends()[0]?.result), /no dispatch record.*cp_dispatch/);
	assert.doesNotMatch(JSON.stringify(ends()[0]?.result), /pipeline/i);
	await waitFor(() => ends().length, (count) => count >= 5, { timeoutMs: 60_000, what: "five RPC results" });
	for (const end of ends().filter((end) => !end.isError)) {
		const checked = validate(DiffVerdictSchema, end.result?.details?.verdict);
		assert.equal(checked.ok, true, `every successful RPC result carries a valid verdict: ${JSON.stringify({ details: end.result?.details, errors: checked.ok ? undefined : checked })}`);
	}
	const blocked = ends().find((end) => (end.result?.details?.verdict as DiffVerdict | undefined)?.job_id === drained)?.result;
	assert.equal((blocked?.details?.verdict as DiffVerdict)?.cause, "operational", JSON.stringify(blocked));
	assert.equal((blocked?.details?.subject as { files: number })?.files, 1, "spawn refusal preserves the materialized subject counts");
	assert.doesNotMatch(JSON.stringify(blocked), /S15_PRIVATE_DIFF|diff\.md|@@/);
	assert.equal(s.provider.requests("s15-drained").length, 0);
	const payload = ends().find((end) => (end.result?.details?.verdict as DiffVerdict | undefined)?.job_id === job)?.result;
	assert.ok(payload?.details);
	assert.equal(payload.details.next, "proceed", JSON.stringify(payload));
	assert.equal(validate(DiffVerdictSchema, payload.details.verdict).ok, true);
	assert.equal((payload.details.verdict as DiffVerdict).head_sha, s.repo.head(job));
	assert.equal((payload.details.verdict as DiffVerdict).verdict, "pass");
	assert.match(JSON.stringify(payload.content), /retry can stay stale/);
	assert.equal(payload.details.review, undefined);
	assert.doesNotMatch(JSON.stringify(payload), /S15_PRIVATE_DIFF|diff\.md|@@/);
	assert.match(String(payload.details.review_file), /review-(?:1|equivalent-[0-9a-f]{40})\.json$/);
	assert.deepEqual(JSON.parse(readFileSync(String(payload.details.review_file), "utf8")), payload.details.verdict);
	for (const [id, label] of [[wide, "wide"], [large, "large"]] as const) {
		const policy = ends().find((end) => (end.result?.details?.verdict as DiffVerdict | undefined)?.job_id === id)?.result;
		assert.equal(policy?.details?.next, "surface");
		assert.equal((policy?.details?.verdict as DiffVerdict).cause, "policy");
		assert.equal(policy?.details?.model, undefined);
		assert.match(JSON.stringify(policy?.content), /no reviewer/);
		assert.doesNotMatch(JSON.stringify(policy), /S15_PRIVATE_DIFF|diff\.md|@@/);
		if (label === "wide") assert.equal(policy?.details?.subject, undefined);
	}
});


test("S15: a failed verdict transport never resurrects a real review's pending slot", { timeout: 120_000 }, async (t) => {
	const s = await stack(t, undefined, () => { throw new Error("S15 transport unavailable"); });
	const job = await s.seed({ "src/transport.ts": "export const transport = 1;\n" });
	const result = await s.review(job);
	assert.equal(result.verdict.verdict, "pass");
	assert.equal(existsSync(join(s.home, paths.pendingReviewFile(job, "review", 1))), false);
	assert.equal(s.post.reviewRuns.pending(job, "review"), undefined);
	assert.equal(s.wakes.length, 1);
	assert.equal(JSON.parse(readFileSync(join(s.home, paths.reviewFile(job, 1)), "utf8")).verdict, "pass");
	assert.equal((await s.post.diffReview({ jobId: job })).next, "proceed");
});


test("S15: orphan reconciliation consumes durable legacy markers and isolates a failed decision write", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const jobs: string[] = [];
	for (const label of ["told", "untold", "alive", "decided", "broken", "invalid", "after"]) jobs.push(await s.seed({ [`${label}.ts`]: `export const ${label} = 1;\n` }));
	for (const [n, job] of jobs.entries()) {
		const file = join(s.home, paths.pendingReviewFile(job, "review", 1));
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, n === 5 ? "{not json" : JSON.stringify({ schema_version: 1, job_id: job, surface: "review", attempt: 1, model: "mock/lost", pid: n === 2 ? process.pid : 2_147_483_647, started_at: "2026-09-05T09:00:00Z", deadline: "2026-09-05T09:15:00Z", handed_back: n !== 1, subject: { head_sha: s.repo.head(job), branch: job, files: 1, truncated: false } }));
		if (n === 3) writeFileSync(join(s.home, paths.reviewFile(job, 1)), "{}");
		if (n === 4) {
			const dir = join(s.home, paths.runDir(job));
			chmodSync(dir, 0o500);
		}
	}
	const invalidShape = join(s.home, paths.pendingReviewFile(jobs[5]!, "review", 2));
	mkdirSync(join(invalidShape, ".."), { recursive: true });
	writeFileSync(invalidShape, JSON.stringify({ job_id: "no-attempt" }));
	let report!: Awaited<ReturnType<typeof s.post.sweepOrphanReviews>>;
	try { await assert.doesNotReject(async () => { report = await s.post.sweepOrphanReviews(); }, "malformed pending files never stop the orphan sweep"); }
	finally { chmodSync(join(s.home, paths.runDir(jobs[4]!)), 0o700); }
	assert.equal(report.finished.length, 3);
	assert.equal(report.skipped.length, 3);
	assert.ok(report.skipped.some((entry) => entry.pending.job_id === jobs[4] && /finish failed/.test(entry.reason)), JSON.stringify(report));
	assert.ok(report.finished.some((pending) => pending.job_id === jobs[0]));
	assert.ok(report.finished.some((pending) => pending.job_id === jobs[1]));
	assert.ok(report.finished.some((pending) => pending.job_id === jobs[6]));
	assert.equal(existsSync(join(s.home, paths.pendingReviewFile(jobs[4]!, "review", 1))), false);
	assert.ok(report.skipped.some((entry) => entry.pending.job_id === jobs[2] && entry.reason === "reviewer still alive"));
	assert.ok(report.skipped.some((entry) => entry.pending.job_id === jobs[3] && entry.reason === "decision already on disk"));
	assert.equal(s.wakes.filter((wake) => wake.content.includes(jobs[0]!)).length, 1);
	assert.equal(s.wakes.some((wake) => wake.content.includes(jobs[1]!)), false);
	for (const job of jobs.slice(0, 2)) {
		assert.equal(existsSync(join(s.home, paths.pendingReviewFile(job, "review", 1))), false);
		const verdict = JSON.parse(readFileSync(join(s.home, paths.reviewFile(job, 1)), "utf8"));
		assert.deepEqual([verdict.verdict, verdict.cause], ["escalate", "operational"]);
	}
	assert.equal(readFileSync(join(s.home, paths.pendingReviewFile(jobs[5]!, "review", 1)), "utf8"), "{not json");
	assert.equal(readFileSync(invalidShape, "utf8"), JSON.stringify({ job_id: "no-attempt" }));
	assert.equal(report.finished.some((pending) => pending.job_id === jobs[5]), false);
	assert.equal(report.skipped.some((entry) => entry.pending.job_id === jobs[5]), false);
	const again = await s.post.sweepOrphanReviews();
	assert.equal(again.finished.length, 0);
});


test("S15: dispatch preview rejects parent tools in external worker profile configuration", { timeout: 60_000 }, async (t) => {
	const s = await stack(t);
	const root = mkdtempSync(join(tmpdir(), "cp-s15-profiles-"));
	mkdirSync(join(root, "profiles"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const post = new CommandPost({ home: s.home, packageRoot: root, parentEnv: { ...process.env, ...s.agent.env }, holdsParentLock: () => true });
	t.after(() => post.shutdown());
	initJobsDocument(s.home, "cp");
	const job = await post.ledger().create({ title: "S15 invalid profile", project: "demo", kind: "ship", delivery: "local" });
	for (const [name, tool] of [["forbidden-review", "cp_review"], ["forbidden-gate", "cp_gate"]]) {
		writeFileSync(join(root, "profiles", `${name}.md`), `---\nname: ${name}\nrole: implementer\ndescription: Invalid parent tool fixture.\ntools: [report_result, ${tool}]\nmodel: mock/model\nbriefTemplate: brief-ship\nreadOnly: false\n---\nReject this configuration before any process starts.\n`);
		await assert.rejects(post.previewDispatch({ jobId: job.id, profile: name, task: "Add one line.", fetch: false }), new RegExp(`"${tool}" is a parent-only tool`));
	}
	assert.equal(s.provider.requests().length, 0);
});

test("S15: real review decision writes recover once before persistence and preserve partial decisions", { timeout: 120_000 }, async (t) => {
	let failedNotices = 0;
	const s = await stack(t, undefined, undefined, () => { failedNotices++; throw new Error("S15 notice transport unavailable"); });
	for (const mode of ["once", "partial", "always"] as const) {
		await t.test(mode, async () => {
		const job = await s.seed({ [`${mode}.ts`]: "export const value = 1;\n" });
		const model = s.provider.addScript(`s15-write-${mode}`, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S15 complete"] } }] }]);
		s.agent.writeModels(s.provider);
		const target = join(s.home, paths.reviewFile(job, 1));
		const rename = fs.renameSync;
		let writes = 0;
		fs.renameSync = (from, to) => {
			if (String(to) === target) {
				writes++;
				if (mode === "partial") rename(from, to);
				if (mode !== "once" || writes === 1) throw new Error("S15 filesystem unavailable\nsecond line");
			}
			rename(from, to);
		};
		syncBuiltinESMExports();
		const before = s.wakes.length;
		const noticesBefore = failedNotices;
		try {
			const started = await s.post.diffReview({ jobId: job, model });
			assert.ok(isDiffReviewWait(started));
			s.post.reviewRuns.handBack(started.key);
			await assert.doesNotReject(s.post.reviewRuns.settled(started.key), "a failing durable-notice transport never rejects reviewer settlement");
		} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(s.post.reviewRuns.pending(job, "review"), undefined);
		assert.equal(existsSync(join(s.home, paths.pendingReviewFile(job, "review", 1))), false);
		assert.equal(readRunEvents(s.home, job).filter((event) => event.type === "review_orphaned").length, 1);
		const notices = s.post.durableWakeups.pending().filter((entry) => entry.job_id === job);
		assert.equal(notices.length, mode === "once" ? 0 : 1);
		assert.equal(failedNotices - noticesBefore, mode === "once" ? 0 : 1);
		if (mode !== "once") {
			assert.match(notices[0]!.content, /review attempt 1/);
			assert.match(notices[0]!.content, /S15 filesystem unavailable second line/);
			assert.match(notices[0]!.content, mode === "partial" ? /a decision was already written/ : /operational fallback also failed/);
		}
		if (mode === "always") {
			assert.equal(writes, 2);
			assert.equal(existsSync(target), false);
			assert.equal(s.wakes.length, before);
		} else {
			assert.equal(existsSync(target), true, "a transient filesystem failure must leave an operational decision");
			const verdict = JSON.parse(readFileSync(target, "utf8"));
			assert.equal(verdict.verdict, mode === "once" ? "escalate" : "pass");
			assert.equal(writes, mode === "once" ? 2 : 1);
			assert.equal(s.wakes.length, before + (mode === "once" ? 1 : 0));
			if (mode === "once") {
				assert.equal(verdict.cause, "operational");
				assert.match(verdict.reasons.join(" "), /^reviewer finish failed: S15 filesystem unavailable second line$/);
				assert.doesNotMatch(verdict.reasons.join(" "), /\n/);
				assert.equal((await s.review(job)).verdict.attempt, 2, "an operational decision consumes one attempt and releases its slot");
			}
		}
		});
	}
});
test("S05: unknown and malformed legacy review heads never become delta baselines", { timeout: 180_000 }, async (t) => {
	const s = await stack(t);
	for (const head of ["0".repeat(40), "--not-a-sha"]) {
		await t.test(head, async () => {
		const job = await s.seed({ "src/app.ts": "export const original = 1;\n" });
		const first = await s.review(job);
		writeFileSync(join(s.home, paths.reviewFile(job, 1)), JSON.stringify({ ...first.verdict, head_sha: head }));
		s.repo.git("checkout", "--quiet", job);
		s.repo.write("src/fix.ts", "export const fix = 1;\n");
		s.repo.commitAll("fix");
		s.repo.git("push", "--quiet", "origin", job);
		s.repo.git("checkout", "--quiet", s.repo.branch);
		let result!: Awaited<ReturnType<typeof s.review>>;
		await assert.doesNotReject(async () => { result = await s.review(job); });
		assert.equal(result.verdict.delta_from, undefined);
		assert.equal(result.verdict.verdict, "pass");
		assert.match(readFileSync(join(result.scratch, "diff.md"), "utf8"), /src\/app\.ts/);
		});
	}
});


test("S05: integrating an advanced base resets the delta while an unmerged advance preserves it", { timeout: 180_000 }, async (t) => {
	for (const integration of ["none", "merge", "rebase"] as const) {
		await t.test(integration, async () => {
		const s = await stack(t);
		const job = await s.seed({ "src/app.ts": "export const x = 1;\n" });
		const first = await s.review(job);
		s.repo.write("upstream/big.csv", "row,123456789\n".repeat(30_000));
		s.repo.commitAll("base grows");
		s.repo.git("push", "--quiet", "origin", s.repo.branch);
		s.repo.git("checkout", "--quiet", job);
		if (integration === "merge") s.repo.git("merge", "--quiet", "--no-edit", s.repo.branch);
		if (integration === "rebase") s.repo.git("rebase", s.repo.branch);
		s.repo.write("src/fix.ts", "export const fix = 1;\n");
		s.repo.commitAll("branch fix");
		s.repo.git("push", "--quiet", ...(integration === "rebase" ? ["--force"] : []), "origin", job);
		s.repo.git("checkout", "--quiet", s.repo.branch);
		const result = await s.review(job);
		assert.equal(result.verdict.verdict, "pass", integration);
		assert.equal(result.verdict.delta_from, integration === "none" ? first.verdict.head_sha : undefined, integration);
		assert.equal(result.verdict.diff_stat.truncated, false);
		const diff = readFileSync(join(result.scratch, "diff.md"), "utf8");
		assert.match(diff, /src\/fix\.ts/);
		assert.doesNotMatch(diff, /upstream\/big\.csv/);
		});
	}
});

test("S05: a settled reviewer without a verdict retries once with the full subject then surfaces", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "app.ts": "export const original = 1;\n" });
	for (let attempt = 1; attempt <= 2; attempt++) {
		const model = s.provider.addScript(`silent-${attempt}`, [{ kind: "text", text: "looks fine" }]);
		s.agent.writeModels(s.provider);
		const started = await s.post.diffReview({ jobId: job, model });
		assert.ok(isDiffReviewWait(started));
		s.post.reviewRuns.handBack(started.key);
		await s.post.reviewRuns.settled(started.key);
		const verdict = JSON.parse(readFileSync(join(s.home, paths.reviewFile(job, attempt)), "utf8"));
		assert.equal(verdict.cause, attempt === 1 ? "operational" : "operational_persistent");
		assert.match(s.wakes.at(-1)?.content ?? "", attempt === 1 ? /-> retry/ : /-> surface/);
		assert.equal(verdict.delta_from, undefined);
		assert.match(verdict.reasons.join(" "), /settled without reporting a verdict/);
		const scratch = join(s.home, paths.reviewScratchDir(job, attempt));
		assert.match(readFileSync(join(scratch, "diff.md"), "utf8"), /export const original/);
		assert.equal(existsSync(join(scratch, "full-diff.md")), false);
	}
});

test("S05: pending reviews fence duplicate starts and carry the reviewed head in one wake", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "app.ts": "S05_PRIVATE_BODY\n" });
	const model = s.provider.addScript("pending", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["small subject"] } }] }]);
	s.agent.writeModels(s.provider);
	const started = await s.post.diffReview({ jobId: job, model });
	assert.ok(isDiffReviewWait(started));
	assert.equal(started.head_sha, s.repo.head(job));
	assert.equal(started.surface, "review");
	const pending = readPendingReview(s.home, job, "review", 1);
	assert.equal(pending?.subject?.head_sha, started.head_sha);
	assert.equal(pending?.subject?.branch, job);
	assert.equal(listPendingReviews(s.home, job).length, 1);
	await s.post.registry.setReviewerModel("demo", "unavailable/reviewer");
	await assert.rejects(() => s.post.diffReview({ jobId: job }), (error: Error) => {
		assert.ok(error.message.includes(started.head_sha!));
		assert.match(error.message, /wait for its cp-verdict wake-up instead of starting another; do not re-issue/);
		return true;
	});
	s.post.reviewRuns.handBack(started.key);
	await s.post.reviewRuns.settled(started.key);
	assert.equal(readPendingReview(s.home, job, "review", 1), undefined);
	assert.equal(listPendingReviews(s.home, job).length, 0);
	assert.equal(s.wakes.length, 1);
	assert.equal(s.wakes[0]?.headSha, started.head_sha);
	assert.match(s.wakes[0]!.content, /review attempt 1: pass/);
	assert.doesNotMatch(s.wakes[0]!.content, /S05_PRIVATE_BODY/);
});


test("S05: the fifth complete review surfaces findings and binds one final-fix checkpoint; a sixth never starts", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "app.ts": "export const app = 1;\n" });
	const pr = "https://github.com/example/demo/pull/5";
	await s.post.fleet.patch(job, { receipts: [{ kind: "pr", status: "open", title: "PR", url: pr }] });
	const first = await s.review(job);
	for (let n = 1; n <= 4; n++) writeFileSync(join(s.home, paths.reviewFile(job, n)), JSON.stringify({ ...first.verdict, attempt: n, verdict: "revise", revisions: ["earlier finding"] }));
	const reasons = Array.from({ length: 10 }, (_, n) => `[severity: high] [confidence: high] finding ${n} `.padEnd(400, "x"));
	const revisions = Array.from({ length: 10 }, (_, n) => `revision ${n} `.padEnd(400, "x"));
	const result = await s.review(job, { verdict: "revise", reasons, revisions });
	assert.equal(result.verdict.attempt, 5);
	assert.equal(result.verdict.verdict, "escalate");
	assert.equal(result.verdict.cause, "policy");
	assert.match(result.verdict.reasons.join(" "), /further item\(s\) dropped/);
	assert.equal(result.verdict.revisions, undefined);
	const checkpoint = new CheckpointStore(s.home, { kind: "final_fix" }).get(job, { scope: s.repo.head(job).slice(0, 12) });
	assert.equal(checkpoint?.decision, "pending");
	assert.equal(checkpoint?.pr_url, pr);
	assert.match(checkpoint?.question ?? "", /Operator text only/);
	assert.deepEqual(checkpoint?.evidence, [...revisions, ...reasons]);
	await assert.rejects(() => s.post.diffReview({ jobId: job }), (error: Error) => {
		assert.match(error.message, /already had 5 diff reviews.*REVIEW_MAX_ATTEMPTS/);
		assert.ok(error.message.includes(paths.reviewFile(job, 5)));
		return true;
	});
	assert.equal(existsSync(join(s.home, paths.reviewFile(job, 6))), false);
	assert.equal(existsSync(join(s.home, paths.reviewScratchDir(job, 6), "diff.md")), false);
});


test("S05: a pass at review three ends the loop and wide subjects finish synchronously without a wake", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "app.ts": "export const app = 1;\n" });
	const first = await s.review(job);
	for (let n = 1; n <= 2; n++) writeFileSync(join(s.home, paths.reviewFile(job, n)), JSON.stringify({ ...first.verdict, attempt: n, verdict: "revise", revisions: ["earlier finding"] }));
	const pass = await s.review(job);
	assert.equal(pass.verdict.attempt, 3);
	assert.equal(pass.verdict.verdict, "pass");
	assert.equal(pass.verdict.cause, null);
	assert.equal(pass.verdict.head_sha, s.repo.head(job));
	assert.match(s.wakes.at(-1)?.content ?? "", /review 3 of 5/);
	const wide = await s.seed(Object.fromEntries(Array.from({ length: DIFF_REVIEW_MAX_STAT_FILES + 1 }, (_, n) => [`wide-${n}.txt`, "x\n"])));
	const wakes = s.wakes.length;
	let stop!: Awaited<ReturnType<typeof s.post.diffReview>>;
	await assert.doesNotReject(async () => { stop = await s.post.diffReview({ jobId: wide }); });
	assert.ok(!isDiffReviewWait(stop));
	assert.equal(stop.model, undefined);
	assert.equal(stop.verdict.cause, "policy");
	assert.equal(listPendingReviews(s.home, wide).length, 0);
	assert.equal(s.wakes.length, wakes);
	const again = await s.post.diffReview({ jobId: wide });
	assert.ok(!isDiffReviewWait(again));
	assert.equal(again.verdict.attempt, stop.verdict.attempt);
	assert.equal(existsSync(join(s.home, paths.reviewFile(wide, 2))), false);
});


test("S05: only a complete fifth review asking for revisions on a bound PR creates a final-fix decision", { timeout: 180_000 }, async (t) => {
	for (const mode of ["earlier", "truncated", "escalate", "pass", "no-pr"] as const) {
		await t.test(mode, async () => {
			const s = await stack(t);
			const files = mode === "truncated" ? Object.fromEntries(Array.from({ length: DIFF_REVIEW_MAX_STAT_FILES + 1 }, (_, n) => [`file-${n}.txt`, "x\n"])) : { "app.ts": "export const app = 1;\n" };
			const job = await s.seed(files);
			if (mode !== "no-pr") await s.post.fleet.patch(job, { receipts: [{ kind: "pr", status: "open", title: "PR", url: "https://github.com/example/demo/pull/5" }] });
			const first = await s.review(job);
			for (let n = 1; n <= (mode === "earlier" ? 3 : 4); n++) writeFileSync(join(s.home, paths.reviewFile(job, n)), JSON.stringify({ ...first.verdict, attempt: n, verdict: "revise", cause: null, diff_stat: { files: 1, truncated: false }, revisions: ["earlier finding"] }));
			const verdict = mode === "escalate" || mode === "pass" ? mode : "revise";
			const result = await s.review(job, { verdict, reasons: ["[severity: high] [confidence: high] finding"], ...(verdict === "revise" ? { revisions: ["fix the finding"] } : {}) });
			assert.equal(result.verdict.attempt, mode === "earlier" ? 4 : 5);
			assert.equal(new CheckpointStore(s.home, { kind: "final_fix" }).get(job, { scope: s.repo.head(job).slice(0, 12) }), undefined);
		});
	}
});


test("S21: a reviewer decision followed by a run-log failure owes one durable recovery notice", { timeout: 110_000 }, async (t) => {
	const s = await stack(t);
	const job = await s.seed({ "app.ts": "export const app = 1;\n" });
	const script = "s21-finish-failure";
	const model = s.provider.addScript(script, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 1" } }] },
		{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["reviewed"] } }] },
	]);
	s.agent.writeModels(s.provider);
	const started = await s.post.diffReview({ jobId: job, model });
	assert.ok(isDiffReviewWait(started));
	await waitFor(() => s.provider.requests(script).length, (n) => n > 0, { timeoutMs: 15_000, what: "reviewer reaching provider" });
	const events = join(s.home, paths.eventsFile(job));
	mkdirSync(join(events, ".."), { recursive: true });
	if (existsSync(events)) renameSync(events, `${events}.saved`);
	mkdirSync(events);
	s.post.reviewRuns.handBack(started.key);
	await s.post.reviewRuns.settled(started.key);
	assert.equal(existsSync(join(s.home, paths.reviewFile(job, 1))), true, "decision persisted before log failure");
	assert.equal(s.wakes.length, 0, "no safe cp-verdict after partial finish");
	const again = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => again.shutdown());
	const delivered = again.drainDurableWakeups(() => {});
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]?.kind, "recovery");
	assert.equal(delivered[0]?.job_id, job);
	assert.deepEqual(delivered[0]?.keys, [job]);
	assert.match(delivered[0]?.id ?? "", new RegExp(`^review-finish:${job}:review:1:`));
	assert.match(delivered[0]?.content ?? "", /a decision was already written/);
	assert.match(delivered[0]?.content ?? "", /action:status/);
	assert.match(delivered[0]?.content ?? "", /never merge on this notice/);
	assert.doesNotMatch(delivered[0]?.content ?? "", /poll/i);
	again.confirmDurableWakeups(delivered.map((entry) => entry.id));
	assert.deepEqual(again.drainDurableWakeups(() => assert.fail("confirmed finish failure replayed")), []);
});
