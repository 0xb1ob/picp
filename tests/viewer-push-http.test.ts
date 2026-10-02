import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { initPush } from "../src/push/keys.ts";
import { APP_COLORS } from "../src/viewer/app-manifest.ts";
import { APP_CSP } from "../src/viewer/app-page.ts";
import { pushDataDir, subscriptionsDir } from "../src/viewer/push-files.ts";
import { createViewer } from "../src/viewer/server.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const ORIGIN = "https://cp.example.com";

async function viewer(t: { after(fn: () => void): void }, configure = true) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(stateDir, { recursive: true });
	if (configure) initPush({ dataDir: pushDataDir(stateDir), origin: ORIGIN });
	const options = { home: home.path, stateDir, host: "127.0.0.1", port: 0, log: () => {} };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, options.host, resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
		new Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>((resolve, reject) => {
			const length: Record<string, string> = init.body === undefined || init.headers?.["transfer-encoding"] ? {} : { "content-length": String(Buffer.byteLength(init.body)) };
			const req = request({ host: "127.0.0.1", port: options.port, path, method: init.method ?? "GET", headers: { host: `127.0.0.1:${options.port}`, ...length, ...init.headers } }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
			});
			req.on("error", reject);
			req.end(init.body);
		});
	return { home, stateDir, dataDir: pushDataDir(stateDir), options, call };
}

const device = (endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString("hex")}`) => {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};
const json = { origin: ORIGIN, "content-type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = json) => ({ method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("push status exposes only the public setup; unconfigured says so", async (t) => {
	const { call, home } = await viewer(t);
	const reply = await call("/api/push");
	assert.equal(reply.status, 200);
	const status = JSON.parse(reply.body.toString());
	assert.equal(status.configured, true);
	assert.equal(status.origin, ORIGIN);
	assert.equal(Buffer.from(status.public_key, "base64url").length, 65);
	assert.equal(status.devices, 0);
	assert.equal(status.undelivered_24h, 0);
	const secret = JSON.parse(readFileSync(join(home.path, LAYOUT.data, "push", "vapid.key"), "utf8")).d as string;
	assert.doesNotMatch(reply.body.toString(), new RegExp(secret));
	assert.equal((await call("/api/push", { method: "POST" })).status, 405);
	const bare = await viewer(t, false);
	const unset = JSON.parse((await bare.call("/api/push")).body.toString());
	assert.deepEqual({ ...unset, generated_at: "" }, { generated_at: "", configured: false, origin: null, public_key: null, devices: null, last_sent_at: null, undelivered_24h: null, last_error: null });
	assert.equal((await bare.call("/api/push/subscription", post(device()))).status, 409);
});

test("subscription route: POST stores one 0600 file per device, idempotently; DELETE removes it; nothing else changes", async (t) => {
	const { call, home, dataDir, stateDir } = await viewer(t);
	const snapshot = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? snapshot(join(dir, e.name)) : [`${relative(home.path, join(dir, e.name))}:${readFileSync(join(dir, e.name)).toString("base64")}`]));
	const before = snapshot(home.path);
	const sub = device();
	const created = await call("/api/push/subscription", post(sub));
	assert.equal(created.status, 201);
	assert.deepEqual(JSON.parse(created.body.toString()), { subscribed: true, devices: 1 });
	assert.equal((await call("/api/push/subscription", post({ ...sub, expirationTime: null }))).status, 201);
	const files = readdirSync(subscriptionsDir(dataDir));
	assert.equal(files.length, 1);
	assert.equal(statSync(join(subscriptionsDir(dataDir), files[0]!)).mode & 0o777, 0o600);
	assert.equal(statSync(subscriptionsDir(dataDir)).mode & 0o777, 0o700);
	assert.deepEqual(snapshot(home.path).filter((line) => !line.startsWith(`${LAYOUT.data}/push/subscriptions/`)), before);
	assert.equal(JSON.parse((await call("/api/push")).body.toString()).devices, 1);
	assert.doesNotMatch((await call("/api/push")).body.toString(), /fcm\.googleapis|p256dh|auth/);
	const removed = await call("/api/push/subscription", { method: "DELETE", headers: json, body: JSON.stringify({ endpoint: sub.endpoint }) });
	assert.equal(removed.status, 200);
	assert.deepEqual(JSON.parse(removed.body.toString()), { unsubscribed: true });
	assert.deepEqual(readdirSync(subscriptionsDir(dataDir)), []);
	assert.deepEqual(JSON.parse((await call("/api/push/subscription", { method: "DELETE", headers: json, body: JSON.stringify({ endpoint: sub.endpoint }) })).body.toString()), { unsubscribed: false });
	assert.ok(existsSync(join(stateDir)));
});

test("subscription route refuses everything but a same-origin JSON subscription on a known push service", async (t) => {
	const { call, dataDir } = await viewer(t);
	const sub = device();
	const cases: [string, ReturnType<typeof post>, number][] = [
		["no Origin", post(sub, { "content-type": "application/json" }), 403],
		["foreign Origin", post(sub, { ...json, origin: "https://evil.example" }), 403],
		["http origin of the proxy host", post(sub, { ...json, origin: "http://cp.example.com" }), 403],
		["cross-site fetch", post(sub, { ...json, "sec-fetch-site": "cross-site" }), 403],
		["form post", post(sub, { origin: ORIGIN, "content-type": "text/plain" }), 415],
		["too large", post("x".repeat(5000)), 413],
		["too large, streamed", post("x".repeat(5000), { ...json, "transfer-encoding": "chunked" }), 413],
		["not JSON", post("{"), 400],
		["http endpoint", post({ ...sub, endpoint: "http://fcm.googleapis.com/x" }), 400],
		["unknown push service", post({ ...sub, endpoint: "https://evil.example/push" }), 400],
		["bad p256dh", post({ ...sub, keys: { ...sub.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } }), 400],
		["bad auth", post({ ...sub, keys: { ...sub.keys, auth: "short" } }), 400],
		["missing keys", post({ endpoint: sub.endpoint }), 400],
	];
	for (const [name, init, status] of cases) assert.equal((await call("/api/push/subscription", init)).status, status, name);
	for (const method of ["GET", "HEAD", "PUT", "PATCH"]) {
		const reply = await call("/api/push/subscription", { method });
		assert.equal(reply.status, 405, method);
		assert.equal(reply.headers.allow, "POST, DELETE");
	}
	assert.equal((await call("/api/push/subscription", post(sub, { ...json, "sec-fetch-site": "same-origin" }))).status, 201);
	assert.equal((await call("/api/push/subscription", post(device(), { ...json, origin: "http://127.0.0.1:1" }))).status, 403, "another loopback port");
	for (let i = 1; i < 10; i++) assert.equal((await call("/api/push/subscription", post(device()))).status, 201);
	assert.equal((await call("/api/push/subscription", post(device()))).status, 409, "11th device");
	assert.equal((await call("/api/push/subscription", post(sub))).status, 201, "a known device refreshes past the cap");
	assert.equal(readdirSync(subscriptionsDir(dataDir)).length, 10);
	assert.equal((await call("/api/awaiting", { method: "POST" })).status, 405);
});

test("the loopback bind's own origin may subscribe; a foreign Host is still refused before the route", async (t) => {
	const { call, options } = await viewer(t);
	assert.equal((await call("/api/push/subscription", post(device(), { "content-type": "application/json", origin: `http://127.0.0.1:${options.port}` }))).status, 201);
	assert.equal((await call("/api/push/subscription", { ...post(device()), headers: { ...json, host: "cp.example.com" } })).status, 421);
	assert.equal((await call("/healthz", { headers: { host: "cp.example.com" } })).status, 421);
});

test("service worker, manifest and icons: same-origin, standalone, opening Awaiting you, in the existing palette", async (t) => {
	const { call } = await viewer(t, false);
	const sw = await call("/sw.js");
	assert.equal(sw.status, 200);
	assert.equal(sw.headers["content-type"], "text/javascript; charset=utf-8");
	assert.equal(sw.headers["content-security-policy"], APP_CSP);
	assert.equal(sw.headers["cache-control"], "no-store");
	assert.match(sw.body.toString(), /notificationclick/);
	assert.match(APP_CSP, /; worker-src 'self'; manifest-src 'self'; /);
	assert.equal(APP_CSP.replace("worker-src 'self'; manifest-src 'self'; ", ""), "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; font-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
	const manifest = await call("/manifest.webmanifest");
	assert.equal(manifest.status, 200);
	assert.equal(manifest.headers["content-type"], "application/manifest+json; charset=utf-8");
	const body = JSON.parse(manifest.body.toString());
	assert.equal(body.display, "standalone");
	assert.equal(body.start_url, "/#awaiting");
	const tokens = readFileSync(join(REPO_ROOT, "viewer-app/styles/tokens.css"), "utf8");
	assert.match(tokens, new RegExp(`--background: ${APP_COLORS.background};`));
	assert.match(tokens, new RegExp(`--amber: ${APP_COLORS.accent};`));
	assert.equal(body.theme_color, APP_COLORS.background);
	assert.equal(body.background_color, APP_COLORS.background);
	const root = await call("/");
	assert.match(root.body.toString(), /<link rel="manifest" href="\/manifest.webmanifest"><link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);
	for (const [path, size] of [["/icon-192.png", 192], ["/icon-512.png", 512], ["/apple-touch-icon.png", 180]] as const) {
		const icon = await call(path);
		assert.equal(icon.status, 200, path);
		assert.equal(icon.headers["content-type"], "image/png");
		assert.deepEqual([...icon.body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		assert.equal(icon.body.readUInt32BE(16), size);
		assert.equal(icon.body.readUInt32BE(20), size);
		const idatLength = icon.body.readUInt32BE(33);
		const pixels = inflateSync(icon.body.subarray(41, 41 + idatLength));
		assert.equal(pixels.length, size * (1 + size * 3));
		const colours = new Set<string>();
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) colours.add(`#${pixels.subarray(y * (1 + size * 3) + 1 + x * 3, y * (1 + size * 3) + 4 + x * 3).toString("hex")}`);
		assert.deepEqual([...colours].sort(), [APP_COLORS.background, APP_COLORS.accent].sort(), path);
		if (body.icons.some((i: { src: string }) => i.src === path)) assert.ok(body.icons.find((i: { src: string }) => i.src === path).sizes === `${size}x${size}`);
	}
	assert.equal((await call("/icon-1.png")).status, 404);
});
