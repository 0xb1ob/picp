/**
 * cur.7: the whole autonomy mission, on the mock provider, driven by one
 * mandate — no human message after it is issued.
 *
 * One pipeline job: mandate issue -> planner blocked question -> cp_send
 * answers it -> gate revise, then pass -> the checkpoint auto-approves under
 * the mandate (`plan_approval` is not in its `ask_on`, cp-3ky) -> implementer
 * pushes a branch and opens a PR -> CI green (a scripted `gh` on `PATH`, real
 * `git`) -> and from the envelope on, **no call from this test**: the held-PR
 * continuation (jje.2) starts the real `cp_review`, whose passing verdict runs
 * `cp_integrate`'s real merge sequence to a closed job. Then `cp_next` recommends a second, independent
 * job (continuation), and once it closes too, every job the mandate named is
 * closed and `cp_next` raises the mission-end escalation exactly once.
 *
 * Every other e2e file in this directory is one drill (`docs/autonomy.md`'s
 * table); this is the one file that runs the drills' happy-path neighbours
 * back to back, in the order a mission actually visits them.
 *
 * `npm test` picks this up like every other gate.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, MINIMAL_PLAN_SUMMARY, SCHEMA_VERSION, paths } from "../../src/contracts.ts";
import { cpNext } from "../../src/next.ts";
import { initJobsDocument } from "../../src/ledger.ts";
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
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "the mission e2e needs treehouse on PATH";
const PR_URL = "https://github.com/example/demo/pull/91";

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

/** The implementer's brief points at its own task file — that is how a canned script learns the ship job's id. */
function shipJobIdOf(request: RecordedRequest): string {
	const match = /state\/runs\/([A-Za-z0-9_-]+)\/task\.md/.exec(JSON.stringify(request.body.messages ?? []));
	assert.ok(match, "no ship job id in the implementer's brief");
	return match[1] as string;
}

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
					reasons: ["the artifact names an exact config key"],
					...overrides,
				},
			},
		],
		usage: { prompt_tokens: 900, completion_tokens: 50 },
	};
}

/** Writes a `cp_review`-shaped diff verdict straight to disk (the same fixture shape `writeReviewPass` uses elsewhere). */
/** A `gh` that answers `pr view`/`api pulls`/`run list`/`pr merge` by asking real `git` what is actually on origin — no fixture to drift. */
function writeFakeGh(bin: string, branch: string, prUrl: string, stateFile: string): void {
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env node
const { execSync } = require("child_process");
const { existsSync, readFileSync, writeFileSync } = require("fs");
const args = process.argv.slice(2);
const branch = ${JSON.stringify(branch)};
const prUrl = ${JSON.stringify(prUrl)};
const stateFile = ${JSON.stringify(stateFile)};
function head() {
  return execSync("git ls-remote origin refs/heads/" + branch, { cwd: process.cwd() }).toString().split("\t")[0].trim();
}
function merged() {
  return existsSync(stateFile) && readFileSync(stateFile, "utf8").trim() === "merged";
}
if (args[0] === "pr" && args[1] === "view") {
  const isMerged = merged();
  const out = {
    number: 91, url: prUrl,
    state: isMerged ? "MERGED" : "OPEN",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    headRefName: branch, headRefOid: head(), baseRefName: "main",
    isDraft: false, autoMergeRequest: null,
  };
  if (isMerged) { out.mergedAt = new Date().toISOString().slice(0, 19) + "Z"; out.mergeCommit = { oid: "f".repeat(40) }; }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
if (args[0] === "api" && (args[1] || "").endsWith("pulls/91")) {
  process.stdout.write(JSON.stringify({ number: 91, html_url: prUrl, state: merged() ? "closed" : "open", merged: merged(), head: { sha: head(), ref: branch } }));
  process.exit(0);
}
if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ status: "completed", conclusion: "success", headSha: head(), workflowName: "ci" }]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "merge") {
  writeFileSync(stateFile, "merged\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh " + args.join(" ") + "\\n");
process.exit(1);
`,
	);
	chmodSync(join(bin, "gh"), 0o755);
}

test(
	"mission: mandate -> blocked question -> gate -> auto-approve -> implement -> review -> CI green -> integrate -> job two -> mission end",
	{ skip: SKIP, timeout: 600_000 },
	async (t) => {
		const home = createScratchHome();
		const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "config.txt": "timeout=10\n" } });
		const provider = await MockProvider.start();
		const agentDir = createAgentDir({ provider });
		initJobsDocument(home.path, "cp");

		const planner = provider.addScript(
			"mission-planner",
			[
				{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\ndraft\nEOF` } }] },
				{
					kind: "tool_calls",
					calls: [
						{
							name: "report_result",
							args: (request: RecordedRequest) => ({
								job_id: jobIdOf(request),
								kind: "research",
								status: "blocked",
								summary: "Need to know which timeout config governs this.",
								artifact_path: artifactPathOf(request),
								blockers: [
									{
										question: "Which timeout config governs the request?",
										why: "The plan cannot name a value without it.",
										options: ["config.txt", "env var"],
										recommended: "config.txt",
										assume_if_unanswered: "config.txt",
									},
								],
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
								summary: "Plan written from the answer: bump config.txt's timeout.",
								artifact_path: artifactPathOf(request),
								plan_summary: MINIMAL_PLAN_SUMMARY,
								self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false },
							}),
						},
					],
				},
				{ kind: "text", text: "standing by" },
			],
			{ onExhausted: "repeat" },
		);
		const reviewerSteps: ScriptStep[] = [];
		const reviewer = provider.addScript("mission-gate", reviewerSteps);
		const implementerSteps: ScriptStep[] = [
			{
				kind: "tool_calls",
				calls: [
					{
						name: "bash",
						args: (request: RecordedRequest) => {
							const jobId = shipJobIdOf(request);
							return { command: `printf 'timeout=30\\n' > config.txt && git add -A && git commit -q -m 'bump timeout' && git push -q -u origin ${jobId}` };
						},
					},
				],
				usage: { prompt_tokens: 900, completion_tokens: 80 },
			},
			{
				kind: "tool_calls",
				calls: [
					{
						name: "report_result",
						args: (request: RecordedRequest) => {
							const jobId = shipJobIdOf(request);
							const headSha = execFileSync("git", ["ls-remote", repo.remote as string, `refs/heads/${jobId}`], { encoding: "utf8" }).split("\t")[0]?.trim();
							assert.match(headSha ?? "", /^[0-9a-f]{40}$/);
							return {
								job_id: jobId,
								kind: "ship",
								status: "done",
								summary: "Bumped the timeout to 30 and opened a PR.",
								branch: jobId,
								pr_url: PR_URL,
								head_sha: headSha,
							};
						},
					},
				],
				usage: { prompt_tokens: 700, completion_tokens: 60 },
			},
			{ kind: "text", text: "standing by" },
		];
		const implementer = provider.addScript("mission-ship", implementerSteps, { onExhausted: "repeat" });
		agentDir.writeModels(provider);

		mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
		writeFileSync(
			join(home.path, LAYOUT.data, "routing.json"),
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

		const sent: ReviewWakeup[] = [];
		const post = new CommandPost({
			home: home.path,
			packageRoot: REPO_ROOT,
			parentEnv: { ...process.env, ...agentDir.env },
			// jje.2: this test plays the live parent that owns the home and continues held PRs itself.
			continuation: true,
			holdsParentLock: () => true,
		});
		post.reviewRuns.wakeupPort = (wakeup) => (sent.push(wakeup), true);

		const originalPath = process.env.PATH;
		t.after(async () => {
			process.env.PATH = originalPath;
			await post.shutdown();
			await provider.stop();
			agentDir.cleanup();
			repo.cleanup();
			home.cleanup();
		});

		await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
		const clone = post.registry.pathOf("demo");
		execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
		const pool = enableTreehouse(clone, { maxTrees: 4 });
		t.after(() => pool.cleanup());

		// --- one mandate, no human message after this ------------------------
		const jobTwo = await post.ledger().create({ title: "second job", project: "demo", delivery: "local", kind: "ship" });
		const started = await post.startPipeline({
			title: "bump the timeout",
			project: "demo",
			task: "Bump the request timeout in config.txt.",
			slug: "mission",
			fetch: false,
		});
		assert.equal(started.dispatch.receipt, "accepted");
		const { research_id: researchId, ship_id: shipId } = started;
		// CI is green for whatever origin holds (scripted `gh`, real `git`) before the implementer ever reports.
		const bin = join(home.path, "bin");
		writeFakeGh(bin, shipId, PR_URL, join(home.path, "gh-state"));
		process.env.PATH = `${bin}:${originalPath ?? ""}`;

		const mandate = post.mandates.issue({
			projects: ["demo"],
			objective: "land the mission: bump the timeout, then the second job",
			expiry: "2099-01-01T00:00:00Z",
			spend_cap: { usd: 100, tokens: 10_000_000 },
			job_cap: 10,
			job_ids: [researchId, shipId, jobTwo.id],
		});
		assert.equal(mandate.status, "active");

		// --- planner blocked question -> the operator's mandate answers it ---
		const artifactPath = post.artifacts.file(researchId);
		// The gate's own predicate (non-empty), not existsSync (H7).
		await waitFor(() => post.artifacts.has(researchId), (there: boolean) => there, { timeoutMs: 60_000, what: "the planner's artifact" });
		const waiting = await waitFor(
			() => readFleet(home.path).jobs.find((job) => job.job_id === researchId),
			(job) => job?.reported_at !== undefined,
			{ timeoutMs: 60_000, what: "the blocked envelope" },
		);
		assert.equal(waiting?.phase, "waiting", "a planner question is not a held session");
		const sentResult = await post.send({ jobId: researchId, message: "Use config.txt." });
		assert.equal(sentResult.receipt, "delivered");

		// --- gate: revise, then pass ------------------------------------------
		await waitFor(
			() => readFleet(home.path).jobs.find((job) => job.job_id === researchId),
			(job) => job?.phase === "held" && (job.planner_blocked_rounds ?? 0) >= 1,
			{ timeoutMs: 60_000, what: "the plan, after the answer" },
		);
		reviewerSteps.push(
			verdict(researchId, { verdict: "revise", reasons: ["name the file explicitly"], revisions: ["say config.txt"] }),
			verdict(researchId, {}),
			// The diff review the continuation starts on its own, once the PR is reported.
			verdict(shipId, { reasons: ["the diff does what the brief asked"] }),
		);
		const advanceThrough = async () => {
			let result = await post.advancePipeline(researchId);
			for (let guard = 0; result.pending && guard < 10; guard += 1) {
				const owner = result.pending.surface === "review" ? shipId : researchId;
				const key = ReviewRuns.key(owner, result.pending.surface, result.pending.attempt);
				post.reviewRuns.handBack(key);
				await post.reviewRuns.settled(key);
				result = await post.advancePipeline(researchId);
			}
			return result;
		};
		const revise = await advanceThrough();
		assert.equal(revise.state, "gating");
		writeFileSync(artifactPath, `${readFileSync(artifactPath, "utf8")}\n# Revision\nconfig.txt names the key.\n`);
		const future = new Date(Date.now() + 2000);
		utimesSync(artifactPath, future, future);

		// --- gate pass -> the checkpoint auto-approves under the mandate -------
		const pass = await advanceThrough();
		assert.equal(pass.state, "implementing", "the mandate approved the checkpoint with no human turn");
		const checkpoint = post.checkpoints.get(shipId);
		assert.equal(checkpoint?.decision, "approved");
		assert.match(String(checkpoint?.decided_by), /^mandate:/);
		assert.equal((await post.ledger().show(researchId)).status, "closed");

		// --- implement -> review -> merge -> teardown -> close, with no call from here ---
		// The envelope starts the continuation: CI is green, so it starts the real
		// cp_review; the reviewer's pass resumes it at verdict due time, and it runs
		// cp_integrate's sequence to the end. Nothing below calls integrate or review.
		await waitFor(
			() => post.integrator.get(shipId)?.step,
			(step) => step === "done",
			{ timeoutMs: 300_000, what: "the held PR to land by itself" },
		);
		const landed = readFleet(home.path).jobs.find((job) => job.job_id === shipId);
		assert.equal(landed?.phase, "done");
		assert.equal(landed?.receipts?.find((r) => r.kind === "pr")?.url, PR_URL);
		assert.equal(landed?.closed_reason, "gated", "torn down through the gate, never forced");
		assert.equal(post.integrator.endState(shipId).merge_receipt, true);
		assert.equal((await post.ledger().show(shipId)).status, "closed");
		assert.equal(readFileSync(join(home.path, "gh-state"), "utf8").trim(), "merged");
		assert.equal(existsSync(join(home.path, paths.reviewFile(shipId, 1))), true, "the continuation's own review passed on the pushed head");
		const notices = post.durableWakeups.pending().map((entry) => entry.content);
		assert.equal(notices.filter((content) => /HELD PR LANDED — /.test(content)).length, 1, "one landing notice for the operator");
		assert.ok(sent.some((wakeup) => wakeup.jobId === shipId && wakeup.surface === "review"), "the verdict still wakes the parent");
		process.env.PATH = originalPath;

		// --- continuation: cp_next dispatches the second, independent job -------
		const nextPorts = { ledger: post.ledger(), fleet: post.fleet, mandates: post.mandates, escalations: post.escalations, pipelines: post.pipelines };
		const continuation = await cpNext(nextPorts, "demo");
		assert.equal(continuation.action.kind, "dispatch");
		assert.equal(continuation.action.job_id, jobTwo.id, "the second job dispatches on its own, no operator message");

		const jobTwoScript = provider.addScript(
			"mission-job-two",
			[
				{
					kind: "tool_calls",
					calls: [{ name: "bash", args: { command: `printf 'ok\\n' > second.txt && git add -A && git commit -q -m 'second job' && git push -q -u origin ${jobTwo.id}` } }],
				},
				{
					kind: "tool_calls",
					calls: [{ name: "report_result", args: { job_id: jobTwo.id, kind: "ship", status: "done", summary: "Landed the second job.", branch: jobTwo.id } }],
				},
				{ kind: "text", text: "standing by" },
			],
			{ onExhausted: "repeat" },
		);
		agentDir.writeModels(provider);
		const dispatchedTwo = await post.dispatch({ jobId: jobTwo.id, task: "Write second.txt.", model: jobTwoScript, fetch: false });
		assert.equal(dispatchedTwo.receipt, "accepted");
		await waitFor(
			() => readFleet(home.path).jobs.find((job) => job.job_id === jobTwo.id),
			(job) => job?.reported_at !== undefined,
			{ timeoutMs: 60_000, what: "the second job's envelope" },
		);
		const tornTwo = await post.tearDown(jobTwo.id);
		assert.equal(tornTwo.torn_down, true, JSON.stringify(tornTwo));
		await post.ledger().close(jobTwo.id, "landed the second job");
		assert.equal((await post.ledger().show(jobTwo.id)).status, "closed");

		// --- mission end: every named job landed clean, so the grant closes itself (answered once, revoked) -----
		const missionEnd = await cpNext(nextPorts, "demo");
		assert.equal(missionEnd.action.kind, "mission_end");
		assert.ok(missionEnd.escalation_id);
		const again = await cpNext(nextPorts, "demo");
		assert.equal(again.action.kind, "no_mandate", "the closed grant is revoked, never evaluated again");
		const ends = post.escalations.list({ kind: "mission_end" }).filter((e) => e.job_ids.includes(shipId));
		assert.deepEqual(ends.map((e) => [e.id, e.status, e.answer]), [[missionEnd.escalation_id, "answered", "close"]]);

		void sent;
	},
);
