/**
 * Behavior 22 (P22): the dashboard's Web Push surface through a real `bin/cp-view` — its push routes on the local and
 * remote listeners, the service worker, manifest and icons, and More's Notifications control in the served app, with
 * the browser's push APIs staged in the tab. The push service is a stand-in behind tests/harness/fake-fetch.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as httpServer, request } from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
import { join, relative } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { LAYOUT } from "../../src/contracts.ts";
import { PushDeliveryStore, PushTestJournal } from "../../src/push/deliveries.ts";
import { initPush } from "../../src/push/keys.ts";
import { tunnelConfigFile, tunnelRuntimeFile } from "../../src/service/daemon-tunnel-files.ts";
import { APP_COLORS } from "../../src/viewer/app-manifest.ts";
import { APP_CSP } from "../../src/viewer/app-page.ts";
import { viewerConfigFile } from "../../src/viewer/host-config.ts";
import { BODY_DISCARD_IDLE_MS } from "../../src/viewer/push-api.ts";
import { listSubscriptions, pushDeliveriesFile, readPushConfig, subscriptionFile, subscriptionId, vapidKeyFile } from "../../src/viewer/push-files.ts";
import { openTab, startViewer, type Tab, until } from "../harness/dashboard.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { type TestDevice, testDevice } from "../harness/push.ts";

const ORIGIN = "https://cp.example.com";
const TUNNEL = "https://amber-otter.trycloudflare.com";
const HOOKS = ["process-clock.ts", "fake-fetch.ts"].map((file) => `--import ${pathToFileURL(join(REPO_ROOT, "tests/harness", file)).href}`).join(" ");
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; json: Record<string, unknown> };
type Init = { method?: string; headers?: Record<string, string>; body?: string };

const freePort = (): Promise<number> =>
	new Promise((done) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => done(port));
		});
	});
/** Raw bytes back; a body is sent with its length unless the caller streams it (`transfer-encoding`). */
function call(port: number, path: string, init: Init = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const length = init.body === undefined || init.headers?.["transfer-encoding"] ? {} : { "content-length": String(Buffer.byteLength(init.body)) };
		const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...length, ...init.headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const body = Buffer.concat(chunks);
				let json: Record<string, unknown> = {};
				try { json = JSON.parse(body.toString("utf8")); } catch { /* not JSON */ }
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
			});
		});
		req.on("error", reject);
		req.end(init.body);
	});
}
const device = (slug = Math.random().toString(16).slice(2)) => testDevice(`https://fcm.googleapis.com/fcm/send/${slug}`);
const wire = (sub: TestDevice) => ({ endpoint: sub.endpoint, keys: sub.keys });

/** A scratch home, push set up unless `configured: false`, a stand-in push service and a running cp-view. */
async function rig(t: TestContext, { configured = true, remote = false } = {}) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path, stateDir = join(home, LAYOUT.state), dataDir = join(home, LAYOUT.data);
	for (const dir of [stateDir, dataDir]) mkdirSync(dir, { recursive: true });
	const posts: Array<{ slug: string; body: Buffer }> = [];
	let answer: (slug: string) => { status: number; body?: string } = () => ({ status: 201 });
	const service = httpServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const slug = String(req.url).split("/").pop()!;
			posts.push({ slug, body: Buffer.concat(chunks) });
			const { status, body = "" } = answer(slug);
			res.writeHead(status).end(body);
		});
	});
	await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
	t.after(() => { service.closeAllConnections(); service.close(); });
	if (configured) initPush({ dataDir, origin: ORIGIN });
	const remotePort = await freePort();
	if (remote) {
		writeFileSync(tunnelConfigFile(dataDir), JSON.stringify({ schema_version: 1, enabled: true, mode: "quick", port: remotePort, binary: "/opt/cf/cloudflared", revision: 1 }));
		writeFileSync(tunnelRuntimeFile(stateDir), JSON.stringify({ schema_version: 1, origin: TUNNEL, generation: 1, revision: 1, state: "running", mode: "quick", port: remotePort, pid: process.pid, binary: "/opt/cf/cloudflared", argv: ["tunnel"], updated_at: new Date().toISOString() }));
	}
	const viewer = await startViewer(t, { home, env: { NODE_OPTIONS: HOOKS, CP_TEST_FETCH_BASE: `http://127.0.0.1:${(service.address() as AddressInfo).port}` } });
	if (remote) await until(viewer.output, (out) => out.includes(`listening on 127.0.0.1:${remotePort} for ${TUNNEL} (generation 1,`), `the remote listener\n${viewer.output()}`);
	const l = (path: string, init: Init = {}) => call(viewer.port, path, init);
	let peer = 0;
	const r = (path: string, init: Init = {}) => call(remotePort, path, { ...init, headers: { "cf-connecting-ip": `203.0.113.${(peer += 1)}`, ...init.headers } });
	const local = { origin: viewer.origin, "content-type": "application/json" };
	const pair = async (name: string, level = "full") => {
		const token = String((await l("/api/devices")).json.token);
		const created = await l("/api/pair/create", { method: "POST", headers: { ...local, "x-cp-control-token": token }, body: JSON.stringify({ level }) });
		assert.equal(created.status, 201, created.body.toString());
		const claimed = await r("/api/pair/claim", { method: "POST", headers: { origin: TUNNEL, "content-type": "application/json" }, body: JSON.stringify({ code: String(created.json.link).split("#")[1], name }) });
		assert.equal(claimed.status, 200, claimed.body.toString());
		const cookie = String(claimed.headers["set-cookie"]).split(";")[0]!;
		return { cookie, id: cookie.split("=")[1]!.split(".")[0]! };
	};
	return {
		home, stateDir, dataDir, viewer, posts, l, r, local, pair,
		answer: (fn: typeof answer) => (answer = fn),
		/** The JSON a write sends from the local listener's own origin unless `headers` says otherwise. */
		post: (path: string, body: unknown, headers: Record<string, string> = local, method = "POST") => l(path, { method, headers, body: typeof body === "string" ? body : JSON.stringify(body) }),
		remote: (cookie: string, path: string, body: unknown, method = "POST", extra: Record<string, string> = {}) => r(path, { method, headers: { cookie, origin: TUNNEL, "content-type": "application/json", ...extra }, body: JSON.stringify(body) }),
		stored: (endpoint: string) => JSON.parse(readFileSync(subscriptionFile(dataDir, subscriptionId(endpoint)), "utf8")) as Record<string, unknown>,
		owners: () => listSubscriptions(dataDir).items.map((item) => item.device_id ?? "legacy").sort(),
	};
}

test("P22-push-http-status: GET /api/push shows only the public setup; an unconfigured home says so and stores nothing", async (t) => {
	const s = await rig(t);
	const reply = await s.l("/api/push");
	assert.equal(reply.status, 200);
	assert.equal(reply.json.configured, true); assert.equal(reply.json.origin, ORIGIN); assert.equal(Buffer.from(String(reply.json.public_key), "base64url").length, 65); assert.equal(reply.json.devices, 0); assert.equal(reply.json.undelivered_24h, 0);
	const secret = JSON.parse(readFileSync(vapidKeyFile(s.dataDir), "utf8")).d as string;
	assert.doesNotMatch(reply.body.toString(), new RegExp(secret));
	assert.equal((await s.l("/api/push", { method: "POST" })).status, 405);
	const bare = await rig(t, { configured: false });
	assert.deepEqual({ ...(await bare.l("/api/push")).json, generated_at: "" }, { generated_at: "", configured: false, origin: null, public_key: null, devices: null, last_sent_at: null, undelivered_24h: null, last_error: null });
	assert.equal((await bare.post("/api/push/subscription", wire(device()))).status, 409);
});

test("P22-push-http-store: POST stores one 0600 file per device, idempotently; DELETE removes it; nothing else changes", async (t) => {
	const s = await rig(t);
	const snapshot = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? snapshot(join(dir, e.name)) : [`${relative(s.home, join(dir, e.name))}:${readFileSync(join(dir, e.name)).toString("base64")}`]));
	const quiet = (lines: string[]) => lines.filter((line) => !line.startsWith(`${LAYOUT.state}/`) && !line.startsWith("clock-offset-ms"));
	const before = quiet(snapshot(s.home));
	const sub = device();
	const created = await s.post("/api/push/subscription", wire(sub));
	assert.equal(created.status, 201); assert.deepEqual(created.json, { subscribed: true, devices: 1 });
	assert.equal((await s.post("/api/push/subscription", { ...wire(sub), expirationTime: null })).status, 201);
	const dir = join(s.dataDir, "push", "subscriptions");
	assert.equal(readdirSync(dir).length, 1); assert.equal(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777, 0o600); assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.deepEqual(quiet(snapshot(s.home)).filter((line) => !line.startsWith(`${LAYOUT.data}/push/subscriptions/`)), before);
	const status = await s.l("/api/push");
	assert.equal(status.json.devices, 1);
	assert.doesNotMatch(status.body.toString(), /fcm\.googleapis|p256dh|auth/);
	const removed = await s.post("/api/push/subscription", { endpoint: sub.endpoint }, s.local, "DELETE");
	assert.equal(removed.status, 200); assert.deepEqual(removed.json, { unsubscribed: true }); assert.deepEqual(readdirSync(dir), []);
	assert.deepEqual((await s.post("/api/push/subscription", { endpoint: sub.endpoint }, s.local, "DELETE")).json, { unsubscribed: false }); assert.ok(existsSync(s.stateDir), "the state dir stays");
});

test("P22-push-http-guard: only a same-origin JSON subscription on a known push service is stored, ten devices at most", async (t) => {
	const s = await rig(t);
	const sub = device(), json = { ...s.local, origin: ORIGIN };
	const cases: Array<[string, unknown, Record<string, string>, number]> = [
		["no Origin", wire(sub), { "content-type": "application/json" }, 403],
		["foreign Origin", wire(sub), { ...json, origin: "https://evil.example" }, 403],
		["http origin of the proxy host", wire(sub), { ...json, origin: "http://cp.example.com" }, 403],
		["another loopback port", wire(sub), { ...json, origin: "http://127.0.0.1:1" }, 403],
		["cross-site fetch", wire(sub), { ...json, "sec-fetch-site": "cross-site" }, 403],
		["form post", wire(sub), { origin: ORIGIN, "content-type": "text/plain" }, 415],
		["too large", "x".repeat(5000), json, 413],
		["too large, streamed", "x".repeat(5000), { ...json, "transfer-encoding": "chunked" }, 413],
		["not JSON", "{", json, 400],
		["http endpoint", { ...wire(sub), endpoint: "http://fcm.googleapis.com/x" }, json, 400],
		["unknown push service", { ...wire(sub), endpoint: "https://evil.example/push" }, json, 400],
		["bad p256dh", { ...wire(sub), keys: { ...sub.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } }, json, 400],
		["bad auth", { ...wire(sub), keys: { ...sub.keys, auth: "short" } }, json, 400],
		["missing keys", { endpoint: sub.endpoint }, json, 400],
	];
	for (const [name, body, headers, status] of cases) assert.equal((await s.post("/api/push/subscription", body, headers)).status, status, name);
	for (const method of ["GET", "HEAD", "PUT", "PATCH"]) {
		const reply = await s.l("/api/push/subscription", { method });
		assert.equal(reply.status, 405, method); assert.equal(reply.headers.allow, "POST, DELETE", method);
	}
	assert.equal((await s.post("/api/push/subscription", wire(sub), { ...json, "sec-fetch-site": "same-origin" })).status, 201, "the configured origin");
	assert.equal((await s.post("/api/push/subscription", wire(device()))).status, 201, "the loopback bind's own origin");
	for (let i = 2; i < 10; i++) assert.equal((await s.post("/api/push/subscription", wire(device()))).status, 201);
	const full = await s.post("/api/push/subscription", wire(device()));
	assert.deepEqual([full.status, full.json.error], [409, "already 10 subscribed devices; turn one off first"], "11th device");
	assert.equal((await s.post("/api/push/subscription", wire(sub))).status, 201, "a known device refreshes past the cap");
	assert.equal(listSubscriptions(s.dataDir).items.length, 10);
	assert.equal((await s.l("/api/awaiting", { method: "POST" })).status, 405);
});

test("P22-push-http-host: under viewer.strict_host a foreign Host is refused before any route", async (t) => {
	const s = await rig(t);
	assert.equal((await s.l("/healthz", { headers: { host: "cp.example.com" } })).status, 200, "the Host check is off by default");
	writeFileSync(viewerConfigFile(s.stateDir), JSON.stringify({ strict_host: true }));
	assert.equal((await s.l("/api/push/subscription", { method: "POST", headers: { ...s.local, host: "cp.example.com" }, body: JSON.stringify(wire(device())) })).status, 421);
	assert.equal((await s.l("/healthz", { headers: { host: "cp.example.com" } })).status, 421);
});

test("P22-push-http-owner: a paired device stores its own from its tunnel origin; nobody else overwrites or removes it", async (t) => {
	const s = await rig(t, { remote: true });
	const laptop = await s.pair("Laptop"), phone = await s.pair("Phone", "view");
	const mine = device();
	assert.equal((await s.remote(phone.cookie, "/api/push/subscription", wire(mine), "POST", { origin: ORIGIN })).status, 403, "the push config origin is not the tunnel's");
	assert.equal((await s.remote(phone.cookie, "/api/push/subscription", { ...wire(mine), device_id: laptop.id, origin: "https://evil.example" })).status, 201, "View-only may store its own");
	assert.deepEqual([s.stored(mine.endpoint).device_id, s.stored(mine.endpoint).origin], [phone.id, TUNNEL], "ownership is the session's, never the body's");
	assert.equal((await s.remote(phone.cookie, "/api/push/subscription", wire(mine))).status, 201, "its own: refreshed");
	const before = readFileSync(subscriptionFile(s.dataDir, subscriptionId(mine.endpoint)), "utf8");
	for (const method of ["POST", "DELETE"]) {
		const other = await s.remote(laptop.cookie, "/api/push/subscription", wire(mine), method);
		assert.deepEqual([other.status, other.json.error], [403, "this subscription belongs to another device"], `another device: ${method}`);
		const local = await s.post("/api/push/subscription", wire(mine), s.local, method);
		assert.deepEqual([local.status, local.json.error], [403, "this subscription belongs to another device"], `the local listener: ${method}`);
	}
	assert.equal(readFileSync(subscriptionFile(s.dataDir, subscriptionId(mine.endpoint)), "utf8"), before, "untouched");
	const legacy = device();
	assert.equal((await s.post("/api/push/subscription", wire(legacy))).status, 201);
	assert.equal(s.stored(legacy.endpoint).device_id, undefined, "a local subscription stays unowned");
	for (const method of ["POST", "DELETE"]) assert.equal((await s.remote(laptop.cookie, "/api/push/subscription", wire(legacy), method)).status, 403, `a remote device never takes a legacy one: ${method}`);
	assert.deepEqual(s.owners(), [phone.id, "legacy"].sort());
	assert.deepEqual((await s.remote(phone.cookie, "/api/push/subscription", { endpoint: mine.endpoint }, "DELETE")).json, { unsubscribed: true }, "its own: removed");
	assert.deepEqual((await s.remote(phone.cookie, "/api/push/subscription", { endpoint: mine.endpoint }, "DELETE")).json, { unsubscribed: false });
	assert.equal((await s.post("/api/push/subscription", { endpoint: legacy.endpoint }, s.local, "DELETE")).status, 200, "local keeps removing its own");
});

test("P22-push-http-revoke: an unreadable file is never overwritten; cp-tunnel revoke removes only that device's own", async (t) => {
	const s = await rig(t, { remote: true });
	const laptop = await s.pair("Laptop"), phone = await s.pair("Phone", "view");
	const torn = device();
	mkdirSync(join(s.dataDir, "push", "subscriptions"), { recursive: true });
	writeFileSync(subscriptionFile(s.dataDir, subscriptionId(torn.endpoint)), "{torn");
	const refused = await s.remote(phone.cookie, "/api/push/subscription", wire(torn));
	assert.deepEqual([refused.status, readFileSync(subscriptionFile(s.dataDir, subscriptionId(torn.endpoint)), "utf8")], [403, "{torn"], "unreadable: not its own, bytes untouched");
	for (const [cookie, sub] of [[phone.cookie, device()], [phone.cookie, device()], [laptop.cookie, device()]] as const) assert.equal((await s.remote(cookie, "/api/push/subscription", wire(sub))).status, 201);
	assert.equal((await s.post("/api/push/subscription", wire(device()))).status, 201);
	const revoke = spawnSync(join(REPO_ROOT, "bin/cp-tunnel"), ["revoke", "Phone", "--home", s.home], { encoding: "utf8", env: { ...process.env, HOME: s.home, CP_HOME: s.home } });
	assert.equal(revoke.status, 0, `${revoke.stdout}${revoke.stderr}`); assert.doesNotMatch(revoke.stderr, /the device is revoked, but/, "no cleanup error");
	assert.deepEqual(s.owners(), [laptop.id, "legacy"].sort(), "both of the phone's went; the laptop's and the legacy one stay");
	assert.equal(readFileSync(subscriptionFile(s.dataDir, subscriptionId(torn.endpoint)), "utf8"), "{torn", "an unreadable file is never someone's to clean up");
});

test("P22-push-http-app: the service worker, manifest and icons are same-origin, standalone and open Awaiting you", async (t) => {
	const s = await rig(t, { configured: false });
	const sw = await s.l("/sw.js");
	assert.equal(sw.status, 200); assert.equal(sw.headers["content-type"], "text/javascript; charset=utf-8"); assert.equal(sw.headers["content-security-policy"], APP_CSP); assert.equal(sw.headers["cache-control"], "no-store");
	assert.match(sw.body.toString(), /notificationclick/);
	assert.match(APP_CSP, /; worker-src 'self'; manifest-src 'self'; /);
	assert.equal(APP_CSP.replace("worker-src 'self'; manifest-src 'self'; ", ""), "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; font-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
	const manifest = await s.l("/manifest.webmanifest");
	assert.equal(manifest.status, 200); assert.equal(manifest.headers["content-type"], "application/manifest+json; charset=utf-8");
	const body = manifest.json as { display: string; start_url: string; theme_color: string; background_color: string; icons: Array<{ src: string; sizes: string }> };
	assert.equal(body.display, "standalone"); assert.equal(body.start_url, "/#awaiting"); assert.equal(body.theme_color, APP_COLORS.background); assert.equal(body.background_color, APP_COLORS.background);
	const tokens = (await s.l(String(/href="([^"]+\.css)"/.exec((await s.l("/")).body.toString())?.[1]))).body.toString();
	assert.match(tokens, new RegExp(`--background: ${APP_COLORS.background};`));
	assert.match(tokens, new RegExp(`--amber: ${APP_COLORS.accent};`));
	assert.match((await s.l("/")).body.toString(), /<link rel="manifest" href="\/manifest.webmanifest"><link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);
	for (const [path, size] of [["/icon-192.png", 192], ["/icon-512.png", 512], ["/apple-touch-icon.png", 180]] as const) {
		const icon = await s.l(path);
		assert.equal(icon.status, 200, path); assert.equal(icon.headers["content-type"], "image/png", path);
		assert.deepEqual([...icon.body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		assert.equal(icon.body.readUInt32BE(16), size); assert.equal(icon.body.readUInt32BE(20), size);
		const pixels = inflateSync(icon.body.subarray(41, 41 + icon.body.readUInt32BE(33)));
		assert.equal(pixels.length, size * (1 + size * 3));
		const colours = new Set<string>();
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) colours.add(`#${pixels.subarray(y * (1 + size * 3) + 1 + x * 3, y * (1 + size * 3) + 4 + x * 3).toString("hex")}`);
		assert.deepEqual([...colours].sort(), [APP_COLORS.background, APP_COLORS.accent].sort(), path);
		const listed = body.icons.find((i) => i.src === path);
		if (listed) assert.equal(listed.sizes, `${size}x${size}`);
	}
	assert.equal((await s.l("/icon-1.png")).status, 404);
});

test("P22-push-http-test: a test push goes only to the caller's own subscription, one a minute, journaled", async (t) => {
	const s = await rig(t, { remote: true });
	const laptop = await s.pair("Laptop"), phone = await s.pair("Phone", "view");
	const mine = device("phone"), theirs = device("laptop");
	for (const [cookie, sub] of [[phone.cookie, mine], [laptop.cookie, theirs]] as const) assert.equal((await s.remote(cookie, "/api/push/subscription", wire(sub))).status, 201);
	const accepted = { subscription: subscriptionId(theirs.endpoint), at: "2026-10-18T09:13:00Z" };
	new PushDeliveryStore(s.stateDir).write({ schema_version: 1, baseline_at: accepted.at, items: [{ id: "a1", source: "ask", kind: "operator_ask", status: "sent", attempts: 1, delivered: 1, accepted: [accepted], created_at: accepted.at, settled_at: accepted.at }] }, new Set());
	const send = (cookie: string, endpoint: string) => s.remote(cookie, "/api/push/test", { endpoint });
	assert.deepEqual((await send(laptop.cookie, mine.endpoint)).json.error, "this subscription belongs to another device");
	assert.equal((await send(phone.cookie, device().endpoint)).status, 404, "not subscribed");
	const own = await send(phone.cookie, mine.endpoint);
	assert.deepEqual([own.status, { ...own.json, at: "" }], [200, { at: "", result: "accepted", last_accepted_at: null }], "View-only may test its own");
	assert.equal((await s.post("/api/push/test", { endpoint: mine.endpoint })).status, 403, "the local listener never tests a device's");
	const again = await send(phone.cookie, mine.endpoint);
	assert.deepEqual([again.status, Number(again.headers["retry-after"]) > 0], [429, true], "rate-limited per device");
	s.answer(() => ({ status: 429, body: "slow down" }));
	const busy = await send(laptop.cookie, theirs.endpoint);
	assert.deepEqual({ ...busy.json, at: "" }, { at: "", result: "retry", reason: "HTTP 429 slow down", last_accepted_at: accepted.at });
	assert.deepEqual(s.posts.map((post) => post.slug), ["phone", "laptop"], "one push per allowed test, none for a refused one");
	assert.equal(JSON.parse(mine.decrypt(s.posts[0]!.body)).kind, "test notification");
	assert.deepEqual(new PushTestJournal(s.stateDir).read().map((item) => [item.subscription, item.result]), [[subscriptionId(mine.endpoint), "accepted"], [subscriptionId(theirs.endpoint), "retry"]]);
});

type Staged = { secure?: boolean; supported?: boolean; ios?: boolean; standalone?: boolean; permission?: NotificationPermission; grant?: NotificationPermission; hang?: boolean };
/** Stages this browser's push APIs in `tab` (a real browser's shapes), then opens More; `calls` records what the app asked. */
async function more(tab: Tab, sub: TestDevice, staged: Staged = {}) {
	const { secure = true, supported = true, ios = false, standalone = false, permission = "default", grant = "granted", hang = false } = staged;
	const calls: unknown[][] = [];
	let current: { endpoint: string; toJSON(): unknown; unsubscribe(): Promise<boolean> } | null = null;
	const registration = {
		pushManager: {
			getSubscription: async () => current,
			subscribe: async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
				calls.push(["subscribe", Buffer.from(applicationServerKey).toString("base64url")]);
				if (hang) return new Promise<never>(() => {});
				current = { endpoint: sub.endpoint, toJSON: () => ({ ...wire(sub), expirationTime: null }), unsubscribe: async () => { calls.push(["unsubscribe"]); current = null; return true; } };
				return current;
			},
		},
	};
	const navigator = tab.navigator as Record<string, unknown>;
	Object.defineProperty(tab.window, "isSecureContext", { configurable: true, value: secure });
	if (ios) Object.assign(navigator, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", standalone });
	const notification = { permission, requestPermission: async () => (calls.push(["requestPermission"]), grant) };
	tab.globals.Notification = notification;
	// linkedom's window writes unknown properties to the shared globalThis: an unsupported one removes another tab's
	if (!supported) for (const name of ["PushManager", "Notification"]) Reflect.deleteProperty(tab.window, name);
	else {
		Object.assign(tab.window, { PushManager: class {}, Notification: notification });
		navigator.serviceWorker = { register: async (url: string, options: { scope: string }) => void calls.push(["register", url, options.scope]), ready: Promise.resolve(registration), getRegistration: async () => registration };
	}
	tab.go("#more");
	return { calls, section: () => tab.find("section.more-push"), html: () => tab.$("section.more-push")?.outerHTML ?? "", meta: () => tab.$("section.more-push .more-meta")?.textContent ?? "" };
}
const button = (tab: Tab, label: string) => tab.find("section.more-push button", (el) => el.textContent === label);

test("P22-push-ui-phases: More's Notifications says why it cannot turn on, with a button only for on or off", async (t) => {
	const s = await rig(t);
	const tab = await s.viewer.open("#awaiting");
	await tab.find("nav");
	assert.equal(tab.$("section.more-push"), null, "no Notifications control off More");
	const phase = async (staged: Staged, meta: RegExp, home = s) => {
		const page = await more(await openTab(t, home.viewer.port, "#awaiting"), device(), staged);
		await page.section();
		await until(page.meta, (text) => meta.test(text), String(meta));
		return page;
	};
	const insecure = await phase({ secure: false, ios: true }, /^Needs the HTTPS address of this dashboard$/);
	assert.match(insecure.html(), /href="https:\/\/cp\.example\.com\/#more">Open the HTTPS dashboard/);
	assert.doesNotMatch(insecure.html(), /<button/);
	const install = await phase({ ios: true, supported: false }, /add this dashboard to the Home Screen first/);
	assert.match(install.html(), /<li>Choose Add to Home Screen<\/li>/);
	const ready = await phase({ ios: true, standalone: true }, /^Off for this device · 0 devices on this home$/);
	assert.deepEqual(ready.html().match(/<button[^>]*>[^<]*<\/button>/g), ['<button type="button">Turn on</button>'], "off: no Send test");
	const recent = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
	const failed = (id: string, at: string, last_error: string) => ({ id, source: "ask", kind: "operator_ask", status: "failed", attempts: 5, delivered: 0, created_at: at, settled_at: at, last_error });
	writeFileSync(pushDeliveriesFile(s.stateDir), JSON.stringify({ schema_version: 1, baseline_at: recent(60), items: [failed("ask-0000000000a1", recent(50), "stale"), failed("ask-0000000000a2", recent(2), "abcd1234 retry: HTTP 500"), failed("ask-0000000000a3", recent(1), "abcd1234 rejected: HTTP 403")] }));
	const pushed = /^Off for this device · 0 devices on this home · 2 undelivered in 24 h \(last: abcd1234 rejected: HTTP 403\)$/;
	assert.match((await phase({}, pushed)).meta(), pushed, "a failed push in 24 h is counted with its last error");
	rmSync(pushDeliveriesFile(s.stateDir));
	assert.doesNotMatch((await phase({ supported: false }, /^This browser has no Web Push$/)).html(), /<button/);
	assert.doesNotMatch((await phase({ permission: "denied" }, /^Blocked in browser settings/)).html(), /<button/);
	const bare = await rig(t, { configured: false });
	assert.doesNotMatch((await phase({}, /npm run push:init -- --origin https:\/\/<dashboard host>/, bare)).html(), /<button/);
	const checking = await more(await openTab(t, s.viewer.port, "#awaiting", new Map(), /^\/api\/push$/), device());
	await until(checking.meta, (text) => text === "Checking this browser", "checking while /api/push is held");
	assert.doesNotMatch(checking.html(), /<button|style=/);
	for (const name of ["PushManager", "Notification", "isSecureContext"]) Reflect.deleteProperty(globalThis, name); // see `more`
	const lost = await openTab(t, s.viewer.port, "#more", new Map(), /^\/api\/push$/);
	await until(() => lost.requests.some((row) => row.read), Boolean, "the screen's data read");
	const error = await more(lost, device());
	await s.viewer.stop();
	lost.release();
	await until(error.meta, (text) => text === "Push status unavailable", "an unreachable home");
	assert.doesNotMatch(error.html(), /<button/);
});

test("P22-push-ui-toggle: Turn on asks first and stores this browser's subscription; Send test and Turn off say what happened", async (t) => {
	const s = await rig(t);
	const config = readPushConfig(s.dataDir)!;
	const mine = device("mine");
	const tab = await openTab(t, s.viewer.port, "#awaiting", new Map(), /^\/api\/push\/subscription$/);
	const page = await more(tab, mine);
	page.calls.length = 0;
	tab.click(await button(tab, "Turn on"));
	assert.deepEqual([(await button(tab, "Working")).hasAttribute("disabled"), page.meta()], [true, "Waiting for this browser and the home"], "busy while the home stores it");
	tab.release();
	await until(page.meta, (text) => text === "On for this device · 1 device on this home", "on");
	assert.deepEqual(tab.$$("section.more-push button").map((el) => el.textContent), ["Turn off", "Send test"]);
	assert.deepEqual(page.calls, [["requestPermission"], ["register", "/sw.js", "/"], ["subscribe", config.public_key]], "permission first, then the worker, then the VAPID key");
	assert.deepEqual(s.stored(mine.endpoint).keys, mine.keys, "this browser's subscription, stored as the browser gave it");
	tab.click(await button(tab, "Send test"));
	const accepted = await tab.find("section.more-push p[role=status]");
	assert.match(accepted.textContent ?? "", /^Test accepted by the push service at .+; this does not confirm the device showed it$/);
	assert.deepEqual(s.posts.map((post) => post.slug), ["mine"], "only this browser's endpoint");
	tab.click(await button(tab, "Send test"));
	assert.match((await tab.find("section.more-push p[role=alert]")).textContent ?? "", /^Test not sent: one test a minute per device/);
	const sent = { subscription: subscriptionId(mine.endpoint), at: "2026-10-18T09:13:00Z" };
	new PushDeliveryStore(s.stateDir).write({ schema_version: 1, baseline_at: sent.at, items: [{ id: "a1", source: "ask", kind: "operator_ask", status: "sent", attempts: 1, delivered: 1, accepted: [sent], created_at: sent.at, settled_at: sent.at }] }, new Set());
	s.viewer.pin(new Date(Date.now() + 120_000).toISOString());
	s.answer(() => ({ status: 410 }));
	tab.click(await button(tab, "Send test"));
	await tab.find("section.more-push p[role=status]", (el) => /not accepted/.test(el.textContent ?? ""));
	assert.match(tab.$("section.more-push p[role=status]")!.textContent!, /^Test not accepted by the push service \(gone: HTTP 410: .+\) · last decision push accepted \d\d:\d\d UTC$/);
	assert.doesNotMatch(page.html(), /style=/);
	await s.post("/api/push/subscription", wire(mine));
	tab.click(await button(tab, "Turn off"));
	await until(page.meta, (text) => text === "Off for this device · 0 devices on this home", "off");
	assert.deepEqual([page.calls.at(-1), listSubscriptions(s.dataDir).items.length], [["unsubscribe"], 0], "the home first, then the browser");
});

test("P22-push-ui-refused: a denial, a full home, an unreachable home or a stalled push service leave nothing subscribed", async (t) => {
	const s = await rig(t);
	const denied = await openTab(t, s.viewer.port, "#awaiting");
	const no = await more(denied, device(), { grant: "denied" });
	denied.click(await button(denied, "Turn on"));
	assert.equal((await denied.find("section.more-push p[role=status]")).textContent, "Notifications were not allowed in this browser");
	assert.deepEqual(no.calls, [["requestPermission"]]);
	const seeded = Array.from({ length: 10 }, () => device());
	for (const sub of seeded) assert.equal((await s.post("/api/push/subscription", wire(sub))).status, 201);
	const full = await openTab(t, s.viewer.port, "#awaiting");
	const crowded = await more(full, device());
	full.click(await button(full, "Turn on"));
	assert.equal((await full.find("section.more-push p[role=alert]")).textContent, "Not turned on: already 10 subscribed devices; turn one off first");
	assert.equal(crowded.calls.at(-1)?.[0], "unsubscribe", "the browser drops what the home refused");
	const stalled = await openTab(t, s.viewer.port, "#awaiting");
	const waiting = await more(stalled, device(), { hang: true });
	stalled.click(await button(stalled, "Turn on"));
	assert.equal((await stalled.find("section.more-push p[role=alert]", () => true, 45_000)).textContent, "The browser's push service did not answer; try again");
	assert.equal(stalled.requests.some((row) => row.path === "/api/push/subscription"), false, "nothing stored");
	assert.equal(waiting.calls.at(-1)?.[0], "subscribe");
	await s.post("/api/push/subscription", { endpoint: seeded[0]!.endpoint }, s.local, "DELETE");
	const leaving = await openTab(t, s.viewer.port, "#awaiting");
	const away = await more(leaving, device());
	leaving.click(await button(leaving, "Turn on"));
	await until(away.meta, (text) => text.startsWith("On for this device"), "on");
	const offline = await openTab(t, s.viewer.port, "#awaiting");
	const gone = await more(offline, device());
	const turnOn = await button(offline, "Turn on");
	await s.viewer.stop();
	leaving.click(await button(leaving, "Turn off"));
	assert.equal((await leaving.find("section.more-push p[role=status]")).textContent, "Removed here; the home drops it on its next push");
	assert.equal(away.calls.at(-1)?.[0], "unsubscribe", "the browser is unsubscribed even when the home is unreachable");
	offline.click(turnOn);
	assert.equal((await offline.find("section.more-push p[role=alert]")).textContent, "Could not reach this home to store the subscription");
	assert.equal(gone.calls.at(-1)?.[0], "unsubscribe", "Turn on with the home unreachable leaves nothing subscribed");
});

/** One raw POST that writes `body` once the reply starts; `hold` keeps the socket open until the server closes it. */
function rawPost(port: number, path: string, headers: Record<string, string>, body: Buffer, hold = false) {
	const head = `POST ${path} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
	return new Promise<{ reply: string; written: boolean; held: number }>((resolve) => {
		const socket = connect(port, "127.0.0.1");
		let reply = "", written = false, repliedAt = 0;
		socket.on("data", (chunk: Buffer) => {
			if (!repliedAt) {
				repliedAt = Date.now();
				socket.write(body, (error) => { written = !error; if (written && !hold) socket.destroy(); });
			}
			reply += chunk.toString("utf8");
		});
		socket.on("error", () => {});
		socket.on("close", () => resolve({ reply, written, held: Date.now() - repliedAt }));
		socket.write(head);
	});
}

test("P22-push-http-oversize: an oversize push body gets a readable 413, a bounded drain, and a stalled sender is closed", { timeout: 60_000 }, async (t) => {
	const s = await rig(t);
	const post = (bytes: number, body: Buffer, hold = false) => rawPost(s.viewer.port, "/api/push/subscription", { ...s.local, "content-length": String(bytes) }, body, hold);
	const within = await post(1024 * 1024, Buffer.alloc(1024 * 1024, 120));
	assert.match(within.reply, /^HTTP\/1\.1 413 [\s\S]*body is larger than 4096 bytes/);
	assert.doesNotMatch(within.reply, /connection: close/i, "the 413 does not reset a sender still writing");
	assert.equal(within.written, true, "a sender within the discard bound finishes its write, no EPIPE");
	const huge = await post(64 * 1024 * 1024, Buffer.alloc(64 * 1024 * 1024, 120));
	assert.match(huge.reply, /^HTTP\/1\.1 413 /);
	assert.equal(huge.written, false, "past the bound the server stops reading and closes");
	const stalled = await post(1024 * 1024, Buffer.alloc(0), true);
	assert.match(stalled.reply, /^HTTP\/1\.1 413 /);
	assert.ok(BODY_DISCARD_IDLE_MS >= 5000 && stalled.held >= BODY_DISCARD_IDLE_MS - 500, `held ${stalled.held} ms: closed by the idle timer, not at once`);
});
