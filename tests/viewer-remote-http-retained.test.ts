/**
 * Retained from viewer-remote-http (P12): no route reports pollingStreams(), and the runtime closes the listener and
 * every connection in the step that clears the binding. tests/e2e/remote-access.test.ts pins everything else. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { test } from "node:test";
import { devicesFile } from "../src/viewer/device-files.ts";
import { pollingStreams } from "../src/viewer/server.ts";
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

test("a binding that is not running refuses every gated route and the claim", async (t) => {
	const { r, pair, bound } = await rig(t);
	const device = pair("Phone");
	bound.current = null;
	assert.equal((await r("/api/overview", { headers: { cookie: device.cookie } })).status, 503);
	assert.equal((await r("/api/pair/claim", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status, 503);
	bound.current = { origin: ORIGIN, generation: 2 };
	assert.equal((await r("/api/overview", { headers: { cookie: device.cookie } })).status, 401, "a new quick generation invalidates the session");
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
