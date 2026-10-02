/**
 * cp-daemon's outer layer (cp-wfo4): `cp-daemon run`. The preserved layer — it
 * changes only on a manual `cp-daemon restart`, a reboot or a unit restart,
 * never on `reload` — so a failed self-update always has a live process to
 * roll back under. It holds `state/daemon.lock`, serves the control socket
 * `state/daemon.sock` (token in the 0600 `state/daemon.json`, newline-JSON
 * frames: the parent-host pattern), keeps the capped `state/daemon.log`, and
 * runs exactly one inner runtime (`daemon-runtime.ts`) over IPC:
 *
 *  - an unexpected inner exit restarts it with the supervisor's backoff; 6
 *    starts in 30 min mark it `crash_looping` and it is retried every 300 s,
 *    never given up; an inner exit 78 (protocol/config) is `failed` until
 *    `reload` or `restart`;
 *  - `reload` stops the inner (≤ 20 s, then SIGKILL of that pid only) and
 *    starts a new one from the files now on disk, answering when it is ready;
 *  - SIGTERM stops the inner the same way, releases the lock, exits 0. The
 *    parent host, the parent and workers are never signalled (KillMode=process).
 *
 * Imports only `node:*` and `./daemon-*.ts`, never dynamically: what it
 * loaded at start is what `outer_hash` records.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
	atomicWrite,
	DAEMON_PROTOCOL,
	type DaemonConfig,
	type DaemonPaths,
	type DaemonState,
	daemonPaths,
	decodeFrames,
	encodeFrame,
	EXIT_CONFIG,
	iso,
	type LockRecord,
	logTail,
	OUTER_ARGV,
	outerHash,
	readDaemonConfig,
	restartDelay,
	rotateLog,
	sameProcess,
	START_LIMIT_BURST,
	START_LIMIT_INTERVAL_MS,
} from "./daemon-files.ts";

export const INNER_READY_MS = 60_000;
export const INNER_STOP_MS = 20_000;
export const CRASH_LOOP_RETRY_MS = 300_000;
export const ROTATE_EVERY_MS = 60_000;
export const FORWARD_TIMEOUT_MS = 10_000;

export interface InnerChild {
	/** Absent when the spawn failed: never a placeholder like -1, which `kill` would read as every process. */
	pid: number | undefined;
	send(message: unknown): void;
}

export interface OuterPorts {
	pid: number;
	now(): number;
	setTimer(fn: () => void, ms: number): () => void;
	spawnInner(config: DaemonConfig, env: Record<string, string>, onMessage: (message: unknown) => void, onExit: (code: number | null, signal: string | null) => void): InnerChild;
	kill(pid: number | undefined, signal: "SIGKILL"): void;
	alive(pid: number): boolean;
	argsOf(pid: number): string | undefined;
	log(line: string): void;
	/** Where `daemon.ts` and the other outer sources live (`outer_hash`). */
	sourceDir: string;
	/** The base env the inner (and every child) gets: HOME/USER/LOGNAME, plus XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS when set (`baseEnv`). */
	base: Record<string, string>;
}

export interface Outer {
	done: Promise<number>;
	stop(): void;
}

type LockResult = { ok: true; reclaimed?: LockRecord } | { ok: false; reason: string };

/** O_EXCL, a dead or pid-reused holder reclaimed (once, compare-then-unlink), a live `daemon.ts run` refused. */
export function acquireDaemonLock(paths: DaemonPaths, ports: Pick<OuterPorts, "pid" | "now" | "alive" | "argsOf">): LockResult {
	const record: LockRecord = { pid: ports.pid, started_at: iso(ports.now()), argv: OUTER_ARGV };
	const write = (): "ok" | "exists" | string => {
		try {
			const fd = openSync(paths.lock, "wx", 0o644);
			try {
				writeSync(fd, `${JSON.stringify(record)}\n`);
			} finally {
				closeSync(fd);
			}
			return "ok";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : (error as Error).message;
		}
	};
	const read = (): LockRecord | "absent" | undefined => {
		try {
			const value = JSON.parse(readFileSync(paths.lock, "utf8")) as LockRecord;
			return Number.isInteger(value?.pid) && typeof value.started_at === "string" ? value : undefined;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : undefined;
		}
	};
	const first = write();
	if (first === "ok") return { ok: true };
	if (first !== "exists") return { ok: false, reason: `cannot take ${paths.lock}: ${first}` };
	const held = read();
	if (held === undefined) return { ok: false, reason: `${paths.lock} is not a cp-daemon lock; inspect it and remove it if no cp-daemon runs` };
	if (held !== "absent" && sameProcess(held.pid, OUTER_ARGV, ports)) return { ok: false, reason: `cp-daemon already runs for this home: pid ${held.pid}, since ${held.started_at}` };
	const confirm = read();
	if (held !== "absent" && confirm !== "absent" && (confirm?.pid !== held.pid || confirm.started_at !== held.started_at)) return { ok: false, reason: `${paths.lock} changed while reclaiming it` };
	if (confirm !== "absent") rmSync(paths.lock, { force: true });
	const again = write();
	return again === "ok" ? { ok: true, ...(held !== "absent" ? { reclaimed: held } : {}) } : { ok: false, reason: `lost a race for ${paths.lock}: ${again}` };
}

/** Remove the lock only while it still names `pid`. */
export function releaseDaemonLock(paths: DaemonPaths, pid: number): boolean {
	try {
		if ((JSON.parse(readFileSync(paths.lock, "utf8")) as LockRecord).pid !== pid) return false;
		unlinkSync(paths.lock);
		return true;
	} catch {
		return false;
	}
}

interface Frame {
	id?: unknown;
	token?: unknown;
	protocol?: unknown;
	op?: unknown;
}

export function runOuter(options: { home: string }, ports: OuterPorts): Outer {
	let stopRequested = false;
	let stopNow: () => void = () => {
		stopRequested = true;
	};
	const done = (async (): Promise<number> => {
		const paths = daemonPaths(options.home);
		let config: DaemonConfig | undefined;
		try {
			config = readDaemonConfig(paths.config);
		} catch (error) {
			ports.log(`${(error as Error).message}; not starting (exit ${EXIT_CONFIG})`);
			return EXIT_CONFIG;
		}
		if (!config) {
			ports.log(`${paths.config} is absent: run cp-install; not starting (exit ${EXIT_CONFIG})`);
			return EXIT_CONFIG;
		}
		mkdirSync(paths.stateDir, { recursive: true });
		const lock = acquireDaemonLock(paths, ports);
		if (!lock.ok) {
			ports.log(`${lock.reason}; exiting ${EXIT_CONFIG}`);
			return EXIT_CONFIG;
		}
		if (lock.reclaimed) ports.log(`reclaimed ${paths.lock} from pid ${lock.reclaimed.pid} (not a running cp-daemon)`);
		const cfg = config;
		const startedAt = ports.now();
		const state: DaemonState = {
			schema_version: 1,
			protocol: DAEMON_PROTOCOL,
			pid: ports.pid,
			started_at: iso(startedAt),
			backend: cfg.backend,
			socket: paths.sock,
			token: randomBytes(32).toString("hex"),
			outer_hash: outerHash(ports.sourceDir),
			state: "running",
			inner: { state: "starting", since: iso(startedAt), restarts: 0 },
		};
		const save = (): void => {
			try {
				atomicWrite(paths.state, state, 0o600);
			} catch (error) {
				ports.log(`cannot write ${paths.state}: ${(error as Error).message}`);
			}
		};
		const setInner = (next: DaemonState["inner"]["state"], patch: Partial<DaemonState["inner"]> = {}): void => {
			state.inner = { ...state.inner, detail: undefined, ...patch, state: next, since: iso(ports.now()) };
			save();
		};
		const timers: Array<() => void> = [];
		const later = (fn: () => void, ms: number): void => void timers.push(ports.setTimer(fn, ms));

		// ---- the inner ------------------------------------------------------
		interface Live {
			child: InnerChild;
			exited: Promise<void>;
			stopping: boolean;
			ready?: (outcome: string | undefined) => void;
			replies: Map<string, (reply: { ok: boolean; detail?: string }) => void>;
		}
		let live: Live | undefined;
		let starts: number[] = [];
		let stopping = false;
		let reloading = false;
		let seq = 0;

		const spawn = (reason: "start" | "reload" | "restart"): Promise<string | undefined> => {
			const now = ports.now();
			starts = [...starts.filter((at) => now - at < START_LIMIT_INTERVAL_MS), now];
			let exitDone: () => void = () => {};
			const exited = new Promise<void>((resolve) => (exitDone = resolve));
			const env = { ...ports.base, CP_HOME: cfg.home, CP_MODE: "multi", PATH: cfg.path, CP_DAEMON_PROTOCOL: String(DAEMON_PROTOCOL), CP_DAEMON_STARTED_AT: iso(startedAt), CP_DAEMON_REASON: reason };
			let current: Live | undefined;
			const child = ports.spawnInner(
				cfg,
				env,
				(message) => {
					const event = message as { type?: string; detail?: string; id?: string; ok?: boolean };
					if (!current) return;
					if (event.type === "ready") {
						setInner("ready");
						current.ready?.(undefined);
					} else if (event.type === "failed") {
						// Running but not ready (its supervisor died at start): a distinct state, never left at `starting`.
						const detail = `the runtime reported: ${event.detail ?? "failed"}`;
						if (live === current) setInner("not_ready", { detail });
						current.ready?.(detail);
					} else if (event.type === "reply" && typeof event.id === "string") current.replies.get(event.id)?.({ ok: event.ok === true, ...(event.detail ? { detail: event.detail } : {}) });
				},
				(code, signal) => {
					const was = current;
					exitDone();
					if (!was || live !== was) return;
					live = undefined;
					const lastExit = { code, signal, at: iso(ports.now()) };
					state.inner.pid = undefined;
					for (const reply of was.replies.values()) reply({ ok: false, detail: "the runtime exited" });
					was.ready?.(`the runtime exited (${code ?? signal})`);
					if (was.stopping || stopping) return setInner("stopped", { last_exit: lastExit });
					if (code === EXIT_CONFIG) {
						ports.log(`inner pid ${was.child.pid} exited ${EXIT_CONFIG} (protocol or config): failed until cp-daemon reload or restart`);
						return setInner("failed", { last_exit: lastExit });
					}
					const looping = starts.filter((at) => ports.now() - at < START_LIMIT_INTERVAL_MS).length >= START_LIMIT_BURST;
					const delay = looping ? CRASH_LOOP_RETRY_MS : restartDelay(state.inner.restarts + 1);
					setInner(looping ? "crash_looping" : "restarting", { last_exit: lastExit, restarts: state.inner.restarts + 1 });
					ports.log(`inner pid ${was.child.pid} exited (${code ?? signal}); ${looping ? "crash looping, " : ""}restart in ${delay / 1000}s`);
					later(() => {
						if (!stopping && !live && !reloading) void spawn("restart");
					}, delay);
				},
			);
			current = { child, exited, stopping: false, replies: new Map() };
			live = current;
			setInner("starting", { pid: child.pid });
			ports.log(`inner started pid ${child.pid} (${reason})`);
			const self = current;
			return new Promise<string | undefined>((resolve) => {
				const cancel = ports.setTimer(() => {
					const detail = `not ready within ${INNER_READY_MS / 1000}s`;
					if (live === self && state.inner.state === "starting") setInner("not_ready", { detail });
					self.ready?.(detail);
				}, INNER_READY_MS);
				self.ready = (outcome) => {
					self.ready = undefined;
					cancel();
					resolve(outcome);
				};
			});
		};

		const stopInner = async (): Promise<void> => {
			const current = live;
			if (!current) return;
			current.stopping = true;
			current.child.send({ type: "request", id: "stop", op: "stop" });
			let timedOut = false;
			const cancel = ports.setTimer(() => {
				timedOut = true;
				ports.log(`inner pid ${current.child.pid} did not stop within ${INNER_STOP_MS / 1000}s: SIGKILL`);
				ports.kill(current.child.pid, "SIGKILL");
			}, INNER_STOP_MS);
			await current.exited;
			if (!timedOut) cancel();
		};

		const forward = (op: string): Promise<{ ok: boolean; detail?: string }> => {
			const current = live;
			if (!current || reloading) return Promise.resolve({ ok: false, detail: `no inner runtime to ask (${reloading ? "reloading" : state.inner.state})` });
			const id = `r${++seq}`;
			return new Promise((resolve) => {
				const cancel = ports.setTimer(() => finish({ ok: false, detail: `the runtime did not answer ${op} within ${FORWARD_TIMEOUT_MS / 1000}s` }), FORWARD_TIMEOUT_MS);
				const finish = (reply: { ok: boolean; detail?: string }): void => {
					cancel();
					current.replies.delete(id);
					resolve(reply);
				};
				current.replies.set(id, finish);
				current.child.send({ type: "request", id, op });
			});
		};

		const reload = async (): Promise<{ ok: boolean; detail?: string }> => {
			if (reloading) return { ok: false, detail: "a reload is already running" };
			if (stopping) return { ok: false, detail: "cp-daemon is stopping" };
			reloading = true;
			const id = `reload-${iso(ports.now())}`;
			try {
				ports.log("reload: stopping the inner runtime");
				await stopInner();
				state.inner.restarts = 0;
				const outcome = stopping ? "cp-daemon is stopping" : await spawn("reload");
				const detail = outcome ? `${outcome}; ${logTail(paths.log, 5).join(" | ")}` : undefined;
				state.last_reload = { id, at: iso(ports.now()), ok: !outcome, ...(detail ? { detail } : {}) };
				save();
				ports.log(`reload ${outcome ? `failed: ${outcome}` : "ok"}`);
				return { ok: !outcome, ...(detail ? { detail } : {}) };
			} finally {
				reloading = false;
			}
		};

		// ---- the control socket --------------------------------------------
		const answer = async (frame: Frame): Promise<Record<string, unknown>> => {
			if (frame.protocol !== DAEMON_PROTOCOL) return { ok: false, error: `protocol ${String(frame.protocol)}≠${DAEMON_PROTOCOL}` };
			switch (frame.op) {
				case "status": {
					const { token: _token, ...visible } = state;
					return { ok: true, state: visible };
				}
				case "reload":
					return reload();
				case "hold":
				case "release":
				case "health":
					return forward(frame.op);
				default:
					return { ok: false, error: `unknown op ${JSON.stringify(frame.op)}` };
			}
		};
		const serve = (socket: Socket): void => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("error", () => socket.destroy());
			socket.on("data", (chunk: string) => {
				const { frames, rest } = decodeFrames(buffer + chunk);
				buffer = rest.slice(0, 64 * 1024);
				for (const frame of frames as Frame[]) {
					if (frame instanceof Error || frame?.token !== state.token) {
						socket.destroy();
						return;
					}
					void answer(frame).then(
						(reply) => socket.writable && socket.write(encodeFrame({ id: frame.id, ...reply })),
						(error: Error) => socket.writable && socket.write(encodeFrame({ id: frame.id, ok: false, error: error.message })),
					);
				}
			});
		};
		rmSync(paths.sock, { force: true });
		const server: Server = createServer(serve);
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(paths.sock, () => resolve());
			});
			chmodSync(paths.sock, 0o600);
		} catch (error) {
			ports.log(`cannot listen on ${paths.sock}: ${(error as Error).message}`);
			releaseDaemonLock(paths, ports.pid);
			return 1;
		}
		save();
		ports.log(`running pid ${ports.pid} (${cfg.backend}), outer ${state.outer_hash.slice(0, 12)}`);

		// ---- the log cap -----------------------------------------------------
		const rotate = (): void => {
			try {
				if (rotateLog(paths.log, paths.prevLog)) ports.log(`rotated ${paths.log} to ${paths.prevLog}`);
			} catch (error) {
				ports.log(`log rotation failed: ${(error as Error).message}`);
			}
			if (!stopping) later(rotate, ROTATE_EVERY_MS);
		};
		rotate();

		let finished: () => void = () => {};
		const over = new Promise<void>((resolve) => (finished = resolve));
		stopNow = () => {
			if (stopping) return;
			stopping = true;
			void (async () => {
				ports.log("stopping: the inner runtime first; the parent host and workers are left running");
				for (const cancel of timers.splice(0)) cancel();
				await stopInner();
				state.state = "stopped";
				state.inner = { ...state.inner, pid: undefined, state: "stopped", since: iso(ports.now()) };
				save();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				rmSync(paths.sock, { force: true });
				releaseDaemonLock(paths, ports.pid);
				ports.log("stopped");
				finished();
			})();
		};
		if (stopRequested) stopNow();
		else {
			const outcome = await spawn("start");
			if (outcome && live) ports.log(`inner runtime not ready: ${outcome}`);
		}
		await over;
		return 0;
	})();
	return { done, stop: () => stopNow() };
}
