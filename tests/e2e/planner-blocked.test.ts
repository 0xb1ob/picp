/**
 * cur.3.1: a planner question is a blocked envelope, not a held session.
 *
 * Mock planner reports blocked with two questions → wake-up carries them →
 * cp_send resumes → final envelope. No artifact body in the wake-up.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { MINIMAL_PLAN_SUMMARY, paths } from "../../src/contracts.ts";
import { formatIntake, type IntakeResult } from "../../src/intake.ts";
import { initJobsDocument } from "../../src/ledger.ts";
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

const SKIP = treehouseAvailable() ? false : "planner-blocked e2e needs treehouse on PATH";
const BODY = "SECRET_ARTIFACT_BODY_MUST_NOT_TRAVEL";

function artifactPathOf(request: RecordedRequest): string {
	const match = /(\/[^"'\s\\]*\/state\/artifacts\/[A-Za-z0-9_-]+\/report\.md)/.exec(
		JSON.stringify(request.body.messages ?? []),
	);
	assert.ok(match, "no artifact path in the brief");
	return match[1] as string;
}

function jobIdOf(request: RecordedRequest): string {
	const match = /\/state\/artifacts\/([A-Za-z0-9_-]+)\/report\.md/.exec(artifactPathOf(request));
	assert.ok(match);
	return match[1] as string;
}

const blocker = (question: string) => ({
	question,
	why: "The plan cannot name a schema without it.",
	options: ["Postgres", "SQLite"],
	recommended: "SQLite",
	assume_if_unanswered: "SQLite",
});

type Script = Parameters<MockProvider["addScript"]>[1];

const writeArtifact: Script[number] = {
	kind: "tool_calls",
	calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${BODY}\nEOF` } }],
};

const reportBlocked = (summary: string, ...questions: string[]): Script[number] => ({
	kind: "tool_calls",
	calls: [
		{
			name: "report_result",
			args: (request: RecordedRequest) => ({
				job_id: jobIdOf(request),
				kind: "research",
				status: "blocked",
				summary,
				artifact_path: artifactPathOf(request),
				blockers: questions.map(blocker),
			}),
		},
	],
});

/** A CommandPost with one dispatched pipeline planner running `steps`; cleanup registers on `t`. */
async function startPlanner(t: TestContext, script: string, steps: Script) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	initJobsDocument(home.path, "cp");
	const reported: IntakeResult[] = [];
	const model = provider.addScript(script, steps);
	const agentDir = createAgentDir({ provider });
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...agentDir.env },
		onReported: (result) => reported.push(result),
	});
	t.after(async () => {
		await post.shutdown();
		await provider.stop();
		home.cleanup();
		repo.cleanup();
	});

	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 2 });
	t.after(() => pool.cleanup());

	const issue = await post.ledger().create({
		title: "plan the cache",
		project: "demo",
		delivery: "pipeline",
		kind: "research",
		slug: "blocked",
	});
	await post.dispatch({ jobId: issue.id, task: "Plan the cache store.", model, fetch: false });
	const job = () => readFleet(home.path).jobs.find((record) => record.job_id === issue.id);
	return { home, post, reported, jobId: issue.id, job };
}

test("blocked planner questions wake the parent, then cp_send finishes the envelope", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const { home, post, reported, jobId, job } = await startPlanner(t, "planner-blocked", [
		writeArtifact,
		reportBlocked("Need two product decisions.", "Which store?", "Which TTL?"),
		{
			kind: "tool_calls",
			calls: [
				{
					name: "report_result",
					args: (request: RecordedRequest) => ({
						job_id: jobIdOf(request),
						kind: "research",
						status: "done",
						summary: "Plan written from the answers.",
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
		{ kind: "text", text: "standing by" },
	]);

	const waiting = await waitFor(job, (record) => record?.reported_at !== undefined, {
		timeoutMs: 120_000,
		intervalMs: 200,
		what: "the blocked envelope",
	});
	assert.equal(waiting?.phase, "waiting", "a question is not a held session");
	assert.equal(waiting?.planner_blocked_rounds, 1);
	const wake = formatIntake(reported[0] as IntakeResult);
	assert.match(wake, /Which store\?/);
	assert.match(wake, /Which TTL\?/);
	assert.match(wake, /SQLite/);
	assert.ok(!wake.includes(BODY), wake);

	const sent = await post.send({ jobId, message: "Store is SQLite. TTL is 300." });
	assert.equal(sent.receipt, "delivered");

	const done = await waitFor(
		job,
		(record) => record?.planner_blocked_rounds === 1 && (record.supersessions ?? 0) >= 1 && record.reported_at !== undefined,
		{ timeoutMs: 120_000, intervalMs: 200, what: "the final envelope" },
	);
	assert.equal(done?.phase, "held");
	const envelope = JSON.parse(readFileSync(join(home.path, paths.envelopeFile(jobId)), "utf8")) as {
		envelope: { status: string };
	};
	assert.equal(envelope.envelope.status, "done");
	assert.ok(!JSON.stringify(reported).includes(BODY));
});

// E2E C (plan cp-testing-policy-review-q8u3): two answered blocked rounds, then a third blocked envelope raises one
// durable loop_exhausted escalation with no autonomous fourth answer or retry; a duplicate wake mints no second one.
test("a third blocked planner round escalates loop_exhausted once and is not answered", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const { post, reported, jobId, job } = await startPlanner(t, "planner-exhausted", [
		writeArtifact,
		reportBlocked("Round one.", "Which store?"),
		reportBlocked("Round two.", "Which TTL?"),
		reportBlocked("Round three.", "Which region?"),
		{ kind: "text", text: "standing by" },
	]);
	const roundReported = (round: number) =>
		waitFor(job, (record) => record?.planner_blocked_rounds === round && reported.length === round, {
			timeoutMs: 120_000,
			intervalMs: 200,
			what: `blocked round ${round}`,
		});

	for (const [round, answer] of [[1, "Store is SQLite."], [2, "TTL is 300."]] as const) {
		const waiting = await roundReported(round);
		assert.equal(waiting?.phase, "waiting");
		assert.equal(reported.at(-1)?.next, "answer", `round ${round} is the parent's to answer`);
		assert.equal(reported.at(-1)?.escalation_id, undefined);
		assert.equal((await post.send({ jobId, message: answer })).receipt, "delivered");
	}

	const exhausted = await roundReported(3);
	assert.equal(exhausted?.phase, "waiting");
	assert.equal(exhausted?.supersessions, 2, "only the two answered rounds promoted the worker");
	const third = reported.at(-1) as IntakeResult;
	assert.equal(third.next, "escalate");
	assert.ok(third.escalation_id, "the third round names its escalation");
	assert.match(formatIntake(third), /loop exhausted\): do not answer these blockers/);

	const escalations = () => post.escalations.list({ jobId, kind: "loop_exhausted" });
	assert.deepEqual(escalations().map((item) => [item.id, item.status]), [[third.escalation_id, "open"]]);

	// Duplicate wakes: a replayed intake and a reconcile re-read the same envelope.
	const replay = await post.intake.intake(jobId);
	assert.equal(replay.already, true);
	await post.reconcile();
	assert.equal(escalations().length, 1, "a duplicate wake must not mint a second escalation");
	assert.equal(reported.filter((result) => result.next === "escalate" && !result.already).length, 1);

	const after = job();
	assert.equal(after?.phase, "waiting");
	assert.equal(after?.supersessions, 2, "nothing answered or retried the exhausted planner");
	assert.equal(after?.planner_blocked_rounds, 3);
});
