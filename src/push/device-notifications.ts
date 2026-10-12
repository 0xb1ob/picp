/**
 * Remote dashboard PR 1d: the pairing-alert sender. It reads committed pairing events (data/devices.json, through
 * `readDeviceState`) and device-owned push subscriptions, and is the sole writer of its own ledger,
 * `state/device-notification-deliveries.json` (schema: src/viewer/device-notification-files.ts). It never writes
 * devices or subscriptions, never touches the ask ledger, and never fabricates an ask: a pairing alert is not an ask.
 *
 * One record per (pairing event, recipient). Every recipient — View-only and the newly paired device included — is
 * re-checked just before each attempt and each retry: a revoked or expired session (or, given a `binding`, one on a
 * superseded origin generation) settles `revoked`/`expired` and gets no newly initiated push. A send already in flight
 * when a revoke lands cannot be recalled; only later attempts stop. Push not set up is `unavailable`, no usable
 * subscription is `unsubscribed` — both stay open until the recipient's session ends, so a browser that enables push
 * later still gets its alert (no baseline). Retries reuse the ask sweep's classification and backoff (five network
 * attempts at most); a gone subscription is remembered as unusable here, never deleted. Exactly-once network delivery
 * is not available: a crash after a push service accepted a send but before the ledger write resends once, and the
 * service worker's per-pairing tag makes that a replacement rather than a second notification.
 *
 * Sweeps do not overlap (a sweep already running answers `busy`) and no lock is held across a network call: each
 * recipient's outcome is written as soon as it is known. The daemon's `device-notify` role (`./device-notify.ts`) runs
 * this every `DEVICE_NOTIFY_INTERVAL_MS` under a one-per-home lease.
 */
import { isoTimestamp } from "../contracts.ts";
import { atomicWriteJson } from "../json-store.ts";
import { deviceEligible, type PairingEvent, readDeviceState } from "../viewer/device-files.ts";
import {
	DEVICE_DELIVERY_ERROR_MAX, DEVICE_DELIVERY_FINAL, DEVICE_UNUSABLE_KEEP, type DeviceDelivery, type DeviceDeliveryState, deviceNotificationsError, deviceNotificationsFile, readDeviceNotifications,
} from "../viewer/device-notification-files.ts";
import { listSubscriptions, pushDataDir } from "../viewer/push-files.ts";
import { PUSH_MAX_ATTEMPTS, pushBackoffSeconds } from "./deliveries.ts";
import { readVapidKeys, type VapidKeys } from "./keys.ts";
import { sendOne } from "./sweep.ts";
import { type PushFetch, vapidAuthorization } from "./webpush.ts";

export const DEVICE_NOTIFY_INTERVAL_MS = 5_000;
/** Recipients attempted over the network per sweep; the rest wait for the next sweep, nothing is dropped. */
export const DEVICE_NOTIFY_MAX_SENDS_PER_SWEEP = 20;

export interface DeviceNotifyPorts {
	stateDir: string;
	dataDir?: string;
	now?: () => Date;
	fetch?: PushFetch;
	log?: (line: string) => void;
	/** The current remote binding, when known: a session on another origin or generation counts as expired. */
	binding?: () => { origin: string; generation: number } | null;
}

export interface DeviceNotifyReport {
	error?: string;
	busy?: true;
	/** Recipients sent to this sweep, and how those attempts settled. */
	attempted: number; delivered: number; retrying: number; failed: number;
	/** Open without an attempt: push not set up, no usable subscription, or backing off. */
	waiting: number;
	/** Settled because the recipient was revoked or expired before delivery. */
	ended: number;
}

/** The typed pairing payload: bounded public event fields only; the service worker opens Settings for it. */
export function pairingPayload(event: PairingEvent): string {
	return JSON.stringify({ type: "pairing", id: event.id, name: event.name.slice(0, 80), level: event.level, at: event.at });
}

const running = new Set<string>();
const FINAL: readonly DeviceDeliveryState[] = DEVICE_DELIVERY_FINAL;

export async function runDeviceNotifySweep(ports: DeviceNotifyPorts): Promise<DeviceNotifyReport> {
	const file = deviceNotificationsFile(ports.stateDir);
	const report: DeviceNotifyReport = { attempted: 0, delivered: 0, retrying: 0, failed: 0, waiting: 0, ended: 0 };
	if (running.has(file)) return { ...report, busy: true };
	running.add(file);
	try {
		return await sweep(ports, file, report);
	} catch (error) {
		const message = `pairing alerts stopped: ${(error as Error).message}`;
		ports.log?.(message);
		return { ...report, error: message };
	} finally {
		running.delete(file);
	}
}

async function sweep(ports: DeviceNotifyPorts, file: string, report: DeviceNotifyReport): Promise<DeviceNotifyReport> {
	const log = ports.log ?? (() => {});
	const now = (ports.now ?? (() => new Date()))();
	const at = isoTimestamp(now);
	const dataDir = ports.dataDir ?? pushDataDir(ports.stateDir);
	const fail = (message: string): DeviceNotifyReport => {
		log(message);
		return { ...report, error: message };
	};
	const devices = readDeviceState(dataDir);
	if (devices.state === "invalid") return fail(`pairing alerts not sent: ${devices.reason}`);
	// Never reset: an unreadable ledger stops the sender until a human looks, it is not an empty one.
	const read = readDeviceNotifications(ports.stateDir);
	if (read.state === "invalid") return fail(`pairing alerts not sent: ${read.reason}; refusing to guess`);
	const ledger = read.ledger;
	let keys: VapidKeys | undefined;
	let unavailable = "push is not set up on this home";
	try {
		keys = readVapidKeys(dataDir);
	} catch (error) {
		unavailable = `push setup is unreadable: ${(error as Error).message}`;
	}
	const write = (): void => {
		const reason = deviceNotificationsError(ledger);
		if (reason) throw new Error(`refusing to write an invalid ${file} (${reason})`);
		atomicWriteJson(file, ledger);
	};

	// Snapshot: one record per committed event and recipient. A record whose event left the device store goes with it.
	const events = new Map(devices.store.events.filter((event) => event.state === "active").map((event) => [event.id, event]));
	const known = new Map(ledger.items.map((item) => [`${item.pairing_id}:${item.device_id}`, item]));
	const items: DeviceDelivery[] = [];
	for (const event of events.values()) {
		for (const device_id of event.recipients) items.push(known.get(`${event.id}:${device_id}`) ?? { pairing_id: event.id, device_id, state: "pending", attempts: 0, delivered: 0, updated_at: at });
	}
	const grew = items.length !== ledger.items.length || items.some((item) => !known.has(`${item.pairing_id}:${item.device_id}`));
	ledger.items = items;
	// Durable before any network call: a new event's recipients are on record even if a push service hangs.
	if (grew) write();

	const settle = (item: DeviceDelivery, state: DeviceDeliveryState, error: string): void => {
		if (state === "revoked" || state === "expired") report.ended += 1;
		else report.waiting += 1;
		if (item.state === state && item.last_error === error && !item.targets && !item.next_attempt_at) return; // idle: no write
		Object.assign(item, { state, updated_at: at, last_error: error.slice(0, DEVICE_DELIVERY_ERROR_MAX) });
		delete item.targets;
		delete item.next_attempt_at;
		write();
	};
	const authorizations = new Map<string, string>();
	const authorizationFor = (endpoint: string): string => {
		// Only allowlisted (so parseable) endpoints reach here, and sendOne turns any throw into a rejected outcome.
		let origin: string;
		try {
			origin = new URL(endpoint).origin;
		} catch {
			throw new Error("endpoint is not a URL");
		}
		let value = authorizations.get(origin);
		if (!value) authorizations.set(origin, (value = vapidAuthorization({ endpoint, keys: keys as VapidKeys, now })));
		return value;
	};

	for (const item of items) {
		if (FINAL.includes(item.state)) continue;
		if (item.next_attempt_at && Date.parse(item.next_attempt_at) > now.getTime()) {
			report.waiting += 1;
			continue;
		}
		// Re-read just before this recipient's attempt: a revoke or expiry since the snapshot stops a newly initiated push.
		const fresh = readDeviceState(dataDir);
		if (fresh.state === "invalid") return fail(`pairing alerts paused: ${fresh.reason}`);
		const device = fresh.store.devices.find((candidate) => candidate.id === item.device_id);
		const binding = ports.binding?.() ?? undefined;
		if (!device || device.revoked_at !== null) {
			settle(item, "revoked", "the device was revoked before delivery");
			continue;
		}
		if (!deviceEligible(device, now, binding?.origin, binding?.generation)) {
			settle(item, "expired", "the device session expired, or its origin is no longer current, before delivery");
			continue;
		}
		if (!keys) {
			settle(item, "unavailable", unavailable);
			continue;
		}
		const owned = listSubscriptions(dataDir).items.filter((subscription) => subscription.device_id === device.id);
		const onOrigin = owned.filter((subscription) => subscription.origin === device.origin);
		const usable = onOrigin.filter((subscription) => !ledger.unusable.includes(subscription.id) && (!item.targets || item.targets.includes(subscription.id)));
		if (usable.length === 0) {
			settle(item, "unsubscribed", owned.length === 0 ? "no push subscription on this device" : onOrigin.length === 0 ? "its push subscription is for another origin" : "its push subscription was refused as gone; enable notifications again");
			continue;
		}
		if (report.attempted >= DEVICE_NOTIFY_MAX_SENDS_PER_SWEEP) {
			report.waiting += 1;
			continue;
		}
		report.attempted += 1;
		const payload = pairingPayload(events.get(item.pairing_id) as PairingEvent);
		const outcomes = await Promise.all(usable.map((target) => sendOne(target, payload, authorizationFor, ports.fetch)));
		const retry: string[] = [];
		const causes: string[] = [];
		outcomes.forEach((outcome, index) => {
			const target = usable[index]!;
			if (outcome.kind === "delivered") {
				item.delivered += 1;
				return;
			}
			const reason = outcome.kind === "gone" ? `HTTP ${outcome.status}, subscription unusable` : outcome.reason;
			log(`pairing alert ${item.pairing_id} → ${item.device_id} (${target.id.slice(0, 8)}): ${outcome.kind} (${reason})`);
			causes.push(`${target.id.slice(0, 8)} ${outcome.kind}: ${reason}`);
			if (outcome.kind === "retry") retry.push(target.id);
			if (outcome.kind === "gone") ledger.unusable = [...ledger.unusable.filter((id) => id !== target.id), target.id].slice(-DEVICE_UNUSABLE_KEEP);
		});
		item.attempts += 1;
		item.updated_at = at;
		if (causes.length > 0) item.last_error = causes.join("; ").slice(0, DEVICE_DELIVERY_ERROR_MAX);
		delete item.targets;
		delete item.next_attempt_at;
		if (item.delivered > 0) {
			item.state = "delivered";
			report.delivered += 1;
		} else if (retry.length > 0 && item.attempts < PUSH_MAX_ATTEMPTS) {
			item.state = "retrying";
			item.targets = retry;
			item.next_attempt_at = isoTimestamp(new Date(now.getTime() + pushBackoffSeconds(item.attempts) * 1000));
			report.retrying += 1;
		} else {
			item.state = "failed";
			report.failed += 1;
		}
		write();
	}
	return report;
}
