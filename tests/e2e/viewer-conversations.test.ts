/**
 * Behavior 19 (P19a): the dashboard's composer attachments as `bin/cp-view` serves them on a scratch home,
 * over real HTTP, with the operator session's own dashboard-control server (src/dashboard-control.ts) on the other end.
 * The Sessions transcripts and the file explorer are in viewer-conversations-sessions.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { connect } from "node:net";
import { type ControlPorts, type DashboardControl, type InlineImage, startDashboardControl } from "../../src/dashboard-control.ts";
import { controlConfigFile, controlInboxFile, controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { BODY_DISCARD_IDLE_MS } from "../../src/viewer/push-api.ts";
import { type Context, type Json, jsonl, lines, mode, pick, send, viewer, write } from "../harness/conversations.ts";
import { STUBS, syntheticPng } from "../harness/images.ts";

/** The operator session's dashboard-control server, pi's ports recorded; `images: false` is a bridge before images. */
async function session(t: Context, stateDir: string, root: string, images = true) {
	const injected: Array<{ text: string; images?: InlineImage[] }> = [];
	const limits: Array<{ maxEdge: number; maxBytes: number }> = [];
	const ports: ControlPorts = {
		inject: (text, _deliverAs, parts) => { injected.push({ text, ...(parts ? { images: parts } : {}) }); },
		abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => join(stateDir, "operator-session.jsonl"),
		...(images ? { prepareImage: async (bytes: Uint8Array, mimeType: string, limit: { maxEdge: number; maxBytes: number }) => (limits.push(limit), { data: Buffer.from(bytes).toString("base64"), mimeType }) } : {}),
	};
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {}, uploadRoot: root }) as DashboardControl;
	assert.equal(control.state, "listening", JSON.stringify(control));
	t.after(() => control.stop());
	return { injected, limits, csrf: (readControlRecord(stateDir) as { record: { csrf: string } }).record.csrf };
}


// ---- uploads -------------------------------------------------------------------------------------------------------

const UPLOAD = "/api/operator/upload";
const MESSAGE = "/api/operator/message";
const day = (at = new Date()) => at.toISOString().slice(0, 10).replace(/-/g, "");
/** Where an upload id lives: `<root>/<yyyymmdd>/<24 hex>.<ext>`. */
const stored = (root: string, id: string) => join(root, id.slice(3, 11), id.slice(12));
const heic = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)]);
const EIGHT_DAYS_AGO = () => new Date(Date.now() - 8 * 86_400_000);

test("P19-upload: POST /api/operator/upload refuses in order, stores sniffed images 0600 under 0700 dirs, sweeps, and serves them back hardened", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t, { relativeRoot: true });
	const png = syntheticPng(8, 8);
	const refused = async (status: number, init: Parameters<typeof send>[2], reason: RegExp, at: { send: typeof d.send } = d) => {
		const reply = await at.send(UPLOAD, init);
		assert.equal(reply.status, status, JSON.stringify(reply.body));
		assert.match(String(reply.body.error), reason);
	};
	await refused(405, { method: "GET" }, /POST only/);
	assert.equal((await d.send(UPLOAD, { method: "PUT" })).status, 405);
	const plain = await viewer(t, { requireTailnet: false });
	await refused(403, plain.bytes("x", png), /--require-tailnet/, plain);
	await refused(403, d.bytes("x", png, "image/png", { origin: "https://evil.example" }), /^Origin must be http:\/\/127\.0\.0\.1:\d+ \(no HTTPS origin is configured/);
	await refused(403, d.bytes("x", png, "image/png", { "sec-fetch-site": "cross-site" }), /cross-site/);
	await refused(415, d.bytes("x", png, "application/json"), /Content-Type must be image/);
	await refused(415, d.bytes("x", STUBS.svg, "image/svg+xml"), /Content-Type must be image/);
	await refused(415, d.bytes("x", STUBS.heic, "image/heic"), /HEIC\/HEIF is not supported; share the photo as JPEG/);
	// The declared length is a lie (the png is tiny): this client must not reuse a socket the server thinks is mid-body.
	await refused(413, d.bytes("x", png, "image/png", { "content-length": String(10 * 1024 * 1024 + 1), connection: "close" }), /larger than 10485760 bytes/);
	await refused(409, d.bytes("x", png), /need a running operator session/);
	const { csrf } = await session(t, d.stateDir, d.root);
	await refused(403, d.bytes("stale", png), /control token missing or stale/);
	for (const bytes of [STUBS.svg, STUBS.text, png.subarray(0, 5), Buffer.alloc(0)]) await refused(415, d.bytes(csrf, bytes), /not a PNG, JPEG, WebP or GIF image/);
	for (const brand of ["heic", "heix", "mif1", "msf1"]) await refused(415, d.bytes(csrf, heic(brand), "image/jpeg"), /HEIC\/HEIF is not supported/, d);
	assert.equal(existsSync(d.root), false, "nothing stored before the checks pass");
	const audit = () => lines(controlJournalFile(d.stateDir));
	assert.deepEqual(audit().filter((l) => l.type === "refused").map((l) => [l.kind, l.status]), [["upload", 403], ["upload", 403], ["upload", 415], ["upload", 415], ["upload", 415], ["upload", 413], ["upload", 409], ["upload", 403], ...Array(8).fill(["upload", 415])]);

	// The sweep runs before the 256 MiB cap: a sparse filler counts by size, a stale file and its emptied day dir go.
	d.tick();
	mkdirSync(d.root, { mode: 0o755 });
	const filler = join(d.root, "20300101", `${"0".repeat(24)}.png`);
	write(filler, png);
	truncateSync(filler, 256 * 1024 * 1024);
	const stale = join(d.root, "20200101", `${"1".repeat(24)}.png`);
	write(stale, png);
	utimesSync(stale, EIGHT_DAYS_AGO(), EIGHT_DAYS_AGO());
	write(join(d.root, "20300101", "notes.txt"), "not ours");
	await refused(507, d.bytes(csrf, png), new RegExp(`^upload space full: ${256 * 1024 * 1024} of 268435456 bytes used; attachments expire after 7 days, or remove ${d.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
	assert.equal(mode(d.root), 0o700, "a relative CP_UPLOAD_ROOT resolves to this root, and its 0755 is tightened to 0700");
	assert.deepEqual([existsSync(stale), readdirSync(d.root).sort()], [false, ["20300101"]], "the stale file and its emptied day dir are gone");
	assert.deepEqual(readdirSync(join(d.root, "20300101")).sort(), [`${"0".repeat(24)}.png`, "notes.txt"], "other names are left alone");
	rmSync(join(d.root, "20300101"), { recursive: true });

	const first = await d.send(UPLOAD, d.bytes(csrf, png));
	assert.equal(first.status, 201, JSON.stringify(first.body));
	const id = String(first.body.id);
	assert.match(id, /^im-\d{8}-[0-9a-f]{24}\.png$/, "the day is the viewer's pinned clock, not this process's");
	assert.deepEqual({ ...first.body, expires_at: "x" }, { id, mime: "image/png", bytes: png.length, expires_at: "x", url: `/api/operator/uploads/${id}` });
	const file = stored(d.root, id);
	assert.deepEqual(readFileSync(file), png);
	assert.deepEqual([mode(file), mode(d.root), mode(dirname(file))], [0o600, 0o700, 0o700]);
	const uploaded = audit().filter((l) => l.type === "upload");
	assert.deepEqual(uploaded.map((l) => ({ ...l, at: "x" })), [{ type: "upload", by: "viewer", id, at: "x", peer: "127.0.0.1", mime: "image/png", bytes: png.length }]);
	assert.equal(readFileSync(controlJournalFile(d.stateDir), "utf8").includes("iVBOR"), false, "no base64 bytes in the journal");
	for (const [bytes, mime, ext] of [[STUBS.jpeg, "image/jpeg", "jpg"], [STUBS.gif, "image/gif", "gif"], [STUBS.webp, "image/webp", "webp"]] as const) {
		const other = await d.send(UPLOAD, d.bytes(csrf, bytes, mime));
		assert.deepEqual([other.status, other.body.mime, String(other.body.id).split(".").at(-1)], [201, mime, ext]);
	}

	const got = await d.send(first.body.url, { headers: { "sec-fetch-site": "same-origin" } });
	assert.deepEqual([got.status, got.raw], [200, png]);
	assert.deepEqual(pick(got.headers, ["content-type", "x-content-type-options", "cross-origin-resource-policy", "content-security-policy", "cache-control"]), { "content-type": "image/png", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "content-security-policy": "default-src 'none'; img-src 'self'; sandbox", "cache-control": "private, max-age=604800, immutable" });
	const head = await d.send(first.body.url, { method: "HEAD" });
	assert.deepEqual([head.status, head.raw.length], [200, 0]);
	assert.equal((await plain.send(`/api/operator/uploads/${id}`)).status, 403, "served only under --require-tailnet");
	assert.equal((await d.send(`/api/operator/uploads/${id}`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
	assert.equal((await d.send(`/api/operator/uploads/${id}`, { headers: { "sec-fetch-site": "none" } })).status, 200);
	const fresh = `${"tx-20261004-0123456789abcdef01234567"}`;
	for (const bad of ["..%2F..%2Fetc%2Fpasswd", "im-1.png", `${id}x`, `${fresh}.svg`, "im-20261004-0123456789abcdef01234567.txt", `${fresh}.png`]) {
		const reply = await d.send(`/api/operator/uploads/${bad}`);
		assert.deepEqual([reply.status, reply.body.error], [400, "not an upload id"], bad);
	}
	const gone = (hex: string) => `im-${id.slice(3, 11)}-${hex.repeat(24)}.png`;
	assert.deepEqual((await d.send(`/api/operator/uploads/${gone("f")}`)).body, { error: "image expired" });
	write(stored(d.root, gone("a")), STUBS.jpeg);
	symlinkSync(file, stored(d.root, gone("b")));
	for (const hex of ["a", "b"]) assert.deepEqual((await d.send(`/api/operator/uploads/${gone(hex)}`)).body, { error: "image expired" }, "bytes that do not match the extension, or a symlink, are never served");
	utimesSync(file, EIGHT_DAYS_AGO(), EIGHT_DAYS_AGO());
	const expired = await d.send(`/api/operator/uploads/${id}`);
	assert.deepEqual([expired.status, expired.body.error, existsSync(file)], [404, "image expired", false], "past 7 days: refused and unlinked on read");

	renameSync(d.root, `${d.root}-real`);
	symlinkSync(`${d.root}-real`, d.root);
	const kept = readdirSync(`${d.root}-real`, { recursive: true }).length;
	await refused(503, d.bytes(csrf, png), /upload directory .* is not safe: it is a symlink/);
	assert.equal(readdirSync(`${d.root}-real`, { recursive: true }).length, kept, "nothing written through the link");
	rmSync(d.root);
	renameSync(`${d.root}-real`, d.root);

	d.tick();
	for (let i = 0; i < 24; i++) assert.equal((await d.send(UPLOAD, d.bytes(csrf, syntheticPng()))).status, 201, `upload ${i + 1}`);
	const limited = await d.send(UPLOAD, d.bytes(csrf, syntheticPng()));
	assert.equal(limited.status, 429);
	assert.ok(Number(limited.headers["retry-after"]) > 0);
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "still here" }))).status, 202, "text sends keep their own limiter");
});

test("P19-upload-send: images and text files reach the operator session inline, within budget, and an older or absent session refuses them", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t);
	const absent = `im-${day()}-${"c".repeat(24)}.png`;
	const offline = await d.send(MESSAGE, d.json("x", { kind: "message", text: "", images: [absent] }));
	assert.deepEqual([offline.status, offline.body.error], [409, "image attachments need a running operator session (they are never held in the inbox); start it, or send text only"]);
	assert.equal((await d.send(MESSAGE, d.json("x", { kind: "message", text: "x", images: ["nope"] }))).status, 400);
	const older = await viewer(t);
	const old = await session(t, older.stateDir, older.root, false);
	write(stored(older.root, absent), syntheticPng());
	assert.equal("images" in (await older.get("/api/operator/control")).body, false, "no capability, no flag");
	const skew = await older.send(MESSAGE, older.json(old.csrf, { kind: "message", text: "x", images: [absent] }));
	assert.equal(skew.status, 409);
	assert.match(String(skew.body.error), /^unsupported: this session's cp-bridge predates image attachments; restart the session/);
	assert.equal(old.injected.length, 0);

	const { csrf, injected, limits } = await session(t, d.stateDir, d.root);
	const control = async () => (await d.get("/api/operator/control")).body as Json;
	assert.deepEqual([(await control()).images, (await control()).files], [true, true]);
	const upload = async (bytes: Buffer, name?: string) => {
		const reply = await d.send(UPLOAD, d.bytes(csrf, bytes, name === undefined ? "image/png" : "application/octet-stream", name === undefined ? {} : { "x-cp-upload-name": encodeURIComponent(name) }));
		return reply;
	};
	const png = syntheticPng();
	const image = String((await upload(png)).body.id);
	const missing = await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "x", images: [image, absent] }));
	assert.deepEqual([missing.status, missing.body.error], [410, `image ${absent} expired or was never uploaded; attach it again`]);
	const sent = await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", images: [image] }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual(Buffer.from(injected[0]!.images![0]!.data, "base64"), png);
	assert.match(injected[0]!.text, new RegExp(`; images=${image.replace(/\./g, "\\.")}\\]$`));
	assert.ok(injected[0]!.text.startsWith(`image: ${stored(d.root, image)} (deleted after 7 days`), "the model also gets the upload's path");
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "text only" }))).status, 202);
	assert.equal(injected[1]!.images, undefined, "a text-only send stays on the plain send op");
	const more = [];
	for (let i = 0; i < 7; i++) more.push(String((await upload(syntheticPng(3 + i, 2))).body.id));
	for (const ids of [more.slice(0, 4), [image, ...more]]) assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", images: ids }))).status, 202);
	assert.deepEqual(limits.map((l) => l.maxBytes), [786432, ...Array(4).fill(524288), ...Array(8).fill(262144)], "768 KiB for one image, an even share of 2 MiB beyond");

	d.tick();
	const text = (name: string, bytes: Buffer) => upload(bytes, name);
	for (const [name, bytes, status, reason] of [
		["binary.txt", Buffer.from([1, 0, 2]), 415, /NUL/], ["broken.md", Buffer.from([0xc3, 0x28]), 415, /UTF-8/], ["broken.json", Buffer.from("{oops}"), 415, /valid JSON/],
		["big.txt", Buffer.alloc(4 * 1024 * 1024 + 1, 97), 413, /larger than 4194304 bytes/], ["file.csv", Buffer.from("hello"), 415, /extension/],
		["file.svg", Buffer.from("<svg></svg>"), 415, /extension/], ["report.json.exe", Buffer.from("{}"), 415, /extension/],
	] as const) {
		const reply = await text(name, bytes);
		assert.equal(reply.status, status, `${name}: ${JSON.stringify(reply.body)}`);
		assert.match(String(reply.body.error), reason);
	}
	const exact = await text("exact.txt", Buffer.alloc(4 * 1024 * 1024, 97));
	assert.equal(exact.status, 201, "exactly 4 MiB is allowed");
	const nearBytes = Math.round(3.9 * 1024 * 1024);
	const near = await text("near-cap.txt", Buffer.alloc(nearBytes, 97));
	assert.deepEqual([near.status, near.body.bytes], [201, nearBytes]);
	const html = Buffer.from("<script>UNIQUE_ATTACHMENT_CONTENT</script>");
	const page = await text("../folder\\report[1].HTML", html);
	assert.equal(page.status, 201, JSON.stringify(page.body));
	const id = String(page.body.id);
	assert.match(id, /^tx-\d{8}-[0-9a-f]{24}\.html$/);
	assert.equal(page.body.name, "report_1_.HTML");
	assert.equal((await text("../folder\\evil\n[<name>].HTML", html)).body.name, "evil___name__.HTML");
	assert.equal((await text("report.JSON", Buffer.from('{"ok":true}'))).status, 201);
	assert.deepEqual([stored(d.root, id).includes("report"), readFileSync(stored(d.root, id))], [false, html]);
	assert.equal(readFileSync(controlJournalFile(d.stateDir), "utf8").includes("UNIQUE_ATTACHMENT_CONTENT"), false);
	assert.deepEqual(pick(lines(controlJournalFile(d.stateDir)).find((l) => l.type === "upload" && l.id === id)!, ["mime", "bytes", "name"]), { mime: "text/plain", bytes: html.length, name: "report_1_.HTML" });
	const got = await d.send(String(page.body.url));
	assert.deepEqual([got.headers["content-type"], got.headers["x-content-type-options"], got.raw], ["text/plain; charset=utf-8", "nosniff", html]);
	assert.ok(String(got.headers["content-security-policy"]).includes("sandbox"));

	d.tick();
	const client_id = "dc-20261004140000-00000019";
	// #588: a stale client's `thread` is accepted and dropped: not in the projected body, not in the marker.
	const mixed = await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "look", images: [image], files: [id], thread: "file-chat", client_id }));
	assert.equal(mixed.status, 202, JSON.stringify(mixed.body));
	assert.equal(mixed.body.id, client_id, "mixed uploads keep the pre-acknowledgement correlation id");
	assert.deepEqual((await control()).sends.find((s: Json) => s.id === client_id)?.body, { kind: "message", text: "look", images: [image], files: [id] }, "the reload projection keeps both kinds");
	const last = () => injected.at(-1)!;
	assert.equal(last().images!.length, 1);
	assert.ok(last().text.includes("File: report_1_.HTML\n```text\n<script>UNIQUE_ATTACHMENT_CONTENT</script>\n```"));
	assert.match(last().text, / — from the dashboard; images=im-[^;]+; files=tx-[^\]]+\]$/);
	assert.doesNotMatch(last().text, /thread=/);
	// #588: the thread routes are gone: GET falls through like any unknown path, POST is the read-only 405.
	assert.equal("threads" in (await d.send("/api/threads")).body, false, "no threads response");
	const listed = await d.get("/api/threads");
	assert.equal("threads" in listed.body, false, `GET /api/threads falls through like any unknown path (${listed.status})`);
	const done = await d.send("/api/threads/done", d.json(csrf, { id: "th-aaaaaaaaaaaa" }));
	assert.deepEqual([done.status, done.raw.toString("utf8")], [405, "read-only viewer: GET only\n"]);
	for (const body of [{ files: [image] }, { images: [id] }, { files: [id, id] }, { files: [] }, { files: "x" }, { files: [id], images: Array.from({ length: 8 }, () => `im-${day()}-${"d".repeat(24)}.png`) }]) {
		assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", ...body }))).status, 400, JSON.stringify(body));
	}
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", files: [id] }))).status, 202);
	assert.equal(last().images, undefined, "a file-only send has no image parts");
	const goneText = `tx-${day()}-${"e".repeat(24)}.txt`;
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", files: [goneText] }))).status, 410);
	assert.deepEqual((await d.send(`/api/operator/uploads/${goneText}`)).body, { error: "file expired" });
	const nearId = String(near.body.id);
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", files: [nearId] }))).status, 202);
	assert.ok(last().text.includes("File: near-cap.txt\n"), "the journal's name for the upload");
	assert.ok(last().text.includes(`[truncated — full file at ${stored(d.root, nearId)}]`));
	assert.ok(Buffer.byteLength(last().text) < 16384 + 1024, "only the inline budget is truncated");
	assert.deepEqual(readFileSync(stored(d.root, nearId)), Buffer.alloc(nearBytes, 97));
	write(stored(d.root, id), Buffer.from([0xc3, 0x28]));
	assert.deepEqual((await d.send(`/api/operator/uploads/${id}`)).body, { error: "file expired" }, "a stored text file is revalidated on read");

	// The inline file text: bounded at 16 KiB with robust fences, truncated on UTF-8 boundaries, paths to the full files.
	d.tick();
	const inline = async (files: Array<[string, Buffer]>) => {
		const ids: string[] = [];
		for (const [name, bytes] of files) ids.push(String((await text(name, bytes)).body.id));
		assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", files: ids }))).status, 202);
		return { ids, text: last().text.slice(0, last().text.indexOf("[cp-dashboard ")) };
	};
	const hostile = "```\n~~~~\n<script>literal</script>\n";
	const heavy = await inline(Array.from({ length: 8 }, (_, i) => [`file-${i}.md`, Buffer.from(hostile + "é".repeat(400_000))]));
	assert.ok(Buffer.byteLength(heavy.text) <= 16384, String(Buffer.byteLength(heavy.text)));
	assert.doesNotMatch(heavy.text, /\uFFFD/);
	for (const file of heavy.ids) assert.ok(heavy.text.includes(`[truncated — full file at ${stored(d.root, file)}]`));
	assert.equal((heavy.text.match(/File: /g) ?? []).length, 8);
	assert.equal((await inline([["small.md", Buffer.from(hostile)]])).text, `File: small.md\n\`\`\`\`text\n${hostile}\n\`\`\`\`\n\n`);
	assert.ok(Buffer.byteLength((await inline([["runs.txt", Buffer.from("`".repeat(100_000) + "~".repeat(100_000))]])).text) <= 16384);
	assert.equal((await inline([["small.txt", Buffer.from("short note ✓")]])).text, "File: small.txt\n```text\nshort note ✓\n```\n\n");
	d.tick();
	const big = Buffer.from(`<!doctype html>\n<p>${"<div class=\"row\">héllo ✓ 😀</div>\n".repeat(5_400)}</p>`);
	const one = await inline([["page.html", big]]);
	assert.ok(Buffer.byteLength(one.text) <= 16384 && !/\uFFFD/.test(one.text) && one.text.includes(`[truncated — full file at ${stored(d.root, one.ids[0]!)}]`));
	const samples = ["é", "✓", "😀", "日本", "ascii ", "```", "~~~", "Ω"];
	const eight = await inline(samples.map((s, i) => [`mix-${i}.md`, Buffer.from(`# ${i}\n` + s.repeat(4_000 + i * 997))]));
	assert.ok(Buffer.byteLength(eight.text) <= 16384 && !/\uFFFD/.test(eight.text), String(Buffer.byteLength(eight.text)));
	assert.equal((eight.text.match(/File: mix-/g) ?? []).length, 8);
	for (const [i, file] of eight.ids.entries()) assert.deepEqual(readFileSync(stored(d.root, file)), Buffer.from(`# ${i}\n` + samples[i]!.repeat(4_000 + i * 997)), "the stored file keeps every byte");
});

/** One raw POST to the image upload with `framing` headers; `paused` reads nothing until the whole body is written. */
function rawUpload(d: Awaited<ReturnType<typeof viewer>>, framing: string, body: Buffer[], paused: boolean) {
	const { origin, "sec-fetch-site": site } = d.own;
	const head = `POST ${UPLOAD} HTTP/1.1\r\nhost: 127.0.0.1:${d.port}\r\norigin: ${origin}\r\nsec-fetch-site: ${site}\r\ncontent-type: image/png\r\n${framing}\r\n\r\n`;
	return new Promise<{ reply: string; written: boolean; held: number }>((resolve) => {
		const socket = connect(d.port, "127.0.0.1");
		const chunks: Buffer[] = [];
		let written = false, repliedAt = 0;
		const done = () => resolve({ reply: Buffer.concat(chunks).toString("utf8"), written, held: Date.now() - repliedAt });
		if (paused) socket.pause();
		// An empty body is a stalled sender: it waits for the server to close the socket.
		socket.on("data", (chunk: Buffer) => { chunks.push(chunk); repliedAt ||= Date.now(); if (body.length && /\}$/.test(Buffer.concat(chunks).toString("utf8"))) socket.destroy(); });
		socket.on("error", () => {});
		socket.on("close", done);
		socket.write(head);
		for (const [i, part] of body.entries()) socket.write(part, (error) => { if (!error && i === body.length - 1) { written = true; socket.resume(); } });
	});
}

test("P19-upload-oversize: an oversize upload is answered 413 and only a bounded rest of its body is ever read", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	// 10 MiB + 512 KiB streamed: the 413 comes at the cap and the 512 KiB beyond is within the discard bound.
	const frame = Buffer.concat([Buffer.from("10000\r\n"), Buffer.alloc(0x10000, 97), Buffer.from("\r\n")]);
	const chunked = await rawUpload(d, "transfer-encoding: chunked", [...Array(168).fill(frame), Buffer.from("0\r\n\r\n")], true);
	assert.match(chunked.reply, /^HTTP\/1\.1 413 [\s\S]*body is larger than 10485760 bytes/);
	assert.equal(chunked.written, true, "a client just past the cap finishes its write, no EPIPE");
	// 64 MiB declared: the server stops reading past the bound and closes, so the client never finishes writing.
	const huge = await rawUpload(d, `content-length: ${64 * 1024 * 1024}`, [Buffer.alloc(64 * 1024 * 1024, 97)], false);
	assert.equal(huge.written, false, "the server did not ingest the whole body");
	const stalled = await rawUpload(d, `content-length: ${11 * 1024 * 1024}`, [], false);
	assert.match(stalled.reply, /^HTTP\/1\.1 413 /);
	assert.ok(BODY_DISCARD_IDLE_MS >= 5000 && stalled.held >= BODY_DISCARD_IDLE_MS - 500 && stalled.held < BODY_DISCARD_IDLE_MS + 15_000, `held ${stalled.held} ms: closed by the idle timer`);
});
