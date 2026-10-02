/**
 * cp-0dhw acceptance — unreported-with-work is a distinct state, and the
 * recovery is automatic within a bound.
 *
 * The incident this pins: in one day, seven workers settled without filing an
 * envelope while their work sat in the worktree — modified and untracked files,
 * one of them 834 insertions across 12 files and $8.56 of spend, three of them
 * cut off mid-turn by provider incidents. Every recovery was hand-driven: the
 * parent noticed, ran `git status` in the worktree, and sent a promote naming
 * what was there. Teardown would have destroyed the work in every case.
 *
 * These tests are hermetic except where the point is git itself: the worker is
 * the same two-method stub the settle tests use, the worktree observation is
 * injected, and the two tests that must prove the *observation* is right run
 * against a real scratch repo.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Envelope,
	type EnvelopeRecord,
	type FleetRecord,
	FleetRecordSchema,
	isoTimestamp,
	type MergeReceipt,
	paths,
	type RunStatus,
	SCHEMA_VERSION,
	type SendReceipt,
	type UnreportedWork,
	unreportedWorkPresent,
	validate,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake } from "../src/intake.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import {
	MAX_RECOVERY_PROMPTS,
	REPORT_NUDGE_TEXT,
	recoveryPromptText,
	SettleWatcher,
	formatSettleOutcome,
} from "../src/settle.ts";
import { assembleStatus, formatStatusTable } from "../src/status.ts";
import { jobState } from "../src/status-render.ts";
import { renderFleetWidget } from "../src/widget.ts";
import { assertReadOnlyGit, inspectWorktreeWork, WORKTREE_READ_ONLY_GIT } from "../src/worktree-work.ts";
import type { WorkerEvent } from "../src/worker-process.ts";
import { createScratchHome, createScratchRepo, readRunEvents, type ScratchHome } from "./harness/index.ts";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

class StubWorker {
	alive = true;
	readonly sent: string[] = [];
	receipt: SendReceipt = "delivered";
	readonly #listeners = new Set<(event: WorkerEvent) => void>();

	async send(message: string): Promise<{ receipt: SendReceipt; error?: string }> {
		this.sent.push(message);
		return this.receipt === "failed" ? { receipt: "failed", error: "worker stdin is closed" } : { receipt: this.receipt };
	}

	onEvent(listener: (event: WorkerEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

const JOB_ID = "cp-recover";

function workFixture(overrides: Partial<UnreportedWork> = {}): UnreportedWork {
	return {
		state: "dirty",
		files: ["src/settle.ts", "tests/settle.test.ts", "docs/contracts.md"],
		file_count: 3,
		commits_ahead: 0,
		branch_on_origin: false,
		observed_at: isoTimestamp(),
		...overrides,
	};
}

const CLEAN: UnreportedWork = {
	state: "clean",
	files: [],
	file_count: 0,
	commits_ahead: 0,
	branch_on_origin: true,
	observed_at: isoTimestamp(),
};

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	watcher: SettleWatcher;
	worker: StubWorker;
	/** What the injected inspector returns next. */
	work: { current: UnreportedWork };
	/** How many times the worktree was looked at. */
	looks: { count: number };
	watcherOver(work?: () => Promise<UnreportedWork>): SettleWatcher;
}

async function bench(
	t: { after(fn: () => void | Promise<void>): void },
	options: { record?: Partial<FleetRecord>; work?: UnreportedWork } = {},
): Promise<Bench> {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const fail = (jobId: string, failure: Parameters<FleetStore["markFailed"]>[1]) => fleet.markFailed(jobId, failure);
	const intake = new EnvelopeIntake({ home: home.path, fleet, runs, fail });
	const work = { current: options.work ?? workFixture() };
	const looks = { count: 0 };
	const inspect = async () => {
		looks.count += 1;
		return work.current;
	};
	const watcher = new SettleWatcher({ fleet, runs, intake, inspect, fail });
	const record: FleetRecord = {
		job_id: JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(home.path, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: join(home.path, "wt"),
		branch: JOB_ID,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		...options.record,
	};
	await fleet.add(record);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return {
		home,
		fleet,
		runs,
		intake,
		watcher,
		worker: new StubWorker(),
		work,
		looks,
		// A *second* watcher over the same home, with its own stores: what a
		// restarted parent has. Nothing is shared in memory.
		watcherOver(inspectAgain?: () => Promise<UnreportedWork>): SettleWatcher {
			const freshFleet = new FleetStore({ home: home.path });
			const freshRuns = new RunRegistry(home.path);
			t.after(() => freshRuns.closeAll());
			const freshFail = (jobId: string, failure: Parameters<FleetStore["markFailed"]>[1]) =>
				freshFleet.markFailed(jobId, failure);
			return new SettleWatcher({
				fleet: freshFleet,
				runs: freshRuns,
				fail: freshFail,
				intake: new EnvelopeIntake({ home: home.path, fleet: freshFleet, runs: freshRuns, fail: freshFail }),
				inspect: inspectAgain ?? inspect,
			});
		},
	};
}

function fileEnvelope(home: string, jobId: string, envelope: Partial<Envelope> = {}): void {
	const dir = join(home, paths.runDir(jobId));
	mkdirSync(dir, { recursive: true });
	const record: EnvelopeRecord = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		received_at: isoTimestamp(),
		attempt: 1,
		envelope: {
			job_id: jobId,
			kind: "ship",
			status: "done",
			summary: "shipped it",
			branch: jobId,
			pr_url: "https://github.com/demo/demo/pull/29",
			...envelope,
		} as Envelope,
	};
	writeFileSync(join(home, paths.envelopeFile(jobId)), `${JSON.stringify(record, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 1. The two states are distinguished, and recorded as a fact
// ---------------------------------------------------------------------------

test("a settle with work on disk records a different fact than a settle with a clean tree", async (t) => {
	const dirty = await bench(t, { work: workFixture() });
	await dirty.watcher.settled(JOB_ID, dirty.worker);
	const withWork = dirty.fleet.require(JOB_ID).unreported_work;
	assert.ok(withWork, "the observation is on the record, not only in a message");
	assert.equal(withWork.state, "dirty");
	assert.equal(withWork.file_count, 3);
	assert.deepEqual(withWork.files, ["src/settle.ts", "tests/settle.test.ts", "docs/contracts.md"]);
	assert.equal(unreportedWorkPresent(withWork), true);
	// The record still validates: a new fact is part of the contract, not a bag.
	const checked = validate(FleetRecordSchema, dirty.fleet.require(JOB_ID));
	assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "));

	const clean = await bench(t, { work: CLEAN });
	await clean.watcher.settled(JOB_ID, clean.worker);
	const nothing = clean.fleet.require(JOB_ID).unreported_work;
	assert.ok(nothing);
	assert.equal(nothing.state, "clean");
	assert.equal(unreportedWorkPresent(nothing), false);

	// And the two settles produced different prompts, from that one fact.
	assert.match(dirty.worker.sent[0] as string, /still sitting in the worktree/);
	assert.equal(clean.worker.sent[0], REPORT_NUDGE_TEXT);
});

test("an observation that failed is `unknown`, and unknown never counts as work", async (t) => {
	const b = await bench(t, {
		work: { state: "unknown", files: [], file_count: 0, commits_ahead: 0, observed_at: isoTimestamp(), reason: "worktree is gone" },
	});
	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "nudged");
	assert.equal(outcome.action === "nudged" ? outcome.prompt : "", "report", "ignorance gets the plain nudge, never a recovery");
	assert.equal(b.fleet.require(JOB_ID).unreported_work?.state, "unknown");
	assert.equal(b.worker.sent[0], REPORT_NUDGE_TEXT);
});

test("an inspector that throws degrades to `unknown` instead of losing the settle", async (t) => {
	const b = await bench(t);
	const watcher = b.watcherOver(async () => {
		throw new Error("git exploded");
	});
	const outcome = await watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "nudged");
	const work = b.fleet.require(JOB_ID).unreported_work;
	assert.equal(work?.state, "unknown");
	assert.match(work?.reason ?? "", /git exploded/);
});

// ---------------------------------------------------------------------------
// 2. The recovery prompt: automatic, evidence-carrying, bounded
// ---------------------------------------------------------------------------

test("the recovery prompt fires automatically, carries the file evidence, and never asks for a redo", async (t) => {
	const b = await bench(t);
	const outcome = await b.watcher.settled(JOB_ID, b.worker);

	assert.equal(outcome.action, "nudged");
	assert.equal(outcome.action === "nudged" ? outcome.prompt : "", "recovery");
	assert.equal(b.worker.sent.length, 1, "one prompt, sent by the boundary itself — no parent turn was needed");

	const prompt = b.worker.sent[0] as string;
	for (const file of ["src/settle.ts", "tests/settle.test.ts", "docs/contracts.md"]) {
		assert.ok(prompt.includes(file), `the prompt carries ${file}`);
	}
	assert.match(prompt, /Do NOT redo it/);
	assert.match(prompt, /report_result exactly once/);
	assert.match(prompt, /blocked/);
	assert.match(prompt, new RegExp(`origin does NOT have ${JOB_ID}`));
	assert.ok(prompt.length < 2500, "a short instruction plus evidence, not a re-brief");

	// The event carries the evidence too, so /watch shows what was recovered.
	const events = readRunEvents(b.home.path, JOB_ID).filter((event) => event.type === "recovery_prompted");
	assert.equal(events.length, 1);
	const payload = events[0]?.payload as { attempt?: number; of?: number; work?: UnreportedWork };
	assert.equal(payload.attempt, 1);
	assert.equal(payload.of, MAX_RECOVERY_PROMPTS);
	assert.equal(payload.work?.state, "dirty");
});

test("the automatic recovery is bounded: prompts stop permanently once the bound is spent", async (t) => {
	const b = await bench(t);
	for (let attempt = 1; attempt <= MAX_RECOVERY_PROMPTS; attempt++) {
		const outcome = await b.watcher.settled(JOB_ID, b.worker);
		assert.equal(outcome.action, "nudged", `attempt ${attempt} prompts`);
	}
	assert.equal(b.worker.sent.length, MAX_RECOVERY_PROMPTS);
	assert.match(b.worker.sent[MAX_RECOVERY_PROMPTS - 1] as string, /and the last one/);

	// Beyond the bound: recorded with its evidence, never prompted again, and the
	// job is left `waiting` for a human — not failed, not torn down.
	for (const settle of [MAX_RECOVERY_PROMPTS + 1, MAX_RECOVERY_PROMPTS + 2]) {
		const outcome = await b.watcher.settled(JOB_ID, b.worker);
		assert.equal(outcome.action, "recorded", `settle ${settle} is recorded`);
		assert.equal(outcome.action === "recorded" ? outcome.work?.state : undefined, "dirty");
	}
	assert.equal(b.worker.sent.length, MAX_RECOVERY_PROMPTS, "the bound is a bound");

	const record = b.fleet.require(JOB_ID);
	assert.equal(record.phase, "waiting");
	assert.equal(record.failure, undefined);
	assert.equal(record.unreported_settles, MAX_RECOVERY_PROMPTS + 2);

	const exhausted = readRunEvents(b.home.path, JOB_ID).filter((event) => event.type === "recovery_exhausted");
	assert.equal(exhausted.length, 2, "every settle past the bound records the fact");

	// The operator line names the evidence and the decision, and is never a body.
	const line = formatSettleOutcome(JOB_ID, { action: "recorded", settles: 4, work: workFixture() });
	assert.ok(line);
	assert.ok((line as string).split("\n").length <= 3);
	assert.match(line as string, /uncommitted file/);
	assert.match(line as string, new RegExp(`cp_send ${JOB_ID}`));
	assert.match(line as string, /nothing was deleted/i);
});

test("the bound is on disk: a restarted parent inherits the spent budget, not a fresh one", async (t) => {
	const b = await bench(t);
	for (let attempt = 1; attempt <= MAX_RECOVERY_PROMPTS; attempt++) {
		await b.watcher.settled(JOB_ID, b.worker);
	}
	assert.equal(b.worker.sent.length, MAX_RECOVERY_PROMPTS);

	// The parent restarts: new stores, new watcher, same home. The only thing
	// carrying the budget across is the counter on the fleet record.
	const restarted = b.watcherOver();
	const outcome = await restarted.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "recorded");
	assert.equal(b.worker.sent.length, MAX_RECOVERY_PROMPTS, "a restart is not a new budget");
});

test("a promote reopens the budget and clears the observation with it", async (t) => {
	const b = await bench(t);
	await b.watcher.settled(JOB_ID, b.worker);
	assert.ok(b.fleet.require(JOB_ID).unreported_work);

	// What `cp_send` does before delivering a new brief.
	await b.fleet.clearUnreportedSettles(JOB_ID);
	const record = b.fleet.require(JOB_ID);
	assert.equal(record.unreported_settles, undefined);
	assert.equal(record.unreported_work, undefined, "a stale observation must not outlive the silence it described");

	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "nudged");
});

// ---------------------------------------------------------------------------
// 3. Who is never prompted
// ---------------------------------------------------------------------------

test("a job that has reported is never prompted, even with a stale unreported flag on the record", async (t) => {
	const b = await bench(t);
	// The cp-rud shape, exactly: the accept path stamped `reported_at`, and a
	// stale counter survives on the record. Prompting here produced an
	// unbreakable loop — report_result refuses as already-filed, the worker
	// settles again, the watcher prompts again.
	await b.fleet.patch(JOB_ID, { unreported_settles: 1, unreported_work: workFixture(), reported_at: isoTimestamp(), phase: "held" });

	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "reported");
	assert.equal(b.worker.sent.length, 0);
	assert.equal(b.looks.count, 0, "a reported job's worktree is not even looked at");

	// And the ordinary path: an envelope on disk that intake has not stamped yet.
	const fresh = await bench(t);
	fileEnvelope(fresh.home.path, JOB_ID);
	assert.equal((await fresh.watcher.settled(JOB_ID, fresh.worker)).action, "reported");
	assert.equal(fresh.worker.sent.length, 0);
	assert.equal(fresh.fleet.require(JOB_ID).unreported_work, undefined);
});

test("a job whose PR has merged is never prompted", async (t) => {
	const b = await bench(t);
	const receipt: MergeReceipt = {
		schema_version: SCHEMA_VERSION,
		job_id: JOB_ID,
		pr_url: "https://github.com/demo/demo/pull/91",
		merge_commit_sha: "a".repeat(40),
		head_sha: "b".repeat(40),
		head_branch: JOB_ID,
		recorded_at: isoTimestamp(),
		recorded_by: "gh pr view",
	};
	mkdirSync(join(b.home.path, paths.runDir(JOB_ID)), { recursive: true });
	writeFileSync(join(b.home.path, paths.mergeFile(JOB_ID)), `${JSON.stringify(receipt, null, 2)}\n`);

	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "ignored");
	assert.match(outcome.action === "ignored" ? outcome.reason : "", /merge receipt/);
	assert.equal(b.worker.sent.length, 0);
	assert.equal(b.fleet.require(JOB_ID).unreported_settles, undefined, "a landed delivery is not an unreported settle");

	// A `merged` PR receipt on the record says the same thing without the file.
	const viaReceipt = await bench(t, {
		record: { receipts: [{ kind: "pr", status: "merged", title: `PR for ${JOB_ID}`, url: "https://x/1" }] },
	});
	const second = await viaReceipt.watcher.settled(JOB_ID, viaReceipt.worker);
	assert.equal(second.action, "ignored");
	assert.equal(viaReceipt.worker.sent.length, 0);
});

test("a job mid-tool-call is never classified unreported", async (t) => {
	const b = await bench(t);
	// The run projection says a call is in flight: that is wedged's territory,
	// and wedged and unreported can never both be true of one job (cp-m44c).
	const status: RunStatus = {
		...initialStatus(JOB_ID),
		phase: "working",
		current_tool: { name: "bash", tool_call_id: "call-1", started_at: isoTimestamp() },
	};
	mkdirSync(join(b.home.path, paths.runDir(JOB_ID)), { recursive: true });
	writeFileSync(join(b.home.path, paths.statusFile(JOB_ID)), `${JSON.stringify(status, null, 2)}\n`);

	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "ignored");
	assert.match(outcome.action === "ignored" ? outcome.reason : "", /working again/);
	assert.equal(b.worker.sent.length, 0);
	const record = b.fleet.require(JOB_ID);
	assert.equal(record.unreported_settles, undefined, "no counter is spent on a run that is still going");
	assert.equal(record.unreported_work, undefined);
});

test("a job that is done, or otherwise not live, is left alone", async (t) => {
	const b = await bench(t);
	await b.fleet.patch(JOB_ID, { phase: "done" });
	const outcome = await b.watcher.settled(JOB_ID, b.worker);
	assert.equal(outcome.action, "ignored");
	assert.equal(b.worker.sent.length, 0);
});

// ---------------------------------------------------------------------------
// 4. The observation itself, against real git — and it never writes
// ---------------------------------------------------------------------------

test("inspectWorktreeWork classifies a real worktree: dirty, unpushed, clean", async (t) => {
	const repo = createScratchRepo({ name: "obs" });
	t.after(() => repo.cleanup());

	// Clean: everything committed and pushed.
	const clean = await inspectWorktreeWork(repo.path, repo.branch);
	assert.equal(clean.state, "clean");
	assert.equal(clean.file_count, 0);
	assert.equal(clean.commits_ahead, 0);
	assert.equal(clean.branch_on_origin, true);

	// Unpushed: a commit no origin ref contains.
	repo.write("src/feature.ts", "export const one = 1;\n");
	repo.commitAll("work that never reached origin");
	const unpushed = await inspectWorktreeWork(repo.path, repo.branch);
	assert.equal(unpushed.state, "unpushed");
	assert.equal(unpushed.commits_ahead, 1);
	assert.equal(unpushed.file_count, 0);

	// Dirty: the seven-jobs shape — modified and untracked files on disk.
	repo.write("src/feature.ts", "export const one = 2;\n");
	repo.write("src/brand-new.ts", "export const two = 2;\n");
	const dirty = await inspectWorktreeWork(repo.path, repo.branch);
	assert.equal(dirty.state, "dirty");
	assert.equal(dirty.file_count, 2);
	assert.deepEqual([...dirty.files].sort(), ["src/brand-new.ts", "src/feature.ts"]);
	assert.equal(dirty.commits_ahead, 1, "the unpushed commit is still counted as evidence");

	// A branch origin has never heard of is reported as absent, not as unknown.
	const other = await inspectWorktreeWork(repo.path, "cp-never-pushed");
	assert.equal(other.branch_on_origin, false);

	// A worktree that is not there at all is `unknown`, with a reason.
	const gone = await inspectWorktreeWork(join(repo.path, "nope"), repo.branch);
	assert.equal(gone.state, "unknown");
	assert.ok(gone.reason);
});

test("nothing in the recovery path deletes, resets or cleans a worktree", async (t) => {
	const repo = createScratchRepo({ name: "intact" });
	t.after(() => repo.cleanup());
	repo.write("src/precious.ts", "export const keep = true;\n");
	repo.write("untracked.md", "834 insertions live here\n");

	const issued: string[][] = [];
	const work = await inspectWorktreeWork(repo.path, repo.branch, {
		git: async (cwd, args) => {
			issued.push([...args]);
			const { execFileSync } = await import("node:child_process");
			return { status: 0, stdout: execFileSync("git", [...args], { cwd, encoding: "utf8" }), stderr: "" };
		},
	});

	assert.equal(work.state, "dirty");
	// Every command issued is one of the three read-only subcommands, and none of
	// the destructive shapes appears anywhere in the argv.
	assert.ok(issued.length > 0);
	for (const args of issued) {
		assert.ok(WORKTREE_READ_ONLY_GIT.includes(args[0] as string), `unexpected git subcommand: ${args.join(" ")}`);
		for (const forbidden of ["clean", "reset", "checkout", "restore", "rm", "stash", "worktree"]) {
			assert.ok(!args.includes(forbidden), `${forbidden} must never be issued: ${args.join(" ")}`);
		}
	}
	// And the files are still exactly where the worker left them.
	assert.equal(readFileSync(join(repo.path, "src/precious.ts"), "utf8"), "export const keep = true;\n");
	assert.ok(existsSync(join(repo.path, "untracked.md")));

	// The guard lives in the runner, not only in the call sites: a later edit that
	// composes a mutating command cannot reach git at all.
	for (const forbidden of ["clean", "reset", "checkout", "restore", "stash", "rm", "worktree", "push"]) {
		assert.throws(() => assertReadOnlyGit([forbidden, "-fd"]), /may only run/, `${forbidden} must be refused`);
	}
	for (const allowed of WORKTREE_READ_ONLY_GIT) assert.doesNotThrow(() => assertReadOnlyGit([allowed]));
});

// ---------------------------------------------------------------------------
// 5. The operator surfaces read the one fact, and never re-derive it
// ---------------------------------------------------------------------------

test("/status and the widget say which unreported situation this is", async (t) => {
	const b = await bench(t);
	await b.watcher.settled(JOB_ID, b.worker);
	const record = b.fleet.require(JOB_ID);

	const snapshot = assembleStatus({
		home: b.home.path,
		generated_at: isoTimestamp(),
		include: "all",
		records: [record],
		runs: new Map([[JOB_ID, { ...initialStatus(JOB_ID), phase: "idle" as const }]]),
		alive: new Map([[JOB_ID, true]]),
		ledger: { ok: false, queried: false },
	});
	const job = snapshot.jobs[0];
	assert.ok(job);
	assert.equal(job.unreported_work?.state, "dirty", "/status carries the fact, it does not run git");
	assert.equal(jobState(job).kind, "unreported");

	const table = formatStatusTable(snapshot);
	assert.match(table, /WITH WORK ON DISK/);
	assert.match(table, /3 uncommitted file/);
	assert.doesNotMatch(table, /failed/);

	const widget = renderFleetWidget(snapshot, { width: 120 }).map((line) => line.text);
	assert.ok(widget.some((line) => line.includes("work on disk")), "the widget names it too");
});

// ---------------------------------------------------------------------------
// 6. The prompt template, on its own
// ---------------------------------------------------------------------------

test("the recovery prompt names the worktree, the branch and the bound, and truncates a long file list", () => {
	const many = workFixture({
		files: Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`),
		file_count: 40,
		commits_ahead: 2,
		branch_on_origin: true,
	});
	const text = recoveryPromptText(
		{ job_id: JOB_ID, branch: JOB_ID, worktree: "/leases/wt-1", delivery: "pr" },
		many,
		MAX_RECOVERY_PROMPTS,
	);
	assert.match(text, /\/leases\/wt-1/);
	assert.match(text, new RegExp(`origin has ${JOB_ID}`));
	assert.match(text, /28 more file\(s\)/);
	assert.match(text, /2 unpushed commit\(s\)/);
	assert.match(text, /the last one/);
	assert.ok(text.length < 3000);
});
