/**
 * `FailureAnnouncer` (pi-command-post-autonomy-programme-cur.4.4): a bound
 * wake-up id needs an occurrence component exactly like a death id already
 * has, or a second breach of the same (job, class) is suppressed as a
 * duplicate of the first and the parent is never woken for it again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, type Failure, type FleetRecord } from "../src/contracts.ts";
import { FailureAnnouncer } from "../src/failure-announcer.ts";
import { FleetStore } from "../src/fleet.ts";
import { DurableWakeupOutbox } from "../src/wakeup-outbox.ts";
import { createScratchHome } from "./harness/index.ts";

const JOB_ID = "cp-bound-repeat";

function record(home: string): FleetRecord {
	return {
		job_id: JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: `${home}/s.jsonl`,
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: `${home}/wt-does-not-exist`,
		branch: JOB_ID,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
}

test("two breaches of the same (job, class) bound produce two distinct wake-up ids, both pending", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record(home.path));
	const outbox = new DurableWakeupOutbox({ home: home.path });
	const announcer = new FailureAnnouncer({
		fleet,
		journal: (input) => outbox.enqueue(input),
	});

	const first: Failure = { class: "wall_clock_exceeded", message: "wall_clock bound exceeded", at: "2026-09-22T10:00:00Z" };
	await announcer.fail(JOB_ID, first);
	// A successful automatic redispatch happens between the two breaches in
	// practice; what matters here is only that `fail()` runs twice for the
	// same (job, class) with a distinct occurrence.
	const second: Failure = { class: "wall_clock_exceeded", message: "wall_clock bound exceeded", at: "2026-09-22T11:00:00Z" };
	await announcer.fail(JOB_ID, second);

	const pending = outbox.pending();
	assert.equal(pending.length, 2, "two breaches, two parent wake-ups — not one suppressed as a duplicate");
	assert.notEqual(pending[0]?.id, pending[1]?.id, "distinct occurrence, distinct id");
	assert.ok(pending.every((entry) => entry.kind === "bound"));
});

test("the SAME occurrence enqueued twice is still suppressed (unchanged behaviour)", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record(home.path));
	const outbox = new DurableWakeupOutbox({ home: home.path });
	const announcer = new FailureAnnouncer({
		fleet,
		journal: (input) => outbox.enqueue(input),
	});

	const failure: Failure = { class: "wall_clock_exceeded", message: "wall_clock bound exceeded", at: "2026-09-22T10:00:00Z" };
	await announcer.fail(JOB_ID, failure);
	await announcer.fail(JOB_ID, failure);

	assert.equal(outbox.pending().length, 1, "one occurrence, one wake-up, no matter how many times it is announced");
});
