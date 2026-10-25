/** cp-0dhw declarations no e2e entry point reaches: the product inspector never throws, a settle cannot race a new
 * tool call on demand, teardown closes a worker before its job is done, and every call site passes read-only git.
 * The rest converted to tests/e2e/worker-lifecycle-p8c.test.ts (P8c, 04-15/04-16) and P8d's 04-23. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	isoTimestamp,
	paths,
	type RunStatus,
	type SendReceipt,
	type UnreportedWork,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake } from "../src/intake.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import { SettleWatcher } from "../src/settle.ts";
import { assertReadOnlyGit, inspectWorktreeWork, WORKTREE_READ_ONLY_GIT } from "../src/worktree-work.ts";
import type { WorkerEvent } from "../src/worker-process.ts";
import { createScratchHome, createScratchRepo, type ScratchHome } from "./harness/index.ts";

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
