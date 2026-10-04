/**
 * T17 acceptance: every gate branch, including the squash-merge
 * head-deleted case, and fail-closed behaviour that keeps everything.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	type Checkpoint,
	DEFAULT_ORIGIN,
	type Delivery,
	type DiffVerdict,
	EMPTY_USAGE,
	type FleetRecord,
	type GateCause,
	type GateVerdictValue,
	isoTimestamp,
	isScriptFleetRecord,
	type JobKind,
	paths,
	type PipelineRecord,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { atomicWriteJson } from "../src/json-store.ts";
import type { JobClaims } from "../src/job-claims.ts";
import { LeaseManager } from "../src/leases.ts";
import { PipelineStore } from "../src/pipeline.ts";
import { loadProfile } from "../src/profiles.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import type { Ledger } from "../src/ledger.ts";
import { formatTeardown, type GitRunner, Teardown, type TeardownLedger } from "../src/teardown.ts";
import { unreportedLiveWorker } from "../src/teardown-head.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
import { registerIntegrateTools } from "../extensions/command-post/tools-integrate.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	advanceBase,
	createAgentDir,
	createScratchHome,
	createScratchLedger,
	createScratchRepo,
	enableTreehouse,
	git,
	MockProvider,
	readFleet,
	readRunEvents,
	rebaseMergeAndDeleteHead,
	REPO_ROOT,
	type ScratchRepo,
	squashMergeAndDeleteHead,
	treehouse,
	treehouseAvailable,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";
import { type CommandRunner, MergeStore } from "../src/merges.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

interface Bench {
	home: string;
	repo: ScratchRepo;
	fleet: FleetStore;
	runs: RunRegistry;
	manager: WorkerManager;
	teardown: Teardown;
	/** The same stores, with git injected — used to record or bend single commands. */
	teardownWith(git: GitRunner): Teardown;
	withLedger(ledger: Ledger): Teardown;
	withJournal(journal: (input: DurableWakeupInput) => void): Teardown;
	/** A linked worktree on the job branch, standing in for a lease. */
	worktree(jobId: string, options?: { base?: string }): string;
	addJob(jobId: string, worktree: string, kind?: JobKind, delivery?: Delivery): Promise<FleetRecord>;
	onCleanup(fn: () => void | Promise<void>): void;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }): Bench {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const manager = new WorkerManager({ home: home.path, workerReporterPath: WORKER_REPORTER_EXTENSION });
	const cleanups: Array<() => void | Promise<void>> = [];
	// Leases are exercised for real in the treehouse test below; the gate tests
	// use a stub release so they can run without treehouse installed.
	const released: string[] = [];
	const leases = new LeaseManager({
		home: home.path,
		cwd: () => home.path,
		runner: async (bin, args) => {
			if (bin === "treehouse" && args[0] === "return") released.push(String(args.at(-1)));
			return { status: 0, stdout: "", stderr: "" };
		},
	});
	const teardown = new Teardown({ home: home.path, fleet, leases, manager, runs });

	t.after(async () => {
		for (const fn of cleanups) await fn();
		await manager.shutdownAll();
		runs.closeAll();
		repo.cleanup();
		home.cleanup();
	});

	return {
		home: home.path,
		repo,
		fleet,
		runs,
		manager,
		teardown,
		teardownWith(git) {
			return new Teardown({ home: home.path, fleet, leases, manager, runs, git });
		},
		withLedger(ledger) {
			return new Teardown({ home: home.path, fleet, leases, manager, runs, ledger: () => ledger });
		},
		withJournal(journal) {
			return new Teardown({ home: home.path, fleet, leases, manager, runs, journal });
		},
		worktree(jobId, options = {}) {
			const path = join(home.path, "worktrees", jobId);
			mkdirSync(join(home.path, "worktrees"), { recursive: true });
			// --no-track mirrors dispatch: a job branch has no upstream until it is
			// pushed, which is exactly what makes the merged-head trap possible.
			git(repo.path, "worktree", "add", "--quiet", "--no-track", "-b", jobId, path, options.base ?? "origin/main");
			cleanups.push(() => {
				try {
					git(repo.path, "worktree", "remove", "--force", path);
				} catch {
					// already gone
				}
			});
			return path;
		},
		async addJob(jobId, worktree, kind: JobKind = "ship", delivery?: Delivery) {
			return fleet.add({
				job_id: jobId,
				project: "demo",
				kind,
				delivery: delivery ?? (kind === "research" ? "pipeline" : "pr"),
				origin: DEFAULT_ORIGIN,
				phase: "held",
				reported_at: isoTimestamp(),
				worker: {
					pid: process.pid,
					session_id: "s",
					session_file: join(home.path, "s.jsonl"),
					profile: kind === "research" ? "planner" : "implementer",
					role: kind === "research" ? "planner" : "implementer",
					model: "mock/model",
					started_at: isoTimestamp(),
					exited_at: isoTimestamp(),
				},
				worktree,
				branch: jobId,
				dispatched_at: isoTimestamp(),
				usage: EMPTY_USAGE,
			});
		},
		onCleanup: (fn) => cleanups.push(fn),
	};
}

// ---------------------------------------------------------------------------
// ship gates
// ---------------------------------------------------------------------------

test("ship: pushed passes, unpushed and dirty keep everything", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);

	// dirty
	const dirtyTree = b.worktree("cp-dirty");
	await b.addJob("cp-dirty", dirtyTree);
	writeFileSync(join(dirtyTree, "scratch.txt"), "work in progress\n");
	const dirty = await b.teardown.teardown("cp-dirty");
	assert.equal(dirty.torn_down, false);
	assert.equal(dirty.failure?.code, "dirty");
	assert.match(formatTeardown(dirty), /keep the lease/);
	assert.equal(b.fleet.require("cp-dirty").phase, "held", "a refused teardown changes nothing");

	// committed but not pushed
	const unpushedTree = b.worktree("cp-unpushed");
	await b.addJob("cp-unpushed", unpushedTree);
	writeFileSync(join(unpushedTree, "src/app.ts"), "export const x = 2;\n");
	git(unpushedTree, "add", "-A");
	git(unpushedTree, "commit", "--quiet", "-m", "bump x");
	const unpushed = await b.teardown.teardown("cp-unpushed");
	assert.equal(unpushed.torn_down, false);
	assert.equal(unpushed.failure?.code, "unpushed");
	assert.match(unpushed.failure?.message ?? "", /no upstream, is not on origin/);

	// pushed
	git(unpushedTree, "push", "--quiet", "-u", "origin", "cp-unpushed");
	const pushed = await b.teardown.teardown("cp-unpushed");
	assert.equal(pushed.torn_down, true);
	assert.equal(pushed.reason, "pushed");
	assert.equal(pushed.lease_returned, true);
	const record = readFleet(b.home).jobs.find((job) => job.job_id === "cp-unpushed");
	assert.equal(record?.phase, "done");
	assert.ok(record?.closed_at);
});

test("ship: a merged PR whose head branch was deleted still tears down", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const worktree = b.worktree("cp-merged");
	await b.addJob("cp-merged", worktree);

	writeFileSync(join(worktree, "src/app.ts"), "export const x = 42;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "bump x to 42");
	git(worktree, "push", "--quiet", "-u", "origin", "cp-merged");

	// GitHub-style squash merge, then auto-delete of the head branch.
	squashMergeAndDeleteHead(b.repo, "cp-merged");
	git(worktree, "fetch", "--quiet", "--prune", "origin");

	// Absence from origin reads like "never pushed" — the ported trap.
	assert.equal(git(worktree, "ls-remote", "--heads", "origin", "cp-merged"), "");

	const result = await b.teardown.teardown("cp-merged");
	assert.equal(result.torn_down, true, formatTeardown(result));
	assert.equal(result.reason, "merged_head_deleted");
});

// ---------------------------------------------------------------------------
// cp-vk1: landing is confirmed from the PR, and "on origin" is asked of origin
// ---------------------------------------------------------------------------

/**
 * A `gh` that reports the merge the test actually performed, so the receipt is
 * written from an observation rather than from an assertion. `git` calls (the
 * store's own `ls-remote`) run for real against the scratch remote.
 */
function ghMerged(input: { branch: string; headSha: string; mergeCommit: string; number: number }): CommandRunner {
	return async (cwd, bin, args) => {
		if (bin === "git") {
			try {
				return { status: 0, stdout: git(cwd, ...args), stderr: "" };
			} catch (error) {
				return { status: 1, stdout: "", stderr: String((error as Error).message) };
			}
		}
		assert.equal(bin, "gh");
		return {
			status: 0,
			stdout: JSON.stringify({
				number: input.number,
				url: `https://github.com/o/r/pull/${input.number}`,
				state: "MERGED",
				mergedAt: "2026-08-31T15:55:07Z",
				mergeCommit: { oid: input.mergeCommit },
				headRefName: input.branch,
				headRefOid: input.headSha,
				baseRefName: "main",
			}),
			stderr: "",
		};
	};
}

test("ship: a squash-merged PR passes on its merge receipt, after the base has moved on", { timeout: 60_000 }, async (t) => {
	// The cp-kzc case, exactly: this repo squash-merges everything, so the branch
	// content is never an ancestor of main, and by the time teardown runs main has
	// advanced past the merge — which is what makes the two-dot tree diff (the
	// only pre-cp-vk1 mechanism) unable to recognise ANY squash-merged PR. The
	// merge receipt is read instead, and `force` is not needed.
	const b = benchOf(t);
	const jobId = "cp-squashed";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 42;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "bump x to 42");
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	const head = git(worktree, "rev-parse", "HEAD");

	const mergeCommit = squashMergeAndDeleteHead(b.repo, jobId);
	advanceBase(b.repo, "docs/other.md", "# a later merge, from another job\n");
	git(worktree, "fetch", "--quiet", "--prune", "origin");

	// Without a receipt the gate refuses — correctly, on the evidence it has.
	const before = await b.teardown.checkGates(worktree, jobId, "ship");
	assert.equal(before.ok, false, "a squash merge is not visible in ancestry, and the gate does not guess");
	assert.match(before.ok === false ? before.failure.fix : "", /cp_merged/, "the fix names a real mechanism");

	// Record what gh says, which is the mechanism "confirm the PR merged" lacked.
	const merges = new MergeStore({
		home: b.home,
		fleet: b.fleet,
		runs: b.runs,
		run: ghMerged({ branch: jobId, headSha: head, mergeCommit, number: 54 }),
	});
	const recorded = await merges.record({ jobId, pr: "54", strategy: "squash" });
	assert.equal(recorded.receipt.head_branch_deleted, true);

	assert.deepEqual(await b.teardown.checkGates(worktree, jobId, "ship"), { ok: true, reason: "merged" });
	const torn = await b.teardown.teardown(jobId);
	assert.equal(torn.torn_down, true, formatTeardown(torn));
	assert.equal(torn.reason, "merged");
	assert.equal(b.fleet.require(jobId).closed_reason, "gated", "proven, not forced");
});

test("ship: a rebase-merged PR is recognised the same way", { timeout: 60_000 }, async (t) => {
	// Rebase rewrites the commit exactly as squash does: the head oid is not an
	// ancestor of the base afterwards, so the receipt is what carries the fact.
	const b = benchOf(t);
	const jobId = "cp-rebased";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 7;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "bump x to 7");
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	const head = git(worktree, "rev-parse", "HEAD");

	advanceBase(b.repo, "docs/first.md", "# something else landed first\n");
	const mergeCommit = rebaseMergeAndDeleteHead(b.repo, jobId);
	assert.notEqual(mergeCommit, head, "a rebase merge is a different commit");
	git(worktree, "fetch", "--quiet", "--prune", "origin");

	const merges = new MergeStore({
		home: b.home,
		fleet: b.fleet,
		runs: b.runs,
		run: ghMerged({ branch: jobId, headSha: head, mergeCommit, number: 55 }),
	});
	await merges.record({ jobId, pr: "55", strategy: "rebase" });

	const torn = await b.teardown.teardown(jobId);
	assert.equal(torn.torn_down, true, formatTeardown(torn));
	assert.equal(torn.reason, "merged");
});

test("ship: a branch that only LOOKS pushed via a stale remote-tracking ref is refused", { timeout: 60_000 }, async (t) => {
	// The false pass (cp-qvw, cp-diffgate-teardown-gate-btd): worker worktrees are
	// separate clones, so refs/remotes/origin/<branch> goes stale on its own. Both
	// jobs tore down reporting "(pushed)" AFTER their remote branches were deleted,
	// because the gate compared HEAD against a ref for a branch that no longer
	// existed upstream. The verdict must not depend on whether anyone happened to
	// run `git fetch --prune`.
	const b = benchOf(t);
	const jobId = "cp-stale";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 5;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "work that is about to vanish from origin");
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	const head = git(worktree, "rev-parse", "HEAD");

	// Deleted from the remote by someone else's clone, and deliberately NOT pruned
	// here: this worktree still holds origin/<branch> at exactly the local tip.
	squashMergeAndDeleteHead(b.repo, jobId);
	advanceBase(b.repo, "docs/after.md", "# main moved on\n");
	assert.equal(
		git(worktree, "rev-parse", `refs/remotes/origin/${jobId}`),
		head,
		"the stale ref is present and equal to HEAD — the exact false-pass condition",
	);
	assert.equal(git(worktree, "ls-remote", "--heads", "origin", jobId), "", "and the remote does not have it");

	const gate = await b.teardown.checkGates(worktree, jobId, "ship");
	assert.equal(gate.ok, false, "a stale ref is not evidence a branch is on origin");
	assert.equal(gate.ok === false && gate.failure.code, "unpushed");
	assert.match(gate.ok === false ? gate.failure.message : "", /stale remote-tracking ref/);

	const refused = await b.teardown.teardown(jobId);
	assert.equal(refused.torn_down, false);
	assert.equal(refused.lease_returned, false, "a refusal returns nothing");
	assert.equal(b.fleet.require(jobId).phase, "held");
});

// ---------------------------------------------------------------------------
// cp-p0r: the receipt-free fallback asks origin for the BASE too
// ---------------------------------------------------------------------------

/**
 * A git runner that records every invocation and otherwise runs for real
 * against the scratch remote, so a test can assert *which question was asked*
 * and not only what the answer was. `bend` gets first refusal on each call.
 */
function recordingGit(
	calls: string[][],
	bend?: (args: readonly string[]) => { status: number | null; stdout: string; stderr: string } | undefined,
): GitRunner {
	return async (cwd, args) => {
		calls.push([...args]);
		const bent = bend?.(args);
		if (bent) return bent;
		try {
			return { status: 0, stdout: git(cwd, ...args), stderr: "" };
		} catch (error) {
			return { status: 1, stdout: "", stderr: String((error as Error).message) };
		}
	};
}

const asked = (calls: string[][], predicate: (args: string[]) => boolean) => calls.some(predicate);
const isBaseLsRemote = (base: string) => (args: string[]) =>
	args[0] === "ls-remote" && args.includes(`refs/heads/${base}`);
const readsBaseTrackingRef = (base: string) => (args: string[]) =>
	args[0] === "rev-parse" && args.includes(`refs/remotes/origin/${base}`);

/** Push the branch, squash-merge it, delete the head, and prune locally. */
function mergeAndAbsorb(b: Bench, jobId: string, worktree: string, content: string): string {
	writeFileSync(join(worktree, "src/app.ts"), content);
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", `set app to ${content.trim()}`);
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	const head = git(worktree, "rev-parse", "HEAD");
	squashMergeAndDeleteHead(b.repo, jobId);
	git(worktree, "fetch", "--quiet", "--prune", "origin");
	return head;
}

test("ship: the merged-and-absorbed fallback asks origin for the base, not a tracking ref", { timeout: 60_000 }, async (t) => {
	// cp-vk1 made every "is it on origin?" question go through `git ls-remote`,
	// but the base half of this fallback still read refs/remotes/origin/<base>.
	// This is a PASS decision, so the question has to be asked of origin.
	const b = benchOf(t);
	const jobId = "cp-absorbed";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	mergeAndAbsorb(b, jobId, worktree, "export const x = 42;\n");

	const calls: string[][] = [];
	const gate = await b.teardownWith(recordingGit(calls)).checkGates(worktree, jobId, "ship");
	assert.deepEqual(gate, { ok: true, reason: "merged_head_deleted" });
	assert.ok(asked(calls, isBaseLsRemote("main")), "the base sha comes from origin itself");
	assert.equal(asked(calls, readsBaseTrackingRef("main")), false, "and never from a remote-tracking ref");
	assert.ok(
		asked(calls, (args) => args[0] === "diff" && args.includes("--name-only") && !args.some((a) => a.startsWith("origin/"))),
		"the two-dot diff runs against the sha origin named, not against a ref name",
	);
});

test("ship: a stale origin/<base> that matches HEAD's tree no longer passes teardown", { timeout: 60_000 }, async (t) => {
	// The dangerous inversion. refs/remotes/origin/main here points at the squash
	// merge (tree identical to HEAD) while origin has already moved past it. Under
	// the old code this tore the job down as `merged_head_deleted`; the base is now
	// asked of origin, so the comparison is against the advanced sha and fails
	// closed instead.
	const b = benchOf(t);
	const jobId = "cp-stale-base";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	mergeAndAbsorb(b, jobId, worktree, "export const x = 43;\n");

	const trackingRef = git(worktree, "rev-parse", "refs/remotes/origin/main");
	assert.equal(git(worktree, "diff", "--name-only", "HEAD", "origin/main"), "", "the stale ref's tree equals HEAD — the false-pass condition");

	// origin advances, and nobody fetches: the tracking ref keeps its old answer.
	const advanced = advanceBase(b.repo, "docs/after.md", "# main moved on\n");
	assert.notEqual(advanced, trackingRef, "origin's main is not what the tracking ref says");
	assert.equal(git(worktree, "rev-parse", "refs/remotes/origin/main"), trackingRef, "and it is still stale");

	const calls: string[][] = [];
	const gate = await b.teardownWith(recordingGit(calls)).checkGates(worktree, jobId, "ship");
	assert.equal(gate.ok, false, "a stale base is not evidence that the work landed");
	assert.equal(gate.ok === false && gate.failure.code, "unpushed");
	assert.ok(asked(calls, isBaseLsRemote("main")), "origin was asked about the base");

	const refused = await b.teardownWith(recordingGit([])).teardown(jobId);
	assert.equal(refused.torn_down, false);
	assert.equal(refused.lease_returned, false, "a refusal returns nothing");
	assert.equal(b.fleet.require(jobId).phase, "held");
});

test("ship: an unanswerable origin fails the merged-and-absorbed fallback closed", { timeout: 60_000 }, async (t) => {
	// No network, no remote, no permission: nothing is known about the base, and an
	// unanswerable question is never a pass.
	const b = benchOf(t);
	const jobId = "cp-base-unreachable";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	mergeAndAbsorb(b, jobId, worktree, "export const x = 44;\n");

	const calls: string[][] = [];
	const gate = await b
		.teardownWith(
			recordingGit(calls, (args) =>
				isBaseLsRemote("main")(args as string[]) ? { status: 128, stdout: "", stderr: "fatal: could not read from remote" } : undefined,
			),
		)
		.checkGates(worktree, jobId, "ship");
	assert.equal(gate.ok, false, "origin could not be asked, so nothing is proven");
	assert.equal(gate.ok === false && gate.failure.code, "unpushed");
	assert.equal(asked(calls, readsBaseTrackingRef("main")), false, "and it does not fall back to the tracking ref");
});

test("ship: with a merge receipt for this head, the base is never consulted at all", { timeout: 60_000 }, async (t) => {
	// The receipt stays the primary evidence, checked first; the tree diff is the
	// fallback behind it.
	const b = benchOf(t);
	const jobId = "cp-receipt-first";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 45;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "bump x to 45");
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	const head = git(worktree, "rev-parse", "HEAD");
	const mergeCommit = squashMergeAndDeleteHead(b.repo, jobId);
	git(worktree, "fetch", "--quiet", "--prune", "origin");
	const merges = new MergeStore({
		home: b.home,
		fleet: b.fleet,
		runs: b.runs,
		run: ghMerged({ branch: jobId, headSha: head, mergeCommit, number: 57 }),
	});
	await merges.record({ jobId, pr: "57", strategy: "squash" });

	const calls: string[][] = [];
	const gate = await b.teardownWith(recordingGit(calls)).checkGates(worktree, jobId, "ship");
	assert.deepEqual(gate, { ok: true, reason: "merged" });
	assert.equal(asked(calls, isBaseLsRemote("main")), false, "the base is not asked about");
	assert.equal(asked(calls, readsBaseTrackingRef("main")), false);
	assert.equal(asked(calls, (args) => args[0] === "diff"), false, "and no tree diff is run");
});

test("ship: a merge receipt covers the merged head only, never later commits", { timeout: 60_000 }, async (t) => {
	// A receipt says "this head landed", not "this branch is finished": work
	// committed after the merge is on no remote and in no PR, so it is refused
	// with the sha that actually landed named in the message.
	const b = benchOf(t);
	const jobId = "cp-after-merge";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 11;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "the merged work");
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	const merged = git(worktree, "rev-parse", "HEAD");
	const mergeCommit = squashMergeAndDeleteHead(b.repo, jobId);
	git(worktree, "fetch", "--quiet", "--prune", "origin");
	const merges = new MergeStore({
		home: b.home,
		fleet: b.fleet,
		runs: b.runs,
		run: ghMerged({ branch: jobId, headSha: merged, mergeCommit, number: 56 }),
	});
	await merges.record({ jobId, pr: "56" });
	assert.deepEqual(await b.teardown.checkGates(worktree, jobId, "ship"), { ok: true, reason: "merged" });

	writeFileSync(join(worktree, "src/app.ts"), "export const x = 12;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "one more, after the merge");
	const gate = await b.teardown.checkGates(worktree, jobId, "ship");
	assert.equal(gate.ok, false);
	assert.equal(gate.ok === false && gate.failure.code, "unpushed");
	assert.match(gate.ok === false ? gate.failure.message : "", /landed nowhere/);
});

test("ship: a merged, head-deleted job can still be forced, and force still proves nothing", { timeout: 60_000 }, async (t) => {
	// `force` is unchanged by cp-vk1: it remains operator authorization for the
	// genuinely unprovable case (no gh, no network, a vanished worktree), it is
	// recorded, and it claims no pass reason.
	const b = benchOf(t);
	const jobId = "cp-forced-merge";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 13;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "unprovable work");

	const refused = await b.teardown.teardown(jobId);
	assert.equal(refused.torn_down, false);
	assert.equal(refused.failure?.code, "unpushed");

	const forced = await b.teardown.teardown(jobId, { force: true });
	assert.equal(forced.torn_down, true, formatTeardown(forced));
	assert.equal(forced.reason, undefined, "nothing was proven, so nothing is claimed");
	assert.equal(b.fleet.require(jobId).closed_reason, "forced");
});

test("ship: a branch that was never pushed and never merged is refused", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const worktree = b.worktree("cp-never");
	await b.addJob("cp-never", worktree);
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 3;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "unpushed work");

	const result = await b.teardown.teardown("cp-never");
	assert.equal(result.torn_down, false);
	assert.equal(result.failure?.code, "unpushed");
	assert.match(result.failure?.message ?? "", /no upstream, is not on origin/);
	assert.equal(b.fleet.require("cp-never").phase, "held");

	// A branch that tracks origin but is behind its own remote ref is refused
	// with the other message: the tip on origin is not what we have.
	git(worktree, "push", "--quiet", "-u", "origin", "cp-never");
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 4;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "one more, unpushed");
	const behind = await b.teardown.teardown("cp-never");
	assert.equal(behind.failure?.code, "unpushed");
	assert.match(behind.failure?.message ?? "", /!= origin\/cp-never/);
});

test("failed ship: pushed but unreported head keeps its lease until reported or merged", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const jobId = "cp-unreported-head";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	await b.fleet.patch(jobId, { phase: "failed", failure: { class: "wall_clock_exceeded", message: "bound", at: isoTimestamp() } });
	await b.fleet.mutate((jobs) => { delete jobs.find((job) => job.job_id === jobId)!.reported_at; });
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 99;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "work before bound");
	git(worktree, "push", "--quiet", "origin", jobId);
	const head = git(worktree, "rev-parse", "HEAD");

	const refused = await b.teardown.teardown(jobId);
	assert.equal(refused.failure?.code, "unreported_head");
	assert.equal(refused.lease_returned, false);
	assert.equal(b.fleet.require(jobId).phase, "failed");

	const file = join(b.home, paths.envelopeFile(jobId));
	mkdirSync(join(b.home, paths.runDir(jobId)), { recursive: true });
	const envelope = (sha: string) => ({ schema_version: SCHEMA_VERSION, job_id: jobId, received_at: isoTimestamp(), attempt: 1,
		envelope: { job_id: jobId, kind: "ship", status: "done", summary: "Shipped.", branch: jobId, head_sha: sha, pr_url: "https://github.com/o/r/pull/1" } });
	writeFileSync(file, JSON.stringify(envelope("0".repeat(40))));
	assert.equal((await b.teardown.teardown(jobId)).failure?.code, "unreported_head", "stale report cannot release the lease");
	writeFileSync(file, JSON.stringify(envelope(head)));
	assert.equal((await b.teardown.teardown(jobId)).failure?.code, "unreported_head", "a filed report without intake acceptance is not evidence");
	const received = b.runs.open(jobId).markEnvelope({ generation: 1, attempt: 1 });
	await b.fleet.patch(jobId, { reported_at: received.ts });
	writeFileSync(file, JSON.stringify({ ...envelope(head), attempt: 2 }));
	assert.equal((await b.teardown.teardown(jobId)).failure?.code, "unreported_head", "the accepted attempt must match the filed report");
	writeFileSync(file, JSON.stringify(envelope(head)));
	const accepted = await b.teardown.teardown(jobId);
	assert.equal(accepted.torn_down, true, formatTeardown(accepted));
	assert.equal(accepted.reason, "pushed");
});

test("failed ship: a previous generation's report cannot release the current lease", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const jobId = "cp-stale-generation";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	git(worktree, "push", "--quiet", "origin", jobId);
	const head = git(worktree, "rev-parse", "HEAD");
	const file = join(b.home, paths.envelopeFile(jobId));
	mkdirSync(join(b.home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: jobId, received_at: isoTimestamp(), attempt: 1,
		envelope: { job_id: jobId, kind: "ship", status: "done", summary: "Shipped.", branch: jobId, head_sha: head, pr_url: "https://github.com/o/r/pull/2" } }));
	b.runs.open(jobId).markEnvelope({ generation: 1, attempt: 1 });
	await b.fleet.patch(jobId, { phase: "failed", supersessions: 1, failure: { class: "wall_clock_exceeded", message: "bound", at: isoTimestamp() } });
	const refused = await b.teardown.teardown(jobId);
	assert.equal(refused.failure?.code, "unreported_head");
	assert.equal(refused.lease_returned, false);
	assert.equal(b.fleet.require(jobId).phase, "failed");
});

test("failed ship: exact merged receipt clears unreported head; force remains unverified", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const jobId = "cp-bound-merged";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	await b.fleet.patch(jobId, { phase: "failed", failure: { class: "wall_clock_exceeded", message: "bound", at: isoTimestamp() } });
	await b.fleet.mutate((jobs) => { delete jobs.find((job) => job.job_id === jobId)!.reported_at; });
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 42;\n");
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", "merged work");
	git(worktree, "push", "--quiet", "origin", jobId);
	const head = git(worktree, "rev-parse", "HEAD");
	const mergeCommit = squashMergeAndDeleteHead(b.repo, jobId);
	const merges = new MergeStore({ home: b.home, fleet: b.fleet, runs: b.runs,
		run: ghMerged({ branch: jobId, headSha: head, mergeCommit, number: 58 }) });
	await merges.record({ jobId, pr: "58" });
	const merged = await b.teardown.teardown(jobId);
	assert.equal(merged.torn_down, true, formatTeardown(merged));
	assert.equal(merged.reason, "merged");

	const other = "cp-bound-forced";
	const otherTree = b.worktree(other);
	await b.addJob(other, otherTree);
	await b.fleet.patch(other, { phase: "failed", failure: { class: "wall_clock_exceeded", message: "bound", at: isoTimestamp() } });
	await b.fleet.mutate((jobs) => { delete jobs.find((job) => job.job_id === other)!.reported_at; });
	git(otherTree, "push", "--quiet", "origin", other);
	assert.equal((await b.teardown.teardown(other)).failure?.code, "unreported_head");
	const forced = await b.teardown.teardown(other, { force: true });
	assert.equal(forced.torn_down, true);
	assert.equal(forced.reason, undefined);
	assert.equal(b.fleet.require(other).closed_reason, "forced");
});


test("research: clean and commit-free passes; a local commit is refused", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);

	const cleanTree = b.worktree("cp-research");
	await b.addJob("cp-research", cleanTree, "research");
	const clean = await b.teardown.teardown("cp-research");
	assert.equal(clean.torn_down, true, formatTeardown(clean));
	assert.equal(clean.reason, "clean_research");

	const committedTree = b.worktree("cp-research2");
	await b.addJob("cp-research2", committedTree, "research");
	writeFileSync(join(committedTree, "notes.md"), "I changed the repo I was only supposed to read\n");
	git(committedTree, "add", "-A");
	git(committedTree, "commit", "--quiet", "-m", "should not exist");
	const committed = await b.teardown.teardown("cp-research2");
	assert.equal(committed.torn_down, false);
	assert.equal(committed.failure?.code, "research_commits");
	assert.match(committed.failure?.fix ?? "", /research changes nothing/);
});

// ---------------------------------------------------------------------------
// issue #2: a live worker with no report
// ---------------------------------------------------------------------------

async function addLiveUnreported(b: Bench, jobId: string): Promise<string> {
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree, "research");
	// The bench pid is process.pid: alive, and owned by no manager here.
	await b.fleet.mutate((jobs) => {
		const job = jobs.find((entry) => entry.job_id === jobId)!;
		delete job.reported_at;
		job.phase = "waiting";
		if (!("script" in job)) delete job.worker.exited_at;
	});
	return worktree;
}

test("cp-t9yr F1: an unmanaged live worker is refused under every call shape; force and a quote do not skip it", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const jobId = "cp-live-unreported";
	await addLiveUnreported(b, jobId);
	const journaled: DurableWakeupInput[] = [];
	const teardown = b.withJournal((input) => journaled.push(input));
	const quote = "Kill cp-live-unreported now.";
	const shapes = [
		{},
		{ force: true },
		{ force: true, requireAuthorization: true },
		{ force: true, requireAuthorization: true, authorization: { by: "operator-quote", quote } },
		{ acceptUnreported: "pipeline hand-off" },
	];
	const refusals = () => readRunEvents(b.home, jobId).filter((event) => event.type === "teardown_refused").length;
	for (const [index, shape] of shapes.entries()) {
		const refused = await teardown.teardown(jobId, shape);
		assert.equal(refused.failure?.code, "unmanaged_live_worker", JSON.stringify(shape));
		assert.equal(refused.lease_returned, false);
		assert.equal(refused.torn_down, false);
		assert.equal(refused.killed_unreported, undefined);
		assert.match(refused.failure?.fix ?? "", /keep the lease/);
		assert.equal(b.fleet.require(jobId).phase, "waiting");
		assert.equal(refusals(), index + 1, `one teardown_refused per call: ${JSON.stringify(shape)}`);
	}
	assert.equal(journaled.length, 0);
	assert.doesNotThrow(() => process.kill(process.pid, 0));
	for (const phase of ["held", "failed"] as const) {
		const before = refusals();
		await b.fleet.mutate((jobs) => {
			const job = jobs.find((entry) => entry.job_id === jobId)!;
			job.phase = phase;
			job.reported_at = isoTimestamp();
			if (phase === "failed") job.failure = { class: "crash", message: "exit 1", at: isoTimestamp() };
		});
		const refused = await teardown.teardown(jobId, { force: true });
		assert.equal(refused.failure?.code, "unmanaged_live_worker", phase);
		assert.equal(b.fleet.require(jobId).phase, phase);
		assert.equal(refusals(), before + 1, phase);
	}

	// `launching`: the fleet schema refuses to persist a model record in that phase,
	// so a read-through store serves it; the gate refuses before any lease or fleet write.
	const launching = { ...b.fleet.require(jobId), phase: "launching" } as FleetRecord;
	const fleet = { get: (id: string) => (id === jobId ? launching : undefined) } as unknown as FleetStore;
	const leases = { release: async () => assert.fail("a refused teardown never releases") } as unknown as LeaseManager;
	const viaLaunching = new Teardown({ home: b.home, fleet, leases, manager: b.manager, runs: b.runs, journal: (input) => journaled.push(input) });
	for (const shape of shapes) {
		const before = refusals();
		const refused = await viaLaunching.teardown(jobId, shape);
		assert.equal(refused.failure?.code, "unmanaged_live_worker", `launching ${JSON.stringify(shape)}`);
		assert.equal(refused.lease_returned, false);
		assert.equal(refusals(), before + 1);
	}
	assert.equal(journaled.length, 0);
});

test("cp-t9yr F1: a reported held job with a live unowned worker is refused even by the gated (integrate) path", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const live = "cp-gated-orphan";
	await b.addJob(live, b.worktree(live), "research");
	const setExited = (jobId: string, exited: boolean) => b.fleet.mutate((jobs) => {
		const job = jobs.find((entry) => entry.job_id === jobId)!;
		if ("script" in job) return;
		if (exited) job.worker.exited_at = isoTimestamp();
		else delete job.worker.exited_at;
	});
	await setExited(live, false);
	const refused = await b.teardown.teardown(live);
	assert.equal(refused.failure?.code, "unmanaged_live_worker");
	assert.equal(b.fleet.require(live).phase, "held");
	await setExited(live, true);
	const torn = await b.teardown.teardown(live);
	assert.equal(torn.torn_down, true, formatTeardown(torn));
	assert.equal(torn.reason, "clean_research");

	// An observed close in the run status is just as dead as a recorded exit.
	const observed = "cp-observed-orphan";
	await b.addJob(observed, b.worktree(observed), "research");
	await setExited(observed, false);
	const status = initialStatus(observed, {}, isoTimestamp());
	Object.assign(status, { phase: "exited", exited_at: isoTimestamp(), exit_code: 0 });
	mkdirSync(join(b.home, paths.runDir(observed)), { recursive: true });
	writeFileSync(join(b.home, paths.statusFile(observed)), JSON.stringify(status));
	const closed = await b.teardown.teardown(observed);
	assert.equal(closed.torn_down, true, formatTeardown(closed));
});

test("issue #2: hand-off and dead workers pass but say no report was filed", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const journaled: DurableWakeupInput[] = [];
	const teardown = b.withJournal((input) => journaled.push(input));

	// (a) The pipeline hand-off on a live unowned worker is refused: nothing here can observe its close.
	await addLiveUnreported(b, "cp-handoff");
	const handoff = await teardown.teardown("cp-handoff", { acceptUnreported: "pipeline hand-off" });
	assert.equal(handoff.failure?.code, "unmanaged_live_worker", formatTeardown(handoff));
	assert.equal(handoff.lease_returned, false);

	// (a2) Once that worker has exited, the hand-off tears down and says no report was filed.
	await b.fleet.mutate((jobs) => {
		const job = jobs.find((entry) => entry.job_id === "cp-handoff")!;
		if (!("script" in job)) job.worker.exited_at = isoTimestamp();
	});
	const after = await teardown.teardown("cp-handoff", { acceptUnreported: "pipeline hand-off" });
	assert.equal(after.torn_down, true, formatTeardown(after));
	assert.equal(after.reason, "clean_research");
	assert.equal(after.unreported, true);
	assert.equal(after.killed_unreported, undefined);
	assert.equal(journaled.length, 0);

	// (b) A worker that already exited is not live: the gates decide, and the line says no report.
	await addLiveUnreported(b, "cp-dead-unreported");
	await b.fleet.mutate((jobs) => {
		const job = jobs.find((entry) => entry.job_id === "cp-dead-unreported")!;
		if (!("script" in job)) job.worker.exited_at = isoTimestamp();
	});
	const dead = await teardown.teardown("cp-dead-unreported");
	assert.equal(dead.torn_down, true, formatTeardown(dead));
	assert.equal(dead.reason, "clean_research");
	assert.equal(dead.unreported, true);
	assert.match(formatTeardown(dead), /no report was filed/);
	assert.equal(journaled.length, 0);
});

test("unreportedLiveWorker: mid-turn wording, dead and reported workers, failed phase excluded", async (t) => {
	const b = benchOf(t);
	const reported = await b.addJob("cp-unit", join(b.home, "worktrees", "cp-unit"), "research");
	const { reported_at: _reportedAt, ...rest } = reported;
	const waiting = { ...rest, phase: "waiting" } as FleetRecord;
	assert.match(unreportedLiveWorker(b.home, waiting, { worker: { alive: true, busy: true } })?.message ?? "", /mid-turn/);
	assert.match(unreportedLiveWorker(b.home, waiting, { worker: { alive: true, busy: false } })?.message ?? "", /is alive/);
	assert.equal(unreportedLiveWorker(b.home, waiting, { worker: { alive: false, busy: false } }), undefined);
	assert.equal(unreportedLiveWorker(b.home, { ...reported, phase: "waiting" }, { worker: { alive: true, busy: true } }), undefined);
	assert.equal(unreportedLiveWorker(b.home, { ...waiting, phase: "failed" } as FleetRecord, { worker: { alive: true, busy: true } }), undefined);
});

test("issue #2: cp_teardown verifies operator_quote before anything runs", async () => {
	type Tool = { execute: (id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> };
	const tools = new Map<string, Tool>();
	const calls: unknown[] = [];
	registerIntegrateTools({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never) } as never, {
		commandPost: () => ({
			tearDown: async (id: string, options: unknown) => {
				calls.push(options);
				return { job_id: id, torn_down: false, worktree: "/w", branch: id, lease_returned: false, artifacts_removed: false };
			},
		}),
		setLive: () => {}, refreshWidget: () => {},
	} as never);
	const ctx = { sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "Yes, kill cp-x now." }] } }] } };
	const tool = tools.get("cp_teardown")!;
	const run = (params: Record<string, unknown>) => tool.execute("t", { job_id: "cp-x", ...params }, undefined, undefined, ctx);

	await run({ force: true });
	assert.deepEqual(calls[0], { force: true, requireAuthorization: true });
	await assert.rejects(() => run({ force: true, operator_quote: "made up" }), /quote not found in operator messages/);
	await assert.rejects(() => run({ operator_quote: "Yes, kill cp-x now." }), /operator_quote authorizes force/);
	assert.equal(calls.length, 1, "a refused quote never reaches teardown");
	await run({ force: true, operator_quote: "Yes, kill cp-x now." });
	assert.deepEqual(calls[1], { force: true, requireAuthorization: true, authorization: { by: "operator-quote", quote: "Yes, kill cp-x now." } });
	await run({});
	assert.deepEqual(calls[2], {});
});

// ---------------------------------------------------------------------------
// bookkeeping
// ---------------------------------------------------------------------------

test("a missing worktree is refused; force is authorization and is recorded", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const worktree = join(b.home, "worktrees", "cp-gone");
	await b.addJob("cp-gone", worktree);

	const refused = await b.teardown.teardown("cp-gone");
	assert.equal(refused.failure?.code, "worktree_missing");

	const forced = await b.teardown.teardown("cp-gone", { force: true });
	assert.equal(forced.torn_down, true);
	assert.equal(forced.reason, undefined, "nothing was proven, so nothing is claimed");
	assert.equal(b.fleet.require("cp-gone").phase, "done");
	// cp-8km: forced is recorded on the record itself, not just the run log, so
	// the Shipped predicate can tell a forced close from a gated one later.
	assert.equal(b.fleet.require("cp-gone").closed_reason, "forced");
	const markers = readRunEvents(b.home, "cp-gone").filter((event) => event.type === "shutdown_requested");
	assert.equal((markers.at(-1)?.payload as { forced?: boolean }).forced, true);
});

test("cp-a9fq: a lease treehouse did not return is never reported returned, forced or not; the job stays open", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const returns: string[] = [];
	const refusing = new LeaseManager({
		home: b.home,
		cwd: () => b.home,
		runner: async (_bin, args) => {
			returns.push(args.join(" "));
			return { status: 1, stdout: "", stderr: "treehouse: worktree is in use by pid 4242" };
		},
	});
	const teardown = new Teardown({ home: b.home, fleet: b.fleet, leases: refusing, manager: b.manager, runs: b.runs });

	// forced (the cp-aqzo hazard: ignoreErrors used to turn this into lease_returned:true + done)
	const gone = join(b.home, "worktrees", "cp-stuck");
	await b.addJob("cp-stuck", gone);
	const forced = await teardown.teardown("cp-stuck", { force: true });
	assert.equal(forced.torn_down, false, formatTeardown(forced));
	assert.equal(forced.lease_returned, false);
	assert.equal(forced.failure?.code, "lease_return_failed");
	assert.match(forced.failure?.message ?? "", /worktree is in use by pid 4242/);
	assert.match(formatTeardown(forced), /kept: lease_return_failed/);
	assert.equal(b.fleet.require("cp-stuck").phase, "held", "not done: the lease is still held");
	assert.equal(b.fleet.require("cp-stuck").closed_reason, undefined);
	assert.equal(readRunEvents(b.home, "cp-stuck").filter((event) => event.type === "teardown_refused").length, 1);

	// gated: the same named failure, not a thrown LeaseError
	const pushed = b.worktree("cp-stuck-gated");
	await b.addJob("cp-stuck-gated", pushed);
	git(pushed, "push", "--quiet", "-u", "origin", "cp-stuck-gated");
	const gated = await teardown.teardown("cp-stuck-gated");
	assert.equal(gated.torn_down, false);
	assert.equal(gated.lease_returned, false);
	assert.equal(gated.failure?.code, "lease_return_failed");
	assert.equal(b.fleet.require("cp-stuck-gated").phase, "held");
	assert.equal(returns.length, 2, "each teardown asked treehouse exactly once");
});

test("cp-a9fq: after lease_return_failed the lease and job are kept until a re-run teardown's return is confirmed", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const jobId = "cp-retry-return";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	// A dead held worker, as the failed attempt leaves it: no recorded exit on the
	// fleet record, a pid that is gone, and no manager entry.
	const deadPid = spawnSync("true").pid as number;
	const held = b.fleet.require(jobId);
	if (isScriptFleetRecord(held)) assert.fail("ship job expected");
	const { exited_at: _gone, ...worker } = held.worker;
	await b.fleet.patch(jobId, { worker: { ...worker, pid: deadPid } });

	let treehouseReturns = 1;
	const returns: string[] = [];
	const leases = new LeaseManager({
		home: b.home,
		cwd: () => b.home,
		runner: async (_bin, args) => {
			returns.push(String(args.at(-1)));
			return treehouseReturns-- > 0 ? { status: 1, stdout: "", stderr: "treehouse: worktree is busy" } : { status: 0, stdout: "", stderr: "" };
		},
	});
	const teardown = new Teardown({ home: b.home, fleet: b.fleet, leases, manager: b.manager, runs: b.runs });

	const first = await teardown.teardown(jobId);
	assert.equal(first.failure?.code, "lease_return_failed");
	assert.equal(first.lease_returned, false);
	assert.equal(b.fleet.require(jobId).phase, "held", "still held: the lease was not confirmed returned");
	assert.equal(b.fleet.require(jobId).closed_at, undefined);

	const second = await teardown.teardown(jobId);
	assert.equal(second.torn_down, true, formatTeardown(second));
	assert.equal(second.lease_returned, true);
	assert.equal(second.reason, "pushed");
	assert.equal(b.fleet.require(jobId).phase, "done");
	assert.equal(b.fleet.require(jobId).closed_reason, "gated");
	assert.deepEqual(returns, [worktree, worktree], "one treehouse return per teardown, the second confirmed");
});

test("cp-a9fq: teardown refuses while automatic recovery owns the job, and owns the job while it runs", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const jobId = "cp-reviving";
	await b.addJob(jobId, join(b.home, "worktrees", jobId));
	const claims: JobClaims = new Map([[jobId, "recovery"]]);
	const never = { release: async () => assert.fail("a refused teardown never releases") } as unknown as LeaseManager;
	const refused = await new Teardown({ home: b.home, fleet: b.fleet, leases: never, manager: b.manager, runs: b.runs, claims })
		.teardown(jobId, { force: true });
	assert.equal(refused.torn_down, false);
	assert.equal(refused.lease_returned, false);
	assert.equal(refused.failure?.code, "job_in_flight");
	assert.match(refused.failure?.fix ?? "", /keep the lease; wait/);
	assert.equal(b.fleet.require(jobId).phase, "held", "a refusal changes nothing");
	assert.equal(claims.get(jobId), "recovery", "the refusal never takes recovery's claim");

	// Recovery settled: the teardown goes through, and holds the job until it is done.
	claims.delete(jobId);
	const ok = new LeaseManager({ home: b.home, cwd: () => b.home, runner: async () => ({ status: 0, stdout: "", stderr: "" }) });
	const running = new Teardown({ home: b.home, fleet: b.fleet, leases: ok, manager: b.manager, runs: b.runs, claims }).teardown(jobId, { force: true });
	assert.equal(claims.get(jobId), "teardown", "claimed synchronously, before the first await");
	const torn = await running;
	assert.equal(torn.torn_down, true, formatTeardown(torn));
	assert.equal(torn.lease_returned, true);
	assert.equal(claims.has(jobId), false, "released once settled");
});

test("a job whose events outlived its worker can still be torn down (cp-0wq7)", { timeout: 60_000 }, async (t) => {
	// The dead end: pi events landed after the observed close, the projection
	// went `working` with `exited_at` still set, and every path that opens the
	// run — cp_revive and cp_teardown alike — refused with "run status projection
	// is invalid". The job could be neither relaunched nor closed.
	const b = benchOf(t);
	const jobId = "cp-post-exit";
	const worktree = join(b.home, "worktrees", jobId);
	await b.addJob(jobId, worktree);
	const at = isoTimestamp();
	const log = [
		{ seq: 1, ts: at, job_id: jobId, source: "cp", type: "spawned", payload: { pid: 4242 } },
		{ seq: 2, ts: at, job_id: jobId, source: "pi", type: "agent_start", payload: {} },
		{ seq: 3, ts: at, job_id: jobId, source: "pi", type: "agent_settled", payload: {} },
		{ seq: 4, ts: at, job_id: jobId, source: "cp", type: "process_exit", payload: { code: 0, signal: null } },
		// The three that landed after the close, in the order the incident had them.
		{ seq: 5, ts: at, job_id: jobId, source: "pi", type: "agent_start", payload: {} },
		{ seq: 6, ts: at, job_id: jobId, source: "pi", type: "turn_start", payload: {} },
		{ seq: 7, ts: at, job_id: jobId, source: "pi", type: "message_start", payload: { message: { role: "user" } } },
	];
	mkdirSync(join(b.home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(join(b.home, paths.eventsFile(jobId)), log.map((event) => `${JSON.stringify(event)}\n`).join(""));

	const forced = await b.teardown.teardown(jobId, { force: true });
	assert.equal(forced.torn_down, true, formatTeardown(forced));
	assert.equal(b.fleet.require(jobId).phase, "done");
	const markers = readRunEvents(b.home, jobId).filter((event) => event.type === "shutdown_requested");
	assert.equal(markers.length, 1, "the teardown marker reached the log the projection used to block");
});

test("a normal (gated) teardown is marked closed_reason:gated, never left ambiguous", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const worktree = b.worktree("cp-gated");
	await b.addJob("cp-gated", worktree);
	git(worktree, "push", "--quiet", "-u", "origin", "cp-gated");

	const result = await b.teardown.teardown("cp-gated");
	assert.equal(result.torn_down, true);
	assert.equal(b.fleet.require("cp-gated").closed_reason, "gated");
});

test("t3code adoption 7: teardown deletes the job's checkpoint ref; a missing one is not a failure", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	for (const jobId of ["cp-ckpt", "cp-ckpt-gone"]) {
		const worktree = b.worktree(jobId);
		await b.addJob(jobId, worktree);
		await b.fleet.patch(jobId, { checkpoint_ref: `refs/cp-checkpoints/${jobId}` });
		git(worktree, "push", "--quiet", "-u", "origin", jobId);
	}
	git(b.repo.path, "update-ref", "refs/cp-checkpoints/cp-ckpt", "HEAD");

	const torn = await b.teardown.teardown("cp-ckpt");
	assert.equal(torn.torn_down, true);
	assert.equal(git(b.repo.path, "for-each-ref", "refs/cp-checkpoints/"), "", "the clone's git dir keeps no checkpoint ref");
	const missing = await b.teardown.teardown("cp-ckpt-gone");
	assert.equal(missing.torn_down, true, missing.failure?.message);
	assert.equal(missing.lease_returned, true);
});

test("teardown is idempotent and refuses unknown jobs", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const worktree = b.worktree("cp-twice");
	await b.addJob("cp-twice", worktree, "research");

	const first = await b.teardown.teardown("cp-twice");
	assert.equal(first.torn_down, true);
	const second = await b.teardown.teardown("cp-twice");
	assert.equal(second.torn_down, false, "already done");
	assert.equal(second.failure, undefined);
	await assert.rejects(() => b.teardown.teardown("cp-unknown"), /no fleet record/);
});

test("artifacts are removed only when the caller asks", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const worktree = b.worktree("cp-artifact");
	await b.addJob("cp-artifact", worktree, "research");
	const artifactDir = join(b.home, paths.artifactDir("cp-artifact"));
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "report.md"), "# findings\n");

	const kept = await b.teardown.teardown("cp-artifact");
	assert.equal(kept.artifacts_removed, false);
	assert.ok(existsSync(artifactDir), "the artifact outlives the worktree by default");

	// A second command post, configured to clean up, on a fresh job.
	const cleaning = new Teardown({
		home: b.home,
		fleet: b.fleet,
		leases: new LeaseManager({
			home: b.home,
			cwd: () => b.home,
			runner: async () => ({ status: 0, stdout: "", stderr: "" }),
		}),
		manager: b.manager,
		runs: b.runs,
		removeArtifacts: true,
	});
	const second = b.worktree("cp-artifact2");
	await b.addJob("cp-artifact2", second, "research");
	const dir2 = join(b.home, paths.artifactDir("cp-artifact2"));
	mkdirSync(dir2, { recursive: true });
	writeFileSync(join(dir2, "report.md"), "# findings\n");
	const removed = await cleaning.teardown("cp-artifact2");
	assert.equal(removed.artifacts_removed, true);
	assert.equal(existsSync(dir2), false);
});

// ---------------------------------------------------------------------------
// the real thing: a live worker and a real lease
// ---------------------------------------------------------------------------

test(
	"teardown returns a real lease and observes the worker's close",
	{ skip: treehouseAvailable() ? false : "treehouse not on PATH", timeout: 120_000 },
	async (t) => {
		const jobId = "cp-live-teardown";
		const home = createScratchHome();
		const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
		const pool = enableTreehouse(repo.path);
		const provider = await MockProvider.start();
		const agentDir = createAgentDir({ provider });
		const model = provider.addScript("teardown", [{ kind: "text", text: "idle" }]);
		agentDir.writeModels(provider);

		const fleet = new FleetStore({ home: home.path });
		const runs = new RunRegistry(home.path);
		const leases = new LeaseManager({ home: home.path, cwd: () => home.path });
		const manager = new WorkerManager({
			home: home.path,
			workerReporterPath: WORKER_REPORTER_EXTENSION,
			parentEnv: { ...process.env, ...agentDir.env },
		});
		t.after(async () => {
			await manager.shutdownAll();
			runs.closeAll();
			pool.cleanup();
			agentDir.cleanup();
			repo.cleanup();
			home.cleanup();
			await provider.stop();
		});

		const lease = await leases.acquire(repo.path, { holder: jobId, project: "demo" });
		git(lease.path, "switch", "--quiet", "-c", jobId, "origin/main");
		const runDir = join(home.path, paths.runDir(jobId));
		mkdirSync(runDir, { recursive: true });
		const managed = manager.spawn({
			identity: { jobId, kind: "ship", delivery: "pr", runDir, worktree: lease.path },
			profile: loadProfile(PROFILES_DIR, "implementer"),
			model,
			sessionDir: join(home.path, "sessions"),
		});
		runs.open(jobId).markSpawned({ pid: managed.worker.pid, model, profile: "implementer" });
		runs.open(jobId).attach(managed.worker);
		await managed.worker.getState(30_000);

		await fleet.add({
			job_id: jobId,
			project: "demo",
			kind: "ship",
			delivery: "pr",
			origin: DEFAULT_ORIGIN,
			phase: "held",
			reported_at: isoTimestamp(),
			worker: {
				pid: managed.worker.pid as number,
				session_id: "s",
				session_file: join(home.path, "sessions/s.jsonl"),
				profile: "implementer",
				role: "implementer",
				model,
				started_at: isoTimestamp(),
			},
			worktree: lease.path,
			...(lease.lease_id ? { lease_id: lease.lease_id } : {}),
			branch: jobId,
			dispatched_at: isoTimestamp(),
			usage: EMPTY_USAGE,
		});

		// Nothing to push: the branch is exactly origin/main.
		const teardown = new Teardown({ home: home.path, fleet, leases, manager, runs });
		const result = await teardown.teardown(jobId);

		assert.equal(result.torn_down, true, formatTeardown(result));
		assert.equal(result.lease_returned, true);
		assert.equal(result.exit_code, 0, "the worker's close was observed, not assumed");
		assert.equal(managed.worker.alive, false);
		assert.equal(manager.active.length, 0);
		assert.ok(!/leased/.test(treehouse(repo.path, "status")), "the pool got its worktree back");
		assert.equal(fleet.require(jobId).phase, "done");
		assert.ok(fleet.require(jobId).worker.exited_at);
	},
);

// ---------------------------------------------------------------------------
// delivery does not relax the gate (T29, settled after the live run)
// ---------------------------------------------------------------------------

test("ship + delivery:local: committed but unpushed is still refused", { timeout: 60_000 }, async (t) => {
	// `delivery:local` means "no PR, and the parent does not hold the worker".
	// It does NOT mean "do not publish": returning a lease recycles the worktree
	// and the branch survives only in projects/<name>, a clone-on-demand cache
	// the system may delete. Work that lives only there is parked, not
	// delivered, so the push demand applies to every ship job.
	const b = benchOf(t);
	const jobId = "cp-local-unpushed";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree, "ship", "local");

	writeFileSync(join(worktree, "src/app.ts"), "export const x = 2;\n");
	git(worktree, "add", "-A");
	git(worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "bump x");

	const refused = await b.teardown.teardown(jobId);
	assert.equal(refused.torn_down, false, "an unpushed local ship job keeps its lease");
	assert.equal(refused.failure?.code, "unpushed");
	assert.equal(readFleet(b.home).jobs[0]?.phase, "held", "a refusal changes nothing");

	// Push, and the same job passes — with the same reason a pr job gets.
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	const torn = await b.teardown.teardown(jobId);
	assert.equal(torn.torn_down, true, JSON.stringify(torn));
	assert.equal(torn.reason, "pushed");
	assert.ok(b.repo.remoteBranches().includes(jobId), "the work is on the remote, off this machine");
});

test("ship: work on a detached HEAD is refused as unreachable, not as unpushed", { timeout: 60_000 }, async (t) => {
	// Measured (T29): `treehouse return` recycles the worktree for the next job,
	// while refs/heads/<branch> survives in the clone. So a commit no branch
	// points at is lost as soon as the slot is reused — a different failure from
	// "not pushed", and the ported gate could only report the misleading one.
	const b = benchOf(t);
	const jobId = "cp-detached";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree, "ship", "pr");

	git(worktree, "checkout", "--quiet", "--detach");
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 3;\n");
	git(worktree, "add", "-A");
	git(worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "detached work");

	const gate = await b.teardown.checkGates(worktree, jobId, "ship");
	assert.equal(gate.ok, false);
	assert.equal(gate.ok === false && gate.failure.code, "unreachable_work");
	assert.match(gate.ok === false ? gate.failure.message : "", /not the tip of/);
	assert.match(gate.ok === false ? gate.failure.fix : "", /keep the lease/);

	const refused = await b.teardown.teardown(jobId);
	assert.equal(refused.torn_down, false);
	assert.equal(refused.failure?.code, "unreachable_work");
});

// ---------------------------------------------------------------------------
// the diff-review gate (cp-diffgate Stage C): opt-in, and invisible without it
// ---------------------------------------------------------------------------

/** A pipeline record for a ship job, with or without the diff-review opt-in. */
function writePipeline(home: string, shipId: string, review?: { enabled: boolean }): PipelineRecord {
	const full: PipelineRecord = {
		schema_version: SCHEMA_VERSION,
		research_id: `${shipId}-research`,
		ship_id: shipId,
		project: "demo",
		delivery: "pr",
		state: "implementing",
		created_at: isoTimestamp(),
		updated_at: isoTimestamp(),
		...(review ? { review } : {}),
	};
	return new PipelineStore(home).write(full);
}

/** One diff-review attempt file, exactly as `DiffReview` persists it. */
function writeReview(
	home: string,
	jobId: string,
	input: { attempt?: number; verdict: GateVerdictValue; cause?: GateCause; head_sha: string; truncated?: boolean },
): DiffVerdict {
	const attempt = input.attempt ?? 1;
	const verdict: DiffVerdict = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		attempt,
		verdict: input.verdict,
		cause: input.cause ?? null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["the reviewer said something bounded"],
		decided_at: isoTimestamp(),
		head_sha: input.head_sha,
		diff_stat: { files: 1, truncated: input.truncated ?? false },
	};
	atomicWriteJson(join(home, paths.reviewFile(jobId, attempt)), verdict);
	return verdict;
}

/** The second, post-diff authorization a human gives to clear a flagged escalate. */
function approveDiffCheckpoint(home: string, jobId: string, decision: Checkpoint["decision"] = "approved"): void {
	const checkpoint: Checkpoint = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		question: `ship ${jobId} despite the flagged diff review?`,
		requested_at: isoTimestamp(),
		decision,
		...(decision === "pending" ? {} : { decided_at: isoTimestamp(), decided_by: "operator" }),
	};
	atomicWriteJson(join(home, paths.checkpointFile(jobId, "diff")), checkpoint);
}

/** A pushed ship job on its own branch: the state every review case starts from. */
async function pushedShipJob(b: Bench, jobId: string): Promise<{ worktree: string; head: string }> {
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree, "ship", "pr");
	writeFileSync(join(worktree, "src/app.ts"), `export const x = ${jobId.length};\n`);
	git(worktree, "add", "-A");
	git(worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", `work for ${jobId}`);
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	return { worktree, head: git(worktree, "rev-parse", "HEAD") };
}

test("review opt-in with no verdict at all is refused as review_missing", { timeout: 60_000 }, async (t) => {
	// (a) The gate exists so a reviewed-by-nobody diff cannot be closed out by
	// returning the lease. A refusal keeps everything: the lease, the record.
	const b = benchOf(t);
	const jobId = "cp-review-missing";
	const { worktree } = await pushedShipJob(b, jobId);
	writePipeline(b.home, jobId, { enabled: true });

	const gate = await b.teardown.checkGates(worktree, jobId, "ship");
	assert.equal(gate.ok, false);
	assert.equal(gate.ok === false && gate.failure.code, "review_missing");
	assert.match(gate.ok === false ? gate.failure.fix : "", /cp_review/);

	const refused = await b.teardown.teardown(jobId);
	assert.equal(refused.torn_down, false);
	assert.equal(refused.failure?.code, "review_missing");
	assert.equal(refused.lease_returned, false, "a refusal returns nothing");
	assert.equal(b.fleet.require(jobId).phase, "held", "a refused teardown changes nothing");
});

test("a pass verdict on this HEAD lets teardown proceed exactly as today", { timeout: 60_000 }, async (t) => {
	// (b) The opt-in adds a question, not a new answer: a cleared review leaves
	// the git gate's own pass reason untouched.
	const b = benchOf(t);
	const jobId = "cp-review-pass";
	const { worktree, head } = await pushedShipJob(b, jobId);
	writePipeline(b.home, jobId, { enabled: true });
	writeReview(b.home, jobId, { verdict: "pass", head_sha: head });

	assert.deepEqual(await b.teardown.checkGates(worktree, jobId, "ship"), { ok: true, reason: "pushed" });
	const torn = await b.teardown.teardown(jobId);
	assert.equal(torn.torn_down, true, formatTeardown(torn));
	assert.equal(torn.reason, "pushed");
	assert.equal(b.fleet.require(jobId).closed_reason, "gated");
});

test("a truncated subject never clears teardown: not a historical pass, not an approved flag", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const jobId = "cp-review-partial";
	const job = await pushedShipJob(b, jobId);
	writePipeline(b.home, jobId, { enabled: true });
	writeReview(b.home, jobId, { verdict: "pass", head_sha: job.head, truncated: true });
	const pass = await b.teardown.checkGates(job.worktree, jobId, "ship");
	assert.equal(pass.ok === false && pass.failure.code, "review_escalated");
	assert.match(pass.ok === false ? pass.failure.message : "", /truncated subject/);
	writeReview(b.home, jobId, { attempt: 2, verdict: "escalate", cause: "flagged", head_sha: job.head, truncated: true });
	approveDiffCheckpoint(b.home, jobId);
	const flagged = await b.teardown.checkGates(job.worktree, jobId, "ship");
	assert.equal(flagged.ok === false && flagged.failure.code, "review_escalated");

	// On another head the answer is a re-review, not an escalation: head before truncation.
	writeReview(b.home, jobId, { attempt: 3, verdict: "pass", head_sha: "f".repeat(40), truncated: true });
	const moved = await b.teardown.checkGates(job.worktree, jobId, "ship");
	assert.equal(moved.ok === false && moved.failure.code, "review_pending");
});

test("a flagged escalate needs an approved diff checkpoint, and nothing else clears it", { timeout: 60_000 }, async (t) => {
	// (c) Evidence is not authorization, and neither is its absence: only a human
	// answer on the second (diff) checkpoint turns a flagged escalate into a
	// teardown. A policy escalate is not clearable this way at all.
	const b = benchOf(t);

	const flagged = "cp-review-flagged";
	const first = await pushedShipJob(b, flagged);
	writePipeline(b.home, flagged, { enabled: true });
	writeReview(b.home, flagged, { verdict: "escalate", cause: "flagged", head_sha: first.head });

	const unapproved = await b.teardown.checkGates(first.worktree, flagged, "ship");
	assert.equal(unapproved.ok === false && unapproved.failure.code, "review_escalated");
	approveDiffCheckpoint(b.home, flagged, "pending");
	const stillPending = await b.teardown.checkGates(first.worktree, flagged, "ship");
	assert.equal(stillPending.ok === false && stillPending.failure.code, "review_escalated", "pending is not approved");

	approveDiffCheckpoint(b.home, flagged);
	assert.deepEqual(await b.teardown.checkGates(first.worktree, flagged, "ship"), { ok: true, reason: "pushed" });
	const torn = await b.teardown.teardown(flagged);
	assert.equal(torn.torn_down, true, formatTeardown(torn));

	// A policy escalate: the same approval does not apply, because the reviewer
	// never found the diff sound.
	const policy = "cp-review-policy";
	const second = await pushedShipJob(b, policy);
	writePipeline(b.home, policy, { enabled: true });
	writeReview(b.home, policy, { verdict: "escalate", cause: "policy", head_sha: second.head });
	approveDiffCheckpoint(b.home, policy);
	const refusedPolicy = await b.teardown.checkGates(second.worktree, policy, "ship");
	assert.equal(refusedPolicy.ok === false && refusedPolicy.failure.code, "review_escalated");
	assert.match(refusedPolicy.ok === false ? refusedPolicy.failure.message : "", /policy/);
});

test("a verdict on another commit is stale, and a revise is unfinished", { timeout: 60_000 }, async (t) => {
	// (d) The head_sha on the verdict is the "has the code changed" signal: a pass
	// on a commit that is no longer HEAD says nothing about what would merge.
	const b = benchOf(t);
	const jobId = "cp-review-stale";
	const { worktree, head } = await pushedShipJob(b, jobId);
	writePipeline(b.home, jobId, { enabled: true });
	writeReview(b.home, jobId, { verdict: "pass", head_sha: "0".repeat(40) });

	const stale = await b.teardown.checkGates(worktree, jobId, "ship");
	assert.equal(stale.ok === false && stale.failure.code, "review_pending");
	assert.match(stale.ok === false ? stale.failure.message : "", /HEAD is/);

	// Re-reviewed at the real HEAD, but the answer was "revise": still unfinished.
	writeReview(b.home, jobId, { attempt: 2, verdict: "revise", head_sha: head });
	const revise = await b.teardown.checkGates(worktree, jobId, "ship");
	assert.equal(revise.ok === false && revise.failure.code, "review_pending");
	assert.match(revise.ok === false ? revise.failure.message : "", /attempt 2/, "the latest attempt decides");

	// The third attempt passes on this HEAD, and only then does teardown proceed.
	writeReview(b.home, jobId, { attempt: 3, verdict: "pass", head_sha: head });
	assert.deepEqual(await b.teardown.checkGates(worktree, jobId, "ship"), { ok: true, reason: "pushed" });
});

test("force bypasses the review gate like every other gate, and says so", { timeout: 60_000 }, async (t) => {
	// (e) `force` is operator authorization, not a shortcut: it is recorded, and
	// it still claims no pass reason, because nothing was proven.
	const b = benchOf(t);
	const jobId = "cp-review-forced";
	await pushedShipJob(b, jobId);
	writePipeline(b.home, jobId, { enabled: true });

	const refused = await b.teardown.teardown(jobId);
	assert.equal(refused.failure?.code, "review_missing");

	const forced = await b.teardown.teardown(jobId, { force: true });
	assert.equal(forced.torn_down, true, formatTeardown(forced));
	assert.equal(forced.reason, undefined, "nothing was proven, so nothing is claimed");
	assert.equal(b.fleet.require(jobId).closed_reason, "forced");
	const markers = readRunEvents(b.home, jobId).filter((event) => event.type === "shutdown_requested");
	assert.equal((markers.at(-1)?.payload as { forced?: boolean }).forced, true);
});

test("without the opt-in the review gate is invisible, verdict or no verdict", { timeout: 60_000 }, async (t) => {
	// (f) The regression guard. A job with no pipeline record, a record with no
	// `review` block, and a record with `review.enabled: false` all tear down
	// exactly as they did before this gate existed — even with a refusing verdict
	// sitting on disk, and even for research.
	const b = benchOf(t);

	const none = "cp-review-optout-none";
	const noRecord = await pushedShipJob(b, none);
	writeReview(b.home, none, { verdict: "escalate", cause: "policy", head_sha: "0".repeat(40) });
	assert.deepEqual(await b.teardown.checkGates(noRecord.worktree, none, "ship"), { ok: true, reason: "pushed" });

	const silent = "cp-review-optout-silent";
	const noReview = await pushedShipJob(b, silent);
	writePipeline(b.home, silent);
	writeReview(b.home, silent, { verdict: "revise", head_sha: "0".repeat(40) });
	assert.deepEqual(await b.teardown.checkGates(noReview.worktree, silent, "ship"), { ok: true, reason: "pushed" });

	const off = "cp-review-optout-off";
	const disabled = await pushedShipJob(b, off);
	writePipeline(b.home, off, { enabled: false });
	assert.deepEqual(await b.teardown.checkGates(disabled.worktree, off, "ship"), { ok: true, reason: "pushed" });

	// Research is never in scope, whatever its record says.
	const research = "cp-review-research";
	const researchTree = b.worktree(research);
	await b.addJob(research, researchTree, "research");
	writePipeline(b.home, research, { enabled: true });
	assert.deepEqual(await b.teardown.checkGates(researchTree, research, "research"), {
		ok: true,
		reason: "clean_research",
	});

	const torn = await b.teardown.teardown(silent);
	assert.equal(torn.torn_down, true, formatTeardown(torn));
});

test("the gate asks one question of every ship job, whatever the delivery", { timeout: 60_000 }, async (t) => {
	// Same tree, same commits, same answer: the delivery decides whether a PR is
	// opened and whether the parent holds the worker, never whether the work has
	// to be durable.
	const b = benchOf(t);
	const jobId = "cp-one-question";
	const worktree = b.worktree(jobId);
	writeFileSync(join(worktree, "src/app.ts"), "export const x = 9;\n");
	git(worktree, "add", "-A");
	git(worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "unpushed work");

	const unpushed = await b.teardown.checkGates(worktree, jobId, "ship");
	assert.equal(unpushed.ok, false);
	assert.equal(unpushed.ok === false && unpushed.failure.code, "unpushed");

	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	assert.deepEqual(await b.teardown.checkGates(worktree, jobId, "ship"), { ok: true, reason: "pushed" });
});

// ---------------------------------------------------------------------------
// usage population
// ---------------------------------------------------------------------------

test("teardown populates the fleet record's usage from the run status", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const jobId = "cp-usage";
	const worktree = b.worktree(jobId);
	await b.addJob(jobId, worktree);

	// Create a run status with non-zero usage
	const runStatus = initialStatus(jobId, {}, isoTimestamp());
	const runUsage = {
		input: 1000,
		output: 500,
		cache_read: 100,
		cache_write: 50,
		total_tokens: 1650,
		cost_usd: 0.05,
	};
	runStatus.usage = runUsage;

	// Write the status file directly
	const statusFile = join(b.home, paths.statusFile(jobId));
	mkdirSync(join(b.home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(statusFile, JSON.stringify(runStatus));

	// Verify the fleet record starts with empty usage
	const before = b.fleet.require(jobId);
	assert.deepEqual(before.usage, EMPTY_USAGE);

	// Push and tear down
	git(worktree, "push", "--quiet", "-u", "origin", jobId);
	const result = await b.teardown.teardown(jobId);
	assert.equal(result.torn_down, true);

	// Verify the fleet record now has the real usage from the run status
	const after = readFleet(b.home).jobs.find((job) => job.job_id === jobId);
	assert.ok(after, "job should still exist in fleet");
	assert.deepEqual(after!.usage, runUsage, "fleet record should have usage from run status");
});

// ---------------------------------------------------------------------------
// ledger close (research / answer)
// ---------------------------------------------------------------------------

function writeEnvelope(
	home: string,
	jobId: string,
	envelope: { kind: JobKind; summary: string; artifact_path?: string },
): void {
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(
		join(home, paths.envelopeFile(jobId)),
		`${JSON.stringify(
			{
				schema_version: SCHEMA_VERSION,
				job_id: jobId,
				received_at: isoTimestamp(),
				attempt: 1,
				envelope: {
					job_id: jobId,
					kind: envelope.kind,
					status: "done",
					summary: envelope.summary,
					...(envelope.artifact_path ? { artifact_path: envelope.artifact_path } : {}),
				},
			},
			null,
			2,
		)}\n`,
	);
}

test("teardown of an answered Q&A job closes the ledger; a second teardown is a no-op", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const scratch = createScratchLedger({ home: b.home, knownProjects: ["demo"] });
	const headline = "Yes: both packages are found under the pi install root.";
	const job = await scratch.ledger.create({
		title: "where are the packages?",
		project: "demo",
		delivery: "answer",
		kind: "research",
	});
	const worktree = b.worktree(job.id);
	await b.addJob(job.id, worktree, "research", "answer");
	writeEnvelope(b.home, job.id, { kind: "research", summary: headline, artifact_path: join(b.home, "answers", `${job.id}.md`) });

	const teardown = b.withLedger(scratch.ledger);
	const first = await teardown.teardown(job.id);
	assert.equal(first.torn_down, true, formatTeardown(first));

	const closed = await scratch.ledger.show(job.id);
	assert.equal(closed.status, "closed");
	assert.equal(closed.close_reason, `answered: ${headline}`);
	const ready = await scratch.ledger.ready();
	assert.equal(ready.some((entry) => entry.id === job.id), false, "cp_job ready no longer lists it");

	const second = await teardown.teardown(job.id);
	assert.equal(second.torn_down, false);
	assert.equal((await scratch.ledger.show(job.id)).close_reason, `answered: ${headline}`);
});

test("teardown of a ship job does not close the ledger", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const scratch = createScratchLedger({ home: b.home, knownProjects: ["demo"] });
	const job = await scratch.ledger.create({
		title: "ship it",
		project: "demo",
		delivery: "pr",
		kind: "ship",
	});
	const worktree = b.worktree(job.id);
	await b.addJob(job.id, worktree, "ship", "pr");
	git(worktree, "push", "--quiet", "-u", "origin", job.id);

	const result = await b.withLedger(scratch.ledger).teardown(job.id);
	assert.equal(result.torn_down, true, formatTeardown(result));
	const still = await scratch.ledger.show(job.id);
	assert.notEqual(still.status, "closed");
});

/** A Teardown over the bench stores with its own lease counter, a ledger port and a journal. */
function ledgerTeardown(b: Bench, ledger: () => TeardownLedger, journaled: DurableWakeupInput[], releases: string[]): Teardown {
	const leases = new LeaseManager({
		home: b.home,
		cwd: () => b.home,
		runner: async (bin, args) => {
			if (bin === "treehouse" && args[0] === "return") releases.push(String(args.at(-1)));
			return { status: 0, stdout: "", stderr: "" };
		},
	});
	return new Teardown({ home: b.home, fleet: b.fleet, leases, manager: b.manager, runs: b.runs, ledger, journal: (input) => journaled.push(input) });
}

test("research ledger close: a failed close is surfaced and retried by the next teardown", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const scratch = createScratchLedger({ home: b.home, knownProjects: ["demo"] });
	const job = await scratch.ledger.create({ title: "look into it", project: "demo", delivery: "pipeline", kind: "research" });
	await scratch.ledger.claim(job.id, "w");
	await b.addJob(job.id, b.worktree(job.id), "research");
	const artifact = join(b.home, "artifacts", `${job.id}.md`);
	writeEnvelope(b.home, job.id, { kind: "research", summary: "findings", artifact_path: artifact });
	let calls = 0;
	const flaky: TeardownLedger = {
		list: (filter) => scratch.ledger.list(filter),
		close: async (id, reason) => {
			calls += 1;
			if (calls === 1) throw new Error("synthetic transient\nsecond line");
			return scratch.ledger.close(id, reason);
		},
	};
	const journaled: DurableWakeupInput[] = [];
	const releases: string[] = [];

	const first = await ledgerTeardown(b, () => flaky, journaled, releases).teardown(job.id);
	assert.equal(first.torn_down, true, formatTeardown(first));
	assert.equal(first.lease_returned, true);
	assert.equal(first.ledger_close_error, "synthetic transient");
	assert.match(formatTeardown(first), /re-run cp_teardown/);
	assert.equal(journaled.length, 1);
	assert.equal(journaled[0]!.id, `ledger-close-failed:${job.id}`);
	assert.equal(journaled[0]!.kind, "recovery");
	assert.equal(journaled[0]!.job_id, job.id);
	assert.equal((await scratch.ledger.show(job.id)).status, "in_progress");
	assert.equal(releases.length, 1);

	const second = await ledgerTeardown(b, () => flaky, journaled, releases).teardown(job.id);
	assert.equal(second.torn_down, false);
	assert.equal(second.ledger_closed, true);
	assert.match(formatTeardown(second), /ledger close was retried/);
	const closed = await scratch.ledger.show(job.id);
	assert.equal(closed.status, "closed");
	assert.equal(closed.close_reason, `researched: ${artifact}`);
	assert.equal(releases.length, 1, "a retry never touches the lease");

	const third = await ledgerTeardown(b, () => flaky, journaled, releases).teardown(job.id);
	assert.equal(third.ledger_closed, undefined);
	assert.equal(calls, 2);
	assert.equal(journaled.length, 1);
});

test("research ledger close: crash boundary and guards", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const scratch = createScratchLedger({ home: b.home, knownProjects: ["demo"] });
	const make = async (title: string, kind: JobKind = "research") => {
		const job = await scratch.ledger.create({ title, project: "demo", delivery: kind === "research" ? "pipeline" : "pr", kind });
		await scratch.ledger.claim(job.id, "w");
		const record = await b.addJob(job.id, join(b.home, "worktrees", job.id), kind);
		await b.fleet.mutate((jobs) => {
			const entry = jobs.find((e) => e.job_id === job.id)!;
			entry.phase = "done";
			entry.closed_at = isoTimestamp(new Date(Date.now() + 60_000));
			entry.closed_reason = "gated";
		});
		writeEnvelope(b.home, job.id, { kind, summary: `${title} done` });
		return record.job_id;
	};
	const eligible = await make("eligible");
	const unreported = await make("unreported");
	await b.fleet.mutate((jobs) => { delete jobs.find((e) => e.job_id === unreported)!.reported_at; });
	const noEnvelope = await make("no envelope");
	rmSync(join(b.home, paths.envelopeFile(noEnvelope)));
	const edited = await make("edited after close");
	await b.fleet.mutate((jobs) => { jobs.find((e) => e.job_id === edited)!.closed_at = "2020-01-01T00:00:00Z"; });
	const ship = await make("ship", "ship");

	const journaled: DurableWakeupInput[] = [];
	const releases: string[] = [];
	const teardown = ledgerTeardown(b, () => scratch.ledger, journaled, releases);
	const crashed = await teardown.teardown(eligible);
	assert.equal(crashed.torn_down, false);
	assert.equal(crashed.ledger_closed, true);
	assert.equal((await scratch.ledger.show(eligible)).status, "closed");
	for (const id of [unreported, noEnvelope, edited, ship]) {
		assert.equal((await teardown.teardown(id)).ledger_closed, undefined, id);
		assert.equal((await scratch.ledger.show(id)).status, "in_progress", id);
	}

	// The startup sweep over the whole done fleet closes only the newly eligible row.
	const again = await make("eligible again");
	const swept = await ledgerTeardown(b, () => scratch.ledger, journaled, releases).retryLedgerCloses();
	assert.deepEqual(swept, { closed: [again], failed: [] });
	assert.equal(journaled.length, 0);
	assert.equal(releases.length, 0);
});

test("research ledger close: a startup sweep whose fleet read throws journals ledger-close-failed:startup and never throws", async (t) => {
	const b = benchOf(t);
	const journaled: DurableWakeupInput[] = [];
	const fleet = { list: () => { throw new Error("synthetic fleet read failure\nsecond line"); } } as unknown as FleetStore;
	const leases = { release: async () => assert.fail("the sweep never touches a lease") } as unknown as LeaseManager;
	let ledgerCalls = 0;
	const ledger: TeardownLedger = {
		list: async () => { ledgerCalls += 1; return []; },
		close: async () => { ledgerCalls += 1; },
	};
	const teardown = new Teardown({ home: b.home, fleet, leases, manager: b.manager, runs: b.runs, ledger: () => ledger, journal: (input) => journaled.push(input) });
	const outcome = await teardown.retryLedgerCloses();
	assert.deepEqual(outcome, { closed: [], failed: [] });
	assert.equal(journaled.length, 1);
	assert.equal(journaled[0]!.id, "ledger-close-failed:startup");
	assert.equal(journaled[0]!.kind, "recovery");
	assert.match(journaled[0]!.content, /synthetic fleet read failure/);
	assert.doesNotMatch(journaled[0]!.content, /second line/);
	assert.equal(ledgerCalls, 0);
});
