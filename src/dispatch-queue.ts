/**
 * cp-itl4 4b-2: the persisted dispatch queue. A `cp_dispatch` refused only by the
 * spawn cap is kept here (`state/dispatch-queue.json`) and replayed, FIFO, through
 * the ordinary `CommandPost.dispatch` — every gate re-run per entry — when a slot
 * frees. Only the home's lock owner drains (`owns`, read per drain and per entry);
 * nothing drains during a home drain. Every outcome but "still full" wakes the parent.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DISPATCH_QUEUE_MAX,
	type DispatchQueueEntry,
	type DispatchQueueFile,
	type FleetRecord,
	type Job,
	LAYOUT,
	type QueuedDispatchRequest,
	type ThinkingLevel,
	isoTimestamp,
	validateDispatchQueueFile,
} from "./contracts.ts";
import type { DispatchRequest } from "./dispatch.ts";
import { readDrain } from "./drain.ts";
import { atomicWriteJson } from "./json-store.ts";
import { MandateError } from "./mandate-accounting.ts";
import { boundedWakeupId, type DurableWakeupInput } from "./wakeup-outbox.ts";
import { SpawnSafetyError, type WorkerManager } from "./worker-manager.ts";

export class DispatchQueueError extends Error {}

export interface DispatchQueueOptions {
	home: string;
	/** `CommandPost.dispatch`: the full gate set runs per entry. */
	dispatch: (request: DispatchRequest) => Promise<{ state: string }>;
	/** HeldRelease.capacityFree: a slot is free, or a held author can be released for one. */
	capacityFree: () => boolean;
	/** CommandPost's `#ownsHome()`: the real parent-lock read, per call, failing closed. */
	owns: () => boolean;
	ledger: () => { show(id: string): Promise<Job> };
	fleet: { get(id: string): FleetRecord | undefined };
	journal: (input: DurableWakeupInput) => void;
	now?: () => Date;
}

/** Still full: keep the entry at the head, untouched, and stop the drain. */
export function keepsHead(error: unknown): boolean {
	return (error instanceof SpawnSafetyError && error.code === "spawn_cap") || (error instanceof MandateError && error.code === "parallelism_full");
}

export function toDispatchRequest(entry: Pick<DispatchQueueEntry, "job_id" | "request">): DispatchRequest {
	const r = entry.request;
	return {
		jobId: entry.job_id,
		...(r.task === undefined ? {} : { task: r.task }),
		...(r.task_file === undefined ? {} : { taskFile: r.task_file }),
		...(r.scope ? { scope: r.scope } : {}),
		...(r.risk ? { risk: r.risk } : {}),
		...(r.model ? { model: r.model } : {}),
		...(r.thinking ? { thinking: r.thinking as ThinkingLevel } : {}),
		...(r.profile ? { profile: r.profile } : {}),
		...(r.base ? { base: r.base } : {}),
		...(r.wall_clock_seconds !== undefined ? { wallClockSeconds: r.wall_clock_seconds } : {}),
		...(r.tool_call_cap !== undefined ? { toolCallCap: r.tool_call_cap } : {}),
	};
}

export class DispatchQueue {
	readonly #options: DispatchQueueOptions;
	readonly #file: string;
	#chain: Promise<void> = Promise.resolve();

	constructor(options: DispatchQueueOptions) {
		this.#options = options;
		this.#file = join(options.home, LAYOUT.dispatchQueueFile);
	}

	/** Absent reads as empty; a corrupt file throws naming the path (never silently dropped). */
	read(): DispatchQueueFile {
		if (!existsSync(this.#file)) return { schema_version: 1, entries: [] };
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#file, "utf8"));
		} catch (error) {
			throw new DispatchQueueError(`refusing to read an unparseable ${this.#file}: ${(error as Error).message}`);
		}
		const result = validateDispatchQueueFile(parsed);
		if (!result.ok) throw new DispatchQueueError(`refusing to read an invalid ${this.#file}:\n  ${result.errors.join("\n  ")}`);
		return result.value;
	}

	ids(): string[] {
		return this.read().entries.map((entry) => entry.job_id);
	}

	/** 1-based position, or undefined when not queued. */
	position(jobId: string): number | undefined {
		const index = this.ids().indexOf(jobId);
		return index < 0 ? undefined : index + 1;
	}

	/** Append; refuses a duplicate or a full queue. Returns the new position. */
	enqueue(jobId: string, request: QueuedDispatchRequest): number {
		const file = this.read();
		const at = file.entries.findIndex((entry) => entry.job_id === jobId);
		if (at >= 0) throw new DispatchQueueError(`${jobId} is already queued at position ${at + 1} — it starts when a worker slot frees; do not re-dispatch`);
		if (file.entries.length >= DISPATCH_QUEUE_MAX) throw new DispatchQueueError(`the dispatch queue is full (${DISPATCH_QUEUE_MAX} entries) — ${jobId} was not queued`);
		this.#write({ ...file, entries: [...file.entries, { job_id: jobId, request, queued_at: isoTimestamp(this.#now()), attempts: 0 }] });
		return file.entries.length + 1;
	}

	/** Serialized: a concurrent call waits for the running drain, so each entry is dispatched once. */
	drain(): Promise<void> {
		this.#chain = this.#chain.then(() => this.#drain()).catch((error: unknown) => {
			// Never silent: a failed drain keeps every entry and wakes the parent once per cause.
			const cause = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
			this.#options.journal({ id: boundedWakeupId(`dispatch-queue:failed:${cause}`), kind: "recovery", content: `DISPATCH QUEUE DRAIN FAILED — ${cause}\n  Queued entries are kept; the next freed slot or scheduler tick retries.` });
		});
		return this.#chain;
	}

	/** The current chain: resolves once every drain started so far has finished. */
	settled(): Promise<void> {
		return this.#chain;
	}

	async #drain(): Promise<void> {
		if (!this.#owns()) return;
		try {
			if (readDrain(this.#options.home)) return;
		} catch {
			return; // an unreadable drain record fails closed, like every other gate
		}
		for (let head = this.read().entries[0]; head && this.#options.capacityFree(); head = this.read().entries[0]) {
			if (!this.#owns()) return; // re-read per entry: a lock reclaimed mid-drain stops it
			const dropped = await this.#stale(head);
			if (dropped) {
				this.#finish(head, "dropped", dropped);
				continue;
			}
			try {
				const result = await this.#options.dispatch(toDispatchRequest(head));
				if (result.state === "promote") this.#finish(head, "dropped", "the job already has a live worker — promote it (cp_send)");
				else this.#finish(head, "started", result.state);
			} catch (error) {
				if (keepsHead(error)) return;
				this.#finish(head, "dropped", ((error as Error).message ?? String(error)).split("\n")[0]!.slice(0, 300));
			}
		}
	}

	/** Why the head can no longer be dispatched, read before any dispatch; undefined when it can. */
	async #stale(head: DispatchQueueEntry): Promise<string | undefined> {
		if (this.#options.fleet.get(head.job_id)) return "the job is already in the fleet";
		try {
			const job = await this.#options.ledger().show(head.job_id);
			if (job.status === "closed") return `the job is closed${job.close_reason ? ` (${job.close_reason})` : ""}`;
			if (job.script) return "script jobs are never queued";
		} catch (error) {
			return `the job cannot be read: ${(error as Error).message.split("\n")[0]}`;
		}
		return undefined;
	}

	#finish(head: DispatchQueueEntry, outcome: "started" | "dropped", detail: string): void {
		const file = this.read();
		this.#write({ ...file, entries: file.entries.filter((entry) => entry.job_id !== head.job_id) });
		const content =
			outcome === "started"
				? `QUEUED DISPATCH STARTED — ${head.job_id} (${detail}), queued at ${head.queued_at}; a worker slot freed. Its envelope is the next wake-up.`
				: `QUEUED DISPATCH DROPPED: ${detail} — ${head.job_id}, queued at ${head.queued_at}. Nothing was dispatched; cp_next decides what runs next.`;
		this.#options.journal({ id: boundedWakeupId(`dispatch-queue:${outcome}:${head.job_id}:${head.queued_at}`), kind: "recovery", job_id: head.job_id, keys: [head.job_id], content });
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

	#write(file: DispatchQueueFile): void {
		atomicWriteJson(this.#file, file);
	}
}

/** Subscribe the queue's drain to "a slot may have freed"; returns the unsubscribe. */
export function wireSlotFree(manager: Pick<WorkerManager, "onSlotFree">, queue: Pick<DispatchQueue, "drain">): () => void {
	return manager.onSlotFree(() => void queue.drain());
}
