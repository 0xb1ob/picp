/**
 * Retained (P12b): from tests/daemon-tunnel.test.ts a restart cancelled by an update hold and a lost exit report, which
 * no entry point reaches. The binding reader moved out in P12c: the device-notify sender pins it end to end.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type TunnelPorts, tunnelController } from "../src/service/daemon-tunnel.ts";
import type { TunnelConfig, TunnelConfigRead, TunnelRuntime } from "../src/service/daemon-tunnel-files.ts";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const BIN = "/opt/cf/cloudflared";
const QUICK: TunnelConfig = { schema_version: 1, enabled: true, mode: "quick", port: 8767, binary: BIN, revision: 1 };

type Proc = { args: string; alive: boolean; stubborn?: boolean; onOutput?: (chunk: string) => void; onExit?: (code: number | null, signal: string | null) => void };

type BenchOptions = { config?: TunnelConfig | TunnelConfigRead | null; runtime?: TunnelRuntime | { ok: false; reason: string }; foreign?: Record<number, string>; stubborn?: boolean; failSpawn?: boolean; deaf?: boolean };
function bench(options: BenchOptions = {}) {
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
			if (options.deaf) return; // its exit is never reported, whatever the signal
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


test("stop cancels a pending restart: an update hold stops the tunnel while the inner lives on", () => {
	const b = bench();
	b.controller.reconcile();
	b.exit(b.live() as number, 1);
	b.controller.stop();
	b.advance(600_000);
	assert.equal(b.spawns.length, 1, "the pending restart is cancelled");
});


test("stop settles even when a SIGKILLed child never reports its exit: logged, then no longer tracked", () => {
	const b = bench({ deaf: true });
	b.controller.reconcile();
	const pid = b.live() as number;
	b.controller.stop();
	b.advance(10_000);
	assert.deepEqual(b.kills, [[pid, "SIGTERM"], [pid, "SIGKILL"]]);
	assert.equal(b.controller.busy(), true, "still waiting for the exit report");
	b.advance(9_999);
	assert.equal(b.controller.busy(), true);
	b.advance(1);
	assert.equal(b.controller.busy(), false);
	assert.equal(b.idle(), 1, "the inner's stop settles");
	assert.deepEqual([b.last()?.state, b.last()?.pid], ["stopped", undefined]);
	assert.match(b.lines.join("\n"), new RegExp(`cloudflared pid ${pid} did not report its exit 10s after SIGKILL`));
	assert.equal(b.kills.length, 2, "no further signal");
});
