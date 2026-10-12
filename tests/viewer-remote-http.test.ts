/**
 * Remote dashboard PR 1b (T1): the remote listener's gate. Every route class and method refuses an unpaired caller
 * before the dispatcher (no data, no stream timer), forged forwarding headers confer nothing, both levels read, View-only
 * gets no write token and no write, remote responses are never cached, a revoke ends the next request and an open
 * stream, and the default local listener is unchanged (no device route, no cookie).
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { DEVICE_SESSION_TTL_MS, devicesFile } from "../src/viewer/device-files.ts";
import { DEVICES_TOKEN } from "../src/viewer/devices-api.ts";
import { pollingStreams } from "../src/viewer/server.ts";
import { newUploadId, writeUpload } from "../src/viewer/uploads.ts";
import { REMOTE_ORIGIN as ORIGIN, remoteRig as rig } from "./harness/remote.ts";

const PROTECTED = [
	"/", "/assets/viewer/app.js", "/boards/", "/boards/board.css", "/boards/demo/", "/sw.js", "/manifest.webmanifest", "/icon-192.png", "/apple-touch-icon.png",
	"/api/identity", "/healthz", "/api/version", "/api/overview", "/api/jobs", "/api/board", "/api/reports", "/api/schedules", "/api/map", "/api/dashboard",
	"/api/awaiting", "/api/decided", "/api/decisions", "/api/stats", "/api/job?id=x", "/api/job/x/events", "/api/job/x/transcript", "/api/diff?id=x",
	"/api/sessions", "/api/sessions?view=you&transcript=1", "/api/roots", "/api/files", "/api/git", "/api/skills", "/api/operator/uploads/x",
	"/api/stream?view=overview", "/api/stream?id=x", "/api/operator/control", "/api/schedules/control", "/api/schedules/policy", "/api/answers/control",
	"/api/threads", "/api/settings", "/api/push", "/api/devices", "/api/devices/notices", "/classic", "/nope", "/pair?code=x", "/pair/", "/api/pair/claim?x=1",
];

test("unpaired: every route class and method refuses 401 before the dispatcher; forged headers confer nothing; only /pair and the claim are public", async (t) => {
	const { r, home } = await rig(t);
	const forged = { "x-forwarded-for": "127.0.0.1", "cf-connecting-ip": "127.0.0.1", "x-real-ip": "127.0.0.1", "tailscale-user-login": "me@example.test", origin: ORIGIN };
	for (const path of PROTECTED) {
		for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
			const reply = await r(path, { method, headers: forged });
			assert.equal(reply.status, 401, `${method} ${path}`);
			assert.equal(reply.text.includes(home.path), false, `${method} ${path} leaks the home`);
			assert.equal(reply.headers["access-control-allow-origin"], undefined);
		}
	}
	for (const path of ["/api/operator/message", "/api/operator/start", "/api/operator/queue", "/api/operator/upload", "/api/settings/apply", "/api/push/subscription", "/api/pair/create", "/api/devices/revoke", "/api/threads/done"]) {
		assert.equal((await r(path, { method: "POST", headers: { ...forged, "content-type": "application/json" }, body: "{}" })).status, 401, path);
	}
	assert.equal(pollingStreams(), 0, "an unpaired stream request starts no timer");
	assert.equal((await r("/api/overview", { headers: { host: "cp.example.test" } })).status, 421, "the tunnel must rewrite Host to the loopback endpoint");
	const page = await r("/pair");
	assert.equal(page.status, 200);
	assert.match(String(page.headers["content-security-policy"]), /^default-src 'none'; script-src 'sha256-/);
	assert.equal(page.headers["cache-control"], "no-store");
	assert.equal(page.headers["referrer-policy"], "no-referrer");
	assert.equal(page.headers["x-frame-options"], "DENY");
	assert.equal(page.headers["set-cookie"], undefined);
	assert.equal((await r("/pair", { method: "HEAD" })).status, 200);
	assert.notEqual((await r("/api/pair/claim", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status, 401, "the claim is public");
});

test("bad cookies: unknown, malformed, duplicated, expired and revoked sessions are 401 and clear the cookie; 10 failures per address then 429", async (t) => {
	const { r, pair, store, clock } = await rig(t);
	const good = pair("Phone");
	const [id] = good.cookie.split("=")[1]!.split(".");
	for (const cookie of ["__Host-cp_device=nope", `__Host-cp_device=${id}.${"A".repeat(43)}`, `${good.cookie}; ${good.cookie}`, "cp_device=x"]) {
		const reply = await r("/api/overview", { headers: { cookie, "cf-connecting-ip": "203.0.113.7" } });
		assert.equal(reply.status, 401, cookie);
	}
	assert.equal((await r("/api/overview", { headers: { cookie: "__Host-cp_device=nope", "cf-connecting-ip": "203.0.113.8" } })).headers["set-cookie"]?.[0]?.includes("Max-Age=0"), true);
	for (let i = 0; i < 8; i++) await r("/api/overview", { headers: { cookie: "__Host-cp_device=nope", "cf-connecting-ip": "203.0.113.7" } });
	assert.equal((await r("/api/overview", { headers: { cookie: good.cookie, "cf-connecting-ip": "203.0.113.7" } })).status, 429, "the address used its 10 failures");
	assert.equal((await r("/api/overview", { headers: { cookie: good.cookie, "cf-connecting-ip": "198.51.100.1" } })).status, 200, "another address is unaffected");
	assert.equal((await r("/api/overview", { headers: { cookie: good.cookie } })).status, 200, "absent CF-Connecting-IP is its own shared bucket");
	clock.advance(10 * 60_000);
	assert.equal((await r("/api/overview", { headers: { cookie: good.cookie, "cf-connecting-ip": "203.0.113.7" } })).status, 200, "the window slides");
	clock.advance(DEVICE_SESSION_TTL_MS + 1);
	assert.equal((await r("/api/overview", { headers: { cookie: good.cookie } })).status, 401, "expired");
	const other = pair("Tablet");
	assert.ok(store.revoke(other.id).ok);
	assert.equal((await r("/api/overview", { headers: { cookie: other.cookie } })).status, 401, "revoked");
});

test("a binding that is not running refuses every gated route and the claim", async (t) => {
	const { r, pair, bound } = await rig(t);
	const device = pair("Phone");
	bound.current = null;
	assert.equal((await r("/api/overview", { headers: { cookie: device.cookie } })).status, 503);
	assert.equal((await r("/api/pair/claim", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status, 503);
	bound.current = { origin: ORIGIN, generation: 2 };
	assert.equal((await r("/api/overview", { headers: { cookie: device.cookie } })).status, 401, "a new quick generation invalidates the session");
});

test("both levels read every protected route, sliding the cookie; remote answers are never cached; View-only gets no write token", async (t) => {
	const { r, pair, uploads, home } = await rig(t);
	const full = pair("Laptop"), view = pair("Phone", "view");
	const id = newUploadId("txt", new Date());
	writeUpload(uploads, id, Buffer.from("hello\n"));
	for (const device of [full, view]) {
		for (const path of ["/api/overview", "/api/identity", "/healthz", "/api/sessions?view=you&transcript=1", "/api/skills", "/api/operator/control", "/api/schedules/control", "/api/answers/control", "/api/threads", `/api/operator/uploads/${id}`, "/api/devices", "/sw.js"]) {
			const reply = await r(path, { headers: { cookie: device.cookie } });
			assert.notEqual(reply.status, 401, path);
			assert.notEqual(reply.status, 403, `${path} is readable remotely (the local listener here has no --require-tailnet)`);
			assert.equal(reply.headers["cache-control"], "no-store", path);
			const cookie = String(reply.headers["set-cookie"]);
			assert.match(cookie, /^__Host-cp_device=dev-[0-9a-f]{16}\.[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; Secure; HttpOnly; SameSite=Strict$/, path);
		}
		assert.equal((await r("/api/identity", { headers: { cookie: device.cookie } })).body.home, home.path);
	}
	const tokens = async (cookie: string) => ({
		control: (await r("/api/operator/control", { headers: { cookie } })).body.inbox_token,
		schedules: (await r("/api/schedules/control", { headers: { cookie } })).body.token,
		answers: (await r("/api/answers/control", { headers: { cookie } })).body.token,
		threads: (await r("/api/threads", { headers: { cookie } })).body.token,
		devices: (await r("/api/devices", { headers: { cookie } })).body.token,
	});
	assert.deepEqual(Object.values(await tokens(view.cookie)), [null, null, null, null, null], "View-only reads with every write token withheld");
	const fullTokens = await tokens(full.cookie);
	for (const [name, token] of Object.entries(fullTokens)) assert.equal(typeof token, "string", name);
	assert.equal(fullTokens.devices, DEVICES_TOKEN);
	const devices = (await r("/api/devices", { headers: { cookie: view.cookie } })).body;
	assert.equal(devices.can_create, false);
	assert.equal(devices.can_revoke, false);
	assert.equal(JSON.stringify(devices).includes("session_digest"), false);
	assert.match(String(devices.trust), /trusted like your terminal/);
});

test("remote writes: View-only refuses before any effect, Full-control reaches the handlers, no remote device mints, Full-control revokes", async (t) => {
	const { r, pair, store } = await rig(t);
	const full = pair("Laptop"), view = pair("Phone", "view");
	const json = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, "content-type": "application/json", "x-cp-control-token": DEVICES_TOKEN, ...extra });
	for (const path of ["/api/operator/message", "/api/operator/start", "/api/operator/restart", "/api/operator/queue", "/api/operator/upload", "/api/schedules/request", "/api/answers/ack", "/api/threads/done", "/api/settings/apply", "/api/settings/restore"]) {
		const viewed = await r(path, { method: "POST", headers: json(view.cookie), body: '{"kind":"message","text":"hi"}' });
		assert.equal(viewed.status, 403, path);
		assert.match(String(viewed.body.error), /View-only/);
		const fulled = await r(path, { method: "POST", headers: json(full.cookie), body: '{"kind":"message","text":"hi"}' });
		assert.doesNotMatch(String(fulled.body.error ?? ""), /View-only|not enabled yet|require-tailnet/, `${path} reaches its handler (PR 1c lifted the blanket 403)`);
		const crossed = await r(path, { method: "POST", headers: json(full.cookie, { origin: "https://evil.example" }), body: '{"kind":"message","text":"hi"}' });
		assert.deepEqual([crossed.status, crossed.body.error], [403, `Origin must be ${ORIGIN}`], `${path}: exact tunnel Origin`);
	}
	for (const device of [full, view]) {
		const minted = await r("/api/pair/create", { method: "POST", headers: json(device.cookie), body: '{"level":"full"}' });
		assert.equal(minted.status, 403, "no remote device mints, whatever its level, token or Origin");
	}
	assert.equal((store.list() as { pending_codes: number }).pending_codes, 0, "nothing was issued");
	assert.equal((await r("/api/devices/revoke", { method: "POST", headers: json(view.cookie), body: JSON.stringify({ id: full.id }) })).status, 403, "View-only cannot revoke");
	assert.equal((await r("/api/devices/revoke", { method: "POST", headers: json(full.cookie, { origin: "https://evil.example" }), body: JSON.stringify({ id: view.id }) })).status, 403, "exact tunnel Origin");
	assert.equal((await r("/api/devices/revoke", { method: "POST", headers: json(full.cookie, { "x-cp-control-token": "0".repeat(64) }), body: JSON.stringify({ id: view.id }) })).status, 403, "management token");
	const revoked = await r("/api/devices/revoke", { method: "POST", headers: json(full.cookie), body: JSON.stringify({ id: view.id }) });
	assert.equal(revoked.status, 200);
	assert.equal(revoked.body.id, view.id);
	assert.equal((await r("/api/overview", { headers: { cookie: view.cookie } })).status, 401, "the next request after a completed revoke is refused");
});

test("a revoke closes that device's open stream within two seconds; HEAD starts no timer", async (t) => {
	const { r, pair, store, remote } = await rig(t);
	const device = pair("Phone");
	assert.equal((await r("/api/stream?view=overview", { method: "HEAD", headers: { cookie: device.cookie } })).status, 200);
	assert.equal(pollingStreams(), 0);
	const closed = new Promise<number>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: remote.port, path: "/api/stream?view=overview", headers: { host: `127.0.0.1:${remote.port}`, cookie: device.cookie } }, (res) => {
			assert.equal(res.statusCode, 200);
			res.once("data", () => {
				const revokedAt = Date.now();
				assert.ok(store.revoke(device.id).ok);
				res.on("close", () => resolve(Date.now() - revokedAt));
				res.on("error", () => resolve(Date.now() - revokedAt));
				res.resume();
			});
		});
		req.on("error", reject);
		req.end();
	});
	const elapsed = await closed;
	assert.ok(elapsed <= 2500, `closed ${elapsed} ms after the revoke`);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(pollingStreams(), 0, "its timer is gone");
});

test("an unreadable device store closes an open remote stream within two seconds (stillValid fails closed)", async (t) => {
	const { pair, remote, dataDir } = await rig(t);
	const device = pair("Phone");
	const closed = new Promise<number>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: remote.port, path: "/api/stream?view=overview", headers: { host: `127.0.0.1:${remote.port}`, cookie: device.cookie } }, (res) => {
			assert.equal(res.statusCode, 200);
			res.once("data", () => {
				const brokenAt = Date.now();
				writeFileSync(devicesFile(dataDir), "{ not json");
				res.on("close", () => resolve(Date.now() - brokenAt));
				res.on("error", () => resolve(Date.now() - brokenAt));
				res.resume();
			});
		});
		req.on("error", reject);
		req.end();
	});
	const elapsed = await closed;
	assert.ok(elapsed <= 2500, `closed ${elapsed} ms after the store became unreadable`);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(pollingStreams(), 0, "its timer is gone");
});

test("local parity: the default local listener has no device route, no pair page and sets no cookie", async (t) => {
	const { l, pair } = await rig(t);
	const device = pair("Phone");
	assert.equal((await l("/api/devices", { headers: { cookie: device.cookie } })).status, 404);
	assert.equal((await l("/pair")).status, 404);
	const post = await l("/api/pair/create", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(post.status, 405, "unknown write paths answer the read-only 405 exactly as before");
	const transcript = await l("/api/sessions?view=you&transcript=1", { headers: { cookie: device.cookie } });
	assert.equal(transcript.status, 403, "a device cookie confers nothing on the local listener");
	const overview = await l("/api/overview", { headers: { cookie: device.cookie } });
	assert.equal(overview.status, 200);
	assert.equal(overview.headers["set-cookie"], undefined);
	assert.equal((await l("/api/operator/control")).status, 403, "--require-tailnet keeps its meaning");
});
