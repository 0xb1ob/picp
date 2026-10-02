/**
 * cp-wedged-tool-call acceptance: a tool call that never returns is detectable.
 *
 * The incident: two workers each stopped with `tool_execution_update` as their
 * final event and sat for fifteen hours. `/status` said `working` the whole
 * time — correctly, because a turn really was in flight. Nothing else looked.
 *
 * Everything here is hermetic and dependency-injected: fabricated run
 * projections, an injected `now`, an injected threshold, an injected env. No
 * clock, no sleeping, no `timeout(1)` (which is not installed on the machines
 * this runs on), no spawned process.
 *
 * The policy under test, stated once:
 *
 *  - an unmatched `tool_execution_start` past the threshold is surfaced;
 *  - a matched pair is not;
 *  - a long-but-progressing call (periodic `tool_execution_update`) is not,
 *    however long it has been running;
 *  - the threshold is configurable and its default is documented;
 *  - nothing here moves a job phase, and nothing here kills anything.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ASK_OPERATOR_TOOL,
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	LONG_TOOL_CALL_SECONDS,
	type RunEvent,
	type RunStatus,
	type StatusSnapshot,
	type Usage,
	WEDGED_TOOL_CALL_SECONDS,
	type WorkerHandle,
} from "../src/contracts.ts";
import { applyEvent, initialProjection, initialStatus, projectEvents } from "../src/run-artifacts.ts";
import { assembleStatus, formatStatusTable, isWedgedToolCall, type StatusFacts } from "../src/status.ts";
import { detectWedgedToolCalls, formatWedgedNotice, WedgedWatch, wedgedToolCallSeconds } from "../src/wedged.ts";

const NOW = "2026-08-31T09:00:00Z";
const HOME = "/home/operator/pi-command-post";

function usage(overrides: Partial<Usage> = {}): Usage {
	return { ...EMPTY_USAGE, ...overrides };
}

function record(overrides: Partial<Omit<FleetRecord, "worker">> & { job_id: string; worker?: Partial<WorkerHandle> }): FleetRecord {
	const { worker, ...rest } = overrides;
	return {
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worktree: `/home/operator/.treehouse/demo/${overrides.job_id}`,
		branch: overrides.job_id,
		dispatched_at: "2026-08-30T18:00:00Z",
		usage: usage(),
		...rest,
		worker: {
			pid: 4242,
			session_id: `sess-${overrides.job_id}`,
			session_file: `/sessions/${overrides.job_id}.jsonl`,
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-08-30T18:00:00Z",
			...worker,
		},
	} as FleetRecord;
}

function run(jobId: string, overrides: Partial<RunStatus> = {}): RunStatus {
	return { ...initialStatus(jobId, {}, "2026-08-30T18:00:00Z"), ...overrides } as RunStatus;
}

/**
 * One live worker, one open tool call, described entirely by the run
 * projection. `alive` is the pid probe, injected.
 */
function snapshotWith(
	jobId: string,
	currentTool: RunStatus["current_tool"],
	options: { alive?: boolean; phase?: RunStatus["phase"]; tool_calls?: number; retrying?: boolean } = {},
): StatusSnapshot {
	const facts: StatusFacts = {
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [record({ job_id: jobId })],
		runs: new Map([
			[
				jobId,
				run(jobId, {
					phase: options.phase ?? "working",
					tool_calls: options.tool_calls ?? 1,
					...(options.retrying ? { retrying: true } : {}),
					...(currentTool === undefined ? {} : { current_tool: currentTool }),
				}),
			],
		]),
		alive: new Map([[jobId, options.alive ?? true]]),
		ledger: { ok: false, queried: false },
		issues: [],
	};
	return assembleStatus(facts);
}

/** A snapshot assembled straight from a fabricated event log. */
function snapshotFromLog(jobId: string, events: readonly RunEvent[]): StatusSnapshot {
	return assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [record({ job_id: jobId })],
		runs: new Map([[jobId, projectEvents(jobId, events)]]),
		alive: new Map([[jobId, true]]),
		ledger: { ok: false, queried: false },
		issues: [],
	});
}

const HOUR_AGO = "2026-08-31T08:00:00Z"; // NOW - 1h
const FIFTEEN_HOURS_AGO = "2026-08-30T18:04:53Z"; // the real incident's last event
const A_MINUTE_AGO = "2026-08-31T08:59:00Z"; // NOW - 1m

// ---------------------------------------------------------------------------
// The four acceptance cases
// ---------------------------------------------------------------------------

test("an unmatched tool_execution_start older than the threshold is surfaced", () => {
	// Exactly the shape of the incident: a bash call opened, one update at the
	// same second, then silence. The projection still says `working`.
	const snapshot = snapshotWith("cp-verify-rubric-tests-7zz", {
		name: "bash",
		tool_call_id: "toolu_01UYnnwDMc4YqAgX3zMfBueK",
		started_at: FIFTEEN_HOURS_AGO,
		last_progress_at: FIFTEEN_HOURS_AGO,
	});

	const wedged = detectWedgedToolCalls(snapshot, { thresholdSeconds: 1800 });
	assert.equal(wedged.length, 1);
	const call = wedged[0] as (typeof wedged)[number];
	assert.equal(call.job_id, "cp-verify-rubric-tests-7zz");
	assert.equal(call.tool, "bash");
	assert.equal(call.idle_seconds, 15 * 3600 - 4 * 60 - 53);
	assert.equal(call.running_seconds, call.idle_seconds, "no progress since the start, so both clocks agree");
	assert.equal(call.threshold_seconds, 1800);
	assert.equal(call.branch, "cp-verify-rubric-tests-7zz");

	// Nothing became a phase. `stalled` stays retired; the job is still
	// `waiting`/`working`, which is what the run log actually observed.
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(job.phase, "waiting");
	assert.equal(job.run_phase, "working");
	assert.ok(!JSON.stringify(snapshot).includes("stalled"));

	// And it is surfaced where the operator already looks.
	const table = formatStatusTable(snapshot);
	assert.match(table, /no progress from bash for \d+h \(possibly wedged/);
});

test("a matched start/end pair is not surfaced, however long ago it ran", () => {
	// `tool_execution_end` clears `current_tool`, so there is no unmatched pair
	// and therefore no fact to report — regardless of the job's own age.
	const snapshot = snapshotWith("cp-done-tool", null, { phase: "working" });
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1 }), []);
	assert.equal((snapshot.jobs[0] as StatusSnapshot["jobs"][number]).current_tool_idle_seconds, null);
	assert.ok(!formatStatusTable(snapshot).includes("possibly wedged"));

	// The end event really is what clears it, projected from the log.
	const events: RunEvent[] = [
		event(1, "2026-08-31T08:00:00Z", "tool_execution_start", { toolName: "bash", toolCallId: "c1" }),
		event(2, "2026-08-31T08:59:00Z", "tool_execution_end", { toolCallId: "c1" }),
	];
	assert.equal(projectEvents("cp-done-tool", events).current_tool, null);
});

test("a long-but-progressing tool call is never surfaced", () => {
	// The ML backtest case: over an hour inside one call, still emitting.
	// Legitimate work, and it stays legitimate however long it runs.
	const snapshot = snapshotWith("cp-backtest", {
		name: "bash",
		tool_call_id: "c-backtest",
		started_at: HOUR_AGO,
		last_progress_at: A_MINUTE_AGO,
	});
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];

	// It IS long — the existing measured-fact marker still fires, as it should.
	assert.equal(job.current_tool_seconds, 3600);
	assert.ok((job.current_tool_seconds as number) >= LONG_TOOL_CALL_SECONDS);
	assert.match(formatStatusTable(snapshot), /long-running tool call: bash for 1h/);

	// It is NOT wedged: only silence accumulates, and it has been silent 60s.
	assert.equal(job.current_tool_idle_seconds, 60);
	assert.equal(isWedgedToolCall(job, 1800), false);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1800 }), []);
	assert.ok(!formatStatusTable(snapshot).includes("possibly wedged"));

	// Even at a one-second threshold it is not wedged, because 60s of silence
	// is what is measured — not the hour the call has been open. This is the
	// distinction the whole design rests on.
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 61 }), []);
	assert.equal(detectWedgedToolCalls(snapshot, { thresholdSeconds: 60 }).length, 1);
});

test("the threshold is configurable, and its default is 30 minutes", () => {
	assert.equal(WEDGED_TOOL_CALL_SECONDS, 1800, "the documented default (docs/contracts.md)");
	assert.ok(WEDGED_TOOL_CALL_SECONDS > LONG_TOOL_CALL_SECONDS, "wedged is strictly past 'worth a glance'");

	// Env override, injected — never read from the ambient process here.
	assert.equal(wedgedToolCallSeconds({}), WEDGED_TOOL_CALL_SECONDS);
	assert.equal(wedgedToolCallSeconds({ CP_WEDGED_TOOL_CALL_SECONDS: "" }), WEDGED_TOOL_CALL_SECONDS);
	assert.equal(wedgedToolCallSeconds({ CP_WEDGED_TOOL_CALL_SECONDS: "120" }), 120);
	assert.equal(wedgedToolCallSeconds({ CP_WEDGED_TOOL_CALL_SECONDS: "90.7" }), 90);
	// A typo must not silently disable detection — that is the exact failure
	// mode this module exists to remove, so it falls back to the default.
	for (const bad of ["nonsense", "0", "-1", "NaN", "Infinity"]) {
		assert.equal(wedgedToolCallSeconds({ CP_WEDGED_TOOL_CALL_SECONDS: bad }), WEDGED_TOOL_CALL_SECONDS, bad);
	}

	// And the threshold actually decides.
	const snapshot = snapshotWith("cp-slow", { name: "bash", tool_call_id: "c", started_at: "2026-08-31T08:50:00Z" });
	assert.equal(detectWedgedToolCalls(snapshot, { thresholdSeconds: 600 }).length, 1);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 601 }), []);
});

// ---------------------------------------------------------------------------
// What must NOT be surfaced
// ---------------------------------------------------------------------------

test("a dead worker's open call is not a wedged call", () => {
	// A worker that exited mid-call is already surfaced as `exited` with no
	// envelope. Reporting it twice, under a name that implies it is still
	// running, would be worse than not reporting it here at all.
	const snapshot = snapshotWith(
		"cp-dead",
		{ name: "bash", tool_call_id: "c", started_at: FIFTEEN_HOURS_AGO },
		{ alive: false },
	);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 60 }), []);
});

test("a job that is not working is not surfaced", () => {
	for (const phase of ["idle", "starting", "exited"] as const) {
		const snapshot = snapshotWith(
			"cp-quiet",
			{ name: "bash", tool_call_id: "c", started_at: FIFTEEN_HOURS_AGO },
			{ phase },
		);
		assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 60 }), [], phase);
	}
});

test("a run projection written before last_progress_at existed still works", () => {
	// Back-compat: the field is optional, and its absence means "the start is
	// the last thing we know", which is exactly the conservative reading.
	const snapshot = snapshotWith("cp-legacy", { name: "bash", tool_call_id: "c", started_at: HOUR_AGO });
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(job.current_tool_idle_seconds, 3600);
	assert.equal(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1800 }).length, 1);
});

test("an assembled snapshot with no idle measurement is never wedged", () => {
	// `current_tool_idle_seconds` is optional on the contract, so a snapshot
	// from an older parent has none. Absent means "not measurable", which must
	// read as "not wedged" rather than as zero or as infinity.
	const snapshot = snapshotWith("cp-old", { name: "bash", tool_call_id: "c", started_at: FIFTEEN_HOURS_AGO });
	const job = { ...(snapshot.jobs[0] as StatusSnapshot["jobs"][number]) };
	delete (job as { current_tool_idle_seconds?: number | null }).current_tool_idle_seconds;
	assert.equal(isWedgedToolCall(job, 1), false);
	assert.deepEqual(detectWedgedToolCalls({ ...snapshot, jobs: [job] }, { thresholdSeconds: 1 }), []);
});

// ---------------------------------------------------------------------------
// A waiting human is not a wedged worker (cp-ft3d)
// ---------------------------------------------------------------------------

test("an open ask_operator call is never a wedged call, however long the human takes", () => {
	// Structurally identical to the incident: `working`, alive, an unmatched
	// `tool_execution_start`, and no update will ever arrive — because the worker
	// is not doing anything. It is waiting, and the silence is the operator's.
	const TWO_HOURS_AGO = "2026-08-31T07:00:00Z";
	const snapshot = snapshotWith("cp-planner-asked", {
		name: ASK_OPERATOR_TOOL,
		tool_call_id: "call-q1",
		started_at: TWO_HOURS_AGO,
		last_progress_at: TWO_HOURS_AGO,
	});
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(job.current_tool, ASK_OPERATOR_TOOL);
	assert.equal(job.current_tool_idle_seconds, 7200, "the fixture really is two hours silent");
	assert.equal(job.run_phase, "working");
	assert.equal(job.alive, true);

	assert.equal(isWedgedToolCall(job, 1800), false);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1800 }), []);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1 }), [], "not at any threshold");
	assert.equal(new WedgedWatch({ thresholdSeconds: 1 }).observe(snapshot).length, 0, "and it never becomes news");

	// Nor is it reported as a long-running call: the row already says a human is
	// the blocker, and the duration is the human's, not the worker's.
	const table = formatStatusTable(snapshot);
	assert.ok(!table.includes("possibly wedged"), table);
	assert.ok(!table.includes("long-running tool call"), table);

	// Nothing moved: the exclusion is about what is *reported*, not about phases.
	assert.equal(job.phase, "waiting");
	assert.ok(!JSON.stringify(snapshot).includes("stalled"));
});

test("review: an open report_result held for review is never a wedged call", () => {
	const TWO_HOURS_AGO = "2026-08-31T07:00:00Z";
	const snapshot = snapshotWith("cp-plan-held", { name: "report_result", tool_call_id: "call-r1", started_at: TWO_HOURS_AGO, last_progress_at: TWO_HOURS_AGO });
	const job = { ...(snapshot.jobs[0] as StatusSnapshot["jobs"][number]), open_question: { schema_version: 1, job_id: "cp-plan-held", seq: 1, dialog_id: "d1", role: "planner" as const, method: "review" as const, question: "Plan written.", asked_at: TWO_HOURS_AGO, outcome: "timeout" as const } };
	assert.equal(isWedgedToolCall(job, 1800), false);
	assert.deepEqual(detectWedgedToolCalls({ ...snapshot, jobs: [job] }, { thresholdSeconds: 1800 }), []);
	const silent = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(isWedgedToolCall(silent, 1800), true, "the same call with no held exchange is still a wedge");
});

test("a bash call silent for 31 minutes is still a notice", () => {
	// The other half of the same rule, on the same threshold: the exclusion is
	// keyed on the ONE tool whose silence belongs to a human, and nothing else.
	const snapshot = snapshotWith("cp-implementer-quiet", {
		name: "bash",
		tool_call_id: "call-1",
		started_at: "2026-08-31T08:29:00Z", // NOW - 31m
		last_progress_at: "2026-08-31T08:29:00Z",
	});
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(job.current_tool_idle_seconds, 31 * 60);
	assert.equal(isWedgedToolCall(job, 1800), true);

	const wedged = detectWedgedToolCalls(snapshot, { thresholdSeconds: 1800 });
	assert.equal(wedged.length, 1);
	assert.equal((wedged[0] as (typeof wedged)[number]).tool, "bash");
	assert.match(formatWedgedNotice(wedged), /cp-implementer-quiet: bash open 31m, silent 31m/);
	assert.match(formatStatusTable(snapshot), /no progress from bash for 31m \(possibly wedged/);
});

test("the exclusion is the tool name from the projection, not a feature flag", () => {
	// Keyed on `current_tool` so it holds in dialog mode (T31) and in hold mode
	// (a held question, which has no deadline at all). A worker never sees
	// which mode the parent is in, so nothing about the mode could reach here.
	const status = projectEvents("cp-proj", [
		event(1, "2026-08-31T07:00:00Z", "tool_execution_start", { toolName: ASK_OPERATOR_TOOL, toolCallId: "q1" }),
	]);
	assert.equal(status.current_tool?.name, ASK_OPERATOR_TOOL, "the projection is where the name comes from");
	assert.deepEqual(detectWedgedToolCalls(snapshotFromLog("cp-proj", [
		event(1, "2026-08-31T07:00:00Z", "tool_execution_start", { toolName: ASK_OPERATOR_TOOL, toolCallId: "q1" }),
	]), { thresholdSeconds: 1 }), []);

	// And once the human answers, the call ends like any other and the job is
	// an ordinary working job again.
	const answered = projectEvents("cp-proj", [
		event(1, "2026-08-31T07:00:00Z", "tool_execution_start", { toolName: ASK_OPERATOR_TOOL, toolCallId: "q1" }),
		event(2, "2026-08-31T08:59:00Z", "tool_execution_end", { toolCallId: "q1" }),
	]);
	assert.equal(answered.current_tool, null);
});

// ---------------------------------------------------------------------------
// pi's own auto-retry is not a wedge (cp-viewer-scroll-stuck-dam)
// ---------------------------------------------------------------------------

function event(seq: number, ts: string, type: string, payload: Record<string, unknown> = {}): RunEvent {
	return { seq, ts, job_id: "cp-proj", source: "pi", type, payload };
}

/**
 * The observed healthy shape: `auto_retry_start`/`auto_retry_end` as one
 * matched pair, `agent_start: 2` against `agent_end: 1` (the loop restarted),
 * and matched tool start/end counts. It recovers on its own.
 */
function retryLog(options: { inFlight: boolean }): RunEvent[] {
	const events: RunEvent[] = [
		event(1, "2026-08-31T08:00:00Z", "agent_start"),
		event(2, "2026-08-31T08:00:10Z", "tool_execution_start", { toolName: "bash", toolCallId: "c1" }),
		event(3, "2026-08-31T08:00:12Z", "tool_execution_end", { toolCallId: "c1" }),
		event(4, "2026-08-31T08:00:20Z", "agent_end"),
		// The transient model/API failure, and the loop restarting.
		event(5, "2026-08-31T08:00:30Z", "auto_retry_start", { attempt: 1, reason: "529 overloaded" }),
		event(6, "2026-08-31T08:00:31Z", "agent_start"),
	];
	if (!options.inFlight) events.push(event(7, "2026-08-31T08:01:00Z", "auto_retry_end", { success: true, attempt: 2 }));
	return events;
}

test("a completed auto-retry is not a wedged tool call", () => {
	const events = retryLog({ inFlight: false });
	const status = projectEvents("cp-proj", events);

	// The asymmetry the observation describes is really there in the log...
	assert.equal(events.filter((e) => e.type === "agent_start").length, 2);
	assert.equal(events.filter((e) => e.type === "agent_end").length, 1);
	assert.equal(events.filter((e) => e.type === "auto_retry_start").length, 1);
	assert.equal(events.filter((e) => e.type === "auto_retry_end").length, 1);
	// ...and the tool calls are matched, which is the signal that matters.
	assert.equal(status.current_tool, null);
	assert.equal(status.retrying, undefined, "a completed retry leaves nothing behind");

	// Nothing is flagged, even at a one-second threshold hours later.
	const snapshot = snapshotFromLog("cp-proj", events);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1 }), []);
	assert.ok(!formatStatusTable(snapshot).includes("possibly wedged"));
	assert.equal(new WedgedWatch({ thresholdSeconds: 1 }).observe(snapshot).length, 0);
});

test("an in-flight auto-retry is not a wedged tool call", () => {
	const events = retryLog({ inFlight: true });
	const status = projectEvents("cp-proj", events);
	assert.equal(status.retrying, true, "the retry is observed, not inferred");

	const snapshot = snapshotFromLog("cp-proj", events);
	assert.equal((snapshot.jobs[0] as StatusSnapshot["jobs"][number]).retrying, true);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1 }), []);
	assert.ok(!formatStatusTable(snapshot).includes("possibly wedged"));

	// And the retry finishing does not turn it into one either.
	const finished = snapshotFromLog("cp-proj", [
		...events,
		event(7, "2026-08-31T08:01:00Z", "auto_retry_end", { success: true, attempt: 2 }),
	]);
	assert.deepEqual(detectWedgedToolCalls(finished, { thresholdSeconds: 1 }), []);
});

test("an unmatched agent_start is not evidence of a wedged tool call", () => {
	// A retry produces exactly this, and only an unmatched TOOL pair is an
	// input here. Stated as its own test so a future refactor cannot quietly
	// start reading agent-level symmetry as a wedge signal.
	const snapshot = snapshotFromLog("cp-proj", [
		event(1, "2026-08-30T18:00:00Z", "agent_start"),
		event(2, "2026-08-30T18:00:10Z", "tool_execution_start", { toolName: "bash", toolCallId: "c1" }),
		event(3, "2026-08-30T18:00:12Z", "tool_execution_end", { toolCallId: "c1" }),
		event(4, "2026-08-30T18:00:20Z", "agent_start"),
	]);
	assert.equal((snapshot.jobs[0] as StatusSnapshot["jobs"][number]).current_tool, null);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1 }), []);
});

test("a healthy job with matched tool counts and recent activity is never flagged", () => {
	// 54 starts, 54 ends, last activity seconds ago -- the shape every healthy
	// worker has, and the exact opposite of the two casualties.
	const events: RunEvent[] = [event(1, "2026-08-31T08:00:00Z", "agent_start")];
	for (let index = 0; index < 54; index += 1) {
		events.push(event(events.length + 1, "2026-08-31T08:59:58Z", "tool_execution_start", { toolName: "read", toolCallId: `c${index}` }));
		events.push(event(events.length + 1, "2026-08-31T08:59:59Z", "tool_execution_end", { toolCallId: `c${index}` }));
	}
	const status = projectEvents("cp-proj", events);
	assert.equal(status.tool_calls, 54);
	assert.equal(status.current_tool, null);
	assert.deepEqual(detectWedgedToolCalls(snapshotFromLog("cp-proj", events), { thresholdSeconds: 1 }), []);
});

test("a retry across an open tool call restarts the silence clock", () => {
	// If a call is open when the loop restarts, the retry events prove the loop
	// ran -- so whatever is open was not what blocked it, and its silence is
	// measured from the retry rather than from a start that is now hours old.
	const status = projectEvents("cp-proj", [
		event(1, "2026-08-30T18:00:00Z", "tool_execution_start", { toolName: "bash", toolCallId: "c1" }),
		event(2, "2026-08-31T08:30:00Z", "auto_retry_start", { attempt: 1 }),
		event(3, "2026-08-31T08:59:30Z", "auto_retry_end", { success: true }),
	]);
	assert.equal(status.current_tool?.started_at, "2026-08-30T18:00:00Z");
	assert.equal(status.current_tool?.last_progress_at, "2026-08-31T08:59:30Z");
	assert.equal(status.retrying, undefined);

	const snapshot = snapshotFromLog("cp-proj", [
		event(1, "2026-08-30T18:00:00Z", "tool_execution_start", { toolName: "bash", toolCallId: "c1" }),
		event(2, "2026-08-31T08:30:00Z", "auto_retry_start", { attempt: 1 }),
		event(3, "2026-08-31T08:59:30Z", "auto_retry_end", { success: true }),
	]);
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(job.current_tool_seconds, 15 * 3600, "open for 15h");
	assert.equal(job.current_tool_idle_seconds, 30, "but silent for 30s");
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1800 }), []);
});

test("the retrying exclusion is belt and braces with the progress mark", () => {
	// Even if a projection somehow carried BOTH an in-flight retry and a stale
	// progress mark, the retry alone must veto the flag.
	const snapshot = snapshotWith(
		"cp-retrying",
		{ name: "bash", tool_call_id: "c", started_at: FIFTEEN_HOURS_AGO, last_progress_at: FIFTEEN_HOURS_AGO },
		{ retrying: true },
	);
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.ok((job.current_tool_idle_seconds as number) > 1800, "the fixture is past the threshold");
	assert.equal(isWedgedToolCall(job, 1800), false);
	assert.deepEqual(detectWedgedToolCalls(snapshot, { thresholdSeconds: 1800 }), []);
	assert.ok(!formatStatusTable(snapshot).includes("possibly wedged"));

	// The same fixture without the retry IS flagged -- so the exclusion is what
	// is doing the work here, not something else about the fixture.
	const notRetrying = snapshotWith("cp-retrying", {
		name: "bash",
		tool_call_id: "c",
		started_at: FIFTEEN_HOURS_AGO,
		last_progress_at: FIFTEEN_HOURS_AGO,
	});
	assert.equal(detectWedgedToolCalls(notRetrying, { thresholdSeconds: 1800 }).length, 1);
});

// ---------------------------------------------------------------------------
// The projection: what makes "progressing" observable at all
// ---------------------------------------------------------------------------

test("tool_execution_update refreshes progress for its own call, and only its own", () => {
	let state = initialProjection("cp-proj", {}, "2026-08-31T08:00:00Z");
	state = applyEvent(state, event(1, "2026-08-31T08:00:00Z", "tool_execution_start", { toolName: "bash", toolCallId: "c1" }));
	assert.equal(state.status.current_tool?.started_at, "2026-08-31T08:00:00Z");
	assert.equal(state.status.current_tool?.last_progress_at, undefined, "no progress observed yet");

	state = applyEvent(state, event(2, "2026-08-31T08:30:00Z", "tool_execution_update", { toolCallId: "c1" }));
	assert.equal(state.status.current_tool?.last_progress_at, "2026-08-31T08:30:00Z");
	assert.equal(state.status.current_tool?.started_at, "2026-08-31T08:00:00Z", "the start is never moved");
	assert.equal(state.status.tool_calls, 1, "an update is not a new call");

	// An update belonging to a different call proves nothing about this one.
	state = applyEvent(state, event(3, "2026-08-31T08:45:00Z", "tool_execution_update", { toolCallId: "other" }));
	assert.equal(state.status.current_tool?.last_progress_at, "2026-08-31T08:30:00Z");

	// And the end still clears the whole thing.
	state = applyEvent(state, event(4, "2026-08-31T08:50:00Z", "tool_execution_end", { toolCallId: "c1" }));
	assert.equal(state.status.current_tool, null);
});

test("a new tool call starts with a clean progress mark", () => {
	const status = projectEvents("cp-proj", [
		event(1, "2026-08-31T08:00:00Z", "tool_execution_start", { toolName: "bash", toolCallId: "c1" }),
		event(2, "2026-08-31T08:10:00Z", "tool_execution_update", { toolCallId: "c1" }),
		event(3, "2026-08-31T08:20:00Z", "tool_execution_end", { toolCallId: "c1" }),
		event(4, "2026-08-31T08:30:00Z", "tool_execution_start", { toolName: "read", toolCallId: "c2" }),
	]);
	assert.equal(status.current_tool?.tool_call_id, "c2");
	assert.equal(status.current_tool?.last_progress_at, undefined);
	assert.equal(status.tool_calls, 2);
});

// ---------------------------------------------------------------------------
// Surfacing: news once, not every tick
// ---------------------------------------------------------------------------

test("a wedged call is announced once, and again only if it is a different call", () => {
	const watch = new WedgedWatch({ thresholdSeconds: 1800 });
	const wedgedSnapshot = snapshotWith(
		"cp-wedged",
		{ name: "bash", tool_call_id: "c1", started_at: FIFTEEN_HOURS_AGO },
		{ tool_calls: 7 },
	);

	assert.equal(watch.observe(wedgedSnapshot).length, 1, "news the first time");
	assert.equal(watch.observe(wedgedSnapshot).length, 0, "not news five seconds later");
	assert.equal(watch.observe(wedgedSnapshot).length, 0);
	assert.equal(watch.announcedCount, 1);

	// The call returned and a new one opened, which also wedged: news again.
	const nextCall = snapshotWith(
		"cp-wedged",
		{ name: "bash", tool_call_id: "c2", started_at: FIFTEEN_HOURS_AGO },
		{ tool_calls: 8 },
	);
	assert.equal(watch.observe(nextCall).length, 1, "a different call is a different fact");
	assert.equal(watch.observe(nextCall).length, 0);

	// It unwedges (output resumed): forgotten, so a later wedge is news again.
	const progressing = snapshotWith(
		"cp-wedged",
		{ name: "bash", tool_call_id: "c2", started_at: FIFTEEN_HOURS_AGO, last_progress_at: A_MINUTE_AGO },
		{ tool_calls: 8 },
	);
	assert.deepEqual(watch.observe(progressing), []);
	assert.equal(watch.announcedCount, 0);
	assert.equal(watch.observe(nextCall).length, 1, "silence returned, so it is news again");
});

test("two wedged workers are one notice naming both", () => {
	const facts: StatusFacts = {
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [record({ job_id: "cp-verify-rubric-tests-7zz" }), record({ job_id: "cp-pipeline-handoff-framing-dz9" })],
		runs: new Map([
			[
				"cp-verify-rubric-tests-7zz",
				run("cp-verify-rubric-tests-7zz", {
					phase: "working",
					current_tool: { name: "bash", tool_call_id: "a", started_at: FIFTEEN_HOURS_AGO },
				}),
			],
			[
				"cp-pipeline-handoff-framing-dz9",
				run("cp-pipeline-handoff-framing-dz9", {
					phase: "working",
					current_tool: { name: "bash", tool_call_id: "b", started_at: "2026-08-30T18:05:03Z" },
				}),
			],
		]),
		alive: new Map([
			["cp-verify-rubric-tests-7zz", true],
			["cp-pipeline-handoff-framing-dz9", true],
		]),
		ledger: { ok: false, queried: false },
		issues: [],
	};
	const wedged = detectWedgedToolCalls(assembleStatus(facts), { thresholdSeconds: 1800 });
	assert.equal(wedged.length, 2);

	const notice = formatWedgedNotice(wedged);
	assert.match(notice, /WEDGED TOOL CALLS — 2 workers/);
	assert.match(notice, /cp-verify-rubric-tests-7zz: bash open \d+h, silent \d+h/);
	assert.match(notice, /cp-pipeline-handoff-framing-dz9: bash open \d+h/);
	assert.match(notice, /Observed, not concluded/);
	// Surfacing, never killing: the notice says so, and it never reaches for the
	// retired phase word to describe what it saw.
	assert.match(notice, /Nothing was killed and no phase changed/);
	assert.ok(!/stalled/.test(notice), notice);
	assert.match(notice, /operator decision/);
	assert.match(notice, /\/watch/);

	assert.equal(formatWedgedNotice([]), "", "no calls, no notice");
});
