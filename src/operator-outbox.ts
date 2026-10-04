/**
 * Operator relay outbox (cp-6fyl PR1). Every parent→operator relay the host
 * produces is written here under a stable relay id **before** any socket
 * frame, so a relay survives a host restart, an operator detach and a
 * half-open socket. Two files under `state/operator/`:
 *
 *  - `relay-outbox.json` — written only by the parent host (atomic
 *    read-modify-write inside one single-threaded process);
 *  - `relay-acks.jsonl` — appended only by operator sessions (`O_APPEND`,
 *    one `write()` per batch): `consumer`, `emit`, `emit_failed`, `ack`
 *    and `discard` lines. An `ack` is written only when a `cp-bridge`
 *    message carrying the id in `details.relay_ids` enters the operator's
 *    context (`message_start` / `context`), never at hand-off.
 *
 * cp-health and the viewer only read. Transport stays at-least-once; the
 * effect in the operator's context is exactly once per id, against the acks.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, isoTimestamp, SCHEMA_VERSION, validate } from "./contracts.ts";
import type { BridgeRelay } from "./cp-bridge.ts";
import { atomicWriteJson, atomicWriteText, durableAppend } from "./json-store.ts";

/** Closed (acked or discarded) entries older than this are pruned, except the newest `OPERATOR_RELAY_KEEP_CLOSED`. */
export const OPERATOR_RELAY_CLOSED_TTL_MS = 24 * 3_600_000;
export const OPERATOR_RELAY_KEEP_CLOSED = 200;
/** Above this the enqueue still writes; PR2's `relay` health check reports `outbox over cap`. */
export const OPERATOR_RELAY_OUTBOX_CAP = 2_000;
/** `relay-acks.jsonl` is compacted at operator `session_start` once it is larger than this. */
export const OPERATOR_RELAY_ACKS_COMPACT_BYTES = 512 * 1024;
export const OPERATOR_RELAY_PROTOCOL = 1;

export function operatorRelayOutboxFile(stateDir: string): string {
	return join(stateDir, "operator", "relay-outbox.json");
}

export function operatorRelayAcksFile(stateDir: string): string {
	return join(stateDir, "operator", "relay-acks.jsonl");
}

// Lenient on purpose: an older operator must still read an outbox a newer host wrote.
const RelaySchema = Type.Object({
	kind: Type.Union(["wake", "escalation", "relaunch", "error", "send"].map((kind) => Type.Literal(kind))),
	jobId: Type.Optional(Type.String()),
	jobIds: Type.Optional(Type.Array(Type.String())),
	sendId: Type.Optional(Type.String()),
	escalationId: Type.Optional(Type.String()),
	drainId: Type.Optional(Type.String()),
	stale: Type.Boolean(),
	text: Type.String(),
	receipt: Type.Object({ level: Type.Union([Type.String(), Type.Null()]), reached: Type.Array(Type.String()) }),
	paths: Type.Array(Type.String()),
});

export const OperatorRelayEntrySchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 200 }),
	relay: RelaySchema,
	queued_at: IsoTimestampSchema,
	producer: Type.String({ minLength: 1, maxLength: 120 }),
});
export type OperatorRelayEntry = Omit<Static<typeof OperatorRelayEntrySchema>, "relay"> & { relay: BridgeRelay };

export const OperatorRelayOutboxFileSchema = Type.Object({
	schema_version: Type.Integer({ minimum: 1 }),
	updated_at: IsoTimestampSchema,
	entries: Type.Array(OperatorRelayEntrySchema),
});
export interface OperatorRelayOutboxFile { schema_version: number; updated_at: string; entries: OperatorRelayEntry[] }

export class OperatorRelayError extends Error {}

const OWNER_KEY = Symbol.for("pi-command-post.operator-relays.owner");
const globalOwners = globalThis as { [OWNER_KEY]?: string };
/** This operator process: an emit by another owner (a dead or restarted session) is due again. */
export const OPERATOR_RELAY_OWNER = (globalOwners[OWNER_KEY] ??= `${process.pid}.${randomUUID().slice(0, 8)}`);

/** `send:<ps-id>`, `esc:<es-id>`, otherwise `<kind>:<uuid>`: one stable id per send outcome and per escalation. */
export function relayIdOf(relay: BridgeRelay): string {
	if (relay.kind === "send" && relay.sendId) return `send:${relay.sendId}`;
	if (relay.kind === "escalation" && relay.escalationId) return `esc:${relay.escalationId}`;
	return `${relay.kind}:${randomUUID()}`;
}

export type AckLine =
	| { type: "consumer"; owner: string; pid: number; session?: string; at: string; protocol: number }
	| { type: "emit"; id: string; owner: string; session?: string; at: string }
	| { type: "emit_failed"; id: string; owner: string; at: string }
	| { type: "ack"; id: string; at: string }
	| { type: "discard"; id: string; reason: string; at: string };

export interface RelayFold {
	acked: Map<string, string>;
	discarded: Map<string, { reason: string; at: string }>;
	/** The latest emit of each id not followed by an `emit_failed`. */
	emits: Map<string, { owner: string; session?: string; at: string }>;
	failed: Set<string>;
	consumer?: { owner: string; pid: number; session?: string; at: string };
}

export function emptyFold(): RelayFold {
	return { acked: new Map(), discarded: new Map(), emits: new Map(), failed: new Set() };
}

const closedAt = (fold: RelayFold, id: string): string | undefined => fold.acked.get(id) ?? fold.discarded.get(id)?.at;

/** The operator's journal: append-only from every operator session, read by the host, cp-health and the viewer. */
export class OperatorRelayAcks {
	readonly file: string;
	constructor(file: string) {
		this.file = file;
	}

	/** Every line in one `write()`; a short write throws (`durableAppend`). */
	append(lines: readonly AckLine[]): void {
		if (lines.length > 0) durableAppend(this.file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	}

	/** A missing file folds empty; an unparsable (torn) line is skipped. */
	fold(): RelayFold {
		const fold = emptyFold();
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return fold;
			throw new OperatorRelayError(`${this.file}: ${(error as Error).message}`);
		}
		for (const row of text.split("\n")) {
			let line: Partial<AckLine> & { id?: unknown; at?: unknown };
			try {
				line = JSON.parse(row) as typeof line;
			} catch {
				continue;
			}
			if (!line || typeof line.at !== "string") continue;
			if (line.type === "consumer" && typeof line.owner === "string") {
				fold.consumer = { owner: line.owner, pid: Number(line.pid), ...(typeof line.session === "string" ? { session: line.session } : {}), at: line.at };
				continue;
			}
			if (typeof line.id !== "string") continue;
			if (line.type === "ack") fold.acked.set(line.id, line.at);
			else if (line.type === "discard") fold.discarded.set(line.id, { reason: String(line.reason ?? ""), at: line.at });
			else if (line.type === "emit" && typeof line.owner === "string") {
				fold.emits.set(line.id, { owner: line.owner, ...(typeof line.session === "string" ? { session: line.session } : {}), at: line.at });
				fold.failed.delete(line.id);
			} else if (line.type === "emit_failed") {
				fold.emits.delete(line.id);
				fold.failed.add(line.id);
			}
		}
		return fold;
	}

	/**
	 * Over `maxBytes`, rewrite keeping only `ack`/`discard` lines for `keepIds` and the newest `consumer`
	 * line. Accepted edge: an append from another session during the rewrite can be lost — at worst one
	 * duplicate delivery, never a loss. Returns whether it rewrote.
	 */
	compact(keepIds: ReadonlySet<string>, maxBytes = OPERATOR_RELAY_ACKS_COMPACT_BYTES): boolean {
		if (!existsSync(this.file) || statSync(this.file).size <= maxBytes) return false;
		const fold = this.fold();
		const lines: AckLine[] = [];
		if (fold.consumer) lines.push({ type: "consumer", ...fold.consumer, protocol: OPERATOR_RELAY_PROTOCOL });
		for (const [id, at] of fold.acked) if (keepIds.has(id)) lines.push({ type: "ack", id, at });
		for (const [id, { reason, at }] of fold.discarded) if (keepIds.has(id)) lines.push({ type: "discard", id, reason, at });
		atomicWriteText(this.file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
		return true;
	}
}

/** Neither acked nor discarded, oldest first. */
export function pendingRelays(outbox: OperatorRelayOutboxFile, fold: RelayFold): OperatorRelayEntry[] {
	return outbox.entries.filter((entry) => closedAt(fold, entry.id) === undefined);
}

/** The oldest pending entry and its age, for the health check and the viewer. */
export function oldestUnacked(outbox: OperatorRelayOutboxFile, fold: RelayFold, now: Date = new Date()): { entry: OperatorRelayEntry; ageSeconds: number } | undefined {
	const entry = pendingRelays(outbox, fold).sort((a, b) => a.queued_at.localeCompare(b.queued_at))[0];
	return entry ? { entry, ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(entry.queued_at)) / 1_000)) } : undefined;
}

/** `details.relay_ids` of a `cp-bridge` message; empty for anything else. */
export function relayIdsOfMessage(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const record = message as { customType?: unknown; details?: { relay_ids?: unknown } };
	if (record.customType !== "cp-bridge" || !Array.isArray(record.details?.relay_ids)) return [];
	return record.details.relay_ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** The host's half: only the parent host process writes this file. */
export class OperatorRelayOutbox {
	readonly file: string;
	readonly #now: () => Date;
	constructor(file: string, now: () => Date = () => new Date()) {
		this.file = file;
		this.#now = now;
	}

	/** A missing file is empty; a corrupt one throws, naming the path. */
	read(): OperatorRelayOutboxFile {
		if (!existsSync(this.file)) return { schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(this.#now()), entries: [] };
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new OperatorRelayError(`${this.file} is not valid JSON (${(error as Error).message})`);
		}
		const parsed = validate<OperatorRelayOutboxFile>(OperatorRelayOutboxFileSchema, raw);
		if (!parsed.ok) throw new OperatorRelayError(`${this.file} violates the operator relay outbox contract: ${parsed.errors.join("; ")}`);
		return parsed.value;
	}

	/**
	 * On disk before any frame; returns the relay id. A send outcome or an escalation keeps one id: a
	 * pending entry is replaced in place (newest text wins, `queued_at` kept); once acked or discarded, the
	 * same text is a no-op and new text is a new entry `<id>#<n>`, so a refreshed question is delivered again.
	 */
	enqueue(relay: BridgeRelay, producer: string, fold: RelayFold = emptyFold()): string {
		const file = this.read();
		const entries = [...file.entries];
		const base = relayIdOf(relay);
		const family = base.startsWith("send:") || base.startsWith("esc:") ? entries.filter((entry) => entry.id === base || entry.id.startsWith(`${base}#`)) : [];
		const latest = family[family.length - 1];
		let id = base;
		if (latest) {
			if (latest.relay.text === relay.text) return latest.id;
			if (closedAt(fold, latest.id) === undefined) {
				entries[entries.indexOf(latest)] = { ...latest, relay };
				this.#write(entries, fold);
				return latest.id;
			}
			id = `${base}#${family.length + 1}`;
		}
		entries.push({ id, relay, queued_at: isoTimestamp(this.#now()), producer });
		this.#write(entries, fold);
		return id;
	}

	/** Drop closed entries older than the TTL beyond the newest kept; never a pending one. Writes only on a change. */
	prune(fold: RelayFold, now: Date = this.#now()): number {
		const entries = this.read().entries;
		const kept = keepAfterPrune(entries, fold, now);
		if (kept.length !== entries.length) this.#write(kept, fold, false);
		return entries.length - kept.length;
	}

	#write(entries: OperatorRelayEntry[], fold: RelayFold, prune = true): void {
		const next = { schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(this.#now()), entries: prune ? keepAfterPrune(entries, fold, this.#now()) : entries };
		const checked = validate<OperatorRelayOutboxFile>(OperatorRelayOutboxFileSchema, next);
		if (!checked.ok) throw new OperatorRelayError(`refusing to write an invalid ${this.file}: ${checked.errors.join("; ")}`);
		atomicWriteJson(this.file, next);
	}
}

function keepAfterPrune(entries: readonly OperatorRelayEntry[], fold: RelayFold, now: Date): OperatorRelayEntry[] {
	const closed = entries.filter((entry) => closedAt(fold, entry.id) !== undefined);
	const newest = new Set(closed.sort((a, b) => (closedAt(fold, a.id) as string).localeCompare(closedAt(fold, b.id) as string)).slice(-OPERATOR_RELAY_KEEP_CLOSED));
	return entries.filter((entry) => {
		const at = closedAt(fold, entry.id);
		return at === undefined || newest.has(entry) || now.getTime() - Date.parse(at) <= OPERATOR_RELAY_CLOSED_TTL_MS;
	});
}
