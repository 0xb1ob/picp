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
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths, type Receipt } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { ChangeRequestObservation } from "../src/forges/adapter.ts";
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
	assert.equal(result.receipt.bound, undefined, "an unbound job's receipt carries no bound marker");
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

test("picp-d0p: a bound job's receipt names the PR head branch and is marked bound", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-bound1", [PR_RECEIPT]);
	await b.fleet.patch("cp-bound1", { branch: "cp-b55w", bound_pr: { number: 54, url: "https://github.com/o/r/pull/54", base: "main" } });
	const store = b.store({
		number: 54,
		url: "https://github.com/o/r/pull/54",
		state: "MERGED",
		mergeCommit: { oid: "b59fc3a1b59fc3a1b59fc3a1b59fc3a1b59fc3a1" },
		headRefName: "cp-b55w",
		headRefOid: "b079433934c2b079433934c2b079433934c2b079",
		baseRefName: "main",
	});
	const result = await store.record({ jobId: "cp-bound1" });
	assert.equal(result.recorded, true);
	assert.equal(result.receipt.head_branch, "cp-b55w");
	assert.equal(result.receipt.bound, true);
	assert.equal(readMergeReceipt(b.home, "cp-bound1")?.bound, true, "the marker survives the schema on disk");
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
		assert.ok(error.message.indexOf("git evidence") < error.message.indexOf("force"), "git evidence is offered first, force last (forge PR 2)");
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

/** Forge PR 2: a GitLab MR observed through an injected observer (no network), and git asked about fast-forward reachability. */
function gitlabStore(b: Bench, observation: Partial<ChangeRequestObservation>, git: { tip?: string; ancestor?: boolean } = {}): { store: MergeStore; asked: string[][] } {
	const asked: string[][] = [];
	const run: CommandRunner = async (_cwd, bin, args) => {
		assert.equal(bin, "git", "GitLab is never asked through gh");
		asked.push([...args]);
		if (args[0] === "ls-remote") return { status: 0, stdout: args[3] === "refs/heads/main" && git.tip ? `${git.tip}\trefs/heads/main\n` : "", stderr: "" };
		if (args[0] === "cat-file") return { status: 0, stdout: "", stderr: "" };
		if (args[0] === "merge-base") return { status: git.ancestor ? 0 : 1, stdout: "", stderr: "" };
		return assert.fail(`unexpected git ${args.join(" ")}`);
	};
	const view: ChangeRequestObservation = {
		provider: "gitlab",
		url: "https://gitlab.com/group/sub/repo/-/merge_requests/7",
		number: 7,
		state: "merged",
		source_branch: "cp-gl",
		target_branch: "main",
		head_sha: "e".repeat(40),
		merged_at: "2026-08-31T15:55:07.123Z",
		...observation,
	};
	const store = new MergeStore({ home: b.home, fleet: b.fleet, runs: b.runs, run, observer: () => ({ provider: "gitlab", readChangeRequest: async () => ({ ok: true, observation: view }) }) });
	return { store, asked };
}

test("forge PR 2: a GitLab squash MR is recorded with its squash commit, provider and project, never through gh", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-gl", [{ ...PR_RECEIPT, url: "https://gitlab.com/group/sub/repo/-/merge_requests/7" }]);
	const { store } = gitlabStore(b, { merge_commit_sha: undefined, squash_commit_sha: "f".repeat(40) });
	const result = await store.record({ jobId: "cp-gl" });
	assert.equal(result.receipt.merge_commit_sha, "f".repeat(40));
	assert.equal(result.receipt.strategy, "squash");
	assert.equal(result.receipt.pr_number, 7, "pr_number carries the MR IID");
	assert.equal(result.receipt.merged_at, "2026-08-31T15:55:07Z", "a millisecond timestamp is normalised");
	assert.equal(result.receipt.recorded_by, "gitlab api");
	assert.deepEqual(result.receipt.forge, { provider: "gitlab", project_url: "https://gitlab.com/group/sub/repo" });
	assert.equal(result.receipt.head_branch_deleted, true);
	const event = readRunEvents(b.home, "cp-gl").find((entry) => entry.type === "merge_recorded");
	assert.equal((event?.payload as { provider?: string } | undefined)?.provider, "gitlab");
});

test("forge PR 3: a GitLab normal merge records its merge commit, never infers a strategy, and asks git nothing about reachability", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-gl", [{ ...PR_RECEIPT, url: "https://gitlab.com/group/sub/repo/-/merge_requests/7" }]);
	const { store, asked } = gitlabStore(b, { merge_commit_sha: "a".repeat(40), squash_commit_sha: "f".repeat(40) });
	const result = await store.record({ jobId: "cp-gl" });
	assert.equal(result.receipt.merge_commit_sha, "a".repeat(40), "the merge commit wins over a squash commit");
	assert.equal(result.receipt.head_sha, "e".repeat(40), "the head stays the source head, separate from the landing commit");
	assert.equal(result.receipt.base_branch, "main");
	assert.equal(result.receipt.strategy, "squash", "squash evidence is recorded as observed");
	assert.deepEqual(asked.filter((args) => args[0] !== "ls-remote"), [], "no fast-forward question is asked when the forge names a landing commit");

	const plain = benchOf(t);
	await plain.addJob("cp-gl", [{ ...PR_RECEIPT, url: "https://gitlab.com/group/sub/repo/-/merge_requests/7" }]);
	const merged = await gitlabStore(plain, { merge_commit_sha: "a".repeat(40) }).store.record({ jobId: "cp-gl" });
	assert.equal(merged.receipt.merge_commit_sha, "a".repeat(40));
	assert.equal(merged.receipt.strategy, "unknown", "a merge commit alone does not say how the MR was merged");
});

test("forge PR 2: a GitLab fast-forward MR records its head only when git sees it on the target", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-gl", [{ ...PR_RECEIPT, url: "https://gitlab.com/group/sub/repo/-/merge_requests/7" }]);
	const unseen = gitlabStore(b, {}, { tip: "1".repeat(40), ancestor: false });
	await assert.rejects(() => unseen.store.record({ jobId: "cp-gl" }), /names no merge commit/);
	assert.equal(readMergeReceipt(b.home, "cp-gl"), undefined, "an MR with no landing commit git can see writes nothing");

	const seen = gitlabStore(b, {}, { tip: "1".repeat(40), ancestor: true });
	const result = await seen.store.record({ jobId: "cp-gl" });
	assert.equal(result.receipt.merge_commit_sha, "e".repeat(40), "the fast-forwarded head is the landing commit");
	assert.equal(result.receipt.strategy, "unknown");
	assert.ok(seen.asked.some((args) => args[0] === "merge-base" && args.includes("e".repeat(40)) && args.includes("1".repeat(40))));
	assert.equal(b.fleet.require("cp-gl").receipts?.[0]?.status, "merged");
});

test("forge PR 2: a stored receipt for another job or branch is refused, and a crash before the fleet patch is repaired", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-gl", [{ ...PR_RECEIPT, url: "https://gitlab.com/group/sub/repo/-/merge_requests/7" }]);
	const { store } = gitlabStore(b, { squash_commit_sha: "f".repeat(40) });
	const first = await store.record({ jobId: "cp-gl" });
	// Simulate the crash window: the receipt is on disk, the fleet still says open.
	await b.fleet.patch("cp-gl", { receipts: [{ ...PR_RECEIPT, url: first.receipt.pr_url }] });
	const again = await store.record({ jobId: "cp-gl" });
	assert.equal(again.recorded, false);
	assert.equal(again.receipt_status_updated, true);
	assert.equal(b.fleet.require("cp-gl").receipts?.[0]?.status, "merged");
	assert.equal(readRunEvents(b.home, "cp-gl").filter((event) => event.type === "merge_recorded").length, 1, "no second event");

	await b.fleet.patch("cp-gl", { branch: "cp-other" });
	await assert.rejects(() => store.record({ jobId: "cp-gl" }), /discharges nothing here/);
});

test("forge PR 2: a mismatched observation records nothing, and a legacy receipt with no forge block still reads", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-gl", [{ ...PR_RECEIPT, url: "https://gitlab.com/group/sub/repo/-/merge_requests/7" }]);
	const mismatch = new MergeStore({ home: b.home, fleet: b.fleet, runs: b.runs, run: async () => assert.fail("nothing runs"), observer: () => ({ provider: "gitlab", readChangeRequest: async () => ({ ok: false, reason: "mismatch", detail: "the answer names another project" }) }) });
	await assert.rejects(() => mismatch.record({ jobId: "cp-gl" }), (error: Error) => {
		assert.match(error.message, /mismatch: the answer names another project/);
		return true;
	});
	assert.equal(readMergeReceipt(b.home, "cp-gl"), undefined);

	await b.addJob("cp-m1", [PR_RECEIPT]);
	const legacy = await b.store({ number: 54, url: PR_RECEIPT.url, state: "MERGED", mergeCommit: { oid: "b".repeat(40) }, headRefName: "cp-m1", headRefOid: "a".repeat(40) }).record({ jobId: "cp-m1" });
	assert.equal(legacy.receipt.forge?.provider, "github");
	const { forge: _forge, ...withoutForge } = legacy.receipt;
	writeFileSync(join(b.home, paths.mergeFile("cp-m1")), JSON.stringify(withoutForge));
	assert.equal(readMergeReceipt(b.home, "cp-m1")?.head_sha, "a".repeat(40), "a pre-forge receipt is still valid");
});

test("#326: afterRecorded runs on new and existing receipts; a throwing port leaves the receipt and names the failure", async (t) => {
	const b = benchOf(t);
	await b.addJob("cp-m1", [PR_RECEIPT]);
	const pr: GhPr = { number: 54, url: PR_RECEIPT.url, state: "MERGED", mergeCommit: { oid: "b".repeat(40) }, headRefName: "cp-m1", headRefOid: "a".repeat(40), baseRefName: "main" };
	const seen: string[] = [];
	const store = (afterRecorded: (receipt: import("../src/contracts.ts").MergeReceipt) => Promise<string | undefined>) =>
		new MergeStore({ home: b.home, fleet: b.fleet, runs: b.runs, run: runner(pr), afterRecorded });
	const failing = await store(async () => { throw new Error("ledger refused\nsecond line"); }).record({ jobId: "cp-m1" });
	assert.equal(failing.recorded, true);
	assert.ok(readMergeReceipt(b.home, "cp-m1"), "the receipt is written whatever the port does");
	assert.equal(failing.after_merge, "after-merge deploy NOT created: ledger refused — cp_merged cp-m1 retries");
	assert.match(formatMerge(failing), /can now pass without force\. after-merge deploy NOT created/);
	const again = await store(async (receipt) => (seen.push(receipt.base_branch ?? ""), "after-merge deploy cp-d1 created")).record({ jobId: "cp-m1" });
	assert.equal(again.recorded, false);
	assert.equal(again.after_merge, "after-merge deploy cp-d1 created");
	assert.deepEqual(seen, ["main"]);
	const quiet = await store(async () => undefined).record({ jobId: "cp-m1" });
	assert.equal("after_merge" in quiet, false);
	assert.equal("after_merge" in (await b.store(pr).record({ jobId: "cp-m1" })), false, "no port: today's result");
});
