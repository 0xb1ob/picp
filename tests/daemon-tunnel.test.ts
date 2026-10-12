/**
 * T6 (remote dashboard PR 2c): the cp-daemon cloudflared controller. A fake clock and process table for the lifecycle;
 * the last tests run a real stand-in script (never cloudflared, never the network) and signal only pids they started.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { daemonPaths, guardedKill, pidAlive, psArgs } from "../src/service/daemon-files.ts";
import { quickOrigin, sanitizeLine, TUNNEL_LOG_LINES, type TunnelPorts, tunnelController, tunnelIo } from "../src/service/daemon-tunnel.ts";
import { readTunnelBinding, readTunnelConfig, readTunnelRuntime, type TunnelConfig, type TunnelConfigRead, type TunnelRuntime, tunnelConfigFile, tunnelRuntimeFile } from "../src/service/daemon-tunnel-files.ts";
import { createScratchHome } from "./harness/index.ts";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const BIN = "/opt/cf/cloudflared";
const QUICK: TunnelConfig = { schema_version: 1, enabled: true, mode: "quick", port: 8767, binary: BIN, revision: 1 };
const NAMED: TunnelConfig = { schema_version: 1, enabled: true, mode: "named", port: 8767, binary: BIN, hostname: "cp.example.com", token_file: "/srv/home/.pi-command-post/data/tunnel/token", revision: 1 };
const QUICK_ARGS = `${BIN} tunnel --no-autoupdate --url http://127.0.0.1:8767 --http-host-header 127.0.0.1:8767`;
const BANNER = "INF |  https://amber-otter-lake-sun.trycloudflare.com                                   |";
const REGISTERED = "INF Registered tunnel connection connIndex=0 connection=0f0e protocol=quic";

type Proc = { args: string; alive: boolean; stubborn?: boolean; onOutput?: (chunk: string) => void; onExit?: (code: number | null, signal: string | null) => void };

function bench(options: { config?: TunnelConfig | TunnelConfigRead | null; runtime?: TunnelRuntime | { ok: false; reason: string }; foreign?: Record<number, string>; stubborn?: boolean; failSpawn?: boolean } = {}) {
	let now = T0;
	const timers: Array<{ at: number; fn: () => void; dead: boolean }> = [];
	const procs = new Map<number, Proc>();
	for (const [pid, args] of Object.entries(options.foreign ?? {})) procs.set(Number(pid), { args, alive: true, stubborn: options.stubborn });
	let nextPid = 2000;
	const kills: Array<[number, string]> = [];
	const writes: TunnelRuntime[] = [];
	const lines: string[] = [];
	const spawns: string[][] = [];
	let idle = 0;
	const state = { config: (options.config === undefined ? QUICK : options.config) as TunnelConfig | TunnelConfigRead | null };
	const exit = (pid: number, code: number | null, signal: string | null = null): void => {
		const proc = procs.get(pid);
		if (!proc?.alive) return;
		proc.alive = false;
		proc.onExit?.(code, signal);
	};
	const ports: TunnelPorts = {
		now: () => now,
		setTimer: (fn, ms) => {
			const timer = { at: now + ms, fn, dead: false };
			timers.push(timer);
			return () => void (timer.dead = true);
		},
		spawn: (file, argv, onOutput, onExit) => {
			spawns.push([file, ...argv]);
			if (options.failSpawn) return undefined;
			const pid = nextPid++;
			procs.set(pid, { args: [file, ...argv].join(" "), alive: true, onOutput, onExit, stubborn: options.stubborn });
			return pid;
		},
		kill: (pid, signal) => {
			kills.push([pid, signal]);
			const proc = procs.get(pid);
			if (proc?.alive && !(signal === "SIGTERM" && proc.stubborn)) exit(pid, null, signal);
		},
		alive: (pid) => procs.get(pid)?.alive ?? false,
		argsOf: (pid) => (procs.get(pid)?.alive ? procs.get(pid)?.args : undefined),
		readConfig: () => {
			const config = state.config;
			return config === null ? { ok: true, config: null } : "ok" in config ? config : { ok: true, config };
		},
		readRuntime: () => (options.runtime === undefined ? { ok: true, runtime: null } : "ok" in options.runtime ? options.runtime : { ok: true, runtime: structuredClone(options.runtime) }),
		writeRuntime: (runtime) => void writes.push(structuredClone(runtime)),
		log: (line) => void lines.push(line),
	};
	const advance = (ms: number): void => {
		const end = now + ms;
		for (;;) {
			const next = timers.filter((timer) => !timer.dead && timer.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			now = next.at;
			next.dead = true;
			next.fn();
		}
		now = end;
	};
	const controller = tunnelController(ports, () => void (idle += 1));
	const live = (): number | undefined => [...procs.entries()].find(([pid, proc]) => proc.alive && pid >= 2000)?.[0];
	const say = (text: string): void => procs.get(live() as number)?.onOutput?.(`${text}\n`);
	return { controller, state, advance, exit, say, live, kills, writes, lines, spawns, procs, last: () => writes.at(-1), idle: () => idle };
}

test("a home with no tunnel config spawns nothing and never writes a runtime record", () => {
	const b = bench({ config: null });
	b.controller.reconcile();
	b.advance(60_000);
	b.controller.reconcile();
	assert.deepEqual(b.spawns, []);
	assert.deepEqual(b.writes, [], "legacy homes keep no state/tunnel-runtime.json");
	assert.equal(b.controller.busy(), false);
});

test("quick: the fixed argv; the origin is published only after its trycloudflare URL and a registered connection", () => {
	const b = bench();
	b.controller.reconcile();
	assert.deepEqual(b.spawns, [QUICK_ARGS.split(" ")]);
	const pid = b.live() as number;
	assert.deepEqual({ ...b.last(), updated_at: "" }, { schema_version: 1, origin: null, generation: 0, revision: 1, state: "starting", mode: "quick", port: 8767, pid, binary: BIN, argv: QUICK_ARGS.split(" ").slice(1), started_at: new Date(T0).toISOString(), updated_at: "" });
	b.say("ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": dial tcp");
	b.say("see https://evil.trycloudflare.com.example.net/ and https://x.trycloudflare.com/path");
	b.say(REGISTERED);
	assert.equal(b.last()?.state, "starting", "no origin seen yet: a connection alone is not running");
	b.say(BANNER);
	b.say(REGISTERED);
	assert.equal(b.last()?.state, "running");
	assert.equal(b.last()?.origin, "https://amber-otter-lake-sun.trycloudflare.com");
	assert.equal(b.last()?.generation, 1);
	b.say("|  https://second-origin.trycloudflare.com |");
	b.say(REGISTERED);
	assert.equal(b.last()?.origin, "https://amber-otter-lake-sun.trycloudflare.com", "the first origin of a run is the run's origin");
	assert.equal(b.writes.filter((write) => write.state === "running").length, 1);
});

test("output parsing: the quick origin is exact, and a logged line is sanitized, redacted and bounded", () => {
	assert.equal(quickOrigin(BANNER), "https://amber-otter-lake-sun.trycloudflare.com");
	assert.equal(quickOrigin("https://abc.trycloudflare.com"), "https://abc.trycloudflare.com");
	for (const line of ["https://api.trycloudflare.com", "http://abc.trycloudflare.com", "https://abc.trycloudflare.com.evil.net", "https://a.b.trycloudflare.com", "https://-abc.trycloudflare.com", "https://ABC.trycloudflare.com/x"]) assert.equal(quickOrigin(line), undefined, line);
	const token = "eyJhIjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MCJ9";
	assert.equal(sanitizeLine(`\x1b[31mERR\x1b[0m bad\ttoken ${token}\r`), "ERR bad token [redacted]");
	assert.equal(sanitizeLine("word ".repeat(200)).length, 300);
	const b = bench();
	b.controller.reconcile();
	for (let i = 0; i < TUNNEL_LOG_LINES + 50; i += 1) b.say(`INF line ${i}`);
	const logged = b.lines.filter((line) => line.startsWith("cloudflared: "));
	assert.equal(logged.length, TUNNEL_LOG_LINES + 1);
	assert.match(logged.at(-1) ?? "", /further output of pid \d+ suppressed/);
	assert.ok(b.lines.every((line) => !line.includes(token)));
});

test("named: the origin is the configured hostname, a restart keeps its generation, and a different origin bumps it", () => {
	const b = bench({ config: NAMED, runtime: { schema_version: 1, origin: "https://old.trycloudflare.com", generation: 4, revision: 1, state: "stopped", updated_at: "" } });
	b.controller.reconcile();
	assert.deepEqual(b.spawns[0], [BIN, "tunnel", "--no-autoupdate", "run", "--token-file", NAMED.token_file]);
	b.say(REGISTERED);
	assert.deepEqual([b.last()?.state, b.last()?.origin, b.last()?.generation], ["running", "https://cp.example.com", 5]);
	b.exit(b.live() as number, 1);
	assert.equal(b.last()?.state, "restarting");
	assert.equal(b.last()?.pid, undefined);
	assert.equal(b.last()?.origin, "https://cp.example.com", "a stopped tunnel keeps its last binding");
	b.advance(5_000);
	b.say(REGISTERED);
	assert.deepEqual([b.last()?.state, b.last()?.generation], ["running", 5], "the same named origin keeps its sessions");
});

test("an unexpected exit restarts on the supervisor's backoff, reset once a run registers; a failed spawn backs off too", () => {
	const b = bench();
	b.controller.reconcile();
	b.exit(b.live() as number, 1);
	assert.match(b.last()?.detail ?? "", /exited \(1\); restart 1 in 5s/);
	b.advance(4_999);
	b.controller.reconcile();
	assert.equal(b.spawns.length, 1, "a tick during the backoff does not start early");
	b.advance(1);
	assert.equal(b.spawns.length, 2);
	b.exit(b.live() as number, 1);
	assert.match(b.last()?.detail ?? "", /restart 2 in 11\.\d+s/);
	b.advance(12_000);
	b.say(BANNER);
	b.say(REGISTERED);
	b.exit(b.live() as number, 1);
	assert.match(b.last()?.detail ?? "", /restart 1 in 5s/, "a registered run resets the backoff");
	const failing = bench({ failSpawn: true });
	failing.controller.reconcile();
	assert.equal(failing.last()?.state, "restarting");
	assert.match(failing.last()?.detail ?? "", /did not spawn/);
	assert.equal(failing.controller.busy(), false);
});

test("a revision-only change is acknowledged without a restart; a changed command line restarts the child", () => {
	const b = bench();
	b.controller.reconcile();
	const first = b.live() as number;
	b.state.config = { ...QUICK, revision: 2 };
	b.controller.reconcile();
	assert.equal(b.live(), first);
	assert.equal(b.last()?.revision, 2);
	assert.deepEqual(b.kills, []);
	b.state.config = { ...QUICK, port: 8800, revision: 3 };
	b.controller.reconcile();
	assert.deepEqual(b.kills, [[first, "SIGTERM"]]);
	assert.notEqual(b.live(), first);
	assert.deepEqual(b.spawns.at(-1)?.slice(-1), ["127.0.0.1:8800"]);
	assert.equal(b.last()?.revision, 3);
});

test("down: SIGTERM, the exit observed, then stopped for that revision with no restart timer; a stubborn child gets SIGKILL after 10 s", () => {
	const b = bench({ stubborn: true });
	b.controller.reconcile();
	const pid = b.live() as number;
	b.state.config = { ...QUICK, enabled: false, revision: 2 };
	b.controller.reconcile();
	assert.deepEqual(b.kills, [[pid, "SIGTERM"]]);
	assert.equal(b.last()?.state, "starting", "not stopped before the exit is observed");
	assert.equal(b.controller.busy(), true);
	b.advance(9_999);
	assert.equal(b.kills.length, 1);
	b.advance(1);
	assert.deepEqual(b.kills, [[pid, "SIGTERM"], [pid, "SIGKILL"]]);
	assert.deepEqual([b.last()?.state, b.last()?.revision, b.last()?.pid], ["stopped", 2, undefined]);
	b.advance(600_000);
	b.controller.reconcile();
	assert.equal(b.spawns.length, 1, "nothing restarts a disabled tunnel");
	assert.equal(b.controller.busy(), false);
});

test("an unreadable or invalid config fails closed: the child is stopped and the refusal named; an unreadable runtime starts nothing", () => {
	const b = bench();
	b.controller.reconcile();
	b.state.config = { ok: false, reason: "/h/data/tunnel.json: not JSON" };
	b.controller.reconcile();
	assert.equal(b.live(), undefined);
	assert.deepEqual([b.last()?.state, b.last()?.detail], ["failed", "config refused: /h/data/tunnel.json: not JSON"]);
	const writes = b.writes.length;
	b.controller.reconcile();
	assert.equal(b.writes.length, writes, "an unchanged refusal is not rewritten every tick");
	assert.equal(readTunnelConfig("/nonexistent").ok, true);

	const corrupt = bench({ runtime: { ok: false, reason: "state/tunnel-runtime.json: not JSON" } });
	corrupt.controller.reconcile();
	assert.deepEqual(corrupt.spawns, []);
	assert.deepEqual(corrupt.writes, []);
	assert.match(corrupt.lines.join("\n"), /runtime record is unreadable, so no tunnel starts/);
});

test("recovery: a recorded child still showing its exact command line is stopped before anything starts; a reused pid is never signalled", () => {
	const recorded: TunnelRuntime = { schema_version: 1, origin: "https://a.trycloudflare.com", generation: 2, revision: 1, state: "running", mode: "quick", port: 8767, pid: 900, binary: BIN, argv: QUICK_ARGS.split(" ").slice(1), updated_at: "" };
	const b = bench({ runtime: recorded, foreign: { 900: QUICK_ARGS }, stubborn: true });
	assert.deepEqual(b.kills, [[900, "SIGTERM"]]);
	b.controller.reconcile();
	assert.deepEqual(b.spawns, [], "nothing new while the orphan lives");
	assert.equal(b.controller.busy(), true);
	b.advance(10_000);
	assert.deepEqual(b.kills, [[900, "SIGTERM"], [900, "SIGKILL"]]);
	assert.equal(b.spawns.length, 1, "started once the orphan is gone");
	b.say(BANNER);
	b.say(REGISTERED);
	assert.equal(b.last()?.generation, 3, "a new quick origin after recovery is a new generation");

	for (const args of ["/usr/bin/cloudflared tunnel --url http://127.0.0.1:8767", "bash"]) {
		const reused = bench({ runtime: recorded, foreign: { 900: args } });
		assert.deepEqual(reused.kills, [], args);
		assert.equal(reused.last()?.pid, undefined, "the stale pid is dropped from the record");
		reused.controller.reconcile();
		assert.equal(reused.spawns.length, 1);
	}
});

test("stop (daemon stop, reload, update hold): no restart, busy until the exit, then idle; reconcile resumes", () => {
	const b = bench();
	b.controller.reconcile();
	b.exit(b.live() as number, 1);
	b.controller.stop();
	b.advance(600_000);
	assert.equal(b.spawns.length, 1, "the pending restart is cancelled");
	b.controller.reconcile();
	const pid = b.live() as number;
	b.controller.stop();
	assert.deepEqual(b.kills.at(-1), [pid, "SIGTERM"]);
	assert.equal(b.controller.busy(), false);
	assert.equal(b.idle(), 1);
	assert.equal(b.last()?.state, "stopped");
	b.controller.reconcile();
	assert.equal(b.spawns.length, 3);
});

test("the published file reads back through both readers, and a malformed one is refused", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { stateDir, dataDir } = daemonPaths(home.path);
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	const runtime: TunnelRuntime = { schema_version: 1, origin: "https://a.trycloudflare.com", generation: 1, revision: 2, state: "running", mode: "quick", port: 8767, pid: 4242, binary: BIN, argv: ["tunnel"], updated_at: "x" };
	writeFileSync(tunnelRuntimeFile(stateDir), JSON.stringify(runtime));
	assert.deepEqual(readTunnelRuntime(stateDir), { ok: true, runtime });
	assert.deepEqual(readTunnelBinding(stateDir), { ok: true, binding: { origin: "https://a.trycloudflare.com", generation: 1 } });
	for (const bad of [{ ...runtime, state: "up" }, { ...runtime, pid: 1 }, { ...runtime, binary: undefined }, { ...runtime, revision: 0 }]) {
		writeFileSync(tunnelRuntimeFile(stateDir), JSON.stringify(bad));
		assert.equal(readTunnelRuntime(stateDir).ok, false, JSON.stringify(bad));
	}
	const config = (value: unknown) => {
		writeFileSync(tunnelConfigFile(dataDir), JSON.stringify(value));
		return readTunnelConfig(dataDir);
	};
	assert.deepEqual(config(NAMED), { ok: true, config: NAMED });
	for (const [field, bad] of [["port", { ...QUICK, port: 80 }], ["binary", { ...QUICK, binary: "cloudflared" }], ["hostname", { ...NAMED, hostname: "localhost" }], ["hostname", { ...QUICK, hostname: "a.b" }], ["token_file", { ...NAMED, token_file: "token" }], ["revision", { ...QUICK, revision: 0 }], ["mode", { ...QUICK, mode: "x" }]] as const) {
		const read = config(bad);
		assert.equal(read.ok, false, field);
		assert.match(read.ok ? "" : read.reason, new RegExp(`${field}$`));
	}
});

/** A stand-in cloudflared: prints a quick banner and a registration, then waits; SIGTERM exits 0. */
function standIn(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "cloudflared");
	// Like cloudflared, every line goes to stderr: the banner reliably precedes the registration.
	writeFileSync(file, `#!/bin/sh\ntrap 'exit 0' TERM\necho "INF |  https://real-child-test.trycloudflare.com  |" >&2\necho "INF Registered tunnel connection connIndex=0" >&2\nwhile :; do sleep 1; done\n`);
	chmodSync(file, 0o755);
	return file;
}

const until = async (what: string, check: () => boolean): Promise<void> => {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

test("a real child: up publishes running, down observes its exit and leaves no process behind", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const paths = daemonPaths(home.path);
	mkdirSync(paths.stateDir, { recursive: true });
	mkdirSync(paths.dataDir, { recursive: true });
	const binary = standIn(join(home.path, "fake-bin"));
	writeFileSync(tunnelConfigFile(paths.dataDir), JSON.stringify({ ...QUICK, binary }));
	const lines: string[] = [];
	let idle = 0;
	const controller = tunnelController(
		{
			...tunnelIo(paths, home.path, { PATH: "/usr/bin:/bin" }, (line) => void lines.push(line)),
			now: Date.now,
			setTimer: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return () => clearTimeout(timer);
			},
			kill: guardedKill((line) => void lines.push(line)),
			alive: pidAlive,
			argsOf: psArgs,
			log: (line) => void lines.push(line),
		},
		() => void (idle += 1),
	);
	controller.reconcile();
	const read = (): TunnelRuntime | null => {
		const runtime = readTunnelRuntime(paths.stateDir);
		return runtime.ok ? runtime.runtime : null;
	};
	await until("running", () => read()?.state === "running");
	const pid = read()?.pid as number;
	t.after(() => {
		if (pidAlive(pid)) process.kill(pid, "SIGKILL");
	});
	assert.equal(read()?.origin, "https://real-child-test.trycloudflare.com");
	assert.equal(statSync(tunnelRuntimeFile(paths.stateDir)).mode & 0o777, 0o600);
	writeFileSync(tunnelConfigFile(paths.dataDir), JSON.stringify({ ...QUICK, binary, enabled: false, revision: 2 }));
	controller.reconcile();
	await until("stopped", () => read()?.state === "stopped");
	assert.equal(pidAlive(pid), false, "the exit was observed, so the process is gone");
	assert.deepEqual([read()?.revision, read()?.pid, controller.busy()], [2, undefined, false]);
	assert.equal(idle, 0, "down is not a stop of the controller");
});


test("a real orphan of a crashed inner is stopped by its exact command line, then a fresh child starts", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const paths = daemonPaths(home.path);
	mkdirSync(paths.stateDir, { recursive: true });
	mkdirSync(paths.dataDir, { recursive: true });
	const binary = standIn(join(home.path, "fake-bin"));
	const argv = ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8767", "--http-host-header", "127.0.0.1:8767"];
	const orphan = spawn(binary, argv, { stdio: "ignore", detached: true });
	orphan.unref();
	const pid = orphan.pid as number;
	t.after(() => {
		if (pidAlive(pid)) process.kill(pid, "SIGKILL");
	});
	await until("the orphan's ps line", () => psArgs(pid)?.includes(argv.join(" ")) ?? false);
	writeFileSync(tunnelRuntimeFile(paths.stateDir), JSON.stringify({ schema_version: 1, origin: "https://old.trycloudflare.com", generation: 1, revision: 1, state: "running", mode: "quick", port: 8767, pid, binary, argv, updated_at: "x" }));
	writeFileSync(tunnelConfigFile(paths.dataDir), JSON.stringify({ ...QUICK, binary }));
	const lines: string[] = [];
	const controller = tunnelController(
		{
			...tunnelIo(paths, home.path, { PATH: "/usr/bin:/bin" }, (line) => void lines.push(line)),
			now: Date.now,
			setTimer: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return () => clearTimeout(timer);
			},
			kill: guardedKill((line) => void lines.push(line)),
			alive: pidAlive,
			argsOf: psArgs,
			log: (line) => void lines.push(line),
		},
		() => {},
	);
	controller.reconcile();
	await until("the orphan's exit", () => !pidAlive(pid) || psArgs(pid) === undefined);
	await until("a fresh child running", () => {
		const read = readTunnelRuntime(paths.stateDir);
		return read.ok && read.runtime?.state === "running" && read.runtime.pid !== pid;
	});
	const read = readTunnelRuntime(paths.stateDir);
	const fresh = read.ok ? (read.runtime?.pid as number) : 0;
	assert.equal(read.ok && read.runtime?.generation, 2);
	controller.stop();
	await until("the fresh child's exit", () => !controller.busy());
	assert.equal(pidAlive(fresh), false);
});
