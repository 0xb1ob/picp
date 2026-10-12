/**
 * Remote dashboard PR 2d: the viewer's remote runtime. Inert on a home without the feature; once configured it owns the
 * device socket, opens the remote listener only for the controller's matching running revision, acknowledges readiness
 * on the owner socket, and closes the listener when the tunnel stops or its binding changes. Loopback only, no tunnel.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import type { TunnelConfig, TunnelConfigRead, TunnelRuntime, TunnelRuntimeRead } from "../src/service/daemon-tunnel-files.ts";
import { appPage } from "../src/viewer/app-page.ts";
import { deviceControlDir, deviceControlRequest } from "../src/viewer/device-control.ts";
import { remoteRuntime, wantedListener } from "../src/viewer/remote-runtime.ts";
import { createViewer } from "../src/viewer/server.ts";
import { createScratchHome } from "./harness/index.ts";
import { call } from "./harness/remote.ts";

const freePort = (): Promise<number> =>
	new Promise((done) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => done(port));
		});
	});

const ORIGIN = "https://amber-otter.trycloudflare.com";
const config = (port: number, revision = 1): TunnelConfig => ({ schema_version: 1, enabled: true, mode: "quick", port, binary: "/opt/cf/cloudflared", revision });
const running = (port: number, revision = 1, generation = 1, origin = ORIGIN): TunnelRuntime => ({ schema_version: 1, origin, generation, revision, state: "running", mode: "quick", port, updated_at: "" });

async function rig(t: import("node:test").TestContext, configured = true) {
	const home = createScratchHome();
	const stateDir = join(home.path, LAYOUT.state);
	const port = await freePort();
	const files: { config: TunnelConfigRead; runtime: TunnelRuntimeRead } = { config: { ok: true, config: config(port) }, runtime: { ok: true, runtime: running(port) } };
	const lines: string[] = [];
	let controls = 0;
	const runtime = remoteRuntime(
		{ home: home.path, stateDir, host: "127.0.0.1", port: 1, requireTailnet: true },
		{
			configured: () => configured,
			readConfig: () => files.config,
			readRuntime: () => files.runtime,
			log: (line) => void lines.push(line),
			...(configured ? {} : { startControl: async () => ((controls += 1), { state: "refused" as const, reason: "never" }) }),
		},
	);
	t.after(() => {
		runtime.stop();
		home.cleanup();
	});
	const status = async () => {
		const reply = await deviceControlRequest(stateDir, "status");
		assert.ok(reply.ok, JSON.stringify(reply));
		return reply.result as Record<string, unknown>;
	};
	return { home: home.path, stateDir, port, files, runtime, lines, status, controls: () => controls, pair: () => call(port, "/pair") };
}

test("off by default: a home without the remote feature gets no store, no socket and no listener", async (t) => {
	const r = await rig(t, false);
	await r.runtime.check();
	await r.runtime.check();
	assert.equal(r.controls(), 0, "the owner socket is never even attempted");
	assert.equal(existsSync(deviceControlDir(r.stateDir)), false);
	assert.equal(r.runtime.listening(), null);
	assert.equal(r.runtime.routes(), undefined, "no device routes: the local listener answers 404 as before");
	await assert.rejects(r.pair(), /ECONNREFUSED/);
	assert.deepEqual(r.lines, []);
});

test("the listener opens only for the controller's running, matching revision and acknowledges it on the owner socket", async (t) => {
	const r = await rig(t);
	r.files.runtime = { ok: true, runtime: running(r.port, 2) };
	await r.runtime.check();
	assert.equal(r.runtime.listening(), null, "the controller answers another revision");
	assert.deepEqual(await r.status(), { pid: process.pid, running: false, origin: null, generation: null, revision: null, port: null });
	await assert.rejects(r.pair(), /ECONNREFUSED/);

	r.files.runtime = { ok: true, runtime: running(r.port) };
	await r.runtime.check();
	assert.deepEqual(await r.status(), { pid: process.pid, running: true, origin: ORIGIN, generation: 1, revision: 1, port: r.port });
	assert.equal((await r.pair()).status, 200, "the remote gate answers on 127.0.0.1:<port>");
	assert.match(r.lines.join(""), new RegExp(`listening on 127\\.0\\.0\\.1:${r.port} for ${ORIGIN}`));

	// A revision-only change (cp-tunnel up with the same settings) is acknowledged in place.
	r.files.config = { ok: true, config: config(r.port, 2) };
	r.files.runtime = { ok: true, runtime: running(r.port, 2) };
	await r.runtime.check();
	assert.equal((await r.status()).revision, 2);
	assert.equal(r.lines.filter((line) => line.includes("listening on")).length, 1, "not reopened");
});

test("the local listener's device routes follow the store owner: 404 before, then the list with Add for a loopback peer", async (t) => {
	const r = await rig(t);
	const port = await freePort();
	const local = createViewer({ home: r.home, stateDir: r.stateDir, host: "127.0.0.1", port, get devices() { return r.runtime.routes(); } });
	await new Promise<void>((done) => local.listen(port, "127.0.0.1", done));
	t.after(() => local.close());
	const devices = () => fetch(`http://127.0.0.1:${port}/api/devices`);
	assert.equal((await devices()).status, 404, "not the owner yet: exactly as before");
	await r.runtime.check();
	const listed = await devices();
	assert.equal(listed.status, 200);
	const body = await listed.json() as { can_create: boolean; can_revoke: boolean; origin: string | null; token: string | null };
	assert.deepEqual([body.can_create, body.can_revoke, body.origin, typeof body.token], [true, true, ORIGIN, "string"]);
});

test("a new generation reopens the listener; a stopped tunnel, a disabled or unreadable config closes it", async (t) => {
	const r = await rig(t);
	await r.runtime.check();
	assert.equal((await r.pair()).status, 200);
	r.files.runtime = { ok: true, runtime: running(r.port, 1, 2, "https://other-name.trycloudflare.com") };
	await r.runtime.check();
	assert.deepEqual([(await r.status()).origin, (await r.status()).generation], ["https://other-name.trycloudflare.com", 2]);
	assert.match(r.lines.join(""), /closed 127\.0\.0\.1:\d+ \(now https:\/\/other-name\.trycloudflare\.com generation 2/);

	for (const [why, change] of [
		["stopped", () => (r.files.runtime = { ok: true, runtime: { ...running(r.port), state: "stopped" } })],
		["disabled", () => (r.files.config = { ok: true, config: { ...config(r.port), enabled: false } })],
		["unreadable", () => (r.files.config = { ok: false, reason: "data/tunnel.json: not JSON" })],
	] as const) {
		r.files.config = { ok: true, config: config(r.port) };
		r.files.runtime = { ok: true, runtime: running(r.port) };
		await r.runtime.check();
		assert.equal((await r.status()).running, true, why);
		change();
		await r.runtime.check();
		assert.equal(r.runtime.listening(), null, why);
		assert.equal((await r.status()).running, false, why);
		await assert.rejects(r.pair(), /ECONNREFUSED/, why);
	}
});

test("wantedListener needs every part to agree; only the quick listener's page asks the app to poll", () => {
	const quick = config(8767);
	assert.deepEqual(wantedListener({ ok: true, config: quick }, { ok: true, runtime: running(8767) }), { origin: ORIGIN, generation: 1, revision: 1, port: 8767, mode: "quick" });
	for (const runtime of [{ ...running(8767), port: 8800 }, { ...running(8767), mode: "named" as const }, { ...running(8767), origin: null }, { ...running(8767), state: "starting" as const }]) {
		assert.equal(wantedListener({ ok: true, config: quick }, { ok: true, runtime }), null, JSON.stringify(runtime));
	}
	assert.equal(wantedListener({ ok: true, config: quick }, { ok: false, reason: "x" }), null);
	assert.equal(wantedListener({ ok: true, config: null }, { ok: true, runtime: running(8767) }), null);
	const app = { script: "/assets/viewer/a.js", stylesheet: "/assets/viewer/a.css", assets: {}, duration_ms: 0, bytes: 0 };
	assert.doesNotMatch(appPage(app), /cp-refresh/, "the default document carries no remote boot metadata");
	assert.equal(appPage(app, "poll"), appPage(app).replace("<title>", '<meta name="cp-refresh" content="poll"><title>'));
});
