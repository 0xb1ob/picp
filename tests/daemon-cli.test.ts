/**
 * cp-wfo4: the cp-daemon CLI over fake ports and a temp home — nothing is
 * spawned, no signal is sent.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { type CliPorts, cli, cliKill, outerKill } from "../src/service/daemon.ts";
import { daemonPaths } from "../src/service/daemon-files.ts";
import { REPO_ROOT } from "./harness/index.ts";

function setup(options: { backend?: string; config?: boolean; nodeMissing?: boolean } = {}) {
	const home = mkdtempSync(join(tmpdir(), "cp-daemon-cli-"));
	const paths = daemonPaths(home);
	mkdirSync(paths.dataDir, { recursive: true });
	mkdirSync(paths.stateDir, { recursive: true });
	const config = { schema_version: 1, generated_by: "cp-install", backend: options.backend ?? "detached", node: "/opt/node/bin/node", app: "/srv/app", home, path: "/opt/node/bin:/usr/bin", port: 7300 };
	if (options.config !== false) writeFileSync(paths.config, JSON.stringify(config));
	let now = 0;
	const out: string[] = [];
	const table = new Map<number, string>();
	const kills: Array<[number, string]> = [];
	const spawns: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
	const requests: Array<[string, number | undefined]> = [];
	const behaviour = { becomesReady: true, dies: true, execFails: false };
	const execs: string[] = [];
	const ports: CliPorts = {
		env: { CP_HOME: home, HOME: "/home/u", USER: "u", ANTHROPIC_API_KEY: "sk-secret", PATH: "/shell/path" },
		out: (line) => void out.push(line),
		now: () => now,
		sleep: async (ms) => void (now += ms),
		alive: (pid) => table.has(pid),
		argsOf: (pid) => table.get(pid),
		kill: (pid, signal) => {
			kills.push([pid, signal]);
			if (behaviour.dies) table.delete(pid);
		},
		spawnDetached: (argv, env, cwd) => {
			spawns.push({ argv, env, cwd });
			const pid = 7000 + spawns.length;
			table.set(pid, argv.join(" "));
			if (behaviour.becomesReady) {
				writeFileSync(paths.lock, JSON.stringify({ pid, started_at: "x", argv: "daemon.ts run" }));
				writeFileSync(paths.state, JSON.stringify({ pid, state: "running", inner: { state: "ready" } }));
			}
			return pid;
		},
		exists: (path) => !(options.nodeMissing && path === config.node),
		request: async (_home, op, timeoutMs) => {
			requests.push([op, timeoutMs]);
			return { ok: true, detail: `${op} done` };
		},
		run: async () => 0,
		exec: (command, args) => {
			execs.push([command, ...args].join(" "));
			return behaviour.execFails ? { status: 1, stdout: "", stderr: "Unit cp-daemon.service not found." } : { status: 0, stdout: "", stderr: "" };
		},
	};
	const running = (pid = 4200): void => {
		table.set(pid, `/opt/node/bin/node /srv/app/src/service/daemon.ts run --home ${home}`);
		writeFileSync(paths.lock, JSON.stringify({ pid, started_at: "2026-10-01T00:00:00Z", argv: "daemon.ts run" }));
	};
	return { home, paths, ports, out, kills, spawns, requests, execs, behaviour, running, text: () => out.join("\n"), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("start spawns `node daemon.ts run --home H` detached with the clean env, waits for ready, prints the reboot command", async () => {
	const s = setup();
	try {
		assert.equal(await cli(["start"], s.ports), 0);
		assert.deepEqual(s.spawns[0]?.argv, ["/opt/node/bin/node", "/srv/app/src/service/daemon.ts", "run", "--home", s.home]);
		assert.deepEqual(s.spawns[0]?.env, { HOME: "/home/u", USER: "u", PATH: "/opt/node/bin:/usr/bin", CP_HOME: s.home, CP_MODE: "multi" });
		assert.equal(s.spawns[0]?.cwd, s.home);
		assert.match(s.text(), new RegExp(`after a reboot: "/opt/node/bin/node" "/srv/app/src/service/daemon.ts" start --home "${s.home}"`));
	} finally {
		s.cleanup();
	}
});

test("start is idempotent: a live holder is 'already running', nothing spawned", async () => {
	const s = setup();
	try {
		s.running();
		assert.equal(await cli(["start", "--home", s.home], s.ports), 0);
		assert.equal(s.spawns.length, 0);
		assert.match(s.text(), /already running pid 4200/);
	} finally {
		s.cleanup();
	}
});

test("start fails with the log tail when the daemon is not ready within 30 s", async () => {
	const s = setup();
	try {
		s.behaviour.becomesReady = false;
		writeFileSync(s.paths.log, "boot\nexiting 78: bad config\n");
		assert.equal(await cli(["start"], s.ports), 1);
		assert.match(s.text(), /not ready within 30s; the log says:\nboot\nexiting 78: bad config/);
	} finally {
		s.cleanup();
	}
});

test("a systemd-backend config routes start/stop/restart through systemctl --user (cp-txbb); a missing node refuses start", async () => {
	const systemd = setup({ backend: "systemd" });
	const missing = setup({ nodeMissing: true });
	try {
		for (const verb of ["start", "stop", "restart"]) assert.equal(await cli([verb], systemd.ports), 0);
		assert.deepEqual(systemd.execs, ["systemctl --user start cp-daemon.service", "systemctl --user stop cp-daemon.service", "systemctl --user restart cp-daemon.service"]);
		assert.match(systemd.text(), /stop cp-daemon\.service: ok \(the parent host and workers keep running\)/);
		assert.equal(systemd.spawns.length + systemd.kills.length, 0);
		systemd.behaviour.execFails = true;
		assert.equal(await cli(["start"], systemd.ports), 1);
		assert.match(systemd.text(), /systemctl --user start cp-daemon\.service failed: Unit cp-daemon\.service not found\./);
		writeFileSync(systemd.paths.update, JSON.stringify({ phase: "merging" }));
		assert.equal(await cli(["stop"], systemd.ports), 1);
		assert.equal(systemd.execs.length, 4, "mid-update stop is refused before systemctl");
		assert.equal(await cli(["start"], missing.ports), 1);
		assert.match(missing.text(), /\/opt\/node\/bin\/node is missing; rerun the install with --force/);
	} finally {
		systemd.cleanup();
		missing.cleanup();
	}
});

test("stop with nothing running exits 0; stop SIGTERMs the lock's verified pid only", async () => {
	const s = setup();
	try {
		assert.equal(await cli(["stop"], s.ports), 0);
		assert.match(s.text(), /not running/);
		writeFileSync(s.paths.lock, JSON.stringify({ pid: 4300, started_at: "x", argv: "daemon.ts run" }));
		assert.equal(await cli(["stop"], s.ports), 0, "a lock naming a dead pid is not running");
		s.running();
		assert.equal(await cli(["stop"], s.ports), 0);
		assert.deepEqual(s.kills, [[4200, "SIGTERM"]]);
		assert.match(s.text(), /stopped pid 4200 \(the parent host and workers keep running\)/);
	} finally {
		s.cleanup();
	}
});

test("stop reports a daemon that does not exit within 30 s", async () => {
	const s = setup();
	try {
		s.running();
		s.behaviour.dies = false;
		assert.equal(await cli(["stop"], s.ports), 1);
		assert.match(s.text(), /did not stop within 30s/);
	} finally {
		s.cleanup();
	}
});

test("status exits 3 with the reboot command when not running, 0 with the children when running", async () => {
	const s = setup();
	try {
		assert.equal(await cli(["status"], s.ports), 3);
		assert.match(s.text(), /not running\nstart it \(also after a reboot\): "\/opt\/node\/bin\/node"/);
		s.running();
		writeFileSync(s.paths.state, JSON.stringify({ pid: 4200, state: "running", started_at: "t0", backend: "detached", outer_hash: "abcdef0123456789", inner: { state: "ready", pid: 4201, restarts: 0 } }));
		const unit = { state: "running", pid: 4202, starts: [], restarts: 1, since: "t" };
		writeFileSync(s.paths.runtime, JSON.stringify({ units: { parent: unit, viewer: { ...unit, pid: 4203 }, health: { next_due: "t5" }, update: { next_due: "t10", pid: 4204 } } }));
		s.out.length = 0;
		assert.equal(await cli(["status"], s.ports), 0);
		assert.match(s.text(), /running pid 4200 since t0 \(detached\), outer abcdef012345/);
		assert.match(s.text(), /parent: running pid 4202, 1 restart/);
		assert.match(s.text(), /update: running pid 4204, next t10/);
		assert.match(s.text(), /after a reboot: /);
		const none = setup({ config: false });
		assert.equal(await cli(["status"], none.ports), 3);
		assert.match(none.text(), /run cp-install/);
		none.cleanup();
	} finally {
		s.cleanup();
	}
});

test("stop, restart and reload refuse while an update is in flight unless --force", async () => {
	const s = setup();
	try {
		s.running();
		writeFileSync(s.paths.update, JSON.stringify({ schema_version: 1, phase: "updating" }));
		for (const verb of ["stop", "restart", "reload"]) assert.equal(await cli([verb], s.ports), 1, verb);
		assert.match(s.text(), /an update is in flight \(state\/update\.json phase updating\)/);
		assert.deepEqual(s.kills, []);
		assert.deepEqual(s.requests, []);
		assert.equal(await cli(["reload", "--force"], s.ports), 0);
		assert.deepEqual(s.requests, [["reload", 90_000]]);
		assert.equal(await cli(["stop", "--force"], s.ports), 0);
		assert.deepEqual(s.kills, [[4200, "SIGTERM"]]);
		writeFileSync(s.paths.update, JSON.stringify({ schema_version: 1, phase: "idle" }));
		assert.equal(await cli(["health"], s.ports), 0, "health is never refused");
	} finally {
		s.cleanup();
	}
});

test("usage: no home, an unknown verb or argument exit 2", async () => {
	const s = setup();
	try {
		assert.equal(await cli(["bogus"], s.ports), 2);
		assert.equal(await cli(["status", "--what"], s.ports), 2);
		assert.equal(await cli(["status"], { ...s.ports, env: {} }), 2);
		assert.match(s.text(), /no home: pass --home/);
	} finally {
		s.cleanup();
	}
});

/** -1 is every process this user owns, 0 our process group, 1 init, absent a failed spawn. */
const INVALID_PIDS = [-1, 0, 1, undefined, 1.5, Number.NaN] as unknown as number[];

function proveGuarded<S extends "SIGTERM" | "SIGKILL">(port: (log: (line: string) => void, raw: (pid: number, signal: NodeJS.Signals) => void) => (pid: number, signal: S) => void, signal: S): void {
	const raw: Array<[number, string]> = [];
	const lines: string[] = [];
	const kill = port((line) => void lines.push(line), (pid, sent) => void raw.push([pid, sent]));
	for (const pid of INVALID_PIDS) kill(pid, signal);
	assert.deepEqual(raw, [], "no invalid pid reaches process.kill");
	assert.deepEqual(lines, INVALID_PIDS.map((pid) => `refused to send ${signal} to pid ${String(pid)}: not one process`));
	kill(4242, signal);
	assert.deepEqual(raw, [[4242, signal]]);
	const gone = port((line) => void lines.push(line), () => {
		throw new Error("kill ESRCH");
	});
	gone(4243, signal);
	assert.equal(lines.at(-1), `kill ${signal} 4243: kill ESRCH`, "a failed signal is logged, not thrown");
}

test("the CLI's production kill port: -1, 0, 1 and undefined never reach process.kill", () => proveGuarded(cliKill, "SIGTERM"));

test("the outer's production kill port: -1, 0, 1 and undefined never reach process.kill", () => proveGuarded(outerKill, "SIGKILL"));

test("start reports a spawn that failed (no pid) and a running daemon whose runtime is not ready", async () => {
	const failed = setup();
	const notReady = setup();
	try {
		failed.ports.spawnDetached = () => undefined;
		assert.equal(await cli(["start"], failed.ports), 1);
		assert.match(failed.text(), /\/opt\/node\/bin\/node could not be spawned/);
		assert.deepEqual(failed.kills, []);
		notReady.ports.spawnDetached = () => {
			writeFileSync(notReady.paths.state, JSON.stringify({ pid: 7100, state: "running", inner: { state: "not_ready", detail: "the runtime reported: parent exited within 5s (78)" } }));
			return 7100;
		};
		assert.equal(await cli(["start"], notReady.ports), 1);
		assert.match(notReady.text(), /pid 7100 is running, but its runtime is not ready: the runtime reported: parent exited within 5s \(78\)/);
	} finally {
		failed.cleanup();
		notReady.cleanup();
	}
});

test("bin/cp-daemon: CP_HOME unset in an installed home (<home>/app beside <home>/data/daemon.json) defaults to that home; a set CP_HOME, or no daemon.json, is left alone", (t) => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cp-daemon-bin-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	// The standard home: ~/.pi-command-post is the home and its runtime root, the checkout at app/ (src/home.ts).
	const home = join(scratch, ".pi-command-post");
	const app = join(home, "app");
	mkdirSync(join(app, "bin"), { recursive: true });
	mkdirSync(join(app, "src/service"), { recursive: true });
	copyFileSync(join(REPO_ROOT, "bin/cp-daemon"), join(app, "bin/cp-daemon"));
	// A stand-in daemon.ts: prints what the real one would resolve its home from.
	writeFileSync(join(app, "src/service/daemon.ts"), "console.log(JSON.stringify({ home: process.env.CP_HOME ?? null, argv: process.argv.slice(2) }));\n");
	const run = (env: Record<string, string>) => JSON.parse(execFileSync("/bin/sh", [join(app, "bin/cp-daemon"), "status"], { env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...env }, encoding: "utf8" })) as { home: string | null; argv: string[] };
	assert.deepEqual(run({}), { home: null, argv: ["status"] }, "no data/daemon.json: no guess, daemon.ts refuses as before");
	const { config, dataDir } = daemonPaths(home);
	assert.equal(relative(dirname(app), config), "data/daemon.json", "$ROOT/../data/daemon.json is the config daemon.ts reads for the standard home");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(config, "{}\n");
	assert.deepEqual(run({}), { home, argv: ["status"] }, "the enclosing home");
	assert.deepEqual(run({ CP_HOME: "/elsewhere" }), { home: "/elsewhere", argv: ["status"] }, "a set CP_HOME wins");
});
