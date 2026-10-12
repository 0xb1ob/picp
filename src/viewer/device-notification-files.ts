/**
 * Remote dashboard PR 1d: the pairing-alert delivery ledger, `state/device-notification-deliveries.json` — its schema
 * and the read-only projection the notices route and the sender share. Its sole writer is the sender
 * (src/push/device-notifications.ts); it is separate from the ask ledger (push-deliveries.json) and holds no push
 * secret, endpoint or key: pairing ids, device ids, subscription ids and bounded error text only. Reads fail closed:
 * an unreadable or malformed ledger is `invalid`, never an empty one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_ID_RE, PAIRING_ID_RE } from "./device-files.ts";

export const deviceNotificationsFile = (stateDir: string): string => join(stateDir, "device-notification-deliveries.json");

/** Still being worked (re-checked every sweep): not yet tried, no usable subscription, push not set up, backing off. */
export const DEVICE_DELIVERY_OPEN = ["pending", "unsubscribed", "unavailable", "retrying"] as const;
/** Settled: accepted by a push service, refused or exhausted, or the recipient's session ended first. */
export const DEVICE_DELIVERY_FINAL = ["delivered", "failed", "expired", "revoked"] as const;
export type DeviceDeliveryState = (typeof DEVICE_DELIVERY_OPEN)[number] | (typeof DEVICE_DELIVERY_FINAL)[number];
export const DEVICE_DELIVERY_ERROR_MAX = 300;
/** Subscriptions a push service called gone, remembered so no later alert retries them (the sender never deletes them). */
export const DEVICE_UNUSABLE_KEEP = 256;

/** One recipient of one pairing event. `targets` are the subscription ids still owed a retry. */
export interface DeviceDelivery {
	pairing_id: string;
	device_id: string;
	state: DeviceDeliveryState;
	attempts: number;
	delivered: number;
	updated_at: string;
	next_attempt_at?: string;
	targets?: string[];
	last_error?: string;
}
export interface DeviceNotificationLedger { schema_version: 1; items: DeviceDelivery[]; unusable: string[] }
export type DeviceNotificationRead = { state: "absent" | "ok"; ledger: DeviceNotificationLedger } | { state: "invalid"; reason: string };

const STATES: readonly string[] = [...DEVICE_DELIVERY_OPEN, ...DEVICE_DELIVERY_FINAL];
const SUBSCRIPTION_ID = /^[0-9a-f]{32}$/;
const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** Why `raw` is not a valid ledger, or undefined. The writer validates with this too. */
export function deviceNotificationsError(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) return "not an object";
	const ledger = raw as Record<string, unknown>;
	if (ledger.schema_version !== 1) return "schema_version";
	if (!Array.isArray(ledger.unusable) || ledger.unusable.length > DEVICE_UNUSABLE_KEEP || !ledger.unusable.every((id) => typeof id === "string" && SUBSCRIPTION_ID.test(id))) return "unusable";
	if (!Array.isArray(ledger.items)) return "items";
	const seen = new Set<string>();
	for (const [i, item] of ledger.items.entries()) {
		const d = item as Record<string, unknown>;
		if (typeof item !== "object" || item === null || typeof d.pairing_id !== "string" || !PAIRING_ID_RE.test(d.pairing_id) || typeof d.device_id !== "string" || !DEVICE_ID_RE.test(d.device_id)) return `items[${i}]`;
		const key = `${d.pairing_id}:${d.device_id}`;
		if (seen.has(key)) return `items[${i}] duplicates ${key}`;
		seen.add(key);
		if (typeof d.state !== "string" || !STATES.includes(d.state) || !isCount(d.attempts) || !isCount(d.delivered) || !isTime(d.updated_at)) return `items[${i}]`;
		if ((d.next_attempt_at !== undefined && !isTime(d.next_attempt_at)) || (d.last_error !== undefined && (typeof d.last_error !== "string" || d.last_error.length > DEVICE_DELIVERY_ERROR_MAX))) return `items[${i}]`;
		if (d.targets !== undefined && (!Array.isArray(d.targets) || !d.targets.every((id) => typeof id === "string" && SUBSCRIPTION_ID.test(id)))) return `items[${i}].targets`;
	}
	return undefined;
}

export function readDeviceNotifications(stateDir: string): DeviceNotificationRead {
	const file = deviceNotificationsFile(stateDir);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? { state: "absent", ledger: { schema_version: 1, items: [], unusable: [] } } : { state: "invalid", reason: `${file} is unreadable (${code ?? "error"})` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { state: "invalid", reason: `${file} is not valid JSON` };
	}
	const reason = deviceNotificationsError(raw);
	return reason ? { state: "invalid", reason: `${file} is malformed (${reason})` } : { state: "ok", ledger: raw as DeviceNotificationLedger };
}
