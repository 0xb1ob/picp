/**
 * Answered decisions (cp-answer-doesnt-wake) — making a human's answer *wake*
 * the parent, the way a report and a wedged tool call already do.
 *
 * ## The incident
 *
 * The operator answered an Awaiting-you item through `/cp-decide`. The answer
 * was recorded perfectly — `state/awaiting.json` held the id, the type, the
 * answer and the timestamp — and the parent's turn was never invoked. The work
 * that decision unblocked simply sat there until the operator said "I gave the
 * decision and your turn was not invoked".
 *
 * That is the same shape as two bugs already fixed, and the fix is the same
 * shape too:
 *
 *  - a worker's `report_result` reaches the parent as a `cp-envelope` message
 *    (`src/intake.ts` → `onReported`);
 *  - a wedged tool call reaches it as a `cp-wedged` message (`src/wedged.ts`);
 *  - an answered decision reached **nothing**. Now it reaches the parent as a
 *    `cp-answered` message.
 *
 * ## Why an outbox and not a callback
 *
 * A bare callback would have delivered the common case and quietly lost every
 * other one: an answer given while no parent session is attached (a headless
 * `/cp-decide`, an `/cp-authorize` typed in a `pi -p` re-entry), or a
 * `sendMessage` that throws. So the answer is **recorded first** and delivery
 * is a separate, retried step:
 *
 *  - `AnsweredOutbox.enqueue` appends to `state/answered.json` `pending`. It is
 *    called *after* the real writer (`AwaitingStore.answerResolved`,
 *    `CheckpointStore.decide`) has already recorded the answer, so a failure
 *    here can never lose a decision — only delay a wake-up.
 *  - `pending()` is drained by whoever is live (the parent extension: on the
 *    answer itself, at `session_start`, and on the widget tick). Delivery is
 *    marked *after* it succeeds, so a failed send stays pending and is
 *    retried on the parent's next turn rather than being dropped.
 *
 * ## Sent is not delivered (cp-nx7)
 *
 * Handing a message to `pi.sendMessage` is not evidence that it reached the
 * parent: pi queues a `followUp` and delivers it when the agent next takes a
 * turn, which can be minutes later. Stamping `delivered_at` at that hand-off
 * made a four-and-a-half minute lag look like an instant delivery, and made a
 * message that never arrived indistinguishable from one that did.
 *
 * So delivery has two steps here, and only the second one writes `delivered`:
 *
 *  - `drain(send)` sends **every** pending answer, coalesced into one call,
 *    and records the attempt in memory only. Nothing is marked delivered.
 *  - `confirmDelivered(ids)` is called by whoever *observed* the message land
 *    in the parent's context (the extension's `message_start` hook). That is
 *    the evidence, and it is the only thing that stamps `delivered_at`.
 *
 * An answer whose wake-up is never observed stays `pending` and is sent again
 * once `ANSWERED_DELIVERY_RETRY_SECONDS` have passed. Losing an answer is worse
 * than repeating one, so the retry exists — but a repeat is a defect, not a
 * feature, and cp-5mgg below is what keeps it rare and non-actionable.
 *  - `delivered` is persisted, which is what makes a restart *not* replay old
 *    answers as fresh wake-ups. That is the opposite choice from
 *    `WedgedWatch`'s in-memory memory, and deliberately so: a still-wedged
 *    call is news again to a fresh session, while an answer that already woke
 *    somebody is history.
 *
 * ## The replay, and why at-least-once was not enough (cp-5mgg)
 *
 * One merge authorization — `aw-checkpoint-cp-ehsc.merge-f7b8769f0606` — was
 * delivered to the parent **three times**, each copy carrying "approved means
 * dispatch it". Nothing bad happened only because `cp_integrate` is idempotent;
 * a replayed authorization for a non-idempotent action would have been executed
 * once per copy. Two independent defects produced it, and both are fixed here:
 *
 *  1. **The arrival evidence could not name the id.** When a message reaches the
 *     parent without its `details` (the transport is free to carry only the
 *     text), `answeredIdsFromMessage` falls back to reading ids out of the
 *     notice — and its pattern stopped at the first `.`, so
 *     `aw-checkpoint-cp-ehsc.merge-f7b8769f0606` was read as
 *     `aw-checkpoint-cp-ehsc` and matched nothing pending. Every checkpoint id
 *     with a scope (`…​.diff`, `…​.merge-<head>`) was therefore **unconfirmable**,
 *     so it stayed pending and was re-sent every retry window, forever. The
 *     pattern now accepts the id it is trying to recognise.
 *  2. **A drain re-sent everything pending whenever *anything* was due.** Two
 *     answers three seconds apart meant the first went out again inside its own
 *     retry window, bundled with the second. Only *due* answers are sent now;
 *     an in-flight one is left alone until its window passes, which is what the
 *     window is for.
 *
 * And the emission itself is now **recorded on disk before the message is
 * emitted** (`sends`), not in memory afterwards: a crash between the record and
 * the send re-delivers at most once (the record is there, the answer is still
 * pending, the retry window applies) and a second drain in the same session no
 * longer re-emits an answer that session had already emitted. A `send` that
 * throws is proof of
 * non-delivery, so that record is rolled back and the answer is due again at
 * once — the honest degradation for "there is no live parent right now".
 *
 * ## A dead session's reservation is not this session's (pi-command-post-u9q)
 *
 * That durable emission record is a *reservation*: while it is inside its retry
 * window the answer is left alone, because re-emitting it is how one merge
 * authorization reached the parent three times. But a reservation is only
 * meaningful while the process that made it is still there to be woken. An
 * answer emitted by a parent that then died was queued as a `followUp` into a
 * context that will never take another turn — so the successor session
 * inherited a reservation for a message nobody can receive, and the operator's
 * answer sat undelivered until `ANSWERED_DELIVERY_RETRY_SECONDS` (120s) expired
 * and a widget tick re-sent it. "I answered it and the parent looked stuck."
 *
 * So every emission records **who made it** (`owner`), and dueness is a
 * question about ownership as well as time: a record written by any other
 * process is nobody's reservation and the answer is due **now**. That is the
 * reclaim, and it happens at the first drain a new parent performs — which is
 * `session_start`, so a restart replays immediately instead of after two
 * minutes. Nothing else changes: the answer itself is untouched (it was on disk
 * before any of this), `delivered` still makes delivery exactly-once across the
 * restart, an acknowledged answer is not pending so nothing can replay it, and
 * within one session the window still bounds repeats to one per window.
 *
 * The owner is this process, not this session file: a second `session_start` in
 * the same process (a reload, a re-entrant lock acquisition) keeps its own
 * reservations and therefore cannot duplicate an emission it has already made.
 *
 * The last line of defence is not here at all: `reviewWakeups`
 * (`src/wakeups.ts`) recognises a second `cp-answered` carrying only ids an
 * earlier one already carried and replaces it with a replay notice, so even a
 * duplicate that escapes this module can never be acted on twice.
 *
 * ## Exactly once, by id
 *
 * The dedupe key is the Awaiting-you id — one decision, one wake-up. Both
 * writers only report an answer they actually *recorded* (an idempotent second
 * `decide` with the same verdict returns early and reports nothing), and
 * `enqueue` refuses an id that is already pending or already delivered, so
 * "answering twice must not wake twice" holds even if a caller retries.
 *
 * Skip is not an answer: it writes nothing, anywhere, so nothing is enqueued
 * and nobody is woken. That invariant lives in `resolveAwaitingResponse` and
 * this module simply never hears about a skip.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ANSWERED_DELIVERY_RETRY_SECONDS,
	ANSWERED_KEEP_DELIVERED,
	ANSWERED_MESSAGE_TYPE,
	type AnsweredDelivery,
	type AnsweredDecision,
	type AnsweredOutboxFile,
	type AnsweredSend,
	AWAITING_ANSWER_MAX_CHARS,
	AWAITING_DECISION_MAX_CHARS,
	type AwaitingType,
	EMPTY_ANSWERED_OUTBOX,
	isoTimestamp,
	LAYOUT,
	SCHEMA_VERSION,
	validateAnsweredOutboxFile,
} from "./contracts.ts";
import { atomicWriteJson, canonicalDir } from "./json-store.ts";
import { type ProjectOf, projectGroupedLines } from "./project-report.ts";

export class AnsweredError extends Error {}

/**
 * Who this process is, when it reserves an emission (pi-command-post-u9q). The
 * pid alone would be ambiguous — pids are reused, and a successor parent that
 * happened to reuse the dead one's pid would inherit its reservations again —
 * so the token is the pid plus a per-process nonce: two records agree only when
 * the same running process wrote both.
 *
 * Anchored on `globalThis`, not on this module's scope, because the property it
 * has to hold is **one owner per process** and a module is not a process: a
 * second instance of this file in the same process (a differently-specified
 * import, a `?query` suffix, two copies on disk) would otherwise mint a second
 * nonce and each would treat the other's in-flight emission as a dead
 * session's — re-emitting inside the retry window, which is the duplicate
 * cp-5mgg exists to prevent. One line here is cheaper than that failure.
 */
const OWNER_KEY = Symbol.for("pi-command-post.answered.owner");
const globalOwners = globalThis as { [OWNER_KEY]?: string };
const PROCESS_OWNER = (globalOwners[OWNER_KEY] ??= `${process.pid}.${randomUUID().slice(0, 8)}`);

/** What a writer hands over once an answer is on the record. */
export interface AnsweredInput {
	id: string;
	type: AwaitingType;
	job_id?: string;
	decision: string;
	answer: string;
	answered_by: string;
	answered_at?: string;
}

/**
 * A writer's report hook. Fired only for an answer that was actually recorded,
 * and **synchronous on purpose**: `CheckpointStore.decide` is synchronous, and a
 * fire-and-forget promise between "the answer is on disk" and "the wake-up is
 * queued" would be exactly the window in which a decision goes missing again.
 */
export type AnsweredSink = (decision: AnsweredDecision) => void;

/**
 * Normalise a writer's report into the schema's own bounds. The prose cells are
 * clipped (they are a headline, not a record — the record is the awaiting item
 * or the checkpoint file), while a missing `answer` or `answered_by` is a bug in
 * the caller and fails loudly rather than producing an unreadable notice.
 */
export function answeredDecision(input: AnsweredInput): AnsweredDecision {
	const answer = input.answer.trim();
	const by = input.answered_by.trim();
	if (answer.length === 0) throw new AnsweredError(`${input.id}: an answered decision must carry the answer`);
	if (by.length === 0) throw new AnsweredError(`${input.id}: an answered decision must say who answered`);
	const decision = input.decision.trim();
	return {
		schema_version: SCHEMA_VERSION,
		id: input.id,
		type: input.type,
		...(input.job_id ? { job_id: input.job_id } : {}),
		decision: (decision.length > 0 ? decision : input.id).slice(0, AWAITING_DECISION_MAX_CHARS),
		answer: answer.slice(0, AWAITING_ANSWER_MAX_CHARS),
		answered_by: by.slice(0, 120),
		answered_at: input.answered_at ?? isoTimestamp(),
	};
}

/** What the queue looks like right now — depth and lag, so both are facts. */
export interface AnsweredQueueStats {
	/** Answers no parent has been observed to receive yet. */
	pending: number;
	/**
	 * Of those, how many are emitted and still inside their retry window, i.e.
	 * waiting on evidence of arrival. An emitted answer whose window has expired
	 * is due again, not in flight, and is not counted here.
	 */
	in_flight: number;
	/** Emissions made for still-pending answers. More than `in_flight` means retries. */
	attempts: number;
	/** Age of the oldest pending answer, in seconds; `null` when empty. */
	oldest_pending_age_seconds: number | null;
}

export class AnsweredOutbox {
	readonly home: string;
	readonly file: string;
	readonly #now: () => Date;
	readonly #retryMs: number;
	/** This process's emission owner (pi-command-post-u9q). Injected in tests. */
	readonly #owner: string;

	constructor(options: { home: string; now?: () => Date; retrySeconds?: number; owner?: string }) {
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.answeredFile);
		this.#now = options.now ?? (() => new Date());
		this.#retryMs = (options.retrySeconds ?? ANSWERED_DELIVERY_RETRY_SECONDS) * 1000;
		this.#owner = options.owner ?? PROCESS_OWNER;
	}

	/**
	 * Is this emission still a live reservation *for this process*
	 * (pi-command-post-u9q)? Two questions, both facts on disk:
	 *
	 *  - **whose** it is: a record another process wrote is a message queued into
	 *    a context this parent cannot be woken in, so it reserves nothing here;
	 *  - **when** it was made: an emission of this process's own, inside its retry
	 *    window, is genuinely in flight and is left alone.
	 *
	 * Absent, unowned or unparseable all read as "not reserved", which sends the
	 * answer — under-delivery is the failure this module exists to prevent.
	 */
	#reserved(entry: AnsweredSend | undefined, now: number): boolean {
		if (!entry) return false;
		if (entry.owner !== this.#owner) return false;
		const at = Date.parse(entry.sent_at);
		return Number.isFinite(at) && now - at < this.#retryMs;
	}

	read(): AnsweredOutboxFile {
		if (!existsSync(this.file)) return EMPTY_ANSWERED_OUTBOX;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new AnsweredError(`${this.file} is not valid JSON (${(error as Error).message})`);
		}
		const result = validateAnsweredOutboxFile(parsed);
		if (!result.ok) {
			throw new AnsweredError(`${this.file} violates the answered contract:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	/** Answers nobody has been woken by yet, oldest first. */
	pending(): AnsweredDecision[] {
		return this.read().pending;
	}

	/** Has this id already woken somebody? Facts only, from the file. */
	delivered(id: string): boolean {
		return this.read().delivered.some((entry) => entry.id === id);
	}

	/**
	 * What has already been emitted for a still-pending answer (cp-5mgg). On
	 * disk, so it survives the crash and the restart that used to re-emit.
	 */
	sends(): AnsweredSend[] {
		return this.read().sends ?? [];
	}

	/**
	 * Read-modify-write, **synchronously**. Every other store in `src/` runs its
	 * mutation through pi's per-path queue, which needs an `await`; this one must
	 * not, and does not need to:
	 *
	 *  - the whole point is that queueing a wake-up happens in the same tick as
	 *    the answer that caused it, with no window for a lost decision;
	 *  - with no `await` inside, a read-modify-write is already atomic against
	 *    everything else in this single-threaded process, so an `enqueue` and a
	 *    `markDelivered` can never interleave;
	 *  - the file is written by this module alone, and `state/` is a path the
	 *    parent's own guard forbids editing by hand.
	 */
	#mutate(mutator: (file: AnsweredOutboxFile) => AnsweredOutboxFile): AnsweredOutboxFile {
		const next = mutator(structuredClone(this.read()));
		const stamped: AnsweredOutboxFile = { ...next, updated_at: isoTimestamp(this.#now()) };
		const result = validateAnsweredOutboxFile(stamped);
		if (!result.ok) {
			throw new AnsweredError(`refusing to write an invalid answered.json:\n  ${result.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file, result.value);
		return result.value;
	}

	/**
	 * Queue one answer for delivery. Returns whether it was queued: an id that
	 * is already pending, or already delivered, is a no-op — one decision, one
	 * wake-up.
	 */
	enqueue(input: AnsweredInput): boolean {
		const decision = answeredDecision(input);
		let queuedIt = false;
		this.#mutate((file) => {
			if (file.pending.some((entry) => entry.id === decision.id)) return file;
			if (file.delivered.some((entry) => entry.id === decision.id)) return file;
			queuedIt = true;
			return { ...file, pending: [...file.pending, decision] };
		});
		return queuedIt;
	}

	/**
	 * Record that these ids woke somebody. Called **after** a successful send,
	 * never before: an unrecorded delivery is a repeated notice (annoying), a
	 * prematurely recorded one is a lost decision (the bug this fixes).
	 */
	markDelivered(ids: readonly string[], options: { at?: string } = {}): AnsweredOutboxFile {
		if (ids.length === 0) return this.read();
		const at = options.at ?? isoTimestamp(this.#now());
		const marked = new Set(ids);
		return this.#mutate((file) => {
			const fresh: AnsweredDelivery[] = file.pending
				.filter((entry) => marked.has(entry.id))
				.map((entry) => ({ id: entry.id, delivered_at: at }));
			const kept = file.delivered.filter((entry) => !marked.has(entry.id));
			const delivered = [...kept, ...fresh];
			return {
				...file,
				pending: file.pending.filter((entry) => !marked.has(entry.id)),
				// An answer that has arrived can never be due again, so its emission
				// record has nothing left to say: `sends` is bookkeeping for the
				// pending queue only, and it never outlives the entry it describes.
				sends: (file.sends ?? []).filter((entry) => !marked.has(entry.id)),
				delivered: delivered.slice(Math.max(0, delivered.length - ANSWERED_KEEP_DELIVERED)),
			};
		});
	}

	/**
	 * Record that these ids are **about to be** emitted — the durable half of
	 * cp-5mgg, and the reason the write happens before the send rather than
	 * after it. A crash in the window between this and the transport leaves a
	 * record of one emission and a still-pending answer, which re-delivers at
	 * most once (on the retry window) and never silently drops.
	 */
	#recordSend(ids: readonly string[]): void {
		if (ids.length === 0) return;
		const at = isoTimestamp(this.#now());
		this.#mutate((file) => {
			const sends = [...(file.sends ?? [])];
			for (const id of ids) {
				const index = sends.findIndex((entry) => entry.id === id);
				const attempts = index >= 0 ? (sends[index]?.attempts ?? 0) + 1 : 1;
				// The owner is re-stamped on every emission: this parent has just made
				// one, so the reservation is now its own (pi-command-post-u9q).
				const entry: AnsweredSend = { id, sent_at: at, attempts, owner: this.#owner };
				if (index >= 0) sends[index] = entry;
				else sends.push(entry);
			}
			return { ...file, sends };
		});
	}

	/**
	 * Undo the emission records this drain wrote, and **only** those. Called when
	 * `send` threw, which is *observed* non-delivery: nothing reached the
	 * transport, so the answer is due again immediately rather than after a retry
	 * window it never earned. A crash (no throw, no rollback) keeps the record,
	 * which is the whole point of writing it first.
	 *
	 * Per id, never a whole-array restore: `send` is arbitrary caller code and
	 * may itself record an emission (the extension's own drain is re-entrant
	 * through `onAnswered`), and rolling back to a snapshot of the whole array
	 * would erase a record this drain never made. Each id goes back to exactly
	 * what it was — the entry it had, or nothing at all.
	 */
	#forgetSends(previous: ReadonlyMap<string, AnsweredSend | undefined>): void {
		if (previous.size === 0) return;
		this.#mutate((file) => {
			const sends = (file.sends ?? []).filter((entry) => !previous.has(entry.id));
			for (const entry of previous.values()) if (entry) sends.push({ ...entry });
			return { ...file, sends };
		});
	}

	/**
	 * Record that a wake-up carrying these ids was **observed reaching the
	 * parent**. This is the only path that stamps `delivered_at`, and the ids it
	 * is given are the ids the observer read off the message itself. Returns the
	 * ids that were still pending (an id confirmed twice is a no-op).
	 */
	confirmDelivered(ids: readonly string[], options: { at?: string } = {}): string[] {
		const pendingIds = new Set(this.pending().map((decision) => decision.id));
		const fresh = ids.filter((id) => pendingIds.has(id));
		if (fresh.length === 0) return [];
		this.markDelivered(fresh, options);
		return fresh;
	}

	/** Queue depth and the age of its oldest entry: lag as a fact, not a guess. */
	stats(): AnsweredQueueStats {
		const file = this.read();
		const pending = file.pending;
		const sends = new Map((file.sends ?? []).map((entry) => [entry.id, entry]));
		const now = this.#now().getTime();
		const oldest = pending.reduce<number | null>((accumulator, decision) => {
			const at = Date.parse(decision.answered_at);
			if (Number.isNaN(at)) return accumulator;
			return accumulator === null || at < accumulator ? at : accumulator;
		}, null);
		return {
			pending: pending.length,
			// Unparseable is due (`drain` agrees), and due is not in flight — and so
			// is a dead session's reservation, which is why the count is a fact about
			// *this* parent's own emissions rather than about the file's history.
			in_flight: pending.filter((decision) => this.#reserved(sends.get(decision.id), now)).length,
			attempts: pending.reduce((total, decision) => total + (sends.get(decision.id)?.attempts ?? 0), 0),
			oldest_pending_age_seconds: oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000)),
		};
	}

	/**
	 * Send every **due** answer through `send`, coalesced into one call — never
	 * one call per answer, and (cp-5mgg) never an answer that is not due.
	 * Nothing is marked delivered here: a send is a hand-off to a transport that
	 * queues, and the evidence of arrival arrives later through
	 * `confirmDelivered`.
	 *
	 * Due is a fact on disk, not a fact in memory: an answer is due when nothing
	 * has been emitted for it, when its last emission was made by **another**
	 * process (pi-command-post-u9q — a dead parent's reservation is not this
	 * one's, so a restart replays at once instead of after the window), or when
	 * its last emission is older than
	 * `ANSWERED_DELIVERY_RETRY_SECONDS`. Before cp-5mgg the whole pending queue
	 * went out whenever *any* single answer was due, so two answers seconds apart
	 * meant the first was emitted twice inside its own retry window — a duplicate
	 * the parent then acted on. The window exists precisely to say "leave this
	 * one alone"; ignoring it for the sake of coalescing was the bug.
	 *
	 * The emission is recorded **before** `send` is called, so a crash in between
	 * costs at most one repeat instead of an unbounded replay. A `send` that
	 * throws is observed non-delivery: the record is rolled back, the queue is
	 * untouched, and the answer is due again on the next drain (the next answer,
	 * the next widget tick, the next session start).
	 */
	drain(send: (decisions: readonly AnsweredDecision[]) => void): AnsweredDecision[] {
		const file = this.read();
		if (file.pending.length === 0) return [];
		const now = this.#now().getTime();
		const sends = new Map((file.sends ?? []).map((entry) => [entry.id, entry]));
		const due = file.pending.filter((decision) => !this.#reserved(sends.get(decision.id), now));
		if (due.length === 0) return [];
		const dueIds = due.map((decision) => decision.id);
		// What these ids looked like before this drain touched them — the unit of
		// rollback is the id, not the array (see `#forgetSends`).
		const before = new Map<string, AnsweredSend | undefined>(
			dueIds.map((id) => {
				const entry = sends.get(id);
				return [id, entry ? { ...entry } : undefined];
			}),
		);
		this.#recordSend(dueIds);
		try {
			send(due);
		} catch (error) {
			this.#forgetSends(before);
			throw error;
		}
		return [...due];
	}
}

/**
 * The ids a `cp-answered` message carries, read off the message itself
 * (cp-nx7). This is the arrival evidence: the extension hands whatever pi put
 * in the parent's context to this function, and a non-empty result is proof
 * that *those* answers reached the parent — not that a send was accepted.
 *
 * Deliberately forgiving about shape and strict about type: any message whose
 * `customType` is not `cp-answered` yields nothing at all, while a payload that
 * lost its `details` on the way through a transport still yields its ids from
 * the notice text, which names every id by construction.
 *
 * cp-5mgg: that fallback has to be able to name **every** id the notice can
 * carry, including a scoped checkpoint row (`aw-checkpoint-<job-id>.diff`,
 * `aw-checkpoint-<job-id>.merge-<head>`). It could not: the pattern stopped at
 * the `.`, so a merge authorization was read as its unscoped prefix, matched
 * nothing pending, was never confirmed — and was therefore re-emitted every
 * retry window for as long as the session lived. An arrival observer that
 * cannot recognise an id is an outbox that never stops repeating it.
 */
export function answeredIdsFromMessage(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const record = message as { customType?: unknown; details?: unknown; content?: unknown };
	if (record.customType !== ANSWERED_MESSAGE_TYPE) return [];
	const ids = new Set<string>();
	const details = record.details as { answered?: unknown } | undefined;
	const answered = details?.answered;
	if (Array.isArray(answered)) {
		for (const entry of answered) {
			if (typeof entry === "string" && entry.length > 0) ids.add(entry);
			else if (entry && typeof entry === "object") {
				const id = (entry as { id?: unknown }).id;
				if (typeof id === "string" && id.length > 0) ids.add(id);
			}
		}
	}
	if (ids.size === 0) {
		for (const match of noticeText(record.content).match(AWAITING_ID_IN_TEXT) ?? []) {
			// A trailing separator belongs to the sentence, never to the id: no id
			// this fleet mints ends in one, and `…merge-f7b8769.` in prose must read
			// as the id followed by a full stop.
			const id = match.replace(/[.\-_]+$/, "");
			if (id.length > 3) ids.add(id);
		}
	}
	return [...ids];
}

/**
 * An Awaiting-you id as it appears inside prose. `.` is in the class because a
 * scoped checkpoint id contains one (`aw-checkpoint-cp-x.merge-<head>`) — the
 * one character whose absence made a merge authorization unconfirmable, and so
 * repeatable, for a whole session (cp-5mgg). `es-` is an escalation answer's
 * own wake id, confirmable the same way.
 */
const AWAITING_ID_IN_TEXT = /\b(?:aw|es)-[A-Za-z0-9_.-]+/g;

/** A custom message's content is a string here, an array of parts elsewhere. */
function noticeText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
		.join("\n");
}

/** `by: mandate:<id>` is a mandate's auto-decision, never a human's answer. */
function mandateIdOf(answeredBy: string): string | undefined {
	const prefix = "mandate:";
	return answeredBy.startsWith(prefix) ? answeredBy.slice(prefix.length).trim() || undefined : undefined;
}

/**
 * The parent-facing notice: a headline plus one line per answer, carrying the
 * id, the type, the job it concerns and the answer itself, so the parent can
 * act without re-reading anything. It states what to do next, because the
 * failure this fixes was not "the parent did not know" — it was "the parent was
 * never asked to do anything".
 */
export function formatAnsweredNotice(decisions: readonly AnsweredDecision[], projectOf?: ProjectOf): string {
	if (decisions.length === 0) return "";
	const count = decisions.length;
	const mandateIds = [...new Set(decisions.map((decision) => mandateIdOf(decision.answered_by)).filter((id): id is string => id !== undefined))];
	const answeredBy =
		mandateIds.length > 0 && decisions.every((decision) => mandateIdOf(decision.answered_by) !== undefined)
			? `decided under mandate ${mandateIds.join(", ")}`
			: mandateIds.length === 0
				? `a human answered ${count} open decision${count === 1 ? "" : "s"}`
				: `${count} open decisions answered`;
	const lines = [`${count === 1 ? "DECISION ANSWERED" : "DECISIONS ANSWERED"} — ${answeredBy}`];
	const rows = projectGroupedLines(
		decisions,
		projectOf && ((decision) => (decision.job_id ? projectOf(decision.job_id) : undefined)),
		(decision) => {
			const job = decision.job_id ? `${decision.job_id}: ` : "";
			return (
				`  ${decision.id} [${decision.type}] ${job}${decision.decision} → "${decision.answer}" ` +
				`(${decision.answered_by} at ${decision.answered_at})`
			);
		},
	);
	lines.push(...rows);
	const authorized = decisions.filter((decision) => decision.type === "authorization");
	if (authorized.length > 0) {
		lines.push(
			`An authorization is a human's permission to act: ${authorized
				.map((decision) => decision.job_id ?? decision.id)
				.join(", ")} \u2014 approved means dispatch it, declined means stop and say so.`,
		);
	}
	lines.push(
		"Act on it now, and check the fleet before you do: this wake-up carries the time the answer was given, and a " +
			"late one may describe something you have already acted on.",
	);
	return lines.join("\n");
}
