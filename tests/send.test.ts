/**
 * T15 acceptance: receipt states verified against a live worker in each state,
 * plus the ported promote rules.
 *
 * cp-held-cannot-report adds the invariant that binds them: a promote that
 * reaches a worker always reopens a way to report, or is refused. Both halves
 * are exercised here against a real pi child, because the defect lived exactly
 * in the seam between `cp_send` and the worker's write-once envelope.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore } from "../src/checkpoint.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { copyOriginalTask } from "../src/gate.ts";
import { EnvelopeIntake } from "../src/intake.ts";
import { atomicWriteJson } from "../src/json-store.ts";
import { MandateStore } from "../src/mandate.ts";
import { decisionReviseAt } from "../src/plan-followup.ts";
import { loadProfile } from "../src/profiles.ts";
import { Reviver } from "../src/revive.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender, SendError } from "../src/send.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readRunEvents,
	readRunStatus,
	REPO_ROOT,
	type ScratchRepo,
	type ScriptStep,
	waitFor,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

interface Bench {
	home: string;
	fleet: FleetStore;
	manager: WorkerManager;
	sender: Sender;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	model: string;
	jobId: string;
	worker: import("../src/worker-process.ts").WorkerProcess;
	/** Job ids whose wall-clock round the sender restarted (`onPromptDelivered`). */
	rearmed: string[];
}

async function bench(
	t: { after(fn: () => void | Promise<void>): void },
	script: ScriptStep[],
	options: { jobId?: string; repo?: ScratchRepo } = {},
): Promise<Bench> {
	const jobId = options.jobId ?? "cp-send";
	const home = createScratchHome();
	const repo = options.repo ?? createScratchRepo({ name: "send" });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const model = provider.addScript("send", script);
	agentDir.writeModels(provider);

	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const runDir = join(home.path, paths.runDir(jobId));
	const profile = loadProfile(PROFILES_DIR, "implementer");
	const managed = manager.spawn({
		identity: { jobId, kind: "ship", delivery: "local", runDir, worktree: repo.path },
		profile,
		model,
		sessionDir: join(home.path, "sessions"),
	});
	const runs = new RunRegistry(home.path);
	runs.open(jobId).markSpawned({ pid: managed.worker.pid, model, profile: profile.frontmatter.name });
	runs.open(jobId).attach(managed.worker);

	const fleet = new FleetStore({ home: home.path });
	// Intake is wired the way the parent wires it: from the worker's own event
	// stream. Nothing here polls, and a script that never reports never fires it.
	const intake = new EnvelopeIntake({
		home: home.path,
		fleet,
		runs,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
	});
	const detach = intake.watch(jobId, managed.worker);
	const record: FleetRecord = {
		job_id: jobId,
		project: "send",
		kind: "ship",
		delivery: "local",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: managed.worker.pid as number,
			session_id: "s",
			session_file: join(home.path, "sessions/s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model,
			started_at: isoTimestamp(),
		},
		worktree: repo.path,
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
	await fleet.add(record);

	t.after(async () => {
		detach();
		await manager.shutdownAll();
		runs.closeAll();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	await managed.worker.getState(30_000);
	const rearmed: string[] = [];
	return {
		rearmed,
		home: home.path,
		fleet,
		manager,
		runs,
		intake,
		model,
		jobId,
		worker: managed.worker,
		sender: new Sender({ fleet, manager, runs, home: home.path, onPromptDelivered: (id) => rearmed.push(id) > 0 }),
	};
}

/** H7: resolve after `count` agent_settled events. Held is marked mid-turn, so a promote before settle came back queued. */
function settled(worker: Bench["worker"], count: number, timeoutMs = 30_000): Promise<void> {
	if (worker.settledCount >= count) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`timed out after ${timeoutMs}ms waiting for agent_settled #${count} (saw ${worker.settledCount})`));
		}, timeoutMs);
		const off = worker.onEvent(() => {
			if (worker.settledCount < count) return;
			clearTimeout(timer);
			off();
			resolve();
		});
	});
}

test("promotion delivers frozen task addenda with provenance without replacing the original", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "received" }]);
	const original = join(b.home, paths.originalTaskFile(b.jobId));
	writeFileSync(original, "Original scope.");
	const row = { schema_version: 1, n: 1, added_at: "2026-09-24T10:00:00Z", by: "operator-quote", quote: "approved", reason: "coverage", text: "Implement the additional requirement." };
	writeFileSync(join(b.home, paths.taskAddendaFile(b.jobId)), `${JSON.stringify(row)}\n`);
	const delivered: string[] = [];
	const send = b.worker.send.bind(b.worker);
	b.worker.send = async (message, ...args) => { delivered.push(message); return send(message, ...args); };
	const result = await b.sender.send({ jobId: b.jobId, message: "Continue the job." });
	assert.equal(result.receipt, "delivered");
	assert.match(delivered[0] ?? "", /Continue the job\./);
	assert.match(delivered[0] ?? "", /Implement the additional requirement\./);
	assert.match(delivered[0] ?? "", /Addendum 1 \(operator-quote, 2026-09-24T10:00:00Z\)/);
	assert.match(delivered[0] ?? "", /Quote: "approved"/);
	assert.equal(readFileSync(original, "utf8"), "Original scope.");
	assert.equal(result.task_updated, undefined);
	await b.worker.waitForSettled(60_000);
});

test("idle worker: a promote is delivered", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [
		{ kind: "text", text: "first" },
		{ kind: "text", text: "second" },
	]);

	const first = await b.sender.send({ jobId: b.jobId, message: "do the first thing" });
	assert.equal(first.receipt, "delivered");
	assert.equal(first.mode, "prompt");
	assert.equal(first.busy_before, false);
	await b.worker.waitForSettled(60_000);

	// promotion of an idle worker is just another prompt
	const second = await b.sender.send({ jobId: b.jobId, message: "now the second thing", model: b.model });
	assert.equal(second.receipt, "delivered");
	await b.worker.waitForSettled(60_000);

	const markers = readRunEvents(b.home, b.jobId).filter((event) => event.source === "cp");
	assert.equal(markers.filter((event) => event.type === "prompt_sent").length, 2);
	assert.equal((markers.at(-1)?.payload as { receipt?: string }).receipt, "delivered");
	assert.equal((markers.at(-1)?.payload as { disposition?: string }).disposition, "started");
	// Each delivered idle prompt starts a fresh wall-clock round, and says so.
	assert.deepEqual(b.rearmed, [b.jobId, b.jobId]);
	assert.equal((markers.at(-1)?.payload as { wall_clock_rearmed?: boolean }).wall_clock_rearmed, true);
});

// ---------------------------------------------------------------------------
// cp-send-idle-steer: a settled worker has no running turn to consume a
// steer/follow_up, so an explicit request for either against one must be
// refused up front — never silently accepted as "queued" and left to sit
// forever with no live agent loop that will ever flush it.
// ---------------------------------------------------------------------------

test("settled, unreported worker: an explicit steer is refused, not queued into the void", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [
		{ kind: "text", text: "first" },
		{ kind: "text", text: "second" },
	]);

	// The worker settles after its first turn without ever calling
	// report_result: settled, alive, idle — and unreported.
	await b.sender.send({ jobId: b.jobId, message: "do the first thing" });
	await b.worker.waitForSettled(60_000);
	assert.equal(b.worker.busy, false);
	assert.equal(b.fleet.require(b.jobId).reported_at, undefined, "still unreported");

	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: "also check the tests", mode: "steer" }),
		(error: SendError) => {
			assert.match(error.message, /is idle, not mid-turn/);
			assert.match(error.message, /"steer"/);
			assert.match(error.message, /mode: "prompt"/);
			return true;
		},
	);
	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: "also update the README", mode: "follow_up" }),
		(error: SendError) => {
			assert.match(error.message, /"follow_up"/);
			return true;
		},
	);

	// Nothing durable was queued, and no budget/supersession side effect fired:
	// the refusal changed nothing on the record or the run log.
	const markers = readRunEvents(b.home, b.jobId)
		.filter((event) => event.source === "cp")
		.map((event) => event.type);
	assert.ok(!markers.includes("steer_sent"));
	assert.ok(!markers.includes("follow_up_sent"));

	// The sanctioned path still works: auto (or explicit prompt) reaches the
	// same idle worker exactly as an ordinary promote would.
	const promoted = await b.sender.send({ jobId: b.jobId, message: "now the second thing" });
	assert.equal(promoted.receipt, "delivered");
	assert.equal(promoted.mode, "prompt");
});

test("settled, reported (held) worker: an explicit follow_up is refused the same way", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-send-idle-held";
	const blocked = {
		job_id: jobId,
		kind: "ship" as const,
		status: "blocked" as const,
		summary: "Blocked: needs owner sign-off.",
		blockers: ["owner sign-off"],
	};
	const b = await bench(
		t,
		[
			{ kind: "tool_calls", calls: [{ name: "report_result", args: blocked }] },
			{ kind: "text", text: "resumed" },
		],
		{ jobId },
	);

	await b.sender.send({ jobId, message: "do the job" });
	await settled(b.worker, 1);
	const held = await waitFor(() => b.fleet.require(jobId), (job) => job.phase === "held", {
		what: "the blocked envelope to be accepted",
	});
	assert.ok(held.reported_at);
	assert.equal(b.worker.busy, false, "the worker is settled, holding an open envelope slot");

	await assert.rejects(
		() => b.sender.send({ jobId, message: "sign-off is in", mode: "follow_up" }),
		(error: SendError) => {
			assert.match(error.message, /is idle, not mid-turn/);
			return true;
		},
	);

	// The refusal fired before any reopen: the held phase and supersession
	// count are untouched, exactly like the landed-delivery refusal.
	const record = b.fleet.require(jobId);
	assert.equal(record.phase, "held");
	assert.equal(record.supersessions, undefined);

	// The sanctioned promote path (auto -> prompt for an idle worker) still
	// reopens the envelope slot and delivers, exactly as before this fix.
	const promote = await b.sender.send({ jobId, message: "sign-off is in — resume and report it" });
	assert.equal(promote.receipt, "delivered");
	assert.equal(promote.superseded?.generation, 1);
});

test("busy worker: steer and follow_up queue, a bare prompt fails honestly", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 2 && echo slept" } }] },
		{ kind: "text", text: "done with the slow thing" },
		{ kind: "text", text: "and the queued one" },
		{ kind: "text", text: "and the other queued one" },
	]);

	await b.sender.send({ jobId: b.jobId, message: "start the slow job" });
	await b.worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
	assert.equal(b.worker.busy, true);
	assert.deepEqual(b.rearmed, [b.jobId]);

	const steered = await b.sender.send({ jobId: b.jobId, message: "also check the tests" });
	assert.equal(steered.mode, "steer", "auto mode steers a busy worker");
	assert.equal(steered.receipt, "queued");
	assert.equal(steered.busy_before, true);

	const followUp = await b.sender.send({ jobId: b.jobId, message: "afterwards, update the README", mode: "follow_up" });
	assert.equal(followUp.receipt, "queued");

	// An explicit bare prompt while streaming is refused by pi; we report that.
	const bare = await b.sender.send({ jobId: b.jobId, message: "bare prompt", mode: "prompt" });
	assert.equal(bare.receipt, "failed");
	assert.ok(bare.error);

	const markers = readRunEvents(b.home, b.jobId)
		.filter((event) => event.source === "cp")
		.map((event) => event.type);
	assert.ok(markers.includes("steer_sent"));
	assert.ok(markers.includes("follow_up_sent"));
	assert.equal(markers.filter((type) => type === "prompt_sent").length, 2, "the refused prompt is logged too");
	assert.equal(
		(readRunEvents(b.home, b.jobId).find((e) => e.source === "cp" && e.type === "steer_sent")?.payload as { disposition?: string }).disposition,
		"queued",
	);
	// Steer, follow_up (queued) and the failed bare prompt never restart the wall clock.
	assert.deepEqual(b.rearmed, [b.jobId]);

	// pi started a run while the local busy flag still reads true: the receipt, not busy, decides the rearm.
	const real = b.worker.send.bind(b.worker);
	b.worker.send = async () => ({ receipt: "delivered", disposition: "started" });
	const late = await b.sender.send({ jobId: b.jobId, message: "busy flag lags", mode: "prompt" });
	assert.equal(late.receipt, "delivered");
	assert.deepEqual(b.rearmed, [b.jobId, b.jobId], "a delivered prompt rearms even when busy read true");
	b.worker.send = real;
});

// ---------------------------------------------------------------------------
// cp-held-cannot-report: promotable implies reportable
// ---------------------------------------------------------------------------

test("a promoted held job can still report: the superseding envelope is accepted", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-supersede";
	const blocked = {
		job_id: jobId,
		kind: "ship" as const,
		status: "blocked" as const,
		summary: "Blocked: the migration needs owner sign-off.",
		blockers: ["migration needs owner sign-off"],
	};
	const repo = createScratchRepo({ name: "send" });
	const shipped = {
		head_sha: repo.head(),
		job_id: jobId,
		kind: "ship" as const,
		status: "done" as const,
		summary: "Stage A implemented, committed and pushed.",
		branch: jobId,
	};
	const b = await bench(
		t,
		[
			{ kind: "tool_calls", calls: [{ name: "report_result", args: blocked }] },
			{ kind: "tool_calls", calls: [{ name: "report_result", args: shipped }] },
		],
		{ jobId, repo },
	);

	// 1. the worker reports blocked, its turn ends, and the job is held.
	await b.sender.send({ jobId, message: "do the job" });
	await settled(b.worker, 1);
	const held = await waitFor(() => b.fleet.require(jobId), (job) => job.phase === "held", {
		what: "the blocked envelope to be accepted",
	});
	assert.ok(held.reported_at);

	// 2. the operator clears the blocker; the parent promotes the same worker.
	const promote = await b.sender.send({ jobId, message: "sign-off is in — implement Stage A and report it" });
	assert.equal(promote.receipt, "delivered");
	assert.equal(promote.superseded?.generation, 1, "the promote reopened the envelope slot");
	assert.equal(promote.superseded?.prior_status, "blocked");

	// 3. the second report is ACCEPTED — this is the whole point. Before the fix
	//    the worker's write-once envelope refused it and the work vanished.
	// (Timestamps are second-precision by contract, so the two generations can
	// share a `reported_at`; the countable fact is the accepted envelope.)
	await settled(b.worker, 2);
	await waitFor(
		() => readRunEvents(b.home, jobId).filter((event) => event.type === "envelope_received").length,
		(count) => count === 2,
		{ what: "the superseding envelope to be accepted", timeoutMs: 30_000 },
	);
	const reported = b.fleet.require(jobId);
	assert.equal(reported.phase, "held");
	assert.ok(reported.reported_at);
	assert.equal(reported.supersessions, 1);
	assert.ok(existsSync(join(b.home, paths.supersededEnvelopeFile(jobId, 1))), "the blocked envelope is kept, not destroyed");

	const markers = readRunEvents(b.home, jobId)
		.filter((event) => event.source === "cp")
		.map((event) => event.type);
	assert.deepEqual(
		markers.filter((type) => type.startsWith("envelope_")),
		["envelope_received", "envelope_superseded", "envelope_received"],
		"one envelope per generation, and the supersession between them is on the record",
	);
	assert.equal(readRunStatus(b.home, jobId).reported, true);
});

test("a failed job continues on its original lease: cp_send refuses it failed, then the resumed worker's report supersedes the accepted envelope", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-continue";
	const blocked = { job_id: jobId, kind: "ship" as const, status: "blocked" as const, summary: "Blocked: needs a hand.", blockers: ["needs a hand"] };
	const repo = createScratchRepo({ name: "send" });
	const shipped = { job_id: jobId, kind: "ship" as const, status: "done" as const, summary: "Continued and pushed.", branch: jobId, head_sha: repo.head() };
	const b = await bench(
		t,
		[
			{ kind: "tool_calls", calls: [{ name: "report_result", args: blocked }] },
			{ kind: "tool_calls", calls: [{ name: "report_result", args: shipped }] },
		],
		{ jobId, repo },
	);

	// 1. the worker reports, then dies, and the job is failed.
	await b.sender.send({ jobId, message: "do the job" });
	await settled(b.worker, 1);
	await waitFor(() => b.fleet.require(jobId), (job) => job.phase === "held", { what: "the blocked envelope" });
	const state = await b.worker.getState(30_000);
	const sessionFile = state.sessionFile as string;
	await b.fleet.patch(jobId, { worker: { ...b.fleet.require(jobId).worker, session_file: sessionFile } });
	await b.manager.shutdown(jobId);
	await b.fleet.markFailed(jobId, { class: "crash", message: "worker exited 137", at: isoTimestamp() });

	// 2. a brief to a failed job names the sanctioned continuation, never a takeover.
	await assert.rejects(
		() => b.sender.send({ jobId, message: "carry on" }),
		(error: SendError) => {
			assert.match(error.message, new RegExp(`cp_revive ${jobId} continue_failed:true`));
			assert.match(error.message, /never a takeover job/);
			return true;
		},
	);

	// 3. the operator continues it: same session and worktree, lands idle, failure cleared.
	const reviver = new Reviver({
		home: b.home,
		profilesDir: PROFILES_DIR,
		fleet: b.fleet,
		manager: b.manager,
		runs: b.runs,
		intake: b.intake,
		isPidAlive: () => false,
	});
	const result = await reviver.revive(jobId, { continueFailed: true });
	assert.equal(result.session_file, sessionFile);
	const continued = b.fleet.require(jobId);
	assert.equal(continued.phase, "waiting");
	assert.equal(continued.failure, undefined);
	assert.ok(continued.reported_at, "the accepted envelope is not silently dropped by continuation");
	const revived = b.manager.get(jobId)?.worker;
	assert.ok(revived);

	// 4. the resumed prompt supersedes the accepted envelope, and the new report is accepted.
	const promote = await b.sender.send({ jobId, message: "the hand is here \u2014 finish and report" });
	assert.equal(promote.receipt, "delivered");
	assert.equal(promote.superseded?.generation, 1);
	assert.equal(promote.superseded?.prior_status, "blocked");
	await settled(revived, 1);
	await waitFor(
		() => readRunEvents(b.home, jobId).filter((event) => event.type === "envelope_received").length,
		(count) => count === 2,
		{ what: "the continued worker's envelope", timeoutMs: 30_000 },
	);
	const reported = b.fleet.require(jobId);
	assert.equal(reported.phase, "held");
	assert.equal(reported.supersessions, 1);
	assert.equal(reported.worktree, continued.worktree);
	assert.ok(existsSync(join(b.home, paths.supersededEnvelopeFile(jobId, 1))), "the first envelope is kept, not overwritten");
});

test("a landed delivery is refused, not silently reopened", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-landed";
	const repo = createScratchRepo({ name: "send" });
	const envelope = {
		head_sha: repo.head(),
		job_id: jobId,
		kind: "ship" as const,
		status: "done" as const,
		summary: "Shipped it.",
		branch: jobId,
	};
	const b = await bench(t, [{ kind: "tool_calls", calls: [{ name: "report_result", args: envelope }] }], { jobId, repo });

	await b.sender.send({ jobId, message: "do the job" });
	await waitFor(() => b.fleet.require(jobId), (job) => job.phase === "held", { what: "the envelope" });
	// Somebody observed the merge and recorded it on the receipt.
	await b.fleet.patch(jobId, {
		receipts: [{ kind: "pr", status: "merged", title: `PR for ${jobId}`, url: "https://github.com/o/r/pull/22" }],
	});

	await assert.rejects(
		() => b.sender.send({ jobId, message: "one more thing while you are there" }),
		(error: SendError) => {
			assert.match(error.message, /landed delivery/);
			assert.match(error.message, new RegExp(`cp_teardown ${jobId}`));
			assert.match(error.message, /cp_dispatch a new job id/);
			return true;
		},
	);

	// Refused means nothing happened: no supersession, no delivery, no archive.
	const record = b.fleet.require(jobId);
	assert.equal(record.phase, "held");
	assert.equal(record.supersessions, undefined);
	assert.ok(existsSync(join(b.home, paths.envelopeFile(jobId))));
	const markers = readRunEvents(b.home, jobId).filter((event) => event.source === "cp");
	assert.equal(markers.filter((event) => event.type === "envelope_superseded").length, 0);
	assert.equal(markers.filter((event) => event.type === "prompt_sent").length, 1, "the refused brief never reached the worker");
});

test("human_handoff change request: cp_send to the handed-off job reopens it on the same branch; a dead worker points at cp_revive", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-aaa1";
	const repo = createScratchRepo({ name: "send" });
	const envelope = { job_id: jobId, kind: "ship" as const, status: "done" as const, summary: "Pushed and opened the PR.", branch: jobId, head_sha: repo.head() };
	const b = await bench(t, [{ kind: "tool_calls", calls: [{ name: "report_result", args: envelope }] }, { kind: "text", text: "on it" }], { jobId, repo });
	await b.sender.send({ jobId, message: "do the job" });
	await settled(b.worker, 1);
	await waitFor(() => b.fleet.require(jobId), (job) => job.phase === "held", { what: "the envelope" });
	// Handed off to a human on GitHub: still held, PR open (src/human-handoff.ts adds no state of its own).
	await b.fleet.patch(jobId, { delivery: "pr", receipts: [{ kind: "pr", status: "open", title: `PR for ${jobId}`, url: "https://github.com/example/example-app/pull/1" }] });

	const change = await b.sender.send({ jobId, message: "the reviewer asked for a rename — push it and report" });
	assert.equal(change.receipt, "delivered");
	assert.equal(change.superseded?.generation, 1, "the change request reopens the envelope");
	const reopened = b.fleet.require(jobId);
	assert.equal(reopened.phase, "waiting");
	assert.equal(reopened.branch, jobId, "same branch, same job");
	assert.deepEqual(b.fleet.list().map((job) => job.job_id), [jobId], "no new job");

	await settled(b.worker, 2);
	await b.manager.shutdown(jobId);
	await assert.rejects(() => b.sender.send({ jobId, message: "one more change" }), /no live worker in this session[\s\S]*revive/);
});

test("promote rules: same model only, live jobs only, live workers only", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }]);

	await assert.rejects(() => b.sender.send({ jobId: b.jobId, message: "   " }), /empty message/);
	await assert.rejects(() => b.sender.send({ jobId: "cp-unknown", message: "hi" }), /no fleet record/);
	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: "hi", model: "mock/other" }),
		(error: SendError) => {
			assert.match(error.message, /cross-model role hop is teardown \+ fresh dispatch/);
			return true;
		},
	);

	// a job that is done has nothing to promote
	await b.fleet.patch(b.jobId, { phase: "done", closed_at: isoTimestamp() });
	await assert.rejects(() => b.sender.send({ jobId: b.jobId, message: "hi" }), /nothing to promote/);
	await b.fleet.patch(b.jobId, { phase: "waiting" });

	// a worker this session does not own is not silently revived
	await b.manager.shutdown(b.jobId);
	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: "hi" }),
		(error: SendError) => {
			assert.match(error.message, /no live worker in this session/);
			assert.match(error.message, /revive|tear the job down/);
			return true;
		},
	);
});

// ---------------------------------------------------------------------------
// cp-promote-task-record: a promoted brief may replace the frozen task a diff
// reviewer scores against; an ordinary steer or follow_up may never do so.
// ---------------------------------------------------------------------------

test("a promotion (mode prompt) replaces the frozen task, and keeps every prior generation", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [
		{ kind: "text", text: "first" },
		{ kind: "text", text: "second" },
	]);
	const originalTaskPath = join(b.home, paths.originalTaskFile(b.jobId));
	writeFileSync(originalTaskPath, "Bump x to 2 in src/app.ts.");

	// generation 1: an inline `task` on an idle worker's promotion.
	const first = await b.sender.send({
		jobId: b.jobId,
		message: "scope grew: also update the README",
		task: "Bump x to 2 in src/app.ts AND update the README to describe the new default.",
	});
	assert.equal(first.receipt, "delivered");
	assert.equal(first.mode, "prompt");
	assert.equal(first.task_updated?.generation, 1);
	assert.equal(first.task_updated?.source, "task");
	assert.equal(readFileSync(originalTaskPath, "utf8"), "Bump x to 2 in src/app.ts AND update the README to describe the new default.");
	assert.equal(
		readFileSync(join(b.home, paths.supersededOriginalTaskFile(b.jobId, 1)), "utf8"),
		"Bump x to 2 in src/app.ts.",
		"the prior task text survives, archived rather than overwritten",
	);
	assert.equal(b.fleet.require(b.jobId).task_generations, 1);
	await b.worker.waitForSettled(60_000);

	// generation 2: a taskFile handover on a second promotion.
	const dir = mkdtempSync(join(tmpdir(), "cp-send-task-"));
	const taskFile = join(dir, "task.md");
	writeFileSync(taskFile, "Bump x to 2, update the README, and add a changelog entry.");
	const second = await b.sender.send({ jobId: b.jobId, message: "one more scope change", taskFile, model: b.model });
	assert.equal(second.receipt, "delivered");
	assert.equal(second.task_updated?.generation, 2);
	assert.equal(second.task_updated?.source, "task_file");
	assert.equal(readFileSync(originalTaskPath, "utf8"), "Bump x to 2, update the README, and add a changelog entry.");
	assert.equal(
		readFileSync(join(b.home, paths.supersededOriginalTaskFile(b.jobId, 2)), "utf8"),
		"Bump x to 2 in src/app.ts AND update the README to describe the new default.",
		"generation 1's text is kept too — nothing collapses the history to one prior copy",
	);
	assert.equal(b.fleet.require(b.jobId).task_generations, 2);

	const markers = readRunEvents(b.home, b.jobId)
		.filter((event) => event.source === "cp")
		.map((event) => event.type);
	assert.deepEqual(
		markers.filter((type) => type === "original_task_updated"),
		["original_task_updated", "original_task_updated"],
		"one journal entry per replacement",
	);
});

// pi-command-post-autonomy-programme-cur.2.4: ask_on: [risk:high] gates a
// cp_send promotion into a ship brief the same way it gates a direct dispatch
// \u2014 no bypass by promoting a planner into an implementer with risky new text.
test("risk:high under ask_on refuses a cp_send promotion into a ship brief; an operator-quoted decide then lets it proceed", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }]);
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["send"],
		objective: "ship the bump",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 10,
		ask_on: ["risk:high"],
	});
	const sender = new Sender({ fleet: b.fleet, manager: b.manager, runs: b.runs, home: b.home, mandates });

	await assert.rejects(
		() => sender.send({ jobId: b.jobId, message: "scope grew", task: "Rotate the production database credentials." }),
		/risk:high under ask_on/,
	);
	const escalations = new EscalationStore({ home: b.home });
	const open = escalations.open();
	assert.equal(open.length, 1, "exactly one escalation");
	assert.equal(open[0]?.kind, "risk_high_irreversible");
	assert.match(open[0]?.question ?? "", new RegExp(b.jobId));

	await escalations.answer(open[0]?.id as string, { answer: "approve", by: "operator-quote" });
	const result = await sender.send({
		jobId: b.jobId,
		message: "scope grew",
		task: "Rotate the production database credentials.",
	});
	assert.equal(result.receipt, "delivered");
});

// b-qbi.4: a repair and a same-kind promotion of the in-flight worker continue under an expired grant.
test("under an expired grant a same-kind promotion and a repair send reach the in-flight implementer; a grant without repair refuses both", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }, { kind: "text", text: "ok" }]);
	const mandates = new MandateStore(b.home);
	const past = (ms: number) => isoTimestamp(new Date(Date.now() - ms));
	const grant = (allowed: Array<"implement" | "review" | "repair" | "merge">, at: number) =>
		mandates.issue({ projects: ["send"], objective: "ship it", expiry: past(1_000), at: past(at), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, allowed_actions: allowed });
	grant(["implement", "review", "repair", "merge"], 86_400_000);
	const sender = new Sender({ fleet: b.fleet, manager: b.manager, runs: b.runs, home: b.home, mandates });

	assert.equal(b.fleet.get(b.jobId)?.kind, "ship");
	const promoted = await sender.send({ jobId: b.jobId, message: "review fix", task: "Address the review finding." });
	assert.equal(promoted.receipt, "delivered");
	await b.worker.waitForSettled(60_000);
	const repaired = await sender.send({ jobId: b.jobId, message: "CI is red; fix it", purpose: "repair" });
	assert.equal(repaired.receipt, "delivered");
	await b.worker.waitForSettled(60_000);

	grant(["implement", "review"], 60_000);
	await assert.rejects(() => sender.send({ jobId: b.jobId, message: "fix it again", purpose: "repair" }), /repair is not an allowed action/);
	await assert.rejects(() => sender.send({ jobId: b.jobId, message: "again", task: "Address it again." }), /repair is not an allowed action/);
});

test("a repair send is refused before delivery under an expired grant that was revoked or cap-paused", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, []);
	const mandates = new MandateStore(b.home);
	const past = (ms: number) => isoTimestamp(new Date(Date.now() - ms));
	const sender = new Sender({ fleet: b.fleet, manager: b.manager, runs: b.runs, home: b.home, mandates });
	const sentBefore = readRunEvents(b.home, b.jobId).filter((event) => event.type === "prompt_sent").length;

	// Revoked after it expired: never a continuation.
	const revoked = mandates.issue({ projects: ["send"], objective: "ship it", expiry: past(2_000), at: past(86_400_000), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
	mandates.revoke(revoked.id);
	await assert.rejects(() => sender.send({ jobId: b.jobId, message: "CI is red; fix it", purpose: "repair" }), new RegExp(`mandate ${revoked.id} is revoked .*no repair under it`));

	// Cap-paused, then past its expiry: the stricter row (the cap) refuses.
	const capped = mandates.issue({ projects: ["send"], objective: "ship it", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), at: past(60_000), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
	mandates.save({ ...mandates.require(capped.id), status: "paused", paused_at: past(30_000), pause_reason: "spend_cap", expiry: past(1_000) });
	await assert.rejects(() => sender.send({ jobId: b.jobId, message: "CI is red; fix it", purpose: "repair" }), new RegExp(`mandate ${capped.id} is paused \\(spend_cap\\) .*no repair under it`));
	assert.equal(readRunEvents(b.home, b.jobId).filter((event) => event.type === "prompt_sent").length, sentBefore, "nothing was delivered");
});

// H6: an inferred risk:high warns; an assessed risk:high gates \u2014 on promotion too.
test("H6: a cp_send promotion whose risk:high is inferred-only against a recorded low delivers with the warning on the result and in the run journal; an assessed high still escalates", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }, { kind: "text", text: "ok" }]);
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["send"],
		objective: "ship the cleanup",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 10,
		ask_on: ["risk:high"],
	});
	const sender = new Sender({ fleet: b.fleet, manager: b.manager, runs: b.runs, home: b.home, mandates });
	const setRouting = (routing: NonNullable<FleetRecord["routing"]>) =>
		b.fleet.mutate((jobs) => {
			for (const job of jobs) if (job.job_id === b.jobId) job.routing = routing;
		});
	// The pipeline implementer: routed high from keywords, a planner-recorded low beside it.
	await setRouting({ risk: "high", inferred: true, provenance: { scope: "defaulted", risk: "inferred" }, recorded_risk: "low" });

	const result = await sender.send({ jobId: b.jobId, message: "re-brief", task: "Delete the stale fixture." });
	assert.equal(result.receipt, "delivered");
	assert.match(result.risk_warning ?? "", /risk:high inferred from keywords only \(delete\)/);
	const sent = readRunEvents(b.home, b.jobId).filter((event) => event.type === "prompt_sent").at(-1);
	assert.equal((sent?.payload as Record<string, unknown> | undefined)?.risk_warning, result.risk_warning, "the same line is in the run journal");
	assert.equal(new EscalationStore({ home: b.home }).open().length, 0, "nothing was escalated");
	await b.worker.waitForSettled(60_000);

	// An explicit (assessed) high gates exactly as before.
	await setRouting({ risk: "high", inferred: false, provenance: { scope: "defaulted", risk: "explicit" } });
	await assert.rejects(() => sender.send({ jobId: b.jobId, message: "re-brief", task: "Delete the stale fixture." }), /risk:high under ask_on/);
	assert.equal(new EscalationStore({ home: b.home }).open()[0]?.kind, "risk_high_irreversible");
});

// riskkw-f10: the promoted task's own header can declare its risk.
test("riskkw-f10: a cp_send promotion reads the new task's header: a declared low warns on a keyword-only high, a declared high gates and names it", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }, { kind: "text", text: "ok" }]);
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["send"],
		objective: "ship the cleanup",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 10,
		ask_on: ["risk:high"],
	});
	const sender = new Sender({ fleet: b.fleet, manager: b.manager, runs: b.runs, home: b.home, mandates });
	await b.fleet.mutate((jobs) => {
		for (const job of jobs) if (job.job_id === b.jobId) job.routing = { risk: "low", inferred: false, provenance: { scope: "defaulted", risk: "defaulted" } };
	});

	const result = await sender.send({ jobId: b.jobId, message: "re-brief", task: "Scope S, risk low.\n\nDelete the stale fixture." });
	assert.equal(result.receipt, "delivered");
	assert.match(result.risk_warning ?? "", /\(delete\); risk low was recorded in the task header/);
	assert.equal(new EscalationStore({ home: b.home }).open().length, 0, "nothing was escalated");
	await b.worker.waitForSettled(60_000);

	await assert.rejects(() => sender.send({ jobId: b.jobId, message: "re-brief", task: "Risk: high\n\nFix the typo." }), /risk:high under ask_on/);
	const open = new EscalationStore({ home: b.home }).open();
	assert.equal(open.length, 1);
	assert.match(open[0]?.question ?? "", /risk high recorded in the task header/);
});

test("serial mandate: promoting the held job itself passes the slot check and reuses its one worker", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-serial-promote";
	const blocked = { job_id: jobId, kind: "ship" as const, status: "blocked" as const, summary: "Blocked on review.", blockers: ["diff review asked for a fix"] };
	const b = await bench(t, [{ kind: "tool_calls", calls: [{ name: "report_result", args: blocked }] }, { kind: "text", text: "fixing" }], { jobId });
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["send"],
		objective: "ship it",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 10_000_000 },
		job_cap: 10,
		dispatch_parallelism: 1,
	});
	const sender = new Sender({ fleet: b.fleet, manager: b.manager, runs: b.runs, home: b.home, mandates });
	await sender.send({ jobId, message: "do the job" });
	await waitFor(() => b.fleet.require(jobId), (job) => job.phase === "held", { what: "the held envelope" });
	await waitFor(() => b.manager.active.every((managed) => !managed.worker.busy), (idle) => idle, { what: "the worker to go idle" });
	// Another job is working: a fresh dispatch would be refused, but repairing this one is its own worker.
	await b.fleet.mutate((jobs) => {
		jobs.push({ ...(jobs[0] as (typeof jobs)[0]), job_id: "cp-other-working", branch: "cp-other-working", phase: "waiting", reported_at: undefined });
	});
	const pid = b.manager.active.map((managed) => managed.worker.pid);

	const promote = await sender.send({ jobId, message: "apply the review fix", task: "Apply the review fix on the same branch." });
	assert.equal(promote.receipt, "delivered", "its own held slot never blocks its promotion");
	assert.deepEqual(b.manager.active.map((managed) => managed.worker.pid), pid, "same worker, no second process");
	assert.equal(b.fleet.read().jobs.length, 2, "no new job");
});

test("a steer or follow_up refuses task/taskFile: scope only changes through a promotion", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 2 && echo slept" } }] },
		{ kind: "text", text: "done with the slow thing" },
	]);
	const originalTaskPath = join(b.home, paths.originalTaskFile(b.jobId));
	writeFileSync(originalTaskPath, "Original scope.");

	await b.sender.send({ jobId: b.jobId, message: "start the slow job" });
	await b.worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
	assert.equal(b.worker.busy, true);

	// explicit steer with a task: refused before anything is mutated.
	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: "also check the tests", mode: "steer", task: "A different job entirely." }),
		(error: SendError) => {
			assert.match(error.message, /only accepted with a promotion/);
			assert.match(error.message, /resolved to "steer"/);
			return true;
		},
	);

	// auto mode against a busy worker resolves to steer too — same refusal.
	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: "also this", task: "Yet another job." }),
		/only accepted with a promotion/,
	);

	// follow_up with a task is refused the same way.
	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: "afterwards", mode: "follow_up", taskFile: originalTaskPath }),
		/only accepted with a promotion/,
	);

	// Nothing was mutated by any of the refused attempts.
	assert.equal(readFileSync(originalTaskPath, "utf8"), "Original scope.");
	assert.equal(b.fleet.require(b.jobId).task_generations, undefined);
	assert.equal(
		readRunEvents(b.home, b.jobId).filter((event) => event.type === "original_task_updated").length,
		0,
	);
});

test("an explicit prompt aimed at a busy worker also refuses task/taskFile: mode alone is not a promotion", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 2 && echo slept" } }] }]);
	const originalTaskPath = join(b.home, paths.originalTaskFile(b.jobId));
	writeFileSync(originalTaskPath, "Original scope.");

	await b.sender.send({ jobId: b.jobId, message: "start the slow job" });
	await b.worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
	assert.equal(b.worker.busy, true);

	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: "scope change", mode: "prompt", task: "A different job entirely." }),
		(error: SendError) => {
			assert.match(error.message, /only accepted with a promotion of an idle worker/);
			assert.match(error.message, /resolved to "prompt"/);
			assert.match(error.message, /busy worker/);
			return true;
		},
	);

	assert.equal(readFileSync(originalTaskPath, "utf8"), "Original scope.");
	assert.equal(b.fleet.require(b.jobId).task_generations, undefined);
});

test("a task replacement is applied only on a delivered receipt; a failed send mutates nothing", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }]);
	const originalTaskPath = join(b.home, paths.originalTaskFile(b.jobId));
	writeFileSync(originalTaskPath, "Original scope.");

	const managed = b.manager.get(b.jobId);
	assert.ok(managed);
	// Force the delivery itself to fail after every guard has already passed
	// (idle worker, mode resolves to "prompt"), so the only thing left to prove
	// is that the frozen-task replacement is gated on the receipt, not on
	// having validated and reached the send call.
	const originalSend = managed.worker.send.bind(managed.worker);
	managed.worker.send = async () => ({ receipt: "failed" as const, error: "simulated delivery failure" });
	t.after(() => {
		managed.worker.send = originalSend;
	});

	const result = await b.sender.send({ jobId: b.jobId, message: "scope change", task: "A different job entirely." });
	assert.equal(result.receipt, "failed");
	assert.equal(result.task_updated, undefined);
	assert.deepEqual(b.rearmed, [], "a failed delivery never restarts the wall clock");
	assert.equal(readFileSync(originalTaskPath, "utf8"), "Original scope.", "the frozen task is untouched by a failed delivery");
	assert.equal(b.fleet.require(b.jobId).task_generations, undefined);
	assert.equal(existsSync(join(b.home, paths.supersededOriginalTaskFile(b.jobId, 1))), false);
	assert.equal(
		readRunEvents(b.home, b.jobId).filter((event) => event.type === "original_task_updated").length,
		0,
	);
});

test("a promotion with no pre-existing frozen task writes one with no archive to restore", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }]);
	const originalTaskPath = join(b.home, paths.originalTaskFile(b.jobId));
	assert.equal(existsSync(originalTaskPath), false, "nothing was frozen for this job yet");

	const result = await b.sender.send({ jobId: b.jobId, message: "first real brief", task: "Do the thing, from scratch." });
	assert.equal(result.receipt, "delivered");
	assert.equal(result.task_updated?.generation, 1);
	assert.equal(result.task_updated?.archived, undefined, "there was nothing to archive");
	assert.equal(readFileSync(originalTaskPath, "utf8"), "Do the thing, from scratch.");
	assert.equal(existsSync(join(b.home, paths.supersededOriginalTaskFile(b.jobId, 1))), false);
	assert.equal(b.fleet.require(b.jobId).task_generations, 1);
});

test("the diff reviewer/plan gate reads the latest generation, not a stale copy", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [
		{ kind: "text", text: "first" },
		{ kind: "text", text: "second" },
	]);
	writeFileSync(join(b.home, paths.originalTaskFile(b.jobId)), "Bump x to 2 in src/app.ts.");

	await b.sender.send({ jobId: b.jobId, message: "scope grew", task: "Bump x to 2 AND update the README." });
	await b.worker.waitForSettled(60_000);

	const scratch1 = mkdtempSync(join(tmpdir(), "cp-send-review-input-"));
	const copy1 = copyOriginalTask({ home: b.home, jobId: b.jobId, scratch: scratch1 });
	assert.equal(readFileSync(copy1 as string, "utf8"), "Bump x to 2 AND update the README.");

	const dir = mkdtempSync(join(tmpdir(), "cp-send-task-"));
	const taskFile = join(dir, "task.md");
	writeFileSync(taskFile, "Bump x to 2, update the README, and add a changelog entry.");
	await b.sender.send({ jobId: b.jobId, message: "one more scope change", taskFile, model: b.model });

	const scratch2 = mkdtempSync(join(tmpdir(), "cp-send-review-input-"));
	const copy2 = copyOriginalTask({ home: b.home, jobId: b.jobId, scratch: scratch2 });
	assert.equal(
		readFileSync(copy2 as string, "utf8"),
		"Bump x to 2, update the README, and add a changelog entry.",
		"the reviewer's copy reflects generation 2, not generation 1 or the original dispatch text",
	);
});

// ---------------------------------------------------------------------------
// pi-command-post-autonomy-programme-cur.3.3: conversation revise / planner
// question reaching cp_send. decidePlanSend runs before any fleet/worker
// lookup, so the refusal case needs no live worker at all.
// ---------------------------------------------------------------------------

test("cp_send refuses a conversation revise once the plan checkpoint is approved and the implementer is dispatched", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const researchId = "cp-plan-research";
	const shipId = "cp-plan-ship";
	atomicWriteJson(join(home.path, paths.pipelineFile(researchId)), {
		schema_version: SCHEMA_VERSION,
		research_id: researchId,
		ship_id: shipId,
	});
	const checkpoints = new CheckpointStore(home.path);
	checkpoints.request({ jobId: shipId, question: `ship ${shipId}?` });
	checkpoints.decide(shipId, true, { by: "mandate:test" });

	const fleet = new FleetStore({ home: home.path });
	await fleet.add({
		job_id: shipId,
		project: "send",
		kind: "ship",
		delivery: "local",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: { pid: 999999, session_id: "s", session_file: join(home.path, "sessions/s.jsonl"), profile: "implementer", role: "implementer", model: "m", started_at: isoTimestamp() },
		worktree: home.path,
		branch: shipId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	});
	const sender = new Sender({
		fleet,
		manager: new WorkerManager({ home: home.path, workerReporterPath: "unused" }),
		runs: new RunRegistry(home.path),
		home: home.path,
	});

	await assert.rejects(
		() =>
			sender.send({
				jobId: researchId,
				message: `revise the plan for job ${researchId}: split step 3`,
			}),
		(error: SendError) => {
			assert.match(error.message, /plan checkpoint .* is already approved and the implementer has been dispatched/);
			assert.match(error.message, /start a new research job, or steer the implementer with cp_send cp-plan-ship/);
			return true;
		},
	);
});

test("conversation revise: delivered, recorded, and refused a second time until re-gated", { timeout: 120_000 }, async (t) => {
	const b = await bench(
		t,
		[
			{ kind: "text", text: "ok" },
			{ kind: "text", text: "ok again" },
		],
		{ jobId: "cp-plan-research2" },
	);
	const shipId = "cp-plan-ship2";
	atomicWriteJson(join(b.home, paths.pipelineFile(b.jobId)), {
		schema_version: SCHEMA_VERSION,
		research_id: b.jobId,
		ship_id: shipId,
	});

	const first = await b.sender.send({ jobId: b.jobId, message: `revise the plan for job ${b.jobId}: split step 3` });
	assert.equal(first.receipt, "delivered");
	await b.worker.waitForSettled(60_000);
	assert.ok(decisionReviseAt(b.home, b.jobId), "a delivered revise leaves an open-revise marker");

	await assert.rejects(
		() => b.sender.send({ jobId: b.jobId, message: `revise the plan for job ${b.jobId}: also fix step 4` }),
		(error: SendError) => {
			assert.match(error.message, /one open revise at a time/);
			return true;
		},
	);
});

test("conversation question: delivered as a blocked-envelope ask, not refused", { timeout: 120_000 }, async (t) => {
	const b = await bench(t, [{ kind: "text", text: "ok" }], { jobId: "cp-plan-research3" });
	atomicWriteJson(join(b.home, paths.pipelineFile(b.jobId)), {
		schema_version: SCHEMA_VERSION,
		research_id: b.jobId,
		ship_id: "cp-plan-ship3",
	});

	const result = await b.sender.send({ jobId: b.jobId, message: `ask the planner of job ${b.jobId}: which auth provider?` });
	assert.equal(result.receipt, "delivered");
	await b.worker.waitForSettled(60_000);
});
