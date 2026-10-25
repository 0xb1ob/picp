/**
 * P11c behavior 10: the opt-in pre-gate quality panel through a real CommandPost — `post.qualityPass()` (what the
 * pipeline, the orphan sweep and S15 use) with routing from the home's routing.json, and a real pipeline whose home
 * quality.json turns the panel on and whose failing panel promotes the live planner with the fix message.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import {
	DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, type JobRouting, LAYOUT, MINIMAL_PLAN_SUMMARY, paths, type QualityReport, SCHEMA_VERSION,
} from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { QUALITY_OFF } from "../../src/quality.ts";
import { ReviewRuns, type ReviewWakeup } from "../../src/review-runs.ts";
import {
	createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, MockProvider, type RecordedRequest, REPO_ROOT,
	type ScriptStep, treehouse, treehouseAvailable, waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "P11c quality pipeline needs treehouse on PATH";
const ARTIFACT = "# Goal\nbump x\n\n# File list\nsrc/app.ts\n";
const brief = (request: RecordedRequest) => JSON.stringify(request.body.messages ?? []);
const jobOf = (request: RecordedRequest) =>
	/\b(cp-q-[a-z]+)\b/.exec(JSON.stringify((request.body.messages ?? []).filter((m) => (m as { role?: string }).role === "user")))?.[1] ?? "unknown";
const vote = (verdict: "pass" | "revise"): ScriptStep => ({
	kind: "tool_calls",
	calls: [{ name: "report_verdict", args: (request: RecordedRequest) => ({
		job_id: jobOf(request), verdict, reasons: ["checked"], flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		...(verdict === "revise" ? { revisions: ["name the exact files"] } : {}),
	}) }],
	usage: { prompt_tokens: 400, completion_tokens: 20 },
});

async function bench(t: { after(fn: () => void | Promise<void>): void }) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const modelRegistry = { find: (p: string, id: string) => ({ provider: p, id, reasoning: true }), hasConfiguredAuth: (m: { provider?: string }) => m.provider !== "unauth" };
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agent.env }, modelRegistry: () => modelRegistry });
	const sent: ReviewWakeup[] = [];
	post.reviewRuns.wakeupPort = (wakeup) => (sent.push(wakeup), true);
	t.after(async () => { await post.shutdown(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const routing = (body: Record<string, unknown>) =>
		writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*", "unauth/*"], ...body }));
	const script = (name: string, steps: ScriptStep[]) => {
		const model = provider.addScript(name, steps);
		const config = provider.modelsJson();
		for (const entry of Object.values(config.providers)) for (const row of (entry as { models: Record<string, unknown>[] }).models) row.reasoning = true;
		writeFileSync(join(agent.path, "models.json"), JSON.stringify(config));
		return model;
	};
	const subject = async (jobId: string, routed?: JobRouting) => {
		writeFileSync(post.artifacts.path(jobId), ARTIFACT);
		await post.fleet.add({ job_id: jobId, project: "demo", kind: "research", delivery: "pipeline", origin: DEFAULT_ORIGIN, phase: "held",
			reported_at: isoTimestamp(), worktree: home.path, branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "planner", role: "planner", model: "mock/planner", started_at: isoTimestamp() },
			...(routed ? { routing: routed } : {}) });
	};
	const events = (jobId: string) => readFileSync(join(home.path, paths.qualityRunDir(jobId, "verify-1"), "events.jsonl"), "utf8").split("\n").filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> });
	const decision = (jobId: string) => events(jobId).find((event) => event.type === "routing_resolved")?.payload;
	/** The effort the voter's pi process actually ran at, from its own state in the run log. */
	const effort = (jobId: string) => /"thinkingLevel":"([a-z]+)"/.exec(JSON.stringify(events(jobId).filter((event) => event.type !== "routing_resolved")))?.[1];
	return { home: home.path, post, provider, sent, routing, script, subject, decision, effort };
}

test("P11c-quality-panel: the panel votes, tallies, abstains, routes and refuses through the command post's own pass", { timeout: 300_000 }, async (t) => {
	const b = await bench(t);
	const pass = () => b.post.qualityPass();
	const voter = b.script("p11c-q-ok", [vote("pass"), vote("revise"), vote("pass")]);
	b.routing({ rubric: [{ id: "voters", role: "gate-reviewer", model: voter }] });

	await b.subject("cp-q-off");
	assert.equal(await pass().runAndWait({ jobId: "cp-q-off", task: "t", config: QUALITY_OFF }), undefined, "off until a job asks");
	assert.equal(await pass().runAndWait({ jobId: "cp-q-off", task: "t", config: {} }), undefined);
	assert.equal(existsSync(join(b.home, paths.qualityFile("cp-q-off"))), false, "a disabled pass writes nothing");

	await b.subject("cp-q-on");
	const report = (await pass().runAndWait({ jobId: "cp-q-on", task: "Bump x to 2 in src/app.ts", config: { verify: true, completeness: true, voters: 2, threshold: 0.5 } }))!;
	assert.deepEqual([report.verify?.sound_count, report.verify?.total, report.verify?.sound, report.completeness?.complete, report.passed], [1, 2, true, true, true],
		"1 of 2 clears a 0.5 threshold");
	assert.deepEqual(report.verify?.votes.map((cast) => cast.lens), ["evidence", "file_list"], "voters get distinct lenses");
	assert.deepEqual(report.fixes, ["[file_list] name the exact files"], "a dissenting vote is still a fix, and a sound one is not");
	assert.deepEqual(JSON.parse(readFileSync(join(b.home, paths.qualityFile("cp-q-on")), "utf8")), report);
	assert.ok(!JSON.stringify(report).includes("# Goal"), "the panel never puts the artifact in the report");
	const briefs = b.provider.requests("p11c-q-ok").map(brief);
	const lensBrief = briefs.find((text) => text.includes("through the file_list lens")) ?? "";
	assert.ok(lensBrief.includes("/cp-q-on/quality-verify-2/review/artifact.md") && !lensBrief.includes("${"), "the lens brief renders");
	assert.match(lensBrief, /each item ≤ 400 characters \(about three lines\), max 10 items\./);
	assert.match(lensBrief, /\*\*only when `verdict` is `revise`\*\*/);
	assert.ok(briefs.some((text) => text.includes("Bump x to 2 in src/app.ts") && !text.includes("Lens") && !text.includes("${")), "the completeness brief carries the task");
	const spent = b.provider.requests("p11c-q-ok").length;
	assert.deepEqual(await pass().runAndWait({ jobId: "cp-q-on", task: "t", config: { verify: true, voters: 2 } }), report, "written once");
	assert.equal(b.provider.requests("p11c-q-ok").length, spent, "a second run spends no model");

	const bad = b.script("p11c-q-bad", Array.from({ length: 5 }, () => vote("revise")));
	b.routing({ rubric: [{ id: "voters", role: "gate-reviewer", model: bad }] });
	await b.subject("cp-q-fail");
	const failed = (await pass().runAndWait({ jobId: "cp-q-fail", task: "t", config: { verify: true, voters: 5, threshold: 0.6 } }))!;
	assert.deepEqual([failed.passed, failed.verify?.sound], [false, false]);
	assert.deepEqual(failed.fixes, ["evidence", "file_list", "test_plan", "scope", "unknowns"].map((lens) => `[${lens}] name the exact files`),
		"five distinct lenses; each fix names its lens");

	const silent = b.script("p11c-q-silent", [{ kind: "text", text: "I would rather discuss it." }]);
	b.routing({ rubric: [{ id: "voters", role: "gate-reviewer", model: silent }] });
	await b.subject("cp-q-abstain");
	const abstained = (await pass().runAndWait({ jobId: "cp-q-abstain", task: "t", config: { verify: true, voters: 1, threshold: 0.5 } }))!;
	assert.deepEqual([abstained.verify?.votes[0]?.abstained, abstained.verify?.sound_count, abstained.verify?.total, abstained.passed], [true, 0, 1, false],
		"an abstention counts in the denominator and is not a yes");
	assert.match(String(abstained.verify?.votes[0]?.note), /without reporting a verdict/);

	await assert.rejects(pass().runAndWait({ jobId: "cp-q-missing", task: "t", config: { verify: true } }), /no artifact for cp-q-missing/);
	// A sixth voter would re-use a lens round-robin, but the config contract caps voters at 5 where it is read.
	writeFileSync(join(b.home, LAYOUT.data, "quality.json"), JSON.stringify({ verify: true, voters: 6 }));
	await assert.rejects(b.post.advancePipeline("cp-q-none"), /quality\.json violates the quality contract:\n {2}\/voters: must be <= 5/);
	rmSync(join(b.home, LAYOUT.data, "quality.json"));
	for (const [jobId, config, refusal] of [["cp-q-zero", { verify: true, voters: 0 }, /voters must be a positive integer, got 0/],
		["cp-q-over", { verify: true, voters: 1, threshold: 1.5 }, /threshold must be between 0 and 1, got 1.5/]] as const) {
		await b.subject(jobId);
		const before = b.sent.length;
		assert.equal(await pass().runAndWait({ jobId, task: "t", config }), undefined);
		assert.match(b.sent[before]?.content ?? "", refusal);
		assert.match(b.sent[before]?.content ?? "", /quality panel failed .* No report was written/);
	}

	const asyncVoter = b.script("p11c-q-async", [vote("pass"), vote("pass")]);
	b.routing({ rubric: [{ id: "voters", role: "gate-reviewer", model: asyncVoter }] });
	await b.subject("cp-q-async");
	const started = await pass().start({ jobId: "cp-q-async", task: "t", config: { verify: true, voters: 2, threshold: 1 } });
	assert.ok(started && "key" in started && started.attempt === 1, JSON.stringify(started));
	assert.ok(existsSync(join(b.home, paths.pendingReviewFile("cp-q-async", "quality", 1))), "one pending attempt in the panel's slot");
	assert.equal(existsSync(join(b.home, paths.qualityRunDir("cp-q-async", "verify-1"), "pending.json")), false, "votes carry no pending file");
	const wakes = b.sent.length;
	b.post.reviewRuns.handBack(started.key);
	await b.post.reviewRuns.settled(started.key);
	assert.deepEqual(b.sent.slice(wakes).map((wake) => [wake.surface, /cp-q-async quality pass: passed \| verify 2\/2/.test(wake.content)]), [["quality", true]],
		"one wake-up, the formatted report");
	const again = await pass().start({ jobId: "cp-q-async", task: "t", config: { verify: true } });
	assert.equal((again as QualityReport).passed, true, "one pass per job: the report, nothing spawned");

	// cp-reviewer-routing: the subject's L/high fires the narrow voter row at its effort; a configured voter model is
	// an override that keeps the profile's effort and still records the subject's impact. 0a9: a fallback votes.
	const narrow = b.script("p11c-q-narrow", [vote("pass")]);
	const broad = b.script("p11c-q-broad", [vote("pass")]);
	const spare = b.script("p11c-q-spare", [vote("pass"), vote("pass")]);
	b.routing({ rubric: [
		{ id: "voters-large", role: "gate-reviewer", scope: ["L"], risk: "high", model: narrow, thinking: "medium" },
		{ id: "voters-default", role: "gate-reviewer", model: "unauth/opus", fallbacks: [spare], thinking: "low" },
	] });
	const impact: JobRouting = { scope: "L", risk: "high", inferred: true, provenance: { scope: "inferred", risk: "assessed" } };
	await b.subject("cp-q-routed", impact);
	await b.subject("cp-q-override", impact);
	await b.subject("cp-q-fallback");
	assert.equal((await pass().runAndWait({ jobId: "cp-q-routed", task: "t", config: { verify: true, voters: 1, threshold: 0.5 } }))?.verify?.votes[0]?.model, narrow);
	assert.deepEqual([b.decision("cp-q-routed")?.model, b.decision("cp-q-routed")?.thinking], [narrow, "medium"]);
	assert.equal(b.effort("cp-q-routed"), "medium", "the voter spawns at the routed effort");
	assert.equal((await pass().runAndWait({ jobId: "cp-q-override", task: "t", config: { verify: true, voters: 1, threshold: 0.5, model: broad } }))?.verify?.votes[0]?.model, broad);
	const overridden = b.decision("cp-q-override")!;
	assert.deepEqual([overridden.surface, "attempt" in overridden, overridden.source, overridden.requested, "requested_thinking" in overridden], ["quality/verify-1", false, "override", broad, false]);
	assert.deepEqual([overridden.thinking, overridden.scope, overridden.risk], ["high", "L", "high"], "the profile's effort, the subject's impact");
	assert.deepEqual([overridden.provenance, overridden.subject_provenance], [{ scope: "inherited", risk: "inherited" }, { scope: "inferred", risk: "assessed" }]);
	assert.equal((await pass().runAndWait({ jobId: "cp-q-fallback", task: "t", config: { verify: true, voters: 1, threshold: 0.5 } }))?.verify?.votes[0]?.model, spare);
	assert.deepEqual([b.decision("cp-q-fallback")?.attempted, b.decision("cp-q-fallback")?.thinking], [[{ model: "unauth/opus", refusal: "availability" }], "low"]);
	assert.deepEqual([b.effort("cp-q-override"), b.effort("cp-q-fallback")], ["high", "low"]);

	// cp-7re9: deny_by_role refuses a configured voter model and a rubric row's only candidate, and spawns nothing.
	const denied = b.script("p11c-q-denied", [vote("pass")]);
	const deny = { "gate-reviewer": [denied] };
	await b.subject("cp-q-deny");
	b.routing({ deny_by_role: deny, rubric: [{ id: "voters", role: "gate-reviewer", model: spare }] });
	await assert.rejects(pass().runAndWait({ jobId: "cp-q-deny", task: "t", config: { verify: true, voters: 1, model: denied } }),
		/^Error: settings: model .* is not allowed for role gate-reviewer \(override;/);
	b.routing({ deny_by_role: deny, rubric: [{ id: "voters", role: "gate-reviewer", model: denied }] });
	await assert.rejects(pass().runAndWait({ jobId: "cp-q-deny", task: "t", config: { verify: true, voters: 1 } }), /not allowed for role gate-reviewer/);
	assert.equal(b.provider.requests("p11c-q-denied").length, 0, "a denied voter never spawns");
	b.routing({ deny_by_role: deny, rubric: [{ id: "voters", role: "gate-reviewer", model: denied, fallbacks: [spare] }] });
	assert.equal((await pass().runAndWait({ jobId: "cp-q-deny", task: "t", config: { verify: true, voters: 1, threshold: 0.5 } }))?.verify?.votes[0]?.model, spare);
	assert.deepEqual(b.decision("cp-q-deny")?.attempted, [{ model: denied, refusal: "allowlist" }]);

	// A panel lost with a previous parent: the session-start sweep writes no report and asks for the panel again.
	await b.subject("cp-q-orphan");
	mkdirSync(join(b.home, paths.pendingReviewFile("cp-q-orphan", "quality", 1), ".."), { recursive: true });
	writeFileSync(join(b.home, paths.pendingReviewFile("cp-q-orphan", "quality", 1)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: "cp-q-orphan",
		surface: "quality", attempt: 1, model: "m", pid: 999_999_999, started_at: isoTimestamp(), deadline: isoTimestamp(), handed_back: true }));
	const swept = await b.post.sweepOrphanReviews();
	assert.deepEqual(swept.finished.map((pending) => pending.job_id), ["cp-q-orphan"], JSON.stringify(swept.skipped));
	assert.match(b.sent.at(-1)?.content ?? "", /cp-q-orphan: the quality panel .* was lost .* advance the pipeline to run the panel again/);
	assert.equal(existsSync(join(b.home, paths.qualityFile("cp-q-orphan"))), false);
});

test("P11c-quality-pipeline: home quality.json opts the pipeline in, and a fresh failure promotes the planner once", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "src/app.ts": "export const x = 1;\n" } });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const artifactPath = (request: RecordedRequest) => /(\/[^"'\s\\]*\/state\/artifacts\/[A-Za-z0-9_-]+\/report\.md)/.exec(brief(request))?.[1] ?? "";
	const planner = provider.addScript("p11c-qp-planner", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${ARTIFACT}EOF` } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: (request: RecordedRequest) => ({
			job_id: /\/state\/artifacts\/([A-Za-z0-9_-]+)\/report\.md/.exec(artifactPath(request))?.[1], kind: "research", status: "done",
			summary: "Plan written.", artifact_path: artifactPath(request), plan_summary: MINIMAL_PLAN_SUMMARY,
			self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false },
		}) }] },
		{ kind: "text", text: "Standing by." },
	], { onExhausted: "repeat" });
	const reviewerSteps: ScriptStep[] = [];
	const reviewer = provider.addScript("p11c-qp-reviewer", reviewerSteps);
	agent.writeModels(provider);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"],
		rubric: [{ id: "planner", role: "planner", model: planner }, { id: "gate-reviewer", role: "gate-reviewer", model: reviewer }] }));
	// cp-u3i2: only the home's data/quality.json is config; a legacy top-level data/ file would turn verify off.
	writeFileSync(join(home.path, LAYOUT.data, "quality.json"), JSON.stringify({ verify: true, voters: 3 }));
	mkdirSync(join(home.path, "data"), { recursive: true });
	writeFileSync(join(home.path, "data/quality.json"), JSON.stringify({ verify: false }));
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env } });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const sent: ReviewWakeup[] = [];
	post.reviewRuns.wakeupPort = (wakeup) => (sent.push(wakeup), true);
	const pool = enableTreehouse(clone, { maxTrees: 4 });
	t.after(async () => {
		await post.shutdown();
		try { treehouse(clone, "prune"); } catch { /* the pool root is deleted next anyway */ }
		pool.cleanup(); agent.cleanup(); repo.cleanup(); home.cleanup(); await provider.stop();
	});

	// The job layer wins over the home default: one voter, plus completeness.
	const started = await post.startPipeline({ title: "bump x", project: "demo", task: "Bump x to 2 in src/app.ts.", delivery: "local", slug: "qp",
		fetch: false, quality: { voters: 1, completeness: true } });
	const id = started.research_id;
	await waitFor(() => post.artifacts.has(id), (there) => there, { timeoutMs: 60_000, what: "the planner's artifact" });
	await waitFor(() => post.fleet.get(id)?.phase, (phase) => phase === "held", { timeoutMs: 60_000, what: "the planner's envelope" });
	const verdict = (verdict: "pass" | "revise", revisions: string[] = []): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
		job_id: id, verdict, reasons: ["checked"], flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		...(verdict === "revise" ? { revisions } : {}) } }] });
	reviewerSteps.push(verdict("revise", ["no paths at all"]), verdict("revise", ["the rollback path"]), verdict("pass"));

	const waiting = await post.advancePipeline(id);
	assert.equal(waiting.pending?.surface, "quality", waiting.message);
	post.reviewRuns.handBack(ReviewRuns.key(id, "quality", 1));
	await post.reviewRuns.settled(ReviewRuns.key(id, "quality", 1));
	const report = JSON.parse(readFileSync(join(home.path, paths.qualityFile(id)), "utf8")) as QualityReport;
	assert.deepEqual([report.verify?.total, report.completeness?.complete, report.fixes], [1, false, ["[evidence] no paths at all", "[completeness] the rollback path"]]);
	assert.match(sent.at(-1)?.content ?? "", new RegExp(`^${id} quality pass: not ready \\| verify 0/1 \\(>= 0.5\\) \\| completeness missing\\n  - \\[evidence\\]`));
	assert.match(sent.at(-1)?.content ?? "", new RegExp(`Next: call cp_pipeline advance ${id}\\.$`));

	const plannerTurns = provider.requests("p11c-qp-planner").length;
	const held = await post.advancePipeline(id);
	assert.equal(held.next, "wait");
	assert.match(held.message, new RegExp(`${id}: pre-gate quality pass asked for fixes`));
	await waitFor(() => provider.requests("p11c-qp-planner").length, (count) => count > plannerTurns, { timeoutMs: 60_000, what: "the promoted planner" });
	const users = (provider.requests("p11c-qp-planner").at(-1)?.body.messages ?? []).filter((m) => (m as { role?: string }).role === "user");
	const fix = JSON.stringify(users.at(-1));
	for (const line of [`Pre-gate quality pass for ${id}: not ready.`, "Panel: 0/1 sound (threshold 0.5).", "Completeness: the artifact does not cover the task.",
		"- [evidence] no paths at all", "- [completeness] the rollback path", "update the artifact in place"]) assert.ok(fix.includes(line), `${line} in ${fix}`);
	assert.ok(!fix.includes("# File list"), "the fix message never carries the artifact body");

	const gating = await post.advancePipeline(id);
	assert.equal(gating.pending?.surface, "gate", "a second advance goes to the gate whatever the panel thought");
	assert.equal(provider.requests("p11c-qp-reviewer").length, 2, "the write-once report spends no second panel");
});
