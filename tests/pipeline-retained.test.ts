/**
 * P11d: tests/pipeline.test.ts's units, kept verbatim (docs/testing-migration/p11d.md names each one's missing
 * entry point); its real-pipeline cases are tests/e2e/pipeline-run.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { finalFixFile, readFinalFixRecord } from "../src/final-fix.ts";
import { atomicWriteJson } from "../src/json-store.ts";
import { MandateStore } from "../src/mandate.ts";
import { CheckpointError, CheckpointStore } from "../src/checkpoint.ts";
import {
	type DiffReviewConfig,
	type DiffVerdict,
	type GateFlags,
	type GateVerdict,
	isoTimestamp,
	type JobRouting,
	LAYOUT,
	paths,
	REVIEW_MAX_ATTEMPTS,
	type Risk,
	MINIMAL_PLAN_SUMMARY,
	SCHEMA_VERSION,
	type Scope,
	type SelfAssessment,
	type TaskImpact,
} from "../src/contracts.ts";
import { nextAction } from "../src/gate.ts";
import { ReviewApprovalStore } from "../src/review-approval.ts";
import { riskKeywords } from "../src/risk-warning.ts";
import {
	type Authorizer,
	type DiffReviewer,
	type DiffReviewOutcome,
	inferScopeAndRisk,
	PipelineError,
	type PipelineOptions,
	PipelineRunner,
	PipelineStore,
	composeImplementationRouting,
	taskImpactFrom,
} from "../src/pipeline.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

// ---------------------------------------------------------------------------
// checkpoints: evidence is not authorization
// ---------------------------------------------------------------------------

test("a checkpoint is journaled pending before anyone is asked, and answered once", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new CheckpointStore(home.path);

	assert.throws(() => store.requireApproved("cp-ship"), /has no checkpoint/);
	assert.throws(() => store.decide("cp-ship", true, { by: "operator" }), CheckpointError);

	const asked = store.request({
		jobId: "cp-ship",
		researchId: "cp-research",
		question: "Authorize implementation?",
		evidence: ["gate: pass (attempt 1)"],
	});
	assert.equal(asked.decision, "pending");
	// The question is on disk before an answer exists: a crash cannot look like a yes.
	assert.equal(
		JSON.parse(readFileSync(join(home.path, paths.checkpointFile("cp-ship")), "utf8")).decision,
		"pending",
	);
	assert.throws(() => store.requireApproved("cp-ship"), /evidence is not authorization/);
	// Asking twice is the same question, not a new one.
	assert.deepEqual(store.request({ jobId: "cp-ship", question: "again?" }), asked);

	const approved = store.decide("cp-ship", true, { by: "operator dialog", note: "ship it" });
	assert.equal(approved.decision, "approved");
	assert.equal(approved.decided_by, "operator dialog");
	assert.ok(approved.decided_at);
	assert.equal(store.requireApproved("cp-ship").decision, "approved");

	// An answer is given once: repeating it is a no-op, reversing it is refused.
	assert.deepEqual(store.decide("cp-ship", true, { by: "someone else" }), approved);
	assert.throws(() => store.decide("cp-ship", false, { by: "operator" }), /already approved/);
});

test("a declined checkpoint is a decision, not a pause", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new CheckpointStore(home.path);
	store.request({ jobId: "cp-ship2", question: "Authorize?" });
	const declined = store.decide("cp-ship2", false, { by: "operator command", note: "wrong approach" });
	assert.equal(declined.decision, "declined");
	assert.throws(() => store.requireApproved("cp-ship2"), /declined, not approved/);
	assert.throws(() => store.decide("cp-ship2", true, { by: "operator" }), /already declined/);
});

test("the planner's measurements become routing inputs; its model suggestion does not", () => {
	// cp-rte (a): scope/destructive_scope/blocking_unknowns/confidence are
	// contract-typed facts about the plan, so routing may use them. The model
	// suggestion is a request for resources, so it may not.
	assert.deepEqual(
		composeImplementationRouting({}),
		{ inputsFrom: {}, reasons: [] },
		"a hung planner with no known task impact supplies nothing: dispatch assesses both axes",
	);

	const small = composeImplementationRouting({
		assessment: {
			confidence: "high",
			scope: "S",
			blocking_unknowns: false,
			destructive_scope: false,
			suggested_implementer_model: "anthropic/claude-opus-5",
		},
	});
	assert.equal(small.scope, "S");
	assert.equal(small.inputsFrom.scope, "assessed");
	// routing T2: the absence of a destructive flag is not a measurement of
	// impact, so no `risk` is emitted at all and dispatch reads the task's words.
	assert.equal(small.risk, undefined, "a confident planner does not get to assert low risk");
	assert.ok(!JSON.stringify(small).includes("claude-opus-5"), "the suggestion never becomes a routing input");

	assert.equal(
		composeImplementationRouting({
			assessment: { confidence: "high", scope: "L", blocking_unknowns: false, destructive_scope: false },
		}).scope,
		"L",
	);

	// Any one of the three is enough to call it risky — each is its own reason to
	// spend a better model, so they are not averaged.
	for (const risky of [
		{ destructive_scope: true, blocking_unknowns: false, confidence: "high" as const },
		{ destructive_scope: false, blocking_unknowns: true, confidence: "high" as const },
		{ destructive_scope: false, blocking_unknowns: false, confidence: "low" as const },
	]) {
		const composed = composeImplementationRouting({ assessment: { scope: "M", ...risky } });
		assert.equal(composed.risk, "high", JSON.stringify(risky));
		assert.equal(composed.inputsFrom.risk, "assessed");
	}
});

test("routing T2: a confident plan cannot lower the task's own known impact", () => {
	// The reproduction from the tracker: production credential work, and a planner
	// that reports scope M, high confidence, nothing destructive, nothing blocked.
	const task = taskImpactFrom({ text: "Rotate production credentials across services" });
	assert.equal(task.routing.risk, "high");
	assert.equal(task.routing.provenance?.risk, "inferred", "the task's own words are the evidence");
	assert.equal(task.source, "start");

	const confident = { confidence: "high" as const, scope: "M" as const, blocking_unknowns: false, destructive_scope: false };
	const composed = composeImplementationRouting({ task, assessment: confident });
	assert.equal(composed.risk, "high", "known impact survives a confident, non-destructive plan");
	assert.equal(composed.inputsFrom.risk, "inferred", "and it keeps the provenance of the source it came from");
	assert.match(composed.reasons.join("; "), /risk high retained from the task \(inferred, start\)/);

	// An axis the operator named explicitly is retained the same way, with its own
	// provenance, even when the text says nothing (regression case 1).
	const named = taskImpactFrom({ text: "Tidy the widget list", risk: "high" });
	assert.equal(named.routing.provenance?.risk, "explicit");
	const fromNamed = composeImplementationRouting({ task: named, assessment: confident });
	assert.equal(fromNamed.risk, "high");
	assert.equal(fromNamed.inputsFrom.risk, "explicit");

	// A non-destructive payment/auth task cannot be talked down either.
	assert.equal(
		composeImplementationRouting({
			task: taskImpactFrom({ text: "Add a receipt line to the refund email" }),
			assessment: confident,
		}).risk,
		"high",
	);

	// A truly low-impact task stays low: nothing is emitted, so dispatch assesses
	// it — and planner uncertainty can still escalate it.
	const low = taskImpactFrom({ text: "Bump the version in package.json" });
	assert.equal(low.routing.provenance?.risk, "defaulted");
	assert.equal(composeImplementationRouting({ task: low, assessment: confident }).risk, undefined);
	assert.equal(
		composeImplementationRouting({ task: low, assessment: { ...confident, blocking_unknowns: true } }).risk,
		"high",
	);
});

test("routing T2: scope may shrink with evidence while impact stays high", () => {
	// An L-sized production task whose gated plan turns out to be one small change.
	const task = taskImpactFrom({ text: "Redesign the production billing pipeline", scope: "L" });
	assert.equal(task.routing.scope, "L");
	assert.equal(task.routing.risk, "high");
	const composed = composeImplementationRouting({
		task,
		assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false },
	});
	assert.equal(composed.scope, "S", "the planner measured the implementation; scope is allowed to shrink");
	assert.equal(composed.inputsFrom.scope, "assessed");
	assert.equal(composed.risk, "high", "shrinking the change does not shrink what it touches");
	assert.match(composed.reasons.join("; "), /scope S: the planner measured the implementation \(task said L\)/);

	// A planner that measured no scope leaves the task's own scope standing.
	assert.equal(composeImplementationRouting({ task }).scope, "L");
	assert.equal(composeImplementationRouting({ task }).inputsFrom.scope, "explicit");
});

test("routing T2: a legacy JobRouting with no per-axis provenance is still read honestly", () => {
	// A record written before `provenance` existed carries only the one-bit flag,
	// which cannot say which axis it describes. The weaker claim is made for both.
	const legacy = composeImplementationRouting({
		task: { routing: { scope: "M", risk: "high", inferred: true }, source: "fleet_routing" },
		assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false },
	});
	assert.equal(legacy.risk, "high");
	assert.equal(legacy.inputsFrom.risk, "inferred");
	assert.match(legacy.reasons.join("; "), /retained from the task \(inferred, fleet_routing\)/);

	// `inferred: false` on a legacy record means somebody named it.
	assert.equal(
		composeImplementationRouting({
			task: { routing: { risk: "high", inferred: false }, source: "fleet_routing" },
		}).inputsFrom.risk,
		"explicit",
	);
});

test("scope and risk are inferred from a job's words when nobody supplied them", () => {
	// cp-rte (b): both defaulted to S/low, so unlabelled work routed as small.
	const bump = inferScopeAndRisk("Bump the version in package.json");
	assert.deepEqual(bump, { reasons: [] }, "a named small change infers nothing: the defaults are right");

	const refactor = inferScopeAndRisk("Refactor the auth module across all services");
	assert.equal(refactor.scope, "M", "structural wording is not small — and M lets a human say L");
	assert.match(refactor.reasons.join(" "), /scope M: the change is structural/);

	const migration = inferScopeAndRisk("Backfill the accounts table and drop the legacy column");
	assert.equal(migration.risk, "high");
	assert.match(migration.reasons.join(" "), /risk high: the task is destructive/);

	// Risk is about irreversibility, not size: a one-liner touching credentials
	// still routes as risky.
	assert.equal(inferScopeAndRisk("Fix the typo in the auth token comment").risk, "high");
	// And a plan-shaped task gets both.
	const both = inferScopeAndRisk("Plan the migration of the billing service to the new schema");
	assert.equal(both.scope, "M");
	assert.equal(both.risk, "high");
	assert.equal(both.reasons.length, 2);
});

test("risk inference skips locally negated verbs and ordinary authority prose (b-qbi.2)", () => {
	for (const text of [
		"Never force-push; open a PR",
		"Do not force-push the branch, open a PR",
		"Ship the patch without touching production",
		"Don't delete anything, just add a test",
		"The reviewer has authority to comment",
		"Credit the original author in the changelog",
	]) {
		assert.equal(inferScopeAndRisk(text).risk, undefined, text);
		assert.deepEqual(riskKeywords(text), [], text);
	}
});

test("risk inference: the self-review redaction sentence alone is not access work; bare `auth` is not a signal (cp-sr-s1-lkgo N4)", () => {
	const redaction = "Redact: never quote tokens, keys, cookies, auth headers or the contents of auth/models-store/daemon.json/dashboard.json/vapid.key — write [REDACTED].";
	assert.equal(inferScopeAndRisk(redaction).risk, undefined);
	assert.deepEqual(riskKeywords(redaction), []);
	// The tokens negation is unchanged, and real access work still routes high.
	assert.deepEqual(riskKeywords("Redact the logs, then quote tokens in the report"), ["tokens"]);
	for (const text of ["Rotate the auth tokens", "Fix the authn check", "Add authz to the viewer", "Authorize the deploy key", "Fix the authentication redirect"]) {
		assert.equal(inferScopeAndRisk(text).risk, "high", text);
	}
});

test("risk inference: affirmative credential, deletion, production billing and shared-history work stays high", () => {
	for (const [text, why] of [
		["Rotate the deploy credentials", /credentials or access/],
		["Delete the stale user rows", /destructive/],
		["Change production billing retries", /money/],
		["Rewrite shared history on the release branch", /rewrites shared history/],
		["Rewriting the git history to drop a secret file", /rewrites shared history/],
		["Fix the authentication redirect", /credentials or access/],
	] as const) {
		const out = inferScopeAndRisk(text);
		assert.equal(out.risk, "high", text);
		assert.match(out.riskReason ?? "", why, text);
	}
});

test("risk inference: a negated match followed by an affirmative one gates on the affirmative evidence", () => {
	const mixed = "Never force-push, but rewrite shared history on main to purge the leaked token";
	const out = inferScopeAndRisk(mixed);
	assert.equal(out.risk, "high");
	assert.deepEqual(riskKeywords(mixed), ["purge", "rewrite shared history", "token"]);
	const clause = "Do not force-push but delete the legacy table";
	assert.match(inferScopeAndRisk(clause).riskReason ?? "", /destructive/);
	assert.deepEqual(riskKeywords(clause), ["delete"], "the negated force-push is not evidence");
	assert.deepEqual(riskKeywords("never force-push; force-push the fix branch"), ["force-push"]);
});

test("risk inference: a negation governs only its own verb, not a risk word further on (b-qbi.6)", () => {
	for (const [text, word] of [
		["Deploy without tests to production", "production"],
		["Do not wait to purge the table", "purge"],
	] as const) {
		assert.equal(inferScopeAndRisk(text).risk, "high", text);
		assert.deepEqual(riskKeywords(text), [word], text);
	}
	for (const text of ["never force-push", "do not delete branches"]) {
		assert.equal(inferScopeAndRisk(text).risk, undefined, text);
		assert.deepEqual(riskKeywords(text), [], text);
	}
	for (const text of ["Fix authenticating the webhook", "Stop authorizing guests", "Rotate the tokens", "Tighten the repo permissions"]) {
		assert.equal(inferScopeAndRisk(text).risk, "high", text);
	}
});

test("findByShipId is the reverse lookup /cp-authorize's improved refusal relies on", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new PipelineStore(home.path);
	assert.equal(store.findByShipId("cp-nope-ship"), undefined, "no pipelines on disk yet");

	const at = isoTimestamp();
	store.write({
		schema_version: SCHEMA_VERSION,
		research_id: "cp-r1",
		ship_id: "cp-s1",
		project: "demo",
		delivery: "pr",
		state: "escalated",
		created_at: at,
		updated_at: at,
	});
	store.write({
		schema_version: SCHEMA_VERSION,
		research_id: "cp-r2",
		ship_id: "cp-s2",
		project: "demo",
		delivery: "pr",
		state: "researching",
		created_at: at,
		updated_at: at,
	});

	assert.equal(store.findByShipId("cp-s1")?.research_id, "cp-r1");
	assert.equal(store.findByShipId("cp-s2")?.research_id, "cp-r2");
	assert.equal(store.findByShipId("cp-unknown"), undefined);
});

test("the pipeline record is validated, and an unknown pipeline is a refusal", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new PipelineStore(home.path);
	assert.equal(store.get("cp-nope"), undefined);
	assert.throws(() => store.require("cp-nope"), PipelineError);

	const at = isoTimestamp();
	store.write({
		schema_version: SCHEMA_VERSION,
		research_id: "cp-r",
		ship_id: "cp-s",
		project: "demo",
		delivery: "pr",
		state: "researching",
		created_at: at,
		updated_at: at,
	});
	assert.equal(store.require("cp-r").ship_id, "cp-s");
	assert.equal(store.setState("cp-r", "gating").state, "gating");
	writeFileSync(store.file("cp-r"), "{invalid json");
	assert.throws(() => store.require("cp-r"), (error: Error) => error instanceof PipelineError && error.message.includes(store.file("cp-r")));
	assert.throws(
		() => store.write({ research_id: "cp-r" } as never),
		/violates the pipeline contract|invalid pipeline record/,
	);
});

// ---------------------------------------------------------------------------
// cp-diffgate-redo-hxb Stage D: the opt-in diff gate, between "the implementer
// reported" and "the pipeline is done".
//
// These run against `PipelineRunner` directly, with a stub reviewer that writes
// real `review-<n>.json` files: freshness is read from disk, so a stub that
// only returns values in memory would prove nothing about the replay path. The
// dependencies the diff gate must never reach (ledger, dispatcher, gate,
// artifacts, teardown) are proxies that throw on any access.
// ---------------------------------------------------------------------------

const NO_FLAGS: GateFlags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };

/** Any dependency this path must not touch. Touching it fails the test. */
function forbidden(name: string): never {
	return new Proxy(
		{},
		{
			get(_target, property) {
				throw new Error(`the diff gate reached ${name}.${String(property)} — it must not`);
			},
		},
	) as never;
}

/**
 * A `DiffReviewer` that decides from a queue and persists each decision exactly
 * where the orchestrator would (`state/runs/<ship-id>/review-<n>.json`), so the
 * pipeline's freshness and replay logic reads the same disk it reads in
 * production.
 */
class StubReviewer implements DiffReviewer {
	/** The ship branch's head "now"; `undefined` means it does not resolve. */
	head: string | undefined = `${"a".repeat(40)}`;
	readonly reviewed: string[] = [];
	readonly headCalls: string[] = [];
	readonly models: Array<string | undefined> = [];
	readonly #home: string;
	readonly #queue: Array<Partial<DiffVerdict>> = [];

	constructor(home: string) {
		this.#home = home;
	}

	queue(...verdicts: Array<Partial<DiffVerdict>>): void {
		this.#queue.push(...verdicts);
	}

	async headSha(jobId: string): Promise<string | undefined> {
		this.headCalls.push(jobId);
		return this.head;
	}

	async start(request: { jobId: string; model?: string; directive?: string }): Promise<DiffReviewOutcome> {
		const queued = this.#queue.shift();
		assert.ok(queued, `the stub reviewer was asked for an unscripted verdict on ${request.jobId}`);
		this.reviewed.push(request.jobId);
		this.models.push(request.model);
		let attempt = 1;
		while (existsSync(join(this.#home, paths.reviewFile(request.jobId, attempt)))) attempt += 1;
		const verdict: DiffVerdict = {
			schema_version: SCHEMA_VERSION,
			job_id: request.jobId,
			attempt,
			verdict: "pass",
			cause: null,
			flags: { ...NO_FLAGS },
			reasons: ["the diff matches the frozen scope"],
			model: request.model ?? "mock/reviewer",
			decided_at: isoTimestamp(),
			head_sha: this.head as string,
			diff_stat: { files: 2, truncated: false },
			...queued,
		};
		const path = join(this.#home, paths.reviewFile(request.jobId, attempt));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`);
		return { verdict, next: nextAction(verdict), path, ...(verdict.model ? { model: verdict.model } : {}) };
	}
}

/** The pipeline record and a runner over it, with only the diff gate wired. */
function diffGateBench(
	home: string,
	options: {
		shipId: string;
		researchId: string;
		review?: DiffReviewConfig;
		reviewer?: DiffReviewer;
		authorizer?: Authorizer;
		mandates?: MandateStore;
		taskImpact?: TaskImpact;
		shipPatch?: Record<string, unknown>;
	},
): PipelineRunner {
	const at = isoTimestamp();
	new PipelineStore(home).write({
		schema_version: SCHEMA_VERSION,
		research_id: options.researchId,
		ship_id: options.shipId,
		project: "demo",
		delivery: "pr",
		// Where a real pipeline is when its implementer reports.
		state: "implementing",
		created_at: at,
		updated_at: at,
		...(options.review ? { review: options.review } : {}),
		...(options.taskImpact ? { task_impact: options.taskImpact } : {}),
	});
	const shipJob = {
		job_id: options.shipId,
		project: "demo",
		kind: "ship",
		branch: options.shipId,
		phase: "held",
		reported_at: isoTimestamp(),
		...options.shipPatch,
	};
	return new PipelineRunner({
		home,
		fleet: { get: (jobId: string) => (jobId === options.shipId ? shipJob : undefined) },
		ledger: forbidden("ledger"),
		dispatcher: () => forbidden("dispatcher"),
		gate: () => forbidden("gate"),
		artifacts: forbidden("artifacts"),
		teardown: forbidden("teardown"),
		...(options.reviewer ? { review: () => options.reviewer as DiffReviewer } : {}),
		...(options.authorizer ? { authorizer: options.authorizer } : {}),
		...(options.mandates ? { mandates: options.mandates } : {}),
	} as unknown as PipelineOptions);
}

test("diff gate: an opted-in pipeline reaches done only once a review of the branch's CURRENT head resolves", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-dg-research";
	const shipId = "cp-dg-ship";
	const reviewer = new StubReviewer(home.path);
	const runner = diffGateBench(home.path, {
		researchId,
		shipId,
		review: { enabled: true, model: "mock/diff-reviewer" },
		reviewer,
	});

	// The ship job has reported: without the gate this advance would be `done`.
	reviewer.queue({ verdict: "revise", cause: null, revisions: ["drop the debug log"] });
	const revised = await runner.advance(researchId);
	assert.equal(revised.state, "implementing", "a revise is not done");
	assert.equal(revised.next, "wait", "the orchestrator's promote path owns a revise; advance waits");
	assert.equal(revised.review?.verdict.verdict, "revise");
	assert.equal(runner.store.require(researchId).state, "implementing");
	assert.deepEqual(reviewer.models, ["mock/diff-reviewer"], "the record's reviewer model override travels");

	// Same head, same verdict: nothing new to judge, so no second reviewer is
	// spent — and `done` is still out of reach.
	const idle = await runner.advance(researchId);
	assert.equal(idle.next, "wait");
	assert.equal(idle.state, "implementing");
	assert.equal(reviewer.reviewed.length, 1, "a fresh verdict is never re-reviewed");
	assert.equal(idle.review, undefined, "nothing new was decided");
	assert.match(idle.message, /replaying diff review attempt 1/);

	// The implementer pushed the fix: a new head is a new subject, so the
	// verdict on disk is stale and the gate reviews again. Freshness is the head
	// commit, not a file mtime.
	reviewer.head = "b".repeat(40);
	reviewer.queue({ verdict: "pass" });
	const done = await runner.advance(researchId);
	assert.equal(reviewer.reviewed.length, 2, "a moved head is a new subject");
	assert.equal(done.state, "done");
	assert.equal(done.next, "done");
	assert.equal(done.review?.verdict.verdict, "pass");
	assert.equal(done.review?.verdict.head_sha, "b".repeat(40));
	assert.equal(runner.store.require(researchId).state, "done");
	assert.match(done.message, /Diff review passed at bbbbbbbbbbbb/);
});

test("diff gate: a truncated pass on the current head is never replayed as done", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-dg-partial-research";
	const shipId = "cp-dg-partial-ship";
	const reviewer = new StubReviewer(home.path);
	const runner = diffGateBench(home.path, { researchId, shipId, review: { enabled: true }, reviewer });
	const partial: DiffVerdict = {
		schema_version: SCHEMA_VERSION,
		job_id: shipId,
		attempt: 1,
		verdict: "pass",
		cause: null,
		flags: { ...NO_FLAGS },
		reasons: ["scored from the visible hunks only"],
		decided_at: isoTimestamp(),
		head_sha: reviewer.head as string,
		diff_stat: { files: 2, truncated: true },
	};
	mkdirSync(join(home.path, LAYOUT.runs, shipId), { recursive: true });
	writeFileSync(join(home.path, paths.reviewFile(shipId, 1)), JSON.stringify(partial));

	reviewer.queue({ verdict: "escalate", cause: "policy", diff_stat: { files: 2, truncated: true } });
	const result = await runner.advance(researchId);
	assert.equal(reviewer.reviewed.length, 1, "the partial pass was not reused; the head was reviewed again");
	assert.notEqual(result.state, "done");
	assert.equal(result.next, "surface");
	assert.equal(runner.store.require(researchId).state === "done", false);

	// The policy stop replays: the next advance neither reviews again nor spends an attempt.
	const replay = await runner.advance(researchId);
	assert.equal(reviewer.reviewed.length, 1);
	assert.equal(replay.next, "surface");
	assert.notEqual(replay.state, "done");
});

test(`diff gate: ${REVIEW_MAX_ATTEMPTS} reviews on the branch is the end of the loop — advance surfaces instead of reviewing again`, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-dg-cap-research";
	const shipId = "cp-dg-cap-ship";
	const reviewer = new StubReviewer(home.path);
	const runner = diffGateBench(home.path, { researchId, shipId, review: { enabled: true }, reviewer });

	// The branch spent its whole budget, and the implementer has pushed again
	// since the last verdict — which is exactly the state that used to start
	// another round.
	mkdirSync(join(home.path, LAYOUT.runs, shipId), { recursive: true });
	for (let attempt = 1; attempt <= REVIEW_MAX_ATTEMPTS; attempt += 1) {
		const verdict: DiffVerdict = {
			schema_version: SCHEMA_VERSION,
			job_id: shipId,
			attempt,
			verdict: attempt === REVIEW_MAX_ATTEMPTS ? "escalate" : "revise",
			cause: attempt === REVIEW_MAX_ATTEMPTS ? "policy" : null,
			flags: { ...NO_FLAGS },
			reasons: [`attempt ${attempt}`],
			decided_at: isoTimestamp(),
			head_sha: "a".repeat(40),
			diff_stat: { files: 1, truncated: false },
		};
		writeFileSync(join(home.path, paths.reviewFile(shipId, attempt)), `${JSON.stringify(verdict)}\n`);
	}
	reviewer.head = "b".repeat(40);

	const surfaced = await runner.advance(researchId);
	assert.equal(reviewer.reviewed.length, 0, "a capped branch must never be reviewed again");
	assert.equal(surfaced.next, "surface");
	assert.equal(surfaced.state, "escalated");
	assert.notEqual(surfaced.state, "done", "the pipeline never reaches done on a capped review");
	assert.match(surfaced.message, new RegExp(`${REVIEW_MAX_ATTEMPTS} diff reviews have run`));
	assert.match(surfaced.message, /REVIEW_MAX_ATTEMPTS/);
	assert.match(surfaced.message, new RegExp(paths.reviewFile(shipId, REVIEW_MAX_ATTEMPTS)));
});

test("jje.3: past the cap, only the one operator-approved final fix head clears the review hold", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const [researchId, shipId, reviewer] = ["cp-dg-fix-research", "cp-dg-fix-ship", new StubReviewer(home.path)];
	const [prUrl, receipts] = ["https://github.com/o/r/pull/7", [{ kind: "pr", status: "open", url: "https://github.com/o/r/pull/7" }]];
	const runner = diffGateBench(home.path, { researchId, shipId, review: { enabled: true }, reviewer, shipPatch: { receipts } });
	mkdirSync(join(home.path, LAYOUT.runs, shipId), { recursive: true });
	const [capped, fixed, pushed] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
	for (let attempt = 1; attempt <= REVIEW_MAX_ATTEMPTS; attempt += 1) {
		const last = attempt === REVIEW_MAX_ATTEMPTS;
		const verdict: DiffVerdict = { schema_version: SCHEMA_VERSION, job_id: shipId, attempt, verdict: last ? "escalate" : "revise", cause: last ? "policy" : null,
			flags: { ...NO_FLAGS }, reasons: [`attempt ${attempt}`], model: "mock/reviewer", decided_at: isoTimestamp(), head_sha: capped, diff_stat: { files: 1, truncated: false } };
		writeFileSync(join(home.path, paths.reviewFile(shipId, attempt)), `${JSON.stringify(verdict)}\n`);
	}
	const store = new CheckpointStore(home.path, { kind: "final_fix" });
	store.request({ jobId: shipId, scope: capped.slice(0, 12), prUrl, question: "one final fix?" });
	reviewer.head = fixed;

	const pending = await runner.advance(researchId);
	assert.deepEqual([pending.next, /awaits a human/.test(pending.message)], ["surface", true], "no approval: the hold stands");

	store.decide(shipId, true, { by: "operator-quote", basis: { operator_quote: "one fix" }, scope: capped.slice(0, 12) });
	atomicWriteJson(join(home.path, finalFixFile(shipId)), {
		schema_version: SCHEMA_VERSION, job_id: shipId, capped_head: capped, pr_url: prUrl, checkpoint: `aw-checkpoint-${shipId}.final-fix-${capped.slice(0, 12)}`,
		decided_by: "operator-quote", promoted_at: isoTimestamp(), fix_generation: 1, fix_head: fixed, bound_at: isoTimestamp(),
	});
	reviewer.head = pushed;
	const moved = await runner.advance(researchId);
	assert.deepEqual([moved.state === "done", /is void/.test(moved.message)], [false, true], "a push after the fix report is never the approved head");

	const reset = readFinalFixRecord(home.path, shipId);
	atomicWriteJson(join(home.path, finalFixFile(shipId)), { ...reset, invalidated: undefined });
	reviewer.head = fixed;
	const done = await runner.advance(researchId);
	assert.equal(done.state, "done");
	assert.match(done.message, /operator-approved final fix at bbbbbbbbbbbb/);
	assert.equal(reviewer.reviewed.length, 0, "no sixth review is ever spent");
});

test("diff gate: opted in with nothing that can review holds short of done and names the fix", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	// (a) no reviewer wired into the runner at all.
	const unwired = diffGateBench(home.path, {
		researchId: "cp-dg-unwired-research",
		shipId: "cp-dg-unwired-ship",
		review: { enabled: true },
	});
	const held = await unwired.advance("cp-dg-unwired-research");
	assert.notEqual(held.state, "done", "an opt-in gate is never waved through");
	assert.equal(held.next, "wait");
	assert.match(held.message, /cp_review cp-dg-unwired-ship/);
	assert.equal(unwired.store.require("cp-dg-unwired-research").state, "implementing");

	// (b) the branch head does not resolve: never pushed, or an unreachable clone.
	const reviewer = new StubReviewer(home.path);
	reviewer.head = undefined;
	const unpushed = diffGateBench(home.path, {
		researchId: "cp-dg-unpushed-research",
		shipId: "cp-dg-unpushed-ship",
		review: { enabled: true },
		reviewer,
	});
	const unresolved = await unpushed.advance("cp-dg-unpushed-research");
	assert.notEqual(unresolved.state, "done");
	assert.equal(unresolved.next, "wait");
	assert.equal(reviewer.reviewed.length, 0, "there is nothing to review yet");
	assert.match(unresolved.message, /does not resolve in the canonical clone/);
});

test("diff gate: a flagged escalate asks a SECOND authorization, at its own path, and never touches the first", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-dg-flag-research";
	const shipId = "cp-dg-flag-ship";

	// The pre-implementation authorization, answered, exactly as the pipeline
	// left it before the implementer ran.
	const preImplementation = new CheckpointStore(home.path);
	preImplementation.request({ jobId: shipId, researchId, question: "Authorize implementation?", evidence: ["gate: pass (attempt 1)"] });
	preImplementation.decide(shipId, true, { by: "operator dialog", note: "ship the plan" });
	const shipFile = join(home.path, paths.checkpointFile(shipId));
	const before = readFileSync(shipFile, "utf8");

	const reviewer = new StubReviewer(home.path);
	const runner = diffGateBench(home.path, { researchId, shipId, review: { enabled: true }, reviewer });
	reviewer.queue({
		verdict: "escalate",
		cause: "flagged",
		flags: { ...NO_FLAGS, destructive_scope: true },
		reasons: ["the diff drops the legacy_accounts table"],
	});

	const flagged = await runner.advance(researchId);
	assert.equal(flagged.state, "awaiting_authorization");
	assert.equal(flagged.next, "authorize");
	assert.equal(flagged.checkpoint?.decision, "pending", "evidence is not authorization, here either");
	assert.notEqual(flagged.state, "done");

	// The second question is its own file, and the first one is byte-identical.
	const diffFile = join(home.path, paths.checkpointFile(shipId, "diff"));
	assert.notEqual(diffFile, shipFile);
	assert.ok(existsSync(diffFile), "the diff checkpoint is written at paths.checkpointFile(shipId, 'diff')");
	assert.equal(readFileSync(shipFile, "utf8"), before, "the pre-implementation checkpoint is untouched");
	assert.equal(preImplementation.get(shipId)?.decision, "approved");
	assert.equal(runner.diffCheckpoints.get(shipId)?.decision, "pending");

	// The flag and its reason travel into the question and the evidence; the diff
	// itself never does.
	const asked = JSON.parse(readFileSync(diffFile, "utf8")) as Record<string, unknown>;
	assert.equal(asked.job_id, shipId);
	assert.match(String(asked.question), /destructive_scope/);
	assert.ok((asked.evidence as string[]).some((item) => item.includes("the diff drops the legacy_accounts table")));
	assert.ok((asked.evidence as string[]).some((item) => item.includes("escalate (flagged")));

	// Advancing again re-asks nothing, reviews nothing, and still is not done.
	const still = await runner.advance(researchId);
	assert.equal(still.next, "authorize");
	assert.equal(still.checkpoint?.decision, "pending");
	assert.equal(reviewer.reviewed.length, 1);

	// A human answers the second question — and only then is done reachable.
	runner.diffCheckpoints.decide(shipId, true, { by: "operator command", note: "accepted the risk" });
	const done = await runner.advance(researchId);
	assert.equal(done.state, "done");
	assert.equal(done.next, "done");
	assert.equal(reviewer.reviewed.length, 1, "an authorized flagged verdict is not re-reviewed");
	assert.equal(readFileSync(shipFile, "utf8"), before, "and the first authorization is still untouched");
});

test("diff gate: a declined diff authorization is a stop, not a pause", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-dg-decline-research";
	const shipId = "cp-dg-decline-ship";
	const reviewer = new StubReviewer(home.path);
	const asked: string[] = [];
	const runner = diffGateBench(home.path, {
		researchId,
		shipId,
		review: { enabled: true },
		reviewer,
		authorizer: {
			async ask(checkpoint) {
				asked.push(checkpoint.job_id);
				return { approved: false, by: "test operator", note: "revert the deletion first" };
			},
		},
	});
	// A flag that still vetoes (cp-unknowns-no-veto: `blocking_unknowns` no
	// longer produces this verdict, so a fixture must not pretend it does).
	reviewer.queue({
		verdict: "escalate",
		cause: "flagged",
		flags: { ...NO_FLAGS, destructive_scope: true },
		reasons: ["the change deletes the migration it replaces"],
	});

	const declined = await runner.advance(researchId);
	assert.deepEqual(asked, [shipId], "the authorizer was asked once, about the diff");
	assert.equal(declined.state, "awaiting_authorization");
	assert.equal(declined.next, "surface");
	assert.equal(declined.checkpoint?.decision, "declined");
	assert.match(declined.message, /declined: revert the deletion first/);

	// Final: advancing again neither re-asks nor reaches done.
	const again = await runner.advance(researchId);
	assert.equal(again.next, "surface");
	assert.notEqual(again.state, "done");
	assert.deepEqual(asked, [shipId], "a decided checkpoint is never re-asked");
});

test("diff gate: the ladder is nextAction's, verbatim — policy surfaces, operational retries, persistent stops", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	// The policy branch: the orchestrator's own judgment (or a stat overflow).
	const policyRunner = diffGateBench(home.path, {
		researchId: "cp-dg-policy-research",
		shipId: "cp-dg-policy-ship",
		review: { enabled: true },
		reviewer: (() => {
			const stub = new StubReviewer(home.path);
			stub.queue({ verdict: "escalate", cause: "policy", reasons: ["the diff spans 41 files, over the review cap"] });
			return stub;
		})(),
	});
	const surfaced = await policyRunner.advance("cp-dg-policy-research");
	assert.equal(surfaced.state, "escalated");
	assert.equal(surfaced.next, "surface");
	assert.equal(policyRunner.diffCheckpoints.get("cp-dg-policy-ship"), undefined, "a policy escalate never reaches a checkpoint");
	assert.match(surfaced.message, /over the review cap/);

	// The operational branch: a reviewer fault is not a judgment about the diff,
	// so a *fresh* one is still not something anyone may ship on — it is retried
	// on the next advance, and a repeat becomes persistent and stops.
	const reviewer = new StubReviewer(home.path);
	const runner = diffGateBench(home.path, {
		researchId: "cp-dg-op-research",
		shipId: "cp-dg-op-ship",
		review: { enabled: true },
		reviewer,
	});
	reviewer.queue(
		{ verdict: "escalate", cause: "operational", reasons: ["the reviewer never filed a verdict"] },
		{ verdict: "escalate", cause: "operational_persistent", reasons: ["two reviewers in a row failed to file"] },
	);
	const operational = await runner.advance("cp-dg-op-research");
	assert.equal(operational.next, "wait");
	assert.notEqual(operational.state, "done");
	assert.match(operational.message, /uses a different model/);

	const retried = await runner.advance("cp-dg-op-research");
	assert.equal(reviewer.reviewed.length, 2, "an operational fault at the same head is retried, not replayed");
	assert.equal(retried.state, "escalated");
	assert.equal(retried.next, "surface");
	assert.notEqual(retried.state, "done");

	// And the ladder itself is imported, never restated here.
	const source = readFileSync(join(REPO_ROOT, "src/pipeline.ts"), "utf8");
	const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*"\.\/gate\.ts";/.exec(source);
	assert.ok(importBlock, "src/pipeline.ts must import its verdict ladder from ./gate.ts");
	assert.match(importBlock[1] as string, /\bnextAction\b/);
	assert.doesNotMatch(source, /function nextAction\b/, "nextAction must not be re-declared in src/pipeline.ts");
});

test("diff gate: `review` absent or false behaves EXACTLY as it did before the gate existed", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	for (const [name, review] of [
		["absent", undefined],
		["false", { enabled: false }],
	] as Array<[string, DiffReviewConfig | undefined]>) {
		const researchId = `cp-dg-off-${name}-research`;
		const shipId = `cp-dg-off-${name}-ship`;
		// A reviewer IS wired: the opt-in, not the wiring, is what decides.
		const reviewer = new StubReviewer(home.path);
		const runner = diffGateBench(home.path, {
			researchId,
			shipId,
			...(review ? { review } : {}),
			reviewer,
		});

		const done = await runner.advance(researchId);
		assert.equal(done.state, "done", `review ${name}: the implementer reported, so the pipeline is done`);
		assert.equal(done.next, "done");
		assert.equal(
			done.message,
			`${shipId}: implementer reported; the pipeline is done.`,
			`review ${name}: the message is the historical one, verbatim`,
		);
		assert.equal(done.review, undefined);
		assert.equal(done.checkpoint, undefined);
		assert.equal(runner.store.require(researchId).state, "done");
		assert.deepEqual(reviewer.reviewed, [], `review ${name}: no review is run`);
		assert.deepEqual(reviewer.headCalls, [], `review ${name}: the branch head is not even resolved`);
		assert.equal(existsSync(join(home.path, paths.checkpointFile(shipId, "diff"))), false);
	}
});


// ---------------------------------------------------------------------------
// cp-routing-provenance: the planner's measurements reach dispatch as `assessed`
// ---------------------------------------------------------------------------

/**
 * The real handoff, with only the outside world stubbed: a gate verdict and a
 * research envelope already on disk, a real `ArtifactStore`, the runner's own
 * `CheckpointStore`, and a dispatcher that records the call instead of spawning.
 *
 * Everything between them is production code — `advance` walks its own ladder,
 * `#authorize` mints the checkpoint and its evidence, `#dispatchImplementer`
 * frames the task file and calls the dispatcher. Nothing here re-implements
 * `composeImplementationRouting`, `frameImplementerTask` or the evidence
 * wording: they are observed through the boundary they actually cross.
 */
function handoffBench(
	home: string,
	options: {
		researchId: string;
		shipId: string;
		assessment?: Record<string, unknown>;
		/** routing T2: the task impact frozen on the pipeline record at start. */
		taskImpact?: TaskImpact;
		/** A legacy record's fallback: the research dispatch's own persisted routing. */
		researchRouting?: JobRouting;
		/** The other fallback: the frozen original task on disk (do8.3). */
		originalTask?: string;
		/** The ship job as the fleet sees it, for the recovery path. */
		shipJob?: Record<string, unknown>;
		mandates?: MandateStore;
		escalations?: EscalationStore;
		planSummary?: Record<string, unknown>;
		decisionSummary?: { would_make_wrong: string; verified: string };
		gateStarts?: string[];
		sent?: string[];
		/** Extra fields on the fake dispatch result (H6: `risk_warning`). */
		dispatchExtra?: Record<string, unknown>;
		/** Override the replayed gate verdict — a flagged escalate, e.g. */
		gateVerdict?: Partial<GateVerdict>;
	},
): { runner: PipelineRunner; calls: Array<Record<string, unknown>>; store: PipelineStore; riskLabels: Array<{ jobId: string; added: string[]; removed: string[] }> } {
	const { researchId, shipId } = options;
	const at = isoTimestamp();
	const store = new PipelineStore(home);
	store.write({
		schema_version: SCHEMA_VERSION,
		research_id: researchId,
		ship_id: shipId,
		project: "demo",
		delivery: "pr",
		state: "gating",
		created_at: at,
		updated_at: at,
		...(options.taskImpact ? { task_impact: options.taskImpact } : {}),
	});
	// The plan the implementer is meant to receive, in the store it really lives in.
	const artifacts = new ArtifactStore({ home });
	mkdirSync(dirname(artifacts.file(researchId)), { recursive: true });
	writeFileSync(artifacts.file(researchId), "# Plan\n\nI did not implement anything; this run was read-only.\n");
	// A gate verdict already decided: `advance` replays it rather than gating again.
	const verdict: GateVerdict = {
		schema_version: SCHEMA_VERSION,
		job_id: researchId,
		attempt: 1,
		verdict: "pass",
		cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["the plan names its files and its checks"],
		model: "mock/gate",
		decided_at: at,
		...(options.decisionSummary ? { decision_summary: options.decisionSummary } : {}),
		...(options.gateVerdict ?? {}),
	};
	mkdirSync(join(home, paths.runDir(researchId)), { recursive: true });
	writeFileSync(join(home, paths.gateFile(researchId, 1)), JSON.stringify(verdict));
	// The planner's envelope: this is where `self_assessment` actually comes from.
	if (options.assessment || options.planSummary) {
		writeFileSync(
			join(home, paths.envelopeFile(researchId)),
			JSON.stringify({
				envelope: {
					...(options.assessment ? { self_assessment: options.assessment } : {}),
					...(options.planSummary ? { plan_summary: options.planSummary } : {}),
				},
			}),
		);
	}
	if (options.originalTask !== undefined) {
		writeFileSync(join(home, paths.originalTaskFile(researchId)), options.originalTask);
	}
	const researchJob = {
		job_id: researchId,
		project: "demo",
		kind: "research",
		branch: researchId,
		phase: "held",
		reported_at: at,
		...(options.researchRouting ? { routing: options.researchRouting } : {}),
	};
	/** riskkw: every `risk:` label write the handoff made, in order. */
	const riskLabels: Array<{ jobId: string; added: string[]; removed: string[] }> = [];
	const calls: Array<Record<string, unknown>> = [];
	const runner = new PipelineRunner({
		home,
		artifacts,
		fleet: {
			get: (jobId: string) =>
				jobId === researchId ? researchJob : jobId === shipId ? options.shipJob : undefined,
		},
		ledger: {
			show: async (jobId: string) => ({ id: jobId, title: `title of ${jobId}`, description: `the frozen task of ${jobId}`, status: "open" }),
			close: async () => undefined,
			addDep: async () => undefined,
			removeDep: async () => undefined,
			retargetDeps: async () => undefined,
			update: async (jobId: string, patch: { addLabels?: string[]; removeLabels?: string[] }) => (riskLabels.push({ jobId, added: patch.addLabels ?? [], removed: patch.removeLabels ?? [] }), { id: jobId, labels: patch.addLabels ?? [], status: "open" }),
		},
		teardown: { teardown: async () => ({ job_id: researchId, torn_down: true }) },
		gate: () =>
			options.gateStarts
				? {
						start: async () => {
							options.gateStarts?.push(researchId);
							return { next: "wait", surface: "gate", attempt: 2, deadline: isoTimestamp(), model: "mock/gate", key: "k" };
						},
					}
				: forbidden("gate"),
		...(options.sent
			? { send: async (_id: string, message: string) => (options.sent?.push(message), { receipt: "delivered" as const }) }
			: {}),
		dispatcher: () => ({
			dispatch: async (request: Record<string, unknown>) => {
				calls.push(request);
				return { job_id: shipId, worker: shipId, worktree: "/pool/1/demo", branch: shipId, state: "dispatched", receipt: "accepted", model: "mock/impl", ...options.dispatchExtra };
			},
		}),
		...(options.mandates ? { mandates: options.mandates } : {}),
		...(options.escalations ? { escalations: options.escalations } : {}),
	} as unknown as PipelineOptions);
	return { runner, calls, store, riskLabels };
}

/** Authorize and run the handoff; returns the one dispatch call it produced. */
async function handOff(
	runner: PipelineRunner,
	calls: Array<Record<string, unknown>>,
	ids: { researchId: string; shipId: string },
): Promise<{ scope?: Scope; risk?: Risk; inputsFrom?: { scope?: string; risk?: string } }> {
	await runner.advance(ids.researchId);
	assert.deepEqual(calls, [], "a passed gate is not authorization: nothing is dispatched before the answer");
	runner.checkpoints.decide(ids.shipId, true, { by: "operator" });
	await runner.advance(ids.researchId);
	assert.equal(calls.length, 1, "exactly one implementer dispatch");
	return calls[0] as never;
}

test("cp-routing-provenance: the planner's measurement crosses the pipeline handoff as `assessed`", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-handoff-research";
	const shipId = "cp-handoff-ship";
	const { runner, calls } = handoffBench(home.path, {
		researchId,
		shipId,
		// Measured scope, and `destructive_scope` — which the composition reads as
		// risk high. Both are the planner's own words, not an operator's.
		assessment: { scope: "M", confidence: "high", destructive_scope: true, blocking_unknowns: false },
	});

	// 1. The gate passed, so `advance` mints the checkpoint. Its evidence is
	//    generated wording that must say the routing inputs came from the plan.
	const asked = await runner.advance(researchId);
	assert.equal(asked.next, "authorize", "a passed gate asks a human; it never dispatches");
	assert.deepEqual(calls, [], "nothing is dispatched before the checkpoint is answered");
	const evidence = (asked.checkpoint?.evidence ?? []).join("\n");
	assert.match(evidence, /planner: scope M, confidence high, destructive/);
	assert.match(evidence, /-> routing as scope M \/ risk high/);

	// 2. Authorized: the handoff runs for real.
	runner.checkpoints.decide(shipId, true, { by: "operator" });
	const dispatched = await runner.advance(researchId);
	assert.equal(dispatched.next, "wait");
	assert.equal(calls.length, 1, "exactly one implementer dispatch");
	const call = calls[0] as unknown as {
		jobId: string;
		taskFile: string;
		scope?: string;
		risk?: string;
		inputsFrom?: { scope?: string; risk?: string };
	};
	assert.equal(call.jobId, shipId);
	// The point of the regression: the planner's axes travel WITH the label that
	// says a planner measured them. Without `inputsFrom`, dispatch would record
	// them as `explicit` — an operator's instruction nobody gave. routing T2 made
	// that label per-axis, because the two axes can now come from two sources.
	assert.deepEqual(call.inputsFrom, { scope: "assessed", risk: "assessed" });
	assert.equal(call.scope, "M");
	assert.equal(call.risk, "high");
	// And the brief the implementer actually reads is the framed specification,
	// handed over by path — the same file the dispatch call names.
	assert.equal(call.taskFile, join(home.path, paths.taskFile(shipId)));
	const framed = readFileSync(call.taskFile, "utf8");
	assert.match(framed, new RegExp(`Specification from ${researchId}`));
	assert.match(framed, new RegExp(`## Your scope for ${shipId}`));
	assert.ok(framed.includes("the frozen task of " + shipId), "the ship job's own description is the frozen scope");
	assert.ok(framed.includes("this run was read-only"), "the plan's body reaches the file unmodified");
});

test("cp-routing-provenance: an axis the planner never measured is not passed off as measured", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-handoff-noscope";
	const shipId = "cp-handoff-noscope-ship";
	const { runner, calls } = handoffBench(home.path, {
		researchId,
		shipId,
		// No `scope` in the assessment: the planner measured risk only.
		assessment: { confidence: "high", destructive_scope: false, blocking_unknowns: false },
	});

	const asked = await runner.advance(researchId);
	// The generated evidence says so rather than printing a default nobody chose:
	// dispatch assesses the missing axis from the task on its own. routing T2: the
	// risk axis is in that position too now — a confident planner is not evidence
	// that the work is low risk, so nothing is emitted and the task's words decide.
	assert.match(
		(asked.checkpoint?.evidence ?? []).join("\n"),
		/-> routing as scope \(inferred at dispatch\) \/ risk \(inferred at dispatch\)/,
	);

	runner.checkpoints.decide(shipId, true, { by: "operator" });
	await runner.advance(researchId);
	const call = calls[0] as unknown as { scope?: string; risk?: string; inputsFrom?: { scope?: string; risk?: string } };
	assert.equal(call.scope, undefined, "an unmeasured axis is left for dispatch to assess, not defaulted here");
	assert.equal(call.risk, undefined, "and so is risk: the pipeline never emits a confident low");
	assert.deepEqual(call.inputsFrom, {}, "no axis was supplied, so no axis is labelled");
});

// ---------------------------------------------------------------------------
// routing T2: known task impact survives the handoff, recovery and reanchor
// ---------------------------------------------------------------------------

/** The tracker's reproduction: production credential work, confident planner. */
const CONFIDENT = { scope: "M", confidence: "high", destructive_scope: false, blocking_unknowns: false };

test("routing T2: a high-risk pipeline still hands the implementer risk high", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ids = { researchId: "cp-t2-known", shipId: "cp-t2-known-ship" };
	const { runner, calls } = handoffBench(home.path, {
		...ids,
		// What `cp_pipeline start` froze: the operator said high, on production auth work.
		taskImpact: taskImpactFrom({ text: "Rotate the production auth credentials", risk: "high" }),
		assessment: CONFIDENT,
	});

	// The checkpoint evidence describes the assessment implementation will get,
	// not the planner's half of it.
	const asked = await runner.advance(ids.researchId);
	const evidence = (asked.checkpoint?.evidence ?? []).join("\n");
	assert.match(evidence, /-> routing as scope M \/ risk high/);
	assert.match(evidence, /routing: risk high retained from the task \(explicit, start\)/);

	runner.checkpoints.decide(ids.shipId, true, { by: "operator" });
	await runner.advance(ids.researchId);
	const call = calls[0] as unknown as { risk?: string; scope?: string; inputsFrom?: { risk?: string } };
	assert.equal(call.risk, "high", "a confident, non-destructive plan does not make production credentials safe");
	assert.equal(call.scope, "M", "the planner's own measurement still wins its own axis");
	assert.equal(call.inputsFrom?.risk, "explicit", "and the retained axis keeps the provenance it was recorded with");
});

// H6: the observed case \u2014 a pipeline started risk low, a planner that said nothing destructive.
test("H6: an explicit-low pipeline hands the implementer a recorded low (the gate warns, routing still infers); an assessed high does not", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ids = { researchId: "cp-h6-low", shipId: "cp-h6-low-ship" };
	const warning = `${ids.shipId}: warning: risk:high inferred from keywords only (delete)`;
	const { runner, calls } = handoffBench(home.path, {
		...ids,
		taskImpact: taskImpactFrom({ text: "Delete the stale fixture", risk: "low" }),
		assessment: CONFIDENT,
		dispatchExtra: { risk_warning: warning },
	});
	await runner.advance(ids.researchId);
	runner.checkpoints.decide(ids.shipId, true, { by: "operator" });
	const dispatched = await runner.advance(ids.researchId);
	const call = calls[0] as { risk?: string; recordedRisk?: Record<string, unknown> };
	assert.equal(call.risk, undefined, "routing is untouched: dispatch still infers from the task's words");
	assert.deepEqual(call.recordedRisk, { risk: "low", from: "pipeline", provenance: "explicit" }, "the operator's low reaches the gate, named as the pipeline's own");
	assert.ok(dispatched.message.includes(warning), "the advance result carries the dispatch's warning");

	// A planner-only low (no start risk) is recorded too, and named as the planner's
	// own assessment; an assessed high never is.
	assert.deepEqual(
		composeImplementationRouting({ assessment: CONFIDENT as SelfAssessment }).recordedRisk,
		{ risk: "low", from: "planner", provenance: "assessed" },
	);
	const destructive = composeImplementationRouting({
		task: taskImpactFrom({ text: "Delete the stale fixture", risk: "low" }),
		assessment: { ...(CONFIDENT as SelfAssessment), destructive_scope: true },
	});
	assert.equal(destructive.risk, "high");
	assert.equal(destructive.recordedRisk, undefined, "a planner-assessed high gates");
	assert.equal(
		composeImplementationRouting({ task: taskImpactFrom({ text: "Tidy the list", risk: "high" }), assessment: CONFIDENT as SelfAssessment }).recordedRisk,
		undefined,
		"an explicit high at start gates",
	);
});

// riskkw (cp-yxgl review): the gate reviewer's own flags for the plan it passed are escalating
// evidence exactly like the planner's, so a flagged plan sets risk high and suppresses the low.
test("riskkw: the gate's flags set the implementer's risk high and suppress the recorded low", () => {
	const start = taskImpactFrom({ text: "Give research workers web tools" });
	const clean = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
	assert.equal(composeImplementationRouting({ task: start, flags: clean }).risk, undefined, "a clean gate adds nothing");
	const destructive = composeImplementationRouting({
		task: taskImpactFrom({ text: "Give research workers web tools", risk: "low" }),
		assessment: CONFIDENT as SelfAssessment,
		flags: { ...clean, destructive_scope: true },
	});
	assert.equal(destructive.risk, "high", "the gate's destructive scope gates under a confident planner and an explicit low at start");
	assert.equal(destructive.inputsFrom.risk, "assessed");
	assert.equal(destructive.recordedRisk, undefined, "and nothing recorded low survives against it");
	assert.match(destructive.reasons.join("; "), /risk high: the gate flags destructive scope/);
	const unknown = composeImplementationRouting({ task: start, assessment: CONFIDENT as SelfAssessment, flags: { ...clean, blocking_unknowns: true } });
	assert.equal(unknown.risk, "high", "the gate's blocking unknowns escalates over a confident, non-destructive plan");
	assert.equal(unknown.recordedRisk, undefined);
	assert.match(unknown.reasons.join("; "), /risk high: the gate flags blocking unknowns/);
	// The planner's own half keeps its own wording, and a gate with no flags never adds one.
	assert.match(
		composeImplementationRouting({ assessment: { ...(CONFIDENT as SelfAssessment), destructive_scope: true }, flags: clean }).reasons.join("; "),
		/risk high: the planner reports destructive scope/,
	);
});

// riskkw: the cp-yxgl review — the implementer's gate risk is the planner's
// assessment, never the start-time default, and the planner's own half is named.
test("riskkw: a planner-assessed high gates on a pipeline started with no risk; a planner-assessed low is the planner's record", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	// Nobody named a risk at start, so `task_impact` froze a `defaulted` low — and
	// the planner assessed high. The implementer dispatch gates with risk high.
	const unnamed = { researchId: "cp-rk-unnamed", shipId: "cp-rk-unnamed-ship" };
	const first = handoffBench(home.path, {
		...unnamed,
		taskImpact: taskImpactFrom({ text: "Give research workers web tools" }),
		assessment: { ...(CONFIDENT as SelfAssessment), destructive_scope: true },
	});
	const assessed = await handOff(first.runner, first.calls, unnamed);
	assert.equal(assessed.risk, "high", "the planner's assessment is the gate's risk, not the defaulted start");
	assert.equal(assessed.inputsFrom?.risk, "assessed");
	assert.equal(first.calls[0]?.recordedRisk, undefined, "a planner-assessed high leaves the gate nothing to warn against");
	assert.deepEqual(first.riskLabels, [{ jobId: unnamed.shipId, added: ["risk:high"], removed: [] }], "the assessed high is recorded on the ledger, so a later promotion reads it");

	// Started with an explicit low and the planner assessing high: the higher wins.
	const explicit = { researchId: "cp-rk-explicit", shipId: "cp-rk-explicit-ship" };
	const second = handoffBench(home.path, {
		...explicit,
		taskImpact: taskImpactFrom({ text: "Give research workers web tools", risk: "low" }),
		assessment: { ...(CONFIDENT as SelfAssessment), blocking_unknowns: true },
	});
	const raised = await handOff(second.runner, second.calls, explicit);
	assert.equal(raised.risk, "high", "an explicit low at start never lowers the planner's assessed high");
	assert.equal(second.calls[0]?.recordedRisk, undefined);
	assert.deepEqual(second.riskLabels, [{ jobId: explicit.shipId, added: ["risk:high"], removed: [] }]);

	// Started with no risk and a planner that assessed the plan as certain and
	// non-destructive: that low is the planner's own record (the only one the gate
	// may warn about), never a `defaulted` axis standing in for it.
	const quiet = { researchId: "cp-rk-quiet", shipId: "cp-rk-quiet-ship" };
	const third = handoffBench(home.path, {
		...quiet,
		taskImpact: taskImpactFrom({ text: "Give research workers web tools" }),
		assessment: CONFIDENT,
	});
	const low = await handOff(third.runner, third.calls, quiet);
	assert.equal(low.risk, undefined, "routing still infers from the ship job's own words");
	assert.deepEqual(third.calls[0]?.recordedRisk, { risk: "low", from: "planner", provenance: "assessed" });
	assert.deepEqual(third.riskLabels, [], "a planner-assessed low is no label: only an assessed high is written");

	// A `defaulted` start with no assessment at all records nothing.
	assert.equal(composeImplementationRouting({ task: taskImpactFrom({ text: "Give research workers web tools" }) }).recordedRisk, undefined);
});

test("routing T2: a legacy record recovers the impact from the facts that do exist", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	// (a) No `task_impact` (written before it existed), but the research dispatch's
	//     own routing is on the fleet record. That IS the effective input it was
	//     given, provenance included, so it is reused rather than re-derived.
	const fleetIds = { researchId: "cp-t2-legacy-fleet", shipId: "cp-t2-legacy-fleet-ship" };
	const fleetBench = handoffBench(home.path, {
		...fleetIds,
		researchRouting: { scope: "M", risk: "high", inferred: true, provenance: { scope: "inferred", risk: "inferred" } },
		assessment: CONFIDENT,
	});
	const fromFleet = await handOff(fleetBench.runner, fleetBench.calls, fleetIds);
	assert.equal(fromFleet.risk, "high");
	assert.equal(fromFleet.inputsFrom?.risk, "inferred");

	// (b) Neither of those, but the frozen original task (do8.3) is on disk. Its
	//     words are re-assessed — never the planner's rewritten Goal.
	const frozenIds = { researchId: "cp-t2-legacy-task", shipId: "cp-t2-legacy-task-ship" };
	const frozenBench = handoffBench(home.path, {
		...frozenIds,
		originalTask: "Reconcile the billing refund ledger.",
		assessment: CONFIDENT,
	});
	const fromFrozen = await handOff(frozenBench.runner, frozenBench.calls, frozenIds);
	assert.equal(fromFrozen.risk, "high", "money wording in the frozen task is evidence the planner cannot erase");
	assert.equal(fromFrozen.inputsFrom?.risk, "inferred");

	// (c) Nothing recorded at all. That is an ABSENT assessment, not a low-risk
	//     one: no axis is emitted, so dispatch assesses the ship job's own words.
	const bareIds = { researchId: "cp-t2-legacy-bare", shipId: "cp-t2-legacy-bare-ship" };
	const bareBench = handoffBench(home.path, { ...bareIds, assessment: CONFIDENT });
	const fromNothing = await handOff(bareBench.runner, bareBench.calls, bareIds);
	assert.equal(fromNothing.risk, undefined);
	assert.equal(fromNothing.scope, "M", "the planner's measurement is still used where it exists");
});

test("routing T2: a frozen task that exists and cannot be read refuses, it does not route low", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ids = { researchId: "cp-t2-unreadable", shipId: "cp-t2-unreadable-ship" };
	const { runner } = handoffBench(home.path, { ...ids, originalTask: "Rotate production credentials", assessment: CONFIDENT });
	// A directory where the file should be is the portable "exists, unreadable":
	// `chmod 000` is a no-op for root, and this runs as whoever ran the suite.
	const frozen = join(home.path, paths.originalTaskFile(ids.researchId));
	rmSync(frozen);
	mkdirSync(frozen);

	await assert.rejects(() => runner.advance(ids.researchId), (error: Error) => {
		assert.ok(error instanceof PipelineError);
		assert.match(error.message, /exists but cannot be read/);
		assert.match(error.message, /an unreadable task is not a low-risk one/);
		return true;
	});
});

test("routing T2: recovery re-dispatches with the same retained impact", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ids = { researchId: "cp-t2-recover", shipId: "cp-t2-recover-ship" };
	const { runner, calls } = handoffBench(home.path, {
		...ids,
		taskImpact: taskImpactFrom({ text: "Migrate the production payments schema" }),
		assessment: CONFIDENT,
		shipJob: { job_id: ids.shipId, project: "demo", kind: "ship", branch: ids.shipId, phase: "failed" },
	});
	// One observed failure on the implementer's run log is what `recoverShip` reads.
	mkdirSync(join(home.path, paths.runDir(ids.shipId)), { recursive: true });
	writeFileSync(
		join(home.path, paths.eventsFile(ids.shipId)),
		`${JSON.stringify({
			ts: isoTimestamp(),
			source: "cp",
			type: "failure",
			payload: { class: "crash", message: "worker died", at: isoTimestamp() },
		})}\n`,
	);

	const recovered = await runner.recoverShip(ids.researchId);
	assert.equal(recovered.next, "wait");
	const call = calls[0] as unknown as { risk?: string; inputsFrom?: { risk?: string } };
	assert.equal(call.risk, "high", "a re-dispatch from the same task file carries the same known impact");
	assert.equal(call.inputsFrom?.risk, "inferred");
});

test("routing T2: reanchor keeps the ship job's impact and re-gates the new plan", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ids = { researchId: "cp-t2-anchor", shipId: "cp-t2-anchor-ship" };
	const impact = taskImpactFrom({ text: "Replace the production access-control checks", scope: "L" });
	const { runner, store } = handoffBench(home.path, { ...ids, taskImpact: impact });

	const replacement = await runner.reanchor(ids.researchId, "cp-t2-anchor-2");
	// The ship job did not change, so what its task is known to touch did not either.
	assert.deepEqual(replacement.task_impact, impact);
	assert.equal(replacement.ship_id, ids.shipId);
	assert.equal(store.require(ids.researchId).superseded_by, "cp-t2-anchor-2");
	// And it is a fresh record: no gate history, so the new plan is judged anew.
	assert.equal(replacement.state, "researching");
});

test("pipeline: reanchor stays refused after a declined checkpoint — start a new pipeline (pi-command-post-toq)", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ids = { researchId: "cp-toq-old", shipId: "cp-toq-ship" };
	const { runner } = handoffBench(home.path, ids);

	// start (record + pass verdict on disk) -> advance -> awaiting_authorization (pending)
	const pending = await runner.advance(ids.researchId);
	assert.equal(pending.state, "awaiting_authorization");
	assert.equal(pending.next, "authorize");
	assert.equal(pending.checkpoint?.decision, "pending");

	await assert.rejects(
		() => runner.reanchor(ids.researchId, "cp-toq-new"),
		(error: Error) => {
			assert.ok(error instanceof PipelineError);
			assert.match(error.message, /human decision is pending/);
			assert.match(error.message, /does not unlock reanchor/);
			assert.doesNotMatch(error.message, /Decline the checkpoint/);
			return true;
		},
	);

	// Observed sequence: decide declined -> advance stays awaiting_authorization -> reanchor still refused.
	runner.checkpoints.decide(ids.shipId, false, { by: "operator" });
	const declined = await runner.advance(ids.researchId);
	assert.equal(declined.state, "awaiting_authorization");
	assert.equal(declined.next, "surface");
	assert.equal(declined.checkpoint?.decision, "declined");

	await assert.rejects(
		() => runner.reanchor(ids.researchId, "cp-toq-new"),
		(error: Error) => {
			assert.ok(error instanceof PipelineError);
			assert.match(error.message, /checkpoint was declined/);
			assert.match(error.message, /cp_pipeline start/);
			assert.doesNotMatch(error.message, /Decline the checkpoint/);
			return true;
		},
	);
});

test("mandate: an active grant auto-decides the ship checkpoint and dispatches", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path);
	const grant = mandates.issue({
		projects: ["demo"],
		objective: "ship the handoff",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 10,
	});
	const researchId = "cp-md-research";
	const shipId = "cp-md-ship";
	const { runner, calls } = handoffBench(home.path, { researchId, shipId, mandates });
	const advanced = await runner.advance(researchId);
	assert.equal(advanced.state, "implementing");
	assert.equal(advanced.next, "wait");
	assert.equal(calls.length, 1, "implementer dispatched without /cp-authorize");
	const checkpoint = runner.checkpoints.get(shipId);
	assert.equal(checkpoint?.decision, "approved");
	assert.equal(checkpoint?.decided_by, `mandate:${grant.id}`);
	assert.match(checkpoint?.note ?? "", /allowed_actions includes implement/);
	assert.match(mandates.show(grant.id), /cp-md-ship/);
	assert.equal(
		new ReviewApprovalStore(home.path).matches(researchId, join(home.path, paths.artifactFile(researchId))),
		true,
		"the approval is pinned to the artifact hash",
	);
});

test("tv8: plan escalation metadata belongs to the selected ship grant, never unrelated askers", async (t) => {
	for (const asks of [true, false]) {
		const home = createScratchHome(); t.after(() => home.cleanup());
		const mandates = new MandateStore(home.path);
		const researchId = "cp-selected-research"; const shipId = "cp-selected-ship";
		const base = { projects: ["demo"], objective: "handoff", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 50, tokens: 1_000_000 }, job_cap: 10 };
		mandates.issue({ ...base, job_ids: [researchId], ask_on: ["plan_approval"] });
		mandates.issue({ ...base, projects: ["other"], ask_on: ["plan_approval"] });
		mandates.issue({ ...base, at: isoTimestamp(new Date(Date.now() - 60_000)), ask_on: ["plan_approval"] });
		const selected = mandates.issue({ ...base, job_ids: [shipId], ask_on: asks ? ["plan_approval"] : [], allowed_actions: asks ? ["implement"] : ["review"] });
		const escalations = new EscalationStore({ home: home.path });
		const { runner, calls } = handoffBench(home.path, { researchId, shipId, mandates, escalations });
		const result = await runner.advance(researchId);
		assert.equal(result.next, "authorize"); assert.deepEqual(calls, []);
		const row = escalations.open()[0]!;
		assert.equal(row.mandate_id, asks ? selected.id : "no mandate", "a selected action denial does not borrow a nonselected plan asker");
		if (asks) assert.equal(row.mandate_clause, `${selected.id}: ask_on includes plan_approval`);
	}
});

test("mandate: a gate flag blocks auto-approval and raises one plan-approval escalation", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the handoff",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 10,
	});
	const escalations = new EscalationStore({ home: home.path });
	const researchId = "cp-md-flag-research";
	const shipId = "cp-md-flag-ship";
	const { runner, calls } = handoffBench(home.path, {
		researchId,
		shipId,
		mandates,
		escalations,
		planSummary: MINIMAL_PLAN_SUMMARY,
		gateVerdict: {
			verdict: "escalate",
			cause: "flagged",
			flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false },
			reasons: ["the plan drops the legacy_accounts table"],
		},
	});
	const flagged = await runner.advance(researchId);
	assert.equal(flagged.next, "authorize");
	assert.equal(flagged.checkpoint?.decision, "pending", "a gate flag is never a mandate decision");
	assert.equal(flagged.checkpoint?.decided_by, undefined);
	assert.deepEqual(calls, [], "nothing is dispatched on a flagged checkpoint");
	const open = escalations.list({ kind: "plan_approval", status: "open" });
	assert.equal(open.length, 1, "exactly one plan-approval escalation");
	await runner.advance(researchId);
	assert.equal(escalations.list({ kind: "plan_approval" }).length, 1, "a second advance does not mint another");
	assert.equal(runner.checkpoints.get(shipId)?.decision, "pending");
});

test("ask_on plan_approval raises one escalation with summaries and paths", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the handoff",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 10,
		ask_on: ["plan_approval"],
	});
	const researchId = "cp-ask-research";
	const shipId = "cp-ask-ship";
	const escalations = new EscalationStore({ home: home.path });
	const decisionSummary = { would_make_wrong: "the file list drops src/app.ts", verified: "acceptance and test plan are present" };
	const { runner, calls } = handoffBench(home.path, {
		researchId,
		shipId,
		mandates,
		escalations,
		planSummary: MINIMAL_PLAN_SUMMARY,
		decisionSummary,
	});
	const first = await runner.advance(researchId);
	await runner.advance(researchId);
	assert.equal(first.next, "authorize");
	assert.equal(first.checkpoint?.decision, "pending");
	assert.deepEqual(calls, []);
	const open = escalations.list({ kind: "plan_approval", status: "open" });
	assert.equal(open.length, 1);
	assert.equal(escalations.list({ kind: "plan_approval" }).length, 1, "a second advance does not mint another");
	const row = open[0]!;
	assert.equal(row.plan_summary?.goal, MINIMAL_PLAN_SUMMARY.goal);
	assert.equal(row.decision_summary?.verified, decisionSummary.verified);
	assert.ok(row.evidence_paths.some((path) => path.endsWith("report.md")));
	assert.ok(row.evidence_paths.some((path) => path.includes("gate-1.json")));
});

test("revise re-gates only when the artifact changed", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-rev-research";
	const shipId = "cp-rev-ship";
	const gateStarts: string[] = [];
	const sent: string[] = [];
	const { runner } = handoffBench(home.path, { researchId, shipId, gateStarts, sent });
	const artifact = join(home.path, paths.artifactFile(researchId));
	await runner.revisePlan(researchId, "split step 3");
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /split step 3/);
	const unchanged = await runner.advance(researchId);
	assert.deepEqual(gateStarts, [], "an unchanged artifact is not re-gated");
	assert.equal(unchanged.next, "authorize");
	const later = new Date(Date.now() + 5_000);
	utimesSync(artifact, later, later);
	const changed = await runner.advance(researchId);
	assert.deepEqual(gateStarts, [researchId]);
	assert.equal(changed.pending?.surface, "gate");
});

test("mandate: risk:high or a project mismatch stays pending", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the handoff",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 10,
	});
	const high = handoffBench(home.path, {
		researchId: "cp-md-high-r",
		shipId: "cp-md-high-s",
		mandates,
		assessment: { scope: "M", confidence: "high", destructive_scope: true, blocking_unknowns: false },
	});
	const asked = await high.runner.advance("cp-md-high-r");
	assert.equal(asked.next, "authorize");
	assert.equal(asked.checkpoint?.decision, "pending");
	assert.deepEqual(high.calls, []);

	const outsider = createScratchHome();
	t.after(() => outsider.cleanup());
	const foreign = new MandateStore(outsider.path);
	foreign.issue({
		projects: ["other"],
		objective: "not this repo",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 10,
	});
	const mismatch = handoffBench(outsider.path, {
		researchId: "cp-md-out-r",
		shipId: "cp-md-out-s",
		mandates: foreign,
	});
	const pending = await mismatch.runner.advance("cp-md-out-r");
	assert.equal(pending.next, "authorize");
	assert.equal(pending.checkpoint?.decision, "pending");
	assert.deepEqual(mismatch.calls, []);
});

test("mandate: an excluded path in the original task stays pending", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path);
	mandates.issue({
		projects: ["demo"],
		objective: "ship except secrets",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 10,
		exclusions: { paths: ["src/secrets"] },
	});
	const { runner, calls } = handoffBench(home.path, {
		researchId: "cp-md-sec-r",
		shipId: "cp-md-sec-s",
		mandates,
		originalTask: "Rotate src/secrets/key.ts and leave the rest alone.\n",
	});
	const asked = await runner.advance("cp-md-sec-r");
	assert.equal(asked.next, "authorize");
	assert.equal(asked.checkpoint?.decision, "pending");
	assert.deepEqual(calls, []);
});

test("mandate: a risk:high flagged diff checkpoint stays pending", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the handoff",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 10,
	});
	const researchId = "cp-md-diff-r";
	const shipId = "cp-md-diff-s";
	new CheckpointStore(home.path).request({ jobId: shipId, researchId, question: "Authorize implementation?" });
	new CheckpointStore(home.path).decide(shipId, true, { by: "operator command" });
	const reviewer = new StubReviewer(home.path);
	const runner = diffGateBench(home.path, {
		researchId,
		shipId,
		review: { enabled: true },
		reviewer,
		mandates,
		taskImpact: {
			source: "start",
			routing: {
				risk: "high",
				inferred: false,
				provenance: { scope: "explicit", risk: "explicit" },
			},
		},
	});
	reviewer.queue({
		verdict: "escalate",
		cause: "flagged",
		flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false },
		reasons: ["the diff drops the legacy_accounts table"],
	});
	const flagged = await runner.advance(researchId);
	assert.equal(flagged.next, "authorize");
	assert.equal(flagged.checkpoint?.decision, "pending");
	assert.equal(runner.diffCheckpoints.get(shipId)?.decision, "pending");
	assert.equal(runner.diffCheckpoints.get(shipId)?.decided_by, undefined);
});
