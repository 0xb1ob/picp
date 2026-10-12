/**
 * Remote dashboard PR 1b: the remote listener's gate. A second server, separate from the loopback/tailnet one and
 * left unchanged by it, bound to 127.0.0.1 on its own port behind the tunnel (which rewrites Host to that address).
 * Nothing starts it yet: the tunnel wiring is a later PR, so the feature stays off by default.
 *
 * Every request passes, in order: the exact Host; the two public routes (exact `GET|HEAD /pair`, exact
 * `POST /api/pair/claim`); a running origin binding; the `__Host-` device cookie (missing: 401; a presented bad one
 * counts toward 10 per 10 minutes per client address, then 429); the store's check, which slides the session and
 * commits before the answer. Only then is a frozen remote context bound to the request (access.ts) and the shared
 * dispatcher runs — so an unpaired caller reaches no route, asset, stream timer or 404 of the dispatcher.
 *
 * Writes: View-only refuses 403 before any handler (device revoke aside, which devices-api.ts refuses itself). A
 * Full-control device reaches the ordinary write routes, whose shared chain (`guarded`, control-api.ts) pins the tunnel
 * origin and stamps every operator message or edit with the device (PR 1c provenance); push subscription writes stay
 * 403 until subscriptions are owned per device.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { bindAccess, remoteAccess } from "./access.ts";
import { onceWarner } from "./boards.ts";
import { DEVICE_COOKIE } from "./device-files.ts";
import { sessionCookie } from "./device-store.ts";
import { DEVICES_REVOKE_PATH, type DeviceRoutes, PAIR_CREATE_PATH, storeRefusal } from "./devices-api.ts";
import { AttemptLimiter, clientAddress, handlePairClaim, PAIR_CLAIM_PATH } from "./pair-api.ts";
import { PAIR_CSP, PAIR_HTML, PAIR_PAGE_PATH } from "./pair-page.ts";
import { PUSH_SUBSCRIPTION_PATH } from "./push-api.ts";
import { dispatch, hostAllowed, hostHeaderFor, send, sendJson, type ViewerOptions } from "./server.ts";

export const REMOTE_HOST = "127.0.0.1";
const CLEAR_COOKIE = `${DEVICE_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
const UNPAIRED = "unauthorized: pair this device with a link from `cp-tunnel pair`\n";

export interface RemoteOptions {
	port: number;
	devices: DeviceRoutes;
	/** Test seams: the two 10-per-10-minute limiters and the clock. */
	claimLimiter?: AttemptLimiter;
	cookieLimiter?: AttemptLimiter;
	now?: () => Date;
}

/** The single device cookie value; `null` when the header carries it more than once (refused, never guessed). */
function deviceCookie(header: string | undefined): string | undefined | null {
	const values = (header ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${DEVICE_COOKIE}=`)).map((part) => part.slice(DEVICE_COOKIE.length + 1));
	return values.length === 0 ? undefined : values.length === 1 ? values[0] : null;
}

export function remoteHandle(req: IncomingMessage, res: ServerResponse, options: ViewerOptions, remote: RemoteOptions, warn = onceWarner(() => {})): void {
	if (!hostAllowed(req.headers.host, REMOTE_HOST, remote.port)) {
		send(res, 421, "text/plain; charset=utf-8", `refused: Host must be ${hostHeaderFor(REMOTE_HOST, remote.port)}\n`);
		return;
	}
	const now = (remote.now ?? (() => new Date()))();
	if (req.url === PAIR_PAGE_PATH && (req.method === "GET" || req.method === "HEAD")) {
		send(res, 200, "text/html; charset=utf-8", PAIR_HTML, { "content-security-policy": PAIR_CSP });
		return;
	}
	if (req.url === PAIR_CLAIM_PATH && req.method === "POST") {
		handlePairClaim(req, remote.devices, (remote.claimLimiter ??= new AttemptLimiter()), now)
			.then((out) => sendJson(res, out.status, out.body, out.headers))
			.catch(() => {
				if (!res.headersSent) sendJson(res, 500, { error: "internal" });
			});
		return;
	}
	const binding = remote.devices.binding();
	if (!binding) {
		send(res, 503, "text/plain; charset=utf-8", "the remote dashboard is not ready\n");
		return;
	}
	const value = deviceCookie(req.headers.cookie);
	if (value === undefined) {
		send(res, 401, "text/plain; charset=utf-8", UNPAIRED);
		return;
	}
	const address = clientAddress(req);
	const limiter = (remote.cookieLimiter ??= new AttemptLimiter());
	if (limiter.blocked(address, now.getTime())) {
		send(res, 429, "text/plain; charset=utf-8", "too many sign-in failures; retry later\n", { "retry-after": String(limiter.windowMs / 1000) });
		return;
	}
	const peer = address === "unknown" ? null : address;
	const signedIn = remote.devices.store.authenticate(value ?? "duplicate", binding, { touch: true, peer });
	if (!signedIn.ok) {
		if (signedIn.reason === "session_invalid" || signedIn.reason === "no_session") {
			limiter.record(address, now.getTime());
			send(res, 401, "text/plain; charset=utf-8", UNPAIRED, { "set-cookie": CLEAR_COOKIE });
			return;
		}
		// The store itself failed (unreadable, or the sliding touch did not commit): refuse, never let the request through.
		const out = storeRefusal(signedIn);
		sendJson(res, out.status, out.body);
		return;
	}
	const access = remoteAccess(signedIn.device);
	const cookie = value as string;
	bindAccess(req, access, () => {
		const current = remote.devices.binding();
		return current !== null && remote.devices.store.authenticate(cookie, current, { touch: false, peer }).ok;
	});
	res.setHeader("set-cookie", sessionCookie(cookie));
	const path = (req.url ?? "/").split("?")[0];
	if (req.method !== "GET" && req.method !== "HEAD" && path !== DEVICES_REVOKE_PATH && path !== PAIR_CREATE_PATH) {
		if (access.level === "view") {
			sendJson(res, 403, { error: "View-only device: dashboard writes are refused" });
			return;
		}
		// Subscription ownership per device is a later slice: until then no remote browser stores or removes one.
		if (path === PUSH_SUBSCRIPTION_PATH) {
			sendJson(res, 403, { error: "remote push subscriptions are not enabled yet" });
			return;
		}
	}
	dispatch(req, res, options, warn);
}

/**
 * The remote listener. `options` is the local viewer's (shared asset snapshot and state); it is never mutated — the
 * remote copy carries the device routes and keeps its own lazily created limiters and caches.
 */
export function createRemoteViewer(options: ViewerOptions, remote: RemoteOptions): Server {
	const warn = onceWarner(options.log ?? ((line) => process.stderr.write(line)));
	const remoteOptions: ViewerOptions = { ...options, devices: remote.devices };
	return createServer((req, res) => remoteHandle(req, res, remoteOptions, remote, warn));
}
