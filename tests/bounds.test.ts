/**
 * Hard bounds: wall-clock and tool-call cap. Pure detection plus env override.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_JOB_TOOL_CALL_CAP,
	DEFAULT_JOB_WALL_CLOCK_SECONDS,
	WEDGED_TOOL_CALL_SECONDS,
} from "../src/contracts.ts";
import {
	HardBoundsWatch,
	boundFailureMessage,
	detectHardBound,
	formatBoundNotice,
	jobToolCallCap,
	jobWallClockSeconds,
	resolveJobHardBounds,
	homeWallClockSeconds,
	WorkerBoundsConfigError,
} from "../src/bounds.ts";
import { LAYOUT, type FleetRecord } from "../src/contracts.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("defaults match limen-scale caps and sit past the wedge warning", () => {
	assert.equal(DEFAULT_JOB_WALL_CLOCK_SECONDS, 5400);
	assert.equal(DEFAULT_JOB_TOOL_CALL_CAP, 900);
	assert.ok(DEFAULT_JOB_WALL_CLOCK_SECONDS > WEDGED_TOOL_CALL_SECONDS);
});

test("env override, malformed values keep the default", () => {
	assert.equal(jobWallClockSeconds({}), DEFAULT_JOB_WALL_CLOCK_SECONDS);
	assert.equal(jobWallClockSeconds({ CP_JOB_WALL_CLOCK_SECONDS: "12" }), 12);
	assert.equal(jobWallClockSeconds({ CP_JOB_WALL_CLOCK_SECONDS: "nope" }), DEFAULT_JOB_WALL_CLOCK_SECONDS);
	assert.equal(jobToolCallCap({ CP_JOB_TOOL_CALL_CAP: "4" }), 4);
	assert.equal(jobToolCallCap({ CP_JOB_TOOL_CALL_CAP: "0" }), DEFAULT_JOB_TOOL_CALL_CAP);
});

test("per-dispatch override wins over env", () => {
	const bounds = resolveJobHardBounds(
		{ wall_clock_seconds: 8, tool_call_cap: 3 },
		{ CP_JOB_WALL_CLOCK_SECONDS: "99", CP_JOB_TOOL_CALL_CAP: "99" },
	);
	assert.deepEqual(bounds, { wall_clock_seconds: 8, tool_call_cap: 3 });
});

test("wall clock precedence: explicit override > home data/worker-bounds.json > env > default", (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-bounds-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const env = { CP_JOB_WALL_CLOCK_SECONDS: "99" };
	// No file: env, then default.
	assert.equal(resolveJobHardBounds(undefined, env, home).wall_clock_seconds, 99);
	assert.equal(resolveJobHardBounds(undefined, {}, home).wall_clock_seconds, DEFAULT_JOB_WALL_CLOCK_SECONDS);
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	const file = join(home, LAYOUT.workerBoundsFile);
	writeFileSync(file, JSON.stringify({ wall_clock_seconds: 1800 }));
	assert.equal(homeWallClockSeconds(home), 1800);
	assert.deepEqual(resolveJobHardBounds(undefined, env, home), { wall_clock_seconds: 1800, tool_call_cap: DEFAULT_JOB_TOOL_CALL_CAP });
	assert.equal(resolveJobHardBounds({ wall_clock_seconds: 8 }, env, home).wall_clock_seconds, 8);
	// No home given (legacy callers): the file is not consulted.
	assert.equal(resolveJobHardBounds(undefined, env).wall_clock_seconds, 99);
});

test("a present but malformed data/worker-bounds.json refuses, naming the file and field", (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-bounds-bad-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	const file = join(home, LAYOUT.workerBoundsFile);
	// A missing or misspelled field is not "no cap configured": the file is present, so it refuses.
	const bodies = [{}, { wall_clok_seconds: 1800 }, ...[0, -5, 1.5, "1800", null].map((value) => ({ wall_clock_seconds: value }))];
	for (const body of bodies) {
		writeFileSync(file, JSON.stringify(body));
		assert.throws(
			() => resolveJobHardBounds(undefined, {}, home),
			(error: Error) => error instanceof WorkerBoundsConfigError && error.message.includes(file) && /wall_clock_seconds must be a positive integer/.test(error.message),
		);
	}
	writeFileSync(file, "{nope");
	assert.throws(() => homeWallClockSeconds(home), /worker-bounds\.json is not valid JSON/);
	writeFileSync(file, "[1800]");
	assert.throws(() => homeWallClockSeconds(home), /must be a JSON object/);
	// An explicit override does not even need the file to be readable.
	assert.equal(resolveJobHardBounds({ wall_clock_seconds: 8 }, {}, home).wall_clock_seconds, 8);
});

test("rearm starts a fresh wall-clock round without resetting the tool count (fake clock)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const failures: string[] = [];
	const record = { phase: "waiting", worktree: "/tmp/wt", branch: "b" };
	const watch = new HardBoundsWatch({
		fleet: { get: () => record } as unknown as ConstructorParameters<typeof HardBoundsWatch>[0]["fleet"],
		runs: { open: () => ({ markFailure: () => {} }) } as unknown as ConstructorParameters<typeof HardBoundsWatch>[0]["runs"],
		fail: async (_id, failure) => {
			failures.push(failure.message);
			return record as unknown as FleetRecord;
		},
		shutdown: async () => {},
		inspect: async () => ({ state: "clean", files: [], file_count: 0, commits_ahead: 0, observed_at: "now" }),
	});
	let emit: ((event: { type: string }) => void) | undefined;
	const worker = {
		onEvent: (fn: (event: { type: string }) => void) => {
			emit = fn;
			return () => {};
		},
		closed: new Promise(() => {}),
	} as unknown as Parameters<typeof watch.watch>[1];

	assert.equal(watch.rearm("cp-round"), false, "no watch armed yet");
	watch.watch("cp-round", worker, { wall_clock_seconds: 10, tool_call_cap: 3 });
	emit?.({ type: "tool_execution_start" });
	t.mock.timers.tick(8_000);
	assert.equal(watch.rearm("cp-round"), true);
	// 8s + 8s = 16s since spawn, but only 8s into the new round: no trip.
	t.mock.timers.tick(8_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(failures, []);
	// The new round's own 10s elapse: the wall clock trips, measured from the rearm.
	t.mock.timers.tick(2_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(failures, ["wall_clock bound 10s exceeded (measured 10s)"]);

	// Tool starts are not a round: the count carries across rearm.
	record.phase = "waiting";
	failures.length = 0;
	watch.watch("cp-round", worker, { wall_clock_seconds: 100, tool_call_cap: 2 });
	emit?.({ type: "tool_execution_start" });
	watch.rearm("cp-round");
	emit?.({ type: "tool_execution_start" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(failures, ["tool_call_cap bound 2 starts exceeded (measured 2 starts)"]);
});

test("the wall-clock timer trips even when it fires 1 ms before Date.now() shows the full cap", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const failures: string[] = [];
	const record = { phase: "waiting", worktree: "/tmp/wt", branch: "b" };
	const watch = new HardBoundsWatch({
		fleet: { get: () => record } as unknown as ConstructorParameters<typeof HardBoundsWatch>[0]["fleet"],
		runs: { open: () => ({ markFailure: () => {} }) } as unknown as ConstructorParameters<typeof HardBoundsWatch>[0]["runs"],
		fail: async (_id, failure) => {
			failures.push(failure.class);
			return record as unknown as FleetRecord;
		},
		shutdown: async () => {},
		inspect: async () => ({ state: "clean", files: [], file_count: 0, commits_ahead: 0, observed_at: "now" }),
	});
	const worker = { onEvent: () => () => {}, closed: new Promise(() => {}) } as unknown as Parameters<typeof watch.watch>[1];
	watch.watch("cp-early", worker, { wall_clock_seconds: 20, tool_call_cap: 900 });
	now += 19_999;
	t.mock.timers.tick(20_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(failures, ["wall_clock_exceeded"]);
});

test("tool-call cap trips at the limit; wall-clock uses spawn or open-tool age", () => {
	const bounds = { wall_clock_seconds: 10, tool_call_cap: 3 };
	assert.equal(detectHardBound(bounds, { elapsedSeconds: 9, toolStarts: 2 }), undefined);
	assert.equal(detectHardBound(bounds, { elapsedSeconds: 10, toolStarts: 2 })?.class, "wall_clock_exceeded");
	assert.equal(
		detectHardBound(bounds, { elapsedSeconds: 1, toolStarts: 1, currentToolSeconds: 10 })?.class,
		"wall_clock_exceeded",
	);
	const tools = detectHardBound(bounds, { elapsedSeconds: 99, toolStarts: 3 });
	assert.equal(tools?.class, "tool_call_cap_exceeded");
	assert.match(boundFailureMessage(tools!), /tool_call_cap bound 3 starts exceeded \(measured 3 starts\)/);
});

test("the notice names the job, the bound, and what is on disk", () => {
	const notice = formatBoundNotice(
		"cp-x",
		{ class: "wall_clock_exceeded", bound: "wall_clock", limit: 8, measured: 9, unit: "seconds" },
		{
			state: "dirty",
			files: ["leftover.txt"],
			file_count: 1,
			commits_ahead: 0,
			observed_at: "2026-09-21T00:00:00Z",
		},
	);
	assert.match(notice, /HARD BOUND — cp-x hit wall_clock 8s \(measured 9s\)/);
	assert.match(notice, /1 uncommitted file/);
	assert.match(notice, /worktree left untouched/);
});

test("a revived worker re-arms the hard bound guard for the same jobId", async () => {
	const jobId = "cp-demo-impl-aaaa";
	const record: { phase: string; reported_at?: string } = { phase: "waiting", reported_at: undefined };
	const failCalls: string[] = [];
	const shutdownCalls: string[] = [];
	const breaches: string[] = [];
	const runs = { open: () => ({ markFailure: () => {} }) } as unknown as ConstructorParameters<typeof HardBoundsWatch>[0]["runs"];
	const watch = new HardBoundsWatch({
		fleet: { get: () => ({ ...record, worktree: "/tmp/wt", branch: "b" }) } as unknown as ConstructorParameters<typeof HardBoundsWatch>[0]["fleet"],
		runs,
		fail: async (_id, failure) => {
			failCalls.push(failure.class);
			record.phase = "failed";
			return { ...record, worktree: "/tmp/wt", branch: "b" } as unknown as FleetRecord;
		},
		shutdown: async (id) => {
			shutdownCalls.push(id);
		},
		onBreach: (_id, failure) => {
			breaches.push(failure.class);
		},
		inspect: async () => ({ state: "dirty", files: ["a.ts"], file_count: 1, commits_ahead: 0, observed_at: "now" }),
	});

	const bounds = { wall_clock_seconds: 99_999, tool_call_cap: 1 };
	function fakeWorker() {
		let cb: ((event: { type: string }) => void) | undefined;
		return {
			worker: {
				onEvent: (fn: (event: { type: string }) => void) => {
					cb = fn;
					return () => {};
				},
				closed: new Promise(() => {}),
			} as unknown as Parameters<typeof watch.watch>[1],
			emitToolStart: () => cb?.({ type: "tool_execution_start" }),
		};
	}

	// First worker trips the tool-call cap.
	const w1 = fakeWorker();
	watch.watch(jobId, w1.worker, bounds);
	w1.emitToolStart();
	w1.emitToolStart();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(failCalls, ["tool_call_cap_exceeded"]);
	assert.deepEqual(breaches, ["tool_call_cap_exceeded"]);
	assert.deepEqual(shutdownCalls, [jobId]);

	// Bounded recovery revives the job into a fresh worker under the same jobId,
	// re-arming the same HardBoundsWatch instance (command-post.ts `bounds: this.bounds`).
	record.phase = "waiting";
	const w2 = fakeWorker();
	watch.watch(jobId, w2.worker, bounds);
	w2.emitToolStart();
	w2.emitToolStart();
	await new Promise((resolve) => setTimeout(resolve, 50));

	// The revived worker must be bounded again, not run unchecked.
	assert.deepEqual(failCalls, ["tool_call_cap_exceeded", "tool_call_cap_exceeded"]);
	assert.deepEqual(breaches, ["tool_call_cap_exceeded", "tool_call_cap_exceeded"]);
	assert.deepEqual(shutdownCalls, [jobId, jobId]);
});
