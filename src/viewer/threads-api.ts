/**
 * Operator threads (cp-xmw2 S4): `GET /api/threads` (--require-tailnet only, never writes) lists the threads with their
 * derived state (threads-view.ts) and this viewer's thread token while control is on; `POST /api/threads/done` takes
 * exactly `{"id": "th-<12 hex>"}` behind the shared dashboard-control chain (`guarded`, kind `thread_done`), then the
 * thread token, the journal readable, the thread known, asks and answers readable, nothing waiting, not already done,
 * and appends one `done` line to `state/operator/threads.jsonl` before it answers 202. Bookkeeping only: no session,
 * no parent, no push; it authorizes and acknowledges nothing. A later bind reopens the thread.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ThreadDoneResponse, ThreadsResponse } from "./api-types.ts";
import { appendThreadLine } from "./control-audit.ts";
import { type ControlRouteOptions, type ControlRouteResult, guarded, isoSeconds, tokenMatches } from "./control-api.ts";
import { operatorThreadsFile, readControlConfig, THREAD_ID_RE } from "./control-files.ts";
import { threadsView } from "./threads-view.ts";

export const THREADS_PATH = "/api/threads";
export const THREAD_DONE_PATH = "/api/threads/done";
/** Mark done's CSRF token: per viewer process; a viewer restart rotates it (the page re-reads it with the list). */
export const THREAD_TOKEN = randomBytes(32).toString("hex");

export function handleThreadsStatus(_req: IncomingMessage, options: ControlRouteOptions, now = new Date()): ControlRouteResult {
	if (options.requireTailnet !== true) return { status: 403, body: { error: "threads are served only under --require-tailnet" } };
	const config = readControlConfig(options.stateDir);
	const enabled = config.state === "on";
	const view = threadsView(options);
	const body: ThreadsResponse = {
		generated_at: now.toISOString(), availability: view.availability, enabled, reason: enabled ? null : `Dashboard control is off: ${config.reason}`,
		token: enabled ? THREAD_TOKEN : null, threads: view.threads, total: view.total, warning: view.warning,
	};
	return { status: 200, body };
}

export function handleThreadDone(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, "thread_done", async (json, { peer, refuse, parsed }) => {
		const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
		const id = typeof value?.id === "string" && THREAD_ID_RE.test(value.id) ? value.id : undefined;
		parsed({ kind: "thread_done", text: null, ask_id: null, ...(id ? { thread_id: id } : {}) });
		if (!value || !id || Object.keys(value).length !== 1) return refuse(400, 'body must be {"id": "th-<12 hex>"}');
		if (!tokenMatches(req.headers["x-cp-control-token"], THREAD_TOKEN)) return refuse(403, "control token missing or stale; reload the page");
		const view = threadsView(options);
		if (view.error) return refuse(500, `threads unreadable: ${view.error}`);
		const thread = view.byId.get(id);
		if (!thread) return refuse(404, `no thread ${id}`);
		if (!thread.waiting) return refuse(503, `cannot tell whether ${id} is waiting: ${view.blind} unreadable`);
		if (thread.state === "waiting") return refuse(409, `answer or acknowledge first: ${thread.waiting.asks} open ask(s), ${thread.waiting.answers} unacknowledged answer(s) in ${thread.tag}`);
		if (thread.state === "done") return refuse(409, `${id} is already done since ${thread.done_at}`);
		const at = isoSeconds(now);
		const written = appendThreadLine(options.stateDir, { type: "done", by: "viewer", id, at, peer });
		if (!written.ok) return refuse(500, `threads journal unwritable (${operatorThreadsFile(options.stateDir)}): ${written.error}`);
		return { status: 202, body: { id, state: "done", done_at: at } satisfies ThreadDoneResponse };
	});
}
