/** P12 (behavior 16), slice 3: paired devices through real processes — `bin/cp-view` (owner socket, local and remote
 * listeners), the `device-notify` sender cp-daemon runs, `bin/cp-tunnel`, and a stand-in push service behind
 * tests/harness/fake-fetch.ts. Tunnel records are seeded on disk; tests/e2e/remote-tunnel.test.ts drives cloudflared.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { type AddressInfo, createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { deviceNotifyLeaseFile } from "../../src/push/device-notify.ts";
import { initPush } from "../../src/push/keys.ts";
import { daemonPaths } from "../../src/service/daemon-files.ts";
import { tunnelConfigFile, tunnelRuntimeFile } from "../../src/service/daemon-tunnel-files.ts";
import type { DeviceNoticesResponse } from "../../src/viewer/api-types.ts";
import { controlJournalFile } from "../../src/viewer/control-files.ts";
import { DEVICE_FRAME_MAX, deviceControlDir, deviceControlLockFile, deviceControlRecordFile, deviceControlRequest, deviceControlSocket } from "../../src/viewer/device-control.ts";
import { devicesFile } from "../../src/viewer/device-files.ts";
import { deviceNotificationsFile } from "../../src/viewer/device-notification-files.ts";
import { subscriptionFile, subscriptionId } from "../../src/viewer/push-files.ts";
import { saveSubscription } from "../../src/viewer/push-subscriptions.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { type TestDevice, testDevice } from "../harness/push.ts";
import { call, type Init } from "../harness/remote.ts";

const ORIGIN = "https://amber-otter.trycloudflare.com";
const DAY = 86_400_000;
const HOOKS = ["process-clock.ts", "fake-fetch.ts"].map((file) => `--import ${pathToFileURL(join(REPO_ROOT, "tests/harness", file)).href}`).join(" ");
const ROOT = process.getuid?.() === 0; // root ignores the read-only directories some steps use
type Item = { pairing_id: string; device_id: string; state: string; attempts: number; last_error?: string; updated_at: string; next_attempt_at?: string };
type Proc = { child: ChildProcess; out: () => string; exited: Promise<number | null> };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const freePort = (): Promise<number> =>
	new Promise((done) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => done(port));
		});
	});
async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
	let last: T | undefined;
	for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
		last = await read();
		if (ok(last)) return last;
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}
const json = (file: string): Record<string, unknown> | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};
const codeOf = (link: unknown): string => String(link).split("#")[1]!;
const mode = (path: string) => statSync(path).mode & 0o777;
/** Raw bytes to the owner socket; resolves with everything it said before closing, or within five seconds. */
const raw = (path: string, data: string): Promise<string> =>
	new Promise((done) => {
		const socket = createConnection(path);
		let text = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => (text += chunk));
		socket.on("close", () => done(text));
		socket.on("error", () => {});
		socket.once("connect", () => socket.write(data));
		setTimeout(() => socket.destroy(), 5_000).unref();
	});

/**
 * A scratch home with the tunnel's records seeded (quick, running, generation 1) and push set up unless `push: false`;
 * nothing started. Every child shares one shifted clock (`advance`) and reaches https only through `posts`/`answer`.
 */
async function rig(t: TestContext, { push = true } = {}) {
	const scratch = createScratchHome();
	const home = scratch.path, { stateDir, dataDir } = daemonPaths(home);
	for (const dir of [stateDir, dataDir]) mkdirSync(dir, { recursive: true });
	let [localPort, remotePort] = [await freePort(), await freePort()];
	const clock = join(home, "clock-offset-ms");
	writeFileSync(clock, "0");
	const posts: Array<{ slug: string; body: Buffer }> = [];
	let answer: (slug: string) => number | Promise<number> = () => 201;
	const service = httpServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const slug = String(req.url).split("/").pop()!;
			posts.push({ slug, body: Buffer.concat(chunks) });
			res.writeHead(await answer(slug)).end();
		});
	});
	await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
	const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CP_HOME: home, NODE_OPTIONS: HOOKS, CP_TEST_CLOCK_FILE: clock, CP_TEST_FETCH_BASE: `http://127.0.0.1:${(service.address() as AddressInfo).port}` };
	const procs: Proc[] = [];
	t.after(async () => {
		for (const proc of procs) if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGKILL");
		await Promise.all(procs.map((proc) => proc.exited));
		service.close();
		scratch.cleanup();
	});
	const start = (file: string, argv: string[]): Proc => {
		const child = spawn(file, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
		let text = "";
		child.stdout!.on("data", (chunk) => (text += chunk));
		child.stderr!.on("data", (chunk) => (text += chunk));
		const proc = { child, out: () => text, exited: new Promise<number | null>((done) => child.once("exit", (code) => done(code))) };
		procs.push(proc);
		return proc;
	};
	const bind = (generation = 1, runtime: Record<string, unknown> = {}) => {
		writeFileSync(tunnelConfigFile(dataDir), JSON.stringify({ schema_version: 1, enabled: true, mode: "quick", port: remotePort, binary: "/opt/cf/cloudflared", revision: 1 }));
		writeFileSync(tunnelRuntimeFile(stateDir), JSON.stringify({ schema_version: 1, origin: ORIGIN, generation, revision: 1, state: "running", mode: "quick", port: remotePort, pid: process.pid, binary: "/opt/cf/cloudflared", argv: ["tunnel"], updated_at: new Date().toISOString(), ...runtime }));
	};
	bind();
	if (push) initPush({ dataDir, origin: ORIGIN });
	let peer = 0;
	const r = (path: string, init: Init = {}) => {
		peer += 1; // one client address per request: the claim and cookie limiters count per address
		return call(remotePort, path, { ...init, headers: { "cf-connecting-ip": `203.0.${Math.floor(peer / 250)}.${(peer % 250) + 1}`, ...init.headers } });
	};
	const l = (path: string, init: Init = {}) => call(localPort, path, init);
	const token = async () => String((await l("/api/devices")).body.token);
	const create = async (level?: string, given?: string) => l("/api/pair/create", { method: "POST", headers: { origin: `http://127.0.0.1:${localPort}`, "content-type": "application/json", "x-cp-control-token": given ?? (await token()) }, body: JSON.stringify(level ? { level } : {}) });
	const issue = async (level?: string) => {
		const reply = await create(level);
		assert.equal(reply.status, 201, reply.text);
		return codeOf(reply.body.link);
	};
	const claim = (code: string, name: unknown, extra: Record<string, unknown> = {}) => r("/api/pair/claim", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code, name, ...extra }) });
	const pair = async (name: string, level = "full", code?: string) => {
		const reply = await claim(code ?? (await issue(level)), name);
		assert.equal(reply.status, 200, reply.text);
		const cookie = String(reply.headers["set-cookie"]).split(";")[0]!;
		return { cookie, id: cookie.split("=")[1]!.split(".")[0]!, setCookie: String(reply.headers["set-cookie"]) };
	};
	const browsers = new Map<string, TestDevice>();
	const subscribe = async (device: { cookie: string }, slug: string) => {
		const browser = testDevice(`https://fcm.googleapis.com/fcm/send/${slug}`);
		browsers.set(slug, browser);
		const reply = await r("/api/push/subscription", { method: "POST", headers: { cookie: device.cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ endpoint: browser.endpoint, keys: browser.keys }) });
		assert.equal(reply.status, 201, reply.text);
		return browser;
	};
	const ledger = () => (json(deviceNotificationsFile(stateDir))?.items ?? []) as Item[];
	let first = true;
	/** The rig's first default-port viewer re-picks both ports and restarts, up to 3 tries, when it exits on a lost port. */
	const viewer = (port?: number): Proc => {
		const launch = () => start(join(REPO_ROOT, "bin/cp-view"), ["--home", home, "--host", "127.0.0.1", "--port", String(port ?? localPort)]);
		let current = launch();
		if (port !== undefined || !first) return current;
		first = false;
		const retry = (attempt: number) => void current.exited.then(async () => {
			if (attempt >= 3 || current.child.signalCode !== null || !current.out().includes("EADDRINUSE")) return;
			[localPort, remotePort] = [await freePort(), await freePort()];
			bind();
			current = launch();
			retry(attempt + 1);
		});
		retry(1);
		return { get child() { return current.child; }, out: () => current.out(), get exited() { return current.exited; } };
	};
	return {
		home, stateDir, dataDir, get localPort() { return localPort; }, get remotePort() { return remotePort; }, posts, bind, r, l, token, create, issue, claim, pair, subscribe, ledger, viewer,
		answer: (fn: typeof answer) => (answer = fn),
		advance: (ms: number) => writeFileSync(clock, String(Number(readFileSync(clock, "utf8")) + ms)),
		sender: () => start(process.execPath, [join(REPO_ROOT, "src/push/device-notify.ts")]),
		/** Waits for the remote listener's line for `generation`, printed after byte `from` of the viewer's output. */
		listening: (proc: Proc, generation = 1, from = 0) => until(() => proc.out().slice(from), (out) => out.includes(`listening on 127.0.0.1:${remotePort} for ${ORIGIN} (generation ${generation},`), `the remote listener (generation ${generation})\n${proc.out()}`),
		stop: async (proc: Proc) => (proc.child.kill("SIGKILL"), await proc.exited),
		socket: (op: string, args: Record<string, unknown> = {}) => deviceControlRequest(stateDir, op, args),
		tunnel: (...argv: string[]) => {
			const proc = start(join(REPO_ROOT, "bin/cp-tunnel"), [...argv, "--home", home]);
			return proc.exited.then((code) => ({ code, out: proc.out() }));
		},
		events: async () => (await l("/api/devices")).body.events as Array<{ id: string; device_id: string; at: string; route: string; recipients: string[] }>,
		record: (pairing: string, device: string) => ledger().find((item) => item.pairing_id === pairing && item.device_id === device),
		/** Decrypted payloads since the last call, by endpoint slug. */
		sent: () => posts.splice(0).map(({ slug, body }) => [slug, JSON.parse(browsers.get(slug)!.decrypt(body))] as const),
		journal: () => readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row) as Record<string, unknown>),
		devices: () => json(devicesFile(dataDir)) as { devices: Array<Record<string, unknown>>; codes: unknown[]; events: Array<Record<string, unknown>> },
	};
}
type Rig = Awaited<ReturnType<typeof rig>>;
const eventOf = async (s: Rig, device: { id: string }) => (await s.events()).find((event) => event.device_id === device.id)!;

test("P12c-alerts: the sender alerts every active recipient of each issuer route's pairing, never resends, and holds one lease", async (t) => {
	const s = await rig(t);
	await s.listening(s.viewer());
	// A reused pid: the lease names a live process that is not a sender, so it is stale and replaced.
	const reused = spawn("sleep", ["600"], { stdio: "ignore" });
	t.after(() => void reused.kill("SIGKILL"));
	writeFileSync(deviceNotifyLeaseFile(s.stateDir), JSON.stringify({ pid: reused.pid }));
	const sender = s.sender();
	const routes: Array<[string, (level: string) => Promise<string>]> = [
		["cli-up", async (level) => codeOf(((await s.socket("pair", { route: "cli-up", level })) as { result: { link: string } }).result.link)],
		["cli-pair", async (level) => codeOf(((await s.socket("pair", { level })) as { result: { link: string } }).result.link)],
		["loopback-dashboard", (level) => s.issue(level)],
	];
	const paired: Array<{ id: string; slug: string }> = [];
	for (const [index, [route, mint]] of routes.entries()) {
		const level = index % 2 === 0 ? "full" : "view";
		const device = await s.pair(`Device ${index}`, level, await mint(level));
		await s.subscribe(device, `browser-${index}`); // the new browser enables push right after pairing
		paired.push({ id: device.id, slug: `browser-${index}` });
		const event = await eventOf(s, device);
		await until(() => paired.map((p) => s.record(event.id, p.id)?.state), (states) => states.every((state) => state === "delivered"), `${route} delivered`);
		const shown = s.sent();
		assert.deepEqual(shown.map(([slug]) => slug).sort(), paired.map((p) => p.slug).sort(), `${route}: every recipient, the new device included`);
		for (const [, payload] of shown) assert.deepEqual(payload, { type: "pairing", id: event.id, name: `Device ${index}`, level, at: event.at });
	}
	assert.equal(JSON.parse(readFileSync(deviceNotifyLeaseFile(s.stateDir), "utf8")).pid, sender.child.pid, "the reused pid's lease was replaced");
	const audit = s.journal().filter((line) => line.event === "paired");
	assert.deepEqual(audit.map((line) => line.route), routes.map(([route]) => route), "audited under each issuer route");
	assert.deepEqual(new Set(audit.map((line) => line.pairing_id)), new Set((await s.events()).map((event) => event.id)), "the same id as the event");
	assert.doesNotMatch(readFileSync(deviceNotificationsFile(s.stateDir), "utf8"), /fcm\.googleapis|browser-|p256dh|auth|Device \d/, "no endpoint, key or name in the ledger");
	assert.equal(existsSync(join(s.stateDir, "push-deliveries.json")), false, "the ask ledger is never touched");

	assert.equal((await s.claim("x".repeat(43), "Replay")).status, 403);
	await sleep(6_000); // past a sweep
	assert.deepEqual([s.posts.length, s.ledger().length], [0, 6], "settled records never resend; a failed claim alerts nobody");
	const second = s.sender();
	assert.equal(await second.exited, 1);
	assert.match(second.out(), new RegExp(`another pairing-alert sender \\(pid ${sender.child.pid}\\) holds`));
	sender.child.kill("SIGTERM");
	assert.equal(await sender.exited, 0);
	assert.equal(existsSync(deviceNotifyLeaseFile(s.stateDir)), false, "its lease is released");
});

test("P12c-retry: an outage retries on the ask backoff until it fails; gone is unusable here; a revoke or an expiry stops new sends", async (t) => {
	const s = await rig(t);
	await s.listening(s.viewer());
	const laptop = await s.pair("Laptop");
	const browser = await s.subscribe(laptop, "laptop");
	const own = (await eventOf(s, laptop)).id;
	s.answer(() => 503);
	let sender = s.sender();
	await until(() => s.record(own, laptop.id)?.attempts, (attempts) => attempts === 1, "the first attempt");
	for (const [index, wait] of [30, 60, 120, 240].entries()) {
		const item = s.record(own, laptop.id)!;
		assert.equal(item.state, "retrying");
		assert.equal(Date.parse(item.next_attempt_at!) - Date.parse(item.updated_at), wait * 1000, `the ask backoff: ${wait}s`);
		if (index === 0) {
			await sleep(6_000);
			assert.equal(s.record(own, laptop.id)?.attempts, 1, "not before its time");
		}
		s.advance(wait * 1000);
		await until(() => s.record(own, laptop.id)?.attempts, (attempts) => attempts === index + 2, `attempt ${index + 2}`);
	}
	const exhausted = s.record(own, laptop.id);
	assert.deepEqual([exhausted?.state, exhausted?.attempts, s.posts.length], ["failed", 5, 5]);
	assert.match(exhausted?.last_error ?? "", /retry: HTTP 503/);
	assert.match(sender.out(), /pairing alert pair-[0-9a-f]{16} → dev-[0-9a-f]{16} \([0-9a-f]{8}\): retry/);

	s.posts.length = 0;
	s.answer(() => 410);
	const phone = await s.pair("Phone");
	const phoned = (await eventOf(s, phone)).id;
	await until(() => s.record(phoned, laptop.id)?.state, (state) => state === "failed", "gone");
	assert.match(s.record(phoned, laptop.id)?.last_error ?? "", /gone: HTTP 410, subscription unusable/);
	assert.equal(existsSync(subscriptionFile(s.dataDir, subscriptionId(browser.endpoint))), true, "never deleted by the sender");
	const tablet = await s.pair("Tablet");
	const tableted = (await eventOf(s, tablet)).id;
	await until(() => s.record(tableted, laptop.id)?.last_error, (error) => error === "its push subscription was refused as gone; enable notifications again", "unusable");
	assert.equal(s.posts.length, 1, "an unusable subscription is never sent to again");

	// The revoke lands while Pad's first send is in flight: that send is not recalled, but its retry never starts.
	s.posts.length = 0;
	s.answer(async (slug) => {
		if (slug === "pad") assert.ok((await s.socket("revoke", { target: "Pad" })).ok);
		return 500;
	});
	const desk = await s.pair("Desk");
	await s.subscribe(desk, "desk");
	const pad = await s.pair("Pad", "view");
	await s.subscribe(pad, "pad");
	const padded = (await eventOf(s, pad)).id;
	await until(() => s.posts.map((post) => post.slug).sort().join(), (slugs) => slugs === "desk,desk,pad", "both pairings' first attempts");
	s.posts.length = 0;
	s.answer(() => 201);
	s.advance(30_000);
	await until(() => s.record(padded, desk.id)?.state, (state) => state === "delivered", "the retry");
	await until(() => s.record(padded, pad.id)?.state, (state) => state === "revoked", "the revoked recipient settled");
	assert.deepEqual(s.posts.map((post) => post.slug), ["desk", "desk"], "the retry skips the revoked device");
	assert.equal(s.record(padded, pad.id)?.last_error, "the device was revoked before delivery");

	// A pairing whose recipients are all past their 30-day session by the next sweep gets no push.
	sender.child.kill("SIGTERM");
	assert.equal(await sender.exited, 0);
	const slate = await s.pair("Slate");
	const slated = (await eventOf(s, slate)).id;
	s.advance(31 * DAY);
	s.posts.length = 0;
	sender = s.sender();
	await until(() => [s.record(slated, desk.id)?.state, s.record(slated, slate.id)?.state], (states) => states.join() === "expired,expired", "expired");
	assert.equal(s.posts.length, 0);
});

test("P12c-waiting: push not set up and no usable subscription stay open, an idle sweep writes nothing, and a later subscription gets the alert", async (t) => {
	const s = await rig(t, { push: false });
	await s.listening(s.viewer());
	s.sender();
	const phone = await s.pair("Phone", "view");
	const own = (await eventOf(s, phone)).id;
	const settled = (error: string) => until(() => s.record(own, phone.id), (item) => item?.last_error === error, error);
	assert.equal((await settled("push is not set up on this home"))?.state, "unavailable");
	initPush({ dataDir: s.dataDir, origin: ORIGIN });
	assert.equal((await settled("no push subscription on this device"))?.state, "unsubscribed");
	// A subscription left on disk from an older quick origin.
	const old = testDevice("https://fcm.googleapis.com/fcm/send/old");
	assert.ok(saveSubscription(s.dataDir, { endpoint: old.endpoint, keys: old.keys }, new Date(), { device_id: phone.id, origin: "https://old.trycloudflare.com" }).ok);
	await settled("its push subscription is for another origin");
	const before = readFileSync(deviceNotificationsFile(s.stateDir), "utf8");
	s.advance(60_000);
	await sleep(6_000);
	assert.equal(readFileSync(deviceNotificationsFile(s.stateDir), "utf8"), before, "an idle sweep writes nothing");
	await s.subscribe(phone, "phone");
	await until(() => s.record(own, phone.id)?.state, (state) => state === "delivered", "delivered once subscribed");
	assert.deepEqual(s.sent().map(([slug]) => slug), ["phone"]);
});

test("P12c-sender-closed: a bad binding, ledger or store sends nothing; the binding is the last published one; a sweep in flight is waited out", async (t) => {
	const s = await rig(t);
	const lease = deviceNotifyLeaseFile(s.stateDir);
	const view = s.viewer();
	await s.listening(view);
	const laptop = await s.pair("Laptop");
	await s.subscribe(laptop, "laptop");
	const own = (await eventOf(s, laptop)).id;
	const kiosk = await s.pair("Kiosk"); // pairing needs a readable runtime, so it happens first
	const kioskOwn = (await eventOf(s, kiosk)).id;
	writeFileSync(lease, JSON.stringify({ pid: 999_999_999 })); // a dead holder
	writeFileSync(tunnelRuntimeFile(s.stateDir), "{torn");
	const started = Date.now();
	let sender = s.sender();
	const unreadable = () => sender.out().split("\n").filter((line) => line.includes("pairing alerts stopped: the tunnel runtime is unreadable")).length;
	await until(unreadable, (count) => count === 1, "fail closed");
	assert.ok(Date.now() - started < 4_000, `the first sweep runs at start, not after an interval (${Date.now() - started} ms)`);
	assert.equal(JSON.parse(readFileSync(lease, "utf8")).pid, sender.child.pid, "a dead holder's lease is replaced");
	assert.deepEqual([s.record(own, laptop.id)?.state, s.posts.length], ["pending", 0], "no push on a guess, nothing settled");
	for (const bad of [{ schema_version: 2, generation: 1, origin: null }, { schema_version: 1, generation: 1.5, origin: null }, { schema_version: 1, generation: 1, origin: "http://abc.trycloudflare.com" }]) {
		const count = unreadable();
		writeFileSync(tunnelRuntimeFile(s.stateDir), JSON.stringify(bad));
		await until(unreadable, (now) => now === count + 1, JSON.stringify(bad));
	}
	assert.equal(unreadable(), 4, "each refused sweep is reported once, and the next sweep runs after it settles");
	assert.equal(s.posts.length, 0);
	// A starting runtime (generation 0, origin null) or no runtime file at all is no binding: judged on its own.
	writeFileSync(tunnelRuntimeFile(s.stateDir), JSON.stringify({ schema_version: 1, generation: 0, origin: null }));
	await until(() => s.record(own, laptop.id)?.state, (state) => state === "delivered", "delivered with a starting runtime");
	const torn = unreadable();
	writeFileSync(tunnelRuntimeFile(s.stateDir), "{torn");
	await until(unreadable, (count) => count === torn + 1, "the torn runtime refused before the kiosk subscription");
	const pad = testDevice("https://fcm.googleapis.com/fcm/send/kiosk"); // stored directly: the listener is down now
	assert.ok(saveSubscription(s.dataDir, { endpoint: pad.endpoint, keys: pad.keys }, new Date(), { device_id: kiosk.id, origin: ORIGIN }).ok);
	rmSync(tunnelRuntimeFile(s.stateDir));
	await until(() => s.record(kioskOwn, kiosk.id)?.state, (state) => state === "delivered", "delivered with no runtime file");

	sender.child.kill("SIGTERM");
	assert.equal(await sender.exited, 0);
	const mark = view.out().length;
	s.bind();
	await s.listening(view, 1, mark);
	const tablet = await s.pair("Tablet");
	await s.subscribe(tablet, "tablet");
	const tableted = (await eventOf(s, tablet)).id;
	// A stopped tunnel's last published binding still counts: generation 2 ends both generation-1 sessions.
	s.bind(2, { state: "stopped", pid: undefined });
	writeFileSync(lease, "{torn");
	s.posts.length = 0;
	sender = s.sender();
	await until(() => [s.record(tableted, laptop.id)?.state, s.record(tableted, tablet.id)?.state].join(), (states) => states === "expired,expired", "another generation is expired");
	assert.equal(JSON.parse(readFileSync(lease, "utf8")).pid, sender.child.pid, "a torn lease names no holder");
	assert.deepEqual([s.record(tableted, laptop.id)?.state, s.record(tableted, tablet.id)?.state, s.posts.length], ["expired", "expired", 0]);

	// A malformed ledger or device store stops the sender loudly and is never reset.
	const malformed = '{"schema_version":1,"items":[],"unusable":["nope"]}';
	writeFileSync(deviceNotificationsFile(s.stateDir), malformed);
	await until(sender.out, (out) => /device-notification-deliveries\.json is malformed \(unusable\); refusing to guess/.test(out), "the ledger refusal");
	const store = readFileSync(devicesFile(s.dataDir), "utf8");
	writeFileSync(devicesFile(s.dataDir), "{ broken");
	await until(sender.out, (out) => /pairing alerts not sent: .*devices\.json/.test(out), "the store refusal");
	assert.deepEqual([readFileSync(deviceNotificationsFile(s.stateDir), "utf8"), readFileSync(devicesFile(s.dataDir), "utf8"), s.posts.length], [malformed, "{ broken", 0]);
	writeFileSync(devicesFile(s.dataDir), store);
	writeFileSync(deviceNotificationsFile(s.stateDir), '{"schema_version":1,"items":[],"unusable":[]}');

	// A send held by the push service: recorded first, never overlapped by the next sweep, waited out by SIGTERM.
	let release: (status: number) => void = () => {};
	s.answer(() => new Promise<number>((done) => (release = done)));
	s.bind(2);
	await s.listening(view, 2);
	const desk = await s.pair("Desk");
	await s.subscribe(desk, "desk");
	const desked = (await eventOf(s, desk)).id;
	await until(() => s.posts.length, (count) => count === 1, "the held send");
	assert.equal(s.record(desked, desk.id)?.state, "pending", "recorded before the network call");
	await sleep(6_000);
	assert.equal(s.posts.length, 1, "no second sweep starts while one is in flight");
	sender.child.kill("SIGTERM");
	await sleep(1_000);
	assert.equal(sender.child.exitCode, null, "stop waits out the sweep in flight");
	release(201);
	assert.equal(await sender.exited, 0);
	assert.equal(s.record(desked, desk.id)?.state, "delivered");
	assert.equal(existsSync(lease), false);

	// A release never removes a lease that names another holder.
	sender = s.sender();
	await until(() => json(lease)?.pid, (pid) => pid === sender.child.pid, "the next lease");
	writeFileSync(lease, JSON.stringify({ pid: 999_999_999 }));
	sender.child.kill("SIGTERM");
	assert.equal(await sender.exited, 0);
	assert.equal(json(lease)?.pid, 999_999_999, "a stale holder's release never removes the new lease");
});

test("P12c-notices: each issuer route's pairing is a notice for every recipient with its honest delivery state; unreadable is never delivered", async (t) => {
	const s = await rig(t, { push: false });
	const view = s.viewer();
	await s.listening(view);
	const laptop = await s.pair("Laptop");
	const phone = await s.pair("Phone", "view");
	const notices = async (cookie?: string) => {
		const reply = cookie ? await s.r("/api/devices/notices", { headers: { cookie } }) : await s.l("/api/devices/notices");
		assert.equal(reply.status, 200, reply.text);
		return reply.body as unknown as DeviceNoticesResponse;
	};
	const mints: Array<[string, () => Promise<string>]> = [
		["cli-up", async () => codeOf(((await s.socket("pair", { route: "cli-up" })) as { result: { link: string } }).result.link)],
		["cli-pair", async () => codeOf(((await s.socket("pair", { level: "view" })) as { result: { link: string } }).result.link)],
		["loopback-dashboard", () => s.issue()],
	];
	const paired: string[] = [];
	for (const [route, mint] of mints) {
		const name = `New ${route}`;
		const device = await s.pair(name, "full", await mint());
		paired.push(device.id);
		for (const cookie of [laptop.cookie, phone.cookie, device.cookie]) {
			const top = (await notices(cookie)).notices[0]!;
			assert.deepEqual([top.name, top.route, top.device_id], [name, route, device.id], `${route}: newest first, on every device`);
			assert.deepEqual(top.recipients.map((r) => [r.device_id, r.state]), [laptop.id, phone.id, ...paired].map((id) => [id, "pending"]), `${route}: View-only and the new device included`);
			assert.doesNotMatch(JSON.stringify(top), /digest|cookie|code|secret/);
		}
	}
	assert.deepEqual((await notices()).notices.map((n) => n.route), ["loopback-dashboard", "cli-pair", "cli-up", "loopback-dashboard", "loopback-dashboard"]);
	assert.equal((await s.r("/api/devices/notices", { headers: { cookie: "__Host-cp_device=x" } })).status, 401, "an unpaired caller gets nothing");
	const fresh = await s.pair("Tablet");
	assert.deepEqual((await notices(fresh.cookie)).notices.map((n) => n.name), ["Tablet"], "a remote device sees only the events naming it");

	const sweeper = s.sender();
	const states = async () => (await notices(phone.cookie)).notices.find((n) => n.name === "Phone")!.recipients.map((r) => [r.name, r.state, r.last_error]);
	await until(states, (rows) => rows.every((row) => row[1] === "unavailable"), "the sender's states");
	assert.deepEqual(await states(), [["Laptop", "unavailable", "push is not set up on this home"], ["Phone", "unavailable", "push is not set up on this home"]]);
	assert.ok((await s.socket("revoke", { target: laptop.id })).ok);
	await until(states, (rows) => rows.map((row) => row[1]).join() === "revoked,unavailable", "revoked");
	// Stop waits out a sweep in flight; a later sweep could rewrite the ledger after the corruption.
	sweeper.child.kill("SIGTERM");
	assert.equal(await sweeper.exited, 0);
	writeFileSync(deviceNotificationsFile(s.stateDir), "{ broken");
	const broken = await notices(phone.cookie);
	assert.equal(broken.delivery_error, "the pairing-alert delivery ledger is unreadable");
	assert.ok(broken.notices.every((n) => n.recipients.every((r) => r.state === "unknown")), "never shown as delivered");
	assert.equal((await s.r("/api/devices/notices", { headers: { cookie: laptop.cookie } })).status, 401, "a revoked device reads nothing");
	writeFileSync(devicesFile(s.dataDir), "{ broken");
	const local = await s.l("/api/devices/notices");
	assert.deepEqual([local.status, local.body], [503, { error: "store_invalid" }]);
});

test("P12c-socket: the viewer's owner socket is owner-only, typed and bounded; one live owner, a stale one replaced, a held lock named", async (t) => {
	const s = await rig(t);
	const sock = deviceControlSocket(s.stateDir), record = deviceControlRecordFile(s.stateDir), lock = deviceControlLockFile(s.stateDir);
	const first = s.viewer();
	await s.listening(first);
	assert.deepEqual([mode(deviceControlDir(s.stateDir)), mode(record), mode(sock)], [0o700, 0o600, 0o600]);
	const ok = async (op: string, args: Record<string, unknown> = {}) => {
		const reply = await s.socket(op, args);
		assert.ok(reply.ok, JSON.stringify(reply));
		return reply.result as Record<string, unknown>;
	};
	assert.deepEqual(await ok("status"), { pid: first.child.pid, running: true, origin: ORIGIN, generation: 1, revision: 1, port: s.remotePort });
	const paired = await ok("pair", { level: "view" });
	assert.match(String(paired.link), new RegExp(`^${ORIGIN}/pair#[A-Za-z0-9_-]{43}$`));
	assert.equal(paired.level, "view");
	assert.deepEqual(s.journal().map((line) => [line.event, line.route]), [["code_issued", "cli-pair"]], "one secret-free line names the CLI route");
	assert.equal(readFileSync(controlJournalFile(s.stateDir), "utf8").includes(codeOf(paired.link)), false);
	const phone = await s.pair("Phone", "view", codeOf(paired.link));
	const listed = await ok("list");
	assert.deepEqual((listed.devices as Array<{ name: string; level: string }>).map((d) => [d.name, d.level]), [["Phone", "view"]]);
	assert.equal(JSON.stringify(listed).includes(phone.cookie.split(".")[1]!), false, "no session secret over the socket");
	const revoked = await s.tunnel("revoke", "phone");
	assert.match(revoked.out, new RegExp(`^revoked ${phone.id} "Phone" at `), "by name, case-insensitively");
	const status = async (op: string, args: Record<string, unknown> = {}) => {
		const reply = await s.socket(op, args);
		return reply.ok ? 200 : reply.status;
	};
	assert.equal(await status("pair", { route: "cli-up" }), 200);
	assert.equal(await status("pair", { route: "loopback-dashboard" }), 400, "a dashboard route is the browser's");
	assert.equal(await status("pair", { level: "admin" }), 400);
	assert.equal(await status("pair", { level: "full", extra: 1 }), 400);
	assert.equal(await status("revoke", { target: "\u0007" }), 400);
	assert.equal(await status("revoke", { target: "nobody" }), 404);
	assert.equal(await status("mint"), 400, "unknown op");

	// Frames: a stranger is not answered; size counts bytes; bad JSON and a wrong version are refused.
	assert.equal(await raw(sock, `${JSON.stringify({ v: 1, token: "0".repeat(64), op: "list" })}\n`), "", "no answer to a stranger");
	await until(first.out, (out) => out.includes("viewer: device control refused a frame with a bad socket token"), "the refusal line");
	const frame = async (data: string) => (JSON.parse((await raw(sock, data)).trim()) as { status: number }).status;
	const wide = "é".repeat(DEVICE_FRAME_MAX / 2 + 1);
	assert.ok(wide.length < DEVICE_FRAME_MAX, "fewer characters than the cap, more bytes");
	assert.deepEqual([await frame("x".repeat(DEVICE_FRAME_MAX + 1)), await frame(`${"y".repeat(DEVICE_FRAME_MAX + 1)}\n`), await frame(`${wide}\n`), await frame(wide)], [413, 413, 413, 413]);
	assert.deepEqual([await frame("not json\n"), await frame(`${JSON.stringify({ v: 2, op: "status" })}\n`)], [400, 502]);

	// A live owner refuses a second viewer; with no running binding there is nothing to pair with.
	const second = s.viewer(await freePort());
	await until(second.out, (out) => out.includes(`device control not started, so no remote listener: device control already served by pid ${first.child.pid} on ${sock}`), "a second owner refused");
	assert.equal((await ok("status")).pid, first.child.pid, "the first owner is untouched");
	s.bind(1, { state: "stopped", pid: undefined });
	await until(() => ok("status"), (now) => now.running === false, "no binding");
	assert.equal(await status("pair"), 409);
	s.bind();
	await s.stop(second);
	await s.stop(first);
	const dead = await s.tunnel("devices");
	assert.deepEqual([dead.code, dead.out.trim()], [1, `cp-tunnel devices: stale device control record: pid ${first.child.pid} is not running; start the viewer`]);

	// A socket nothing answers is replaced; the client refuses a record that is not owner-only.
	const third = s.viewer();
	await s.listening(third);
	assert.equal(json(record)?.pid, third.child.pid);
	assert.equal((await s.tunnel("devices")).code, 0, "a CLI in another process reaches the owner");
	chmodSync(record, 0o644);
	assert.match((await s.tunnel("devices")).out, /is not an owner-only file of this user/);
	chmodSync(record, 0o600);

	// Takeover is locked: a live or a crashed holder is named, the stale socket untouched, and the winner drops the lock.
	await s.stop(third);
	const inode = statSync(sock).ino;
	writeFileSync(lock, `${process.pid}\n`);
	const fourth = s.viewer();
	await until(fourth.out, (out) => out.includes(`pid ${process.pid} is replacing a stale ${sock}; another viewer is starting`), "a live lock holder");
	writeFileSync(lock, "999999999\n");
	await until(fourth.out, (out) => out.includes(`${lock} is held by no running viewer (pid 999999999): if no viewer is starting, remove it and start again`), "a crashed lock holder");
	assert.equal(statSync(sock).ino, inode, "a refused starter touches nothing");
	rmSync(lock);
	await s.listening(fourth);
	assert.equal(existsSync(lock), false, "the lock is released once the new owner listens");
});

test("P12c-race: of five viewers racing for one stale socket exactly one owns it; six claims of one code have one winner", async (t) => {
	const s = await rig(t);
	mkdirSync(deviceControlDir(s.stateDir), { recursive: true, mode: 0o700 });
	writeFileSync(deviceControlSocket(s.stateDir), "left by a crash");
	const racers = await Promise.all(Array.from({ length: 5 }, async () => s.viewer(await freePort())));
	const refused = () => racers.filter((v) => v.out().includes("device control not started, so no remote listener"));
	await until(() => refused().length, (count) => count === 4, "four refused racers");
	const winner = racers.find((v) => !refused().includes(v))!;
	await s.listening(winner);
	await sleep(4_000); // two more checks: the losers stay refused
	assert.equal(refused().length, 4);
	assert.equal(((await s.socket("status")) as { result: { pid: number } }).result.pid, winner.child.pid, "the record names the one owner");
	const listed = await s.tunnel("devices");
	assert.deepEqual([listed.code, listed.out], [0, "no paired devices\n0 unclaimed pairing code(s)\n"], "a CLI in another process reaches it");

	const code = codeOf(((await s.socket("pair")) as { result: { link: string } }).result.link);
	const statuses = await Promise.all(Array.from({ length: 6 }, (_, index) => s.claim(code, `Phone ${index + 1}`).then((reply) => reply.status)));
	assert.equal(statuses.filter((status) => status === 200).length, 1, statuses.join(", "));
	assert.ok(statuses.every((status) => status === 200 || (status >= 400 && status < 500)), statuses.join(", "));
	assert.equal(s.devices().devices.length, 1, "one device, whatever the interleaving");
});

test("P12c-store: a pairing keeps only hashes and hands a __Host- session out once; codes, names, generations, sessions and revokes hold", async (t) => {
	const s = await rig(t);
	const view = s.viewer();
	await s.listening(view);
	const get = (cookie: string) => s.r("/api/devices", { headers: { cookie } }).then((reply) => reply.status);
	const refusal = async (reply: Promise<{ status: number; body: Record<string, unknown> }>) => {
		const { status, body } = await reply;
		return [status, body.error];
	};
	const created = (await s.create()).body;
	assert.equal(created.level, "full", "full by default");
	const code = codeOf(created.link);
	assert.equal(Buffer.from(code, "base64url").length, 32, "at least 128 random bits");
	assert.ok(Math.abs(Date.parse(String(created.expires_at)) - Date.now() - 300_000) < 5_000, "valid five minutes");
	const phone = await s.pair("  Phone  ", "full", code);
	const [, secret] = phone.cookie.split("=")[1]!.split(".");
	assert.equal(Buffer.from(secret!, "base64url").length, 32, "at least 256 random bits");
	assert.match(phone.setCookie, /^__Host-cp_device=/);
	for (const part of ["Max-Age=2592000", "Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) assert.ok(phone.setCookie.split("; ").includes(part), part);
	assert.doesNotMatch(phone.setCookie, /Domain/i);
	assert.equal(mode(devicesFile(s.dataDir)), 0o600);
	for (const sentinel of [code, secret!]) {
		assert.equal(readFileSync(devicesFile(s.dataDir), "utf8").includes(sentinel), false, "no secret in devices.json");
		assert.equal(readFileSync(controlJournalFile(s.stateDir), "utf8").includes(sentinel), false, "no secret in the journal");
	}
	const listed = (await s.l("/api/devices")).body;
	assert.deepEqual((listed.devices as Array<Record<string, unknown>>).map((d) => [d.name, d.state, "session_digest" in d]), [["Phone", "active", false]]);
	assert.deepEqual(s.journal().map((line) => [line.event, line.id]), [["code_issued", null], ["paired", null]], "composer readers skip device lines");
	assert.equal(await get(phone.cookie), 200);

	// Codes: single use, at most three live, valid until five minutes.
	assert.deepEqual(await refusal(s.claim(code, "b")), [403, "code_invalid"], "a replay is refused");
	const codes = [await s.issue(), await s.issue(), await s.issue()];
	assert.deepEqual(await refusal(s.create()), [429, "too_many_codes"]);
	s.advance(298_000);
	assert.equal((await s.claim(codes[0]!, "c")).status, 200, "valid just before five minutes");
	s.advance(3_000);
	assert.deepEqual(await refusal(s.claim(codes[1]!, "d")), [403, "code_expired"]);
	assert.equal((await s.create()).status, 201, "expired codes free their slots");

	// The level is fixed at issue; names are required and unique.
	const viewCode = await s.issue("view");
	assert.deepEqual(await refusal(s.claim(viewCode, "p", { level: "full" })), [403, "level_mismatch"]);
	for (const name of ["", "   ", "a\u0007b", "x".repeat(81), 42]) assert.deepEqual(await refusal(s.claim(viewCode, name)), [400, "name_invalid"], JSON.stringify(name));
	const tablet = await s.pair("Tablet", "view", viewCode);
	const devicesToken = await s.token(); // given anyway, so only the level can refuse
	const post = async (path: string, cookie: string, body: Record<string, unknown>) => {
		const reply = await s.r(path, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json", "x-cp-control-token": devicesToken }, body: JSON.stringify(body) });
		return [reply.status, reply.body.error];
	};
	assert.deepEqual(await post("/api/pair/create", phone.cookie, {}), [403, "pairing codes are issued only by the terminal or a loopback/tailnet dashboard"], "a remote Full device never mints");
	assert.deepEqual(await post("/api/devices/revoke", tablet.cookie, { id: phone.id }), [403, "View-only devices cannot revoke"]);
	assert.deepEqual(await refusal(s.claim(await s.issue(), "tablet")), [409, "name_taken"]);
	const failedAudits = s.journal().filter((line) => line.event === "claim_refused").map((line) => line.reason);
	assert.ok(failedAudits.includes("code_invalid") && failedAudits.includes("name_taken"), "failed claims leave a failure audit");
	assert.equal(readFileSync(controlJournalFile(s.stateDir), "utf8").includes("x".repeat(81)), false, "raw input never reaches the audit");

	// A new generation refuses the old generation's codes and sessions; a pairing snapshots the active devices only.
	const stale = await s.issue();
	s.bind(2);
	await s.listening(view, 2);
	assert.deepEqual(await refusal(s.claim(stale, "p")), [403, "origin_mismatch"]);
	assert.equal(await get(tablet.cookie), 401, "a new quick generation invalidates the session");
	for (const bad of ["garbage", `${phone.id}.${"A".repeat(43)}`, `${phone.cookie.split("=")[1]}.x`]) assert.equal(await get(`__Host-cp_device=${bad}`), 401, bad);
	assert.equal((await s.r("/api/devices")).status, 401, "no cookie");
	s.advance(301_000); // the codes left above expire and free their slots
	const full = await s.pair("Full"), viewOnly = await s.pair("View", "view"), gone = await s.pair("Gone");
	assert.ok((await s.socket("revoke", { target: gone.id })).ok);
	const fresh = await s.pair("Fresh");
	assert.deepEqual((await eventOf(s, fresh)).recipients, [full.id, viewOnly.id, fresh.id], "revoked and stale-generation devices are not recipients");
	assert.equal((await s.events()).length, 7, "one event per successful pairing");

	// Sessions slide 30 days on use; a revoke denies the next request and keeps the row.
	s.advance(30 * DAY - 60_000);
	assert.equal(await get(full.cookie), 200, "a request slides the expiry");
	s.advance(30 * DAY - 60_000);
	assert.equal(await get(full.cookie), 200);
	s.advance(30 * DAY + 60_000);
	assert.equal(await get(full.cookie), 401, "expired 30 days after its last use");
	const laptop = await s.pair("Laptop");
	assert.equal(((await s.socket("revoke", { target: "LAPTOP" })) as { result: { id: string } }).result.id, laptop.id);
	assert.equal(await get(laptop.cookie), 401);
	assert.ok(s.devices().devices.find((d) => d.id === laptop.id)?.revoked_at, "the row stays, marked revoked");
	assert.equal((await s.socket("revoke", { target: laptop.id })).ok, false, "a revoked device is not revoked twice");
	assert.ok(s.journal().some((line) => line.event === "revoked" && line.device_id === laptop.id));
	assert.ok(s.journal().some((line) => line.event === "signin_refused" && line.reason === "session_invalid"));

	// A revoke removes the device's push subscriptions afterwards; a failed cleanup is reported and the revoke stands.
	const token = await s.token();
	const revoke = (id: string) => s.l("/api/devices/revoke", { method: "POST", headers: { origin: `http://127.0.0.1:${s.localPort}`, "content-type": "application/json", "x-cp-control-token": token }, body: JSON.stringify({ id }) });
	const watch = await s.pair("Watch");
	const watchFile = subscriptionFile(s.dataDir, subscriptionId((await s.subscribe(watch, "watch")).endpoint));
	assert.deepEqual([(await revoke(watch.id)).body.cleanup_error, existsSync(watchFile)], [null, false]);
	if (!ROOT) {
		const slate = await s.pair("Slate");
		const slateFile = subscriptionFile(s.dataDir, subscriptionId((await s.subscribe(slate, "slate")).endpoint));
		chmodSync(dirname(slateFile), 0o500);
		try {
			assert.equal((await revoke(slate.id)).body.cleanup_error, "push subscription cleanup failed: EACCES");
		} finally {
			chmodSync(dirname(slateFile), 0o700);
		}
		assert.equal(await get(slate.cookie), 401, "the revoke stands");
	}

	// Malformed storage fails closed for every operation and is never reset; a restart's recovery refuses it too.
	const pad = await s.pair("Pad");
	const code2 = await s.issue();
	for (const body of ["{not json", JSON.stringify({ schema_version: 2, devices: [], codes: [], events: [] }), JSON.stringify({ schema_version: 1, devices: [{ id: "x" }], codes: [], events: [] })]) {
		writeFileSync(devicesFile(s.dataDir), body);
		assert.deepEqual(await refusal(s.l("/api/devices")), [503, "store_invalid"]);
		assert.deepEqual(await refusal(s.create(undefined, token)), [503, "store_invalid"]);
		assert.deepEqual(await refusal(s.claim(code2, "x")), [503, "store_invalid"]);
		assert.deepEqual(await refusal(s.r("/api/devices", { headers: { cookie: pad.cookie } })), [503, "store_invalid"]);
		assert.deepEqual([(await s.socket("revoke", { target: "Pad" })).ok, (await s.socket("list")).ok], [false, false]);
		assert.equal(readFileSync(devicesFile(s.dataDir), "utf8"), body, "bytes untouched");
	}
	await s.stop(view);
	const restarted = s.viewer();
	await until(restarted.out, (out) => out.includes("device store recovery refused (store_invalid)"), "recovery refused");
});

test("P12c-recovery: a failed audit or write stores no code; a half-committed pairing is finished once on restart, never twice", async (t) => {
	const s = await rig(t);
	let view = s.viewer();
	await s.listening(view);
	await s.pair("Phone");
	const journal = controlJournalFile(s.stateDir);
	const breakJournal = () => (renameSync(journal, `${journal}.saved`), mkdirSync(journal)); // unreadable: a directory
	const fixJournal = () => (rmdirSync(journal), renameSync(`${journal}.saved`, journal));
	const restart = async () => {
		await s.stop(view);
		view = s.viewer();
		return view;
	};
	const refusal = async (reply: Promise<{ status: number; body: Record<string, unknown> }>) => {
		const { status, body } = await reply;
		return [status, body.error];
	};
	breakJournal();
	assert.deepEqual(await refusal(s.create()), [500, "audit_failed"]);
	fixJournal();
	assert.equal(s.devices().codes.length, 0, "no unaudited code on disk");
	if (!ROOT) {
		chmodSync(s.dataDir, 0o500);
		let failed;
		try {
			failed = await s.create();
		} finally {
			chmodSync(s.dataDir, 0o700);
		}
		assert.deepEqual([failed.status, failed.body.error, "link" in failed.body], [500, "write_failed", false]);
		assert.equal(s.devices().codes.length, 0, "the failed write left no claimable code");
	}

	// The paired line cannot be written: no cookie, a pending device, a consumed code; recovery waits for the journal.
	const code = await s.issue();
	breakJournal();
	const refused = await s.claim(code, "Tablet");
	assert.deepEqual([refused.status, refused.body.error, refused.headers["set-cookie"]], [500, "audit_failed", undefined]);
	const pending = s.devices().devices.find((d) => d.name === "Tablet")!;
	assert.deepEqual([pending.state, s.devices().codes.length], ["pending", 0]);
	assert.equal((await s.events()).length, 1, "a pending event is not a committed notice");
	assert.deepEqual(await refusal(s.claim(code, "Tablet")), [403, "code_invalid"], "the code is not revived");
	await until((await restart()).out, (out) => out.includes("device store recovery refused (audit_failed)"), "recovery refused on an unreadable journal");
	fixJournal();
	await until((await restart()).out, (out) => out.includes("finished 1 interrupted pairing(s)"), "recovered");
	const paired = (id: unknown) => s.journal().filter((line) => line.event === "paired" && line.pairing_id === id).length;
	assert.deepEqual([paired(pending.pairing_id), s.devices().devices.find((d) => d.name === "Tablet")?.state], [1, "active"]);
	await s.listening(await restart());
	assert.doesNotMatch(view.out(), /interrupted pairing/, "recovery is idempotent");
	assert.equal(paired(pending.pairing_id), 1);

	// A crash after the paired line: recovery activates the device without a second line, though that line straddles
	// the journal's first 1 MiB chunk.
	const code2 = await s.issue();
	breakJournal();
	assert.equal((await s.claim(code2, "Slate")).status, 500);
	fixJournal();
	const slate = s.devices().devices.find((d) => d.name === "Slate")!;
	appendFileSync(journal, `${JSON.stringify({ type: "refused", pad: "x".repeat(1024 * 1024 - 20 - statSync(journal).size - 28) })}\n`);
	appendFileSync(journal, `${JSON.stringify({ type: "device", event: "paired", pairing_id: slate.pairing_id })}\n`);
	await until((await restart()).out, (out) => out.includes("finished 1 interrupted pairing(s)"), "recovered after the audit");
	assert.deepEqual([paired(slate.pairing_id), s.devices().devices.find((d) => d.name === "Slate")?.state], [1, "active"], "never a second success line");
	assert.equal(s.devices().events.find((e) => e.device_id === slate.id)?.id, slate.pairing_id, "audit and event share the pairing id");
});
