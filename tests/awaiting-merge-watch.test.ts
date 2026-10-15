/** awaiting_merge PR3: exit precedence, the apply executor, the batched watch, stack follow-ups and wake staleness. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyExit, decideExit, type ExitPorts, type PrSnapshot } from "../src/awaiting-merge-exits.ts";
import { awaitingMergePorts } from "../src/awaiting-merge.ts";
import { AwaitingMergeWatch, batchQuery, readWatchFile } from "../src/awaiting-merge-watch.ts";
import { EMPTY_USAGE, type FleetRecord } from "../src/contracts.ts";
import { drainFile } from "../src/drain.ts";
import { FleetStore } from "../src/fleet.ts";
import { atomicWriteJson } from "../src/json-store.ts";
import { AwaitingStore } from "../src/awaiting.ts";
import { Integrator } from "../src/integrate.ts";
import { MergeStore } from "../src/merges.ts";
import { cpNext } from "../src/next.ts";
import { pendingStackActions, readStackFollowups, StackFollowups } from "../src/stack-followups.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
import { checkWakeup } from "../src/wakeups.ts";
import { createScratchHome } from "./harness/index.ts";

const HANDED = "2026-10-15T10:00:00Z";
const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);

function parked(id = "cp-park", branch = id, base = "main", number = 7): FleetRecord {
	return {
		job_id: id, project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "awaiting_merge",
		worker: { pid: 4242, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m/m", started_at: HANDED, exited_at: HANDED, exit_code: 0 },
		worktree: "/wt/old", branch, dispatched_at: HANDED, reported_at: HANDED, usage: EMPTY_USAGE,
		awaiting_merge: { cycle: 1, pr_url: `https://github.com/o/r/pull/${number}`, repo: "o/r", branch, head_sha: HEAD, base,
			handed_at: HANDED, released_at: HANDED, frozen_seconds: 60, frozen_usage: EMPTY_USAGE },
	};
}

function snap(over: Partial<PrSnapshot> = {}): PrSnapshot {
	return { url: "https://github.com/o/r/pull/7", number: 7, state: "open", head_sha: HEAD, base: "main", head_branch: "cp-park", events: [], ...over };
}

async function bench(t: { after(fn: () => void): void }, records: FleetRecord[] = [parked()]) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	for (const record of records) await fleet.add(record);
	const wakes: DurableWakeupInput[] = [];
	const closed: string[] = [];
	let landed = 0;
	const stacks = new StackFollowups({ home: home.path });
	const ports: ExitPorts = {
		fleet, stacks,
		merges: new MergeStore({ home: home.path, fleet, run: async () => { throw new Error("no git or gh may run"); } }),
		ledger: () => ({ close: async (id: string, reason: string) => closed.push(`${id} ${reason}`) }),
		wakeups: { enqueue: (input) => (wakes.push(input), true) },
		onLanded: async () => { landed += 1; },
		now: () => new Date("2026-10-15T12:00:00Z"),
	};
	return { home: home.path, fleet, stacks, ports, wakes, closed, landed: () => landed };
}

test("decideExit: precedence, and a lower-priority event never clobbers a pending one (a close does)", () => {
	const now = new Date("2026-10-15T12:00:00Z");
	const record = parked().awaiting_merge!;
	const busy = snap({ head_sha: "b".repeat(40), base: "dev", events: [
		{ kind: "human_comment", id: "IC_1", at: "2026-10-15T11:00:00Z" }, { kind: "changes_requested", id: "PRR_1", at: "2026-10-15T11:30:00Z" },
	] });
	assert.equal(decideExit(record, { ...busy, state: "merged" }, now).kind, "merged");
	const head = decideExit(record, busy, now);
	assert.equal(head.kind === "pending" && head.pending.kind, "head_moved");
	assert.equal(head.kind === "pending" && head.last_human_activity_at, "2026-10-15T11:30:00Z");
	const pending = { kind: "human_comment" as const, event_id: "IC_0", observed_at: HANDED };
	assert.equal(decideExit({ ...record, pending }, snap({ base: "dev" }), now).kind, "none");
	const closed = decideExit({ ...record, pending }, snap({ state: "closed" }), now);
	assert.equal(closed.kind === "pending" && closed.pending.kind, "closed_unmerged");
	assert.equal(decideExit(record, snap({ base: "dev" }), now).kind === "pending", true);
});

test("applyExit pending: marks the parked record once, one stale-able wake, no spawn or lease", async (t) => {
	const b = await bench(t);
	const event = snap({ events: [{ kind: "changes_requested", id: "PRR_9", at: "2026-10-15T11:00:00Z" }] });
	assert.equal((await applyExit(b.ports, "cp-park", 1, event)).applied, "changes_requested");
	assert.equal((await applyExit(b.ports, "cp-park", 1, event)).applied, "none");
	const record = b.fleet.require("cp-park");
	assert.equal(record.phase, "awaiting_merge");
	assert.equal(record.awaiting_merge?.pending?.event_id, "PRR_9");
	assert.deepEqual(b.wakes.map((wake) => [wake.id, wake.keys]), [["awaiting-merge:pending:cp-park:1:PRR_9", ["parked-cycle:1"]]]);
	assert.equal((await applyExit(b.ports, "cp-park", 2, event)).applied, "skipped", "a stale cycle is never applied");
});

test("applyExit merged: receipt, ledger close, stack action, done, dependents released, one wake — idempotent", async (t) => {
	const b = await bench(t, [parked(), parked("cp-child", "cp-child", "cp-park", 8)]);
	b.stacks.recordEdges([{ job_id: "cp-park", repo: "o/r", branch: "cp-park", base: "main" }, { job_id: "cp-child", repo: "o/r", branch: "cp-child", base: "cp-park" }]);
	const merged = snap({ state: "merged", merge_sha: MERGE, merged_at: "2026-10-15T11:59:00Z" });
	const outcome = await applyExit(b.ports, "cp-park", 1, merged);
	assert.deepEqual(outcome, { job_id: "cp-park", applied: "merged", stack_actions: 1 });
	assert.equal(b.fleet.require("cp-park").phase, "done");
	assert.deepEqual(b.closed, ["cp-park merged: https://github.com/o/r/pull/7"]);
	assert.equal(b.landed(), 1);
	assert.deepEqual(pendingStackActions(b.home).map((action) => [action.child_job, action.previous_base, action.target_base]), [["cp-child", "cp-park", "main"]]);
	assert.equal(b.wakes.length, 1);
	assert.equal(b.wakes[0]!.keys, undefined, "a merged wake is always fresh");
	assert.equal((await applyExit(b.ports, "cp-park", 1, merged)).applied, "skipped");
	assert.equal(pendingStackActions(b.home).length, 1);
	new StackFollowups({ home: b.home }).settle(`cp-park:cp-child:${MERGE}`, "done");
	assert.equal(pendingStackActions(b.home).length, 0);
});

test("applyExit: another claim holder skips the job instead of waiting", async (t) => {
	const b = await bench(t);
	const claims = new Map([["cp-park", "resume" as const]]);
	const outcome = await applyExit({ ...b.ports, claims }, "cp-park", 1, snap({ state: "closed" }));
	assert.equal(outcome.applied, "skipped");
	assert.equal(b.fleet.require("cp-park").awaiting_merge?.pending, undefined);
});

function rawPr(over: Record<string, unknown> = {}) {
	const page = (nodes: unknown[], endCursor: string | null, hasNextPage = false) => ({ pageInfo: { hasNextPage, endCursor }, nodes });
	return {
		url: "https://github.com/o/r/pull/7", number: 7, state: "OPEN", headRefOid: HEAD, headRefName: "cp-park", baseRefName: "main",
		mergedAt: null, mergeCommit: null,
		latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "ann", __typename: "User" } }] },
		comments: page([
			{ id: "IC_old", createdAt: "2026-10-15T09:00:00Z", author: { login: "ann", __typename: "User" } },
			{ id: "IC_bot", createdAt: "2026-10-15T11:00:00Z", author: { login: "ci", __typename: "Bot" } },
			{ id: "IC_cp", createdAt: "2026-10-15T11:00:00Z", author: { login: "cp-bot", __typename: "User" } },
		], "C1", true),
		reviews: page([], null),
		...over,
	};
}

test("watch sweep: batches, filters bots/CP/pre-handoff, keeps a failed PR's last observation, advances cursors", async (t) => {
	const b = await bench(t, [parked(), parked("cp-two", "cp-two", "main", 9)]);
	const queries: string[] = [];
	const answers = [
		{ data: { rateLimit: { remaining: 4000, resetAt: "2026-10-15T13:00:00Z" }, p0: { pullRequest: rawPr() } } },
		{ data: { rateLimit: { remaining: 4000 }, p0: null }, errors: [{ message: "Could not resolve to a PullRequest", path: ["p0"] }] },
	];
	const watch = new AwaitingMergeWatch({ ...b.ports, home: b.home, cpLogins: ["cp-bot"], batchSize: 1, runner: async (query) => (queries.push(query), answers.shift()) });
	const result = await watch.sweep();
	assert.equal(queries.length, 2);
	assert.deepEqual(result.outcomes.map((outcome) => outcome.applied), ["none"]);
	assert.deepEqual(result.catching_up, ["cp-park"]);
	assert.match(result.errors[0]!, /cp-two: Could not resolve/);
	const file = readWatchFile(b.home);
	assert.deepEqual(file.prs.map((pr) => [pr.job_id, pr.cursors.comments, pr.approvals, pr.approvals_required]), [["cp-park", "C1", 1, null]]);
	assert.match(batchQuery([{ owner: "o", name: "r", number: 7, prior: file.prs[0] }]), /comments\(first: 50, after: "C1"\)/);
});

test("watch sweep: a failing apply keeps the cursor, a runner failure and a low rate limit back off", async (t) => {
	const b = await bench(t);
	const human = rawPr({ comments: { pageInfo: { hasNextPage: false, endCursor: "C2" }, nodes: [{ id: "IC_h", createdAt: "2026-10-15T11:00:00Z", author: { login: "ann", __typename: "User" } }] } });
	let now = new Date("2026-10-15T12:00:00Z");
	const ports = { ...b.ports, now: () => now, fleet: Object.assign(Object.create(b.fleet), { mutate: async () => { throw new Error("disk full"); } }) };
	let answer: unknown = { data: { p0: { pullRequest: human } } };
	const watch = new AwaitingMergeWatch({ ...ports, home: b.home, runner: async () => { if (answer instanceof Error) throw answer; return answer; } });
	const failed = await watch.sweep();
	assert.match(failed.errors[0]!, /disk full; cursors kept/);
	assert.equal(readWatchFile(b.home).prs.length, 0);
	answer = new Error("gh: network down");
	const down = await watch.sweep();
	assert.equal(down.backoff_until, "2026-10-15T12:01:00Z");
	assert.match((await watch.sweep()).skipped ?? "", /backing off/);
	now = new Date("2026-10-15T12:02:00Z");
	answer = { data: { rateLimit: { remaining: 10, resetAt: "2026-10-15T13:00:00Z" }, p0: { pullRequest: rawPr() } } };
	const limited = await watch.sweep();
	assert.equal(limited.backoff_until, "2026-10-15T13:00:00Z");
});

test("watch sweep: overlapping calls run one sweep", async (t) => {
	const b = await bench(t);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const watch = new AwaitingMergeWatch({ ...b.ports, home: b.home, runner: async () => { await gate; return { data: { p0: { pullRequest: rawPr() } } }; } });
	const first = watch.sweep();
	assert.equal((await watch.sweep()).skipped, "a sweep is already running");
	release();
	assert.equal((await first).observed, 1);
});

test("watch sweep: a skipped apply keeps the prior cursors, so that page is re-read", async (t) => {
	const b = await bench(t);
	const claims = new Map([["cp-park", "resume" as const]]);
	const watch = new AwaitingMergeWatch({ ...b.ports, claims, home: b.home, runner: async () => ({ data: { p0: { pullRequest: rawPr() } } }) });
	const result = await watch.sweep();
	assert.deepEqual(result.outcomes.map((outcome) => outcome.applied), ["skipped"]);
	assert.deepEqual(result.catching_up, []);
	assert.deepEqual(readWatchFile(b.home).prs[0]?.cursors, {});
});

test("watch sweep: a batch answered only by path-less errors (bad credentials) is a runner failure and backs off", async (t) => {
	const b = await bench(t);
	const watch = new AwaitingMergeWatch({ ...b.ports, home: b.home, runner: async () => ({ errors: [{ message: "Bad credentials" }] }) });
	const result = await watch.sweep();
	assert.equal(result.backoff_until, "2026-10-15T12:01:00Z");
	assert.match(readWatchFile(b.home).last_error ?? "", /Bad credentials/);
	assert.equal(result.observed, 0);
});

test("watch sweep: a live job whose PR is based on a parked branch gets a stack edge", async (t) => {
	const live: FleetRecord = { ...parked("cp-child"), phase: "held" };
	delete live.awaiting_merge;
	const b = await bench(t, [parked(), live]);
	const queries: string[] = [];
	const answer = { data: { p0: { pullRequest: rawPr(), stacked: { nodes: [{ headRefName: "cp-child" }, { headRefName: "someone-else" }] } } } };
	await new AwaitingMergeWatch({ ...b.ports, stackEdges: b.stacks, home: b.home, runner: async (query) => (queries.push(query), answer) }).sweep();
	assert.match(queries[0]!, /stacked: pullRequests\(baseRefName: "cp-park", states: OPEN/);
	assert.deepEqual(readStackFollowups(b.home).edges.map((edge) => [edge.parent_job, edge.child_job]), [["cp-park", "cp-child"]]);
});

test("watch sweep: observeCi sees open snapshots (a moved head included), never merged/closed; its fault skips nothing", async (t) => {
	const b = await bench(t, [parked(), parked("cp-two", "cp-two", "main", 9), parked("cp-three", "cp-three", "main", 10)]);
	const moved = "b".repeat(40);
	const answer = { data: {
		p0: { pullRequest: rawPr({ headRefOid: moved }) },
		p1: { pullRequest: rawPr({ url: "https://github.com/o/r/pull/9", number: 9, state: "CLOSED" }) },
		p2: { pullRequest: rawPr({ url: "https://github.com/o/r/pull/10", number: 10, state: "MERGED", mergedAt: "2026-10-15T11:59:00Z", mergeCommit: { oid: MERGE } }) },
	} };
	const seen: string[] = [];
	const observeCi = async (record: FleetRecord, snapshot: PrSnapshot) => { seen.push(`${record.job_id}@${snapshot.head_sha}`); throw new Error("store unwritable"); };
	const result = await new AwaitingMergeWatch({ ...b.ports, home: b.home, observeCi, runner: async () => answer }).sweep();
	assert.deepEqual(seen, [`cp-park@${moved}`]);
	assert.deepEqual(result.outcomes.map((outcome) => outcome.applied), ["head_moved", "closed_unmerged"]);
	assert.match(result.errors.join("\n"), /cp-park: native CI not recorded — store unwritable/);
	assert.deepEqual(readWatchFile(b.home).prs.map((pr) => [pr.job_id, pr.cursors.comments]), [["cp-park", "C1"], ["cp-two", "C1"]]);
});

test("checkWakeup: a pending-exit wake is stale once its job left that parking cycle", () => {
	const stamp = { kind: "recovery" as const, job_id: "cp-park", keys: ["parked-cycle:1"], issued_at: HANDED };
	const facts = (phase: FleetRecord["phase"], parked_cycle?: number) => ({ job: () => ({ phase, generation: 1, ...(parked_cycle ? { parked_cycle } : {}) }) });
	assert.equal(checkWakeup(stamp, facts("awaiting_merge", 1)).state, "fresh");
	assert.equal(checkWakeup(stamp, facts("awaiting_merge", 2)).state, "superseded");
	assert.equal(checkWakeup(stamp, facts("held")).state, "superseded");
});

test("cp_next names a parked job with team activity and how to resume it", async (t) => {
	const record = parked();
	record.awaiting_merge!.pending = { kind: "changes_requested", event_id: "PRR_1", observed_at: HANDED };
	const b = await bench(t, [record]);
	// The drain answer returns before any mandate read, and still carries the advisory warning.
	atomicWriteJson(drainFile(b.home), { state: "draining", started_at: HANDED, deadline: HANDED, timeout_s: 5, jobs: [], reported: true });
	const result = await cpNext({ fleet: b.fleet, ledger: {} as never, mandates: {} as never, escalations: {} as never });
	assert.match(result.warning ?? "", /cp-park \(changes_requested\) — cp_send cp-park resumes it/);
});

test("cp_integrate on a parked job waits for the watch and runs no gh or git", async (t) => {
	const b = await bench(t);
	const never = async (): Promise<never> => { throw new Error("nothing may run for a parked job"); };
	const integrator = new Integrator({
		home: b.home, fleet: b.fleet, run: never, projectDir: () => "/wt/old", merges: b.ports.merges as MergeStore,
		teardown: { teardown: never }, ledger: () => ({ close: never }), awaiting: () => new AwaitingStore({ home: b.home }),
	});
	const result = await integrator.advance({ jobId: "cp-park" });
	assert.equal(result.next, "wait");
	assert.match(result.reason, /awaiting_merge watch/);
});

test("awaiting_merge PR6 sweep port: skipped without the home lock; a throwing sweep is journaled once per cause", async (t) => {
	const b = await bench(t);
	const journaled: DurableWakeupInput[] = [];
	let logins = 0;
	let owned = false;
	const unreadable = () => { throw new Error("fleet.json is not readable JSON"); };
	const fleet = { read: unreadable, list: unreadable, get: () => undefined };
	const host = { home: b.home, fleet, runs: undefined, merges: b.ports.merges, ledger: b.ports.ledger, armedDispatches: { release: async () => {} }, ghLogin: async () => (logins += 1, "cp-bot") };
	const ports = awaitingMergePorts(host as never, new Map(), (input) => journaled.push(input), () => owned);
	assert.equal((await ports.sweep()).skipped, "this process does not hold the home");
	assert.equal(logins, 0, "no gh call without the lock");
	owned = true;
	for (const _ of [1, 2]) assert.deepEqual((await ports.sweep()).errors, ["fleet.json is not readable JSON"]);
	assert.equal(new Set(journaled.map((input) => input.id)).size, 1, "one outbox id for the same cause");
	assert.equal(journaled[0]?.kind, "recovery");
});
