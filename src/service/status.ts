/**
 * `/doctor`'s always-on lines (cp-daemon v1 P2), spread inside
 * `viewerFindings` so `doctor.ts` gains no line:
 *
 *  - `service.daemon` / `service.legacy_units` (cp-txbb, `daemon-backend.ts`): cp-daemon running with
 *    healthy children, else why not (warn, never error); legacy cp-* unit files left over warn;
 *  - `service.node`: the node binary cp-daemon (`data/daemon.json`), else the legacy units, run still
 *    exists (an fnm upgrade removes it; fix: reinstall with --force);
 *  - `service.legacy_home`: the retired managed home holds a runtime root;
 *  - `service.health` (P3): the watchdog's last run (`state/health.json`) and
 *    what it finds failing; stale past 15 min warns;
 *  - `service.update` (P4): auto-update on/off and its last result; a failure, or a
 *    skip lasting > 24 h with origin/main ahead, warns.
 *  - `service.launchers`: Start session's launchers — tmux (cp-daemon installed, tmux on PATH, the wrapper:
 *    `tmuxLaunch`), herdr binary on PATH, herdr server running (src/viewer/launchers.ts);
 *
 * Nothing is installed → no line at all (a manual `bin/cp-operator` home is
 * not a fault). Read-only: never starts, stops or rewrites a unit.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DoctorFinding } from "../contracts.ts";
import type { CommandRunner } from "../doctor.ts";
import { cappedFinding } from "../doctor-caps.ts";
import { legacyManagedHome } from "../home.ts";
import { HEALTH_CHECKS, readHealth, UPDATE_FAILURES } from "./health.ts";
import { herdrServerArgv, herdrServerRunning, onPath, operatorWrapperPath, tmuxLaunch } from "../viewer/launchers.ts";
import { daemonFindings, LEGACY_UNITS, viewerExpected as backendViewerExpected } from "./daemon-backend.ts";
import { daemonPaths, readDaemonConfig } from "./daemon-files.ts";
import { HEALTH_TIMER, installTargets, OPERATOR_UNIT } from "./units.ts";
import { readUpdateState, updateStateFile } from "./update.ts";
/** A skip that has lasted this long with origin/main ahead is worth a look. */
const UPDATE_SKIP_WARN_MS = 24 * 3_600_000;
/** Two missed 5-minute runs: the timer is not firing. */
const HEALTH_STALE_MS = 15 * 60_000;

function unitText(unitDir: string, name: string): string | undefined {
	const file = join(unitDir, name);
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** The first ExecStart word (the node binary), unquoted. */
export function unitNode(text: string): string | undefined {
	const line = text.split("\n").find((row) => row.startsWith("ExecStart="));
	const match = line ? /^ExecStart="((?:[^"\\]|\\.)*)"/.exec(line) : undefined;
	return match?.[1]?.replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$");
}

/** True when a missing viewer is a fault: cp-daemon runs one (not held by an update), or a legacy cp-view.service is enabled. */
export function viewerExpected(run: CommandRunner, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return backendViewerExpected(run, cwd, installTargets(env).unitDir);
}

export function serviceFindings(run: CommandRunner, cwd: string, env: NodeJS.ProcessEnv = process.env, stateDir?: string, now = Date.now()): DoctorFinding[] {
	const { unitDir } = installTargets(env);
	const daemon = existsSync(daemonPaths(cwd).config);
	const legacyUnits = LEGACY_UNITS.filter((name) => unitText(unitDir, name) !== undefined);
	const operator = unitText(unitDir, OPERATOR_UNIT) !== undefined;
	const findings: DoctorFinding[] = daemonFindings(run, cwd, unitDir);
	if (daemon || legacyUnits.length > 0) findings.push(nodeFinding(cwd, unitDir, daemon ? [] : [...legacyUnits, ...(operator ? [OPERATOR_UNIT] : [])]));
	if (daemon || legacyUnits.length > 0 || operator) findings.push(launchersFinding(run, cwd, env, daemon));
	const health = stateDir ? healthFinding(stateDir, daemon || legacyUnits.includes(HEALTH_TIMER), now) : undefined;
	if (health) findings.push(health);
	const update = stateDir ? updateFinding(stateDir, daemon || legacyUnits.length > 0, now) : undefined;
	if (update) findings.push(update);
	const legacy = join(legacyManagedHome(env), ".pi-command-post");
	if (existsSync(legacy)) {
		findings.push({ check: "service.legacy_home", severity: "warn", what: `the retired managed home holds a runtime root: ${legacy}`, fix: "it is no longer read; move what you need into the standard home ~/.pi-command-post (or point CP_HOME at its parent), then remove it" });
	}
	// Capped once, here: every service finding joins the doctor report through this return (cp-daemon v1 doctor cap).
	return findings.map(cappedFinding);
}

/** `service.node`: `data/daemon.json`'s node, else the ExecStart node of the legacy `units`. */
function nodeFinding(home: string, unitDir: string, units: string[]): DoctorFinding {
	let nodes: string[];
	try {
		nodes = units.length ? units.map((name) => unitNode(unitText(unitDir, name) as string)).filter((node): node is string => node !== undefined) : [readDaemonConfig(daemonPaths(home).config)?.node].filter((node): node is string => node !== undefined);
	} catch {
		nodes = []; // an unreadable data/daemon.json is service.daemon's finding
	}
	const missing = [...new Set(nodes.filter((node) => !existsSync(node)))];
	const who = units.length ? "the legacy units run" : "cp-daemon runs";
	return missing.length > 0
		? { check: "service.node", severity: "error", what: `${who} ${missing.join(", ")}, which no longer exists (a node upgrade removed it)`, fix: "rerun the install with --force from the new node: sh scripts/install.sh --force (same --home/--app as before)" }
		: { check: "service.node", severity: "ok", what: `the node binary ${who} exists` };
}

/** `service.launchers`: what the dashboard's Start session can use — tmux (as the viewer decides it), the herdr binary, its server. */
function launchersFinding(run: CommandRunner, cwd: string, env: NodeJS.ProcessEnv, daemon: boolean): DoctorFinding {
	// The dashboard's Start session runs on the viewer's PATH (data/daemon.json `path`); an absent or unreadable config falls back to the caller's.
	let viewerPath = env.PATH ?? "";
	try {
		viewerPath = readDaemonConfig(daemonPaths(cwd).config)?.path ?? viewerPath;
	} catch {
		// unreadable data/daemon.json is service.daemon's finding
	}
	const tmux = "argv" in tmuxLaunch({ daemonRun: daemon, tmux: onPath("tmux", viewerPath), wrapper: operatorWrapperPath(env) });
	const herdr = onPath("herdr", env.PATH ?? "");
	const [bin, ...args] = herdr ? herdrServerArgv(herdr) : [];
	const server = bin ? herdrServerRunning(run(bin, args, cwd)) : false;
	const yes = (value: boolean) => (value ? "yes" : "no");
	return { check: "service.launchers", severity: "ok", what: `tmux ${yes(tmux)}, herdr binary ${yes(herdr !== undefined)}, herdr server running ${yes(server)}` };
}

/** `service.health`: the watchdog's last run and what it finds failing; no line when it is neither installed nor ever ran. */
function healthFinding(stateDir: string, timerInstalled: boolean, now: number): DoctorFinding | undefined {
	const record = readHealth(stateDir);
	if (!record) return timerInstalled ? { check: "service.health", severity: "warn", what: `the watchdog is installed but ${join(stateDir, "health.json")} is absent or unreadable`, fix: "cp-daemon health runs it now; cp-daemon log says why it fails" } : undefined;
	const age = Math.max(0, Math.round((now - Date.parse(record.last_run_at)) / 60_000));
	const failing = HEALTH_CHECKS.filter((name) => record.checks[name]?.status === "fail").map((name) => `${name} (${record.checks[name]!.detail})`);
	const stale = !(now - Date.parse(record.last_run_at) <= HEALTH_STALE_MS);
	const what = `health last ran ${age} min ago: ${failing.length ? `failing: ${failing.join("; ")}` : "all ok"}`;
	if (stale) return { check: "service.health", severity: "warn", what, fix: "the watchdog is not running every 5 min: cp-daemon status (start it if it is down), then cp-daemon log" };
	return failing.length ? { check: "service.health", severity: "warn", what, fix: "each failing check names its cause; the watchdog pushed once and pushes again on recovery" } : { check: "service.health", severity: "ok", what };
}

/** `service.update` (P4): on/off and the last result; never an error (the updater's own verify reads /doctor). */
function updateFinding(stateDir: string, timerInstalled: boolean, now: number): DoctorFinding | undefined {
	let record: ReturnType<typeof readUpdateState>;
	try {
		record = readUpdateState(stateDir);
	} catch (error) {
		return { check: "service.update", severity: "warn", what: (error as Error).message, fix: "remove it; the next cp-update run writes a fresh record" };
	}
	if (!record) return timerInstalled ? { check: "service.update", severity: "ok", what: "auto-update is installed; no update run recorded yet" } : undefined;
	const result = record.last_result ?? "none";
	const ago = record.last_run_at ? `${Math.max(0, Math.round((now - Date.parse(record.last_run_at)) / 3_600_000))}h ago` : "never";
	const what = `auto-update ${result} ${ago}${record.to ? ` (${record.to.slice(0, 7)})` : ""}${record.detail ? `: ${record.detail}` : ""}`;
	if (result === "migration_required") return { check: "service.update", severity: "warn", what, fix: "rerun cp-install (same --home/--app): it moves this home to cp-daemon; auto-update stays stopped until then" };
	if (record.phase === "rolling_back" && result === "rollback_failed") return { check: "service.update", severity: "warn", what, fix: "live workers held the rollback back (it never kills one); it drains and retries after 4× interval_min — cp-daemon log" };
	if (record.phase !== "idle") return { check: "service.update", severity: "ok", what: `auto-update in progress (phase ${record.phase})` };
	if (result === "skipped_disabled") return { check: "service.update", severity: "ok", what: "auto-update off (data/update.json)" };
	if (result === "rollback_failed") return { check: "service.update", severity: "warn", what, fix: `check the checkout by hand, then remove ${updateStateFile(stateDir)} to resume auto-update` };
	if (UPDATE_FAILURES.includes(result) || (result === "fetch_failed" && record.fetch_failures >= 3)) return { check: "service.update", severity: "warn", what, fix: "cp-daemon log; it retries on its own (a rolled-back sha never)" };
	const skipped = result.startsWith("skipped_") && record.since !== undefined && now - Date.parse(record.since) > UPDATE_SKIP_WARN_MS && (record.behind ?? 0) > 0;
	if (skipped) return { check: "service.update", severity: "warn", what: `${what}; skipped since ${record.since} with origin/main ${record.behind} commit(s) ahead`, fix: "clear the cause it names (a clean tree on main, not ahead, an idle fleet), or update by hand: git merge --ff-only origin/main at a quiet point" };
	return { check: "service.update", severity: "ok", what: `auto-update on: ${result} ${ago}${record.to ? ` ${record.to.slice(0, 7)}` : ""}` };
}

