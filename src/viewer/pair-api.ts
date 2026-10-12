/**
 * Remote dashboard PR 1b: `POST /api/pair/claim`, the one public write on the remote listener. It consumes a code a
 * terminal or eligible local screen already issued — it never issues one. Refusal order: method, the claim limiter (10
 * attempts per 10 minutes per client address, successes counted), a running remote binding, `Origin` exactly the
 * tunnel origin, Sec-Fetch-Site, JSON type, 1 KiB body, exactly `{code, name, level?}`, then the store, which audits
 * the outcome with a fixed reason. Success answers the HttpOnly cookie and a redirect target, never the secret in JSON.
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { type DeviceRoutes, type DevicesRouteResult, storeRefusal } from "./devices-api.ts";
import { sessionCookie } from "./device-store.ts";
import { readBody } from "./push-api.ts";

export const PAIR_CLAIM_PATH = "/api/pair/claim";
export const PAIR_ATTEMPTS = 10;
export const PAIR_WINDOW_MS = 10 * 60_000;
const CLAIM_BODY_MAX_BYTES = 1024;
const LIMITER_MAX_KEYS = 1024;

/** Sliding window of attempts per client address; past its key cap every new address shares one bucket. */
export class AttemptLimiter {
	readonly #hits = new Map<string, number[]>();
	readonly limit: number;
	readonly windowMs: number;
	constructor(limit = PAIR_ATTEMPTS, windowMs = PAIR_WINDOW_MS) {
		this.limit = limit;
		this.windowMs = windowMs;
	}
	#row(key: string, now: number): number[] {
		if (!this.#hits.has(key) && this.#hits.size >= LIMITER_MAX_KEYS) {
			for (const [k, at] of this.#hits) if (!at.some((t) => now - t < this.windowMs)) this.#hits.delete(k);
			if (this.#hits.size >= LIMITER_MAX_KEYS) key = "overflow";
		}
		const row = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
		this.#hits.set(key, row);
		return row;
	}
	blocked(key: string, now: number): boolean {
		return this.#row(key, now).length >= this.limit;
	}
	record(key: string, now: number): void {
		this.#row(key, now).push(now);
	}
	/** Count this attempt; false when the window is already full (the refused attempt is not counted). */
	take(key: string, now: number): boolean {
		if (this.blocked(key, now)) return false;
		this.record(key, now);
		return true;
	}
}

/**
 * The remote listener's rate-accounting address: one well-formed `CF-Connecting-IP`, else one shared `unknown`
 * bucket. It names a bucket and an audit peer only — it never confers authority.
 */
export function clientAddress(req: IncomingMessage): string {
	const raw = req.headers["cf-connecting-ip"];
	return typeof raw === "string" && isIP(raw.trim()) !== 0 ? raw.trim() : "unknown";
}

export async function handlePairClaim(req: IncomingMessage, routes: DeviceRoutes, limiter: AttemptLimiter, now = new Date()): Promise<DevicesRouteResult> {
	const refuse = (status: number, error: string, headers?: Record<string, string>): DevicesRouteResult => ({ status, body: { error }, ...(headers ? { headers } : {}) });
	if (req.method !== "POST") return refuse(405, "POST only", { allow: "POST" });
	const address = clientAddress(req);
	if (!limiter.take(address, now.getTime())) return refuse(429, `too many pairing attempts: ${limiter.limit} per ${limiter.windowMs / 60_000} minutes`, { "retry-after": String(limiter.windowMs / 1000) });
	const binding = routes.binding();
	if (!binding) return refuse(503, "pairing is not available right now");
	if (req.headers.origin !== binding.origin) return refuse(403, `Origin must be ${binding.origin}`);
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin") return refuse(403, "cross-site request refused");
	if (!/^application\/json\s*(?:;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(415, "Content-Type must be application/json");
	const raw = await readBody(req, CLAIM_BODY_MAX_BYTES);
	if (raw === "too_large") return refuse(413, `body is larger than ${CLAIM_BODY_MAX_BYTES} bytes`, { connection: "close" });
	let value: unknown;
	try { value = JSON.parse(raw.toString("utf8")); } catch { return refuse(400, "body is not JSON"); }
	const body = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (!body || Object.keys(body).some((key) => key !== "code" && key !== "name" && key !== "level")) return refuse(400, 'body must be {"code", "name", "level"?}');
	const claimed = routes.store.claim({ ...binding, code: body.code, name: body.name, ...(body.level !== undefined ? { level: body.level } : {}), peer: address === "unknown" ? null : address });
	if (!claimed.ok) return storeRefusal(claimed);
	return { status: 200, body: { paired: true, name: claimed.device.name, level: claimed.device.level, redirect: "/" }, headers: { "set-cookie": sessionCookie(claimed.cookie) } };
}
