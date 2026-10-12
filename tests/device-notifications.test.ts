import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { runDeviceNotifySweep } from "../src/push/device-notifications.ts";
import { initPush } from "../src/push/keys.ts";
import type { PushFetch, PushRequestInit } from "../src/push/webpush.ts";
import { controlJournalFile } from "../src/viewer/control-files.ts";
import type { DeviceLevel, IssuanceRoute } from "../src/viewer/device-files.ts";
import { type DeviceDelivery, deviceNotificationsFile, readDeviceNotifications } from "../src/viewer/device-notification-files.ts";
import { DeviceStore } from "../src/viewer/device-store.ts";
import { subscriptionFile, subscriptionId } from "../src/viewer/push-files.ts";
import { saveSubscription } from "../src/viewer/push-subscriptions.ts";
import { createScratchHome } from "./harness/index.ts";
import { type TestDevice, testDevice } from "./harness/push.ts";

const ORIGIN = "https://cp.example.test";

function bench(t: import("node:test").TestContext, configured = true) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const stateDir = join(scratch.path, LAYOUT.state);
	const dataDir = join(scratch.path, LAYOUT.data);
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	if (configured) initPush({ dataDir, origin: ORIGIN });
	let clock = new Date("2026-09-27T00:00:00Z");
	const store = new DeviceStore(dataDir, stateDir, { now: () => clock });
	const calls: Array<{ url: string; init: PushRequestInit }> = [];
	let respond: (url: string) => number | Promise<number> = () => 201;
	const fetch: PushFetch = async (url, init) => {
		calls.push({ url, init });
		return { status: await respond(url), text: async () => "" };
	};
	const browsers = new Map<string, TestDevice>();
	const lines: string[] = [];
	const pair = (name: string, route: IssuanceRoute = "cli-pair", level: DeviceLevel = "full") => {
		const issued = store.issueCode({ origin: ORIGIN, generation: 1, route, level });
		assert.ok(issued.ok);
		const claimed = store.claim({ origin: ORIGIN, generation: 1, code: issued.code, name });
		assert.ok(claimed.ok);
		return { id: claimed.device.id, pairing_id: claimed.pairing_id };
	};
	/** A browser enabling push for a device, through the ordinary owned-subscription path. */
	const subscribe = (deviceId: string, slug: string, origin = ORIGIN) => {
		const browser = testDevice(`https://fcm.googleapis.com/fcm/send/${slug}`);
		assert.ok(saveSubscription(dataDir, { endpoint: browser.endpoint, keys: browser.keys }, clock, { device_id: deviceId, origin }).ok);
		browsers.set(browser.endpoint, browser);
		return browser;
	};
	const sweep = () => runDeviceNotifySweep({ stateDir, dataDir, fetch, now: () => clock, log: (line) => lines.push(line) });
	const ledger = (): DeviceDelivery[] => {
		const read = readDeviceNotifications(stateDir);
		assert.notEqual(read.state, "invalid");
		return read.state === "invalid" ? [] : read.ledger.items;
	};
	const record = (pairing: string, device: string) => ledger().find((item) => item.pairing_id === pairing && item.device_id === device);
	/** Decrypted payloads since the last call, by endpoint slug. */
	const sent = () => calls.splice(0).map((call) => [call.url.split("/").pop(), JSON.parse(browsers.get(call.url)!.decrypt(Buffer.from(call.init.body)))] as const);
	return {
		stateDir, dataDir, store, calls, lines, pair, subscribe, sweep, ledger, record, sent,
		advance: (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000)),
		respondWith: (fn: typeof respond) => (respond = fn),
	};
}

test("A8/A9: a pairing through every issuer route alerts every active recipient — Full, View-only and the new device — audited under the same id, with no ask involved", async (t) => {
	const b = bench(t);
	const routes: IssuanceRoute[] = ["cli-up", "cli-pair", "loopback-dashboard", "tailnet-dashboard"];
	const paired: Array<{ id: string; pairing_id: string; slug: string }> = [];
	for (const [index, route] of routes.entries()) {
		const level: DeviceLevel = index % 2 === 0 ? "full" : "view";
		const device = b.pair(`Device ${index}`, route, level);
		const slug = `browser-${index}`;
		b.subscribe(device.id, slug); // the newly paired browser enables push before the next sweep
		paired.push({ ...device, slug });
		const report = await b.sweep();
		assert.deepEqual([report.attempted, report.delivered, report.error], [paired.length, paired.length, undefined], route);
		const shown = b.sent();
		assert.deepEqual(shown.map(([slug]) => slug).sort(), paired.map((p) => p.slug).sort(), `${route}: every recipient, the new device included`);
		for (const [, payload] of shown) assert.deepEqual(payload, { type: "pairing", id: device.pairing_id, name: `Device ${index}`, level, at: "2026-09-27T00:00:00.000Z" });
		for (const p of paired) assert.equal(b.record(device.pairing_id, p.id)?.state, "delivered");
	}
	const audit = readFileSync(controlJournalFile(b.stateDir), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(audit.filter((line) => line.event === "paired").map((line) => [line.pairing_id, line.route]), paired.map((p, i) => [p.pairing_id, routes[i]]));
	const raw = readFileSync(deviceNotificationsFile(b.stateDir), "utf8");
	assert.doesNotMatch(raw, /fcm\.googleapis|browser-|p256dh|auth|Device \d/, "no endpoint, key or name in the ledger");
	assert.equal(existsSync(join(b.stateDir, "push-deliveries.json")), false, "the ask ledger is never touched");

	await b.sweep();
	assert.equal(b.calls.length, 0, "settled records never resend");
	const failed = b.store.claim({ origin: ORIGIN, generation: 1, code: "x".repeat(43), name: "Replay" });
	assert.equal(failed.ok, false);
	await b.sweep();
	assert.deepEqual([b.calls.length, b.ledger().length], [0, 10], "a failed claim alerts nobody");
});

test("A9: push not set up is unavailable and no subscription is unsubscribed — both open, and delivered once fixed (no baseline)", async (t) => {
	const b = bench(t, false);
	const phone = b.pair("Phone", "cli-up", "view");
	let report = await b.sweep();
	assert.deepEqual([report.attempted, report.waiting], [0, 1]);
	assert.deepEqual([b.record(phone.pairing_id, phone.id)?.state, b.record(phone.pairing_id, phone.id)?.last_error], ["unavailable", "push is not set up on this home"]);
	initPush({ dataDir: b.dataDir, origin: ORIGIN });
	await b.sweep();
	assert.deepEqual([b.record(phone.pairing_id, phone.id)?.state, b.record(phone.pairing_id, phone.id)?.last_error], ["unsubscribed", "no push subscription on this device"]);
	b.subscribe(phone.id, "old", "https://old.trycloudflare.com");
	await b.sweep();
	assert.equal(b.record(phone.pairing_id, phone.id)?.last_error, "its push subscription is for another origin");
	const file = deviceNotificationsFile(b.stateDir);
	const before = readFileSync(file, "utf8");
	b.advance(60);
	await b.sweep();
	assert.equal(readFileSync(file, "utf8"), before, "an idle sweep writes nothing");
	b.subscribe(phone.id, "phone");
	report = await b.sweep();
	assert.equal(report.delivered, 1);
	assert.deepEqual(b.sent().map(([slug]) => slug), ["phone"]);
	assert.equal(b.record(phone.pairing_id, phone.id)?.state, "delivered");
});

test("A9: an outage retries on the ask backoff and fails visibly after five attempts; gone marks the subscription unusable here and never deletes it", async (t) => {
	const b = bench(t);
	const laptop = b.pair("Laptop");
	const browser = b.subscribe(laptop.id, "laptop");
	b.respondWith(() => 503);
	await b.sweep();
	for (const wait of [30, 60, 120, 240]) {
		assert.equal(b.record(laptop.pairing_id, laptop.id)?.state, "retrying");
		b.advance(wait - 1);
		assert.equal((await b.sweep()).attempted, 0, `not before ${wait}s`);
		b.advance(1);
		await b.sweep();
	}
	const exhausted = b.record(laptop.pairing_id, laptop.id);
	assert.deepEqual([exhausted?.state, exhausted?.attempts, b.calls.length], ["failed", 5, 5]);
	assert.match(exhausted?.last_error ?? "", /retry: HTTP 503/);

	b.calls.length = 0;
	b.respondWith(() => 410);
	const phone = b.pair("Phone");
	await b.sweep();
	assert.equal(b.record(phone.pairing_id, laptop.id)?.state, "failed");
	assert.match(b.record(phone.pairing_id, laptop.id)?.last_error ?? "", /gone: HTTP 410, subscription unusable/);
	assert.equal(existsSync(subscriptionFile(b.dataDir, subscriptionId(browser.endpoint))), true, "never deleted by this sender");
	b.pair("Tablet");
	await b.sweep();
	assert.equal(b.calls.length, 1, "an unusable subscription is never sent to again");
	assert.match(b.lines.join("\n"), /^pairing alert pair-[0-9a-f]{16} → dev-[0-9a-f]{16} \([0-9a-f]{8}\): retry/m);
});

test("A9: eligibility is re-read before each retry — a send in flight at revoke time is not recalled, but no new one starts; an expired recipient gets none", async (t) => {
	const b = bench(t);
	const laptop = b.pair("Laptop");
	const phone = b.pair("Phone", "cli-pair", "view");
	b.subscribe(laptop.id, "laptop");
	b.subscribe(phone.id, "phone");
	b.respondWith((url) => {
		if (url.endsWith("phone")) assert.ok(b.store.revoke(phone.id).ok); // the revoke lands while this send is in flight
		return 500;
	});
	await b.sweep();
	assert.deepEqual(b.sent().map(([slug]) => slug).sort(), ["laptop", "laptop", "phone"], "both pairings' first attempts went out");
	b.respondWith(() => 201);
	b.advance(30);
	await b.sweep();
	assert.deepEqual(b.sent().map(([slug]) => slug), ["laptop", "laptop"], "the retry skips the revoked device");
	const revoked = b.record(b.ledger().find((item) => item.device_id === phone.id)!.pairing_id, phone.id);
	assert.deepEqual([revoked?.state, revoked?.last_error], ["revoked", "the device was revoked before delivery"]);

	const tablet = b.pair("Tablet");
	b.advance(31 * 24 * 3600);
	const report = await b.sweep();
	assert.deepEqual([report.attempted, b.calls.length], [0, 0]);
	assert.deepEqual([b.record(tablet.pairing_id, laptop.id)?.state, b.record(tablet.pairing_id, tablet.id)?.state], ["expired", "expired"]);
});

test("a malformed ledger or device store stops the sender loudly and is never reset; sweeps never overlap", async (t) => {
	const b = bench(t);
	const laptop = b.pair("Laptop");
	b.subscribe(laptop.id, "laptop");
	writeFileSync(deviceNotificationsFile(b.stateDir), '{"schema_version":1,"items":[],"unusable":["nope"]}');
	const report = await b.sweep();
	assert.match(report.error ?? "", /device-notification-deliveries\.json is malformed \(unusable\); refusing to guess/);
	assert.equal(readFileSync(deviceNotificationsFile(b.stateDir), "utf8"), '{"schema_version":1,"items":[],"unusable":["nope"]}');
	assert.equal(b.calls.length, 0);

	writeFileSync(deviceNotificationsFile(b.stateDir), '{"schema_version":1,"items":[],"unusable":[]}');
	let release: (status: number) => void = () => {};
	b.respondWith(() => new Promise<number>((resolve) => (release = resolve)));
	const first = b.sweep();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(b.record(b.ledger()[0]!.pairing_id, laptop.id)?.state, "pending", "recorded before the network call");
	assert.deepEqual(await b.sweep(), { attempted: 0, delivered: 0, retrying: 0, failed: 0, waiting: 0, ended: 0, busy: true });
	release(201);
	assert.equal((await first).delivered, 1);
});
