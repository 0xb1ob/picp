/**
 * `POST /api/operator/queue` (cp-y43c): edit or cancel a composer message the dashboard queued while the operator
 * session was busy. The viewer only forwards one `queue_edit` / `queue_cancel` frame to the session's control socket;
 * the bridge owns the queue, decides, and journals the `edited` / `cancelled` line before it answers
 * (src/dashboard-control.ts), so an edit and the handoff to pi are ordered by one process and one journal.
 *
 * Refusal order: the shared chain (`guarded`: method, --require-tailnet, rate, opt-out, Origin, Sec-Fetch-Site, JSON,
 * 20 KiB), then exactly `{"op": "edit", "id", "text"}` or `{"op": "cancel", "id"}`, a live session (409 `offline`),
 * its CSRF token. The bridge answers 404 for an id it never journaled and 409 for one it no longer holds; an id it
 * already handed over comes back as `{state: "sent", text}`, the text pi was given.
 */
import type { IncomingMessage } from "node:http";
import type { OperatorQueueResponse } from "./api-types.ts";
import { type ControlRouteOptions, type ControlRouteResult, controlRequest, guarded, tokenMatches } from "./control-api.ts";
import { CONTROL_TEXT_MAX, DASHBOARD_ID_RE, readControlRecord } from "./control-files.ts";
import { operatorSession } from "./control-inbox.ts";

export const OPERATOR_QUEUE_PATH = "/api/operator/queue";

export function handleOperatorQueue(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, "queue", async (json, { peer, refuse, parsed }) => {
		const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
		const op = value?.op === "edit" || value?.op === "cancel" ? value.op : undefined;
		const id = typeof value?.id === "string" && DASHBOARD_ID_RE.test(value.id) ? value.id : undefined;
		const text = typeof value?.text === "string" ? value.text : undefined;
		parsed({ kind: "queue", text: text?.slice(0, CONTROL_TEXT_MAX) ?? null, ask_id: null, ...(op ? { op } : {}), ...(id ? { queue_id: id } : {}) });
		const keys = op === "edit" ? 3 : 2;
		if (!value || !op || !id || Object.keys(value).length !== keys || (op === "edit" && text === undefined)) return refuse(400, 'body must be {"op": "edit", "id": "dc-…", "text": "…"} or {"op": "cancel", "id": "dc-…"}');
		const record = readControlRecord(options.stateDir);
		const session = operatorSession(options.stateDir);
		if (record.state !== "ok" || !session.running) return refuse(409, `no operator session is running (${session.reason}); a queued message is edited through its session`, undefined, { state: "offline" });
		if (!tokenMatches(req.headers["x-cp-control-token"], record.record.csrf)) return refuse(403, "control token missing or stale; reload the page");
		const reply = await controlRequest(record.record, op === "edit" ? "queue_edit" : "queue_cancel", { id, peer, ...(op === "edit" ? { text } : {}) });
		if (reply.ok) return { status: 200, body: reply.result as OperatorQueueResponse };
		if (reply.status === 400 && /^unknown op/.test(reply.error)) return refuse(409, "unsupported: this session's cp-bridge predates queued-message edits; restart the session (⋮ → Restart session)");
		// The bridge writes edited/cancelled lines only; every refusal (404, 409 already sent, transport) is one refused line here.
		return refuse(reply.status, reply.error, undefined, reply.result && typeof reply.result === "object" ? (reply.result as Record<string, unknown>) : {});
	});
}
