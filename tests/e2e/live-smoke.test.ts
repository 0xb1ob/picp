/**
 * Live smokes — OPERATOR RUN ONLY, never in CI.
 *
 *   CP_LIVE_TESTS=1 npm run smoke:live
 *   CP_LIVE_TESTS=1 CP_LIVE_MODEL=anthropic/claude-haiku-4-5 npm run smoke:live
 *
 * Each smoke is the milestone round trip against a REAL model, with a small
 * token budget. They cost money and can fail for provider reasons, so they are
 * skipped unless CP_LIVE_TESTS=1. The mock-provider milestones remain the gate.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type EnvelopeRecord, paths, validateEnvelope } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import type { Authorizer } from "../../src/pipeline.ts";
import { assembleBrief, loadProfile, readBriefTemplate } from "../../src/profiles.ts";
import { RunRecorder } from "../../src/run-artifacts.ts";
import { WorkerManager } from "../../src/worker-manager.ts";
import {
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	git,
	LIVE_TESTS_ENABLED,
	readFleet,
	readRunStatus,
	REPO_ROOT,
	treehouseAvailable,
	waitFor,
	WORKER_REPORTER_EXTENSION,
} from "../harness/index.ts";

const LIVE_MODEL = process.env.CP_LIVE_MODEL ?? "anthropic/claude-haiku-4-5";
/** Hard ceiling for the smoke; breaching it fails the test rather than the wallet. */
const LIVE_TOKEN_BUDGET = Number(process.env.CP_LIVE_TOKEN_BUDGET ?? 60_000);

test(
	"live smoke (m1): a real model completes the worker round trip",
	{ timeout: 300_000, skip: LIVE_TESTS_ENABLED ? false : "set CP_LIVE_TESTS=1 to run live smokes" },
	async (t) => {
		const jobId = "cp-live1";
		const repo = createScratchRepo({
			name: "live",
			files: {
				"README.md": "# live smoke\n\nA tiny repo used by the pi-command-post live smoke.\n",
				"src/version.txt": "1\n",
			},
		});
		const home = createScratchHome();
		const runDir = join(home.path, paths.runDir(jobId));
		mkdirSync(runDir, { recursive: true });
		repo.git("checkout", "--quiet", "-b", jobId);

		const profile = loadProfile(join(REPO_ROOT, "profiles"), "implementer");
		const brief = assembleBrief({
			profile,
			template: readBriefTemplate(join(REPO_ROOT, "prompts/briefs"), profile.frontmatter.briefTemplate),
			values: {
				job_id: jobId,
				branch: jobId,
				base: repo.branch,
				worktree: repo.path,
				project: "live",
				kind: "ship",
				delivery: "local",
				task: "Change the single number in src/version.txt from 1 to 2, commit it with message 'bump version', and report. Do not touch anything else. There is no test suite and no remote: do not push, do not open a PR.",
			},
		});

		const manager = new WorkerManager({
			home: home.path,
			workerReporterPath: WORKER_REPORTER_EXTENSION,
		});
		const recorder = RunRecorder.open({ home: home.path, jobId, flushIntervalMs: 100 });
		const managed = manager.spawn({
			identity: { jobId, kind: "ship", delivery: "local", runDir, worktree: repo.path },
			profile,
			model: LIVE_MODEL,
			brief,
			sessionDir: join(home.path, "sessions"),
		});
		recorder.markSpawned({ pid: managed.worker.pid, model: LIVE_MODEL, profile: profile.frontmatter.name });
		recorder.attach(managed.worker);
		t.after(async () => {
			await manager.shutdownAll();
			recorder.close();
			repo.cleanup();
			home.cleanup();
		});

		await managed.worker.getState(60_000);
		const receipt = await managed.worker.send(brief);
		assert.equal(receipt.receipt, "delivered");

		// Real models take turns; wait for the envelope, not for a fixed count.
		await waitFor(
			() => readRunStatus(home.path, jobId),
			(status) => status.phase === "idle" || status.usage.total_tokens > LIVE_TOKEN_BUDGET,
			{ timeoutMs: 240_000, intervalMs: 500, what: "worker to settle" },
		);

		const status = readRunStatus(home.path, jobId);
		assert.ok(
			status.usage.total_tokens <= LIVE_TOKEN_BUDGET,
			`live smoke exceeded its budget: ${status.usage.total_tokens} > ${LIVE_TOKEN_BUDGET} tokens`,
		);

		const record = JSON.parse(readFileSync(join(runDir, "envelope.json"), "utf8")) as EnvelopeRecord;
		const validation = validateEnvelope(record.envelope, {
			job_id: jobId,
			kind: "ship",
			delivery: "local",
			worktree: repo.path,
		});
		assert.ok(validation.ok, validation.ok ? "" : validation.errors.join("; "));
		assert.equal(record.envelope.status, "done", `worker reported: ${record.envelope.summary}`);
		assert.equal(readFileSync(join(repo.path, "src/version.txt"), "utf8").trim(), "2");
		assert.ok(repo.isClean(), "a done ship job leaves a clean tree");

		const exit = await managed.worker.shutdown();
		assert.equal(exit.code, 0);
		const finalStatus = await waitFor(
			() => readRunStatus(home.path, jobId),
			(value) => value.phase === "exited",
			{ what: "exited projection" },
		);
		assert.equal(finalStatus.exit_code, 0);
		console.log(
			`[live smoke] model=${LIVE_MODEL} turns=${finalStatus.turns} tools=${finalStatus.tool_calls} tokens=${finalStatus.usage.total_tokens} cost=$${finalStatus.usage.cost_usd.toFixed(4)}`,
		);
	},
);

test(
	"live smoke (m2): one local-delivery job from intake to teardown",
	{
		timeout: 600_000,
		skip: !LIVE_TESTS_ENABLED
			? "set CP_LIVE_TESTS=1 to run live smokes"
			: treehouseAvailable()
				? false
				: "br and treehouse must be installed",
	},
	async (t) => {
		// The full parent path against a real model: intake -> dispatch -> the
		// worker's own envelope -> teardown gates. delivery:local, so nothing is
		// pushed anywhere and no PR is opened.
		const home = createScratchHome();
		const repo = createScratchRepo({
			name: "demo",
			files: { "README.md": "# live m2\n", "src/version.txt": "1\n" },
		});
		initJobsDocument(home.path, "cp");

		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
		execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
		const clone = post.registry.pathOf("demo");
		const pool = enableTreehouse(clone, { maxTrees: 2 });
		t.after(async () => {
			await post.shutdown();
			pool.cleanup();
			repo.cleanup();
			home.cleanup();
		});

		const issue = await post.ledger().create({
			title: "bump the version file",
			project: "demo",
			delivery: "local",
			kind: "ship",
			slug: "live-bump",
		});

		const dispatched = await post.dispatch({
			jobId: issue.id,
			task: "Change the single number in src/version.txt from 1 to 2 and commit it with message 'bump version'. Do not push and do not open a PR: this job is delivery:local.",
			model: LIVE_MODEL,
		});
		assert.equal(dispatched.state, "dispatched");

		const held = await waitFor(
			() => readFleet(home.path).jobs[0],
			(record) =>
				record?.phase === "held" || readRunStatus(home.path, issue.id).usage.total_tokens > LIVE_TOKEN_BUDGET,
			{ timeoutMs: 480_000, intervalMs: 1000, what: "the worker's envelope" },
		);
		const status = readRunStatus(home.path, issue.id);
		assert.ok(
			status.usage.total_tokens <= LIVE_TOKEN_BUDGET,
			`live smoke exceeded its budget: ${status.usage.total_tokens} > ${LIVE_TOKEN_BUDGET} tokens`,
		);
		assert.equal(held?.phase, "held");
		assert.equal(readFileSync(join(dispatched.worktree, "src/version.txt"), "utf8").trim(), "2");
		assert.equal(git(dispatched.worktree, "status", "--porcelain"), "", "a done ship job leaves a clean tree");

		const torn = await post.tearDown(issue.id);
		assert.equal(torn.torn_down, true, JSON.stringify(torn));
		assert.equal(readFleet(home.path).jobs[0]?.phase, "done");
		await post.ledger().close(issue.id, "live smoke: local delivery verified");

		console.log(
			`[live smoke m2] model=${LIVE_MODEL} job=${issue.id} turns=${status.turns} tools=${status.tool_calls} tokens=${status.usage.total_tokens} cost=$${status.usage.cost_usd.toFixed(4)} teardown=${torn.reason}`,
		);
	},
);

test(
	"live smoke (m3): a real pipeline reaches a real verdict and a real checkpoint",
	{
		timeout: 900_000,
		skip: !LIVE_TESTS_ENABLED
			? "set CP_LIVE_TESTS=1 to run live smokes"
			: treehouseAvailable()
				? false
				: "br and treehouse must be installed",
	},
	async (t) => {
		// research -> artifact -> gate (a real reviewer, a real verdict with a
		// cause) -> checkpoint -> implementer dispatch. delivery:local, so nothing
		// is pushed and no PR is opened. Two live workers plus one reviewer, so the
		// budget below is per job, checked after each stage.
		const home = createScratchHome();
		const repo = createScratchRepo({
			name: "demo",
			files: { "README.md": "# live m3\n", "src/version.txt": "1\n" },
		});
		initJobsDocument(home.path, "cp");

		const asked: string[] = [];
		// The smoke answers its own checkpoint, and says so on the record: an
		// unattended run is exactly the case where "who authorized this?" matters.
		const authorizer: Authorizer = {
			async ask(checkpoint) {
				asked.push(checkpoint.job_id);
				return { approved: true, by: "live smoke (unattended)" };
			},
		};
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, authorizer });
		await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
		execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
		const clone = post.registry.pathOf("demo");
		const pool = enableTreehouse(clone, { maxTrees: 3 });
		t.after(async () => {
			await post.shutdown();
			pool.cleanup();
			repo.cleanup();
			home.cleanup();
		});

		const started = await post.startPipeline({
			title: "bump the version file",
			project: "demo",
			task: "Plan the change that sets the single number in src/version.txt from 1 to 2. It is one file and one line: keep the plan short, name the file, and give a test plan that says there is no suite.",
			delivery: "local",
			slug: "live-pipeline",
			model: LIVE_MODEL,
		});
		const { research_id: researchId, ship_id: shipId } = started;
		assert.equal(started.dispatch.receipt, "accepted");

		await waitFor(
			() => readFleet(home.path).jobs.find((job) => job.job_id === researchId),
			(job) =>
				job?.phase === "held" || readRunStatus(home.path, researchId).usage.total_tokens > LIVE_TOKEN_BUDGET,
			{ timeoutMs: 480_000, intervalMs: 1000, what: "the research envelope" },
		);
		const researchStatus = readRunStatus(home.path, researchId);
		assert.ok(
			researchStatus.usage.total_tokens <= LIVE_TOKEN_BUDGET,
			`research exceeded its budget: ${researchStatus.usage.total_tokens} > ${LIVE_TOKEN_BUDGET} tokens`,
		);

		// A real reviewer on a real artifact: any verdict is a pass for the smoke,
		// as long as it is a *decided* one with the cause the contract requires.
		const advanced = await post.advancePipeline(researchId);
		const verdict = advanced.gate?.verdict;
		assert.ok(verdict, `no gate decision: ${advanced.message}`);
		assert.ok(["pass", "revise", "escalate"].includes(verdict.verdict));
		assert.equal(verdict.cause === null, verdict.verdict !== "escalate", "cause is null exactly on pass/revise");

		if (verdict.verdict === "pass") {
			assert.deepEqual(asked, [shipId], "a passed gate asks for authorization, once");
			assert.equal(post.checkpoints.get(shipId)?.decision, "approved");
			assert.equal(advanced.state, "implementing");
			assert.equal(advanced.dispatch?.receipt, "accepted");
			// The artifact reached the implementer as a file, unread by the parent.
			assert.ok(readFileSync(join(home.path, paths.taskFile(shipId)), "utf8").length > 0);
			await post.tearDown(shipId, { force: true });
		} else {
			assert.equal(asked.length, 0, "only a passed gate reaches a human");
		}
		await post.tearDown(researchId, { force: true });

		console.log(
			`[live smoke m3] model=${LIVE_MODEL} research=${researchId} verdict=${verdict.verdict} cause=${verdict.cause} ` +
				`reviewer=${verdict.model} tokens=${researchStatus.usage.total_tokens} cost=$${researchStatus.usage.cost_usd.toFixed(4)}`,
		);
	},
);
