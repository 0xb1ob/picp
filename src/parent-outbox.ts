/**
 * Parent send outbox — the durable record of every operator→parent send, so
 * none ends at "queued and not replayed".
 *
 * Written only by the bridge process (`src/cp-bridge.ts`), beside the parent
 * session file. Every send is on disk before its RPC write; its body carries a
 * marker line, so landing is proven from the parent's own user messages (live
 * stream, or `get_entries` after a relaunch) and a body is put in the parent's
 * context exactly once by id. A send that cannot be proven or delivered ends
 * `undeliverable` and is relayed, never dropped. The design follows the idea of
 * Pier's outbox (proof of delivery, attempt ceiling, explicit undeliverable, a
 * batch as one follow-up); no Pier code.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import {
	type BridgeReceiptLevel,
	DelegationRuleSchema,
	type DelegationProvenance,
	IsoTimestampSchema,
	isoTimestamp,
	SCHEMA_VERSION,
	validate,
	type ValidationResult,
} from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";

export const PARENT_SEND_MAX_ATTEMPTS = 5;
export const PARENT_SEND_MAX_AGE_HOURS = 24;
export const PARENT_SEND_KEEP_OBSERVED = 200;
export const PARENT_SEND_REPLY_MAX = 16_000;
export const PARENT_SEND_TEXT_MAX = 32_000;
const TRUNCATED = "…[truncated]";
const ERROR_MAX = 2_000;

export const PARENT_SEND_STATES = ["queued", "injected", "landed", "settled", "failed", "undeliverable"] as const;
export type ParentSendState = (typeof PARENT_SEND_STATES)[number];
const TERMINAL: readonly ParentSendState[] = ["settled", "failed", "undeliverable"];

export const PARENT_SEND_ID_PATTERN = "^ps-[0-9]{14}-[0-9a-f]{8}$";

export const ParentSendDelegationSchema = Type.Object({
	delegated: Type.Optional(Type.Boolean()),
	delegation_rule: Type.Optional(Type.String({ description: "Nonblank after trimming; truncated to 200 characters with an ellipsis." })),
}, { additionalProperties: false });
export type ParentSendDelegation = Static<typeof ParentSendDelegationSchema>;
const DEFAULT_DELEGATION_RULE = "operator delegation";
const SEND_DELEGATION_RULE_MAX = 200;

function normalizeSendRule(rule = DEFAULT_DELEGATION_RULE): string {
	const trimmed = rule.trim();
	if (!trimmed) throw new ParentSendOutboxError("delegation_rule must not be blank");
	// Drop a high surrogate at the cut so the ellipsis cannot split a code point.
	return trimmed.length > SEND_DELEGATION_RULE_MAX ? `${trimmed.slice(0, SEND_DELEGATION_RULE_MAX - 1).replace(/[\uD800-\uDBFF]$/u, "")}…` : trimmed;
}

export const ParentSendEntrySchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		id: Type.String({ pattern: PARENT_SEND_ID_PATTERN }),
		text: Type.String({ minLength: 1, maxLength: PARENT_SEND_TEXT_MAX }),
		...ParentSendDelegationSchema.properties,
		delegation_rule: Type.Optional(DelegationRuleSchema),
		queued_at: IsoTimestampSchema,
		state: StringEnum([...PARENT_SEND_STATES]),
		attempts: Type.Integer({ minimum: 0 }),
		/** Transient-retry reservations this send id has spent (absent on older records: 0). Not an RPC injection count. */
		outer_retry_attempts: Type.Optional(Type.Integer({ minimum: 0 })),
		last_injected_at: Type.Optional(IsoTimestampSchema),
		owner: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
		landed_at: Type.Optional(IsoTimestampSchema),
		settled_at: Type.Optional(IsoTimestampSchema),
		reply: Type.Optional(Type.String({ maxLength: PARENT_SEND_REPLY_MAX + TRUNCATED.length })),
		error: Type.Optional(Type.String({ minLength: 1, maxLength: ERROR_MAX })),
		relayed_at: Type.Optional(IsoTimestampSchema),
		relay_owner: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
		owner_observed_at: Type.Optional(IsoTimestampSchema),
		/** The one "still pending after 10 min" notice was relayed (cp-6fyl B1). */
		pending_notice_at: Type.Optional(IsoTimestampSchema),
	},
	{ additionalProperties: false },
);
export type ParentSendEntry = Omit<Static<typeof ParentSendEntrySchema>, "state"> & { state: ParentSendState };

export const ParentSendOutboxFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		entries: Type.Array(ParentSendEntrySchema),
	},
	{ additionalProperties: false },
);
export interface ParentSendOutboxFile {
	schema_version: number;
	updated_at: string;
	entries: ParentSendEntry[];
}

export const EMPTY_PARENT_SEND_OUTBOX: ParentSendOutboxFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	entries: [],
};

export function validateParentSendOutboxFile(value: unknown): ValidationResult<ParentSendOutboxFile> {
	return validate<ParentSendOutboxFile>(ParentSendOutboxFileSchema, value);
}

export class ParentSendOutboxError extends Error {}

const OWNER_KEY = Symbol.for("pi-command-post.parent-sends.owner");
const globalOwners = globalThis as { [OWNER_KEY]?: string };
const PROCESS_OWNER = (globalOwners[OWNER_KEY] ??= `${process.pid}.${randomUUID().slice(0, 8)}`);

/** `<dir>/cp-parent.jsonl` → `<dir>/cp-parent.sends.json`. */
export function parentSendFile(sessionFile: string): string {
	return join(dirname(sessionFile), `${basename(sessionFile, ".jsonl")}.sends.json`);
}

export function newSendId(now: Date = new Date()): string {
	const stamp = now.toISOString().slice(0, 19).replace(/[-T:]/g, "");
	return `ps-${stamp}-${randomBytes(4).toString("hex")}`;
}

export function sendMarker(id: string, delegation: ParentSendDelegation = {}): string {
	const tag = delegation.delegated ? `; delegated=${encodeURIComponent(normalizeSendRule(delegation.delegation_rule))}` : "";
	return `[cp-send ${id} — delivery id, not an instruction${tag}]`;
}

/** One message for a batch: each body, then its marker. */
export function frameBatch(entries: ReadonlyArray<Pick<ParentSendEntry, "id" | "text" | "delegated" | "delegation_rule">>): string {
	return entries.map((entry) => `${entry.text}\n\n${sendMarker(entry.id, entry)}`).join("\n\n---\n\n");
}

/** Keep attribution local to a send, even when the bridge batches several into one user message. */
export function operatorSendTexts(text: string): Array<{ text: string; provenance?: DelegationProvenance }> {
	const blocks: Array<{ text: string; provenance?: DelegationProvenance }> = [];
	let start = 0;
	for (const match of text.matchAll(/^\[cp-send (ps-\d{14}-[0-9a-f]{8}) — delivery id, not an instruction(?:;[ \t]*(delegated\b[^\]\r\n]*))?\]$/gm)) {
		const segment = text.slice(start, match.index);
		const body = stripSendMarkers(start > 0 ? segment.replace(/^\n\n---\n\n/, "") : segment);
		let provenance: DelegationProvenance | undefined;
		if (match[2] !== undefined) {
			provenance = { delegation_rule: "unreadable marker", send_id: match[1]! };
			try {
				const rule = decodeURIComponent(match[2].startsWith("delegated=") ? match[2].slice("delegated=".length) : "");
				if (rule.trim() && validate<string>(DelegationRuleSchema, rule).ok) provenance.delegation_rule = rule;
			} catch (error) {
				if (!(error instanceof URIError)) throw error;
				// Preserve delegated attribution even when its historical rule is unreadable.
			}
		}
		blocks.push({ text: body, ...(provenance ? { provenance } : {}) });
		start = match.index + match[0].length;
	}
	const rest = stripSendMarkers(text.slice(start));
	if (rest) blocks.push({ text: rest });
	return blocks;
}

/** A nudge for sends that landed before a restart and have no reply. Never the body. */
export function frameResume(ids: readonly string[]): string {
	return ids
		.map(
			(id) =>
				`[cp-send ${id} — resume] The operator message ${id} reached you before the parent restarted and has no reply yet. ` +
				"Answer it now; if you already acted on it, say what you did.",
		)
		.join("\n\n");
}

/**
 * Operator text minus the bridge's own `[cp-send <id> ...]` lines (delivery
 * marker, resume nudge): a quote recorded into a decision or a grant never
 * carries them, and they are never operator words.
 */
export function stripSendMarkers(text: string): string {
	return text.replace(/\n*^\[cp-send ps-\d{14}-[0-9a-f]{8} [^\n]*$/gm, "").trim();
}

export function sendIdsInText(text: string): string[] {
	return [...new Set([...text.matchAll(/\[cp-send (ps-\d{14}-[0-9a-f]{8})\b/g)].map((match) => match[1] as string))];
}

/** Text blocks of a pi message, joined. */
export function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const typed = block as { type?: string; text?: string };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

interface TranscriptEntry {
	type?: string;
	message?: { role?: string; content?: unknown };
}

/** Ids carried by the parent's own user messages. Assistant and custom entries never count. */
export function sendIdsInTranscript(entries: readonly TranscriptEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		for (const id of sendIdsInText(messageText(entry.message))) ids.add(id);
	}
	return ids;
}

/** Ids whose `frameResume` line is already in the parent's own user messages: a successor never nudges them again (N5). */
export function resumedIdsInTranscript(entries: readonly TranscriptEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageText(entry.message);
		for (const id of sendIdsInText(text)) if (text.includes(frameResume([id]))) ids.add(id);
	}
	return ids;
}

/** A cp-bridge relay message in the main session carries `details.send_id`. */
export function sendIdOfMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as { customType?: unknown; details?: { send_id?: unknown } };
	if (record.customType !== "cp-bridge") return undefined;
	const id = record.details?.send_id;
	return typeof id === "string" && new RegExp(PARENT_SEND_ID_PATTERN).test(id) ? id : undefined;
}

export interface ParentSendReceipt {
	level: BridgeReceiptLevel | null;
	reached: BridgeReceiptLevel[];
	reply?: string;
	error?: string;
	send_id?: string;
	pending?: string;
}

export function receiptOf(entry: ParentSendEntry): ParentSendReceipt {
	const id = { send_id: entry.id };
	switch (entry.state) {
		case "queued":
			return { level: null, reached: [], ...id, pending: entry.id };
		case "injected":
		case "landed":
			return { level: "injected", reached: ["injected"], ...id, pending: entry.id };
		case "settled":
			return entry.owner_observed_at
				? { level: "owner_observed", reached: ["injected", "turn_settled", "owner_observed"], reply: entry.reply ?? "", ...id }
				: { level: "turn_settled", reached: ["injected", "turn_settled"], reply: entry.reply ?? "", ...id };
		case "failed":
			return { level: "turn_failed", reached: ["injected", "turn_settled", "turn_failed"], error: entry.error ?? "turn failed", ...id };
		case "undeliverable":
			return { level: null, reached: [], error: entry.error ?? "undeliverable", ...id };
	}
}

/** The main session's text for a send that ended without its sync waiter. */
export function sendRelayText(entry: ParentSendEntry, file: string): string {
	if (entry.state === "settled") return entry.reply ?? "";
	if (entry.state === "failed") return `send ${entry.id} turn failed: ${entry.error ?? "unknown error"}`;
	return `send ${entry.id} was not delivered (${entry.error ?? "undeliverable"}); its text is kept in ${file}. Resend only if it is still wanted.`;
}

/** The `send`-kind relay (a `BridgeRelay`) for one outcome. */
export function sendRelay(entry: ParentSendEntry, file: string) {
	return { kind: "send" as const, sendId: entry.id, stale: false, text: sendRelayText(entry, file), receipt: receiptOf(entry), paths: [] };
}

type SpanMark = { id: string; index: number; assistants: number; end?: number; endAssistants?: number };
type SpanTurn = { texts: readonly string[]; assistantCount: number; landed: ReadonlyArray<SpanMark>; answers: readonly number[] };

/**
 * Where a landed send's reply stops: the segment end it was settled at, else
 * the next landing, else the run so far (`last`: the run's error is its own).
 * A later landing ends this span only after a finished answer (clean
 * turn_end) fell between them; until then the sends share one answer.
 */
export function markSpan(turn: SpanTurn, mark: SpanMark): { end: number; endAssistants: number; last: boolean } {
	const next = turn.landed.find(
		(other) => other.assistants > mark.assistants && turn.answers.some((at) => at > mark.assistants && at <= other.assistants),
	);
	return {
		end: mark.end ?? next?.index ?? turn.texts.length,
		endAssistants: mark.endAssistants ?? next?.assistants ?? turn.assistantCount,
		last: next === undefined && mark.end === undefined,
	};
}

/** The reply of a send that shared its span with an earlier one: the text went out once, under that id. */
export function sharedReplyPointer(firstId: string): string {
	return `answered together with ${firstId} — see that reply`;
}

/**
 * Each landed send's reply is the assistant text from its landing to the end
 * of its span (`markSpan`). No assistant message in that span, or a last one
 * that errored, is a failed turn. Sends whose spans end at the same place were
 * answered by one text: the earliest landing keeps it, the others point at it
 * (`sharedReplyPointer`), so one answer is relayed once, not once per send.
 */
export function landedOutcomes(turn: SpanTurn & { error?: { message: string } }): Array<{ id: string; failed: boolean; reply: string; error: string }> {
	const firstBySpanEnd = new Map<string, string>();
	return turn.landed.map((mark) => {
		const span = markSpan(turn, mark);
		const modelError = span.last ? turn.error : undefined;
		const failed = span.endAssistants - mark.assistants === 0 || modelError !== undefined;
		const key = `${span.end}:${span.endAssistants}`;
		const first = failed ? undefined : firstBySpanEnd.get(key);
		if (!failed && first === undefined) firstBySpanEnd.set(key, mark.id);
		return {
			id: mark.id,
			failed,
			reply: failed ? "" : first !== undefined ? sharedReplyPointer(first) : turn.texts.slice(mark.index, span.end).join("\n"),
			error: failed ? (modelError?.message ?? "parent settled without an assistant message") : "",
		};
	});
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}${TRUNCATED}` : text;
}

export class ParentSendOutbox {
	readonly file: string;
	readonly #now: () => Date;
	readonly #owner: string;

	constructor(options: { file: string; now?: () => Date; owner?: string }) {
		this.file = options.file;
		this.#now = options.now ?? (() => new Date());
		this.#owner = options.owner ?? PROCESS_OWNER;
	}

	read(): ParentSendOutboxFile {
		if (!existsSync(this.file)) return EMPTY_PARENT_SEND_OUTBOX;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new ParentSendOutboxError(`${this.file} is not valid JSON (${(error as Error).message})`);
		}
		const result = validateParentSendOutboxFile(parsed);
		if (!result.ok) {
			throw new ParentSendOutboxError(`${this.file} violates the parent send contract:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	list(): ParentSendEntry[] {
		return this.read().entries;
	}

	get(id: string): ParentSendEntry | undefined {
		return this.list().find((entry) => entry.id === id);
	}

	/** Never reached the parent's context: `queued` or `injected`. */
	unlanded(): ParentSendEntry[] {
		return this.list().filter((entry) => entry.state === "queued" || entry.state === "injected");
	}

	/** For a notice only: an unreadable file counts as none. */
	countUnlanded(): number {
		try {
			return this.unlanded().length;
		} catch {
			return 0;
		}
	}

	/** `cp_parent status`: every send without an observed outcome, plus the last 10 observed. */
	statusRows(): {
		sends: Array<{ id: string; state: ParentSendState; level: BridgeReceiptLevel | null; queued_at: string }>;
		sendsError?: string;
	} {
		let entries: ParentSendEntry[];
		try {
			entries = this.list();
		} catch (error) {
			return { sends: [], sendsError: (error as Error).message };
		}
		const observed = entries.filter((entry) => entry.owner_observed_at).slice(-10);
		const rows = [...entries.filter((entry) => !entry.owner_observed_at), ...observed];
		return { sends: rows.map((entry) => ({ id: entry.id, state: entry.state, level: receiptOf(entry).level, queued_at: entry.queued_at })) };
	}

	#mutate(mutator: (entries: ParentSendEntry[]) => void): void {
		const entries = structuredClone(this.read().entries);
		mutator(entries);
		const observed = entries.filter((entry) => entry.owner_observed_at);
		const drop = new Set(observed.slice(0, Math.max(0, observed.length - PARENT_SEND_KEEP_OBSERVED)));
		const next = {
			schema_version: SCHEMA_VERSION,
			updated_at: isoTimestamp(this.#now()),
			entries: entries.filter((entry) => !drop.has(entry)),
		};
		const result = validateParentSendOutboxFile(next);
		if (!result.ok) {
			throw new ParentSendOutboxError(`refusing to write an invalid ${this.file}:\n  ${result.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file, result.value);
	}

	/** Move `ids` that are in one of `from`; writes only when something moved. Returns the moved entries. */
	#update(ids: readonly string[], from: readonly ParentSendState[], patch: (entry: ParentSendEntry) => void): ParentSendEntry[] {
		const wanted = new Set(ids);
		if (!this.list().some((entry) => wanted.has(entry.id) && from.includes(entry.state))) return [];
		const moved: ParentSendEntry[] = [];
		this.#mutate((entries) => {
			for (const entry of entries) {
				if (!wanted.has(entry.id) || !from.includes(entry.state)) continue;
				patch(entry);
				moved.push(entry);
			}
		});
		return moved;
	}

	enqueue(text: string, delegation: ParentSendDelegation = {}): ParentSendEntry {
		const checked = validate<ParentSendDelegation>(ParentSendDelegationSchema, delegation);
		if (!checked.ok) throw new ParentSendOutboxError(`invalid send delegation: ${checked.errors.join("; ")}`);
		const rule = normalizeSendRule(delegation.delegation_rule);
		if (text.length === 0) throw new ParentSendOutboxError("a parent send needs text");
		if (text.length > PARENT_SEND_TEXT_MAX) {
			throw new ParentSendOutboxError(`a parent send is at most ${PARENT_SEND_TEXT_MAX} characters; got ${text.length}`);
		}
		const now = this.#now();
		const entry: ParentSendEntry = {
			schema_version: SCHEMA_VERSION,
			id: newSendId(now),
			text,
			...(delegation.delegated ? { delegated: true, delegation_rule: rule } : {}),
			queued_at: isoTimestamp(now),
			state: "queued",
			attempts: 0,
		};
		this.#mutate((entries) => {
			entries.push(entry);
		});
		return entry;
	}

	/** Reservation before the RPC write; `revertInjected` rolls it back if the write is refused. */
	markInjected(ids: readonly string[]): void {
		const at = isoTimestamp(this.#now());
		this.#update(ids, ["queued"], (entry) => {
			entry.state = "injected";
			entry.attempts += 1;
			entry.last_injected_at = at;
			entry.owner = this.#owner;
		});
	}

	revertInjected(ids: readonly string[]): void {
		this.#update(ids, ["injected"], (entry) => {
			entry.state = "queued";
			entry.attempts = Math.max(0, entry.attempts - 1);
		});
	}

	/** The body is in the parent's context. Returns every id now `landed` (already-landed ones included). */
	markLanded(ids: readonly string[]): string[] {
		const at = isoTimestamp(this.#now());
		this.#update(ids, ["queued", "injected"], (entry) => {
			entry.state = "landed";
			entry.landed_at = at;
		});
		const wanted = new Set(ids);
		return this.list()
			.filter((entry) => wanted.has(entry.id) && entry.state === "landed")
			.map((entry) => entry.id);
	}

	settle(id: string, outcome: { reply: string } | { error: string }): boolean {
		const at = isoTimestamp(this.#now());
		return (
			this.#update([id], ["landed"], (entry) => {
				entry.settled_at = at;
				if ("reply" in outcome) {
					entry.state = "settled";
					entry.reply = clip(outcome.reply, PARENT_SEND_REPLY_MAX);
				} else {
					entry.state = "failed";
					entry.error = clip(outcome.error || "turn failed", ERROR_MAX - TRUNCATED.length);
				}
			}).length > 0
		);
	}

	/**
	 * Spend one transient-retry reservation of a `landed` send below `limit`, on
	 * disk before any timer or nudge. Returns the new 1-based ordinal; undefined
	 * (nothing written) for an unknown, non-landed or exhausted send.
	 */
	reserveOuterRetry(id: string, limit: number): number | undefined {
		if (!Number.isInteger(limit) || limit < 1) throw new ParentSendOutboxError(`outer retry limit must be a positive integer; got ${limit}`);
		const entry = this.get(id);
		if (entry?.state !== "landed" || (entry.outer_retry_attempts ?? 0) >= limit) return undefined;
		const ordinal = (entry.outer_retry_attempts ?? 0) + 1;
		const moved = this.#update([id], ["landed"], (item) => {
			item.outer_retry_attempts = ordinal;
		});
		return moved.length > 0 ? ordinal : undefined;
	}

	markUndeliverable(ids: readonly string[], reason: string): ParentSendEntry[] {
		return this.#update(ids, ["queued", "injected", "landed"], (entry) => {
			entry.state = "undeliverable";
			entry.error = clip(reason || "undeliverable", ERROR_MAX - TRUNCATED.length);
		});
	}

	markRelayed(id: string): void {
		const at = isoTimestamp(this.#now());
		this.#update([id], TERMINAL, (entry) => {
			entry.relayed_at = at;
			entry.relay_owner = this.#owner;
		});
	}

	/** The owner saw the outcome. No-op when absent, not terminal, or already observed. */
	markObserved(id: string): boolean {
		const entry = this.get(id);
		if (!entry || entry.owner_observed_at || !TERMINAL.includes(entry.state)) return false;
		const at = isoTimestamp(this.#now());
		this.#update([id], TERMINAL, (item) => {
			item.owner_observed_at = at;
		});
		return true;
	}

	#stale(entry: ParentSendEntry, now: number): boolean {
		const at = Date.parse(entry.queued_at);
		return Number.isFinite(at) && now - at > PARENT_SEND_MAX_AGE_HOURS * 3_600_000;
	}

	/** Queued, under the attempt ceiling, not stale: what the next drain injects. */
	due(): ParentSendEntry[] {
		const now = this.#now().getTime();
		return this.list().filter(
			(entry) => entry.state === "queued" && entry.attempts < PARENT_SEND_MAX_ATTEMPTS && !this.#stale(entry, now),
		);
	}

	/** Queued sends past the attempt ceiling or the max age become undeliverable. */
	expireStale(): ParentSendEntry[] {
		const now = this.#now().getTime();
		const expired: ParentSendEntry[] = [];
		for (const entry of this.list()) {
			if (entry.state !== "queued") continue;
			const reason = this.#stale(entry, now)
				? `stale: queued ${entry.queued_at}`
				: entry.attempts >= PARENT_SEND_MAX_ATTEMPTS
					? `not delivered after ${entry.attempts} attempts`
					: undefined;
			if (reason) expired.push(...this.markUndeliverable([entry.id], reason));
		}
		return expired;
	}

	/**
	 * After a relaunch: an `injected` send whose marker is in the parent's own
	 * transcript landed; one that is absent is requeued, unless the transcript
	 * window cannot prove it (duplicate avoidance wins). Returns the entries
	 * that became undeliverable.
	 */
	reconcile(
		transcript: { entries: ReadonlyArray<TranscriptEntry & { timestamp?: unknown }>; dropped: number },
		/** Only these ids (the ones injected before the restart); default every `injected` one. */
		only?: ReadonlySet<string>,
	): ParentSendEntry[] {
		const seen = sendIdsInTranscript(transcript.entries);
		const injected = this.list().filter((entry) => entry.state === "injected" && (!only || only.has(entry.id)));
		this.markLanded(injected.filter((entry) => seen.has(entry.id)).map((entry) => entry.id));
		const oldest = transcript.entries[0]?.timestamp;
		const oldestAt = typeof oldest === "string" || typeof oldest === "number" ? new Date(oldest).getTime() : Number.NaN;
		const unprovable: string[] = [];
		const requeue: string[] = [];
		for (const entry of injected) {
			if (seen.has(entry.id)) continue;
			const at = Date.parse(entry.last_injected_at ?? entry.queued_at);
			if (transcript.dropped > 0 && !(Number.isFinite(oldestAt) && at >= oldestAt)) unprovable.push(entry.id);
			else requeue.push(entry.id);
		}
		this.#update(requeue, ["injected"], (entry) => {
			entry.state = "queued";
		});
		return [
			...this.markUndeliverable(unprovable, "landing unprovable: outside the 400-entry transcript window"),
			...this.expireStale(),
		];
	}

	/** Outcomes whose relay went to a different (dead) operator process and were never observed. */
	relaysDue(): ParentSendEntry[] {
		return this.list().filter(
			(entry) => TERMINAL.includes(entry.state) && !entry.owner_observed_at && entry.relay_owner !== this.#owner,
		);
	}

	/** Non-terminal sends queued more than `seconds` ago with no pending notice yet. */
	overdue(seconds: number, now: Date = this.#now()): ParentSendEntry[] {
		return this.list().filter((entry) => !TERMINAL.includes(entry.state) && !entry.pending_notice_at && now.getTime() - Date.parse(entry.queued_at) > seconds * 1_000);
	}

	/** Records the one pending notice; false (nothing written) when it is already recorded or the send is terminal. */
	markPendingNotice(id: string): boolean {
		if (this.get(id)?.pending_notice_at) return false;
		const at = isoTimestamp(this.#now());
		return this.#update([id], ["queued", "injected", "landed"], (entry) => {
			entry.pending_notice_at = at;
		}).length > 0;
	}

	/** `landed` sends whose landing is more than `hours` old: no reply is coming. */
	landedOlderThan(hours: number, now: Date = this.#now()): ParentSendEntry[] {
		return this.list().filter((entry) => entry.state === "landed" && now.getTime() - Date.parse(entry.landed_at ?? entry.queued_at) > hours * 3_600_000);
	}
}
