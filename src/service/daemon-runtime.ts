/**
 * cp-daemon's inner runtime (cp-wfo4): the IPC child of the outer
 * (`daemon-outer.ts`), restarted on a crash and replaced on `reload`, so it
 * is the layer that moves onto new code. It runs, with the legacy units'
 * semantics:
 *
 *  - the supervisor (`supervise.ts`, cp-parent.service): on-failure with
 *    backoff, exit 78 → failed, a 7th start in 30 min → failed;
 *  - the viewer (cp-view.service): restarted 10 s after any exit, unless held;
 *  - health and update (the timers): detached oneshots every 5 min, first at
 *    +3/+10 min from the daemon's start, each with its own timeout, and never
 *    signalled on stop or reload — the updater survives the reload it asked for.
 *
 * Signals only pids it spawned, or recorded pids whose `ps` args still name
 * the role's script. Never a process group, never the parent host.
 *
 * Imports only `node:*` and `./daemon-files.ts`.
 */
import { spawn as spawnChild } from "node:child_process";
import {
	childArgv,
	childEnv,
	DAEMON_PROTOCOL,
	type DaemonConfig,
	daemonPaths,
	decideRestart,
	EXIT_CONFIG,
	atomicWrite,
	baseEnv,
	iso,
	type LongUnit,
	type OneshotUnit,
	guardedKill,
	pidAlive,
	psArgs,
	readDaemonConfig,
	readDaemonRuntime,
	type Role,
	roleScript,
	type RawKill,
	type RuntimeRecord,
	sameProcess,
	START_LIMIT_INTERVAL_MS,
} from "./daemon-files.ts";

export const TICK_MS = 5_000;
export const READY_AFTER_MS = 5_000;
export const PERIOD_MS = 5 * 60_000;
export const FIRST_DUE_MS = { health: 3 * 60_000, update: 10 * 60_000 } as const;
export const TIMEOUT_MS = { health: 120_000, update: 45 * 60_000 } as const;
export const KILL_GRACE_MS = 10_000;
/** Longer than the 45-min update timeout: a hold never outlives a dead updater for long. */
export const HOLD_MAX_MS = 50 * 60_000;

type Long = "parent" | "viewer";
type Job = "health" | "update";

export type InnerSignal = "SIGTERM" | "SIGKILL";
export type InnerEvent = { type: "ready" } | { type: "failed"; detail: string };
export interface InnerReply {
	ok: boolean;
	detail?: string;
}

export interface InnerPorts {
	now(): number;
	setTimer(fn: () => void, ms: number): () => void;
	/** Spawn a role: supervisor/viewer attached, oneshots detached and unref'd. `onExit` fires once. Returns the pid, absent when the spawn failed. */
	spawn(role: Role, argv: string[], env: Record<string, string>, onExit: (code: number | null, signal: string | null) => void): number | undefined;
	kill(pid: number, signal: InnerSignal): void;
	alive(pid: number): boolean;
	argsOf(pid: number): string | undefined;
	readRuntime(): RuntimeRecord | undefined;
	writeRuntime(record: RuntimeRecord): void;
	send(event: InnerEvent): void;
	log(line: string): void;
}

/** The production `kill` port: guarded at its lowest level (`guardedKill`), so no invalid pid reaches `process.kill`. */
export const innerKill = (log: (line: string) => void, raw?: RawKill): InnerPorts["kill"] => guardedKill(log, raw);

export interface InnerOptions {
	config: DaemonConfig;
	base: Record<string, string>;
	pid: number;
	/** The outer's start (ms): timers are due relative to it. */
	daemonStartedAt: number;
	/** `reload` clears a hold (it is the update's own restart); a crash restart honours it. */
	reason: "start" | "reload" | "restart";
}

export interface Inner {
	done: Promise<number>;
	handle(op: string): InnerReply;
	stop(): void;
}

export function runInner(options: InnerOptions, ports: InnerPorts): Inner {
	const { config } = options;
	const now = (): number => ports.now();
	const at = (): string => iso(now());
	let prior: RuntimeRecord | undefined;
	try {
		prior = ports.readRuntime();
	} catch (error) {
		ports.log(`ignoring the prior runtime record: ${(error as Error).message}`);
	}
	const sameOuter = prior?.daemon_started_at === iso(options.daemonStartedAt);
	const long = (unit: LongUnit | undefined): LongUnit => ({ state: "starting", starts: (unit?.starts ?? []).filter((start) => now() - Date.parse(start) < START_LIMIT_INTERVAL_MS), restarts: 0, since: at() });
	const oneshot = (job: Job): OneshotUnit => {
		const unit = prior?.units?.[job];
		const adopt = unit?.pid !== undefined && sameProcess(unit.pid, roleScript(config, job), ports);
		if (adopt) ports.log(`adopted the in-flight ${job} run pid ${unit?.pid}`);
		return {
			next_due: sameOuter && unit?.next_due ? unit.next_due : iso(options.daemonStartedAt + FIRST_DUE_MS[job]),
			...(unit?.last_start ? { last_start: unit.last_start } : {}),
			...(unit?.last_exit ? { last_exit: unit.last_exit } : {}),
			...(adopt ? { pid: unit?.pid, started_at: unit?.started_at ?? at(), ...(unit?.term_at ? { term_at: unit.term_at } : {}) } : {}),
		};
	};
	const keepHold = options.reason !== "reload" && prior?.hold && Date.parse(prior.hold.until) > now();
	const record: RuntimeRecord = {
		schema_version: 1,
		pid: options.pid,
		protocol: DAEMON_PROTOCOL,
		started_at: at(),
		daemon_started_at: iso(options.daemonStartedAt),
		units: { parent: long(prior?.units?.parent), viewer: long(prior?.units?.viewer), health: oneshot("health"), update: oneshot("update") },
		...(keepHold && prior?.hold ? { hold: prior.hold } : {}),
	};
	const save = (): void => {
		try {
			ports.writeRuntime(record);
		} catch (error) {
			ports.log(`cannot write the runtime record: ${(error as Error).message}`);
		}
	};
	const requested = new Set<number>();
	const owned = new Set<number>();
	const cancels: Array<() => void> = [];
	const later = (fn: () => void, ms: number): void => void cancels.push(ports.setTimer(fn, ms));
	let stopping = false;
	let finish: (code: number) => void = () => {};
	const done = new Promise<number>((resolve) => (finish = resolve));

	const startLong = (role: Long): void => {
		const unit = record.units[role];
		unit.starts = [...unit.starts.filter((start) => now() - Date.parse(start) < START_LIMIT_INTERVAL_MS), at()];
		const pid = ports.spawn(role, childArgv(config, role), childEnv(config, role, options.base), (code, signal) => onLongExit(role, pid, code, signal));
		Object.assign(unit, { pid, state: "running", since: at() });
		delete unit.result;
		ports.log(`${role} started pid ${pid}`);
		save();
	};

	const onLongExit = (role: Long, pid: number | undefined, code: number | null, signal: string | null): void => {
		const unit = record.units[role];
		if (unit.pid !== pid) return;
		delete unit.pid;
		unit.last_exit = { code, signal, at: at() };
		unit.since = at();
		const wasRequested = pid !== undefined && requested.delete(pid);
		if (stopping) {
			unit.state = "stopped";
			save();
			return settle();
		}
		const held = role === "viewer" && record.hold !== undefined;
		const decision = decideRestart(role, { starts: unit.starts.map(Date.parse), restarts: unit.restarts, held }, { code, signal, requested: wasRequested }, now());
		if (decision.action === "restart") {
			unit.state = "restarting";
			unit.restarts += 1;
			later(() => {
				if (!stopping && unit.state === "restarting") startLong(role);
			}, decision.delayMs);
			ports.log(`${role} pid ${pid} exited (${code ?? signal}); restart ${unit.restarts} in ${decision.delayMs / 1000}s`);
		} else if (decision.action === "stopped") {
			unit.state = held ? "held" : "stopped";
			ports.log(`${role} pid ${pid} exited (${code ?? signal}); ${unit.state}`);
		} else {
			unit.state = "failed";
			unit.result = decision.result;
			ports.log(`${role} pid ${pid} exited (${code ?? signal}); failed (${decision.result}), not restarting`);
		}
		save();
	};

	const terminate = (role: Long): void => {
		const pid = record.units[role].pid;
		if (pid === undefined) return;
		requested.add(pid);
		ports.kill(pid, "SIGTERM");
	};

	const startJob = (job: Job): void => {
		const unit = record.units[job];
		const pid = ports.spawn(job, childArgv(config, job), childEnv(config, job, options.base), (code, signal) => {
			if (pid !== undefined) owned.delete(pid);
			if (unit.pid !== pid) return;
			delete unit.pid;
			delete unit.started_at;
			delete unit.term_at;
			unit.last_exit = { code, signal, at: at() };
			ports.log(`${job} pid ${pid} exited (${code ?? signal})`);
			save();
		});
		if (pid !== undefined) owned.add(pid);
		Object.assign(unit, { pid, started_at: at(), last_start: at(), next_due: iso(now() + PERIOD_MS) });
		delete unit.term_at;
		ports.log(`${job} started pid ${pid}`);
		save();
	};

	const release = (why: string): void => {
		if (!record.hold) return;
		delete record.hold;
		ports.log(`viewer hold released (${why})`);
		if (record.units.viewer.pid === undefined && !stopping) startLong("viewer");
		else save();
	};

	const tickJob = (job: Job): void => {
		const unit = record.units[job];
		const script = roleScript(config, job);
		if (unit.pid !== undefined && !owned.has(unit.pid) && !sameProcess(unit.pid, script, ports)) {
			ports.log(`adopted ${job} pid ${unit.pid} is gone`);
			delete unit.pid;
			delete unit.started_at;
			delete unit.term_at;
			unit.last_exit = { code: null, signal: null, at: at() };
			save();
		}
		if (unit.pid !== undefined) {
			if (!unit.term_at && now() - Date.parse(unit.started_at ?? at()) >= TIMEOUT_MS[job]) {
				if (sameProcess(unit.pid, script, ports)) ports.kill(unit.pid, "SIGTERM");
				unit.term_at = at();
				ports.log(`${job} pid ${unit.pid} timed out after ${TIMEOUT_MS[job] / 1000}s: SIGTERM`);
				save();
			} else if (unit.term_at && now() - Date.parse(unit.term_at) >= KILL_GRACE_MS && sameProcess(unit.pid, script, ports)) {
				ports.kill(unit.pid, "SIGKILL");
				ports.log(`${job} pid ${unit.pid} ignored SIGTERM: SIGKILL`);
			}
		}
		if (now() < Date.parse(unit.next_due)) return;
		if (unit.pid !== undefined) {
			unit.next_due = iso(now() + PERIOD_MS);
			ports.log(`${job} due while pid ${unit.pid} is still running: skipped`);
			save();
		} else startJob(job);
	};

	const tick = (): void => {
		if (stopping) return;
		if (record.hold && now() >= Date.parse(record.hold.until)) release("its 50-min deadline passed");
		tickJob("health");
		tickJob("update");
		later(tick, TICK_MS);
	};

	const begin = (): void => {
		if (stopping) return;
		startLong("parent");
		if (record.hold) {
			record.units.viewer.state = "held";
			save();
		} else startLong("viewer");
		const initial = { parent: record.units.parent.pid, viewer: record.units.viewer.pid };
		later(() => {
			if (stopping) return;
			const bad = (["parent", "viewer"] as const).filter((role) => !(role === "viewer" && record.hold) && record.units[role].pid !== initial[role]);
			if (bad.length === 0) ports.send({ type: "ready" });
			else ports.send({ type: "failed", detail: bad.map((role) => `${role} exited within ${READY_AFTER_MS / 1000}s (${JSON.stringify(record.units[role].last_exit ?? null)}), now ${record.units[role].state}`).join("; ") });
		}, READY_AFTER_MS);
		later(tick, TICK_MS);
	};

	// Orphans of a crashed inner (attached children do not die with their parent): stop them before spawning anew.
	const orphans = (["parent", "viewer"] as const).map((role) => ({ pid: prior?.units?.[role]?.pid, script: roleScript(config, role) })).filter((orphan): orphan is { pid: number; script: string } => sameProcess(orphan.pid, orphan.script, ports));
	const orphanAlive = (): number[] => orphans.filter((orphan) => sameProcess(orphan.pid, orphan.script, ports)).map((orphan) => orphan.pid);
	save();
	if (orphans.length === 0) begin();
	else {
		for (const orphan of orphans) ports.kill(orphan.pid, "SIGTERM");
		ports.log(`stopping orphaned children of a previous runtime: ${orphans.map((orphan) => orphan.pid).join(", ")}`);
		const deadline = now() + KILL_GRACE_MS;
		const wait = (): void => {
			const left = orphanAlive();
			if (left.length === 0) return begin();
			if (now() >= deadline) {
				for (const pid of left) ports.kill(pid, "SIGKILL");
				return begin();
			}
			later(wait, 1_000);
		};
		later(wait, 1_000);
	}

	let settled = false;
	const settle = (): void => {
		if (settled || record.units.parent.pid !== undefined || record.units.viewer.pid !== undefined) return;
		settled = true;
		save();
		ports.log("stopped (oneshots left running)");
		finish(0);
	};

	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		for (const cancel of cancels.splice(0)) cancel();
		for (const role of ["parent", "viewer"] as const) {
			if (record.units[role].pid === undefined && record.units[role].state !== "failed") record.units[role].state = "stopped";
			terminate(role);
		}
		ports.setTimer(() => {
			for (const role of ["parent", "viewer"] as const) {
				const pid = record.units[role].pid;
				if (pid === undefined) continue;
				ports.kill(pid, "SIGKILL");
				ports.log(`${role} pid ${pid} ignored SIGTERM: SIGKILL`);
			}
		}, KILL_GRACE_MS);
		settle();
	};

	const handle = (op: string): InnerReply => {
		switch (op) {
			case "stop":
				stop();
				return { ok: true };
			case "hold":
				record.hold = { until: iso(now() + HOLD_MAX_MS) };
				if (record.units.viewer.pid !== undefined) terminate("viewer");
				else record.units.viewer.state = "held";
				ports.log(`viewer held until ${record.hold.until}`);
				save();
				return { ok: true };
			case "release":
				release("released");
				return { ok: true };
			case "health":
				if (record.units.health.pid !== undefined) return { ok: true, detail: `health pid ${record.units.health.pid} is already running` };
				startJob("health");
				return { ok: true, detail: `health started pid ${record.units.health.pid}` };
			default:
				return { ok: false, detail: `unknown op ${JSON.stringify(op)}` };
		}
	};

	return { done, handle, stop };
}

if (import.meta.main) {
	const log = (line: string): void => void process.stderr.write(`${new Date().toISOString()} cp-daemon inner[${process.pid}]: ${line}\n`);
	const refuse = (why: string): never => {
		log(`${why}; exiting ${EXIT_CONFIG}`);
		process.exit(EXIT_CONFIG);
	};
	if (process.env.CP_DAEMON_PROTOCOL !== String(DAEMON_PROTOCOL)) refuse(`the outer speaks protocol ${process.env.CP_DAEMON_PROTOCOL ?? "none"}, this runtime ${DAEMON_PROTOCOL}: run cp-daemon restart`);
	if (!process.send) refuse("not started by cp-daemon (no IPC channel)");
	const home = process.env.CP_HOME ?? refuse("CP_HOME is not set");
	const paths = daemonPaths(home);
	let config: DaemonConfig | undefined;
	try {
		config = readDaemonConfig(paths.config);
	} catch (error) {
		refuse((error as Error).message);
	}
	if (!config) refuse(`${paths.config} is absent`);
	const send = (message: unknown): void => {
		if (process.connected) process.send?.(message);
	};
	const inner = runInner(
		{
			config: config as DaemonConfig,
			base: baseEnv(process.env),
			pid: process.pid,
			daemonStartedAt: Date.parse(process.env.CP_DAEMON_STARTED_AT ?? "") || Date.now(),
			reason: process.env.CP_DAEMON_REASON === "reload" || process.env.CP_DAEMON_REASON === "restart" ? process.env.CP_DAEMON_REASON : "start",
		},
		{
			now: Date.now,
			setTimer: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return () => clearTimeout(timer);
			},
			spawn: (role, argv, env, onExit) => {
				const oneshot = role === "health" || role === "update";
				const child = spawnChild(argv[0] as string, argv.slice(1), { cwd: (config as DaemonConfig).home, env, stdio: ["ignore", "inherit", "inherit"], detached: oneshot });
				let fired = false;
				const once = (code: number | null, signal: string | null): void => {
					if (!fired) onExit(code, signal);
					fired = true;
				};
				child.once("exit", once);
				child.once("error", (error) => {
					log(`${role} spawn failed: ${error.message}`);
					queueMicrotask(() => once(127, null));
				});
				if (oneshot) child.unref();
				return child.pid;
			},
			kill: innerKill(log),
			alive: pidAlive,
			argsOf: psArgs,
			readRuntime: () => readDaemonRuntime(paths),
			writeRuntime: (record) => atomicWrite(paths.runtime, record, 0o644),
			send,
			log,
		},
	);
	process.on("message", (message: { type?: string; id?: string; op?: string }) => {
		if (message?.type !== "request" || typeof message.op !== "string") return;
		send({ type: "reply", id: message.id, ...inner.handle(message.op) });
	});
	// The outer is gone (its IPC closed, or this process was reparented): stop the children, keep the oneshots.
	process.on("disconnect", () => inner.stop());
	const parent = process.ppid;
	setInterval(() => process.ppid !== parent && inner.stop(), TICK_MS).unref();
	process.on("SIGTERM", () => inner.stop());
	process.on("SIGHUP", () => log("SIGHUP ignored: the control API is the socket"));
	void inner.done.then((code) => process.exit(code));
}
