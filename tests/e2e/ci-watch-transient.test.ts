/** #420: one slow or empty Actions jobs read must not fail the CI watch tick; the retry fits the original budget. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test } from "node:test";
import { ACTIONS_CI_TIMEOUT_MS } from "../../src/actions-ci.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, paths } from "../../src/contracts.ts";
import { initialStatus } from "../../src/run-artifacts.ts";
import { StatusError } from "../../src/status.ts";
import { run, SKIP, startStack } from "./landing-helpers.ts";

const hang = { untilFile: "/nonexistent/never" };
const cases = [
	// Hangs past the per-call slot (killed at 12 s); the old code gave it the whole 30 s budget and failed the tick.
	["a jobs read that exceeds its slot", [hang, { pass: true }], 411],
	// Three empty 200s outlast get()'s own backoff, so only retryTransientRead's second read can recover the tick.
	["empty 200 jobs reads that outlast the in-read backoff", [{ stdout: "" }, { stdout: "" }, { stdout: "" }, { pass: true }], 412],
] as const;

for (const [title, replies, number] of cases) {
	test(`ci watch tick: ${title}, then valid, succeeds without a failure`, { skip: SKIP, timeout: 120_000 }, async (t) => {
		const s = await startStack(t);
		const live = await s.held(title, number);
		s.setGh({ runs: [run(number, live.head, "completed", "success")], routes: [{ match: "/attempts/", replies: [...replies] }] });
		const tick = await s.post.ciTick();
		assert.deepEqual(tick.errors, []);
		assert.equal(tick.observations[0]?.event, "ci_green");
	});
}

// Two 12 s hangs plus backoff spend ~25 of 30 s, then a transient read; the retry gets the ~5 s left, not a fresh 30 s.
test("ci watch tick: the transient retry never extends past the original deadline", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("retry within deadline", 413);
	const replies = [hang, hang, { stdout: "" }, hang];
	s.setGh({ runs: [run(413, live.head, "completed", "success")], routes: [{ match: "/attempts/", replies }] });
	const started = Date.now();
	const tick = await s.post.ciTick();
	assert.ok(Date.now() - started < 40_000, `tick took ${Date.now() - started} ms`);
	assert.equal(tick.errors.length, 1);
});

/** Generous absolute ceiling on one loop stall; the cache's win is asserted as a ratio, so load cannot flake it. */
const LAG_BOUND_MS = 10_000;

// #561: every read re-ran the schema check. With 3,000 finished jobs the tick fits its budget and
// repeat reads (cache hits) beat the first read after a write.
test("ci watch tick: a 3,000-job home keeps the tick inside its budget and the event loop responsive", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("large home", 414);
	const now = isoTimestamp();
	const done = Array.from({ length: 3_000 }, (_, i): FleetRecord => {
		const id = `cp-done-${i}`;
		mkdirSync(join(s.home, paths.runDir(id)), { recursive: true });
		writeFileSync(join(s.home, paths.statusFile(id)), JSON.stringify(initialStatus(id, {}, now)));
		return {
			job_id: id, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "done", dispatched_at: now, reported_at: now, closed_at: now,
			closed_reason: "gated", usage: EMPTY_USAGE, worktree: join(s.home, "gone", id), branch: id,
			worker: { pid: 1, session_id: "s", session_file: join(s.home, `${id}.jsonl`), profile: "implementer", role: "implementer", model: "mock/model", started_at: now, exited_at: now, exit_code: 0 },
			receipts: [{ kind: "pr", status: "merged", title: `PR ${i}`, url: `https://github.com/example/demo/pull/${1_000 + i}` }],
		};
	});
	await s.post.fleet.mutate((jobs) => void jobs.push(...done));
	s.setGh({ runs: [run(414, live.head, "completed", "success")] });
	await s.post.fleet.mutate(() => undefined); // a fleet write: the next read is the first one after it
	const widgetRead = () => {
		const at = performance.now();
		s.post.statusNow();
		s.post.awaitingSnapshotSync();
		return Math.round(performance.now() - at);
	};
	const first = widgetRead();
	const lag = monitorEventLoopDelay({ resolution: 10 });
	lag.enable();
	const started = performance.now();
	const pending = s.post.ciTick();
	const reads: number[] = [];
	for (let i = 0; i < 3; i++) {
		reads.push(widgetRead());
		await new Promise((resolve) => setImmediate(resolve));
	}
	const tick = await pending;
	const took = Math.round(performance.now() - started);
	lag.disable();
	const worst = Math.round(lag.max / 1e6);
	console.log(`3,000-job home: tick ${took} ms, first read ${first} ms, cached reads ${reads.join("/")} ms, loop lag max ${worst} ms`);
	assert.deepEqual(tick.errors, []);
	assert.equal(tick.observations[0]?.event, "ci_green");
	assert.ok(took < ACTIONS_CI_TIMEOUT_MS, `tick took ${took} ms`);
	assert.ok(first < LAG_BOUND_MS, `first read after a write took ${first} ms`);
	assert.ok(Math.max(...reads) * 2 < first, `cached reads ${reads.join("/")} ms vs first ${first} ms`);
	assert.ok(worst < LAG_BOUND_MS, `event-loop lag reached ${worst} ms`);
});

// #580 regression: skipping the snapshot self-check outright returned an invalid snapshot raw instead of StatusError.
test("status: an invalid snapshot throws StatusError on every read, never served from cache", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	await s.held("status validation", 415);
	const bad = { include: "bogus" } as never;
	assert.ok(s.post.statusNow().jobs.length > 0); // a valid read first, so the cache is warm
	for (let i = 0; i < 2; i++) {
		assert.throws(() => s.post.statusNow(bad), StatusError);
		await assert.rejects(s.post.status({ include: "bogus", titles: false } as never), StatusError);
	}
});
