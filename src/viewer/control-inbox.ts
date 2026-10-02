/**
 * The dashboard inbox (cp-daemon v1 P3), read-only: while no operator session runs, a composer send is held as a
 * `held` line in `state/operator/inbox.jsonl` (appended by control-api.ts through control-audit.ts), and the next
 * session delivers it at `session_start` (src/dashboard-control.ts appends `delivered`/`dropped`).
 *
 * The CSRF token for a held send is this viewer process's own random inbox token, returned by
 * `GET /api/operator/control` while offline, since the session's token does not exist then.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { controlInboxFile, readControlRecord } from "./control-files.ts";
import { pidAlive } from "./overview-health.ts";

/** Per viewer process; a viewer restart rotates it (the page re-reads it with the status). */
export const INBOX_TOKEN = randomBytes(32).toString("hex");

export interface HeldMessage { id: string; at: string; text: string; ask_id: string | null }

/** Held lines not yet delivered or dropped, oldest first; `error` names an unreadable file (never silently empty). */
export function readInbox(stateDir: string): { held: HeldMessage[]; error: string | null } {
	let text: string;
	try {
		text = readFileSync(controlInboxFile(stateDir), "utf8");
	} catch (error) {
		return { held: [], error: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : `${controlInboxFile(stateDir)}: ${(error as Error).message}` };
	}
	const held = new Map<string, HeldMessage>();
	for (const row of text.split("\n")) {
		let line: Record<string, unknown>;
		try {
			line = JSON.parse(row) as Record<string, unknown>;
		} catch {
			continue; // a torn last line: the next append starts a fresh one
		}
		if (typeof line?.id !== "string") continue;
		if (line.type === "held" && typeof line.at === "string" && typeof line.text === "string") held.set(line.id, { id: line.id, at: line.at, text: line.text, ask_id: typeof line.ask_id === "string" ? line.ask_id : null });
		else if (line.type === "delivered" || line.type === "dropped") held.delete(line.id);
	}
	return { held: [...held.values()].sort((a, b) => a.at.localeCompare(b.at)), error: null };
}

/** The operator session as the dashboard sees it: its record, and whether that pid still runs. */
export function operatorSession(stateDir: string, isAlive: (pid: number) => boolean = pidAlive): { running: boolean; pid: number | null; since: string | null; reason: string } {
	const record = readControlRecord(stateDir);
	if (record.state === "absent") return { running: false, pid: null, since: null, reason: "no dashboard control record" };
	if (record.state === "invalid") return { running: false, pid: null, since: null, reason: record.reason };
	if (!isAlive(record.record.pid)) return { running: false, pid: record.record.pid, since: null, reason: `the recorded session pid ${record.record.pid} is not running` };
	return { running: true, pid: record.record.pid, since: record.record.started_at, reason: "running" };
}

/** cp-hhuf P6: the parent as the dashboard sees it, from `state/parent.lock` and whether that pid still runs. */
export function parentHolder(stateDir: string, isAlive: (pid: number) => boolean = pidAlive): { running: boolean; pid: number | null; reason: string } {
	const file = join(stateDir, "parent.lock");
	let lock: { pid?: unknown } | null;
	try {
		lock = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown } | null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { running: false, pid: null, reason: "no parent lock" };
		return { running: false, pid: null, reason: `${file} is unreadable: ${(error as Error).message}` };
	}
	const pid = lock?.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { running: false, pid: null, reason: "parent lock names no pid" };
	if (!isAlive(pid)) return { running: false, pid, reason: `the recorded parent pid ${pid} is not running` };
	return { running: true, pid, reason: "running" };
}

const stamp = (date: Date) => date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
/** A held message's id: the same `dc-…` shape the session gives the requests it journals. */
export const heldId = (now: Date): string => `dc-${stamp(now)}-${randomBytes(4).toString("hex")}`;
