/**
 * Durable outbox for death / bound / recovery wake-ups.
 *
 * Same delivery contract as `src/answered.ts`: enqueue on disk first, emit
 * only when due, stamp delivered on observed arrival. A restart replays
 * undelivered entries once; a confirmed id never comes back.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DURABLE_WAKEUP_KEEP_DELIVERED,
	DURABLE_WAKEUP_RETRY_SECONDS,
	type DurableWakeupEntry,
	type DurableWakeupKind,
	type DurableWakeupOutboxFile,
	EMPTY_DURABLE_WAKEUP_OUTBOX,
	isoTimestamp,
	LAYOUT,
	SCHEMA_VERSION,
	validateDurableWakeupOutboxFile,
	type AnsweredSend,
} from "./contracts.ts";
import { atomicWriteJson, canonicalDir } from "./json-store.ts";

export class DurableWakeupError extends Error {}

const OWNER_KEY = Symbol.for("pi-command-post.wakeups.owner");
const globalOwners = globalThis as { [OWNER_KEY]?: string };
const PROCESS_OWNER = (globalOwners[OWNER_KEY] ??= `${process.pid}.${randomUUID().slice(0, 8)}`);

/** Ids are capped at 160. A hash of the full string keeps a long recovery set unique. */
export function boundedWakeupId(raw: string): string {
	if (raw.length <= 160) return raw;
	const digest = createHash("sha256").update(raw).digest("hex").slice(0, 20);
	return `${raw.slice(0, 139)}:${digest}`;
}

/** `prefix` + a cause, at most 160 chars; a long cause keeps its head and its tail (the status/HTTP code) plus a hash. */
export function boundedCauseId(prefix: string, cause: string): string {
	const raw = prefix + cause;
	if (raw.length <= 160) return raw;
	return `${prefix}${cause.slice(0, 30)}…${cause.slice(-70)}:${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
}

/** A completed held-PR continuation is operator news, never a parent turn. */
export function isLandedContinuation(id: string): boolean {
	return id.startsWith("continuation:done:") || (id.startsWith("continuation:") && id.endsWith(":done"));
}

/** issue #2: the durable id prefix of a killed_unreported notice; cp-bridge relays it straight to the operator. */
export const KILLED_UNREPORTED_WAKEUP_PREFIX = "killed-unreported:";

export interface DurableWakeupInput {
	id: string;
	kind: DurableWakeupKind;
	job_id?: string;
	content: string;
	keys?: string[];
	generation?: number;
	queued_at?: string;
}

export class DurableWakeupOutbox {
	readonly home: string;
	readonly file: string;
	readonly #now: () => Date;
	readonly #retryMs: number;
	readonly #owner: string;

	constructor(options: { home: string; now?: () => Date; retrySeconds?: number; owner?: string }) {
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.wakeupsFile);
		this.#now = options.now ?? (() => new Date());
		this.#retryMs = (options.retrySeconds ?? DURABLE_WAKEUP_RETRY_SECONDS) * 1000;
		this.#owner = options.owner ?? PROCESS_OWNER;
	}

	#reserved(entry: AnsweredSend | undefined, now: number): boolean {
		if (!entry) return false;
		if (entry.owner !== this.#owner) return false;
		const at = Date.parse(entry.sent_at);
		return Number.isFinite(at) && now - at < this.#retryMs;
	}

	read(): DurableWakeupOutboxFile {
		if (!existsSync(this.file)) return EMPTY_DURABLE_WAKEUP_OUTBOX;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new DurableWakeupError(`${this.file} is not valid JSON (${(error as Error).message})`);
		}
		const result = validateDurableWakeupOutboxFile(parsed);
		if (!result.ok) {
			throw new DurableWakeupError(`${this.file} violates the wake-up contract:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	pending(): DurableWakeupEntry[] {
		return this.read().pending;
	}

	#mutate(mutator: (file: DurableWakeupOutboxFile) => DurableWakeupOutboxFile): DurableWakeupOutboxFile {
		const next = mutator(structuredClone(this.read()));
		const stamped: DurableWakeupOutboxFile = { ...next, updated_at: isoTimestamp(this.#now()) };
		const result = validateDurableWakeupOutboxFile(stamped);
		if (!result.ok) {
			throw new DurableWakeupError(`refusing to write an invalid wakeups.json:\n  ${result.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file, result.value);
		return result.value;
	}

	enqueue(input: DurableWakeupInput): boolean {
		const entry: DurableWakeupEntry = {
			schema_version: SCHEMA_VERSION,
			id: input.id,
			kind: input.kind,
			content: input.content,
			queued_at: input.queued_at ?? isoTimestamp(this.#now()),
			...(input.job_id ? { job_id: input.job_id } : {}),
			...(input.keys && input.keys.length > 0 ? { keys: input.keys } : {}),
			...(input.generation !== undefined ? { generation: input.generation } : {}),
		};
		let queuedIt = false;
		this.#mutate((file) => {
			if (file.pending.some((item) => item.id === entry.id)) return file;
			if (file.delivered.some((item) => item.id === entry.id)) return file;
			if ((file.discarded ?? []).some((item) => item.id === entry.id)) return file;
			queuedIt = true;
			return { ...file, pending: [...file.pending, entry] };
		});
		return queuedIt;
	}

	#recordSend(ids: readonly string[]): void {
		if (ids.length === 0) return;
		const at = isoTimestamp(this.#now());
		this.#mutate((file) => {
			const sends = [...(file.sends ?? [])];
			for (const id of ids) {
				const index = sends.findIndex((item) => item.id === id);
				const attempts = index >= 0 ? (sends[index]?.attempts ?? 0) + 1 : 1;
				const item: AnsweredSend = { id, sent_at: at, attempts, owner: this.#owner };
				if (index >= 0) sends[index] = item;
				else sends.push(item);
			}
			return { ...file, sends };
		});
	}

	#forgetSends(previous: ReadonlyMap<string, AnsweredSend | undefined>): void {
		if (previous.size === 0) return;
		this.#mutate((file) => {
			const sends = (file.sends ?? []).filter((item) => !previous.has(item.id));
			for (const item of previous.values()) if (item) sends.push({ ...item });
			return { ...file, sends };
		});
	}

	/** Stale suppression is terminal. A later enqueue of the same id does not resurrect it. */
	discard(items: ReadonlyArray<{ id: string; reason: string }>): string[] {
		const pendingIds = new Set(this.pending().map((entry) => entry.id));
		const fresh = items.filter((item) => pendingIds.has(item.id));
		if (fresh.length === 0) return [];
		const at = isoTimestamp(this.#now());
		const marked = new Map(fresh.map((item) => [item.id, item.reason.slice(0, 500) || "stale"]));
		this.#mutate((file) => {
			const added = [...marked].map(([id, reason]) => ({ id, at, reason }));
			const discarded = [...(file.discarded ?? []).filter((item) => !marked.has(item.id)), ...added];
			return {
				...file,
				pending: file.pending.filter((entry) => !marked.has(entry.id)),
				sends: (file.sends ?? []).filter((item) => !marked.has(item.id)),
				discarded: discarded.slice(Math.max(0, discarded.length - DURABLE_WAKEUP_KEEP_DELIVERED)),
			};
		});
		return [...marked.keys()];
	}

	confirmDelivered(ids: readonly string[], options: { at?: string } = {}): string[] {
		const pendingIds = new Set(this.pending().map((entry) => entry.id));
		const fresh = ids.filter((id) => pendingIds.has(id));
		if (fresh.length === 0) return [];
		const at = options.at ?? isoTimestamp(this.#now());
		const marked = new Set(fresh);
		this.#mutate((file) => {
			const added = file.pending.filter((entry) => marked.has(entry.id)).map((entry) => ({ id: entry.id, delivered_at: at }));
			const delivered = [...file.delivered.filter((item) => !marked.has(item.id)), ...added];
			return {
				...file,
				pending: file.pending.filter((entry) => !marked.has(entry.id)),
				sends: (file.sends ?? []).filter((item) => !marked.has(item.id)),
				delivered: delivered.slice(Math.max(0, delivered.length - DURABLE_WAKEUP_KEEP_DELIVERED)),
			};
		});
		return fresh;
	}

	drain(send: (entry: DurableWakeupEntry) => void): DurableWakeupEntry[] {
		const file = this.read();
		if (file.pending.length === 0) return [];
		const now = this.#now().getTime();
		const sends = new Map((file.sends ?? []).map((item) => [item.id, item]));
		const due = file.pending.filter((entry) => !this.#reserved(sends.get(entry.id), now));
		if (due.length === 0) return [];
		const dueIds = due.map((entry) => entry.id);
		const before = new Map<string, AnsweredSend | undefined>(
			dueIds.map((id) => {
				const item = sends.get(id);
				return [id, item ? { ...item } : undefined];
			}),
		);
		this.#recordSend(dueIds);
		try {
			for (const entry of due) send(entry);
		} catch (error) {
			this.#forgetSends(before);
			throw error;
		}
		return [...due];
	}
}

export function durableIdsFromMessage(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const record = message as { customType?: unknown; details?: unknown };
	if (typeof record.customType !== "string") return [];
	if (!record.customType.startsWith("cp-")) return [];
	const details = record.details as { durable_id?: unknown; cp_wakeup?: { kind?: unknown } } | undefined;
	if (typeof details?.durable_id === "string" && details.durable_id.length > 0) return [details.durable_id];
	return [];
}
