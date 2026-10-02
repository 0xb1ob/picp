/**
 * H1 (Pier 2.6): command-post's own outer retry ladder, above pi's own.
 *
 * Hermetic: `StubWorker` is exactly the surface `watchOuterProviderRetry`
 * uses (`alive`, `send`, `onEvent`); fake timers stand in for the real
 * 5/10/20/40/80 s ladder so the test asserts the delays without waiting them
 * out.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, type SendReceipt } from "../src/contracts.ts";
import { attachWorkerObservers } from "../src/dispatch.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake } from "../src/intake.ts";
import {
	isTransientProviderError,
	MAX_OUTER_RETRIES,
	OUTER_RETRY_DELAYS_MS,
	RESUME_NUDGE,
	watchOuterProviderRetry,
} from "../src/provider-retry.ts";
import { RunRegistry } from "../src/runs.ts";
import { REPORT_NUDGE_TEXT, SettleWatcher } from "../src/settle.ts";
import type { WorkerEvent, WorkerProcess } from "../src/worker-process.ts";
import { createScratchHome, readRunEvents } from "./harness/index.ts";

const JOB_ID = "cp-provider-retry";

/** Exactly the surface `watchOuterProviderRetry` uses, and nothing else. */
class StubWorker {
	alive = true;
	readonly sent: string[] = [];
	receipt: SendReceipt = "delivered";
	/** Never resolves: nothing in these tests observes a close. */
	readonly closed = new Promise<never>(() => {});
	readonly #listeners = new Set<(event: WorkerEvent) => void>();

	async send(message: string, _mode?: "prompt" | "steer" | "follow_up"): Promise<{ receipt: SendReceipt; error?: string }> {
		this.sent.push(message);
		return { receipt: this.receipt };
	}

	onEvent(listener: (event: WorkerEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: WorkerEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}

	agentStart(): void {
		this.emit({ type: "agent_start" });
	}

	/** An assistant turn that errored, exactly as pi reports it (docs/json.md). */
	failedTurn(message: string): void {
		this.emit({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: message, content: [] },
		});
		this.emit({ type: "agent_settled" });
	}

	/** An assistant turn that came back clean. */
	okTurn(text = "done"): void {
		this.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		});
		this.emit({ type: "agent_settled" });
	}
}

function bench() {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	const recorder = runs.open(JOB_ID);
	const worker = new StubWorker();
	const handle = watchOuterProviderRetry({ jobId: JOB_ID, worker: worker as never, recorder });
	return { home, runs, recorder, worker, handle, detach: handle.detach };
}

test("isPending() is true from the failing message_end, before agent_settled ever fires", () => {
	const { home, runs, worker, handle, detach } = bench();
	try {
		assert.equal(handle.isPending(), false);
		worker.agentStart();
		// Emit message_end only \u2014 no agent_settled yet. isPending() must already
		// be true (H1 review, finding 1): a settle watcher racing this exact event
		// must see the flag before it decides anything.
		worker.emit({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded", content: [] },
		});
		assert.equal(handle.isPending(), true, "pending before agent_settled");
		worker.emit({ type: "agent_settled" });
		assert.equal(handle.isPending(), true, "still pending: the delayed resume nudge has not resolved yet");

		// A non-transient error must never claim the settle.
		worker.agentStart();
		worker.emit({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "401 Invalid API key", content: [] },
		});
		assert.equal(handle.isPending(), false, "never pending for a non-transient error");
	} finally {
		detach();
		runs.closeAll();
		home.cleanup();
	}
});

test("isTransientProviderError: retries capacity/connectivity, never quota/auth", () => {
	assert.equal(isTransientProviderError("529 overloaded"), true);
	assert.equal(isTransientProviderError("429 rate limited, try again"), true);
	assert.equal(isTransientProviderError("502 Bad Gateway"), true);
	assert.equal(isTransientProviderError("ECONNRESET"), true);
	assert.equal(isTransientProviderError("request timed out"), true);

	assert.equal(isTransientProviderError("quota exceeded for this project"), false);
	assert.equal(isTransientProviderError("usage limit reached"), false);
	assert.equal(isTransientProviderError("401 Invalid API key"), false);
	assert.equal(isTransientProviderError("insufficient credit balance"), false);
	assert.equal(isTransientProviderError("something odd nobody has seen before"), false);
});

test("named ladder: 5 attempts, 5/10/20/40/80s, ~155s total", () => {
	assert.deepEqual(OUTER_RETRY_DELAYS_MS, [5_000, 10_000, 20_000, 40_000, 80_000]);
	assert.equal(MAX_OUTER_RETRIES, 5);
	assert.equal(OUTER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0), 155_000);
});

test("transient exhaustion sends the resume nudge on the ladder's delays, never the original brief", async () => {
	const timers = mock.timers;
	timers.enable({ apis: ["setTimeout"] });
	try {
		const { home, runs, worker, detach } = bench();
		try {
			worker.agentStart();
			worker.failedTurn("529 overloaded, try again");
			assert.equal(worker.sent.length, 0, "no nudge before the first delay elapses");

			await timers.tick(OUTER_RETRY_DELAYS_MS[0] as number);
			await Promise.resolve();
			assert.deepEqual(worker.sent, [RESUME_NUDGE]);
			assert.notEqual(worker.sent[0], "the original brief text", "never re-sends the task");

			const events = readRunEvents(home.path, JOB_ID);
			const attempt = events.find((e) => e.type === "outer_retry_attempt");
			assert.ok(attempt, "attempt journaled");
			assert.equal((attempt?.payload as { attempt?: number }).attempt, 1);
			assert.equal((attempt?.payload as { delayMs?: number }).delayMs, OUTER_RETRY_DELAYS_MS[0]);

			// The resumed turn succeeds: the ladder resets.
			worker.agentStart();
			worker.okTurn();
			const succeeded = readRunEvents(home.path, JOB_ID).find((e) => e.type === "outer_retry_succeeded");
			assert.ok(succeeded, "success journaled and ladder reset");
			assert.equal((succeeded?.payload as { afterAttempts?: number }).afterAttempts, 1);
		} finally {
			detach();
			runs.closeAll();
			home.cleanup();
		}
	} finally {
		timers.reset();
	}
});

test("attempt count is capped at MAX_OUTER_RETRIES", async () => {
	const timers = mock.timers;
	timers.enable({ apis: ["setTimeout"] });
	try {
		const { home, runs, worker, detach } = bench();
		try {
			for (let i = 0; i < MAX_OUTER_RETRIES; i++) {
				worker.agentStart();
				worker.failedTurn("503 Service Unavailable");
				await timers.tick(OUTER_RETRY_DELAYS_MS[i] as number);
				await Promise.resolve();
			}
			assert.equal(worker.sent.length, MAX_OUTER_RETRIES);

			// One more failure: the ladder is spent, no further attempt/send.
			worker.agentStart();
			worker.failedTurn("503 Service Unavailable");
			await Promise.resolve();
			assert.equal(worker.sent.length, MAX_OUTER_RETRIES, "no attempt past the cap");

			const exhausted = readRunEvents(home.path, JOB_ID).find((e) => e.type === "outer_retry_exhausted");
			assert.ok(exhausted, "exhaustion journaled");
			assert.equal((exhausted?.payload as { attempts?: number }).attempts, MAX_OUTER_RETRIES);
		} finally {
			detach();
			runs.closeAll();
			home.cleanup();
		}
	} finally {
		timers.reset();
	}
});

test("quota/auth errors are never retried", async () => {
	const { home, runs, worker, detach } = bench();
	try {
		worker.agentStart();
		worker.failedTurn("401 Invalid API key");
		await Promise.resolve();
		assert.equal(worker.sent.length, 0);
		// Nothing was ever transient here, so the ladder never wrote an event —
		// the events file itself may not exist yet.
		let events: ReturnType<typeof readRunEvents> = [];
		try {
			events = readRunEvents(home.path, JOB_ID);
		} catch {
			// no events.jsonl at all: also "no attempt", the assertion below still holds
		}
		const attempt = events.find((e) => e.type === "outer_retry_attempt");
		assert.equal(attempt, undefined, "no attempt for a non-transient error");
	} finally {
		detach();
		runs.closeAll();
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// H1 review, finding 1: attachWorkerObservers-level \u2014 the outer ladder and
// the settle-without-report boundary share one `agent_settled`, and only one
// of them may act on a given settle.
// ---------------------------------------------------------------------------

const ATTACH_JOB_ID = "cp-attach-retry";

function attachBench(t: { after(fn: () => void | Promise<void>): void }) {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const fail = (jobId: string, failure: Parameters<FleetStore["markFailed"]>[1]) => fleet.markFailed(jobId, failure);
	const intake = new EnvelopeIntake({ home: home.path, fleet, runs, fail });
	const settle = new SettleWatcher({ fleet, fail, runs, intake });
	const record: FleetRecord = {
		job_id: ATTACH_JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: `${home.path}/s.jsonl`,
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: `${home.path}/wt`,
		branch: ATTACH_JOB_ID,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return { home, fleet, runs, settle, record, worker: new StubWorker() };
}

test("attachWorkerObservers: a pending outer retry is never also nudged for an unreported envelope, and the job is not marked failed mid-ladder", async (t) => {
	const timers = mock.timers;
	timers.enable({ apis: ["setTimeout"] });
	try {
		const { fleet, runs, settle, record, worker } = attachBench(t);
		await fleet.add(record);
		const recorder = runs.open(ATTACH_JOB_ID);
		attachWorkerObservers({
			recorder,
			worker: worker as unknown as WorkerProcess,
			jobId: ATTACH_JOB_ID,
			settle,
		});

		// A transient failure with nothing else in the run at all is exactly the
		// dead-on-arrival shape settle.ts's own #failModelCall exists to catch
		// (cp-0wq7) \u2014 the same settle the outer ladder is also driving.
		worker.agentStart();
		worker.failedTurn("529 overloaded, try again");
		// Give the (fake-timer-free) async settle watcher's promise chain a turn
		// to run, the same way a real event loop would before the ladder's timer
		// fires.
		await Promise.resolve();
		await Promise.resolve();

		// Not marked failed: the ladder, not settle.ts, owns this settle.
		assert.equal(fleet.get(ATTACH_JOB_ID)?.phase, "waiting", "not classified failed mid-ladder");
		// No REPORT_NUDGE_TEXT: settle.ts must not have sent its own prompt.
		assert.equal(worker.sent.includes(REPORT_NUDGE_TEXT), false, "settle's own nudge must not fire mid-ladder");
		assert.equal(worker.sent.length, 0, "no prompt at all before the ladder's own delay elapses");

		// The ladder's delay elapses: exactly one prompt goes out, and it is the
		// resume nudge \u2014 never REPORT_NUDGE_TEXT, never the original brief.
		await timers.tick(OUTER_RETRY_DELAYS_MS[0] as number);
		await Promise.resolve();
		assert.deepEqual(worker.sent, [RESUME_NUDGE], "exactly one prompt per ladder step");
		assert.equal(fleet.get(ATTACH_JOB_ID)?.phase, "waiting", "still not failed after the first retry");
	} finally {
		timers.reset();
	}
});
