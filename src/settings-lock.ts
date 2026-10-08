/**
 * `state/settings.lock` (cp-7bsr PR2): one settings transaction per home at a time.
 *
 * A minimal clone of src/parent-lock.ts: an O_EXCL plain file that fails closed (unreadable or
 * unparseable is a refusal naming the path), reclaims only a dead holder after re-reading the exact
 * record it classified (the nonce), and lets only the holder release it. The transaction it guards
 * is synchronous (src/settings-write.ts), so the lock is held for milliseconds.
 */

import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { isoTimestamp, LAYOUT } from "./contracts.ts";
import { isPidAlive as probePid } from "./fleet.ts";

export interface SettingsLockRecord {
	schema_version: 1;
	pid: number;
	started_at: string;
	nonce: string;
}

export type SettingsLockResult =
	| { ok: true; release(): boolean; reclaimed?: SettingsLockRecord }
	| { ok: false; reason: string; holder?: SettingsLockRecord };

export interface SettingsLockOptions {
	pid?: number;
	now?: () => Date;
	isPidAlive?: (pid: number) => boolean;
	/** Test seam: called once, immediately before a dead holder's lock would be removed. */
	onBeforeReclaim?: () => void;
}

export function settingsLockPath(home: string): string {
	return join(home, LAYOUT.state, "settings.lock");
}

type Read = { state: "absent" } | { state: "held"; record: SettingsLockRecord } | { state: "unreadable"; reason: string };

function readLock(path: string): Read {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "unreadable", reason: `${path} is unreadable: ${(error as Error).message}` };
	}
	try {
		const value = JSON.parse(text) as Partial<SettingsLockRecord>;
		if (value && Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.started_at === "string" && typeof value.nonce === "string" && value.nonce.length > 0) {
			return { state: "held", record: { schema_version: 1, pid: value.pid as number, started_at: value.started_at, nonce: value.nonce } };
		}
	} catch {
		// fall through: not a lock this build wrote
	}
	return { state: "unreadable", reason: `${path} is not a settings lock this build wrote (${text.trim().slice(0, 120) || "empty file"}); remove it if no settings write is running` };
}

export function acquireSettingsLock(home: string, options: SettingsLockOptions = {}): SettingsLockResult {
	const path = settingsLockPath(home);
	const isAlive = options.isPidAlive ?? probePid;
	const record: SettingsLockRecord = { schema_version: 1, pid: options.pid ?? process.pid, started_at: isoTimestamp(options.now?.() ?? new Date()), nonce: randomBytes(8).toString("hex") };
	const release = (): boolean => {
		const current = readLock(path);
		if (current.state !== "held" || current.record.nonce !== record.nonce) return false;
		try {
			unlinkSync(path);
			return true;
		} catch {
			return false;
		}
	};
	const write = (): { ok: true } | { ok: false; exists: boolean; reason: string } => {
		try {
			mkdirSync(dirname(path), { recursive: true });
			const fd = openSync(path, "wx", 0o600);
			try {
				writeSync(fd, `${JSON.stringify(record)}\n`);
			} finally {
				closeSync(fd);
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, exists: (error as NodeJS.ErrnoException).code === "EEXIST", reason: (error as Error).message };
		}
	};

	const first = write();
	if (first.ok) return { ok: true, release };
	if (!first.exists) return { ok: false, reason: `cannot take the settings lock at ${path}: ${first.reason}` };
	const current = readLock(path);
	if (current.state === "unreadable") return { ok: false, reason: current.reason };
	if (current.state === "absent") {
		const retry = write();
		return retry.ok ? { ok: true, release } : { ok: false, reason: `lost a race for the settings lock at ${path}: ${retry.reason}` };
	}
	if (isAlive(current.record.pid)) return { ok: false, holder: current.record, reason: `another settings write holds ${path} (pid ${current.record.pid}, since ${current.record.started_at}); retry` };
	const stale = current.record;
	options.onBeforeReclaim?.();
	const confirm = readLock(path);
	if (confirm.state === "held" && confirm.record.nonce === stale.nonce) {
		try {
			unlinkSync(path);
		} catch (error) {
			return { ok: false, holder: stale, reason: `cannot reclaim the stale settings lock at ${path}: ${(error as Error).message}` };
		}
	} else if (confirm.state !== "absent") {
		return { ok: false, ...(confirm.state === "held" ? { holder: confirm.record } : {}), reason: `the stale settings lock at ${path} changed while it was being reclaimed; retry` };
	}
	const reclaimed = write();
	return reclaimed.ok ? { ok: true, release, reclaimed: stale } : { ok: false, holder: stale, reason: `another writer took ${path} while it was reclaimed from dead pid ${stale.pid}: ${reclaimed.reason}` };
}
