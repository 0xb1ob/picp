/**
 * `POST /api/operator/restart` (cp-aqxl): Restart session. The viewer only forwards one `restart` frame to the
 * operator session's control socket; the bridge decides and stops its own pi (src/dashboard-restart.ts), and the
 * session's launcher relaunches it (src/operator-relaunch.ts). This module spawns, signals and locates no process.
 *
 * Refusal order: the shared chain (`guarded`: method, --require-tailnet, rate, opt-out, Origin, Sec-Fetch-Site, JSON,
 * 20 KiB), then exactly `{"restart": true}`, a live session (409 `offline`), its CSRF token, one accepted restart per 60 s;
 * each refusal after the --require-tailnet guard is one `refused` line (kind `restart`) through `guarded`'s refuse.
 */
import type { IncomingMessage } from "node:http";
import type { OperatorRestartResponse } from "./api-types.ts";
import { type ControlRouteOptions, type ControlRouteResult, controlRequest, guarded, tokenMatches } from "./control-api.ts";
import { readControlRecord } from "./control-files.ts";
import { operatorSession } from "./control-inbox.ts";
import { OPERATOR_RESTART_WINDOW_MS, parseRestartBody, RESTART_PREDATES } from "./restart-status.ts";

export function handleOperatorRestart(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, "restart", async (json, { peer, refuse }) => {
		const bad = parseRestartBody(json);
		if (bad) return refuse(400, bad);
		const record = readControlRecord(options.stateDir);
		const session = operatorSession(options.stateDir);
		if (record.state !== "ok" || !session.running) return refuse(409, `no operator session is running (${session.reason}); use Start session or Resume last session`, undefined, { state: "offline" });
		if (!tokenMatches(req.headers["x-cp-control-token"], record.record.csrf)) return refuse(403, "control token missing or stale; reload the page");
		const start = (options.operatorStart ??= {});
		const previous = start.restartAt;
		if (previous !== undefined && now.getTime() - previous < OPERATOR_RESTART_WINDOW_MS) {
			const wait = Math.max(1, Math.ceil((previous + OPERATOR_RESTART_WINDOW_MS - now.getTime()) / 1000));
			return refuse(429, `one restart per ${OPERATOR_RESTART_WINDOW_MS / 1000} s; retry in ${wait} s`, { "retry-after": String(wait) });
		}
		// Reserved across the await so a double tap sends one frame; released unless the bridge accepted, so a
		// "not now" can be retried as soon as the blocker clears.
		start.restartAt = now.getTime();
		const reply = await controlRequest(record.record, "restart", { peer });
		if (reply.ok) return { status: 202, body: reply.result as OperatorRestartResponse };
		start.restartAt = previous;
		// The bridge journals its own request/outcome once the frame reached it; transport failures are ours.
		if (reply.status === 503 || reply.status === 504) return refuse(reply.status, reply.error);
		// An older cp-bridge has no restart op and journals nothing for it: our refused line is the only record.
		if (reply.status === 400 && /^unknown op/.test(reply.error)) return refuse(409, `unsupported: ${RESTART_PREDATES}`, undefined, { state: "refused" });
		return { status: reply.status, body: { state: "refused", error: reply.error } };
	});
}
