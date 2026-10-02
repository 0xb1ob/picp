/**
 * Where the operator session can start (dashboard Start session): the one launcher lookup the installer, doctor
 * and the viewer share. tmux is the absolute `tmux` on PATH, run directly (cp-rrye) by a cp-daemon-run viewer:
 * `tmux new-session -d -s cp-operator <wrapper> [-c]`; herdr is the absolute `herdr` on PATH, usable only while
 * its background server runs (`herdr status server --json`).
 * It lives in src/viewer/ because viewer modules import only `node:` and `./` (tests/viewer-workbench.test.ts).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { standardHome } from "../home.ts";

/**
 * `~/.local/bin/cp-operator`, what the herdr pane runs: the same path as src/service/units.ts
 * `installTargets(env).binDir` + `OPERATOR_WRAPPER` (pinned by tests/service-units.test.ts). The user's home is
 * the standard home's parent (src/home.ts owns the $HOME read).
 */
export function operatorWrapperPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(dirname(standardHome(env)), ".local/bin", "cp-operator");
}

export type Launcher = "herdr" | "tmux";
/** Every herdr call the viewer makes is bounded by this. */
export const HERDR_TIMEOUT_MS = 10_000;
/** The herdr workspace (and its label) the operator session runs in. */
export const HERDR_WORKSPACE_LABEL = "cp-operator";
/** The tmux session the operator runs in (`tmux attach -t cp-operator`). */
export const OPERATOR_TMUX_SESSION = "cp-operator";
/** A viewer not run by cp-daemon (a legacy `cp-view.service`, or `bin/cp-view` by hand) never starts tmux: a session
 * started there would live in that viewer's cgroup or terminal and die with it. */
export const TMUX_NEEDS_DAEMON = "Start in tmux needs the cp-daemon-run dashboard: rerun cp-install";

/**
 * Start in tmux (cp-rrye): the fixed argv — the absolute tmux, a detached `cp-operator` session running the
 * wrapper, `-c` to resume — or why not. Available only when cp-daemon runs this viewer (`daemonRun`: the viewer's
 * `CP_DAEMON_ROLE=viewer`; doctor: `data/daemon.json`), tmux is on PATH and the wrapper is installed.
 */
export function tmuxLaunch(input: { daemonRun: boolean; tmux: string | undefined; wrapper: string; exists?: (file: string) => boolean }, resume = false): { argv: string[] } | { reason: string } {
	if (!input.daemonRun) return { reason: TMUX_NEEDS_DAEMON };
	if (!input.tmux) return { reason: "tmux is not on PATH: install tmux (Start in tmux runs it directly)" };
	if (!(input.exists ?? existsSync)(input.wrapper)) return { reason: `${input.wrapper} is not installed: rerun cp-install` };
	return { argv: [input.tmux, "new-session", "-d", "-s", OPERATOR_TMUX_SESSION, input.wrapper, ...(resume ? ["-c"] : [])] };
}

/** The first absolute `<dir>/<name>` on `path` that exists; undefined when none does. */
export function onPath(name: string, path = process.env.PATH ?? "", exists: (file: string) => boolean = existsSync): string | undefined {
	return path.split(":").filter((dir) => dir.startsWith("/")).map((dir) => join(dir, name)).find((file) => exists(file));
}

export const herdrServerArgv = (herdr: string): string[] => [herdr, "status", "server", "--json"];

/** `herdr status server --json` answered `"running": true`. */
export function herdrServerRunning(result: { status: number | null; stdout: string }): boolean {
	if (result.status !== 0) return false;
	try {
		return (JSON.parse(result.stdout) as { running?: unknown }).running === true;
	} catch {
		return false;
	}
}

/**
 * The one `<command>` argument of `herdr pane run <pane_id> <command>`: every word POSIX-sh quoted, joined. herdr
 * types it into the pane's shell, and its own argv parser takes a global `--session <name>` from anywhere, so
 * command words passed as separate argv elements (`… cp-operator --session <id>`) re-route the call to another
 * herdr session (`server_not_running`) and `--` is typed literally; one quoted string is the contract that holds.
 */
export function herdrCommand(words: readonly string[]): string {
	return words.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
}

/** `herdr integration status` lists pi as installed (a `pi:` line that does not say "not installed"). */
export function herdrPiIntegrated(stdout: string): boolean {
	const line = stdout.split("\n").find((row) => /^pi:/.test(row.trim()));
	return line !== undefined && !/not installed/.test(line);
}
