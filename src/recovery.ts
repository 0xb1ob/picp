/**
 * Bounded recovery without the operator (pi-command-post-autonomy-programme-cur.4.2).
 *
 * Ordinary failures are handled within limits, with nobody watching: one
 * automatic revive (or re-dispatch) per failure class per job, then
 * escalation. This module is the decision and the bookkeeping; the actions
 * themselves are the same tools an operator would reach for (`cp_revive`,
 * `cp_send`) — a revival never invents a new mechanism, it just does not wait
 * for a human to ask for it first.
 *
 * Three things this module refuses to do, on purpose:
 *  - it never deletes or resets a worktree. A `revive` action relaunches
 *    (`Reviver.revive`) on the same session file inside the same worktree; a
 *    `redispatch` action (cur.4.4) spawns a fresh worker straight onto that
 *    same worktree/branch instead \u2014 never through `Reviver` (which would
 *    resume the dead session) and never through `Dispatcher.dispatch` (which
 *    would take a new lease from the pool). Neither path acquires a fresh
 *    lease or cuts a fresh branch.
 *  - it never retries a `policy` cause (`RECOVERY_POLICY[class] === "none"`)
 *    or a `risk:high` job. Both escalate on the first occurrence.
 *  - it never loops past `RECOVERY_ATTEMPT_BOUND` (one) automatic attempts
 *    for the same (job, class) pair. The bound is read from a file in the
 *    run dir, so a parent restart cannot hand out a second one.
 *
 * `onDeath`/`onBound` are invoked *after* `FailureAnnouncer.fail` (#191's one
 * `waiting \u2192 failed` writer) has already run \u2014 that ordering is load-bearing:
 * `fail` must win the race against the generic close-observer classification
 * that `shutdown()` can otherwise trigger, or two paths call `recordRecoveryAttempt`
 * for the same job concurrently. `Reviver.plan`/`revive` therefore take a
 * `recovering: true` option (see `revive.ts`) to act on the job `fail` just
 * moved to `phase: failed`. Consequences of running after the write
 * (cur.4.2 review, finding 2): a death wake-up is journaled by `fail` with the
 * `previewDecision` fact (an attempt *in flight*, never a claim about its
 * outcome) and retracted by the caller on `action: "revived"`. A hard bound's
 * wake-up is deferred instead (zh7.4): `settleBound` runs the attempt, then
 * announces once, from the outcome and the job's current liveness.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import {
	describeUnreportedWork,
	isoTimestamp,
	isScriptFleetRecord,
	LAYOUT, paths,
	RECOVERY_ATTEMPT_BOUND,
	RECOVERY_POLICY,
	type Failure,
	type FailureClass,
	type FleetRecord,
	type RecoveryPolicyAction,
	type UnreportedWork,
} from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";
import { type JobClaims, withJobClaim } from "./job-claims.ts";
import { assertNotDraining } from "./drain.ts";
import { resolveJobHardBounds } from "./bounds.ts";
import { raiseLoopExhausted, type EscalationStore } from "./escalation.ts";
import { attachWorkerObservers, type WorkerObserverOptions } from "./dispatch.ts";
import { loadProfile } from "./profiles.ts";
import type { RunRegistry } from "./runs.ts";
import type { RevivePlanOptions, RevivePlanResult, ReviveResult } from "./revive.ts";
import type { FailRecoveryFact } from "./failure-announcer.ts";
import type { FleetStore } from "./fleet.ts";
import type { WorkerManager } from "./worker-manager.ts";

// ---------------------------------------------------------------------------
// Persisted attempt counter
// ---------------------------------------------------------------------------

interface RecoveryAttemptsFile {
	schema_version: 1;
	attempts: Partial<Record<FailureClass, number>>;
}

const EMPTY: RecoveryAttemptsFile = { schema_version: 1, attempts: {} };

function readAttemptsFile(home: string, jobId: string): RecoveryAttemptsFile {
	const file = `${home}/${paths.recoveryAttemptsFile(jobId)}`;
	if (!existsSync(file)) return EMPTY;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RecoveryAttemptsFile>;
		return { schema_version: 1, attempts: parsed.attempts ?? {} };
	} catch {
		return EMPTY;
	}
}

/** How many automatic recovery attempts this (job, class) pair has already spent. */
export function readRecoveryAttempts(home: string, jobId: string, cls: FailureClass): number {
	return readAttemptsFile(home, jobId).attempts[cls] ?? 0;
}

/** Consume one attempt for this (job, class) pair. Returns the new count. */
export function recordRecoveryAttempt(home: string, jobId: string, cls: FailureClass): number {
	const current = readAttemptsFile(home, jobId);
	const next = (current.attempts[cls] ?? 0) + 1;
	const file = `${home}/${paths.recoveryAttemptsFile(jobId)}`;
	atomicWriteJson(file, { schema_version: 1, attempts: { ...current.attempts, [cls]: next } });
	return next;
}

// ---------------------------------------------------------------------------
// The decision — pure, testable without a fleet or a worker
// ---------------------------------------------------------------------------

export interface RecoveryDecisionInput {
	class: FailureClass;
	/** Attempts already consumed for this (job, class) pair. */
	attempts: number;
	/** `risk:high` jobs never auto-recover, whatever the class. */
	riskHigh: boolean;
}

export interface RecoveryDecision {
	action: RecoveryPolicyAction | "escalate";
	reason: string;
	/** The attempt number this action would be, or the count that was reached when escalating. */
	attempt: number;
}

/**
 * The whole ladder, decided from facts only: `RECOVERY_POLICY[class]`,
 * `risk:high`, and the attempt count already spent. Never reads a file or a
 * fleet record — the caller supplies those as plain values so this stays a
 * one-line-per-branch function a test can call directly.
 */
export function decideBoundedRecovery(input: RecoveryDecisionInput): RecoveryDecision {
	if (input.riskHigh) {
		return { action: "escalate", reason: "risk:high jobs never auto-recover", attempt: input.attempts };
	}
	const base = RECOVERY_POLICY[input.class];
	if (base === "none") {
		return {
			action: "escalate",
			reason: `${input.class} is a policy cause \u2014 not auto-recoverable, a human decides`,
			attempt: input.attempts,
		};
	}
	if (input.attempts >= RECOVERY_ATTEMPT_BOUND) {
		return {
			action: "escalate",
			reason: `${input.class} recurred after ${input.attempts} automatic ${base} attempt(s) (bound ${RECOVERY_ATTEMPT_BOUND}) \u2014 escalating instead of looping`,
			attempt: input.attempts,
		};
	}
	return {
		action: base,
		reason: `${input.class} is recoverable: ${base} (attempt ${input.attempts + 1}/${RECOVERY_ATTEMPT_BOUND})`,
		attempt: input.attempts + 1,
	};
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

/** What a revived worker is told after a transient death: continue, do not redo. */
export function recoveryReviveBriefText(jobId: string, cause: Failure, interruptedTool?: { name: string }): string {
	const lines = [
		`Automatic recovery: ${jobId} died (${cause.class}: ${cause.message}) and has been revived on this same session.`,
		"Nothing on disk was touched. Continue exactly where you left off:",
		...(interruptedTool
			? [`the interrupted call was ${interruptedTool.name}; treat it as failed and retry it, do not assume it ran.`]
			: []),
		"do not redo work you had already finished, and call report_result once you are done.",
		"This is the one automatic recovery this job gets for this failure; a repeat is escalated to a human.",
	];
	return lines.join("\n");
}

/** What a fresh worker is told after a hard-bound stop: the evidence, then finish. */
export function recoveryRedispatchBriefText(jobId: string, cause: Failure, work: UnreportedWork): string {
	const shown = work.files.map((file) => `    - ${file}`);
	const more = work.file_count - work.files.length;
	if (more > 0) shown.push(`    - \u2026 ${more} more file(s)`);
	return [
		`Automatic recovery: ${jobId} hit a hard bound (${cause.class}) and was stopped. You are a fresh worker in the`,
		"SAME worktree \u2014 nothing was deleted or reset. Do NOT redo the work, do not re-analyse it from scratch.",
		"",
		`What is already on disk (observed ${work.observed_at}): ${describeUnreportedWork(work)}`,
		...(shown.length > 0 ? ["  uncommitted paths:", ...shown] : []),
		"",
		"Finish from exactly that state: commit what is there, push it, verify, and call report_result once.",
		"This is the one automatic recovery this job gets for this failure; a repeat is escalated to a human.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

/** The slice of `Reviver` this module drives. Narrow on purpose \u2014 a test needs a stub, not a worker. */
export interface RecoveryReviver {
	plan(jobId: string, options?: RevivePlanOptions): Promise<RevivePlanResult>;
	revive(jobId: string, options?: RevivePlanOptions): Promise<ReviveResult>;
}

/** The slice of `Sender` this module drives, after a revive. */
export interface RecoverySender {
	send(jobId: string, message: string): Promise<{ receipt: string; error?: string }>;
}

/**
 * The slice of `WorkerManager` this module drives: `get` waits out a shutdown
 * race, `spawn` is `redispatch`'s fresh worker (cur.4.4). Every real caller
 * (and test) already hands over a real `WorkerManager`, so this is a `Pick`,
 * not a hand-written stub surface.
 */
export type RecoveryManager = Pick<WorkerManager, "get" | "ready" | "spawn" | "shutdown">;

/** `get` for the decision, `mutate` for `redispatch`'s fleet write (phase, worker, cleared `failure`). */
export type RecoveryFleetLike = Pick<FleetStore, "get" | "mutate">;

export interface BoundedRecoveryOptions {
	home: string;
	fleet: RecoveryFleetLike;
	runs: RunRegistry;
	escalations: EscalationStore;
	reviver: () => RecoveryReviver;
	sender: RecoverySender;
	manager?: RecoveryManager;
	/** Required only for a `redispatch` class (cur.4.4); a `revive`-only caller may omit it. */
	profilesDir?: string;
	/** Observer wiring for a `redispatch`'s fresh worker \u2014 the same options `Reviver` takes. */
	intake?: WorkerObserverOptions["intake"];
	failures?: WorkerObserverOptions["failures"];
	settle?: WorkerObserverOptions["settle"];
	bounds?: WorkerObserverOptions["bounds"];
	onUsage?: WorkerObserverOptions["onUsage"];
	now?: () => Date;
	/** cp-a9fq: shared with Teardown so a revive and a teardown never interleave on one job. */
	claims?: JobClaims;
	/** Bounded wait for a hard-bound shutdown to finish before planning a revive. Test hook. */
	sleep?: (ms: number) => Promise<void>;
}

/** One decided outcome, for a caller (and a test) to inspect without re-reading disk. */
export type RecoveryOutcome =
	| { action: "revived"; attempt: number }
	| RecoveryNotRevived;

/**
 * The shape a caller uses to tell the truth in a `failed` wake-up (cur.4.2
 * review, finding 2): `attempted` is whether `Reviver.plan`/`revive` was ever
 * called for this occurrence (false only for a policy cause, `risk:high`, or
 * an already-exhausted bound \u2014 nothing was tried, not just "tried and lost" \u2014
 * or a `tool_child_alive` plan refusal, decided before the attempt is spent),
 * and `attemptsLeft` is what remains for this (job, class) pair afterward.
 */
export interface RecoveryNotRevived {
	action: "escalated" | "revive_refused";
	reason: string;
	attempted: boolean;
	attemptsLeft: number;
}

const SHUTDOWN_WAIT_RETRIES = 20;
const SHUTDOWN_WAIT_DELAY_MS = 150;

export class BoundedRecovery {
	readonly #options: BoundedRecoveryOptions;

	constructor(options: BoundedRecoveryOptions) {
		this.#options = options;
	}

	/**
	 * The `decideBoundedRecovery` verdict for this occurrence, without acting on
	 * it (cur.4.2 review, finding 2): synchronous and read-only, so a caller
	 * about to call `fail()` can put the true `attempted`/`attemptsLeft` facts
	 * into the wake-up `fail` is about to journal, before the actual attempt
	 * (`onDeath`/`onBound`, run afterward) has happened. Reads the exact same
	 * inputs `#recover` reads a moment later \u2014 the persisted attempt count and
	 * the fleet's `risk` \u2014 so the two never disagree.
	 */
	previewDecision(jobId: string, failure: Failure): FailRecoveryFact {
		const { home, fleet } = this.#options;
		const record = fleet.get(jobId);
		if (record && isScriptFleetRecord(record)) return { attempted: false, attemptsLeft: 0 };
		const attempts = readRecoveryAttempts(home, jobId, failure.class);
		const decision = decideBoundedRecovery({
			class: failure.class,
			attempts,
			riskHigh: record?.routing?.risk === "high",
		});
		return decision.action === "escalate"
			? { attempted: false, attemptsLeft: Math.max(RECOVERY_ATTEMPT_BOUND - attempts, 0) }
			: { attempted: true, pending: true, attemptsLeft: Math.max(RECOVERY_ATTEMPT_BOUND - decision.attempt, 0) };
	}

	/**
	 * A hard bound's whole recovery, announced once its outcome is known (zh7.4).
	 * `fail` already recorded the failed transition without a wake-up; this runs
	 * `onBound`, then hands `announce` the exact outcome — or nothing, when
	 * the job was revived or a live worker has since replaced the tripped one (a
	 * relaunch that raced this call). A rejected attempt is announced as an
	 * operational failure; the lease is never touched here.
	 */
	async settleBound(
		jobId: string,
		failure: Failure,
		work: UnreportedWork,
		announce: (fact: FailRecoveryFact) => void | Promise<void>,
	): Promise<FailRecoveryFact | undefined> {
		const before = this.#options.fleet.get(jobId);
		const trippedPid = before && !isScriptFleetRecord(before) ? before.worker.pid : undefined;
		let fact: FailRecoveryFact;
		try {
			const outcome = await this.onBound(jobId, failure, work);
			if (outcome.action === "revived") return undefined;
			fact = { attempted: outcome.attempted, attemptsLeft: outcome.attemptsLeft, reason: outcome.reason };
		} catch (error) {
			const left = Math.max(RECOVERY_ATTEMPT_BOUND - readRecoveryAttempts(this.#options.home, jobId, failure.class), 0);
			fact = { attempted: true, attemptsLeft: left, error: true, reason: error instanceof Error ? error.message : String(error) };
			try {
				this.#options.runs.open(jobId).cp("recovery_failed", { class: failure.class, stage: "recover", error: fact.reason });
			} catch {
				// The wake-up below is the visible record; a run log miss must not stop it.
			}
		}
		// A rejection is announced even beside a live worker: its wording carries
		// no teardown advice, and a silent throw is the one thing it must not be.
		if (!fact.error && this.#liveReplacement(jobId, trippedPid)) return undefined;
		await announce(fact);
		return fact;
	}

	/** A relaunch moved the fleet off `failed`, or the manager holds a worker other than the tripped one. */
	#liveReplacement(jobId: string, trippedPid: number | undefined): boolean {
		const record = this.#options.fleet.get(jobId);
		if (record && record.phase !== "failed") return true;
		const managed = this.#options.manager?.get(jobId);
		return managed !== undefined && managed.worker.pid !== trippedPid;
	}

	/** A worker died (crash, timeout, provider_limit, agent_empty_output, settled_without_report, ...). */
	onDeath(jobId: string, failure: Failure): Promise<RecoveryOutcome> {
		return this.#claimed(jobId, failure, () => this.#recover(jobId, failure, () => recoveryReviveBriefText(jobId, failure)));
	}

	/** A worker hit its wall-clock or tool-call cap. The worktree is intact; the process is already gone. */
	onBound(jobId: string, failure: Failure, work: UnreportedWork): Promise<RecoveryOutcome> {
		return this.#claimed(jobId, failure, async () => {
			await this.#waitForDeregistration(jobId);
			return this.#recover(jobId, failure, () => recoveryRedispatchBriefText(jobId, failure, work));
		});
	}

	/**
	 * cp-a9fq: recovery owns the job's in-flight state for its whole attempt, taken
	 * synchronously on entry. A teardown already in flight wins: recovery stands
	 * down without spending an attempt, and says so in the run log. Nothing
	 * retries it: if that teardown refuses, the job stays dead until an operator
	 * revives or re-dispatches it (the reason says so).
	 */
	#claimed(jobId: string, failure: Failure, work: () => Promise<RecoveryOutcome>): Promise<RecoveryOutcome> {
		return withJobClaim(this.#options.claims, jobId, "recovery", work, async (holder) => {
			const reason = `automatic recovery of ${jobId} stood down: a ${holder} is in flight for this job. Nothing retries it automatically — if that ${holder} does not close the job, cp_revive ${jobId} (or re-dispatch) once it finishes`;
			this.#options.runs.open(jobId).cp("recovery_failed", { class: failure.class, stage: "claim", error: reason });
			return { action: "revive_refused", reason, attempted: false, attemptsLeft: Math.max(RECOVERY_ATTEMPT_BOUND - readRecoveryAttempts(this.#options.home, jobId, failure.class), 0) };
		});
	}

	async #recover(jobId: string, failure: Failure, brief: () => string): Promise<RecoveryOutcome> {
		const { home, fleet, runs } = this.#options;
		const record = fleet.get(jobId);
		if (record && isScriptFleetRecord(record)) return { action: "revive_refused", reason: `${jobId} is a script job; no automatic replay`, attempted: false, attemptsLeft: 0 };
		// A drain starts no process, and a refused revive spends no attempt: the restart report owns this job.
		try { assertNotDraining(home, `automatic recovery of ${jobId}`); } catch (error) {
			return { action: "revive_refused", reason: (error as Error).message, attempted: false, attemptsLeft: Math.max(RECOVERY_ATTEMPT_BOUND - readRecoveryAttempts(home, jobId, failure.class), 0) };
		}
		const attempts = readRecoveryAttempts(home, jobId, failure.class);
		const decision = decideBoundedRecovery({
			class: failure.class,
			attempts,
			riskHigh: record?.routing?.risk === "high",
		});
		if (decision.action === "escalate") {
			await this.#escalate(jobId, failure, decision.reason);
			return { action: "escalated", reason: decision.reason, attempted: false, attemptsLeft: Math.max(RECOVERY_ATTEMPT_BOUND - attempts, 0) };
		}
		// A live tool child of the dead worker is decided before the attempt is
		// spent: waiting it out is not a failed attempt. Every other plan refusal
		// still spends, then escalates (below).
		const reviver = decision.action === "redispatch" ? undefined : this.#options.reviver();
		const plan = await reviver?.plan(jobId, { recovering: true });
		if (plan && !plan.ok && plan.code === "tool_child_alive") {
			const reason = `automatic recovery could not revive ${jobId} (${plan.code}): ${plan.message}`;
			await this.#escalate(jobId, failure, reason);
			return { action: "revive_refused", reason, attempted: false, attemptsLeft: Math.max(RECOVERY_ATTEMPT_BOUND - attempts, 0) };
		}
		const spent = recordRecoveryAttempt(home, jobId, failure.class);
		const attemptsLeft = Math.max(RECOVERY_ATTEMPT_BOUND - spent, 0);

		let pid: number;
		let sessionFile: string;
		if (decision.action === "redispatch") {
			// The worktree is intact and the process is already gone (module header,
			// `onBound`): a fresh worker on the SAME worktree/branch, never `Reviver`,
			// which would resume the dead session instead of starting a new one.
			if (!record) {
				const reason = `automatic recovery could not redispatch ${jobId}: no fleet record`;
				await this.#escalate(jobId, failure, reason);
				return { action: "revive_refused", reason, attempted: true, attemptsLeft };
			}
			try {
				const result = await this.#redispatch(jobId, record);
				pid = result.pid;
				sessionFile = result.session_file;
			} catch (error) {
				const reason = `automatic recovery could not redispatch ${jobId}: ${(error as Error).message}`;
				await this.#escalate(jobId, failure, reason);
				return { action: "revive_refused", reason, attempted: true, attemptsLeft };
			}
		} else {
			// `recovering: true`: `fail()` has already stamped `phase: failed` by the
			// time this runs (see the module header) \u2014 see `RevivePlanOptions`.
			if (!reviver || !plan) throw new Error(`${jobId}: bounded recovery planned no revive`);
			if (!plan.ok) {
				const reason = `automatic recovery could not revive ${jobId} (${plan.code}): ${plan.message}`;
				await this.#escalate(jobId, failure, reason);
				return { action: "revive_refused", reason, attempted: true, attemptsLeft };
			}
			const result = await reviver.revive(jobId, { recovering: true });
			pid = result.pid;
			sessionFile = result.session_file;
		}

		const text = brief();
		const sent = await this.#options.sender.send(jobId, text);
		runs.open(jobId).cp("recovery_attempted", {
			class: failure.class,
			action: decision.action,
			attempt: decision.attempt,
			bound: RECOVERY_ATTEMPT_BOUND,
			pid,
			session_file: sessionFile,
			send_receipt: sent.receipt,
			...(sent.error ? { send_error: sent.error } : {}),
		});
		return { action: "revived", attempt: decision.attempt };
	}

	/**
	 * `redispatch` (cur.4.4): a fresh worker on the job's EXISTING worktree and
	 * branch \u2014 a new pid, a new session file, never a resumed one. Reuses the
	 * spawn/observer wiring `src/dispatch.ts` exports for exactly this reason
	 * (`attachWorkerObservers`'s own doc comment), so a redispatched worker is
	 * observed identically to a freshly dispatched one. Never `Dispatcher.dispatch`:
	 * that takes a fresh lease from the treehouse pool, which is a DIFFERENT
	 * worktree from the one this job's partial work is sitting in.
	 */
	async #redispatch(jobId: string, record: FleetRecord): Promise<{ pid: number; session_file: string }> {
		const { home, manager, profilesDir, runs } = this.#options;
		if (!manager) throw new Error(`${jobId}: bounded recovery cannot redispatch without a manager`);
		if (!profilesDir) throw new Error(`${jobId}: bounded recovery cannot redispatch without profilesDir`);
		if (isScriptFleetRecord(record)) throw new Error(`${jobId} is a script job; bounded recovery cannot redispatch it`);
		const profile = loadProfile(profilesDir, record.worker.profile);
		const runDir = `${home}/${paths.runDir(jobId)}`;
		mkdirSync(runDir, { recursive: true });
		if (record.kind === "research") mkdirSync(`${home}/${paths.artifactDir(jobId)}`, { recursive: true });
		await manager.ready();
		const managed = manager.spawn({
			identity: {
				jobId,
				kind: record.kind,
				delivery: record.delivery,
				runDir,
				worktree: record.worktree,
				...(record.kind === "research" ? { artifactPath: `${home}/${paths.artifactFile(jobId)}` } : {}),
			},
			profile,
			model: record.worker.model,
			...(record.routing?.thinking ? { thinking: record.routing.thinking } : {}),
			sessionDir: `${home}/${LAYOUT.sessions}`,
			sessionName: jobId,
		});
		const recorder = runs.open(jobId);
		// The marker goes in FIRST, before a single event of the new process can be
		// teed (cp-0wq7): it is what reopens the projection's liveness after the
		// previous attempt's observed close.
		recorder.markSpawned({ pid: managed.worker.pid, model: record.worker.model, profile: profile.frontmatter.name });
		try {
			attachWorkerObservers({
				recorder,
				worker: managed.worker,
				jobId,
				...(this.#options.intake ? { intake: this.#options.intake } : {}),
				...(this.#options.settle ? { settle: this.#options.settle } : {}),
				...(this.#options.failures ? { failures: this.#options.failures } : {}),
				...(this.#options.bounds ? { bounds: this.#options.bounds, hardBounds: record.bounds ?? resolveJobHardBounds() } : {}),
				...(this.#options.onUsage ? { onUsage: this.#options.onUsage } : {}),
			});
			const state = await managed.worker.getState(60_000);
			const sessionId = typeof state.sessionId === "string" ? state.sessionId : jobId;
			const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : "";
			const now = this.#options.now ?? (() => new Date());
			const worker = { ...record.worker, pid: managed.worker.pid as number, session_id: sessionId, session_file: sessionFile, started_at: isoTimestamp(now()) };
			await this.#options.fleet.mutate((jobs) => {
				const job = jobs.find((candidate) => candidate.job_id === jobId);
				if (!job) return;
				job.phase = "waiting";
				delete job.failure;
				job.worker = worker;
			});
			return { pid: managed.worker.pid as number, session_file: sessionFile };
		} catch (error) {
			// The fleet must never disagree with the manager (symmetric with
			// `Dispatcher#dispatch` and `Reviver#revive`): a worker the fleet does not
			// know about is exactly the deadlock this module exists to close, in reverse.
			await manager.shutdown(jobId).catch(() => {});
			throw error;
		}
	}

	async #escalate(jobId: string, failure: Failure, reason: string): Promise<void> {
		const record = this.#options.fleet.get(jobId);
		await raiseLoopExhausted(this.#options.escalations, {
			jobId,
			question: `${jobId}: ${reason}. ${failure.message}${record ? ` (worktree ${record.worktree})` : ""}`,
			evidence_paths: [paths.eventsFile(jobId)],
		});
		this.#options.runs.open(jobId).cp("recovery_escalated", {
			class: failure.class,
			reason,
			at: isoTimestamp((this.#options.now ?? (() => new Date()))()),
		});
	}

	/** A hard-bound breach calls this hook before its own `shutdown()` finishes; wait it out, bounded. */
	async #waitForDeregistration(jobId: string): Promise<void> {
		const manager = this.#options.manager;
		if (!manager) return;
		const sleep = this.#options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
		for (let attempt = 0; attempt < SHUTDOWN_WAIT_RETRIES; attempt += 1) {
			if (!manager.get(jobId)) return;
			await sleep(SHUTDOWN_WAIT_DELAY_MS);
		}
	}
}
