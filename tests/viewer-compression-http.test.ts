import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createViewer } from "../src/viewer/server.ts";
import { LAYOUT } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";
import { call, remoteRig } from "./harness/remote.ts";
import { createRemoteViewer } from "../src/viewer/remote-server.ts";

test("bodies of at least 1 KiB are gzip/br-encoded when accepted; streams, small and HEAD replies stay identity", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	const ask = { type: "open", id: "ask-ab", created_at: "2026-09-26T11:00:00Z", project: "demo", question: `Keep paused? ${"long text ".repeat(300)}`, options: [{ label: "Keep", consequence: "Paused" }], recommendation: "Keep" };
	writeFileSync(join(stateDir, "operator", "asks.jsonl"), `${JSON.stringify(ask)}\n`);
	const asset = "/assets/viewer/main-ABCDEF12.js";
	const app = { script: asset, stylesheet: "/assets/viewer/main-ABCDEF12.css", assets: { [asset]: { bytes: Buffer.from("console.log(1);\n".repeat(200)), mime: "text/javascript; charset=utf-8" } }, duration_ms: 0, bytes: 0 };
	const options = { home: home.path, stateDir, host: "127.0.0.1", port: 0, app };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, options.host, resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const get = (path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: options.port, path, method, headers }, (res) => {
			const chunks: Buffer[] = [];
			if (res.headers["content-type"]?.startsWith("text/event-stream")) { res.destroy(); resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.alloc(0) }); return; }
			res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject); req.end();
	});
	const strip = (body: Buffer) => { const { generated_at: _, ...rest } = JSON.parse(body.toString("utf8")); return rest; };

	const plain = await get("/api/decisions");
	assert.equal(plain.status, 200);
	assert.equal(plain.headers["content-encoding"], undefined, "no accept-encoding: identity bytes as before");
	assert.ok(plain.body.length >= 1024, `fixture must exceed the 1 KiB floor, got ${plain.body.length}`);

	const gz = await get("/api/decisions", { "accept-encoding": "gzip" });
	assert.equal(gz.headers["content-encoding"], "gzip");
	assert.match(String(gz.headers.vary), /accept-encoding/);
	assert.equal(gz.headers["cache-control"], "no-store");
	assert.ok(gz.body.length < plain.body.length);
	assert.deepEqual(strip(gunzipSync(gz.body)), strip(plain.body));

	const br = await get("/api/decisions", { "accept-encoding": "gzip, br" });
	assert.equal(br.headers["content-encoding"], "br");
	assert.deepEqual(strip(brotliDecompressSync(br.body)), strip(plain.body));
	assert.equal((await get("/api/decisions", { "accept-encoding": "br;q=0, gzip" })).headers["content-encoding"], "gzip", "q=0 refuses a coding");

	const health = await get("/healthz", { "accept-encoding": "gzip, br" });
	assert.equal(health.status, 200);
	assert.equal(health.headers["content-encoding"], undefined, "a 3-byte body is not worth encoding");
	assert.equal((await get("/api/decisions", { "accept-encoding": "gzip" }, "HEAD")).headers["content-encoding"], undefined);

	const stream = await get("/api/stream?view=overview", { "accept-encoding": "gzip, br" }, "HEAD");
	assert.match(String(stream.headers["content-type"]), /^text\/event-stream/);
	assert.equal(stream.headers["content-encoding"], undefined, "the refresh stream is never compressed");

	const js = await get(asset, { "accept-encoding": "gzip" });
	assert.equal(js.status, 200);
	assert.equal(js.headers["cache-control"], "public, max-age=31536000, immutable", "hashed assets are immutable locally");
	assert.equal(gunzipSync(js.body).toString("utf8"), "console.log(1);\n".repeat(200));
	const missing = await get("/assets/viewer/nope-1.js");
	assert.equal(missing.status, 404);
	assert.equal(missing.headers["cache-control"], "no-store", "a missing asset is never cached");
});

test("the remote listener serves a hashed /assets/viewer/* asset with no-store, never the local immutable cache", async (t) => {
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
