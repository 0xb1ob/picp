/**
 * Retained verbatim (P11c); reachable outcomes are P11c-run-log. Missing entry points: a suppressed wake-up lands in
 * its teardown's second, a revive needs a resumable session, in-flight usage and the pre-event projection go unlogged.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, paths, type RunEvent, validateRunStatus } from "../src/contracts.ts";
import { applyEvent, initialProjection, initialStatus, projectEvents, rebuildStatus } from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, readRunStatus } from "./harness/index.ts";

const JOB_ID = "cp-run1";

function ev(seq: number, source: "pi" | "cp", type: string, payload: unknown = {}, tsSeconds = seq): RunEvent {
	return {
		seq,
		ts: isoTimestamp(new Date(Date.UTC(2026, 7, 27, 12, 0, tsSeconds))),
		job_id: JOB_ID,
		source,
		type,
		payload,
	};
}

function assistantMessage(usage: Record<string, unknown>): Record<string, unknown> {
	return { message: { role: "assistant", usage } };
}

test("streaming usage is neither double counted nor invisible", () => {
	let state = initialProjection(JOB_ID);
	state = applyEvent(state, ev(1, "pi", "message_update", { usage: { input: 10, output: 5, totalTokens: 15 } }));
	assert.equal(state.status.usage.total_tokens, 15, "in-flight usage is visible");

	state = applyEvent(state, ev(2, "pi", "message_update", { usage: { input: 10, output: 9, totalTokens: 19 } }));
	assert.equal(state.status.usage.total_tokens, 19, "cumulative, not additive");

	state = applyEvent(state, ev(3, "pi", "message_end", assistantMessage({ input: 10, output: 9, totalTokens: 19 })));
	assert.equal(state.status.usage.total_tokens, 19, "final message replaces the in-flight estimate");

	state = applyEvent(state, ev(4, "pi", "message_end", assistantMessage({ input: 1, output: 1, totalTokens: 2 })));
	assert.equal(state.status.usage.total_tokens, 21, "second message adds up");

	// User/tool messages carry no assistant usage.
	state = applyEvent(state, ev(5, "pi", "message_end", { message: { role: "user" } }));
	assert.equal(state.status.usage.total_tokens, 21);
});

/**
 * The shape that dead-ended a real job (cp-worker-doa-settle-5ttg): pi events
 * teed after `cp:process_exit`. The projection used to move back to `working`
 * while `exited_at` still stood, which `validateRunStatus` refuses — so
 * `RunRecorder.open` threw, and `cp_revive` and `cp_teardown --force` both
 * refused the job with "run status projection is invalid". No sanctioned exit.
 */
const POST_EXIT: RunEvent[] = [
	ev(1, "cp", "spawned", { pid: 4242, model: "mock/script-x", profile: "implementer" }),
	ev(2, "pi", "agent_start"),
	ev(3, "pi", "agent_settled"),
	ev(4, "cp", "process_exit", { code: 0, signal: null }),
	// Everything below landed after the child's close was observed.
	ev(5, "pi", "turn_start"),
	ev(6, "pi", "message_start", { message: { role: "user", content: [] } }),
	ev(7, "pi", "agent_start"),
	ev(8, "pi", "tool_execution_start", { toolName: "bash", toolCallId: "late-1" }),
	ev(9, "pi", "agent_settled"),
];

/**
 * pi-command-post-long-idle-sessions-8sz. Two Sep 5-6 jobs read as 14-17h
 * sessions at $11-$24. Neither held a lease: both merged and were torn down
 * seconds later (`integration_advanced step: done`). What was long was
 * `last_activity_at`, because every later parent session re-checked the same
 * queued wake-ups, found them stale, and appended `cp:wakeup_suppressed`
 * markers to a run log whose process had exited the day before.
 */
const SUPPRESSED_AFTER_CLOSE: RunEvent[] = [
	ev(1, "cp", "spawned", { pid: 4242, model: "mock/script-x", profile: "implementer" }),
	ev(2, "pi", "agent_start"),
	ev(3, "pi", "agent_settled"),
	ev(4, "cp", "process_exit", { code: 0, signal: null }),
	// Hours later, a fresh parent session re-withholds the same wake-ups.
	ev(5, "cp", "wakeup_suppressed", { kind: "envelope", issued_at: "2026-08-27T11:00:00Z", reason: "cp-run1 is already done", stage: "delivery" }, 4000),
	ev(6, "cp", "wakeup_suppressed", { kind: "verdict", issued_at: "2026-08-27T11:00:00Z", reason: "cp-run1 is already done", stage: "delivery" }, 8000),
];

test("a suppressed wake-up is logged but never counts as activity", () => {
	const status = projectEvents(JOB_ID, SUPPRESSED_AFTER_CLOSE);
	// The log is still the history: nothing is dropped.
	assert.equal(status.event_count, SUPPRESSED_AFTER_CLOSE.length);
	// But a message the parent declined to send is not this run doing anything.
	assert.equal(
		status.last_activity_at,
		SUPPRESSED_AFTER_CLOSE[3]?.ts,
		"last activity stays at the observed close, not at the parent's bookkeeping",
	);
	assert.equal(status.phase, "exited");
	const checked = validateRunStatus(status);
	assert.ok(checked.ok, `projection must satisfy the contract: ${checked.ok ? "" : checked.errors.join("; ")}`);
});

test("a suppressed wake-up does not refresh a live run's idle age either", () => {
	let state = initialProjection(JOB_ID);
	state = applyEvent(state, ev(1, "pi", "agent_settled"));
	const settled = state.status.last_activity_at;
	state = applyEvent(state, ev(2, "cp", "wakeup_suppressed", { kind: "ci", issued_at: "2026-08-27T11:00:00Z" }, 600));
	assert.equal(state.status.last_activity_at, settled, "an idle worker is no less idle for a wake-up it never got");
	assert.equal(state.status.event_count, 2);
});

test("a run whose events outlived the process can still be opened, revived and torn down", () => {
	const home = createScratchHome();
	try {
		const file = join(home.path, paths.eventsFile(JOB_ID));
		mkdirSync(join(home.path, paths.runDir(JOB_ID)), { recursive: true });
		writeFileSync(file, POST_EXIT.map((event) => `${JSON.stringify(event)}\n`).join(""));

		// Both cp_revive and cp_teardown reach the run through the registry: this
		// call is the one that used to throw and leave the job with no exit.
		const registry = new RunRegistry(home.path);
		const recorder = registry.open(JOB_ID);
		assert.equal(recorder.status.phase, "exited");
		assert.equal(readRunStatus(home.path, JOB_ID).phase, "exited");
		recorder.cp("shutdown_requested", { job_id: JOB_ID, forced: true });
		assert.equal(readRunStatus(home.path, JOB_ID).phase, "exited");

		// A relaunch is what reopens liveness — an event never does.
		recorder.cp("worker_revived", { pid: 5151, session_file: join(home.path, "s.jsonl"), model: "mock/script-x" });
		assert.equal(recorder.status.phase, "starting");
		assert.equal(recorder.status.exited_at, undefined);
		assert.equal(recorder.status.exit_code, undefined);
		assert.equal(recorder.status.pid, 5151, "the revived process is the one on the record");
		recorder.record("pi", "agent_start", {});
		assert.equal(recorder.status.phase, "working");
		assert.equal(readRunStatus(home.path, JOB_ID).phase, "working");

		// And the log still rebuilds to exactly what the writer had in memory.
		assert.deepEqual(rebuildStatus(home.path, JOB_ID), recorder.status);
		registry.closeAll();
	} finally {
		home.cleanup();
	}
});

test("initialStatus is a valid, minimal projection", () => {
	const status = initialStatus(JOB_ID, { model: "m" });
	assert.equal(status.phase, "starting");
	assert.equal(status.event_count, 0);
	assert.equal(status.reported, false);
	assert.equal(status.model, "m");
});

