/**
 * Self-review A0 decodes `authority_hold` and `replaces_escalation_id`; H0 drives real producers on a legacy journal
 * (since A1 only the policy gate and asking plan approval hold), H0-decoder reads new-format fixtures in another home.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { isoTimestamp, LAYOUT, MINIMAL_PLAN_SUMMARY, paths, type ReviewSurface, SCHEMA_VERSION } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import type { Authorizer } from "../../src/pipeline.ts";
import { ReviewRuns } from "../../src/review-runs.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	REPO_ROOT,
	type ScriptStep,
	startPiChild,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "the pipeline producers need treehouse on PATH";
const ARTIFACT_BODY = ["# Goal", "Bump x to 2 in src/app.ts.", "", "# File list", "- src/app.ts", "", "# Test plan", "npm test", "",
	"# Unknowns/Blockers", "none", ""].join("\n");
const OPTIONS = [
	{ id: "approve", label: "approve", consequence: "proceed", cost: "none" },
	{ id: "decline", label: "decline", consequence: "stop", cost: "sunk" },
];
const LEGACY = {
	schema_version: SCHEMA_VERSION, id: "es-1e9ac0", job_ids: ["cp-legacy"], kind: "product_ambiguity", question: "which copy?",
	options: OPTIONS, recommended: "approve", mandate_id: "no mandate", mandate_clause: "no mandate", evidence_paths: [],
	created_at: "2026-11-01T00:00:00Z", status: "open",
};
const HOLD = { mandate_id: "md-a0a0", project: "demo", source_job_id: "cp-plan", ship_job_ids: ["cp-ship"], gate_attempt: 1,
	evidence_path: "state/gates/cp-plan/gate-1.json", artifact_sha256: "a".repeat(64) };

type Call = { id: string; name: string; args: Record<string, unknown> };
const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, args });

/** One real pi parent per prompt against `home`: every call is a fresh process, so each one is a parent restart. */
function parents(t: TestContext, home: string, provider: MockProvider, agentDir: ReturnType<typeof createAgentDir>, name: string) {
	let prompts = 0;
	return async (prompt: string, ...turns: Call[][]) => {
		const model = provider.addScript(`${name}-${(prompts += 1)}`, [...turns.map((calls) => ({ kind: "tool_calls" as const, calls })), { kind: "text" as const, text: "done" }]);
		agentDir.writeModels(provider);
		const child = startPiChild({ cwd: home, model, env: { ...agentDir.env, CP_HOME: home }, extensions: [COMMAND_POST_EXTENSION] });
		try {
			await child.prompt(prompt);
			await child.waitForSettled(90_000);
			const ends = new Map(child.eventsOfType("tool_execution_end").map((end) => [String(end.toolCallId), end]));
			const ok = (id: string) => assert.notEqual(ends.get(id)?.isError, true, `${id}: ${JSON.stringify(ends.get(id)?.result)}`);
			const id = (callId: string) => (ends.get(callId)?.result as { details: { id: string } }).details.id;
			return { ends, ok, id };
		} finally {
			await child.close();
		}
	};
}

const journal = (home: string) => JSON.parse(readFileSync(join(home, LAYOUT.escalationsFile), "utf8")).items as Record<string, unknown>[];
const writeJournal = (home: string, items: object[]) => {
	mkdirSync(dirname(join(home, LAYOUT.escalationsFile)), { recursive: true });
	writeFileSync(join(home, LAYOUT.escalationsFile), JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "2026-11-01T00:00:00Z", items }));
};

/**
 * The H0 field check, one assertion per field. A0 required both absent everywhere; since A1 only `held` ids (the policy
 * gate and the asking plan approval) carry `authority_hold`, and nothing in H0 is a replacement.
 */
function absent(home: string, after: string, count: number, held: readonly string[] = []): void {
	const items = journal(home);
	assert.equal(items.length, count, `${after}: journal size`);
	for (const item of items) assert.equal("authority_hold" in item, held.includes(String(item.id)), `${after}: ${item.id} authority_hold presence`);
	for (const item of items) assert.ok(!("replaces_escalation_id" in item), `${after}: ${item.id} carries replaces_escalation_id`);
	assert.equal(new EscalationStore({ home }).read().items.length, count, `${after}: the strict reader decodes the journal`);
}

/** Trimmed from pipeline-run's bench: a real CommandPost on a treehouse pool with scripted planner and gate models. */
async function pipelineBench(t: TestContext, gateSteps: ScriptStep[]) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const planner = provider.addScript("a0-research", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${ARTIFACT_BODY}EOF` } }] },
		{ kind: "text", text: "Artifact written." },
	], { onExhausted: "repeat" });
	const reviewer = provider.addScript("a0-gate", gateSteps);
	const implementer = provider.addScript("a0-ship", [{ kind: "text", text: "Working on it." }], { onExhausted: "repeat" });
	agentDir.writeModels(provider);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [
		{ id: "planner", role: "planner", model: planner },
		{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer },
		{ id: "implementer", role: "implementer", model: implementer },
	] }));
	const authorizer: Authorizer = { ask: async () => undefined };
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agentDir.env }, authorizer });
	post.reviewRuns.wakeupPort = () => true;
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 3 });
	t.after(async () => {
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// the pool root goes next anyway
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});
	const settle = async (jobId: string, surface: ReviewSurface, attempt: number) => {
		const key = ReviewRuns.key(jobId, surface, attempt);
		post.reviewRuns.handBack(key);
		await post.reviewRuns.settled(key);
	};
	const advanceThrough = async (researchId: string) => {
		let result = await post.advancePipeline(researchId);
		for (let guard = 0; result.pending && guard < 10; guard += 1) {
			await settle(result.pending.surface === "review" ? result.ship_id : result.research_id, result.pending.surface, result.pending.attempt);
			result = await post.advancePipeline(researchId);
		}
		return result;
	};
	return { home: home.path, post, provider, agentDir, settle, advanceThrough };
}

const verdict = (jobId: string, overrides: Record<string, unknown> = {}): ScriptStep => ({
	kind: "tool_calls",
	calls: [{ name: "report_verdict", args: { job_id: jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["file list is concrete"], ...overrides } }],
});

test("H0: on a field-absent journal, cp_escalate raise/answer/withdraw, a policy gate, a pending plan approval and parent restarts write neither authority field", { skip: SKIP, timeout: 900_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await pipelineBench(t, steps);
	writeJournal(b.home, [LEGACY]);
	absent(b.home, "legacy seed", 1);
	const escalations = new EscalationStore({ home: b.home });

	// A policy escalate from the real gate, then its research teardown (the S1-01 sequence's producers).
	const policy = await b.post.startPipeline({ title: "bump x", project: "demo", task: "Bump x to 2 in src/app.ts.", delivery: "local", slug: "bump-x", fetch: false });
	await waitFor(() => b.post.artifacts.has(policy.research_id), (there) => there, { what: "the planner's artifact" });
	steps.push(verdict(policy.research_id, { verdict: "escalate", reasons: ["the plan skips a rollback step"] }));
	assert.equal((await b.advanceThrough(policy.research_id)).state, "escalated");
	const gate = escalations.list({ kind: "conflicting_acceptance" });
	assert.equal(gate.length, 1, "the gate raised one policy escalation");
	const held = [gate[0]!.id];
	absent(b.home, "policy escalation", 2, held);
	assert.deepEqual([gate[0]!.authority_hold?.source_job_id, gate[0]!.authority_hold?.ship_job_ids, gate[0]!.authority_hold?.gate_attempt],
		[policy.research_id, [policy.ship_id], 1], "A1: the policy gate records its hold");
	await b.post.tearDown(policy.research_id, { force: true });
	absent(b.home, "research teardown", 2, held);

	// A pending plan approval from the selected ask_on grant, as P11d-plan-ask drives it.
	const plan = await b.post.startPipeline({ title: "bump y", project: "demo", task: "Bump x to 2 in src/app.ts.", delivery: "local", slug: "bump-y", fetch: false });
	writeFileSync(b.post.artifacts.file(plan.research_id), ARTIFACT_BODY);
	const envelopeFile = join(b.home, paths.envelopeFile(plan.research_id));
	mkdirSync(dirname(envelopeFile), { recursive: true });
	writeFileSync(envelopeFile, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: plan.research_id, received_at: isoTimestamp(), attempt: 1, envelope: {
		job_id: plan.research_id, kind: "research", status: "done", summary: "plan complete", artifact_path: b.post.artifacts.file(plan.research_id),
		plan_summary: MINIMAL_PLAN_SUMMARY, self_assessment: { scope: "M", confidence: "high", destructive_scope: false, blocking_unknowns: false } } }));
	steps.push(verdict(plan.research_id));
	const gating = await b.post.advancePipeline(plan.research_id);
	if (gating.pending) await b.settle(plan.research_id, gating.pending.surface, gating.pending.attempt);
	const grant = b.post.mandates.issue({ projects: ["demo"], objective: "a0 plan approval", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 50, job_ids: [plan.ship_id], ask_on: ["plan_approval"], allowed_actions: ["implement"] });
	const asked = await b.advanceThrough(plan.research_id);
	assert.deepEqual([asked.next, asked.checkpoint?.decision, b.post.fleet.get(plan.ship_id)], ["authorize", "pending", undefined]);
	const approval = escalations.list({ kind: "plan_approval" });
	assert.deepEqual(approval.map((row) => [row.status, row.mandate_id]), [["open", grant.id]]);
	held.push(approval[0]!.id);
	assert.equal(approval[0]!.authority_hold?.mandate_id, grant.id, "A1: the asking grant's plan approval records its hold");
	absent(b.home, "plan approval", 3, held);
	for (const id of [plan.research_id, plan.ship_id]) {
		if (b.post.fleet.get(id) && b.post.fleet.get(id)?.phase !== "done") await b.post.tearDown(id, { force: true });
	}

	// cp_escalate raise, cp_decide answer and withdraw (the policy record too) through real parents, one process each.
	const parent = parents(t, b.home, b.provider, b.agentDir, "a0-h0");
	const raise = (id: string, job: string, question: string) =>
		call(id, "cp_escalate", { job_ids: [job], kind: "product_ambiguity", question, options: OPTIONS, recommended: "approve" });
	const raised = await parent("File the escalations.", [raise("r1", "cp-job1", "which copy?"), raise("r2", "cp-job2", "which colour?")]);
	raised.ok("r1");
	raised.ok("r2");
	absent(b.home, "cp_escalate raise", 5, held);
	const [r1, r2] = [raised.id("r1"), raised.id("r2")];
	const decided = await parent(`Approve ${r1}.`, [
		call("d-r1", "cp_decide", { target: r1, decision: "approve", basis: { operator_quote: `Approve ${r1}.` } }),
		call("wd-r2", "cp_escalate", { action: "withdraw", escalation_id: r2, reason: "moot" }),
		call("wd-gate", "cp_escalate", { action: "withdraw", escalation_id: gate[0]!.id, reason: "superseded by a replan" }),
	]);
	for (const id of ["d-r1", "wd-r2", "wd-gate"]) decided.ok(id);
	absent(b.home, "cp_decide answer and cp_escalate withdraw", 5, held);
	assert.deepEqual([r1, r2, gate[0]!.id, approval[0]!.id].map((id) => escalations.get(id)?.status), ["answered", "withdrawn", "withdrawn", "open"]);

	const restarted = await parent("What awaits me?", [call("list", "cp_awaiting", { action: "list" })]);
	restarted.ok("list");
	absent(b.home, "parent restart", 5, held);
});

test("H0-decoder: a separate home's legacy and new-format records decode through a real parent, and an answer keeps the metadata", { timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	t.after(async () => {
		await provider.stop();
		agentDir.cleanup();
		home.cleanup();
	});
	const fresh = { ...LEGACY, id: "es-a0f00d", job_ids: ["cp-ship"], question: "release the hold?", authority_hold: HOLD, replaces_escalation_id: "es-a0dead" };
	const withdrawn = { ...LEGACY, id: "es-a0dead", job_ids: ["cp-ship"], question: "release the hold?", status: "withdrawn", authority_hold: HOLD };
	writeJournal(home.path, [LEGACY, withdrawn, fresh]);
	const parent = parents(t, home.path, provider, agentDir, "a0-decoder");
	const run = await parent(`Approve ${fresh.id}.`, [
		call("d-fresh", "cp_decide", { target: fresh.id, decision: "approve", basis: { operator_quote: `Approve ${fresh.id}.` } }),
		call("wd-legacy", "cp_escalate", { action: "withdraw", escalation_id: LEGACY.id, reason: "moot" }),
	]);
	run.ok("d-fresh");
	run.ok("wd-legacy");
	const items = new Map(journal(home.path).map((item) => [item.id, item]));
	assert.deepEqual([items.get(fresh.id)?.status, items.get(fresh.id)?.authority_hold, items.get(fresh.id)?.replaces_escalation_id], ["answered", HOLD, withdrawn.id]);
	assert.deepEqual([items.get(withdrawn.id)?.status, items.get(withdrawn.id)?.authority_hold], ["withdrawn", HOLD]);
	assert.deepEqual([items.get(LEGACY.id)?.status, "authority_hold" in items.get(LEGACY.id)!], ["withdrawn", false]);
});
