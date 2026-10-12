/**
 * Remote dashboard PR 1b: device management, opt-in (only a viewer given `devices` routes these paths; the default
 * local viewer answers 404 exactly as before).
 *
 * - `GET /api/devices`: the device list (no digest), committed pairing events and the live-code count. Local: only a
 *   loopback/tailnet socket peer. Remote: either level. The management token goes only to a caller that may revoke.
 * - `POST /api/pair/create` `{level?}`: issue one pairing code. Local only, from a loopback/tailnet socket peer
 *   (`canMint`); every remote context refuses 403 whatever its level, token or Origin (Decision es-6a78c3: the API half).
 * - `POST /api/devices/revoke` `{id}`: an eligible local screen or a Full-control remote device.
 *
 * Writes refuse in order: method, authority, Origin (local: the control route's origins; remote: exactly its tunnel
 * origin), Sec-Fetch-Site, JSON type, 1 KiB body, the management token, the body shape, then the store (the one writer,
 * which audits issue and revoke). Responses carry fixed reasons, never a code except the one create hands back.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { accessOf, canMint, canRevoke, mintPeer } from "./access.ts";
import { tokenMatches } from "./control-api.ts";
import { controlOrigin } from "./control-files.ts";
import { DEVICE_ID_RE, isDeviceLevel } from "./device-files.ts";
import type { DeviceFailure, DeviceStore } from "./device-store.ts";
import { allowedOrigins, bindOrigin, readBody } from "./push-api.ts";

export const DEVICES_PATH = "/api/devices";
export const PAIR_CREATE_PATH = "/api/pair/create";
export const DEVICES_REVOKE_PATH = "/api/devices/revoke";
export const DEVICES_BODY_MAX_BYTES = 1024;
/** The management CSRF token: per viewer process, independent of every control token. */
export const DEVICES_TOKEN = randomBytes(32).toString("hex");
/** Decision es-6a78c3, verbatim: shown wherever devices are managed. */
export const DEVICE_TRUST = "A Full-control remote device is trusted like your terminal. The dashboard's pairing and device APIs prevent remote devices from creating additional devices; this does not prevent shell actions requested through the operator agent. Use View only for a less-trusted device.";

/** The tunnel's current origin and generation, or null while no remote listener is running. */
export type DeviceBinding = { origin: string; generation: number };
export interface DeviceRoutes {
	store: DeviceStore;
	binding: () => DeviceBinding | null;
}
export interface DevicesRouteOptions {
	stateDir: string;
	host: string;
	port: number;
	log?: (line: string) => void;
}
export interface DevicesRouteResult {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

const STORE_STATUS: Record<DeviceFailure["reason"], number> = {
	store_invalid: 503, write_failed: 500, audit_failed: 500, too_many_codes: 429, bad_input: 400, code_invalid: 403, code_expired: 403,
	origin_mismatch: 403, level_mismatch: 403, name_invalid: 400, name_taken: 409, not_found: 404, ambiguous: 409, no_session: 401, session_invalid: 401,
};
/** A store refusal as an HTTP answer: the fixed reason only, never the store's detail (a path or a schema position). */
export const storeRefusal = (failure: DeviceFailure): DevicesRouteResult => ({ status: STORE_STATUS[failure.reason], body: { error: failure.reason } });

const peerOf = (req: IncomingMessage): string | undefined => req.socket.remoteAddress;

export function handleDevicesList(req: IncomingMessage, routes: DeviceRoutes, now = new Date()): DevicesRouteResult {
	const access = accessOf(req);
	if (access.kind === "local" && !mintPeer(peerOf(req))) return { status: 403, body: { error: "devices are listed only to a loopback or tailnet peer" } };
	const listed = routes.store.list();
	if (!listed.ok) return storeRefusal(listed);
	const revoke = canRevoke(access, peerOf(req));
	return {
		status: 200,
		body: {
			generated_at: now.toISOString(), origin: routes.binding()?.origin ?? null, devices: listed.devices, events: listed.events, pending_codes: listed.pending_codes,
			token: revoke ? DEVICES_TOKEN : null, can_create: canMint(access, peerOf(req)), can_revoke: revoke, trust: DEVICE_TRUST,
		},
	};
}

export async function handleDevicesWrite(req: IncomingMessage, options: DevicesRouteOptions, routes: DeviceRoutes, op: "create" | "revoke"): Promise<DevicesRouteResult> {
	const access = accessOf(req);
	const peer = peerOf(req);
	const refuse = (status: number, error: string, headers?: Record<string, string>): DevicesRouteResult => {
		(options.log ?? ((line: string) => process.stderr.write(line)))(`viewer: device ${op} refused ${status}: ${error} (${access.kind === "remote" ? access.device_id : peer ?? "unknown peer"})\n`);
		return { status, body: { error }, ...(headers ? { headers } : {}) };
	};
	if (req.method !== "POST") return refuse(405, "POST only", { allow: "POST" });
	if (op === "create" && !canMint(access, peer)) return refuse(403, "pairing codes are issued only by the terminal or a loopback/tailnet dashboard");
	if (op === "revoke" && !canRevoke(access, peer)) return refuse(403, access.kind === "remote" ? "View-only devices cannot revoke" : "devices are revoked only from a loopback or tailnet peer");
	if (access.kind === "remote") {
		if (req.headers.origin !== access.origin) return refuse(403, `Origin must be ${access.origin}`);
	} else {
		const origin = controlOrigin(options.stateDir);
		if (!(origin ? allowedOrigins(options, origin) : [bindOrigin(options)]).includes(req.headers.origin ?? "")) return refuse(403, `Origin must be ${origin ?? bindOrigin(options)}`);
	}
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin") return refuse(403, "cross-site request refused");
	if (!/^application\/json\s*(?:;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(415, "Content-Type must be application/json");
	const raw = await readBody(req, DEVICES_BODY_MAX_BYTES);
	if (raw === "too_large") return refuse(413, `body is larger than ${DEVICES_BODY_MAX_BYTES} bytes`, { connection: "close" });
	if (!tokenMatches(req.headers["x-cp-control-token"], DEVICES_TOKEN)) return refuse(403, "device token missing or stale; reload the page");
	let value: unknown;
	try { value = JSON.parse(raw.toString("utf8")); } catch { return refuse(400, "body is not JSON"); }
	const body = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (op === "revoke") {
		if (!body || Object.keys(body).length !== 1 || typeof body.id !== "string" || !DEVICE_ID_RE.test(body.id)) return refuse(400, 'body must be {"id": "dev-<16 hex>"}');
		const revoked = routes.store.revoke(body.id, peer ?? null);
		if (!revoked.ok) return storeRefusal(revoked);
		return { status: 200, body: { id: revoked.device.id, revoked_at: revoked.device.revoked_at, audit_error: revoked.audit_error } };
	}
	if (!body || Object.keys(body).some((key) => key !== "level") || (body.level !== undefined && !isDeviceLevel(body.level))) return refuse(400, 'body must be {"level"?: "full" | "view"}');
	const binding = routes.binding();
	if (!binding) return refuse(409, "the remote dashboard is not running: start it with cp-tunnel up");
	// canMint passed, so the peer is loopback or tailnet: name which one issued the code.
	const route = /^(?:127\.|::1$|::ffff:127\.)/.test(peer ?? "") ? "loopback-dashboard" : "tailnet-dashboard";
	const issued = routes.store.issueCode({ ...binding, route, ...(body.level ? { level: body.level as "full" | "view" } : {}), peer: peer ?? null });
	if (!issued.ok) return storeRefusal(issued);
	return { status: 201, body: { level: issued.level, expires_at: issued.expires_at, link: `${binding.origin}/pair#${issued.code}` } };
}
