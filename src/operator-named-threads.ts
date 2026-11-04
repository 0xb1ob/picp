/**
 * Full match S8: the named-thread registry's one writer, run only in the operator session (src/dashboard-control.ts
 * ops `thread_create` / `thread_rename`; `bindThread` has no producer until S9/S10). Every write first reads the whole
 * registry through the shared reader (src/viewer/named-threads-view.ts); unavailable refuses and is never repaired.
 */

import { randomBytes } from "node:crypto";
import { type NamedThreadEvent, NamedThreadEventSchema, validate } from "./contracts.ts";
import { durableAppend } from "./json-store.ts";
import type { ThreadBinding, ThreadWriteResponse } from "./viewer/api-types.ts";
import { type ControlAuditLine, DASHBOARD_ID_RE } from "./viewer/control-files.ts";
import { THREADS_MAX_BYTES, THREADS_MAX_LINES, THREADS_VERSION } from "./contracts/thread-limits.ts";
import { bindingKey, isThreadId, readNamedThreads, threadKey, threadName, type ThreadRegistry } from "./viewer/named-threads-view.ts";

type Refusal = { ok: false; status: number; error: string };
export type ThreadReply = { ok: true; result: ThreadWriteResponse } | Refusal;
export type BindReply = { ok: true; result: ThreadBinding & { unchanged: boolean } } | Refusal;

const refusal = (status: number, error: string): Refusal => ({ ok: false, status, error });

/** One complete line, fsynced, 0600 on create; checked against the v1 contract and the read caps first. */
function append(registry: Extract<ThreadRegistry, { available: true }>, event: NamedThreadEvent): Refusal | null {
	const checked = validate(NamedThreadEventSchema, event);
	if (!checked.ok) return refusal(500, `thread event fails its contract: ${checked.errors.join("; ")}`);
	const line = `${JSON.stringify(event)}\n`;
	if (registry.bytes + Buffer.byteLength(line) > THREADS_MAX_BYTES || registry.lines + 1 > THREADS_MAX_LINES) {
		return refusal(409, `the thread registry is full (${THREADS_MAX_BYTES} bytes or ${THREADS_MAX_LINES} lines); nothing was written`);
	}
	try {
		durableAppend(registry.file, line, { mode: 0o600 });
	} catch (error) {
		return refusal(500, `thread registry unwritable: ${(error as Error).message}`);
	}
	return null;
}

const unavailable = (registry: Extract<ThreadRegistry, { available: false }>): Refusal => refusal(503, `thread registry unavailable, writes refused: ${registry.reason}`);

/** Create or rename one thread; the same client_id again replays its first answer and writes nothing. */
export function writeThread(stateDir: string, op: "thread_create" | "thread_rename", args: Record<string, unknown>, now: Date): ThreadReply {
	const type = op === "thread_create" ? "create" : "rename";
	const requestId = typeof args.client_id === "string" && DASHBOARD_ID_RE.test(args.client_id) ? args.client_id : null;
	if (!requestId) return refusal(400, "client_id must be a dashboard id");
	const name = threadName(args.name);
	if (!name.ok) return refusal(400, name.reason);
	const target = type === "rename" ? args.thread_id : undefined;
	if (type === "rename" && !isThreadId(target)) return refusal(400, "thread_id must be th-<16 hex>");
	const registry = readNamedThreads(stateDir);
	if (!registry.available) return unavailable(registry);
	const state = type === "create" ? "created" : "renamed";
	const prior = registry.requests.get(requestId);
	if (prior) {
		const same = prior.type === type && prior.name === name.name && (type === "create" || prior.thread_id === target);
		return same ? { ok: true, result: { thread_id: prior.thread_id, name: prior.name, state, replayed: true } } : refusal(409, `client_id ${requestId} was already used for another thread request`);
	}
	if (type === "rename" && !registry.threads.has(target as string)) return refusal(404, `no thread ${String(target)}`);
	let threadId = target as string;
	if (type === "create") do threadId = `th-${randomBytes(8).toString("hex")}`; while (registry.threads.has(threadId));
	const peer = typeof args.peer === "string" ? args.peer.slice(0, 100) : null;
	const failed = append(registry, { v: THREADS_VERSION, type, at: now.toISOString(), request_id: requestId, thread_id: threadId, name: name.name, peer });
	return failed ?? { ok: true, result: { thread_id: threadId, name: name.name, state, replayed: false } };
}

/** The dashboard-control op: `writeThread`, then one `thread` line in the audit journal for the answer. */
export function threadRequest(stateDir: string, op: "thread_create" | "thread_rename", args: Record<string, unknown>, now: Date, journal: (line: ControlAuditLine) => void): ThreadReply {
	const reply = writeThread(stateDir, op, args, now);
	const id = typeof args.client_id === "string" && DASHBOARD_ID_RE.test(args.client_id) ? args.client_id : null;
	const peer = typeof args.peer === "string" ? args.peer.slice(0, 100) : null;
	const name = typeof args.name === "string" ? args.name.slice(0, 200) : null;
	const fields = { type: "thread", by: "bridge", id, at: now.toISOString(), peer, op: op === "thread_create" ? "create" : "rename", name } as const;
	if (reply.ok) journal({ ...fields, thread_id: reply.result.thread_id, state: reply.result.replayed ? "replayed" : reply.result.state, reason: null });
	else journal({ ...fields, thread_id: isThreadId(args.thread_id) ? args.thread_id : null, state: "refused", reason: reply.error });
	return reply;
}

/** Binds a typed key to a thread (or null, No thread): the same binding again writes nothing, another is refused. */
export function bindThread(stateDir: string, key: unknown, threadId: unknown, now: Date): BindReply {
	const parsed = threadKey(key);
	if (!parsed.ok) return refusal(400, parsed.reason);
	if (threadId !== null && !isThreadId(threadId)) return refusal(400, "thread_id must be th-<16 hex> or null");
	const registry = readNamedThreads(stateDir);
	if (!registry.available) return unavailable(registry);
	if (threadId !== null && !registry.threads.has(threadId)) return refusal(404, `no thread ${threadId}`);
	const prior = registry.bindings.get(bindingKey(parsed.key));
	if (prior && prior.thread_id !== threadId) return refusal(409, `${parsed.key.kind} ${parsed.key.id} is already bound to ${prior.thread_id ?? "no thread"}; a binding never moves`);
	if (prior) return { ok: true, result: { ...prior, unchanged: true } };
	const at = now.toISOString();
	const failed = append(registry, { v: THREADS_VERSION, type: "bind", at, key: parsed.key, thread_id: threadId });
	return failed ?? { ok: true, result: { ...parsed.key, thread_id: threadId, at, unchanged: false } };
}
