/**
 * cp-wfo4: cp-daemon's outer layer — the real lock, state file and control
 * socket in a temp home (with the real client, `daemon-control.ts`), a fake
 * inner runtime and a fake clock. Nothing is forked.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { daemonControl, daemonRequest } from "../src/service/daemon-control.ts";
import { type DaemonState, daemonPaths, encodeFrame, LOG_MAX_BYTES, outerHash, restartDelay } from "../src/service/daemon-files.ts";
import { acquireDaemonLock, type OuterPorts, releaseDaemonLock, runOuter } from "../src/service/daemon-outer.ts";
import { outerKill } from "../src/service/daemon.ts";

const SERVICE = resolve(import.meta.dirname, "../src/service");
const OUTER_PID = 4100;

interface FakeInner {
	pid: number;
	env: Record<string, string>;
	sent: Array<{ op?: string; id?: string }>;
	alive: boolean;
	onMessage(message: unknown): void;
	onExit(code: number | null, signal: string | null): void;
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 2));
async function until(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (cond()) return;
		await tick();
	}
	assert.fail(`timed out waiting for ${what}`);
}

function setup(options: { autoReady?: boolean; stubborn?: boolean; table?: Record<number, string> } = {}) {
	const home = mkdtempSync(join(tmpdir(), "cp-daemon-outer-"));
	const paths = daemonPaths(home);
	mkdirSync(paths.dataDir, { recursive: true });
	mkdirSync(paths.stateDir, { recursive: true });
	writeFileSync(paths.config, JSON.stringify({ schema_version: 1, generated_by: "cp-install", backend: "detached", node: "/opt/node", app: "/srv/app", home, path: "/usr/bin", port: 7300 }));
	let now = Date.parse("2026-10-01T00:00:00Z");
	const timers: Array<{ at: number; fn: () => void; dead: boolean }> = [];
	const inners: FakeInner[] = [];
	const order: string[] = [];
	const kills: Array<[number | undefined, string]> = [];
	const lines: string[] = [];
	const mode = { autoReady: options.autoReady ?? true, stubborn: options.stubborn ?? false, failSpawn: false };
	let nextPid = 5000;
	const exitInner = (inner: FakeInner, code: number | null, signal: string | null = null): void => {
		if (!inner.alive) return;
		inner.alive = false;
		order.push(`exit ${inner.pid}`);
		inner.onExit(code, signal);
	};
	const ports: OuterPorts = {
		pid: OUTER_PID,
		now: () => now,
		setTimer: (fn, ms) => {
			const timer = { at: now + ms, fn, dead: false };
			timers.push(timer);
			return () => void (timer.dead = true);
		},
		spawnInner: (_config, env, onMessage, onExit) => {
			const inner: FakeInner = { pid: nextPid++, env, sent: [], alive: true, onMessage, onExit };
			inners.push(inner);
			order.push(`spawn ${inner.pid}`);
			if (mode.autoReady) setTimeout(() => inner.alive && onMessage({ type: "ready" }), 1);
			return {
				pid: mode.failSpawn ? undefined : inner.pid,
				send: (message) => {
					const request = message as { op?: string; id?: string };
					inner.sent.push(request);
					order.push(`send ${inner.pid} ${request.op}`);
					if (request.op === "stop") {
						if (!mode.stubborn) setTimeout(() => exitInner(inner, 0), 1);
					} else setTimeout(() => onMessage({ type: "reply", id: request.id, ok: true, detail: `${request.op} done` }), 1);
				},
			};
		},
		kill: (pid, signal) => {
			kills.push([pid, signal]);
			const inner = inners.find((candidate) => candidate.pid === pid);
			if (inner) exitInner(inner, null, signal);
		},
		alive: (pid) => pid in (options.table ?? {}),
		argsOf: (pid) => options.table?.[pid],
		log: (line) => void lines.push(line),
		sourceDir: SERVICE,
		base: { HOME: "/home/u" },
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
	const state = (): DaemonState => JSON.parse(readFileSync(paths.state, "utf8")) as DaemonState;
	const live = (): FakeInner | undefined => inners.find((inner) => inner.alive);
	const cleanup = (): void => rmSync(home, { recursive: true, force: true });
	return { home, paths, ports, advance, inners, order, kills, lines, mode, state, live, exitInner, cleanup };
}

async function started(s: ReturnType<typeof setup>) {
	const outer = runOuter({ home: s.home }, s.ports);
	await until(() => {
		try {
			return s.state().inner.state === "ready";
		} catch {
			return false;
		}
	}, "the first inner to be ready");
	return outer;
}

async function stopped(s: ReturnType<typeof setup>, outer: ReturnType<typeof runOuter>): Promise<number> {
	outer.stop();
	const code = await outer.done;
	s.cleanup();
	return code;
}

test("the lock is O_EXCL: a live cp-daemon holder refuses (78), a dead or reused pid is reclaimed, only the owner releases", async () => {
	const s = setup({ table: { 4242: "/opt/node /srv/app/src/service/daemon.ts run --home /h", 4343: "bash" } });
	try {
		writeFileSync(s.paths.lock, JSON.stringify({ pid: 4242, started_at: "2026-09-30T00:00:00Z", argv: "daemon.ts run" }));
		const refused = runOuter({ home: s.home }, s.ports);
		assert.equal(await refused.done, 78);
		assert.ok(s.lines.some((line) => /already runs for this home: pid 4242/.test(line)));
		assert.equal(s.inners.length, 0);
		writeFileSync(s.paths.lock, JSON.stringify({ pid: 4343, started_at: "2026-09-30T00:00:00Z", argv: "daemon.ts run" }));
		assert.deepEqual(acquireDaemonLock(s.paths, s.ports), { ok: true, reclaimed: { pid: 4343, started_at: "2026-09-30T00:00:00Z", argv: "daemon.ts run" } });
		assert.equal(acquireDaemonLock(s.paths, { ...s.ports, pid: 1, alive: () => true, argsOf: () => "node daemon.ts run" }).ok, false);
		assert.equal(releaseDaemonLock(s.paths, 999), false);
		assert.equal(releaseDaemonLock(s.paths, OUTER_PID), true);
		writeFileSync(s.paths.lock, "garbage");
		assert.match((acquireDaemonLock(s.paths, s.ports) as { reason: string }).reason, /not a cp-daemon lock/);
	} finally {
		s.cleanup();
	}
});

test("an absent or invalid config exits 78 without taking the lock", async () => {
	const s = setup();
	try {
		writeFileSync(s.paths.config, JSON.stringify({ schema_version: 1 }));
		assert.equal(await runOuter({ home: s.home }, s.ports).done, 78);
		assert.ok(s.lines.some((line) => /field generated_by/.test(line)));
		assert.throws(() => statSync(s.paths.lock));
	} finally {
		s.cleanup();
	}
});

test("running: state/daemon.json (0600) records the pid, the outer_hash and the socket; the inner gets the daemon env", async () => {
	const s = setup();
	const outer = await started(s);
	const state = s.state();
	assert.equal(state.pid, OUTER_PID);
	assert.equal(state.outer_hash, outerHash(SERVICE));
	assert.equal(state.socket, s.paths.sock);
	assert.equal(statSync(s.paths.state).mode & 0o777, 0o600);
	assert.equal(statSync(s.paths.sock).mode & 0o777, 0o600);
	const env = s.inners[0]?.env ?? {};
	assert.equal(env.CP_DAEMON_PROTOCOL, "1");
	assert.equal(env.CP_DAEMON_REASON, "start");
	assert.equal(env.CP_DAEMON_STARTED_AT, state.started_at);
	assert.equal(env.HOME, "/home/u");
	assert.equal(await stopped(s, outer), 0);
});

test("the socket: a wrong token closes it, a wrong protocol is refused, status answers without the token", async () => {
	const s = setup();
	const outer = await started(s);
	const raw = (frame: object): Promise<string> =>
		new Promise((done) => {
			let text = "";
			const socket = connect(s.paths.sock, () => socket.write(encodeFrame(frame)));
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				text += chunk;
				if (text.includes("\n")) socket.end();
			});
			socket.on("close", () => done(text));
			socket.on("error", () => done(text));
		});
	assert.equal(await raw({ id: "1", token: "wrong", protocol: 1, op: "status" }), "");
	const token = s.state().token;
	assert.deepEqual(JSON.parse(await raw({ id: "2", token, protocol: 2, op: "status" })), { id: "2", ok: false, error: "protocol 2≠1" });
	const status = await daemonRequest(s.home, "status");
	assert.equal(status.ok, true);
	assert.equal(JSON.stringify(status).includes(token), false);
	assert.equal(await stopped(s, outer), 0);
});

test("reload stops the old inner before spawning the new one, answers ok on ready, and keeps the outer pid", async () => {
	const s = setup();
	const outer = await started(s);
	const first = s.inners[0]?.pid as number;
	assert.equal(await daemonControl(s.home).reload(), undefined);
	const second = s.inners[1]?.pid as number;
	assert.deepEqual(s.order, [`spawn ${first}`, `send ${first} stop`, `exit ${first}`, `spawn ${second}`]);
	assert.equal(s.inners[1]?.env.CP_DAEMON_REASON, "reload");
	assert.equal(s.state().pid, OUTER_PID);
	assert.equal(s.state().inner.pid, second);
	assert.equal(s.state().last_reload?.ok, true);
	assert.equal(await stopped(s, outer), 0);
});

test("reload answers failed with the log tail on an early exit, and on a 60-s timeout", async () => {
	const s = setup();
	const outer = await started(s);
	writeFileSync(s.paths.log, "line 1\nline 2\nthe new runtime crashed\n");
	s.mode.autoReady = false;
	const early = daemonRequest(s.home, "reload", 5_000);
	await until(() => s.inners.length === 2, "the new inner");
	s.exitInner(s.inners[1] as FakeInner, 1);
	const reply = await early;
	assert.equal(reply.ok, false);
	assert.match((reply as { error: string }).error, /the runtime exited \(1\); line 1 \| line 2 \| the new runtime crashed/);
	assert.equal(s.state().last_reload?.ok, false);
	// The crashed inner is restarted with backoff; the next reload times out.
	s.advance(restartDelay(1));
	await until(() => s.inners.length === 3, "the backoff restart");
	const slow = daemonRequest(s.home, "reload", 5_000);
	await until(() => s.inners.length === 4, "the reloaded inner");
	s.advance(60_000);
	assert.match((await slow as { error: string }).error, /not ready within 60s/);
	s.mode.autoReady = true;
	assert.equal(await stopped(s, outer), 0);
});

test("an inner crash restarts with backoff; an inner exit 78 is failed and not restarted", async () => {
	const s = setup();
	const outer = await started(s);
	s.exitInner(s.live() as FakeInner, 1);
	assert.equal(s.state().inner.state, "restarting");
	s.advance(restartDelay(1) - 1);
	assert.equal(s.inners.length, 1);
	s.advance(1);
	assert.equal(s.inners.length, 2);
	await until(() => s.state().inner.state === "ready", "the restarted inner");
	s.exitInner(s.live() as FakeInner, 78);
	s.advance(3_600_000);
	assert.equal(s.inners.length, 2);
	assert.equal(s.state().inner.state, "failed");
	assert.deepEqual(s.state().inner.last_exit?.code, 78);
	// A reload is the way out of failed.
	assert.equal(await daemonControl(s.home).reload(), undefined);
	assert.equal(s.state().inner.state, "ready");
	assert.equal(await stopped(s, outer), 0);
});

test("six inner starts in 30 min mark it crash_looping, retried every 300 s, never given up", async () => {
	const s = setup({ autoReady: false });
	const outer = runOuter({ home: s.home }, s.ports);
	await until(() => s.inners.length === 1, "the first inner");
	for (let n = 1; n <= 5; n++) {
		s.exitInner(s.live() as FakeInner, 1);
		s.advance(restartDelay(n));
		assert.equal(s.inners.length, n + 1);
	}
	s.exitInner(s.live() as FakeInner, 1);
	assert.equal(s.state().inner.state, "crash_looping");
	s.advance(299_999);
	assert.equal(s.inners.length, 6);
	s.advance(1);
	assert.equal(s.inners.length, 7);
	assert.equal(await stopped(s, outer), 0);
});

test("SIGTERM: the inner is asked to stop, SIGKILLed after 20 s if it does not, the lock released, exit 0", async () => {
	const s = setup({ stubborn: true });
	const outer = await started(s);
	const pid = s.live()?.pid as number;
	outer.stop();
	await until(() => s.inners[0]?.sent.some((message) => message.op === "stop") ?? false, "the stop request");
	s.advance(19_999);
	assert.deepEqual(s.kills, []);
	s.advance(1);
	assert.deepEqual(s.kills, [[pid, "SIGKILL"]]);
	assert.equal(await outer.done, 0);
	assert.equal(s.state().state, "stopped");
	assert.throws(() => statSync(s.paths.lock));
	assert.throws(() => statSync(s.paths.sock));
	s.cleanup();
});

test("the log over 5 MiB is copied to daemon.prev.log and truncated, at start and every 60 s", async () => {
	const s = setup();
	writeFileSync(s.paths.log, "x".repeat(LOG_MAX_BYTES + 1));
	const outer = await started(s);
	assert.equal(statSync(s.paths.log).size, 0);
	assert.equal(statSync(s.paths.prevLog).size, LOG_MAX_BYTES + 1);
	writeFileSync(s.paths.log, "y".repeat(LOG_MAX_BYTES + 2));
	s.advance(60_000);
	assert.equal(statSync(s.paths.log).size, 0);
	assert.equal(statSync(s.paths.prevLog).size, LOG_MAX_BYTES + 2);
	assert.equal(await stopped(s, outer), 0);
});

test("hold and health are forwarded to the inner; with no inner they are refused, not hung", async () => {
	const s = setup();
	const outer = await started(s);
	assert.equal(await daemonControl(s.home).hold(), undefined);
	assert.deepEqual((await daemonRequest(s.home, "health")) as unknown, { ok: true, detail: "health done" });
	s.exitInner(s.live() as FakeInner, 78);
	assert.match((await daemonControl(s.home).hold()) ?? "", /no inner runtime to ask \(failed\)/);
	assert.equal(await stopped(s, outer), 0);
	assert.match((await daemonControl(s.home).reload()) ?? "", /not running/);
});

test("a failed inner spawn records no pid, and the stop's SIGKILL through the production port never reaches process.kill", async () => {
	const s = setup({ stubborn: true });
	const raw: Array<[number, string]> = [];
	s.ports.kill = outerKill((line) => void s.lines.push(line), (pid, signal) => void raw.push([pid, signal]));
	s.mode.failSpawn = true;
	const outer = await started(s);
	assert.equal("pid" in s.state().inner, false, "absent, never -1");
	outer.stop();
	await until(() => s.inners[0]?.sent.some((message) => message.op === "stop") ?? false, "the stop request");
	s.advance(20_000);
	assert.deepEqual(raw, []);
	assert.ok(s.lines.some((line) => line === "refused to send SIGKILL to pid undefined: not one process"));
	s.exitInner(s.inners[0] as FakeInner, null, "SIGKILL");
	assert.equal(await outer.done, 0);
	s.cleanup();
});

test("a running inner that reports failed, or is not ready within 60 s, is not_ready with the reason — never left at starting", async () => {
	const s = setup({ autoReady: false });
	const outer = runOuter({ home: s.home }, s.ports);
	await until(() => s.inners.length === 1, "the first inner");
	(s.inners[0] as FakeInner).onMessage({ type: "failed", detail: "parent exited within 5s (78)" });
	assert.equal(s.state().inner.state, "not_ready");
	assert.equal(s.state().inner.detail, "the runtime reported: parent exited within 5s (78)");
	s.exitInner(s.live() as FakeInner, 1);
	assert.equal(s.state().inner.detail, undefined, "a later state drops the reason");
	s.advance(restartDelay(1));
	assert.equal(s.inners.length, 2);
	s.advance(59_999);
	assert.equal(s.state().inner.state, "starting");
	s.advance(1);
	assert.equal(s.state().inner.state, "not_ready");
	assert.equal(s.state().inner.detail, "not ready within 60s");
	(s.inners[1] as FakeInner).onMessage({ type: "ready" });
	assert.equal(s.state().inner.state, "ready");
	assert.equal(s.state().inner.detail, undefined);
	assert.equal(await stopped(s, outer), 0);
});
