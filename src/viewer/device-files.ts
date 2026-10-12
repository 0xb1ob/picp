/**
 * Remote dashboard PR 1: the device store's schema, paths and read-only projections. `data/devices.json` (0600) holds
 * paired devices (a domain-separated SHA-256 of the session secret, never the secret), pending pairing codes (hash
 * only) and pairing events (the durable "new device paired" record every paired device is told about). Its one
 * writer is `src/viewer/device-store.ts`; everything else reads through `readDeviceState`, which fails closed: an
 * unreadable or malformed file is `invalid`, never an empty store.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { controlJournalFile } from "./control-files.ts";

export type DeviceLevel = "full" | "view";
export type IssuanceRoute = "cli-up" | "cli-pair" | "loopback-dashboard" | "tailnet-dashboard";

export const DEVICE_SCHEMA_VERSION = 1;
export const DEVICE_CODE_TTL_MS = 5 * 60_000;
export const DEVICE_MAX_PENDING_CODES = 3;
export const DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const DEVICE_COOKIE = "__Host-cp_device";
export const DEVICE_NAME_MAX = 80;
/** Codes and session secrets: 32 random bytes, base64url. */
export const DEVICE_SECRET_BYTES = 32;
export const DEVICE_ID_RE = /^dev-[0-9a-f]{16}$/;
export const PAIRING_ID_RE = /^pair-[0-9a-f]{16}$/;
export const DEVICE_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

const LEVELS: readonly string[] = ["full", "view"];
const ROUTES: readonly string[] = ["cli-up", "cli-pair", "loopback-dashboard", "tailnet-dashboard"];
const HEX64 = /^[0-9a-f]{64}$/;

export type DeviceRecord = {
	id: string; name: string; level: DeviceLevel; origin: string; generation: number; session_digest: string;
	/** `pending` until its pairing event is audited; a pending device never authenticates. */
	state: "pending" | "active";
	created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null; pairing_id: string;
};
export type PendingCode = { digest: string; origin: string; generation: number; level: DeviceLevel; route: IssuanceRoute; issued_at: string; expires_at: string };
export type PairingEvent = { id: string; at: string; device_id: string; name: string; level: DeviceLevel; route: IssuanceRoute; recipients: string[]; state: "pending" | "active" };
export type DeviceState = { schema_version: 1; devices: DeviceRecord[]; codes: PendingCode[]; events: PairingEvent[] };
/** A device without its digest: what lists, notices and access contexts see. */
export type DeviceView = Omit<DeviceRecord, "session_digest">;

export const devicesFile = (dataDir: string): string => join(dataDir, "devices.json");
export const emptyDeviceState = (): DeviceState => ({ schema_version: 1, devices: [], codes: [], events: [] });

/** Domain-separated digest: a code digest never verifies as a session digest. */
export const secretDigest = (kind: "code" | "session", secret: string): string => createHash("sha256").update(`cp-device-${kind}\0${secret}`).digest("hex");

export function digestEquals(a: string, b: string): boolean {
	return HEX64.test(a) && HEX64.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Trimmed, 1–80 characters, no control characters; undefined when unacceptable. */
export function deviceName(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const name = raw.trim();
	return name.length >= 1 && name.length <= DEVICE_NAME_MAX && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name) ? name : undefined;
}

export const isDeviceLevel = (value: unknown): value is DeviceLevel => typeof value === "string" && LEVELS.includes(value);
export const isIssuanceRoute = (value: unknown): value is IssuanceRoute => typeof value === "string" && ROUTES.includes(value);

/** An authenticated session may use the device: active, unrevoked, unexpired, and bound to the current origin generation. */
export function deviceEligible(device: DeviceRecord | DeviceView, now: Date, origin?: string, generation?: number): boolean {
	return device.state === "active" && device.revoked_at === null && Date.parse(device.expires_at) > now.getTime()
		&& (origin === undefined || device.origin === origin) && (generation === undefined || device.generation === generation);
}

/**
 * Remote dashboard push eligibility, re-read on every call: an owned subscription (`device_id`/`origin`) may receive a
 * push only while its device is active, unrevoked, unexpired and still on that origin. An unreadable store makes every
 * owned one ineligible (fail closed); a legacy unowned (local/tailnet) subscription is never affected.
 */
export function subscriptionEligibility(dataDir: string, now: Date): (subscription: { device_id?: string; origin?: string }) => boolean {
	const read = readDeviceState(dataDir);
	return (subscription) => subscription.device_id === undefined
		|| (read.state !== "invalid" && read.store.devices.some((device) => device.id === subscription.device_id && deviceEligible(device, now, subscription.origin)));
}

export const projectDevice = ({ session_digest: _digest, ...view }: DeviceRecord): DeviceView => view;

export type DeviceRead = { state: "absent"; store: DeviceState } | { state: "invalid"; reason: string } | { state: "ok"; store: DeviceState };

export function readDeviceState(dataDir: string): DeviceRead {
	const file = devicesFile(dataDir);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? { state: "absent", store: emptyDeviceState() } : { state: "invalid", reason: `${file}: ${code ?? "unreadable"}` };
	}
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { return { state: "invalid", reason: `${file}: not JSON` }; }
	const reason = deviceStateProblem(raw);
	return reason ? { state: "invalid", reason: `${file}: ${reason}` } : { state: "ok", store: raw as DeviceState };
}

const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const isOrigin = (value: unknown): value is string => typeof value === "string" && /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(value);
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first schema violation, or undefined for a valid v1 store. Strict: unknown shapes are refused, not repaired. */
export function deviceStateProblem(raw: unknown): string | undefined {
	if (!isObject(raw) || raw.schema_version !== DEVICE_SCHEMA_VERSION) return "schema_version is not 1";
	if (!Array.isArray(raw.devices) || !Array.isArray(raw.codes) || !Array.isArray(raw.events)) return "devices, codes and events must be arrays";
	const ids = new Set<string>();
	for (const [i, d] of raw.devices.entries()) {
		if (!isObject(d) || typeof d.id !== "string" || !DEVICE_ID_RE.test(d.id) || ids.has(d.id)) return `devices[${i}].id`;
		ids.add(d.id);
		if (deviceName(d.name) !== d.name) return `devices[${i}].name`;
		if (!isDeviceLevel(d.level)) return `devices[${i}].level`;
		if (!isOrigin(d.origin) || !isGeneration(d.generation)) return `devices[${i}].origin`;
		if (typeof d.session_digest !== "string" || !HEX64.test(d.session_digest)) return `devices[${i}].session_digest`;
		if (d.state !== "pending" && d.state !== "active") return `devices[${i}].state`;
		if (!isTime(d.created_at) || !isTime(d.last_seen_at) || !isTime(d.expires_at) || (d.revoked_at !== null && !isTime(d.revoked_at))) return `devices[${i}] times`;
		if (typeof d.pairing_id !== "string" || !PAIRING_ID_RE.test(d.pairing_id)) return `devices[${i}].pairing_id`;
	}
	for (const [i, c] of raw.codes.entries()) {
		if (!isObject(c) || typeof c.digest !== "string" || !HEX64.test(c.digest)) return `codes[${i}].digest`;
		if (!isOrigin(c.origin) || !isGeneration(c.generation) || !isDeviceLevel(c.level) || !isIssuanceRoute(c.route)) return `codes[${i}]`;
		if (!isTime(c.issued_at) || !isTime(c.expires_at)) return `codes[${i}] times`;
	}
	const events = new Set<string>();
	for (const [i, e] of raw.events.entries()) {
		if (!isObject(e) || typeof e.id !== "string" || !PAIRING_ID_RE.test(e.id) || events.has(e.id)) return `events[${i}].id`;
		events.add(e.id);
		if (!isTime(e.at) || typeof e.device_id !== "string" || !ids.has(e.device_id)) return `events[${i}].device_id`;
		if (deviceName(e.name) !== e.name || !isDeviceLevel(e.level) || !isIssuanceRoute(e.route)) return `events[${i}]`;
		if (!Array.isArray(e.recipients) || !e.recipients.every((id) => typeof id === "string" && ids.has(id))) return `events[${i}].recipients`;
		if (e.state !== "pending" && e.state !== "active") return `events[${i}].state`;
	}
	return undefined;
}

/**
 * Which of `wanted` pairing ids already have their `paired` audit line in `state/operator/dashboard.jsonl`. Reads the
 * journal in 1 MiB chunks, so memory stays bounded however long it grows. An unreadable journal is an error, never
 * "none found" (that would append a second success line).
 */
export function auditedPairings(stateDir: string, wanted: ReadonlySet<string>): { found: Set<string>; error: string | null } {
	const found = new Set<string>();
	if (!wanted.size) return { found, error: null };
	const file = controlJournalFile(stateDir);
	let fd: number;
	try { fd = openSync(file, "r"); } catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { found, error: code === "ENOENT" ? null : `${file}: ${code ?? "unreadable"}` };
	}
	try {
		const size = fstatSync(fd).size;
		let pending = Buffer.alloc(0);
		for (let offset = 0; offset < size;) {
			const buf = Buffer.alloc(Math.min(1024 * 1024, size - offset));
			const read = readSync(fd, buf, 0, buf.length, offset);
			if (!read) break;
			offset += read;
			const chunk = Buffer.concat([pending, buf.subarray(0, read)]);
			let start = 0;
			for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
				const row = chunk.subarray(start, end).toString("utf8");
				start = end + 1;
				if (!row.includes('"paired"')) continue;
				try {
					const line = JSON.parse(row) as Record<string, unknown>;
					if (line.type === "device" && line.event === "paired" && typeof line.pairing_id === "string" && wanted.has(line.pairing_id)) found.add(line.pairing_id);
				} catch { /* a torn or foreign line is not a pairing record */ }
			}
			pending = Buffer.from(chunk.subarray(start));
		}
		return { found, error: null };
	} catch (error) {
		return { found, error: `${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
	} finally {
		closeSync(fd);
	}
}
