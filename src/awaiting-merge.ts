/**
 * awaiting_merge PR2: park a handed-off human_handoff PR. Order is the teardown order without closing the job:
 * gates → release intent → observed worker close → gates again → lease return → fleet `awaiting_merge`.
 * Each stage is on disk before the next external effect, so `recover` resumes a crash from the stage it reached.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AwaitingMerge, type FleetRecord, FULL_SHA_PATTERN, isoTimestamp, isScriptFleetRecord, type ParkIntent, type ParkStage, paths,
	validateParkIntent,
} from "./contracts.ts";
import { ACTIONS_CI_TIMEOUT_MS, readActionsCi } from "./actions-ci.ts";
import { AwaitingMergeResume } from "./awaiting-merge-resume.ts";
import type { ExitPorts } from "./awaiting-merge-exits.ts";
import { AwaitingMergeWatch, type SweepResult } from "./awaiting-merge-watch.ts";
import { deleteCheckpoint } from "./checkpoint-ref.ts";
import type { FleetStore } from "./fleet.ts";
import type { LedgerLike } from "./integrate.ts";
import { type JobClaims, withJobClaim } from "./job-claims.ts";
import { atomicWriteJson } from "./json-store.ts";
import { leaseFromRecord, type LeaseManager } from "./leases.ts";
import { runCommand } from "./merge-ask.ts";
import { parkedCiObserver } from "./parked-ci.ts";
import { readEventLog, readStatusFile } from "./run-artifacts.ts";
import type { RunRegistry } from "./runs.ts";
import type { GateOutcome } from "./teardown.ts";
import { StackFollowups } from "./stack-followups.ts";
import { defaultGit, jobInFlight, unmanagedLiveWorker, withdrawHumanReview } from "./teardown-head.ts";
import { boundedCauseId, type DurableWakeupInput } from "./wakeup-outbox.ts";
import type { WorkerManager } from "./worker-manager.ts";

export { AwaitingMergeResume, ResumeError } from "./awaiting-merge-resume.ts";

export const PARK_FAILURE_CODES = ["not_parkable", "job_in_flight", "unmanaged_live_worker", "gate_refused", "head_mismatch", "intent_mismatch", "lease_return_failed"] as const;
export type ParkFailureCode = (typeof PARK_FAILURE_CODES)[number];
export interface ParkFailure { code: ParkFailureCode; message: string; fix: string }

/** What the handoff observed on the forge; the parked record carries it verbatim. */
export interface ParkFacts { pr_url: string; repo: string; head_sha: string; base: string; handed_at: string }

export type ParkResult =
	| { job_id: string; parked: true; awaiting_merge: AwaitingMerge }
	| { job_id: string; parked: false; failure: ParkFailure; stage?: ParkStage };

type Git = (cwd: string, args: readonly string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export interface ParkingOptions {
	home: string;
	fleet: FleetStore;
	leases: Pick<LeaseManager, "release">;
	manager: Pick<WorkerManager, "get" | "shutdown">;
	runs: RunRegistry;
	/** Teardown's clean/pushed gates (`Teardown#checkGates`); only a `pushed` pass may park. */
	gates: (record: FleetRecord) => Promise<GateOutcome>;
	git?: Git;
	claims?: JobClaims;
	now?: () => Date;
	journal?: (input: DurableWakeupInput) => void;
}

/** What CommandPost lends the ports; read per call, so the ports can be built before its constructor body runs. */
export interface AwaitingMergeHost {
	home: string;
	fleet: FleetStore;
	leases: LeaseManager;
	manager: WorkerManager;
	runs: RunRegistry;
	registry: { assertCanonicalClone(project: string): string };
	teardown: { checkGates(worktree: string, branch: string, kind: FleetRecord["kind"], jobId?: string): Promise<GateOutcome> };
	revive(jobId: string): Promise<unknown>;
	merges: ExitPorts["merges"];
	ledger(): LedgerLike;
	armedDispatches: { release(): Promise<unknown> };
	/** This home's gh login: its comments on a parked PR are CP activity, never a human event. */
	ghLogin(): Promise<string>;
}

/**
 * The park/resume primitives and the batched watch over one host and one shared claim map (teardown and recovery
 * hold the same one). `sweep` acts only while `owns()` (this process holds the home) and never throws.
 */
export function awaitingMergePorts(host: AwaitingMergeHost, claims: JobClaims, journal: (input: DurableWakeupInput) => void, owns: () => boolean = () => true) {
	const parking = () => new Parking({
		home: host.home, fleet: host.fleet, leases: host.leases, manager: host.manager, runs: host.runs, claims, journal,
		gates: (record) => host.teardown.checkGates(record.worktree, record.branch, record.kind, record.job_id),
	});
	let watch: AwaitingMergeWatch | undefined;
	const logins: string[] = [];
	const sweep = async (): Promise<SweepResult> => {
		if (!owns()) return { skipped: "this process does not hold the home", observed: 0, outcomes: [], errors: [], catching_up: [] };
		const login = await host.ghLogin().catch(() => "");
		if (login && !logins.includes(login)) logins.push(login);
		const stacks = new StackFollowups({ home: host.home });
		watch ??= new AwaitingMergeWatch({
			home: host.home, fleet: host.fleet, merges: host.merges, ledger: () => host.ledger(), stacks, stackEdges: stacks, claims, runs: host.runs, cpLogins: logins,
			wakeups: { enqueue: (input) => (journal(input), true) }, onLanded: async () => void (await host.armedDispatches.release()),
			observeCi: parkedCiObserver({ home: host.home, fleet: host.fleet, runs: host.runs, read: (record, sha) => readParkedActionsCi(host, record, sha) }),
		});
		try {
			const result = await watch.sweep();
			for (const error of result.errors) journal({ id: boundedCauseId("awaiting-merge-watch:", error), kind: "recovery", content: `AWAITING-MERGE WATCH — ${error}\n  The watch keeps its last observation and retries on its next sweep.` });
			return result;
		} catch (error) {
			const cause = (error as Error).message.split("\n")[0]?.slice(0, 300) || "no message";
			journal({ id: boundedCauseId("awaiting-merge-watch:", cause), kind: "recovery", content: `AWAITING-MERGE WATCH FAILED — ${cause}\n  Parked PRs are observed again on the next sweep.` });
			return { observed: 0, outcomes: [], errors: [cause], catching_up: [] };
		}
	};
	return {
		park: (jobId: string, facts: ParkFacts) => parking().park(jobId, facts),
		recover: () => parking().recover(),
		resume: (jobId: string) => new AwaitingMergeResume({
			fleet: host.fleet, leases: host.leases, runs: host.runs, claims, clone: (project) => host.registry.assertCanonicalClone(project), revive: (id) => host.revive(id),
		}).resume(jobId),
		sweep,
	};
}

/** Actions runs and jobs for a parked head, addressed at the parked repo from the canonical clone, never a worktree. */
function readParkedActionsCi(host: AwaitingMergeHost, record: FleetRecord, sha: string) {
	const [owner = "", repo = ""] = (record.awaiting_merge?.repo ?? "").split("/");
	const cwd = host.registry.assertCanonicalClone(record.project);
	return readActionsCi({ cwd, exec: runCommand, repo: { owner, repo }, sha, timeoutMs: ACTIONS_CI_TIMEOUT_MS });
}

export function readParkIntent(home: string, jobId: string): ParkIntent | undefined {
	const file = join(home, paths.parkIntentFile(jobId));
	if (!existsSync(file)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${file} is not readable JSON: ${(error as Error).message}`);
	}
	const parsed = validateParkIntent(raw);
	if (!parsed.ok) throw new Error(`${file} is not a valid park intent: ${parsed.errors.join("; ")}`);
	return parsed.value;
}

export class Parking {
	readonly #options: ParkingOptions;

	constructor(options: ParkingOptions) {
		this.#options = options;
	}

	/** Park one held ship/pr job. Idempotent: an already parked job answers its record; a recorded intent continues. */
	park(jobId: string, facts: ParkFacts): Promise<ParkResult> {
		return withJobClaim(this.#options.claims, jobId, "park", () => this.#park(jobId, facts),
			async (holder) => ({ job_id: jobId, parked: false, failure: { ...jobInFlight(jobId, holder), code: "job_in_flight" } }));
	}

	/** Startup: continue every recorded park intent from its stage; one result per intent, never a throw. */
	async recover(): Promise<ParkResult[]> {
		const results: ParkResult[] = [];
		for (const record of this.#options.fleet.list()) {
			let intent: ParkIntent | undefined;
			try {
				intent = readParkIntent(this.#options.home, record.job_id);
			} catch (error) {
				results.push(this.#refused(record.job_id, "intent_mismatch", (error as Error).message, "inspect the intent file by hand; nothing was changed"));
				continue;
			}
			if (!intent) continue;
			const { pr_url, repo, head_sha, base, created_at } = intent;
			results.push(await this.park(record.job_id, { pr_url, repo, head_sha, base, handed_at: created_at }));
		}
		return results;
	}

	async #park(jobId: string, facts: ParkFacts): Promise<ParkResult> {
		const { fleet, home } = this.#options;
		const record = fleet.get(jobId);
		if (record?.phase === "awaiting_merge" && record.awaiting_merge) {
			this.#removeIntent(jobId);
			return { job_id: jobId, parked: true, awaiting_merge: record.awaiting_merge };
		}
		const problem = parkableProblem(record, jobId, facts);
		if (problem || !record) return this.#refused(jobId, "not_parkable", problem ?? `no fleet record for ${jobId}`, "only a reported, held ship/pr job with a pushed full head can park");
		let intent: ParkIntent | undefined;
		try {
			intent = readParkIntent(home, jobId);
		} catch (error) {
			return this.#refused(jobId, "intent_mismatch", (error as Error).message, `move ${paths.parkIntentFile(jobId)} aside by hand once its stage is known`);
		}
		if (intent && (intent.head_sha !== facts.head_sha || intent.branch !== record.branch)) {
			return this.#refused(jobId, "intent_mismatch", `${jobId}: a park intent for ${intent.head_sha.slice(0, 12)} is recorded, not ${facts.head_sha.slice(0, 12)}`,
				`finish that park first (startup recovery), or move ${paths.parkIntentFile(jobId)} aside by hand`, intent.stage);
		}
		let stage: ParkStage = intent?.stage ?? "intent";
		const at = isoTimestamp(this.#now());
		const write = (next: ParkStage) => this.#writeIntent({
			schema_version: 1, job_id: jobId, cycle: intent?.cycle ?? previousCycle(home, jobId) + 1, stage: next, pr_url: facts.pr_url, repo: facts.repo,
			branch: record.branch, head_sha: facts.head_sha, base: facts.base, ...((intent?.lease_id ?? record.lease_id) ? { lease_id: intent?.lease_id ?? record.lease_id } : {}),
			created_at: intent?.created_at ?? at, updated_at: isoTimestamp(this.#now()),
		});

		if (stage === "intent") {
			const unowned = unmanagedLiveWorker(home, record, this.#options.manager.get(jobId));
			if (unowned) return this.#abort(jobId, { ...unowned, code: "unmanaged_live_worker" });
			const before = await this.#verify(record, facts);
			if (before) return this.#abort(jobId, before);
			write("intent");
			// held_released first: an aborted park leaves a worker cp_send restores, never a stranded one.
			this.#options.runs.open(jobId).cp("held_released", { reason: "awaiting_merge park", head_sha: facts.head_sha });
			if (this.#options.manager.get(jobId)) await this.#options.manager.shutdown(jobId);
			const after = await this.#verify(record, facts);
			if (after) return this.#abort(jobId, after);
			if (record.checkpoint_ref) await deleteCheckpoint(this.#git, record.worktree, record.checkpoint_ref);
			write("worker_closed");
			stage = "worker_closed";
		}
		if (stage === "worker_closed") {
			// From here the worktree is never read: after a crash its path may already be another job's.
			const lease = leaseFromRecord({ worktree: record.worktree, project: record.project, ...((intent?.lease_id ?? record.lease_id) ? { lease_id: intent?.lease_id ?? record.lease_id } : {}) });
			const released = await this.#options.leases.release(lease, { ignoreErrors: true });
			if (!released.ok) {
				const failure: ParkFailure = { code: "lease_return_failed", message: `${jobId}: ${released.error}`, fix: `the job stays held with its lease and a closed worker; startup recovery retries the return (or cp_send ${jobId} restores the worker)` };
				this.#options.runs.open(jobId).cp("awaiting_merge_refused", { ...failure, stage });
				return { job_id: jobId, parked: false, failure, stage };
			}
			write("lease_returned");
		}
		return this.#commit(record, facts);
	}

	/** Gates on the leased worktree, then HEAD must be exactly the handed-off head. */
	async #verify(record: FleetRecord, facts: ParkFacts): Promise<ParkFailure | undefined> {
		const outcome = await this.#options.gates(record);
		if (!outcome.ok) return { code: "gate_refused", message: `${outcome.failure.code}: ${outcome.failure.message}`, fix: outcome.failure.fix };
		if (outcome.reason !== "pushed") return { code: "gate_refused", message: `${record.job_id}: passed as ${outcome.reason}, not pushed — only an open, pushed PR head parks`, fix: "let cp_integrate settle the landing instead" };
		const head = (await this.#git(record.worktree, ["rev-parse", "HEAD"])).stdout.trim();
		if (head !== facts.head_sha) {
			return { code: "head_mismatch", message: `${record.job_id}: HEAD is ${head.slice(0, 12) || "unreadable"}, not the handed-off ${facts.head_sha.slice(0, 12)}`, fix: "review and CI the current head again before handing it off" };
		}
		return undefined;
	}

	async #commit(record: FleetRecord, facts: ParkFacts): Promise<ParkResult> {
		const { fleet, home } = this.#options;
		const jobId = record.job_id;
		const releasedAt = isoTimestamp(this.#now());
		const usage = readStatusFile(home, jobId)?.usage ?? record.usage;
		const parked: AwaitingMerge = {
			cycle: previousCycle(home, jobId) + 1, pr_url: facts.pr_url, repo: facts.repo, branch: record.branch, head_sha: facts.head_sha, base: facts.base,
			handed_at: facts.handed_at, released_at: releasedAt, frozen_seconds: frozenSeconds(home, record, releasedAt), frozen_usage: usage,
		};
		await fleet.mutate((jobs) => {
			const job = jobs.find((candidate) => candidate.job_id === jobId);
			if (!job || job.phase !== "held") throw new Error(`${jobId}: fleet phase moved to ${job?.phase ?? "missing"} during parking`);
			job.phase = "awaiting_merge";
			job.awaiting_merge = parked;
			job.usage = usage;
			job.worker = { ...job.worker, exited_at: job.worker.exited_at ?? releasedAt };
			delete job.lease_id;
			delete job.checkpoint_ref;
		});
		this.#removeIntent(jobId);
		this.#options.runs.open(jobId).cp("awaiting_merge_parked", { cycle: parked.cycle, head_sha: parked.head_sha, pr_url: parked.pr_url, frozen_seconds: parked.frozen_seconds });
		this.#options.runs.close(jobId);
		await withdrawHumanReview(home, fleet.require(jobId), this.#options.journal);
		return { job_id: jobId, parked: true, awaiting_merge: parked };
	}

	/** Before the lease is touched nothing is lost: drop the intent, keep the job held with its lease. */
	#abort(jobId: string, failure: ParkFailure): ParkResult {
		this.#removeIntent(jobId);
		this.#options.runs.open(jobId).cp("awaiting_merge_refused", { ...failure });
		return { job_id: jobId, parked: false, failure };
	}

	#writeIntent(intent: ParkIntent): void {
		const parsed = validateParkIntent(intent);
		if (!parsed.ok) throw new Error(`refusing to write an invalid park intent: ${parsed.errors.join("; ")}`);
		const file = join(this.#options.home, paths.parkIntentFile(intent.job_id));
		mkdirSync(dirname(file), { recursive: true });
		atomicWriteJson(file, parsed.value);
	}

	#removeIntent(jobId: string): void {
		rmSync(join(this.#options.home, paths.parkIntentFile(jobId)), { force: true });
	}

	#git: Git = (cwd, args) => (this.#options.git ?? defaultGit)(cwd, args);

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}

	/** A refusal before any stage ran; journaled so a startup recovery that stops is never silent. */
	#refused(jobId: string, code: ParkFailureCode, message: string, fix: string, stage?: ParkStage): ParkResult {
		const failure: ParkFailure = { code, message, fix };
		this.#options.runs.open(jobId).cp("awaiting_merge_refused", { ...failure, ...(stage ? { stage } : {}) });
		return { job_id: jobId, parked: false, failure, ...(stage ? { stage } : {}) };
	}
}

function parkableProblem(record: FleetRecord | undefined, jobId: string, facts: ParkFacts): string | undefined {
	if (!record) return `no fleet record for ${jobId}`;
	if (isScriptFleetRecord(record) || record.kind !== "ship" || record.delivery !== "pr") return `${jobId} is not a ship/pr job`;
	if (record.phase !== "held" || record.failure) return `${jobId} is ${record.phase}${record.failure ? ` (${record.failure.class})` : ""}, not held`;
	if (!record.reported_at) return `${jobId} has no accepted report`;
	if (!new RegExp(FULL_SHA_PATTERN).test(facts.head_sha)) return `${jobId}: head ${facts.head_sha} is not a full sha`;
	return undefined;
}

function parkedEvents(home: string, jobId: string) {
	try {
		return readEventLog(home, jobId).filter((event) => event.source === "cp" && (event.type === "awaiting_merge_parked" || event.type === "awaiting_merge_resumed"));
	} catch {
		return []; // an unreadable log restarts the count; it never blocks a park
	}
}

function payloadNumber(payload: unknown, key: string): number | undefined {
	const value = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : undefined;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function previousCycle(home: string, jobId: string): number {
	return payloadNumber(parkedEvents(home, jobId).findLast((event) => event.type === "awaiting_merge_parked")?.payload, "cycle") ?? 0;
}

/** Execution time: earlier cycles' frozen seconds plus this cycle, from dispatch or the last resume. */
function frozenSeconds(home: string, record: FleetRecord, releasedAt: string): number {
	const events = parkedEvents(home, record.job_id);
	const last = events.at(-1);
	const before = payloadNumber(events.findLast((event) => event.type === "awaiting_merge_parked")?.payload, "frozen_seconds") ?? 0;
	const since = last?.type === "awaiting_merge_resumed" ? last.ts : record.dispatched_at;
	return Math.floor(before + Math.max(0, Date.parse(releasedAt) - Date.parse(since)) / 1000);
}
