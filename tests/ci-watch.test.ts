/**
 * cp-e2d acceptance: the parent is woken when a held PR's CI finishes for its
 * current pushed head, or when that PR merges or closes.
 *
 * The gap these tests encode: a worker never waits for CI (cp-kzc), no local
 * file changes when a run finishes, and the parent sleeps on wake-ups and polls
 * nothing — so a green PR sat unmerged until a human happened to look. Twice in
 * one session, and four merge-ready PRs for fourteen hours before that.
 *
 * Everything here is hermetic and dependency-injected, the standing convention
 * (`tests/wedged.test.ts`): the `gh`/`git` facts are fakes returning exactly the
 * rows the case is about, `now` is injected, and nothing spawns a process,
 * sleeps, reaches the network, or uses `timeout(1)` (absent on these machines).
 *
 * `node --test tests/ci-watch.test.ts`
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	jobIdOfKey,
	CI_MESSAGE_TYPE,
	type CiObservation,
	CiWatch,
	CiWatchStore,
	ciEventKey,
	ciKeysFromMessage,
	ciWatchIntervalMs,
	deriveCiEvents,
	formatCiNotice,
	ghPrRest,
	isWatched,
	nextDueMs,
	parsePrRest,
	parsePrUrl,
	type PrObservation,
	type WatchableRecord,
} from "../src/ci-watch.ts";
import { detectCiWait } from "../src/ci-wait.ts";
import { HeldContinuation } from "../src/held-continuation.ts";
import type { IntegrateResult } from "../src/integrate.ts";
import {
	CI_WATCH_IDLE_MULTIPLIER,
	CI_WATCH_INTERVAL_MS,
	CI_WATCH_MAX_BACKOFF_MS,
	type Delivery,
	type FleetRecord,
	type IntegrationNext,
	isoTimestamp,
	type JobPhase,
	LAYOUT,
	type Receipt,
	SCHEMA_VERSION,
	validateCiWatchFile,
} from "../src/contracts.ts";
import { ghCiRuns, type CiRun } from "../src/merge-ask.ts";
import { CommandPost } from "../src/command-post.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const NEW_HEAD = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
const PR = "https://github.com/0xb1ob/pi-command-post/pull/58";
const NOW = new Date("2026-08-31T18:00:00Z");

function record(overrides: Partial<WatchableRecord> = {}): WatchableRecord {
	return {
		job_id: "cp-4wz",
		branch: "cp-4wz",
		project: "pi-command-post",
		phase: "held" as JobPhase,
		delivery: "pr" as Delivery,
		reported_at: "2026-08-31T17:00:00Z",
		receipts: [{ kind: "pr", status: "open", title: "PR for cp-4wz", url: PR }] as Receipt[],
		...overrides,
	};
}

function run(overrides: Partial<CiRun> = {}): CiRun {
	return { status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci", ...overrides };
}

function pr(overrides: Partial<PrObservation> = {}): PrObservation {
	return { merged: false, state: "open", number: 58, url: PR, head_sha: HEAD, head_ref: "cp-4wz", ...overrides };
}

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

interface Bench {
	watch: CiWatch;
	home: string;
	/** Mutable facts: the case sets them, the watcher reads them. */
	state: { jobs: WatchableRecord[]; pr?: PrObservation; runs: CiRun[]; prError?: string; runsError?: string };
	queries: { pr: number; runs: number };
	observed: CiObservation[];
	disabled: string[];
	setNow(at: Date | string): void;
	now(): Date;
}

function benchOf(
	t: { after(fn: () => void | Promise<void>): void },
	options: { jobs?: WatchableRecord[]; retrySeconds?: number } = {},
): Bench {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	let clock = NOW;
	const state: Bench["state"] = { jobs: options.jobs ?? [record()], pr: pr(), runs: [run()] };
	const queries = { pr: 0, runs: 0 };
	const observed: CiObservation[] = [];
	const disabled: string[] = [];
	const watch = new CiWatch({
		home: home.path,
		jobs: () => state.jobs,
		pr: async () => {
			queries.pr += 1;
			if (state.prError) throw new Error(state.prError);
			return state.pr;
		},
		runs: async () => {
			queries.runs += 1;
			if (state.runsError) throw new Error(state.runsError);
			return state.runs;
		},
		now: () => clock,
		intervalMs: CI_WATCH_INTERVAL_MS,
		...(options.retrySeconds !== undefined ? { retrySeconds: options.retrySeconds } : {}),
		onObserved: (_jobId, observation) => observed.push(observation),
		onDisabled: (reason) => disabled.push(reason),
	});
	return {
		watch,
		home: home.path,
		state,
		queries,
		observed,
		disabled,
		now: () => clock,
		setNow(at) {
			clock = typeof at === "string" ? new Date(at) : at;
		},
	};
}

/** Advance the injected clock past every backoff so the next tick is due. */
function advance(bench: Bench, ms: number): void {
	bench.setNow(new Date(bench.now().getTime() + ms));
}

// ---------------------------------------------------------------------------
// The watch predicate
// ---------------------------------------------------------------------------

test("a held delivery:pr job with an open PR receipt is watched", () => {
	assert.equal(isWatched(record()), true);
});

test("waiting, done and failed jobs are not watched", () => {
	for (const phase of ["waiting", "done", "failed"] as JobPhase[]) {
		assert.equal(isWatched(record({ phase })), false, `${phase} must not be watched`);
	}
});

test("delivery local and pipeline are not watched", () => {
	for (const delivery of ["local", "pipeline"] as Delivery[]) {
		assert.equal(isWatched(record({ delivery })), false, `${delivery} must not be watched`);
	}
});

test("a held job with no PR receipt is not watched", () => {
	assert.equal(isWatched(record({ receipts: [{ kind: "artifact", status: "written", title: "report" }] as Receipt[] })), false);
	assert.equal(isWatched(record({ receipts: [] })), false);
});

test("the set drains itself: a merged or landed PR receipt is not watched", () => {
	for (const status of ["merged", "landed", "MERGED", " merged "]) {
		const receipts = [{ kind: "pr", status, title: "PR", url: PR }] as Receipt[];
		assert.equal(isWatched(record({ receipts })), false, `status ${JSON.stringify(status)} must drain the set`);
	}
});

test("a job whose envelope slot was reopened by a promote is not watched", () => {
	const reopened = record({ reported_at: undefined });
	delete (reopened as { reported_at?: string }).reported_at;
	assert.equal(isWatched(reopened), false);
});

// ---------------------------------------------------------------------------
// Event derivation
// ---------------------------------------------------------------------------

test("all runs completed green on the current head derives exactly one ci_green", () => {
	const events = deriveCiEvents({
		jobId: "cp-4wz",
		branch: "cp-4wz",
		pr: pr(),
		head: { sha: HEAD },
		runs: [run(), run({ workflowName: "lint", conclusion: "skipped" })],
	});
	assert.equal(events.length, 1);
	assert.equal(events[0]?.event, "ci_green");
	assert.equal(events[0]?.head_sha, HEAD);
	assert.equal(events[0]?.key, ciEventKey("cp-4wz", HEAD, "ci_green"));
});

test("rerunwake-12z: the derived key carries the attempt, and stays historical without a run id", () => {
	const facts = { jobId: "cp-4wz", branch: "cp-4wz", pr: pr(), head: { sha: HEAD } };
	const attempt1 = deriveCiEvents({ ...facts, runs: [run({ conclusion: "failure", databaseId: 77, attempt: 1 })] });
	const attempt2 = deriveCiEvents({ ...facts, runs: [run({ conclusion: "failure", databaseId: 77, attempt: 2 })] });
	assert.equal(attempt1[0]?.event, "ci_failed");
	assert.notEqual(attempt1[0]?.key, attempt2[0]?.key, "a re-run that fails again is a new fact");
	const legacy = deriveCiEvents({ ...facts, runs: [run({ conclusion: "failure" })] });
	assert.equal(legacy[0]?.key, ciEventKey("cp-4wz", HEAD, "ci_failed"), "no run id keeps the old key shape");
});

test("one unfinished run on the head emits nothing — the aggregate rule", () => {
	const events = deriveCiEvents({
		jobId: "cp-4wz",
		branch: "cp-4wz",
		pr: pr(),
		head: { sha: HEAD },
		runs: [run(), run({ status: "in_progress", conclusion: null, workflowName: "e2e" })],
	});
	assert.deepEqual(events, []);
});

test("a green run on a superseded sha with none on the current head emits nothing", () => {
	const events = deriveCiEvents({
		jobId: "cp-4wz",
		branch: "cp-4wz",
		pr: pr({ head_sha: NEW_HEAD }),
		head: { sha: NEW_HEAD },
		runs: [run({ headSha: HEAD })],
	});
	assert.deepEqual(events, []);
});

test("a completed non-green run on the current head derives ci_failed, never ci_green", () => {
	const events = deriveCiEvents({
		jobId: "cp-4wz",
		branch: "cp-4wz",
		pr: pr(),
		head: { sha: HEAD },
		runs: [run({ conclusion: "failure", workflowName: "ci" })],
	});
	assert.equal(events.length, 1);
	assert.equal(events[0]?.event, "ci_failed");
	assert.equal(events[0]?.workflow, "ci");
	assert.equal(events[0]?.conclusion, "failure");
});

test("a merged PR derives pr_merged carrying the merge commit, and no CI event", () => {
	const events = deriveCiEvents({
		jobId: "cp-4wz",
		branch: "cp-4wz",
		pr: pr({ merged: true, state: "closed", merge_commit_sha: "79e837c7c62922e9c78944edb208d8fff2f49de1", merged_at: "2026-08-31T17:55:07Z" }),
		head: { sha: HEAD },
		runs: [run()],
	});
	assert.equal(events.length, 1);
	assert.equal(events[0]?.event, "pr_merged");
	assert.equal(events[0]?.merge_commit_sha, "79e837c7c62922e9c78944edb208d8fff2f49de1");
	assert.equal(events[0]?.merged_at, "2026-08-31T17:55:07Z");
});

test("a closed unmerged PR derives pr_closed", () => {
	const events = deriveCiEvents({
		jobId: "cp-4wz",
		branch: "cp-4wz",
		pr: pr({ state: "closed", closed_at: "2026-08-31T17:55:07Z" }),
		head: { sha: HEAD },
		runs: [],
	});
	assert.equal(events.length, 1);
	assert.equal(events[0]?.event, "pr_closed");
	assert.equal(events[0]?.closed_at, "2026-08-31T17:55:07Z");
});

test("zero runs for the branch emits nothing and is not an error", () => {
	const events = deriveCiEvents({ jobId: "cp-4wz", branch: "cp-4wz", pr: pr(), head: { sha: HEAD }, runs: [] });
	assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// Idempotence, delivery and force-push
// ---------------------------------------------------------------------------

test("two ticks with identical facts and an observed arrival wake once", async (t) => {
	const bench = benchOf(t);
	const first = await bench.watch.tick();
	assert.equal(first.observations.length, 1);
	bench.watch.confirm(first.observations.map((observation) => observation.key));
	advance(bench, CI_WATCH_INTERVAL_MS * CI_WATCH_IDLE_MULTIPLIER);
	const second = await bench.watch.tick();
	assert.deepEqual(second.observations, []);
	assert.equal(bench.observed.length, 1);
});

test("sent is not delivered: an unconfirmed fact is sent again after the retry window", async (t) => {
	const bench = benchOf(t, { retrySeconds: 600 });
	const first = await bench.watch.tick();
	assert.equal(first.observations.length, 1);
	// Due again, but inside the retry window: not re-sent, because a queued
	// followUp may still be on its way.
	advance(bench, CI_WATCH_INTERVAL_MS * CI_WATCH_IDLE_MULTIPLIER);
	assert.deepEqual((await bench.watch.tick()).observations, []);
	// Past it: at-least-once wins over at-most-once. A duplicate CI notice is
	// idempotent and visible; a lost one is neither.
	advance(bench, 601_000);
	const third = await bench.watch.tick();
	assert.equal(third.observations.length, 1);
	assert.equal(third.observations[0]?.key, first.observations[0]?.key);
	// The run log records the fact once, not once per delivery attempt.
	assert.equal(bench.observed.length, 1);
});

test("pi-command-post-jua: an unconfirmed fact gets one resend, never a third send", async (t) => {
	const bench = benchOf(t, { retrySeconds: 600 });
	const first = await bench.watch.tick();
	assert.equal(first.observations.length, 1);
	// Past the retry window, still unconfirmed: the one bounded resend.
	advance(bench, 601_000);
	const second = await bench.watch.tick();
	assert.equal(second.observations.length, 1);
	assert.equal(second.observations[0]?.key, first.observations[0]?.key);
	// Past the retry window again, still unconfirmed: no third send. Silent
	// under-delivery is the accepted trade past the bound.
	advance(bench, 601_000);
	const third = await bench.watch.tick();
	assert.deepEqual(third.observations, []);
	// The run log recorded the fact once, on the first send only.
	assert.equal(bench.observed.length, 1);
});

test("a restart over the same state file does not re-announce a confirmed fact", async (t) => {
	const bench = benchOf(t);
	const first = await bench.watch.tick();
	bench.watch.confirm(first.observations.map((observation) => observation.key));

	// A fresh watcher, same home, same facts: the inversion of WedgedWatch's
	// in-memory memory. "CI went green on d48a81d" is history once it landed.
	const fresh = new CiWatch({
		home: bench.home,
		jobs: () => bench.state.jobs,
		pr: async () => bench.state.pr,
		runs: async () => bench.state.runs,
		now: () => new Date(bench.now().getTime() + CI_WATCH_MAX_BACKOFF_MS),
		intervalMs: CI_WATCH_INTERVAL_MS,
	});
	assert.deepEqual((await fresh.tick()).observations, []);
});

test("rerunwake-12z: a re-run that fails again on the same head wakes again", async (t) => {
	// The observed defect: attempt 1 failed and `job|head|ci_failed` was announced,
	// the parent re-ran the job, and attempt 2's failure derived the same key — so
	// the wake was deduped away and the PR sat in `wait` for 35+ minutes (cp-djk9
	// #358, cp-pr8y #359, cp-9as8 #361).
	const bench = benchOf(t);
	bench.state.runs = [run({ conclusion: "failure", databaseId: 5001, attempt: 1 })];
	const red = await bench.watch.tick();
	assert.equal(red.observations.length, 1);
	assert.equal(red.observations[0]?.event, "ci_failed");
	bench.watch.confirm(red.observations.map((observation) => observation.key));

	// The re-run, still running: not a terminal fact, so nothing to say.
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	bench.state.runs = [run({ status: "in_progress", conclusion: null, databaseId: 5001, attempt: 2 })];
	assert.deepEqual((await bench.watch.tick()).observations, []);

	// Attempt 2 fails: a new completed attempt on the same head is news.
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	bench.state.runs = [run({ conclusion: "failure", databaseId: 5001, attempt: 2 })];
	const rerun = await bench.watch.tick();
	assert.equal(rerun.observations.length, 1, "the re-run's failure is a new fact");
	assert.equal(rerun.observations[0]?.event, "ci_failed");
	assert.notEqual(rerun.observations[0]?.key, red.observations[0]?.key, "a new attempt is a new key");
	assert.equal(bench.observed.length, 2);
});

test("rerunwake-12z: a green re-run after a red attempt wakes", async (t) => {
	const bench = benchOf(t);
	bench.state.runs = [run({ conclusion: "failure", databaseId: 5002, attempt: 1 })];
	const red = await bench.watch.tick();
	bench.watch.confirm(red.observations.map((observation) => observation.key));
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	bench.state.runs = [run({ conclusion: "success", databaseId: 5002, attempt: 2 })];
	const green = await bench.watch.tick();
	assert.equal(green.observations.length, 1);
	assert.equal(green.observations[0]?.event, "ci_green");
	assert.notEqual(green.observations[0]?.key, red.observations[0]?.key);
});

test("rerunwake-12z: a re-run of an already-announced green head is a new fact", async (t) => {
	const bench = benchOf(t);
	bench.state.runs = [run({ databaseId: 5003, attempt: 1 })];
	const first = await bench.watch.tick();
	assert.equal(first.observations[0]?.event, "ci_green");
	bench.watch.confirm(first.observations.map((observation) => observation.key));
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	bench.state.runs = [run({ databaseId: 5003, attempt: 2 })];
	const second = await bench.watch.tick();
	assert.equal(second.observations.length, 1, "the same event on a new attempt is not a replay");
	assert.equal(second.observations[0]?.event, "ci_green");
	assert.notEqual(second.observations[0]?.key, first.observations[0]?.key);
});

test("rerunwake-12z: the same completed attempt polled twice wakes once", async (t) => {
	const bench = benchOf(t);
	bench.state.runs = [run({ conclusion: "failure", databaseId: 5004, attempt: 2 })];
	const first = await bench.watch.tick();
	assert.equal(first.observations.length, 1);
	bench.watch.confirm(first.observations.map((observation) => observation.key));
	advance(bench, CI_WATCH_IDLE_MULTIPLIER * CI_WATCH_INTERVAL_MS);
	assert.deepEqual((await bench.watch.tick()).observations, []);
	assert.equal(bench.observed.length, 1);
});

test("rerunwake-12z: a restart over the same run identity does not re-announce", async (t) => {
	const bench = benchOf(t);
	bench.state.runs = [run({ conclusion: "failure", databaseId: 5005, attempt: 2 })];
	const first = await bench.watch.tick();
	bench.watch.confirm(first.observations.map((observation) => observation.key));
	const fresh = new CiWatch({
		home: bench.home,
		jobs: () => bench.state.jobs,
		pr: async () => bench.state.pr,
		runs: async () => bench.state.runs,
		now: () => new Date(bench.now().getTime() + CI_WATCH_MAX_BACKOFF_MS),
		intervalMs: CI_WATCH_INTERVAL_MS,
	});
	assert.deepEqual((await fresh.tick()).observations, []);
});

test("a force-push makes the new head a new key, and does not retract the old one", async (t) => {
	const bench = benchOf(t);
	const first = await bench.watch.tick();
	assert.equal(first.observations[0]?.event, "ci_green");
	bench.watch.confirm(first.observations.map((observation) => observation.key));

	// The head moves. The old head's completed run is invisible from here, so
	// nothing is emitted until a run starts on the new one.
	bench.state.pr = pr({ head_sha: NEW_HEAD });
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	assert.deepEqual((await bench.watch.tick()).observations, []);
	assert.equal(bench.watch.head("cp-4wz"), NEW_HEAD);

	bench.state.runs = [run({ headSha: NEW_HEAD })];
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	const second = await bench.watch.tick();
	assert.equal(second.observations.length, 1);
	assert.equal(second.observations[0]?.key, ciEventKey("cp-4wz", NEW_HEAD, "ci_green"));
});

test("ci_failed, then a force-push, then green: the failure is neither repeated nor retracted", async (t) => {
	const bench = benchOf(t);
	bench.state.runs = [run({ conclusion: "failure" })];
	const red = await bench.watch.tick();
	assert.equal(red.observations[0]?.event, "ci_failed");
	bench.watch.confirm(red.observations.map((observation) => observation.key));

	bench.state.pr = pr({ head_sha: NEW_HEAD });
	bench.state.runs = [run({ headSha: NEW_HEAD })];
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	const green = await bench.watch.tick();
	assert.equal(green.observations.length, 1);
	assert.equal(green.observations[0]?.event, "ci_green");
	assert.equal(green.observations[0]?.head_sha, NEW_HEAD);
	assert.equal(bench.observed.filter((observation) => observation.event === "ci_failed").length, 1);
});

test("a job that leaves the watch set is pruned from the state file", async (t) => {
	const bench = benchOf(t);
	await bench.watch.tick();
	assert.ok(bench.watch.head("cp-4wz"));
	bench.state.jobs = [record({ receipts: [{ kind: "pr", status: "merged", title: "PR", url: PR }] as Receipt[] })];
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	const tick = await bench.watch.tick();
	assert.deepEqual(tick.checked, []);
	assert.equal(bench.watch.head("cp-4wz"), undefined);
});

// ---------------------------------------------------------------------------
// Polling policy
// ---------------------------------------------------------------------------

test("every command the watcher builds passes detectCiWait", async () => {
	const built: string[] = [];
	const exec = async (command: string, args: readonly string[]) => {
		built.push([command, ...args].join(" "));
		return command === "gh" && args[0] === "api" ? JSON.stringify({ number: 58, state: "open", merged: false, head: { sha: HEAD } }) : "[]";
	};
	await ghPrRest({ cwd: "/tmp", exec })(PR);
	await ghCiRuns({ cwd: "/tmp", exec })("cp-4wz");
	assert.equal(built.length, 2);
	for (const command of built) {
		assert.equal(detectCiWait(command), undefined, `the watcher must never build a refused shape: ${command}`);
	}
	// And the shapes that ARE refused stay refused, so this is a real assertion.
	assert.ok(detectCiWait(`sleep 60; ${built[1]}`));
	assert.ok(detectCiWait("gh run watch 12345 --exit-status"));
});

test("a query error backs off exponentially and a success resets it", async (t) => {
	const bench = benchOf(t);
	bench.state.prError = "gh api failed: 500";
	const delays: number[] = [];
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		const before = bench.now().getTime();
		const tick = await bench.watch.tick();
		assert.equal(tick.errors.length, 1);
		const due = Date.parse(bench.watch.store.job("cp-4wz")?.next_due_at ?? "");
		delays.push(due - before);
		advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	}
	assert.deepEqual(delays.slice(0, 4), [60_000, 120_000, 240_000, 480_000]);
	assert.equal(delays[4], CI_WATCH_MAX_BACKOFF_MS);

	delete bench.state.prError;
	const ok = await bench.watch.tick();
	assert.equal(ok.errors.length, 0);
	assert.equal(bench.watch.store.job("cp-4wz")?.consecutive_failures, 0);
});

test("a query that learned nothing does not age the head it did not read (pi-command-post-8ok)", async (t) => {
	// `observedAt` is what tells `headMoved` whether this watcher's head is the
	// current reading of the branch or a lagging one. It used to be
	// `last_checked_at`, which a *failed* query advances too — so every minute `gh`
	// was unreachable made a head nobody had re-read look freshly observed, and a
	// stale head that reads as current is a head that withholds a live verdict.
	const bench = benchOf(t);
	await bench.watch.tick();
	const observedAt = bench.watch.observedAt("cp-4wz");
	assert.equal(observedAt, "2026-08-31T18:00:00Z");
	assert.equal(bench.watch.head("cp-4wz"), HEAD);

	// A long lag: query after query fails, for well over an hour.
	bench.state.prError = "gh api failed: 500";
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		advance(bench, CI_WATCH_MAX_BACKOFF_MS);
		assert.equal((await bench.watch.tick()).errors.length, 1);
		assert.equal(bench.watch.observedAt("cp-4wz"), observedAt, "a failed query re-read no head, so it aged none");
		assert.equal(bench.watch.head("cp-4wz"), HEAD, "and the head it still holds is the one it last read");
	}
	// The scheduler's own timestamps did advance — the attempt happened.
	const job = bench.watch.store.job("cp-4wz");
	assert.notEqual(job?.last_checked_at, observedAt, "the attempt is recorded, it is just not an observation");
	assert.equal(job?.consecutive_failures, 5);

	// A tick that reaches GitHub but cannot resolve a head is the same fact.
	delete bench.state.prError;
	bench.state.pr = pr({ head_sha: undefined });
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	await bench.watch.tick();
	assert.equal(bench.watch.observedAt("cp-4wz"), observedAt, "no head resolved is no head observed");

	// And an actual refresh does age it, or the field would be useless.
	bench.state.pr = pr({ head_sha: NEW_HEAD });
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	await bench.watch.tick();
	assert.equal(bench.watch.head("cp-4wz"), NEW_HEAD);
	assert.equal(bench.watch.observedAt("cp-4wz"), isoTimestamp(bench.now()));
});

test("a missing gh disables the watch, says so once, and emits nothing", async (t) => {
	const bench = benchOf(t);
	bench.state.prError = "spawn gh ENOENT";
	const first = await bench.watch.tick();
	assert.ok(first.disabled);
	assert.deepEqual(first.observations, []);
	advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	const second = await bench.watch.tick();
	assert.ok(second.disabled);
	assert.deepEqual(second.observations, []);
	assert.equal(bench.disabled.length, 1, "an alarm that fires every tick is an alarm nobody reads");
	assert.equal(bench.queries.pr, 1, "a disabled watch stops querying");
});

test("an announced verdict on an open PR is re-checked at the idle multiplier", async (t) => {
	const bench = benchOf(t);
	const before = bench.now().getTime();
	await bench.watch.tick();
	const due = Date.parse(bench.watch.store.job("cp-4wz")?.next_due_at ?? "");
	assert.equal(due - before, CI_WATCH_INTERVAL_MS * CI_WATCH_IDLE_MULTIPLIER);
});

test("a job with no verdict yet is re-checked at the base interval", async (t) => {
	const bench = benchOf(t);
	bench.state.runs = [run({ status: "in_progress", conclusion: null })];
	const before = bench.now().getTime();
	const tick = await bench.watch.tick();
	assert.deepEqual(tick.observations, []);
	const due = Date.parse(bench.watch.store.job("cp-4wz")?.next_due_at ?? "");
	assert.equal(due - before, CI_WATCH_INTERVAL_MS);
});

test("a tick that is not due yet is skipped, not queried", async (t) => {
	const bench = benchOf(t);
	await bench.watch.tick();
	const queries = bench.queries.pr;
	const tick = await bench.watch.tick();
	assert.deepEqual(tick.skipped, ["cp-4wz"]);
	assert.equal(bench.queries.pr, queries);
});

test("an overlapping tick returns the first one's promise: no double query", async (t) => {
	const bench = benchOf(t);
	const [a, b] = await Promise.all([bench.watch.tick(), bench.watch.tick()]);
	assert.equal(bench.queries.pr, 1);
	assert.deepEqual(a.observations.map((observation) => observation.key), b.observations.map((observation) => observation.key));
});

test("nextDueMs: base, idle multiplier, exponential backoff, capped", () => {
	const cadence = { intervalMs: 60_000, idleMultiplier: 5, maxBackoffMs: 900_000 };
	assert.equal(nextDueMs(cadence, { failures: 0, settled: false }), 60_000);
	assert.equal(nextDueMs(cadence, { failures: 0, settled: true }), 300_000);
	assert.equal(nextDueMs(cadence, { failures: 1, settled: false }), 60_000);
	assert.equal(nextDueMs(cadence, { failures: 4, settled: false }), 480_000);
	assert.equal(nextDueMs(cadence, { failures: 40, settled: false }), 900_000);
});

test("a malformed CP_CI_WATCH_SECONDS falls back to the default, never to off", () => {
	assert.equal(ciWatchIntervalMs({} as NodeJS.ProcessEnv), CI_WATCH_INTERVAL_MS);
	assert.equal(ciWatchIntervalMs({ CP_CI_WATCH_SECONDS: "" } as NodeJS.ProcessEnv), CI_WATCH_INTERVAL_MS);
	assert.equal(ciWatchIntervalMs({ CP_CI_WATCH_SECONDS: "nope" } as NodeJS.ProcessEnv), CI_WATCH_INTERVAL_MS);
	assert.equal(ciWatchIntervalMs({ CP_CI_WATCH_SECONDS: "0" } as NodeJS.ProcessEnv), CI_WATCH_INTERVAL_MS);
	assert.equal(ciWatchIntervalMs({ CP_CI_WATCH_SECONDS: "-5" } as NodeJS.ProcessEnv), CI_WATCH_INTERVAL_MS);
	assert.equal(ciWatchIntervalMs({ CP_CI_WATCH_SECONDS: "120" } as NodeJS.ProcessEnv), 120_000);
});

// ---------------------------------------------------------------------------
// The watcher declares nothing and merges nothing
// ---------------------------------------------------------------------------

test("the watcher writes only its own state file: no awaiting rows, no receipts", async (t) => {
	const bench = benchOf(t);
	for (let tick = 0; tick < 4; tick += 1) {
		bench.state.runs = tick % 2 === 0 ? [run()] : [run({ conclusion: "failure", headSha: NEW_HEAD })];
		bench.state.pr = tick === 3 ? pr({ merged: true, state: "closed", merge_commit_sha: NEW_HEAD }) : pr();
		await bench.watch.tick();
		advance(bench, CI_WATCH_MAX_BACKOFF_MS);
	}
	assert.equal(existsIn(bench.home, LAYOUT.awaitingFile), false, "a background timer must never mint decisions");
	assert.equal(existsIn(bench.home, LAYOUT.fleetFile), false, "the watcher never touches the fleet");
	assert.equal(existsIn(bench.home, LAYOUT.ciWatchFile), true);
});

function existsIn(home: string, relative: string): boolean {
	try {
		readFileSync(join(home, relative), "utf8");
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// The store and the contract
// ---------------------------------------------------------------------------

test("state/ci-watch.json round-trips and refuses an invalid shape", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new CiWatchStore({ home: home.path, now: () => NOW });
	store.record("cp-4wz", { head_sha: HEAD, last_ci: "green", consecutive_failures: 0 });
	store.confirm([ciEventKey("cp-4wz", HEAD, "ci_green")]);
	const parsed = validateCiWatchFile(JSON.parse(readFileSync(join(home.path, LAYOUT.ciWatchFile), "utf8")));
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("\n"));
	assert.equal(parsed.value.schema_version, SCHEMA_VERSION);
	assert.deepEqual(parsed.value.jobs[0]?.announced, [ciEventKey("cp-4wz", HEAD, "ci_green")]);

	assert.equal(validateCiWatchFile({ schema_version: 1, updated_at: NOW.toISOString(), jobs: [{ job_id: "cp-4wz" }] }).ok, false);
	assert.equal(validateCiWatchFile({ schema_version: 1, updated_at: "not-a-time", jobs: [] }).ok, false);
	assert.equal(validateCiWatchFile({ jobs: [] }).ok, false);
});

test("an unreadable state file degrades to no memory instead of throwing out of a tick", async (t) => {
	const bench = benchOf(t);
	const file = join(bench.home, LAYOUT.ciWatchFile);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "{ not json");
	const tick = await bench.watch.tick();
	assert.equal(tick.errors.length, 0);
	assert.equal(tick.observations.length, 1, "no memory means one duplicate notice, never a missed one");
});

test("confirming the same key twice is a no-op", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new CiWatchStore({ home: home.path, now: () => NOW });
	const key = ciEventKey("cp-4wz", HEAD, "ci_green");
	assert.deepEqual(store.confirm([key]), [key]);
	assert.deepEqual(store.confirm([key]), []);
	assert.deepEqual([...store.announced("cp-4wz")], [key]);
});

// ---------------------------------------------------------------------------
// Message shape and parsing
// ---------------------------------------------------------------------------

test("arrival evidence comes off the message, and only off a cp-ci message", () => {
	const key = ciEventKey("cp-4wz", HEAD, "ci_green");
	assert.deepEqual(ciKeysFromMessage({ customType: CI_MESSAGE_TYPE, details: { ci: [{ key }] } }), [key]);
	assert.deepEqual(ciKeysFromMessage({ customType: CI_MESSAGE_TYPE, details: { ci: [key] } }), [key]);
	assert.deepEqual(ciKeysFromMessage({ customType: "cp-envelope", details: { ci: [key] } }), []);
	assert.deepEqual(ciKeysFromMessage({ customType: CI_MESSAGE_TYPE }), []);
	assert.deepEqual(ciKeysFromMessage(undefined), []);
	assert.equal(jobIdOfKey(key), "cp-4wz");
});

test("the notice is a headline plus facts, and says green is not authorization", () => {
	const [green] = deriveCiEvents({ jobId: "cp-4wz", branch: "cp-4wz", pr: pr(), head: { sha: HEAD }, runs: [run()] });
	const text = formatCiNotice([green as CiObservation]);
	assert.match(text, /^CI\/PR OBSERVED/);
	assert.match(text, /cp-4wz: CI green on d48a81d1f4d3/);
	assert.match(text, /evidence, not authorization/i);
	assert.match(text, /Nothing has been merged\./);
	assert.equal(formatCiNotice([]), "");
});

test("the green notice sends the parent to cp_integrate, never back to gh (cp-3zbp)", () => {
	// The observed defect: the notice told the parent to "verify CI against the
	// head sha yourself, check ancestry", so a parent that already held the
	// GitHub read spent a turn re-taking it (gh run list, two gh pr views, one of
	// them a 403 on statusCheckRollup, a hand-rolled merge-base). The wake-up is
	// the read; the only next step it may name is cp_integrate.
	const [green] = deriveCiEvents({ jobId: "cp-4wz", branch: "cp-4wz", pr: pr(), head: { sha: HEAD }, runs: [run()] });
	const text = formatCiNotice([green as CiObservation]);
	assert.match(text, /cp_integrate/, "the notice must name the one follow-on step");
	assert.match(text, /do not re-query gh/i);
	assert.doesNotMatch(text, /verify CI (against|yourself)/i, "the notice tells the parent to re-prove the fact it carries");
	assert.doesNotMatch(text, /check ancestry/i, "ancestry is cp_integrate's read, not a hand-rolled merge-base");
	for (const command of [/gh run list/, /gh pr checks/, /gh pr view/]) {
		assert.doesNotMatch(text, command, `the notice invites a re-query: ${command.source}`);
	}
	// It mints no decision either, so it is not a reason to re-render a row.
	assert.match(text, /no Awaiting-you row/i);
});

test("a red notice asks no merge question at all", () => {
	const [red] = deriveCiEvents({
		jobId: "cp-4wz",
		branch: "cp-4wz",
		pr: pr(),
		head: { sha: HEAD },
		runs: [run({ conclusion: "failure" })],
	});
	const text = formatCiNotice([red as CiObservation]);
	assert.match(text, /Merging red is forbidden/);
	assert.doesNotMatch(text, /evidence, not authorization/i);
});

test("REST parsing: the PR url, the fields, and nothing GraphQL", () => {
	assert.deepEqual(parsePrUrl(PR), { owner: "0xb1ob", repo: "pi-command-post", number: 58 });
	assert.equal(parsePrUrl("https://example.com/whatever"), undefined);
	const observation = parsePrRest(
		JSON.stringify({
			number: 58,
			html_url: PR,
			state: "closed",
			merged: true,
			merge_commit_sha: NEW_HEAD,
			merged_at: "2026-08-31T17:55:07Z",
			head: { sha: HEAD, ref: "cp-4wz" },
		}),
	);
	assert.equal(observation?.merged, true);
	assert.equal(observation?.head_sha, HEAD);
	assert.equal(observation?.merge_commit_sha, NEW_HEAD);
	assert.equal(parsePrRest(""), undefined);
});

// ---------------------------------------------------------------------------
// pi-command-post-epic-pr-a-jje.2: the held-PR continuation. The watcher's facts
// (and an envelope, a passing review, a restart) now advance integration by
// themselves — serial per project, coalesced per job|head|event, re-checked at
// execution, and stopped visibly on anything but `advance`.
// ---------------------------------------------------------------------------

interface ContinuationBench {
	continuation: HeldContinuation;
	records: FleetRecord[];
	heads: Map<string, string>;
	/** Per job, the `next` values `advance` returns in order (the last repeats). */
	script: Map<string, IntegrationNext[]>;
	advances: string[];
	reviews: string[];
	pending: Set<string>;
	handedBack: string[];
	notices: { id: string; job_id: string; content: string; keys?: string[] }[];
	/** Most integration steps ever running at once. */
	peak: { now: number; max: number };
	/** Runs inside each `advance`, i.e. while a step is in flight. */
	during: { step?: (jobId: string) => void; head?: string };
}

function heldRecord(jobId: string, overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		...record({ job_id: jobId, branch: jobId }),
		kind: "ship",
		supersessions: 0,
		...overrides,
	} as unknown as FleetRecord;
}

function continuationBench(options: { records?: FleetRecord[]; enabled?: boolean; writeBack?: (jobId: string) => string } = {}): ContinuationBench {
	const records = options.records ?? [heldRecord("cp-4wz")];
	const bench: Omit<ContinuationBench, "continuation"> = {
		records,
		heads: new Map(),
		script: new Map(),
		advances: [],
		reviews: [],
		pending: new Set(),
		handedBack: [],
		notices: [],
		peak: { now: 0, max: 0 },
		during: {},
	};
	const continuation = new HeldContinuation({
		enabled: () => options.enabled ?? true,
		fleet: {
			get: (jobId: string) => bench.records.find((entry) => entry.job_id === jobId),
			list: () => bench.records,
		} as never,
		advance: async (jobId) => {
			bench.peak.now += 1;
			bench.peak.max = Math.max(bench.peak.max, bench.peak.now);
			bench.advances.push(jobId);
			await new Promise((resolve) => setImmediate(resolve));
			bench.during.step?.(jobId);
			const steps = bench.script.get(jobId) ?? ["wait"];
			const next = steps.length > 1 ? (steps.shift() as IntegrationNext) : (steps[0] as IntegrationNext);
			bench.peak.now -= 1;
			return { job_id: jobId, branch: jobId, step: next === "done" ? "done" : "merge", next, facts: [], reason: `${jobId}: ${next}`, pr_url: PR, head_sha: bench.during.head ?? HEAD } as unknown as IntegrateResult;
		},
		review: async (jobId) => {
			bench.reviews.push(jobId);
			return { next: "wait", surface: "review", attempt: 1, model: "mock/reviewer", deadline: "2026-08-31T18:15:00Z", key: `${jobId}#review-1`, head_sha: HEAD };
		},
		reviews: {
			pending: (jobId: string) => (bench.pending.has(jobId) ? ({ attempt: 1 } as never) : undefined),
			handBack: (key: string) => void bench.handedBack.push(key),
		},
		// Every source reads HEAD unless a case moves it; "" plays a source that cannot be read.
		head: (jobId) => bench.heads.get(jobId) ?? HEAD,
		notify: (notice) => void bench.notices.push(notice),
		...(options.writeBack ? { writeBack: options.writeBack } : {}),
	});
	return { ...bench, continuation };
}

test("jje.2 green: envelope starts the review, a passing verdict merges and finishes — no parent turn", async () => {
	const b = continuationBench();
	b.script.set("cp-4wz", ["review"]);
	const envelope = await b.continuation.trigger({ jobId: "cp-4wz", event: "envelope", generation: 1 });
	assert.equal(envelope.action, "review_started");
	assert.deepEqual(b.reviews, ["cp-4wz"], "one cp_review, started by the parent itself");
	assert.deepEqual(b.handedBack, ["cp-4wz#review-1"], "handed back at once, so the verdict is not held behind a caller");
	assert.equal(b.notices.length, 0, "a started review is not a stop: its cp-verdict is the next wake-up");

	b.script.set("cp-4wz", ["advance", "done"]);
	await b.continuation.onVerdict({ jobId: "cp-4wz", surface: "review", attempt: 1, headSha: HEAD, content: "", details: { next: "proceed" } });
	assert.deepEqual(b.advances, ["cp-4wz", "cp-4wz", "cp-4wz"], "merge, then finish, in one continuation");
	assert.equal(b.notices.length, 1);
	assert.match(b.notices[0]?.content ?? "", /HELD PR LANDED — cp-4wz/);
	assert.match(b.notices[0]?.content ?? "", /cp_next/);
	assert.equal(b.notices[0]?.keys, undefined, "a landing notice is about the job being done, so it is never stale for it");
});

test("laf: a HELD PR LANDED notice names the tracker write-back; a stop, or no writeBack dep, adds nothing", async () => {
	const line = "tracker write-back: demo-beads/b-1 closes with https://github.com/o/r/pull/7 on the next write-back tick";
	const asked: string[] = [];
	const b = continuationBench({ writeBack: (jobId) => (asked.push(jobId), line) });
	b.script.set("cp-4wz", ["done"]);
	await b.continuation.trigger({ jobId: "cp-4wz", event: "envelope", generation: 1 });
	assert.equal(b.notices.length, 1);
	assert.match(b.notices[0]?.content ?? "", /HELD PR LANDED — cp-4wz/);
	assert.ok(b.notices[0]?.content.includes(`\n  ${line}\n`), b.notices[0]?.content);
	assert.deepEqual(asked, ["cp-4wz"]);
	const stop = continuationBench({ writeBack: () => line });
	stop.script.set("cp-4wz", ["surface"]);
	await stop.continuation.trigger({ jobId: "cp-4wz", event: "envelope", generation: 1 });
	assert.match(stop.notices[0]?.content ?? "", /HELD PR STOPPED/);
	assert.doesNotMatch(stop.notices[0]?.content ?? "", /tracker write-back/);
	const plain = continuationBench();
	plain.script.set("cp-4wz", ["done"]);
	await plain.continuation.trigger({ jobId: "cp-4wz", event: "envelope", generation: 1 });
	assert.match(plain.notices[0]?.content ?? "", /HELD PR LANDED/);
	assert.doesNotMatch(plain.notices[0]?.content ?? "", /tracker write-back/);
});

test("jje.2 revise: a revise verdict continues nothing — the fix belongs to the job's own implementer", async () => {
	const b = continuationBench();
	await b.continuation.onVerdict({ jobId: "cp-4wz", surface: "review", attempt: 2, headSha: HEAD, content: "", details: { next: "revise" } });
	await b.continuation.onVerdict({ jobId: "cp-4wz", surface: "gate", attempt: 1, content: "", details: { next: "proceed" } });
	assert.deepEqual(b.advances, [], "no integration step, no second reviewer, no repromote");
});

test("jje.2 serial: two held PRs in one project never overlap a step, and a manual cp_integrate waits its turn", async () => {
	const b = continuationBench({ records: [heldRecord("cp-a1"), heldRecord("cp-a2")] });
	b.script.set("cp-a1", ["advance", "done"]);
	b.script.set("cp-a2", ["advance", "done"]);
	const order: string[] = [];
	const manual = b.continuation.serialize("cp-a2", async () => {
		order.push("manual");
	});
	await Promise.all([
		b.continuation.trigger({ jobId: "cp-a1", event: "ci_green", head: HEAD }),
		b.continuation.trigger({ jobId: "cp-a2", event: "ci_green", head: HEAD }),
		manual,
	]);
	assert.equal(b.peak.max, 1, "the second PR reads the base the first merge left, never races it");
	assert.deepEqual(b.advances, ["cp-a1", "cp-a1", "cp-a2", "cp-a2"], "one job's sequence runs to its stop before the next starts");
	assert.equal(order[0], "manual");
});

test("jje.2 red: a failed head stops visibly once, and a duplicate event never promotes again", async () => {
	const b = continuationBench();
	b.script.set("cp-4wz", ["resolve"]);
	const first = await b.continuation.trigger({ jobId: "cp-4wz", event: "ci_failed", head: HEAD });
	assert.equal(first.action, "stopped");
	assert.equal(first.next, "resolve");
	const again = await b.continuation.trigger({ jobId: "cp-4wz", event: "ci_failed", head: HEAD });
	assert.equal(again.action, "coalesced");
	assert.equal(b.advances.length, 1, "the replayed fact reached no integration step at all");
	assert.equal(b.notices.length, 1);
	assert.match(b.notices[0]?.content ?? "", /HELD PR STOPPED — cp-4wz \(continuation, next: resolve\)/);
	assert.deepEqual(b.notices[0]?.keys, ["cp-4wz"], "a stop notice goes stale once the job is done");
	// A new head is a new fact, and actionable.
	b.heads.set("cp-4wz", NEW_HEAD);
	b.script.set("cp-4wz", ["wait"]);
	assert.equal((await b.continuation.trigger({ jobId: "cp-4wz", event: "ci_failed", head: NEW_HEAD })).action, "wait");
});

test("jje.2 stale: a moved head, a reopened generation or a job no longer held acts on nothing", async () => {
	const b = continuationBench();
	b.script.set("cp-4wz", ["advance", "done"]);
	b.heads.set("cp-4wz", NEW_HEAD);
	const moved = await b.continuation.trigger({ jobId: "cp-4wz", event: "ci_green", head: HEAD });
	assert.equal(moved.action, "stale");
	assert.match(moved.reason, /moved from d48a81d1f4d3 to aa11bb22cc33/);
	const generation = await b.continuation.trigger({ jobId: "cp-4wz", event: "envelope", generation: 2 });
	assert.equal(generation.action, "stale");
	(b.records[0] as { phase: string }).phase = "waiting";
	const promoted = await b.continuation.trigger({ jobId: "cp-4wz", event: "startup" });
	assert.equal(promoted.action, "stale", "a promoted job's branch belongs to its worker again");
	assert.deepEqual(b.advances, [], "nothing merged, reviewed or promoted on a stale event");
	assert.equal(b.notices.length, 0);
});

test("jje.2 wait/retry/pending: wait is left to the watcher, a fault is never retried, a pending review is not doubled", async () => {
	const b = continuationBench({ records: [heldRecord("cp-w"), heldRecord("cp-r"), heldRecord("cp-p")] });
	b.script.set("cp-w", ["wait"]);
	b.script.set("cp-r", ["retry"]);
	b.script.set("cp-p", ["review"]);
	b.pending.add("cp-p");
	assert.equal((await b.continuation.trigger({ jobId: "cp-w", event: "ci_green", head: HEAD })).action, "wait");
	const retry = await b.continuation.trigger({ jobId: "cp-r", event: "ci_green", head: HEAD });
	assert.equal(retry.next, "retry");
	assert.equal((await b.continuation.trigger({ jobId: "cp-p", event: "ci_green", head: HEAD })).action, "review_pending");
	assert.deepEqual(b.advances, ["cp-w", "cp-r", "cp-p"], "one step each: nothing loops on an operational fault");
	assert.deepEqual(b.reviews, [], "one reviewer per job and surface");
	assert.deepEqual(b.notices.map((notice) => notice.job_id), ["cp-r"], "only the stop that needs somebody is announced");
	assert.match(b.notices[0]?.content ?? "", /nothing retries automatically/);
});

test("jje.2 restart: startup resumes every held PR once, and a fresh process resumes again", async () => {
	const records = [heldRecord("cp-h1"), heldRecord("cp-h2", { project: "other" } as Partial<FleetRecord>), heldRecord("cp-w1", { phase: "waiting" } as Partial<FleetRecord>)];
	const b = continuationBench({ records });
	b.script.set("cp-h1", ["advance", "done"]);
	const outcomes = await b.continuation.resume();
	assert.deepEqual(outcomes.map((outcome) => `${outcome.job_id}:${outcome.action}`).sort(), ["cp-h1:done", "cp-h2:wait"]);
	assert.deepEqual(
		(await b.continuation.resume()).map((outcome) => `${outcome.job_id}:${outcome.action}`).sort(),
		["cp-h1:coalesced", "cp-h2:wait"],
		"a settled job is not passed again; one that only waited is re-armed",
	);
	const restarted = continuationBench({ records });
	assert.equal((await restarted.continuation.resume()).length, 2, "a new parent owes every held PR its pass");
	const off = continuationBench({ records, enabled: false });
	assert.deepEqual(await off.continuation.resume(), [], "a session without the continuation (or the lock) touches nothing");
	assert.equal((await off.continuation.trigger({ jobId: "cp-h1", event: "ci_green", head: HEAD })).action, "disabled");
});

test("jje.2: a CI/PR watch tick that throws is journaled durably, once per cause", async (t) => {
	const home = createScratchHome();
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	t.after(async () => {
		await post.shutdown();
		home.cleanup();
	});
	post.ciWatchFailed(new Error("fleet.json is not valid JSON\nstack…"));
	post.ciWatchFailed(new Error("fleet.json is not valid JSON\nanother stack"));
	post.ciWatchFailed("gh exited 1");
	const journaled = post.durableWakeups.pending().map((entry) => entry.content);
	assert.equal(journaled.length, 2, "the same cause is one entry, a new cause is another");
	assert.match(journaled[0] ?? "", /^CI\/PR WATCH TICK FAILED — fleet\.json is not valid JSON\n/);
	assert.match(journaled[1] ?? "", /gh exited 1/);
});

test("jje.2 generation: a CI fact carries the generation it was observed on — a reopened job is a new identity, an old one is stale", async () => {
	const b = continuationBench();
	b.script.set("cp-4wz", ["wait"]);
	b.continuation.onCi("cp-4wz", { event: "ci_green", head_sha: HEAD });
	await new Promise((resolve) => setImmediate(resolve));
	await b.continuation.serialize("cp-4wz", async () => {});
	assert.deepEqual(b.advances, ["cp-4wz"], "generation 1's fact acted once");
	// A promote reopened the slot and the worker reported again on the same head:
	// the same head/event on generation 2 is a new fact, not a replay of generation 1's.
	(b.records[0] as { supersessions: number }).supersessions = 1;
	b.continuation.onCi("cp-4wz", { event: "ci_green", head_sha: HEAD });
	await new Promise((resolve) => setImmediate(resolve));
	await b.continuation.serialize("cp-4wz", async () => {});
	assert.deepEqual(b.advances, ["cp-4wz", "cp-4wz"], "the new generation's same-head event is not suppressed");
	// A generation-1 fact arriving late acts on nothing.
	const late = await b.continuation.trigger({ jobId: "cp-4wz", event: "ci_failed", head: HEAD, generation: 1 });
	assert.equal(late.action, "stale");
	assert.match(late.reason, /generation 1 to 2/);
	assert.equal(b.advances.length, 2);
});

test("rerunwake-12z: a new CI attempt is a new continuation fact, the same one is a replay", async () => {
	// The run-identity key gets the wake out; this is the other half of the
	// requirement — the held-PR continuation must also act on the new attempt, or
	// integration.json keeps the stale `wait`/`in_progress` record it wrote when the
	// re-run was still running.
	const b = continuationBench();
	b.script.set("cp-4wz", ["resolve"]);
	const flush = async () => {
		await new Promise((resolve) => setImmediate(resolve));
		await b.continuation.serialize("cp-4wz", async () => {});
	};
	b.continuation.onCi("cp-4wz", { event: "ci_failed", head_sha: HEAD, run_identity: "abc123" });
	await flush();
	assert.deepEqual(b.advances, ["cp-4wz"], "the first attempt's failure acted once");
	b.continuation.onCi("cp-4wz", { event: "ci_failed", head_sha: HEAD, run_identity: "abc123" });
	await flush();
	assert.deepEqual(b.advances, ["cp-4wz"], "the same attempt never promotes twice");
	b.continuation.onCi("cp-4wz", { event: "ci_failed", head_sha: HEAD, run_identity: "def456" });
	await flush();
	assert.deepEqual(b.advances, ["cp-4wz", "cp-4wz"], "a re-run on the same head is a new fact");
});

test("jje.2 interleaving: phase, generation and head are re-checked before every step, not once", async () => {
	const b = continuationBench({ records: [heldRecord("cp-p1"), heldRecord("cp-g1"), heldRecord("cp-h1")] });
	for (const job of ["cp-p1", "cp-g1", "cp-h1"]) b.script.set(job, ["advance", "done"]);
	// Each job changes under the continuation while its first step is in flight.
	const change = new Map<string, () => void>([
		["cp-p1", () => void ((b.records[0] as { phase: string }).phase = "waiting")],
		["cp-g1", () => void ((b.records[1] as { supersessions: number }).supersessions = 1)],
		["cp-h1", () => void b.heads.set("cp-h1", NEW_HEAD)],
	]);
	b.during.step = (jobId) => change.get(jobId)?.();
	const outcomes = [];
	for (const job of change.keys()) {
		outcomes.push(await b.continuation.trigger({ jobId: job, event: "ci_green", head: HEAD, generation: 1 }));
	}
	assert.deepEqual(outcomes.map((outcome) => `${outcome.action}:${outcome.steps}`), ["stale:1", "stale:1", "stale:1"]);
	assert.match(outcomes[0]?.reason ?? "", /phase waiting/);
	assert.match(outcomes[1]?.reason ?? "", /generation 1 to 2/);
	assert.match(outcomes[2]?.reason ?? "", /moved from d48a81d1f4d3 to aa11bb22cc33/);
	assert.deepEqual(b.advances, ["cp-p1", "cp-g1", "cp-h1"], "no second step — no merge, review or finish — on a stale trigger");
	assert.equal(b.notices.length, 0);
});

test("jje.2 wait re-arms: the same job|head|event can act again once it settled on wait, but never while it is in flight", async () => {
	const b = continuationBench();
	b.script.set("cp-4wz", ["wait"]);
	const trigger = { jobId: "cp-4wz", event: "ci_green" as const, head: HEAD, generation: 1 };
	const [first, duplicate] = await Promise.all([b.continuation.trigger(trigger), b.continuation.trigger(trigger)]);
	assert.equal(first.action, "wait");
	assert.equal(duplicate.action, "coalesced", "in-flight coalescing is kept");
	b.script.set("cp-4wz", ["advance", "done"]);
	const again = await b.continuation.trigger(trigger);
	assert.equal(again.action, "done", "the watch's repeat of the same fact is actionable once CI or GitHub settled");
	assert.deepEqual(b.advances, ["cp-4wz", "cp-4wz", "cp-4wz"]);
	assert.equal((await b.continuation.trigger(trigger)).action, "coalesced", "a fact that reached a stop is handled for good");
});

test("jje.2 review interleaving: a trigger that went stale during the step never starts a review", async () => {
	const b = continuationBench();
	b.script.set("cp-4wz", ["review"]);
	b.during.step = () => void b.heads.set("cp-4wz", NEW_HEAD);
	const outcome = await b.continuation.trigger({ jobId: "cp-4wz", event: "ci_green", head: HEAD, generation: 1 });
	assert.equal(outcome.action, "stale");
	assert.match(outcome.reason, /moved from d48a81d1f4d3 to aa11bb22cc33/);
	assert.deepEqual(b.reviews, [], "no reviewer spent on a head nobody is shipping");
	assert.equal(b.notices.length, 0);
});

test("jje.2 lagged watcher: a step that read a newer remote head never starts a review for the old trigger", async () => {
	const b = continuationBench();
	b.script.set("cp-4wz", ["review"]);
	// The watcher still holds HEAD (so #stale passes), but the step read NEW_HEAD on the remote.
	b.heads.set("cp-4wz", HEAD);
	b.during.head = NEW_HEAD;
	const outcome = await b.continuation.trigger({ jobId: "cp-4wz", event: "ci_green", head: HEAD, generation: 1 });
	assert.equal(outcome.action, "stale");
	assert.match(outcome.reason, /moved from d48a81d1f4d3 to aa11bb22cc33 on the remote/);
	assert.deepEqual(b.reviews, [], "the new head gets its own CI fact and review, never the old trigger's");
	assert.equal(b.notices.length, 0);
});

test("jje.2 snapshot: a startup trigger carries the head and generation it was observed on, and a later change stops it", async () => {
	const b = continuationBench({ records: [heldRecord("cp-s1"), heldRecord("cp-s2")] });
	b.script.set("cp-s1", ["advance", "done"]);
	b.script.set("cp-s2", ["advance", "done"]);
	// Hold the lane so both startup triggers are observed now and executed later.
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	const gate = b.continuation.serialize("cp-s1", () => held);
	const resumed = b.continuation.resume();
	b.heads.set("cp-s1", NEW_HEAD);
	(b.records[1] as { supersessions: number }).supersessions = 1;
	release();
	await gate;
	const outcomes = await resumed;
	assert.deepEqual(outcomes.map((outcome) => outcome.key), [`cp-s1|${HEAD}|startup@1`, `cp-s2|${HEAD}|startup@1`], "head and generation are its identity");
	assert.deepEqual(outcomes.map((outcome) => outcome.action), ["stale", "stale"]);
	assert.match(outcomes[0]?.reason ?? "", /moved from d48a81d1f4d3 to aa11bb22cc33/);
	assert.match(outcomes[1]?.reason ?? "", /generation 1 to 2/);
	assert.deepEqual(b.advances, [], "nothing observed before the change may act after it");
});

test("jje.2 fail closed: a head-bearing CI or verdict trigger whose owning head cannot be read waits, and acts nowhere", async () => {
	const b = continuationBench({ records: [heldRecord("cp-ci"), heldRecord("cp-vd")] });
	b.script.set("cp-ci", ["advance", "done"]);
	b.script.set("cp-vd", ["advance", "done"]);
	b.heads.set("cp-ci", "");
	b.heads.set("cp-vd", "");
	const ci = await b.continuation.trigger({ jobId: "cp-ci", event: "ci_green", head: HEAD });
	await b.continuation.onVerdict({ jobId: "cp-vd", surface: "review", attempt: 1, headSha: HEAD, content: "", details: { next: "proceed" } });
	assert.equal(ci.action, "wait");
	assert.equal(ci.next, "wait");
	assert.match(ci.reason, /observed head cannot be read/);
	assert.deepEqual(b.advances, [], "no step, no review and no merge on a head nobody confirmed");
	assert.equal(b.notices.length, 0, "a wait is the watch's to re-trigger, not a stop");
	// Readable again: the same fact is re-armed and acts.
	b.heads.delete("cp-ci");
	assert.equal((await b.continuation.trigger({ jobId: "cp-ci", event: "ci_green", head: HEAD })).action, "done");
});
