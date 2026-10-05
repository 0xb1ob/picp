/**
 * The dashboard's Web Push surface (Pier 1.1): `/api/push` (public setup and delivery health) and the one
 * write route, `POST|DELETE /api/push/subscription`, which stores or removes this browser's subscription.
 *
 * The write route is a CSRF target (any page a tailnet browser visits could try to register an endpoint and
 * then read project/kind/headline), so it demands, in order: push set up on this home, an `Origin` equal to
 * the configured HTTPS origin (or this bind's own `http://` origin on loopback, a secure context too), a
 * same-origin `Sec-Fetch-Site` when sent, JSON content (which forces a CORS preflight nothing answers), a
 * body of at most 4 KiB, a well-formed subscription on the push-service allowlist, and room for the device.
 * The Host guard in server.ts is unchanged and runs first: the HTTPS proxy sends the bind address as Host.
 */

import type { IncomingMessage } from "node:http";
import type { PushStatusResponse } from "./api-types.ts";
import { listSubscriptions, parseSubscription, pushDataDir, pushServiceAllowed, readDeliverySummary, readPushConfig } from "./push-files.ts";
import { deleteSubscription, saveSubscription } from "./push-subscriptions.ts";

export const PUSH_STATUS_PATH = "/api/push";
export const PUSH_SUBSCRIPTION_PATH = "/api/push/subscription";
export const PUSH_BODY_MAX_BYTES = 4096;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface PushRouteOptions {
	stateDir: string;
	host: string;
	port: number;
	log?: (line: string) => void;
}

export interface PushRouteResult {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
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

const refuse = (status: number, error: string, headers?: Record<string, string>): PushRouteResult => ({ status, body: { error }, ...(headers ? { headers } : {}) });

export async function handlePushSubscription(req: IncomingMessage, options: PushRouteOptions, now = new Date()): Promise<PushRouteResult> {
	const method = req.method ?? "";
	if (method !== "POST" && method !== "DELETE") return refuse(405, "POST or DELETE only", { allow: "POST, DELETE" });
	const dataDir = pushDataDir(options.stateDir);
	const config = readPushConfig(dataDir);
	if (!config) return refuse(409, "push is not set up on this home: npm run push:init -- --origin https://<dashboard host>");
	if (!allowedOrigins(options, config.origin).includes(req.headers.origin ?? "")) return refuse(403, `Origin must be ${config.origin}`);
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin") return refuse(403, "cross-site request refused");
	if (!/^application\/json\s*(?:;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(415, "Content-Type must be application/json");
	const body = await readBody(req, PUSH_BODY_MAX_BYTES);
	if (body === "too_large") return refuse(413, `body is larger than ${PUSH_BODY_MAX_BYTES} bytes`, { connection: "close" });
	let json: unknown;
	try {
		json = JSON.parse(body.toString("utf8"));
	} catch {
		return refuse(400, "body is not JSON");
	}
	const parsed = parseSubscription(json, method === "POST" ? "subscribe" : "unsubscribe");
	if (!parsed.ok) return refuse(400, parsed.reason);
	if (!pushServiceAllowed(parsed.value.endpoint)) return refuse(400, "endpoint is not on a known push service");
	try {
		if (method === "DELETE") return { status: 200, body: { unsubscribed: deleteSubscription(dataDir, parsed.value.endpoint) } };
		const keys = parsed.value.keys;
		if (!keys) return refuse(400, "keys are missing");
		const saved = saveSubscription(dataDir, { endpoint: parsed.value.endpoint, keys }, now);
		if (!saved.ok) return refuse(409, `already ${saved.devices} subscribed devices; turn one off first`);
		return { status: 201, body: { subscribed: true, devices: saved.devices } };
	} catch (error) {
		(options.log ?? ((line) => process.stderr.write(line)))(`viewer: push subscription ${method === "POST" ? "save" : "removal"} failed: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`);
		return refuse(500, "could not store the subscription on this home");
	}
}
