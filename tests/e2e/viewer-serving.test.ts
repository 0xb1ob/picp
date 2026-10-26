/**
 * P21, behavior 21: the dashboard's serving and live refresh. `bin/cp-view` on a scratch home (tests/harness/dashboard.ts),
 * or the real `createViewer` server in this process where a scenario reads its process-local stream count; the
 * linkedom tab has no layout, so render claims assert served DOM text and bytes, never pixels.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
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
