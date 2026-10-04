/**
 * Restart session (cp-aqxl), the bridge's decision: whether this session can restart now, and the `restart` op.
 * Called from src/dashboard-control.ts with its own journal, outcome writer and in-memory request state.
 *
 * Order, exact: the `request` line first (unwritable: 500, nothing else happens); the kill switch; the capability
 * (`relaunchFile`/`shutdown`/`parentSends` ports: cp-bridge started by a relaunching cp-operator); the blockers; the
 * session file absolute and on disk; the 0600 relaunch marker (src/operator-relaunch.ts); outcome `restarting`;
 * then the caller writes the reply and only after that runs `after` (pi's own `ctx.shutdown()`).
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { ControlPorts } from "./dashboard-control.ts";
import { OperatorAsks } from "./operator-asks.ts";
import { restartBlockers, writeRelaunchMarker } from "./operator-relaunch.ts";
import { type ControlAuditLine, type ControlKind, readControlConfig } from "./viewer/control-files.ts";

export const RESTART_UNSUPPORTED = "this session was not started by a cp-operator that relaunches it; restart it once by hand: /quit, then cp-operator -c";

type Reply = { ok: true; result: unknown } | { ok: false; status: number; error: string };
type Outcome = (id: string, kind: ControlKind, askId: string | null, peer: string | null, state: "refused" | "failed" | "restarting", reason: string | null) => void;

export interface RestartInput {
	ports: ControlPorts;
	stateDir: string;
	/** Injected dashboard requests the session has not seen yet. */
	open: ReadonlyMap<string, unknown>;
	/** Dashboard answer clicks, by ask id. */
	clicks: ReadonlyMap<string, unknown>;
}

/** What `status` reports: supported (the three ports present, a relaunch file given) and, when it is, the blockers. */
export function restartState(input: RestartInput): { supported: boolean; blockers: string[]; reason: string | null } {
	const { ports } = input;
	const supported = ports.shutdown !== undefined && ports.parentSends !== undefined && ports.relaunchFile?.() !== undefined;
	if (!supported) return { supported, blockers: [], reason: RESTART_UNSUPPORTED };
	const unrecordedAsks: string[] = [];
	let asksError: string | null = null;
	if (input.clicks.size > 0) {
		try {
			const open = new Set(new OperatorAsks(join(input.stateDir, "operator", "asks.jsonl")).list().filter((ask) => ask.state === "open").map((ask) => ask.id));
			unrecordedAsks.push(...[...input.clicks.keys()].filter((id) => open.has(id)));
		} catch (error) {
			asksError = `asks unreadable: ${(error as Error).message}`;
		}
	}
	const blockers = restartBlockers({ idle: ports.isIdle(), pendingMessages: ports.hasPendingMessages(), openRequests: input.open.size, unrecordedAsks, parentSends: ports.parentSends!() });
	if (asksError) blockers.push(asksError);
	return { supported, blockers, reason: blockers.length > 0 ? `not now: ${blockers.join("; ")}` : null };
}

/** The `restart` op: one journaled request, then a refusal, or the marker and `after` to run once the reply is written. */
export function restartRequest(input: RestartInput & { args: Record<string, unknown>; now: () => Date; newId: (now: Date) => string; append: (line: ControlAuditLine) => { ok: true } | { ok: false; error: string }; outcome: Outcome }): Reply & { after?: () => void } {
	const { ports, now } = input;
	const peer = typeof input.args.peer === "string" ? input.args.peer.slice(0, 100) : null;
	const id = input.newId(now());
	const journaled = input.append({ type: "request", by: "bridge", id, at: now().toISOString(), peer, kind: "restart", text: null, ask_id: null, deliver: "restart" });
	if (!journaled.ok) return { ok: false, status: 500, error: `failed: audit journal unwritable (${journaled.error})` };
	const refuse = (status: number, reason: string): Reply => {
		input.outcome(id, "restart", null, peer, "refused", reason);
		return { ok: false, status, error: reason };
	};
	const config = readControlConfig(input.stateDir);
	if (config.state !== "on") return refuse(403, `dashboard control is off (${config.reason})`);
	const state = restartState(input);
	if (!state.supported) return refuse(409, `unsupported: ${RESTART_UNSUPPORTED}`);
	if (state.blockers.length > 0) return refuse(409, `not now: ${state.blockers.join("; ")}`);
	const file = ports.sessionFile();
	if (!file || !isAbsolute(file) || !file.endsWith(".jsonl") || !existsSync(file)) return refuse(409, `the session file ${file ?? "(none)"} is not on disk; nothing to resume`);
	const written = writeRelaunchMarker(ports.relaunchFile!()!, { id, pid: process.pid, session_file: file, at: now().toISOString() });
	if (!written.ok) {
		input.outcome(id, "restart", null, peer, "failed", `relaunch marker unwritable: ${written.error}`);
		return { ok: false, status: 500, error: `failed: relaunch marker unwritable (${written.error})` };
	}
	input.outcome(id, "restart", null, peer, "restarting", null);
	return { ok: true, result: { id, state: "restarting", session_file: basename(file) }, after: () => ports.shutdown!() };
}
