/**
 * cp-wfo4: the pure half of cp-daemon — paths (equal to the layout), the
 * restart policy (systemd's numbers), env/argv parity with the legacy units,
 * config validation, frames, the outer's import boundary and its hash.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { layoutForHome } from "../src/contracts/layout.ts";
import {
	childArgv,
	baseEnv,
	childEnv,
	type DaemonConfig,
	daemonPaths,
	decideRestart,
	decodeFrames,
	encodeFrame,
	OUTER_SOURCES,
	outerHash,
	rebootCommand,
	restartDelay,
	rotateLog,
	validateDaemonConfig,
} from "../src/service/daemon-files.ts";
import { renderUnits, unitPath } from "../src/service/units.ts";

const SERVICE = resolve(import.meta.dirname, "../src/service");

test("daemonPaths equals layoutForHome('multi', home) for a nested and a flat home", () => {
	for (const home of ["/srv/homes/a", "/home/u/.pi-command-post"]) {
		const layout = layoutForHome("multi", home);
		const paths = daemonPaths(home);
		assert.equal(paths.stateDir, join(home, layout.state));
		assert.equal(paths.dataDir, join(home, layout.data));
		assert.equal(paths.lock, join(home, layout.state, "daemon.lock"));
		assert.equal(paths.config, join(home, layout.data, "daemon.json"));
		assert.equal(paths.update, join(home, layout.state, "update.json"));
	}
});

test("restartDelay follows RestartSec=5, RestartSteps=5, RestartMaxDelaySec=300", () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => Math.round(restartDelay(n) / 10) / 100), [5, 11.34, 25.72, 58.33, 132.28, 300, 300]);
});

test("decideRestart: the supervisor's on-failure, exit-78 and start-limit rules", () => {
	const now = 10_000_000;
	const exit = (code: number | null, requested = false) => ({ code, signal: code === null ? "SIGTERM" : null, requested });
	assert.deepEqual(decideRestart("parent", { starts: [now - 1000], restarts: 0 }, exit(1), now), { action: "restart", delayMs: 5000 });
	assert.deepEqual(decideRestart("parent", { starts: [now - 1000], restarts: 2 }, exit(1), now), { action: "restart", delayMs: restartDelay(3) });
	assert.deepEqual(decideRestart("parent", { starts: [now], restarts: 0 }, exit(78), now), { action: "failed", result: "exit-code" });
	const six = [0, 1, 2, 3, 4, 5].map((i) => now - i * 60_000);
	assert.deepEqual(decideRestart("parent", { starts: six, restarts: 5 }, exit(1), now), { action: "failed", result: "start-limit-hit" });
	// Starts older than 1800 s no longer count.
	assert.equal(decideRestart("parent", { starts: six.map((at) => at - 1_800_000), restarts: 5 }, exit(1), now).action, "restart");
	assert.deepEqual(decideRestart("parent", { starts: [now], restarts: 0 }, exit(0), now), { action: "stopped" });
	assert.deepEqual(decideRestart("parent", { starts: [now], restarts: 0 }, exit(null, true), now), { action: "stopped" });
	// Someone else's SIGKILL is a failure.
	assert.equal(decideRestart("parent", { starts: [now], restarts: 0 }, { code: null, signal: "SIGKILL", requested: false }, now).action, "restart");
	// A manual start resets n (restarts: 0) but not the window: five earlier starts plus the manual one still hit the limit.
	assert.deepEqual(decideRestart("parent", { starts: six, restarts: 0 }, exit(1), now), { action: "failed", result: "start-limit-hit" });
});

test("decideRestart: the viewer restarts after 10 s on any exit, never limited, none while held", () => {
	const many = Array.from({ length: 50 }, (_, i) => i);
	for (const code of [0, 1, 78, null]) assert.deepEqual(decideRestart("viewer", { starts: many, restarts: 49 }, { code, signal: null, requested: false }, 100), { action: "restart", delayMs: 10_000 });
	assert.deepEqual(decideRestart("viewer", { starts: [], restarts: 0, held: true }, { code: null, signal: "SIGTERM", requested: false }, 0), { action: "stopped" });
	assert.deepEqual(decideRestart("viewer", { starts: [], restarts: 0 }, { code: null, signal: "SIGTERM", requested: true }, 0), { action: "stopped" });
});

/** The `Environment=` pairs and `ExecStart=` words of a rendered unit, systemd escapes undone. */
function parseUnit(text: string): { env: Record<string, string>; argv: string[] } {
	const words = (line: string, exec: boolean): string[] =>
		[...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => {
			const value = (m[1] as string).replace(/\\(.)/g, "$1").replace(/%%/g, "%");
			return exec ? value.replace(/\$\$/g, "$") : value;
		});
	const env: Record<string, string> = {};
	let argv: string[] = [];
	for (const line of text.split("\n")) {
		if (line.startsWith("Environment=")) {
			const [pair] = words(line, false);
			const at = (pair as string).indexOf("=");
			env[(pair as string).slice(0, at)] = (pair as string).slice(at + 1);
		} else if (line.startsWith("ExecStart=")) argv = words(line, true);
	}
	return { env, argv };
}

test("childEnv/childArgv equal the legacy units' Environment=/ExecStart= words, and leak nothing from the shell", () => {
	const unitFor = { parent: "cp-parent.service", viewer: "cp-view.service", health: "cp-health.service", update: "cp-update.service" } as const;
	const base = { HOME: "/home/u", USER: "u", LOGNAME: "u" };
	for (const extra of [{}, { viewerHost: "100.64.0.7", parentModel: "anthropic/claude-x 100%$" }]) {
		const input = { node: "/opt/node/bin/node", app: "/srv/app", home: "/home/u/.pi-command-post", path: "/usr/bin:/home/u/.fnm/fnm_multishells/1/bin:/bin", port: 7300, ...extra };
		const units = renderUnits(input);
		const config: DaemonConfig = {
			schema_version: 1,
			generated_by: "cp-install",
			backend: "detached",
			node: input.node,
			app: input.app,
			home: input.home,
			path: unitPath(input.node, input.path),
			port: input.port,
			...("viewerHost" in extra ? { viewer_host: extra.viewerHost, parent_model: extra.parentModel } : {}),
		};
		for (const role of ["parent", "viewer", "health", "update"] as const) {
			const unit = parseUnit(units[unitFor[role]] as string);
			const env = childEnv(config, role, { ...base });
			const { HOME, USER, LOGNAME, CP_DAEMON_ROLE, CP_DAEMON_JOB, ...rest } = env;
			assert.deepEqual(rest, unit.env, `${role} env`);
			assert.deepEqual({ HOME, USER, LOGNAME }, base);
			assert.equal(CP_DAEMON_ROLE, role === "viewer" ? "viewer" : undefined);
			assert.equal(CP_DAEMON_JOB, role === "health" || role === "update" ? role : undefined);
			assert.deepEqual(childArgv(config, role), unit.argv, `${role} argv`);
		}
	}
	const config = validateDaemonConfig({ schema_version: 1, generated_by: "cp-install", backend: "detached", node: "/n", app: "/a", home: "/h", path: "/bin", port: 1 });
	const leaked = childEnv(config, "parent", { HOME: "/home/u" });
	assert.equal("ANTHROPIC_API_KEY" in leaked, false);
});

test("U3: XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS (what the user manager gave the legacy units) reach every role when the outer has them; nothing else ambient does", () => {
	const config = validateDaemonConfig({ schema_version: 1, generated_by: "cp-install", backend: "systemd", node: "/n", app: "/a", home: "/h", path: "/bin", port: 1 });
	const session = { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
	const outer = { HOME: "/home/u", USER: "u", LOGNAME: "u", ...session, ANTHROPIC_API_KEY: "sk-ambient", SSH_AUTH_SOCK: "/tmp/agent", PATH: "/shell/path" };
	assert.deepEqual(baseEnv(outer), { HOME: "/home/u", USER: "u", LOGNAME: "u", ...session });
	for (const role of ["parent", "viewer", "health", "update"] as const) {
		const env = childEnv(config, role, baseEnv(outer));
		assert.equal(env.XDG_RUNTIME_DIR, session.XDG_RUNTIME_DIR, `${role}: XDG_RUNTIME_DIR`);
		assert.equal(env.DBUS_SESSION_BUS_ADDRESS, session.DBUS_SESSION_BUS_ADDRESS, `${role}: DBUS_SESSION_BUS_ADDRESS`);
		for (const key of ["ANTHROPIC_API_KEY", "SSH_AUTH_SOCK"]) assert.equal(key in env, false, `${role}: ${key} never passes`);
		assert.equal(env.PATH, "/bin", `${role}: PATH is the config's, not the shell's`);
	}
	const bare = childEnv(config, "parent", baseEnv({ HOME: "/home/u" }));
	assert.ok(!("XDG_RUNTIME_DIR" in bare) && !("DBUS_SESSION_BUS_ADDRESS" in bare), "unset in the outer (a detached machine): absent, never empty");
});

test("validateDaemonConfig names the bad field", () => {
	const good = { schema_version: 1, generated_by: "cp-install", backend: "detached", node: "/n", app: "/a", home: "/h", path: "/bin", port: 7300 };
	assert.equal(validateDaemonConfig(good).port, 7300);
	for (const [field, value] of [["backend", "launchd"], ["node", "node"], ["port", 0], ["schema_version", 2], ["path", ""], ["viewer_host", ""]] as const) {
		assert.throws(() => validateDaemonConfig({ ...good, [field]: value }), new RegExp(`field ${field}:`));
	}
	assert.throws(() => validateDaemonConfig([]), /not an object/);
});

test("frames round-trip, a partial line stays buffered, a bad one is an Error", () => {
	const text = encodeFrame({ id: "1", op: "status" }) + encodeFrame({ id: "2", ok: true }) + "{\"id\":";
	const { frames, rest } = decodeFrames(text);
	assert.deepEqual(frames, [{ id: "1", op: "status" }, { id: "2", ok: true }]);
	assert.equal(rest, "{\"id\":");
	assert.ok(decodeFrames("nope\n").frames[0] instanceof Error);
});

test("the outer and inner import only node:* and ./daemon-*.ts, statically, and OUTER_SOURCES is daemon.ts's whole closure", () => {
	const importsOf = (name: string): string[] => {
		const source = readFileSync(join(SERVICE, name), "utf8");
		assert.doesNotMatch(source, /\bimport\s*\(/, `${name} uses a dynamic import`);
		return [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1] as string);
	};
	const closure = new Set<string>();
	const visit = (name: string): void => {
		if (closure.has(name)) return;
		closure.add(name);
		for (const spec of importsOf(name)) {
			if (spec.startsWith("node:")) continue;
			assert.match(spec, /^\.\/daemon(?:-[a-z]+)?\.ts$/, `${name} imports ${spec}`);
			visit(spec.slice(2));
		}
	};
	visit("daemon.ts");
	assert.deepEqual([...closure].sort(), [...OUTER_SOURCES].sort());
	for (const spec of importsOf("daemon-runtime.ts")) assert.ok(spec.startsWith("node:") || spec === "./daemon-files.ts", `daemon-runtime.ts imports ${spec}`);
});

test("outer_hash covers every outer source: changing any one of them changes it", () => {
	const dir = mkdtempSync(join(tmpdir(), "cp-daemon-hash-"));
	try {
		for (const name of OUTER_SOURCES) writeFileSync(join(dir, name), readFileSync(join(SERVICE, name)));
		const original = outerHash(dir);
		assert.equal(original, outerHash(SERVICE));
		for (const name of OUTER_SOURCES) {
			const path = join(dir, name);
			const text = readFileSync(path, "utf8");
			writeFileSync(path, `${text}// changed\n`);
			assert.notEqual(outerHash(dir), original, name);
			writeFileSync(path, text);
		}
		assert.equal(outerHash(dir), original);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rebootCommand is one quoted command; rotateLog caps the log", () => {
	assert.equal(rebootCommand({ node: "/opt/n/bin/node", app: "/srv/app", home: "/home/u/.pi-command-post" }), '"/opt/n/bin/node" "/srv/app/src/service/daemon.ts" start --home "/home/u/.pi-command-post"');
	assert.equal(rebootCommand({ node: "/n", app: "/a$b", home: '/h"q' }), '"/n" "/a\\$b/src/service/daemon.ts" start --home "/h\\"q"');
	const dir = mkdtempSync(join(tmpdir(), "cp-daemon-log-"));
	try {
		const log = join(dir, "daemon.log");
		const prev = join(dir, "daemon.prev.log");
		writeFileSync(log, "x".repeat(100));
		assert.equal(rotateLog(log, prev, 200), false);
		writeFileSync(log, "y".repeat(300));
		assert.equal(rotateLog(log, prev, 200), true);
		assert.equal(readFileSync(log, "utf8"), "");
		assert.equal(readFileSync(prev, "utf8").length, 300);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
