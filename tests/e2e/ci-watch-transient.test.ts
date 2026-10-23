/** #420: one slow or empty Actions jobs read must not fail the CI watch tick; the retry fits the original budget. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { run, SKIP, startStack } from "./landing-helpers.ts";

const cases = [
	// Hangs past the per-call slot (killed at 6 s); the old code gave it the whole 15 s budget and failed the tick.
	["a jobs read that exceeds its slot", { untilFile: "/nonexistent/never" }, 411],
	["an empty 200 jobs read", { stdout: "" }, 412],
] as const;

for (const [title, first, number] of cases) {
	test(`ci watch tick: ${title}, then valid, succeeds without a failure`, { skip: SKIP, timeout: 120_000 }, async (t) => {
		const s = await startStack(t);
		const live = await s.held(title, number);
		s.setGh({ runs: [run(number, live.head, "completed", "success")], routes: [{ match: "/attempts/", replies: [first, { pass: true }] }] });
		const tick = await s.post.ciTick();
		assert.deepEqual(tick.errors, []);
		assert.equal(tick.observations[0]?.event, "ci_green");
	});
}
