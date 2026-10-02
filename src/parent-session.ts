/**
 * Parent session mode: display vs orchestration.
 *
 * Display timers (widget, key listeners) stay `hasUI`-gated. Orchestration
 * timers (CI watch, deferred re-gate, reconcile sweeps) run in every mode —
 * including `pi --mode rpc` with no TUI, which is how a bridge-driven parent
 * is woken.
 */
import { ENV_HEADLESS } from "./contracts.ts";

export interface ParentSession {
	mode: string;
	hasUI: boolean;
	/** RPC, or `CP_HEADLESS=1`: never open overlays; bridge is the operator channel. */
	headless: boolean;
	widget: boolean;
	keys: boolean;
	ciWatch: boolean;
	orchestration: boolean;
}

export interface RunningTimers {
	widget: boolean;
	keys: boolean;
	ciWatch: boolean;
	orchestration: boolean;
}

export type NotifyLevel = "info" | "warning" | "error";

export function isHeadlessParent(ctx: { mode: string }, env: NodeJS.ProcessEnv = process.env): boolean {
	return ctx.mode === "rpc" || env[ENV_HEADLESS] === "1";
}

export function parentSession(
	ctx: { mode: string; hasUI: boolean },
	env: NodeJS.ProcessEnv = process.env,
): ParentSession {
	const headless = isHeadlessParent(ctx, env);
	return {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		headless,
		widget: ctx.hasUI,
		keys: ctx.mode === "tui" && ctx.hasUI && !headless,
		ciWatch: true,
		orchestration: true,
	};
}

export function formatParentSession(session: ParentSession, running: RunningTimers): string {
	const flag = (on: boolean): string => (on ? "on" : "off");
	const channel = session.headless ? "headless (bridge)" : "interactive";
	return [
		`session: ${session.mode} · ${channel}`,
		`timers: ci-watch ${flag(running.ciWatch)}, orchestration ${flag(running.orchestration)}, widget ${flag(running.widget)}, keys ${flag(running.keys)}`,
	].join("\n");
}

/** Same information as `ctx.ui.notify`, on stderr when no UI is attached. */
export function operatorNotify(
	ctx: { hasUI: boolean; ui: { notify: (message: string, level?: NotifyLevel) => void } } | undefined | null,
	text: string,
	level: NotifyLevel = "info",
): void {
	if (ctx?.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}
	process.stderr.write(`${text}\n`);
}
