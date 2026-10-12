import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { runDeviceNotifySweep } from "../src/push/device-notifications.ts";
import type { DeviceNoticesResponse } from "../src/viewer/api-types.ts";
import { deviceControlAnswer } from "../src/viewer/device-control.ts";
import { deviceNotificationsFile } from "../src/viewer/device-notification-files.ts";
import { DEVICES_TOKEN } from "../src/viewer/devices-api.ts";
import { bindOrigin } from "../src/viewer/push-api.ts";
import { REMOTE_ORIGIN, remoteRig } from "./harness/remote.ts";

type Env = Awaited<ReturnType<typeof remoteRig>>;
const notices = async (env: Env, cookie?: string) => {
	const reply = cookie ? await env.r("/api/devices/notices", { headers: { cookie } }) : await env.l("/api/devices/notices");
	assert.equal(reply.status, 200, reply.text);
	return reply.body as unknown as DeviceNoticesResponse;
};
const codeOf = (link: unknown): string => String(link).split("#")[1]!;

test("A8: a pairing through every issuer route is a durable notice naming its route for every recipient — Full, View-only and the new device — remote and local", async (t) => {
	const env = await remoteRig(t, { localDevices: true });
	const laptop = env.pair("Laptop");
	const phone = env.pair("Phone", "view");
	const issue: Record<string, () => Promise<string>> = {
		"cli-up": async () => {
			const reply = deviceControlAnswer(env.devices, "pair", { route: "cli-up" });
			assert.ok(reply.ok);
			return codeOf((reply.result as { link: string }).link);
		},
		"cli-pair": async () => {
			const reply = deviceControlAnswer(env.devices, "pair", { route: "cli-pair", level: "view" });
			assert.ok(reply.ok);
			return codeOf((reply.result as { link: string }).link);
		},
		"loopback-dashboard": async () => {
			const reply = await env.l("/api/pair/create", { method: "POST", headers: { origin: bindOrigin(env.options), "content-type": "application/json", "x-cp-control-token": DEVICES_TOKEN }, body: "{}" });
			assert.equal(reply.status, 201);
			return codeOf(reply.body.link);
		},
		// A test cannot bind a tailnet address: the tailnet Add device's own store call, as devices-api.ts makes it.
		"tailnet-dashboard": async () => {
			const issued = env.store.issueCode({ ...env.bound.current!, route: "tailnet-dashboard", peer: "100.64.0.7" });
			assert.ok(issued.ok);
			return issued.code;
		},
	};
	const paired: string[] = [];
	for (const [route, mint] of Object.entries(issue)) {
		const name = `New ${route}`;
		const claimed = await env.r("/api/pair/claim", { method: "POST", headers: { origin: REMOTE_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code: await mint(), name }) });
		assert.equal(claimed.status, 200, route);
		const cookie = String(claimed.headers["set-cookie"]).split(";")[0]!;
		const id = cookie.split("=")[1]!.split(".")[0]!;
		paired.push(id);
		for (const viewer of [laptop.cookie, phone.cookie, cookie]) {
			const top = (await notices(env, viewer)).notices[0]!;
			assert.deepEqual([top.name, top.route, top.device_id], [name, route, id], `${route}: newest first, on every device`);
			assert.deepEqual(top.recipients.map((r) => [r.device_id, r.state]), [laptop.id, phone.id, ...paired].map((d) => [d, "pending"]), `${route}: every recipient, View-only and the new device included`);
			assert.doesNotMatch(JSON.stringify(top), /digest|cookie|code|secret/);
		}
	}
	const local = await notices(env);
	assert.deepEqual(local.notices.map((n) => n.route), ["tailnet-dashboard", "loopback-dashboard", "cli-pair", "cli-up", "cli-pair", "cli-pair"]);
	assert.equal((await env.r("/api/devices/notices", { headers: { cookie: "__Host-cp_device=x" } })).status, 401, "an unpaired caller gets nothing");
	const fresh = env.pair("Tablet");
	assert.deepEqual((await notices(env, fresh.cookie)).notices.map((n) => n.name), ["Tablet"], "a remote device sees only the events naming it");
});

test("A9: notices carry each recipient's honest delivery state; an unreadable ledger is reported, never shown as delivered", async (t) => {
	const env = await remoteRig(t, { localDevices: true });
	const laptop = env.pair("Laptop");
	const phone = env.pair("Phone", "view");
	const report = await runDeviceNotifySweep({ stateDir: env.stateDir, dataDir: env.dataDir });
	assert.equal(report.waiting, 3);
	const body = await notices(env, phone.cookie);
	assert.equal(body.delivery_error, null);
	assert.deepEqual(body.notices[0]!.recipients.map((r) => [r.name, r.state, r.last_error]), [["Laptop", "unavailable", "push is not set up on this home"], ["Phone", "unavailable", "push is not set up on this home"]]);
	assert.ok(env.store.revoke(laptop.id).ok);
	await runDeviceNotifySweep({ stateDir: env.stateDir, dataDir: env.dataDir });
	assert.deepEqual((await notices(env, phone.cookie)).notices[0]!.recipients.map((r) => r.state), ["revoked", "unavailable"]);

	writeFileSync(deviceNotificationsFile(env.stateDir), "{ broken");
	const broken = await notices(env, phone.cookie);
	assert.equal(broken.delivery_error, "the pairing-alert delivery ledger is unreadable");
	assert.deepEqual(broken.notices[0]!.recipients.map((r) => r.state), ["unknown", "unknown"]);
	assert.equal((await env.r("/api/devices/notices", { headers: { cookie: laptop.cookie } })).status, 401, "a revoked device reads nothing");
	writeFileSync(`${env.dataDir}/devices.json`, "{ broken");
	assert.deepEqual([(await env.l("/api/devices/notices")).status, (await env.l("/api/devices/notices")).body], [503, { error: "store_invalid" }]);
});
