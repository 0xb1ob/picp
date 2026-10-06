/**
 * T4 acceptance: the projection matches a scripted event sequence, and files
 * are the only read surface (a real worker is teed end-to-end).
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, paths, type RunEvent, validateRunStatus } from "../src/contracts.ts";
import {
	applyEvent,
	initialProjection,
	initialStatus,
	parseEventLog,
	projectEvents,
	rebuildStatus,
	readEventLog,
	RunRecorder,
} from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import { WorkerProcess } from "../src/worker-process.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readRunEvents,
	readRunStatus,
	waitFor,
} from "./harness/index.ts";

const BR = "cp-run1";

function ev(seq: number, source: "pi" | "cp", type: string, payload: unknown = {}, tsSeconds = seq): RunEvent {
	return {
		seq,
		ts: isoTimestamp(new Date(Date.UTC(2026, 7, 27, 12, 0, tsSeconds))),
		job_id: BR,
		source,
		type,
		payload,
	};
}

function assistantMessage(usage: Record<string, unknown>): Record<string, unknown> {
	return { message: { role: "assistant", usage } };
}

const SCRIPTED: RunEvent[] = [
	ev(1, "cp", "spawned", { pid: 999, model: "mock/script-x", profile: "implementer", session_id: "sess-1" }),
	ev(2, "pi", "agent_start"),
	ev(3, "pi", "turn_start"),
	ev(4, "pi", "tool_execution_start", { toolName: "bash", toolCallId: "call-1" }),
	ev(5, "pi", "tool_execution_end", { toolName: "bash", toolCallId: "call-1" }),
	ev(
		6,
		"pi",
		"message_end",
		assistantMessage({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.01 } }),
	),
	ev(7, "pi", "turn_end"),
	ev(8, "pi", "tool_execution_start", { toolName: "report_result", toolCallId: "call-2" }),
	ev(9, "cp", "envelope_received", { status: "done" }),
	ev(10, "pi", "tool_execution_end", { toolName: "report_result", toolCallId: "call-2" }),
	ev(
		11,
		"pi",
		"message_end",
		assistantMessage({ input: 200, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { total: 0.02 } }),
	),
	ev(12, "pi", "turn_end"),
	ev(13, "pi", "agent_settled"),
];

test("projection matches a scripted event sequence", () => {
	const status = projectEvents(BR, SCRIPTED);
	assert.equal(status.phase, "idle");
	assert.equal(status.turns, 2);
	assert.equal(status.tool_calls, 2);
	assert.equal(status.current_tool, null);
	assert.equal(status.reported, true);
	assert.equal(status.pid, 999);
	assert.equal(status.model, "mock/script-x");
	assert.equal(status.profile, "implementer");
	assert.equal(status.session_id, "sess-1");
	assert.equal(status.event_count, SCRIPTED.length);
	assert.equal(status.last_activity_at, SCRIPTED.at(-1)?.ts);
	assert.equal(status.settled_at, SCRIPTED.at(-1)?.ts);
	assert.deepEqual(status.usage, {
		input: 300,
		output: 50,
		cache_read: 5,
		cache_write: 0,
		total_tokens: 355,
		cost_usd: 0.03,
	});
});

test("phase transitions and current tool follow the events", () => {
	let state = initialProjection(BR);
	assert.equal(state.status.phase, "starting");

	state = applyEvent(state, ev(1, "pi", "agent_start"));
	assert.equal(state.status.phase, "working");

	state = applyEvent(state, ev(2, "pi", "tool_execution_start", { toolName: "read", toolCallId: "c1" }));
	assert.deepEqual(state.status.current_tool, { name: "read", tool_call_id: "c1", started_at: state.status.last_activity_at });

	state = applyEvent(state, ev(3, "pi", "tool_execution_end", { toolCallId: "c1" }));
	assert.equal(state.status.current_tool, null);

	state = applyEvent(state, ev(4, "pi", "agent_settled"));
	assert.equal(state.status.phase, "idle");

	// A second run reopens working, then an observed close ends the run.
	state = applyEvent(state, ev(5, "pi", "agent_start"));
	assert.equal(state.status.phase, "working");
	state = applyEvent(state, ev(6, "cp", "process_exit", { code: 0, signal: null }));
	assert.equal(state.status.phase, "exited");
	assert.equal(state.status.exit_code, 0);
	assert.ok(state.status.exited_at);
});

test("streaming usage is neither double counted nor invisible", () => {
	let state = initialProjection(BR);
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

test("recorder writes an append-only log and an atomic projection", () => {
	const home = createScratchHome();
	try {
		const recorder = RunRecorder.open({ home: home.path, jobId: BR, meta: { pid: 42 } });
		assert.ok(existsSync(join(home.path, paths.runDir(BR))));
		assert.equal(readRunStatus(home.path, BR).phase, "starting");

		for (const event of SCRIPTED) {
			recorder.record(event.source, event.type, event.payload as Record<string, unknown>);
		}
		const status = recorder.status;
		assert.equal(status.phase, "idle");
		assert.equal(status.turns, 2);

		// The file matches the in-memory projection exactly.
		assert.deepEqual(readRunStatus(home.path, BR), status);

		// events.jsonl is LF JSONL with monotonic seq and no rewriting.
		const raw = readFileSync(join(home.path, paths.eventsFile(BR)), "utf8");
		assert.ok(raw.endsWith("\n"));
		const events = parseEventLog(raw);
		assert.deepEqual(
			events.map((event) => event.seq),
			SCRIPTED.map((_, index) => index + 1),
		);
		assert.deepEqual(readRunEvents(home.path, BR).length, SCRIPTED.length);

		// Reopening appends after the existing log and recovers the projection.
		const reopened = RunRecorder.open({ home: home.path, jobId: BR });
		assert.equal(reopened.status.turns, 2);
		assert.equal(reopened.seq, SCRIPTED.length);
		reopened.cp("shutdown_requested", {});
		const after = readEventLog(home.path, BR);
		assert.equal(after.length, SCRIPTED.length + 1);
		assert.equal(after.at(-1)?.seq, SCRIPTED.length + 1);
		assert.equal(after.at(-1)?.type, "shutdown_requested");

		// The log wins: a corrupted cache is recoverable from it.
		writeFileSync(join(home.path, paths.statusFile(BR)), "{}\n");
		const rebuilt = rebuildStatus(home.path, BR);
		assert.equal(rebuilt.turns, 2);
		assert.equal(rebuilt.event_count, SCRIPTED.length + 1);
		reopened.close();
	} finally {
		home.cleanup();
	}
});

test("a corrupt log is refused, never silently replaced", () => {
	const home = createScratchHome();
	try {
		const recorder = RunRecorder.open({ home: home.path, jobId: BR });
		recorder.cp("spawned", { pid: 1 });
		recorder.close();
		// Truncated/garbled tail: reopening must fail loudly rather than start a
		// fresh log over the top of history.
		appendFileSync(join(home.path, paths.eventsFile(BR)), "{not json\n");
		assert.throws(() => RunRecorder.open({ home: home.path, jobId: BR }), SyntaxError);
		assert.throws(() => rebuildStatus(home.path, BR), SyntaxError);
	} finally {
		home.cleanup();
	}
});

test("every persisted projection satisfies the contract validator", () => {
	const home = createScratchHome();
	try {
		const recorder = RunRecorder.open({ home: home.path, jobId: BR });
		for (const event of SCRIPTED) {
			recorder.record(event.source, event.type, event.payload as Record<string, unknown>);
			// readRunStatus validates; a violation throws here, not in production.
			readRunStatus(home.path, BR);
		}
		recorder.cp("process_exit", { code: 0, signal: null });
		assert.equal(readRunStatus(home.path, BR).phase, "exited");
		recorder.close();
	} finally {
		home.cleanup();
	}
});

test("N2: a logged tool_execution_update keeps its call id but never its streamed partialResult", () => {
	const home = createScratchHome();
	try {
		const recorder = RunRecorder.open({ home: home.path, jobId: BR });
		recorder.pi({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
		recorder.pi({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "STREAMED-SECRET" }] } });
		recorder.close();
		const raw = readFileSync(join(home.path, paths.eventsFile(BR)), "utf8");
		assert.doesNotMatch(raw, /STREAMED-SECRET|partialResult/);
		const update = readEventLog(home.path, BR).find((event) => event.type === "tool_execution_update");
		assert.equal((update?.payload as { toolCallId?: string }).toolCallId, "c1");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// cp-0wq7: events that arrive after the observed close
// ---------------------------------------------------------------------------

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

test("events arriving after the observed close keep the projection valid", () => {
	const status = projectEvents(BR, POST_EXIT);
	assert.equal(status.phase, "exited", "a closed process cannot be working again");
	assert.equal(status.exit_code, 0);
	assert.equal(status.exited_at, POST_EXIT[3]?.ts);
	assert.equal(status.current_tool, null, "a dead worker holds no tool call");
	assert.equal(status.settled_at, POST_EXIT[2]?.ts, "the settle mark stays the one from before the exit");
	// Nothing is dropped: the log is still the history, and liveness still moves.
	assert.equal(status.event_count, POST_EXIT.length);
	assert.equal(status.last_activity_at, POST_EXIT.at(-1)?.ts);
	const checked = validateRunStatus(status);
	assert.ok(checked.ok, `post-exit projection must satisfy the contract: ${checked.ok ? "" : checked.errors.join("; ")}`);
});

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
	const status = projectEvents(BR, SUPPRESSED_AFTER_CLOSE);
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
	let state = initialProjection(BR);
	state = applyEvent(state, ev(1, "pi", "agent_settled"));
	const settled = state.status.last_activity_at;
	state = applyEvent(state, ev(2, "cp", "wakeup_suppressed", { kind: "ci", issued_at: "2026-08-27T11:00:00Z" }, 600));
	assert.equal(state.status.last_activity_at, settled, "an idle worker is no less idle for a wake-up it never got");
	assert.equal(state.status.event_count, 2);
});

test("a run whose events outlived the process can still be opened, revived and torn down", () => {
	const home = createScratchHome();
	try {
		const file = join(home.path, paths.eventsFile(BR));
		mkdirSync(join(home.path, paths.runDir(BR)), { recursive: true });
		writeFileSync(file, POST_EXIT.map((event) => `${JSON.stringify(event)}\n`).join(""));

		// Both cp_revive and cp_teardown reach the run through the registry: this
		// call is the one that used to throw and leave the job with no exit.
		const registry = new RunRegistry(home.path);
		const recorder = registry.open(BR);
		assert.equal(recorder.status.phase, "exited");
		assert.equal(readRunStatus(home.path, BR).phase, "exited");
		recorder.cp("shutdown_requested", { job_id: BR, forced: true });
		assert.equal(readRunStatus(home.path, BR).phase, "exited");

		// A relaunch is what reopens liveness — an event never does.
		recorder.cp("worker_revived", { pid: 5151, session_file: join(home.path, "s.jsonl"), model: "mock/script-x" });
		assert.equal(recorder.status.phase, "starting");
		assert.equal(recorder.status.exited_at, undefined);
		assert.equal(recorder.status.exit_code, undefined);
		assert.equal(recorder.status.pid, 5151, "the revived process is the one on the record");
		recorder.record("pi", "agent_start", {});
		assert.equal(recorder.status.phase, "working");
		assert.equal(readRunStatus(home.path, BR).phase, "working");

		// And the log still rebuilds to exactly what the writer had in memory.
		assert.deepEqual(rebuildStatus(home.path, BR), recorder.status);
		registry.closeAll();
	} finally {
		home.cleanup();
	}
});

test("initialStatus is a valid, minimal projection", () => {
	const status = initialStatus(BR, { model: "m" });
	assert.equal(status.phase, "starting");
	assert.equal(status.event_count, 0);
	assert.equal(status.reported, false);
	assert.equal(status.model, "m");
});

test("teeing a real worker produces the only read surface", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "runtee" });
	const home = createScratchHome();
	const model = provider.addScript("run-tee", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo tee-ok" } }] },
		{ kind: "text", text: "done", usage: { prompt_tokens: 300, completion_tokens: 40 } },
	]);
	const agentDir = createAgentDir({ provider });
	const jobId = "cp-tee1";
	const recorder = RunRecorder.open({ home: home.path, jobId, flushIntervalMs: 20 });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["bash"],
		env: agentDir.env,
		extraArgs: ["--no-context-files", "--no-session"],
	});
	recorder.markSpawned({ pid: worker.pid, model, profile: "implementer" });
	recorder.attach(worker);
	t.after(async () => {
		await worker.shutdown();
		recorder.close();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	await worker.getState(30_000);
	await worker.prompt("go");
	await worker.waitForSettled(60_000);

	const status = await waitFor(
		() => readRunStatus(home.path, jobId),
		(value) => value.phase === "idle" && value.turns >= 2,
		{ what: "settled projection" },
	);
	assert.equal(status.tool_calls, 1);
	assert.equal(status.current_tool, null);
	assert.ok(status.usage.total_tokens > 0, "usage must reach the projection");
	assert.ok(status.session_id === undefined || typeof status.session_id === "string");

	const events = readRunEvents(home.path, jobId);
	const types = events.map((event) => event.type);
	assert.equal(events[0]?.type, "spawned");
	assert.equal(events[0]?.source, "cp");
	for (const expected of ["agent_start", "tool_execution_start", "tool_execution_end", "agent_settled"]) {
		assert.ok(types.includes(expected), `missing ${expected}`);
	}
	assert.ok(!types.includes("message_update"), "streaming deltas are summarized, not stored");
	// seq is dense and monotonic in the log.
	assert.deepEqual(
		events.map((event) => event.seq),
		events.map((_, index) => index + 1),
	);

	// The observed close is written as a cp marker, and the projection follows.
	const exit = await worker.shutdown();
	assert.equal(exit.code, 0);
	const exited = await waitFor(
		() => readRunStatus(home.path, jobId),
		(value) => value.phase === "exited",
		{ what: "exited projection" },
	);
	assert.equal(exited.exit_code, 0);
	assert.ok(exited.exited_at);
	assert.deepEqual(rebuildStatus(home.path, jobId), exited, "log rebuild equals the cached projection");
});
