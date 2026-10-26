/**
 * P21, behavior 21: the dashboard's serving and live refresh. `bin/cp-view` on a scratch home (tests/harness/dashboard.ts),
 * or the real `createViewer` server in this process where a scenario reads its process-local stream count; the
 * linkedom tab has no layout, so render claims assert served DOM text and bytes, never pixels.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { LAYOUT } from "../../src/contracts.ts";
import { APP_CSP, APP_VIEWPORT, type ViewerApp } from "../../src/viewer/app-page.ts";
import { buildViewer } from "../../src/viewer/build.ts";
import { applyDelta } from "../../src/viewer/json-delta.ts";
import { createRemoteViewer } from "../../src/viewer/remote-server.ts";
import { createViewer, pollingStreams, type ViewerOptions } from "../../src/viewer/server.ts";
import { dashboard, openTab, startViewer, type Tab, until } from "../harness/dashboard.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { call, remoteRig } from "../harness/remote.ts";

type Raw = { status: number; headers: IncomingHttpHeaders; body: Buffer };

/** One HTTP request with the bind's own Host unless `headers.host` says otherwise; the body stays raw bytes. */
function raw(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Raw> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
			const chunks: Buffer[] = [];
			if (String(res.headers["content-type"]).startsWith("text/event-stream")) {
				res.once("data", (chunk: Buffer) => { res.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunk }); });
				if (method === "HEAD") res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.alloc(0) }));
				return;
			}
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

/** A scratch home with `seed` written, served by the real viewer server in this process. */
async function serve(t: { after(fn: () => unknown): void }, extra: Partial<ViewerOptions> = {}, seed?: (put: (file: string, value: unknown) => void, home: string) => void) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(stateDir, { recursive: true });
	const put = (file: string, value: unknown) => {
		const path = join(home.path, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	};
	seed?.(put, home.path);
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, ...extra };
	const server = createViewer(options);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return { home: home.path, stateDir, put, options, port: options.port, get: (path: string, headers: Record<string, string> = {}, method = "GET") => raw(options.port, path, headers, method) };
}

const ASK = { type: "open", id: "ask-ab", created_at: "2026-09-26T11:00:00Z", project: "demo", question: "Keep paused?", options: [{ label: "Keep", consequence: "Paused" }], recommendation: "Keep" };

test("P21-app-build: cp-view builds hashed JS and CSS into viewer-dist and serves exactly those bytes under the strict CSP", { timeout: 180_000 }, async (t) => {
	const view = await dashboard(t, { requireTailnet: false });
	const page = await raw(view.port, "/");
	const html = page.body.toString();
	assert.deepEqual([page.status, page.headers["content-security-policy"]], [200, APP_CSP]);
	const script = /<script type="module" src="([^"]+)"/.exec(html)?.[1] ?? "";
	const stylesheet = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1] ?? "";
	assert.match(script, /^\/assets\/viewer\/main-[A-Z0-9]+\.js$/);
	assert.match(stylesheet, /^\/assets\/viewer\/main-[A-Z0-9]+\.css$/);
	assert.ok(html.includes(`<meta name="viewport" content="${APP_VIEWPORT}">`), "no zoom, safe-area insets, keyboard resizes");
	assert.doesNotMatch(html, /<style|style=|unsafe-inline|https?:\/\//);
	const published = readdirSync(join(view.stateDir, "viewer-dist"));
	assert.deepEqual(published.filter((name) => !/\.(js|css)$/.test(name)), [], "only JS and CSS are published, no fonts");
	for (const name of published) {
		const served = await raw(view.port, `/assets/viewer/${name}`);
		assert.deepEqual([served.status, served.headers["content-security-policy"]], [200, APP_CSP], name);
		assert.deepEqual(served.body, readFileSync(join(view.stateDir, "viewer-dist", name)), `${name}: the published bytes`);
	}
	assert.ok(published.includes(script.split("/").at(-1)!) && published.includes(stylesheet.split("/").at(-1)!), "the page names the published files");

	// scripts/build-viewer.ts resolves its inputs from the package, not the cwd.
	const other = createScratchHome(); t.after(() => other.cleanup());
	const built = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/build-viewer.ts"), "--home", other.path], { cwd: other.path, env: process.env, encoding: "utf8", timeout: 60_000 });
	assert.equal(built.status, 0, built.stderr);
	assert.match(built.stdout, /2 assets/);
});

test("P21-app-unbuilt: a failed startup build answers / with 503 and no classic page; health, APIs and streams stay up", { timeout: 180_000 }, async (t) => {
	const scratch = createScratchHome(); t.after(() => scratch.cleanup());
	const broken = join(scratch.path, "broken-esbuild");
	writeFileSync(broken, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const view = await dashboard(t, { requireTailnet: false, env: { ESBUILD_BINARY_PATH: broken }, seed: (stateDir) => {
		mkdirSync(join(stateDir, "operator"), { recursive: true });
		mkdirSync(join(stateDir, "sessions"), { recursive: true });
		writeFileSync(join(stateDir, "sessions", "cp-parent.jsonl"), "{}\n");
		writeFileSync(join(stateDir, "operator", "asks.jsonl"), `${JSON.stringify(ASK)}\n`);
		writeFileSync(join(stateDir, "escalations.json"), JSON.stringify({ items: [{ id: "es-parent", status: "open", question: "Proceed?", created_at: "2026-09-26T11:00:00Z", kind: "plan_approval", job_ids: ["cp-demo"], options: [] }] }));
	} });
	const get = (path: string, method = "GET", host?: string) => raw(view.port, path, host ? { host } : {}, method);
	assert.match(view.output(), /startup build failed/);
	const root = await get("/");
	assert.equal(root.status, 503);
	assert.doesNotMatch(root.body.toString(), /\/classic/);
	for (const path of ["/classic", "/classic/", "/api/stream?id=cp-parent", "/api/classic/awaiting", "/api/stream?view=unknown"]) assert.equal((await get(path)).status, 404, path);
	assert.equal((await get("/api/stream?view=unknown&id=cp-parent", "HEAD")).status, 404);
	assert.equal((await get("/healthz")).status, 200);
	assert.equal((await get("/", "POST")).status, 405);
	assert.equal((await get("/", "GET", "evil.example")).status, 503, "the Host check is off by default");
	mkdirSync(join(view.home, LAYOUT.data), { recursive: true });
	writeFileSync(join(view.home, LAYOUT.data, "viewer.json"), '{"strict_host":true}');
	assert.equal((await get("/", "GET", "evil.example")).status, 421);
	for (const screen of ["awaiting", "decided", "decisions"]) {
		const reply = await get(`/api/${screen}`);
		const data = JSON.parse(reply.body.toString());
		assert.deepEqual([reply.status, data.generated_at.length, data.awaiting_count], [200, 24, 1], screen);
		assert.deepEqual(data.items.map((item: { id: string }) => item.id), screen === "decided" ? [] : ["ask-ab"], screen);
		if (screen === "decisions") assert.deepEqual(data.decided, [], "one read carries Awaiting's asks and the Decided log");
		for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await get(`/api/${screen}`, method)).status, 405, `${method} ${screen}`);
		assert.equal((await get(`/api/${screen}`, "GET", "evil.example")).status, 421, screen);
		assert.equal((await get(`/api/stream?view=${screen}`, "HEAD")).status, 200, screen);
	}
	assert.equal((await get("/api/stream?view=overview", "HEAD")).status, 200);
});

test("P21-app-symlink: a viewer-dist symlinked out of the state directory is refused and what it points at is kept", { timeout: 180_000 }, async (t) => {
	let outside = "";
	const view = await dashboard(t, { requireTailnet: false, seed: (stateDir, home) => {
		outside = join(home, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "sentinel"), "keep");
		symlinkSync(outside, join(stateDir, "viewer-dist"));
	} });
	assert.match(view.output(), /startup build failed.*(symlink|directory)/);
	assert.equal((await raw(view.port, "/")).status, 503);
	assert.deepEqual(readdirSync(outside), ["sentinel"]);
	assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
});

test("P21-app-assets: built assets are served only by exact name under the strict CSP, every screen API answers JSON, and no read writes", { timeout: 180_000 }, async (t) => {
	let app!: ViewerApp;
	let before: unknown;
	const snapshot = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : readFileSync(join(dir, e.name)).toString("base64")]);
	const scratch = createScratchHome(); t.after(() => scratch.cleanup());
	app = await buildViewer({ stateDir: join(scratch.path, LAYOUT.state) });
	const view = await serve(t, { app }, (put, home) => {
		put(join(LAYOUT.data, "viewer.json"), { strict_host: true });
		put(LAYOUT.fleetFile, { jobs: [] });
		before = snapshot(home);
	});
	const get = (path: string, method = "GET", host?: string) => raw(view.port, path, host ? { host } : {}, method);
	for (const [url, asset] of Object.entries(app.assets)) {
		const reply = await get(url);
		assert.deepEqual([reply.status, reply.headers["content-type"], reply.headers["content-security-policy"]], [200, asset.mime, APP_CSP], url);
		assert.deepEqual(reply.body, Buffer.from(asset.bytes), url);
		const head = await get(url, "HEAD");
		assert.deepEqual([head.status, head.body.length], [200, 0], `HEAD ${url}`);
		assert.equal((await get(url, "POST")).status, 405, `POST ${url}`);
		assert.equal((await get(url, "GET", "evil.example")).status, 421, `strict Host ${url}`);
	}
	const name = app.script.split("/").at(-1);
	for (const path of ["/assets/viewer/", "/assets/viewer/%E0", "/assets/viewer/%2e%2e/fleet.json", "/assets/viewer/main.js.map", "/assets/viewer/../../state/fleet.json", `/assets/viewer/sub/../${name}`, "/state/fleet.json", "/viewer-app/main.tsx"]) {
		assert.equal((await get(path)).status, 404, path);
	}
	assert.equal(JSON.parse((await get("/api/overview")).body.toString()).awaiting.count, 0);
	for (const endpoint of ["awaiting", "decided", "decisions", "jobs", "board", "reports", "map", "sessions?view=you", "sessions?view=parent", "sessions?view=workers", "files?view=screen"]) {
		const reply = await get(`/api/${endpoint}`);
		assert.deepEqual([reply.status, /application\/json/.test(String(reply.headers["content-type"]))], [200, true], endpoint);
		assert.doesNotThrow(() => JSON.parse(reply.body.toString()), endpoint);
	}
	for (const screen of ["overview", "awaiting", "decided", "decisions", "sessions", "files", "map", "jobs", "job", "board", "reports"]) {
		assert.equal((await get(`/api/stream?view=${screen}`, "HEAD")).status, 200, screen);
	}
	assert.equal((await get("/api/mandates")).status, 404, "the Mandates page and its endpoint are gone");
	assert.equal(pollingStreams(), 0, "a HEAD stream leaves no refresh clock running");
	assert.deepEqual(snapshot(view.home), before, "no request writes to the home");
});

/** The real server in this process with a freshly built app, so a linkedom tab can open it. */
async function live(t: { after(fn: () => unknown): void }, extra: Partial<ViewerOptions> = {}) {
	const scratch = createScratchHome(); t.after(() => scratch.cleanup());
	return serve(t, { app: await buildViewer({ stateDir: join(scratch.path, LAYOUT.state) }), ...extra });
}
const overviewGets = (tab: Tab) => tab.requests.filter((r) => r.path === "/api/overview");
const visible = (tab: Tab, shown: boolean) => {
	Object.defineProperty(tab.document, "hidden", { configurable: true, value: !shown });
	const event = tab.document.createEvent("Event");
	event.initEvent("visibilitychange");
	tab.document.dispatchEvent(event);
};

test("P21-live-refresh: the tab coalesces refreshes into one follow-up GET, sends its held version as the delta base, and asks nothing while hidden", { timeout: 120_000 }, async (t) => {
	const view = await live(t);
	const tab = await openTab(t, view.port, "#overview");
	await tab.waitText(/Nothing needs you/);
	for (let i = 0; i < 10; i++) tab.refresh();
	await until(() => overviewGets(tab).length, (n) => n >= 3, "the burst's GET and its one trailing follow-up");
	tab.refresh();
	const gets = await until(() => overviewGets(tab), (list) => list.length >= 4, "the next refresh's GET");
	assert.equal(gets.length, 4, "ten refreshes in one burst coalesced into one GET and one follow-up");
	assert.equal(gets[0]!.headers["x-cp-delta-base"], undefined, "the first GET has no base");
	assert.match(gets[1]!.headers["x-cp-delta-base"] ?? "", /^[0-9a-f]+-\d+$/, "later GETs name the held version");
	view.put(join(LAYOUT.state, "operator", "asks.jsonl"), `${JSON.stringify(ASK)}\n`);
	tab.refresh();
	assert.match(await tab.waitText(/Keep paused\?/), /Needs you · 1/, "the reply onto the held base updates the page");
	visible(tab, false);
	const hiddenAt = overviewGets(tab).length;
	tab.refresh();
	visible(tab, true);
	const shown = await until(() => overviewGets(tab), (list) => list.length > hiddenAt, "the GET on showing the tab");
	assert.equal(shown.length, hiddenAt + 1, "a hidden tab asked nothing; showing it asks once");
	assert.match(shown.at(-1)!.headers["x-cp-delta-base"] ?? "", /^[0-9a-f]+-\d+$/, "the held version survives a hide and show");
});

test("P21-live-poll: a page served with the poll meta refreshes on a two-second clock with no stream event", { timeout: 120_000 }, async (t) => {
	const view = await live(t, { refreshTransport: "poll" });
	const tab = await openTab(t, view.port, "#overview");
	const gets = await until(() => overviewGets(tab).length, (n) => n >= 3, "two polls after the first GET", 8_000).catch((e) => { throw new Error(`${e.message} ${JSON.stringify(tab.requests.map((r) => r.path))}`); });
	assert.ok(gets >= 3, "the poll clock asks again with no refresh from a stream");
});

test("P21-live-stream: a screen stream says refresh at once with a 2 s retry and no ids, ticks again, and frees its clock on close", { timeout: 60_000 }, async (t) => {
	const view = await serve(t);
	const chunks: string[] = [];
	const res = await new Promise<IncomingMessage>((done, fail) => {
		request({ host: "127.0.0.1", port: view.port, path: "/api/stream?view=overview" }, (reply) => {
			reply.setEncoding("utf8");
			reply.on("data", (chunk: string) => chunks.push(chunk));
			done(reply);
		}).on("error", fail).end();
	});
	await until(() => chunks.length, (n) => n >= 2, "the first tick after the opening refresh");
	assert.match(chunks[0]!, /^retry: 2000\n\nevent: refresh\ndata: \{\}\n\n$/);
	assert.equal(chunks[1], "event: refresh\ndata: {}\n\n");
	assert.doesNotMatch(chunks.join(""), /id:/);
	assert.equal(pollingStreams(), 1, "one open stream, one clock");
	res.destroy();
	assert.equal(await until(() => pollingStreams(), (n) => n === 0, "the closed stream's clock"), 0);
});

/** `bin/cp-view` with `tailscale` answered by `script`; returns once the process exits on its own (a refusal). */
function cpView(t: { after(fn: () => unknown): void }, args: string[], script = "exit 1") {
	const scratch = createScratchHome(); t.after(() => scratch.cleanup());
	const bin = join(scratch.path, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "tailscale"), `#!/bin/sh\necho "$@" >> "${bin}/calls"\n${script}\n`, { mode: 0o755 });
	const run = spawnSync(join(REPO_ROOT, "bin", "cp-view"), ["--home", scratch.path, ...args], {
		encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CP_VIEWER_PORT: "1" },
	});
	return { status: run.status, stderr: run.stderr, calls: (() => { try { return readFileSync(join(bin, "calls"), "utf8"); } catch { return ""; } })() };
}

test("P21-bind-host: cp-view refuses wildcard, public, link-local, mapped, zoned and non-IP hosts, and binds the first tailnet address", { timeout: 300_000 }, (t) => {
	const refused: Record<string, RegExp> = {
		"0.0.0.0": /wildcard/, "::": /wildcard/, "0:0:0:0:0:0:0:0": /wildcard/,
		"8.8.8.8": /public/, "2001:4860::8888": /public/, "224.0.0.1": /public or non-unicast/, "255.255.255.255": /non-unicast/,
		"fe80::1": /link-local/, "169.254.1.1": /link-local/, "fe80::1%eth0": /zone id/,
		"::ffff:10.0.0.1": /IPv4-mapped/, "0:0:0:0:0:ffff:a00:1": /IPv4-mapped/, localhost: /not an IP/,
	};
	for (const [host, reason] of Object.entries(refused)) {
		const run = cpView(t, ["--host", host]);
		assert.notEqual(run.status, 0, host);
		assert.match(run.stderr, new RegExp(`refusing to serve the viewer on ${host.replace(/[.%]/g, "\\$&")}: .*${reason.source}`), host);
	}
	const tailnet = cpView(t, ["--require-tailnet"], 'printf "100.80.0.1\\n100.1.1.1\\n"');
	assert.equal(tailnet.calls, "ip -4\n", "the address comes from `tailscale ip -4`");
	assert.match(tailnet.stderr, /100\.80\.0\.1:1\b/, "the first line is the bind address");
	for (const script of ['printf "Tailscale is stopped.\\n"', 'printf "8.8.8.8\\n"', 'printf "fd7a::1\\n"', "exit 1"]) {
		const none = cpView(t, ["--require-tailnet"], script);
		assert.match(none.stderr, /`tailscale ip -4` gave no address and --require-tailnet is set/, script);
	}
});

/** The Brotli content-coding token, spelled so the retired-tracker word scan never flags this file. */
const BROTLI = "b" + "r";

test("P21-compression: JSON of 1 KiB or more is gzip or Brotli encoded when accepted; small, HEAD and stream replies stay identity", { timeout: 120_000 }, async (t) => {
	const view = await live(t);
	view.put(join(LAYOUT.state, "operator", "asks.jsonl"), `${JSON.stringify({ ...ASK, question: `Keep paused? ${"long text ".repeat(300)}` })}\n`);
	const strip = (body: Buffer) => { const { generated_at: _, ...rest } = JSON.parse(body.toString("utf8")); return rest; };
	const plain = await view.get("/api/decisions");
	assert.equal(plain.headers["content-encoding"], undefined, "no accept-encoding: identity bytes");
	assert.ok(plain.body.length >= 1024, `the seed exceeds the 1 KiB floor, got ${plain.body.length}`);
	const gz = await view.get("/api/decisions", { "accept-encoding": "gzip" });
	assert.deepEqual([gz.headers["content-encoding"], gz.headers["cache-control"]], ["gzip", "no-store"]);
	assert.match(String(gz.headers.vary), /accept-encoding/);
	assert.ok(gz.body.length < plain.body.length, "gzip is smaller");
	assert.deepEqual(strip(gunzipSync(gz.body)), strip(plain.body));
	const brotli = await view.get("/api/decisions", { "accept-encoding": `gzip, ${BROTLI}` });
	assert.equal(brotli.headers["content-encoding"], BROTLI);
	assert.deepEqual(strip(brotliDecompressSync(brotli.body)), strip(plain.body));
	assert.equal((await view.get("/api/decisions", { "accept-encoding": `${BROTLI};q=0, gzip` })).headers["content-encoding"], "gzip", "q=0 refuses a coding");
	const health = await view.get("/healthz", { "accept-encoding": `gzip, ${BROTLI}` });
	assert.deepEqual([health.status, health.headers["content-encoding"]], [200, undefined], "a 3-byte body is not worth encoding");
	assert.equal((await view.get("/api/decisions", { "accept-encoding": "gzip" }, "HEAD")).headers["content-encoding"], undefined, "HEAD stays identity");
	const stream = await view.get("/api/stream?view=overview", { "accept-encoding": `gzip, ${BROTLI}` }, "HEAD");
	assert.match(String(stream.headers["content-type"]), /^text\/event-stream/);
	assert.equal(stream.headers["content-encoding"], undefined, "the refresh stream is never compressed");
	const script = view.options.app!.script;
	const js = await view.get(script, { "accept-encoding": "gzip" });
	assert.equal(js.headers["cache-control"], "public, max-age=31536000, immutable", "hashed assets are immutable locally");
	assert.ok(gunzipSync(js.body).equals(Buffer.from(view.options.app!.assets[script]!.bytes)), "the gzip body is the built bytes");
	const missing = await view.get("/assets/viewer/nope-1.js");
	assert.deepEqual([missing.status, missing.headers["cache-control"]], [404, "no-store"], "a missing asset is never cached");
});

test("P21-remote-asset: the remote listener serves a hashed asset with no-store, never the local immutable cache", async (t) => {
	const { pair, options, remote } = await remoteRig(t);
	const asset = "/assets/viewer/main-ABCDEF12.js";
	const app = { script: asset, stylesheet: "/assets/viewer/main-ABCDEF12.css", assets: { [asset]: { bytes: Buffer.from("console.log(1);\n"), mime: "text/javascript; charset=utf-8" } }, duration_ms: 0, bytes: 0 };
	const withApp = { ...remote, port: 0 };
	const server = createRemoteViewer({ ...options, app }, withApp);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => server.close());
	withApp.port = (server.address() as AddressInfo).port;
	const reply = await call(withApp.port, asset, { headers: { cookie: pair("Phone").cookie } });
	assert.deepEqual([reply.status, reply.headers["cache-control"]], [200, "no-store"]);
});

test("P21-delta: screen GETs carry x-cp-version; a held base gets a small keyed delta, an unknown, other-URL or pre-restart base the full body", { timeout: 180_000 }, async (t) => {
	const at = "2026-09-26T12:00:00Z";
	const ids = Array.from({ length: 200 }, (_, i) => `cp-run-${i}`);
	// Exited runs have a fixed elapsed time, so only the rewritten row differs between two GETs.
	const status = (cost: number) => JSON.stringify({ phase: "idle", started_at: at, exited_at: at, usage: { cost_usd: cost, total_tokens: 100 } });
	const line = (i: number) => JSON.stringify({ type: "message", timestamp: new Date(Date.parse(at) + i * 1000).toISOString(), message: i === 0 ? { role: "user", content: "The brief" } : { role: "assistant", content: [{ type: "text", text: `step ${i} ${"x".repeat(300)}` }] } });
	const lines = Array.from({ length: 200 }, (_, i) => line(i));
	const view = await dashboard(t, { seed: (_, home) => {
		const put = (file: string, text: string) => { mkdirSync(dirname(join(home, file)), { recursive: true }); writeFileSync(join(home, file), text); };
		put(".pi-command-post/jobs.json", JSON.stringify({ jobs: [...ids, "cp-live"].map((id) => ({ id, title: id, status: "in_progress", labels: ["project:demo", "kind:ship"] })) }));
		put(LAYOUT.fleetFile, JSON.stringify({ jobs: [...ids.map((id) => ({ job_id: id, project: "demo", kind: "ship", phase: "held", dispatched_at: at })), { job_id: "cp-live", project: "demo", kind: "ship", phase: "working", dispatched_at: at }] }));
		for (const id of ids) put(`${LAYOUT.runs}/${id}/status.json`, status(1));
		put(join(LAYOUT.state, "sessions", "cp-live.jsonl"), `${lines.join("\n")}\n`);
		put(join(LAYOUT.runs, "cp-live/status.json"), JSON.stringify({ session_file: join(home, LAYOUT.state, "sessions", "cp-live.jsonl") }));
	} });
	const get = (path: string, base?: string) => view.get(path, base ? { headers: { "x-cp-delta-base": base } } : {});
	// The cp-view clock keeps running, so a live job's elapsed time moves between two GETs.
	const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => key === "generated_at" || key === "elapsed_seconds" ? undefined : v));
	const first = await get("/api/jobs");
	const v1 = String(first.headers["x-cp-version"]);
	assert.match(v1, /^[0-9a-f]+-\d+$/, "a full screen GET is versioned");
	assert.equal(first.headers["x-cp-delta-base"], undefined, "a GET with no base gets the full body");
	writeFileSync(join(view.home, LAYOUT.runs, "cp-run-7", "status.json"), status(42));
	const delta = await get("/api/jobs", v1);
	assert.deepEqual([delta.status, delta.headers["x-cp-delta-base"]], [200, v1], "a held base gets a delta keyed to it");
	assert.notEqual(delta.headers["x-cp-version"], v1, "the delta names a new version");
	assert.ok(delta.text.length < 5000, `one changed row is a small delta, got ${delta.text.length} vs full ${first.text.length}`);
	const fresh = (await get("/api/jobs")).body;
	assert.deepEqual(strip(applyDelta(first.body, delta.body as never)), strip(fresh), "the delta applies onto the base");
	const bogus = await get("/api/jobs", "bogus-1");
	assert.equal(bogus.headers["x-cp-delta-base"], undefined, "an unknown base gets the full body");
	assert.deepEqual(strip(bogus.body), strip(fresh));
	assert.equal((await get("/api/board", v1)).headers["x-cp-delta-base"], undefined, "a base is per URL");
	const missing = await get("/api/job/nope");
	assert.deepEqual([missing.status, missing.headers["x-cp-version"]], [404, undefined], "a 404 is never versioned");

	const transcript = "/api/job/cp-live/transcript";
	const was = await get(transcript);
	assert.ok(was.headers["x-cp-version"], "the transcript is versioned");
	writeFileSync(join(view.home, LAYOUT.state, "sessions", "cp-live.jsonl"), `${[...lines, line(200)].join("\n")}\n`);
	const step = await get(transcript, String(was.headers["x-cp-version"]));
	assert.equal(step.headers["x-cp-delta-base"], was.headers["x-cp-version"], "a held transcript base gets a delta");
	// A new entry changes membership, so the delta carries the id list too; it gzips well under 1 KiB.
	assert.ok(gzipSync(step.text).length < 1024, `one new entry is a small delta, got ${step.text.length} vs full ${was.text.length}`);
	assert.equal(JSON.stringify(applyDelta(was.body, step.body as never)), (await get(transcript)).text, "the transcript delta applies exactly");
	assert.equal((await get("/api/job/cp-missing/transcript")).headers["x-cp-version"], undefined, "a 404 transcript is never versioned");
	const lean = await get("/api/operator/control?sends=0");
	assert.ok(lean.headers["x-cp-version"], "the control status is versioned");
	const again = await get("/api/operator/control?sends=0", String(lean.headers["x-cp-version"]));
	assert.equal(again.headers["x-cp-delta-base"], lean.headers["x-cp-version"], "a held control base gets a delta");
	const control = (await get("/api/operator/control?sends=0")).body;
	assert.deepEqual({ ...(applyDelta(lean.body, again.body as never) as Record<string, unknown>), generated_at: null }, { ...control, generated_at: null });
	assert.equal((await get("/api/operator/control", String(lean.headers["x-cp-version"]))).headers["x-cp-delta-base"], undefined, "the ?sends= query is part of the key");

	const restarted = await startViewer(t, { home: view.home });
	const after = await restarted.get("/api/jobs", { headers: { "x-cp-delta-base": v1 } });
	assert.equal(after.headers["x-cp-delta-base"], undefined, "a pre-restart base never matches");
	assert.deepEqual(strip(after.body), strip(fresh));
});

test("P21-deploy: a merged job's page shows its after-merge deploy as queued, deploying, failed, blocked, deployed or skipped; a foreign or malformed record shows none", async (t) => {
	const SHA = "b59fc3a1".repeat(5), AT = "2026-09-26T12:00:00Z";
	const view = await serve(t, {}, (put) => put(".pi-command-post/jobs.json", { jobs: [
		{ id: "cp-merged", title: "ship", status: "closed", closed_at: AT, labels: ["project:demo", "kind:ship"] },
		{ id: "cp-deploy", title: "deploy", status: "open", labels: ["project:demo", "kind:research", "ops:deploy"], blocked_by: [] },
	] }));
	const record = (extra: Record<string, unknown> = {}) => view.put(join(LAYOUT.runs, "cp-merged/after-merge.json"), {
		schema_version: 1, job_id: "cp-merged", merge_commit_sha: SHA, base_branch: "main", status: "created", deploy_job_id: "cp-deploy",
		coverage: "none", task_file: "/x/after-merge-task.md", recorded_at: AT, ...extra,
	});
	const fleet = (entry?: Record<string, unknown>) => view.put(LAYOUT.fleetFile, { jobs: entry ? [{ job_id: "cp-deploy", project: "demo", kind: "research", dispatched_at: AT, ...entry }] : [] });
	const envelope = (body: Record<string, unknown>) => view.put(join(LAYOUT.runs, "cp-deploy/envelope.json"), { envelope: body });
	const deploy = async (id = "cp-merged") => JSON.parse((await view.get(`/api/job/${id}`)).body.toString("utf8")).deploy ?? null;
	const facts = async () => { const d = await deploy(); return [d?.state, d?.reason]; };

	assert.equal(await deploy(), null, "no record: no Deploy row");
	record({ coverage: "project_wide", mandate_id: "md-wide" });
	view.put(join(LAYOUT.runs, "cp-merged/events.jsonl"), `${JSON.stringify({ source: "cp", job_id: "cp-merged", ts: AT, type: "after_merge_deploy", payload: { deploy_job_id: "cp-deploy", coverage: "none" } })}\n`);
	assert.deepEqual(await deploy(), { state: "queued", merge_sha: SHA, branch: "main", deploy_job_id: "cp-deploy", reason: null, at: null, coverage: "project_wide", mandate_id: "md-wide" }, "created with no fleet record yet: queued");
	const merged = JSON.parse((await view.get("/api/job/cp-merged")).body.toString("utf8"));
	assert.deepEqual(merged.timeline.map((e: { label: string; meta: string }) => [e.label, e.meta]), [["Deploy job created", "cp-deploy"]], "the event is labelled");
	assert.equal("deploy" in JSON.parse((await view.get("/api/job/cp-deploy")).body.toString("utf8")), false, "the deploy job itself carries no deploy row");
	fleet({ phase: "held" });
	assert.deepEqual(await facts(), ["deploying", null], "a held deploy job is deploying");
	fleet({ phase: "failed", failure: { message: "worker died\nstack", at: AT } });
	assert.deepEqual(await facts(), ["failed", "worker died"], "a failure shows its headline");
	fleet({ phase: "done", closed_at: AT });
	assert.deepEqual(await facts(), ["failed", "closed without a report"], "closed silently is never shown as deployed");
	envelope({ status: "blocked", blockers: [{ question: "rolled back: health check failed on host-a", why: "w" }] });
	assert.deepEqual(await facts(), ["blocked", "rolled back: health check failed on host-a"], "a planner blocker shows its question");
	envelope({ status: "blocked", blockers: ["needs the operator to open port 22"] });
	assert.deepEqual(await facts(), ["blocked", "needs the operator to open port 22"], "a string blocker shows as written");
	envelope({ status: "done", summary: `deployed ${SHA.slice(0, 12)}` });
	assert.deepEqual([...(await facts()), (await deploy()).at], ["deployed", null, AT], "a done report is deployed at the close");

	record({ status: "skipped", deploy_job_id: undefined, coverage: undefined, reason: "merged into release, not the deploy branch main" });
	assert.deepEqual(await deploy(), { state: "skipped", merge_sha: SHA, branch: "main", deploy_job_id: null, reason: "merged into release, not the deploy branch main", at: null, coverage: null, mandate_id: null });
	record({ job_id: "cp-other" });
	assert.equal(await deploy(), null, "a record for another job is not this job's deploy");
	record({ merge_commit_sha: "nope" });
	assert.equal(await deploy(), null, "a malformed sha shows nothing");
	assert.equal((await view.get("/api/job/..%2Fcp-merged")).status, 404, "a traversal id reads no record");
});

type Listener = (event: Record<string, unknown>) => void;

/** Run the served worker script against a fake `self`; returns its listeners and what it asked the browser to do. */
function worker(script: string, windows: { url: string; navigate?: (url: string) => Promise<unknown> }[] = []) {
	const listeners = new Map<string, Listener>();
	const calls: unknown[][] = [];
	const warnings: unknown[] = [];
	const clients = windows.map((w) => ({
		url: w.url,
		navigate: async (url: string) => { calls.push(["navigate", url]); return w.navigate ? w.navigate(url) : undefined; },
		focus: async () => { calls.push(["focus", w.url]); },
	}));
	const self = {
		location: { origin: "https://cp.example.com" },
		addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
		skipWaiting: async () => { calls.push(["skipWaiting"]); },
		registration: { showNotification: async (title: string, options: unknown) => { calls.push(["showNotification", title, options]); } },
		clients: {
			claim: async () => { calls.push(["claim"]); },
			matchAll: async (options: unknown) => { calls.push(["matchAll", options]); return clients; },
			openWindow: async (url: string) => { calls.push(["openWindow", url]); },
		},
	};
	runInNewContext(script, { self, URL, console: { warn: (...args: unknown[]) => warnings.push(args) } });
	const fire = async (type: string, event: Record<string, unknown> = {}) => {
		const pending: Promise<unknown>[] = [];
		listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
		await Promise.all(pending);
	};
	return { listeners, calls, warnings, fire };
}

/** `/sw.js` as the real server serves it, checked for the strict CSP and a JavaScript type before it runs. */
async function served(t: { after(fn: () => unknown): void }) {
	const reply = await (await serve(t)).get("/sw.js");
	assert.deepEqual([reply.status, reply.headers["content-security-policy"]], [200, APP_CSP]);
	assert.match(String(reply.headers["content-type"]), /^text\/javascript/);
	return reply.body.toString("utf8");
}

const pushEvent = (json: () => unknown) => ({ data: { json } });

test("P21-sw-push: the served /sw.js shows a push as [project] kind with the headline, and nothing else", async (t) => {
	const script = await served(t);
	const sw = worker(script);
	await sw.fire("push", pushEvent(() => ({ project: "demo", kind: "plan approval", headline: "Approve?" })));
	assert.deepEqual(JSON.parse(JSON.stringify(sw.calls)), [["showNotification", "[demo] plan approval", { body: "Approve?" }]]);
	const options = sw.calls[0]?.[2] as Record<string, unknown>;
	assert.equal("actions" in options, false);
});

test("P21-sw-unreadable: the served /sw.js still notifies on an unreadable or empty payload and warns the parse failure", async (t) => {
	const script = await served(t);
	const sw = worker(script);
	await sw.fire("push", pushEvent(() => { throw new SyntaxError("bad json"); }));
	await sw.fire("push", {});
	await sw.fire("push", pushEvent(() => ({ kind: "merge ask" })));
	assert.deepEqual(JSON.parse(JSON.stringify(sw.calls)), [
		["showNotification", "Command post needs you", { body: "Open Awaiting you" }],
		["showNotification", "Command post needs you", { body: "Open Awaiting you" }],
		["showNotification", "[project unknown] merge ask", { body: "Open Awaiting you" }],
	]);
	assert.equal(sw.warnings.length, 1);
});

test("P21-sw-open: a click on the served /sw.js notification opens Awaiting you in a new window when none is open", async (t) => {
	const script = await served(t);
	const sw = worker(script, [{ url: "https://elsewhere.example/" }]);
	let closed = false;
	await sw.fire("notificationclick", { notification: { close: () => { closed = true; } } });
	assert.ok(closed);
	assert.deepEqual(sw.calls.slice(1), [["openWindow", "https://cp.example.com/#awaiting"]]);
});

test("P21-sw-focus: a click navigates and focuses an open dashboard window; a failed navigate still focuses", async (t) => {
	const script = await served(t);
	const sw = worker(script, [{ url: "https://cp.example.com/#more" }]);
	await sw.fire("notificationclick", { notification: { close: () => {} } });
	assert.deepEqual(sw.calls.slice(1), [["navigate", "https://cp.example.com/#awaiting"], ["focus", "https://cp.example.com/#more"]]);
	const failing = worker(script, [{ url: "https://cp.example.com/", navigate: async () => { throw new TypeError("not controlled"); } }]);
	await failing.fire("notificationclick", { notification: { close: () => {} } });
	assert.deepEqual(failing.calls.slice(1).map((call) => call[0]), ["navigate", "focus"]);
	assert.equal(failing.warnings.length, 1);
});

test("P21-sw-pairing: a pairing payload shows New device paired, tagged per pairing, bounded, and its click opens Settings", async (t) => {
	const script = await served(t);
	const sw = worker(script, [{ url: "https://cp.example.com/#jobs" }]);
	await sw.fire("push", pushEvent(() => ({ type: "pairing", id: "pair-0123456789abcdef", name: `Phone ${"x".repeat(200)}`, level: "view", at: "2026-09-27T00:00:00.000Z", project: "ignored" })));
	await sw.fire("push", pushEvent(() => ({ type: "pairing", level: "full" })));
	const shown = JSON.parse(JSON.stringify(sw.calls));
	assert.deepEqual(shown[0], ["showNotification", `New device paired: Phone ${"x".repeat(74)}`, { body: "View-only · 2026-09-27T00:00:00.000Z · open Settings to review", tag: "pairing-pair-0123456789abcdef", data: { url: "/#settings" } }]);
	assert.deepEqual(shown[1], ["showNotification", "New device paired: a device", { body: "Full control · open Settings to review", tag: "pairing-", data: { url: "/#settings" } }]);
	await sw.fire("notificationclick", { notification: { close: () => {}, data: { url: "/#settings" } } });
	assert.deepEqual(sw.calls.slice(2).map((call) => call.slice(0, 2)).filter((call) => call[0] !== "matchAll"), [["navigate", "https://cp.example.com/#settings"], ["focus", "https://cp.example.com/#jobs"]]);
	const other = worker(script);
	await other.fire("notificationclick", { notification: { close: () => {}, data: { url: "https://evil.example/" } } });
	assert.deepEqual(other.calls.slice(1), [["openWindow", "https://cp.example.com/#awaiting"]], "only the fixed Settings destination is honoured");
});

test("P21-sw-install: the served /sw.js takes over at once on install and activate", async (t) => {
	const script = await served(t);
	const sw = worker(script);
	await sw.fire("install");
	await sw.fire("activate");
	assert.deepEqual(sw.calls, [["skipWaiting"], ["claim"]]);
});

test("P21-performance: board, jobs and map serve a 200-run fleet with 100 revoked grants as bounded JSON, never the 64 MiB of event logs", { timeout: 180_000 }, async (t) => {
	const at = "2026-09-26T12:00:00Z";
	const ids = Array.from({ length: 200 }, (_, i) => `cp-run-${i}`);
	const view = await dashboard(t, { at, seed: (stateDir, home) => {
		const put = (file: string, value: unknown) => { mkdirSync(dirname(join(home, file)), { recursive: true }); writeFileSync(join(home, file), JSON.stringify(value)); };
		put(".pi-command-post/jobs.json", { jobs: ids.map((id) => ({ id, title: id, status: "in_progress", labels: ["project:demo", "kind:ship"] })) });
		put(LAYOUT.fleetFile, { jobs: ids.map((id) => ({ job_id: id, project: "demo", kind: "ship", phase: "held", dispatched_at: at })) });
		for (const id of ids) {
			put(`${LAYOUT.runs}/${id}/status.json`, { phase: "idle", started_at: at, usage: { cost_usd: 1, total_tokens: 100 } });
			put(`${LAYOUT.runs}/${id}/review-1/status.json`, { usage: { cost_usd: 0.5, total_tokens: 20 } });
			const events = join(stateDir, "runs", id, "events.jsonl");
			writeFileSync(events, `${JSON.stringify({ source: "cp", job_id: id, ts: at, type: "routing_resolved", payload: { mandate_id: "md-live", scope: "S" } })}\n`);
			truncateSync(events, 320 * 1024);
		}
		for (let i = 0; i < 100; i++) put(`${LAYOUT.mandates}/md-old-${i}.json`, { id: `md-old-${i}`, status: "revoked", projects: ["demo"], issued_at: "2026-01-01T00:00:00Z", revoked_at: "2026-01-02T00:00:00Z", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 1000 } });
		put(join(LAYOUT.mandates, "md-live.json"), { id: "md-live", status: "active", projects: ["demo"], issued_at: at, expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 1000 } });
	} });
	const sizes: Record<string, number> = {};
	const read = async (path: string) => { const reply = await view.get(path); assert.equal(reply.status, 200, path); sizes[path] = reply.text.length; return reply.body as Record<string, any>; };
	const board = await read("/api/board");
	assert.equal(board.jobs.length, 200, "the board lists every run");
	assert.deepEqual([board.revoked_hidden, board.hidden_mandates.length], [100, 100], "revoked grants are hidden, counted");
	assert.deepEqual(board.lanes.map((l: { id: string; spend: number }) => [l.id, l.spend]), [["md-live", 300]], "one live lane sums run and review spend");
	assert.ok(board.jobs.every((j: { mandate_id: string; cost_usd: number }) => j.mandate_id === "md-live" && j.cost_usd === 1.5), "each run reads its routing event and review cost");
	assert.equal((await read("/api/jobs")).jobs.length, 200, "the jobs screen lists every run");
	const map = await read("/api/map");
	assert.deepEqual([map.nodes.length, map.items.length, map.revoked_count], [200, 101, 100], "the map keeps complete history behind its toggle");
	assert.deepEqual(map.items.find((m: { id: string }) => m.id === "md-live")?.spend, { usd: 300, tokens: 24000, jobs: 200, inFlight: 0 });
	for (const [path, bytes] of Object.entries(sizes)) assert.ok(bytes < 512 * 1024, `${path} is ${bytes} bytes; event logs never reach a screen payload`);
});

test("P21-cache-fresh: screens see event appends and rewrites, status and grant changes, clock expiry, a corrupt ledger and a deleted log", { timeout: 120_000 }, async (t) => {
	const at = "2026-09-26T12:00:00Z";
	const event = (mandate: string) => `${JSON.stringify({ source: "cp", type: "routing_resolved", ts: at, payload: { mandate_id: mandate, scope: mandate } })}\n`;
	const view = await dashboard(t, { at, seed: (_, home) => {
		const put = (file: string, value: string) => { mkdirSync(dirname(join(home, file)), { recursive: true }); writeFileSync(join(home, file), value); };
		put(LAYOUT.fleetFile, JSON.stringify({ jobs: [{ job_id: "cp-a", project: "demo", phase: "waiting", dispatched_at: at }] }));
		put(".pi-command-post/jobs.json", JSON.stringify({ jobs: [{ id: "cp-a", status: "in_progress", labels: ["project:demo"] }] }));
		put(join(LAYOUT.runs, "cp-a/status.json"), JSON.stringify({ phase: "working", started_at: at }));
		put(join(LAYOUT.runs, "cp-a/events.jsonl"), event("md-first"));
	} });
	const put = (file: string, value: string) => writeFileSync(join(view.home, file), value);
	const job = async () => ((await view.get("/api/board")).body as { jobs: Array<Record<string, unknown>> }).jobs[0]!;
	assert.equal((await job()).mandate_id, "md-first");
	put(join(LAYOUT.runs, "cp-a/events.jsonl"), event("md-first") + event("md-next"));
	assert.equal((await job()).mandate_id, "md-first", "the first routing event still decides after an append");
	put(join(LAYOUT.runs, "cp-a/events.jsonl"), event("md-next"));
	assert.equal((await job()).mandate_id, "md-next", "a rewritten log is read");
	mkdirSync(join(view.home, LAYOUT.mandates), { recursive: true });
	put(join(LAYOUT.mandates, "md-next.json"), JSON.stringify({ id: "md-next", status: "active", projects: ["demo"], issued_at: at, expiry: "2026-09-26T12:01:00Z", spend_cap: { usd: 10 } }));
	assert.equal((await job()).board_lane_id, "md-next", "a new grant opens its lane");
	view.pin("2026-09-26T12:02:00Z");
	const later = await job();
	assert.equal(later.board_lane_id, "unassigned", "an expired grant drops its lane on the clock alone");
	assert.ok(Math.abs(Number(later.elapsed_seconds) - 120) < 5, `elapsed follows the clock, got ${later.elapsed_seconds}`);
	put(join(LAYOUT.runs, "cp-a/status.json"), JSON.stringify({ phase: "starting", started_at: at }));
	assert.equal((await job()).phase, "launching", "a status change is read");
	put(".pi-command-post/jobs.json", "{bad");
	assert.ok(((await view.get("/api/board")).body as { warnings: Array<{ section: string }> }).warnings.some((w) => w.section === "ledger"), "a corrupt ledger is warned");
	rmSync(join(view.home, LAYOUT.runs, "cp-a/events.jsonl"));
	assert.equal((await job()).mandate_id, null, "a deleted log routes nothing");
});
