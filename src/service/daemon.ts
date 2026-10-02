/**
 * `cp-daemon` (cp-wfo4): one always-on process per home — the parent
 * supervisor, the dashboard viewer, the health watchdog and the auto-updater.
 *
 *   run [--stdout]          the outer process (`daemon-outer.ts`); what a unit or `start` runs
 *   start | stop | restart  detached: setsid-spawn `run`, SIGTERM it; systemd: `systemctl --user` on
 *                           cp-daemon.service (`daemon-backend.ts`). The host and workers stay up.
 *   reload                  replace the inner runtime with one from the files on disk
 *   status                  exit 0 running, 3 not (like systemctl), with the start command
 *   health                  run the health check now (unless one is in flight)
 *   log [-n N]              the tail of state/daemon.log
 *
 * `--home H` (else CP_HOME). stop/restart/reload refuse while an update is in
 * flight (`state/update.json` phase ≠ idle) unless `--force`.
 *
 * Imports only `node:*` and `./daemon-*.ts` (`OUTER_SOURCES`): this file is
 * loaded by the outer process.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type RunResult, startCommand, systemdVerb } from "./daemon-backend.ts";
import { type DaemonReply, daemonRequest, RELOAD_TIMEOUT_MS } from "./daemon-control.ts";
import {
	baseEnv,
	type DaemonConfig,
	type DaemonPaths,
	daemonPaths,
	guardedKill,
	type LockRecord,
	logTail,
	OUTER_ARGV,
	pidAlive,
	psArgs,
	type RawKill,
	readDaemonConfig,
	readDaemonRuntime,
	readDaemonState,
	readJson,
	sameProcess,
} from "./daemon-files.ts";
import { type OuterPorts, runOuter } from "./daemon-outer.ts";

export const START_WAIT_MS = 30_000;
export const STOP_WAIT_MS = 30_000;
export const POLL_MS = 500;
export const EXIT_NOT_RUNNING = 3;

export interface CliPorts {
	env: NodeJS.ProcessEnv;
	out(line: string): void;
	now(): number;
	sleep(ms: number): Promise<void>;
	alive(pid: number): boolean;
	argsOf(pid: number): string | undefined;
	kill(pid: number, signal: "SIGTERM"): void;
	/** Detached (own session), stdio ignored, unref'd. Returns the pid, absent when the spawn failed. */
	spawnDetached(argv: string[], env: Record<string, string>, cwd: string): number | undefined;
	exists(path: string): boolean;
	request(home: string, op: string, timeoutMs?: number): Promise<DaemonReply>;
	run(home: string, stdout: boolean): Promise<number>;
	/** A command, synchronously (the systemd backend's `systemctl --user`). */
	exec(command: string, args: readonly string[]): RunResult;
}

/** The production `kill` ports of the CLI and the outer: guarded at their lowest level (`guardedKill`). */
export const cliKill = (log: (line: string) => void, raw?: RawKill): CliPorts["kill"] => guardedKill(log, raw);
export const outerKill = (log: (line: string) => void, raw?: RawKill): OuterPorts["kill"] => guardedKill(log, raw);

interface Args {
	verb: string;
	home?: string;
	force: boolean;
	stdout: boolean;
	lines: number;
}

function parse(argv: string[]): Args | string {
	const args: Args = { verb: argv[0] ?? "", force: false, stdout: false, lines: 50 };
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--home" && argv[i + 1]) args.home = argv[++i];
		else if (arg === "--force") args.force = true;
		else if (arg === "--stdout") args.stdout = true;
		else if (arg === "-n" && /^\d+$/.test(argv[i + 1] ?? "")) args.lines = Number(argv[++i]);
		else return `unknown argument ${JSON.stringify(arg)}`;
	}
	return args;
}

const USAGE = "usage: cp-daemon run|start|stop|restart|reload|status|health|log [--home H] [--force] [-n N]";

/** The live outer, by its lock and a `ps` identity check; undefined when none runs. */
function runningPid(paths: DaemonPaths, ports: CliPorts): number | undefined {
	let lock: LockRecord | undefined;
	try {
		lock = readJson<LockRecord>(paths.lock);
	} catch {
		return undefined;
	}
	return lock && sameProcess(lock.pid, OUTER_ARGV, ports) ? lock.pid : undefined;
}

export async function cli(argv: string[], ports: CliPorts): Promise<number> {
	const args = parse(argv);
	if (typeof args === "string") {
		ports.out(`${args}\n${USAGE}`);
		return 2;
	}
	if (!["run", "start", "stop", "restart", "reload", "status", "health", "log"].includes(args.verb)) {
		ports.out(USAGE);
		return 2;
	}
	const home = args.home ?? ports.env.CP_HOME;
	if (!home) {
		ports.out("cp-daemon: no home: pass --home <home> or set CP_HOME");
		return 2;
	}
	if (args.verb === "run") return ports.run(home, args.stdout);
	const paths = daemonPaths(home);
	let config: DaemonConfig | undefined;
	try {
		config = readDaemonConfig(paths.config);
	} catch (error) {
		ports.out(`cp-daemon: ${(error as Error).message}`);
		return 1;
	}

	const midUpdate = (): string | undefined => {
		if (args.force) return undefined;
		try {
			const phase = readJson<{ phase?: unknown }>(paths.update)?.phase;
			return phase === undefined || phase === "idle" ? undefined : `an update is in flight (state/update.json phase ${String(phase)}); retry when it is idle, or pass --force`;
		} catch (error) {
			return `cannot read the update record (${(error as Error).message}); pass --force to override`;
		}
	};
	const installed = (): string | undefined => (config ? undefined : `no ${paths.config}: run cp-install first`);
	const systemd = config?.backend === "systemd";
	const refuse = (why: string | undefined): boolean => {
		if (why) ports.out(`cp-daemon ${args.verb}: refused: ${why}`);
		return why !== undefined;
	};

	const stop = async (): Promise<number> => {
		const pid = runningPid(paths, ports);
		if (pid === undefined) {
			ports.out("cp-daemon: not running");
			return 0;
		}
		ports.kill(pid, "SIGTERM");
		for (const until = ports.now() + STOP_WAIT_MS; ports.now() < until; await ports.sleep(POLL_MS)) {
			if (!ports.alive(pid)) {
				ports.out(`cp-daemon: stopped pid ${pid} (the parent host and workers keep running)`);
				return 0;
			}
		}
		ports.out(`cp-daemon: pid ${pid} did not stop within ${STOP_WAIT_MS / 1000}s; see ${paths.log}`);
		return 1;
	};

	const start = async (cfg: DaemonConfig): Promise<number> => {
		const running = runningPid(paths, ports);
		if (running !== undefined) {
			ports.out(`cp-daemon: already running pid ${running}`);
			return 0;
		}
		if (!ports.exists(cfg.node)) {
			ports.out(`cp-daemon start: refused: ${cfg.node} is missing; rerun the install with --force from the new node`);
			return 1;
		}
		const env = { ...baseEnv(ports.env), PATH: cfg.path, CP_HOME: cfg.home, CP_MODE: "multi" };
		const pid = ports.spawnDetached([cfg.node, `${cfg.app}/src/service/daemon.ts`, "run", "--home", cfg.home], env, cfg.home);
		if (pid === undefined) {
			ports.out(`cp-daemon start: ${cfg.node} could not be spawned`);
			return 1;
		}
		for (const until = ports.now() + START_WAIT_MS; ports.now() < until; await ports.sleep(POLL_MS)) {
			let state;
			try {
				state = readDaemonState(paths);
			} catch {
				state = undefined;
			}
			if (state?.pid === pid && state.inner.state === "ready") {
				ports.out(`cp-daemon: started pid ${pid}; after a reboot: ${startCommand(cfg)}`);
				return 0;
			}
			if (state?.pid === pid && state.inner.state === "not_ready") {
				ports.out(`cp-daemon: pid ${pid} is running, but its runtime is not ready: ${state.inner.detail ?? "no detail"}; see cp-daemon status and cp-daemon log`);
				return 1;
			}
			if (!ports.alive(pid)) break;
		}
		ports.out(`cp-daemon: pid ${pid} is not ready within ${START_WAIT_MS / 1000}s; the log says:\n${logTail(paths.log, 20).join("\n")}`);
		return 1;
	};
	/** The systemd backend: the unit is the process manager. */
	const unit = (verb: "start" | "stop" | "restart"): number => {
		const { code, text } = systemdVerb(verb, (command, rest) => ports.exec(command, rest));
		ports.out(text);
		return code;
	};

	switch (args.verb) {
		case "start":
			if (refuse(installed())) return 1;
			return systemd ? unit("start") : start(config as DaemonConfig);
		case "stop":
			if (refuse(installed() ?? midUpdate())) return 1;
			return systemd ? unit("stop") : stop();
		case "restart": {
			if (refuse(installed() ?? midUpdate())) return 1;
			if (systemd) return unit("restart");
			const stopped = await stop();
			return stopped === 0 ? start(config as DaemonConfig) : stopped;
		}
		case "reload":
		case "health": {
			if (args.verb === "reload" && refuse(midUpdate())) return 1;
			const reply = await ports.request(home, args.verb, args.verb === "reload" ? RELOAD_TIMEOUT_MS : undefined);
			ports.out(reply.ok ? `cp-daemon ${args.verb}: ok${reply.detail ? ` (${reply.detail})` : ""}` : `cp-daemon ${args.verb}: failed: ${reply.error}`);
			return reply.ok ? 0 : 1;
		}
		case "log":
			ports.out(logTail(paths.log, args.lines).join("\n") || `(no log at ${paths.log})`);
			return 0;
		default:
			return status(paths, config, ports);
	}
}

function status(paths: DaemonPaths, config: DaemonConfig | undefined, ports: CliPorts): number {
	const pid = runningPid(paths, ports);
	if (pid === undefined) {
		ports.out("cp-daemon: not running");
		if (config) ports.out(`start it (also after a reboot): ${startCommand(config)}`);
		else ports.out(`no ${paths.config}: run cp-install`);
		return EXIT_NOT_RUNNING;
	}
	const lines: string[] = [];
	try {
		const state = readDaemonState(paths);
		const runtime = readDaemonRuntime(paths);
		lines.push(`cp-daemon: running pid ${pid}${state ? ` since ${state.started_at} (${state.backend}), outer ${state.outer_hash.slice(0, 12)}` : ""}`);
		if (state) lines.push(`inner: ${state.inner.state}${state.inner.detail ? ` (${state.inner.detail})` : ""}${state.inner.pid ? ` pid ${state.inner.pid}` : ""}, ${state.inner.restarts} restart(s)`);
		if (runtime) {
			for (const role of ["parent", "viewer"] as const) {
				const unit = runtime.units[role];
				lines.push(`${role}: ${unit.state}${unit.result ? ` (${unit.result})` : ""}${unit.pid ? ` pid ${unit.pid}` : ""}, ${unit.restarts} restart(s)`);
			}
			for (const job of ["health", "update"] as const) {
				const unit = runtime.units[job];
				lines.push(`${job}: ${unit.pid ? `running pid ${unit.pid}` : "idle"}, next ${unit.next_due}${unit.last_exit ? `, last exit ${unit.last_exit.code ?? unit.last_exit.signal}` : ""}`);
			}
			if (runtime.hold) lines.push(`viewer held until ${runtime.hold.until}`);
		}
		if (state?.last_reload) lines.push(`last reload: ${state.last_reload.ok ? "ok" : `failed (${state.last_reload.detail ?? ""})`} at ${state.last_reload.at}`);
	} catch (error) {
		lines.push(`cp-daemon: running pid ${pid}; its records are unreadable: ${(error as Error).message}`);
	}
	lines.push(`log: ${paths.log}`);
	if (config) lines.push(`after a reboot: ${config.backend === "systemd" ? `${startCommand(config)} (enabled units start at boot)` : startCommand(config)}`);
	ports.out(lines.join("\n"));
	return 0;
}

if (import.meta.main) {
	const ports: CliPorts = {
		env: process.env,
		out: (line) => void process.stdout.write(`${line}\n`),
		now: Date.now,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		alive: pidAlive,
		argsOf: psArgs,
		kill: cliKill((line) => void process.stderr.write(`cp-daemon: ${line}\n`)),
		spawnDetached: (argv, env, cwd) => {
			const child = spawn(argv[0] as string, argv.slice(1), { cwd, env, detached: true, stdio: "ignore" });
			child.once("error", (error) => void process.stderr.write(`cp-daemon: spawn ${argv[0]} failed: ${error.message}\n`));
			child.unref();
			return child.pid;
		},
		exists: existsSync,
		exec: (command, args) => {
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
		},
		request: daemonRequest,
		run: (home, stdout) => {
			const paths = daemonPaths(home);
			let out: number | "inherit" = "inherit";
			if (!stdout) {
				mkdirSync(paths.stateDir, { recursive: true });
				out = openSync(paths.log, "a", 0o600);
			}
			const log = (line: string): void => {
				const text = `${new Date().toISOString()} cp-daemon[${process.pid}]: ${line}\n`;
				if (out === "inherit") process.stderr.write(text);
				else writeSync(out, text);
			};
			const outer = runOuter(
				{ home },
				{
					pid: process.pid,
					now: Date.now,
					setTimer: (fn, ms) => {
						const timer = setTimeout(fn, ms);
						return () => clearTimeout(timer);
					},
					spawnInner: (config, env, onMessage, onExit) => {
						const child = spawn(config.node, [join(config.app, "src/service/daemon-runtime.ts")], { cwd: config.home, env, stdio: ["ignore", out, out, "ipc"] });
						child.on("message", onMessage);
						child.once("exit", onExit);
						child.once("error", (error) => {
							log(`inner spawn failed: ${error.message}`);
							if (child.pid === undefined) onExit(127, null);
						});
						return { pid: child.pid, send: (message) => void (child.connected && child.send(message as object)) };
					},
					kill: outerKill(log),
					alive: pidAlive,
					argsOf: psArgs,
					log,
					sourceDir: import.meta.dirname,
					base: baseEnv(process.env),
				},
			);
			process.on("SIGTERM", () => outer.stop());
			process.on("SIGINT", () => outer.stop());
			process.on("SIGHUP", () => log("SIGHUP ignored: the control API is the socket"));
			return outer.done;
		},
	};
	cli(process.argv.slice(2), ports).then(
		(code) => process.exit(code),
		(error: Error) => {
			process.stderr.write(`cp-daemon: ${error.stack ?? error.message}\n`);
			process.exit(1);
		},
	);
}
