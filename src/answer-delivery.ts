/**
 * Answer card delivery (cp-6lg7) — the answer outlives the job that produced
 * it.
 *
 * ## The incident
 *
 * `cp-n9jh` was a `delivery:answer` job. It wrote a 4571-byte answer, filed its
 * envelope at 17:41:07, and the parent did exactly what the loop says: relayed
 * the headline and tore the job down seven seconds later. The operator saw
 * nothing at all, and the run log recorded the only trace:
 *
 *     wakeup_suppressed { kind: envelope, stage: delivery, delay_seconds: 7,
 *       reason: "cp-n9jh is already done: the delivery landed and the job was
 *       torn down" }
 *
 * `cp-5vl9` had lost its answer the same way an hour earlier. For a Q&A job the
 * answer *is* the deliverable, so this is not a missing notification — it is
 * silent, total loss of the job's output, and it fires **precisely when the
 * parent is prompt**. Only a slow parent escaped it.
 *
 * ## What was actually fragile
 *
 * The card was surfaced exactly once, synchronously, inside intake's
 * `onReported` — the same instant, and the same call stack, as the wake-up that
 * announces the envelope. Everything about that moment is hostile:
 *
 *  - the parent is mid-turn (the envelope arrives while it is streaming), which
 *    is the worst moment to append something to a transcript;
 *  - the job's phase moves to `done` seconds later, and every *other* surface
 *    keyed on that phase correctly treats the report as history — the wake-up
 *    is suppressed by `checkWakeup`, and it should be;
 *  - a single synchronous attempt has no second chance: if the surface is not
 *    there (no UI yet, a headless re-entry, a throw inside a renderer), the
 *    pointer is gone with the call stack.
 *
 * So the answer's only path to the operator was a best-effort side effect of a
 * message whose whole job is to describe a *phase*, at the one moment the phase
 * was about to invalidate it.
 *
 * ## The fix: an outbox, not a callback
 *
 * The card is **recorded on disk at intake** and delivered as a separate,
 * retried step — the shape `src/answered.ts` already proved for a human's
 * answer, for the same reason (a delivery that only exists in a call stack is a
 * delivery that can be lost):
 *
 *  - `enqueue` writes a pointer (job id, project, headline, path, bytes) into
 *    `state/answer-cards.json`. It is keyed by `<job-id>#<generation>` and
 *    refuses an id that is pending or already delivered, so one answer can
 *    never mint two cards.
 *  - `drain` is called by whoever is live — at intake, at `session_start`, and
 *    on the widget tick that already reads `state/`. Nothing new polls.
 *  - `markDelivered` runs **after** the surface accepted the card, and persists,
 *    which is what makes a restart not show yesterday's answers again.
 *
 * Nothing here reads the job's phase, so a teardown two seconds after the
 * envelope cannot drop the card — and, just as important, nothing here changes
 * what a wake-up is allowed to say. The envelope wake-up for a torn-down job
 * stays suppressed, because that message instructs the *parent* to act on a job
 * that is over. The card instructs nobody: it is the answer, for the human who
 * asked the question.
 *
 * ## Why delivery prefers an idle session
 *
 * `answerCardDue` holds a card back while the parent is mid-turn and releases
 * it at the next idle moment, because a card appended into a streaming turn is
 * spliced above the message being written and is the one the operator did not
 * see. The wait is bounded by `ANSWER_CARD_DEFER_SECONDS`: a session that never
 * goes idle gets the card anyway. Late is a nuisance; never is the bug.
 *
 * ## What never travels
 *
 * A record is a pointer and a headline. The body is read from the file by the
 * renderer, at render time, capped (`src/answer-card.ts`) — it is not in this
 * file, not in the session file, not in a message, and not in the parent's
 * context. Nothing in this module reads the artifact.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ANSWER_CARD_DEFER_SECONDS,
	ANSWER_CARD_KEEP_DELIVERED,
	type AnswerCardChannel,
	type AnswerCardDelivery,
	type AnswerCardOutboxFile,
	type AnswerCardRecord,
	EMPTY_ANSWER_CARD_OUTBOX,
	isoTimestamp,
	LAYOUT,
	SCHEMA_VERSION,
	SUMMARY_MAX_CHARS,
	validateAnswerCardOutboxFile,
} from "./contracts.ts";
import { atomicWriteJson, canonicalDir } from "./json-store.ts";

export class AnswerCardError extends Error {}

/** What intake hands over once a `delivery:answer` envelope is accepted. */
export interface AnswerCardInput {
	job_id: string;
	project?: string;
	generation: number;
	/** The envelope headline. Never a body. */
	summary: string;
	/** Absolute path of the stored answer. */
	path: string;
	bytes: number;
	reported_at: string;
	queued_at?: string;
}

/** One answer, one card, forever: the dedupe key both halves agree on. */
export function answerCardId(jobId: string, generation: number): string {
	return `${jobId}#${generation}`;
}

/**
 * Normalise a caller's report into the schema's own bounds. The headline is
 * clipped (it is a headline, not a record), while a missing path or an
 * unusable generation is a bug in the caller and fails loudly rather than
 * writing a card nothing can render.
 */
export function answerCardRecord(input: AnswerCardInput): AnswerCardRecord {
	const path = input.path.trim();
	if (path.length === 0) throw new AnswerCardError(`${input.job_id}: an answer card must name the artifact path`);
	if (!Number.isInteger(input.generation) || input.generation < 1) {
		throw new AnswerCardError(`${input.job_id}: an answer card must carry a positive envelope generation`);
	}
	return {
		schema_version: SCHEMA_VERSION,
		id: answerCardId(input.job_id, input.generation),
		job_id: input.job_id,
		...(input.project ? { project: input.project.slice(0, 120) } : {}),
		generation: input.generation,
		summary: input.summary.slice(0, SUMMARY_MAX_CHARS),
		path,
		bytes: Math.max(0, Math.trunc(input.bytes)),
		reported_at: input.reported_at,
		queued_at: input.queued_at ?? isoTimestamp(),
	};
}

/** The facts `answerCardDue` decides on. Nothing about the job's phase. */
export interface AnswerCardDueOptions {
	/**
	 * Is the parent session between turns? A card appended mid-stream is the one
	 * the operator did not see, so an idle session is preferred — but never
	 * required forever (see `deferSeconds`).
	 */
	idle: boolean;
	now?: Date;
	deferSeconds?: number;
}

/**
 * Pure policy: may this card be surfaced right now?
 *
 * Idle wins immediately. Otherwise the card waits, and the wait is bounded: a
 * parent that streams for longer than `ANSWER_CARD_DEFER_SECONDS` gets the card
 * anyway, because a deferred card and a lost card must never converge.
 */
export function answerCardDue(record: AnswerCardRecord, options: AnswerCardDueOptions): boolean {
	if (options.idle) return true;
	const now = (options.now ?? new Date()).getTime();
	const queued = Date.parse(record.queued_at);
	const defer = (options.deferSeconds ?? ANSWER_CARD_DEFER_SECONDS) * 1000;
	// An unparseable timestamp is due: a card whose clock cannot be read must
	// still reach somebody.
	if (!Number.isFinite(queued)) return true;
	return now - queued >= defer;
}

/**
 * How a drain delivered one card, or `undefined` for "there is no surface for
 * this right now". `undefined` leaves the card pending, which is the whole
 * point: a headless re-entry into this home must not consume the answer the
 * operator's terminal is going to show.
 */
export type AnswerCardSink = (record: AnswerCardRecord) => AnswerCardChannel | undefined;

/** Queue depth and lag, so "nobody has seen this answer yet" is a fact. */
export interface AnswerCardQueueStats {
	pending: number;
	delivered: number;
	/** Age of the oldest pending card, in seconds; `null` when empty. */
	oldest_pending_age_seconds: number | null;
}

export class AnswerCardOutbox {
	readonly home: string;
	readonly file: string;
	readonly #now: () => Date;
	readonly #deferSeconds: number;

	constructor(options: { home: string; now?: () => Date; deferSeconds?: number }) {
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.answerCardsFile);
		this.#now = options.now ?? (() => new Date());
		this.#deferSeconds = options.deferSeconds ?? ANSWER_CARD_DEFER_SECONDS;
	}

	read(): AnswerCardOutboxFile {
		if (!existsSync(this.file)) return EMPTY_ANSWER_CARD_OUTBOX;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new AnswerCardError(`${this.file} is not valid JSON (${(error as Error).message})`);
		}
		const result = validateAnswerCardOutboxFile(parsed);
		if (!result.ok) {
			throw new AnswerCardError(`${this.file} violates the answer card contract:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	/** Cards nobody has been shown yet, oldest first. */
	pending(): AnswerCardRecord[] {
		return this.read().pending;
	}

	/** Has this card already reached the operator? Facts only, from the file. */
	delivered(id: string): boolean {
		return this.read().delivered.some((entry) => entry.id === id);
	}

	/**
	 * Read-modify-write, synchronously and for the same reasons `AnsweredOutbox`
	 * documents: the card is queued in the same tick as the envelope that earned
	 * it, a read-modify-write with no `await` inside is already atomic in this
	 * single-threaded process, and one parent per home holds this file
	 * (`state/parent.lock`).
	 */
	#mutate(mutator: (file: AnswerCardOutboxFile) => AnswerCardOutboxFile): AnswerCardOutboxFile {
		const next = mutator(structuredClone(this.read()));
		const stamped: AnswerCardOutboxFile = { ...next, updated_at: isoTimestamp(this.#now()) };
		const result = validateAnswerCardOutboxFile(stamped);
		if (!result.ok) {
			throw new AnswerCardError(`refusing to write an invalid answer-cards.json:\n  ${result.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file, result.value);
		return result.value;
	}

	/**
	 * Queue one card. Returns whether it was queued: an id already pending, or
	 * already delivered, is a no-op — one answer, one card, and a card that has
	 * been shown is never resurrected.
	 */
	enqueue(input: AnswerCardInput): boolean {
		const record = answerCardRecord({ ...input, queued_at: input.queued_at ?? isoTimestamp(this.#now()) });
		let queuedIt = false;
		this.#mutate((file) => {
			if (file.pending.some((entry) => entry.id === record.id)) return file;
			if (file.delivered.some((entry) => entry.id === record.id)) return file;
			queuedIt = true;
			return { ...file, pending: [...file.pending, record] };
		});
		return queuedIt;
	}

	/**
	 * Record that these cards reached the operator. Called **after** the surface
	 * accepted them, never before: an unrecorded delivery costs a repeated card
	 * (visible, harmless), a prematurely recorded one costs the answer.
	 */
	markDelivered(ids: readonly string[], options: { at?: string; channel?: AnswerCardChannel } = {}): AnswerCardOutboxFile {
		if (ids.length === 0) return this.read();
		const at = options.at ?? isoTimestamp(this.#now());
		const channel = options.channel ?? "card";
		const marked = new Set(ids);
		return this.#mutate((file) => {
			const fresh: AnswerCardDelivery[] = file.pending
				.filter((entry) => marked.has(entry.id))
				.map((entry) => ({ id: entry.id, job_id: entry.job_id, delivered_at: at, channel }));
			const kept = file.delivered.filter((entry) => !marked.has(entry.id));
			const delivered = [...kept, ...fresh];
			return {
				...file,
				pending: file.pending.filter((entry) => !marked.has(entry.id)),
				delivered: delivered.slice(Math.max(0, delivered.length - ANSWER_CARD_KEEP_DELIVERED)),
			};
		});
	}

	/** The pending cards that may be surfaced right now, oldest first. */
	due(options: AnswerCardDueOptions): AnswerCardRecord[] {
		const now = options.now ?? this.#now();
		return this.pending().filter((record) =>
			answerCardDue(record, { idle: options.idle, now, deferSeconds: options.deferSeconds ?? this.#deferSeconds }),
		);
	}

	/**
	 * Show every due card through `sink`, one call per card, and record the ones
	 * it accepted. A sink that returns `undefined` (no operator surface in this
	 * mode) and a sink that throws both leave the card pending for the next
	 * drain — the next tick, the next session, the next parent.
	 *
	 * A throw propagates after the cards already accepted are recorded, so one
	 * broken render can never un-deliver a card that was shown before it.
	 */
	drain(sink: AnswerCardSink, options: AnswerCardDueOptions): AnswerCardRecord[] {
		const due = this.due(options);
		if (due.length === 0) return [];
		const shown: AnswerCardRecord[] = [];
		const byChannel = new Map<AnswerCardChannel, string[]>();
		const record = (): void => {
			for (const [channel, ids] of byChannel) this.markDelivered(ids, { channel });
			byChannel.clear();
		};
		try {
			for (const card of due) {
				const channel = sink(card);
				if (!channel) continue;
				shown.push(card);
				byChannel.set(channel, [...(byChannel.get(channel) ?? []), card.id]);
			}
		} catch (error) {
			record();
			throw error;
		}
		record();
		return shown;
	}

	stats(): AnswerCardQueueStats {
		const file = this.read();
		const now = this.#now().getTime();
		const oldest = file.pending.reduce<number | null>((accumulator, card) => {
			const at = Date.parse(card.queued_at);
			if (Number.isNaN(at)) return accumulator;
			return accumulator === null || at < accumulator ? at : accumulator;
		}, null);
		return {
			pending: file.pending.length,
			delivered: file.delivered.length,
			oldest_pending_age_seconds: oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000)),
		};
	}
}
