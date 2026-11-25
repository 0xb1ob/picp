/**
 * `/doctor`'s `viewer` finding: is `bin/cp-view` running? Advisory — the fleet
 * works without it. `bin/cp-operator` runs it for the operator session's
 * lifetime (src/viewer/operator.ts), so with no operator session up, "not
 * running" is information, not a fault. Both are found by command line.
 * Plus one `dashboard-control` line, and the always-on `service.*` lines
 * (src/service/status.ts); with cp-daemon (or a legacy cp-view.service) running one, a missing viewer warns.
 */

import type { DoctorFinding } from "../contracts.ts";
import type { CommandRunner } from "../doctor.ts";
import { type BoardsAddress, boardsAddress } from "./bind-host.ts";
import { DEFAULT_PORT } from "./cli.ts";
import { controlSocketFile, readControlConfig, readControlRecord } from "./control-files.ts";
import { loadViewerConfig, strictHost, viewerConfigFile } from "./host-config.ts";
import { pidAlive } from "./overview-health.ts";
import { hostHeaderFor } from "./server.ts";
import { resolveStateDir } from "./sessions.ts";
import { type DaemonConfig, daemonPaths, readDaemonConfig } from "../service/daemon-files.ts";
import { serviceFindings, viewerExpected } from "../service/status.ts";

function pidsOf(run: CommandRunner, cwd: string, pattern: string): string[] {
	const proc = run("pgrep", ["-f", pattern], cwd);
	return proc.status === 0 ? proc.stdout.trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid)) : [];
}

/** `env` is where the service lines read the unit dir and the legacy home: injected in tests so the host's own units never leak in. */
export function viewerFindings(run: CommandRunner, cwd: string, env: NodeJS.ProcessEnv = process.env): DoctorFinding[] {
	const stateDir = resolveStateDir(cwd);
	return [viewerFinding(run, cwd, env), dashboardControlFinding(stateDir), viewerHostFinding(stateDir), boardsFinding(cwd, env), ...serviceFindings(run, cwd, env, stateDir)];
}

/** One line: the opt-in boards-only listener, from CP_BOARDS_PORT when set, else data/daemon.json `boards_*`. */
export function boardsFinding(home: string, env: NodeJS.ProcessEnv): DoctorFinding {
	let config: DaemonConfig | undefined;
	try {
		config = readDaemonConfig(daemonPaths(home).config);
	} catch {
		config = undefined; // `service.daemon` reports an unreadable data/daemon.json
	}
	let boards: BoardsAddress | undefined;
	try {
		boards = env.CP_BOARDS_PORT ? boardsAddress(env) : config?.boards_port === undefined ? undefined
			: { port: config.boards_port, host: config.boards_host ?? "127.0.0.1", index: config.boards_index === true };
	} catch (error) {
		return { check: "boards", severity: "warn", what: `boards listener: ${(error as Error).message}`.slice(0, 200), fix: "fix or unset CP_BOARDS_PORT/CP_BOARDS_HOST/CP_BOARDS_INDEX" };
	}
	if (!boards) return { check: "boards", severity: "ok", what: "boards listener: off (no boards_port in data/daemon.json or CP_BOARDS_PORT); boards are served only by the dashboard" };
	const viewerPort = Number(env.CP_VIEWER_PORT);
	const dashboard = Number.isInteger(viewerPort) && viewerPort >= 1 && viewerPort <= 65535 ? viewerPort : config?.port ?? DEFAULT_PORT;
	if (boards.port === dashboard) {
		return { check: "boards", severity: "warn", what: `boards listener: boards_port ${boards.port} is the dashboard port; cp-view does not start it`, fix: "set another boards_port in data/daemon.json (or CP_BOARDS_PORT), then cp-daemon reload" };
	}
	return { check: "boards", severity: "ok", what: `boards listener: on ${hostHeaderFor(boards.host, boards.port)}, apart from the dashboard (${dashboard}): every published board is public to anyone who can reach it; /boards/ index ${boards.index ? "on" : "off"}` };
}

function viewerFinding(run: CommandRunner, cwd: string, env: NodeJS.ProcessEnv): DoctorFinding {
	const pids = pidsOf(run, cwd, "src/viewer/cli.ts");
	if (pids.length > 0) {
		return { check: "viewer", severity: "ok", what: `session viewer running (pid ${pids.join(", ")})` };
	}
	if (viewerExpected(run, cwd, env)) {
		return { check: "viewer", severity: "warn", what: "cp-daemon (or a legacy cp-view.service) should run the viewer, but none is running", fix: "cp-daemon status, then cp-daemon log (it binds CP_VIEWER_HOST, else `tailscale ip -4`); pin one with cp-install --viewer-host <ip> --force; cp-daemon reload" };
	}
	if (pidsOf(run, cwd, "src/viewer/operator.ts").length === 0) {
		return { check: "viewer", severity: "ok", what: "session viewer not running (no operator session up; bin/cp-operator starts it)" };
	}
	return {
		check: "viewer",
		severity: "warn",
		what: "an operator session is up but the session viewer is not running",
		fix: "optional: it runs with --require-tailnet, so check `tailscale ip -4` (or set CP_VIEWER_HOST), then restart bin/cp-operator (or run `bin/cp-view` in a terminal)",
	};
}

/** One line: does the local listener pin its bind Host (`viewer.strict_host`, data/viewer.json)? */
export function viewerHostFinding(stateDir: string): DoctorFinding {
	try {
		if (!loadViewerConfig(viewerConfigFile(stateDir)).strict_host) {
			return { check: "viewer-host", severity: "ok", what: "viewer Host check off (viewer.strict_host=false): any name that reaches this port is served; set viewer.strict_host=true to pin it" };
		}
		return { check: "viewer-host", severity: "ok", what: "viewer Host check on (viewer.strict_host=true): only the exact bind host:port is served" };
	} catch (error) {
		const message = (error as Error).message;
		const what = strictHost(stateDir) ? "viewer Host check on: data/viewer.json is invalid, so the bind Host is pinned"
			: "viewer Host check off: data/viewer.json public_url or boards_public_url is invalid, so board links skip it";
		return { check: "viewer-host", severity: "warn", what, detail: message.slice(0, 2000), fix: "fix data/viewer.json (only {\"strict_host\": true|false, \"public_url\": \"https://…\", \"boards_public_url\": \"https://…\"}) or remove it" };
	}
}

/** One line: is the dashboard allowed to steer the operator session, and is a session serving it? */
export function dashboardControlFinding(stateDir: string): DoctorFinding {
	const config = readControlConfig(stateDir);
	if (config.state === "invalid") {
		return { check: "dashboard-control", severity: "warn", what: `dashboard control: off (${config.reason})`, fix: "fix data/dashboard-control.json (only {\"enabled\": false}) or remove it" };
	}
	if (config.state === "off") return { check: "dashboard-control", severity: "ok", what: `dashboard control: off (${config.reason})` };
	const record = readControlRecord(stateDir);
	const serving = record.state === "ok" && pidAlive(record.record.pid)
		? `operator session pid ${record.record.pid} serving ${controlSocketFile(stateDir)}`
		: "no operator session serving it; the dashboard says session not running";
	return { check: "dashboard-control", severity: "ok", what: `dashboard control: on (${config.reason}; ${serving})` };
}
