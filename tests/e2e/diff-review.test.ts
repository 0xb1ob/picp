import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, DIFF_REVIEW_MAX_BYTES, DIFF_REVIEW_MAX_STAT_FILES, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, type DiffVerdict } from "../../src/contracts.ts";
import { isDiffReviewWait } from "../../src/diff-review.ts";
import { createAgentDir, createScratchHome, createScratchRepo, MockProvider, REPO_ROOT } from "../harness/index.ts";
import type { PiModelRegistryLike } from "../../src/routing.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { enableTreehouse, waitFor } from "../harness/index.ts";

async function stack(t: TestContext, registry?: PiModelRegistryLike) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo" });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const wakes: string[] = [];
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env }, holdsParentLock: () => true, sendWakeup: (wake) => (wakes.push(wake.content), true), ...(registry ? { modelRegistry: () => registry } : {}) });
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
		const started = await post.diffReview({ jobId, ...(source === "explicit" ? { model } : {}) });
		if (isDiffReviewWait(started)) {
			post.reviewRuns.handBack(started.key);
			await post.reviewRuns.settled(started.key);
		}
		const attempt = isDiffReviewWait(started) ? started.attempt : started.verdict.attempt;
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
		["hidden-code", { "data/results.csv": "row,123456789\n".repeat(19_000), "src/app.ts": "export const hidden = true;\n".repeat(3_000) }, /src\/app\.ts/],
	] as const) {
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
	await assert.rejects(() => s.post.diffReview({ jobId: "cp-absent" }), /no dispatch record.*cp_dispatch/);
	const research = await s.seed({ "research.txt": "note\n" });
	await s.post.fleet.patch(research, { kind: "research" });
	await assert.rejects(() => s.post.diffReview({ jobId: research }), /kind:research.*cp_gate/);
	const unpushed = await s.seed({ "unpushed.txt": "note\n" });
	await s.post.fleet.patch(unpushed, { branch: "cp-never-pushed" });
	await assert.rejects(() => s.post.diffReview({ jobId: unpushed }), /branch not pushed.*git push/);
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
	assert.match(s.wakes.at(-1) ?? "", /no live worker/);
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
		await assert.rejects(() => s.post.diffReview({ jobId: job }), mode);
		if (mode === "role") await assert.rejects(() => s.post.diffReview({ jobId: job, model: chosen }), /not allowed for role/);
		assert.equal(s.provider.requests("chosen").length, 0, mode);
		assert.equal(s.provider.requests("spare").length, 0, mode);
	}
	effort = false;
	blocked = chosen;
	save(config);
	await s.post.registry.setReviewerModel("demo", null);
	const started = await s.post.diffReview({ jobId: job });
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
	for (let attempt = 1; attempt <= 2; attempt++) {
		const result = await s.review(job.id, { verdict: "revise", reasons: ["[severity: high] [confidence: high] missing test"], revisions: [`S04 add coverage ${attempt}`] });
		assert.equal(result.verdict.attempt, attempt);
		assert.equal(result.verdict.verdict, "revise");
		await waitFor(() => s.provider.requests("implementer"), (requests) => requests.some((request) => JSON.stringify(request.body.messages).includes(`S04 add coverage ${attempt}`)), { timeoutMs: 30_000, what: "revision delivered" });
		const received = JSON.stringify(s.provider.requests("implementer").at(-1)?.body.messages);
		assert.ok(received.includes(`same branch (${job.id})`));
		assert.match(received, /never a second PR/);
		assert.ok(received.includes(`review ${attempt} of 5`));
		assert.ok(received.includes(`${5 - attempt} reviews remain`));
	}
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
	const result = await s.review(job);
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
	assert.match(entry("src/run.py")?.sha256 ?? "", /^[0-9a-f]{64}$/);
	assert.deepEqual(entries.filter((e) => e.reason === "changed").map((e) => `${e.side}:${e.path}`), ["head", "fork"].flatMap((side) => ["docs/legacy.md", "img.bin", "src/core.ts", "src/run.py", "tests/core.test.ts"].map((path) => `${side}:${path}`)));
	const context = readFileSync(join(result.scratch, "context.md"), "utf8");
	assert.match(context, /S15_FORK_ONLY/);
	assert.doesNotMatch(context, /binary_marker|S15_ABSOLUTE|S15_HOME|ffff/);
	assert.equal(context.match(/^### /gm)?.length, entries.filter((e) => e.state === "included").length);
	assert.ok(context.includes("r".repeat(99)));
	const brief = readFileSync(join(result.run, "brief.md"), "utf8");
	assert.ok(brief.includes(`Fork point ${manifest.fork_point.slice(0, 12)}, head ${manifest.head_sha.slice(0, 12)}.`));
	assert.match(brief, /read context-manifest\.json first, then only the context\.md sections you need/);
	assert.match(brief, /`absent` means git confirmed the path does not exist at that sha/);
	assert.match(brief, /never treat them as absent/);
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
