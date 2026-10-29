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

/** How a restart ended: `cp_parent restart`'s text and the dashboard outcome. */
export function restartedLine(result: ParentStartResult): string {
	return `restarted ${result.start ?? "clean"} pid=${result.pid ?? "?"} session=${result.sessionFile}${result.archivedFile ? ` (archived ${result.archivedFile})` : ""}`;
}

export interface ParentRestartPorts extends Required<Pick<ControlPorts, "parentRestart" | "parentRestartState">> {
	/** `cp_parent restart`: the same gated host op, awaited. */
	restart(mode: ParentRestartMode): Promise<ParentStartResult>;
}

/** `restarted` runs after a host restart succeeded (the operator target's new parent pid). */
export function parentRestartPorts(options: { home: () => string; client: () => Promise<ParentHostClient>; restarted?: (result: ParentStartResult) => void }): ParentRestartPorts {
	let running = false;
	let last: string | null = null;
	const restart = async (mode: ParentRestartMode): Promise<ParentStartResult> => {
		const result = await (await options.client()).request("restart", { fresh: mode === "clean" }) as ParentStartResult;
		options.restarted?.(result);
		return result;
	};
	return {
		restart,
		parentRestartState: () => {
			const home = options.home();
			return { ...(running ? { safe: false, reason: RUNNING } : restartSafety(home, () => new FleetStore({ home }).list())), last };
		},
		parentRestart: async (mode) => {
			if (running) return { refused: RUNNING };
			running = true; // held across the gate read: a double tap or a second dashboard gets RUNNING
			let gate: { safe: boolean; reason: string };
			try { gate = await (await options.client()).request("restartGate") as typeof gate; } catch (error) { running = false; throw error; }
			if (!gate.safe) { running = false; return { refused: `not safe to restart: ${gate.reason}` }; }
			const done = restart(mode).then(restartedLine, (error: Error) => `${/^not safe to restart:/.test(error.message) ? "refused" : "failed"}: ${error.message}`)
				.then((line) => { running = false; last = line; return line; });
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
