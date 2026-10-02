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
import { test } from "node:test";
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

test("blocked planner questions wake the parent, then cp_send finishes the envelope", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	initJobsDocument(home.path, "cp");
	const reported: IntakeResult[] = [];
	const model = provider.addScript("planner-blocked", [
		{
			kind: "tool_calls",
			calls: [
				{
					name: "bash",
					args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${BODY}\nEOF` },
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
						status: "blocked",
						summary: "Need two product decisions.",
						artifact_path: artifactPathOf(request),
						blockers: [blocker("Which store?"), blocker("Which TTL?")],
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

	const waiting = await waitFor(
		() => readFleet(home.path).jobs.find((job) => job.job_id === issue.id),
		(job) => job?.reported_at !== undefined,
		{ timeoutMs: 120_000, intervalMs: 200, what: "the blocked envelope" },
	);
	assert.equal(waiting?.phase, "waiting", "a question is not a held session");
	assert.equal(waiting?.planner_blocked_rounds, 1);
	const wake = formatIntake(reported[0] as IntakeResult);
	assert.match(wake, /Which store\?/);
	assert.match(wake, /Which TTL\?/);
	assert.match(wake, /SQLite/);
	assert.ok(!wake.includes(BODY), wake);

	const sent = await post.send({ jobId: issue.id, message: "Store is SQLite. TTL is 300." });
	assert.equal(sent.receipt, "delivered");

	const done = await waitFor(
		() => readFleet(home.path).jobs.find((job) => job.job_id === issue.id),
		(job) => job?.planner_blocked_rounds === 1 && (job.supersessions ?? 0) >= 1 && job.reported_at !== undefined,
		{ timeoutMs: 120_000, intervalMs: 200, what: "the final envelope" },
	);
	assert.equal(done?.phase, "held");
	const envelope = JSON.parse(readFileSync(join(home.path, paths.envelopeFile(issue.id)), "utf8")) as {
		envelope: { status: string };
	};
	assert.equal(envelope.envelope.status, "done");
	assert.ok(!JSON.stringify(reported).includes(BODY));
});
