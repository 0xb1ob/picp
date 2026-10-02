/**
 * cp-settle-without-report acceptance.
 *
 * The incident: five workers finished their work — four pushed green,
 * merge-ready PRs, one wrote a complete artifact — and every one of them ended
 * `agent_end -> agent_settled` without calling `report_result`. The parent
 * sleeps on envelopes, so it slept for fourteen hours, and every finished job
 * was recorded as `failed`.
 *
 * These are hermetic: the worker is a stub with the two methods `SettleWatcher`
 * actually uses (`alive`, `send`, `onEvent`), so the settle boundary is tested
 * without a child process, a provider or a clock.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Envelope,
	type EnvelopeRecord,
	type FleetRecord,
	isoTimestamp,
	paths,
	SCHEMA_VERSION,
	type SendReceipt,
	type StatusJob,
	type StatusSnapshot,
	StatusSnapshotSchema,
	validate,
} from "../src/contracts.ts";
import { attachWorkerObservers } from "../src/dispatch.ts";
import { classifyRun, decideRecovery } from "../src/failures.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake } from "../src/intake.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import { mayBeDeadOnArrival, REPORT_NUDGE_TEXT, SettleWatcher, formatSettleOutcome } from "../src/settle.ts";
import { assembleStatus, formatStatusTable } from "../src/status.ts";
import { assembleStatusBlock } from "../src/status-block.ts";
import { isWedgedToolCall, jobState, settledWithoutReport } from "../src/status-render.ts";
import { detectWedgedToolCalls } from "../src/wedged.ts";
import { renderFleetWidget } from "../src/widget.ts";
import type { RunRecorder } from "../src/run-artifacts.ts";
import type { WorkerEvent, WorkerProcess } from "../src/worker-process.ts";
import { createScratchHome, readRunEvents, type ScratchHome, waitFor } from "./harness/index.ts";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** Exactly the surface `SettleWatcher` uses, and nothing else. */
class StubWorker {
	alive = true;
	readonly sent: string[] = [];
	receipt: SendReceipt = "delivered";
	readonly #listeners = new Set<(event: WorkerEvent) => void>();

	async send(message: string, _mode?: "prompt" | "steer" | "follow_up"): Promise<{ receipt: SendReceipt; error?: string }> {
		this.sent.push(message);
		return this.receipt === "failed" ? { receipt: "failed", error: "worker stdin is closed" } : { receipt: this.receipt };
	}

	onEvent(listener: (event: WorkerEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Emit an `agent_settled` the way a real worker's stream would. */
	settle(): void {
		for (const listener of [...this.#listeners]) listener({ type: "agent_settled" });
	}
}

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	watcher: SettleWatcher;
	worker: StubWorker;
	outcomes: Array<{ jobId: string; action: string }>;
}

const JOB_ID = "cp-settle";

async function bench(t: { after(fn: () => void | Promise<void>): void }): Promise<Bench> {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const fail = (jobId: string, failure: Parameters<FleetStore["markFailed"]>[1]) => fleet.markFailed(jobId, failure);
	const intake = new EnvelopeIntake({ home: home.path, fleet, runs, fail });
	const outcomes: Array<{ jobId: string; action: string }> = [];
	const watcher = new SettleWatcher({
		fleet,
		runs,
		intake,
		fail,
		onUnreported: (jobId, outcome) => outcomes.push({ jobId, action: outcome.action }),
	});
	const record: FleetRecord = {
		job_id: JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(home.path, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: join(home.path, "wt"),
		branch: JOB_ID,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
	await fleet.add(record);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return { home, fleet, runs, intake, watcher, worker: new StubWorker(), outcomes };
}

/** Write the envelope the worker-reporter would have written. */
function fileEnvelope(home: string, jobId: string, envelope: Partial<Envelope> = {}): void {
	const dir = join(home, paths.runDir(jobId));
	mkdirSync(dir, { recursive: true });
	const record: EnvelopeRecord = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		received_at: isoTimestamp(),
		attempt: 1,
		envelope: {
			job_id: jobId,
			kind: "ship",
			status: "done",
			summary: "shipped it",
			branch: jobId,
			pr_url: "https://github.com/demo/demo/pull/29",
			...envelope,
		} as Envelope,
	};
	writeFileSync(join(home, paths.envelopeFile(jobId)), `${JSON.stringify(record, null, 2)}\n`);
}

function statusJob(overrides: Partial<StatusJob> = {}): StatusJob {
	return {
		job_id: JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		title: null,
		br_status: null,
		profile: "implementer",
		role: "implementer",
		model: "mock/model",
		run_phase: "idle",
		current_tool: null,
		current_tool_seconds: null,
		turns: 3,
		tool_calls: 12,
		alive: true,
		pid: process.pid,
		session_id: "s",
		worktree: "/tmp/wt",
		branch: JOB_ID,
		timestamp: isoTimestamp(),
		time_source: "dispatched_at",
		age_seconds: 120,
		last_activity_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		...overrides,
	};
}

/** A one-job snapshot, for the pure detectors and the table renderer. */
function snapshotOf(job: StatusJob): StatusSnapshot {
	const snapshot: StatusSnapshot = {
		schema_version: SCHEMA_VERSION,
		generated_at: isoTimestamp(),
		home: "/home/operator/pi-command-post",
		filter: { include: "active", project: null },
		counts: {
			jobs: 1,
			launching: job.phase === "launching" ? 1 : 0,
			waiting: job.phase === "waiting" ? 1 : 0,
			held: job.phase === "held" ? 1 : 0,
			done: job.phase === "done" ? 1 : 0,
			failed: job.phase === "failed" ? 1 : 0,
			live: job.alive ? 1 : 0,
			working: job.run_phase === "working" ? 1 : 0,
		},
		usage: job.usage,
		ledger: { ok: true, queried: true },
		jobs: [job],
		unclaimed: [],
	};
	// Fabricated fixtures are only useful if they are legal ones: a snapshot that
	// could never come off disk proves nothing about the detectors that read it.
	const checked = validate<StatusSnapshot>(StatusSnapshotSchema, snapshot);
	assert.ok(checked.ok, `fabricated snapshot violates the contract: ${checked.ok ? "" : checked.errors.join("; ")}`);
	return snapshot;
}

// ---------------------------------------------------------------------------
// 1. The nudge: exactly once, and the report that follows is accepted
// ---------------------------------------------------------------------------

test("the nudge is driven by the worker's own agent_settled event, never a poll", async (t) => {
	const b = await bench(t);
	const detach = b.watcher.watch(JOB_ID, b.worker);
	b.worker.settle();
	await waitFor(
		() => b.fleet.require(JOB_ID),
		(record) => record.unreported_settles === 1,
		{ what: "the settle to be noticed" },
	);
	assert.equal(b.worker.sent.length, 1);

	// Detaching stops it dead: nothing here is timer-driven.
	detach();
	b.worker.settle();
	assert.equal(b.worker.sent.length, 1);
});

test("detaching drops the pending-retry guard with the listener it belonged to", async (t) => {
	const b = await bench(t);
	let consulted = 0;
	const detach = b.watcher.watch(JOB_ID, b.worker, () => {
		consulted += 1;
		return true;
	});
	detach();

	// The predicate would have claimed this settle; after detach it must not even
	// be read, so the settle takes its ordinary path and nudges.
	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(consulted, 0, "a detached watcher's predicate is never consulted");
	assert.equal(outcome.action, "nudged");
});

test("the retry guard outlives one settle: the ladder re-arms it on each failure", async (t) => {
	const b = await bench(t);
	b.watcher.watch(JOB_ID, b.worker, () => true);
	assert.equal((await b.watcher.settled(JOB_ID, b.worker)).action, "ignored");
	// The next transient failure sets the flag again before its own
	// `agent_settled`; the guard must still be attached to see it (H1 finding 1).
	assert.equal((await b.watcher.settled(JOB_ID, b.worker)).action, "ignored");
	assert.equal(b.worker.sent.length, 0, "a retry-claimed settle is never nudged");
});

test("detaching an earlier watch leaves a later watch's retry guard for the same job intact", async (t) => {
	const b = await bench(t);
	const detachA = b.watcher.watch(JOB_ID, b.worker, () => false);
	let consultedB = 0;
	b.watcher.watch(JOB_ID, b.worker, () => {
		consultedB += 1;
		return true;
	});
	detachA();

	// A's detach must not take B's entry with it: B's predicate is what gates
	// this settle, and it is the one consulted.
	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(consultedB, 1, "the later watch's predicate is still the stored guard");
	assert.equal(outcome.action, "ignored");
});

test("dispatch wires the settle watcher onto every worker it observes", () => {
	const watched: string[] = [];
	const order: string[] = [];
	attachWorkerObservers({
		recorder: { attach: () => () => {} } as unknown as RunRecorder,
		worker: new StubWorker() as unknown as WorkerProcess,
		jobId: JOB_ID,
		intake: { watch: () => { order.push("intake"); return () => {}; } } as unknown as EnvelopeIntake,
		settle: {
			watch: (jobId: string) => {
				order.push("settle");
				watched.push(jobId);
				return () => {};
			},
		} as unknown as SettleWatcher,
	});
	assert.deepEqual(watched, [JOB_ID]);
	// Intake first: the nudge must never fire at a worker whose envelope is on disk.
	assert.deepEqual(order, ["intake", "settle"]);
});

test("a worker that settles without an envelope is prompted exactly once", async (t) => {
	const b = await bench(t);
	b.watcher.watch(JOB_ID, b.worker);

	const first = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(first.action, "nudged");
	assert.equal(b.worker.sent.length, 1);
	assert.equal(b.worker.sent[0], REPORT_NUDGE_TEXT);
	assert.match(b.worker.sent[0] as string, /report_result/);

	// The fact is on the record and in the log, and the job is NOT failed: its
	// worker is idle, alive and promotable, with an open envelope slot.
	const record = b.fleet.require(JOB_ID);
	assert.equal(record.unreported_settles, 1);
	assert.equal(record.phase, "waiting");
	assert.equal(record.failure, undefined);
	const nudges = readRunEvents(b.home.path, JOB_ID).filter((event) => event.type === "report_nudged");
	assert.equal(nudges.length, 1);
});

test("the report that follows a nudge is accepted, and clears the unreported fact", async (t) => {
	const b = await bench(t);
	const nudged = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(nudged.action, "nudged");

	// The worker answers the nudge the way the tool would: envelope on disk,
	// then the run settles again.
	fileEnvelope(b.home.path, JOB_ID);
	const second = await b.watcher.settled(JOB_ID, b.worker);

	assert.equal(second.action, "reported");
	// Only the nudge was ever sent: a reported settle prompts nothing.
	assert.equal(b.worker.sent.length, 1);
	const record = b.fleet.require(JOB_ID);
	assert.equal(record.phase, "held");
	assert.ok(record.reported_at);
	assert.equal(record.unreported_settles, undefined, "an accepted envelope clears the settle counter");
	assert.equal(settledWithoutReport(statusJob({ phase: "held", reported_at: record.reported_at })), false);
});

test("an envelope already on disk at settle time is never nudged", async (t) => {
	const b = await bench(t);
	fileEnvelope(b.home.path, JOB_ID);
	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "reported");
	assert.equal(b.worker.sent.length, 0);
});

// ---------------------------------------------------------------------------
// 2. The bound: settling twice is recorded honestly, not prompted forever
// ---------------------------------------------------------------------------

test("a worker that settles twice with no report is recorded, not prompted again", async (t) => {
	const b = await bench(t);
	assert.equal((await b.watcher.settled(JOB_ID, b.worker)).action, "nudged");

	const second = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(second.action, "recorded");
	assert.equal(b.worker.sent.length, 1, "the nudge is spent, not repeated");

	// A third settle changes nothing about the prompt.
	const third = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(third.action, "recorded");
	assert.equal(b.worker.sent.length, 1);

	const events = readRunEvents(b.home.path, JOB_ID);
	assert.equal(events.filter((event) => event.type === "report_nudged").length, 1);
	assert.ok(events.filter((event) => event.type === "settled_without_report").length >= 1);
	assert.deepEqual(
		b.outcomes.map((entry) => entry.action),
		["nudged", "recorded", "recorded"],
	);
});

test("an undeliverable nudge is recorded rather than retried", async (t) => {
	const b = await bench(t);
	b.worker.receipt = "failed";
	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "recorded");
	const nudges = readRunEvents(b.home.path, JOB_ID).filter((event) => event.type === "report_nudged");
	assert.equal(nudges.length, 1);
	assert.equal((nudges[0]?.payload as { receipt?: string }).receipt, "failed");
});

test("a worker that is already gone is recorded, never prompted", async (t) => {
	const b = await bench(t);
	b.worker.alive = false;
	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "recorded");
	assert.equal(b.worker.sent.length, 0);
});

// ---------------------------------------------------------------------------
// 3. The ordinary path is unchanged
// ---------------------------------------------------------------------------

test("a job that is not this watcher's business is left alone", async (t) => {
	const b = await bench(t);
	await b.fleet.patch(JOB_ID, { phase: "done" });
	const done = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(done.action, "ignored");
	assert.equal(b.worker.sent.length, 0);

	const unknown = await b.watcher.settled("cp-unknown", b.worker);
	assert.equal(unknown.action, "ignored");
	assert.equal(b.worker.sent.length, 0);
});

test("a promote resets the nudge budget: a new brief is a new chance to report", async (t) => {
	const b = await bench(t);
	await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(b.fleet.require(JOB_ID).unreported_settles, 1);

	// What `cp_send` does before it delivers a new brief.
	await b.fleet.clearUnreportedSettles(JOB_ID);
	const afterPromote = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(afterPromote.action, "nudged");
	assert.equal(b.worker.sent.length, 2, "one nudge per brief, never one per job lifetime");
});

// ---------------------------------------------------------------------------
// 4. Settled-without-report is not a plain failure
// ---------------------------------------------------------------------------

test("a run that settled and exited without reporting is not classified as a crash", () => {
	const at = isoTimestamp();
	const events = [
		{ seq: 1, ts: at, job_id: JOB_ID, source: "cp" as const, type: "spawned", payload: {} },
		{ seq: 2, ts: at, job_id: JOB_ID, source: "pi" as const, type: "agent_start", payload: {} },
		{
			seq: 3,
			ts: at,
			job_id: JOB_ID,
			source: "pi" as const,
			type: "tool_execution_start",
			payload: { toolName: "bash", args: { command: "git push" } },
		},
		{ seq: 4, ts: at, job_id: JOB_ID, source: "pi" as const, type: "agent_settled", payload: {} },
		{ seq: 5, ts: at, job_id: JOB_ID, source: "cp" as const, type: "process_exit", payload: { code: 0 } },
	];
	const classified = classifyRun(events, { alive: false });
	assert.equal(classified?.class, "settled_without_report");
	assert.match(classified?.message ?? "", /report_result/);

	// A crash is still a crash: an exit with no settle behind it.
	const crashed = classifyRun(events.filter((event) => event.type !== "agent_settled"), { alive: false });
	assert.equal(crashed?.class, "crash");
});

// ---------------------------------------------------------------------------
// 4b. cp-0wq7: a settle that follows a model call that never happened
// ---------------------------------------------------------------------------

/** pi's own shape for a model call that errored: no content, no tokens. */
function failedModelCall(errorMessage = "401 Invalid API key"): Record<string, unknown> {
	return {
		message: {
			role: "assistant",
			content: [],
			provider: "anthropic",
			model: "claude-opus-5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "error",
			errorMessage,
		},
	};
}

/** Write the run log a dead-on-arrival worker leaves behind. */
function recordDeadOnArrival(b: Bench): void {
	const recorder = b.runs.open(JOB_ID);
	recorder.cp("spawned", { pid: 1, model: "anthropic/claude-opus-5", profile: "implementer" });
	recorder.cp("prompt_sent", { receipt: "delivered", bytes: 8716 });
	recorder.record("pi", "agent_start", {});
	recorder.record("pi", "turn_start", {});
	recorder.record("pi", "message_end", { message: { role: "user", content: [{ type: "text", text: "the brief" }] } });
	recorder.record("pi", "message_end", failedModelCall());
	recorder.record("pi", "turn_end", failedModelCall());
	recorder.record("pi", "agent_end", { willRetry: false });
}

test("a worker whose model call failed is failed closed, never nudged", async (t) => {
	const b = await bench(t);
	recordDeadOnArrival(b);

	const outcome = await b.watcher.settled(JOB_ID, b.worker);

	// Not one prompt: another one would only repeat the failed call.
	assert.equal(b.worker.sent.length, 0);
	assert.equal(outcome.action, "recorded");
	assert.equal(outcome.action === "recorded" ? outcome.failure?.class : undefined, "model_call_failed");

	// The job fails closed, with the provider's own words as the cause — not
	// "unreported", which said the fleet was still owed an envelope.
	const record = b.fleet.require(JOB_ID);
	assert.equal(record.phase, "failed");
	assert.equal(record.failure?.class, "model_call_failed");
	assert.match(record.failure?.message ?? "", /401 Invalid API key/);
	assert.equal(record.unreported_settles, undefined, "a worker that never ran is not an unreported settle");

	const events = readRunEvents(b.home.path, JOB_ID);
	assert.equal(events.filter((event) => event.type === "report_nudged").length, 0);
	assert.equal(events.filter((event) => event.type === "recovery_prompted").length, 0);
	assert.equal(events.filter((event) => event.type === "failure").length, 1);

	// A second settle changes nothing and still sends nothing.
	const again = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(again.action, "ignored", "a failed job is no longer this watcher's business");
	assert.equal(b.worker.sent.length, 0);

	const line = formatSettleOutcome(JOB_ID, outcome);
	assert.match(line ?? "", /dead on arrival/);
	assert.match(line ?? "", /401 Invalid API key/);
	assert.match(line ?? "", /re-dispatch/);
});

test("the dead-on-arrival check reads the log only for a run that produced nothing", async (t) => {
	// The cost bound (cp-0wq7): `detectDeadModelCall` parses the whole of
	// events.jsonl, and a long job's log is megabytes. The projection this
	// boundary has already read answers "could this run be dead on arrival?" for
	// free — a run with tokens or tool calls plainly did work — so only the tiny
	// logs of runs that emitted a handful of events and stopped are ever parsed.
	const zero = { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost_usd: 0 };
	assert.equal(mayBeDeadOnArrival(undefined), true, "no projection is ignorance, and ignorance never hides a failure");
	assert.equal(mayBeDeadOnArrival({ ...initialStatus(JOB_ID), usage: zero, tool_calls: 0 }), true);
	assert.equal(mayBeDeadOnArrival({ ...initialStatus(JOB_ID), usage: zero, tool_calls: 1 }), false);
	assert.equal(
		mayBeDeadOnArrival({ ...initialStatus(JOB_ID), usage: { ...zero, total_tokens: 12_000 }, tool_calls: 0 }),
		false,
	);

	// And the skip is real, not just a predicate: a run whose projection shows a
	// tool call is nudged without the log being parsed at all — which this proves
	// by leaving a line in events.jsonl that would throw if anything read it.
	const b = await bench(t);
	const recorder = b.runs.open(JOB_ID);
	recorder.cp("spawned", { pid: 1, model: "anthropic/claude-opus-5", profile: "implementer" });
	recorder.record("pi", "agent_start", {});
	recorder.record("pi", "message_end", failedModelCall());
	recorder.record("pi", "tool_execution_start", { toolName: "bash", toolCallId: "c1" });
	recorder.record("pi", "tool_execution_end", { toolCallId: "c1" });
	appendFileSync(join(b.home.path, paths.eventsFile(JOB_ID)), "{ this line is not json\n");

	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "nudged");
	assert.equal(b.worker.sent.length, 1);
});

test("a run that actually ran is still nudged, model errors or not", async (t) => {
	const b = await bench(t);
	const recorder = b.runs.open(JOB_ID);
	recorder.cp("spawned", { pid: 1, model: "anthropic/claude-opus-5", profile: "implementer" });
	recorder.record("pi", "agent_start", {});
	// One provider hiccup mid-run, then real work: the ordinary boundary applies.
	recorder.record("pi", "message_end", failedModelCall("529 overloaded"));
	recorder.record("pi", "tool_execution_start", { toolName: "bash", toolCallId: "c1" });
	recorder.record("pi", "tool_execution_end", { toolCallId: "c1" });
	recorder.record("pi", "message_end", { message: { role: "assistant", content: [{ type: "text", text: "pushed" }] } });

	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "nudged");
	assert.equal(b.worker.sent.length, 1);
	assert.equal(b.fleet.require(JOB_ID).phase, "waiting", "a run that did work is never failed by the boundary");
});

test("the recovery ladder never re-runs a brief whose delivery may already exist", () => {
	const decision = decideRecovery({ class: "settled_without_report", role: "implementer", attempts: 0 });
	assert.equal(decision.action, "escalate");
	assert.match(decision.reason, /cp_send|promote/);
});

test("a settled-without-report job renders as unreported, not as a failure", () => {
	const live = statusJob({ unreported_settles: 1 });
	assert.equal(settledWithoutReport(live), true);
	const state = jobState(live);
	assert.equal(state.kind, "unreported");
	assert.equal(state.word, "unreported");
	assert.equal(state.section, "attention");

	// Even once the worker has exited and the classifier has spoken, the word is
	// the specific one: `failed` would say the work is lost, and it is not.
	const exited = statusJob({
		phase: "failed",
		run_phase: "exited",
		alive: false,
		failure: {
			class: "settled_without_report",
			message: "the run settled and then exited without calling report_result",
			at: isoTimestamp(),
		},
	});
	assert.equal(jobState(exited).kind, "unreported");

	// An ordinary failure is untouched.
	const failed = statusJob({
		phase: "failed",
		failure: { class: "crash", message: "worker exited (code 1) without reporting", at: isoTimestamp() },
	});
	assert.equal(jobState(failed).kind, "failed");

	// And an ordinary idle worker is still just idle.
	assert.equal(jobState(statusJob()).kind, "idle");
});

test("a settled-without-report job with a pushed branch is not shown as a failure", async (t) => {
	const b = await bench(t);
	// The incident, exactly: the worker pushed and opened a green PR, then settled
	// without filing an envelope. Its one nudge is spent and the fact is recorded.
	await b.fleet.patch(JOB_ID, {
		receipts: [{ kind: "pr", status: "open", title: `PR for ${JOB_ID}`, url: "https://github.com/demo/demo/pull/29" }],
	});
	await b.watcher.settled(JOB_ID, b.worker);
	await b.watcher.settled(JOB_ID, b.worker);

	const record = b.fleet.require(JOB_ID);
	assert.equal(record.phase, "waiting", "finished work is never marked failed");
	assert.equal(record.failure, undefined);
	assert.equal(record.unreported_settles, 2);

	const snapshot = assembleStatus({
		home: b.home.path,
		generated_at: isoTimestamp(),
		include: "all",
		records: [record],
		runs: new Map([[JOB_ID, { ...initialStatus(JOB_ID), phase: "idle" as const }]]),
		alive: new Map([[JOB_ID, true]]),
		ledger: { ok: false, queried: false },
	});
	const job = snapshot.jobs[0];
	assert.ok(job);
	assert.equal(job.unreported_settles, 2, "/status carries the fact, it does not re-derive it");
	assert.equal(jobState(job).word, "unreported");

	// The two operator-facing surfaces say the same word, from the same call.
	const block = assembleStatusBlock(snapshot);
	assert.match(block.text, /unreported/);
	assert.doesNotMatch(block.text, /failed/);
	const widget = renderFleetWidget(snapshot, { width: 100 }).map((line) => line.text);
	assert.ok(widget.some((line) => line.includes("unreported")), "the widget names it too");
	assert.ok(
		widget.some((line) => line.includes("no envelope filed")),
		"and says what is actually missing",
	);
});

// ---------------------------------------------------------------------------
// 5. The two watchers are disjoint (cp-settle-without-report x cp-wedged-tool-call)
// ---------------------------------------------------------------------------

/**
 * A worker cannot be settled and mid-tool-call at the same moment, so exactly
 * one of the two "something is wrong" watchers can ever be true for a job.
 * These pin that from both directions, including the one seam where they could
 * collide: a nudged worker that started running again.
 */
test("a wedged worker is not unreported: it never settled", () => {
	// The cp-wedged-tool-call shape: mid-call, alive, working, silent for an hour.
	const wedged = statusJob({
		run_phase: "working",
		current_tool: "bash",
		current_tool_seconds: 3600,
		current_tool_idle_seconds: 3600,
	});
	assert.equal(isWedgedToolCall(wedged), true);
	assert.equal(settledWithoutReport(wedged), false, "a run in flight has not settled without reporting");
	assert.equal(detectWedgedToolCalls(snapshotOf(wedged)).length, 1);
	assert.equal(jobState(wedged).kind, "long-tool");
});

test("an unreported worker is not wedged: it holds no open tool call", () => {
	// The cp-settle-without-report shape: settled, idle, no call open. This is
	// what agent_settled projects (run-artifacts clears current_tool on settle).
	const unreported = statusJob({ unreported_settles: 2, run_phase: "idle", current_tool: null });
	assert.equal(settledWithoutReport(unreported), true);
	assert.equal(isWedgedToolCall(unreported), false, "there is no open call to be silent");
	assert.equal(detectWedgedToolCalls(snapshotOf(unreported)).length, 0);
	assert.equal(jobState(unreported).kind, "unreported");
});

test("a nudged worker that is running again is `working`, and a wedge there still surfaces", () => {
	// The one seam: the nudge landed, the worker started a new turn, and its
	// counter is still set. The honest present-tense state is `working` -- the
	// unreported fact is about a run that has STOPPED -- and if that new call
	// goes silent it must surface as the wedge it is, unmasked.
	const running = statusJob({
		unreported_settles: 1,
		run_phase: "working",
		current_tool: "bash",
		current_tool_seconds: 30,
		current_tool_idle_seconds: 30,
	});
	assert.equal(settledWithoutReport(running), false, "a working run is never reported as unreported");
	assert.equal(jobState(running).kind, "working");

	const wedgedAfterNudge = { ...running, current_tool_seconds: 3600, current_tool_idle_seconds: 3600 };
	assert.equal(isWedgedToolCall(wedgedAfterNudge), true);
	assert.equal(detectWedgedToolCalls(snapshotOf(wedgedAfterNudge)).length, 1, "the counter must not mask a wedge");
	assert.equal(settledWithoutReport(wedgedAfterNudge), false);
	assert.equal(jobState(wedgedAfterNudge).kind, "long-tool");

	// And when that run finally settles with still no envelope, the fact returns.
	const settledAgain = { ...running, run_phase: "idle" as const, current_tool: null, current_tool_idle_seconds: null };
	assert.equal(settledWithoutReport(settledAgain), true);
	assert.equal(jobState(settledAgain).kind, "unreported");
});

test("no job is ever reported as both wedged and unreported", () => {
	// Every combination of the inputs the two predicates read, asserted as
	// mutually exclusive -- so a later edit to either cannot make them overlap.
	const phases = [null, "starting", "working", "idle", "exited"] as const;
	for (const run_phase of phases) {
		for (const tool of [null, "bash"]) {
			for (const settles of [undefined, 1, 2]) {
				for (const idle of [null, 0, 3600]) {
					const job = statusJob({
						run_phase,
						current_tool: tool,
						current_tool_seconds: tool ? 3600 : null,
						current_tool_idle_seconds: idle,
						...(settles === undefined ? {} : { unreported_settles: settles }),
					});
					assert.ok(
						!(isWedgedToolCall(job) && settledWithoutReport(job)),
						`both fired for run_phase=${run_phase} tool=${tool} settles=${settles} idle=${idle}`,
					);
				}
			}
		}
	}
});

test("the /status row says which of the two it is, and never both", () => {
	const unreported = formatStatusTable(snapshotOf(statusJob({ unreported_settles: 1, run_phase: "idle" })));
	assert.match(unreported, /settled without filing an envelope/);
	assert.doesNotMatch(unreported, /possibly wedged/);

	const wedged = formatStatusTable(
		snapshotOf(
			statusJob({
				run_phase: "working",
				current_tool: "bash",
				current_tool_seconds: 3600,
				current_tool_idle_seconds: 3600,
				unreported_settles: 1,
			}),
		),
	);
	assert.match(wedged, /possibly wedged/);
	assert.doesNotMatch(wedged, /settled without filing an envelope/);
});

test("the operator line names the recovery, and never carries a body", () => {
	const line = formatSettleOutcome(JOB_ID, { action: "recorded", settles: 2 });
	assert.ok(line);
	assert.match(line as string, /cp_send cp-settle/);
	assert.ok((line as string).split("\n").length <= 3);
	assert.equal(formatSettleOutcome(JOB_ID, { action: "reported" }), undefined);
});
