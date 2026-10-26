/** Retained from awaiting_merge PR3: the in-process claim and the N20 withdrawal (P18b; the rest is e2e). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyExit, type ExitPorts, type PrSnapshot } from "../src/awaiting-merge-exits.ts";
import { AwaitingMergeWatch, readWatchFile } from "../src/awaiting-merge-watch.ts";
import { EMPTY_USAGE, type FleetRecord } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { AwaitingStore } from "../src/awaiting.ts";
import { MergeStore } from "../src/merges.ts";
import { StackFollowups } from "../src/stack-followups.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
import { createScratchHome } from "./harness/index.ts";

const HANDED = "2026-10-15T10:00:00Z";
const HEAD = "a".repeat(40);

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

test("watch sweep: a skipped apply keeps the prior cursors, so that page is re-read", async (t) => {
	const b = await bench(t);
	const claims = new Map([["cp-park", "resume" as const]]);
	const watch = new AwaitingMergeWatch({ ...b.ports, claims, home: b.home, runner: async () => ({ data: { p0: { pullRequest: rawPr() } } }) });
	const result = await watch.sweep();
	assert.deepEqual(result.outcomes.map((outcome) => outcome.applied), ["skipped"]);
	assert.deepEqual(result.catching_up, []);
	assert.deepEqual(readWatchFile(b.home).prs[0]?.cursors, {});
});

test("N20: the sweep withdraws a done job's open human-review row (merged before any teardown withdrew it), nothing else", async (t) => {
	const closed: FleetRecord = { ...parked("cp-dsuj"), phase: "done" };
	delete closed.awaiting_merge;
	const b = await bench(t, [parked(), closed]);
	const awaiting = new AwaitingStore({ home: b.home });
	const row = async (job_id: string, subject: string) => (await awaiting.declareGated({ type: "approval", subject, decision: `${subject} at abc`, why: "w", blocks: "b", job_id })).item;
	const stale = await row("cp-dsuj", "human-review pr https://github.com/o/r/pull/78");
	const reminder = await row("cp-dsuj", "merge-pending pr https://github.com/o/r/pull/78");
	const parkedRow = await row("cp-park", "human-review pr https://github.com/o/r/pull/7");
	await new AwaitingMergeWatch({ ...b.ports, home: b.home, runner: async () => ({ data: { p0: { pullRequest: rawPr() } } }) }).sweep();
	assert.deepEqual([stale, reminder, parkedRow].map((item) => awaiting.get(item.id)?.state), ["withdrawn", "open", "open"]);
});
