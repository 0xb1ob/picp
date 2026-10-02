/**
 * T21 acceptance: the pipeline, end to end on a scratch repo with scripted
 * models — research → gate (revise, then pass) → **checkpoint** → implementer
 * dispatch, plus the units that must fail closed on their own (classification,
 * the journaled checkpoint, the pipeline record).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { EscalationStore, gateOverride } from "../src/escalation.ts";
import { finalFixFile, readFinalFixRecord } from "../src/final-fix.ts";
import { atomicWriteJson } from "../src/json-store.ts";
import { MandateStore } from "../src/mandate.ts";
import { CheckpointError, CheckpointStore } from "../src/checkpoint.ts";
import { CommandPost } from "../src/command-post.ts";
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
	type ReviewSurface,
	type Risk,
	MINIMAL_PLAN_SUMMARY,
	SCHEMA_VERSION,
	type Scope,
	type SelfAssessment,
	type TaskImpact,
} from "../src/contracts.ts";
import { nextAction } from "../src/gate.ts";
import { QuestionStore } from "../src/questions.ts";
import { ReviewApprovalStore } from "../src/review-approval.ts";
import { initJobsDocument } from "../src/ledger.ts";
import { ReviewRuns, type ReviewWakeup } from "../src/review-runs.ts";
import { riskKeywords } from "../src/risk-warning.ts";
import {
	classifyIntake,
	type Authorizer,
	type DiffReviewer,
	type DiffReviewOutcome,
	frameImplementerTask,
	formatAdvance,
	inferScopeAndRisk,
	looksLikeQuestion,
	PipelineError,
	type AdvanceResult,
	type PipelineOptions,
	PipelineRunner,
	PipelineStore,
	composeImplementationRouting,
	taskImpactFrom,
} from "../src/pipeline.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	REPO_ROOT,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "./harness/index.ts";

const SKIP = treehouseAvailable() ? false : "the pipeline e2e needs treehouse on PATH";

// ---------------------------------------------------------------------------
// classification: advisory, deterministic, overridable
// ---------------------------------------------------------------------------

test("classification splits ambiguous or cross-cutting work, and only that", () => {
	for (const task of [
		"Figure out why the nightly job times out",
		"Refactor the auth module",
		"Rename the config key across all services",
		"We need a plan for migrating to the new schema",
		"Something is wrong somewhere in billing",
	]) {
		const result = classifyIntake({ task });
		assert.equal(result.mode, "pipeline", `expected a pipeline for: ${task}`);
		assert.ok(result.reasons.length > 0);
	}

	for (const task of ["Fix the typo in README.md", "Bump the version to 1.2.3", "Update the changelog for the release"]) {
		assert.equal(classifyIntake({ task }).mode, "single", `expected a single worker for: ${task}`);
	}

	// Scope and risk are signals in their own right.
	assert.equal(classifyIntake({ task: "Add a flag", scope: "L" }).mode, "pipeline");
	assert.equal(classifyIntake({ task: "Add a flag", risk: "high" }).mode, "pipeline");

	// The caller decides; a forced mode wins and says so.
	const forced = classifyIntake({ task: "Refactor everything", force: "single" });
	assert.equal(forced.mode, "single");
	assert.equal(forced.forced, true);
	// A research job is not a pipeline: it is the first half of one.
	assert.equal(classifyIntake({ task: "Investigate the flake", kind: "research" }).mode, "single");
});

// ---------------------------------------------------------------------------
// cp-u3o4: qa is the third, advisory mode
// ---------------------------------------------------------------------------

test("a question classifies as qa, and only a question does", () => {
	for (const task of [
		"Where is the retry ladder configured?",
		"which module owns the lease pool?",
		"Does the widget read fleet.json directly?",
		"How many profiles does this package have?",
	]) {
		const result = classifyIntake({ task });
		assert.equal(result.mode, "qa", `expected qa for: ${task}`);
		assert.ok(result.reasons.length > 0);
		assert.equal(result.forced, false);
	}

	// The failure this must not have: calling real work "a question".
	for (const task of [
		"Can you refactor the auth module?",
		"Should we migrate to the new schema? Write the plan.",
		"Fix the typo in README.md",
		"Figure out why the nightly job times out",
	]) {
		assert.notEqual(classifyIntake({ task }).mode, "qa", `must not be qa: ${task}`);
	}

	// Sized work is work: a caller who named scope or risk has already decided.
	assert.notEqual(classifyIntake({ task: "Where is the retry ladder configured?", scope: "L" }).mode, "qa");
	assert.notEqual(classifyIntake({ task: "Where is the retry ladder configured?", kind: "ship" }).mode, "qa");

	// Advisory, like the other two: the caller can force it, and forcing says so.
	const forced = classifyIntake({ task: "Refactor everything", force: "qa" });
	assert.equal(forced.mode, "qa");
	assert.equal(forced.forced, true);

	// The classifier errs toward work, never toward a question: a question that
	// mentions a change verb falls back to the ordinary single/pipeline decision,
	// which is the safe direction for an advisory signal. `/cp-ask` is the
	// deterministic door for the cases it declines.
	assert.notEqual(classifyIntake({ task: "How many profiles ship in this package?" }).mode, "qa");

	// And a long "question" is not a question with a glanceable answer.
	const wordy = `Why ${"very ".repeat(45)}slow?`;
	assert.notEqual(classifyIntake({ task: wordy }).mode, "qa");
	assert.equal(looksLikeQuestion(wordy).question, false);
	assert.equal(looksLikeQuestion("").question, false);
});

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

test("risk inference skips locally negated verbs and ordinary authority prose (bead b-qbi.2)", () => {
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

test("risk inference: a negation governs only its own verb, not a risk word further on (bead b-qbi.6)", () => {
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

// ---------------------------------------------------------------------------
// cp-pipeline-handoff-framing-dz9: the artifact must arrive framed, not raw
// ---------------------------------------------------------------------------

// A regression fixture: real read-only research phrasing, the kind that reads
// as the implementer's own instructions when handed over unframed. If a
// future change lets sentences like these reach the worker with no framing
// around them, this must fail.
const READ_ONLY_RESEARCH_BODY = [
	"# Findings",
	"Not implementing the feature. No code in this repository was changed.",
	"This research made no code changes (read-only per brief).",
	"# Recommendation",
	"Add a `widget` field to the config schema and thread it through the loader.",
].join("\n");

test("frameImplementerTask states the document is a specification to implement, not the reader's own words", () => {
	const framed = frameImplementerTask({
		researchId: "cp-research-1",
		shipId: "cp-ship-1",
		scope: "Add a widget field to the config loader; nothing else.",
		body: READ_ONLY_RESEARCH_BODY,
	});

	// The artifact body reaches the worker byte-for-byte, wrapped, never edited
	// or summarised.
	assert.ok(framed.includes(READ_ONLY_RESEARCH_BODY), "the artifact body survives unmodified");

	// It says plainly what the document is and what the reader's job is.
	assert.match(framed, /specification/i);
	assert.match(framed, /cp-research-1/, "names the research job the plan came from");
	assert.match(framed, /implement/i);

	// It defuses the planner's first-person, read-only voice explicitly —
	// the exact failure mode: an implementer reading "no code was changed" as
	// an instruction to itself.
	assert.match(framed, /first-person/i);
	assert.match(framed, /read-only/i);
	assert.match(framed, /not (an )?instructions? to you/i);

	// It carries the ship job's own scope boundary, taken from the caller
	// (never invented from the plan's size), and says the rest is out of scope.
	assert.match(framed, /cp-ship-1/, "names the ship job the scope belongs to");
	assert.ok(framed.includes("Add a widget field to the config loader; nothing else."), "the scope boundary is the ship job's own text");
	assert.match(framed, /out of scope/i);

	// The framing precedes the body: a reader hits "implement this" before it
	// hits the planner's own voice.
	assert.ok(framed.indexOf("specification") < framed.indexOf(READ_ONLY_RESEARCH_BODY));
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
// the pipeline, for real
// ---------------------------------------------------------------------------

interface Bench {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	clone: string;
	approvals: string[];
	/** What the authorizer will answer next. */
	answer: { approved: boolean } | undefined;
	sent: ReviewWakeup[];
	/** Hand back and wait for one attempt's chain to finish. */
	settle(jobId: string, surface: ReviewSurface, attempt: number): Promise<void>;
	/**
	 * Advance until nothing is pending: every reviewer the ladder starts is
	 * handed back and settled, then `advance` is called again. The synchronous
	 * shape the ladder tests were written against, restored on top of the async
	 * one (spec 2026-09-05).
	 */
	advanceThrough(researchId: string): Promise<AdvanceResult>;
}

const ARTIFACT_BODY = [
	"# Goal",
	"Bump x to 2 in src/app.ts.",
	"",
	"# File list",
	"- src/app.ts",
	"",
	"# Test plan",
	"npm test",
	"",
	"# Unknowns/Blockers",
	"none",
	"",
].join("\n");

async function bench(t: { after(fn: () => void | Promise<void>): void }, gateSteps: ScriptStep[]): Promise<Bench> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");

	// A planner that writes its artifact and never reports: the ported
	// hung-planner case, which the pipeline must be able to gate anyway.
	const planner = provider.addScript(
		"pipe-research",
		[
			{
				kind: "tool_calls",
				calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${ARTIFACT_BODY}EOF` } }],
				usage: { prompt_tokens: 800, completion_tokens: 60 },
			},
			{ kind: "text", text: "Artifact written." },
		],
		{ onExhausted: "repeat" },
	);
	const reviewer = provider.addScript("pipe-gate", gateSteps);
	const implementer = provider.addScript("pipe-ship", [{ kind: "text", text: "Working on it." }], {
		onExhausted: "repeat",
	});
	agentDir.writeModels(provider);

	// One rubric row per role, pinning each to a scripted model — exactly how an
	// operator writes routing policy now that pins are gone (cp-cxt).
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.path, LAYOUT.routingFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			allow: ["mock/*"],
			rubric: [
				{ id: "planner", role: "planner", model: planner },
				{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer },
				{ id: "implementer", role: "implementer", model: implementer },
			],
		}),
	);

	const approvals: string[] = [];
	const state: Bench = {
		home: home.path,
		post: undefined as unknown as CommandPost,
		provider,
		clone: "",
		approvals,
		answer: { approved: true },
		sent: [],
		settle: async () => {},
		advanceThrough: async () => {
			throw new Error("bench not built");
		},
	};
	const authorizer: Authorizer = {
		async ask(checkpoint) {
			approvals.push(checkpoint.job_id);
			return state.answer ? { approved: state.answer.approved, by: "test operator" } : undefined;
		},
	};

	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...agentDir.env },
		authorizer,
	});
	state.post = post;
	const sent: ReviewWakeup[] = [];
	post.reviewRuns.wakeupPort = (wakeup) => (sent.push(wakeup), true);
	state.sent = sent;
	state.settle = async (jobId, surface, attempt) => {
		const key = ReviewRuns.key(jobId, surface, attempt);
		post.reviewRuns.handBack(key);
		await post.reviewRuns.settled(key);
	};
	state.advanceThrough = async (researchId) => {
		let result = await post.advancePipeline(researchId);
		for (let guard = 0; result.pending && guard < 10; guard += 1) {
			const owner = result.pending.surface === "review" ? result.ship_id : result.research_id;
			await state.settle(owner, result.pending.surface, result.pending.attempt);
			result = await post.advancePipeline(researchId);
		}
		return result;
	};

	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	state.clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(state.clone, { maxTrees: 3 });

	t.after(async () => {
		await post.shutdown();
		try {
			treehouse(state.clone, "prune");
		} catch {
			// the pool root goes next anyway
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	return state;
}

function verdict(jobId: string, overrides: Record<string, unknown>): ScriptStep {
	return {
		kind: "tool_calls",
		calls: [
			{
				name: "report_verdict",
				args: {
					job_id: jobId,
					verdict: "pass",
					flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
					reasons: ["file list is concrete"],
					...overrides,
				},
			},
		],
		usage: { prompt_tokens: 700, completion_tokens: 40 },
	};
}

/** Start a pipeline and wait for the scripted planner to write its artifact (no envelope). */
async function startWithArtifact(b: Bench, slug: string): Promise<{ researchId: string; shipId: string; artifactPath: string }> {
	const started = await b.post.startPipeline({
		title: `bump ${slug}`,
		project: "demo",
		task: "Bump x to 2 in src/app.ts.",
		delivery: "local",
		slug,
		reasons: ["scope L"],
		fetch: false,
	});
	const artifactPath = await artifactWritten(b, started.research_id);
	return { researchId: started.research_id, shipId: started.ship_id, artifactPath };
}

/**
 * H7: wait on the gate's own predicate (non-empty), not existsSync: `cat > file`
 * creates it empty, and an advance then saw "no artifact yet". 10 s harness bound.
 */
async function artifactWritten(b: Bench, researchId: string): Promise<string> {
	await waitFor(() => b.post.artifacts.has(researchId), (there) => there, { what: "the planner's artifact" });
	return b.post.artifacts.file(researchId);
}

test(
	"pipeline: two dep-linked issues, hung-planner gate, one revise, authorization, implementer hand-off",
	{ skip: SKIP, timeout: 300_000 },
	async (t) => {
		// The reviewer's script serves both attempts, in order: revise, then pass.
		// The job ids are only known after `start`, so the verdicts are filled in
		// once the pipeline exists (the script is consumed later, on the gate run).
		const steps: ScriptStep[] = [];
		const b = await bench(t, steps);

		const started = await b.post.startPipeline({
			title: "bump x",
			project: "demo",
			task: "Bump x to 2 in src/app.ts.",
			delivery: "local",
			slug: "bump-x",
			reasons: ["scope L"],
			fetch: false,
		});
		const { research_id: researchId, ship_id: shipId } = started;
		steps.push(verdict(researchId, { verdict: "revise", revisions: ["name the exact test command"] }), verdict(researchId, {}));

		// --- the ledger is the operator's view: two issues, dep-linked --------
		const ledger = b.post.ledger();
		const research = await ledger.show(researchId);
		const ship = await ledger.show(shipId);
		assert.match(research.title, /^research: bump x/);
		assert.match(ship.title, /^ship: bump x/);
		assert.ok(research.labels?.includes("kind:research"));
		assert.ok(ship.labels?.includes("kind:ship"));
		assert.ok(ship.labels?.includes("delivery:local"));
		assert.deepEqual(await ledger.blockersOf(shipId), [researchId], "the ship job must be blocked by the research");
		assert.equal(started.dispatch.receipt, "accepted");
		assert.equal(b.post.pipeline().store.require(researchId).state, "researching");

		// --- the planner writes its artifact and hangs (no envelope) -------
		const artifactPath = await artifactWritten(b, researchId);
		assert.equal(b.post.fleet.get(researchId)?.reported_at, undefined, "this run is the hung-planner case");

		// --- advance #1: spawn the gate reviewer and return at once -----------
		const first = await b.post.advancePipeline(researchId);
		assert.equal(first.state, "gating");
		assert.equal(first.next, "wait");
		assert.equal(first.hung_planner, true, "an artifact without an envelope is still evidence");
		assert.equal(first.gate, undefined, "the verdict is not in the tool result any more");
		assert.equal(first.pending?.surface, "gate");
		assert.equal(first.pending?.attempt, 1);
		assert.ok(existsSync(join(b.home, paths.pendingReviewFile(researchId, "gate", 1))));

		// While the reviewer runs, advancing again changes nothing and says why.
		const busy = await b.post.advancePipeline(researchId);
		assert.equal(busy.next, "wait");
		assert.match(busy.message, /gate attempt 1 is running/);

		// The verdict lands in the background; the wake-up names the next step.
		await b.settle(researchId, "gate", 1);
		assert.equal(b.sent.at(-1)?.surface, "gate");
		assert.match(b.sent.at(-1)?.content ?? "", /gate attempt 1: revise/);
		assert.match(b.sent.at(-1)?.content ?? "", /revise delivered: delivered/);
		assert.match(b.sent.at(-1)?.content ?? "", new RegExp(`Next: call cp_pipeline advance ${researchId}`));

		// --- advance #2: the revise was already delivered by finish -----------
		const idle = await b.post.advancePipeline(researchId);
		assert.equal(idle.state, "gating");
		assert.equal(idle.next, "wait");
		assert.equal(idle.gate, undefined, "an unchanged artifact is not re-gated");
		assert.match(idle.message, /has not changed yet/, "and it says so, instead of reading like progress");
		assert.equal(b.approvals.length, 0, "nothing is authorized before a pass");

		// --- the planner revises: a newer artifact is a new artifact -------
		writeFileSync(artifactPath, `${ARTIFACT_BODY}\n# Test plan\nnpm test -- pipeline\n`);
		const future = new Date(Date.now() + 2000);
		utimesSync(artifactPath, future, future);

		// --- advance #3: a changed artifact is re-gated; the pass lands later --
		const regate = await b.post.advancePipeline(researchId);
		assert.equal(regate.next, "wait");
		assert.equal(regate.pending?.attempt, 2);
		await b.settle(researchId, "gate", 2);
		assert.match(b.sent.at(-1)?.content ?? "", /gate attempt 2: pass/);

		// --- advance #4: pass -> close research -> authorize -> implement -----
		const second = await b.post.advancePipeline(researchId);
		assert.equal(second.gate, undefined, "the verdict was read from disk, not decided here");
		assert.equal(second.state, "implementing");
		assert.equal(second.next, "wait");
		assert.deepEqual(b.approvals, [shipId], "the human was asked exactly once");

		// The research job is closed in the ledger, with the verdict as the reason.
		const closed = await ledger.show(researchId);
		assert.equal(closed.status, "closed");
		assert.match(String(closed.close_reason), /gate pass \(attempt 2/);

		// The authorization is journaled.
		const checkpoint = b.post.checkpoints.get(shipId);
		assert.equal(checkpoint?.decision, "approved");
		assert.equal(checkpoint?.decided_by, "test operator");
		assert.equal(checkpoint?.research_id, researchId);
		assert.ok(checkpoint?.evidence?.some((item) => item.startsWith("gate: pass")));
		assert.ok(!JSON.stringify(checkpoint).includes("# Goal"), "evidence is a headline, never a body");

		// The research lease came back before the implementer took one.
		assert.equal(second.teardown?.torn_down, true);
		assert.equal(b.post.fleet.get(researchId)?.phase, "done");

		// The hand-off is a file: the artifact, copied in code, never in context —
		// but wrapped in framing that says it is a specification to implement, not
		// the planner's own instructions.
		const taskFile = join(b.home, paths.taskFile(shipId));
		const taskFileBody = readFileSync(taskFile, "utf8");
		assert.ok(taskFileBody.includes(readFileSync(artifactPath, "utf8")), "the artifact body reaches the worker intact");
		assert.match(taskFileBody, /specification/i);
		assert.match(taskFileBody, /implement/i);
		assert.match(taskFileBody, new RegExp(shipId));
		assert.equal(second.dispatch?.receipt, "accepted");
		// cp-n7w: the brief points at the task file rather than inlining its body,
		// so the credential guard never sees artifact text — only the pointer.
		const brief = readFileSync(join(b.home, paths.briefFile(shipId)), "utf8");
		assert.ok(!brief.includes("npm test -- pipeline"), "the artifact body never enters the brief");
		assert.ok(brief.includes(taskFile), "the brief points the implementer at the task file instead");
		assert.equal(b.post.fleet.get(shipId)?.phase, "waiting");
		assert.equal(b.post.pipeline().store.require(researchId).state, "implementing");

		// Two gate attempts, both on disk, both schema-valid.
		assert.ok(existsSync(join(b.home, paths.gateFile(researchId, 1))));
		assert.ok(existsSync(join(b.home, paths.gateFile(researchId, 2))));
		// cp-yi73: attempt 1 revised, so the bytes that attempt was judging are kept
		// (the store has moved on since). Attempt 2 passed, so its scratch copy is
		// gone — while the attempt's own record (verdict.json) stays put.
		assert.ok(statSync(join(b.home, paths.gateScratchDir(researchId, 1), "artifact.md")).size > 0);
		assert.ok(!existsSync(join(b.home, paths.gateScratchDir(researchId, 2))));
		assert.ok(existsSync(join(b.home, paths.gateVerdictFile(researchId, 2))));

		// --- advance #3: an implementer that exists ends the ladder -----------
		// A settled record still says "gate: pass" and "checkpoint: approved", so
		// without this guard a second advance walks straight back down to
		// #dispatchImplementer and puts a second worker on one ship job.
		const working = await b.post.advancePipeline(researchId);
		assert.equal(working.state, "implementing");
		assert.equal(working.next, "wait");
		assert.equal(working.dispatch, undefined, "one ship job never gets a second implementer");
		assert.equal(working.gate, undefined, "a spent gate is not re-run");
		assert.equal(b.approvals.length, 1, "and the human is not asked twice");

		await b.post.tearDown(shipId, { force: true });

		// --- advance #4: `done` is reachable ---------------------------------
		const finished = await b.post.advancePipeline(researchId);
		assert.equal(finished.state, "done", "the implementer reported: the contract's terminal state");
		assert.equal(finished.next, "done");
		assert.equal(b.post.pipeline().store.require(researchId).state, "done");
	},
);

// riskkw (cp-yxgl review): the gate's own flags must reach the implementer's gate — a plan the
// reviewer flagged is refused before any lease under `ask_on: [risk:high]`, through the real
// dispatcher and its real mandate gate, and the ledger label follows the assessed value.
test("riskkw: a gate-flagged plan is refused at the implementer handoff under ask_on risk:high", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the web-search safety plan",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 50, tokens: 1_000_000 },
		job_cap: 10,
		ask_on: ["risk:high"],
	});

	const started = await b.post.startPipeline({
		title: "give workers web tools",
		project: "demo",
		task: "Give research workers web tools.",
		delivery: "local",
		slug: "riskkw-gate",
		fetch: false,
	});
	const { research_id: researchId, ship_id: shipId } = started;
	// The gate passes the plan but reports what it could not resolve — the reviewer's own read of it.
	steps.push(verdict(researchId, { flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: true } }));
	await artifactWritten(b, researchId);

	await assert.rejects(() => b.advanceThrough(researchId), /risk:high under ask_on/);

	const raised = new EscalationStore({ home: b.home }).open();
	const riskHigh = raised.find((item) => item.kind === "risk_high_irreversible");
	assert.equal(riskHigh?.job_ids.includes(shipId), true, `the dispatch gate raised the risk:high escalation for the ship job; open: ${JSON.stringify(raised.map((item) => [item.kind, item.job_ids]))}`);
	assert.equal(b.post.fleet.get(shipId), undefined, "refused before any lease or fleet record");
	assert.equal((await b.post.ledger().show(shipId)).labels?.includes("risk:high"), true, "the ledger label follows the assessed high");
});

test("pipeline: without a human answer nothing is dispatched", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);
	b.answer = undefined; // the operator is not there to answer

	const started = await b.post.startPipeline({
		title: "bump x",
		project: "demo",
		task: "Bump x to 2 in src/app.ts.",
		delivery: "local",
		slug: "bump-x",
		fetch: false,
	});
	const { research_id: researchId, ship_id: shipId } = started;
	steps.push(verdict(researchId, {}));

	await artifactWritten(b, researchId);

	const pending = await b.advanceThrough(researchId);
	assert.match(b.sent.at(-1)?.content ?? "", /gate attempt 1: pass/);
	assert.equal(pending.state, "awaiting_authorization");
	assert.equal(pending.next, "authorize");
	assert.equal(pending.checkpoint?.decision, "pending");
	assert.equal(pending.dispatch, undefined, "a passed gate is not authorization");
	assert.equal(b.post.fleet.get(shipId), undefined, "the ship job was never dispatched");
	// The research job is closed in the ledger (the finding is good) while the
	// fleet still shows `waiting`: this planner hung, so no envelope ever
	// arrived and intake never ran. The lease is still ours until teardown.
	assert.equal((await b.post.ledger().show(researchId)).status, "closed");
	assert.equal(b.post.fleet.get(researchId)?.phase, "waiting");

	// The operator answers out of band (/cp-authorize), then the pipeline moves.
	b.post.checkpoints.decide(shipId, true, { by: "operator command", note: "go" });
	const dispatched = await b.advanceThrough(researchId);
	assert.equal(dispatched.state, "implementing");
	assert.equal(dispatched.dispatch?.receipt, "accepted");
	assert.equal(dispatched.gate, undefined, "a passed artifact is gated once");
	assert.equal(dispatched.pending, undefined, "no second reviewer was spawned");
	assert.equal(b.post.checkpoints.get(shipId)?.decided_by, "operator command");

	await b.post.tearDown(shipId, { force: true });
});

test("pipeline: the home wall-clock cap in data/worker-bounds.json is frozen on both stages", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);
	writeFileSync(join(b.home, LAYOUT.workerBoundsFile), JSON.stringify({ wall_clock_seconds: 4321 }));

	const started = await b.post.startPipeline({
		title: "bump x",
		project: "demo",
		task: "Bump x to 2 in src/app.ts.",
		delivery: "local",
		slug: "bump-x",
		fetch: false,
	});
	const { research_id: researchId, ship_id: shipId } = started;
	steps.push(verdict(researchId, {}));
	assert.equal(b.post.fleet.require(researchId).bounds?.wall_clock_seconds, 4321, "start: the planner record carries the home cap");

	await artifactWritten(b, researchId);
	const dispatched = await b.advanceThrough(researchId);
	assert.equal(dispatched.state, "implementing");
	assert.equal(b.post.fleet.require(shipId).bounds?.wall_clock_seconds, 4321, "advance: the implementer record carries the home cap");

	await b.post.tearDown(shipId, { force: true });
});

test("pipeline: requested wall-clock bound survives start and advance", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);
	writeFileSync(join(b.home, LAYOUT.workerBoundsFile), JSON.stringify({ wall_clock_seconds: 4321 }));
	const started = await b.post.startPipeline({
		title: "bump x", project: "demo", task: "Bump x to 2 in src/app.ts.",
		delivery: "local", slug: "bounded", fetch: false,
		wallClockSeconds: 10800,
	});
	const { research_id: researchId, ship_id: shipId } = started;
	steps.push(verdict(researchId, {}));
	assert.equal(b.post.fleet.require(researchId).bounds?.wall_clock_seconds, 10800);
	assert.equal(started.dispatch.wall_clock_seconds, 10800);
	assert.equal(JSON.parse(readFileSync(b.post.pipeline().store.file(researchId), "utf8")).wall_clock_seconds, 10800);

	await artifactWritten(b, researchId);
	// A new runner reads the persisted request, not state retained by start().
	const dispatched = await b.advanceThrough(researchId);
	assert.equal(dispatched.state, "implementing");
	assert.equal(b.post.fleet.require(shipId).bounds?.wall_clock_seconds, 10800);
	assert.equal(dispatched.dispatch?.wall_clock_seconds, 10800);
	assert.match(formatAdvance(dispatched), new RegExp(`${shipId}.*wall_clock_seconds.*10800`));
	await b.post.tearDown(shipId, { force: true });
});

test("pipeline: the opt-in quality pass runs before the gate, once", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);

	const started = await b.post.startPipeline({
		title: "bump x",
		project: "demo",
		task: "Bump x to 2 in src/app.ts.",
		delivery: "local",
		slug: "bump-x",
		fetch: false,
		// Per-job opt-in: one voter, and only a unanimous panel proceeds.
		quality: { verify: true, voters: 1, threshold: 1 },
	});
	const { research_id: researchId } = started;
	// The reviewer profile is pinned to one script: the voter consumes the first
	// step, the gate reviewer the second.
	steps.push(verdict(researchId, { verdict: "revise", revisions: ["name the exact files"] }), verdict(researchId, {}));

	await artifactWritten(b, researchId);

	// The panel starts and returns at once.
	const panel = await b.post.advancePipeline(researchId);
	assert.equal(panel.state, "gating");
	assert.equal(panel.next, "wait");
	assert.equal(panel.pending?.surface, "quality");
	assert.equal(panel.gate, undefined, "the expensive gate is not paid for before the panel");
	await b.settle(researchId, "quality", 1);
	assert.match(b.sent.at(-1)?.content ?? "", /quality pass: not ready/);

	// The first advance to see the failed report acts on it: one promote, no gate.
	const checked = await b.post.advancePipeline(researchId);
	assert.equal(checked.state, "gating");
	assert.equal(checked.next, "wait");
	assert.equal(checked.quality?.passed, false);
	assert.equal(checked.quality?.verify?.total, 1);
	assert.deepEqual(checked.quality?.fixes, ["[evidence] name the exact files"]);
	assert.equal(checked.pending, undefined, "nothing is running: the planner was asked to fix");
	assert.match(checked.message, /promote: delivered/);
	assert.equal(existsSync(join(b.home, paths.gateFile(researchId, 1))), false);

	// One pass per job, acted on once: the next advance starts the gate.
	const gating = await b.post.advancePipeline(researchId);
	assert.equal(gating.pending?.surface, "gate");
	assert.equal(gating.quality?.passed, false, "the report is write-once and still says what it said");
	await b.settle(researchId, "gate", 1);
	const gated = await b.post.advancePipeline(researchId);
	assert.equal(gated.state, "implementing");

	await b.post.tearDown(started.ship_id, { force: true });
});

test("pipeline: a declined checkpoint stops the pipeline and says so", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);
	b.answer = { approved: false };

	const started = await b.post.startPipeline({
		title: "bump x",
		project: "demo",
		task: "Bump x to 2 in src/app.ts.",
		delivery: "local",
		slug: "bump-x",
		fetch: false,
	});
	steps.push(verdict(started.research_id, {}));
	await artifactWritten(b, started.research_id);

	const declined = await b.advanceThrough(started.research_id);
	assert.equal(declined.state, "awaiting_authorization");
	assert.equal(declined.next, "surface");
	assert.equal(declined.checkpoint?.decision, "declined");
	assert.equal(b.post.fleet.get(started.ship_id), undefined);
	assert.match(declined.message, /declined/);

	// A declined decision is final: advancing again does not re-ask.
	const again = await b.advanceThrough(started.research_id);
	assert.equal(again.checkpoint?.decision, "declined");
	assert.equal(b.approvals.length, 1, "a decided checkpoint is never re-asked");
});

// ---------------------------------------------------------------------------
// cp-n10: a flagged escalate reaches a pending checkpoint; a policy escalate
// never does; nothing auto-approves either way.
// ---------------------------------------------------------------------------

test(
	"pipeline: destructive_scope escalates FLAGGED, not policy — it reaches a pending checkpoint carrying the flag, and only a human answer dispatches it",
	{ skip: SKIP, timeout: 300_000 },
	async (t) => {
		const steps: ScriptStep[] = [];
		const b = await bench(t, steps);
		b.answer = undefined; // no operator attached: prove nothing auto-approves

		const started = await b.post.startPipeline({
			title: "bump x",
			project: "demo",
			task: "Bump x to 2 in src/app.ts.",
			delivery: "local",
			slug: "bump-x",
			fetch: false,
		});
		const { research_id: researchId, ship_id: shipId } = started;
		steps.push(
			verdict(researchId, {
				flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false },
				reasons: ["plan drops the legacy_accounts table"],
			}),
		);

		await artifactWritten(b, researchId);

		const flagged = await b.advanceThrough(researchId);
		const flaggedVerdict = JSON.parse(readFileSync(join(b.home, paths.gateFile(researchId, 1)), "utf8")) as GateVerdict;
		assert.equal(flaggedVerdict.verdict, "escalate");
		assert.equal(flaggedVerdict.cause, "flagged", "a reviewer-sound plan escalated only on a flag is FLAGGED, not policy");
		assert.match(b.sent.at(-1)?.content ?? "", /escalate \(cause: flagged\)/);
		assert.equal(flagged.state, "awaiting_authorization", "a flagged escalate reaches the checkpoint state, like a pass");
		assert.equal(flagged.next, "authorize");
		assert.equal(flagged.checkpoint?.decision, "pending", "evidence is not authorization, even when the reviewer is otherwise satisfied");
		assert.equal(flagged.dispatch, undefined, "a flagged escalate is never auto-approved into a dispatch");
		assert.equal(b.post.fleet.get(shipId), undefined, "the ship job was never dispatched");

		// The danger travels into the checkpoint, verbatim: the flag, and why.
		const checkpoint = b.post.checkpoints.get(shipId);
		assert.match(checkpoint?.question ?? "", /destructive_scope/);
		assert.ok(checkpoint?.evidence?.some((item) => item.includes("escalate (flagged")));
		assert.ok(checkpoint?.evidence?.some((item) => item.includes("destructive_scope")));
		assert.ok(checkpoint?.evidence?.some((item) => item.includes("plan drops the legacy_accounts table")));

		// The research is still closed — the reviewer found the plan sound; only
		// the flag stopped it, and closing research is not the same fact as
		// authorizing the ship job.
		assert.equal((await b.post.ledger().show(researchId)).status, "closed");

		// The operator answers out of band (/cp-authorize), then the pipeline moves.
		b.post.checkpoints.decide(shipId, true, { by: "operator command", note: "accepted the destructive risk" });
		const dispatched = await b.advanceThrough(researchId);
		assert.equal(dispatched.state, "implementing");
		assert.equal(dispatched.dispatch?.receipt, "accepted");
		assert.equal(dispatched.gate, undefined, "a spent gate verdict is not re-run");

		await b.post.tearDown(shipId, { force: true });
	},
);

test(
	"pipeline: a policy escalate stays stopped until its explicit override, then continues through authorization",
	{ skip: SKIP, timeout: 300_000 },
	async (t) => {
		const steps: ScriptStep[] = [];
		const b = await bench(t, steps);

		const started = await b.post.startPipeline({
			title: "bump x",
			project: "demo",
			task: "Bump x to 2 in src/app.ts.",
			delivery: "local",
			slug: "bump-x",
			fetch: false,
		});
		const { research_id: researchId, ship_id: shipId } = started;
		steps.push(verdict(researchId, { verdict: "escalate", reasons: ["the plan skips a rollback step"] }));

		await artifactWritten(b, researchId);

		const escalated = await b.advanceThrough(researchId);
		const escalatedVerdict = JSON.parse(readFileSync(join(b.home, paths.gateFile(researchId, 1)), "utf8")) as GateVerdict;
		assert.equal(escalatedVerdict.verdict, "escalate");
		assert.equal(escalatedVerdict.cause, "policy");
		assert.equal(escalated.state, "escalated");
		assert.equal(escalated.next, "surface");
		assert.equal(escalated.checkpoint, undefined, "a policy escalate never reaches #authorize");
		assert.equal(b.post.checkpoints.get(shipId), undefined, "nothing was ever asked — there is no checkpoint to answer");

		// /cp-authorize's underlying refusal: there is nothing to authorize, and it
		// stays that way — a policy escalate is not a pause, it is a stop.
		assert.throws(() => b.post.checkpoints.decide(shipId, true, { by: "operator command" }), /no checkpoint for/);

		// Advancing again changes nothing: the escalate is not re-gated (no new
		// artifact), and it still never reaches a checkpoint.
		const again = await b.advanceThrough(researchId);
		assert.equal(again.state, "escalated");
		assert.equal(again.checkpoint, undefined);
		assert.equal(b.post.fleet.get(shipId), undefined, "the ship job was never dispatched");

		const escalation = b.post.escalations.open().find((item) => item.evidence_paths.includes(paths.gateFile(researchId, 1)))!;
		await b.post.escalations.answer(escalation.id, { answer: "override", by: "operator-quote" });
		assert.equal(gateOverride(b.post.escalations, { ...escalatedVerdict, attempt: 2 }), undefined, "an override is scoped to its gate attempt");
		assert.equal(gateOverride(b.post.escalations, escalatedVerdict, "2099-01-01T00:00:00Z"), undefined, "changed artifacts cannot inherit an old override");
		b.answer = undefined;
		const resumed = await b.advanceThrough(researchId);
		assert.equal(resumed.state, "awaiting_authorization", "override clears the gate stop, not the implementation authorization");
		assert.equal(resumed.checkpoint?.decision, "pending");
		assert.match(resumed.checkpoint?.evidence?.join("\n") ?? "", /escalate.*policy/);
		assert.equal(resumed.pending, undefined, "no second gate is spawned");
		assert.equal(b.post.escalations.list({ kind: "conflicting_acceptance" }).length, 1, "answered override is not re-raised");
		b.post.checkpoints.decide(shipId, true, { by: "operator-quote" });
		const dispatched = await b.advanceThrough(researchId);
		assert.equal(dispatched.dispatch?.receipt, "accepted");
		assert.equal(dispatched.state, "implementing");
		const repeated = await b.post.advancePipeline(researchId);
		assert.equal(repeated.dispatch, undefined, "the implementer is not dispatched twice");
		assert.equal(b.sent.filter((item) => item.surface === "gate").length, 1);
		await b.post.tearDown(shipId, { force: true });
	},
);

test(
	"pipeline: blocking_unknowns in a gate verdict (without veto flags) advances to checkpoint, reaches evidence verbatim, and reaches routing as an assessed high",
	{ skip: SKIP, timeout: 300_000 },
	async (t) => {
		// cp-unknowns-no-veto: blocking_unknowns is reported but not a veto flag, so a
		// gate verdict with blocking_unknowns:true and no veto flags (destructive_scope
		// and scope_growth both false) does not escalate on its own — it reaches the
		// checkpoint (headline behaviour). The flag is reported verbatim in the gate's
		// own reasons and reaches checkpoint evidence, and (riskkw, the cp-yxgl review)
		// it is escalating evidence for the composition exactly like the planner's own
		// `self_assessment.blocking_unknowns`: a plan the reviewer could not resolve is
		// not a low-risk plan. The composition below is still compared against the same
		// `composeImplementationRouting` call computed here from the verdict on disk.
		const steps: ScriptStep[] = [];
		const b = await bench(t, steps);
		b.answer = undefined; // disable auto-approval to observe the checkpoint

		const started = await b.post.startPipeline({
			title: "add feature",
			project: "demo",
			task: "Add feature X",
			delivery: "pr",
			slug: "feature-x",
			fetch: false,
		});
		const { research_id: researchId, ship_id: shipId } = started;

		// Gate verdict with blocking_unknowns:true but NO veto flags.
		steps.push(
			verdict(researchId, {
				flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: true },
				reasons: ["some implementation details remain uncertain"],
			}),
		);

		const artifactPath = await artifactWritten(b, researchId);

		// The planner's own assessment does NOT report blocking_unknowns — only the
		// gate reviewer did, so the routing assertion below isolates the gate flag's
		// own effect from the planner's.
		const fixedAssessment = {
			scope: "S" as const,
			confidence: "high" as const,
			destructive_scope: false,
			blocking_unknowns: false,
		};
		// A full, contract-valid envelope record — the same shape a real worker's
		// report_result would write. A minimal `{ envelope: { self_assessment } }` is
		// rejected: the planner's mock script keeps running (`onExhausted: repeat`),
		// so its next `agent_settled` fires the settle watcher, which calls intake,
		// which validates this file and quarantines anything that violates the
		// contract — silently deleting a hand-written envelope that skips required
		// fields.
		const envelopeFile = join(b.home, paths.envelopeFile(researchId));
		mkdirSync(dirname(envelopeFile), { recursive: true });
		writeFileSync(
			envelopeFile,
			JSON.stringify({
				schema_version: SCHEMA_VERSION,
				job_id: researchId,
				received_at: isoTimestamp(),
				attempt: 1,
				envelope: {
					job_id: researchId,
					kind: "research",
					status: "done",
					summary: "plan complete; self-assessment fixed for the blocking_unknowns routing test",
					artifact_path: artifactPath,
					plan_summary: MINIMAL_PLAN_SUMMARY,
					self_assessment: fixedAssessment,
				},
			}),
		);

		const advanced = await b.advanceThrough(researchId);
		// blocking_unknowns is NOT a veto flag (GATE_VETO_FLAGS = destructive_scope,
		// scope_growth), so the verdict does not escalate despite the flag.
		const gateVerdict = JSON.parse(readFileSync(join(b.home, paths.gateFile(researchId, 1)), "utf8")) as GateVerdict;
		assert.equal(gateVerdict.verdict, "pass", "blocking_unknowns alone does not produce an escalate");
		assert.equal(gateVerdict.cause, null, "a pass has no cause");
		assert.equal(advanced.state, "awaiting_authorization", "a pass reaches the checkpoint, even with blocking_unknowns — the headline behaviour");
		assert.equal(advanced.next, "authorize");

		// The true-valued flag reaches the checkpoint evidence verbatim, via the
		// gate's own "reported, no veto" reason line — pinned to that exact rendering
		// (not a bare `includes("blocking_unknowns")`, which would also pass on a
		// false or absent value: `raised`/`reported` in src/gate.ts only ever name a
		// flag that is actually true, so this line can only appear here because the
		// flag really is true).
		const checkpoint = b.post.checkpoints.get(shipId);
		const evidence = (checkpoint?.evidence ?? []).join("\n");
		assert.match(
			evidence,
			/flag reported, no veto: blocking_unknowns/,
			`the true-valued blocking_unknowns flag must reach evidence verbatim; evidence: ${evidence}`,
		);

		// The routing assertion (routing T2 / cp-routing-provenance / riskkw): prove the
		// gate's flag reached the composition by comparing the routing the checkpoint
		// actually authorized — rendered into evidence by `#authorize` — against the SAME
		// composeImplementationRouting call, computed here from the verdict on disk, not a
		// hard-coded literal.
		const expected = composeImplementationRouting({ assessment: fixedAssessment, flags: gateVerdict.flags });
		assert.equal(expected.risk, "high", "the gate's blocking_unknowns alone escalates the composition");
		const rendered = evidence.match(/-> routing as scope (\S+) \/ risk (.+)$/m);
		assert.ok(rendered, `the routing summary line must appear in evidence; evidence: ${evidence}`);
		const [, renderedScope, renderedRisk] = rendered as RegExpMatchArray;
		assert.equal(renderedScope, expected.scope ?? "(inferred at dispatch)", "rendered scope must equal composeImplementationRouting's own scope");
		assert.equal(renderedRisk, expected.risk ?? "(inferred at dispatch)", "rendered risk must equal composeImplementationRouting's own risk — the gate's flag reaches it");

		// Each half is its own evidence: the planner's own blocking_unknowns escalates
		// exactly as the gate's flag does, and each names itself.
		assert.equal(
			composeImplementationRouting({ assessment: { ...fixedAssessment, blocking_unknowns: true } }).risk,
			"high",
			"the planner's own blocking_unknowns:true also escalates routing risk to high",
		);
		assert.match(
			composeImplementationRouting({ flags: gateVerdict.flags }).reasons.join("; "),
			/risk high: the gate flags blocking unknowns/,
			"and the composition says which half reported it",
		);
	},
);

test(
	"pipeline: reanchor points a superseded pipeline at a replacement research job, and re-gates it; the superseded artifact can never reach an implementer",
	{ skip: SKIP, timeout: 300_000 },
	async (t) => {
		const steps: ScriptStep[] = [];
		const b = await bench(t, steps);

		const started = await b.post.startPipeline({
			title: "bump x",
			project: "demo",
			task: "Bump x to 2 in src/app.ts.",
			delivery: "local",
			slug: "bump-x",
			fetch: false,
		});
		const { research_id: oldResearchId, ship_id: shipId } = started;
		steps.push(verdict(oldResearchId, { verdict: "escalate", reasons: ["the plan is unsafe as written"] }));

		await artifactWritten(b, oldResearchId);
		const escalated = await b.advanceThrough(oldResearchId);
		assert.equal(escalated.state, "escalated");

		// The replacement research job: a real br issue, dep-linked like any other.
		const ledger = b.post.ledger();
		const replacement = await ledger.create({
			title: "research: bump x, take 2",
			project: "demo",
			delivery: "pipeline",
			kind: "research",
			description: "Bump x to 2 in src/app.ts, avoiding the unsafe step.",
		});

		const reanchored = await b.post.reanchorPipeline(oldResearchId, replacement.id);
		assert.equal(reanchored.research_id, replacement.id);
		assert.equal(reanchored.ship_id, shipId);
		assert.equal(reanchored.state, "researching");

		// The superseded record says so, and refuses to be advanced ever again —
		// its artifact must never reach an implementer.
		const old = b.post.pipeline().store.get(oldResearchId);
		assert.equal(old?.superseded_by, replacement.id);
		await assert.rejects(() => b.post.advancePipeline(oldResearchId), /superseded by/);

		// The ledger dep now names the replacement, not the superseded research.
		assert.deepEqual(await ledger.blockersOf(shipId), [replacement.id]);

		// The replacement's own artifact, written directly (no planner needed
		// for this half of the test) and re-gated from scratch: a fresh gate
		// attempt 1, unrelated to the superseded research's escalate.
		writeFileSync(b.post.artifacts.path(replacement.id), ARTIFACT_BODY);
		steps.push(verdict(replacement.id, {}));

		const gated = await b.advanceThrough(replacement.id);
		const replacementVerdict = JSON.parse(
			readFileSync(join(b.home, paths.gateFile(replacement.id, 1)), "utf8"),
		) as GateVerdict;
		assert.equal(replacementVerdict.attempt, 1, "the replacement is gated as if for the first time");
		assert.equal(replacementVerdict.verdict, "pass");
		assert.equal(gated.state, "implementing");
		assert.equal(gated.dispatch?.receipt, "accepted");

		// Artifact resolution at implementer dispatch always follows the CURRENT
		// research job: the task file is the replacement's artifact, never the
		// superseded one's.
		const taskFile = join(b.home, paths.taskFile(shipId));
		assert.ok(
			readFileSync(taskFile, "utf8").includes(readFileSync(b.post.artifacts.file(replacement.id), "utf8")),
			"the task file wraps the replacement's artifact, never the superseded one's",
		);

		await b.post.tearDown(shipId, { force: true });
	},
);

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
// cp-u3o4: a pipeline never delivers an answer
// ---------------------------------------------------------------------------

test("a pipeline refuses delivery:answer in code, before it creates anything", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	// Every dependency is forbidden: the refusal must land before the ledger is
	// touched, so a non-tool caller cannot leave a half-created pipeline behind.
	const runner = new PipelineRunner({
		home: home.path,
		fleet: { get: () => undefined },
		ledger: forbidden("ledger"),
		dispatcher: () => forbidden("dispatcher"),
		gate: () => forbidden("gate"),
		artifacts: forbidden("artifacts"),
		teardown: forbidden("teardown"),
	} as unknown as PipelineOptions);

	await assert.rejects(
		() =>
			runner.start({
				title: "answer something",
				project: "demo",
				task: "Where is the retry ladder configured?",
				delivery: "answer" as never,
			}),
		(error: Error) => {
			assert.ok(error instanceof PipelineError, error.message);
			assert.match(error.message, /delivery:answer is the Q&A path/);
			return true;
		},
	);
});

test("riskkw-f10: cp_pipeline start records its risk on both ledger jobs, and nothing without one", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	for (const risk of ["low", undefined] as const) {
		const creates: Array<Record<string, unknown>> = [];
		const runner = new PipelineRunner({
			home: home.path,
			fleet: { get: () => undefined },
			ledger: {
				create: async (input: Record<string, unknown>) => (creates.push(input), { id: `cp-rk-${risk ?? "none"}-${creates.length}` }),
				addDep: async () => undefined,
			},
			dispatcher: () => ({ dispatch: async () => ({ state: "dispatched", receipt: "accepted" }) }),
			gate: () => forbidden("gate"),
			artifacts: forbidden("artifacts"),
			teardown: forbidden("teardown"),
		} as unknown as PipelineOptions);
		const started = await runner.start({ title: `tidy ${risk ?? "none"}`, project: "demo", task: "Tidy", ...(risk ? { risk } : {}) });
		assert.equal(creates.length, 2);
		for (const input of creates) assert.equal(input.risk, risk, JSON.stringify(input));
		// With nobody naming a risk the frozen axis is still routing's standing low —
		// `defaulted`, which is not a record, so it is never a `risk:low` label either.
		assert.equal(started.record.task_impact?.routing.risk, "low", "the standing default is still the frozen axis");
		assert.equal(started.record.task_impact?.routing.provenance?.risk, risk ? "explicit" : "defaulted");
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

test("review: an open review question does not hold the plan off the gate", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const b = await bench(t, []);
	const { researchId } = await startWithArtifact(b, "held-review");
	new QuestionStore(b.home).append({
		schema_version: 1, job_id: researchId, seq: 1, dialog_id: "d1", role: "planner", method: "review",
		question: "Plan written.", asked_at: "2026-09-13T10:00:00Z", outcome: "timeout",
	});
	const result = await b.post.advancePipeline(researchId);
	assert.doesNotMatch(result.message, /console review/);
	assert.equal(result.pending?.surface, "gate", "no envelope is not a console hold; the artifact is gated");
});

test("review: a console approval pinned to the artifact decides the checkpoint without asking", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);
	const { researchId, shipId, artifactPath } = await startWithArtifact(b, "pre-approved");
	steps.push(verdict(researchId, {})); // a pass, as the hung-planner test's second verdict
	new ReviewApprovalStore(b.home).write({ jobId: researchId, questionSeq: 1, artifactPath, by: "operator console" });
	b.answer = undefined; // the authorizer would leave it pending if asked
	const result = await b.advanceThrough(researchId);
	assert.deepEqual(b.approvals, [], "the authorizer was never asked");
	const checkpoint = b.post.checkpoints.get(shipId);
	assert.equal(checkpoint?.decision, "approved");
	assert.equal(checkpoint?.decided_by, "operator console");
	assert.match(checkpoint?.note ?? "", /approved for artifact [0-9a-f]{8}/);
	assert.equal(result.next, "wait", "the implementer was dispatched");
});

test("review: a console approval does not auto-decide a flagged escalate", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);
	const { researchId, shipId, artifactPath } = await startWithArtifact(b, "flagged-approval");
	// A reviewer pass plus a veto flag is the flagged escalate (gate.ts); passing
	// verdict:"escalate" would be policy and never reach #authorize.
	steps.push(
		verdict(researchId, {
			flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false },
			reasons: ["plan drops the legacy_accounts table"],
		}),
	);
	new ReviewApprovalStore(b.home).write({ jobId: researchId, questionSeq: 1, artifactPath, by: "operator console" });
	b.answer = undefined;
	const result = await b.advanceThrough(researchId);
	assert.equal(b.approvals.length, 1, "the authorizer was asked");
	assert.equal(b.approvals[0], shipId);
	assert.equal(result.checkpoint?.decision, "pending");
	assert.equal(result.next, "authorize");
});

test("review: an approval for a different plan is ignored", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const steps: ScriptStep[] = [];
	const b = await bench(t, steps);
	const { researchId, artifactPath } = await startWithArtifact(b, "stale-approval");
	steps.push(verdict(researchId, {}));
	new ReviewApprovalStore(b.home).write({ jobId: researchId, questionSeq: 1, artifactPath, by: "operator console" });
	appendFileSync(artifactPath, "\n# Rollback\nnone\n");
	b.answer = undefined;
	const result = await b.advanceThrough(researchId);
	assert.equal(b.approvals.length, 1, "a changed plan is asked about");
	assert.equal(result.next, "authorize");
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
