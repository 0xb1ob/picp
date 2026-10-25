/**
 * Retained from tests/recovery.test.ts by P8d (cp-e2e-migration-p8d-om9z): declarations no e2e entry point reaches.
 * Each is verbatim; the ledger row in docs/testing-migration/p8d.md names why.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type Failure, isoTimestamp, type FleetRecord, RECOVERY_POLICY, type UnreportedWork } from "../src/contracts.ts";
import { type FailRecoveryFact, recoveryLine } from "../src/failure-announcer.ts";
import { EscalationStore } from "../src/escalation.ts";
import type { JobClaims } from "../src/job-claims.ts";
import { FleetStore } from "../src/fleet.ts";
import {
	BoundedRecovery,
	decideBoundedRecovery,
	readRecoveryAttempts,
	type RecoveryManager,
	type RecoveryReviver,
	type RecoverySender,
} from "../src/recovery.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, readRunEvents, type ScratchHome } from "./harness/index.ts";

const JOB_ID = "cp-recover";

test("the policy table has an action for every failure class", () => {
	for (const cls of Object.keys(RECOVERY_POLICY) as (keyof typeof RECOVERY_POLICY)[]) {
		assert.ok(["revive", "redispatch", "none"].includes(RECOVERY_POLICY[cls]));
	}
});

test("a policy cause escalates immediately, on the very first occurrence", () => {
	for (const cls of ["tool_loop", "budget_exceeded", "envelope_invalid", "spawn_failed", "model_call_failed"] as const) {
		const decision = decideBoundedRecovery({ class: cls, attempts: 0, riskHigh: false });
		assert.equal(decision.action, "escalate", cls);
		assert.match(decision.reason, /policy cause/);
	}
});

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

test("cp-a9fq: a teardown in flight wins; recovery stands down without spending an attempt, and owns the job while it runs", async (t) => {
	const b = await bench(t);
	const claims: JobClaims = new Map([[JOB_ID, "teardown"]]);
	const recovery = new BoundedRecovery({ home: b.home.path, fleet: b.fleet, runs: b.runs, escalations: b.escalations, reviver: () => b.reviver, sender: b.sender, claims });
	const outcome = await recovery.onDeath(JOB_ID, CRASH());
	assert.equal(outcome.action, "revive_refused");
	assert.match(outcome.action === "revive_refused" ? outcome.reason : "", /teardown is in flight.*Nothing retries it automatically.*cp_revive cp-recover/);
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

test("a live tool child refuses the revive before the attempt is spent: one escalation, attempted false", async (t) => {
	const b = await bench(t);
	b.reviver.plan = async (jobId) => {
		b.reviver.plans += 1;
		return { ok: false, job_id: jobId, code: "tool_child_alive", message: "pid 4242 has live child process(es) 4243" };
	};
	const outcome = await b.recovery.onDeath(JOB_ID, CRASH());
	assert.deepEqual(
		outcome.action === "revive_refused" ? { attempted: outcome.attempted, attemptsLeft: outcome.attemptsLeft } : outcome,
		{ attempted: false, attemptsLeft: 1 },
	);
	assert.match(outcome.action === "revive_refused" ? outcome.reason : "", /tool_child_alive/);
	assert.equal(readRecoveryAttempts(b.home.path, JOB_ID, "crash"), 0, "recovery-attempts.json not incremented");
	assert.equal(b.reviver.revives, 0, "nothing spawned");
	assert.equal(b.escalations.list().length, 1, "escalated once");
});

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
