/**
 * unload-parent PR2: dependency-landed dispatch. A `cp_dispatch` refused **only**
 * because the job's blockers are still open is armed here
 * (`state/armed-dispatches.json`) with the parent's own request, and replayed
 * through the ordinary `CommandPost.dispatch` — mandate, risk (pre-approval
 * included), routing, preflight: every gate re-run — once `ledger.blockersOf`
 * is empty. Nothing is guessed: no brief, model or task is ever invented for a
 * job nobody dispatched.
 *
 * Only the home's lock owner releases (`owns`, read per release and per entry),
 * and never during a drain. Triggers: a held PR landing (HeldContinuation
 * `onLanded`), startup, and the scheduler tick that drains the dispatch queue.
 * Outcomes: blockers still open (a dropped blocker included) → kept, silently;
 * spawn_cap → handed to the dispatch queue; parallelism_full or a blocker that
 * reopened → kept; started, queued or any other refusal → one durable wake-up
 * (a risk:high refusal has already raised its own escalation).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ARMED_DISPATCH_MAX,
	type ArmedDispatchEntry,
	type ArmedDispatchFile,
	type FleetRecord,
	isoTimestamp,
	type Job,
	LAYOUT,
	type QueuedDispatchRequest,
	validateArmedDispatchFile,
} from "./contracts.ts";
import { BlockedDispatchError, type DispatchRequest } from "./dispatch.ts";
import { toDispatchRequest } from "./dispatch-queue.ts";
import { assertNotDraining, readDrain } from "./drain.ts";
import { atomicWriteJson } from "./json-store.ts";
import { MandateError } from "./mandate-accounting.ts";
import { boundedWakeupId, type DurableWakeupInput } from "./wakeup-outbox.ts";
import { SpawnSafetyError } from "./worker-manager.ts";

export class ArmedDispatchError extends Error {}

export interface ArmedDispatchOptions {
	home: string;
	/** `CommandPost.dispatch`: the full gate set runs per entry. */
	dispatch: (request: DispatchRequest) => Promise<{ state: string }>;
	/** `DispatchQueue.enqueue`: a released job refused by the spawn cap waits for a slot there. */
	enqueue: (jobId: string, request: QueuedDispatchRequest) => number;
	/** CommandPost's `#ownsHome()`: the real parent-lock read, per call, failing closed. */
	owns: () => boolean;
	ledger: () => { show(id: string): Promise<Job>; blockersOf(id: string): Promise<string[]> };
	fleet: { get(id: string): FleetRecord | undefined };
	/** A pipeline's research or ship job: `cp_pipeline advance` owns its next dispatch, never this. */
	pipelineOwned: (jobId: string) => boolean;
	journal: (input: DurableWakeupInput) => void;
	now?: () => Date;
}

export class ArmedDispatches {
	readonly #options: ArmedDispatchOptions;
	readonly #file: string;
	#chain: Promise<void> = Promise.resolve();

	constructor(options: ArmedDispatchOptions) {
		this.#options = options;
		this.#file = join(options.home, LAYOUT.armedDispatchFile);
	}

	/** Absent reads as empty; a corrupt file throws naming the path (never silently dropped). */
	read(): ArmedDispatchFile {
		if (!existsSync(this.#file)) return { schema_version: 1, entries: [] };
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#file, "utf8"));
		} catch (error) {
			throw new ArmedDispatchError(`refusing to read an unparseable ${this.#file}: ${(error as Error).message}`);
		}
		const result = validateArmedDispatchFile(parsed);
		if (!result.ok) throw new ArmedDispatchError(`refusing to read an invalid ${this.#file}:\n  ${result.errors.join("\n  ")}`);
		return result.value;
	}

	ids(): string[] {
		return this.read().entries.map((entry) => entry.job_id);
	}

	/** Arm (or re-arm with the newer request). Refuses a pipeline job, a drain and a full file. */
	arm(jobId: string, request: QueuedDispatchRequest, blockers: readonly string[]): { rearmed: boolean } {
		assertNotDraining(this.#options.home, `armed dispatch of ${jobId}`);
		if (this.#options.pipelineOwned(jobId)) throw new ArmedDispatchError(`${jobId} belongs to a pipeline — cp_pipeline advance dispatches it`);
		const file = this.read();
		const rest = file.entries.filter((entry) => entry.job_id !== jobId);
		if (rest.length >= ARMED_DISPATCH_MAX) throw new ArmedDispatchError(`${ARMED_DISPATCH_MAX} dispatches are already armed — ${jobId} was not armed`);
		this.#write({ ...file, entries: [...rest, { job_id: jobId, request, armed_at: isoTimestamp(this.#now()), blockers: [...blockers] }] });
		return { rearmed: rest.length < file.entries.length };
	}

	/** A manual dispatch that started supersedes the armed one; silent, idempotent. */
	disarm(jobId: string): void {
		const file = this.read();
		if (file.entries.some((entry) => entry.job_id === jobId)) this.#write({ ...file, entries: file.entries.filter((entry) => entry.job_id !== jobId) });
	}

	/** Serialized: a concurrent call waits for the running release, so each entry is dispatched once. */
	release(): Promise<void> {
		this.#chain = this.#chain.then(() => this.#release()).catch((error: unknown) => {
			// Never silent: a failed release keeps every entry and wakes the parent once per cause.
			const cause = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
			this.#options.journal({ id: boundedWakeupId(`armed-dispatch:failed:${cause}`), kind: "recovery", content: `ARMED DISPATCH RELEASE FAILED — ${cause}\n  Armed entries are kept; the next landing or scheduler tick retries.` });
		});
		return this.#chain;
	}

	async #release(): Promise<void> {
		if (!this.#owns()) return;
		try {
			if (readDrain(this.#options.home)) return;
		} catch {
			return; // an unreadable drain record fails closed, like every other gate
		}
		for (const entry of this.read().entries) {
			if (!this.#owns()) return; // re-read per entry: a lock reclaimed mid-release stops it
			const dropped = await this.#stale(entry);
			if (dropped) {
				this.#finish(entry, "dropped", dropped);
				continue;
			}
			if ((await this.#options.ledger().blockersOf(entry.job_id)).length > 0) continue;
			try {
				const result = await this.#options.dispatch(toDispatchRequest(entry));
				if (result.state === "promote") this.#finish(entry, "dropped", "the job already has a live worker — promote it (cp_send)");
				else this.#finish(entry, "started", result.state);
			} catch (error) {
				if (error instanceof BlockedDispatchError) continue; // a blocker reopened: still armed
				if (error instanceof MandateError && error.code === "parallelism_full") continue;
				if (error instanceof SpawnSafetyError && error.code === "spawn_cap") {
					this.#queue(entry);
					continue;
				}
				this.#finish(entry, "dropped", ((error as Error).message ?? String(error)).split("\n")[0]!.slice(0, 300));
			}
		}
	}

	/** Why the entry can no longer be dispatched, read before any dispatch; undefined when it can. */
	async #stale(entry: ArmedDispatchEntry): Promise<string | undefined> {
		if (this.#options.fleet.get(entry.job_id)) return "the job is already in the fleet";
		try {
			if (this.#options.pipelineOwned(entry.job_id)) return "the job belongs to a pipeline — cp_pipeline advance dispatches it";
			const job = await this.#options.ledger().show(entry.job_id);
			if (job.status === "closed") return `the job is closed${job.close_reason ? ` (${job.close_reason})` : ""}`;
			if (job.script) return "script jobs are never armed";
		} catch (error) {
			return `the job cannot be read: ${(error as Error).message.split("\n")[0]}`;
		}
		return undefined;
	}

	#queue(entry: ArmedDispatchEntry): void {
		let position: number;
		try {
			position = this.#options.enqueue(entry.job_id, entry.request);
		} catch (error) {
			this.#finish(entry, "dropped", `its blockers landed but the spawn cap is full and it could not be queued: ${(error as Error).message.split("\n")[0]}`);
			return;
		}
		this.#finish(entry, "queued", `position ${position}`);
	}

	#finish(entry: ArmedDispatchEntry, outcome: "started" | "queued" | "dropped", detail: string): void {
		this.disarm(entry.job_id);
		const content =
			outcome === "started"
				? `ARMED DISPATCH STARTED — ${entry.job_id} (${detail}): its blockers landed (armed at ${entry.armed_at}). Its envelope is the next wake-up.`
				: outcome === "queued"
					? `ARMED DISPATCH QUEUED — ${entry.job_id} (${detail}): its blockers landed but the spawn cap is full; it starts when a worker slot frees. Do not re-dispatch.`
					: `ARMED DISPATCH DROPPED: ${detail} — ${entry.job_id}, armed at ${entry.armed_at}. Nothing was dispatched; cp_next decides what runs next.`;
		this.#options.journal({ id: boundedWakeupId(`armed-dispatch:${outcome}:${entry.job_id}:${entry.armed_at}`), kind: "recovery", job_id: entry.job_id, keys: [entry.job_id], content });
	}

	#owns(): boolean {
		try {
			return this.#options.owns();
		} catch {
			return false;
		}
	}

	#now(): Date {
		return this.#options.now?.() ?? new Date();
	}

	/** Validated before it touches disk: one bad entry would otherwise refuse every later read. */
	#write(file: ArmedDispatchFile): void {
		const result = validateArmedDispatchFile(file);
		if (!result.ok) throw new ArmedDispatchError(`refusing to write an invalid ${this.#file}:\n  ${result.errors.join("\n  ")}`);
		atomicWriteJson(this.#file, file);
	}
}
