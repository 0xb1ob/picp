/**
 * cp-wfo4: cp-daemon's inner runtime with a fake clock and a fake process
 * table — no process is spawned except the one protocol-mismatch check,
 * which exits before it does anything.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { type DaemonConfig, type RawKill, type RuntimeRecord, restartDelay } from "../src/service/daemon-files.ts";
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

function harness(options: { prior?: RuntimeRecord; reason?: InnerOptions["reason"]; foreign?: Record<number, string>; stubborn?: string[]; failSpawn?: string[]; raw?: RawKill } = {}) {
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

test("starts the supervisor and the viewer with their unit env, and reports ready 5 s later", () => {
	const h = harness();
	assert.deepEqual(h.spawns.map((spawn) => spawn.role), ["parent", "viewer"]);
	assert.deepEqual(h.spawns[1]?.argv, ["/opt/node", "/srv/app/src/viewer/cli.ts", "--home", "/srv/home", "--require-tailnet", "--port", "7300"]);
	assert.equal(h.spawns[0]?.env.CP_VIEWER_PORT, "7300");
	assert.equal(h.spawns[0]?.env.HOME, "/home/u");
	h.advance(4_999);
	assert.deepEqual(h.events, []);
	h.advance(1);
	assert.deepEqual(h.events, [{ type: "ready" }]);
	assert.equal(h.record().units.parent.state, "running");
});

test("a supervisor that dies within 5 s makes the start report failed", () => {
	const h = harness();
	h.exit(h.live("parent") as number, 78);
	h.advance(5_000);
	assert.equal(h.events[0]?.type, "failed");
	assert.match((h.events[0] as { detail: string }).detail, /parent exited within 5s/);
});

test("a supervisor crash loop restarts with the exact backoff and ends failed (start-limit-hit)", () => {
	const h = harness();
	for (let i = 0; i < 5; i++) {
		h.exit(h.live("parent") as number, 1);
		h.advance(restartDelay(i + 1) - 1);
		assert.equal(h.live("parent"), undefined, `restart ${i + 1} too early`);
		h.advance(1);
		assert.ok(h.live("parent"), `restart ${i + 1} on time`);
	}
	const starts = h.spawns.filter((spawn) => spawn.role === "parent").map((spawn) => spawn.at - T0);
	assert.deepEqual(starts.slice(1).map((at, i) => at - (starts[i] as number)), [1, 2, 3, 4, 5].map(restartDelay));
	h.exit(h.live("parent") as number, 1);
	h.advance(600_000);
	assert.equal(h.live("parent"), undefined);
	assert.equal(h.record().units.parent.state, "failed");
	assert.equal(h.record().units.parent.result, "start-limit-hit");
	assert.ok(h.live("viewer"), "the viewer is untouched");
});

test("a supervisor exit 78 is failed (exit-code) and never restarted", () => {
	const h = harness();
	h.exit(h.live("parent") as number, 78);
	h.advance(3_600_000);
	assert.equal(h.spawns.filter((spawn) => spawn.role === "parent").length, 1);
	assert.equal(h.record().units.parent.result, "exit-code");
});

test("the viewer is restarted 10 s after any exit", () => {
	const h = harness();
	h.exit(h.live("viewer") as number, 0);
	h.advance(9_999);
	assert.equal(h.live("viewer"), undefined);
	h.advance(1);
	assert.ok(h.live("viewer"));
});

test("health is first due at +3 min and update at +10 min, then 5 min after the last start; in flight is skipped", () => {
	const h = harness();
	h.advance(179_999);
	assert.equal(h.spawns.some((spawn) => spawn.role === "health"), false);
	h.advance(1);
	const health = h.spawns.filter((spawn) => spawn.role === "health");
	assert.equal(health.length, 1);
	assert.equal(health[0]?.env.CP_DAEMON_JOB, "health");
	h.exit(health[0]?.pid as number, 0);
	h.advance(300_000);
	assert.deepEqual(h.spawns.filter((spawn) => spawn.role === "health").map((spawn) => spawn.at - T0), [180_000, 480_000]);
	h.exit(h.live("health") as number, 0);
	h.advance(600_000 - (h.now() - T0));
	const update = h.spawns.filter((spawn) => spawn.role === "update");
	assert.deepEqual(update.map((spawn) => spawn.at - T0), [600_000]);
	h.advance(300_000);
	assert.equal(h.spawns.filter((spawn) => spawn.role === "update").length, 1, "due while in flight: skipped");
	assert.ok(h.lines.some((line) => /update due while pid \d+ is still running: skipped/.test(line)));
	assert.equal(Date.parse(h.record().units.update.next_due), h.now() + 300_000);
});

test("the health timeout sends SIGTERM at 120 s and SIGKILL 10 s later", () => {
	const h = harness({ stubborn: ["health"] });
	h.advance(180_000);
	const pid = h.live("health") as number;
	h.advance(119_999);
	assert.equal(h.kills.some(([p]) => p === pid), false);
	h.advance(1);
	assert.deepEqual(h.kills.filter(([p]) => p === pid), [[pid, "SIGTERM"]]);
	h.advance(10_000);
	assert.deepEqual(h.kills.filter(([p]) => p === pid), [[pid, "SIGTERM"], [pid, "SIGKILL"]]);
});

test("hold stops the viewer and blocks its restart until release, then until the 50-min deadline", () => {
	const h = harness();
	const viewer = h.live("viewer") as number;
	assert.deepEqual(h.inner.handle("hold"), { ok: true });
	assert.deepEqual(h.kills, [[viewer, "SIGTERM"]]);
	h.advance(600_000);
	assert.equal(h.live("viewer"), undefined);
	assert.equal(h.record().units.viewer.state, "held");
	h.inner.handle("release");
	assert.ok(h.live("viewer"));
	h.inner.handle("hold");
	h.advance(50 * 60_000 - 5_000);
	assert.equal(h.live("viewer"), undefined);
	h.advance(5_000);
	assert.ok(h.live("viewer"), "the deadline releases it");
});

test("a persisted hold survives a crash restart of the inner, and a reload clears it", () => {
	const first = harness();
	first.inner.handle("hold");
	const prior = { ...first.record(), units: { ...first.record().units, parent: { ...first.record().units.parent, pid: undefined } } };
	const crashed = harness({ prior, reason: "restart" });
	assert.equal(crashed.live("viewer"), undefined);
	assert.equal(crashed.record().units.viewer.state, "held");
	crashed.advance(5_000);
	assert.deepEqual(crashed.events, [{ type: "ready" }]);
	const reloaded = harness({ prior, reason: "reload" });
	assert.ok(reloaded.live("viewer"));
});

test("stop SIGTERMs only the supervisor and viewer — never a oneshot or the parent host — and exits 0", async () => {
	const h = harness({ foreign: { 42: "node /srv/app/src/parent-host.ts" } });
	h.advance(180_000);
	const health = h.live("health") as number;
	const signalled = [h.live("parent"), h.live("viewer")];
	h.inner.stop();
	assert.equal(await h.inner.done, 0);
	assert.deepEqual(h.kills.map(([pid]) => pid).sort(), signalled.sort());
	assert.ok(h.procs.get(health)?.alive, "the oneshot keeps running");
	assert.ok(h.procs.get(42)?.alive, "the host is never signalled");
	assert.equal(h.record().units.parent.state, "stopped");
});

test("a supervisor that ignores SIGTERM on stop is SIGKILLed after 10 s", async () => {
	const h = harness({ stubborn: ["parent"] });
	const pid = h.live("parent") as number;
	h.inner.stop();
	h.advance(10_000);
	assert.deepEqual(h.kills.filter(([p]) => p === pid), [[pid, "SIGTERM"], [pid, "SIGKILL"]]);
	assert.equal(await h.inner.done, 0);
});

function priorRecord(units: Partial<RuntimeRecord["units"]>, startedAt = T0): RuntimeRecord {
	const long = { state: "running" as const, starts: [], restarts: 0, since: new Date(T0).toISOString() };
	return {
		schema_version: 1,
		pid: 77,
		protocol: 1,
		started_at: new Date(T0).toISOString(),
		daemon_started_at: new Date(startedAt).toISOString(),
		units: { parent: long, viewer: long, health: { next_due: new Date(T0 + 180_000).toISOString() }, update: { next_due: new Date(T0 + 600_000).toISOString() }, ...units },
	};
}

test("adoption: a recorded live update with matching args is adopted, not respawned, and keeps its timeout", () => {
	const startedAt = new Date(T0 - 60_000).toISOString();
	const prior = priorRecord({ update: { pid: 500, started_at: startedAt, next_due: new Date(T0 + 240_000).toISOString() } });
	const h = harness({ prior, foreign: { 500: "/opt/node /srv/app/src/service/update.ts" } });
	assert.equal(h.record().units.update.pid, 500);
	h.advance(300_000);
	assert.equal(h.spawns.some((spawn) => spawn.role === "update"), false, "in flight at its due time: skipped");
	h.procs.set(500, { args: "", alive: false });
	h.advance(300_000);
	assert.equal(h.spawns.filter((spawn) => spawn.role === "update").length, 1, "respawned once the adopted run is gone");
});

test("a recorded pid whose args no longer match (pid reuse) is neither adopted nor signalled", () => {
	const prior = priorRecord({ update: { pid: 500, started_at: new Date(T0).toISOString(), next_due: new Date(T0).toISOString() }, viewer: { state: "running", pid: 600, starts: [], restarts: 0, since: "" } });
	const h = harness({ prior, foreign: { 500: "vim notes", 600: "bash" } });
	assert.equal(h.record().units.update.pid, undefined);
	assert.deepEqual(h.kills, []);
	assert.ok(h.live("viewer"));
});

test("orphans: a recorded live viewer with matching args gets SIGTERM before the new spawn", () => {
	const prior = priorRecord({ viewer: { state: "running", pid: 600, starts: [], restarts: 0, since: "" } });
	const h = harness({ prior, foreign: { 600: "/opt/node /srv/app/src/viewer/cli.ts --home /srv/home" } });
	assert.deepEqual(h.kills, [[600, "SIGTERM"]]);
	assert.equal(h.spawns.length, 0, "nothing spawned while the orphan lives");
	h.advance(1_000);
	assert.deepEqual(h.spawns.map((spawn) => spawn.role), ["parent", "viewer"]);
});

test("timers carry over a reload of the same outer, and restart from the daemon's start for a new one", () => {
	const due = new Date(T0 + 30_000).toISOString();
	const same = harness({ prior: priorRecord({ health: { next_due: due } }), reason: "reload" });
	assert.equal(same.record().units.health.next_due, due);
	const fresh = harness({ prior: priorRecord({ health: { next_due: due } }, T0 - 3_600_000) });
	assert.equal(fresh.record().units.health.next_due, new Date(T0 + 180_000).toISOString());
});

test("the health op starts a run now, unless one is in flight", () => {
	const h = harness();
	assert.match(h.inner.handle("health").detail ?? "", /health started pid/);
	assert.match(h.inner.handle("health").detail ?? "", /already running/);
	assert.equal(h.spawns.filter((spawn) => spawn.role === "health").length, 1);
	assert.equal(h.inner.handle("bogus").ok, false);
});

test("a runtime on another protocol exits 78 before it does anything", () => {
	const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../src/service/daemon-runtime.ts")], { env: { PATH: process.env.PATH, CP_DAEMON_PROTOCOL: "0" }, encoding: "utf8" });
	assert.equal(result.status, 78);
	assert.match(result.stderr, /protocol 0, this runtime 1/);
});

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

test("a failed spawn records no pid (never -1), and hold and stop then signal nothing", async () => {
	const raw: Array<[number, string]> = [];
	const h = harness({ failSpawn: ["parent", "viewer"], raw: (pid, signal) => void raw.push([pid, signal]) });
	assert.equal(h.record().units.parent.pid, undefined);
	assert.equal(h.record().units.viewer.pid, undefined);
	assert.equal(JSON.stringify(h.record()).includes('"pid":-1'), false);
	h.inner.handle("hold");
	h.inner.stop();
	h.advance(10_000);
	assert.equal(await h.inner.done, 0);
	assert.deepEqual(raw, []);
	assert.deepEqual(h.kills, []);
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
