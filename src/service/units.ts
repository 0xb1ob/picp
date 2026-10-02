/**
 * The always-on unit text (cp-daemon v1 P2): `cp-parent.service` runs the
 * attach-first supervisor, `cp-view.service` the dashboard viewer, and
 * `cp-operator` is the generated wrapper that attaches the operator session
 * from any directory. P3 adds `cp-health.service` + `cp-health.timer` (the
 * watchdog, every 5 min) and, when tmux is on PATH at install time,
 * `cp-operator.service` (installed, never enabled). P4 adds `cp-update.service`
 * + `cp-update.timer` (auto-update when idle, every 5 min). Pure rendering:
 * `install.ts` owns where they go. Since cp-daemon (cp-txbb, cp-rrye) install writes only `cp-daemon.service`
 * and the wrapper; the legacy renderers stay as the reference childEnv keeps parity with.
 *
 * Units carry `CP_*`, `PATH` and the model name only — never a secret; the
 * wrapper carries the same plus the pinned model names. The parent
 * authenticates through `~/.pi/agent/auth.json`; the optional gateway admin
 * key lives only in `gateway.env` (`src/gateway-key.ts`).
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PARENT_UNIT = "cp-parent.service";
export const VIEW_UNIT = "cp-view.service";
export const HEALTH_UNIT = "cp-health.service";
export const HEALTH_TIMER = "cp-health.timer";
export const UPDATE_UNIT = "cp-update.service";
export const UPDATE_TIMER = "cp-update.timer";
/** No longer written (cp-rrye: Start in tmux runs tmux directly); named so install removes an older generated one and uninstall clears it. */
export const OPERATOR_UNIT = "cp-operator.service";
/** The same, running `cp-operator -c` (the old Resume last session); retired with it. */
export const OPERATOR_RESUME_UNIT = "cp-operator-resume.service";
export const OPERATOR_TMUX_SESSION = "cp-operator";
export const OPERATOR_WRAPPER = "cp-operator";
/** The one unit the systemd backend runs (cp-txbb): named in `daemon-backend.ts`, which the outer may import. */
export { DAEMON_UNIT } from "./daemon-backend.ts";

/** Where the units and the wrapper go: outside the home, in the user's own config and PATH. */
export function installTargets(env: NodeJS.ProcessEnv = process.env): { unitDir: string; binDir: string } {
	const user = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
	return { unitDir: resolve(env.XDG_CONFIG_HOME || join(user, ".config"), "systemd/user"), binDir: resolve(user, ".local/bin") };
}

export interface UnitInput {
	/** Absolute node binary the units run (the installing node). */
	node: string;
	/** The command-post checkout. */
	app: string;
	home: string;
	/** The installing `PATH`, recorded so `pi`, `git`, `gh` resolve under systemd. */
	path: string;
	port: number;
	parentModel?: string;
	/** CP_OPERATOR_MODEL, exported by the wrapper only (the operator session's `--model`). */
	operatorModel?: string;
	/** Absolute tmux, found at install time; without it (or the wrapper) no cp-operator.service is rendered. */
	tmux?: string;
	/** The generated `~/.local/bin/cp-operator`, what cp-operator.service runs inside tmux. */
	wrapper?: string;
	/** CP_VIEWER_HOST, pinned by cp-install (policy-checked there); absent, every unit renders as before it existed. */
	viewerHost?: string;
}

/** One systemd word (Environment=): quoted, `\` and `"` escaped, `%` doubled (specifier escape). */
function word(value: string): string {
	if (/[\n\r\0]/.test(value)) throw new Error(`unit value holds a line break or NUL: ${JSON.stringify(value)}`);
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/** One ExecStart= word: as `word`, plus `$` doubled, since ExecStart= expands `$VAR` (systemd.service(5)). */
function execWord(value: string): string {
	return word(value).replace(/\$/g, "$$$$");
}

/**
 * WorkingDirectory= takes a bare absolute path: no quotes, no C escapes (systemd.exec(5)), only `%`
 * specifiers. A path systemd cannot carry verbatim is refused rather than guessed at.
 */
function directory(value: string): string {
	if (!value.startsWith("/") || /[\s\p{Cc}"'\\]/u.test(value)) throw new Error(`WorkingDirectory= cannot carry ${JSON.stringify(value)}: systemd needs an absolute path with no whitespace, quote, backslash or control character; pick a --home without them`);
	return value.replace(/%/g, "%%");
}

function environment(vars: Record<string, string>): string[] {
	return Object.entries(vars).map(([key, value]) => `Environment=${word(`${key}=${value}`)}`);
}

/**
 * The unit PATH, stable across shells on one machine: fnm's per-shell `fnm_multishells/<id>` entries
 * (and empties, duplicates) dropped, the node binary's own dir first — where `npm -g` puts `pi` too.
 * tmux/herdr/git/gh keep their system dirs; the absolute tmux is in ExecStart anyway.
 */
export function unitPath(node: string, path: string): string {
	// The ExecStart node's own dir is kept verbatim, even under fnm_multishells: the unit runs that binary.
	const dirs = [dirname(node), ...path.split(":").filter((dir) => dir.length > 0 && !dir.includes("/fnm_multishells/"))];
	return [...new Set(dirs)].join(":");
}

const HEADER = "# Generated by cp-install (pi-command-post); edits are refused on reinstall without --force.";

/**
 * `cp-daemon.service` (cp-txbb): the thin unit of the systemd backend. It runs `cp-daemon run` in the
 * foreground; the viewer host and the parent model live in `data/daemon.json`, never here, so re-pinning
 * them never rewrites this file. `KillMode=process`: the parent host and its workers live in this cgroup.
 */
export function renderDaemonUnit(raw: Pick<UnitInput, "node" | "app" | "home" | "path">): string {
	return [
		HEADER,
		"[Unit]",
		"Description=pi-command-post daemon (parent supervisor, viewer, health and update)",
		"After=network-online.target",
		"StartLimitIntervalSec=1800",
		"StartLimitBurst=6",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${execWord(raw.node)} ${execWord(`${raw.app}/src/service/daemon.ts`)} "run"`,
		`WorkingDirectory=${directory(raw.home)}`,
		...environment({ CP_HOME: raw.home, CP_MODE: "multi", PATH: unitPath(raw.node, raw.path) }),
		"Restart=on-failure",
		"RestartSec=5",
		"RestartSteps=5",
		"RestartMaxDelaySec=300",
		"RestartPreventExitStatus=78",
		"KillMode=process",
		"TimeoutStopSec=30",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

/** The unit files by name, in install order. */
export function renderUnits(raw: UnitInput): Record<string, string> {
	const input = { ...raw, path: unitPath(raw.node, raw.path) };
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error(`port must be 1-65535, got ${input.port}`);
	const header = HEADER;
	// Every unit that resolves the viewer's address (the port's units) carries the pinned host, so health, update
	// verify, intake board links and the viewer itself agree on one address.
	const host: Record<string, string> = input.viewerHost ? { CP_VIEWER_HOST: input.viewerHost } : {};
	const parent = [
		header,
		"[Unit]",
		"Description=pi-command-post parent host supervisor (attach-first)",
		"After=network-online.target",
		"StartLimitIntervalSec=1800",
		"StartLimitBurst=6",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${execWord(input.node)} ${execWord(`${input.app}/src/service/supervise.ts`)}`,
		`WorkingDirectory=${directory(input.home)}`,
		...environment({
			CP_HOME: input.home,
			CP_MODE: "multi",
			PATH: input.path,
			CP_VIEWER_PORT: String(input.port),
			...host,
			...(input.parentModel ? { CP_PARENT_MODEL: input.parentModel } : {}),
		}),
		"Restart=on-failure",
		"RestartSec=5",
		"RestartSteps=5",
		"RestartMaxDelaySec=300",
		"RestartPreventExitStatus=78",
		"KillMode=process",
		"TimeoutStopSec=10",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	];
	const view = [
		header,
		"[Unit]",
		"Description=pi-command-post dashboard viewer",
		"After=network-online.target",
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${[input.node, `${input.app}/src/viewer/cli.ts`, "--home", input.home, "--require-tailnet", "--port", String(input.port)].map(execWord).join(" ")}`,
		`WorkingDirectory=${directory(input.home)}`,
		...environment({ CP_HOME: input.home, CP_MODE: "multi", PATH: input.path, ...host }),
		"Restart=always",
		"RestartSec=10",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	];
	const health = [
		header,
		"[Unit]",
		"Description=pi-command-post health watchdog (one run; cp-health.timer repeats it)",
		"",
		"[Service]",
		"Type=oneshot",
		`ExecStart=${execWord(input.node)} ${execWord(`${input.app}/src/service/health.ts`)}`,
		`WorkingDirectory=${directory(input.home)}`,
		...environment({ CP_HOME: input.home, CP_MODE: "multi", PATH: input.path, CP_VIEWER_PORT: String(input.port), ...host }),
		"TimeoutStartSec=120",
		"",
	];
	const timer = [
		header,
		"[Unit]",
		"Description=pi-command-post health watchdog, every 5 minutes",
		"",
		"[Timer]",
		"OnBootSec=3min",
		"OnUnitActiveSec=5min",
		`Unit=${HEALTH_UNIT}`,
		"",
		"[Install]",
		"WantedBy=timers.target",
		"",
	];
	// P4: its own unit, outside cp-parent's cgroup, so restarting the parent never kills the updater mid-step.
	const update = [
		header,
		"[Unit]",
		"Description=pi-command-post auto-update when idle (one run; cp-update.timer repeats it)",
		"",
		"[Service]",
		"Type=oneshot",
		`ExecStart=${execWord(input.node)} ${execWord(`${input.app}/src/service/update.ts`)}`,
		`WorkingDirectory=${directory(input.home)}`,
		...environment({ CP_HOME: input.home, CP_MODE: "multi", PATH: input.path, CP_VIEWER_PORT: String(input.port), ...host }),
		"TimeoutStartSec=45min",
		"",
	];
	const updateTimer = [
		header,
		"[Unit]",
		"Description=pi-command-post auto-update check, every 5 minutes",
		"",
		"[Timer]",
		"OnBootSec=10min",
		"OnUnitActiveSec=5min",
		`Unit=${UPDATE_UNIT}`,
		"",
		"[Install]",
		"WantedBy=timers.target",
		"",
	];
	const units: Record<string, string> = { [PARENT_UNIT]: parent.join("\n"), [VIEW_UNIT]: view.join("\n"), [HEALTH_UNIT]: health.join("\n"), [HEALTH_TIMER]: timer.join("\n"), [UPDATE_UNIT]: update.join("\n"), [UPDATE_TIMER]: updateTimer.join("\n") };
	const { tmux, wrapper } = input;
	if (tmux && wrapper) {
		// Installed, never enabled: starting it spends model tokens, so it takes an explicit click (or command).
		// The resume twin runs the same wrapper with the fixed `-c` (pi: continue this home's last session, or a fresh one).
		const operator = (description: string, args: string[]) => [
			header,
			"[Unit]",
			`Description=${description}`,
			"",
			"[Service]",
			"Type=forking",
			`ExecStart=${[tmux, "new-session", "-d", "-s", OPERATOR_TMUX_SESSION, wrapper, ...args].map(execWord).join(" ")}`,
			`ExecStop=${[tmux, "kill-session", "-t", OPERATOR_TMUX_SESSION].map(execWord).join(" ")}`,
			`WorkingDirectory=${directory(input.home)}`,
			...environment({ CP_HOME: input.home, CP_MODE: "multi", PATH: input.path }),
			"",
			"[Install]",
			"WantedBy=default.target",
			"",
		].join("\n");
		units[OPERATOR_UNIT] = operator("pi-command-post operator session in tmux (never at boot; the dashboard's Start session)", []);
		units[OPERATOR_RESUME_UNIT] = operator("pi-command-post operator session in tmux, resuming the last session (never at boot; the dashboard's Resume last session)", ["-c"]);
	}
	return units;
}

/** One POSIX sh word. */
function sh(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * `~/.local/bin/cp-operator`: this home, multi mode, the service's viewer (and its pinned host) — from any directory.
 * A pinned model is exported too: `CP_OPERATOR_MODEL` (the session's `--model`, `src/viewer/operator.ts`) and
 * `CP_PARENT_MODEL` (what `cp_parent start` resolves), so an operator-started parent matches the supervisor's.
 */
export function renderOperatorWrapper(input: Pick<UnitInput, "app" | "home" | "viewerHost" | "parentModel" | "operatorModel">): string {
	const models = `${input.parentModel ? ` CP_PARENT_MODEL=${sh(input.parentModel)}` : ""}${input.operatorModel ? ` CP_OPERATOR_MODEL=${sh(input.operatorModel)}` : ""}`;
	return [
		"#!/bin/sh",
		"# Generated by cp-install (pi-command-post): attach the operator session to this home's running parent.",
		`export CP_HOME=${sh(input.home)} CP_MODE=multi CP_OPERATOR_VIEWER=service${input.viewerHost ? ` CP_VIEWER_HOST=${sh(input.viewerHost)}` : ""}${models}`,
		'cd "$CP_HOME" || exit 1',
		`exec ${sh(`${input.app}/bin/cp-operator`)} "$@"`,
		"",
	].join("\n");
}

/** What a rendered cp-view.service pinned: `generated` when cp-install wrote it, `host` its CP_VIEWER_HOST. */
export function unitViewerHost(text: string | undefined): { generated: boolean; host?: string } {
	const host = /^Environment="CP_VIEWER_HOST=([0-9A-Fa-f:.]+)"$/m.exec(text ?? "")?.[1];
	return { generated: (text ?? "").includes("Generated by cp-install"), ...(host ? { host } : {}) };
}

/** The CP_VIEWER_HOST a rendered wrapper exports (the previous choice when there is no systemd). */
export function wrapperViewerHost(text: string | undefined): string | undefined {
	return /CP_VIEWER_HOST='([0-9A-Fa-f:.]+)'/.exec(text ?? "")?.[1];
}

/** The CP_PARENT_MODEL a rendered cp-parent.service pins (systemd word unescaped); `generated` when cp-install wrote it. */
export function unitParentModel(text: string | undefined): { generated: boolean; model?: string } {
	const raw = /^Environment="CP_PARENT_MODEL=((?:[^"\\]|\\.)*)"$/m.exec(text ?? "")?.[1];
	const model = raw?.replace(/\\(.)/g, "$1").replace(/%%/g, "%");
	return { generated: (text ?? "").includes("Generated by cp-install"), ...(model ? { model } : {}) };
}

/** The models a rendered wrapper exports; `generated` when cp-install wrote it. */
export function wrapperModels(text: string | undefined): { generated: boolean; parent?: string; operator?: string } {
	const parent = / CP_PARENT_MODEL='([^']*)'/.exec(text ?? "")?.[1];
	const operator = / CP_OPERATOR_MODEL='([^']*)'/.exec(text ?? "")?.[1];
	return { generated: (text ?? "").includes("Generated by cp-install"), ...(parent ? { parent } : {}), ...(operator ? { operator } : {}) };
}
