/**
 * Remote dashboard PR 2c: the cloudflared controller, owned by the cp-daemon inner (`daemon-runtime.ts`).
 *
 * The inner calls `reconcile()` at its start, on every 5 s tick and on a hold's release; it applies `data/tunnel.json`
 * (`readTunnelConfig`): enabled runs exactly one attached cloudflared with the fixed argv (`quickArgv`/`namedArgv`,
 * no shell, the named token only as a file path); disabled, absent or unreadable stops it. A changed command line
 * restarts the child; a changed revision alone is only acknowledged.
 *
 * `state/tunnel-runtime.json` (`TunnelRuntime`) is published on every transition: the owned child's pid and exact
 * command line, the config revision it answers, its state and the binding. A child is `running` once it registered a
 * tunnel connection on its origin — named: `https://<hostname>`; quick: the first `https://<label>.trycloudflare.com`
 * it printed. A new origin is a new generation (sessions and codes bound to the old one stop working); the same named
 * origin keeps its generation. The child's output reaches the daemon log only sanitized and bounded.
 *
 * An unexpected exit restarts on the supervisor's backoff (5 s growing to 5 min, reset once a run registers). `stop()`
 * (the daemon's stop, reload and update hold) cancels that timer and SIGTERMs the child, SIGKILL after 10 s if its
 * exit was not observed, and after 10 s more it stops tracking a child whose exit was never reported (logged), so a
 * stop always settles. A child recorded by a crashed inner is signalled only while `ps` still shows its exact
 * recorded command line, and nothing new starts until it is gone: never a kill by name or group, never an adoption.
 * An unreadable runtime record starts nothing (its generation is unknown, so publishing could revive old sessions);
 * every reconcile re-reads it, so fixing or removing it takes effect without a daemon restart.
 */
import { spawn as spawnChild } from "node:child_process";
import { namedArgv, quickArgv } from "../tunnel/cloudflared.ts";
import { atomicWrite, type DaemonPaths, iso, restartDelay, sameProcess } from "./daemon-files.ts";
import { readTunnelConfig, readTunnelRuntime, type TunnelConfig, type TunnelConfigRead, type TunnelRuntime, type TunnelRuntimeRead, tunnelRuntimeFile } from "./daemon-tunnel-files.ts";

export const TUNNEL_KILL_GRACE_MS = 10_000;
export const TUNNEL_ORPHAN_POLL_MS = 1_000;
/** Child output lines logged per run, then one "suppressed" line. */
export const TUNNEL_LOG_LINES = 200;
export const TUNNEL_LINE_MAX = 300;
const BUFFER_MAX = 8_192;

export interface TunnelIo {
	/** Spawn `file argv` attached, stdout and stderr piped into `onOutput`. `onExit` fires once; absent pid: the spawn failed. */
	spawn(file: string, argv: string[], onOutput: (chunk: string) => void, onExit: (code: number | null, signal: string | null) => void): number | undefined;
	readConfig(): TunnelConfigRead;
	readRuntime(): TunnelRuntimeRead;
	writeRuntime(runtime: TunnelRuntime): void;
}
export interface TunnelPorts extends TunnelIo {
	now(): number;
	setTimer(fn: () => void, ms: number): () => void;
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
	alive(pid: number): boolean;
	argsOf(pid: number): string | undefined;
	log(line: string): void;
}

/** The production I/O: an attached child, never through a shell, whose env (`env`) carries no credential. */
export function tunnelIo(paths: DaemonPaths, cwd: string, env: Record<string, string>, log: (line: string) => void): TunnelIo {
	return {
		spawn: (file, argv, onOutput, onExit) => {
			const child = spawnChild(file, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout?.setEncoding("utf8").on("data", onOutput);
			child.stderr?.setEncoding("utf8").on("data", onOutput);
			let fired = false;
			const once = (code: number | null, signal: string | null): void => {
				if (!fired) onExit(code, signal);
				fired = true;
			};
			child.once("exit", once);
			child.once("error", (error) => {
				log(`cloudflared spawn failed: ${error.message}`);
				queueMicrotask(() => once(127, null));
			});
			return child.pid;
		},
		readConfig: () => readTunnelConfig(paths.dataDir),
		readRuntime: () => readTunnelRuntime(paths.stateDir),
		writeRuntime: (runtime) => atomicWrite(tunnelRuntimeFile(paths.stateDir), runtime, 0o600),
	};
}

export interface TunnelController {
	/** Apply the desired config now (also resumes after `stop()`). */
	reconcile(): void;
	/** Stop the owned child and every restart timer until the next `reconcile()`. */
	stop(): void;
	/** An owned child or a recovered orphan is still alive. */
	busy(): boolean;
}

/** One output line as the log may carry it: no escapes or control bytes, long token-like runs redacted, bounded. */
export function sanitizeLine(line: string): string {
	return line
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\0-\x1f\x7f]+/g, " ")
		.replace(/[A-Za-z0-9+/_=-]{48,}/g, "[redacted]")
		.trim()
		.slice(0, TUNNEL_LINE_MAX);
}

const QUICK_RE = /https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com(?=[\s|"]|$)/;
/** The quick tunnel's origin in a line of its output: one `<label>.trycloudflare.com` over https, never the API host. */
export function quickOrigin(line: string): string | undefined {
	const match = QUICK_RE.exec(line);
	return match && match[1] !== "api" ? `https://${match[1]}.trycloudflare.com` : undefined;
}

type Spec = { binary: string; argv: string[]; mode: TunnelConfig["mode"]; port: number; revision: number; origin?: string };
type Child = { pid: number; spec: Spec; origin?: string; registered: boolean; requested: boolean; lines: number; buffer: string };

const commandLine = (binary: string, argv: readonly string[]): string => [binary, ...argv].join(" ");
const sameCommand = (a: Spec, b: Spec): boolean => commandLine(a.binary, a.argv) === commandLine(b.binary, b.argv);

function specOf(config: TunnelConfig): Spec {
	const argv = config.mode === "quick" ? quickArgv(config.port) : namedArgv(config.token_file as string);
	return { binary: config.binary, argv, mode: config.mode, port: config.port, revision: config.revision, ...(config.mode === "named" ? { origin: `https://${config.hostname}` } : {}) };
}

export function tunnelController(ports: TunnelPorts, onIdle: () => void): TunnelController {
	const now = (): string => iso(ports.now());
	let read = ports.readRuntime();
	if (!read.ok) ports.log(`the runtime record is unreadable, so no tunnel starts until it is fixed or removed: ${read.reason}`);
	let runtime: TunnelRuntime | null = read.ok ? read.runtime : null;
	let child: Child | undefined;
	let orphan: { pid: number; needle: string; deadline: number } | undefined;
	let restart: { cancel: () => void; spec: Spec } | undefined;
	let restarts = 0;
	let halted = false;

	const publish = (patch: Partial<TunnelRuntime>, drop: ReadonlyArray<keyof TunnelRuntime> = []): void => {
		const next: TunnelRuntime = { ...(runtime ?? { schema_version: 1, origin: null, generation: 0, revision: null, state: "stopped" }), ...patch, updated_at: now() };
		for (const key of drop) delete next[key];
		runtime = next;
		try {
			ports.writeRuntime(next);
		} catch (error) {
			ports.log(`cannot write the runtime record: ${(error as Error).message}`);
		}
	};
	const CHILD_FIELDS = ["pid", "started_at", "detail"] as const;

	const cancelRestart = (): void => {
		restart?.cancel();
		restart = undefined;
	};

	const terminate = (target: Child): void => {
		if (target.requested) return;
		target.requested = true;
		ports.kill(target.pid, "SIGTERM");
		// Not cancellable by stop(): an exit must be observed, whatever else is cancelled.
		ports.setTimer(() => {
			if (child !== target) return;
			ports.kill(target.pid, "SIGKILL");
			ports.log(`cloudflared pid ${target.pid} ignored SIGTERM: SIGKILL`);
			// SIGKILL cannot be ignored, but its exit report can still be lost: bounded, so a stop always settles.
			ports.setTimer(() => {
				if (child !== target) return;
				ports.log(`cloudflared pid ${target.pid} did not report its exit ${TUNNEL_KILL_GRACE_MS / 1000}s after SIGKILL; it is no longer tracked`);
				onExit(target, null, "SIGKILL");
			}, TUNNEL_KILL_GRACE_MS);
		}, TUNNEL_KILL_GRACE_MS);
	};

	const onLine = (target: Child, raw: string): void => {
		const line = sanitizeLine(raw);
		if (!line) return;
		target.lines += 1;
		if (target.lines <= TUNNEL_LOG_LINES) ports.log(`cloudflared: ${line}`);
		else if (target.lines === TUNNEL_LOG_LINES + 1) ports.log(`cloudflared: further output of pid ${target.pid} suppressed`);
		if (child !== target || target.requested) return;
		if (target.spec.mode === "quick" && !target.origin) target.origin = quickOrigin(line);
		if (target.registered || !target.origin || !/\bRegistered tunnel connection\b/.test(line)) return;
		target.registered = true;
		restarts = 0;
		const generation = (runtime?.generation ?? 0) + (runtime?.origin === target.origin ? 0 : 1);
		publish({ state: "running", origin: target.origin, generation }, ["detail"]);
		ports.log(`running on ${target.origin} (generation ${generation}, revision ${target.spec.revision})`);
	};

	const onExit = (target: Child, code: number | null, signal: string | null): void => {
		if (child !== target) return;
		child = undefined;
		const how = `${code ?? signal}`;
		if (target.requested || halted) {
			publish({ state: "stopped" }, CHILD_FIELDS);
			ports.log(`cloudflared pid ${target.pid} exited (${how}) as asked`);
			if (halted) onIdle();
			else reconcile();
			return;
		}
		scheduleRestart(target.spec, `cloudflared pid ${target.pid} exited (${how})`);
	};

	const scheduleRestart = (spec: Spec, why: string): void => {
		restarts += 1;
		const delay = restartDelay(restarts);
		publish({ state: "restarting", detail: `${why}; restart ${restarts} in ${delay / 1000}s` }, ["pid", "started_at"]);
		ports.log(`${why}; restart ${restarts} in ${delay / 1000}s`);
		const cancel = ports.setTimer(() => {
			restart = undefined;
			reconcile();
		}, delay);
		restart = { cancel, spec };
	};

	const start = (spec: Spec): void => {
		const target: Child = { pid: 0, spec, registered: false, requested: false, lines: 0, ...(spec.origin ? { origin: spec.origin } : {}), buffer: "" };
		const pid = ports.spawn(
			spec.binary,
			spec.argv,
			(chunk) => {
				const lines = `${target.buffer}${chunk}`.split(/\r?\n/);
				target.buffer = lines.pop() ?? "";
				if (target.buffer.length > BUFFER_MAX) target.buffer = "";
				for (const line of lines) onLine(target, line);
			},
			(code, signal) => onExit(target, code, signal),
		);
		if (pid === undefined) return scheduleRestart(spec, `cloudflared ${spec.binary} did not spawn`);
		target.pid = pid;
		child = target;
		publish({ state: "starting", revision: spec.revision, mode: spec.mode, port: spec.port, pid, binary: spec.binary, argv: spec.argv, started_at: now() }, ["detail"]);
		ports.log(`cloudflared started pid ${pid} (${spec.mode}, revision ${spec.revision})`);
	};

	/** No child wanted: the child goes; once none runs, the runtime says `state` for `revision`. */
	const quiesce = (state: "stopped" | "failed", revision: number | null, detail?: string): void => {
		cancelRestart();
		if (child) return terminate(child);
		if (!runtime && revision === null) return; // a home that never ran a tunnel gets no runtime file
		if (runtime?.state === state && runtime.revision === revision && runtime.detail === detail) return;
		publish({ state, revision, ...(detail ? { detail } : {}) }, detail ? CHILD_FIELDS.filter((key) => key !== "detail") : CHILD_FIELDS);
	};

	const reconcile = (): void => {
		halted = false;
		if (!read.ok) {
			// Re-read every tick: a fixed or removed record takes effect without a daemon restart.
			read = ports.readRuntime();
			if (!read.ok) return;
			runtime = read.runtime;
			ports.log("the runtime record is readable again");
			recover();
		}
		if (orphan) return;
		const config = ports.readConfig();
		if (!config.ok) return quiesce("failed", runtime?.revision ?? null, `config refused: ${config.reason}`);
		if (!config.config?.enabled) return quiesce("stopped", config.config?.revision ?? runtime?.revision ?? null);
		let spec: Spec;
		try {
			spec = specOf(config.config);
		} catch (error) {
			return quiesce("failed", config.config.revision, `config refused: ${(error as Error).message}`);
		}
		if (child) {
			if (!sameCommand(child.spec, spec)) return terminate(child);
			child.spec = { ...child.spec, revision: spec.revision };
			if (runtime?.revision !== spec.revision) publish({ revision: spec.revision });
			return;
		}
		if (restart) {
			if (sameCommand(restart.spec, spec)) return; // its timer re-reads the config
			cancelRestart(); // a new command line is a fresh start, not the next step of the old backoff
			restarts = 0;
		}
		start(spec);
	};

	// A child recorded by a crashed inner: signalled only while it still shows its exact recorded command line.
	const recover = (): void => {
		const prior = runtime;
		if (prior?.pid === undefined || !prior.binary || !prior.argv) return;
		const needle = commandLine(prior.binary, prior.argv);
		if (!sameProcess(prior.pid, needle, ports)) return publish({ state: "stopped" }, CHILD_FIELDS);
		orphan = { pid: prior.pid, needle, deadline: ports.now() + TUNNEL_KILL_GRACE_MS };
		ports.kill(prior.pid, "SIGTERM");
		ports.log(`stopping cloudflared pid ${prior.pid} of a previous runtime`);
		const wait = (): void => {
			if (!orphan) return;
			if (sameProcess(orphan.pid, orphan.needle, ports)) {
				if (ports.now() < orphan.deadline) return void ports.setTimer(wait, TUNNEL_ORPHAN_POLL_MS);
				ports.kill(orphan.pid, "SIGKILL");
				ports.log(`cloudflared pid ${orphan.pid} of a previous runtime ignored SIGTERM: SIGKILL`);
			}
			orphan = undefined;
			publish({ state: "stopped" }, CHILD_FIELDS);
			if (halted) onIdle();
			else reconcile();
		};
		ports.setTimer(wait, TUNNEL_ORPHAN_POLL_MS);
	};
	if (read.ok) recover();

	return {
		reconcile,
		stop: () => {
			halted = true;
			cancelRestart();
			if (child) terminate(child);
		},
		busy: () => child !== undefined || orphan !== undefined,
	};
}
