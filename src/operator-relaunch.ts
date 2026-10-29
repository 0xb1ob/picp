/**
 * Restart session (cp-aqxl): the operator session stops itself and its launcher relaunches it in the same terminal.
 *
 * `bin/cp-operator` (src/viewer/operator.ts) gives every pi it starts `CP_OPERATOR_RELAUNCH_FILE`
 * (`state/operator/relaunch.json`): its presence is the capability handshake. On an accepted dashboard restart the
 * bridge (src/dashboard-restart.ts) writes a 0600 marker `{version: 1, id, pid, session_file, at}` there and calls
 * pi's own `ctx.shutdown()`. When that pi exits, `superviseOperatorPi` takes the marker only when it names the exited
 * child's pid, removes it, and spawns pi again with exactly `--session <file>` (`-c` when the file is gone; no resume
 * flag at all for a `fresh: true` marker, Restart clean); at most
 * 3 relaunches per 10 min. No marker: the launcher exits with pi's code, as before. Nothing here signals, kills or
 * looks up any process from outside: the stop is pi's own, the relaunch is the terminal's own launcher.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { layoutForHome, type Mode } from "./contracts.ts";
import type { ControlPorts } from "./dashboard-control.ts";
import { newestOperatorHandoff } from "./operator-context.ts";
import { PARENT_SEND_MAX_AGE_HOURS, parentSendFile, readParentSendOutboxForRestart } from "./parent-outbox.ts";

export const RELAUNCH_ENV = "CP_OPERATOR_RELAUNCH_FILE";
export const RELAUNCH_LIMIT = { count: 3, windowMs: 10 * 60_000 };

/** `fresh`: relaunch on a new session (Restart clean); a launcher that predates it ignores the field and resumes. */
export interface RelaunchMarker { version: 1; id: string; pid: number; session_file: string; at: string; fresh?: true }

/** `<home>/<state>/operator/relaunch.json`: where the launcher looks, and what it tells pi. */
export function relaunchFileFor(home: string, mode: Mode): string {
	return join(resolve(home), layoutForHome(mode, home).state, "operator", "relaunch.json");
}

/** Atomic and owner-only: a tmp file 0600, then a rename. */
export function writeRelaunchMarker(file: string, marker: Omit<RelaunchMarker, "version">): { ok: true } | { ok: false; error: string } {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		rmSync(tmp, { force: true });
		writeFileSync(tmp, `${JSON.stringify({ version: 1, ...marker })}\n`, { mode: 0o600 });
		renameSync(tmp, file);
		return { ok: true };
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// The tmp's directory is the failure itself (missing or not a directory): nothing was left to remove.
		}
		return { ok: false, error: (error as Error).message };
	}
}

/** The marker, removed, only when it is well-formed and names `pid`; any other marker stays where it is (inert). */
export function takeRelaunchMarker(file: string, pid: number): { id: string; session_file: string; fresh: boolean } | undefined {
	let raw: Partial<RelaunchMarker> | null;
	try {
		raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RelaunchMarker> | null;
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object" || raw.version !== 1 || raw.pid !== pid || typeof raw.id !== "string") return undefined;
	if (typeof raw.session_file !== "string" || !isAbsolute(raw.session_file) || !raw.session_file.endsWith(".jsonl")) return undefined;
	rmSync(file, { force: true });
	return { id: raw.id, session_file: raw.session_file, fresh: raw.fresh === true };
}

/** No resume flag when fresh (pi starts a new session on the configured model); else the exact file, `-c` when gone. */
export function relaunchArgs(marker: { session_file: string; fresh?: boolean }, exists: (path: string) => boolean = existsSync): string[] {
	if (marker.fresh) return [];
	return exists(marker.session_file) ? ["--session", marker.session_file] : ["-c"];
}

/** `cp_parent send`s without an observed outcome, queued within 24 h; an unreadable outbox is an error, never none. */
export function pendingParentSends(home: string, mode: Mode, now: Date = new Date()): { ids: string[]; error: string | null } {
	const file = parentSendFile(join(resolve(home), layoutForHome(mode, home).sessions, "cp-parent.jsonl"));
	try {
		const since = now.getTime() - PARENT_SEND_MAX_AGE_HOURS * 3_600_000;
		const ids = readParentSendOutboxForRestart(file).entries.filter((entry) => !entry.owner_observed_at && Date.parse(entry.queued_at) >= since).map((entry) => entry.id);
		return { ids, error: null };
	} catch (error) {
		return { ids: [], error: (error as Error).message };
	}
}

/** Why a restart must wait, one line each, in a fixed order; empty when it may go. */
export function restartBlockers(input: { idle: boolean; pendingMessages: boolean; openRequests: number; unrecordedAsks: readonly string[]; parentSends: { ids: readonly string[]; error: string | null } }): string[] {
	const out: string[] = [];
	if (!input.idle) out.push("the session is busy with a turn");
	if (input.pendingMessages) out.push("messages are queued for the session");
	if (input.openRequests > 0) out.push(`${input.openRequests} dashboard request(s) injected but not seen by the session yet`);
	for (const id of input.unrecordedAsks) out.push(`ask ${id} answered from the dashboard but not recorded yet`);
	if (input.parentSends.ids.length > 0) out.push(`cp_parent send ${input.parentSends.ids.join(", ")} pending`);
	if (input.parentSends.error) out.push(`parent send outbox unreadable: ${input.parentSends.error}`);
	return out;
}

/** The bridge's restart ports in one call; `relaunchFile` is undefined unless the launcher gave an absolute path. */
export function relaunchPorts(input: { target: () => { home: string; mode: Mode }; ctx: () => { shutdown(): void; mode?: string } | undefined; whenIdle: (fn: () => void) => void; env?: NodeJS.ProcessEnv }): Required<Pick<ControlPorts, "shutdown" | "relaunchFile" | "parentSends" | "handoff">> {
	const env = input.env ?? process.env;
	return {
		shutdown: () => input.whenIdle(() => {
			const ctx = input.ctx();
			ctx?.shutdown();
			// pi --mode rpc only flags the shutdown until its next stdin command; its own SIGTERM handler runs it now.
			if (ctx?.mode === "rpc") process.kill(process.pid, "SIGTERM");
		}),
		relaunchFile: () => {
			const file = env[RELAUNCH_ENV];
			return file && isAbsolute(file) ? file : undefined;
		},
		parentSends: () => {
			const { home, mode } = input.target();
			return pendingParentSends(home, mode);
		},
		handoff: () => {
			const { home, mode } = input.target();
			return newestOperatorHandoff(home, mode);
		},
	};
}

export interface SuperviseOptions {
	spawnPi: (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;
	firstArgs: readonly string[];
	/** Absent: no relaunch, pi runs once (the launcher could not resolve a home). */
	relaunchFile?: string;
	limit?: { count: number; windowMs: number };
	now?: () => number;
	log?: (line: string) => void;
	/** Each child as it starts, so the caller forwards signals to the current one. */
	onChild?: (child: ChildProcess) => void;
	/** True once the launcher itself was signalled: the session is ending, never relaunched. */
	stopped?: () => boolean;
}

function exitOf(child: ChildProcess, log: (line: string) => void): Promise<number> {
	return new Promise((done) => {
		child.once("error", (error) => {
			log(`cp-operator: could not start pi: ${error.message}\n`);
			done(127);
		});
		child.once("exit", (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)));
	});
}

/** Run pi; relaunch it while it exits with a marker naming its own pid, within the cap; resolve with the last exit code. */
export async function superviseOperatorPi(options: SuperviseOptions): Promise<number> {
	const limit = options.limit ?? RELAUNCH_LIMIT;
	const now = options.now ?? Date.now;
	const log = options.log ?? ((line: string) => process.stderr.write(line));
	// Always set: without a relaunch file an inherited value is cleared (spawn drops undefined), so pi never claims a relaunch nobody does.
	const env: NodeJS.ProcessEnv = { [RELAUNCH_ENV]: options.relaunchFile };
	const relaunches: number[] = [];
	let args = options.firstArgs;
	for (;;) {
		const child = options.spawnPi(args, env);
		options.onChild?.(child);
		const code = await exitOf(child, log);
		if (!options.relaunchFile || child.pid === undefined || options.stopped?.()) return code;
		const marker = takeRelaunchMarker(options.relaunchFile, child.pid);
		if (!marker) return code;
		const at = now();
		while (relaunches.length > 0 && at - relaunches[0]! >= limit.windowMs) relaunches.shift();
		if (relaunches.length >= limit.count) {
			log(`cp-operator: not restarting: ${limit.count} restarts within ${Math.round(limit.windowMs / 60_000)} min; resume by hand: cp-operator --session ${marker.session_file}\n`);
			return code;
		}
		relaunches.push(at);
		args = relaunchArgs(marker);
		log(marker.fresh ? "cp-operator: restarting from the dashboard with a clean session\n"
			: args[0] === "--session" ? `cp-operator: restarting from the dashboard, resuming ${marker.session_file}\n` : `cp-operator: restarting from the dashboard; ${marker.session_file} is gone, continuing the most recent session (-c)\n`);
	}
}
