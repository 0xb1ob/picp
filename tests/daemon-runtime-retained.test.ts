/**
 * cp-wfo4: cp-daemon's inner runtime with a fake clock and a fake process table. Retained (P14b): the kill port's
 * guards and a failed oneshot spawn beside a live supervisor are unreachable from an e2e surface.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaemonConfig, RawKill, RuntimeRecord } from "../src/service/daemon-files.ts";
import { type InnerEvent, type InnerOptions, type InnerPorts, innerKill, runInner } from "../src/service/daemon-runtime.ts";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const config: DaemonConfig = { schema_version: 1, generated_by: "cp-install", backend: "detached", node: "/opt/node", app: "/srv/app", home: "/srv/home", path: "/usr/bin", port: 7300 };

interface Proc {
	role?: string;
	args: string;
	alive: boolean;
	stubborn?: boolean;
	onExit?: (code: number | null, signal: string | null) => void;
}

function harness(options: { prior?: RuntimeRecord; reason?: InnerOptions["reason"]; foreign?: Record<number, string>; stubborn?: string[]; failSpawn?: string[]; raw?: RawKill; remote?: { on: boolean } } = {}) {
	let now = T0;
	const timers: Array<{ at: number; fn: () => void; dead: boolean }> = [];
	const procs = new Map<number, Proc>();
	for (const [pid, args] of Object.entries(options.foreign ?? {})) procs.set(Number(pid), { args, alive: true });
	let nextPid = 1000;
	const kills: Array<[number, string]> = [];
	const spawns: Array<{ role: string; pid?: number; at: number; env: Record<string, string>; argv: string[] }> = [];
	const events: InnerEvent[] = [];
	const lines: string[] = [];
	let record = options.prior ? structuredClone(options.prior) : undefined;
	const exit = (pid: number, code: number | null, signal: string | null = null): void => {
		const proc = procs.get(pid);
		if (!proc?.alive) return;
		proc.alive = false;
		proc.onExit?.(code, signal);
	};
	const signalled = (pid: number, signal: string): void => {
		kills.push([pid, signal]);
		const proc = procs.get(pid);
		if (proc?.alive && !(signal === "SIGTERM" && proc.stubborn)) exit(pid, null, signal);
	};
	// With `raw`, kills go through the production port (`innerKill`) first: only what it lets through is signalled.
	const fakeKill = options.raw
		? innerKill(
				(line) => void lines.push(line),
				(pid, signal) => {
					options.raw?.(pid, signal);
					signalled(pid, signal);
				},
			)
		: signalled;
	const ports: InnerPorts = {
		now: () => now,
		setTimer: (fn, ms) => {
			const timer = { at: now + ms, fn, dead: false };
			timers.push(timer);
			return () => void (timer.dead = true);
		},
		spawn: (role, argv, env, onExit) => {
			if (options.failSpawn?.includes(role)) {
				spawns.push({ role, at: now, env, argv });
				return undefined;
			}
			const pid = nextPid++;
			procs.set(pid, { role, args: argv.join(" "), alive: true, onExit, stubborn: options.stubborn?.includes(role) });
			spawns.push({ role, pid, at: now, env, argv });
			return pid;
		},
		kill: (pid, signal) => fakeKill(pid, signal),
		alive: (pid) => procs.get(pid)?.alive ?? false,
		argsOf: (pid) => (procs.get(pid)?.alive ? procs.get(pid)?.args : undefined),
		readRuntime: () => (record ? structuredClone(record) : undefined),
		writeRuntime: (next) => void (record = structuredClone(next)),
		send: (event) => void events.push(event),
		log: (line) => void lines.push(line),
		...(options.remote ? { remoteConfigured: () => options.remote!.on } : {}),
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
	const inner = runInner({ config, base: { HOME: "/home/u" }, pid: 99, daemonStartedAt: T0, reason: options.reason ?? "start" }, ports);
	const live = (role: string): number | undefined => [...procs.entries()].find(([, proc]) => proc.role === role && proc.alive)?.[0];
	return { inner, advance, exit, kills, spawns, events, lines, procs, live, record: () => record as RuntimeRecord, now: () => now };
}

test("the inner's production kill port: -1, 0, 1 and undefined never reach process.kill", () => {
	const raw: Array<[number, string]> = [];
	const lines: string[] = [];
	const kill = innerKill((line) => void lines.push(line), (pid, signal) => void raw.push([pid, signal]));
	const invalid = [-1, 0, 1, undefined, 1.5, Number.NaN] as unknown as number[];
	for (const pid of invalid) kill(pid, "SIGKILL");
	assert.deepEqual(raw, []);
	assert.deepEqual(lines, invalid.map((pid) => `refused to send SIGKILL to pid ${String(pid)}: not one process`));
	kill(4242, "SIGTERM");
	assert.deepEqual(raw, [[4242, "SIGTERM"]]);
	innerKill((line) => void lines.push(line), () => {
		throw new Error("kill ESRCH");
	})(4243, "SIGTERM");
	assert.equal(lines.at(-1), "kill SIGTERM 4243: kill ESRCH");
});

test("a failed oneshot spawn records no pid; a supervisor that does start is still the only pid signalled", async () => {
	const raw: Array<[number, string]> = [];
	const h = harness({ failSpawn: ["health", "viewer"], raw: (pid, signal) => void raw.push([pid, signal]) });
	h.advance(180_000);
	assert.equal(h.record().units.health.pid, undefined);
	h.inner.stop();
	assert.equal(await h.inner.done, 0);
	assert.deepEqual(raw, [[h.spawns[0]?.pid as number, "SIGTERM"]]);
});
