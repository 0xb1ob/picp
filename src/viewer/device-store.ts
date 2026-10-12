/**
 * Remote dashboard PR 1: the one writer of `data/devices.json` (0600, dir 0700). Every operation is synchronous
 * read → change → atomic replace (exclusive temp, fsync, rename, directory fsync), so inside the viewer process
 * they serialize and two concurrent claims of one code have exactly one winner. The CLI reaches it through the
 * viewer's owner socket (a later PR), never by writing the file itself.
 *
 * A successful pairing is three commits: (1) consume the code and store the device and its pairing event as
 * `pending`; (2) append the secret-free `paired` audit line carrying the event id; (3) mark both `active` and only
 * then hand out the cookie. `recover()` finishes any pairing stuck between them: it appends the audit line only when
 * the journal lacks that id, then activates — one logical pairing, never a second device or a revived code.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { appendControlAudit } from "./control-audit.ts";
import type { ControlAuditLine } from "./control-files.ts";
import {
	auditedPairings, DEVICE_CODE_TTL_MS, DEVICE_COOKIE, DEVICE_ID_RE, DEVICE_MAX_PENDING_CODES, DEVICE_SECRET_BYTES, DEVICE_SECRET_RE,
	DEVICE_SESSION_TTL_MS, deviceEligible, deviceName, type DeviceLevel, type DeviceRecord, type DeviceState, deviceStateProblem,
	devicesFile, type DeviceView, digestEquals, isDeviceLevel, type IssuanceRoute, type PairingEvent, projectDevice, readDeviceState, secretDigest,
} from "./device-files.ts";

export type DeviceAuditLine = Extract<ControlAuditLine, { type: "device" }>;
export type DeviceStorePorts = {
	now?: () => Date;
	random?: (bytes: number) => Buffer;
	audit?: (line: DeviceAuditLine) => { ok: true } | { ok: false; error: string };
	/** Test seam: throws here simulate a crash right after that commit. */
	crash?: (stage: "pending_written" | "audited") => void;
};
export type DeviceRefusal =
	| "store_invalid" | "write_failed" | "audit_failed" | "too_many_codes" | "bad_input"
	| "code_invalid" | "code_expired" | "origin_mismatch" | "level_mismatch" | "name_invalid" | "name_taken"
	| "not_found" | "ambiguous" | "no_session" | "session_invalid";
export type DeviceFailure = { ok: false; reason: DeviceRefusal; detail?: string };

type Binding = { origin: string; generation: number };

/** `__Host-` cookie: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, 30-day sliding Max-Age. */
export const sessionCookie = (value: string): string =>
	`${DEVICE_COOKIE}=${value}; Max-Age=${DEVICE_SESSION_TTL_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Strict`;

export class DeviceStore {
	private readonly dataDir: string;
	private readonly stateDir: string;
	private readonly now: () => Date;
	private readonly random: (bytes: number) => Buffer;
	private readonly audit: (line: DeviceAuditLine) => { ok: true } | { ok: false; error: string };
	private readonly crash: (stage: "pending_written" | "audited") => void;

	constructor(dataDir: string, stateDir: string, ports: DeviceStorePorts = {}) {
		this.dataDir = dataDir;
		this.stateDir = stateDir;
		this.now = ports.now ?? (() => new Date());
		this.random = ports.random ?? randomBytes;
		this.audit = ports.audit ?? ((line) => appendControlAudit(stateDir, line));
		this.crash = ports.crash ?? (() => {});
	}

	/** Issue one pairing code (terminal or eligible local browser only — the caller's gate). The secret is returned once, never stored or audited. */
	issueCode(input: Binding & { route: IssuanceRoute; level?: DeviceLevel; peer?: string | null }): { ok: true; code: string; level: DeviceLevel; expires_at: string } | DeviceFailure {
		const level = input.level ?? "full";
		if (!isDeviceLevel(level)) return { ok: false, reason: "bad_input", detail: "level" };
		const loaded = this.load();
		if (!loaded.ok) return loaded;
		const store = loaded.store;
		const now = this.now();
		if (store.codes.length >= DEVICE_MAX_PENDING_CODES) return { ok: false, reason: "too_many_codes" };
		const code = this.random(DEVICE_SECRET_BYTES).toString("base64url");
		const expires_at = new Date(now.getTime() + DEVICE_CODE_TTL_MS).toISOString();
		const before = store.codes;
		store.codes = [...before, { digest: secretDigest("code", code), origin: input.origin, generation: input.generation, level, route: input.route, issued_at: now.toISOString(), expires_at }];
		const saved = this.save(store);
		if (!saved.ok) return saved;
		const audited = this.audit({ ...this.line("code_issued", input.peer, null), level, route: input.route });
		if (!audited.ok) {
			store.codes = before; // an unaudited code must not stay claimable
			this.save(store);
			return { ok: false, reason: "audit_failed" };
		}
		return { ok: true, code, level, expires_at };
	}

	/** Consume a code and pair a device. Only a fully audited, activated pairing returns a cookie value. */
	claim(input: Binding & { code: unknown; name: unknown; level?: unknown; peer?: string | null }): { ok: true; device: DeviceView; cookie: string; pairing_id: string } | DeviceFailure {
		const refuse = (reason: DeviceRefusal): DeviceFailure => {
			this.audit(this.line("claim_refused", input.peer, reason));
			return { ok: false, reason };
		};
		if (typeof input.code !== "string" || !DEVICE_SECRET_RE.test(input.code)) return refuse("code_invalid");
		const loaded = this.load();
		if (!loaded.ok) return loaded;
		const store = loaded.store;
		const now = this.now();
		const digest = secretDigest("code", input.code);
		let index = -1;
		store.codes.forEach((code, i) => { if (digestEquals(code.digest, digest)) index = i; });
		if (index === -1) {
			// The expired codes `load` pruned are refused as expired, not unknown; nothing is written for them here.
			return refuse(loaded.expired.some((code) => digestEquals(code.digest, digest)) ? "code_expired" : "code_invalid");
		}
		const code = store.codes[index]!;
		if (code.origin !== input.origin || code.generation !== input.generation) return refuse("origin_mismatch");
		if (input.level !== undefined && input.level !== code.level) return refuse("level_mismatch");
		const name = deviceName(input.name);
		if (name === undefined) return refuse("name_invalid");
		if (store.devices.some((device) => device.revoked_at === null && device.name.toLowerCase() === name.toLowerCase())) return refuse("name_taken");
		const secret = this.random(DEVICE_SECRET_BYTES).toString("base64url");
		const id = `dev-${this.random(8).toString("hex")}`;
		const pairing_id = `pair-${this.random(8).toString("hex")}`;
		const at = now.toISOString();
		const device: DeviceRecord = {
			id, name, level: code.level, origin: code.origin, generation: code.generation, session_digest: secretDigest("session", secret), state: "pending",
			created_at: at, last_seen_at: at, expires_at: new Date(now.getTime() + DEVICE_SESSION_TTL_MS).toISOString(), revoked_at: null, pairing_id,
		};
		const recipients = [...store.devices.filter((other) => deviceEligible(other, now)).map((other) => other.id), id];
		const event: PairingEvent = { id: pairing_id, at, device_id: id, name, level: code.level, route: code.route, recipients, state: "pending" };
		store.codes.splice(index, 1);
		store.devices.push(device);
		store.events.push(event);
		const pending = this.save(store);
		if (!pending.ok) return pending;
		this.crash("pending_written");
		const audited = this.audit(this.pairedLine(event, input.peer ?? null));
		if (!audited.ok) return { ok: false, reason: "audit_failed" };
		this.crash("audited");
		device.state = "active";
		event.state = "active";
		const active = this.save(store);
		if (!active.ok) return active;
		return { ok: true, device: projectDevice(device), cookie: `${id}.${secret}`, pairing_id };
	}

	/**
	 * Check a session cookie value against the current origin generation. `touch` (every real request) slides
	 * last-seen and the 30-day expiry and commits before the caller answers; a stream check passes `touch: false`.
	 */
	authenticate(value: string | undefined, binding: Binding, options: { touch: boolean; peer?: string | null }): { ok: true; device: DeviceView } | DeviceFailure {
		if (value === undefined || value === "") return { ok: false, reason: "no_session" };
		const refuse = (): DeviceFailure => {
			this.audit(this.line("signin_refused", options.peer, "session_invalid"));
			return { ok: false, reason: "session_invalid" };
		};
		const [id, secret, extra] = value.split(".");
		if (extra !== undefined || !id || !DEVICE_ID_RE.test(id) || !secret || !DEVICE_SECRET_RE.test(secret)) return refuse();
		const loaded = this.load();
		if (!loaded.ok) return loaded;
		const now = this.now();
		const device = loaded.store.devices.find((item) => item.id === id);
		if (!device || !digestEquals(device.session_digest, secretDigest("session", secret)) || !deviceEligible(device, now, binding.origin, binding.generation)) return refuse();
		if (options.touch) {
			device.last_seen_at = now.toISOString();
			device.expires_at = new Date(now.getTime() + DEVICE_SESSION_TTL_MS).toISOString();
			const saved = this.save(loaded.store);
			if (!saved.ok) return saved;
		}
		return { ok: true, device: projectDevice(device) };
	}

	/** Revoke by public id or (case-insensitive) name. The row stays, marked; the revocation stands even if its audit line fails. */
	revoke(target: string, peer?: string | null): { ok: true; device: DeviceView; audit_error: string | null } | DeviceFailure {
		const loaded = this.load();
		if (!loaded.ok) return loaded;
		const live = loaded.store.devices.filter((device) => device.revoked_at === null);
		const byId = live.filter((device) => device.id === target);
		const matches = byId.length ? byId : live.filter((device) => device.name.toLowerCase() === target.trim().toLowerCase());
		if (matches.length === 0) return { ok: false, reason: "not_found" };
		if (matches.length > 1) return { ok: false, reason: "ambiguous" };
		const device = matches[0]!;
		device.revoked_at = this.now().toISOString();
		const saved = this.save(loaded.store);
		if (!saved.ok) return saved;
		const audited = this.audit({ ...this.line("revoked", peer, null), device_id: device.id, name: device.name, level: device.level });
		return { ok: true, device: projectDevice(device), audit_error: audited.ok ? null : audited.error };
	}

	/** The read model: devices without digests, committed (active) pairing events, live code count. */
	list(): { ok: true; devices: DeviceView[]; events: PairingEvent[]; pending_codes: number } | DeviceFailure {
		const loaded = this.load();
		if (!loaded.ok) return loaded;
		return { ok: true, devices: loaded.store.devices.map(projectDevice), events: loaded.store.events.filter((event) => event.state === "active"), pending_codes: loaded.store.codes.length };
	}

	/** Startup reconciliation: finish every pairing left `pending` by a crash or a failed audit/activation write. */
	recover(): { ok: true; recovered: string[] } | DeviceFailure {
		const loaded = this.load();
		if (!loaded.ok) return loaded;
		const store = loaded.store;
		const pending = store.events.filter((event) => event.state === "pending");
		if (!pending.length) return { ok: true, recovered: [] };
		const journal = auditedPairings(this.stateDir, new Set(pending.map((event) => event.id)));
		if (journal.error) return { ok: false, reason: "audit_failed", detail: journal.error };
		for (const event of pending) {
			if (!journal.found.has(event.id)) {
				const audited = this.audit(this.pairedLine(event, null));
				if (!audited.ok) return { ok: false, reason: "audit_failed" };
			}
			event.state = "active";
			const device = store.devices.find((item) => item.id === event.device_id);
			if (device) device.state = "active";
		}
		const saved = this.save(store);
		return saved.ok ? { ok: true, recovered: pending.map((event) => event.id) } : saved;
	}

	private line(event: DeviceAuditLine["event"], peer: string | null | undefined, reason: string | null): DeviceAuditLine {
		return { type: "device", by: "viewer", id: null, at: this.now().toISOString(), peer: peer ?? null, event, reason };
	}

	private pairedLine(event: PairingEvent, peer: string | null): DeviceAuditLine {
		return { ...this.line("paired", peer, null), pairing_id: event.id, device_id: event.device_id, name: event.name, level: event.level, route: event.route };
	}

	/** The current store with expired codes pruned (in memory; the next write drops them). Malformed storage refuses. */
	private load(): { ok: true; store: DeviceState; expired: DeviceState["codes"] } | DeviceFailure {
		const read = readDeviceState(this.dataDir);
		if (read.state === "invalid") return { ok: false, reason: "store_invalid", detail: read.reason };
		const now = this.now().getTime();
		const expired = read.store.codes.filter((code) => Date.parse(code.expires_at) <= now);
		read.store.codes = read.store.codes.filter((code) => Date.parse(code.expires_at) > now);
		return { ok: true, store: read.store, expired };
	}

	private save(store: DeviceState): { ok: true } | DeviceFailure {
		const problem = deviceStateProblem(store);
		if (problem) return { ok: false, reason: "bad_input", detail: problem };
		const file = devicesFile(this.dataDir);
		const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			const buffer = Buffer.from(`${JSON.stringify(store)}\n`, "utf8");
			const fd = openSync(tmp, "wx", 0o600);
			try {
				if (writeSync(fd, buffer, 0, buffer.length) !== buffer.length) throw new Error("short write");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, file);
			const dir = openSync(dirname(file), "r");
			try { fsyncSync(dir); } finally { closeSync(dir); }
			return { ok: true };
		} catch (error) {
			rmSync(tmp, { force: true });
			return { ok: false, reason: "write_failed", detail: (error as NodeJS.ErrnoException).code ?? (error as Error).message };
		}
	}
}
