/**
 * Retained from tests/tunnel-cli.test.ts (P12b): the three `cp-tunnel` statements no entry point reaches — an older
 * revision's viewer ack, the revoke's push-cleanup error echo and a thrown fetch that echoes the API token. Fake ports.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { atomicWrite, daemonPaths } from "../src/service/daemon-files.ts";
import { readTunnelConfig, type TunnelRuntime, tunnelConfigFile, tunnelRuntimeFile } from "../src/service/daemon-tunnel-files.ts";
import { cli, type TunnelCliPorts } from "../src/tunnel/cli.ts";
import { type CfFetch, setupNamedTunnel } from "../src/tunnel/cloudflare-api.ts";
import type { DeviceControlReply } from "../src/viewer/device-control.ts";
import { createScratchHome } from "./harness/index.ts";

const QUICK = "https://amber-otter.trycloudflare.com";
const TOKEN = "eyJhIjoic2VjcmV0LXR1bm5lbC10b2tlbiJ9";
const API_TOKEN = "cfapi-SECRET-api-token-0123456789";
const HOST = "cp.lab.example.co.uk";

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
		cfFetch: async () => assert.fail("no Cloudflare API call expected"),
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

test("an ack for an older revision or generation does not count", async (t) => {
	const r = rig(t);
	await r.run("up");
	// The viewer is stuck on revision 1 / its generation while the controller applies revision 2.
	r.world.viewerLags = Number.MAX_SAFE_INTEGER;
	r.err.length = 0;
	assert.equal(await r.run("up"), 1);
	assert.match(r.err.join("\n"), /the viewer has not opened the remote listener for this origin yet/);
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

test("setupNamedTunnel redacts the API token from a failure that echoes it", async () => {
	const echo: CfFetch = async (url) => {
		throw new Error(`connect failed for ${url} with Bearer ${API_TOKEN}`);
	};
	const result = await setupNamedTunnel({ hostname: HOST, port: 8767, apiToken: API_TOKEN, tunnelName: "picp-test" }, echo, () => {});
	assert.equal(result.ok, false);
	assert.ok(!result.ok && !result.reason.includes(API_TOKEN) && result.reason.includes("Bearer [redacted]"), JSON.stringify(result));
});
