/**
 * Full match S8, named threads: the registry's one reader and the read-only `GET /api/threads` projection. Only the
 * operator session appends (src/operator-named-threads.ts); this module never writes. The retired cp-xmw2 journal
 * `state/operator/threads.jsonl` (#588) is never read: the registry is `state/operator/named-threads.jsonl`.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { NamedThread, SessionEntry, ThreadBinding, ThreadsResponse } from "./api-types.ts";
import { DASHBOARD_ID_RE } from "./control-files.ts";
import { THREAD_AT_SOURCE, THREAD_BIND_KINDS, THREAD_ID_SOURCE, THREAD_KEY_ID_MAX, THREAD_NAME_MAX, THREADS_MAX_BYTES, THREADS_MAX_LINES, THREADS_VERSION } from "../contracts/thread-limits.ts";

const THREAD_ID_RE = new RegExp(`^${THREAD_ID_SOURCE}$`);
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ISO_RE = new RegExp(`^${THREAD_AT_SOURCE}$`);

export type ThreadKey = Omit<ThreadBinding, "thread_id" | "at">;
export type ThreadRequest = { type: "create" | "rename"; thread_id: string; name: string };
export type ThreadRegistry =
	| { available: true; file: string; bytes: number; lines: number; threads: Map<string, NamedThread>; bindings: Map<string, ThreadBinding>; requests: Map<string, ThreadRequest> }
	| { available: false; file: string; reason: string };

export const namedThreadsFile = (stateDir: string): string => join(stateDir, "operator", "named-threads.jsonl");
export const isThreadId = (value: unknown): value is string => typeof value === "string" && THREAD_ID_RE.test(value);
export const bindingKey = (key: ThreadKey): string => JSON.stringify([key.kind, key.id, key.session_id ?? null]);

/** A free display name, trimmed; the reason names the rule it breaks. */
export function threadName(value: unknown): { ok: true; name: string } | { ok: false; reason: string } {
	if (typeof value !== "string") return { ok: false, reason: "name must be a string" };
	const name = value.trim();
	if (!name) return { ok: false, reason: "name is empty" };
	if (CONTROL_CHAR.test(name)) return { ok: false, reason: "name must not contain control characters" };
	if ([...name].length > THREAD_NAME_MAX) return { ok: false, reason: `name is longer than ${THREAD_NAME_MAX} characters` };
	return { ok: true, name };
}

const keyPart = (value: unknown): boolean => typeof value === "string" && value.length >= 1 && value.length <= THREAD_KEY_ID_MAX && !CONTROL_CHAR.test(value);

/** A typed bind key `{kind, id, session_id?}`, exactly those fields. */
export function threadKey(value: unknown): { ok: true; key: ThreadKey } | { ok: false; reason: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "key must be {kind, id, session_id?}" };
	const { kind, id, session_id, ...rest } = value as Record<string, unknown>;
	if (Object.keys(rest).length) return { ok: false, reason: `key has unknown field ${Object.keys(rest).join(", ")}` };
	if (!(THREAD_BIND_KINDS as readonly unknown[]).includes(kind)) return { ok: false, reason: `key.kind must be one of ${THREAD_BIND_KINDS.join(", ")}` };
	if (!keyPart(id)) return { ok: false, reason: `key.id must be 1-${THREAD_KEY_ID_MAX} characters without control characters` };
	if (session_id !== undefined && !keyPart(session_id)) return { ok: false, reason: `key.session_id must be 1-${THREAD_KEY_ID_MAX} characters without control characters` };
	return { ok: true, key: { kind: kind as ThreadKey["kind"], id: id as string, ...(session_id !== undefined ? { session_id: session_id as string } : {}) } };
}

type Open = Extract<ThreadRegistry, { available: true }>;

/** Applies one parsed v1 line to the registry so far; the reason when the line is invalid. */
function apply(registry: Open, line: Record<string, unknown>): string | null {
	const extra = (allowed: string[]) => Object.keys(line).filter((key) => !allowed.includes(key));
	if (typeof line.at !== "string" || !ISO_RE.test(line.at)) return "at must be an ISO timestamp";
	if (line.type === "create" || line.type === "rename") {
		const unknown = extra(["v", "type", "at", "request_id", "thread_id", "name", "peer"]);
		if (unknown.length) return `unknown field ${unknown.join(", ")}`;
		if (typeof line.request_id !== "string" || !DASHBOARD_ID_RE.test(line.request_id)) return "request_id must be a dashboard id";
		if (registry.requests.has(line.request_id)) return `request_id ${line.request_id} is used twice`;
		if (!isThreadId(line.thread_id)) return "thread_id must be th-<16 hex>";
		const name = threadName(line.name);
		if (!name.ok || name.name !== line.name) return name.ok ? "name is not trimmed" : name.reason;
		if (line.peer !== undefined && line.peer !== null && (typeof line.peer !== "string" || line.peer.length > 100)) return "peer must be a string of at most 100 characters or null";
		const known = registry.threads.get(line.thread_id);
		if (line.type === "create" && known) return `${line.thread_id} is created twice`;
		if (line.type === "rename" && !known) return `rename of unknown thread ${line.thread_id}`;
		if (known) Object.assign(known, { name: name.name, renamed_at: line.at });
		else registry.threads.set(line.thread_id, { id: line.thread_id, name: name.name, created_at: line.at, renamed_at: null });
		registry.requests.set(line.request_id, { type: line.type, thread_id: line.thread_id, name: name.name });
		return null;
	}
	if (line.type === "bind") {
		const unknown = extra(["v", "type", "at", "key", "thread_id"]);
		if (unknown.length) return `unknown field ${unknown.join(", ")}`;
		const key = threadKey(line.key);
		if (!key.ok) return key.reason;
		if (line.thread_id !== null && !isThreadId(line.thread_id)) return "thread_id must be th-<16 hex> or null";
		if (line.thread_id !== null && !registry.threads.has(line.thread_id)) return `bind to unknown thread ${line.thread_id}`;
		const prior = registry.bindings.get(bindingKey(key.key));
		if (prior && prior.thread_id !== line.thread_id) return `key is already bound to ${prior.thread_id ?? "no thread"}`;
		if (!prior) registry.bindings.set(bindingKey(key.key), { ...key.key, thread_id: line.thread_id, at: line.at });
		return null;
	}
	return `unknown type ${JSON.stringify(line.type)?.slice(0, 40)}`;
}

/**
 * The whole registry, validated. Absent is available and empty. Over a cap, a torn final line, an unknown `v` or any
 * invalid line is unavailable with a `file:line` reason; nothing here repairs, truncates or resets the file.
 */
export function readNamedThreads(stateDir: string): ThreadRegistry {
	const file = namedThreadsFile(stateDir);
	const fail = (line: number, why: string): ThreadRegistry => ({ available: false, file, reason: `${file}:${line}: ${why}` });
	const registry: Open = { available: true, file, bytes: 0, lines: 0, threads: new Map(), bindings: new Map(), requests: new Map() };
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? registry : { available: false, file, reason: `${file}: unreadable (${code ?? (error as Error).message})` };
	}
	let size: number;
	let buffer: Buffer;
	try {
		size = fstatSync(fd).size;
		buffer = Buffer.alloc(Math.min(size, THREADS_MAX_BYTES));
		let got = 0;
		for (let read = 1; got < buffer.length && read > 0; got += read) read = readSync(fd, buffer, got, buffer.length - got, got);
		buffer = buffer.subarray(0, got);
	} catch (error) {
		return { available: false, file, reason: `${file}: unreadable (${(error as Error).message})` };
	} finally {
		closeSync(fd);
	}
	const rows = buffer.toString("utf8").split("\n");
	if (size > THREADS_MAX_BYTES) return fail(rows.length, `the registry is ${size} bytes, over the ${THREADS_MAX_BYTES}-byte read cap`);
	const torn = rows.pop();
	if (rows.length > THREADS_MAX_LINES) return fail(THREADS_MAX_LINES + 1, `more than ${THREADS_MAX_LINES} lines, over the read cap`);
	if (torn) return fail(rows.length + 1, "torn final line (no trailing newline)");
	for (const [index, row] of rows.entries()) {
		let line: unknown;
		try {
			line = JSON.parse(row);
		} catch {
			return fail(index + 1, "not JSON");
		}
		if (line === null || typeof line !== "object" || Array.isArray(line)) return fail(index + 1, "not a JSON object");
		const v = (line as { v?: unknown }).v;
		if (v !== THREADS_VERSION) return fail(index + 1, `unknown version v=${JSON.stringify(v)?.slice(0, 20)}; this build reads v=${THREADS_VERSION}`);
		const why = apply(registry, line as Record<string, unknown>);
		if (why) return fail(index + 1, why);
	}
	return { ...registry, bytes: size, lines: rows.length };
}

/** S9, a send's explicit thread: absent or null is No thread and never reads the registry; an id must be registered. */
export function sendThread(stateDir: string, value: unknown): { ok: true; threadId: string | null } | { ok: false; status: number; error: string } {
	if (value === undefined || value === null) return { ok: true, threadId: null };
	if (!isThreadId(value)) return { ok: false, status: 400, error: "thread_id must be th-<16 hex> or null" };
	const registry = readNamedThreads(stateDir);
	if (!registry.available) return { ok: false, status: 503, error: `thread registry unavailable, so a send to a thread is refused; send without a thread or repair it: ${registry.reason}` };
	if (!registry.threads.has(value)) return { ok: false, status: 404, error: `no thread ${value}; nothing was sent` };
	return { ok: true, threadId: value };
}

/**
 * S9 membership by turn, read-only: each entry takes its turn input's `message` binding in this pi session (`turns`
 * maps an entry to that input's entry id). Unbound, cut off by the window or an unavailable registry: untagged.
 */
export function applyThreadMembership(stateDir: string, file: string, entries: SessionEntry[], turns: Map<SessionEntry, string>): void {
	if (!turns.size) return;
	const registry = readNamedThreads(stateDir);
	if (!registry.available || !registry.bindings.size) return;
	const sessionId = sessionIdOf(file);
	if (!sessionId) return;
	for (const entry of entries) {
		const input = turns.get(entry);
		const bound = input ? registry.bindings.get(bindingKey({ kind: "message", id: input, session_id: sessionId }))?.thread_id : null;
		if (bound) entry.thread_id = bound;
	}
}

/** The pi session id from the file's header line (its first 4 KiB), the id the owner binds under. */
function sessionIdOf(file: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(4096);
		const header = JSON.parse(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8").split("\n")[0]!) as { type?: unknown; id?: unknown };
		return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined; // unreadable or no header: untagged, never guessed
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** `GET /api/threads`: the catalog and membership, or why the registry is unavailable. Never writes. */
export function threadsView(stateDir: string, now = new Date()): ThreadsResponse {
	const registry = readNamedThreads(stateDir);
	const base = { generated_at: now.toISOString(), threads: [], bindings: [] };
	if (!registry.available) return { ...base, available: false, reason: registry.reason };
	return { ...base, available: true, reason: null, threads: [...registry.threads.values()].map((thread) => ({ ...thread })), bindings: [...registry.bindings.values()] };
}
