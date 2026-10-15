/** awaiting_merge PR4 of Actions-only CI: the parked sweep's native CI observer (src/parked-ci.ts). Hermetic. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrSnapshot } from "../src/awaiting-merge-exits.ts";
import { CiWatchStore } from "../src/ci-watch.ts";
import { EMPTY_USAGE, type FleetRecord } from "../src/contracts.ts";
import type { CiRun } from "../src/merge-ask.ts";
import { parkedCiObserver } from "../src/parked-ci.ts";
import { createScratchHome } from "./harness/index.ts";

const HANDED = "2026-10-15T10:00:00Z";
const A = "a".repeat(40);
const B = "b".repeat(40);
const CADENCE = { intervalMs: 60_000, idleMultiplier: 5, maxBackoffMs: 900_000 };

function parked(cycle = 1): FleetRecord {
	return {
		job_id: "cp-park", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "awaiting_merge",
		worker: { pid: 4242, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m/m", started_at: HANDED, exited_at: HANDED, exit_code: 0 },
		worktree: "/wt/old", branch: "cp-park", dispatched_at: HANDED, reported_at: HANDED, usage: EMPTY_USAGE,
		awaiting_merge: { cycle, pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-park", head_sha: A, base: "main",
			handed_at: HANDED, released_at: HANDED, frozen_seconds: 60, frozen_usage: EMPTY_USAGE },
	};
}

const snap = (head = A, state: PrSnapshot["state"] = "open"): PrSnapshot =>
	({ url: "https://github.com/o/r/pull/7", number: 7, state, head_sha: head, base: "main", events: [] });
const run = (head: string, conclusion: string | null, status = "completed"): CiRun => ({ status, conclusion, headSha: head, databaseId: 11, attempt: 1, workflowName: "ci" });

function bench(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	let clock = new Date("2026-10-15T12:00:00Z");
	let record: FleetRecord | undefined = parked();
	const state: { runs?: readonly CiRun[]; error?: string; during?: () => void } = {};
	const reads: string[] = [];
	const journal: { type: string; payload: Record<string, unknown> }[] = [];
	const observe = parkedCiObserver({
		home: home.path, cadence: CADENCE, now: () => clock,
		fleet: { get: () => record },
		runs: { open: () => ({ cp: (type: string, payload: Record<string, unknown>) => journal.push({ type, payload }) }) as never },
		read: async (_record, head) => {
			reads.push(head);
			state.during?.();
			if (state.error) throw new Error(state.error);
			return state.runs ?? [];
		},
	});
	const row = () => new CiWatchStore({ home: home.path }).job("cp-park");
	return {
		observe, state, reads, journal, row,
		setRecord: (next: FleetRecord | undefined) => { record = next; },
		advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
	};
}

test("parked CI: head A green, then the moved head B pending, then red — each stored for its own head, journaled once", async (t) => {
	const b = bench(t);
	b.state.runs = [run(A, "success")];
	await b.observe(parked(), snap(A));
	assert.deepEqual([b.row()?.head_sha, b.row()?.last_ci], [A, "green"]);
	await b.observe(parked(), snap(A));
	assert.deepEqual(b.reads, [A], "a settled head is not re-read before the idle interval");
	b.state.runs = [run(B, null, "in_progress")];
	await b.observe(parked(), snap(B));
	assert.deepEqual([b.row()?.head_sha, b.row()?.last_ci], [B, "in_progress"], "a moved head never inherits A's green");
	b.advance(CADENCE.intervalMs);
	b.state.runs = [run(B, "failure")];
	await b.observe(parked(), snap(B));
	assert.equal(b.row()?.last_ci, "failed");
	assert.deepEqual(b.journal.map((entry) => [entry.type, entry.payload.event, entry.payload.head_sha]), [["ci_observed", "ci_green", A], ["ci_observed", "ci_failed", B]]);
	assert.deepEqual(b.reads, [A, B, B]);
});

test("parked CI: a permission denial is loud even after a green; a transient fault is unknown; both back off", async (t) => {
	const b = bench(t);
	b.state.runs = [run(A, "success")];
	await b.observe(parked(), snap(A));
	b.advance(CADENCE.intervalMs * CADENCE.idleMultiplier);
	b.state.error = "Actions CI read denied: gh api repos/o/r/actions/runs?head_sha=… (HTTP 403)";
	await b.observe(parked(), snap(A));
	assert.deepEqual([b.row()?.last_ci, b.row()?.consecutive_failures], ["unreadable", 1]);
	b.state.error = "Actions CI read transport: gh api repos/o/r/actions/runs";
	await b.observe(parked(), snap(B));
	assert.deepEqual([b.row()?.head_sha, b.row()?.last_ci, b.row()?.consecutive_failures], [B, "unknown", 2], "the observed head is stored before the fault");
	await b.observe(parked(), snap(B));
	assert.equal(b.reads.length, 3, "a failing head backs off instead of re-reading every sweep");
	assert.equal(b.journal.length, 1, "a fault journals nothing");
});

test("parked CI: a resume or re-park during the read drops the observation; merged/closed or a held job reads nothing", async (t) => {
	const b = bench(t);
	b.state.runs = [run(A, "success")];
	b.state.during = () => b.setRecord(parked(2));
	await b.observe(parked(), snap(A));
	b.state.during = () => b.setRecord({ ...parked(), phase: "waiting" });
	await b.observe(parked(), snap(A));
	assert.equal(b.row(), undefined);
	assert.equal(b.journal.length, 0);
	delete b.state.during;
	await b.observe(parked(), snap(A, "merged"));
	await b.observe(parked(), snap(A, "closed"));
	await b.observe({ ...parked(), phase: "held" }, snap(A));
	assert.equal(b.reads.length, 2, "only the two dropped reads ran");
});
