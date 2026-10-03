/**
 * Graceful drain (src/drain.ts). The drain never blocks: start writes the flag
 * and returns, the ordinary tick (`check`) emits exactly one outcome wake, every
 * process start is refused with the drain named, and only a fresh parent's
 * startup reports and clears the record. Isolated scratch homes and fakes only;
 * nothing here drains a live parent.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, type FleetRecord, isoTimestamp, paths, type RunPhase, SCHEMA_VERSION } from "../src/contracts.ts";
import { CommandPost } from "../src/command-post.ts";
import { assertNotDraining, DrainControl, drainFile, DrainError, formatDrain, liveWorkerJobs, readDrain, restartActivity, restartNotice } from "../src/drain.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { IntegrationHolds } from "../src/integration-hold.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { cpNext } from "../src/next.ts";
import { parentDiagnostic } from "../src/parent-diagnostics.ts";
import { loadProfile } from "../src/profiles.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender } from "../src/send.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import type { WorkerProcess } from "../src/worker-process.ts";
import { createScratchHome, createScratchLedger, REPO_ROOT } from "./harness/index.ts";

function record(jobId: string, overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: "terminal",
		phase: "waiting",
		worker: { pid: 999_999, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m/x", started_at: "2026-09-27T12:00:00Z" },
		worktree: `/wt/${jobId}`,
		branch: jobId,
		dispatched_at: "2026-09-27T12:00:00Z",
		usage: EMPTY_USAGE,
		...overrides,
	};
}

function control(home: string, fleet: FleetStore, overrides: Partial<ConstructorParameters<typeof DrainControl>[0]> = {}) {
	const wakes: Array<{ id: string; content: string; keys?: string[] }> = [];
	const discarded: string[] = [];
	let busy: string[] = [];
	let clock = Date.UTC(2026, 8, 27, 12);
	const drain = new DrainControl({
		home,
		fleet,
		busy: () => busy,
		head: (jobId: string) => (jobId === "cp-held" ? "abcdef0123456789" : undefined),
		journal: (wake) => wakes.push(wake),
		discard: (ids) => discarded.push(...ids),
		now: () => new Date(clock),
		...overrides,
	});
	return { drain, wakes, discarded, setBusy: (keys: string[]) => { busy = keys; }, advance: (ms: number) => { clock += ms; } };
}

test("drain lifecycle: start returns at once, envelopes keep landing, and exactly one 'drained' wake follows the last settle", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record("cp-held", { phase: "held", reported_at: "2026-09-27T12:30:00Z", lease_id: "lease-7" }));
	await fleet.add(record("cp-busy"));
	await fleet.add(record("cp-gone", { phase: "done" }));
	const c = control(home.path, fleet);
	c.setBusy(["cp-busy", "review:cp-held"]);

	const started = c.drain.start(300); // synchronous: nothing to await, nothing waits
	assert.equal(started.state, "draining");
	assert.equal(started.timeout_s, 300);
	assert.match(formatDrain(started, home.path), /^DRAIN: draining since .*one wake follows when drained/);
	assert.throws(() => assertNotDraining(home.path, "dispatch"), DrainError, "the flag is on disk before start returns");
	assert.equal(c.drain.check()?.state, "draining", "a busy worker or reviewer keeps it draining");
	assert.equal(c.wakes.length, 0);

	// The parent keeps processing envelopes: the fleet still moves while draining.
	await fleet.patch("cp-busy", { phase: "held", reported_at: isoTimestamp() });
	c.setBusy(["review:cp-held"]);
	assert.equal(c.drain.check()?.state, "draining", "the reviewer is still mid-turn");
	c.setBusy([]);
	const done = c.drain.check();
	assert.equal(done?.state, "drained");
	assert.equal(c.wakes.length, 1);
	assert.match(c.wakes[0]!.content, /^DRAIN: drained: safe to restart\n  2 job\(s\) in flight/);
	assert.deepEqual(readDrain(home.path)?.jobs, [
		{ job_id: "cp-held", phase: "held", lease: "lease-7", head: "abcdef0123456789" },
		{ job_id: "cp-busy", phase: "held", lease: "/wt/cp-busy", head: null },
	]);
	c.drain.check();
	c.drain.check();
	assert.equal(c.wakes.length, 1, "exactly one outcome wake");
	assert.match(restartNotice(home.path, () => fleet.list()), /^drained at .*: safe to restart; 2 job\(s\)/);
	assert.equal(c.drain.start().state, "drained", "a finished drain restarts fresh, and answers drained at once when idle");
	assert.equal(c.wakes.length, 1, "an immediate answer is the report: no wake follows it");
});

test("drain timeout: exactly one 'drain timed out' wake naming workers, reviewers and merge steps still running", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record("cp-live", { worker: { ...record("x").worker, pid: process.pid } }));
	await fleet.add(record("cp-dead"));
	assert.match(restartNotice(home.path, () => fleet.list()), /^warning: not drained; this kills 1 live worker\(s\)/);
	const c = control(home.path, fleet);
	c.setBusy(["cp-live"]);
	let release!: () => void;
	const step = c.drain.track(() => new Promise<void>((done) => { release = done; }));
	c.drain.start(5);
	c.advance(4000);
	c.drain.check();
	assert.equal(c.wakes.length, 0, "inside the bound nothing is reported");
	c.advance(1000);
	const out = c.drain.check();
	c.drain.check();
	assert.equal(out?.state, "timeout");
	assert.deepEqual(out?.survivors, ["cp-live", "1 merge step(s)"]);
	assert.equal(c.wakes.length, 1);
	assert.match(c.wakes[0]!.content, /^DRAIN: drain timed out after 5s: still busy cp-live, 1 merge step\(s\); a restart now kills them/);
	assert.match(restartNotice(home.path, () => fleet.list()), /timed out .* this kills 1 live worker\(s\)/);
	release();
	await step;
	assert.equal(c.drain.mergeSteps, 0);
});

test("drain: a session without the parent lock never decides the outcome", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const owner = control(home.path, fleet);
	owner.setBusy(["cp-busy"]);
	owner.drain.start();
	const other = control(home.path, fleet, { owns: () => false });
	assert.equal(other.drain.check()?.state, "draining", "its own empty manager proves nothing");
	assert.equal(other.wakes.length, 0);
	const home2 = createScratchHome();
	t.after(() => home2.cleanup());
	const stranger = control(home2.path, new FleetStore({ home: home2.path }), { owns: () => false });
	assert.throws(() => stranger.drain.start(), /does not hold the parent lock/, "a non-owner never writes a false 'drained'");
	assert.equal(existsSync(drainFile(home2.path)), false);
});

test("drain: an outcome wake that fails to journal is retried on the next tick, still exactly once", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const sent = new Set<string>();
	let fail = true;
	const c = control(home.path, fleet, {
		journal: (wake) => {
			if (fail) throw new Error("disk full");
			sent.add(wake.id);
		},
	});
	c.setBusy(["cp-busy"]);
	c.drain.start();
	c.setBusy([]);
	assert.throws(() => c.drain.check(), /disk full/, "never swallowed");
	assert.equal(readDrain(home.path)?.reported, false);
	fail = false;
	assert.equal(c.drain.check()?.reported, true);
	c.drain.check();
	assert.equal(sent.size, 1);
});

test("drain cancel (cp-update's drain timeout): owner-only, withdraws draining or timed out, never drained, and opens the gates", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const owner = control(home.path, fleet);
	owner.setBusy(["cp-busy"]);
	const started = owner.drain.start(5);
	assert.throws(() => assertNotDraining(home.path, "dispatch"), DrainError);
	assert.throws(() => control(home.path, fleet, { owns: () => false }).drain.cancel(), /does not hold the parent lock/, "a non-owner never cancels");
	assert.equal(readDrain(home.path)?.state, "draining");
	owner.advance(5000);
	assert.equal(owner.drain.check()?.state, "timeout");
	const text = owner.drain.cancel();
	assert.match(text, /^DRAIN: cancelled \u2014 .*\(timeout\) is withdrawn; .*open again/);
	assert.deepEqual(owner.wakes.map((wake) => wake.id), [`drain:${started.started_at}:timeout`, `drain:${started.started_at}:cancelled`], "one wake for the cancel, relayed by its drain: id");
	assert.equal(existsSync(drainFile(home.path)), false);
	assertNotDraining(home.path, "dispatch");
	assert.throws(() => owner.drain.cancel(), /no drain to cancel/);
	owner.setBusy([]);
	assert.equal(owner.drain.start().state, "drained");
	assert.throws(() => owner.drain.cancel(), /finished drained; that restart is prepared/, "a drained drain is the restart already prepared");
	assert.equal(readDrain(home.path)?.state, "drained");
});

test("drain gates every process start with the drain named: next, dispatch, promotion, steer to idle, merge, review, gate, revive, spawn", async (t) => {
	const home = createScratchHome();
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(async () => {
		await post.shutdown();
		home.cleanup();
	});
	await post.fleet.add(record("cp-idle"));
	await post.fleet.add(record("cp-held", { phase: "held", reported_at: "2026-09-27T12:30:00Z" }));
	post.drain.start();
	const named = /refused: the parent is draining for a restart \(since .*\)/;

	const scratch = createScratchLedger({ knownProjects: ["demo"], home: home.path });
	const next = await cpNext({ ledger: scratch.ledger as Ledger, fleet: post.fleet, mandates: new MandateStore(home.path), escalations: new EscalationStore({ home: home.path }) });
	assert.equal(next.action.kind, "draining");
	assert.match(new IntegrationHolds(home.path).get("cp-held")?.reason ?? "", /draining/, "the next merge step waits");

	const idle = { get: () => ({ model: "m/x", worker: { alive: true, busy: false } }) } as unknown as WorkerManager;
	const sender = new Sender({ fleet: post.fleet, manager: idle, runs: new RunRegistry(home.path), home: home.path });
	await assert.rejects(sender.send({ jobId: "cp-idle", message: "new brief" }), named);
	await assert.rejects(sender.send({ jobId: "cp-idle", message: "steer", mode: "steer" }), /no promotion or steer send to idle cp-idle starts/);
	const busy = { get: () => ({ model: "m/x", worker: { alive: true, busy: true } }) } as unknown as WorkerManager;
	const busySender = new Sender({ fleet: post.fleet, manager: busy, runs: new RunRegistry(home.path), home: home.path });
	await assert.rejects(busySender.send({ jobId: "cp-idle", message: "after", mode: "follow_up" }), /no promotion or follow_up send to busy cp-idle starts/, "a follow_up queues a turn after the settle point");
	await assert.rejects(busySender.send({ jobId: "cp-idle", message: "brief", task: "new scope" }), /no promotion or auto send to busy cp-idle starts/);
	await assert.rejects(busySender.send({ jobId: "cp-idle", message: "settle now" }), (error: unknown) => !(error instanceof DrainError), "a steer into a running turn passes the drain gate");

	await assert.rejects(post.dispatch({ jobId: "cp-any", task: "x" }), /no dispatch starts/);
	await assert.rejects(post.diffReview({ jobId: "cp-held" }), /no cp_review reviewer starts/, "HeldContinuation's review spawn goes through this");
	await assert.rejects(post.gate({ jobId: "cp-held" } as never), /no plan gate reviewer starts/);
	const revived = await post.recovery.onDeath("cp-idle", { class: "crash", message: "exit 1", at: isoTimestamp() });
	assert.equal(revived.action, "revive_refused");
	assert.match((revived as { reason: string }).reason, /no automatic recovery of cp-idle starts/);
	assert.equal((revived as { attempted: boolean }).attempted, false, "a drain spends no recovery attempt");

	const manager = new WorkerManager({ home: home.path, workerReporterPath: join(REPO_ROOT, "extensions/worker-reporter/index.ts") });
	const profile = loadProfile(join(REPO_ROOT, "profiles"), "implementer");
	assert.throws(() => manager.spawn({ identity: { jobId: "cp-new", kind: "ship", delivery: "pr", runDir: home.path, worktree: home.path }, profile, model: "m/x" }), /no worker process for cp-new starts/);

	writeFileSync(drainFile(home.path), "{not json");
	assert.throws(() => assertNotDraining(home.path, "dispatch"), /not a drain record/);
});

test("drain: reconcile never clears this process's drain; the next parent's startup reports it once through cp-recovery and clears it", async (t) => {
	const home = createScratchHome();
	const first = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	const next = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(async () => {
		await first.shutdown();
		await next.shutdown();
		home.cleanup();
	});
	await first.fleet.add(record("cp-held", { phase: "held", reported_at: "2026-09-27T12:30:00Z" }));
	first.drain.start();
	await first.reconcile();
	assert.equal(existsSync(drainFile(home.path)), true, "the draining process keeps its own drain");

	await next.reconcile(); // a fresh parent: its startup pass
	assert.equal(existsSync(drainFile(home.path)), false, "draining is cleared");
	assert.doesNotThrow(() => assertNotDraining(home.path, "dispatch"));
	const restart = next.durableWakeups.pending().filter((entry) => entry.content.startsWith("RESTART AFTER DRAIN"));
	assert.equal(restart.length, 1);
	assert.equal(restart[0]!.kind, "recovery");
	assert.match(restart[0]!.content, /cp-held held, lease \/wt\/cp-held, head none/);
	await next.reconcile();
	assert.equal(next.durableWakeups.pending().filter((entry) => entry.content.startsWith("RESTART AFTER DRAIN")).length, 1, "reported once");
});

test("reconcile: a parent startup closes the ledger row of a research job torn down just before a crash", async (t) => {
	const home = createScratchHome();
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(async () => {
		await post.shutdown();
		home.cleanup();
	});
	const scratch = createScratchLedger({ knownProjects: ["demo"], home: home.path });
	const job = await scratch.ledger.create({ title: "synthetic research", project: "demo", delivery: "pipeline", kind: "research" });
	await scratch.ledger.claim(job.id, "w");
	await post.fleet.add(record(job.id, {
		kind: "research", delivery: "pipeline", phase: "done", reported_at: isoTimestamp(),
		closed_at: isoTimestamp(new Date(Date.now() + 60_000)), closed_reason: "gated",
		worker: { ...record(job.id).worker, exited_at: isoTimestamp() },
	}));
	mkdirSync(join(home.path, paths.runDir(job.id)), { recursive: true });
	writeFileSync(join(home.path, paths.envelopeFile(job.id)), JSON.stringify({
		schema_version: SCHEMA_VERSION, job_id: job.id, received_at: isoTimestamp(), attempt: 1,
		envelope: { job_id: job.id, kind: "research", status: "done", summary: "synthetic findings", artifact_path: "/synthetic/report.md" },
	}));
	await post.reconcile();
	const closed = await scratch.ledger.show(job.id);
	assert.equal(closed.status, "closed");
	assert.equal(closed.close_reason, "researched: /synthetic/report.md");
});

test("cp_parent drain path: parentDiagnostic sends /cp-drain <seconds> and returns the parent's immediate answer", async () => {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	const prompts: string[] = [];
	const proc = {
		onEvent: (listener: (event: Record<string, unknown>) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		request: async (type: string, payload: { message?: string }) => {
			if (type === "get_commands") return { success: true, data: { commands: [{ name: "cp-drain", source: "extension" }] } };
			prompts.push(payload.message ?? "");
			for (const listener of listeners) listener({ type: "extension_ui_request", method: "notify", notifyType: "info", message: "DRAIN: draining since 2026-09-27T12:00:00Z: waiting" });
			return { success: true };
		},
	} as unknown as WorkerProcess;
	const result = await parentDiagnostic(proc, "drain", 5_000, "30");
	assert.deepEqual(prompts, ["/cp-drain 30"]);
	assert.match(result.text, /^DRAIN: draining since/);
	assert.equal(result.level, "info");
	assert.equal(listeners.size, 0, "the listener is released");
	await parentDiagnostic(proc, "drain", 5_000, "cancel"); // CpBridge.drainCancel, the host's drainCancel op
	assert.deepEqual(prompts, ["/cp-drain 30", "/cp-drain cancel"]);
});

test("restartActivity: idle live workers are not blockers; mid-turn, unknown-status and script pids are (cp-ccm0)", () => {
	const live = (jobId: string, overrides: Partial<FleetRecord> = {}) => record(jobId, { ...overrides, worker: { ...record(jobId).worker, pid: process.pid, ...overrides.worker } });
	const script = (jobId: string, exited_at?: string) => ({ ...record(jobId, { phase: "held" }), executor: "script", worker: undefined, script_path: "scripts/x.sh", script_process: { pid: process.pid, started_at: "2026-09-27T12:00:00Z", ...(exited_at ? { exited_at } : {}) } }) as unknown as FleetRecord;
	const records = [
		live("cp-idle", { phase: "held" }),
		live("cp-working", { phase: "waiting" }),
		live("cp-unknown", { phase: "launching" }),
		record("cp-dead", { phase: "held" }),
		live("cp-exited", { phase: "held", worker: { ...record("x").worker, pid: process.pid, exited_at: "2026-09-27T13:00:00Z" } }),
		live("cp-done", { phase: "done" }),
		script("cp-script"),
		script("cp-script-exited", "2026-09-27T13:00:00Z"),
	];
	const phases: Record<string, RunPhase> = { "cp-idle": "idle", "cp-working": "working", "cp-exited": "working", "cp-done": "working" };
	assert.deepEqual(restartActivity(records, (jobId) => phases[jobId]), { working: ["cp-working", "cp-unknown"], scripts: ["cp-script"] });
	assert.ok(liveWorkerJobs(records).includes("cp-idle"), "liveWorkerJobs keeps its meaning: what a restart kills");
});
