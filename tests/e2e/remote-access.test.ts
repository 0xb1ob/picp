/**
 * P12 (behavior 16), slice 1: the remote dashboard through real processes — `bin/cp-view` and its remote listener,
 * `bin/cp-tunnel` on the owner socket, a real cp-bridge pi; the viewer's clock via tests/harness/process-clock.ts. */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { LAYOUT } from "../../src/contracts.ts";
import { tunnelConfigFile, tunnelRuntimeFile } from "../../src/service/daemon-tunnel-files.ts";
import { controlJournalFile, controlRecordFile, controlSocketFile, parseDashboardText, readControlRecord } from "../../src/viewer/control-files.ts";
import { readInbox } from "../../src/viewer/control-inbox.ts";
import { deviceControlDir, deviceControlRequest } from "../../src/viewer/device-control.ts";
import { DEVICE_SESSION_TTL_MS, devicesFile } from "../../src/viewer/device-files.ts";
import { newUploadId, writeUpload } from "../../src/viewer/uploads.ts";
import { CP_BRIDGE_EXTENSION, MockProvider, createAgentDir, createScratchHome, startRpc } from "../harness/index.ts";
import { call, type Init } from "../harness/remote.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CLOCK = pathToFileURL(resolve(import.meta.dirname, "../harness/process-clock.ts")).href;
const ORIGIN = "https://amber-otter.trycloudflare.com";
const COOKIE_RE = /^__Host-cp_device=dev-[0-9a-f]{16}\.[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; Secure; HttpOnly; SameSite=Strict$/;
const MINUTE = 60_000;

const freePort = (): Promise<number> =>
	new Promise((done) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => done(port));
		});
	});

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
	let last: T | undefined;
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 100))) {
		last = await read();
		if (ok(last)) return last;
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}

/** Write `file` whole (temp then rename), so the polling viewer never reads a half-written file. */
const put = (file: string, text: string) => {
	writeFileSync(`${file}.tmp`, text);
	renameSync(`${file}.tmp`, file);
};

/** A scratch home with a running `cp-view`; `tunnel` seeds an enabled quick config and its running record. */
async function stack(t: TestContext, { tunnel = true }: { tunnel?: boolean } = {}) {
	const home = createScratchHome();
	const dataDir = join(home.path, LAYOUT.data), stateDir = join(home.path, LAYOUT.state), uploads = join(home.path, "uploads");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	const [localPort, remotePort] = [await freePort(), await freePort()];
	const clockFile = join(home.path, "clock-offset-ms");
	let offset = 0;
	put(clockFile, "0");
	const config = (patch: Record<string, unknown> = {}) =>
		put(tunnelConfigFile(dataDir), JSON.stringify({ schema_version: 1, enabled: true, mode: "quick", port: remotePort, binary: "/opt/cf/cloudflared", revision: 1, ...patch }));
	const runtime = (patch: Record<string, unknown> = {}) =>
		put(tunnelRuntimeFile(stateDir), JSON.stringify({ schema_version: 1, origin: ORIGIN, generation: 1, revision: 1, state: "running", mode: "quick", port: remotePort, updated_at: new Date().toISOString(), ...patch }));
	if (tunnel) {
		config();
		runtime();
	}
	const env = { PATH: process.env.PATH ?? "", HOME: home.path, CP_HOME: home.path, CP_UPLOAD_ROOT: uploads };
	const view: ChildProcess = spawn(join(ROOT, "bin/cp-view"), ["--home", home.path, "--host", "127.0.0.1", "--port", String(localPort)], {
		env: { ...env, CP_TEST_CLOCK_FILE: clockFile, NODE_OPTIONS: `--import ${CLOCK}` },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	view.stdout!.on("data", (chunk) => (output += chunk));
	view.stderr!.on("data", (chunk) => (output += chunk));
	const exited = new Promise<void>((done) => view.once("exit", () => done()));
	t.after(async () => {
		if (view.exitCode === null) view.kill("SIGTERM");
		await exited;
		home.cleanup();
	});
	const l = (path: string, init: Init = {}) => call(localPort, path, init);
	const r = (path: string, init: Init = {}) => call(remotePort, path, init);
	await until(() => l("/healthz").then((reply) => reply.status, () => 0), (status) => status === 200, `cp-view on ${localPort}\n${output}`, 60_000);
	/** `cp-tunnel <args>` as its own process, against this home. */
	const tunnelCli = (...args: string[]) =>
		new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
			execFile(join(ROOT, "bin/cp-tunnel"), [...args, "--home", home.path], { env }, (error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
		});
	const remoteUp = () => r("/pair").then((reply) => reply.status, (error: NodeJS.ErrnoException) => error.code ?? "error");
	const listener = (open: boolean) => until(remoteUp, (status) => (open ? status === 200 : status === "ECONNREFUSED"), `remote listener ${open ? "open" : "closed"}\n${output}`);
	if (tunnel) await listener(true);
	const token = async () => String((await l("/api/devices")).body.token);
	const localOrigin = `http://127.0.0.1:${localPort}`;
	const create = async (body: unknown = {}, headers: Record<string, string> = {}) =>
		l("/api/pair/create", { method: "POST", headers: { origin: localOrigin, "content-type": "application/json", "x-cp-control-token": await token(), ...headers }, body: JSON.stringify(body) });
	const codeOf = (reply: { body: Record<string, unknown> }) => String(reply.body.link).split("#")[1]!;
	const claimInit = (body: unknown, headers: Record<string, string> = {}, origin = ORIGIN): Init => ({ method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	let peers = 0;
	/** Pair via Add device and the public claim, each from its own client address. */
	const pair = async (name: string, level: "full" | "view" = "full", origin = ORIGIN, host?: string) => {
		const made = await create({ level });
		assert.equal(made.status, 201, JSON.stringify(made.body));
		const claimed = await r("/api/pair/claim", claimInit({ code: codeOf(made), name, level }, { "cf-connecting-ip": `198.51.100.${(peers += 1)}`, ...(host ? { host } : {}) }, origin));
		assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
		const cookie = String(claimed.headers["set-cookie"]).split(";")[0]!;
		return { cookie, id: cookie.split("=")[1]!.split(".")[0]! };
	};
	const journal = (): Array<Record<string, unknown>> =>
		existsSync(controlJournalFile(stateDir)) ? readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row)) : [];
	const status = async () => (await tunnelCli("status")).stdout;
	return {
		home: home.path, dataDir, stateDir, uploads, localPort, remotePort, view, l, r, config, runtime, listener, tunnelCli, status, create, codeOf, claimInit, pair, journal, token,
		output: () => output,
		advance: (ms: number) => put(clockFile, String((offset += ms))),
		ack: async () => {
			const reply = await deviceControlRequest(stateDir, "status");
			assert.ok(reply.ok, JSON.stringify(reply));
			return reply.result as Record<string, unknown>;
		},
	};
}
type Stack = Awaited<ReturnType<typeof stack>>;

/** Open a remote SSE stream; resolves on its first event with a promise of the time it closes. */
function openStream(s: Stack, cookie: string): Promise<{ closed: Promise<number> }> {
	return new Promise((opened, reject) => {
		const req = request({ host: "127.0.0.1", port: s.remotePort, path: "/api/stream?view=overview", headers: { host: `127.0.0.1:${s.remotePort}`, cookie } }, (res) => {
			assert.equal(res.statusCode, 200);
			res.once("data", () => {
				const closed = new Promise<number>((done) => {
					res.on("close", () => done(Date.now()));
					res.on("error", () => done(Date.now()));
					setTimeout(() => done(Number.POSITIVE_INFINITY), 10_000).unref(); // a stream that never closes fails, not hangs
				});
				res.resume();
				opened({ closed });
			});
		});
		req.on("error", reject);
		req.end();
	});
}

test("P12-off: a home without the remote feature gets no owner socket, listener or device route; paired devices alone turn them on", async (t) => {
	const s = await stack(t, { tunnel: false });
	await new Promise((done) => setTimeout(done, 2_500)); // past the viewer's first 2 s remote check
	assert.equal(existsSync(deviceControlDir(s.stateDir)), false, "the owner socket is never even attempted");
	assert.equal((await s.l("/api/devices")).status, 404, "no device routes: the local listener answers 404 as before");
	assert.equal((await s.l("/pair")).status, 404, "no pair page on the local listener");
	const post = await s.l("/api/pair/create", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(post.status, 405, "unknown write paths answer the read-only 405 exactly as before");
	await assert.rejects(s.r("/pair"), /ECONNREFUSED/);
	assert.match(await s.status(), /^config: none \(the remote dashboard is off/m);
	assert.doesNotMatch(s.output(), /viewer: remote:/);

	// The devices.json a store wrote keeps the feature on after cp-tunnel down removed tunnel.json (alerts outlive it).
	writeFileSync(devicesFile(s.dataDir), JSON.stringify({ schema_version: 1, devices: [], codes: [], events: [] }));
	const owned = await until(() => s.l("/api/devices"), (reply) => reply.status === 200, "device routes once the viewer owns the store");
	const body = owned.body as { can_create: boolean; can_revoke: boolean; origin: string | null; token: string | null };
	assert.deepEqual([body.can_revoke, body.origin], [true, null], "owned, with no tunnel to pair through");
	assert.match(String(body.token), /^[0-9a-f]{64}$/);
	assert.equal(existsSync(deviceControlDir(s.stateDir)), true);
	await assert.rejects(s.r("/pair"), /ECONNREFUSED/);
	s.config();
	s.runtime();
	await s.listener(true);
	assert.equal((await s.l("/api/devices")).body.origin, ORIGIN);
});

test("P12-runtime: cp-view opens the remote listener only for the controller's matching running revision, acks it, and closes it when that stops", async (t) => {
	const s = await stack(t, { tunnel: false });
	s.config();
	s.runtime({ revision: 2 });
	await until(() => s.status(), (out) => out.includes("viewer: remote listener closed"), "the owner socket's closed ack");
	assert.deepEqual(await s.ack(), { pid: s.view.pid, running: false, origin: null, generation: null, revision: null, port: null });
	await assert.rejects(s.r("/pair"), /ECONNREFUSED/, "the controller answers another revision");

	s.runtime();
	await s.listener(true);
	assert.match(await s.status(), new RegExp(`^viewer: remote listener open for ${ORIGIN} \\(generation 1, revision 1\\)$`, "m"));
	assert.deepEqual(await s.ack(), { pid: s.view.pid, running: true, origin: ORIGIN, generation: 1, revision: 1, port: s.remotePort });
	assert.match(s.output(), new RegExp(`viewer: remote: listening on 127\\.0\\.0\\.1:${s.remotePort} for ${ORIGIN}`));

	// A revision-only change (cp-tunnel up with the same settings) is acknowledged in place.
	s.config({ revision: 2 });
	s.runtime({ revision: 2 });
	await until(() => s.ack(), (ack) => ack.revision === 2, "revision 2 acknowledged");
	assert.equal(s.output().split("listening on").length - 1, 1, "not reopened");

	const other = "https://other-name.trycloudflare.com";
	s.runtime({ revision: 2, generation: 2, origin: other });
	await until(() => s.ack(), (ack) => ack.generation === 2, "the new generation");
	assert.equal((await s.ack()).origin, other);
	assert.match(s.output(), /closed 127\.0\.0\.1:\d+ \(now https:\/\/other-name\.trycloudflare\.com generation 2/);

	const torn = (file: string) => () => writeFileSync(file, "{torn");
	const otherPort = await freePort();
	for (const [why, change] of [
		["stopped", () => s.runtime({ state: "stopped" })],
		["starting", () => s.runtime({ state: "starting" })],
		["another port", () => s.runtime({ port: otherPort })],
		["another mode", () => s.runtime({ mode: "named" })],
		["no origin yet", () => s.runtime({ origin: null })],
		["unreadable runtime", torn(tunnelRuntimeFile(s.stateDir))],
		["disabled", () => s.config({ enabled: false })],
		["unreadable config", torn(tunnelConfigFile(s.dataDir))],
		["no config", () => rmSync(tunnelConfigFile(s.dataDir))],
	] as const) {
		s.config();
		s.runtime();
		await until(() => s.ack(), (ack) => ack.running === true && ack.generation === 1, `${why}: reopened`);
		await s.listener(true);
		change();
		await s.listener(false);
		assert.equal((await s.ack()).running, false, why);
		assert.match(await s.status(), /^viewer: remote listener closed$/m, why);
	}
});

test("P12-host: a named tunnel's listener answers its hostname in any case, bare or :443; a quick one only its loopback Host and asks the app to poll", async (t) => {
	const s = await stack(t);
	assert.equal((await s.r("/pair", { headers: { host: "cp.example.test", connection: "close" } })).status, 421, "quick: loopback Host only");
	assert.equal((await s.r("/api/overview", { headers: { host: "cp.example.test" } })).status, 421, "the tunnel must rewrite Host to the loopback endpoint");
	const quick = await s.pair("Quick");
	const [local, remote] = [await s.l("/"), await s.r("/", { headers: { cookie: quick.cookie } })];
	assert.equal(local.status, 200);
	assert.doesNotMatch(local.text, /cp-refresh/, "the local document carries no remote boot metadata");
	assert.equal(remote.text, local.text.replace("<title>", '<meta name="cp-refresh" content="poll"><title>'), "a quick listener's page asks the app to poll");

	const named = "https://cp.example.test";
	s.config({ revision: 2, mode: "named", hostname: "cp.example.test", token_file: "/opt/cf/token" });
	s.runtime({ revision: 2, generation: 2, origin: named, mode: "named" });
	await until(() => s.ack(), (ack) => ack.origin === named, "the named listener");
	for (const host of ["cp.example.test", "CP.Example.Test", "cp.example.test:443"]) assert.equal((await s.r("/api/overview", { headers: { host } })).status, 401, host);
	const device = await s.pair("Laptop", "full", named, "cp.example.test");
	assert.equal((await s.r("/api/overview", { headers: { host: "cp.example.test", cookie: device.cookie } })).status, 200);
	assert.doesNotMatch((await s.r("/", { headers: { host: "cp.example.test", cookie: device.cookie } })).text, /cp-refresh/, "a named listener streams");
	for (const host of ["evil.example", "cp.example.test:8443", "x.cp.example.test", "cp.example.test.evil", "other.example.test"]) {
		const reply = await s.r("/api/overview", { headers: { host, cookie: device.cookie } });
		assert.equal(reply.status, 421, host);
		assert.match(reply.text, /^refused: Host must be 127\.0\.0\.1:\d+ or cp\.example\.test\n$/);
	}
	assert.equal((await s.r("/api/overview", { headers: { cookie: device.cookie } })).status, 200, "the loopback Host still passes");
});

test("P12-pair: Add device on the loopback dashboard issues a code, the pair page claims it over the tunnel, the cookie signs in, nothing secret is kept", async (t) => {
	const s = await stack(t);
	const listed = await s.l("/api/devices");
	assert.equal(listed.status, 200, "an eligible loopback screen lists devices once this viewer owns the store");
	assert.equal(listed.body.can_create, true);
	const made = await s.create({ level: "view" });
	assert.equal(made.status, 201);
	const link = String(made.body.link);
	assert.match(link, /^https:\/\/amber-otter\.trycloudflare\.com\/pair#[A-Za-z0-9_-]{43}$/, "the code travels in the fragment, never a query");
	assert.equal(made.body.level, "view");
	const code = s.codeOf(made);
	const page = await s.r("/pair");
	const csp = String(page.headers["content-security-policy"]);
	const script = /<script>([\s\S]*)<\/script>/.exec(page.text)![1]!;
	const style = /<style>([\s\S]*)<\/style>/.exec(page.text)![1]!;
	const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
	assert.ok(csp.includes(`script-src ${sha(script)};`), "the CSP admits exactly the inline script");
	assert.ok(csp.includes(`style-src ${sha(style)};`), "and exactly the inline style");
	assert.doesNotMatch(page.text, /\bsrc=|\bhref=|localStorage|sessionStorage|indexedDB|document\.cookie/, "no asset, no browser storage");
	assert.match(script, /^\(\(\) => \{\nconst code = location\.hash\.slice\(1\);\nhistory\.replaceState\(null, "", location\.pathname\);/, "the fragment is read, then scrubbed");
	const claimed = await s.r("/api/pair/claim", s.claimInit({ code, name: "Phone", level: "view" }, { "cf-connecting-ip": "203.0.113.9" }));
	assert.equal(claimed.status, 200);
	assert.deepEqual(claimed.body, { paired: true, name: "Phone", level: "view", redirect: "/" });
	const cookie = String(claimed.headers["set-cookie"]);
	assert.match(cookie, COOKIE_RE);
	const value = cookie.split(";")[0]!;
	const secret = value.split(".")[1]!;
	assert.equal(claimed.text.includes(secret), false, "the session secret is only in the HttpOnly cookie");
	assert.equal((await s.r("/api/overview", { headers: { cookie: value } })).status, 200);
	const lines = s.journal().filter((line) => line.type === "device");
	assert.deepEqual(lines.map((line) => [line.event, line.route]), [["code_issued", "loopback-dashboard"], ["paired", "loopback-dashboard"]]);
	assert.equal(lines[1]!.peer, "203.0.113.9");
	assert.equal(((await s.l("/api/devices")).body.events as unknown[]).length, 1, "one durable pairing event");
	for (const text of [readFileSync(controlJournalFile(s.stateDir), "utf8"), readFileSync(devicesFile(s.dataDir), "utf8"), s.output()]) {
		assert.equal(text.includes(code), false, "the code is never journaled, stored or logged");
		assert.equal(text.includes(secret), false, "nor the session secret");
	}
	const replay = await s.r("/api/pair/claim", s.claimInit({ code, name: "Other" }));
	assert.deepEqual([replay.status, replay.body.error], [403, "code_invalid"], "single use");
	assert.equal(s.journal().filter((line) => line.event === "paired").length, 1, "a replay is a failure line only, never a second pairing");
	// Local parity: a device cookie confers nothing on the local listener, which sets none.
	assert.equal((await s.l("/pair")).status, 404);
	assert.equal((await s.l("/api/sessions?view=you&transcript=1", { headers: { cookie: value } })).status, 403);
	const overview = await s.l("/api/overview", { headers: { cookie: value } });
	assert.deepEqual([overview.status, overview.headers["set-cookie"]], [200, undefined]);
	assert.equal((await s.l("/api/operator/control", { headers: { cookie: value } })).status, 403, "--require-tailnet keeps its meaning");
});

test("P12-claim: the public claim refuses bad requests, replays, taken names and expired codes, and limits each client address", async (t) => {
	const s = await stack(t);
	const code = s.codeOf(await s.create());
	const cases: Array<[string, Init, number]> = [
		["wrong Origin", s.claimInit({ code, name: "A" }, { origin: "https://evil.example" }), 403],
		["no Origin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "A" }) }, 403],
		["cross-site", s.claimInit({ code, name: "A" }, { "sec-fetch-site": "cross-site" }), 403],
		["form post", s.claimInit({ code, name: "A" }, { "content-type": "application/x-www-form-urlencoded" }), 415],
		["too large", s.claimInit({ code, name: "A".repeat(2000) }), 413],
		["extra field", s.claimInit({ code, name: "A", device_id: "dev-0000000000000000" }), 400],
		["level differs from the code's", s.claimInit({ code, name: "A", level: "view" }), 403],
		["blank name", s.claimInit({ code, name: "   " }), 400],
	];
	for (const [label, init, status] of cases) assert.equal((await s.r("/api/pair/claim", init)).status, status, label);
	assert.equal((await s.r(`/api/pair/claim?code=${code}`, s.claimInit({ name: "A" }))).status, 401, "a query string is not the public claim");
	await s.pair("Phone");
	const taken = await s.r("/api/pair/claim", s.claimInit({ code: s.codeOf(await s.create()), name: "phone" }));
	assert.equal(taken.status, 409, "names are unique case-insensitively");
	const late = s.codeOf(await s.create());
	s.advance(5 * MINUTE + 1);
	const expired = await s.r("/api/pair/claim", s.claimInit({ code: late, name: "Late" }, { "cf-connecting-ip": "198.51.100.200" }));
	assert.deepEqual([expired.status, expired.body.error], [403, "code_expired"]);
	assert.equal(s.journal().filter((line) => line.event === "paired").length, 1, "only Phone");

	const bad = s.claimInit({ code: "A".repeat(43), name: "X" }, { "cf-connecting-ip": "203.0.113.1" });
	for (let i = 0; i < 10; i++) assert.equal((await s.r("/api/pair/claim", bad)).status, 403);
	const limited = await s.r("/api/pair/claim", bad);
	assert.deepEqual([limited.status, limited.headers["retry-after"]], [429, "600"]);
	const fresh = s.codeOf(await s.create());
	assert.equal((await s.r("/api/pair/claim", s.claimInit({ code: fresh, name: "Tablet" }, { "cf-connecting-ip": "203.0.113.1" }))).status, 429, "a good code waits out the window too");
	const other = await s.r("/api/pair/claim", s.claimInit({ code: fresh, name: "Tablet" }, { "cf-connecting-ip": "203.0.113.2" }));
	assert.equal(other.status, 200, "another address is unaffected, and the code is still unused");
	const device = String(other.headers["set-cookie"]).split(";")[0]!;
	assert.equal((await s.r("/api/overview", { headers: { cookie: device, "cf-connecting-ip": "203.0.113.1" } })).status, 200, "claim failures do not lock out a session");
	s.advance(10 * MINUTE);
	assert.equal((await s.r("/api/pair/claim", bad)).status, 403, "the window slides");
});

test("P12-create: Add device refuses a bad token, Origin, proxy, site or body, a fourth live code, no running listener and a GET", async (t) => {
	const s = await stack(t);
	assert.equal((await s.create({}, { "x-cp-control-token": "0".repeat(64) })).status, 403);
	assert.equal((await s.create({}, { origin: "https://evil.example" })).status, 403);
	// A proxied Host with its own Origin passes the control routes (viewer.strict_host off), never device management.
	const proxy = { host: "8766--dev--box.coder.example", origin: "https://8766--dev--box.coder.example" };
	const want = `Origin must be http://127.0.0.1:${s.localPort}`;
	const proxied = await s.create({}, proxy);
	assert.deepEqual([proxied.status, proxied.body.error], [403, want]);
	const revoke = await s.l("/api/devices/revoke", { method: "POST", headers: { ...proxy, "content-type": "application/json", "x-cp-control-token": await s.token() }, body: JSON.stringify({ id: "dev-0123456789abcdef" }) });
	assert.deepEqual([revoke.status, revoke.body.error], [403, want]);
	assert.equal((await s.create({}, { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await s.create({ level: "admin" })).status, 400);
	assert.equal((await s.create({ level: "full", name: "x" })).status, 400);
	for (let i = 0; i < 3; i++) assert.equal((await s.create()).status, 201);
	assert.equal((await s.create()).status, 429, "at most three live codes");
	s.runtime({ state: "stopped" });
	await s.listener(false);
	s.advance(5 * MINUTE + 1);
	assert.equal((await s.create()).status, 409, "no remote listener: nothing to pair with");
	assert.equal(s.journal().filter((line) => line.event === "code_issued").length, 3, "refusals issue nothing");
	assert.equal((await s.l("/api/pair/create")).status, 405);
});

const PROTECTED = [
	"/", "/assets/viewer/app.js", "/boards/", "/boards/board.css", "/boards/demo/", "/sw.js", "/manifest.webmanifest", "/icon-192.png", "/apple-touch-icon.png",
	"/api/identity", "/healthz", "/api/version", "/api/overview", "/api/jobs", "/api/board", "/api/reports", "/api/schedules", "/api/map", "/api/dashboard",
	"/api/awaiting", "/api/decided", "/api/decisions", "/api/stats", "/api/job?id=x", "/api/job/x/events", "/api/job/x/transcript", "/api/diff?id=x",
	"/api/sessions", "/api/sessions?view=you&transcript=1", "/api/roots", "/api/files", "/api/git", "/api/skills", "/api/operator/uploads/x",
	"/api/stream?view=overview", "/api/stream?id=x", "/api/operator/control", "/api/schedules/control", "/api/schedules/policy", "/api/answers/control",
	"/api/settings", "/api/push", "/api/devices", "/api/devices/notices", "/classic", "/nope", "/pair?code=x", "/pair/", "/api/pair/claim?x=1",
];

test("P12-gate: an unpaired caller is refused 401 on every route and method, forged headers confer nothing, and only the pair page and claim are public", async (t) => {
	const s = await stack(t);
	const forged = { "x-forwarded-for": "127.0.0.1", "cf-connecting-ip": "127.0.0.1", "x-real-ip": "127.0.0.1", "tailscale-user-login": "me@example.test", origin: ORIGIN };
	for (const path of PROTECTED) {
		for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
			const reply = await s.r(path, { method, headers: forged });
			assert.equal(reply.status, 401, `${method} ${path}`);
			assert.equal(reply.text.includes(s.home), false, `${method} ${path} leaks the home`);
			assert.equal(reply.headers["access-control-allow-origin"], undefined);
		}
	}
	for (const path of ["/api/operator/message", "/api/operator/start", "/api/operator/queue", "/api/operator/upload", "/api/settings/apply", "/api/push/subscription", "/api/pair/create", "/api/devices/revoke"]) {
		assert.equal((await s.r(path, { method: "POST", headers: { ...forged, "content-type": "application/json" }, body: "{}" })).status, 401, path);
	}
	const page = await s.r("/pair");
	assert.equal(page.status, 200);
	assert.match(String(page.headers["content-security-policy"]), /^default-src 'none'; script-src 'sha256-/);
	assert.deepEqual([page.headers["cache-control"], page.headers["referrer-policy"], page.headers["x-frame-options"], page.headers["set-cookie"]], ["no-store", "no-referrer", "DENY", undefined]);
	assert.equal((await s.r("/pair", { method: "HEAD" })).status, 200);
	assert.notEqual((await s.r("/api/pair/claim", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status, 401, "the claim is public");
});

test("P12-cookie: bad, expired, revoked and other-generation sessions are 401 and cleared; 10 failures per address then 429", async (t) => {
	const s = await stack(t);
	const good = await s.pair("Phone");
	for (const cookie of ["__Host-cp_device=nope", `__Host-cp_device=${good.id}.${"A".repeat(43)}`, `${good.cookie}; ${good.cookie}`, "cp_device=x"]) {
		assert.equal((await s.r("/api/overview", { headers: { cookie, "cf-connecting-ip": "203.0.113.7" } })).status, 401, cookie);
	}
	assert.equal((await s.r("/api/overview", { headers: { cookie: "__Host-cp_device=nope", "cf-connecting-ip": "203.0.113.8" } })).headers["set-cookie"]?.[0]?.includes("Max-Age=0"), true);
	for (let i = 0; i < 8; i++) await s.r("/api/overview", { headers: { cookie: "__Host-cp_device=nope", "cf-connecting-ip": "203.0.113.7" } });
	assert.equal((await s.r("/api/overview", { headers: { cookie: good.cookie, "cf-connecting-ip": "203.0.113.7" } })).status, 429, "the address used its 10 failures");
	assert.equal((await s.r("/api/overview", { headers: { cookie: good.cookie, "cf-connecting-ip": "198.51.100.99" } })).status, 200, "another address is unaffected");
	assert.equal((await s.r("/api/overview", { headers: { cookie: good.cookie } })).status, 200, "absent CF-Connecting-IP is its own shared bucket");
	s.advance(10 * MINUTE);
	assert.equal((await s.r("/api/overview", { headers: { cookie: good.cookie, "cf-connecting-ip": "203.0.113.7" } })).status, 200, "the window slides");
	s.advance(DEVICE_SESSION_TTL_MS + 1);
	assert.equal((await s.r("/api/overview", { headers: { cookie: good.cookie } })).status, 401, "expired");

	const tablet = await s.pair("Tablet");
	const revoked = await s.tunnelCli("revoke", "Tablet");
	assert.equal(revoked.code, 0, revoked.stderr);
	assert.match(revoked.stdout, new RegExp(`^revoked ${tablet.id} "Tablet" at `));
	assert.equal((await s.r("/api/overview", { headers: { cookie: tablet.cookie } })).status, 401, "revoked");
	assert.match((await s.tunnelCli("devices")).stdout, new RegExp(`^${tablet.id}  "Tablet"  full  .*  revoked `, "m"), "the row is kept");

	const laptop = await s.pair("Laptop");
	s.runtime({ generation: 2, origin: "https://other-name.trycloudflare.com" });
	await until(() => s.ack(), (ack) => ack.generation === 2, "the new quick generation");
	assert.equal((await s.r("/api/overview", { headers: { cookie: laptop.cookie } })).status, 401, "a new quick generation invalidates the session");
});

test("P12-levels: both levels read every protected route with a sliding cookie and no cache; View-only gets no write token and no write", async (t) => {
	const s = await stack(t);
	const full = await s.pair("Laptop"), view = await s.pair("Phone", "view");
	const id = newUploadId("txt", new Date());
	writeUpload(s.uploads, id, Buffer.from("hello\n"));
	for (const device of [full, view]) {
		for (const path of ["/api/overview", "/api/identity", "/healthz", "/api/sessions?view=you&transcript=1", "/api/skills", "/api/operator/control", "/api/schedules/control", "/api/answers/control", `/api/operator/uploads/${id}`, "/api/devices", "/sw.js"]) {
			const reply = await s.r(path, { headers: { cookie: device.cookie } });
			assert.notEqual(reply.status, 401, path);
			assert.notEqual(reply.status, 403, `${path} is readable remotely`);
			assert.equal(reply.headers["cache-control"], "no-store", path);
			assert.match(String(reply.headers["set-cookie"]), COOKIE_RE, path);
		}
		assert.equal((await s.r("/api/identity", { headers: { cookie: device.cookie } })).body.home, s.home);
	}
	const tokens = async (cookie: string) => [
		(await s.r("/api/operator/control", { headers: { cookie } })).body.inbox_token,
		(await s.r("/api/schedules/control", { headers: { cookie } })).body.token,
		(await s.r("/api/answers/control", { headers: { cookie } })).body.token,
		(await s.r("/api/devices", { headers: { cookie } })).body.token,
	];
	assert.deepEqual(await tokens(view.cookie), [null, null, null, null], "View-only reads with every write token withheld");
	const fullTokens = await tokens(full.cookie);
	for (const token of fullTokens) assert.equal(typeof token, "string");
	assert.equal(fullTokens[3], await s.token(), "the device management token is the local screen's");
	const devices = (await s.r("/api/devices", { headers: { cookie: view.cookie } })).body;
	assert.deepEqual([devices.can_create, devices.can_revoke], [false, false]);
	assert.equal(JSON.stringify(devices).includes("session_digest"), false);
	assert.match(String(devices.trust), /trusted like your terminal/);

	const json = async (cookie: string, extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, "content-type": "application/json", "x-cp-control-token": await s.token(), ...extra });
	for (const path of ["/api/operator/message", "/api/operator/start", "/api/operator/restart", "/api/operator/queue", "/api/operator/upload", "/api/schedules/request", "/api/answers/ack", "/api/settings/apply", "/api/settings/restore"]) {
		const viewed = await s.r(path, { method: "POST", headers: await json(view.cookie), body: '{"kind":"message","text":"hi"}' });
		assert.equal(viewed.status, 403, path);
		assert.match(String(viewed.body.error), /View-only/);
		const fulled = await s.r(path, { method: "POST", headers: await json(full.cookie), body: '{"kind":"message","text":"hi"}' });
		assert.doesNotMatch(String(fulled.body.error ?? ""), /View-only|not enabled yet|require-tailnet/, `${path} reaches its handler`);
		const crossed = await s.r(path, { method: "POST", headers: await json(full.cookie, { origin: "https://evil.example" }), body: '{"kind":"message","text":"hi"}' });
		assert.deepEqual([crossed.status, crossed.body.error], [403, `Origin must be ${ORIGIN}`], `${path}: exact tunnel Origin`);
	}
	for (const device of [full, view]) {
		const minted = await s.r("/api/pair/create", { method: "POST", headers: await json(device.cookie), body: '{"level":"full"}' });
		assert.equal(minted.status, 403, "no remote device mints, whatever its level, token or Origin");
	}
	assert.equal((await s.l("/api/devices")).body.pending_codes, 0, "nothing was issued");
	const revoke = async (cookie: string, target: string, extra: Record<string, string> = {}) => s.r("/api/devices/revoke", { method: "POST", headers: await json(cookie, extra), body: JSON.stringify({ id: target }) });
	assert.equal((await revoke(view.cookie, full.id)).status, 403, "View-only cannot revoke");
	assert.equal((await revoke(full.cookie, view.id, { origin: "https://evil.example" })).status, 403, "exact tunnel Origin");
	assert.equal((await revoke(full.cookie, view.id, { "x-cp-control-token": "0".repeat(64) })).status, 403, "management token");
	const revoked = await revoke(full.cookie, view.id);
	assert.deepEqual([revoked.status, revoked.body.id], [200, view.id]);
	assert.equal((await s.r("/api/overview", { headers: { cookie: view.cookie } })).status, 401, "the next request after a completed revoke is refused");
});

test("P12-stream: a cp-tunnel revoke or an unreadable device store closes an open remote stream within two seconds", async (t) => {
	const s = await stack(t);
	const phone = await s.pair("Phone"), tablet = await s.pair("Tablet");
	assert.equal((await s.r("/api/stream?view=overview", { method: "HEAD", headers: { cookie: phone.cookie } })).status, 200);
	const revokedStream = await openStream(s, phone.cookie);
	const revokeAt = Date.now();
	const revoked = await s.tunnelCli("revoke", phone.id);
	assert.equal(revoked.code, 0, revoked.stderr);
	const revokedAt = Date.now();
	const afterRevoke = (await revokedStream.closed) - revokedAt;
	assert.ok(afterRevoke <= 2_500, `closed ${afterRevoke} ms after cp-tunnel revoke returned (it began ${revokedAt - revokeAt} ms before)`);

	const brokenStream = await openStream(s, tablet.cookie);
	const brokenAt = Date.now();
	writeFileSync(devicesFile(s.dataDir), "{ not json");
	const afterBreak = (await brokenStream.closed) - brokenAt;
	assert.ok(afterBreak <= 2_500, `closed ${afterBreak} ms after the store became unreadable`);
});

const MESSAGE = "/api/operator/message";
const write = (cookie: string, token: string | null, body: unknown, extra: Record<string, string> = {}): Init => ({
	method: "POST", body: JSON.stringify(body),
	headers: { cookie, origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});
const controlToken = async (s: Stack, cookie: string, key: "token" | "inbox_token") => (await s.r("/api/operator/control", { headers: { cookie } })).body[key] as string | null;

test("P12-control: a Full-control device's send reaches the real operator session stamped with its device; refusals reach nothing", { timeout: 120_000 }, async (t) => {
	const s = await stack(t);
	const full = await s.pair("Laptop"), view = await s.pair("Phone", "view");
	const provider = await MockProvider.start();
	let release!: () => void;
	const busy = new Promise<void>((done) => (release = done));
	const model = provider.addScript("remote-control", [{ kind: "text", text: "Ready." }, { kind: "hang", until: busy }, { kind: "text", text: "Seen." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const rpc = startRpc({ cwd: s.home, env: { ...agent.env, CP_HOME: s.home, PI_HOME: s.home }, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--model", model] });
	t.after(async () => { release(); await rpc.close(); agent.cleanup(); await provider.stop(); });
	rpc.send({ type: "prompt", id: "seed", message: "Stand by." });
	await rpc.waitFor((event) => event.type === "agent_settled", 30_000);
	assert.equal(readControlRecord(s.stateDir).state, "ok");
	const token = await controlToken(s, full.cookie, "token");
	assert.match(String(token), /^[0-9a-f]{64}$/, "a Full-control device gets the write token");
	assert.equal(await controlToken(s, view.cookie, "token"), null, "View-only never does");

	const sent = await s.r(MESSAGE, write(full.cookie, token, { kind: "message", text: "ship it" }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	await until(async () => provider.requests("remote-control").length, (n) => n >= 2, "the injected turn");
	const userTexts = () => provider.requests("remote-control").flatMap((request) => (request.body.messages as Array<{ role: string; content: unknown }>)
		.filter((message) => message.role === "user")
		.map((message) => typeof message.content === "string" ? message.content : (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("")));
	const injected = userTexts().map(parseDashboardText).filter((parsed) => parsed !== undefined);
	assert.deepEqual(injected.map((parsed) => [parsed.body, parsed.remote]), [["ship it", { sender: { device_id: full.id, name: "Laptop" }, editors: [] }]]);

	const named = await s.r(MESSAGE, write(full.cookie, token, { kind: "message", text: "refused write", remote: { device_id: view.id, name: "Boss" } }));
	assert.deepEqual([named.status, named.body.error], [400, "unknown field remote"]);
	const local = await s.r(MESSAGE, write(full.cookie, token, { kind: "message", text: "refused write" }, { origin: `http://127.0.0.1:${s.localPort}` }));
	assert.deepEqual([local.status, local.body.error], [403, `Origin must be ${ORIGIN}`], "a remote device writes only from its tunnel origin");
	const viewed = await s.r(MESSAGE, write(view.cookie, token, { kind: "message", text: "refused write" }));
	assert.deepEqual([viewed.status, viewed.body.error], [403, "View-only device: dashboard writes are refused"]);

	const held = await s.r(MESSAGE, write(full.cookie, token, { kind: "message", text: "later" }));
	assert.equal(held.body.state, "queued", "the session is mid-turn");
	const edited = await s.r("/api/operator/queue", write(full.cookie, token, { op: "edit", id: held.body.id, text: "later, edited" }));
	assert.equal(edited.status, 200, JSON.stringify(edited.body));
	const line = s.journal().find((row) => row.type === "edited" && row.id === held.body.id);
	assert.deepEqual(line?.remote, { device_id: full.id, name: "Laptop" }, "the edit names its device");
	release();
	await until(async () => userTexts().join("\n"), (text) => text.includes("later, edited"), "the queued send");
	assert.equal(userTexts().some((text) => text.includes("refused write")), false, "no refused write reached the session");
});

test("P12-legacy: an older running bridge without remote provenance refuses a remote send or edit 409 and is only asked its status", async (t) => {
	const s = await stack(t);
	const frames: Array<Record<string, unknown>> = [];
	const socket = controlSocketFile(s.stateDir);
	mkdirSync(dirname(socket), { recursive: true });
	const old = createServer((conn) => conn.on("data", (chunk) => {
		const frame = JSON.parse(String(chunk).trim()) as Record<string, unknown>;
		frames.push(frame);
		conn.end(`${JSON.stringify(frame.op === "status" ? { ok: true, result: { busy: false, pending: false, session_file: null, recent: [], files: true } } : { ok: true, result: { id: "dc-20260101000000-00000000", state: "delivered" } })}\n`);
	}));
	await new Promise<void>((done) => old.listen(socket, done));
	t.after(() => old.close());
	const csrf = randomBytes(32).toString("hex");
	writeFileSync(controlRecordFile(s.stateDir), JSON.stringify({ version: 1, pid: process.pid, socket, token: randomBytes(32).toString("hex"), csrf, started_at: new Date().toISOString() }));
	const full = await s.pair("Laptop");
	for (const [path, body] of [[MESSAGE, { kind: "message", text: "hi" }], ["/api/operator/queue", { op: "edit", id: "dc-20260101000000-00000000", text: "x" }]] as const) {
		const reply = await s.r(path, write(full.cookie, csrf, body));
		assert.equal(reply.status, 409, path);
		assert.match(String(reply.body.error), /predates remote-device provenance; restart the session/);
	}
	assert.deepEqual(frames.map((frame) => frame.op), ["status", "status"], "only the capability check reached the old bridge");
	assert.equal(s.journal().filter((row) => row.type === "refused").length, 2, "each refusal is journaled by the viewer");
});

test("P12-offline: with no operator session a remote message is held with its device for the next session to replay", async (t) => {
	const s = await stack(t);
	const full = await s.pair("Laptop");
	const held = await s.r(MESSAGE, write(full.cookie, await controlToken(s, full.cookie, "inbox_token"), { kind: "message", text: "when you are back" }));
	assert.deepEqual([held.status, held.body.state], [202, "held"]);
	assert.deepEqual(readInbox(s.stateDir).held.map((message) => [message.text, message.remote]), [["when you are back", { device_id: full.id, name: "Laptop" }]]);
});
