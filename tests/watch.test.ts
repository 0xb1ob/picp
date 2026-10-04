/**
 * T24 acceptance: a recorded event log renders correctly, and a live follow
 * picks up events as they are appended.
 *
 * The recorded log is built with the real `RunRecorder` from scripted pi events
 * — the same writer a worker's stream goes through — so the viewer is tested
 * against the file format that actually exists, not a hand-written fixture of
 * what we hope it looks like.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseWatchArgs } from "../extensions/command-post/index.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, paths, type RunEvent } from "../src/contracts.ts";
import { initialStatus, RunRecorder } from "../src/run-artifacts.ts";
import {
	formatRunView,
	PARENT_TAIL_DEFAULT,
	renderEvents,
	renderHeader,
	RunWatcher,
	summarizeToolArgs,
	parseWatchLines,
	WATCH_DETAIL_LINES,
	WATCH_LINE_CAP,
	WatchError,
} from "../src/watch.ts";
import { assertGolden, createScratchHome } from "./harness/index.ts";

const JOB_ID = "cp-watch-demo";

function fleetRecord(overrides: Partial<Omit<FleetRecord, "worker">> = {}): FleetRecord {
	return {
		job_id: JOB_ID,
		project: "demo",
		kind: "research",
		delivery: "pipeline",
		origin: DEFAULT_ORIGIN,
		phase: "held",
		worktree: "/worktrees/cp-watch-demo",
		branch: JOB_ID,
		dispatched_at: "2026-08-27T11:00:00Z",
		reported_at: "2026-08-27T11:04:00Z",
		usage: { ...EMPTY_USAGE, input: 9000, output: 800, total_tokens: 9800, cost_usd: 0.031 },
		...overrides,
		worker: {
			pid: 5150,
			session_id: "sess-watch",
			session_file: "/sessions/cp-watch-demo.jsonl",
			profile: "planner",
			role: "planner",
			model: "mock/scripted",
			started_at: "2026-08-27T11:00:00Z",
		},
	} as FleetRecord;
}

/**
 * A run that did everything worth rendering: spawn, prompt, a turn with two
 * tools (one failing), assistant text, an envelope, a gate decision, a budget
 * warning, a shutdown and an observed exit.
 */
function recordRun(home: string, jobId = JOB_ID): void {
	const recorder = RunRecorder.open({
		home,
		jobId,
		meta: { pid: 5150, model: "mock/scripted", profile: "planner", session_id: "sess-watch" },
		now: stepClock("2026-08-27T11:00:00Z"),
	});
	recorder.cp("spawned", { pid: 5150, model: "mock/scripted", profile: "planner" });
	recorder.cp("prompt_sent", { receipt: "delivered", message: "Investigate the flaky import\nwrite findings" });
	recorder.pi({ type: "agent_start" });
	recorder.pi({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/import.ts" } });
	recorder.pi({
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "read",
		isError: false,
		result: { content: [{ type: "text", text: "line one\nline two\nline three" }] },
	});
	recorder.pi({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "npm test -- import" } });
	recorder.pi({
		type: "tool_execution_end",
		toolCallId: "c2",
		toolName: "bash",
		isError: true,
		result: { content: [{ type: "text", text: "1 failing\n  import order" }] },
	});
	recorder.pi({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "The import cycle is in src/import.ts.\nI will write it up." }],
			usage: { input: 9000, output: 800, cacheRead: 0, cacheWrite: 0, totalTokens: 9800, cost: { total: 0.031 } },
		},
	});
	recorder.pi({ type: "turn_end" });
	recorder.cp("budget_warning", { message: "82% of 400000 tokens" });
	recorder.cp("envelope_received", { status: "done", summary: "Found the cycle; fix is one import move." });
	recorder.cp("gate_decided", { attempt: 1, verdict: "pass", cause: null });
	recorder.cp("review_decided", { attempt: 1, verdict: "pass", cause: null });
	recorder.pi({ type: "agent_settled" });
	recorder.cp("shutdown_requested", {});
	recorder.cp("process_exit", { code: 0, signal: null });
	recorder.close();
}

/** A clock that advances one second per call: deterministic, and monotonic. */
function stepClock(start: string): () => Date {
	let at = Date.parse(start);
	return () => {
		const now = new Date(at);
		at += 1000;
		return now;
	};
}

function watcherFor(home: string, record?: FleetRecord): RunWatcher {
	return new RunWatcher({
		home,
		...(record ? { record: () => record } : {}),
		now: () => new Date("2026-08-27T11:10:00Z"),
	});
}

// ---------------------------------------------------------------------------
// Rendering a recorded log
// ---------------------------------------------------------------------------

test("golden: a recorded run renders compactly", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	recordRun(home.path);
	const view = watcherFor(home.path, fleetRecord()).render(JOB_ID);
	assert.equal(view.exited, true, "the observed exit is in the log, so following is pointless");
	assertGolden("watch-compact.txt", formatRunView(view));
});

test("golden: detailed mode adds tool results and full text, still capped", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	recordRun(home.path);
	const view = watcherFor(home.path, fleetRecord()).render(JOB_ID, { mode: "detailed" });
	assertGolden("watch-detailed.txt", formatRunView(view));
});

test("an operator question renders in the run log, question and answer", (t) => {
	// T31: the run log is the operator's history and `/watch` renders it in code,
	// parent's context, so the question belongs here in full — that is what makes
	// the exchange auditable without ever modelling it.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const recorder = RunRecorder.open({ home: home.path, jobId: JOB_ID, now: stepClock("2026-08-27T11:00:00Z") });
	recorder.markSpawned({ pid: 4242, model: "mock/one", profile: "planner" });
	recorder.cp("question_asked", { seq: 1, method: "select", question: "Postgres or SQLite?", options: ["Postgres", "SQLite"] });
	recorder.cp("question_closed", { seq: 1, outcome: "answered", answered_by: "operator dialog (tui)" });
	recorder.cp("question_asked", { seq: 2, method: "input", question: "Which module owns refresh?" });
	recorder.cp("question_closed", { seq: 2, outcome: "timeout" });
	recorder.close();

	const rendered = formatRunView(watcherFor(home.path, fleetRecord()).render(JOB_ID));
	assert.match(rendered, /\? asked the operator: Postgres or SQLite\? \[Postgres \| SQLite\]/);
	assert.match(rendered, /! question answered by operator dialog \(tui\)/);
	assert.match(rendered, /\? asked the operator: Which module owns refresh\?/);
	assert.match(rendered, /question timeout/, "nobody answering is part of the history too");
});

test("review: a plan review renders the verb, never the body", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const recorder = RunRecorder.open({ home: home.path, jobId: JOB_ID, now: stepClock("2026-08-27T11:00:00Z") });
	recorder.markSpawned({ pid: 4242, model: "mock/one", profile: "planner" });
	recorder.cp("question_asked", { seq: 1, method: "review", question: "Plan written." });
	recorder.cp("question_closed", { seq: 1, outcome: "answered", answered_by: "operator console", answer: "approve" });
	recorder.cp("question_asked", { seq: 2, method: "review", question: "Plan written." });
	recorder.cp("question_closed", {
		seq: 2,
		outcome: "answered",
		answered_by: "operator console",
		answer: "revise\nsplit step 3",
	});
	recorder.cp("question_asked", { seq: 3, method: "review", question: "Plan written." });
	recorder.cp("question_closed", { seq: 3, outcome: "answered", answered_by: "operator console", answer: "ask" });
	recorder.close();

	const rendered = formatRunView(watcherFor(home.path, fleetRecord()).render(JOB_ID));
	assert.match(rendered, /plan review asked: Plan written\./);
	assert.match(rendered, /plan approved by operator console/);
	assert.match(rendered, /revision requested by operator console/);
	assert.match(rendered, /operator asked by operator console/);
	assert.ok(!rendered.includes("split step 3"), "the body stays out of the run log line");
});

test("cp-89cs: an attach console renders as counts and a duration, never as words", (t) => {
	// The guard refuses attach.jsonl and points here, so this is the whole surface
	// an operator has on a console after the fact — and it must carry no words:
	// the parent reads the run log.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const recorder = RunRecorder.open({ home: home.path, jobId: JOB_ID, now: stepClock("2026-08-27T11:00:00Z") });
	recorder.markSpawned({ pid: 4242, model: "mock/one", profile: "planner" });
	recorder.cp("attach_opened", { seq: 1, by: "operator console" });
	recorder.cp("attach_closed", {
		seq: 4,
		reason: "detached",
		duration_ms: 92_400,
		messages: 3,
		answers: 1,
		tools: 7,
	});
	// A close with no duration (and no counts) still renders: the reason is the
	// part that always exists, and the counts default to 0 rather than to "?".
	recorder.cp("attach_closed", { seq: 9, reason: "worker_exited" });
	recorder.close();

	const rendered = formatRunView(watcherFor(home.path, fleetRecord()).render(JOB_ID));
	assert.match(rendered, /console opened by operator console/);
	assert.match(rendered, /console closed \(detached\) after 92s: 3 message\(s\), 1 answer\(s\), 7 tool call\(s\)/);
	assert.match(rendered, /console closed \(worker_exited\): 0 message\(s\), 0 answer\(s\), 0 tool call\(s\)/);
	assert.ok(!/after undefineds/.test(rendered), "an absent duration is omitted, not printed");

	// Detailed mode is the same two lines: there is no console body to expand.
	const detailed = formatRunView(watcherFor(home.path, fleetRecord()).render(JOB_ID, { mode: "detailed" }));
	assert.match(detailed, /console closed \(detached\) after 92s/);
});

test("a detailed view never expands an artifact payload, however often it is rendered", (t) => {
	// cp-ti5: WATCH_DETAIL_LINES bounds ONE event, not a session. `--detailed` is
	// callable repeatedly, so without this a patient parent could reassemble a
	// research plan in its own context — exactly what the T19 guards prevent
	// everywhere else.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const recorder = RunRecorder.open({ home: home.path, jobId: JOB_ID, now: stepClock("2026-08-27T11:00:00Z") });
	recorder.markSpawned({ pid: 1, model: "mock/one", profile: "planner" });

	const artifactPath = join(home.path, paths.artifactFile(JOB_ID));
	const body = Array.from({ length: 12 }, (_, n) => `secret plan line ${n}`).join("\n");
	// 1. written with bash, the way a planner actually writes its report
	recorder.pi({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "bash",
		args: { command: `cat > "${artifactPath}" <<'EOF'\n${body}\nEOF` },
	});
	recorder.pi({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: body } });
	// 2. and read back with the same path (a failed call still says nothing)
	recorder.pi({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: { path: artifactPath } });
	recorder.pi({
		type: "tool_execution_end",
		toolCallId: "call-2",
		toolName: "read",
		isError: true,
		result: { content: body },
	});
	// 3. a normal tool keeps its detail: this is a targeted rule, not a mute button
	recorder.pi({ type: "tool_execution_start", toolCallId: "call-3", toolName: "bash", args: { command: "npm test" } });
	recorder.pi({
		type: "tool_execution_end",
		toolCallId: "call-3",
		toolName: "bash",
		result: { content: "1 passing\n2 passing" },
	});
	recorder.close();

	const detailed = formatRunView(watcherFor(home.path, fleetRecord()).render(JOB_ID, { mode: "detailed" }));
	assert.ok(!detailed.includes("secret plan line"), `an artifact body reached the view:\n${detailed}`);
	assert.match(detailed, /artifact payload not shown/);
	assert.match(detailed, /cp_artifact get <job-id> --out <file>/, "the suppression names the sanctioned path");
	// What the worker DID is still visible — that is the operator's whole interest.
	assert.match(detailed, /⚙ bash/);
	assert.match(detailed, /1 passing/, "an unrelated tool result is still expanded");

	// Compact mode was never a risk and is unchanged: successful tool ends are not
	// rendered at all.
	const compact = formatRunView(watcherFor(home.path, fleetRecord()).render(JOB_ID));
	assert.ok(!compact.includes("secret plan line"));
});

test("the header carries both phases and never derives one from the other", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	recordRun(home.path);
	const view = watcherFor(home.path, fleetRecord()).render(JOB_ID);
	assert.match(view.header, /^run cp-watch-demo · job held · demo\/research · model scripted · run exited/);
	assert.match(view.header, /turns 1 · tools 2/);
	assert.match(view.header, /exited 2026-08-27T11:00:1[0-9]Z \(code 0\)/);

	// No fleet record (a run this home no longer tracks) still renders.
	const bare = watcherFor(home.path).render(JOB_ID);
	assert.match(bare.header, /^run cp-watch-demo · model scripted · run exited/);
	assert.ok(!bare.header.includes("job "));
});

test("no events yet is said out loud, not rendered as silence", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, paths.runDir(JOB_ID)), { recursive: true });
	const view = watcherFor(home.path).render(JOB_ID);
	assert.equal(view.events_read, 0);
	assert.match(formatRunView(view), /no projection yet[\s\S]*no events yet/);
});

test("an unknown run exits 2, because an unknown run is not an idle one", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const watcher = watcherFor(home.path);
	assert.equal(watcher.knows("cp-never-dispatched"), false);
	assert.throws(
		() => watcher.render("cp-never-dispatched"),
		(error: unknown) => error instanceof WatchError && error.code === "unknown_run",
	);
	// A hostile id is refused before it touches a path.
	assert.throws(
		() => watcher.render("../../etc/passwd"),
		(error: unknown) => error instanceof WatchError && error.code === "unsafe_id",
	);
	assert.equal(watcher.knows("../../etc"), false, "knows() is total: it never throws on hostile input");
});

test("--last renders a bounded tail; the parent's default is bounded too", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	recordRun(home.path);
	const watcher = watcherFor(home.path, fleetRecord());
	const all = watcher.render(JOB_ID).lines;
	const tail = watcher.render(JOB_ID, { last: 3 }).lines;
	assert.equal(tail.length, 3);
	assert.deepEqual(tail, all.slice(all.length - 3));
	assert.equal(watcher.render(JOB_ID, { last: 0 }).lines.length, 0);
	assert.equal(PARENT_TAIL_DEFAULT, 40);
});

test("every line is capped, and a long payload cannot be reproduced whole", () => {
	const body = Array.from({ length: 50 }, (_, index) => `finding ${index}: ${"x".repeat(400)}`).join("\n");
	const events: RunEvent[] = [
		{
			seq: 1,
			ts: "2026-08-27T11:00:00Z",
			job_id: JOB_ID,
			source: "pi",
			type: "message_end",
			payload: { message: { role: "assistant", content: [{ type: "text", text: body }] } },
		},
	];
	for (const mode of ["compact", "detailed"] as const) {
		const lines = renderEvents(events, { mode });
		for (const line of lines) assert.ok(line.length <= WATCH_LINE_CAP + 6, `line over cap in ${mode}: ${line.length}`);
		assert.ok(lines.length <= WATCH_DETAIL_LINES + 2, `${mode} rendered ${lines.length} lines for one event`);
	}
	const detailed = renderEvents(events, { mode: "detailed" });
	assert.match(detailed.at(-1) ?? "", /more lines/, "a truncated payload says how much it dropped");
});

test("tool arguments are summarized by the field that says what happened", () => {
	assert.equal(summarizeToolArgs("bash", { command: "npm test" }), "npm test");
	assert.equal(summarizeToolArgs("read", { path: "src/a.ts", limit: 20 }), "src/a.ts");
	assert.equal(summarizeToolArgs("edit", { file_path: "src/b.ts", old: "a", new: "b" }), "src/b.ts");
	assert.equal(summarizeToolArgs("weird", { alpha: 1, beta: 2 }), "alpha,beta");
	assert.equal(summarizeToolArgs("web_search", { queries: ["a", "b"] }), "a, b");
	assert.equal(summarizeToolArgs("fetch_content", { urls: ["https://x"] }), "https://x");
	assert.equal(summarizeToolArgs("source_check", { claim: "x" }), "x");
	assert.equal(summarizeToolArgs("none", undefined), "");
});

test("a job branch cleanup renders what it removed, or what it left behind", () => {
	const events: RunEvent[] = [
		{
			seq: 1,
			ts: "2026-08-27T11:00:00Z",
			job_id: JOB_ID,
			source: "cp",
			type: "job_branch_cleaned",
			payload: {
				branch: JOB_ID,
				worktree: "/pool/1/demo",
				deleted: true,
				at: "0123456789abcdef0123456789abcdef01234567",
			},
		},
		{
			seq: 2,
			ts: "2026-08-27T11:00:01Z",
			job_id: JOB_ID,
			source: "cp",
			type: "job_branch_cleaned",
			payload: {
				branch: JOB_ID,
				worktree: "/pool/1/demo",
				deleted: false,
				reason: `branch ${JOB_ID} was left in place at /pool/1/demo (it has commits on it) — remove it by hand`,
			},
		},
	];
	const lines = renderEvents(events, { mode: "compact" });
	assert.equal(lines.length, 2, "both variants render, in both modes' shared path");
	assert.equal(lines[0], `11:00:00 ⌫ removed the empty job branch ${JOB_ID} at 0123456789ab`);
	assert.match(lines[1] as string, /⚠ job branch cp-watch-demo left in place: .*it has commits on it/);
	assert.deepEqual(renderEvents(events, { mode: "detailed" }), lines, "a destructive step is never hidden in compact mode");
});

test("a job branch cleanup with fields missing renders '?' rather than guessing", () => {
	const events: RunEvent[] = [
		{ seq: 1, ts: "2026-08-27T11:00:00Z", job_id: JOB_ID, source: "cp", type: "job_branch_cleaned", payload: { deleted: true } },
		{ seq: 2, ts: "2026-08-27T11:00:01Z", job_id: JOB_ID, source: "cp", type: "job_branch_cleaned", payload: {} },
	];
	const lines = renderEvents(events, { mode: "compact" });
	assert.equal(lines[0], "11:00:00 ⌫ removed the empty job branch ? at ?");
	assert.equal(lines[1], "11:00:01 ⚠ job branch ? left in place: ?");
});

test("unknown event types are shown in detailed mode and never guessed at", () => {
	const events: RunEvent[] = [
		{ seq: 1, ts: "2026-08-27T11:00:00Z", job_id: JOB_ID, source: "pi", type: "compaction_start", payload: {} },
		{ seq: 2, ts: "2026-08-27T11:00:01Z", job_id: JOB_ID, source: "pi", type: "agent_start", payload: {} },
	];
	assert.deepEqual(renderEvents(events, { mode: "compact" }), ["11:00:01 ▶ agent start"]);
	const detailed = renderEvents(events, { mode: "detailed" });
	assert.equal(detailed.length, 2);
	assert.match(detailed[0] as string, /compaction_start/);
});

test("renderHeader on a run with no projection says so", () => {
	assert.match(renderHeader("cp-x", undefined, undefined, "2026-08-27T11:00:00Z"), /no projection yet/);
});

test("renderHeader surfaces a long-running tool call as a measured duration, not a phase", () => {
	const status = {
		...initialStatus(JOB_ID, {}, "2026-08-27T11:41:00Z"),
		phase: "working" as const,
		current_tool: { name: "bash", tool_call_id: "call-1", started_at: "2026-08-27T11:41:02Z" },
	};
	// The incident: `git rebase --continue` wedged on vi for seven minutes.
	const header = renderHeader(JOB_ID, status, undefined, "2026-08-27T11:48:02Z");
	assert.match(header, /current tool bash running 7m !/);
	assert.ok(!header.includes("stalled"), "a duration is surfaced, never an inferred phase");

	// Short-lived call: no marker, just the fact.
	const quick = {
		...status,
		current_tool: { name: "read", tool_call_id: "call-2", started_at: "2026-08-27T11:47:58Z" },
	};
	const quickHeader = renderHeader(JOB_ID, quick, undefined, "2026-08-27T11:48:02Z");
	assert.match(quickHeader, /current tool read running 4s(?! !)/);
});

// ---------------------------------------------------------------------------
// Live follow
// ---------------------------------------------------------------------------

test("a log torn by a kill -9 still renders, minus the broken line", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, paths.runDir(JOB_ID)), { recursive: true });
	const eventsFile = join(home.path, paths.eventsFile(JOB_ID));
	const good = (seq: number, type: string): string =>
		JSON.stringify({ seq, ts: "2026-08-27T11:00:00Z", job_id: JOB_ID, source: "pi", type, payload: {} });
	// Line 2 was cut in half when the process died; line 3 landed afterwards.
	writeFileSync(eventsFile, `${good(1, "agent_start")}\n${good(2, "turn_end").slice(0, 40)}\n${good(3, "agent_settled")}\n`);

	const view = watcherFor(home.path).render(JOB_ID);
	assert.equal(view.events_read, 2, "the two intact events are shown");
	assert.equal(view.skipped_lines, 1);
	assert.deepEqual(view.lines, ["11:00:00 ▶ agent start", "11:00:00 ■ settled"]);
	assert.match(formatRunView(view), /1 unparseable line\(s\) skipped/);
	assert.deepEqual(parseWatchLines("{\"a\":1}\nnot json\n").skipped, 1);
});

test("--export names the session file from facts, or refuses", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	recordRun(home.path);
	const sessionFile = join(home.path, "session.jsonl");
	writeFileSync(sessionFile, "{}\n");

	const watcher = watcherFor(home.path, fleetRecord({}) as FleetRecord);
	// The fleet record's session file does not exist in this scratch home.
	assert.throws(
		() => watcher.exportCommand(JOB_ID),
		(error: unknown) => error instanceof WatchError && error.code === "no_session" && /is gone/.test((error as Error).message),
	);

	const present = new RunWatcher({
		home: home.path,
		record: () => {
			const base = fleetRecord();
			return { ...base, worker: { ...base.worker, session_file: sessionFile } };
		},
	});
	assert.deepEqual(present.exportCommand(JOB_ID).argv, ["--export", sessionFile]);
	assert.deepEqual(present.exportCommand(JOB_ID, "out.html").argv, ["--export", sessionFile, "out.html"]);

	// No record and no projection session: say so, never invent a path.
	const home2 = createScratchHome();
	t.after(() => home2.cleanup());
	mkdirSync(join(home2.path, paths.runDir(JOB_ID)), { recursive: true });
	assert.throws(
		() => watcherFor(home2.path).exportCommand(JOB_ID),
		(error: unknown) => error instanceof WatchError && /only history there is/.test((error as Error).message),
	);
});

// ---------------------------------------------------------------------------
// Argument parsing: the CLI follows, the parent never does
// ---------------------------------------------------------------------------

test("/watch is bounded and refuses to follow inside the parent session", () => {
	assert.deepEqual(parseWatchArgs("cp-a"), {
		jobId: "cp-a",
		mode: "compact",
		last: PARENT_TAIL_DEFAULT,
		exportRun: false,
	});
	assert.deepEqual(parseWatchArgs("cp-a --detailed --last 5"), {
		jobId: "cp-a",
		mode: "detailed",
		last: 5,
		exportRun: false,
	});
	assert.throws(() => parseWatchArgs(""), /usage: \/watch/);
	assert.throws(() => parseWatchArgs("cp-a --follow"), /never polls/);
	assert.throws(() => parseWatchArgs("cp-a -f"), /never polls/);
	assert.throws(() => parseWatchArgs("cp-a --serve"), /unknown argument/);
	assert.throws(() => parseWatchArgs("cp-a cp-b"), /one job id at a time/);
});

test("cp-routing-provenance: routing_resolved renders per-axis provenance, and the legacy shape unchanged", () => {
	const events: RunEvent[] = [
		{
			seq: 1,
			ts: "2026-08-27T11:00:00Z",
			job_id: JOB_ID,
			source: "cp",
			type: "routing_resolved",
			payload: {
				model: "anthropic/claude-opus-5",
				source: "rubric",
				rule: "risky-ship",
				thinking: "high",
				scope: "M",
				risk: "high",
				// The legacy one-word summary is still written beside the per-axis
				// truth; the renderer prefers the latter and never prints both.
				inputs: "inferred",
				provenance: { scope: "explicit", risk: "inferred" },
			},
		},
		{
			// A run logged before provenance existed: read exactly as it was.
			seq: 2,
			ts: "2026-08-27T11:00:01Z",
			job_id: JOB_ID,
			source: "cp",
			type: "routing_resolved",
			payload: { model: "anthropic/claude-haiku-4-5", source: "profile", rule: "profile implementer", scope: "S", risk: "low", inputs: "explicit" },
		},
		{
			// Older still: no scope/risk on the event at all.
			seq: 3,
			ts: "2026-08-27T11:00:02Z",
			job_id: JOB_ID,
			source: "cp",
			type: "routing_resolved",
			payload: { model: "anthropic/claude-haiku-4-5", source: "profile", rule: "profile implementer" },
		},
	];
	const lines = renderEvents(events, { mode: "compact" });
	assert.equal(
		lines[0],
		"11:00:00 ~ routing anthropic/claude-opus-5 (source=rubric, rule=risky-ship, thinking=high) inputs=M(explicit)/high(inferred)",
	);
	assert.ok(!(lines[0] as string).includes(" inferred"), "the per-axis form never trails the one-word summary too");
	assert.equal(
		lines[1],
		"11:00:01 ~ routing anthropic/claude-haiku-4-5 (source=profile, rule=profile implementer) inputs=S/low explicit",
	);
	assert.equal(
		lines[2],
		"11:00:02 ~ routing anthropic/claude-haiku-4-5 (source=profile, rule=profile implementer) inputs=S/low explicit",
	);
	assert.deepEqual(renderEvents(events, { mode: "detailed" }), lines, "the routing decision renders the same in both modes");
});
