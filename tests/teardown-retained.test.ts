import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths, type Delivery, type FleetRecord, type JobKind } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { LeaseManager } from "../src/leases.ts";
import { RunRegistry } from "../src/runs.ts";
import { Teardown, type TeardownLedger } from "../src/teardown.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { createScratchHome, createScratchRepo, git, readRunEvents, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

function benchOf(t: { after(fn: () => void | Promise<void>): void }) {
 const home = createScratchHome();
 const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
 const fleet = new FleetStore({ home: home.path });
 const runs = new RunRegistry(home.path);
 const manager = new WorkerManager({ home: home.path, workerReporterPath: WORKER_REPORTER_EXTENSION });
 const leases = new LeaseManager({ home: home.path, cwd: () => home.path,
  runner: async () => ({ status: 0, stdout: "", stderr: "" }) });
 const teardown = new Teardown({ home: home.path, fleet, leases, manager, runs });
 t.after(async () => { await manager.shutdownAll(); runs.closeAll(); repo.cleanup(); home.cleanup(); });
 return {
  home: home.path, fleet, runs, manager, teardown,
  withJournal(journal: (input: DurableWakeupInput) => void) {
   return new Teardown({ home: home.path, fleet, leases, manager, runs, journal });
  },
  worktree(jobId: string) {
   const path = join(home.path, "worktrees", jobId);
   mkdirSync(join(home.path, "worktrees"), { recursive: true });
   git(repo.path, "worktree", "add", "--quiet", "--no-track", "-b", jobId, path, "origin/main");
   return path;
  },
  async addJob(jobId: string, worktree: string, kind: JobKind = "ship", delivery?: Delivery) {
   return fleet.add({ job_id: jobId, project: "demo", kind,
    delivery: delivery ?? (kind === "research" ? "pipeline" : "pr"), origin: DEFAULT_ORIGIN,
    phase: "held", reported_at: isoTimestamp(), worker: { pid: process.pid, session_id: "s",
     session_file: join(home.path, "s.jsonl"), profile: kind === "research" ? "planner" : "implementer",
     role: kind === "research" ? "planner" : "implementer", model: "mock/model",
     started_at: isoTimestamp(), exited_at: isoTimestamp() },
    worktree, branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE });
  },
 };
}
type Bench = ReturnType<typeof benchOf>;
async function addLiveUnreported(b: Bench, jobId: string): Promise<string> {
 const worktree = b.worktree(jobId);
 await b.addJob(jobId, worktree, "research");
 await b.fleet.mutate((jobs) => {
  const job = jobs.find((entry) => entry.job_id === jobId)!;
  delete job.reported_at;
  job.phase = "waiting";
  if (!("script" in job)) delete job.worker.exited_at;
 });
 return worktree;
}

// No public entry point persists model phase=launching; retain the full mixed contract.
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

// CommandPost exposes no removeArtifacts=true constructor option.
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

// Public reconciliation reads FleetStore before the guarded retry sweep can observe this fault.
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
