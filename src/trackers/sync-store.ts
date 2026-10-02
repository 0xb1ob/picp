/**
 * Tracker write-back intents (B5) in `<home>/state/tracker-sync.json`. Intents are derived from facts
 * (ledger + merge receipts) and keyed, so this file is a cache of progress, never the source of truth:
 * deleting it re-derives the same keys, and the adapter's own dedupe (read-back, comment marker) keeps
 * a re-run from writing twice. Intents are never deleted.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, isoTimestamp, JobIdSchema, LAYOUT, SCHEMA_VERSION, TRACKER_CONNECTION_ID_PATTERN, TRACKER_ITEM_ID_PATTERN, validate } from "../contracts.ts";
import { atomicWriteJson, queued } from "../json-store.ts";
import { TrackerError, type TrackerWrite } from "./adapter.ts";

const SyncIntentSchema = Type.Object({
	key: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	connection_id: Type.String({ pattern: TRACKER_CONNECTION_ID_PATTERN }),
	item_id: Type.String({ pattern: TRACKER_ITEM_ID_PATTERN }),
	job_id: JobIdSchema,
	op: Type.Union([Type.Literal("close"), Type.Literal("comment")]),
	text: Type.String({ minLength: 1, maxLength: 2000 }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("ambiguous"), Type.Literal("refused")]),
	attempts: Type.Integer({ minimum: 0 }),
	next_attempt_at: Type.Optional(IsoTimestampSchema),
	last_error: Type.Optional(Type.String({ maxLength: 500 })),
	created_at: IsoTimestampSchema,
	done_at: Type.Optional(IsoTimestampSchema),
}, { additionalProperties: false });
export type SyncIntent = Static<typeof SyncIntentSchema>;
const SyncFileSchema = Type.Object({ schema_version: Type.Integer({ minimum: 1 }), intents: Type.Array(SyncIntentSchema) }, { additionalProperties: false });

export type NewIntent = Pick<SyncIntent, "key" | "connection_id" | "item_id" | "job_id" | "op" | "text">;

export function trackerSyncFile(home: string): string {
	return join(home, LAYOUT.state, "tracker-sync.json");
}

/** Seconds until the next attempt after `attempts` failures: 60, 120, 240 … capped at 900. */
export const backoffSeconds = (attempts: number): number => Math.min(60 * 2 ** Math.max(0, attempts - 1), 900);

export class SyncStore {
	readonly file: string;
	constructor(home: string) {
		this.file = trackerSyncFile(home);
	}

	list(): SyncIntent[] {
		if (!existsSync(this.file)) return [];
		let raw: unknown;
		try { raw = JSON.parse(readFileSync(this.file, "utf8")); } catch (error) { throw new TrackerError(`${this.file} is not valid JSON (${(error as Error).message}); refusing to guess`); }
		const parsed = validate<Static<typeof SyncFileSchema>>(SyncFileSchema, raw);
		if (!parsed.ok) throw new TrackerError(`${this.file} violates the tracker-sync contract:\n  ${parsed.errors.join("\n  ")}`);
		return parsed.value.intents;
	}

	/** Add every intent whose key is not yet recorded; returns the whole list. */
	enqueue(intents: readonly NewIntent[], at: string): Promise<SyncIntent[]> {
		return this.#mutate((all) => {
			const known = new Set(all.map((intent) => intent.key));
			for (const intent of intents) {
				if (known.has(intent.key)) continue;
				known.add(intent.key);
				all.push({ ...intent, status: "pending", attempts: 0, created_at: at });
			}
			return [...all];
		});
	}

	/** Record one attempt's outcome: done, held (ambiguous/refused), or rescheduled with backoff. */
	settle(key: string, outcome: TrackerWrite, now: Date): Promise<SyncIntent> {
		return this.#mutate((all) => {
			const intent = all.find((entry) => entry.key === key);
			if (!intent) throw new TrackerError(`no tracker-sync intent ${key}`);
			const at = isoTimestamp(now);
			intent.attempts += 1;
			if (outcome.status === "applied" || outcome.status === "already") {
				intent.status = "done";
				intent.done_at = at;
				delete intent.next_attempt_at;
				delete intent.last_error;
				return intent;
			}
			intent.last_error = outcome.message.slice(0, 500);
			if (outcome.status === "retryable") {
				intent.next_attempt_at = isoTimestamp(new Date(now.getTime() + backoffSeconds(intent.attempts) * 1000));
			} else {
				intent.status = outcome.status;
				delete intent.next_attempt_at;
			}
			return intent;
		});
	}

	#mutate<T>(fn: (intents: SyncIntent[]) => T): Promise<T> {
		return queued(this.file, async () => {
			const intents = this.list();
			const out = fn(intents);
			atomicWriteJson(this.file, { schema_version: SCHEMA_VERSION, intents });
			return out;
		});
	}
}
