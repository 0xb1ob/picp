/**
 * The gateway's records under `state/channels/` (0700): `journal.jsonl` (request, refused, routed, delivery; never
 * message text) and `outbox.json`, the Slack write ledger in the push ledger's shape (src/push/deliveries.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, validate } from "../contracts.ts";
import { atomicWriteJson, durableAppend, queued } from "../json-store.ts";

export const channelsStateDir = (stateDir: string): string => join(stateDir, "channels");
export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_SETTLED_KEEP = 200;

export type JournalLine =
	| { type: "request"; dc_id: string; at: string; team: string; channel: string; thread_ts: string; user: string; kind: "message" | "answer"; chars: number; parent?: string; ask_id?: string }
	| { type: "refused"; at: string; reason: string; via: "event" | "action"; team?: string; user?: string; channel?: string }
	| { type: "routed"; at: string; kind: "answer" | "message" | "which"; dc_id?: string; ask_id?: string }
	| { type: "delivery"; at: string; key: string; state: "failed"; error: string };
export type RequestLine = Extract<JournalLine, { type: "request" }>;

const Str = Type.String({ minLength: 1, maxLength: 200 });
const ItemSchema = Type.Object({
	key: Str,
	kind: Type.Union([Type.Literal("status"), Type.Literal("card"), Type.Literal("notice"), Type.Literal("reply"), Type.Literal("which"), Type.Literal("too_long")]),
	dc_id: Type.Union([Str, Type.Null()]),
	ask_id: Type.Optional(Str),
	ask_ids: Type.Optional(Type.Array(Str, { maxItems: 10 })),
	channel: Str,
	thread_ts: Str,
	/** The Slack message's own ts once posted: later writes are edits of it. */
	ts: Type.Optional(Str),
	state: Type.Union([Type.Literal("pending"), Type.Literal("posted"), Type.Literal("failed")]),
	/** The wanted version and the last one Slack took; a write is due while `done_rev < rev`. */
	rev: Type.Integer({ minimum: 1 }),
	done_rev: Type.Integer({ minimum: 0 }),
	attempts: Type.Integer({ minimum: 0 }),
	next_attempt_at: Type.Optional(IsoTimestampSchema),
	last_error: Type.Optional(Type.String({ maxLength: 300 })),
	/** A reply or link-only notice, already `safeText`ed when queued. */
	text: Type.Optional(Type.String({ maxLength: 16_000 })),
	receipt: Type.Optional(Type.Object({
		state: Type.Union([Type.Literal("queued"), Type.Literal("behind"), Type.Literal("delivered"), Type.Literal("held"), Type.Literal("dropped"), Type.Literal("refused")]),
		reason: Type.Optional(Type.String({ maxLength: 300 })),
	}, { additionalProperties: false })),
	mirror: Type.Optional(Type.Union([Type.Literal("answered"), Type.Literal("withdrawn")])),
	created_at: IsoTimestampSchema,
	settled_at: Type.Optional(IsoTimestampSchema),
}, { additionalProperties: false });
export type OutboxItem = Static<typeof ItemSchema>;
const OutboxSchema = Type.Object({
	schema_version: Type.Literal(1),
	baseline_at: IsoTimestampSchema,
	/** Byte offset into state/operator/turn-bindings.jsonl already turned into items. */
	bindings_offset: Type.Integer({ minimum: 0 }),
	items: Type.Array(ItemSchema),
}, { additionalProperties: false });
export type Outbox = Static<typeof OutboxSchema>;

/** An item still owed a write, or one whose status, card or mirror may change later. */
const live = (item: OutboxItem): boolean => item.state === "pending" || (item.state === "posted" && ((item.kind === "status" && !["delivered", "dropped", "refused"].includes(item.receipt?.state ?? "")) || (item.kind === "card" && !item.mirror)));

export class ChannelStore {
	readonly dir: string;
	readonly journalFile: string;
	readonly outboxFile: string;
	constructor(stateDir: string) {
		this.dir = channelsStateDir(stateDir);
		this.journalFile = join(this.dir, "journal.jsonl");
		this.outboxFile = join(this.dir, "outbox.json");
	}

	journal(line: JournalLine): void {
		durableAppend(this.journalFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
	}

	/** Every complete journal line, oldest first; a torn or malformed line is skipped. */
	readJournal(): JournalLine[] {
		let text: string;
		try { text = readFileSync(this.journalFile, "utf8"); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const lines: JournalLine[] = [];
		for (const row of text.split("\n")) {
			try {
				const line = JSON.parse(row) as JournalLine;
				if (line && typeof line.type === "string" && typeof line.at === "string") lines.push(line);
			} catch { /* torn */ }
		}
		return lines;
	}

	requests(): RequestLine[] {
		return this.readJournal().filter((line): line is RequestLine => line.type === "request");
	}

	/** The ledger, or undefined before the first sweep; invalid is refused by name, never guessed. */
	readOutbox(): Outbox | undefined {
		if (!existsSync(this.outboxFile)) return undefined;
		let raw: unknown;
		try { raw = JSON.parse(readFileSync(this.outboxFile, "utf8")); } catch (error) {
			throw new Error(`${this.outboxFile} is not valid JSON (${(error as Error).message}); refusing to guess`);
		}
		const parsed = validate<Outbox>(OutboxSchema, raw);
		if (!parsed.ok) throw new Error(`${this.outboxFile} violates the channel outbox contract:\n  ${parsed.errors.join("\n  ")}`);
		return parsed.value;
	}

	/** Validate, prune settled rows past the keep, and write 0600. */
	writeOutbox(outbox: Outbox): void {
		const settled = outbox.items.filter((item) => !live(item)).sort((a, b) => (b.settled_at ?? b.created_at).localeCompare(a.settled_at ?? a.created_at));
		const drop = new Set(settled.slice(OUTBOX_SETTLED_KEEP));
		const next = { ...outbox, items: outbox.items.filter((item) => !drop.has(item)) };
		const parsed = validate<Outbox>(OutboxSchema, next);
		if (!parsed.ok) throw new Error(`refusing to write an invalid channel outbox:\n  ${parsed.errors.join("\n  ")}`);
		atomicWriteJson(this.outboxFile, next, { mode: 0o600 });
	}

	/** Exclusive access to the outbox within this process (the socket handler and the sweep share it). */
	locked<T>(fn: () => Promise<T>): Promise<T> {
		return queued(this.outboxFile, fn);
	}
}
