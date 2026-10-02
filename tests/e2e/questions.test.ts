/**
 * T31 end to end: a planner asks the operator, off the parent's context.
 *
 * Everything real except the model and the human: a real `pi --mode rpc`
 * planner with the real worker-reporter, a real project, lease and run dir, a
 * real dialog travelling the real `extension_ui_request` sub-protocol, and a
 * fake operator standing in for a person at a keyboard.
 *
 * The load-bearing assertion is the one about *where the answer went*: it is
 * proven to have entered the WORKER's context (the scripted model reads it out
 * of its own transcript and writes it into the artifact) while the parent's
 * envelope and run log carry only the exchange, never the plan body.
 *
 * `node --test tests/e2e/questions.test.ts`
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { MINIMAL_PLAN_SUMMARY, paths, type RunEvent } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { loadProfile } from "../../src/profiles.ts";
import { readEventLog } from "../../src/run-artifacts.ts";
import { ASK_OPERATOR_TOOL } from "../../src/worker-manager.ts";
import type { Asker, OperatorQuestion } from "../../src/questions.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readFleet,
	type RecordedRequest,
	REPO_ROOT,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "T31 e2e needs treehouse on PATH";
const QUESTION = "Which store should the cache use?";
const OPTIONS = ["Postgres", "SQLite"];

/** The operator's answer, as the worker's own transcript shows it. */
function answerFromTranscript(request: RecordedRequest): string {
	const text = JSON.stringify(request.body.messages ?? []);
	const match = /The operator answered: ([^"\\]+)/.exec(text);
	return match?.[1]?.trim() ?? "NO-ANSWER";
}

interface Bench {
	home: string;
	post: CommandPost;
	asked: OperatorQuestion[];
	jobId: string;
	cleanup(): Promise<void>;
}

/**
 * A command post with one scripted planner. `operator` decides whether a
 * human is attached at all — the single fact that turns the ask channel on.
 */
async function bench(
	t: { after(fn: () => void | Promise<void>): void },
	options: { operator: boolean; answer?: string | undefined },
): Promise<Bench> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
	const provider = await MockProvider.start();
	initJobsDocument(home.path, "cp");

	// The planner asks first, then writes an artifact that QUOTES the answer, then
	// reports. Step 2 reads the answer out of the request it was sent, so the
	// artifact can only contain it if the answer really reached the worker.
	const planner = provider.addScript(
		"t31-research",
		[
			{
				kind: "tool_calls",
				calls: [{ name: ASK_OPERATOR_TOOL, args: { question: QUESTION, options: OPTIONS } }],
			},
			{
				kind: "tool_calls",
				calls: [
					{
						name: "bash",
						args: (request: RecordedRequest) => ({
							command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n# Goal\nCache work.\n\n# Constraints\noperator chose: ${answerFromTranscript(request)}\n\n# Unknowns/Blockers\nnone\nEOF`,
						}),
					},
				],
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
							summary: "Plan written; the store choice came from the operator.",
							artifact_path: artifactPathOf(request),
							plan_summary: MINIMAL_PLAN_SUMMARY,
							self_assessment: {
								confidence: "high",
								scope: "S",
								blocking_unknowns: false,
								destructive_scope: false,
							},
						}),
					},
				],
			},
			{ kind: "text", text: "Reported; standing by." },
		],
		{ onExhausted: "repeat" },
	);
	const agentDir = createAgentDir({ provider });

	const asked: OperatorQuestion[] = [];
	const asker: Asker = {
		async ask(question) {
			asked.push(question);
			// `undefined` is a real answer: it means nobody answered.
			return options.answer === undefined ? undefined : { answer: options.answer, by: "fake operator (test)" };
		},
	};

	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...agentDir.env },
		...(options.operator ? { asker } : {}),
	});
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 2 });

	const issue = await post.ledger().create({
		title: "cache store research",
		project: "demo",
		delivery: "pipeline",
		kind: "research",
		slug: "t31",
	});
	await post.dispatch({ jobId: issue.id, task: "Plan the cache store.", model: planner, fetch: false });

	return {
		home: home.path,
		post,
		asked,
		jobId: issue.id,
		async cleanup() {
			await post.shutdown();
			pool.cleanup();
			agentDir.cleanup();
			repo.cleanup();
			home.cleanup();
			await provider.stop();
		},
	};
}

function artifactPathOf(request: RecordedRequest): string {
	const match = /(\/[^"'\s\\]*\/state\/artifacts\/[A-Za-z0-9_-]+\/report\.md)/.exec(JSON.stringify(request.body.messages ?? []));
	assert.ok(match, "no artifact path in the brief the worker was sent");
	return match[1] as string;
}

function jobIdOf(request: RecordedRequest): string {
	const match = /\/state\/artifacts\/([A-Za-z0-9_-]+)\/report\.md/.exec(artifactPathOf(request));
	assert.ok(match, "no job id in the artifact path");
	return match[1] as string;
}

// ---------------------------------------------------------------------------

test("t31: a planner's question reaches the operator and the answer reaches the worker", {
	skip: "ask_operator left the planner path (cur.3.1); see planner-blocked.test.ts",
	timeout: 180_000,
}, async (t) => {
	const b = await bench(t, { operator: true, answer: "SQLite" });
	t.after(() => b.cleanup());

	const held = await waitFor(
		() => readFleet(b.home).jobs.find((job) => job.job_id === b.jobId),
		(job) => job?.phase === "held",
		{ timeoutMs: 120_000, intervalMs: 200, what: "the planner's envelope" },
	);
	assert.ok(held);

	// 1. A human was asked, once, with the question and options the worker chose.
	assert.equal(b.asked.length, 1);
	assert.equal(b.asked[0]?.question, QUESTION);
	assert.deepEqual(b.asked[0]?.options, OPTIONS);
	assert.equal(b.asked[0]?.role, "planner");
	assert.ok((b.asked[0]?.timeout_ms ?? 0) > 0, "the asker is handed a deadline, not left to invent one");

	// 2. The answer reached the WORKER's context: the artifact quotes it, and the
	//    only way it could is through the tool result.
	const artifact = readFileSync(join(b.home, paths.artifactFile(b.jobId)), "utf8");
	assert.match(artifact, /operator chose: SQLite/);

	// 3. It is journaled as an exchange: asked, then closed with who answered.
	// A third line follows: the planner's report_result also opens a console
	// review (spec 2026-09-13), and this bench's operator is not in hold mode, so
	// that review is refused in one line and the envelope files as-is.
	const journal = b.post.questions.store.list(b.jobId);
	assert.equal(journal.length, 2, "the ask_operator exchange only; report_result does not open a review");
	assert.equal(journal[0]?.outcome, "timeout", "the open line is provisional until it closes");
	assert.equal(journal[1]?.outcome, "answered");
	assert.equal(journal[1]?.answer, "SQLite");
	assert.equal(journal[1]?.answered_by, "fake operator (test)");
	assert.equal(b.post.questions.store.open(b.jobId), undefined, "an answered exchange is not still open");

	// 4. The run log carries it, so `/watch` shows the exchange the parent's
	//    context never saw.
	const kinds = readEventLog(b.home, b.jobId)
		.filter((event: RunEvent) => event.source === "cp")
		.map((event: RunEvent) => event.type);
	assert.ok(kinds.includes("question_asked"), `no question_asked in ${kinds.join(", ")}`);
	assert.ok(kinds.includes("question_closed"));

	// 5. The envelope is unchanged by all of this: a headline, no answer, no body.
	const envelope = JSON.parse(readFileSync(join(b.home, paths.envelopeFile(b.jobId)), "utf8")) as {
		envelope: { summary: string; status: string };
	};
	assert.equal(envelope.envelope.status, "done");
	assert.ok(!envelope.envelope.summary.includes("SQLite"), "an answer is not envelope content");
});

test("t31: no answer is a legitimate outcome, and the worker still finishes", {
	skip: "ask_operator left the planner path (cur.3.1); see planner-blocked.test.ts",
	timeout: 180_000,
}, async (t) => {
	// An operator is attached but dismisses the dialog: the worker is told "no
	// answer" and must not stall, guess, or ask again.
	const b = await bench(t, { operator: true, answer: undefined });
	t.after(() => b.cleanup());

	const held = await waitFor(
		() => readFleet(b.home).jobs.find((job) => job.job_id === b.jobId),
		(job) => job?.phase === "held",
		{ timeoutMs: 120_000, intervalMs: 200, what: "the planner's envelope" },
	);
	assert.equal(held?.phase, "held", "a dismissed question still ends in a report");
	assert.equal(b.asked.length, 1);

	const artifact = readFileSync(join(b.home, paths.artifactFile(b.jobId)), "utf8");
	assert.match(artifact, /operator chose: NO-ANSWER/, "the worker saw the no-answer instruction, not a fabricated answer");

	const journal = b.post.questions.store.list(b.jobId);
	// [0]/[1] are the ask_operator exchange; [2] is report_result's own console
	// review, refused because this bench's operator is not in hold mode.
	assert.equal(journal[1]?.outcome, "cancelled");
	assert.equal(journal[1]?.answer, undefined, "nothing invents an answer on the record");
	assert.notEqual(journal.at(-1)?.outcome, "refused");
});

test("t31: with no operator attached the tool does not exist", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t, { operator: false });
	t.after(() => b.cleanup());

	// The spawn plan is the fact: no CP_ASK_OPERATOR, no ask_operator in the
	// allowlist. A worker that cannot reach a human is never told that it can.
	const plan = b.post.manager.plan({
		identity: {
			jobId: b.jobId,
			kind: "research",
			delivery: "pipeline",
			runDir: join(b.home, paths.runDir(b.jobId)),
			worktree: join(b.home, "wt"),
		},
		profile: loadProfile(join(REPO_ROOT, "profiles"), "planner"),
		model: "mock/whatever",
	});
	assert.ok(!plan.tools.includes(ASK_OPERATOR_TOOL));
	assert.equal(plan.env.CP_ASK_OPERATOR, undefined);
	assert.equal(b.post.questions.hasOperator, false);

	// The scripted planner calls ask_operator anyway. pi refuses a tool the
	// worker does not have, the run does not hang, and nothing is journaled as a
	// question — the whole point of failing closed.
	await waitFor(
		() => existsSync(join(b.home, paths.statusFile(b.jobId))),
		(there) => there,
		{ timeoutMs: 60_000, intervalMs: 200, what: "the worker's run to start" },
	);
	assert.deepEqual(b.post.questions.store.list(b.jobId), []);
	assert.deepEqual(b.asked, [], "an unreachable operator is never asked");
});

test("t31: an implementer never gets the ask tool, even with an operator present", { skip: SKIP, timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		asker: {
			async ask() {
				return { answer: "sure", by: "fake operator (test)" };
			},
		},
	});
	assert.equal(post.questions.hasOperator, true);

	const identity = {
		jobId: "cp-t31-ship",
		kind: "ship" as const,
		delivery: "local" as const,
		runDir: join(home.path, paths.runDir("cp-t31-ship")),
		worktree: join(home.path, "wt"),
	};
	const profiles = join(REPO_ROOT, "profiles");

	// The planner no longer asks (cur.3.1): questions are a blocked envelope.
	const planner = post.manager.plan({ identity, profile: loadProfile(profiles, "planner"), model: "mock/x" });
	assert.ok(!planner.tools.includes(ASK_OPERATOR_TOOL));
	assert.equal(planner.env.CP_ASK_OPERATOR, undefined);

	// … the implementer and the reviewer may not. An implementer that stops to
	// ask is an implementer not implementing, and a reviewer's whole value is a
	// fresh context with nobody in it.
	for (const role of ["implementer", "gate-reviewer"] as const) {
		const plan = post.manager.plan({ identity, profile: loadProfile(profiles, role), model: "mock/x" });
		assert.ok(!plan.tools.includes(ASK_OPERATOR_TOOL), `${role} must not hold ${ASK_OPERATOR_TOOL}`);
		assert.equal(plan.env.CP_ASK_OPERATOR, undefined, `${role} must not be told it can ask`);
	}
});
