/**
 * cp-daemon core (cp-wfo4): the pure half the outer (`daemon-outer.ts`), the
 * inner runtime (`daemon-runtime.ts`), the control client and the CLI share —
 * paths, the config schema, child env/argv, the restart policy, frames.
 *
 * Imports only `node:*`. The outer process loads this file once and never
 * re-imports it, so a merge or `npm ci` under a running outer never changes
 * its code; `outer_hash` (`outerHash`) records what it loaded.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";

/** Bumped when the outer↔inner IPC changes; an inner on a different protocol exits 78. */
export const DAEMON_PROTOCOL = 1;
export const EXIT_CONFIG = 78;
/** The files the outer process loads (daemon.ts and its static imports); `outer_hash` covers exactly these. */
export const OUTER_SOURCES = ["daemon.ts", "daemon-outer.ts", "daemon-files.ts", "daemon-control.ts", "daemon-backend.ts"] as const;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export type Role = "parent" | "viewer" | "health" | "update";
export type Backend = "systemd" | "detached";

const RUNTIME_DIR = ".pi-command-post";

export interface DaemonPaths {
	home: string;
	dataDir: string;
	stateDir: string;
	config: string;
	lock: string;
	state: string;
	sock: string;
	runtime: string;
	log: string;
	prevLog: string;
	/** The updater's record (`src/service/update.ts`): stop/restart/reload refuse while its phase is not idle. */
	update: string;
}

/**
 * The daemon's own paths. Derived here rather than from `layoutForHome` so the outer imports nothing
 * outside `node:*` (contracts pull typebox); `tests/daemon-files.test.ts` pins equality with the layout.
 */
export function daemonPaths(home: string): DaemonPaths {
	const abs = resolve(home);
	const root = basename(abs) === RUNTIME_DIR ? abs : join(abs, RUNTIME_DIR);
	const dataDir = join(root, "data");
	const stateDir = join(root, "state");
	return {
		home: abs,
		dataDir,
		stateDir,
		config: join(dataDir, "daemon.json"),
		lock: join(stateDir, "daemon.lock"),
		state: join(stateDir, "daemon.json"),
		sock: join(stateDir, "daemon.sock"),
		runtime: join(stateDir, "daemon-runtime.json"),
		log: join(stateDir, "daemon.log"),
		prevLog: join(stateDir, "daemon.prev.log"),
		update: join(stateDir, "update.json"),
	};
}

/** `data/daemon.json`: written by cp-install only, never holds a secret. */
export interface DaemonConfig {
	schema_version: 1;
	generated_by: "cp-install";
	backend: Backend;
	/** Absolute node binary every child runs. */
	node: string;
	/** The command-post checkout. */
	app: string;
	home: string;
	/** Already `unitPath(node, installPATH)`. */
	path: string;
	port: number;
	viewer_host?: string;
	parent_model?: string;
}

/** Strict: the first bad field is named. */
export function validateDaemonConfig(raw: unknown): DaemonConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("daemon config is not an object");
	const value = raw as Record<string, unknown>;
	const bad = (field: string, want: string): never => {
		throw new Error(`daemon config field ${field}: expected ${want}, got ${JSON.stringify(value[field])}`);
	};
	if (value.schema_version !== 1) bad("schema_version", "1");
	if (value.generated_by !== "cp-install") bad("generated_by", '"cp-install"');
	if (value.backend !== "systemd" && value.backend !== "detached") bad("backend", '"systemd" or "detached"');
	for (const field of ["node", "app", "home"]) if (typeof value[field] !== "string" || !(value[field] as string).startsWith("/")) bad(field, "an absolute path");
	if (typeof value.path !== "string" || value.path.length === 0) bad("path", "a non-empty PATH");
	if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) bad("port", "an integer 1-65535");
	for (const field of ["viewer_host", "parent_model"]) if (value[field] !== undefined && (typeof value[field] !== "string" || (value[field] as string).length === 0)) bad(field, "a non-empty string when present");
	return {
		schema_version: 1,
		generated_by: "cp-install",
		backend: value.backend as Backend,
		node: value.node as string,
		app: value.app as string,
		home: value.home as string,
		path: value.path as string,
		port: value.port as number,
		...(value.viewer_host ? { viewer_host: value.viewer_host as string } : {}),
		...(value.parent_model ? { parent_model: value.parent_model as string } : {}),
	};
}

/** A JSON record: `undefined` when absent; unreadable or corrupt throws naming the path. */
export function readJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new Error(`${path}: ${(error as Error).message}`);
	}
}

export function readDaemonConfig(path: string): DaemonConfig | undefined {
	const raw = readJson<unknown>(path);
	if (raw === undefined) return undefined;
	try {
		return validateDaemonConfig(raw);
	} catch (error) {
		throw new Error(`${path}: ${(error as Error).message}`);
	}
}

/** tmp + rename; `json-store.ts` is not importable here (it pulls pi-coding-agent). */
export function atomicWrite(path: string, value: unknown, mode = 0o600): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
	renameSync(tmp, path);
}

/**
 * What every role's process sees beyond its `Environment=` lines: HOME, USER, LOGNAME, and — when the outer has
 * them — XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, which the user manager supplied to the legacy units
 * implicitly (a git/gh credential helper or keyring may need the session bus). Nothing else from the shell.
 */
const BASE_ENV_KEYS = ["HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;
export function baseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of BASE_ENV_KEYS) if (env[key]) out[key] = env[key] as string;
	return out;
}

/** A role's env: the base, plus exactly what its legacy unit's `Environment=` carried, plus the daemon markers. */
export function childEnv(config: DaemonConfig, role: Role, base: Record<string, string>): Record<string, string> {
	const host: Record<string, string> = config.viewer_host ? { CP_VIEWER_HOST: config.viewer_host } : {};
	const core = { CP_HOME: config.home, CP_MODE: "multi", PATH: config.path };
	const port = { CP_VIEWER_PORT: String(config.port) };
	switch (role) {
		case "parent":
			return { ...base, ...core, ...port, ...host, ...(config.parent_model ? { CP_PARENT_MODEL: config.parent_model } : {}) };
		case "viewer":
			return { ...base, ...core, ...host, CP_DAEMON_ROLE: "viewer" };
		case "health":
		case "update":
			return { ...base, ...core, ...port, ...host, CP_DAEMON_JOB: role };
	}
}

const SCRIPTS: Record<Role, string> = { parent: "src/service/supervise.ts", viewer: "src/viewer/cli.ts", health: "src/service/health.ts", update: "src/service/update.ts" };

/** The script a role runs: also the `ps` needle that identifies a recorded pid as ours. */
export function roleScript(config: Pick<DaemonConfig, "app">, role: Role): string {
	return `${config.app}/${SCRIPTS[role]}`;
}

export function childArgv(config: DaemonConfig, role: Role): string[] {
	const script = roleScript(config, role);
	return role === "viewer" ? [config.node, script, "--home", config.home, "--require-tailnet", "--port", String(config.port)] : [config.node, script];
}

// ---------------------------------------------------------------------------
// Restart policy: cp-parent.service / cp-view.service semantics (systemd.service(5), service.c)
// ---------------------------------------------------------------------------

export const START_LIMIT_INTERVAL_MS = 1_800_000;
export const START_LIMIT_BURST = 6;
export const VIEWER_RESTART_MS = 10_000;

/** RestartSec=5, RestartSteps=5, RestartMaxDelaySec=300: the n-th automatic restart, in ms. */
export function restartDelay(n: number): number {
	return Math.round(Math.min(300, 5 * 60 ** ((Math.max(1, n) - 1) / 5)) * 1000);
}

export interface RestartHistory {
	/** Start times (ms) — manual and automatic; the start-limit window counts both. */
	starts: number[];
	/** Automatic restarts since the last manual start (reload/start reset it, uptime never does). */
	restarts: number;
	/** Viewer only: an update holds it down. */
	held?: boolean;
}

export interface ChildExit {
	code: number | null;
	signal: string | null;
	/** The daemon itself asked it to stop. */
	requested: boolean;
}

export type RestartDecision = { action: "restart"; delayMs: number } | { action: "stopped" } | { action: "failed"; result: "exit-code" | "start-limit-hit" };

export function decideRestart(role: "parent" | "viewer", history: RestartHistory, exit: ChildExit, now: number): RestartDecision {
	if (exit.requested) return { action: "stopped" };
	if (role === "viewer") return history.held ? { action: "stopped" } : { action: "restart", delayMs: VIEWER_RESTART_MS };
	if (exit.code === 0) return { action: "stopped" };
	if (exit.code === EXIT_CONFIG) return { action: "failed", result: "exit-code" };
	if (history.starts.filter((at) => now - at < START_LIMIT_INTERVAL_MS).length >= START_LIMIT_BURST) return { action: "failed", result: "start-limit-hit" };
	return { action: "restart", delayMs: restartDelay(history.restarts + 1) };
}

// ---------------------------------------------------------------------------
// Records and frames
// ---------------------------------------------------------------------------

export interface LockRecord {
	pid: number;
	started_at: string;
	argv: string;
}

export const OUTER_ARGV = "daemon.ts run";

/** `not_ready`: the inner runs but reported failed or never ready (its `detail` says why). */
export type InnerState = "starting" | "ready" | "not_ready" | "restarting" | "crash_looping" | "failed" | "stopped";

/** `state/daemon.json`: the outer's record, 0600 (it holds the socket token). */
export interface DaemonState {
	schema_version: 1;
	protocol: number;
	pid: number;
	started_at: string;
	backend: Backend;
	socket: string;
	token: string;
	outer_hash: string;
	state: "running" | "stopped";
	inner: { pid?: number; state: InnerState; detail?: string; since: string; restarts: number; last_exit?: { code: number | null; signal: string | null; at: string } };
	last_reload?: { id: string; at: string; ok: boolean; detail?: string };
}

export type UnitState = "starting" | "running" | "restarting" | "stopped" | "failed" | "held";

export interface LongUnit {
	state: UnitState;
	result?: string;
	pid?: number;
	starts: string[];
	restarts: number;
	last_exit?: { code: number | null; signal: string | null; at: string };
	since: string;
}

export interface OneshotUnit {
	pid?: number;
	started_at?: string;
	term_at?: string;
	last_exit?: { code: number | null; signal: string | null; at: string };
	last_start?: string;
	next_due: string;
}

/** `state/daemon-runtime.json`: the inner's record, rewritten atomically on every transition. */
export interface RuntimeRecord {
	schema_version: 1;
	pid: number;
	protocol: number;
	started_at: string;
	/** The outer's start: timers carry over across reloads of the same outer only. */
	daemon_started_at: string;
	units: { parent: LongUnit; viewer: LongUnit; health: OneshotUnit; update: OneshotUnit };
	hold?: { until: string };
}

export const readDaemonState = (paths: DaemonPaths): DaemonState | undefined => readJson<DaemonState>(paths.state);
export const readDaemonRuntime = (paths: DaemonPaths): RuntimeRecord | undefined => readJson<RuntimeRecord>(paths.runtime);

export function encodeFrame(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/** Split complete newline-JSON frames off `buffer`; a malformed frame is returned as an Error. */
export function decodeFrames(buffer: string): { frames: unknown[]; rest: string } {
	const lines = buffer.split("\n");
	const rest = lines.pop() as string;
	const frames = lines.filter((line) => line.trim()).map((line) => {
		try {
			return JSON.parse(line) as unknown;
		} catch (error) {
			return new Error(`bad frame: ${(error as Error).message}`);
		}
	});
	return { frames, rest };
}

// ---------------------------------------------------------------------------
// Processes, log, hash
// ---------------------------------------------------------------------------

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** `ps -o args= -p <pid>` (Linux and macOS); undefined when there is no such process. */
export function psArgs(pid: number): string | undefined {
	try {
		return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** The identity check before any signal: alive, and its command line still names `needle` (a pid is reused). */
export function sameProcess(pid: number | undefined, needle: string, ports: { alive(pid: number): boolean; argsOf(pid: number): string | undefined }): boolean {
	return pid !== undefined && pid > 0 && ports.alive(pid) && (ports.argsOf(pid)?.includes(needle) ?? false);
}

export type RawKill = (pid: number, signal: NodeJS.Signals) => void;
export const processKill: RawKill = (pid, signal) => void process.kill(pid, signal);

/**
 * The lowest level of every production kill port: a pid that is not an integer > 1 is refused and
 * logged, never signalled. -1 is every process this user owns (the parent host and its workers), 0 our
 * own process group, 1 init, and absent is a spawn that failed. A failed signal (ESRCH) is logged.
 */
export function guardedKill(log: (line: string) => void, raw: RawKill = processKill): (pid: number | undefined, signal: NodeJS.Signals) => void {
	return (pid, signal) => {
		if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return log(`refused to send ${signal} to pid ${String(pid)}: not one process`);
		try {
			raw(pid, signal);
		} catch (error) {
			log(`kill ${signal} ${pid}: ${(error as Error).message}`);
		}
	};
}

/** Over `max`: copy to the previous log and truncate in place (children append through O_APPEND, so this is safe). */
export function rotateLog(log: string, prevLog: string, max = LOG_MAX_BYTES): boolean {
	if (!existsSync(log) || statSync(log).size <= max) return false;
	copyFileSync(log, prevLog);
	truncateSync(log, 0);
	return true;
}

export function logTail(log: string, n: number): string[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0).slice(-n);
}

/** sha256 over the outer's own sources in `dir` (src/service): doctor compares it with the files on disk. */
export function outerHash(dir: string): string {
	const hash = createHash("sha256");
	for (const name of OUTER_SOURCES) hash.update(name).update("\0").update(readFileSync(join(dir, name))).update("\0");
	return hash.digest("hex");
}

/** One POSIX sh word in double quotes. */
function dq(value: string): string {
	return `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
}

/** The one documented post-reboot command (no root): absolute node, so the login shell's node manager never matters. */
export function rebootCommand(config: Pick<DaemonConfig, "node" | "app" | "home">): string {
	return `${dq(config.node)} ${dq(`${config.app}/src/service/daemon.ts`)} start --home ${dq(config.home)}`;
}

export const iso = (ms: number): string => new Date(ms).toISOString();
