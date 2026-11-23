/**
 * cp-912x R6 (`state/native-wait.json`): a review, gate, revive, send or pipeline advance a full CLI keeps waiting,
 * replayed FIFO per CLI on that same CLI, never another, before the dispatch queue's new jobs. Only the lock owner
 * drains, never during a home drain; every outcome but "still full" wakes the parent.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type FleetRecord,
	isoTimestamp,
	LAYOUT,
	NATIVE_WAIT_MAX,
	type NativeWaitEntry,
	type NativeWaitFile,
	type NativeWaitKind,
	type NativeWaitRequest,
	validateNativeWaitFile,
} from "./contracts.ts";
import type { CommandPost } from "./command-post.ts";
import { isDiffReviewWait } from "./diff-review.ts";
import { keepsHead, waitingLabel } from "./dispatch-queue.ts";
import type { NativeDriverError } from "./drivers/claude.ts";
import { nativeDriverSpec } from "./drivers/registry.ts";
import { assertNotDraining, readDrain } from "./drain.ts";
import { isGateWait } from "./gate.ts";
import { atomicWriteJson } from "./json-store.ts";
import { ReviewRuns } from "./review-runs.ts";
import { boundedWakeupId, type DurableWakeupInput } from "./wakeup-outbox.ts";
import type { NativeDriver } from "./worker-driver.ts";

export class NativeWaitError extends Error {}

/** The start was queued, not refused: callers show it as `state: queued` (tools) or wait for its wake-up. */
export class NativeWaitQueuedError extends Error {
	readonly entry: NativeWaitEntry;
	readonly position: number;
	constructor(entry: NativeWaitEntry, position: number) {
		super(queuedText(entry, position));
		this.entry = entry;
		this.position = position;
	}
}

export interface NativeWaitInput {
	kind: NativeWaitKind;
	job_id: string;
	driver: NativeDriver;
	text: string;
	request?: NativeWaitRequest;
}

export interface NativeWaitOptions {
	home: string;
	/** CommandPost's `#ownsHome()`: the real parent-lock read, per call, failing closed. */
	owns: () => boolean;
	journal: (input: DurableWakeupInput) => void;
	/** Re-runs the entry's full entry point without queueing again; resolves with a one-line detail. */
	replay: (entry: NativeWaitEntry) => Promise<string>;
	/** Drained after this queue (the dispatch queue): work on existing jobs first, then new jobs. */
	then?: () => Promise<void>;
	now?: () => Date;
}

/** The queued result's text, the same words every surface shows. */
export function queuedText(entry: Pick<NativeWaitEntry, "kind" | "job_id" | "driver" | "text">, position: number): string {
	return `${entry.job_id}: ${entry.kind} queued (position ${position}), ${entry.text} — it runs on the ${nativeDriverSpec(entry.driver).label} ` +
		"when a slot frees and never on another CLI; do not re-issue, its wake-up says when it started";
}

/** A tool result for a queued start; any other error is rethrown. */
export function queuedToolResult(error: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	if (!(error instanceof NativeWaitQueuedError)) throw error;
	const { entry, position } = error;
	return { content: [{ type: "text", text: error.message }], details: { state: "queued", waiting: entry.text, position, kind: entry.kind, job_id: entry.job_id, driver: entry.driver } };
}

export class NativeWaitQueue {
	readonly #options: NativeWaitOptions;
	readonly #file: string;
	#chain: Promise<void> = Promise.resolve();

	constructor(options: NativeWaitOptions) {
		this.#options = options;
		this.#file = join(options.home, LAYOUT.nativeWaitFile);
	}

	/** Absent reads as empty; a corrupt file throws naming the path (never silently dropped). */
	read(): NativeWaitFile {
		if (!existsSync(this.#file)) return { schema_version: 1, entries: [] };
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#file, "utf8"));
		} catch (error) {
			throw new NativeWaitError(`refusing to read an unparseable ${this.#file}: ${(error as Error).message}`);
		}
		const result = validateNativeWaitFile(parsed);
		if (!result.ok) throw new NativeWaitError(`refusing to read an invalid ${this.#file}:\n  ${result.errors.join("\n  ")}`);
		return result.value;
	}

	/** What `cp_next` shows under `lined_up.waiting`. */
	list(): Array<Pick<NativeWaitEntry, "job_id" | "kind" | "driver" | "text">> {
		return this.read().entries.map(({ job_id, kind, driver, text }) => ({ job_id, kind, driver, text }));
	}

	/** Append, or find the same kind already waiting for that job (never a duplicate). Returns the 1-based position. */
	enqueue(input: NativeWaitInput): { entry: NativeWaitEntry; position: number } {
		assertNotDraining(this.#options.home, `the queued ${input.kind} of ${input.job_id}`);
		const file = this.read();
		const at = file.entries.findIndex((entry) => entry.kind === input.kind && entry.job_id === input.job_id);
		if (at >= 0) return { entry: file.entries[at]!, position: at + 1 };
		if (file.entries.length >= NATIVE_WAIT_MAX) throw new NativeWaitError(`the native wait queue is full (${NATIVE_WAIT_MAX} entries) — the ${input.kind} of ${input.job_id} was not queued; ${input.text}`);
		const entry: NativeWaitEntry = { kind: input.kind, job_id: input.job_id, driver: input.driver, text: input.text.slice(0, 500), request: input.request ?? {}, queued_at: isoTimestamp(this.#now()) };
		this.#write({ ...file, entries: [...file.entries, entry] });
		return { entry, position: file.entries.length + 1 };
	}

	/** The error to throw for `error`: a full CLI's refusal becomes a queued entry, anything else stays itself. */
	queue(kind: NativeWaitKind, jobId: string, request: NativeWaitRequest, error: unknown): unknown {
		const text = waitingLabel(error);
		const driver = (error as NativeDriverError | undefined)?.driver;
		if (text === undefined || driver === undefined) return error;
		const { entry, position } = this.enqueue({ kind, job_id: jobId, driver, text, request });
		return new NativeWaitQueuedError(entry, position);
	}

	/** Runs `start`; a full CLI queues it (thrown as NativeWaitQueuedError) instead of refusing. */
	orWait<T>(kind: NativeWaitKind, jobId: string, request: NativeWaitRequest, start: () => Promise<T>): Promise<T> {
		return start().catch((error: unknown) => { throw this.queue(kind, jobId, request, error); });
	}

	/** Serialized: a concurrent call waits for the running drain, so each entry replays once; then the next queue. */
	drain(): Promise<void> {
		this.#chain = this.#chain.then(() => this.#drain()).catch((error: unknown) => {
			const cause = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
			this.#options.journal({ id: boundedWakeupId(`native-wait:failed:${cause}`), kind: "recovery", content: `NATIVE WAIT DRAIN FAILED — ${cause}\n  Waiting entries are kept; the next freed slot or scheduler tick retries.` });
		}).then(() => this.#options.then?.());
		return this.#chain;
	}

	async #drain(): Promise<void> {
		if (!this.#owns()) return;
		try {
			if (readDrain(this.#options.home)) return;
		} catch {
			return; // an unreadable drain record fails closed
		}
		// FIFO per CLI: a still-full head keeps its place and every later entry of that CLI.
		const full = new Set<NativeDriver>();
		for (const entry of this.read().entries) {
			if (full.has(entry.driver)) continue;
			if (!this.#owns()) return;
			if (!this.read().entries.some((each) => sameEntry(each, entry))) continue;
			try {
				this.#finish(entry, "started", await this.#options.replay(entry));
			} catch (error) {
				if (keepsHead(error)) full.add(entry.driver);
				else this.#finish(entry, "dropped", ((error as Error).message ?? String(error)).split("\n")[0]!.slice(0, 300));
			}
		}
	}

	#finish(head: NativeWaitEntry, outcome: "started" | "dropped", detail: string): void {
		const file = this.read();
		this.#write({ ...file, entries: file.entries.filter((entry) => !sameEntry(entry, head)) });
		if (head.request.message_file) rmSync(head.request.message_file, { force: true });
		const what = `the ${head.kind} of ${head.job_id}`;
		const content = outcome === "started"
			? `NATIVE WAIT STARTED — ${what} ran on the ${nativeDriverSpec(head.driver).label} (${detail}), queued at ${head.queued_at}; a slot freed.`
			: `NATIVE WAIT DROPPED: ${detail} — ${what}, queued at ${head.queued_at}. Nothing ran on any CLI; re-issue it if it is still wanted.`;
		this.#options.journal({ id: boundedWakeupId(`native-wait:${outcome}:${head.kind}:${head.job_id}:${head.queued_at}`), kind: "recovery", job_id: head.job_id, keys: [head.job_id], content });
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

	#write(file: NativeWaitFile): void {
		const result = validateNativeWaitFile(JSON.parse(JSON.stringify(file)));
		if (!result.ok) throw new NativeWaitError(`refusing to write an invalid ${this.#file}:\n  ${result.errors.join("\n  ")}`);
		atomicWriteJson(this.#file, file);
	}
}

const sameEntry = (a: NativeWaitEntry, b: NativeWaitEntry): boolean => a.kind === b.kind && a.job_id === b.job_id && a.queued_at === b.queued_at;

type ReplayPost = Pick<CommandPost, "diffReviewModule" | "gateModule" | "reviewRuns" | "revive" | "sender" | "pipeline"> & { fleet: { get(id: string): FleetRecord | undefined } };

/** Each kind's full entry point, re-run without queueing again: a still-full CLI throws `occupied` (head kept). */
export function replayOn(post: ReplayPost): (entry: NativeWaitEntry) => Promise<string> {
	return async (entry) => {
		const r = entry.request;
		const review = { jobId: entry.job_id, ...(r.model ? { model: r.model } : {}), ...(r.deliver_revise === undefined ? {} : { deliverRevise: r.deliver_revise }), ...(r.directive ? { directive: r.directive } : {}) };
		if (entry.kind === "review" || entry.kind === "gate") {
			const started = entry.kind === "review" ? await post.diffReviewModule().start(review) : await post.gateModule().start(review);
			const wait = entry.kind === "review" ? isDiffReviewWait(started as never) : isGateWait(started as never);
			if (!wait) return `${entry.kind} already decided on disk`;
			const { key, attempt } = started as unknown as { key: string; attempt: number };
			post.reviewRuns.handBack(key); // nobody else holds this result: the verdict wakes the parent
			return `${entry.kind} attempt ${attempt} started`;
		}
		if (entry.kind === "revive") {
			const revived = await post.revive(entry.job_id, r.native_recovery ? { nativeRecovery: true } : {});
			return `revived, pid ${revived.pid}`;
		}
		if (entry.kind === "send") {
			const message = readFileSync(r.message_file ?? "", "utf8");
			const sent = await post.sender.send({ jobId: entry.job_id, message, nativeReplay: true, ...(r.mode ? { mode: r.mode } : {}),
				...(r.purpose ? { purpose: r.purpose } : {}), ...(r.keep_round ? { keepRound: true } : {}) });
			if (sent.receipt === "failed") throw new NativeWaitError(sent.error ?? "the worker refused the message");
			return `send ${sent.receipt}`;
		}
		const advanced = await post.pipeline().advance(entry.job_id, { nativeReplay: true });
		if (advanced.pending) post.reviewRuns.handBack(ReviewRuns.key(advanced.pending.surface === "review" ? advanced.ship_id : advanced.research_id, advanced.pending.surface, advanced.pending.attempt));
		return `advance ${advanced.state}/${advanced.next}`;
	};
}

/** The review/gate request fields a replay re-runs with. */
export const reviewWaitRequest = (request: { model?: string; deliverRevise?: boolean; directive?: string }): NativeWaitRequest => ({
	...(request.model ? { model: request.model } : {}), ...(request.deliverRevise === undefined ? {} : { deliver_revise: request.deliverRevise }),
	...(request.directive ? { directive: request.directive.slice(0, 500) } : {}),
});

/** A pipeline advance a full CLI refused: its queue position, or undefined for any other error. */
export function waitAdvance(queue: Pick<NativeWaitQueue, "queue">, researchId: string, error: unknown): number | undefined {
	const queued = queue.queue("pipeline-advance", researchId, {}, error);
	return queued instanceof NativeWaitQueuedError ? queued.position : undefined;
}
