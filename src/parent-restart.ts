/**
 * Parent restart (dashboard and `cp_parent restart`), the operator bridge's half: its gate read is advisory, the host
 * `restart` op re-checks it (src/parent-host.ts). The dashboard gets `restarting` now, the outcome line later.
 */
import type { ControlPorts } from "./dashboard-control.ts";
import { restartSafety } from "./drain.ts";
import { FleetStore } from "./fleet.ts";
import type { ParentStartResult } from "./parent-control.ts";
import type { ParentHostClient } from "./parent-host.ts";
import { type ControlAuditLine, type ControlKind, readControlConfig } from "./viewer/control-files.ts";

export type ParentRestartMode = "resume" | "clean";
const RUNNING = "a parent restart is running";

/** A restart's result; `warning` when it succeeded but the operator target could not follow the new pid. */
export type ParentRestartResult = ParentStartResult & { warning?: string };
/** Past this, the dashboard restart reports `failed` and frees the latch; the host's late answer still follows. */
const RESTART_WAIT_MS = 300_000;

/** How a restart ended: `cp_parent restart`'s text and the dashboard outcome. */
export function restartedLine(result: ParentRestartResult): string {
	return `restarted ${result.start ?? "clean"} pid=${result.pid ?? "?"} session=${result.sessionFile}${result.archivedFile ? ` (archived ${result.archivedFile})` : ""}${result.warning ? `; warning: ${result.warning}` : ""}`;
}

export interface ParentRestartPorts extends Required<Pick<ControlPorts, "parentRestart" | "parentRestartState">> {
	/** `cp_parent restart`: the same gated host op, awaited. */
	restart(mode: ParentRestartMode): Promise<ParentRestartResult>;
}

/**
 * `restarted` runs after a host restart succeeded (the operator target's new parent pid); its failure is a warning.
 * `waitMs` bounds the dashboard restart (default 300 s, or `CP_PARENT_RESTART_TIMEOUT_MS`).
 */
export function parentRestartPorts(options: { home: () => string; client: () => Promise<ParentHostClient>; restarted?: (result: ParentStartResult) => void; waitMs?: number }): ParentRestartPorts {
	const waitMs = options.waitMs ?? (Number(process.env.CP_PARENT_RESTART_TIMEOUT_MS) || RESTART_WAIT_MS);
	let running = false;
	let last: string | null = null;
	const restart = async (mode: ParentRestartMode): Promise<ParentRestartResult> => {
		const result = await (await options.client()).request("restart", { fresh: mode === "clean" }) as ParentStartResult;
		try { options.restarted?.(result); } catch (error) { return { ...result, warning: `operator target not updated: ${(error as Error).message}` }; }
		return result;
	};
	return {
		restart,
		parentRestartState: () => {
			if (running) return { safe: false, reason: RUNNING, last };
			// An unresolvable target (e.g. a stale selected.json) must not break the whole control status.
			try { const home = options.home(); return { ...restartSafety(home, () => new FleetStore({ home }).list()), last }; }
			catch (error) { return { safe: false, reason: `parent unknown: ${(error as Error).message}`, last }; }
		},
		parentRestart: async (mode) => {
			if (running) return { refused: RUNNING };
			running = true; // held across the gate read: a double tap or a second dashboard gets RUNNING
			let gate: { safe: boolean; reason: string };
			try { gate = await (await options.client()).request("restartGate") as typeof gate; } catch (error) { running = false; throw error; }
			if (!gate.safe) { running = false; return { refused: `not safe to restart: ${gate.reason}` }; }
			const outcome = restart(mode).then(restartedLine, (error: Error) => `${/^not safe to restart:/.test(error.message) ? "refused" : "failed"}: ${error.message}`);
			let expired = false;
			let timer: NodeJS.Timeout | undefined;
			const expiry = new Promise<string>((resolve) => { timer = setTimeout(() => { expired = true; resolve(`failed: no answer from the parent host within ${waitMs / 1000} s; its outcome follows when it answers`); }, waitMs); timer.unref(); });
			const done = Promise.race([outcome, expiry]).then((line) => { clearTimeout(timer); running = false; last = line; return line; });
			void outcome.then((line) => { if (expired) last = line; });
			return { done };
		},
	};
}

type Reply = { ok: true; result: unknown } | { ok: false; status: number; error: string };
type Outcome = (id: string, kind: ControlKind, askId: string | null, peer: string | null, state: "refused" | "failed" | "restarting" | "restarted", reason: string | null) => void;

/** The `parent_restart` op: the `request` line first (unwritable: 500), then a refusal, or `restarting` now. */
export async function parentRestartRequest(input: { args: Record<string, unknown>; ports: ControlPorts; stateDir: string; now: () => Date; newId: (now: Date) => string; append: (line: ControlAuditLine) => { ok: true } | { ok: false; error: string }; outcome: Outcome }): Promise<Reply> {
	const { args, now } = input;
	const peer = typeof args.peer === "string" ? args.peer.slice(0, 100) : null;
	const mode = args.mode === "resume" || args.mode === "clean" ? args.mode : undefined;
	const id = input.newId(now());
	const journaled = input.append({ type: "request", by: "bridge", id, at: now().toISOString(), peer, kind: "parent_restart", text: mode ?? null, ask_id: null, deliver: "parent_restart" });
	if (!journaled.ok) return { ok: false, status: 500, error: `failed: audit journal unwritable (${journaled.error})` };
	const refuse = (status: number, reason: string): Reply => {
		input.outcome(id, "parent_restart", null, peer, "refused", reason);
		return { ok: false, status, error: reason };
	};
	if (!mode) return refuse(400, 'mode must be "resume" or "clean"');
	const config = readControlConfig(input.stateDir);
	if (config.state !== "on") return refuse(403, `dashboard control is off (${config.reason})`);
	let started: { refused: string } | { done: Promise<string> };
	try { started = await input.ports.parentRestart!(mode); } catch (error) { return refuse(409, (error as Error).message); }
	if ("refused" in started) return refuse(409, started.refused);
	input.outcome(id, "parent_restart", null, peer, "restarting", mode);
	void started.done.then((line) => input.outcome(id, "parent_restart", null, peer, line.startsWith("restarted ") ? "restarted" : line.startsWith("refused: ") ? "refused" : "failed", line));
	return { ok: true, result: { id, state: "restarting", mode } };
}
