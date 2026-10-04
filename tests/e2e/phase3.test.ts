/**
 * MILESTONE m3 — the pipeline, end to end, on the mock provider.
 *
 * Everything is the real thing except the model: a real `br` ledger, a real
 * project registry and clone, real treehouse leases, real `pi --mode rpc`
 * workers (planner, gate reviewer, implementer), real files on disk. Only
 * the model's answers are scripted, which is what makes every branch reachable
 * for free.
 *
 * Covered:
 *  - research → artifact at the predeclared path → envelope → gate
 *  - every gate verdict/cause branch: pass, revise (promoted to the live
 *    planner), a second revise capped into escalate/policy, a raised flag
 *    forcing escalate/policy, an unparseable verdict as escalate/operational,
 *    and a repeat of that as escalate/operational_persistent (on a different
 *    model, then surfaced)
 *  - checkpoint: a passed gate is not authorization; a journaled human decision
 *    is what dispatches the implementer, with the artifact as its task file
 *  - parent context safety: the artifact body is unreadable by the parent, the
 *    ledger read that would inline it is blocked, and runtime state cannot be
 *    committed
 *
 * `npm run e2e:phase3`
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type GateVerdict, LAYOUT, MINIMAL_PLAN_SUMMARY, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { nextAction } from "../../src/gate.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import type { AdvanceResult, Authorizer } from "../../src/pipeline.ts";
import { ReviewRuns, type ReviewWakeup } from "../../src/review-runs.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readFleet,
	type RecordedRequest,
	REPO_ROOT,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "m3 needs treehouse on PATH";

const ARTIFACT = [
	"# Goal",
	"Bump x to 2 in src/app.ts.",
	"",
	"# Non-goals",
	"Everything else.",
	"",
	"# Evidence",
	"- src/app.ts:1 `export const x = 1;`",
	"",
	"# File list",
	"- src/app.ts",
	"",
	"# Constraints",
	"No API change.",
	"",
	"# Test plan",
	"npm test",
	"",
	"# Unknowns/Blockers",
	"none",
	"",
	"# Self-assessment",
	"confidence high, scope S, blocking_unknowns no, destructive_scope no",
	"",
].join("\n");

/** What the scripted planner puts in its envelope; mutable per scenario. */
interface PlannerAssessment {
	confidence: "high" | "medium" | "low";
	scope: "S" | "M" | "L";
	blocking_unknowns: boolean;
	destructive_scope: boolean;
	suggested_implementer_model?: string;
}

interface Pipeline {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	clone: string;
	/** What the operator will answer at the checkpoint. */
	answer: { approved: boolean } | undefined;
	/** What the scripted planner will report about its own plan. */
	assessment: PlannerAssessment;
	asked: string[];
	/** Reviewer steps, filled in once the job ids exist. */
	reviewer: ScriptStep[];
	start(options?: {
		quality?: { verify?: boolean; voters?: number; threshold?: number };
		/** The intake task; defaults to the small, low-impact one. */
		task?: string;
		/** What the operator said about the work at `cp_pipeline start`. */
		risk?: "low" | "high";
		scope?: "S" | "M" | "L";
	}): Promise<{
		research_id: string;
		ship_id: string;
	}>;
	/** Wait until the planner has written its artifact. */
	artifact(researchId: string): Promise<string>;
	/**
	 * Advance until nothing is pending: every reviewer the ladder starts is
	 * handed back and settled, then `advance` runs again (spec 2026-09-05).
	 */
	advanceThrough(researchId: string): Promise<AdvanceResult>;
	/** Hand back and settle one attempt's chain. */
	settle(jobId: string, surface: "gate" | "review" | "quality", attempt: number): Promise<void>;
	/** Every cp-verdict the registry handed to the transport, in order. */
	sent: ReviewWakeup[];
}

/**
 * A whole command post in a temp dir, with every role pinned to a scripted
 * model through `data/routing.json` rubric rows — how an operator routes now.
 */
async function pipeline(t: { after(fn: () => void | Promise<void>): void }): Promise<Pipeline> {
	const home = createScratchHome();
	const repo = createScratchRepo({
		name: "demo",
		files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" },
	});
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");

	// The planner writes the artifact at the path it was given, then reports
	// through the only channel there is. `$CP_ARTIFACT_PATH` comes from the
	// worker environment; the envelope's ids are read back out of the brief,
	// because br mints them after the script is registered.
	// cp-rte: L + destructive means routing must reach the implementer rubric row
	// for big, risky work — and the suggested model must be ignored. routing T2
	// swaps this out for a confident, non-destructive plan on a high-impact task.
	const assessment: PlannerAssessment = {
		confidence: "high",
		scope: "L",
		blocking_unknowns: false,
		destructive_scope: true,
		suggested_implementer_model: "mock/script-m3-gate-ladder",
	};
	const planner = provider.addScript(
		"m3-research",
		[
			{
				kind: "tool_calls",
				calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${ARTIFACT}EOF` } }],
				usage: { prompt_tokens: 1200, completion_tokens: 90 },
			},
			{
				kind: "tool_calls",
				calls: [
					{
						name: "report_result",
						args: (request: RecordedRequest) => ({
							job_id: jobIdOf(request),
							kind: "research",
							status: "done",
							summary: "Plan written: one file, one constant, existing suite covers it.",
							artifact_path: artifactPathOf(request),
							plan_summary: MINIMAL_PLAN_SUMMARY,
							self_assessment: { ...assessment },
						}),
					},
				],
				usage: { prompt_tokens: 1500, completion_tokens: 70 },
			},
			{ kind: "text", text: "Reported; standing by for revisions." },
		],
		{ onExhausted: "repeat" },
	);
	const reviewerSteps: ScriptStep[] = [];
	const reviewer = provider.addScript("m3-gate", reviewerSteps);
	// cp-eff: there is no different-model rung any more, so a repeated operational
	// fault re-runs the same reviewer model and is capped at
	// `operational_persistent`. The script stays registered because the m3
	// scenario drives that second attempt explicitly.
	provider.addScript("m3-gate-ladder", [{ kind: "text", text: "still not reporting" }]);
	// Same script, second registration: the *model* is what the assertion is about.
	const bigShip = provider.addScript(
		"m3-ship-big",
		[
			{
				kind: "tool_calls",
				calls: [
					{
						name: "bash",
						args: { command: "printf 'export const x = 2;\\n' > src/app.ts && git add -A && git commit -q -m 'bump x'" },
					},
				],
			},
			{ kind: "text", text: "Bumped x; standing by." },
		],
		{ onExhausted: "repeat" },
	);
	// routing T2: the row for work that is risky but not big. Only a pipeline that
	// retains the TASK's impact past a confident planner can ever reach it.
	const riskyShip = provider.addScript(
		"m3-ship-risky",
		[
			{
				kind: "tool_calls",
				calls: [
					{
						name: "bash",
						args: { command: "printf 'export const x = 2;\\n' > src/app.ts && git add -A && git commit -q -m 'bump x'" },
					},
				],
			},
			{ kind: "text", text: "Bumped x; standing by." },
		],
		{ onExhausted: "repeat" },
	);
	const implementer = provider.addScript(
		"m3-ship",
		[
			{
				kind: "tool_calls",
				calls: [
					{
						name: "bash",
						args: { command: "printf 'export const x = 2;\\n' > src/app.ts && git add -A && git commit -q -m 'bump x'" },
					},
				],
			},
			{ kind: "text", text: "Bumped x; standing by." },
		],
		{ onExhausted: "repeat" },
	);
	agentDir.writeModels(provider);

	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.path, LAYOUT.routingFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			allow: ["mock/*"],
			rubric: [
				{ id: "planner", role: "planner", model: planner },
				{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer },
				// cp-rte: only a job routed as L/high reaches this row, and only the
				// planner's self-assessment can supply those inputs for a pipeline.
				{ id: "big-risky-ship", role: "implementer", scope: ["L"], risk: "high", model: bigShip, thinking: "xhigh" },
				{ id: "risky-ship", role: "implementer", risk: "high", model: riskyShip, thinking: "high" },
				{ id: "implementer", role: "implementer", model: implementer },
			],
		}),
	);

	const asked: string[] = [];
	const state = { answer: { approved: true } as { approved: boolean } | undefined };
	const authorizer: Authorizer = {
		async ask(checkpoint) {
			asked.push(checkpoint.job_id);
			return state.answer ? { approved: state.answer.approved, by: "m3 operator" } : undefined;
		},
	};

	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...agentDir.env },
		authorizer,
	});
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const sent: ReviewWakeup[] = [];
	post.reviewRuns.wakeupPort = (wakeup) => (sent.push(wakeup), true);

	const pool = enableTreehouse(clone, { maxTrees: 4 });

	t.after(async () => {
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// the pool root is deleted next anyway
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	const bench: Pipeline = {
		home: home.path,
		post,
		provider,
		clone,
		get answer() {
			return state.answer;
		},
		set answer(value) {
			state.answer = value;
		},
		assessment,
		asked,
		reviewer: reviewerSteps,
		sent,
		async settle(jobId, surface, attempt) {
			const key = ReviewRuns.key(jobId, surface, attempt);
			post.reviewRuns.handBack(key);
			await post.reviewRuns.settled(key);
		},
		async advanceThrough(researchId) {
			let result = await post.advancePipeline(researchId);
			for (let guard = 0; result.pending && guard < 10; guard += 1) {
				const owner = result.pending.surface === "review" ? result.ship_id : result.research_id;
				const key = ReviewRuns.key(owner, result.pending.surface, result.pending.attempt);
				post.reviewRuns.handBack(key);
				await post.reviewRuns.settled(key);
				result = await post.advancePipeline(researchId);
			}
			return result;
		},
		async start(options = {}) {
			const started = await post.startPipeline({
				title: "bump x",
				project: "demo",
				task: options.task ?? "Bump x to 2 in src/app.ts.",
				delivery: "local",
				slug: "m3",
				fetch: false,
				...(options.quality ? { quality: options.quality } : {}),
				...(options.risk ? { risk: options.risk } : {}),
				...(options.scope ? { scope: options.scope } : {}),
			});
			assert.equal(started.dispatch.receipt, "accepted");
			return { research_id: started.research_id, ship_id: started.ship_id };
		},
		async artifact(researchId) {
			// H7: the gate's own predicate (non-empty); `cat > file` creates it empty first.
			await waitFor(() => post.artifacts.has(researchId), (there) => there, { timeoutMs: 60_000, what: "the planner's artifact" });
			return post.artifacts.file(researchId);
		},
	};
	return bench;
}

/**
 * The brief the worker was sent is in the request, and it names the job and its
 * predeclared artifact. That is how a canned script reports for an id br only
 * minted a moment ago.
 */
function briefOf(request: RecordedRequest): string {
	return JSON.stringify(request.body.messages ?? []);
}

function artifactPathOf(request: RecordedRequest): string {
	// Anchored on the predeclared artifact path, which is unambiguous: a plain
	// `cp-...` search would happily match the pool directory in the worktree path.
	const match = /(\/[^"'\s\\]*\/state\/artifacts\/[A-Za-z0-9_-]+\/report\.md)/.exec(briefOf(request));
	assert.ok(match, "no artifact path in the brief the worker was sent");
	return match[1] as string;
}

function jobIdOf(request: RecordedRequest): string {
	const match = /\/state\/artifacts\/([A-Za-z0-9_-]+)\/report\.md/.exec(artifactPathOf(request));
	assert.ok(match, "no job id in the artifact path");
	return match[1] as string;
}

/** A scripted reviewer verdict. */
function verdict(jobId: string, overrides: Record<string, unknown> = {}): ScriptStep {
	return {
		kind: "tool_calls",
		calls: [
			{
				name: "report_verdict",
				args: {
					job_id: jobId,
					verdict: "pass",
					flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
					reasons: ["file list is concrete; test plan runs as written"],
					...overrides,
				},
			},
		],
		usage: { prompt_tokens: 900, completion_tokens: 50 },
	};
}

/** The decision one gate attempt left on disk (the verdict no longer rides the tool result). */
function decision(home: string, jobId: string, attempt: number): GateVerdict {
	return JSON.parse(readFileSync(join(home, paths.gateFile(jobId, attempt)), "utf8")) as GateVerdict;
}

/** Touch the artifact so the gate treats it as revised (a newer artifact). */
function markRevised(path: string): void {
	writeFileSync(path, `${readFileSync(path, "utf8")}\n# Revision\nCommands named explicitly.\n`);
	const future = new Date(Date.now() + 2000);
	utimesSync(path, future, future);
}

// ---------------------------------------------------------------------------
// the whole path
// ---------------------------------------------------------------------------

test("m3: research → gate (revise, then pass) → checkpoint → implement", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const f = await pipeline(t);
	const { research_id: researchId, ship_id: shipId } = await f.start();

	// The ship job exists and is blocked by the research job: br ready cannot
	// offer implementation work before the plan is judged.
	assert.deepEqual(await f.post.ledger().blockersOf(shipId), [researchId]);

	const artifactPath = await f.artifact(researchId);
	const held = await waitFor(
		() => readFleet(f.home).jobs.find((job) => job.job_id === researchId),
		(job) => job?.phase === "held",
		{ timeoutMs: 60_000, what: "the research envelope" },
	);
	assert.ok(held?.reported_at, "the planner reported through report_result");
	assert.equal(
		held?.receipts?.some((receipt) => receipt.kind === "artifact"),
		true,
	);

	// --- gate: revise, promoted to the live planner --------------------
	f.reviewer.push(
		verdict(researchId, { verdict: "revise", reasons: ["test plan is vague"], revisions: ["name the exact test command"] }),
		verdict(researchId, {}),
	);

	const revise = await f.advanceThrough(researchId);
	const reviseVerdict = decision(f.home, researchId, 1);
	assert.equal(reviseVerdict.verdict, "revise");
	assert.equal(reviseVerdict.cause, null, "revise carries no cause");
	// The verdict travels as a cp-verdict wake-up now, not in the tool result.
	assert.match(f.sent.at(-1)?.content ?? "", /gate attempt 1: revise/);
	assert.match(f.sent.at(-1)?.content ?? "", /revise delivered: delivered/);
	assert.equal(revise.state, "gating");
	assert.equal(f.asked.length, 0, "nothing is authorized before a pass");

	// --- gate: pass -> close research -> ask a human ----------------------
	markRevised(artifactPath);
	const pass = await f.advanceThrough(researchId);
	const passVerdict = decision(f.home, researchId, 2);
	assert.equal(passVerdict.verdict, "pass");
	assert.equal(passVerdict.cause, null);
	assert.equal(passVerdict.attempt, 2);
	assert.equal(pass.state, "implementing");
	assert.deepEqual(f.asked, [shipId], "the human was asked exactly once");

	// the research job is closed with the verdict, and its lease is back
	const closed = await f.post.ledger().show(researchId);
	assert.equal(closed.status, "closed");
	assert.match(String(closed.close_reason), /gate pass \(attempt 2/);
	assert.equal(pass.teardown?.torn_down, true);
	assert.equal(readFleet(f.home).jobs.find((job) => job.job_id === researchId)?.phase, "done");

	// the authorization is journaled, with headline evidence only
	const checkpoint = f.post.checkpoints.get(shipId);
	assert.equal(checkpoint?.decision, "approved");
	assert.equal(checkpoint?.decided_by, "m3 operator");
	assert.ok(!JSON.stringify(checkpoint).includes("# Goal"), "a checkpoint never carries the artifact body");

	// the implementer got the artifact as a file, wrapped in implement-this
	// framing, and did the work
	const taskFile = join(f.home, paths.taskFile(shipId));
	assert.ok(readFileSync(taskFile, "utf8").includes(readFileSync(artifactPath, "utf8")), "the artifact body reaches the worker intact");
	// cp-n7w: the brief points at the task file rather than inlining its body,
	// so the credential guard never sees artifact text.
	const brief = readFileSync(join(f.home, paths.briefFile(shipId)), "utf8");
	assert.ok(!brief.includes("Commands named explicitly."), "the artifact body never enters the brief");
	assert.ok(brief.includes(taskFile), "the brief points the implementer at the task file instead");
	assert.equal(pass.dispatch?.receipt, "accepted");

	// --- cp-rte: the planner's measurements chose the implementer's model ---
	// The artifact said scope L + destructive, so the L/high rubric row fires. Its
	// model is NOT the profile default and NOT the model the planner suggested.
	assert.equal(pass.dispatch?.model, "mock/script-m3-ship-big", "the L/high rubric row must decide");
	assert.match(pass.dispatch?.routing ?? "", /source=rubric/);
	assert.match(pass.dispatch?.routing ?? "", /rule=big-risky-ship/);
	assert.match(pass.dispatch?.routing ?? "", /thinking=xhigh/, "the row's effort travels with its model");
	assert.notEqual(pass.dispatch?.model, "mock/script-m3-gate-ladder", "a planner does not pick its successor's model");
	// And the disagreement is surfaced rather than silently resolved.
	assert.match(pass.message, /planner suggested mock\/script-m3-gate-ladder; routing chose mock\/script-m3-ship-big/);

	// The checkpoint carries both as evidence, so a human saw them before saying yes.
	const evidence = (f.post.checkpoints.get(shipId)?.evidence ?? []).join("\n");
	assert.match(evidence, /planner: scope L, confidence high, destructive -> routing as scope L \/ risk high/);
	assert.match(evidence, /planner suggested model: mock\/script-m3-gate-ladder \(advisory; routing decides\)/);

	const shipJob = readFleet(f.home).jobs.find((job) => job.job_id === shipId);
	assert.equal(shipJob?.phase, "waiting");
	await waitFor(
		() => readFileSync(join(shipJob?.worktree ?? "", "src/app.ts"), "utf8"),
		(text) => text.trim() === "export const x = 2;",
		{ timeoutMs: 60_000, what: "the implementer's edit" },
	);

	// --- parent context safety, on the real artifact ----------------------
	// The guard is the same object the parent extension consults on tool_call.
	const read = f.post.checkToolCall({ toolName: "read", input: { path: artifactPath }, cwd: f.home });
	assert.equal(read?.code, "artifact_body_read");
	assert.match(read?.reason ?? "", /cp_artifact get/);
	assert.equal(
		f.post.checkToolCall({ toolName: "bash", input: { command: `cat ${artifactPath}` }, cwd: f.home })?.code,
		"artifact_body_read",
	);
	// Reading the run's control surfaces stays allowed.
	for (const control of [paths.statusFile(researchId), paths.envelopeFile(researchId), paths.gateFile(researchId, 2)]) {
		assert.equal(f.post.checkToolCall({ toolName: "read", input: { path: join(f.home, control) }, cwd: f.home }), undefined);
	}
	// Runtime state is never committed. The guard matches NEVER_COMMIT_PATHS, and
	// since cp-u3i2 every runtime file lives under `.pi-command-post/`. So the
	// fleet file this home actually writes (LAYOUT.fleetFile) is blocked, and a
	// bare top-level `state/` path is ordinary source that may be staged.
	assert.equal(LAYOUT.fleetFile, ".pi-command-post/state/fleet.json");
	assert.equal(
		f.post.checkToolCall({ toolName: "bash", input: { command: `git add ${LAYOUT.fleetFile}` }, cwd: f.home })?.code,
		"never_commit_path",
	);
	assert.equal(f.post.checkToolCall({ toolName: "bash", input: { command: "git add state/fleet.json" }, cwd: f.home }), undefined);

	// Nothing the PARENT writes carries the body: the fleet, the gate decisions
	// and the checkpoint are all headlines and facts. (The worker's own event log
	// is a different surface: it records what the worker did, including the text
	// it wrote — that is observability, and the guards keep it out of the
	// parent's context the same way.)
	for (const file of [
		LAYOUT.fleetFile,
		paths.gateFile(researchId, 1),
		paths.gateFile(researchId, 2),
		paths.checkpointFile(shipId),
	]) {
		assert.ok(
			!readFileSync(join(f.home, file), "utf8").includes("# Non-goals"),
			`${file} must not carry the artifact body`,
		);
	}

	await f.post.tearDown(shipId, { force: true });
});

test(
	"m3 (routing T2): a confident plan cannot route production credential work as low risk",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const f = await pipeline(t);
		// The planner reports exactly what the tracker's reproduction says: a small,
		// confident, non-destructive, unblocked plan. Nothing here is a measurement
		// of what the WORK touches — that is the task's own fact, frozen at start.
		Object.assign(f.assessment, {
			confidence: "high",
			scope: "S",
			blocking_unknowns: false,
			destructive_scope: false,
			suggested_implementer_model: "mock/script-m3-ship",
		});
		const { research_id: researchId, ship_id: shipId } = await f.start({
			task: "Rotate the production auth credentials used by src/app.ts.",
			risk: "high",
		});
		await f.artifact(researchId);
		f.reviewer.push(verdict(researchId, {}));

		const pass = await f.advanceThrough(researchId);
		assert.equal(pass.state, "implementing");
		assert.deepEqual(f.asked, [shipId], "the human was asked exactly once");

		// The assertion this scenario exists for, on the model routing ACTUALLY
		// picked after the handoff: before routing T2 the pipeline emitted S/low here
		// (confident, non-destructive), which both missed every risk row and switched
		// off dispatch's own inference over the task's words.
		assert.equal(pass.dispatch?.model, "mock/script-m3-ship-risky", "known task impact must survive the handoff");
		assert.match(pass.dispatch?.routing ?? "", /rule=risky-ship/);
		assert.match(pass.dispatch?.routing ?? "", /thinking=high/, "the row's effort travels with its model");
		assert.notEqual(pass.dispatch?.model, "mock/script-m3-ship", "the ordinary implementer row must not win");

		// Scope still shrank on the planner's evidence — impact and size are not the
		// same axis — and the fleet record says where each half came from.
		const shipJob = readFleet(f.home).jobs.find((job) => job.job_id === shipId);
		assert.equal(shipJob?.routing?.scope, "S");
		assert.equal(shipJob?.routing?.risk, "high");
		assert.deepEqual(shipJob?.routing?.provenance, { scope: "assessed", risk: "explicit" });

		// And the human saw the composed assessment, not the planner's half of it.
		const evidence = (f.post.checkpoints.get(shipId)?.evidence ?? []).join("\n");
		assert.match(evidence, /-> routing as scope S \/ risk high/);
		assert.match(evidence, /routing: risk high retained from the task \(explicit, start\)/);

		await f.post.tearDown(shipId, { force: true });
	},
);

// ---------------------------------------------------------------------------
// every remaining verdict/cause branch
// ---------------------------------------------------------------------------

test("m3: a second revise is capped into escalate/policy", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const f = await pipeline(t);
	const { research_id: researchId, ship_id: shipId } = await f.start();
	const artifactPath = await f.artifact(researchId);
	f.reviewer.push(
		verdict(researchId, { verdict: "revise", reasons: ["thin"], revisions: ["name the commands"] }),
		verdict(researchId, { verdict: "revise", reasons: ["still thin"], revisions: ["again"] }),
	);

	await f.advanceThrough(researchId);
	assert.equal(decision(f.home, researchId, 1).verdict, "revise");

	markRevised(artifactPath);
	const capped = await f.advanceThrough(researchId);
	const cappedVerdict = decision(f.home, researchId, 2);
	assert.equal(cappedVerdict.verdict, "escalate");
	assert.equal(cappedVerdict.cause, "policy");
	assert.equal(nextAction(cappedVerdict), "surface");
	assert.match(cappedVerdict.reasons.join(" "), /attempt cap/);
	assert.equal(cappedVerdict.revisions, undefined, "an escalate carries no revisions");
	assert.equal(capped.state, "escalated");
	assert.equal(capped.next, "surface");

	// Nothing downstream happened: no authorization, no implementer.
	assert.equal(f.asked.length, 0);
	assert.equal(f.post.checkpoints.get(shipId), undefined);
	assert.equal(readFleet(f.home).jobs.find((job) => job.job_id === shipId), undefined);
	assert.equal((await f.post.ledger().show(researchId)).status, "in_progress", "an escalated research job stays open");
});

test(
	"m3: a raised flag forces escalate/FLAGGED on a reviewer pass — not policy, and it may still reach a checkpoint",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const f = await pipeline(t);
		f.answer = undefined; // no operator attached: prove nothing auto-approves
		const { research_id: researchId, ship_id: shipId } = await f.start();
		await f.artifact(researchId);
		f.reviewer.push(
			verdict(researchId, {
				verdict: "pass",
				flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false },
				reasons: ["the plan drops a table"],
			}),
		);

		const flagged = await f.advanceThrough(researchId);
		const flaggedVerdict = decision(f.home, researchId, 1);
		assert.equal(flaggedVerdict.verdict, "escalate", "a pass with a flag is not a pass");
		assert.equal(flaggedVerdict.cause, "flagged", "a reviewer-sound plan escalated only on a flag is FLAGGED, not policy");
		assert.equal(flaggedVerdict.flags.destructive_scope, true);
		assert.match(flaggedVerdict.reasons.join(" "), /flag forced escalate: destructive_scope/);
		assert.equal(flagged.next, "authorize", "flagged still needs a human, but it is not stuck behind /cp-authorize forever");
		assert.equal(f.post.checkpoints.get(shipId)?.decision, "pending", "a flagged escalate reaches a pending checkpoint");
	},
);

test("m3: a reviewer's own escalate with a flag stays policy — never authorizable", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const f = await pipeline(t);
	const { research_id: researchId, ship_id: shipId } = await f.start();
	await f.artifact(researchId);
	f.reviewer.push(
		verdict(researchId, {
			verdict: "escalate",
			flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false },
			reasons: ["the plan itself drops the wrong table"],
		}),
	);

	const escalated = await f.advanceThrough(researchId);
	const escalatedVerdict = decision(f.home, researchId, 1);
	assert.equal(escalatedVerdict.verdict, "escalate");
	assert.equal(escalatedVerdict.cause, "policy", "the reviewer's own escalate is a disputed plan, not a flagged-but-sound one");
	assert.equal(escalated.next, "surface");
	assert.equal(f.post.checkpoints.get(shipId), undefined, "a policy escalate never reaches a human authorization");
});

test("m3: unparseable → operational → operational_persistent, same model, capped", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const f = await pipeline(t);
	const { research_id: researchId } = await f.start();
	await f.artifact(researchId);

	// A reviewer that talks instead of reporting: nothing to parse, ever.
	f.reviewer.push({ kind: "text", text: "The artifact seems fine to me." });

	const firstRun = await f.post.advancePipeline(researchId);
	assert.equal(firstRun.next, "wait", "the reviewer is running: the tool call does not wait for it");
	assert.equal(firstRun.pending?.attempt, 1);
	await f.settle(researchId, "gate", 1);
	const operationalVerdict = decision(f.home, researchId, 1);
	assert.equal(operationalVerdict.verdict, "escalate");
	assert.equal(operationalVerdict.cause, "operational");
	assert.equal(nextAction(operationalVerdict), "retry", "an operational fault is retried, not surfaced");
	// The verdict reaches the parent as a wake-up, and it says what to do next.
	assert.match(f.sent.at(-1)?.content ?? "", /escalate \(cause: operational\)/);
	assert.match(f.sent.at(-1)?.content ?? "", /-> retry/);
	assert.deepEqual(operationalVerdict.flags, {
		destructive_scope: false,
		scope_growth: false,
		blocking_unknowns: false,
	});

	// Advancing again re-gates. cp-eff removed the fallback ladder, so the second
	// attempt runs the SAME model — correct for a transient fault — and the cap is
	// what stops the loop: a second operational fault is operational_persistent
	// and goes to a human.
	f.reviewer.push({ kind: "text", text: "Still not reporting a verdict." });
	const secondRun = await f.post.advancePipeline(researchId);
	assert.equal(secondRun.pending?.attempt, 2, "the retry is the next advance, exactly as the wake-up said");
	await f.settle(researchId, "gate", 2);
	const persistentVerdict = decision(f.home, researchId, 2);
	assert.equal(persistentVerdict.cause, "operational_persistent");
	assert.equal(nextAction(persistentVerdict), "surface", "a persistent tool failure stops looping");
	assert.equal(persistentVerdict.model, operationalVerdict.model, "there is no second list of models to walk");
	const persistent = await f.post.advancePipeline(researchId);
	assert.equal(persistent.next, "surface");

	// Both attempts are on disk, schema-valid, in order.
	const first = JSON.parse(readFileSync(join(f.home, paths.gateFile(researchId, 1)), "utf8")) as GateVerdict;
	const second = JSON.parse(readFileSync(join(f.home, paths.gateFile(researchId, 2)), "utf8")) as GateVerdict;
	assert.equal(first.cause, "operational");
	assert.equal(second.cause, "operational_persistent");
	assert.equal(second.attempt, 2);
});

test("m3: a passed gate is not authorization", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const f = await pipeline(t);
	f.answer = undefined; // nobody is at the keyboard
	const { research_id: researchId, ship_id: shipId } = await f.start();
	await f.artifact(researchId);
	f.reviewer.push(verdict(researchId, {}));

	const waiting = await f.advanceThrough(researchId);
	assert.equal(decision(f.home, researchId, 1).verdict, "pass");
	assert.equal(waiting.state, "awaiting_authorization");
	assert.equal(waiting.next, "authorize");
	assert.equal(waiting.checkpoint?.decision, "pending");
	assert.equal(waiting.dispatch, undefined);
	assert.equal(readFleet(f.home).jobs.find((job) => job.job_id === shipId), undefined, "no implementer without a human");

	// A declined decision stops the pipeline for good.
	f.post.checkpoints.decide(shipId, false, { by: "operator command", note: "not this quarter" });
	const declined = await f.post.advancePipeline(researchId);
	assert.equal(declined.checkpoint?.decision, "declined");
	assert.equal(declined.next, "surface");
	assert.equal(readFleet(f.home).jobs.find((job) => job.job_id === shipId), undefined);
	assert.match(declined.message, /not this quarter/);
});
