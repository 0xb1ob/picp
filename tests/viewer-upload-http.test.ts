/**
 * Dashboard image attachments, the viewer's half (cp-br81 plan T3): `POST /api/operator/upload` in its refusal
 * order, `GET /api/operator/uploads/<id>`, and the message route's image branch end to end against the real
 * bridge server. Every viewer and bridge gets a mkdtemp `uploadRoot`; none touches /tmp/cp-dashboard-uploads.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlPorts, type DashboardControl, type InlineImage, startDashboardControl } from "../src/dashboard-control.ts";
import { controlJournalFile, readControlRecord } from "../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../src/viewer/push-files.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { newUploadId, uploadFile, writeUpload } from "../src/viewer/uploads.ts";
import { createScratchHome } from "./harness/index.ts";
import { STUBS, syntheticPng } from "./harness/images.ts";

const ORIGIN = "https://cp.example.ts.net";
const UPLOAD = "/api/operator/upload";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const journalText = (stateDir: string) => existsSync(controlJournalFile(stateDir)) ? readFileSync(controlJournalFile(stateDir), "utf8") : "";
const journal = (stateDir: string): Array<Record<string, unknown>> => journalText(stateDir).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; raw: Buffer; body: Record<string, unknown> }
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks);
				let body: Record<string, unknown> = {};
				try { body = JSON.parse(raw.toString("utf8")); } catch { /* binary */ }
				resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body });
			});
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

async function setup(t: import("node:test").TestContext, viewer: Partial<ViewerOptions> = {}) {
	const home = createScratchHome();
	const uploads = mkdtempSync(join(tmpdir(), "cp-upload-http-"));
	t.after(() => { home.cleanup(); rmSync(uploads, { recursive: true, force: true }); });
	const stateDir = join(home.path, LAYOUT.state);
	const uploadRoot = join(uploads, "root");
	put(pushConfigFile(pushDataDir(stateDir)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-09-27T08:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null }, uploadRoot, ...viewer };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return { stateDir, uploadRoot, options, port: options.port };
}

async function bridge(t: import("node:test").TestContext, stateDir: string, uploadRoot: string, images = true) {
	const injected: Array<{ text: string; images?: InlineImage[] }> = [];
	const ports: ControlPorts = {
		inject: (text, _deliverAs, parts) => { injected.push({ text, ...(parts ? { images: parts } : {}) }); },
		abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => "/tmp/op.jsonl",
		...(images ? { prepareImage: async (bytes: Uint8Array, mimeType: string) => ({ data: Buffer.from(bytes).toString("base64"), mimeType }) } : {}),
	};
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {}, uploadRoot }) as DashboardControl;
	assert.equal(control.state, "listening");
	t.after(() => control.stop());
	return { injected, csrf: (readControlRecord(stateDir) as { record: { csrf: string } }).record.csrf };
}

const image = (token: string | null, body: Buffer, type = "image/png", extra: Record<string, string> = {}) => ({
	method: "POST", body,
	headers: { origin: ORIGIN, "content-type": type, "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});
const message = (token: string, body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": token } });

test("upload: 201 stores the bytes 0600 under 0700 dirs, journals one upload line with no bytes, and GET serves them back hardened", async (t) => {
	const { stateDir, uploadRoot, port } = await setup(t);
	const { csrf } = await bridge(t, stateDir, uploadRoot);
	const png = syntheticPng(8, 8);
	const stored = await call(port, UPLOAD, image(csrf, png));
	assert.equal(stored.status, 201, JSON.stringify(stored.body));
	const id = String(stored.body.id);
	assert.match(id, /^im-\d{8}-[0-9a-f]{24}\.png$/);
	assert.deepEqual({ ...stored.body, id: "x", expires_at: "x" }, { id: "x", mime: "image/png", bytes: png.length, expires_at: "x", url: `/api/operator/uploads/${id}` });
	const file = uploadFile(uploadRoot, id)!;
	assert.deepEqual(readFileSync(file), png);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(uploadRoot).mode & 0o777, 0o700);
	assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
	const lines = journal(stateDir).filter((line) => line.type === "upload");
	assert.equal(lines.length, 1);
	assert.deepEqual({ ...lines[0], at: "x", peer: "x" }, { type: "upload", by: "viewer", id, at: "x", peer: "x", mime: "image/png", bytes: png.length });
	assert.equal(journalText(stateDir).includes("iVBOR"), false, "no base64 bytes in the journal");

	const got = await call(port, stored.body.url as string, { headers: { "sec-fetch-site": "same-origin" } });
	assert.equal(got.status, 200);
	assert.deepEqual(got.raw, png);
	assert.equal(got.headers["content-type"], "image/png");
	assert.equal(got.headers["x-content-type-options"], "nosniff");
	assert.equal(got.headers["cross-origin-resource-policy"], "same-origin");
	assert.equal(got.headers["content-security-policy"], "default-src 'none'; img-src 'self'; sandbox");
	assert.equal(got.headers["cache-control"], "private, max-age=604800, immutable");
	const head = await call(port, stored.body.url as string, { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal(head.raw.length, 0);
});

test("upload refusals, in order: 405, 403 tailnet, 403 Origin, 403 cross-site, 415 type (HEIC hinted), 413 size, 409 offline, 403 token, 415 sniffed bytes, 507 full — each journaled, nothing stored", async (t) => {
	const { stateDir, uploadRoot, port } = await setup(t);
	const png = syntheticPng();
	const refused = async (status: number, options: Parameters<typeof call>[2], reason: RegExp, at = port) => {
		const reply = await call(at, UPLOAD, options);
		assert.equal(reply.status, status, JSON.stringify(reply.body));
		assert.match(String(reply.body.error), reason);
	};
	await refused(405, { method: "GET" }, /POST only/);
	const offTailnet = await setup(t, { requireTailnet: false });
	await refused(403, image("x", png), /--require-tailnet/, offTailnet.port);
	await refused(403, image("x", png, "image/png", { origin: "https://evil.example" }), /Origin must be/);
	await refused(403, image("x", png, "image/png", { "sec-fetch-site": "cross-site" }), /cross-site/);
	await refused(415, image("x", png, "application/json"), /Content-Type must be image/);
	await refused(415, image("x", STUBS.svg, "image/svg+xml"), /Content-Type must be image/);
	await refused(415, image("x", STUBS.heic, "image/heic"), /HEIC\/HEIF is not supported; share the photo as JPEG/);
	await refused(413, image("x", png, "image/png", { "content-length": String(10 * 1024 * 1024 + 1) }), /larger than 10485760 bytes/);
	await refused(409, image("x", png), /need a running operator session/);
	const { csrf } = await bridge(t, stateDir, uploadRoot);
	await refused(403, image("stale", png), /control token missing or stale/);
	await refused(415, image(csrf, STUBS.svg), /not a PNG, JPEG, WebP or GIF image/);
	await refused(415, image(csrf, STUBS.heic, "image/jpeg"), /HEIC\/HEIF is not supported/);
	assert.equal(existsSync(uploadRoot), false, "nothing stored before the checks pass");
	// 256 MiB of sparse file: the sweep counts sizes, not blocks.
	const filler = newUploadId("png", new Date());
	writeUpload(uploadRoot, filler, png);
	truncateSync(uploadFile(uploadRoot, filler)!, 256 * 1024 * 1024);
	await refused(507, image(csrf, png), /upload space full/);
	const kinds = journal(stateDir).filter((line) => line.type === "refused").map((line) => [line.kind, line.status]);
	assert.deepEqual(kinds, [["upload", 403], ["upload", 403], ["upload", 415], ["upload", 415], ["upload", 415], ["upload", 413], ["upload", 409], ["upload", 403], ["upload", 415], ["upload", 415], ["upload", 507]]);
	assert.equal(journal(stateDir).some((line) => line.type === "upload"), false);
});

test("upload rate: its own 24 per 60 s limiter; the 25th is 429 with retry-after, while text sends still pass", async (t) => {
	const { stateDir, uploadRoot, port } = await setup(t);
	const { csrf } = await bridge(t, stateDir, uploadRoot);
	for (let i = 0; i < 24; i++) assert.equal((await call(port, UPLOAD, image(csrf, syntheticPng()))).status, 201, `upload ${i + 1}`);
	const limited = await call(port, UPLOAD, image(csrf, syntheticPng()));
	assert.equal(limited.status, 429);
	assert.ok(Number(limited.headers["retry-after"]) > 0);
	assert.equal((await call(port, "/api/operator/message", message(csrf, { kind: "message", text: "still here" }))).status, 202);
});

test("GET uploads: tailnet only, same-origin only, an id or 400, and 404 'image expired' for a missing or 7-day-old file", async (t) => {
	const { uploadRoot, port } = await setup(t);
	const id = newUploadId("png", new Date());
	writeUpload(uploadRoot, id, syntheticPng());
	const offTailnet = await setup(t, { requireTailnet: false, uploadRoot });
	assert.equal((await call(offTailnet.port, `/api/operator/uploads/${id}`)).status, 403);
	assert.equal((await call(port, `/api/operator/uploads/${id}`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
	assert.equal((await call(port, `/api/operator/uploads/${id}`, { headers: { "sec-fetch-site": "none" } })).status, 200);
	for (const bad of ["..%2F..%2Fetc%2Fpasswd", "im-1.png", `${id}x`]) {
		const reply = await call(port, `/api/operator/uploads/${bad}`);
		assert.deepEqual([reply.status, reply.body.error], [400, "not an upload id"], bad);
	}
	assert.deepEqual((await call(port, `/api/operator/uploads/${newUploadId("png", new Date())}`)).body, { error: "image expired" });
	const old = new Date(Date.now() - 8 * 86_400_000);
	utimesSync(uploadFile(uploadRoot, id)!, old, old);
	const expired = await call(port, `/api/operator/uploads/${id}`);
	assert.deepEqual([expired.status, expired.body.error], [404, "image expired"]);
	assert.equal((await call(port, UPLOAD, { method: "PUT" })).status, 405);
});

test("message with images, viewer to bridge: offline 409, unknown id 410, an older bridge 409 unsupported, else the bridge gets the image parts; status carries images only with the capability", async (t) => {
	const { stateDir, uploadRoot, port } = await setup(t);
	const id = newUploadId("png", new Date());
	writeUpload(uploadRoot, id, syntheticPng());
	const offline = await call(port, "/api/operator/message", message("x", { kind: "message", text: "", images: [id] }));
	assert.deepEqual([offline.status, offline.body.error], [409, "image attachments need a running operator session (they are never held in the inbox); start it, or send text only"]);
	assert.equal((await call(port, "/api/operator/message", message("x", { kind: "message", text: "x", images: ["nope"] }))).status, 400);

	const older = await setup(t, { uploadRoot });
	const old = await bridge(t, older.stateDir, uploadRoot, false);
	assert.equal("images" in (await call(older.port, "/api/operator/control")).body, false, "no capability, no flag");
	const skew = await call(older.port, "/api/operator/message", message(old.csrf, { kind: "message", text: "x", images: [id] }));
	assert.equal(skew.status, 409);
	assert.match(String(skew.body.error), /^unsupported: this session's cp-bridge predates image attachments; restart the session/);
	assert.equal(old.injected.length, 0);

	const { csrf, injected } = await bridge(t, stateDir, uploadRoot);
	assert.equal((await call(port, "/api/operator/control")).body.images, true);
	const gone = newUploadId("png", new Date());
	const missing = await call(port, "/api/operator/message", message(csrf, { kind: "message", text: "x", images: [id, gone] }));
	assert.deepEqual([missing.status, missing.body.error], [410, `image ${gone} expired or was never uploaded; attach it again`]);
	const sent = await call(port, "/api/operator/message", message(csrf, { kind: "message", text: "", images: [id] }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.equal(injected.length, 1);
	assert.deepEqual(Buffer.from(injected[0]!.images![0]!.data, "base64"), syntheticPng());
	assert.match(injected[0]!.text, new RegExp(`; images=${id.replace(/\./g, "\\.")}\\]$`));
	const plain = await call(port, "/api/operator/message", message(csrf, { kind: "message", text: "text only" }));
	assert.equal(plain.status, 202);
	assert.equal(injected[1]!.images, undefined, "a text-only send stays on the plain send op");
});

test("no HTTPS origin configured: a tailnet bind's own http:// origin uploads and sends an image; a foreign origin is refused", async (t) => {
	const { stateDir, uploadRoot, port } = await setup(t, { host: "100.64.0.9" });
	rmSync(pushConfigFile(pushDataDir(stateDir)));
	const { csrf, injected } = await bridge(t, stateDir, uploadRoot);
	const self = { host: `100.64.0.9:${port}`, origin: `http://100.64.0.9:${port}` };
	const png = syntheticPng();
	const foreign = await call(port, UPLOAD, image(csrf, png, "image/png", { ...self, origin: "https://evil.example" }));
	assert.equal(foreign.status, 403);
	assert.match(String(foreign.body.error), /^Origin must be http:\/\/100\.64\.0\.9:\d+ \(no HTTPS origin is configured/);
	const stored = await call(port, UPLOAD, image(csrf, png, "image/png", self));
	assert.equal(stored.status, 201, JSON.stringify(stored.body));
	const req = message(csrf, { kind: "message", text: "", images: [stored.body.id] });
	const sent = await call(port, "/api/operator/message", { ...req, headers: { ...req.headers, ...self } });
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual(Buffer.from(injected[0]!.images![0]!.data, "base64"), png);
});


test("text uploads: validate extensions/UTF-8/JSON/size, store metadata only, serve HTML as text/plain, and deliver files with images and a thread", async t => {
 const {stateDir, uploadRoot, port} = await setup(t);
 const {csrf, injected} = await bridge(t, stateDir, uploadRoot);
 const text = (name: string, bytes: Buffer) => image(csrf, bytes, "application/octet-stream", {"x-cp-upload-name": encodeURIComponent(name)});
 for (const [name, bytes, status, reason] of [
  ["binary.txt", Buffer.from([1, 0, 2]), 415, /NUL/],
  ["broken.md", Buffer.from([0xc3, 0x28]), 415, /UTF-8/],
  ["broken.json", Buffer.from("{oops}"), 415, /valid JSON/],
  ["big.txt", Buffer.alloc(1024 * 1024 + 1, 97), 413, /1048576/],
  ["file.csv", Buffer.from("hello"), 415, /extension/],
  ["file.svg", Buffer.from("<svg></svg>"), 415, /extension/],
 ] as const) {
  const reply = await call(port, UPLOAD, text(name, bytes)); assert.equal(reply.status, status, JSON.stringify(reply.body)); assert.match(String(reply.body.error), reason);
 }
 const html = Buffer.from("<script>UNIQUE_ATTACHMENT_CONTENT</script>");
 const uploaded = await call(port, UPLOAD, text("../folder\\report[1].HTML", html));
 assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
 assert.match(String(uploaded.body.id), /^tx-\d{8}-[0-9a-f]{24}\.html$/);
 assert.equal(uploaded.body.name, "report_1_.HTML");
 const id = String(uploaded.body.id);
 assert.equal(uploadFile(uploadRoot, id)!.includes("report"), false);
 assert.deepEqual(readFileSync(uploadFile(uploadRoot, id)!), html);
 assert.equal(journalText(stateDir).includes("UNIQUE_ATTACHMENT_CONTENT"), false);
 const audit = journal(stateDir).find(line => line.type === "upload" && line.id === id)!;
 assert.deepEqual([audit.mime, audit.bytes, audit.name], ["text/plain", html.length, "report_1_.HTML"]);
 const got = await call(port, String(uploaded.body.url));
 assert.equal(got.headers["content-type"], "text/plain; charset=utf-8"); assert.equal(got.headers["x-content-type-options"], "nosniff"); assert.deepEqual(got.raw, html);
 assert.ok(String(got.headers["content-security-policy"]).includes("sandbox"));
 const png = await call(port, UPLOAD, image(csrf, syntheticPng()));
 const client_id="dc-20261004140000-00000019";
 const sent = await call(port, "/api/operator/message", message(csrf, {kind: "message", text: "look", images: [png.body.id], files: [id], thread: "file-chat", client_id}));
 assert.equal(sent.status, 202, JSON.stringify(sent.body));
 assert.equal(sent.body.id,client_id,"mixed uploads preserve the pre-acknowledgement correlation id");
 const pending=(await call(port,"/api/operator/control")).body.sends as Array<{id:string;body:unknown}>;
 assert.deepEqual(pending.find(send=>send.id === client_id)?.body,{kind:"message",text:"look",images:[png.body.id],files:[id],thread:"file-chat"},"reload projection retains both attachment kinds and the thread");
 assert.equal(injected[0]!.images!.length, 1); assert.ok(injected[0]!.text.includes("File: report_1_.HTML\n```text\n<script>UNIQUE_ATTACHMENT_CONTENT</script>\n```"));
 assert.match(injected[0]!.text, /; thread=file-chat; images=im-[^;]+; files=tx-[^\]]+\]$/);
 assert.equal((await call(port, "/api/operator/control")).body.files, true);
 for (const body of [{files: [png.body.id]}, {images: [id]}, {files: [id, id]}, {files: []}, {files: "x"}, {files: [id], images: Array.from({length: 8}, () => newUploadId("png", new Date()))}]) assert.equal((await call(port, "/api/operator/message", message(csrf, {kind: "message", text: "", ...body}))).status, 400);
 const fileOnly = await call(port, "/api/operator/message", message(csrf, {kind: "message", text: "", files: [id]})); assert.equal(fileOnly.status, 202); assert.equal(injected[1]!.images, undefined);
 const gone = newUploadId("txt", new Date());
 assert.equal((await call(port, "/api/operator/message", message(csrf, {kind: "message", text: "", files: [gone]}))).status, 410);
 assert.deepEqual((await call(port, `/api/operator/uploads/${gone}`)).body, {error: "file expired"});
 for (const [name, bytes] of [["note.txt", "plain"], ["note.md", "# markdown"], ["note.json", '{"ok": true}']] as const) assert.equal((await call(port, UPLOAD, text(name, Buffer.from(bytes)))).status, 201);
});
