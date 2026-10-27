/**
 * The dashboard's Web Push surface (Pier 1.1): `/api/push` (public setup and delivery health), the subscription write
 * route, `POST|DELETE /api/push/subscription`, which stores or removes this browser's subscription, and
 * `POST /api/push/test`, which sends one test push to it and reports the push service's answer — never a display.
 *
 * The write route is a CSRF target (any page a tailnet browser visits could try to register an endpoint and
 * then read project/kind/headline), so it demands, in order: push set up on this home, an `Origin` equal to
 * the configured HTTPS origin (or this bind's own `http://` origin on loopback, a secure context too), a
 * same-origin `Sec-Fetch-Site` when sent, JSON content (which forces a CORS preflight nothing answers), a
 * body of at most 4 KiB, a well-formed subscription on the push-service allowlist, and room for the device.
 * The Host guard in server.ts is unchanged and runs first: the HTTPS proxy sends the bind address as Host.
 * Remote dashboard (PR 1d): through the remote gate, either level may write its own subscription (a browser preference,
 * not an operational control), from exactly its tunnel origin; the record is owned by that device and origin, and an
 * endpoint stored by another device — or by the local listener — is refused 403, never overwritten or removed.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { accessOf } from "./access.ts";
import { runPushTest } from "../push/test-push.ts";
import type { PushFetch } from "../push/webpush.ts";
import type { PushStatusResponse } from "./api-types.ts";
import { listSubscriptions, ownsSubscription, parseSubscription, pushDataDir, pushServiceAllowed, readDeliverySummary, readPushConfig, type SubscriptionOwner, subscriptionId } from "./push-files.ts";
import { deleteSubscription, saveSubscription } from "./push-subscriptions.ts";

export const PUSH_STATUS_PATH = "/api/push";
export const PUSH_SUBSCRIPTION_PATH = "/api/push/subscription";
export const PUSH_TEST_PATH = "/api/push/test";
export const PUSH_BODY_MAX_BYTES = 4096;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface PushRouteOptions {
	stateDir: string;
	host: string;
	port: number;
	log?: (line: string) => void;
	/** Test seam for the test-notification send. */
	pushFetch?: PushFetch;
}

export interface PushRouteResult {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
	/** Unread request body left to drop (at most this many bytes) after the response, then the socket closes. */
	discard?: number;
}

export function pushStatus(options: { stateDir: string }, now = new Date()): PushStatusResponse {
	const dataDir = pushDataDir(options.stateDir);
	const config = readPushConfig(dataDir);
	const base = { generated_at: now.toISOString(), origin: null, public_key: null, devices: null, last_sent_at: null, undelivered_24h: null, last_error: null };
	if (!config) return { ...base, configured: false };
	const summary = readDeliverySummary(options.stateDir, now);
	return {
		...base,
		configured: true,
		origin: config.origin,
		public_key: config.public_key,
		devices: listSubscriptions(dataDir).items.length,
		...(summary === undefined ? { undelivered_24h: 0 } : summary === null ? {} : summary),
	};
}

/** This bind's own `http://` origin as a browser serializes it (IPv6 bracketed, port 80 elided). */
export function bindOrigin(options: { host: string; port: number }): string {
	const host = options.host.includes(":") ? `[${options.host}]` : options.host;
	return options.port === 80 ? `http://${host}` : `http://${host}:${options.port}`;
}

/** Origins allowed to write: the configured HTTPS origin, plus this bind's own origin when it is loopback. */
export function allowedOrigins(options: PushRouteOptions, configOrigin: string): string[] {
	if (!LOOPBACK.has(options.host)) return [configOrigin];
	return [configOrigin, bindOrigin(options)];
}

/** The request body up to `max` bytes, or "too_large" (declared or streamed past the cap). */
export function readBody(req: IncomingMessage, max: number): Promise<Buffer | "too_large"> {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > max) return Promise.resolve("too_large");
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.length;
			if (size > max) {
				settled = true;
				resolve("too_large");
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!settled) resolve(Buffer.concat(chunks));
			settled = true;
		});
		req.on("error", (error) => {
			if (!settled) reject(error);
			settled = true;
		});
	});
}

/** The slack beyond the cap that a refused oversize body may still be drained for, so its sender reads the 413. */
export const BODY_DISCARD_MAX_BYTES = 1024 * 1024;
/** A refused sender silent this long ends the discard and loses its socket, so a stalled client cannot hold it. */
export const BODY_DISCARD_IDLE_MS = 5000;

/** How much more of a refused body to drop: a declared length was never read, so its allowance starts at the cap. */
export function discardAllowance(req: IncomingMessage, max: number): number {
	const declared = Number(req.headers["content-length"]);
	return Number.isFinite(declared) && declared > max ? max + BODY_DISCARD_MAX_BYTES : BODY_DISCARD_MAX_BYTES;
}

/** Drop up to `budget` more bytes of the unread body, then close the socket once `res` has flushed. */
export function discardBounded(req: IncomingMessage, res: ServerResponse, budget: number): void {
	if (req.complete) return;
	let seen = 0;
	const close = (): void => {
		clearTimeout(idle);
		req.removeListener("data", onData);
		req.pause();
		if (res.writableFinished) req.socket.destroySoon();
		else res.once("finish", () => req.socket.destroySoon());
	};
	const onData = (chunk: Buffer): void => {
		seen += chunk.length;
		if (seen > budget) close();
		else idle.refresh();
	};
	const idle = setTimeout(close, BODY_DISCARD_IDLE_MS).unref();
	req.on("data", onData);
	req.once("end", () => clearTimeout(idle));
	req.once("close", () => clearTimeout(idle));
}

const refuse = (status: number, error: string, headers?: Record<string, string>): PushRouteResult => ({ status, body: { error }, ...(headers ? { headers } : {}) });

type Guarded = { ok: false; refused: PushRouteResult } | { ok: true; dataDir: string; owner: SubscriptionOwner; json: unknown };

/** The CSRF guards every push write shares (see the header), up to the parsed JSON body. */
async function guardedJson(req: IncomingMessage, options: PushRouteOptions): Promise<Guarded> {
	const fail = (refused: PushRouteResult): Guarded => ({ ok: false, refused });
	const dataDir = pushDataDir(options.stateDir);
	const config = readPushConfig(dataDir);
	if (!config) return fail(refuse(409, "push is not set up on this home: npm run push:init -- --origin https://<dashboard host>"));
	// Remote dashboard: a paired device writes from exactly its tunnel origin and owns what it stores (server-derived, never the body's).
	const access = accessOf(req);
	const owner = access.kind === "remote" ? { device_id: access.device_id, origin: access.origin } : undefined;
	if (owner ? req.headers.origin !== owner.origin : !allowedOrigins(options, config.origin).includes(req.headers.origin ?? "")) return fail(refuse(403, `Origin must be ${owner?.origin ?? config.origin}`));
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin") return fail(refuse(403, "cross-site request refused"));
	if (!/^application\/json\s*(?:;|$)/i.test(req.headers["content-type"] ?? "")) return fail(refuse(415, "Content-Type must be application/json"));
	const body = await readBody(req, PUSH_BODY_MAX_BYTES);
	if (body === "too_large") return fail({ ...refuse(413, `body is larger than ${PUSH_BODY_MAX_BYTES} bytes`), discard: discardAllowance(req, PUSH_BODY_MAX_BYTES) });
	try {
		return { ok: true, dataDir, owner, json: JSON.parse(body.toString("utf8")) };
	} catch {
		return fail(refuse(400, "body is not JSON"));
	}
}

export async function handlePushSubscription(req: IncomingMessage, options: PushRouteOptions, now = new Date()): Promise<PushRouteResult> {
	const method = req.method ?? "";
	if (method !== "POST" && method !== "DELETE") return refuse(405, "POST or DELETE only", { allow: "POST, DELETE" });
	const guarded = await guardedJson(req, options);
	if (!guarded.ok) return guarded.refused;
	const { dataDir, owner, json } = guarded;
	const parsed = parseSubscription(json, method === "POST" ? "subscribe" : "unsubscribe");
	if (!parsed.ok) return refuse(400, parsed.reason);
	if (!pushServiceAllowed(parsed.value.endpoint)) return refuse(400, "endpoint is not on a known push service");
	try {
		if (method === "DELETE") {
			const removed = deleteSubscription(dataDir, parsed.value.endpoint, owner);
			return removed === "owned" ? refuse(403, "this subscription belongs to another device") : { status: 200, body: { unsubscribed: removed } };
		}
		const keys = parsed.value.keys;
		if (!keys) return refuse(400, "keys are missing");
		const saved = saveSubscription(dataDir, { endpoint: parsed.value.endpoint, keys }, now, owner);
		if (!saved.ok) return saved.owned ? refuse(403, "this subscription belongs to another device") : refuse(409, `already ${saved.devices} subscribed devices; turn one off first`);
		return { status: 201, body: { subscribed: true, devices: saved.devices } };
	} catch (error) {
		(options.log ?? ((line) => process.stderr.write(line)))(`viewer: push subscription ${method === "POST" ? "save" : "removal"} failed: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`);
		return refuse(500, "could not store the subscription on this home");
	}
}

/** `POST /api/push/test {endpoint}`: one labelled push to the caller's own subscription, rate-limited and journaled. */
export async function handlePushTest(req: IncomingMessage, options: PushRouteOptions, now = new Date()): Promise<PushRouteResult> {
	if (req.method !== "POST") return refuse(405, "POST only", { allow: "POST" });
	const guarded = await guardedJson(req, options);
	if (!guarded.ok) return guarded.refused;
	const parsed = parseSubscription(guarded.json, "unsubscribe");
	if (!parsed.ok) return refuse(400, parsed.reason);
	const id = subscriptionId(parsed.value.endpoint);
	const target = listSubscriptions(guarded.dataDir).items.find((item) => item.id === id && item.endpoint === parsed.value.endpoint);
	if (!target) return refuse(404, "this browser is not subscribed on this home; turn notifications on first");
	if (!ownsSubscription(target, guarded.owner)) return refuse(403, "this subscription belongs to another device");
	try {
		const run = await runPushTest({ stateDir: options.stateDir, dataDir: guarded.dataDir, target, now, ...(options.pushFetch ? { fetch: options.pushFetch } : {}) });
		if (run.ok) return { status: 200, body: run.reply };
		return refuse(run.status, run.error, run.retry_after ? { "retry-after": String(run.retry_after) } : undefined);
	} catch (error) {
		(options.log ?? ((line) => process.stderr.write(line)))(`viewer: push test failed: ${(error as Error).message.slice(0, 300)}\n`);
		return refuse(500, "could not run the test on this home");
	}
}
