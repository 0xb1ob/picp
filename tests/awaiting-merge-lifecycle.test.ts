/** awaiting_merge PR6: a human_handoff parks the job, the viewer keeps its CI, and the batched watch ends the cycle. */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Parking } from "../src/awaiting-merge.ts";
import { AwaitingMergeWatch } from "../src/awaiting-merge-watch.ts";
import { recordCiObserved } from "../src/ci-evidence.ts";
import { CiWatch, isWatched, type WatchableRecord } from "../src/ci-watch.ts";
import { EMPTY_USAGE, LAYOUT, type FleetRecord } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { makeHandoff } from "../src/human-handoff.ts";
import type { IntegrateResult } from "../src/integrate.ts";
import { MergeStore } from "../src/merges.ts";
import { RunRegistry } from "../src/runs.ts";
import { StackFollowups } from "../src/stack-followups.ts";
import { overview } from "../src/viewer/overview-view.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
import { createScratchHome } from "./harness/index.ts";

const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);
const PR = "https://github.com/o/r/pull/7";
const NOW = new Date("2026-10-15T10:30:00Z");
const WORKTREE = "/wt/cp-park";

const held: FleetRecord = {
	job_id: "cp-park", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "held",
	worker: { pid: 4242, session_id: "s", session_file: "/nonexistent/s.jsonl", profile: "implementer", role: "implementer", model: "m/m", started_at: "2026-10-15T09:00:00Z" },
	worktree: WORKTREE, branch: "cp-park", dispatched_at: "2026-10-15T09:00:00Z", reported_at: "2026-10-15T10:00:00Z",
	usage: EMPTY_USAGE, lease_id: "lease-1", receipts: [{ kind: "pr", status: "open", title: "PR", url: PR }],
};

/** A held job whose green head the CI watch observed, handed off through the real port and Parking. */
async function parkedBench(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(held);
	await new CiWatch({
		home: home.path, now: () => NOW, intervalMs: 60_000,
		jobs: () => fleet.list() as WatchableRecord[],
		pr: async () => ({ merged: false, state: "open", number: 7, url: PR, head_sha: HEAD, head_ref: "cp-park" }),
		runs: async () => [{ status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci" }],
		onObserved: (jobId, observation) => recordCiObserved(runs, jobId, observation),
	}).tick();
	let live = true;
	const touched: string[] = [];
	const parking = new Parking({
		home: home.path, fleet, runs, now: () => NOW,
		manager: { get: () => (live ? ({ worker: { alive: true } } as never) : undefined), shutdown: async () => void (live = false) },
		leases: { release: async (lease) => (touched.push(`release ${lease.path}`), { ok: true }) },
		gates: async (record) => (touched.push(`gates ${record.worktree}`), { ok: true, reason: "pushed" }),
		git: async (cwd, args) => (touched.push(`git ${cwd}`), { status: 0, stdout: args[0] === "rev-parse" ? `${HEAD}\n` : "", stderr: "" }),
	});
	const port = makeHandoff({ registry: { get: () => ({ merge_policy: "human_handoff" }) }, awaiting: () => assert.fail("a park needs no row"), runs, park: (id, facts) => parking.park(id, facts), now: () => NOW });
	const result = await port({
		jobId: "cp-park", branch: "cp-park", facts: [], prUrl: PR, head: HEAD, project: "demo", base: "main", at: "permit",
		verdict: { permission: "pending", cause: "reviews", reason: "REVIEW_REQUIRED", facts: [] },
		write: (w) => ({ job_id: w.jobId, next: w.next, reason: w.reason }) as unknown as IntegrateResult,
	});
	return { home: home.path, fleet, runs, result, touched };
}

function watchOf(b: Awaited<ReturnType<typeof parkedBench>>, pullRequest: Record<string, unknown>) {
	const wakes: DurableWakeupInput[] = [];
	const closed: string[] = [];
	let landed = 0;
	const stacks = new StackFollowups({ home: b.home });
	const watch = new AwaitingMergeWatch({
		home: b.home, fleet: b.fleet, stacks, stackEdges: stacks, runs: b.runs, cpLogins: ["cp-bot"], now: () => new Date("2026-10-15T12:00:00Z"),
		merges: new MergeStore({ home: b.home, fleet: b.fleet, run: async () => assert.fail("the watch runs no git or gh per job") }),
		ledger: () => ({ close: async (id: string, reason: string) => closed.push(`${id} ${reason}`) }),
		wakeups: { enqueue: (input) => (wakes.push(input), true) },
		onLanded: async () => void (landed += 1),
		runner: async () => ({ data: { p0: { pullRequest: {
			url: PR, number: 7, headRefOid: HEAD, headRefName: "cp-park", baseRefName: "main", mergedAt: null, mergeCommit: null,
			latestOpinionatedReviews: { nodes: [] }, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
			reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, ...pullRequest,
		} } } }),
	});
	return { watch, wakes, closed, landed: () => landed };
}

test("acceptance: the watch's green CI for the head is shown With the team after a human_handoff parks the job", async (t) => {
	const b = await parkedBench(t);
	assert.equal(b.result?.next, "wait", b.result?.reason);
	const parked = b.fleet.require("cp-park");
	assert.equal(parked.phase, "awaiting_merge");
	assert.equal(isWatched(parked as WatchableRecord), false, "the per-job watch drops a parked job");
	// The ci-watch row would answer by itself; deleting it proves the view falls back to the ci_observed event.
	rmSync(join(b.home, LAYOUT.ciWatchFile));
	const view = overview({ home: b.home, stateDir: join(b.home, LAYOUT.state) }, NOW.getTime());
	assert.deepEqual(view.with_team.map((job) => [job.id, job.head, job.ci, job.ci_forwarded]), [["cp-park", HEAD, "green", null]]);
	assert.deepEqual(view.in_flight, []);
});

test("lifecycle: a team change request marks the parked job pending, a merge closes it; the released worktree is never touched", async (t) => {
	const b = await parkedBench(t);
	const afterPark = b.touched.length;
	assert.ok(b.touched.includes(`release ${WORKTREE}`));
	const author = { login: "ann", __typename: "User" };
	const review = { reviews: { pageInfo: { hasNextPage: false, endCursor: "R1" }, nodes: [{ id: "PRR_1", state: "CHANGES_REQUESTED", body: "", createdAt: "2026-10-15T11:00:00Z", author, comments: { totalCount: 0 } }] } };
	const changes = watchOf(b, { state: "OPEN", ...review });
	assert.deepEqual((await changes.watch.sweep()).outcomes.map((outcome) => outcome.applied), ["changes_requested"]);
	assert.equal(b.fleet.require("cp-park").awaiting_merge?.pending?.kind, "changes_requested");
	assert.equal(changes.wakes.length, 1, "one wake for the cycle's pending event");

	const merged = watchOf(b, { state: "MERGED", mergedAt: "2026-10-15T11:59:00Z", mergeCommit: { oid: MERGE } });
	assert.deepEqual((await merged.watch.sweep()).outcomes.map((outcome) => outcome.applied), ["merged"]);
	assert.equal(b.fleet.require("cp-park").phase, "done");
	assert.deepEqual([merged.closed, merged.landed()], [[`cp-park merged: ${PR}`], 1]);
	assert.equal(b.touched.length, afterPark, "no gate, git or lease call after the release");
});
