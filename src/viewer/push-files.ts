/**
 * Web Push files (Pier 1.1), read-only: where they live and how a reader tells a
 * good one from a bad one. Shared by the parent's push sweep (src/push/), `/doctor`
 * and the viewer, so every reader agrees on one layout:
 *
 *   data/push/config.json               public: origin, subject, VAPID public key
 *   data/push/vapid.key                 0600: the private JWK — never read here
 *   data/push/subscriptions/<id>.json   0600: one browser subscription per file
 *   state/push-deliveries.json          the parent's delivery ledger
 *
 * Nothing in this file writes, and nothing it returns carries key material.
 */

import { createHash, ECDH } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { num, obj, readObject, str } from "./sessions.ts";

/** Devices one home may subscribe. */
export const PUSH_MAX_SUBSCRIPTIONS = 10;
/** Subscription files a reader looks at, at most. */
const SUBSCRIPTION_SCAN_LIMIT = 50;
export const PUSH_ENDPOINT_MAX_CHARS = 1024;
/** Push services a subscription may name (SSRF guard): an exact host, or a `.suffix`. */
export const PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = ["fcm.googleapis.com", ".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

export const pushDataDir = (stateDir: string): string => join(dirname(stateDir), "data");
export const pushConfigFile = (dataDir: string): string => join(dataDir, "push", "config.json");
export const vapidKeyFile = (dataDir: string): string => join(dataDir, "push", "vapid.key");
export const subscriptionsDir = (dataDir: string): string => join(dataDir, "push", "subscriptions");
export const subscriptionFile = (dataDir: string, id: string): string => join(subscriptionsDir(dataDir), `${id}.json`);
export const pushDeliveriesFile = (stateDir: string): string => join(stateDir, "push-deliveries.json");
export const subscriptionId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

export interface PushConfig {
	origin: string;
	subject: string;
	/** base64url of the uncompressed 65-byte P-256 point. */
	public_key: string;
	created_at: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const decoded = (value: string): Buffer | undefined => (B64URL.test(value) ? Buffer.from(value, "base64url") : undefined);

/** The public push config, or undefined when missing or malformed. Never the private key. */
export function readPushConfig(dataDir: string): PushConfig | undefined {
	const raw = readObject(pushConfigFile(dataDir));
	const origin = str(raw?.origin);
	const subject = str(raw?.subject);
	const publicKey = str(raw?.public_key);
	const createdAt = str(raw?.created_at);
	if (!origin || !subject || !publicKey || !createdAt || decoded(publicKey)?.length !== 65) return undefined;
	return { origin, subject, public_key: publicKey, created_at: createdAt };
}

/** An `https:` endpoint on a known push service, default port, no credentials. */
export function pushServiceAllowed(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || endpoint.length > PUSH_ENDPOINT_MAX_CHARS) return false;
	const host = url.hostname.toLowerCase();
	return PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => (suffix.startsWith(".") ? host.endsWith(suffix) && host.length > suffix.length : host === suffix));
}

export interface PushSubscriptionKeys {
	p256dh: string;
	auth: string;
}
export interface PushSubscriptionInput {
	endpoint: string;
	keys?: PushSubscriptionKeys;
}
export type ParsedSubscription = { ok: true; value: PushSubscriptionInput } | { ok: false; reason: string };

/**
 * A browser's `PushSubscription.toJSON()` shape: `{endpoint, keys: {p256dh, auth}}` to subscribe, `{endpoint}` to
 * unsubscribe. Shape only — the push-service allowlist is `pushServiceAllowed`, checked separately by each caller.
 */
export function parseSubscription(value: unknown, mode: "subscribe" | "unsubscribe"): ParsedSubscription {
	const body = obj(value);
	const endpoint = str(body?.endpoint);
	if (!endpoint) return { ok: false, reason: "endpoint is missing" };
	if (endpoint.length > PUSH_ENDPOINT_MAX_CHARS) return { ok: false, reason: `endpoint is longer than ${PUSH_ENDPOINT_MAX_CHARS} characters` };
	if (!endpoint.startsWith("https://")) return { ok: false, reason: "endpoint must be https:" };
	if (mode === "unsubscribe") return { ok: true, value: { endpoint } };
	const keys = obj(body?.keys);
	const p256dh = str(keys?.p256dh);
	const auth = str(keys?.auth);
	const point = p256dh ? decoded(p256dh) : undefined;
	if (!p256dh || point?.length !== 65) return { ok: false, reason: "keys.p256dh must be a base64url 65-byte P-256 public key" };
	try {
		ECDH.convertKey(point, "prime256v1"); // refuses a point that is not on the curve
	} catch {
		return { ok: false, reason: "keys.p256dh is not a point on P-256" };
	}
	if (!auth || decoded(auth)?.length !== 16) return { ok: false, reason: "keys.auth must be a base64url 16-byte secret" };
	return { ok: true, value: { endpoint, keys: { p256dh, auth } } };
}

export interface StoredSubscription {
	id: string;
	endpoint: string;
	keys: PushSubscriptionKeys;
	created_at: string;
}

/** Valid subscription files (sorted by id) and how many were not. A missing directory is zero devices. */
export function listSubscriptions(dataDir: string): { items: StoredSubscription[]; invalid: number } {
	let names: string[];
	try {
		names = readdirSync(subscriptionsDir(dataDir)).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return { items: [], invalid: 0 };
	}
	const items: StoredSubscription[] = [];
	let invalid = 0;
	for (const name of names.slice(0, SUBSCRIPTION_SCAN_LIMIT)) {
		const raw = readObject(join(subscriptionsDir(dataDir), name));
		const parsed = parseSubscription(raw, "subscribe");
		const createdAt = str(raw?.created_at);
		if (!parsed.ok || !parsed.value.keys || !createdAt || `${subscriptionId(parsed.value.endpoint)}.json` !== name || raw?.id !== name.slice(0, -5)) {
			invalid += 1;
			continue;
		}
		items.push({ id: name.slice(0, -5), endpoint: parsed.value.endpoint, keys: parsed.value.keys, created_at: createdAt });
	}
	return { items, invalid: invalid + Math.max(0, names.length - SUBSCRIPTION_SCAN_LIMIT) };
}

export interface PushDeliverySummary {
	last_sent_at: string | null;
	/** Failed in the last 24 h, or still retrying after a failed attempt. */
	undelivered_24h: number;
	last_error: string | null;
}

/**
 * A lenient summary of the delivery ledger: `undefined` when there is none yet, `null` when it cannot be read.
 * Never a record's targets or anything a device could be identified by beyond what the ledger holds.
 */
export function readDeliverySummary(stateDir: string, now: Date): PushDeliverySummary | null | undefined {
	const file = pushDeliveriesFile(stateDir);
	const raw = readObject(file);
	if (!raw) return existsSync(file) ? null : undefined;
	if (!Array.isArray(raw.items)) return null;
	const since = now.getTime() - 24 * 3600_000;
	let lastSent: string | null = null;
	let undelivered = 0;
	let lastError: { at: string; text: string } | undefined;
	for (const item of raw.items.map(obj)) {
		if (!item) continue;
		const status = str(item.status);
		const settled = str(item.settled_at);
		if (status === "sent" && settled && (!lastSent || settled > lastSent)) lastSent = settled;
		const failedRecently = status === "failed" && settled !== undefined && Date.parse(settled) >= since;
		const retrying = status === "pending" && (num(item.attempts) ?? 0) > 0;
		if (!failedRecently && !retrying) continue;
		undelivered += 1;
		const at = settled ?? str(item.created_at) ?? "";
		const text = str(item.last_error);
		if (text && (!lastError || at >= lastError.at)) lastError = { at, text };
	}
	return { last_sent_at: lastSent, undelivered_24h: undelivered, last_error: lastError?.text ?? null };
}
