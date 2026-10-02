/**
 * cp-f9jh: a declared Awaiting-you row does not outlive the job it asks about.
 *
 * The observed shape, twice on 2026-09-04: the operator was asked at 18:52
 * whether to merge PR #111 — merged at 18:45, br cp-gb3w closed — and answered
 * "this is obsolete". Unasked wake-ups are staleness-checked and derived rows
 * clear with their source; declared rows had no such rule.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AwaitingStore, mergeAwaiting, obsoleteDeclaredReason } from "../src/awaiting.ts";
import { resolveAwaitingRows } from "../src/awaiting-rows.ts";
import type { StatusJob } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

function job(overrides: Partial<StatusJob> & { job_id: string }): StatusJob {
	return {
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: "terminal",
		phase: "waiting",
		title: null,
		br_status: null,
		profile: "implementer",
		role: "implementer",
		model: "anthropic/claude-sonnet-5",
		run_phase: null,
		current_tool: null,
		current_tool_seconds: null,
		turns: 0,
		tool_calls: 0,
		alive: true,
		pid: 4321,
		session_id: "sess",
		worktree: "/tmp/demo",
		branch: overrides.job_id,
		timestamp: "2026-09-04T18:00:00Z",
		time_source: "dispatched_at",
		age_seconds: 60,
		last_activity_at: null,
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost_usd: 0 },
		...overrides,
	} as StatusJob;
}

const DECLARED = {
	type: "approval" as const,
	decision: "Ship cp-gb3w, drop it, or open a follow-up?",
	why: "the work is finished",
	blocks: "cp-gb3w close",
	job_id: "cp-gb3w",
};

test("a declared row whose job then merges and closes is no longer open; a live job's row still is", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		await store.declare(DECLARED);
		await store.declare({ ...DECLARED, decision: "Ship cp-live, drop it, or open a follow-up?", job_id: "cp-live", blocks: "cp-live close" });

		const live = [job({ job_id: "cp-gb3w" }), job({ job_id: "cp-live" })];
		assert.deepEqual(
			mergeAwaiting({ checkpoints: [], heldResearch: [], declared: store.list(), jobs: live }).map((row) => row.job_id),
			["cp-gb3w", "cp-live"],
			"while both jobs are live, both decisions are offered",
		);

		const after = [
			job({
				job_id: "cp-gb3w",
				phase: "done",
				br_status: "closed",
				receipts: [{ kind: "pr", status: "merged", title: "PR #111", url: "https://github.com/x/y/pull/111" }],
			}),
			job({ job_id: "cp-live" }),
		];
		const rows = mergeAwaiting({ checkpoints: [], heldResearch: [], declared: store.list(), jobs: after });
		assert.deepEqual(rows.map((row) => row.job_id), ["cp-live"], "the merged, closed job's row is not offered");

		// Nothing was deleted and nothing was withdrawn: obsolete-on-read.
		assert.equal(store.list("open").length, 2, "both rows are still on disk, unchanged");
	} finally {
		home.cleanup();
	}
});

test("a row with no job_id, and a row whose job the fleet has no record of, are untouched", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		await store.declare({ type: "design", decision: "postgres or sqlite?", why: "schema choice", blocks: "the data layer" });
		await store.declare({ ...DECLARED, job_id: "cp-unknown", decision: "Ship cp-unknown, drop it, or open a follow-up?" });

		const rows = mergeAwaiting({
			checkpoints: [],
			heldResearch: [],
			declared: store.list(),
			jobs: [job({ job_id: "cp-other", phase: "done" })],
		});
		assert.equal(rows.length, 2, "no job_id and no fleet record are both ignorance, never evidence");
		assert.equal(obsoleteDeclaredReason({}, [job({ job_id: "cp-x", phase: "done" })]), undefined);
	} finally {
		home.cleanup();
	}
});

test("an answer already recorded is untouched when the job is done", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = await store.declare(DECLARED);
		await store.answer(item.id, { answer: "ship", by: "operator" });

		const done = [job({ job_id: "cp-gb3w", phase: "done", br_status: "closed" })];
		assert.deepEqual(mergeAwaiting({ checkpoints: [], heldResearch: [], declared: store.list(), jobs: done }), []);
		const stored = store.get(item.id)!;
		assert.equal(stored.state, "answered");
		assert.equal(stored.answer, "ship");
		assert.equal(stored.answered_by, "operator");
	} finally {
		home.cleanup();
	}
});

test("the status block refuses an obsolete row instead of rendering it as open, and says why", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const supplied = [{ type: "approval" as const, decision: DECLARED.decision, why: DECLARED.why, blocks: DECLARED.blocks, job_id: "cp-gb3w" }];
		const resolved = await resolveAwaitingRows(supplied, store, [job({ job_id: "cp-gb3w", phase: "done", br_status: "closed" })]);
		assert.deepEqual(resolved.rendered, [], "not rendered as an open question");
		assert.equal(resolved.refused.length, 1);
		assert.match(resolved.refused[0]!.reason, /obsolete/);
		assert.equal(store.list().length, 0, "no row is minted for a decision the world has taken");

		const stillLive = await resolveAwaitingRows(supplied, store, [job({ job_id: "cp-gb3w" })]);
		assert.equal(stillLive.rendered.length, 1, "a live job's row is stored and rendered as before");
	} finally {
		home.cleanup();
	}
});
