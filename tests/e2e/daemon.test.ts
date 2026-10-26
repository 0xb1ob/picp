/**
 * Behavior 15 (P14b): `cp-daemon` through its CLI and control socket on scratch homes. The outer, the inner and the
 * CLI are copies of this checkout's sources in the home's app dir; the roles (and, per scenario, the outer or the
 * inner) are logging stand-ins. Daemon processes run a scaled clock (tests/harness/time-scale.ts) through a node wrapper.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { daemonPaths, OUTER_SOURCES } from "../../src/service/daemon-files.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";

const INNER_SOURCES = ["daemon-runtime.ts", "daemon-tunnel.ts", "daemon-tunnel-files.ts"];
const PRELOAD = pathToFileURL(join(REPO_ROOT, "tests/harness/time-scale.ts")).href;
const FILES = pathToFileURL(join(REPO_ROOT, "src/service/daemon-files.ts")).href;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Every stand-in: logs its start (and SIGTERM, requests) to ../fake/events.jsonl and takes its mode from <role>.mode. */
const STUB = `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { daemonPaths } from "${FILES}";
const fake = new URL("../../../fake/", import.meta.url).pathname;
const role = { "supervise.ts": "parent", "cli.ts": "viewer", "health.ts": "health", "update.ts": "update", "device-notify.ts": "device-notify",
	"daemon-runtime.ts": "inner", "daemon.ts": "outer" }[basename(process.argv[1])];
const take = () => {
	const file = fake + role + ".mode";
	if (!existsSync(file)) return "run";
	const modes = readFileSync(file, "utf8").trim().split(",");
	if (modes.length > 1) writeFileSync(file, modes.slice(1).join(","));
	return modes[0];
};
const mode = take();
const stat = readFileSync("/proc/self/stat", "utf8").slice(readFileSync("/proc/self/stat", "utf8").lastIndexOf(")") + 2).split(" ");
const log = (event, more = {}) => appendFileSync(fake + "events.jsonl", JSON.stringify({ role, pid: process.pid, event, at: Date.now(), ...more }) + "\\n");
log("start", { mode, argv: process.argv.slice(2), env: process.env, sid: Number(stat[3]) });
const stubborn = mode === "stubborn";
process.on("SIGTERM", () => { log("term"); if (!stubborn) { if (role === "outer") rmSync(daemonPaths(home).lock, { force: true }); process.exit(0); } });
setInterval(() => {}, 1 << 30);
if (mode.startsWith("exit:")) process.exit(Number(mode.slice(5)));
const home = process.argv[process.argv.indexOf("--home") + 1] ?? process.env.CP_HOME;
if (role === "outer") {
	const p = daemonPaths(home);
	mkdirSync(p.stateDir, { recursive: true });
	if (mode === "silent") appendFileSync(p.log, "boot: stuck before the lock\\n");
	else {
		const at = new Date().toISOString();
		writeFileSync(p.lock, JSON.stringify({ pid: process.pid, started_at: at, argv: "daemon.ts run" }));
		const inner = mode === "not_ready" ? { state: "not_ready", detail: "the runtime reported: parent exited", since: at, restarts: 0 } : { state: "ready", since: at, restarts: 0 };
		writeFileSync(p.state, JSON.stringify({ schema_version: 1, protocol: 1, pid: process.pid, started_at: at, backend: "detached", socket: p.sock, token: "t", outer_hash: "0123456789abcdef", state: "running", inner }));
	}
}
if (role === "inner") {
	const send = (message) => process.connected && process.send(message);
	process.on("message", (m) => {
		log("request", { op: m.op });
		if (m.op === "stop") { if (!stubborn) process.exit(0); return; }
		send({ type: "reply", id: m.id, ok: true, detail: "inner " + m.op });
	});
	process.on("disconnect", () => { if (!stubborn) process.exit(0); });
	if (mode === "crash") process.exit(1);
	if (mode === "failed") send({ type: "failed", detail: "parent exited" });
	else if (mode !== "silent") send({ type: "ready" });
}
`;

type Run = { code: number | null; out: string };

/**
 * A scratch home with `app/` (the daemon sources copied, the roles stubbed; `inner: "stub"` stubs the runtime too)
 * and a node wrapper in `fake bin/` that runs every daemon process `scale` times fast. `config()` writes data/daemon.json.
 */
function rig(t: TestContext, { scale = 1, inner = "real" as "real" | "stub", outer = "real" as "real" | "stub" } = {}) {
	const scratch = createScratchHome();
	const home = scratch.path, paths = daemonPaths(home);
	const app = join(home, "app"), fake = join(home, "fake"), fakeBin = join(home, "fake bin");
	for (const dir of [paths.dataDir, join(app, "src/service"), join(app, "src/viewer"), join(app, "src/push"), join(app, "src/tunnel"), fake, fakeBin]) mkdirSync(dir, { recursive: true });
	const stubbed = new Set(["supervise.ts", "health.ts", "update.ts", ...(inner === "stub" ? ["daemon-runtime.ts"] : [])]);
	for (const name of [...OUTER_SOURCES, ...INNER_SOURCES]) if (!stubbed.has(name)) copyFileSync(join(REPO_ROOT, "src/service", name), join(app, "src/service", name));
	copyFileSync(join(REPO_ROOT, "src/tunnel/cloudflared.ts"), join(app, "src/tunnel/cloudflared.ts"));
	for (const name of stubbed) writeFileSync(join(app, "src/service", name), STUB);
	writeFileSync(join(app, "src/viewer/cli.ts"), STUB);
	writeFileSync(join(app, "src/push/device-notify.ts"), STUB);
	// A stand-in outer lives in an app of its own: the CLI is always the real daemon.ts.
	const stubApp = join(home, "stub-app");
	if (outer === "stub") {
		mkdirSync(join(stubApp, "src/service"), { recursive: true });
		writeFileSync(join(stubApp, "src/service/daemon.ts"), STUB);
	}
	const node = join(fakeBin, "node");
	const zero = Date.now();
	writeFileSync(node, `#!/bin/sh\nCP_TEST_TIME_SCALE=${scale} CP_TEST_TIME_ZERO=${zero} exec ${process.execPath} --import ${PRELOAD} "$@"\n`, { mode: 0o755 });
	writeFileSync(join(fakeBin, "systemctl"), `#!/bin/sh\necho "$*" >> "${fake}/systemctl.log"\nif [ -e "${fake}/systemctl.fail" ]; then echo "Unit cp-daemon.service not found." >&2; exit 5; fi\n`, { mode: 0o755 });
	const PATH = `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`;
	const config = (over: Record<string, unknown> = {}) =>
		writeFileSync(paths.config, JSON.stringify({ schema_version: 1, generated_by: "cp-install", backend: "detached", node, app: outer === "stub" ? stubApp : app, home, path: PATH, port: 1, ...over }));
	/** The real CLI from the app copy, real-time, on a clean env. */
	const cli = (args: string[], env: Record<string, string> = {}): Run => {
		const r = spawnSync(process.execPath, [join(app, "src/service/daemon.ts"), ...args], { env: { PATH, HOME: home, ...env }, encoding: "utf8", timeout: 120_000 });
		return { code: r.status, out: `${r.stdout}${r.stderr}` };
	};
	const at = (...args: string[]) => cli([...args, "--home", home]);
	t.after(async () => {
		if (outer === "real") at("stop", "--force");
		for (const e of events().filter((ev) => ev.event === "start")) killStandIn(e.pid, home);
		scratch.cleanup();
	});
	const events = (): Array<{ role: string; pid: number; event: string; at?: number; mode?: string; argv?: string[]; env?: Record<string, string>; sid?: number; op?: string }> =>
		existsSync(join(fake, "events.jsonl")) ? readFileSync(join(fake, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	const starts = (role: string) => events().filter((e) => e.role === role && e.event === "start");
	const modes = (role: string, ...list: string[]) => writeFileSync(join(fake, `${role}.mode`), list.join(","));
	const log = () => (existsSync(paths.log) ? readFileSync(paths.log, "utf8") : "");
	const state = () => JSON.parse(readFileSync(paths.state, "utf8"));
	const runtime = () => JSON.parse(readFileSync(paths.runtime, "utf8"));
	const until = async (what: string, check: () => boolean, ms = 60_000) => {
		for (const end = Date.now() + ms; !check(); await sleep(100)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${log()}`);
	};
	return { home, paths, app, cfgApp: outer === "stub" ? stubApp : app, fake, fakeBin, node, PATH, zero, config, cli, at, events, starts, modes, log, state, runtime, until };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("P14-daemon-cli: cp-daemon start, stop, restart and status on the detached and systemd backends, and the usage", { timeout: 300_000 }, async (t) => {
	const r = rig(t, { outer: "stub" });
	// Usage: no home, an unknown verb or argument exit 2.
	assert.deepEqual(r.cli(["status"]), { code: 2, out: "cp-daemon: no home: pass --home <home> or set CP_HOME\n" });
	assert.equal(r.cli(["frobnicate", "--home", r.home]).code, 2);
	assert.match(r.cli(["frobnicate", "--home", r.home]).out, /^usage: cp-daemon run\|start\|stop/);
	assert.match(r.at("status", "--bogus").out, /^unknown argument "--bogus"\nusage: cp-daemon /);
	assert.match(r.at("start").out, /cp-daemon start: refused: no \S+daemon\.json: run cp-install first/);
	assert.deepEqual(r.starts("outer"), []);

	// Not running: exit 3 and the start command, also after a reboot (one quoted command).
	r.config();
	const down = r.at("status");
	assert.equal(down.code, 3);
	assert.equal(down.out, `cp-daemon: not running\nstart it (also after a reboot): "${r.node}" "${r.cfgApp}/src/service/daemon.ts" start --home "${r.home}"\n`);
	r.config({ app: "/a$b", home: '/h"q' });
	const escaped = r.at("status").out.split("\n")[1];
	assert.equal(escaped, `start it (also after a reboot): "${r.node}" "/a\\$b/src/service/daemon.ts" start --home "/h\\"q"`, "$ and \" escaped");

	// A node that cannot be run is a failed spawn; a missing one is refused.
	r.config({ node: r.fake });
	assert.match(r.at("start").out, /cp-daemon start: \S+\/fake could not be spawned/);
	r.config({ node: join(r.home, "gone", "node") });
	assert.match(r.at("start").out, /cp-daemon start: refused: \S+\/gone\/node is missing; rerun the install with --force from the new node/);

	// start: `node daemon.ts run --home H` in a session of its own with the clean env; ready, then the reboot command.
	r.config();
	const up = r.cli(["start", "--force", "--home", r.home], { SSH_AUTH_SOCK: "/tmp/agent", ANTHROPIC_API_KEY: "sk-shell-only" });
	assert.equal(up.code, 0, up.out);
	const [outer] = r.starts("outer");
	assert.match(up.out, new RegExp(`^cp-daemon: started pid ${outer!.pid}; after a reboot: "${r.node}" `));
	assert.deepEqual(outer!.argv, ["run", "--home", r.home]);
	assert.equal(outer!.sid, outer!.pid, "detached: its own session");
	const env = Object.keys(outer!.env!).filter((k) => !k.startsWith("CP_TEST_") && k !== "PWD" && k !== "SHLVL" && k !== "_").sort();
	assert.deepEqual(env, ["CP_HOME", "CP_MODE", "HOME", "PATH"], "the clean env: nothing from the shell beyond HOME");
	assert.match(r.at("start").out, new RegExp(`^cp-daemon: already running pid ${outer!.pid}\n$`));
	assert.equal(r.starts("outer").length, 1, "idempotent: nothing spawned");
	const running = r.at("status");
	assert.equal(running.code, 0);
	assert.match(running.out, new RegExp(`^cp-daemon: running pid ${outer!.pid} since \\S+ \\(detached\\), outer 0123456789ab\ninner: ready, 0 restart\\(s\\)\nlog: ${r.paths.log}\nafter a reboot: "`));

	// An update in flight refuses stop, restart and reload unless --force.
	writeFileSync(r.paths.update, JSON.stringify({ phase: "draining" }));
	for (const verb of ["stop", "restart", "reload"]) {
		const refused = r.at(verb);
		assert.equal(refused.code, 1);
		assert.match(refused.out, new RegExp(`^cp-daemon ${verb}: refused: an update is in flight \\(state/update\\.json phase draining\\); retry when it is idle, or pass --force`));
	}
	assert.ok(alive(outer!.pid));
	const stopped = r.at("stop", "--force");
	assert.equal(stopped.out, `cp-daemon: stopped pid ${outer!.pid} (the parent host and workers keep running)\n`);
	writeFileSync(r.paths.update, JSON.stringify({ phase: "idle" }));
	assert.equal(r.at("stop").out, "cp-daemon: not running\n", "nothing running: exit 0");

	// A lock naming a live process that is not a cp-daemon is never signalled.
	const other = spawn("sleep", ["60"]);
	t.after(() => other.kill("SIGKILL"));
	writeFileSync(r.paths.lock, JSON.stringify({ pid: other.pid, started_at: new Date().toISOString(), argv: "daemon.ts run" }));
	assert.equal(r.at("stop").out, "cp-daemon: not running\n");
	assert.ok(alive(other.pid!), "only the lock's verified pid");

	// A runtime that reports not ready; a daemon that never gets ready names the log tail; one that ignores SIGTERM.
	r.modes("outer", "not_ready", "silent", "stubborn");
	const notReady = r.at("restart");
	assert.match(notReady.out, /cp-daemon: pid \d+ is running, but its runtime is not ready: the runtime reported: parent exited; see cp-daemon status and cp-daemon log/);
	assert.equal(notReady.code, 1);
	r.at("stop");
	const silent = r.at("start");
	assert.equal(silent.code, 1);
	assert.match(silent.out, /cp-daemon: pid \d+ is not ready within 30s; the log says:\nboot: stuck before the lock/);
	for (const e of r.starts("outer")) killStandIn(e.pid, r.home);
	assert.equal(r.at("start").code, 0);
	const stubborn = r.starts("outer").at(-1)!.pid;
	const slow = r.at("stop");
	assert.equal(slow.code, 1);
	assert.equal(slow.out, `cp-daemon: pid ${stubborn} did not stop within 30s; see ${r.paths.log}\n`);
	process.kill(stubborn, "SIGKILL");

	// The systemd backend: start, stop and restart are systemctl --user verbs on the unit; a failure names journalctl.
	r.config({ backend: "systemd" });
	const unit = (verb: string) => r.at(verb);
	assert.equal(unit("start").out, "cp-daemon: systemctl --user start cp-daemon.service: ok\n");
	assert.equal(unit("stop").out, "cp-daemon: systemctl --user stop cp-daemon.service: ok (the parent host and workers keep running)\n");
	writeFileSync(join(r.fake, "systemctl.fail"), "");
	assert.equal(unit("restart").out, "cp-daemon restart: systemctl --user restart cp-daemon.service failed: Unit cp-daemon.service not found.; journalctl --user -u cp-daemon.service -n 20\n");
	assert.equal(readFileSync(join(r.fake, "systemctl.log"), "utf8"), "--user start cp-daemon.service\n--user stop cp-daemon.service\n--user restart cp-daemon.service\n");
	assert.match(r.at("status").out, /start it \(also after a reboot\): systemctl --user start cp-daemon\.service/);
});

test("P14-daemon-bin: bin/cp-daemon in an installed home defaults CP_HOME to that home; a set CP_HOME or no daemon.json is left alone", { timeout: 120_000 }, async (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = join(scratch.path, ".pi-command-post");
	mkdirSync(join(home, "app", "bin"), { recursive: true });
	for (const dir of ["src/service", "src/tunnel"]) mkdirSync(join(home, "app", dir), { recursive: true });
	copyFileSync(join(REPO_ROOT, "bin/cp-daemon"), join(home, "app/bin/cp-daemon"));
	for (const name of OUTER_SOURCES) copyFileSync(join(REPO_ROOT, "src/service", name), join(home, "app/src/service", name));
	const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch.path };
	const run = (extra: Record<string, string> = {}) => spawnSync(join(home, "app/bin/cp-daemon"), ["status"], { env: { ...env, ...extra }, encoding: "utf8" });
	assert.equal(run().stdout, "cp-daemon: no home: pass --home <home> or set CP_HOME\n", "no daemon.json beside the app: no home");
	const paths = daemonPaths(home);
	mkdirSync(paths.dataDir);
	writeFileSync(paths.config, JSON.stringify({ schema_version: 1, generated_by: "cp-install", backend: "detached", node: process.execPath, app: join(home, "app"), home, path: env.PATH, port: 1 }));
	const installed = run();
	assert.equal(installed.status, 3);
	assert.match(installed.stdout, new RegExp(`start --home "${home}"\\n$`), "the enclosing home");
	const other = run({ CP_HOME: join(scratch.path, "other") });
	assert.match(other.stdout, new RegExp(`no ${scratch.path}/other/\\.pi-command-post/data/daemon\\.json: run cp-install`), "a set CP_HOME wins");
});

/** Newline-JSON `frames` written one by one to the control socket; the replies, and whether the daemon closed it. */
function socket(path: string, frames: string[], waitMs = 5_000): Promise<{ replies: Array<Record<string, unknown>>; closed: boolean }> {
	return new Promise((done) => {
		const s = connect(path);
		const expected = frames.join("").split("\n").length - 1;
		let buffer = "", closed = false, timer: NodeJS.Timeout | undefined;
		const lines = () => buffer.split("\n").filter(Boolean);
		const finish = () => {
			clearTimeout(timer);
			done({ replies: lines().map((line) => JSON.parse(line)), closed });
			s.destroy();
		};
		// Settles on the event: a reply per frame, or the daemon closing the socket; waitMs is only the cap.
		s.setEncoding("utf8").on("data", (chunk: string) => { buffer += chunk; if (buffer.endsWith("\n") && lines().length >= expected) finish(); });
		s.on("connect", async () => { for (const frame of frames) { if (!s.destroyed) s.write(frame); await sleep(100); } });
		s.on("error", () => {});
		s.on("close", () => { closed = true; finish(); });
		timer = setTimeout(finish, waitMs);
	});
}

test("P14-daemon-outer: one locked outer per home, its socket, and its inner's reloads, crashes and stops", { timeout: 300_000 }, async (t) => {
	const r = rig(t, { scale: 20, inner: "stub" });
	const run = () => spawnSync(r.node, [join(r.app, "src/service/daemon.ts"), "run", "--home", r.home, "--stdout"], { env: { PATH: r.PATH, HOME: r.home }, encoding: "utf8", timeout: 60_000 });
	// No config, or an invalid one: exit 78 before the lock, naming the bad field.
	const absent = run();
	assert.equal(absent.status, 78);
	assert.match(absent.stderr, /data\/daemon\.json is absent: run cp-install; not starting \(exit 78\)/);
	r.config({ port: 0 });
	const invalid = run();
	assert.equal(invalid.status, 78);
	assert.match(invalid.stderr, /daemon config field port: expected an integer 1-65535, got 0; not starting \(exit 78\)/);
	assert.equal(existsSync(r.paths.lock), false, "no lock taken");

	// A lock held by a reused pid is reclaimed; the log over 5 MiB moves to daemon.prev.log at start.
	r.config();
	const reused = spawn("sleep", ["60"]);
	t.after(() => reused.kill("SIGKILL"));
	mkdirSync(r.paths.stateDir, { recursive: true });
	writeFileSync(r.paths.lock, JSON.stringify({ pid: reused.pid, started_at: new Date().toISOString(), argv: "daemon.ts run" }));
	writeFileSync(r.paths.log, `${"old line\n".repeat(600_000)}`);
	const env = { XDG_RUNTIME_DIR: "/run/user/p14", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/p14/bus", FOO: "shell-only" };
	assert.equal(r.at("start").code, 0, r.log());
	const prev = readFileSync(r.paths.prevLog, "utf8");
	assert.match(prev, new RegExp(`^old line\\n[^]*reclaimed ${r.paths.lock} from pid ${reused.pid} \\(not a running cp-daemon\\)`));
	assert.ok(alive(reused.pid!), "a reclaimed lock's pid is never signalled");
	assert.ok(statSync(r.paths.log).size < 10_000, "truncated in place");
	const outer = r.state().pid as number;
	assert.equal(statSync(r.paths.state).mode & 0o777, 0o600);
	assert.deepEqual([r.state().socket, r.state().outer_hash.length, r.state().inner.state], [r.paths.sock, 64, "ready"]);
	const second = run();
	assert.equal(second.status, 78);
	assert.match(second.stderr, new RegExp(`cp-daemon already runs for this home: pid ${outer}, since \\S+; exiting 78`));

	// The inner's env: the daemon's markers, the config's PATH and the base keys, nothing else from the shell.
	const [first] = r.starts("inner");
	const { CP_TEST_TIME_SCALE: _s, CP_TEST_TIME_ZERO: _z, PWD: _p, ...innerEnv } = first!.env!;
	assert.deepEqual(innerEnv, { HOME: r.home, CP_HOME: r.home, CP_MODE: "multi", PATH: r.PATH, CP_DAEMON_PROTOCOL: "1", CP_DAEMON_STARTED_AT: r.state().started_at, CP_DAEMON_REASON: "start" });
	r.at("stop");
	assert.equal(r.cli(["start", "--home", r.home], env).code, 0);
	const withBus = r.starts("inner").at(-1)!.env!;
	assert.deepEqual([withBus.XDG_RUNTIME_DIR, withBus.DBUS_SESSION_BUS_ADDRESS, withBus.FOO], [env.XDG_RUNTIME_DIR, env.DBUS_SESSION_BUS_ADDRESS, undefined]);

	// The socket: status needs the token and never shows it; a wrong protocol is refused; a frame may arrive in parts.
	const token = r.state().token as string;
	const frame = (op: string, over: Record<string, unknown> = {}) => `${JSON.stringify({ id: op, token, protocol: 1, op, ...over })}\n`;
	const status = await socket(r.paths.sock, [frame("status").slice(0, 20), frame("status").slice(20)]);
	assert.equal(status.replies[0]?.ok, true);
	assert.equal((status.replies[0]?.state as { pid: number }).pid, r.state().pid);
	assert.equal(JSON.stringify(status.replies).includes(token), false, "the token never leaves the state file");
	assert.deepEqual(await socket(r.paths.sock, [frame("status", { token: "f".repeat(64) }), frame("status")]), { replies: [], closed: true }, "a wrong token closes it");
	assert.deepEqual(await socket(r.paths.sock, ["{bad\n", frame("status")]), { replies: [], closed: true }, "a bad frame closes it");
	assert.deepEqual((await socket(r.paths.sock, [frame("status", { protocol: 2 })])).replies, [{ id: "status", ok: false, error: "protocol 2≠1" }]);
	// hold and health reach the inner; the tunnel's, devices' and sender's ops are unknown here, never forwarded.
	const ops = await socket(r.paths.sock, ["hold", "release", "tunnel", "device", "sender"].map((op) => frame(op)));
	assert.deepEqual(ops.replies.map((reply) => reply.detail ?? reply.error), ["inner hold", "inner release", 'unknown op "tunnel"', 'unknown op "device"', 'unknown op "sender"']);
	assert.equal(r.at("health").out, "cp-daemon health: ok (inner health)\n");
	assert.deepEqual(r.events().filter((e) => e.event === "request" && e.op !== "stop").map((e) => e.op), ["hold", "release", "health"]);

	// reload: the old inner is stopped before the new one starts, the outer stays; an early exit and a silent one fail.
	const before = r.starts("inner").at(-1)!.pid;
	const outerNow = r.state().pid;
	r.modes("inner", "ready", "crash", "ready", "silent", "failed", "ready");
	assert.equal(r.at("reload").out, "cp-daemon reload: ok\n");
	const kinds = r.events().filter((e) => e.role === "inner" && (e.event === "start" || e.op === "stop")).slice(-2);
	assert.deepEqual(kinds.map((e) => [e.pid, e.event]), [[before, "request"], [r.starts("inner").at(-1)!.pid, "start"]]);
	assert.equal(r.starts("inner").at(-1)!.env!.CP_DAEMON_REASON, "reload");
	assert.equal(r.state().pid, outerNow, "the outer keeps its pid");
	assert.match(r.at("status").out, /^last reload: ok at /m);
	const early = r.at("reload");
	assert.equal(early.code, 1);
	assert.match(early.out, /^cp-daemon reload: failed: the runtime exited \(1\); .*inner pid \d+ exited \(1\); restart in 5s/);
	await r.until("the restarted inner", () => r.state().inner.state === "ready");
	assert.match(r.at("reload").out, /^cp-daemon reload: failed: not ready within 60s; /);
	assert.deepEqual([r.state().inner.state, r.state().inner.detail], ["not_ready", "not ready within 60s"]);
	assert.match(r.at("reload").out, /^cp-daemon reload: failed: the runtime reported: parent exited; /);
	assert.deepEqual([r.state().inner.state, r.state().inner.detail], ["not_ready", "the runtime reported: parent exited"]);
	assert.equal(r.at("reload").out, "cp-daemon reload: ok\n");

	// A fresh outer: crashes back off on the supervisor's schedule; six starts in 30 min are a crash loop retried every
	// 300 s, never given up; an exit 78 is failed, not restarted, and with no inner, hold and health are refused.
	r.modes("inner", "crash", "crash", "crash", "crash", "crash", "crash", "exit:78");
	r.at("restart");
	await r.until("the exit 78", () => r.state().inner.state === "failed", 90_000);
	const delays = [...r.log().matchAll(/inner pid \d+ exited \(1\); (crash looping, )?restart in ([\d.]+)s/g)].map((m) => `${m[1] ?? ""}${m[2]}`);
	assert.deepEqual(delays.slice(-6), ["5", "11.34", "25.718", "58.326", "132.279", "crash looping, 300"]);
	assert.match(r.log(), /inner pid \d+ exited 78 \(protocol or config\): failed until cp-daemon reload or restart/);
	const failedStarts = r.starts("inner").length;
	await sleep(1_500);
	assert.equal(r.starts("inner").length, failedStarts, "an exit 78 is never restarted");
	assert.equal(r.at("health").out, "cp-daemon health: failed: no inner runtime to ask (failed)\n");
	assert.deepEqual((await socket(r.paths.sock, [frame("hold", { token: r.state().token })])).replies[0]?.detail, "no inner runtime to ask (failed)");

	// SIGTERM: an inner that ignores its stop is SIGKILLed after 20 s; the lock goes and the outer exits 0. Meanwhile
	// the log, grown past 5 MiB, was rotated within the minute.
	r.modes("inner", "stubborn");
	assert.equal(r.at("reload").out, "cp-daemon reload: ok\n");
	const stubborn = r.starts("inner").at(-1)!.pid;
	appendFileSync(r.paths.log, "x".repeat(5_300_000));
	await r.until("the minute's rotation", () => statSync(r.paths.log).size < 1_000_000 && /rotated \S+daemon\.log to \S+daemon\.prev\.log/.test(r.log()));
	const pid = r.state().pid as number;
	assert.match(r.at("stop").out, new RegExp(`^cp-daemon: stopped pid ${pid} `));
	assert.match(r.log(), new RegExp(`inner pid ${stubborn} did not stop within 20s: SIGKILL[^]*stopped\\n`));
	assert.equal(alive(stubborn), false);
	assert.equal(existsSync(r.paths.lock), false);
	assert.equal(r.state().state, "stopped");

	// A failed inner spawn (the node gone after the outer started) records no pid.
	r.config({ node: r.fake });
	const direct: ChildProcess = spawn(process.execPath, [join(r.app, "src/service/daemon.ts"), "run", "--home", r.home], { env: { PATH: r.PATH, HOME: r.home }, stdio: "ignore" });
	t.after(() => direct.kill("SIGKILL"));
	await r.until("the failed spawn", () => /inner spawn failed: spawn \S+\/fake EACCES/.test(r.log()));
	await r.until("the restarting state", () => r.state().inner.state === "restarting");
	assert.equal(r.state().inner.pid, undefined);
	direct.kill("SIGTERM");
	assert.equal(await new Promise((done) => direct.once("exit", done)), 0);
});

test("P14-daemon-hash: outer_hash covers every outer source — changing any one changes the hash cp-daemon status shows", { timeout: 300_000 }, async (t) => {
	const r = rig(t, { scale: 20, inner: "stub" });
	r.config();
	const seen = new Set<string>();
	for (const name of [undefined, ...OUTER_SOURCES]) {
		if (name) appendFileSync(join(r.app, "src/service", name), "\n// p14b\n");
		assert.equal(r.at("restart").code, 0, r.log());
		const line = /^cp-daemon: running pid \d+ since \S+ \(detached\), outer ([0-9a-f]{12})$/m.exec(r.at("status").out)?.[1];
		assert.ok(line && !seen.has(line), `${name ?? "first"}: a new outer hash`);
		seen.add(line);
	}
	assert.equal(seen.size, OUTER_SOURCES.length + 1);
});

/** The env a stand-in saw, without what the scaled-clock wrapper and its shell add. */
const roleEnv = (env: Record<string, string> | undefined) => {
	const { CP_TEST_TIME_SCALE: _s, CP_TEST_TIME_ZERO: _z, PWD: _p, ...rest } = env ?? {};
	return rest;
};

test("P14-daemon-runtime: the inner runs the parent, viewer and sender, the health and update oneshots, holds and orphans", { timeout: 300_000 }, async (t) => {
	const r = rig(t, { scale: 30 });
	r.config();
	r.modes("health", "stubborn", "run");
	r.modes("update", "run");
	r.modes("parent", "run", "run", "run", "stubborn");
	const session = { XDG_RUNTIME_DIR: "/run/user/p14", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/p14/bus" };
	assert.equal(r.cli(["start", "--home", r.home], { ...session, SSH_AUTH_SOCK: "/tmp/agent" }).code, 0, r.log());
	const status = () => r.at("status").out;
	/** The scaled clock of the first daemon.log line matching `re` (each line starts with its ISO time). */
	const stamp = (re: RegExp) => Date.parse(r.log().split("\n").find((line) => re.test(line))?.split(" ")[0] ?? "");
	const token = () => r.state().token as string;
	const op = async (name: string) => (await socket(r.paths.sock, [`${JSON.stringify({ id: name, token: token(), protocol: 1, op: name })}\n`])).replies[0];

	// The parent and viewer start with their unit argv and env — the user manager's session keys, nothing else
	// ambient — and nothing more runs (no remote feature: no sender).
	const [parent] = r.starts("parent"), [viewer] = r.starts("viewer");
	const core = { HOME: r.home, ...session, CP_HOME: r.home, CP_MODE: "multi", PATH: r.PATH };
	assert.deepEqual([parent!.argv, roleEnv(parent!.env)], [[], { ...core, CP_VIEWER_PORT: "1" }]);
	assert.deepEqual([viewer!.argv, roleEnv(viewer!.env)], [["--home", r.home, "--require-tailnet", "--port", "1"], { ...core, CP_DAEMON_ROLE: "viewer" }]);
	const started = Date.parse(r.state().started_at);
	const due = (ms: number) => new Date(started + ms).toISOString();
	assert.match(status(), new RegExp(`^parent: running pid ${parent!.pid}, 0 restart\\(s\\)\nviewer: running pid ${viewer!.pid}, 0 restart\\(s\\)\nhealth: idle, next ${due(180_000)}\nupdate: idle, next ${due(600_000)}$`, "m"));
	assert.deepEqual(r.starts("device-notify"), []);

	// The viewer is restarted 10 s after any exit.
	process.kill(viewer!.pid, "SIGKILL");
	await r.until("the viewer restart", () => r.starts("viewer").length === 2);
	const viewerExit = stamp(new RegExp(`viewer pid ${viewer!.pid} exited \\(SIGKILL\\); restart 1 in 10s`));
	const viewerBack = stamp(new RegExp(`viewer started pid ${r.starts("viewer")[1]!.pid}`));
	assert.ok(viewerBack - viewerExit >= 9_000 && viewerBack - viewerExit < 16_000, `${viewerBack - viewerExit} ms`);

	// health is first due at +3 min; at 120 s a SIGTERM, 10 s later a SIGKILL. The health op starts one now, once.
	await r.until("the health SIGKILL", () => /health pid \d+ ignored SIGTERM: SIGKILL/.test(r.log()));
	const [health] = r.starts("health");
	const healthAt = stamp(new RegExp(`health started pid ${health!.pid}`));
	assert.ok(healthAt - started >= 180_000 && healthAt - started < 200_000, `${healthAt - started} ms`);
	const term = stamp(new RegExp(`health pid ${health!.pid} timed out after 120s: SIGTERM`));
	assert.ok(term - healthAt >= 120_000 && term - healthAt < 140_000, `${term - healthAt} ms`);
	const kill = stamp(new RegExp(`health pid ${health!.pid} ignored SIGTERM: SIGKILL`));
	assert.ok(kill - term >= 9_000 && kill - term < 20_000, `${kill - term} ms`);
	await r.until("the health exit", () => r.runtime().units.health.pid === undefined);
	const ran = Number(/^cp-daemon health: ok \(health started pid (\d+)\)\n$/.exec(r.at("health").out)?.[1]);
	assert.equal(r.at("health").out, `cp-daemon health: ok (health pid ${ran} is already running)\n`);
	await r.until("the second health", () => r.starts("health").length === 2);
	assert.equal(r.starts("health")[1]!.pid, ran);
	assert.equal(r.runtime().units.health.next_due, new Date(stamp(new RegExp(`health started pid ${ran}`)) + 300_000).toISOString(), "5 min after the last start");

	// update is first due at +10 min; still running when due again 5 min later, that run is skipped.
	await r.until("the skipped update", () => /update due while pid \d+ is still running: skipped/.test(r.log()), 90_000);
	const [update] = r.starts("update");
	const updateAt = stamp(new RegExp(`update started pid ${update!.pid}`));
	assert.ok(updateAt - started >= 600_000 && updateAt - started < 620_000, `${updateAt - started} ms`);
	assert.match(r.log(), new RegExp(`update due while pid ${update!.pid} is still running: skipped`));
	assert.equal(r.starts("update").length, 1);

	// A reload of the same outer adopts the running update and keeps the timers; the parent's restart count resets.
	const timers = [r.runtime().units.health.next_due, r.runtime().units.update.next_due];
	assert.equal(r.at("reload").out, "cp-daemon reload: ok\n", r.log());
	assert.match(r.log(), new RegExp(`adopted the in-flight update run pid ${update!.pid}`));
	assert.deepEqual([r.runtime().units.health.next_due, r.runtime().units.update.next_due], timers);
	assert.equal(r.runtime().units.update.pid, update!.pid);
	assert.equal(r.starts("update").length, 1, "adopted, not respawned");

	// The remote feature: a paired device starts the sender on the next tick; a crash restarts it on the backoff.
	writeFileSync(join(r.paths.dataDir, "devices.json"), "{}");
	await r.until("the sender", () => r.starts("device-notify").length === 1);
	const [sender] = r.starts("device-notify");
	assert.deepEqual([sender!.argv, roleEnv(sender!.env)], [[], { ...core, CP_DAEMON_ROLE: "device-notify" }]);
	process.kill(sender!.pid, "SIGKILL");
	await r.until("the sender restart", () => r.starts("device-notify").length === 2);
	assert.match(r.log(), new RegExp(`device-notify pid ${sender!.pid} exited \\(SIGKILL\\); restart 1 in 5s`));

	// hold stops the viewer and the sender until release, at most 50 min.
	const viewers = r.starts("viewer").length;
	assert.deepEqual(await op("hold"), { id: "hold", ok: true });
	await r.until("the held viewer", () => r.runtime().units.viewer.state === "held" && r.runtime().units["device-notify"].state === "held");
	const until = Date.parse(r.runtime().hold.until);
	const heldAt = stamp(/viewer held until /);
	assert.ok(until - heldAt > 49 * 60_000 && until - heldAt <= 50 * 60_000, `${until - heldAt} ms`);
	assert.match(status(), new RegExp(`^viewer: held, \\d+ restart\\(s\\)$[^]*^viewer held until ${r.runtime().hold.until}$`, "m"));
	await sleep(1_000);
	assert.equal(r.starts("viewer").length, viewers, "no restart while held");
	assert.deepEqual([r.runtime().units["device-notify"].state, r.starts("device-notify").length], ["held", 2], "sender held");
	await op("release");
	await r.until("the released viewer", () => r.starts("viewer").length === viewers + 1 && r.starts("device-notify").length === 3);
	assert.equal(r.starts("device-notify").length, 3, "the release starts the sender again");
	assert.match(r.log(), /viewer hold released \(released\)/);

	// A persisted hold survives a crash restart of the inner, whose live children are stopped first; a reload clears it.
	await op("hold");
	await r.until("the held viewer", () => r.runtime().units.viewer.pid === undefined);
	const orphan = r.runtime().units.parent.pid as number;
	process.kill(r.state().inner.pid, "SIGKILL");
	await r.until("the new inner", () => r.state().inner.state === "ready" && r.runtime().units.parent.pid !== orphan);
	assert.match(r.log(), new RegExp(`stopping orphaned children of a previous runtime: ${orphan}(, \\d+)?\\n`));
	assert.equal(alive(orphan), false);
	assert.equal(r.runtime().units.viewer.state, "held");
	assert.equal(r.starts("viewer").length, viewers + 1, "still held");
	assert.equal(r.at("reload").out, "cp-daemon reload: ok\n");
	assert.equal(r.runtime().hold, undefined);
	assert.equal(r.starts("viewer").length, viewers + 2);

	// stop SIGTERMs the parent, viewer and sender — a stubborn parent is SIGKILLed after 10 s — never the oneshots.
	await r.until("the stubborn parent", () => r.starts("parent").at(-1)?.mode === "stubborn");
	const stubborn = r.starts("parent").at(-1)!;
	assert.equal(r.at("stop").code, 0);
	const termAt = r.events().find((e) => e.pid === stubborn.pid && e.event === "term")!.at!;
	const killAt = stamp(new RegExp(`parent pid ${stubborn.pid} ignored SIGTERM: SIGKILL`));
	assert.ok(killAt - termAt >= 9_000 && killAt - termAt < 18_000, `${killAt - termAt} ms`);
	assert.match(r.log(), /stopped \(oneshots left running\)/);
	assert.ok(alive(update!.pid), "the update run outlives the daemon");
	for (const role of ["viewer", "device-notify"]) assert.equal(r.starts(role).every((e) => !alive(e.pid)), true, role);
});

test("P14-daemon-runtime-fail: a parent crash loop backs off and fails; exit 78 is never restarted; a failed spawn has no pid; another protocol is refused", { timeout: 300_000 }, async (t) => {
	const r = rig(t, { scale: 5 }); // the readiness window, 5 s, must outlast a stand-in's node boot
	r.config();
	r.modes("parent", "exit:1");
	const start = r.at("start");
	assert.equal(start.code, 1);
	assert.match(start.out, /its runtime is not ready: the runtime reported: parent exited within 5s \(\{"code":1,"signal":null,"at":"[^"]+"\}\), now restarting/);
	await r.until("the start limit", () => /parent pid \d+ exited \(1\); failed \(start-limit-hit\), not restarting/.test(r.log()));
	const delays = [...r.log().matchAll(/parent pid \d+ exited \(1\); restart (\d) in ([\d.]+)s/g)].map((m) => `${m[1]}:${m[2]}`);
	assert.deepEqual(delays, ["1:5", "2:11.34", "3:25.718", "4:58.326", "5:132.279"]);
	assert.equal(r.starts("parent").length, 6);
	assert.match(r.at("status").out, /^parent: failed \(start-limit-hit\), 5 restart\(s\)$/m);

	// exit 78 is failed (exit-code) and never restarted.
	r.modes("parent", "exit:78");
	r.at("reload");
	await r.until("the exit-code failure", () => /parent pid \d+ exited \(78\); failed \(exit-code\), not restarting/.test(r.log()));
	await sleep(1_000);
	assert.equal(r.starts("parent").length, 7);

	// A node the inner cannot spawn: the parent restarts with no pid recorded, and stop still settles.
	r.modes("parent", "run");
	r.config({ node: r.fake });
	r.at("reload");
	await r.until("the failed spawn", () => /parent spawn failed: spawn \S+\/fake EACCES/.test(r.log()));
	assert.equal(r.runtime().units.parent.pid, undefined);
	assert.match(r.at("status").out, /^parent: failed \(start-limit-hit\), 0 restart\(s\)\nviewer: restarting, 1 restart\(s\)$/m, "no pid recorded");
	assert.doesNotMatch(JSON.stringify(r.runtime()), /"pid":-1/, "never -1");
	// Hold and stop then signal nothing: innerKill would log a refused or a failed kill for a missing pid.
	const settled = r.log().length;
	const hold = `${JSON.stringify({ id: "hold", token: r.state().token, protocol: 1, op: "hold" })}\n`;
	assert.equal((await socket(r.paths.sock, [hold])).replies[0]?.ok, true);
	assert.equal(r.at("stop").code, 0);
	assert.doesNotMatch(r.log().slice(settled), /refused to send|kill SIG|ignored SIGTERM/);
	assert.doesNotMatch(r.log(), /ignored SIGTERM/);

	// A new outer: recorded pids whose command lines no longer match (reused) are neither adopted nor signalled, and
	// the timers restart from its own start.
	const reused = spawn("sleep", ["60"]);
	t.after(() => reused.kill("SIGKILL"));
	const record = r.runtime();
	record.units.update = { ...record.units.update, pid: reused.pid, started_at: record.started_at };
	record.units.viewer = { ...record.units.viewer, state: "running", pid: reused.pid };
	writeFileSync(r.paths.runtime, JSON.stringify(record));
	r.modes("parent", "run");
	r.config();
	const logged = r.log().length;
	assert.equal(r.at("start").code, 0, r.log());
	assert.doesNotMatch(r.log().slice(logged), new RegExp(`adopted the in-flight update|pid ${reused.pid}|orphaned`));
	assert.ok(alive(reused.pid!), "a reused pid is never signalled");
	assert.equal(r.runtime().units.update.pid, undefined);
	assert.equal(r.runtime().units.health.next_due, new Date(Date.parse(r.state().started_at) + 180_000).toISOString());
	r.at("stop");

	// A runtime on another protocol, or without the outer's IPC, exits 78 before it does anything.
	const inner = (env: Record<string, string>) => spawnSync(process.execPath, [join(r.app, "src/service/daemon-runtime.ts")], { env: { PATH: r.PATH, HOME: r.home, CP_HOME: r.home, ...env }, encoding: "utf8" });
	const other = inner({ CP_DAEMON_PROTOCOL: "2" });
	assert.equal(other.status, 78);
	assert.match(other.stderr, /the outer speaks protocol 2, this runtime 1: run cp-daemon restart; exiting 78/);
	assert.match(inner({ CP_DAEMON_PROTOCOL: "1" }).stderr, /not started by cp-daemon \(no IPC channel\); exiting 78/);
});

/** SIGKILL a logged stand-in only while its pid still runs this home's code: a pid reused since is never signalled. */
function killStandIn(pid: number, home: string): void {
	try {
		if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(home)) process.kill(pid, "SIGKILL");
	} catch { /* gone */ }
}
