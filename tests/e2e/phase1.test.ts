/**
 * MILESTONE m1 — worker lifecycle round trip, end to end, on the mock provider.
 *
 * profile + brief -> spawn (trust policy) -> events teed -> status.json phase
 * transitions -> validated envelope -> graceful shutdown with observed close.
 *
 * Deterministic and free: `npm run e2e:phase1`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	type EnvelopeRecord,
	type JobPhase,
	paths,
	type RunPhase,
	validateEnvelope,
} from "../../src/contracts.ts";
import { assembleBrief, loadProfile, readBriefTemplate } from "../../src/profiles.ts";
import { projectEvents, RunRecorder } from "../../src/run-artifacts.ts";
import { WorkerManager } from "../../src/worker-manager.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readRunEvents,
	readRunStatus,
	REPO_ROOT,
	waitFor,
	WORKER_REPORTER_EXTENSION,
} from "../harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");

test("m1: full worker lifecycle on the mock provider", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-m1ship";
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "m1", files: { "README.md": "# m1\n", "src/app.ts": "export const x = 1;\n" } });
	const home = createScratchHome();
	const agentDir = createAgentDir({ provider });

	// --- profile + brief (pure) -------------------------------------------
	const profile = loadProfile(PROFILES_DIR, "implementer");
	const template = readBriefTemplate(BRIEFS_DIR, profile.frontmatter.briefTemplate);
	repo.git("checkout", "--quiet", "-b", jobId);
	const brief = assembleBrief({
		profile,
		template,
		values: {
			job_id: jobId,
			branch: jobId,
			base: repo.branch,
			worktree: repo.path,
			project: "m1",
			kind: "ship",
			delivery: "local",
			task: "Bump x to 2 in src/app.ts and commit it.",
		},
	});
	assert.ok(brief.includes(jobId) && !brief.includes("${"));

	// --- scripted worker --------------------------------------------------
	const envelope = {
		job_id: jobId,
		kind: "ship" as const,
		status: "done" as const,
		summary: "Bumped x to 2; committed on the job branch.",
		branch: jobId,
	};
	const model = provider.addScript("m1", [
		{
			kind: "tool_calls",
			calls: [
				{
					name: "bash",
					args: {
						command:
							"printf 'export const x = 2;\\n' > src/app.ts && git add -A && git commit -q -m 'bump x' && git status --porcelain | wc -l",
					},
				},
			],
			usage: { prompt_tokens: 1500, completion_tokens: 80 },
		},
		{ kind: "tool_calls", calls: [{ name: "report_result", args: envelope }], usage: { prompt_tokens: 1800, completion_tokens: 60 } },
	]);
	agentDir.writeModels(provider);

	// --- spawn with the full safety policy --------------------------------
	const runDir = join(home.path, paths.runDir(jobId));
	mkdirSync(runDir, { recursive: true });
	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const recorder = RunRecorder.open({ home: home.path, jobId, flushIntervalMs: 20 });
	const managed = manager.spawn({
		identity: { jobId, kind: "ship", delivery: "local", runDir, worktree: repo.path },
		profile,
		model,
		brief,
		sessionDir: join(home.path, "sessions"),
		extraArgs: [],
	});
	recorder.markSpawned({
		pid: managed.worker.pid,
		model,
		profile: profile.frontmatter.name,
	});
	recorder.attach(managed.worker);

	t.after(async () => {
		await manager.shutdownAll();
		recorder.close();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	// Trust policy is in the argv that actually spawned.
	for (const flag of ["--no-approve", "--no-extensions", "--no-skills"]) {
		assert.ok(managed.plan.args.includes(flag), `missing ${flag}`);
	}
	assert.ok(managed.plan.budget.tokens > 0);

	// --- deliver the brief (receipt is a fact) ----------------------------
	const state = await managed.worker.getState(30_000);
	assert.equal(state.isStreaming, false);
	// Durability: the worker owns a session file under our session dir. pi writes
	// it lazily, so existence is asserted after the run (below), not here.
	const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined;
	assert.ok(sessionFile?.startsWith(join(home.path, "sessions")), `unexpected session file ${sessionFile}`);

	const receipt = await managed.worker.send(brief);
	assert.equal(receipt.receipt, "delivered");

	await managed.worker.waitForSettled(90_000);

	// --- the worker did the job ------------------------------------------
	assert.equal(readFileSync(join(repo.path, "src/app.ts"), "utf8"), "export const x = 2;\n");
	assert.ok(repo.isClean(), "worker left the tree clean");
	assert.equal(repo.git("log", "-1", "--pretty=%s"), "bump x");
	assert.ok(existsSync(sessionFile as string), "the session persists, so a held worker can be revived");

	// --- envelope is valid against the contract --------------------------
	const record = JSON.parse(readFileSync(join(runDir, "envelope.json"), "utf8")) as EnvelopeRecord;
	const validation = validateEnvelope(record.envelope, {
		job_id: jobId,
		kind: "ship",
		delivery: "local",
		worktree: repo.path,
	});
	assert.ok(validation.ok, validation.ok ? "" : validation.errors.join("; "));
	assert.deepEqual(record.envelope, envelope);
	recorder.markEnvelope({ status: record.envelope.status, attempt: record.attempt });

	// --- run artifacts are the read surface ------------------------------
	const status = await waitFor(
		() => readRunStatus(home.path, jobId),
		(value) => value.phase === "idle" && value.reported,
		{ what: "reported + idle projection" },
	);
	assert.equal(status.tool_calls, 2);
	assert.equal(status.turns, 2);
	assert.equal(status.current_tool, null);
	assert.equal(status.model, model);
	assert.equal(status.profile, "implementer");
	assert.ok(status.usage.total_tokens >= 1800, `usage should accumulate, got ${status.usage.total_tokens}`);

	const events = readRunEvents(home.path, jobId);
	const types = events.map((event) => event.type);
	assert.equal(types[0], "spawned");
	for (const expected of [
		"agent_start",
		"tool_execution_start",
		"tool_execution_end",
		"turn_end",
		"agent_settled",
		"envelope_received",
	]) {
		assert.ok(types.includes(expected), `missing ${expected} in the log`);
	}
	assert.ok(!types.includes("message_update"), "deltas stay out of the log");

	// Phase transitions, replayed from the log alone.
	const phases: RunPhase[] = [];
	for (let index = 1; index <= events.length; index++) {
		const phase = projectEvents(jobId, events.slice(0, index)).phase;
		if (phases.at(-1) !== phase) phases.push(phase);
	}
	assert.deepEqual(phases, ["starting", "working", "idle"]);

	// --- graceful shutdown with an observed close -------------------------
	const exit = await managed.worker.shutdown();
	assert.equal(exit.code, 0, `expected a clean exit, got ${JSON.stringify(exit)}`);
	assert.equal(managed.worker.alive, false);
	assert.equal(manager.active.length, 0, "capacity frees on the observed close");

	const finalStatus = await waitFor(
		() => readRunStatus(home.path, jobId),
		(value) => value.phase === "exited",
		{ what: "exited projection" },
	);
	assert.equal(finalStatus.exit_code, 0);
	assert.ok(finalStatus.exited_at);
	assert.deepEqual(projectEvents(jobId, readRunEvents(home.path, jobId)), finalStatus, "log rebuild == projection");

	// The whole script was consumed: no hidden extra model turns.
	assert.equal(provider.remaining("m1"), 0);
	assert.equal(provider.requests("m1").length, 2);

	// The job phase a fleet record would take from this run (T8 stores it).
	const jobPhase: JobPhase = finalStatus.reported ? "held" : "failed";
	assert.equal(jobPhase, "held");
});
