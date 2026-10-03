/**
 * Bounded recovery without the operator (pi-command-post-autonomy-programme-cur.4.2).
 *
 * The pure decision, the persisted counter and the brief text are tested
 * hermetically, against stubs. But a stub reviver cannot reproduce the bug
 * cur.4.2's review caught (finding 1): a real `Reviver.plan` refuses a job
 * `fail()` has already moved to `phase: failed`, unless it is told
 * `recovering: true` \u2014 so the two "watcher, end to end" tests below drive the
 * real `FleetStore`, `Reviver` and `WorkerManager`, the same recipe
 * `tests/revive.test.ts` uses for its own real-child-process case.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Failure,
	isoTimestamp,
	type FleetRecord,
	paths,
	RECOVERY_ATTEMPT_BOUND,
	RECOVERY_POLICY,
	type UnreportedWork,
} from "../src/contracts.ts";
import { BOUND_SPENT_PHRASE, type FailRecoveryFact, recoveryLine } from "../src/failure-announcer.ts";
import { EscalationStore } from "../src/escalation.ts";
import type { JobClaims } from "../src/job-claims.ts";
import { FleetStore } from "../src/fleet.ts";
import { loadProfile } from "../src/profiles.ts";
import { Reviver } from "../src/revive.ts";
import {
	BoundedRecovery,
	decideBoundedRecovery,
	readRecoveryAttempts,
	recordRecoveryAttempt,
	recoveryRedispatchBriefText,
	recoveryReviveBriefText,
	type RecoveryManager,
	type RecoveryReviver,
	type RecoverySender,
} from "../src/recovery.ts";
import { RunRegistry } from "../src/runs.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readRunEvents,
	REPO_ROOT,
	type ScratchHome,
	type ScratchRepo,
	waitFor,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const JOB_ID = "cp-recover";

// ---------------------------------------------------------------------------
// decideBoundedRecovery — pure
// ---------------------------------------------------------------------------

test("the policy table has an action for every failure class", () => {
	for (const cls of Object.keys(RECOVERY_POLICY) as (keyof typeof RECOVERY_POLICY)[]) {
		assert.ok(["revive", "redispatch", "none"].includes(RECOVERY_POLICY[cls]));
	}
});

test("a transient class recovers on attempt one, escalates on attempt two", () => {
	const first = decideBoundedRecovery({ class: "crash", attempts: 0, riskHigh: false });
	assert.equal(first.action, "revive");
	assert.equal(first.attempt, 1);

	const second = decideBoundedRecovery({ class: "crash", attempts: RECOVERY_ATTEMPT_BOUND, riskHigh: false });
	assert.equal(second.action, "escalate");
	assert.match(second.reason, /recurred after 1 automatic/);
});

test("a hard bound redispatches once, then escalates", () => {
	const first = decideBoundedRecovery({ class: "wall_clock_exceeded", attempts: 0, riskHigh: false });
	assert.equal(first.action, "redispatch");
	const spent = decideBoundedRecovery({ class: "tool_call_cap_exceeded", attempts: 1, riskHigh: false });
	assert.equal(spent.action, "escalate");
});

test("a policy cause escalates immediately, on the very first occurrence", () => {
	for (const cls of ["tool_loop", "budget_exceeded", "envelope_invalid", "spawn_failed", "model_call_failed"] as const) {
		const decision = decideBoundedRecovery({ class: cls, attempts: 0, riskHigh: false });
		assert.equal(decision.action, "escalate", cls);
		assert.match(decision.reason, /policy cause/);
	}
});

test("risk:high never auto-recovers, whatever the class", () => {
	const decision = decideBoundedRecovery({ class: "crash", attempts: 0, riskHigh: true });
	assert.equal(decision.action, "escalate");
	assert.match(decision.reason, /risk:high/);
});

// ---------------------------------------------------------------------------
// Persisted attempt counter
// ---------------------------------------------------------------------------

test("the attempt counter is per (job, class) and survives a fresh read", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.equal(readRecoveryAttempts(home.path, JOB_ID, "crash"), 0);
	assert.equal(recordRecoveryAttempt(home.path, JOB_ID, "crash"), 1);
	assert.equal(readRecoveryAttempts(home.path, JOB_ID, "crash"), 1);
	// A different class on the same job starts its own count.
	assert.equal(readRecoveryAttempts(home.path, JOB_ID, "timeout"), 0);
	assert.equal(recordRecoveryAttempt(home.path, JOB_ID, "crash"), 2);
});

// ---------------------------------------------------------------------------
// Briefs name what is already true, never redo
// ---------------------------------------------------------------------------

test("the revive brief tells the worker to continue, not redo", () => {
	const text = recoveryReviveBriefText(JOB_ID, { class: "crash", message: "exit 1", at: isoTimestamp() });
	assert.match(text, /revived on this same session/);
	assert.match(text, /do not redo work/);
});

test("the redispatch brief carries the on-disk evidence", () => {
	const text = recoveryRedispatchBriefText(
		JOB_ID,
		{ class: "wall_clock_exceeded", message: "bound hit", at: isoTimestamp() },
		{
			state: "dirty",
			files: ["src/app.ts"],
			file_count: 1,
			commits_ahead: 0,
			observed_at: isoTimestamp(),
		},
	);
	assert.match(text, /SAME worktree/);
	assert.match(text, /src\/app\.ts/);
	assert.match(text, /Do NOT redo the work/);
});

// ---------------------------------------------------------------------------
// The watcher, end to end against stubs
// ---------------------------------------------------------------------------

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	runs: RunRegistry;
	escalations: EscalationStore;
	reviver: RecoveryReviver & { plans: number; revives: number; ok: boolean };
	sender: RecoverySender & { sent: string[] };
	recovery: BoundedRecovery;
}

function record(home: string, overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: `${home}/s.jsonl`,
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: `${home}/wt`,
		branch: JOB_ID,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		...overrides,
	};
}

async function bench(t: { after(fn: () => void | Promise<void>): void }, overrides: Partial<FleetRecord> = {}): Promise<Bench> {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const escalations = new EscalationStore({ home: home.path });
	await fleet.add(record(home.path, overrides));
	const reviver: Bench["reviver"] = {
		plans: 0,
		revives: 0,
		ok: true,
		async plan(jobId) {
			this.plans += 1;
			return this.ok
				? { ok: true, job_id: jobId, session_file: "s.jsonl", worktree: `${home.path}/wt`, model: "mock/model", profile: "implementer", role: "implementer", worktreeDirty: false }
				: { ok: false, job_id: jobId, code: "session_missing", message: "no session file" };
		},
		async revive(jobId) {
			this.revives += 1;
			return { job_id: jobId, pid: 4242, session_file: "s.jsonl", model: "mock/model", worktreeDirty: false };
		},
	};
	const sender: Bench["sender"] = {
		sent: [],
		async send(jobId, message) {
			this.sent.push(message);
			return { receipt: "delivered" };
		},
	};
	const recovery = new BoundedRecovery({
		home: home.path,
		fleet,
		runs,
		escalations,
		reviver: () => reviver,
		sender,
	});
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return { home, fleet, runs, escalations, reviver, sender, recovery };
}

const CRASH = (): Failure => ({ class: "crash", message: "worker exited without reporting", at: isoTimestamp() });


test("a policy failure (tool_loop) escalates immediately, no revive attempted", async (t) => {
	const b = await bench(t);
	const outcome = await b.recovery.onDeath(JOB_ID, { class: "tool_loop", message: "same call 6x", at: isoTimestamp() });
	assert.equal(outcome.action, "escalated");
	assert.equal(b.reviver.plans, 0, "never attempted a revive");
	assert.equal(b.escalations.list().length, 1);
});

test("a risk:high job never auto-recovers, even a transient class", async (t) => {
	const b = await bench(t, { routing: { scope: "S", risk: "high", inferred: false } });
	const outcome = await b.recovery.onDeath(JOB_ID, CRASH());
	assert.equal(outcome.action, "escalated");
	assert.equal(b.reviver.plans, 0);
});

test("cp-a9fq: a teardown in flight wins; recovery stands down without spending an attempt, and owns the job while it runs", async (t) => {
	const b = await bench(t);
	const claims: JobClaims = new Map([[JOB_ID, "teardown"]]);
	const recovery = new BoundedRecovery({ home: b.home.path, fleet: b.fleet, runs: b.runs, escalations: b.escalations, reviver: () => b.reviver, sender: b.sender, claims });
	const outcome = await recovery.onDeath(JOB_ID, CRASH());
	assert.equal(outcome.action, "revive_refused");
	assert.match(outcome.action === "revive_refused" ? outcome.reason : "", /teardown is in flight/);
	assert.equal(b.reviver.plans, 0, "nothing was attempted beside the teardown");
	assert.equal(readRecoveryAttempts(b.home.path, JOB_ID, "crash"), 0, "no attempt spent");
	assert.equal(b.escalations.list().length, 0);
	const logged = readRunEvents(b.home.path, JOB_ID).find((event) => event.type === "recovery_failed");
	assert.equal((logged?.payload as { stage?: string } | undefined)?.stage, "claim", "the stand-down is in the run log");
	assert.equal(claims.get(JOB_ID), "teardown", "the stand-down never takes the teardown's claim");

	claims.delete(JOB_ID);
	const running = recovery.onDeath(JOB_ID, CRASH());
	assert.equal(claims.get(JOB_ID), "recovery", "claimed synchronously, before the first await");
	assert.equal((await running).action, "revived");
	assert.equal(claims.has(JOB_ID), false, "released once settled");
});

// ---------------------------------------------------------------------------
// The watcher, end to end against the real FleetStore, Reviver and
// WorkerManager (cur.4.2 review, finding 1): a stubbed reviver cannot see the
// `not_revivable_phase` refusal a real one raised against a job `fail()` had
// already moved to `phase: failed` — these two drive the real revive path,
// one transient class (worker death) and one hard-bound class.
// ---------------------------------------------------------------------------

const PROFILES_DIR = join(REPO_ROOT, "profiles");

interface LiveJob {
	home: ScratchHome;
	repo: ScratchRepo;
	agentDir: ReturnType<typeof createAgentDir>;
	provider: MockProvider;
	fleet: FleetStore;
	runs: RunRegistry;
	escalations: EscalationStore;
	manager2: WorkerManager;
	sender: RecoverySender & { sent: string[] };
	recovery: BoundedRecovery;
	jobId: string;
	deadPid: number;
	deadSessionFile: string;
}

/** Spawn a real worker, kill -9 it, and fleet-register it dead \u2014 exactly what bounded recovery finds after `fail()` runs. */
async function liveJob(t: { after(fn: () => void | Promise<void>): void }, failure: Failure): Promise<LiveJob> {
	const jobId = "cp-recover-e2e";
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "recovery-e2e" });
	const home = createScratchHome();
	const agentDir = createAgentDir({ provider });
	const model = provider.addScript("recovery-e2e", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 600" } }] },
		{ kind: "text", text: "resumed" },
	]);
	agentDir.writeModels(provider);

	const manager1 = new WorkerManager({ home: home.path, workerReporterPath: WORKER_REPORTER_EXTENSION, parentEnv: { ...process.env, ...agentDir.env } });
	const runDir = join(home.path, paths.runDir(jobId));
	mkdirSync(runDir, { recursive: true });
	const profile = loadProfile(PROFILES_DIR, "implementer");
	const sessionDir = join(home.path, "sessions");
	const managed = manager1.spawn({ identity: { jobId, kind: "ship", delivery: "pr", runDir, worktree: repo.path }, profile, model, sessionDir });
	await managed.worker.prompt("run the command");
	await managed.worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
	const state = await managed.worker.getState(30_000);
	const sessionFile = state.sessionFile as string;
	const deadPid = managed.worker.pid as number;
	await waitFor(() => existsSync(sessionFile), (ok) => ok, { what: "worker session file" });

	const fleet = new FleetStore({ home: home.path });
	await fleet.add({
		job_id: jobId,
		project: "recovery-e2e",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: deadPid,
			session_id: (state.sessionId as string | undefined) ?? "unknown",
			session_file: sessionFile,
			profile: profile.frontmatter.name,
			role: profile.frontmatter.role,
			model,
			started_at: isoTimestamp(),
		},
		worktree: repo.path,
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	});

	// kill -9: exactly what a dead worker leaves behind.
	await managed.worker.kill("SIGKILL");
	// `fail()` (FailureAnnouncer, restored ordering \u2014 cur.4.2 review, finding 1/2)
	// always runs before bounded recovery is even asked; this is the state it
	// leaves, and the only state bounded recovery ever finds.
	await fleet.markFailed(jobId, failure);

	// A brand-new manager, standing in for the restarted parent \u2014 the real
	// `Reviver.revive` relaunches through this one, not `manager1`.
	const manager2 = new WorkerManager({ home: home.path, workerReporterPath: WORKER_REPORTER_EXTENSION, parentEnv: { ...process.env, ...agentDir.env } });
	const runs = new RunRegistry(home.path);
	const escalations = new EscalationStore({ home: home.path });
	const reviver = new Reviver({
		home: home.path,
		profilesDir: PROFILES_DIR,
		fleet,
		manager: manager2,
		runs,
		isPidAlive: () => false, // the real pid is gone; this pins the "gone" branch deterministically
	});
	const sender: LiveJob["sender"] = {
		sent: [],
		async send(id, message) {
			this.sent.push(message);
			return { receipt: "delivered" };
		},
	};
	const recovery = new BoundedRecovery({ home: home.path, fleet, runs, escalations, reviver: () => reviver, sender, manager: manager2, profilesDir: PROFILES_DIR });

	t.after(async () => {
		await manager1.shutdownAll();
		await manager2.shutdownAll();
		runs.closeAll();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	return { home, repo, agentDir, provider, fleet, runs, escalations, manager2, sender, recovery, jobId, deadPid, deadSessionFile: sessionFile };
}

test(
	"a transient worker death (crash) is revived once for real, then escalates on the second occurrence",
	{ timeout: 120_000 },
	async (t) => {
		const failure: Failure = { class: "crash", message: "worker exited without reporting", at: isoTimestamp() };
		const j = await liveJob(t, failure);

		const outcome = await j.recovery.onDeath(j.jobId, failure);
		assert.equal(outcome.action, "revived");
		assert.equal(j.sender.sent.length, 1, "one brief sent");
		assert.equal(j.escalations.list().length, 0, "zero escalations");
		assert.equal(readRecoveryAttempts(j.home.path, j.jobId, "crash"), 1, "attempt counter 1");

		const revivedRecord = j.fleet.require(j.jobId);
		assert.notEqual(revivedRecord.worker.pid, j.deadPid, "worker relaunched: a new pid, not the dead one");
		assert.equal(revivedRecord.phase, "waiting", "a revived job is not left phase: failed");
		assert.ok(j.manager2.get(j.jobId), "the revived worker is registered under the job's key");

		const second = await j.recovery.onDeath(j.jobId, {
			class: "crash",
			message: "worker exited without reporting",
			at: isoTimestamp(),
		});
		assert.equal(second.action, "escalated");
		assert.equal(j.sender.sent.length, 1, "zero further briefs");
		assert.equal(j.escalations.list().length, 1, "exactly one escalation");
	},
);

test(
	"a hard bound (wall_clock_exceeded) redispatches once for real, then escalates on the second occurrence",
	{ timeout: 120_000 },
	async (t) => {
		const failure: Failure = { class: "wall_clock_exceeded", message: "wall_clock bound exceeded", at: isoTimestamp() };
		const j = await liveJob(t, failure);
		const work = { state: "dirty" as const, files: ["src/app.ts"], file_count: 1, commits_ahead: 0, observed_at: isoTimestamp() };

		const outcome = await j.recovery.onBound(j.jobId, failure, work);
		assert.equal(outcome.action, "revived");
		assert.equal(j.sender.sent.length, 1, "one brief sent");
		assert.match(j.sender.sent[0] ?? "", /src\/app\.ts/);
		assert.match(j.sender.sent[0] ?? "", /Do NOT redo the work/);
		assert.equal(j.escalations.list().length, 0, "zero escalations");
		assert.equal(readRecoveryAttempts(j.home.path, j.jobId, "wall_clock_exceeded"), 1, "attempt counter 1");

		const revivedRecord = j.fleet.require(j.jobId);
		assert.notEqual(revivedRecord.worker.pid, j.deadPid, "worker relaunched: a new pid, not the dead one");
		assert.notEqual(
			revivedRecord.worker.session_file,
			j.deadSessionFile,
			"redispatch (cur.4.4): a fresh session file, never the dead worker's resumed one",
		);
		assert.equal(revivedRecord.phase, "waiting", "a redispatched job is not left phase: failed");
		assert.ok(j.manager2.get(j.jobId), "the redispatched worker is registered under the job's key");

		const second = await j.recovery.onBound(j.jobId, failure, work);
		assert.equal(second.action, "escalated");
		assert.equal(j.sender.sent.length, 1, "zero further briefs");
		assert.equal(j.escalations.list().length, 1, "exactly one escalation");
	},
);

test("a refused revive plan escalates instead of throwing", async (t) => {
	const b = await bench(t);
	b.reviver.ok = false;
	const outcome = await b.recovery.onDeath(JOB_ID, CRASH());
	assert.equal(outcome.action, "revive_refused");
	assert.equal(b.escalations.list().length, 1);
});

// ---------------------------------------------------------------------------
// settleBound (zh7.4): a hard bound is announced once its outcome is known
// ---------------------------------------------------------------------------

const BOUND = (): Failure => ({ class: "wall_clock_exceeded", message: "wall_clock bound exceeded", at: isoTimestamp() });
/** The state `fail(..., "defer")` leaves: failed, with the bound as its cause. */
const TRIPPED = (): Partial<FleetRecord> => ({ phase: "failed", failure: BOUND() });
const WORK: UnreportedWork = { state: "clean", files: [], file_count: 0, commits_ahead: 0, observed_at: isoTimestamp() };

async function settle(recovery: BoundedRecovery, failure: Failure = BOUND()): Promise<{ announced: FailRecoveryFact[]; fact: FailRecoveryFact | undefined }> {
	const announced: FailRecoveryFact[] = [];
	const fact = await recovery.settleBound(JOB_ID, failure, WORK, (value) => {
		announced.push(value);
	});
	return { announced, fact };
}

test("settleBound: a revive announces nothing", async (t) => {
	const b = await bench(t, TRIPPED());
	b.recovery.onBound = async () => ({ action: "revived", attempt: 1 });
	const { announced } = await settle(b.recovery);
	assert.deepEqual(announced, []);
});

test("settleBound: a refused redispatch announces the outcome once, never a preview", async (t) => {
	const b = await bench(t, TRIPPED());
	// No manager wired: the redispatch itself is refused.
	const { announced } = await settle(b.recovery);
	assert.equal(announced.length, 1);
	assert.equal(announced[0]?.attempted, true);
	assert.equal(announced[0]?.attemptsLeft, 0);
	assert.equal(announced[0]?.pending, undefined);
	const line = recoveryLine(announced[0] as FailRecoveryFact);
	assert.match(line, /attempted, not revived \(automatic recovery could not redispatch/);
	assert.doesNotMatch(line, /did not stick/);
	assert.equal(b.escalations.list().length, 1);
});

test("settleBound: a spent bound announces BOUND_SPENT_PHRASE with 0 attempts left", async (t) => {
	const b = await bench(t, TRIPPED());
	recordRecoveryAttempt(b.home.path, JOB_ID, "wall_clock_exceeded");
	const { announced } = await settle(b.recovery);
	assert.equal(announced.length, 1);
	assert.deepEqual({ attempted: announced[0]?.attempted, attemptsLeft: announced[0]?.attemptsLeft }, { attempted: false, attemptsLeft: 0 });
	assert.equal(recoveryLine(announced[0] as FailRecoveryFact), BOUND_SPENT_PHRASE);
});

test("settleBound: a rejected attempt is announced as operational, logged, and keeps the lease", async (t) => {
	const b = await bench(t, TRIPPED());
	b.recovery.onBound = async () => {
		throw new Error("spawn exploded");
	};
	const { announced } = await settle(b.recovery);
	assert.equal(announced.length, 1);
	assert.equal(announced[0]?.error, true);
	assert.match(recoveryLine(announced[0] as FailRecoveryFact), /failed operationally \(spawn exploded\).*lease and worktree kept/);
	assert.equal(b.fleet.require(JOB_ID).phase, "failed", "nothing tore the job down");
	b.runs.closeAll();
	assert.ok(readRunEvents(b.home.path, JOB_ID).some((event) => event.type === "recovery_failed"));
});

test("settleBound: a live replacement that raced the outcome gets no notice", async (t) => {
	const b = await bench(t, TRIPPED());
	b.recovery.onBound = async () => {
		await b.fleet.mutate((jobs) => {
			const job = jobs.find((candidate) => candidate.job_id === JOB_ID);
			if (job) job.phase = "waiting";
		});
		return { action: "revive_refused", reason: "raced", attempted: true, attemptsLeft: 0 };
	};
	assert.deepEqual((await settle(b.recovery)).announced, []);

	// Fleet still says failed, but the manager holds a worker other than the tripped one.
	const c = await bench(t, TRIPPED());
	const manager = { get: () => ({ worker: { pid: 999_999 } }) } as unknown as RecoveryManager;
	const recovery = new BoundedRecovery({ home: c.home.path, fleet: c.fleet, runs: c.runs, escalations: c.escalations, reviver: () => c.reviver, sender: c.sender, manager });
	recovery.onBound = async () => ({ action: "revive_refused", reason: "raced", attempted: true, attemptsLeft: 0 });
	assert.deepEqual((await settle(recovery)).announced, []);
});
