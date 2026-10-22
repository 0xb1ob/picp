/**
 * Graceful drain (the idea behind Pier row 1.4, reimplemented here): before a
 * parent restart, stop starting new processes, let every live worker and
 * reviewer reach its next settle point (an envelope, or a turn settling while
 * held), let merge steps already running finish, then say once whether a
 * restart is safe.
 *
 * Nothing blocks. `/cp-drain` (and `cp_parent drain`, which runs it) writes
 * `state/drain.json` and returns. The parent's ordinary tick — the widget
 * refresh that also runs on every envelope, settle and durable wake-up — calls
 * `DrainControl.check`, which moves the record to `drained` or `timeout` exactly
 * once and journals exactly one `cp-recovery` wake saying so. The file is the
 * flag every start gate reads (`assertNotDraining`), and the record the next
 * parent reports at startup and then clears.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type FleetRecord, isoTimestamp, LAYOUT, type RunPhase } from "./contracts.ts";
import type { DurableWakeupEntry } from "./contracts/wakeups.ts";
import { isPidAlive } from "./fleet.ts";
import { atomicWriteJson } from "./json-store.ts";
import { PARENT_CONTROL_BUSY } from "./parent-diagnostics.ts";

export const DRAIN_DEFAULT_TIMEOUT_S = 600;
export const DRAIN_MAX_TIMEOUT_S = 3600;
/** Every drain message starts with this; the bridge relays the ones the parent receives. */
export const DRAIN_PREFIX = "DRAIN: ";
const IN_FLIGHT = ["launching", "waiting", "held"];

/** Drains this process wrote (`home` + `started_at`): the gate self-heal never touches them. */
const created = new Set<string>();
/** The newest control per home: the gates' `assertNotDraining` has only a home to find it by. */
const healers = new Map<string, DrainControl>();
const PROCESS_STARTED_MS = Date.now() - process.uptime() * 1000;
let runningSha: string | undefined;

const createdKey = (home: string, record: Pick<DrainRecord, "started_at">): string => `${home}\0${record.started_at}`;

/** The checkout HEAD this parent loaded; a drained auto-update record for it is spent. */
export function setRunningVersion(sha: string | undefined): void {
	runningSha = sha;
}

export interface DrainJob {
	job_id: string;
	phase: string;
	/** The treehouse lease id when recorded, else the worktree path. */
	lease: string;
	head: string | null;
}

/** Why a drain runs: cp-daemon's updater (`auto-update`, restarts the parent itself) or an operator's `/cp-drain` (`manual`). Absent on records older than this field. */
export interface DrainCause {
	reason: "auto-update" | "manual";
	target_sha?: string;
}

export interface DrainRecord {
	cause?: DrainCause;
	state: "draining" | "drained" | "timeout";
	started_at: string;
	deadline: string;
	timeout_s: number;
	finished_at?: string;
	/** Still mid-turn (manager keys: workers and reviewers) or `N merge step(s)` at the timeout. */
	survivors?: string[];
	/** Set on an outcome: false until its one wake is journaled, so a failed journal is retried on the next tick. */
	reported?: boolean;
	jobs: DrainJob[];
}

export class DrainError extends Error {}

export function drainFile(home: string): string {
	return join(home, LAYOUT.state, "drain.json");
}

/** Absent means not draining. An unreadable file throws: every gate fails closed on it. */
export function readDrain(home: string): DrainRecord | undefined {
	const file = drainFile(home);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new DrainError(`${file} is unreadable (${(error as Error).message}); the home stays draining until it is removed`);
	}
	try {
		const value = JSON.parse(text) as DrainRecord;
		if (typeof value?.started_at === "string" && Array.isArray(value.jobs)) return value;
	} catch {
		// Reported below with the file named.
	}
	throw new DrainError(`${file} is not a drain record; the home stays draining until it is removed`);
}

/** What a drain is for, in a clause; undefined for a legacy record (no cause) or an unrecognised one, which read as before. */
export function describeCause(record: Pick<DrainRecord, "cause" | "deadline">): string | undefined {
	const cause = record.cause;
	if (cause?.reason === "auto-update") {
		const target = typeof cause.target_sha === "string" && cause.target_sha ? ` to ${cause.target_sha.slice(0, 12)}` : "";
		return `auto-update${target} in progress, drain timeout ${record.deadline}; it restarts the parent by itself, a manual restart does not apply it`;
	}
	return cause?.reason === "manual" ? "manual /cp-drain" : undefined;
}

/** `/cp-drain`'s arguments: `[seconds] [auto-update [sha]]`, `cancel` or `status`; undefined when malformed. */
export function parseDrainArgs(text: string): { timeoutS?: number; cancel?: boolean; status?: boolean; cause?: DrainCause } | undefined {
	const [first = "", ...rest] = text.trim().split(/\s+/).filter(Boolean);
	if (first === "cancel" || first === "status") return rest.length === 0 ? (first === "cancel" ? { cancel: true } : { status: true }) : undefined;
	const timeoutS = first === "" ? undefined : Number(first);
	if (timeoutS !== undefined && !(Number.isFinite(timeoutS) && timeoutS >= 0)) return undefined;
	if (rest.length === 0) return { timeoutS };
	const [reason, sha, ...extra] = rest;
	if (reason !== "auto-update" || extra.length > 0 || (sha !== undefined && !/^[0-9a-f]{7,64}$/i.test(sha))) return undefined;
	return { timeoutS, cause: { reason, ...(sha ? { target_sha: sha } : {}) } };
}

/** The inverse of `parseDrainArgs` for a drain started with a cause. */
export function drainArgs(timeoutS: number, cause?: DrainCause): string {
	return cause?.reason === "auto-update" ? [timeoutS, "auto-update", cause.target_sha].filter((word) => word !== undefined).join(" ") : String(timeoutS);
}

/** The one refusal every process start shares while a drain is on disk; it names the drain and, when recorded, why. */
export function assertNotDraining(home: string, what: string): void {
	let drain = readDrain(home);
	if (drain && healers.get(home)?.healStale(drain)) drain = readDrain(home);
	const why = drain && describeCause(drain);
	if (drain) throw new DrainError(`refused: the parent is draining for a restart (since ${drain.started_at}, ${drain.state}${why ? `; ${why}` : ""}); no ${what} starts until the parent restarts or /cp-drain cancel withdraws it (${drainFile(home)})`);
}

export function inFlightJobs(records: readonly FleetRecord[], head: (jobId: string) => string | undefined): DrainJob[] {
	return records
		.filter((record) => IN_FLIGHT.includes(record.phase))
		.map((record) => ({ job_id: record.job_id, phase: record.phase, lease: record.lease_id ?? record.worktree, head: head(record.job_id) ?? null }));
}

export interface DurableWakeupSweepStore {
	drain(send: (entry: DurableWakeupEntry) => void): DurableWakeupEntry[];
	discard(items: ReadonlyArray<{ id: string; reason: string }>): string[];
}

/**
 * One sweep of due durable wake-ups.
 * `true` — transport took the copy; stays pending until arrival confirm, retried if that never comes.
 * string — stale suppression; discarded with that reason, not retried.
 * throw — transport failure; entry stays pending and the next sweep retries it.
 */
export function sweepDurableWakeups(
	store: DurableWakeupSweepStore,
	ownsHome: () => boolean,
	send: (entry: DurableWakeupEntry) => boolean | string,
): string[] {
	if (!ownsHome()) return [];
	const drop: Array<{ id: string; reason: string }> = [];
	try {
		store.drain((entry) => {
			const result = send(entry);
			if (result !== true) {
				drop.push({ id: entry.id, reason: typeof result === "string" && result.length > 0 ? result : "stale" });
			}
		});
	} finally {
		if (drop.length > 0) store.discard(drop);
	}
	return drop.map((item) => item.id);
}

export interface DrainControlDeps {
	home: string;
	fleet: { list(): FleetRecord[] };
	/** Manager keys mid-turn in this process (`WorkerManager.quiesce().busy`): workers and reviewers. */
	busy: () => string[];
	head: (jobId: string) => string | undefined;
	/** One durable `cp-recovery` wake; ids repeat for one outcome, so the outbox delivers it once. */
	journal: (wake: { id: string; content: string; keys?: string[] }) => void;
	/** Retract a drain wake a restart made moot. */
	discard?: (ids: string[]) => void;
	/** Does this process hold the home's parent lock? Only the owner sees the workers a drain waits for. */
	owns?: () => boolean;
	/** The parent's compact hold is on (cp-35d0 S6): no new drain starts, a running one cannot finish `drained`. Absent = false. */
	parentControlBusy?: () => boolean;
	now?: () => Date;
}

function outcomeWakeId(record: Pick<DrainRecord, "started_at">, state: "drained" | "timeout"): string {
	return `drain:${record.started_at}:${state}`;
}

/**
 * Delivery-time check of a drain outcome wake (`drain:<started_at>:drained|timeout`): a reason when it is stale,
 * else undefined. Stale = the live `state/drain.json` is gone, a different drain started, or its state moved on.
 * A `:cancelled` wake and every non-drain id are never stale; an unreadable file stays draining, so it is delivered.
 * Synchronous inside the sweep, so a drain written by this process cannot slip between this read and the send.
 */
export function staleDrainOutcome(home: string, wakeId: string): string | undefined {
	const match = /^drain:(.+):(drained|timeout)$/.exec(wakeId);
	if (!match) return undefined;
	let live: DrainRecord | undefined;
	try {
		live = readDrain(home);
	} catch {
		return undefined;
	}
	if (!live) return `no drain is on disk any more (${drainFile(home)} is gone); the ${match[2]} notice for the drain started ${match[1]} is history`;
	if (live.started_at !== match[1]) return `a different drain is on disk (started ${live.started_at}); the ${match[2]} notice for the drain started ${match[1]} is history`;
	if (live.state !== match[2]) return `the drain started ${match[1]} is now ${live.state}; its ${match[2]} notice is history`;
	return undefined;
}

/** The parent's drain: start it, advance it on the ordinary tick, report it once at the next startup. */
export class DrainControl {
	readonly #deps: DrainControlDeps;
	#mergeSteps = 0;
	/** Set while this process owns a drain: its own startup pass must never clear it. */
	#owned = false;

	constructor(deps: DrainControlDeps) {
		this.#deps = deps;
		healers.set(deps.home, this);
	}

	/** Integration steps running now: a drain waits for them, and the drain's hold makes the next one wait. */
	get mergeSteps(): number {
		return this.#mergeSteps;
	}

	async track<T>(step: () => Promise<T>): Promise<T> {
		this.#mergeSteps += 1;
		try {
			return await step();
		} finally {
			this.#mergeSteps -= 1;
		}
	}

	#now(): Date {
		return (this.#deps.now ?? (() => new Date()))();
	}

	#survivors(): string[] {
		const steps = this.#mergeSteps;
		return [...this.#deps.busy(), ...(steps > 0 ? [`${steps} merge step(s)`] : []), ...(this.#deps.parentControlBusy?.() ? ["parent compaction"] : [])];
	}

	/**
	 * Write the flag and return at once. A drain already running is returned as
	 * is. When nothing is mid-turn right now, the answer is `drained` and this
	 * answer is the one report: no wake follows it.
	 */
	start(timeoutS: number = DRAIN_DEFAULT_TIMEOUT_S, cause: DrainCause = { reason: "manual" }): DrainRecord {
		// Only the lock owner sees the workers a drain waits for: anywhere else an empty manager would say "drained".
		if (this.#deps.owns?.() === false) throw new DrainError(`refused: this session does not hold the parent lock for ${this.#deps.home}; run /cp-drain (or cp_parent drain) in the parent that does`);
		const existing = readDrain(this.#deps.home);
		// Refused before any write; a drain already running is still returned as is (and waits out the hold in #survivors).
		if (existing?.state !== "draining" && this.#deps.parentControlBusy?.()) throw new DrainError(PARENT_CONTROL_BUSY);
		this.#owned = true;
		if (existing?.state === "draining") return existing;
		const bounded = Math.min(Math.max(Math.round(Number.isFinite(timeoutS) ? timeoutS : DRAIN_DEFAULT_TIMEOUT_S), 0), DRAIN_MAX_TIMEOUT_S);
		const started = this.#now();
		const record: DrainRecord = {
			state: "draining",
			started_at: isoTimestamp(started),
			deadline: isoTimestamp(new Date(started.getTime() + bounded * 1000)),
			timeout_s: bounded,
			cause,
			jobs: inFlightJobs(this.#deps.fleet.list(), this.#deps.head),
		};
		atomicWriteJson(drainFile(this.#deps.home), record);
		created.add(createdKey(this.#deps.home, record));
		// Idle already: this answer is the report, so it is written `reported` and no wake follows.
		return this.#survivors().length === 0 ? (this.#finish(record, [], true) ?? record) : record;
	}

	/**
	 * The ordinary tick. Moves a running drain to its outcome once and journals its one wake;
	 * an outcome whose wake was never journaled (a failed write) is journaled again here. A
	 * journal failure throws to the caller and stays `reported: false` for the next tick.
	 */
	check(): DrainRecord | undefined {
		let record: DrainRecord | undefined;
		try {
			record = readDrain(this.#deps.home);
		} catch {
			return undefined; // Unreadable: every gate stays closed (readDrain throws there), and startup reports and clears it.
		}
		if (!record || this.#deps.owns?.() === false) return record;
		if (record.state === "draining") {
			const left = this.#survivors();
			if (left.length > 0 && this.#now().getTime() < Date.parse(record.deadline)) return record;
			// Written before the wake: a re-entrant tick from the journal sees the outcome, never `draining`.
			const done = this.#finish(record, left, false);
			if (!done) return undefined;
			record = done;
		}
		if (record.reported !== false) return record;
		// The outbox dedups by id, so a re-entrant or retried journal still delivers one wake.
		this.#deps.journal({ id: outcomeWakeId(record, record.state as "drained" | "timeout"), content: formatDrain(record, this.#deps.home) });
		const reported = { ...record, reported: true };
		// The journal can re-enter or outlive a startup, cancel or operator rm: never write a removed drain back.
		return this.#writeIfCurrent(reported) ? reported : undefined;
	}

	/** Write `record` only while the same drain (same started_at) is still on disk; a removed or replaced drain is never resurrected. */
	#writeIfCurrent(record: DrainRecord): boolean {
		let live: DrainRecord | undefined;
		try {
			live = readDrain(this.#deps.home);
		} catch {
			return false; // Unreadable: every gate stays closed, and startup reports and clears it.
		}
		if (live?.started_at !== record.started_at) return false;
		atomicWriteJson(drainFile(this.#deps.home), record);
		return true;
	}

	#finish(record: DrainRecord, left: string[], reported: boolean): DrainRecord | undefined {
		const done: DrainRecord = {
			...record,
			state: left.length > 0 ? "timeout" : "drained",
			finished_at: isoTimestamp(this.#now()),
			...(left.length > 0 ? { survivors: left } : {}),
			reported,
			jobs: inFlightJobs(this.#deps.fleet.list(), this.#deps.head),
		};
		return this.#writeIfCurrent(done) ? done : undefined;
	}

	/** `session_shutdown`: the workers are gone, so the next session's startup may report and clear. */
	released(): void {
		this.#owned = false;
	}

	/**
	 * `/cp-drain cancel` (cp-update's drain timeout). Owner-only: withdraws a `draining` or `timeout` drain,
	 * or a `drained` record an earlier parent left behind — never this process's own `drained` one, which is
	 * the restart already prepared — and journals one wake saying so.
	 */
	cancel(): string {
		if (this.#deps.owns?.() === false) throw new DrainError(`refused: this session does not hold the parent lock for ${this.#deps.home}; run /cp-drain cancel in the parent that does`);
		const record = readDrain(this.#deps.home);
		if (!record) throw new DrainError("refused: no drain to cancel");
		if (record.state === "drained" && this.#owned) throw new DrainError(`refused: this parent drained (started ${record.started_at}); that restart is prepared — restart the parent (cp_parent stop + start), whose startup clears it`);
		const content = `${DRAIN_PREFIX}cancelled \u2014 the drain started ${record.started_at} (${record.state}) is withdrawn; dispatch, promotion, revive, review and merge steps are open again`;
		// Journaled before the file goes: a failed journal leaves the drain (and every gate) in place.
		this.#deps.journal({ id: `drain:${record.started_at}:cancelled`, content });
		// The cancel supersedes this drain's own undelivered outcome wake (same started_at), so only the cancel is delivered. Idempotent: a retry after a throw here is safe.
		this.#deps.discard?.([outcomeWakeId(record, "drained"), outcomeWakeId(record, "timeout")]);
		rmSync(drainFile(this.#deps.home), { force: true });
		return content;
	}

	/** Startup only: report the recorded jobs through `cp-recovery`, then clear draining. Never while this process drains. */
	startup(): DrainRecord | undefined {
		if (this.#owned) {
			try {
				const kept = readDrain(this.#deps.home);
				if (kept) process.stderr.write(`drain: kept the ${kept.state} drain started ${kept.started_at} at startup: this process owns it\n`);
			} catch (error) {
				process.stderr.write(`drain: kept ${drainFile(this.#deps.home)} at startup: this process owns it (${(error as Error).message})\n`);
			}
			return undefined;
		}
		return this.#clear("at startup");
	}

	/** Gate self-heal: clears a spent `drained` record this process did not write; never a `draining` one. */
	healStale(record: DrainRecord): boolean {
		if (record.state !== "drained" || this.#owned || this.#deps.owns?.() === false || created.has(createdKey(this.#deps.home, record))) return false;
		const target = record.cause?.target_sha;
		// finished_at is second-precision: only a record a whole second older than this process is provably pre-start.
		const spent = record.finished_at !== undefined && Date.parse(record.finished_at) + 1000 <= PROCESS_STARTED_MS
			? `it finished ${record.finished_at}, before this parent started`
			: target && runningSha && (runningSha.startsWith(target) || target.startsWith(runningSha)) ? `its auto-update target ${target.slice(0, 12)} is the running version` : undefined;
		return spent !== undefined && this.#clear(`at a start gate (${spent})`) !== undefined;
	}

	#clear(when: string): DrainRecord | undefined {
		const file = drainFile(this.#deps.home);
		try {
			// The file goes even when the notice cannot be journaled (a lost notice costs a line; a kept file refuses every start).
			const cleared = consumeDrain(this.#deps.home, (found) => {
				try {
					this.#deps.discard?.([outcomeWakeId(found, "drained"), outcomeWakeId(found, "timeout")]);
					this.#deps.journal({ id: `recovery:drain:${found.started_at}`, content: formatDrainRecovery(found), keys: found.jobs.map((job) => job.job_id) });
				} catch (error) {
					process.stderr.write(`drain: the RESTART AFTER DRAIN notice for the drain started ${found.started_at} was not journaled (${(error as Error).message}); ${file} is cleared anyway\n`);
				}
			});
			if (cleared) process.stderr.write(`drain: cleared the ${cleared.state} drain started ${cleared.started_at} ${when} (${file})\n`);
			return cleared;
		} catch (error) {
			process.stderr.write(`drain: could not clear ${file} ${when} (${(error as Error).message}); every start stays refused until it is removed\n`);
			return undefined;
		}
	}
}

function jobLines(record: DrainRecord): string[] {
	return record.jobs.map((job) => `  ${job.job_id} ${job.phase}, lease ${job.lease}, head ${job.head?.slice(0, 12) ?? "none"}`);
}

/** `/cp-drain`'s answer and the one outcome wake; `cp_parent drain` captures the prefix. */
export function formatDrain(record: DrainRecord, home: string): string {
	const head = record.state === "drained"
		? `${DRAIN_PREFIX}drained: safe to restart`
		: record.state === "timeout"
			? `${DRAIN_PREFIX}drain timed out after ${record.timeout_s}s: still busy ${record.survivors?.join(", ") ?? "unknown"}; a restart now kills them`
			: `${DRAIN_PREFIX}draining since ${record.started_at}: waiting for live workers and reviewers to settle; one wake follows when drained, or at ${record.deadline} naming the survivors`;
	const why = describeCause(record);
	return [
		head,
		`  ${record.jobs.length} job(s) in flight (drain started_at ${record.started_at}) recorded in ${drainFile(home)}`,
		...(why ? [`  cause: ${why}`] : []),
		...jobLines(record),
		"  every new process (dispatch, promotion, revive, review) and every new merge step stays refused until the parent restarts.",
	].join("\n");
}

/** What `cp_parent stop`/`rotate` says before it kills the parent's workers. */
export function restartNotice(home: string, records: () => readonly FleetRecord[]): string {
	let drain: DrainRecord | undefined;
	try {
		drain = readDrain(home);
	} catch (error) {
		return `warning: ${(error as Error).message}`;
	}
	if (drain?.state === "drained") return `drained at ${drain.finished_at ?? drain.started_at}: safe to restart; ${drain.jobs.length} job(s) recorded in ${drainFile(home)}`;
	let live: number | string;
	try {
		live = liveWorkerJobs(records()).length;
	} catch (error) {
		live = `an unknown number of (${(error as Error).message})`;
	}
	if (drain?.state === "timeout") return `warning: the drain timed out with ${drain.survivors?.join(", ") ?? "survivors"} still busy; this kills ${live} live worker(s)`;
	if (drain) return `warning: a drain started at ${drain.started_at} has not finished; this kills ${live} live worker(s)`;
	return `warning: not drained; this kills ${live} live worker(s) (cp_parent drain first to let them settle)`;
}

/** Jobs with a live worker or script pid in flight (held PR workers included): what a restart kills. */
export function liveWorkerJobs(records: readonly FleetRecord[]): string[] {
	return records.filter((record) => {
		const pid = record.worker ? (record.worker.exited_at ? undefined : record.worker.pid) : record.script_process?.pid;
		return IN_FLIGHT.includes(record.phase) && pid !== undefined && isPidAlive(pid);
	}).map((record) => record.job_id);
}

/**
 * What blocks an auto-update restart (cp-ccm0): live script pids — a drain never waits for them — and live
 * workers whose run is not `idle` (absent/unreadable status fails closed as working). An idle held/waiting
 * worker is what a drain leaves revivable, so it blocks nothing.
 */
export function restartActivity(records: readonly FleetRecord[], runPhase: (jobId: string) => RunPhase | undefined): { working: string[]; scripts: string[] } {
	const working: string[] = [];
	const scripts: string[] = [];
	for (const record of records) {
		if (!IN_FLIGHT.includes(record.phase)) continue;
		if (!record.worker) {
			const pid = record.script_process?.pid;
			if (pid !== undefined && !record.script_process?.exited_at && isPidAlive(pid)) scripts.push(record.job_id);
		} else if (!record.worker.exited_at && isPidAlive(record.worker.pid) && runPhase(record.job_id) !== "idle") working.push(record.job_id);
	}
	return { working, scripts };
}

/**
 * Report, then remove, the drain record. An unreadable file is reported and removed, never left to
 * block a fresh parent; a `report` that throws still removes the file, then rethrows.
 */
export function consumeDrain(home: string, report?: (record: DrainRecord) => void): DrainRecord | undefined {
	let record: DrainRecord | undefined;
	try {
		record = readDrain(home);
	} catch (error) {
		record = { state: "draining", started_at: "unknown", deadline: "unknown", timeout_s: 0, survivors: [(error as Error).message], jobs: [] };
	}
	if (!record) return undefined;
	try {
		report?.(record);
	} finally {
		rmSync(drainFile(home), { force: true });
	}
	return record;
}

export function formatDrainRecovery(record: DrainRecord): string {
	const how = record.state === "drained" ? "drained cleanly" : record.state === "timeout" ? "drain timed out" : "drain never finished";
	return [
		`RESTART AFTER DRAIN — ${how} (started ${record.started_at}); ${record.jobs.length} job(s) were in flight`,
		...jobLines(record),
		...(record.survivors?.length ? [`  not settled at restart: ${record.survivors.join(", ")}`] : []),
		"  draining is cleared: dispatch, promotion, revive, review and merge steps are open again. The drain revived nothing;",
		"  the reconcile report and bounded recovery own any revive. next: cp_next.",
	].join("\n");
}
