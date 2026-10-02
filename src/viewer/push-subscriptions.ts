/**
 * The viewer's one request-time write (Pier 1.1): this browser's Web Push subscription, one file per device
 * under `data/push/subscriptions/` (dir 0700, file 0600). Every write is a single create+rename or unlink —
 * no read-modify-write — because the parent's push sweep deletes files here on 404/410 from another process.
 * Callers validate first (`parseSubscription`, `pushServiceAllowed`); this module only places the file.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { listSubscriptions, PUSH_MAX_SUBSCRIPTIONS, type PushSubscriptionKeys, subscriptionFile, subscriptionId, subscriptionsDir } from "./push-files.ts";

export type SaveSubscriptionResult = { ok: true; created: boolean; devices: number } | { ok: false; devices: number };

/** Store (or refresh) one device. Refuses a new device past `PUSH_MAX_SUBSCRIPTIONS`; throws on a write error. */
export function saveSubscription(dataDir: string, subscription: { endpoint: string; keys: PushSubscriptionKeys }, now: Date): SaveSubscriptionResult {
	const id = subscriptionId(subscription.endpoint);
	const devices = listSubscriptions(dataDir).items;
	const known = devices.find((item) => item.id === id);
	if (!known && devices.length >= PUSH_MAX_SUBSCRIPTIONS) return { ok: false, devices: devices.length };
	mkdirSync(subscriptionsDir(dataDir), { recursive: true, mode: 0o700 });
	const file = subscriptionFile(dataDir, id);
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const record = { schema_version: 1, id, endpoint: subscription.endpoint, keys: subscription.keys, created_at: known?.created_at ?? now.toISOString() };
	try {
		writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(tmp, file);
	} finally {
		rmSync(tmp, { force: true });
	}
	return { ok: true, created: !known, devices: known ? devices.length : devices.length + 1 };
}

/** Remove one device; whether it was stored. */
export function deleteSubscription(dataDir: string, endpoint: string): boolean {
	const file = subscriptionFile(dataDir, subscriptionId(endpoint));
	const existed = existsSync(file);
	rmSync(file, { force: true });
	return existed;
}
