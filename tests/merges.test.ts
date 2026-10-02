/**
 * cp-vk1 acceptance, half one: the merge receipt itself.
 *
 * A receipt is an **observation**, so every test here is about what `gh` said,
 * not about what a caller claimed. The store refuses an unmerged PR, a PR gh
 * cannot be asked about, a merged PR with no merge commit and a PR that merged
 * some other branch — writing nothing in every one of those cases, because a
 * receipt nobody can trust is worse than the `force` it was meant to replace.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths, type Receipt } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { type CommandRunner, formatMerge, MergeError, MergeStore, readMergeReceipt } from "../src/merges.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, readRunEvents } from "./harness/index.ts";

interface GhPr {
	number?: number;
	url?: string;
	state?: string;
	mergedAt?: string;
	mergeCommit?: { oid?: string } | null;
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
}

/**
 * A `gh` that answers with exactly what the test says GitHub knows, and a `git`
 * that answers "the head branch is gone". Nothing here shells out.
 */
function runner(pr: GhPr | { fail: string }, options: { branchOnRemote?: boolean } = {}): CommandRunner {
	return async (_cwd, bin, args) => {
		if (bin === "git") {
			assert.deepEqual([...args].slice(0, 2), ["ls-remote", "--heads"]);
			return { status: 0, stdout: options.branchOnRemote ? `abc123\trefs/heads/x\n` : "", stderr: "" };
		}
		assert.equal(bin, "gh");
		assert.deepEqual([...args].slice(0, 2), ["pr", "view"]);
		if ("fail" in pr) return { status: 1, stdout: "", stderr: pr.fail };
		return { status: 0, stdout: JSON.stringify(pr), stderr: "" };
	};
}

interface Bench {
	home: string;
	fleet: FleetStore;
	runs: RunRegistry;
	store(pr: GhPr | { fail: string }, options?: { branchOnRemote?: boolean }): MergeStore;
	addJob(jobId: string, receipts?: Receipt[]): Promise<void>;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }): Bench {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return {
		home: home.path,
		fleet,
		runs,
		store(pr, options = {}) {
			return new MergeStore({ home: home.path, fleet, runs, run: runner(pr, options) });
		},
		async addJob(jobId, receipts) {
			await fleet.add({
				job_id: jobId,
				project: "demo",
				kind: "ship",
				delivery: "pr",
				origin: DEFAULT_ORIGIN,
				phase: "held",
				reported_at: isoTimestamp(),
				worker: {
					pid: process.pid,
					session_id: "s",
					session_file: join(home.path, "s.jsonl"),
					profile: "implementer",
					role: "implementer",
					model: "mock/model",
					started_at: isoTimestamp(),
				},
				worktree: join(home.path, "worktrees", jobId),
				branch: jobId,
				dispatched_at: isoTimestamp(),
				usage: EMPTY_USAGE,
				...(receipts ? { receipts } : {}),
			});
		},
	};
}

const PR_RECEIPT: Receipt = { kind: "pr", status: "open", title: "PR for cp-m1", url: "https://github.com/o/r/pull/54" };

test("a merged PR is recorded from what gh reports, and the pr receipt becomes merged", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-m1", [PR_RECEIPT]);
	const store = b.store({
		number: 54,
		url: "https://github.com/o/r/pull/54",
		state: "MERGED",
		mergedAt: "2026-08-31T15:55:07Z",
		mergeCommit: { oid: "b59fc3a1b59fc3a1b59fc3a1b59fc3a1b59fc3a1" },
		headRefName: "cp-m1",
		headRefOid: "b079433934c2b079433934c2b079433934c2b079",
		baseRefName: "main",
	});

	const result = await store.record({ jobId: "cp-m1", strategy: "squash" });
	assert.equal(result.recorded, true);
	assert.equal(result.receipt.merge_commit_sha.slice(0, 7), "b59fc3a");
	assert.equal(result.receipt.head_sha.slice(0, 12), "b079433934c2");
	assert.equal(result.receipt.head_branch_deleted, true, "gh's branch is gone from the remote");
	assert.equal(result.receipt.strategy, "squash");
	assert.match(formatMerge(result), /cp_teardown cp-m1 can now pass without force/);

	// On disk, and readable by the gate's total reader.
	assert.ok(existsSync(join(b.home, paths.mergeFile("cp-m1"))));
	assert.equal(readMergeReceipt(b.home, "cp-m1")?.pr_url, "https://github.com/o/r/pull/54");

	// The one existing record it touches: `open` -> `merged` (src/supersede.ts's
	// LANDED_RECEIPT_STATUSES), which nothing set before this existed.
	const receipts = b.fleet.require("cp-m1").receipts ?? [];
	assert.equal(receipts.length, 1, "the receipt is updated, never duplicated");
	assert.equal(receipts[0]?.status, "merged");
	assert.equal(receipts[0]?.url, "https://github.com/o/r/pull/54");

	// Journaled, so a `merged` teardown pass has evidence behind it in the log.
	const events = readRunEvents(b.home, "cp-m1").filter((event) => event.type === "merge_recorded");
	assert.equal(events.length, 1);

	// Idempotent: a second call reads the receipt back and writes nothing.
	const again = await store.record({ jobId: "cp-m1" });
	assert.equal(again.recorded, false);
	assert.equal(again.receipt.merge_commit_sha, result.receipt.merge_commit_sha);
});

test("nothing is recorded for a PR gh does not call merged", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-m2", [{ ...PR_RECEIPT, title: "PR for cp-m2" }]);

	const open = b.store({ url: "https://github.com/o/r/pull/9", state: "OPEN", headRefName: "cp-m2" });
	await assert.rejects(() => open.record({ jobId: "cp-m2" }), (error: Error) => {
		assert.ok(error instanceof MergeError);
		assert.match(error.message, /not MERGED/);
		return true;
	});
	assert.equal(readMergeReceipt(b.home, "cp-m2"), undefined);
	assert.equal(b.fleet.require("cp-m2").receipts?.[0]?.status, "open", "a refusal changes nothing");

	// Merged, but with no merge commit named: unprovable, so still nothing.
	const noCommit = b.store({ state: "MERGED", headRefName: "cp-m2", headRefOid: "a".repeat(40), mergeCommit: null });
	await assert.rejects(() => noCommit.record({ jobId: "cp-m2" }), /names no merge commit/);
	assert.equal(readMergeReceipt(b.home, "cp-m2"), undefined);

	// A PR that merged some other branch is not this job's delivery.
	const otherBranch = b.store({
		state: "MERGED",
		url: "https://github.com/o/r/pull/11",
		headRefName: "someone-elses-branch",
		headRefOid: "a".repeat(40),
		mergeCommit: { oid: "b".repeat(40) },
	});
	await assert.rejects(() => otherBranch.record({ jobId: "cp-m2" }), /is not this job's delivery/);
	assert.equal(readMergeReceipt(b.home, "cp-m2"), undefined);
});

test("an unreachable gh refuses and names force as the honest exit", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-m3", [{ ...PR_RECEIPT, title: "PR for cp-m3" }]);
	const store = b.store({ fail: "gh: command not found" });

	await assert.rejects(() => store.record({ jobId: "cp-m3" }), (error: Error) => {
		assert.match(error.message, /could not read PR/);
		assert.match(error.message, /cp_teardown cp-m3 force/, "force stays the exit for the unprovable case");
		return true;
	});
	assert.equal(readMergeReceipt(b.home, "cp-m3"), undefined);
});

test("a job with no PR receipt must be told which PR, and an unknown job is refused", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-m4");
	const store = b.store({
		state: "MERGED",
		url: "https://github.com/o/r/pull/77",
		headRefName: "cp-m4",
		headRefOid: "c".repeat(40),
		mergeCommit: { oid: "d".repeat(40) },
	});

	await assert.rejects(() => store.record({ jobId: "cp-m4" }), /carries no PR receipt/);
	const explicit = await store.record({ jobId: "cp-m4", pr: "77" });
	assert.equal(explicit.recorded, true);
	// With no prior receipt there is one to add, so Shipped can render the job.
	assert.equal(b.fleet.require("cp-m4").receipts?.[0]?.status, "merged");

	await assert.rejects(() => store.record({ jobId: "cp-unknown" }), /no fleet record/);
});

test("an unreadable receipt is no receipt, never an exception out of a gate", async (t) => {
	const b = benchOf(t);
	assert.equal(readMergeReceipt(b.home, "cp-none"), undefined);
	assert.equal(readMergeReceipt(b.home, "../escape"), undefined, "an unsafe id is not a path");
});
