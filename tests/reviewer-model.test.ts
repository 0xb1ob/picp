import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandPost } from "../src/command-post.ts";
import type { IntegrateResult } from "../src/integrate.ts";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, type FleetRecord, type Mandate } from "../src/contracts.ts";
import { MandateStore } from "../src/mandate.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { selectReviewerModel } from "../src/reviewer-model.ts";
import { argOf, captureSpawns, createAgentDir, createScratchHome, createScratchRepo, MockProvider, REPO_ROOT } from "./harness/index.ts";

const NOW = new Date("2026-10-07T10:00:00Z");
const record = { job_id: "cp-model", project: "demo", kind: "ship", dispatched_at: "2026-10-07T09:00:00Z" } as FleetRecord;
test("reviewer selection: explicit, newest active (tie by id), expired continuation, project, unset", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "https://github.com/o/demo.git" });
	await registry.setReviewerModel("demo", "project/review");
	const store = new MandateStore(home.path, { now: () => NOW });
	const first = store.issue({ projects: ["demo"], objective: "test", reviewer_model: "mandate/first", expiry: "2026-10-08T10:00:00Z", spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
	let grants: Mandate[] = [];
	const mandates = { list: () => grants, scheduleOf: () => ({}), scheduleMandates: () => new Map<string, string>() };
	const select = () => selectReviewerModel({ record, registry, mandates, now: NOW });
	assert.deepEqual(selectReviewerModel({ model: "explicit/review", record, registry, mandates, now: NOW }), { model: "explicit/review", source: "explicit" });
	assert.deepEqual(select(), { model: "project/review", source: "project" });
	const expired = { ...first, id: "md-expired", status: "expired" as const, expiry: "2026-10-07T09:30:00Z", issued_at: "2026-10-07T09:59:00Z", reviewer_model: "expired/review" };
	const newest = { ...first, id: "md-new", issued_at: "2026-10-07T09:50:00Z", reviewer_model: "new/review" };
	grants = [expired, { ...first, issued_at: "2026-10-07T09:00:00Z" }, newest];
	assert.deepEqual(select(), { model: "new/review", source: "mandate", mandate_id: "md-new" });
	grants.push({ ...newest, id: "md-z", reviewer_model: "tie/review" });
	assert.equal(select()?.mandate_id, "md-z");
	grants = [expired];
	assert.equal(select()?.model, "expired/review");
	grants = [{ ...expired, allowed_actions: ["plan"] }];
	assert.equal(select()?.source, "project");
	for (const disqualifier of [
		{ projects: ["other"] }, { job_ids: ["cp-other"] }, { exclusions: { job_kinds: ["ship" as const] } },
		{ schedule_grant: true as const }, { status: "paused" as const }, { status: "revoked" as const },
	]) {
		grants = [{ ...first, ...disqualifier }];
		assert.equal(select()?.source, "project", JSON.stringify(disqualifier));
	}
	grants = [];
	await registry.setReviewerModel("demo", null);
	assert.equal(select(), undefined);
	assert.equal(selectReviewerModel({ registry, mandates, now: NOW }), undefined, "recordless gates retain normal routing");
});

test("scheduled and legacy schedule subjects use only their actual schedule grant", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const store = new MandateStore(home.path, { now: () => NOW });
	const grant = store.issue({ projects: ["demo"], objective: "schedule", schedule_grant: true, reviewer_model: "schedule/review", expiry: "2026-10-08T10:00:00Z", spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
	const mandates = { list: () => [grant], scheduleMandates: () => new Map([["sc-one", grant.id], ["sc-other", "md-other"]]), scheduleOf: () => ({ scheduleId: "sc-one", scheduleMandate: grant.id }) };
	assert.equal(selectReviewerModel({ record: { ...record, schedule_id: "sc-one" }, mandates, now: NOW })?.model, "schedule/review");
	assert.equal(selectReviewerModel({ record: { ...record, schedule_id: "sc-other" }, mandates, now: NOW }), undefined);
	assert.equal(selectReviewerModel({ record, mandates, now: NOW })?.model, "schedule/review", "legacy scope lookup");
});


test("production factories and automatic ci_green reviews honor current preferences", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome(), repo = createScratchRepo({ name: "demo" });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const cases = ["gate", "automatic", "pipeline", "gate-reread"];
	const models = cases.map((mode) => provider.addScript(`factory-${mode}`, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: `cp-factory-${mode}`, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["covered"] } }] }]));
	agent.writeModels(provider);
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, continuation: true, holdsParentLock: () => true,
		parentEnv: { ...process.env, ...agent.env }, modelRegistry: () => ({ find: (provider, id) => models.includes(`${provider}/${id}`) ? { provider, id, reasoning: true } : undefined, hasConfiguredAuth: () => true }), sendWakeup: () => true });
	t.after(async () => { await post.shutdown(); agent.cleanup(); await provider.stop(); repo.cleanup(); home.cleanup(); });
	await post.registry.register({ name: "demo", clone_url: repo.remote! });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ ...DEFAULT_ROUTING_CONFIG, allow: ["mock/*"], rubric: [] }));
	const spawns = captureSpawns(post.manager);
	for (const [index, mode] of cases.entries()) {
		const jobId = `cp-factory-${mode}`, model = models[index]!;
		repo.git("checkout", "--quiet", "-b", jobId, repo.branch);
		repo.write(`src/${mode}.ts`, "export const covered = true;\n"); repo.commitAll(mode);
		repo.git("push", "--quiet", "origin", jobId); repo.git("checkout", "--quiet", repo.branch);
		const head = repo.head(jobId);
		await post.fleet.add({ job_id: jobId, project: "demo", kind: mode.startsWith("gate") ? "research" : "ship", delivery: mode.startsWith("gate") ? "pipeline" : "pr", origin: DEFAULT_ORIGIN,
			phase: "held", reported_at: isoTimestamp(), worktree: home.path, branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/author", started_at: isoTimestamp() },
			routing: { scope: "M", risk: "low", inferred: false }, receipts: mode.startsWith("gate") ? [] : [{ kind: "pr", status: "open", title: "PR", url: "https://github.com/o/r/pull/7" }] });
		await post.registry.setReviewerModel("demo", model);
		if (mode === "automatic") {
			post.mandates.issue({ projects: ["demo"], job_ids: [jobId], objective: "review", reviewer_model: model, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
			post.ciHead = () => head; post.reportedHeadSha = () => head;
			post.integrator.advance = async (): Promise<IntegrateResult> => {
				const record = { schema_version: 1, job_id: jobId, branch: jobId, head_sha: head, next: "review" as const, step: "merge" as const, reason: "needs review", facts: [], resolve_attempts: 0, started_at: isoTimestamp(), updated_at: isoTimestamp() };
				return { ...record, record };
			};
			assert.equal((await post.continuation.trigger({ jobId, event: "ci_green", head })).action, "review_started");
			await post.reviewRuns.settled(`${jobId}#review-1`);
		} else if (mode === "pipeline") {
			assert.equal((await post.diffReviewModule().reviewAndWait({ jobId })).verdict.verdict, "pass");
		} else {
			const file = post.artifacts.path(jobId); writeFileSync(file, "# Goal\nreview this plan\n");
			assert.equal((await post.gateModule().gateAndWait({ jobId })).verdict.verdict, "pass");
		}
		assert.equal(argOf(spawns[index]?.args ?? [], "--model"), model);
		assert.equal(argOf(spawns[index]?.args ?? [], "--thinking"), "high");
		const dir = mode.startsWith("gate") ? paths.gateRunDir(jobId, 1) : paths.reviewRunDir(jobId, 1);
		const events = readFileSync(join(home.path, dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.equal(events.find((event) => event.type === "reviewer_model_selected")?.payload.source, mode === "automatic" ? "mandate" : "project");
	}
});
