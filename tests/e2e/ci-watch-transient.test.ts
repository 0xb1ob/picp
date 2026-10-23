/** #420: one slow or empty Actions jobs read must not fail the CI watch tick; the retry fits the original budget. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { run, SKIP, startStack } from "./landing-helpers.ts";

const hang = { untilFile: "/nonexistent/never" };
const cases = [
	// Hangs past the per-call slot (killed at 6 s); the old code gave it the whole 15 s budget and failed the tick.
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

// Two 6 s hangs plus backoff spend ~13 of 15 s, then a transient read; the retry gets the ~2 s left, not a fresh 15 s.
test("ci watch tick: the transient retry never extends past the original deadline", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("retry within deadline", 413);
	const replies = [hang, hang, { stdout: "" }, hang];
	s.setGh({ runs: [run(413, live.head, "completed", "success")], routes: [{ match: "/attempts/", replies }] });
	const started = Date.now();
	const tick = await s.post.ciTick();
	assert.ok(Date.now() - started < 20_000, `tick took ${Date.now() - started} ms`);
	assert.equal(tick.errors.length, 1);
});
