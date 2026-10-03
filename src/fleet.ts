/**
 * Fleet state — `state/fleet.json`.
 *
 * One record per in-flight job, keyed by job id. Exactly one process owns this
 * file (the parent extension); concurrency inside that process is serialized
 * through pi's per-path file mutation queue, not by lock files, so the parent's
 * own `edit`/`write` tools queue behind us too.
 *
 * Two rules govern everything here:
 *
 *  1. **Atomic.** A mutation is read-modify-write inside the queue, validated
 *     against the contract, then `write tmp -> fsync -> rename`. An invalid
 *     fleet is a thrown error, never a written file.
 *  2. **Facts only.** `reconcile()` looks at observed exits, pid liveness,
 *     session files and envelopes on disk. Where the evidence runs out it says
 *     so (`orphan`, `reported`) instead of inventing a phase. Nothing is
 *     inferred from age.
 *
 * Phase changes that are *policy* (envelope intake, teardown, failure ladders)
 * belong to their own tasks; this module only offers the mechanics plus the one
 * policy that is unambiguous at startup: a worker we can prove is gone, for a
 * job that never reported, is a `crash`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, canonicalDir, queued } from "./json-store.ts";
import {
	type Delivery,
	type Failure,
	FAILURE_RECOVERABLE,
	type FleetFile,
	type FleetRecord,
	isoTimestamp,
	isScriptFleetRecord,
	type JobKind,
	type JobPhase,
	LAYOUT,
	paths,
	SCHEMA_VERSION,
	validateFleetFile,
	validateRunStatus,
} from "./contracts.ts";

export class FleetError extends Error {}

// ---------------------------------------------------------------------------
// Reconcile vocabulary
// ---------------------------------------------------------------------------

/**
 * What reconcile concluded about one record.
 *
 *  terminal  — already `done`/`failed`; history is not re-litigated
 *  live      — the worker is alive AND this process owns it (a reload, not a restart)
 *  orphan    — the worker's pid is alive but nobody here owns it: reachable by
 *              nobody, so it is reported to the operator and left alone
 *  revivable — dead worker, session file present, phase `held` OR `waiting`
 *              (cp-8km): the hold or the pre-envelope run survives and can be
 *              revived with `--session <file>` via `cp_revive`
 *  reported  — dead worker, no `reported_at`, but a matching envelope is on
 *              disk: the work landed and envelope intake (T16) owns the phase
 *  failed    — dead worker with nothing to salvage; `failure` carries the class
 */
export const RECONCILE_OUTCOMES = ["terminal", "live", "orphan", "revivable", "reported", "failed"] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export interface ReconcileEntry {
	job_id: string;
	outcome: ReconcileOutcome;
	phase_before: JobPhase;
	phase_after: JobPhase;
	pid: number | null;
	pid_alive?: boolean;
	session_file_present: boolean;
	/** Recoverable failure class + a session file to revive from. */
	resumable: boolean;
	/** The evidence, in operator-readable form. */
	detail: string;
}

export interface ReconcileReport {
	at: string;
	checked: number;
	changed: number;
	entries: ReconcileEntry[];
	/**
	 * Jobs whose envelope is on disk but not yet accepted by the fleet (T16).
	 *
	 * Keyed on the **envelope**, never on the worker's pid (pi-command-post-3ip):
	 * an unstamped envelope needs intake whether the worker is dead, orphaned or
	 * still alive. Reading it off the `reported` outcome hid every other case —
	 * an orphaned pid, or a live-but-unowned worker — behind a classification
	 * that is about the worker, and the job then sat unstamped forever because
	 * intake only ever ran from a live worker's event stream.
	 */
	needs_intake: string[];
	/**
	 * Jobs reconcile classified `revivable` (cp-8km): dead worker, session file
	 * present, nothing else changed about the phase. `changed` does not count
	 * these (the phase never moves), so a caller that only checks `changed` must
	 * not miss them — this is the explicit list a startup summary reads instead
	 * of string-matching `outcome`.
	 */
	revivable: string[];
}

export interface ReconcileOptions {
	/** job ids whose workers this process still owns (`WorkerManager.active`). */
	owned?: Iterable<string>;
	/** Injected in tests; production probes the real process table. */
	isPidAlive?: (pid: number) => boolean;
	/** Injected in tests; production hits the real filesystem. */
	fileExists?: (path: string) => boolean;
}

// ---------------------------------------------------------------------------
// Facts from the operating system and from disk
// ---------------------------------------------------------------------------

/**
 * Is this pid still a process we could own?
 *
 * `ESRCH` is gone. `EPERM` means the pid exists but belongs to another user,
 * which our own child never does — the pid was reused, so our worker is gone.
 * A single-thread zombie is gone too: it has exited, and an orphan reparented
 * to a PID 1 that never reaps (a container whose PID 1 is `timeout`, like the
 * Nomad CI runner) stays one forever while `kill(pid, 0)` still finds it. A
 * zombie leader with threads left is still exiting, so it counts as alive.
 * Either way the answer is a fact about now, not a guess about the past.
 */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		return !(/^State:\s+Z/m.test(status) && /^Threads:\s+1$/m.test(status));
	} catch {
		return true; // no procfs: kill(pid, 0) is all there is
	}
}

export interface RunObservation {
	/** The previous parent OBSERVED the child close. Never inferred from age. */
	closed: boolean;
	exited_at?: string;
	exit_code?: number | null;
	/** A failure the previous parent already classified. */
	failure?: Failure;
}

/**
 * The previous parent's own record of how a run ended. `status.json` is a
 * projection of the append-only event log, so an `exited` phase there is an
 * OBSERVED close — the one exception to "only this process observes deaths",
 * and a legitimate one: it was observed, just not by us.
 *
 * A classified failure is carried over even when the run has not exited, so
 * reconcile reports the class the evidence produced instead of flattening
 * everything to `crash`.
 */
export function readRunObservation(home: string, jobId: string): RunObservation | undefined {
	const file = join(home, paths.statusFile(jobId));
	if (!existsSync(file)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	const result = validateRunStatus(parsed);
	if (!result.ok) return undefined;
	const status = result.value;
	const closed = status.phase === "exited" && status.exited_at !== undefined;
	if (!closed && !status.failure) return undefined;
	return {
		closed,
		...(status.exited_at ? { exited_at: status.exited_at } : {}),
		...(closed ? { exit_code: status.exit_code ?? null } : {}),
		...(status.failure ? { failure: status.failure } : {}),
	};
}

/** Did the worker leave a valid envelope for this job behind? */
export function hasEnvelopeOnDisk(home: string, jobId: string): boolean {
	const file = join(home, paths.envelopeFile(jobId));
	if (!existsSync(file)) return false;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { job_id?: unknown };
		return parsed.job_id === jobId;
	} catch {
		return false;
	}
}

/** A job can be resumed when its failure is recoverable and its context survived. */
export function isResumable(record: FleetRecord, fileExists: (path: string) => boolean = existsSync): boolean {
	if (isScriptFleetRecord(record)) return false;
	if (!fileExists(record.worker.session_file)) return false;
	if (!record.failure) return true;
	return FAILURE_RECOVERABLE[record.failure.class];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface FleetStoreOptions {
	/** Notification after a committed mutation; must not throw or block the writer. */
	onChanged?: (before: readonly FleetRecord[], after: readonly FleetRecord[]) => void;
	/** Command post home; the file is `<home>/state/fleet.json`. */
	home: string;
	now?: () => Date;
}

export interface FleetFilter {
	phase?: JobPhase | readonly JobPhase[];
	project?: string;
	kind?: JobKind;
	delivery?: Delivery;
}

/** Mutator contract: mutate the draft in place, or return a replacement array. */
export type FleetMutator = (jobs: FleetRecord[]) => FleetRecord[] | void;

export class FleetStore {
	readonly home: string;
	readonly file: string;
	readonly #now: () => Date;
	readonly #onChanged: FleetStoreOptions["onChanged"];

	constructor(options: FleetStoreOptions) {
		this.#onChanged = options.onChanged;
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.fleetFile);
		this.#now = options.now ?? (() => new Date());
	}

	/** True once the fleet has been written at least once. */
	get exists(): boolean {
		return existsSync(this.file);
	}

	/**
	 * Read and validate. A missing file is an empty fleet (a fresh home is not
	 * an error); a corrupt or future-versioned file is refused rather than
	 * guessed at.
	 */
	read(): FleetFile {
		if (!existsSync(this.file)) {
			return { schema_version: SCHEMA_VERSION, updated_at: "1970-01-01T00:00:00Z", jobs: [] };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new FleetError(
				`${this.file} is not valid JSON (${(error as Error).message}). Refusing to guess; move it aside to start clean.`,
			);
		}
		const version = (parsed as { schema_version?: unknown }).schema_version;
		if (typeof version === "number" && version > SCHEMA_VERSION) {
			throw new FleetError(
				`${this.file} is schema_version ${version}; this build reads ${SCHEMA_VERSION}. Upgrade pi-command-post instead of downgrading the file.`,
			);
		}
		const result = validateFleetFile(parsed);
		if (!result.ok) {
			throw new FleetError(`${this.file} violates the fleet contract:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	get(jobId: string): FleetRecord | undefined {
		return this.read().jobs.find((job) => job.job_id === jobId);
	}

	require(jobId: string): FleetRecord {
		const record = this.get(jobId);
		if (!record) throw new FleetError(`no fleet record for ${jobId}`);
		return record;
	}

	list(filter: FleetFilter = {}): FleetRecord[] {
		const phases =
			filter.phase === undefined ? undefined : Array.isArray(filter.phase) ? filter.phase : [filter.phase as JobPhase];
		return this.read().jobs.filter((job) => {
			if (phases && !phases.includes(job.phase)) return false;
			if (filter.project !== undefined && job.project !== filter.project) return false;
			if (filter.kind !== undefined && job.kind !== filter.kind) return false;
			if (filter.delivery !== undefined && job.delivery !== filter.delivery) return false;
			return true;
		});
	}

	/**
	 * The only write path. Serialized per file across this process, atomic on
	 * disk, and validated before anything is renamed into place.
	 */
	async mutate(mutator: FleetMutator): Promise<FleetFile> {
		return queued(this.file, async () => {
			const current = this.read();
			const draft = structuredClone(current.jobs) as FleetRecord[];
			const returned = mutator(draft);
			const jobs = returned ?? draft;
			const next: FleetFile = {
				schema_version: SCHEMA_VERSION,
				updated_at: isoTimestamp(this.#now()),
				jobs,
			};
			const result = validateFleetFile(next);
			if (!result.ok) {
				throw new FleetError(`refusing to write an invalid fleet.json:\n  ${result.errors.join("\n  ")}`);
			}
			atomicWriteJson(this.file, result.value);
			this.#onChanged?.(current.jobs, result.value.jobs);
			return result.value;
		});
	}

	/** Add a new job. A duplicate job id is a contract violation, not an update. */
	async add(record: FleetRecord): Promise<FleetRecord> {
		await this.mutate((jobs) => {
			if (jobs.some((job) => job.job_id === record.job_id)) {
				throw new FleetError(
					`fleet already has a record for ${record.job_id} — promote or tear it down instead of dispatching twice`,
				);
			}
			jobs.push(structuredClone(record));
		});
		return this.require(record.job_id);
	}

	/**
	 * Shallow merge of defined keys. Deleting a field (e.g. clearing `failure`)
	 * goes through `mutate`, deliberately: an erasure should be explicit.
	 */
	async patch(jobId: string, patch: Partial<FleetRecord>): Promise<FleetRecord> {
		await this.mutate((jobs) => {
			const index = jobs.findIndex((job) => job.job_id === jobId);
			if (index === -1) throw new FleetError(`no fleet record for ${jobId}`);
			const current = jobs[index] as FleetRecord;
			const next: FleetRecord = { ...current };
			for (const [key, value] of Object.entries(patch)) {
				if (value === undefined) continue;
				Reflect.set(next, key, structuredClone(value));
			}
			next.job_id = current.job_id;
			jobs[index] = next;
		});
		return this.require(jobId);
	}

	/** Phase `failed` always carries its cause: that is the whole point of it. */
	async markFailed(jobId: string, failure: Failure): Promise<FleetRecord> {
		return this.patch(jobId, { phase: "failed", failure });
	}

	/**
	 * Reset the settle-without-report counter (cp-settle-without-report).
	 *
	 * An accepted envelope, or a promote handing over a new brief, is a fresh
	 * chance to report — the nudge budget belongs to a brief, not to a job's
	 * lifetime. Deleting a field goes through `mutate` deliberately (see
	 * `patch`), and a record that has no counter is left untouched rather than
	 * rewritten for nothing.
	 */
	async clearUnreportedSettles(jobId: string): Promise<void> {
		const current = this.get(jobId);
		if (current?.unreported_settles === undefined && current?.unreported_work === undefined) return;
		await this.mutate((jobs) => {
			const job = jobs.find((candidate) => candidate.job_id === jobId);
			if (!job) return;
			delete job.unreported_settles;
			// cp-0dhw: the observation and the counter are one fact about one
			// generation's silence. Clearing the budget without clearing the evidence
			// would leave `/status` describing a worktree nobody has looked at since.
			delete job.unreported_work;
		});
	}

	async remove(jobId: string): Promise<void> {
		await this.mutate((jobs) => {
			const index = jobs.findIndex((job) => job.job_id === jobId);
			if (index === -1) throw new FleetError(`no fleet record for ${jobId}`);
			jobs.splice(index, 1);
		});
	}

	/**
	 * Startup truth pass. For every non-terminal record: is the worker alive,
	 * did somebody observe it die, is its session file still there, did it leave
	 * an envelope? Records are updated to match; anything the evidence does not
	 * settle is reported, not decided.
	 *
	 * Never creates state: a home with no fleet.json and no jobs stays that way.
	 */
	async reconcile(options: ReconcileOptions = {}): Promise<ReconcileReport> {
		const owned = new Set(options.owned ?? []);
		const alive = options.isPidAlive ?? isPidAlive;
		const fileExists = options.fileExists ?? ((path: string) => existsSync(path));
		const at = isoTimestamp(this.#now());
		const entries: ReconcileEntry[] = [];
		const needsIntake: string[] = [];

		if (!this.exists) {
			return { at, checked: 0, changed: 0, entries, needs_intake: needsIntake, revivable: [] };
		}

		let changed = 0;
		const revivable: string[] = [];
		await this.mutate((jobs) => {
			for (const job of jobs) {
				const entry = this.#reconcileRecord(job, { owned, alive, fileExists });
				entries.push(entry);
				if (entry.phase_after !== entry.phase_before) changed += 1;
				if (envelopeNeedsIntake(this.home, job)) needsIntake.push(job.job_id);
				if (entry.outcome === "revivable") revivable.push(job.job_id);
			}
		});

		return { at, checked: entries.length, changed, entries, needs_intake: needsIntake, revivable };
	}

	// -- internals ----------------------------------------------------------

	/** Mutates `job` in place and returns what the evidence said. */
	#reconcileRecord(
		job: FleetRecord,
		ctx: { owned: Set<string>; alive: (pid: number) => boolean; fileExists: (path: string) => boolean },
	): ReconcileEntry {
		const phaseBefore = job.phase;
		if (isScriptFleetRecord(job)) {
			if (!job.script_process) {
				const base = { job_id: job.job_id, phase_before: phaseBefore, pid: null, session_file_present: false, resumable: false };
				const result = ctx.fileExists(join(this.home, paths.scriptResultFile(job.job_id)));
				if (result && !job.reported_at) return { ...base, outcome: "reported", phase_after: phaseBefore, detail: `script result is on disk for ${job.job_id}; intake owns its observed exit` };
				if (phaseBefore === "failed" || phaseBefore === "done" || job.reported_at) return { ...base, outcome: "terminal", phase_after: phaseBefore, detail: `script ${phaseBefore}; no replay` };
				const failure: Failure = { class: "crash", message: `${job.job_id}: launch outcome unknown without an observed pid; inspect the retained lease; never replay`, at: isoTimestamp(this.#now()) };
				job.phase = "failed";
				job.failure = failure;
				return { ...base, outcome: "failed", phase_after: "failed", detail: failure.message };
			}
			const pid = job.script_process.pid;
			const base = { job_id: job.job_id, phase_before: phaseBefore, pid, session_file_present: false, resumable: false };
			const result = ctx.fileExists(join(this.home, paths.scriptResultFile(job.job_id)));
			if (result && !job.reported_at) return { ...base, outcome: "reported", phase_after: phaseBefore, detail: `script result is on disk for ${job.job_id}; intake owns its outcome` };
			if (phaseBefore === "done" || phaseBefore === "failed" || job.reported_at) return { ...base, outcome: "terminal", phase_after: phaseBefore, detail: `script ${phaseBefore}; no replay` };
			if (!job.script_process.exited_at && ctx.alive(pid)) return { ...base, outcome: ctx.owned.has(job.job_id) ? "live" : "orphan", phase_after: phaseBefore, pid_alive: true, detail: `script pid ${pid} is alive${ctx.owned.has(job.job_id) ? " and owned" : " but unowned; inspect it, never re-execute"}` };
			const failure: Failure = { class: "crash", message: `script pid ${pid} is gone without a durable observed exit; outcome unknown, inspect the lease; never replay`, at: isoTimestamp(this.#now()) };
			job.phase = "failed";
			job.failure = failure;
			return { ...base, outcome: "failed", phase_after: "failed", pid_alive: false, detail: failure.message };
		}
		const pid = job.worker.pid;
		const sessionPresent = ctx.fileExists(job.worker.session_file);
		const base = {
			job_id: job.job_id,
			phase_before: phaseBefore,
			pid,
			session_file_present: sessionPresent,
		};

		if (phaseBefore === "done" || phaseBefore === "failed") {
			return {
				...base,
				outcome: "terminal",
				phase_after: phaseBefore,
				resumable: phaseBefore === "failed" && isResumable(job, ctx.fileExists),
				detail: `phase ${phaseBefore}; history is not re-litigated`,
			};
		}

		const observation = readRunObservation(this.home, job.job_id);
		// A close we (or the previous parent) observed outranks any pid probe:
		// pids are reused, observations are not.
		const knownDead = job.worker.exited_at !== undefined || observation?.closed === true;
		const pidAlive = knownDead ? false : ctx.alive(pid);

		if (pidAlive) {
			const ownedHere = ctx.owned.has(job.job_id);
			return {
				...base,
				outcome: ownedHere ? "live" : "orphan",
				phase_after: phaseBefore,
				pid_alive: true,
				resumable: sessionPresent,
				detail: ownedHere
					? `pid ${pid} is alive and owned by this session`
					: `pid ${pid} is alive but unreachable from this session (no stdio); left untouched — end it deliberately, then cp_teardown (teardown refuses while it lives)`,
			};
		}

		// Dead. Stamp the exit only when somebody actually observed the close;
		// a pid that merely stopped existing gives us no time and no code.
		if (!job.worker.exited_at && observation?.closed && observation.exited_at) {
			job.worker.exited_at = observation.exited_at;
			job.worker.exit_code = observation.exit_code ?? null;
		}

		if (phaseBefore === "held") {
			if (sessionPresent) {
				return {
					...base,
					outcome: "revivable",
					phase_after: "held",
					pid_alive: false,
					resumable: true,
					detail: `worker gone (pid ${pid}) but the envelope is in and ${job.worker.session_file} survives — revive with --session to promote`,
				};
			}
			const failure: Failure = {
				class: "crash",
				message: `held worker for ${job.job_id} is gone (pid ${pid}) and its session file ${job.worker.session_file} is missing: the hold cannot be revived`,
				at: isoTimestamp(this.#now()),
			};
			job.phase = "failed";
			job.failure = failure;
			return {
				...base,
				outcome: "failed",
				phase_after: "failed",
				pid_alive: false,
				resumable: false,
				detail: failure.message,
			};
		}

		// waiting: no envelope was ever accepted into the fleet.
		if (hasEnvelopeOnDisk(this.home, job.job_id)) {
			return {
				...base,
				outcome: "reported",
				phase_after: phaseBefore,
				pid_alive: false,
				resumable: sessionPresent,
				detail: `worker gone (pid ${pid}) but it left an envelope; envelope intake owns the phase change`,
			};
		}

		// cp-8km, operator-confirmed (option A): a `waiting` job that crashed before
		// filing any envelope is revivable exactly like a `held` one, when its
		// session file survived (spike Evidence S2-S5: no mechanical difference
		// between resuming a held session and a waiting one). This is the one
		// guarded branch the design calls for — reverting to "waiting always fails"
		// is flipping WAITING_REVIVABLE back to false, nothing else.
		const WAITING_REVIVABLE = true;
		if (WAITING_REVIVABLE && sessionPresent) {
			return {
				...base,
				outcome: "revivable",
				phase_after: "waiting",
				pid_alive: false,
				resumable: true,
				detail: `worker gone (pid ${pid}) before any envelope, but ${job.worker.session_file} survives — revive with --session to resume`,
			};
		}

		const failure: Failure =
			observation?.failure ??
			({
				class: "crash",
				message: `worker for ${job.job_id} is gone (pid ${pid}) with no envelope${
					observation?.exited_at ? ` (close observed at ${observation.exited_at})` : " (pid no longer exists)"
				}`,
				at: isoTimestamp(this.#now()),
			} satisfies Failure);
		job.phase = "failed";
		job.failure = failure;
		return {
			...base,
			outcome: "failed",
			phase_after: "failed",
			pid_alive: false,
			resumable: FAILURE_RECOVERABLE[failure.class] && sessionPresent,
			detail: failure.message,
		};
	}
}

/**
 * Does this record have a delivery on disk that the fleet never stamped?
 *
 * Asked of the record as reconcile leaves it, so a phase it just moved is the
 * one that counts. Three facts, and none of them is the worker: the job has no
 * `reported_at` for the live generation, its phase is not terminal (a `failed`
 * job's envelope was already refused with a cause — re-intaking it would relitigate
 * a fail-closed decision), and a matching envelope is on disk.
 */
function envelopeNeedsIntake(home: string, job: FleetRecord): boolean {
	if (job.reported_at !== undefined || job.phase === "done") return false;
	if (isScriptFleetRecord(job)) return existsSync(join(home, paths.scriptResultFile(job.job_id)));
	if (job.phase === "failed") return false;
	return hasEnvelopeOnDisk(home, job.job_id);
}

/** One line per record, for the operator. Empty string when nothing changed. */
export function summarizeReconcile(report: ReconcileReport): string {
	if (report.entries.length === 0) return "fleet: nothing to reconcile";
	const interesting = report.entries.filter((entry) => entry.outcome !== "terminal" && entry.outcome !== "live");
	const header = `fleet: ${report.checked} job(s) checked, ${report.changed} updated`;
	if (interesting.length === 0) return header;
	const lines = interesting.map(
		(entry) => `  ${entry.job_id} ${entry.outcome}${entry.resumable ? " (resumable)" : ""}: ${entry.detail}`,
	);
	return [header, ...lines].join("\n");
}
