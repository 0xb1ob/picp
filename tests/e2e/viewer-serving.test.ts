/**
 * P21, behavior 21: the dashboard's serving and live refresh. `bin/cp-view` on a scratch home (tests/harness/dashboard.ts),
 * or the real `createViewer` server in this process where a scenario reads its process-local stream count; the
 * linkedom tab has no layout, so render claims assert served DOM text and bytes, never pixels.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { APP_CSP, APP_VIEWPORT, type ViewerApp } from "../../src/viewer/app-page.ts";
import { buildViewer } from "../../src/viewer/build.ts";
import { createViewer, pollingStreams, type ViewerOptions } from "../../src/viewer/server.ts";
import { dashboard } from "../harness/dashboard.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";

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
