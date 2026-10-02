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
import { controlSocketFile, readControlConfig, readControlRecord } from "./control-files.ts";
import { pidAlive } from "./overview-health.ts";
import { resolveStateDir } from "./sessions.ts";
import { serviceFindings, viewerExpected } from "../service/status.ts";

function pidsOf(run: CommandRunner, cwd: string, pattern: string): string[] {
	const proc = run("pgrep", ["-f", pattern], cwd);
	return proc.status === 0 ? proc.stdout.trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid)) : [];
}

/** `env` is where the service lines read the unit dir and the legacy home: injected in tests so the host's own units never leak in. */
export function viewerFindings(run: CommandRunner, cwd: string, env: NodeJS.ProcessEnv = process.env): DoctorFinding[] {
	const stateDir = resolveStateDir(cwd);
	return [viewerFinding(run, cwd, env), dashboardControlFinding(stateDir), ...serviceFindings(run, cwd, env, stateDir)];
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
