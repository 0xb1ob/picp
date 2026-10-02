/**
 * The Web Push delivery ledger, `state/push-deliveries.json`: one record per pushed-for item (a mandate completion,
 * an operator ask, a human-only escalation, a final-fix checkpoint or a merge-ask row), keyed by source + id, so an
 * item is sent at most once however often the sweep runs. Single
 * writer (the parent-lock holder's sweep); no payload is stored — the question stays in its own record.
 */

import { existsSync, readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, SCHEMA_VERSION, validate } from "../contracts.ts";
import { atomicWriteJson, queued } from "../json-store.ts";
import { pushDeliveriesFile } from "../viewer/push-files.ts";

export const PUSH_MAX_ATTEMPTS = 5;
/** Settled records kept beyond the pending and still-open ones. */
export const PUSH_LEDGER_SETTLED_KEEP = 200;
export const PUSH_LAST_ERROR_MAX_CHARS = 300;

const PushRecordSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 160 }),
		source: Type.Union([Type.Literal("escalation"), Type.Literal("merge_ask"), Type.Literal("checkpoint"), Type.Literal("ask"), Type.Literal("mandate")]),
		kind: Type.String({ minLength: 1, maxLength: 64 }),
		status: Type.Union([Type.Literal("pending"), Type.Literal("sent"), Type.Literal("failed"), Type.Literal("skipped")]),
		attempts: Type.Integer({ minimum: 0 }),
		delivered: Type.Integer({ minimum: 0 }),
		/** Subscription ids still owed this push (set after a retryable attempt). */
		targets: Type.Optional(Type.Array(Type.String({ pattern: "^[0-9a-f]{32}$" }), { maxItems: 50 })),
		next_attempt_at: Type.Optional(IsoTimestampSchema),
		last_error: Type.Optional(Type.String({ maxLength: PUSH_LAST_ERROR_MAX_CHARS })),
		created_at: IsoTimestampSchema,
		settled_at: Type.Optional(IsoTimestampSchema),
	},
	{ additionalProperties: false },
);
export type PushRecord = Static<typeof PushRecordSchema>;
const PushLedgerSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		baseline_at: IsoTimestampSchema,
		/** When the current push rule (`PUSH_RULE`) took over this ledger: what its sources held then is baseline, never replayed. */
		rule_baseline_at: Type.Optional(IsoTimestampSchema),
		items: Type.Array(PushRecordSchema),
	},
	{ additionalProperties: false },
);
export type PushLedger = Static<typeof PushLedgerSchema>;

export class PushLedgerError extends Error {}

/** Seconds until the next attempt after `attempts` tries: 30, 60, 120, 240 … capped at 900. */
export const pushBackoffSeconds = (attempts: number): number => Math.min(30 * 2 ** Math.max(0, attempts - 1), 900);

export const pushRecordKey = (record: Pick<PushRecord, "source" | "id">): string => `${record.source}:${record.id}`;

export class PushDeliveryStore {
	readonly file: string;
	constructor(stateDir: string) {
		this.file = pushDeliveriesFile(stateDir);
	}

	exists(): boolean {
		return existsSync(this.file);
	}

	/** The ledger, or undefined before the first sweep. Invalid JSON or shape is refused by name, never guessed. */
	read(): PushLedger | undefined {
		if (!existsSync(this.file)) return undefined;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new PushLedgerError(`${this.file} is not valid JSON (${(error as Error).message}); refusing to guess`);
		}
		const parsed = validate<PushLedger>(PushLedgerSchema, raw);
		if (!parsed.ok) throw new PushLedgerError(`${this.file} violates the push-deliveries contract:\n  ${parsed.errors.join("\n  ")}`);
		return parsed.value;
	}

	/** Validate, prune and write. `open` is the set of keys still open, whose records are always kept. */
	write(ledger: PushLedger, open: ReadonlySet<string>): void {
		const settled = ledger.items.filter((item) => item.status !== "pending" && !open.has(pushRecordKey(item)));
		const drop = new Set(
			settled
				.sort((a, b) => (b.settled_at ?? b.created_at).localeCompare(a.settled_at ?? a.created_at))
				.slice(PUSH_LEDGER_SETTLED_KEEP),
		);
		const next = { ...ledger, schema_version: SCHEMA_VERSION, items: ledger.items.filter((item) => !drop.has(item)) };
		const parsed = validate<PushLedger>(PushLedgerSchema, next);
		if (!parsed.ok) throw new PushLedgerError(`refusing to write an invalid push ledger:\n  ${parsed.errors.join("\n  ")}`);
		atomicWriteJson(this.file, next);
	}

	/** Run `fn` with exclusive access to the ledger within this process. */
	locked<T>(fn: () => Promise<T>): Promise<T> {
		return queued(this.file, fn);
	}
}
