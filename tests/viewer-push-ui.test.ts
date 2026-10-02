import assert from "node:assert/strict";
import { build } from "esbuild";
import { join } from "node:path";
import { test } from "node:test";
import type { PushStatusResponse } from "../src/viewer/api-types.ts";
import { overview } from "../src/viewer/overview-view.ts";
import { base64UrlToBytes, disablePush, enablePush, type PushDeps, type PushEnv, pushMeta, type PushPhase, pushPhase, type PushSubscriptionLike, type PushView } from "../viewer-app/push.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const status: PushStatusResponse = { generated_at: "2026-09-27T00:00:00.000Z", configured: true, origin: "https://cp.example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), devices: 1, last_sent_at: null, undelivered_24h: 0, last_error: null };
const env: PushEnv = { secure: true, supported: true, ios: false, standalone: false, permission: "default" };

test("pushPhase: HTTPS first, then Home Screen on iOS, then support, setup, permission and subscription", () => {
	const phase = (e: Partial<PushEnv>, s: Partial<{ status: PushStatusResponse | null | undefined; subscribed: boolean | undefined; busy: boolean }> = {}) => pushPhase({ ...env, ...e }, { status, subscribed: false, busy: false, ...s });
	assert.equal(phase({ secure: false, ios: true }), "insecure");
	assert.equal(phase({ ios: true, supported: false }), "install");
	assert.equal(phase({ ios: true, standalone: true }), "off");
	assert.equal(phase({ ios: true, standalone: true }, { subscribed: true }), "on");
	assert.equal(phase({ supported: false }), "unsupported");
	assert.equal(phase({}, { status: undefined }), "checking");
	assert.equal(phase({}, { status: null }), "error");
	assert.equal(phase({}, { status: { ...status, configured: false } }), "unconfigured");
	assert.equal(phase({}, { busy: true }), "busy");
	assert.equal(phase({ permission: "denied" }), "denied");
	assert.equal(phase({}, { subscribed: undefined }), "checking");
	assert.equal(phase({ permission: "granted" }, { subscribed: true }), "on");
	assert.equal(phase({}), "off");
	assert.match(pushMeta("on", { ...status, undelivered_24h: 2, last_error: "HTTP 500" }), /On for this device · 1 device on this home · 2 undelivered in 24 h \(last: HTTP 500\)/);
	assert.match(pushMeta("install", status), /Home Screen/);
	assert.match(pushMeta("unconfigured", status), /npm run push:init/);
});

test("base64UrlToBytes decodes unpadded base64url", () => {
	const bytes = Buffer.from([0xfb, 0xff, 0xfe, 1, 2]);
	assert.deepEqual(Buffer.from(base64UrlToBytes(bytes.toString("base64url"))), bytes);
});

function fakes(options: { permission?: NotificationPermission; response?: () => Promise<Response>; existing?: boolean; hang?: boolean } = {}) {
	const calls: unknown[][] = [];
	let current: PushSubscriptionLike | null = null;
	const make = (): PushSubscriptionLike => ({
		endpoint: "https://fcm.googleapis.com/fcm/send/abc",
		toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } }),
		unsubscribe: async () => { calls.push(["unsubscribe"]); current = null; return true; },
	});
	if (options.existing) current = make();
	const registration = {
		pushManager: {
			getSubscription: async () => current,
			subscribe: async (o: { applicationServerKey: Uint8Array }) => { calls.push(["subscribe", o.applicationServerKey.length]); if (options.hang) return new Promise<never>(() => {}); current = make(); return current; },
		},
	};
	const deps: PushDeps = {
		env: () => env,
		requestPermission: async () => { calls.push(["requestPermission"]); return options.permission ?? "granted"; },
		register: async () => { calls.push(["register"]); return registration; },
		getRegistration: async () => registration,
		fetch: async (url, init) => { calls.push(["fetch", url, init?.method, init?.body]); return options.response ? options.response() : new Response(JSON.stringify({ subscribed: true, devices: 1 }), { status: 201 }); },
	};
	return { deps, calls, current: () => current };
}

test("enablePush asks first, subscribes with the VAPID key and stores it; a denial or a refused POST leaves nothing subscribed", async () => {
	const ok = fakes();
	assert.equal(await enablePush(ok.deps, status.public_key!), "on");
	assert.deepEqual(ok.calls.map((c) => c.slice(0, 3)), [["requestPermission"], ["register"], ["subscribe", 65], ["fetch", "/api/push/subscription", "POST"]]);
	assert.deepEqual(JSON.parse(String(ok.calls[3]?.[3])), { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } });
	const denied = fakes({ permission: "denied" });
	assert.equal(await enablePush(denied.deps, status.public_key!), "denied");
	assert.deepEqual(denied.calls, [["requestPermission"]]);
	const refused = fakes({ response: async () => new Response(JSON.stringify({ error: "already 10 subscribed devices" }), { status: 409 }) });
	await assert.rejects(enablePush(refused.deps, status.public_key!), /Not turned on: already 10 subscribed devices/);
	assert.equal(refused.current(), null);
	const offline = fakes({ response: async () => { throw new TypeError("offline"); } });
	await assert.rejects(enablePush(offline.deps, status.public_key!), /Could not reach this home/);
	assert.equal(offline.current(), null);
	const stalled = fakes({ hang: true });
	await assert.rejects(enablePush(stalled.deps, status.public_key!, 10), /push service did not answer/);
	assert.equal(stalled.calls.some((c) => c[0] === "fetch"), false);
});

test("disablePush removes the device from the home, then the browser; a failed DELETE still unsubscribes with a warning", async () => {
	const ok = fakes({ existing: true, response: async () => new Response("{}", { status: 200 }) });
	assert.deepEqual(await disablePush(ok.deps), {});
	assert.deepEqual(ok.calls.map((c) => c.slice(0, 3)), [["fetch", "/api/push/subscription", "DELETE"], ["unsubscribe"]]);
	const failed = fakes({ existing: true, response: async () => new Response("{}", { status: 500 }) });
	assert.match((await disablePush(failed.deps)).warning ?? "", /Removed here; the home drops it on its next push \(HTTP 500\)/);
	assert.equal(failed.current(), null);
	assert.deepEqual(await disablePush(fakes().deps), {});
});

test("More renders the Notifications control for every phase: a button only for on/off, the HTTPS link, the iOS steps, alerts, no inline style", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const result = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {More} from "./viewer-app/screens/More.tsx"; export const screen=(data,push)=>render(h(More,{data,push}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
	const { screen } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
	const data = overview({ home: home.path, stateDir: join(home.path, LAYOUT.state) });
	assert.doesNotMatch(screen(data), /Notifications/);
	const view = (phase: PushPhase, extra: Partial<PushView> = {}): string => screen(data, { phase, status, error: null, notice: null, toggle: () => {}, ...extra });
	assert.match(view("off"), /<h2 id="more-push-title">Notifications<\/h2>/);
	assert.match(view("off"), /<button type="button">Turn on<\/button>/);
	assert.match(view("on"), /<button type="button">Turn off<\/button>/);
	assert.match(view("busy"), /<button type="button" disabled>Working<\/button>/);
	for (const phase of ["checking", "insecure", "install", "unsupported", "unconfigured", "denied", "error"] as const) assert.doesNotMatch(view(phase), /<button/, phase);
	assert.match(view("insecure"), /href="https:\/\/cp\.example\.com\/#more">Open the HTTPS dashboard/);
	assert.match(view("install"), /Add to Home Screen/);
	assert.match(view("denied"), /Blocked in browser settings/);
	assert.match(view("off", { error: "Not turned on: HTTP 409" }), /<p role="alert" class="overview-error">Not turned on: HTTP 409<\/p>/);
	assert.match(view("off", { notice: "Removed here" }), /<p role="status" class="more-meta">Removed here<\/p>/);
	assert.doesNotMatch(view("off"), /style=/);
});
