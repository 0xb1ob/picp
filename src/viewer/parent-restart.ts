/**
 * `POST /api/parent/restart`: forwards one `parent_restart` frame; the bridge and parent host refuse 409 undrained.
 * 202: started, the outcome lands in `parent_restart.last`. No viewer window: the bridge refuses one while one runs.
 */
import type { IncomingMessage } from "node:http";
import type { ParentRestartResponse } from "./api-types.ts";
import { type ControlRouteOptions, type ControlRouteResult, controlRequest, guarded, tokenMatches } from "./control-api.ts";
import { readControlRecord } from "./control-files.ts";
import { operatorSession } from "./control-inbox.ts";
import { PARENT_RESTART_PREDATES, parseParentRestartBody } from "./restart-status.ts";

export function handleParentRestart(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, "parent_restart", async (json, { peer, refuse }) => {
		const mode = parseParentRestartBody(json);
		if (!mode) return refuse(400, 'body must be exactly {"restart": "resume"} or {"restart": "clean"}');
		const record = readControlRecord(options.stateDir);
		const session = operatorSession(options.stateDir);
		if (record.state !== "ok" || !session.running) return refuse(409, `no operator session is running (${session.reason}); start it first`, undefined, { state: "offline" });
		if (!tokenMatches(req.headers["x-cp-control-token"], record.record.csrf)) return refuse(403, "control token missing or stale; reload the page");
		const reply = await controlRequest(record.record, "parent_restart", { peer, mode });
		if (reply.ok) return { status: 202, body: reply.result as ParentRestartResponse };
		if (reply.status === 503 || reply.status === 504) return refuse(reply.status, reply.error);
		if (reply.status === 400 && /^unknown op/.test(reply.error)) return refuse(409, `unsupported: ${PARENT_RESTART_PREDATES}`, undefined, { state: "refused" });
		return { status: reply.status, body: { state: "refused", error: reply.error } };
	});
}
