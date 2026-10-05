/**
 * The operator terminal's version line (cp-kz20): one footer status `cp-version`, e.g. `version: latest · a4baa79` or
 * `version: 3 behind (skipped_busy) · this session stale (on 7c776ac, checkout at 93af26a) — restart`.
 *
 * `refresh()` is `readVersion({home})` then `formatTerminal()`: the viewer's own reader, so git runs bounded and cached
 * and never fetches. It runs at start, every `REFRESH_MS`, and within one `TICK_MS` of a change to `state/update.json`,
 * `parent.lock` or the host records (an mtime look, no git). One refresh at a time; nothing is written after `stop()`
 * or to a ctx without a UI, and a failure is a `version: unknown (…)` line, never a throw into pi.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VersionLevel } from "../../src/viewer/api-types.ts";
import { LOADED_COMMIT } from "../../src/viewer/loaded-commit.ts";
import { resolveStateDir } from "../../src/viewer/sessions.ts";
import { formatTerminal, readVersion, type VersionOptions } from "../../src/viewer/version-view.ts";

export const VERSION_STATUS_KEY = "cp-version";
export const TICK_MS = 10_000;
export const REFRESH_MS = 60_000;
const COLOR: Record<VersionLevel, "success" | "warning" | "error" | "dim"> = { ok: "success", warn: "warning", alert: "error", unknown: "dim" };

export interface VersionLineOptions {
	home: () => string;
	ctx: () => ExtensionContext | undefined;
	/** Test seams. */
	read?: (options: VersionOptions) => ReturnType<typeof readVersion>;
	own?: () => Promise<string | null | undefined>;
	now?: () => number;
	tickMs?: number;
}
export interface VersionLine { refresh(): Promise<void>; stop(): void }

/** What a change on disk looks like without git: the mtimes of the files the version view reads. */
function signature(stateDir: string): string {
	const mtime = (file: string) => { try { return statSync(join(stateDir, file)).mtimeMs; } catch { return 0; } };
	let hosts: string[] = [];
	try { hosts = readdirSync(stateDir).filter((name) => /^parent-host\.\d+\.json$/.test(name)); } catch { /* no state dir yet */ }
	return [mtime("update.json"), mtime("parent.lock"), ...hosts.sort().map((name) => `${name}:${mtime(name)}`)].join("|");
}

export function startVersionLine(options: VersionLineOptions): VersionLine {
	const read = options.read ?? readVersion;
	const own = options.own ?? (async () => (await LOADED_COMMIT)?.sha);
	const now = options.now ?? Date.now;
	let stopped = false;
	let running: Promise<void> | undefined;
	let last = 0;
	let seen = "";
	const show = (level: VersionLevel, text: string) => {
		const ctx = options.ctx();
		if (stopped || !ctx?.hasUI) return;
		// A ctx without a theme (a test double, an older pi) still gets the plain line.
		const theme = ctx.ui.theme as typeof ctx.ui.theme | undefined;
		ctx.ui.setStatus(VERSION_STATUS_KEY, theme ? theme.fg(COLOR[level], text) : text);
	};
	const run = async (): Promise<void> => {
		last = now();
		try {
			const home = options.home();
			seen = signature(resolveStateDir(home));
			const [view, commit] = await Promise.all([read({ home }), own()]);
			if (stopped) return;
			const line = formatTerminal(view, commit);
			show(line.level, line.text);
		} catch (error) {
			show("unknown", `version: unknown (${(error as Error).message})`);
		}
	};
	const refresh = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		running ??= run().finally(() => { running = undefined; });
		return running;
	};
	const timer = setInterval(() => {
		if (running || stopped) return;
		let changed = false;
		try { changed = signature(resolveStateDir(options.home())) !== seen; } catch { /* the refresh names it */ }
		if (changed || now() - last >= REFRESH_MS) void refresh();
	}, options.tickMs ?? TICK_MS);
	timer.unref();
	void refresh();
	return {
		refresh,
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			const ctx = options.ctx();
			if (ctx?.hasUI) ctx.ui.setStatus(VERSION_STATUS_KEY, undefined);
		},
	};
}
