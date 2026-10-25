/**
 * P11d behavior 10: the research pipeline through a real CommandPost (cp_pipeline's start, advance and reanchor) with
 * mock-model planner, gate-reviewer and implementer workers on a treehouse pool; moved from tests/pipeline.test.ts.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { EscalationStore, gateOverride } from "../../src/escalation.ts";
import { MandateStore } from "../../src/mandate.ts";
import { CommandPost } from "../../src/command-post.ts";
import {
	type GateVerdict,
	isoTimestamp,
	LAYOUT,
	paths,
	type ReviewSurface,
	MINIMAL_PLAN_SUMMARY,
	unreportedWorkPresent,
	SCHEMA_VERSION,
} from "../../src/contracts.ts";
import { MAX_RECOVERY_PROMPTS, MAX_REPORT_NUDGES } from "../../src/settle.ts";
import { QuestionStore } from "../../src/questions.ts";
import { ReviewApprovalStore } from "../../src/review-approval.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { ReviewRuns, type ReviewWakeup } from "../../src/review-runs.ts";
import { type Authorizer, formatAdvance, type AdvanceResult, composeImplementationRouting } from "../../src/pipeline.ts";
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
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "the pipeline e2e needs treehouse on PATH";

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
	/** Advance until nothing is pending: every reviewer the ladder starts is handed back and settled first. */
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

/**
 * A revise sent during the hung planner's nudge turn is a steer (`queued`); once the nudge budget is spent and the
 * worker idles it is a prompt (`delivered`). Wait for that, so the receipt never depends on the gate's timing.
 */
async function hungPlannerIdle(b: Bench, researchId: string): Promise<void> {
	await waitFor(
		() => {
			const record = b.post.fleet.get(researchId);
			const settles = record?.unreported_settles ?? 0;
			const bound = unreportedWorkPresent(record?.unreported_work) ? MAX_RECOVERY_PROMPTS : MAX_REPORT_NUDGES;
			const busy = b.post.manager.get(researchId)?.worker.busy ?? true;
			return { settles, bound, busy };
		},
		(state) => state.settles > state.bound && !state.busy,
		{ timeoutMs: 60_000, what: "the hung planner idle after its report nudge" },
	);
}

test(
	"P11d-handoff: pipeline: two dep-linked issues, hung-planner gate, one revise, authorization, implementer hand-off",
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
		await hungPlannerIdle(b, researchId);

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
		// cp-pipeline-handoff-framing-dz9: before the divider, the framing defuses the planner's read-only voice and
		// states the ship job's own frozen task as the boundary; the body follows it.
		const [framing = ""] = taskFileBody.split("\n---\n");
		assert.match(framing, new RegExp(`^# Specification from ${researchId}`));
		assert.match(framing, /first-person voice[^]*not instructions to you/);
		assert.match(framing, /out of scope/);
		assert.ok(framing.includes("Bump x to 2 in src/app.ts."), "the ship job's frozen task is the scope boundary");
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
test("P11d-riskkw-gate: riskkw: a gate-flagged plan is refused at the implementer handoff under ask_on risk:high", { skip: SKIP, timeout: 300_000 }, async (t) => {
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

test("P11d-unanswered: pipeline: without a human answer nothing is dispatched", { skip: SKIP, timeout: 300_000 }, async (t) => {
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

test("P11d-bounds-home: pipeline: the home wall-clock cap in data/worker-bounds.json is frozen on both stages", { skip: SKIP, timeout: 300_000 }, async (t) => {
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

test("P11d-bounds-request: pipeline: requested wall-clock bound survives start and advance", { skip: SKIP, timeout: 300_000 }, async (t) => {
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

test("P11d-start: start refuses delivery:answer before any job exists, and labels its risk on both jobs", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const b = await bench(t, []);
	const before = (await b.post.ledger().list()).length;
	await assert.rejects(
		b.post.startPipeline({ title: "answer", project: "demo", task: "Where is it?", delivery: "answer" as never, fetch: false }),
		/delivery:answer is the Q&A path/,
	);
	assert.equal((await b.post.ledger().list()).length, before, "the refusal lands before the ledger is touched");
	// riskkw-f10: a named risk is a `risk:<x>` label on both jobs; no risk is no label, though routing still defaults low.
	for (const risk of ["low", undefined] as const) {
		const started = await b.post.startPipeline({
			title: `tidy ${risk ?? "none"}`, project: "demo", task: "Tidy", delivery: "local", fetch: false, ...(risk ? { risk } : {}),
		});
		for (const id of [started.research_id, started.ship_id]) {
			const labels = (await b.post.ledger().show(id)).labels ?? [];
			assert.deepEqual(labels.filter((label) => label.startsWith("risk:")), risk ? [`risk:${risk}`] : [], id);
		}
		assert.deepEqual(
			[started.record.task_impact?.routing.risk, started.record.task_impact?.routing.provenance?.risk],
			["low", risk ? "explicit" : "defaulted"],
		);
		await b.post.tearDown(started.research_id, { force: true });
	}
});

test("P11d-quality: pipeline: the opt-in quality pass runs before the gate, once", { skip: SKIP, timeout: 300_000 }, async (t) => {
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

test("P11d-declined: pipeline: a declined checkpoint stops the pipeline and says so", { skip: SKIP, timeout: 300_000 }, async (t) => {
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
	"P11d-flagged: pipeline: destructive_scope escalates FLAGGED, not policy — it reaches a pending checkpoint carrying the flag, and only a human answer dispatches it",
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
	"P11d-policy: pipeline: a policy escalate stays stopped until its explicit override, then continues through authorization",
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
	"P11d-unknowns: pipeline: blocking_unknowns in a gate verdict (without veto flags) advances to checkpoint, reaches evidence verbatim, and reaches routing as an assessed high",
	{ skip: SKIP, timeout: 300_000 },
	async (t) => {
		// cp-unknowns-no-veto: blocking_unknowns alone is reported, not a veto, so the plan reaches the checkpoint with
		// the flag in its evidence; riskkw (cp-yxgl): it still escalates the implementer's routing like the planner's own.
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
		// A full, contract-valid envelope record: the planner's mock keeps settling, and intake quarantines a
		// hand-written envelope that skips required fields.
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

		// Pinned to the gate's own "reported, no veto" line: src/gate.ts names only a flag that is actually true.
		const checkpoint = b.post.checkpoints.get(shipId);
		const evidence = (checkpoint?.evidence ?? []).join("\n");
		assert.match(
			evidence,
			/flag reported, no veto: blocking_unknowns/,
			`the true-valued blocking_unknowns flag must reach evidence verbatim; evidence: ${evidence}`,
		);

		// The routing the checkpoint authorized (rendered by `#authorize`) equals the composition of the verdict on disk.
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
	"P11d-reanchor: pipeline: reanchor points a superseded pipeline at a replacement research job, and re-gates it; the superseded artifact can never reach an implementer",
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

		// The replacement research job: a real job, dep-linked like any other.
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

test("P11d-review-open: review: an open review question does not hold the plan off the gate", { skip: SKIP, timeout: 300_000 }, async (t) => {
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

test("P11d-review-approved: review: a console approval pinned to the artifact decides the checkpoint without asking", { skip: SKIP, timeout: 300_000 }, async (t) => {
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

test("P11d-review-flagged: review: a console approval does not auto-decide a flagged escalate", { skip: SKIP, timeout: 300_000 }, async (t) => {
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

test("P11d-review-stale: review: an approval for a different plan is ignored", { skip: SKIP, timeout: 300_000 }, async (t) => {
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
