/**
 * Remote dashboard PR 2d (T5): `cp-tunnel` with fake ports — no cloudflared, no tunnel, no daemon, no terminal. A fake
 * controller writes the runtime record and a fake viewer answers the owner-socket ack whenever the CLI sleeps.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initPush } from "../src/push/keys.ts";
import { atomicWrite, daemonPaths } from "../src/service/daemon-files.ts";
import { readTunnelConfig, type TunnelRuntime, tunnelConfigFile, tunnelRuntimeFile } from "../src/service/daemon-tunnel-files.ts";
import { cli, type TunnelCliPorts, UP_WAIT_MS } from "../src/tunnel/cli.ts";
import type { DeviceControlReply } from "../src/viewer/device-control.ts";
import { pushConfigFile, vapidKeyFile } from "../src/viewer/push-files.ts";
import { createScratchHome } from "./harness/index.ts";

const QUICK = "https://amber-otter.trycloudflare.com";
const TOKEN = "eyJhIjoic2VjcmV0LXR1bm5lbC10b2tlbiJ9";

type Rig = ReturnType<typeof rig>;

function rig(t: import("node:test").TestContext, options: { daemon?: boolean; running?: boolean; tty?: boolean; answer?: string; viewerLags?: number } = {}) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const paths = daemonPaths(home);
	mkdirSync(paths.dataDir, { recursive: true });
	mkdirSync(paths.stateDir, { recursive: true });
	if (options.daemon !== false) atomicWrite(paths.config, { schema_version: 1, generated_by: "cp-install", backend: "detached", node: "/usr/bin/node", app: "/opt/app", home, path: "/usr/bin", port: 8766 });
	const out: string[] = [], err: string[] = [], calls: string[] = [], shown: string[] = [], asked: string[] = [];
	const world = { clock: 0, running: options.running !== false, generation: 0, ack: { running: false, origin: null as string | null, generation: null as number | null, revision: null as number | null }, viewerLags: options.viewerLags ?? 0, origin: QUICK, starts: 0, startCode: 0 };
	/** One controller tick and one viewer check: apply the saved config the way cp-daemon and the viewer would. */
	const tick = () => {
		if (!world.running) return;
		const read = readTunnelConfig(paths.dataDir);
		if (!read.ok || !read.config) return;
		const config = read.config;
		if (!config.enabled) {
			atomicWrite(tunnelRuntimeFile(paths.stateDir), { schema_version: 1, origin: null, generation: world.generation, revision: config.revision, state: "stopped", mode: config.mode, port: config.port, updated_at: "" } satisfies TunnelRuntime);
			world.ack = { running: false, origin: null, generation: null, revision: null };
			return;
		}
		world.generation += 1;
		const origin = config.mode === "named" ? `https://${config.hostname}` : world.origin;
		atomicWrite(tunnelRuntimeFile(paths.stateDir), { schema_version: 1, origin, generation: world.generation, revision: config.revision, state: "running", mode: config.mode, port: config.port, pid: 4242, binary: config.binary, argv: ["tunnel", "run"], updated_at: "" } satisfies TunnelRuntime);
		if (world.viewerLags > 0) world.viewerLags -= 1;
		else world.ack = { running: true, origin, generation: world.generation, revision: config.revision };
	};
	const ports: TunnelCliPorts = {
		env: {},
		out: (line) => void out.push(line),
		err: (line) => void err.push(line),
		now: () => world.clock,
		sleep: async (ms) => {
			world.clock += ms;
			tick();
		},
		provision: async (binDir) => (calls.push(`provision ${binDir}`), { ok: true, path: "/opt/cf/cloudflared", source: "installed", version: "2026.3.0" }),
		control: async (_stateDir, op, args = {}): Promise<DeviceControlReply> => {
			calls.push(`control ${op} ${JSON.stringify(args)}`);
			if (op === "status") return { ok: true, result: { pid: 1, ...world.ack, port: null } };
			if (op === "pair") return world.ack.running ? { ok: true, result: { link: `${world.ack.origin}/pair#SECRETCODE`, level: args.level, expires_at: "2026-05-01T00:05:00Z" } } : { ok: false, status: 409, error: "the remote listener is not open" };
			if (op === "list") return { ok: true, result: { devices: [{ id: "dev-1", name: "Phone", level: "view", created_at: "c", last_seen_at: "s", revoked_at: null }], events: [], pending_codes: 1 } };
			if (op === "revoke") return args.target === "Phone" ? { ok: true, result: { id: "dev-1", name: "Phone", revoked_at: "r", audit_error: null, cleanup_error: "push cleanup failed" } } : { ok: false, status: 404, error: `no device ${args.target}` };
			return { ok: false, status: 400, error: "unknown op" };
		},
		daemonRunning: () => world.running,
		startDaemon: () => {
			world.starts += 1;
			world.running = world.startCode === 0;
			return world.startCode;
		},
		tty: () => (options.tty === false ? "no controlling terminal (/dev/tty: ENXIO)" : (link) => (shown.push(link), { ok: true })),
		ask: (question) => (asked.push(question), options.answer),
	};
	const run = (...argv: string[]) => cli([...argv, "--home", home], ports);
	const config = () => readTunnelConfig(paths.dataDir);
	const saved = () => {
		const read = config();
		assert.ok(read.ok, JSON.stringify(read));
		return read.config;
	};
	/** Nothing that reaches stdout, stderr or a saved file may carry the token or the pairing code. */
	const noSecrets = () => {
		const files = [tunnelConfigFile(paths.dataDir), tunnelRuntimeFile(paths.stateDir)].filter(existsSync).map((file) => readFileSync(file, "utf8"));
		for (const text of [...out, ...err, ...calls, ...files]) {
			assert.ok(!text.includes(TOKEN) && !text.includes("SECRETCODE"), text);
			assert.doesNotMatch(text, /\bsudo\b/);
		}
	};
	return { home, paths, ports, out, err, calls, shown, asked, world, run, config, saved, noSecrets, tick };
}

const pairs = (r: Rig) => r.calls.filter((call) => call.startsWith("control pair"));

test("argument refusals: usage on stderr with exit 2, and nothing is written", async (t) => {
	const r = rig(t);
	for (const argv of [[], ["launch"], ["pair", "--hostname", "x.example.com"], ["devices", "--level", "view"], ["revoke"], ["status", "extra"], ["up", "--level", "admin"], ["up", "--push-origin", "maybe"], ["up", "--bogus"]]) {
		r.err.length = 0;
		assert.equal(await r.run(...argv), 2, argv.join(" "));
		assert.match(r.err.join("\n"), /usage: cp-tunnel up/, argv.join(" "));
	}
	assert.equal(await cli(["status"], r.ports), 2, "no --home and no CP_HOME");
	assert.deepEqual(r.config(), { ok: true, config: null });
	assert.deepEqual(r.calls, []);
});

test("quick up: provisions, writes revision 1, succeeds only once the controller and the viewer ack agree, then pairs on the terminal", async (t) => {
	const r = rig(t, { viewerLags: 3 });
	assert.equal(await r.run("up"), 0, r.err.join("\n"));
	const saved = r.config();
	assert.deepEqual(saved, { ok: true, config: { schema_version: 1, enabled: true, mode: "quick", port: 8767, binary: "/opt/cf/cloudflared", revision: 1 } });
	assert.equal(statSync(tunnelConfigFile(r.paths.dataDir)).mode & 0o777, 0o600);
	assert.deepEqual(r.out, [`${QUICK}`], "stdout is the origin alone");
	const statusPolls = r.calls.filter((call) => call.startsWith("control status")).length;
	assert.ok(statusPolls >= 4, `kept waiting while the viewer lagged (${statusPolls} acks)`);
	assert.deepEqual(pairs(r), ['control pair {"level":"full","route":"cli-up"}']);
	assert.deepEqual(r.shown, [`${QUICK}/pair#SECRETCODE`], "the link went to the terminal display only");
	assert.match(r.err.join("\n"), /hostname changes whenever cloudflared restarts/);
	assert.match(r.err.join("\n"), /Full-control pairing link is on the terminal/);
	assert.equal(existsSync(pushConfigFile(r.paths.dataDir)), false, "quick never touches push");
	assert.deepEqual(r.asked, []);
	r.noSecrets();

	// A second up is a new revision; --level view pairs a View-only device.
	r.calls.length = 0;
	assert.equal(await r.run("up", "--level", "view"), 0, r.err.join("\n"));
	assert.equal(r.saved()?.revision, 2);
	assert.deepEqual(pairs(r), ['control pair {"level":"view","route":"cli-up"}']);
});

test("readiness: a running child whose origin the viewer never acknowledges is a failure, and no pairing code is issued", async (t) => {
	const r = rig(t, { viewerLags: Number.MAX_SAFE_INTEGER });
	assert.equal(await r.run("up", "--quick"), 1);
	assert.match(r.err.join("\n"), new RegExp(`not ready within ${UP_WAIT_MS / 1000}s: the viewer has not opened the remote listener for this origin yet`));
	assert.match(r.err.join("\n"), /stays enabled .* cp-tunnel down turns it off/);
	assert.ok(r.world.clock >= UP_WAIT_MS, "it waited the whole bound");
	assert.deepEqual(r.out, []);
	assert.deepEqual(pairs(r), []);
});

test("an ack for an older revision or generation does not count", async (t) => {
	const r = rig(t);
	await r.run("up");
	// The viewer is stuck on revision 1 / its generation while the controller applies revision 2.
	r.world.viewerLags = Number.MAX_SAFE_INTEGER;
	r.err.length = 0;
	assert.equal(await r.run("up"), 1);
	assert.match(r.err.join("\n"), /the viewer has not opened the remote listener for this origin yet/);
});

test("a stopped cp-daemon is started; a failed start is named and leaves the tunnel enabled", async (t) => {
	const r = rig(t, { running: false });
	assert.equal(await r.run("up"), 0, r.err.join("\n"));
	assert.equal(r.world.starts, 1);
	assert.match(r.err.join("\n"), /cp-daemon is not running; starting it/);

	const failed = rig(t, { running: false });
	failed.world.startCode = 1;
	assert.equal(await failed.run("up"), 1);
	assert.match(failed.err.join("\n"), /cp-daemon did not start; the tunnel is enabled and starts with it/);
	assert.equal(failed.saved()?.enabled, true);
});

test("refusals before anything is written: no cp-daemon config, bad flags, an unusable cloudflared, a held lock", async (t) => {
	const none = rig(t, { daemon: false });
	assert.equal(await none.run("up"), 1);
	assert.match(none.err.join("\n"), /run cp-install first/);

	const r = rig(t);
	const cases: Array<[string[], RegExp]> = [
		[["up", "--quick", "--hostname", "cp.example.com"], /--quick takes no --hostname/],
		[["up", "--quick", "--push-origin", "accept"], /push is never pointed at it/],
		[["up", "--hostname", "not a host"], /needs --hostname HOST/],
		[["up", "--hostname", "cp.example.com"], /needs --token-file FILE/],
		[["up", "--remote-port", "8766"], /the local dashboard's port/],
		[["up", "--remote-port", "80"], /--remote-port must be 1024-65535/],
		[["up", "--hostname", "cp.example.com", "--token-file", "/nonexistent/token"], /cannot read --token-file: ENOENT/],
		[["down"], /no tunnel is configured/],
	];
	for (const [argv, refusal] of cases) {
		r.err.length = 0;
		assert.equal(await r.run(...argv), 1, argv.join(" "));
		assert.match(r.err.join("\n"), refusal, argv.join(" "));
	}
	assert.deepEqual(r.config(), { ok: true, config: null });
	assert.deepEqual(r.calls, []);

	r.ports.provision = async () => ({ ok: false, reason: "sha256 mismatch for cloudflared-linux-amd64" });
	assert.equal(await r.run("up"), 1);
	assert.match(r.err.join("\n"), /no usable cloudflared: sha256 mismatch/);
	assert.deepEqual(r.config(), { ok: true, config: null }, "a refused binary writes no config");

	const locked = rig(t);
	writeFileSync(join(locked.paths.dataDir, "tunnel.lock"), `${process.pid}\n`);
	assert.equal(await locked.run("up"), 1);
	assert.match(locked.err.join("\n"), new RegExp(`cp-tunnel pid ${process.pid} is changing the tunnel`));
	assert.deepEqual(locked.config(), { ok: true, config: null });
});

test("named up: the token is stored 0600 and travels only as a path; without a terminal push consent keeps the config and key bytes", async (t) => {
	const r = rig(t);
	const tokenFile = join(r.home, "given-token");
	writeFileSync(tokenFile, `${TOKEN}\n`);
	initPush({ dataDir: r.paths.dataDir, origin: "https://old.example.com" });
	const pushBytes = readFileSync(pushConfigFile(r.paths.dataDir));
	const keyBytes = readFileSync(vapidKeyFile(r.paths.dataDir));

	assert.equal(await r.run("up", "--hostname", "CP.Example.com", "--token-file", tokenFile), 0, r.err.join("\n"));
	const stored = join(r.paths.dataDir, "tunnel", "token");
	assert.deepEqual(r.config(), { ok: true, config: { schema_version: 1, enabled: true, mode: "named", port: 8767, binary: "/opt/cf/cloudflared", hostname: "cp.example.com", token_file: stored, revision: 1 } });
	assert.equal(readFileSync(stored, "utf8"), TOKEN);
	assert.equal(statSync(stored).mode & 0o777, 0o600);
	assert.deepEqual(r.out, ["https://cp.example.com"]);
	assert.equal(r.asked.length, 1, "asked once at the terminal");
	assert.match(r.asked[0]!, /Switch them to https:\/\/cp\.example\.com\? The keys stay/);
	assert.match(r.err.join("\n"), /push kept on https:\/\/old\.example\.com; cp-tunnel up --push-origin accept/);
	assert.deepEqual(readFileSync(pushConfigFile(r.paths.dataDir)), pushBytes, "config bytes unchanged");
	assert.deepEqual(readFileSync(vapidKeyFile(r.paths.dataDir)), keyBytes, "key bytes unchanged");
	r.noSecrets();

	// --push-origin keep never asks; bare up keeps the named mode, hostname and stored token.
	r.asked.length = 0;
	assert.equal(await r.run("up", "--push-origin", "keep"), 0, r.err.join("\n"));
	assert.deepEqual(r.asked, []);
	assert.equal(r.saved()?.token_file, stored);
	assert.deepEqual(readFileSync(pushConfigFile(r.paths.dataDir)), pushBytes);
});

test("named push consent accept (flag or a typed y) moves push to the tunnel origin and never rotates the keys", async (t) => {
	for (const how of ["flag", "typed"] as const) {
		const r = rig(t, how === "typed" ? { answer: "y" } : {});
		const tokenFile = join(r.home, "given-token");
		writeFileSync(tokenFile, TOKEN);
		initPush({ dataDir: r.paths.dataDir, origin: "https://old.example.com" });
		const before = JSON.parse(readFileSync(pushConfigFile(r.paths.dataDir), "utf8")) as Record<string, unknown>;
		const keyBytes = readFileSync(vapidKeyFile(r.paths.dataDir));
		const argv = ["up", "--hostname", "cp.example.com", "--token-file", tokenFile, ...(how === "flag" ? ["--push-origin", "accept"] : [])];
		assert.equal(await r.run(...argv), 0, r.err.join("\n"));
		const after = JSON.parse(readFileSync(pushConfigFile(r.paths.dataDir), "utf8")) as Record<string, unknown>;
		assert.equal(after.origin, "https://cp.example.com", how);
		assert.equal(after.public_key, before.public_key, `${how}: same public key`);
		assert.deepEqual(readFileSync(vapidKeyFile(r.paths.dataDir)), keyBytes, `${how}: key bytes unchanged`);
		assert.match(r.err.join("\n"), /push now uses https:\/\/cp\.example\.com \(keys kept\)/, how);
		assert.equal(r.asked.length, how === "flag" ? 0 : 1);
		r.noSecrets();
	}
});

test("pairing is terminal-only: without a terminal no code is issued; pair, devices, revoke and status go through the owner socket", async (t) => {
	const r = rig(t, { tty: false });
	assert.equal(await r.run("up"), 1, "the tunnel is up but the pairing display is refused");
	assert.deepEqual(r.out, [QUICK]);
	assert.match(r.err.join("\n"), /pairing display refused: no controlling terminal .* run cp-tunnel pair from an interactive terminal/);
	assert.deepEqual(pairs(r), [], "no code is issued without a display");

	r.ports.tty = () => (link) => (r.shown.push(link), { ok: true });
	assert.equal(await r.run("pair", "--level", "view"), 0, r.err.join("\n"));
	assert.deepEqual(pairs(r), ['control pair {"level":"view","route":"cli-pair"}']);
	assert.equal(r.shown.length, 1);

	r.out.length = 0;
	assert.equal(await r.run("devices"), 0);
	assert.deepEqual(r.out, ['dev-1  "Phone"  view  created c  last seen s  active', "1 unclaimed pairing code(s)"]);

	r.out.length = 0;
	r.err.length = 0;
	assert.equal(await r.run("revoke", "Phone"), 0);
	assert.deepEqual(r.out, ['revoked dev-1 "Phone" at r']);
	assert.match(r.err.join("\n"), /the device is revoked, but: push cleanup failed/);
	assert.equal(await r.run("revoke", "Tablet"), 1);
	assert.match(r.err.join("\n"), /cp-tunnel revoke: no device Tablet/);

	r.out.length = 0;
	assert.equal(await r.run("status"), 0);
	assert.deepEqual(r.out, [
		"config: enabled, quick, port 8767, revision 1",
		`cloudflared: running pid 4242, origin ${QUICK}, generation ${r.world.generation}, revision 1`,
		`viewer: remote listener open for ${QUICK} (generation ${r.world.generation}, revision 1)`,
	]);
	r.noSecrets();
});

test("down: a disabled revision, success only once cloudflared exited and the listener closed; a stopped daemon is not started", async (t) => {
	const r = rig(t);
	await r.run("up");
	r.out.length = 0;
	assert.equal(await r.run("down"), 0, r.err.join("\n"));
	assert.deepEqual(r.config(), { ok: true, config: { schema_version: 1, enabled: false, mode: "quick", port: 8767, binary: "/opt/cf/cloudflared", revision: 2 } });
	assert.match(r.out.join("\n"), /tunnel down: cloudflared exited and the remote listener is closed; the local dashboard is unchanged/);
	assert.equal(r.world.ack.running, false);

	r.world.running = false;
	r.out.length = 0;
	assert.equal(await r.run("down"), 0);
	assert.equal(r.saved()?.revision, 3);
	assert.match(r.out.join("\n"), /cp-daemon is not running, so it stays off/);
	assert.equal(r.world.starts, 0);

	r.out.length = 0;
	assert.equal(await r.run("status"), 0);
	assert.equal(r.out[0], "config: disabled, quick, port 8767, revision 3");
});
