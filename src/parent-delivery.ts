/**
 * Parent delivery — the bridge's half of the send outbox (`src/parent-outbox.ts`):
 * inject, drain when the parent's turn ends, reconcile against the parent's
 * own transcript after every spawn, attribute replies by landed id, and relay
 * every outcome no tool result carried. Process ownership, relaunch and the
 * relay stream stay in `src/cp-bridge.ts`.
 */
import {
	frameBatch,
	frameResume,
	landedOutcomes,
	type ParentSendEntry,
	type ParentSendDelegation,
	type ParentSendOutbox,
	type ParentSendReceipt,
	sendIdsInText,
	sendRelay,
} from "./parent-outbox.ts";
import { isTransientProviderError, MAX_OUTER_RETRIES, OUTER_RETRY_DELAYS_MS, RESUME_NUDGE } from "./provider-retry.ts";
import type { WorkerProcess } from "./worker-process.ts";

type OuterRetryEvent = "outer_retry_attempt" | "outer_retry_succeeded" | "outer_retry_exhausted" | "relay_failed";

/** An operator send must not queue behind fleet follow-ups: it lands at the next tool-batch boundary. */
const PARENT_STREAMING = "steer" as const;

export interface LandedMark {
	id: string;
	/** `texts.length` and `assistantCount` of the run when the marker landed. */
	index: number;
	assistants: number;
}

export interface LandedTurn {
	texts: string[];
	assistantCount: number;
	error?: { message: string };
	landed: LandedMark[];
}

type SendOutcome = { failed: boolean; reply: string; error: string };

export interface DeliveryHost {
	/** The ready, live parent; undefined while dead, booting, relaunching or stopping. */
	liveProc(): WorkerProcess | undefined;
	emit(relay: ReturnType<typeof sendRelay>): void;
	/** H1 outer ladder: the wait between resumes, its journal, and once-per-send turn counting. */
	sleep(ms: number): Promise<void>;
	journal(event: OuterRetryEvent, payload: Record<string, unknown>): void;
	countTurn(failed: boolean, error: string): void;
	requestTimeoutMs?: number;
}

export class ParentDelivery {
	readonly outbox: ParentSendOutbox;
	readonly #host: DeliveryHost;
	/** Sync `send()` calls still holding their tool result, by send id. */
	readonly #waiters = new Map<string, (outcome: SendOutcome | undefined) => void>();
	/**
	 * Outer-ladder attempts per send id (H1, Pier 2.6), in memory.
	 * ponytail: a death or restart mid-ladder drops the count; the entry stays
	 * `landed`, so the relaunch's resume nudge takes over. Persist it if that matters.
	 */
	readonly #retries = new Map<string, number>();
	/** The post-ready transcript read failed; retried on the next settle. */
	#reconcilePending = false;
	/**
	 * Ids injected or landed by the current parent process. A reconcile never
	 * requeues and a resume never nudges one of these: they did not cross a restart.
	 */
	readonly #live = new Set<string>();
	/** Send ids already journaled as relay_failed for this process; cleared once the entry finally relays. */
	readonly #relayFailedJournaled = new Set<string>();

	constructor(outbox: ParentSendOutbox, host: DeliveryHost) {
		this.outbox = outbox;
		this.#host = host;
	}

	/**
	 * On disk first, then injected. An outcome inside `timeoutMs` is the tool
	 * result; a later one arrives as a `send` relay with the same id (`pending`).
	 */
	async send(text: string, timeoutMs: number, delegation: ParentSendDelegation = {}): Promise<ParentSendReceipt> {
		const entry = this.outbox.enqueue(text, delegation);
		const pending = { send_id: entry.id, pending: entry.id };
		const proc = this.#host.liveProc();
		if (!proc) return { level: null, reached: [], ...pending };
		let finish: (outcome: SendOutcome | undefined) => void = () => undefined;
		const outcome = new Promise<SendOutcome | undefined>((resolve) => (finish = resolve));
		this.#waiters.set(entry.id, finish); // before the write: the settle can precede the RPC response
		const refused = await this.#inject(proc, [entry]);
		if (refused !== undefined) {
			this.#waiters.delete(entry.id);
			return { level: null, reached: [], ...pending, error: `${refused}; kept queued, delivered once by id when the parent is ready` };
		}
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		const result = await outcome;
		clearTimeout(timer);
		this.#waiters.delete(entry.id);
		if (!result) return { level: "injected", reached: ["injected"], ...pending };
		this.outbox.markObserved(entry.id);
		if (result.failed) {
			return { level: "turn_failed", reached: ["injected", "turn_settled", "turn_failed"], error: result.error, send_id: entry.id };
		}
		return { level: "owner_observed", reached: ["injected", "turn_settled", "owner_observed"], reply: result.reply, send_id: entry.id };
	}

	/** A parent user message: record every send whose marker it carries as landed in this run. */
	landed(text: string, turn: LandedTurn): void {
		const ids = sendIdsInText(text);
		if (ids.length === 0) return;
		let landed: string[] = [];
		try {
			landed = this.outbox.markLanded(ids);
		} catch {
			// Unreadable outbox: status reports it.
		}
		for (const id of landed) {
			this.#live.add(id);
			if (!turn.landed.some((mark) => mark.id === id)) {
				turn.landed.push({ id, index: turn.texts.length, assistants: turn.assistantCount });
			}
		}
	}

	/**
	 * The run settled: a transient failure is resumed under the same id (the
	 * entry stays `landed`, its waiter keeps waiting); every final outcome goes
	 * to its waiter, or out as one relay, and counts once toward the relaunch cap.
	 */
	settle(turn: LandedTurn): void {
		for (const { id, ...outcome } of landedOutcomes(turn)) {
			if (outcome.failed && this.#scheduleResume(id, outcome.error)) continue;
			this.#finish(id, outcome);
		}
	}

	#finish(id: string, outcome: SendOutcome): void {
		const attempts = this.#retries.get(id) ?? 0;
		this.#retries.delete(id);
		if (attempts > 0 && !outcome.failed) this.#host.journal("outer_retry_succeeded", { send_id: id, afterAttempts: attempts });
		if (attempts >= MAX_OUTER_RETRIES && outcome.failed) {
			this.#host.journal("outer_retry_exhausted", { send_id: id, attempts, message: outcome.error });
		}
		let entry: ParentSendEntry | undefined;
		try {
			if (this.outbox.settle(id, outcome.failed ? { error: outcome.error } : { reply: outcome.reply })) entry = this.outbox.get(id);
		} catch {
			// The waiter still gets the outcome; an unwritable outbox shows in status.
		}
		const waiter = this.#waiters.get(id);
		this.#waiters.delete(id);
		if (waiter) waiter(outcome);
		else if (entry) this.relay(entry);
		this.#host.countTurn(outcome.failed, outcome.error);
	}

	/** A transient provider failure with ladder left: resume later, under the same id. */
	#scheduleResume(id: string, error: string): boolean {
		const attempt = (this.#retries.get(id) ?? 0) + 1;
		if (!isTransientProviderError(error) || attempt > MAX_OUTER_RETRIES) return false;
		this.#retries.set(id, attempt);
		const delayMs = OUTER_RETRY_DELAYS_MS[attempt - 1] as number;
		this.#host.journal("outer_retry_attempt", { send_id: id, attempt, delayMs, message: error });
		void this.#host.sleep(delayMs).then(() => this.#resume(id, attempt, error));
		return true;
	}

	/** The resume nudge carries the same id's marker, so its reply settles this send. */
	async #resume(id: string, attempt: number, error: string): Promise<void> {
		if (this.#retries.get(id) !== attempt) return; // superseded, or dropped by a death/stop
		const proc = this.#host.liveProc();
		if (!proc) return; // still `landed`: the relaunch's resume nudge answers it
		const sent = await proc.send(frameBatch([{ id, text: RESUME_NUDGE }]), "prompt", PARENT_STREAMING);
		if (sent.receipt === "failed") this.#finish(id, { failed: true, reply: "", error: sent.error ?? error });
	}

	/** "When the parent's turn ends": queued sends go in now, as one message. */
	afterSettle(): void {
		const proc = this.#host.liveProc();
		if (proc && this.#reconcilePending) void this.afterReady(proc);
		else if (proc) this.#drain(proc);
	}

	/**
	 * After every spawn: `injected` sends from a dead process are checked against
	 * the parent's own transcript (`ParentSendOutbox.reconcile`); landed-unanswered
	 * ones get one resume nudge, never the body; then the queue drains. An
	 * unreadable transcript re-injects nothing and is retried on the next settle.
	 */
	async afterReady(proc: WorkerProcess): Promise<void> {
		this.#reconcilePending = false;
		try {
			// Read before any await: a send this process injects or lands meanwhile
			// is never requeued (a second delivery) nor nudged as "before the restart".
			const crossed = (state: string) =>
				new Set(this.outbox.list().filter((entry) => entry.state === state && !this.#live.has(entry.id)).map((entry) => entry.id));
			const injected = crossed("injected");
			const landed = crossed("landed");
			if (injected.size > 0) {
				const transcript = await proc.getEntries(undefined, this.#host.requestTimeoutMs);
				for (const entry of this.outbox.reconcile(transcript, injected)) this.relay(entry);
			}
			const resume = this.outbox
				.list()
				.filter((entry) => entry.state === "landed" && (landed.has(entry.id) || injected.has(entry.id)) && !this.#live.has(entry.id))
				.map((entry) => entry.id);
			if (resume.length > 0) {
				const sent = await proc.send(frameResume(resume), "prompt", PARENT_STREAMING);
				if (sent.receipt === "failed") throw new Error(sent.error ?? "resume failed");
			}
		} catch {
			this.#reconcilePending = true;
			return;
		}
		this.#drain(proc);
	}

	/** Outcomes relayed into an operator session that died unseen come back once. */
	relaysDue(): void {
		for (const entry of this.outbox.relaysDue()) this.relay(entry);
	}

	/** `cp_parent stop`: sends that never landed end undeliverable, relayed once. */
	discardUnlanded(reason: string): void {
		try {
			const ids = this.outbox.unlanded().map((entry) => entry.id);
			for (const entry of this.outbox.markUndeliverable(ids, reason)) this.relay(entry);
		} catch {
			// An unreadable outbox is reported by status and the next start.
		}
	}

	/** The parent died or stopped: each `send()` returns its pending receipt; the sends stay on disk. */
	failWaiters(): void {
		for (const waiter of this.#waiters.values()) waiter(undefined);
		this.#waiters.clear();
		this.#retries.clear();
		this.#live.clear();
		this.#relayFailedJournaled.clear();
	}

	/**
	 * A throw from `emit` (H3c) must never abort the loop it is called from
	 * (`relaysDue`, the reconcile loop in `afterReady`): journal it so the
	 * failure is never silently dropped, then return without marking the entry
	 * relayed — the next `relaysDue()`/reconcile pass retries the same entry,
	 * so it is relayed exactly once it actually lands, never duplicated.
	 */
	relay(entry: ParentSendEntry): void {
		try {
			this.#host.emit(sendRelay(entry, this.outbox.file));
		} catch (error) {
			if (!this.#relayFailedJournaled.has(entry.id)) {
				this.#relayFailedJournaled.add(entry.id);
				this.#host.journal("relay_failed", { send_id: entry.id, message: (error as Error).message ?? String(error) });
			}
			return;
		}
		this.#relayFailedJournaled.delete(entry.id);
		try {
			this.outbox.markRelayed(entry.id);
		} catch {
			// Unstamped: the next operator process re-emits it once.
		}
	}

	#drain(proc: WorkerProcess): void {
		if (this.#host.liveProc() !== proc) return;
		try {
			for (const entry of this.outbox.expireStale()) this.relay(entry);
			void this.#inject(proc, this.outbox.due()).catch(() => undefined);
		} catch {
			// Unreadable outbox: status reports it; nothing is injected without a record.
		}
	}

	/** Reserve on disk, then one RPC write; a refused write goes back to `queued`. Returns the refusal. */
	// pi, not `proc.busy`, decides start vs queue: prompt + steer starts a run when idle, lands after the current tool batch when busy.
	async #inject(proc: WorkerProcess, entries: readonly ParentSendEntry[]): Promise<string | undefined> {
		if (entries.length === 0) return undefined;
		const ids = entries.map((entry) => entry.id);
		for (const id of ids) this.#live.add(id);
		this.outbox.markInjected(ids);
		const sent = await proc.send(frameBatch(entries), "prompt", PARENT_STREAMING);
		if (sent.receipt !== "failed") return undefined;
		try {
			this.outbox.revertInjected(ids);
		} catch {
			// Left `injected`: the next relaunch reconciles it against the transcript.
		}
		return sent.error ?? "send failed";
	}
}
