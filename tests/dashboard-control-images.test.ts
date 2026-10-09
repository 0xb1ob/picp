/**
 * Dashboard image attachments, the operator session's half (cp-br81 plan T4): `userMessageContent` builds the
 * image parts pi.sendUserMessage receives, the `send_images` op reads, resizes and injects them, and cp-bridge
 * wires both (real pi resizeImage). Every upload root is a mkdtemp dir; none is /tmp/cp-dashboard-uploads.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlPorts, type DashboardControl, type InlineImage, startDashboardControl, userMessageContent } from "../src/dashboard-control.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import { appendControlAudit } from "../src/viewer/control-audit.ts";
import { controlJournalFile, parseDashboardText, readControlRecord } from "../src/viewer/control-files.ts";
import { inlineBudget, newUploadId, TEXT_MESSAGE_INLINE_BYTES, uploadFile, writeUpload } from "../src/viewer/uploads.ts";
import bridgeExtension, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { createScratchHome } from "./harness/index.ts";
import { syntheticPng } from "./harness/images.ts";

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	const uploads = mkdtempSync(join(tmpdir(), "cp-bridge-images-"));
	t.after(() => { home.cleanup(); rmSync(uploads, { recursive: true, force: true }); });
	return { home: home.path, stateDir: join(home.path, LAYOUT.state), uploadRoot: join(uploads, "root") };
}
const journal = (stateDir: string): Array<Record<string, unknown>> => existsSync(controlJournalFile(stateDir)) ? readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
type Record_ = Parameters<typeof controlRequest>[0];

function fakePorts(prepare: ControlPorts["prepareImage"] | null = async (bytes, mimeType) => ({ data: Buffer.from(bytes).toString("base64"), mimeType })) {
	const state = { injected: [] as Array<{ text: string; images?: InlineImage[] }>, limits: [] as Array<{ maxEdge: number; maxBytes: number }> };
	const ports: ControlPorts = {
		inject: (text, _deliverAs, images) => { state.injected.push({ text, ...(images ? { images } : {}) }); },
		abort: () => {},
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionFile: () => "/tmp/operator-session.jsonl",
		...(prepare ? { prepareImage: (bytes: Uint8Array, mime: string, limits: { maxEdge: number; maxBytes: number }) => { state.limits.push(limits); return prepare(bytes, mime, limits); } } : {}),
	};
	return { state, ports };
}

async function listening(t: import("node:test").TestContext, stateDir: string, ports: ControlPorts, extra: Partial<Parameters<typeof startDashboardControl>[0]> = {}) {
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 50, log: () => {}, ...extra });
	assert.equal(control.state, "listening");
	t.after(() => (control as DashboardControl).stop());
	return (readControlRecord(stateDir) as { record: Record_ }).record;
}

function stored(root: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => {
		const id = newUploadId("png", new Date());
		writeUpload(root, id, syntheticPng(2 + i, 2));
		return id;
	});
}

test("userMessageContent: text alone stays a string; with images, one text part then one image part each, bytes and mime as given", () => {
	assert.equal(userMessageContent("hello"), "hello");
	assert.equal(userMessageContent("hello", []), "hello");
	const images = [{ data: "aGVsbG8=", mimeType: "image/png" }, { data: "d29ybGQ=", mimeType: "image/jpeg" }];
	assert.deepEqual(userMessageContent("look\n\n[marker]", images), [
		{ type: "text", text: "look\n\n[marker]" },
		{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		{ type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
	]);
});

test("send_images: the request line names the ids (no bytes), each image is prepared within the budget, injected as images, and the marker lists the ids; empty text is allowed", async (t) => {
	const { stateDir, uploadRoot } = scratch(t);
	const { state, ports } = fakePorts();
	const record = await listening(t, stateDir, ports, { uploadRoot });
	const status = await controlRequest(record, "status", {});
	assert.equal(status.ok && (status.result as { images?: boolean }).images, true, "status advertises the capability");
	const ids = stored(uploadRoot, 3);
	const reply = await controlRequest(record, "send_images", { kind: "message", text: "", images: ids });
	assert.equal(reply.ok, true, JSON.stringify(reply));
	assert.equal(state.injected.length, 1);
	const sent = state.injected[0]!;
	assert.deepEqual(parseDashboardText(sent.text)?.images, ids, "the marker lists the ids in order");
	const lines = ids.map((id) => `image: ${uploadFile(uploadRoot, id)} (deleted after 7 days; copy it if needed longer)`);
	assert.ok(lines.every((line) => line.startsWith("image: /")), "absolute paths");
	assert.equal(parseDashboardText(sent.text)?.body, lines.join("\n"), "one path line per image, in order, before the marker; no text");
	assert.ok(sent.text.split("\n").pop()!.startsWith("[cp-dashboard "), "the marker stays the last line");
	assert.deepEqual(sent.images?.map((image) => image.mimeType), ["image/png", "image/png", "image/png"]);
	assert.deepEqual(Buffer.from(sent.images![0]!.data, "base64"), syntheticPng(2, 2), "the upload's bytes reach the image part");
	assert.deepEqual(state.limits, ids.map(() => ({ maxEdge: 1568, maxBytes: inlineBudget(3) })));
	const request = journal(stateDir).find((line) => line.type === "request");
	assert.deepEqual(request?.images, ids);
	assert.equal(readFileSync(controlJournalFile(stateDir), "utf8").includes("iVBOR"), false, "no image bytes in the journal");
});

test("send_images refusals: bad ids 400, a missing upload 410, a resize past the deadline 504 — nothing injected; a null resize sends the path instead", async (t) => {
	const { stateDir, uploadRoot } = scratch(t);
	const { state, ports } = fakePorts();
	const record = await listening(t, stateDir, ports, { uploadRoot });
	const [id] = stored(uploadRoot, 1);
	for (const images of [[], ["../../etc/passwd"], [id, id], Array.from({ length: 9 }, () => newUploadId("png", new Date())), "x"]) {
		const reply = await controlRequest(record, "send_images", { kind: "message", text: "x", images });
		assert.deepEqual(reply.ok ? null : [reply.status, reply.error], [400, "images must be 1-8 distinct upload ids"], JSON.stringify(images));
	}
	const gone = newUploadId("png", new Date());
	const missing = await controlRequest(record, "send_images", { kind: "message", text: "x", images: [id, gone] });
	assert.deepEqual(missing.ok ? null : [missing.status, missing.error], [410, `image ${gone} expired or was never uploaded; attach it again`]);
	assert.equal(state.injected.length, 0);

	const slow = scratch(t);
	const never = fakePorts(() => new Promise(() => {}));
	const slowRecord = await listening(t, slow.stateDir, never.ports, { uploadRoot: slow.uploadRoot, imagePrepMs: 50 });
	const late = await controlRequest(slowRecord, "send_images", { kind: "message", text: "x", images: stored(slow.uploadRoot, 1) });
	assert.deepEqual(late.ok ? null : late.status, 504);
	assert.equal(never.state.injected.length, 0, "nothing sent past the deadline");

	const nulls = scratch(t);
	const failing = fakePorts(async () => null);
	const nullRecord = await listening(t, nulls.stateDir, failing.ports, { uploadRoot: nulls.uploadRoot });
	const [kept] = stored(nulls.uploadRoot, 1);
	const fallback = await controlRequest(nullRecord, "send_images", { kind: "message", text: "see", images: [kept] });
	assert.equal(fallback.ok, true);
	const text = failing.state.injected[0]!.text;
	const pathLine = `image: ${uploadFile(nulls.uploadRoot, kept!)} (deleted after 7 days; copy it if needed longer)`;
	assert.ok(text.startsWith(`see\n\n[image ${kept} could not be attached inline; file: ${uploadFile(nulls.uploadRoot, kept!)}]\n\n${pathLine}\n\n[cp-dashboard `), text);
	assert.equal(failing.state.injected[0]!.images, undefined);
	assert.match(String(journal(nulls.stateDir).find((line) => line.state === "injected")?.reason), /1 image\(s\) sent as a file path \(resize failed\)/);
});

test("send_images without prepareImage: an unknown op, and the status has no images flag", async (t) => {
	const { stateDir, uploadRoot } = scratch(t);
	const { ports } = fakePorts(null);
	const record = await listening(t, stateDir, ports, { uploadRoot });
	const status = await controlRequest(record, "status", {});
	assert.equal(status.ok && "images" in (status.result as object), false);
	const reply = await controlRequest(record, "send_images", { kind: "message", text: "x", images: stored(uploadRoot, 1) });
	assert.deepEqual(reply.ok ? null : [reply.status, reply.error], [400, "unknown op send_images"]);
});

test("cp-bridge wiring: index.ts sends userMessageContent; a send_images frame reaches pi.sendUserMessage as [text, image] parts resized by pi", async (t) => {
	const source = readFileSync(new URL("../extensions/cp-bridge/index.ts", import.meta.url), "utf8");
	assert.match(source, /pi\.sendUserMessage\(userMessageContent\(text, images\)/, "the bridge builds its content with the shared helper");
	assert.match(source, /prepareImage: .*resizeImage\(/);
	const { home, stateDir, uploadRoot } = scratch(t);
	const previous = { PI_HOME: process.env.PI_HOME, CP_UPLOAD_ROOT: process.env.CP_UPLOAD_ROOT };
	process.env.PI_HOME = join(home, "pi-home");
	process.env.CP_UPLOAD_ROOT = uploadRoot;
	t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
	saveOperatorTarget({ home, mode: "multi", hostPid: 0, parentPid: 0 });
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const sent: unknown[] = [];
	const emit = async (event: string, payload: unknown, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); };
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		sendUserMessage: (content: unknown) => {
			sent.push(content);
			setImmediate(() => void emit("message_start", { message: { role: "user", content } }));
		},
	} as never);
	const ctx = { hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => join(home, "operator-session.jsonl") } };
	await emit("session_start", {}, ctx);
	t.after(() => emit("session_shutdown", {}));
	const record = (readControlRecord(stateDir) as { record: Record_ }).record;
	const status = await controlRequest(record, "status", {});
	assert.equal(status.ok && (status.result as { images?: boolean }).images, true);
	const [id] = stored(uploadRoot, 1);
	const reply = await controlRequest(record, "send_images", { kind: "message", text: "what is this?", images: [id] }, 20_000);
	assert.equal(reply.ok && (reply.result as { state: string }).state, "delivered", JSON.stringify(reply));
	assert.equal(sent.length, 1);
	const parts = sent[0] as Array<Record<string, string>>;
	assert.ok(Array.isArray(parts), "content is a parts array, not a string");
	assert.equal(parts.length, 2);
	assert.equal(parts[0]!.type, "text");
	assert.match(parts[0]!.text!, new RegExp(`^what is this\\?\\n\\nimage: ${uploadFile(uploadRoot, id!)!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(deleted after 7 days; copy it if needed longer\\)\\n\\n\\[cp-dashboard dc-\\d{14}-[0-9a-f]{8} — from the dashboard; images=${id!.replace(/\./g, "\\.")}\\]$`));
	assert.equal(parts[1]!.type, "image");
	assert.equal(parts[1]!.mimeType, "image/png");
	assert.equal(Buffer.from(parts[1]!.data!, "base64").subarray(1, 4).toString("latin1"), "PNG", "a real PNG, base64");
});


test("send_files: text-only capability, bounded UTF-8 inline with paths, metadata and ids journaled without file contents; revalidation refuses mutation", async t => {
 const {stateDir, uploadRoot} = scratch(t);
 const {state, ports} = fakePorts(null);
 const record = await listening(t, stateDir, ports, {uploadRoot});
 const status = await controlRequest(record, "status", {}); assert.equal(status.ok && (status.result as {files?: boolean}).files, true);
 const bytes = Buffer.from("UNIQUE_FILE_CONTENT\n```\n~~~~\n" + "é".repeat(400_000));
 const ids = Array.from({length: 3}, () => newUploadId("md", new Date()));
 for (const id of ids) {
  writeUpload(uploadRoot, id, bytes);
  assert.ok(appendControlAudit(stateDir, {type: "upload", by: "viewer", id, at: new Date().toISOString(), peer: null, mime: "text/plain", bytes: bytes.length, name: "original.md"}).ok);
 }
 const sent = await controlRequest(record, "send_files", {kind: "message", text: "", files: ids, thread: "notes"}); assert.ok(sent.ok, JSON.stringify(sent));
 const text = state.injected[0]!.text, parsed = parseDashboardText(text)!;
 assert.deepEqual(parsed.files, ids); assert.equal(parsed.thread, "notes"); assert.equal(state.injected[0]!.images, undefined);
 assert.ok(Buffer.byteLength(parsed.body) <= TEXT_MESSAGE_INLINE_BYTES);
 assert.doesNotMatch(parsed.body, /\uFFFD/);
 for (const id of ids) { assert.ok(parsed.body.includes(`[truncated — full file at ${uploadFile(uploadRoot, id)}]`)); assert.deepEqual(readFileSync(uploadFile(uploadRoot, id)!), bytes); }
 assert.equal((parsed.body.match(/File: original.md/g) ?? []).length, 3);
 assert.deepEqual(journal(stateDir).find(row => row.type === "request")?.files, ids);
 assert.equal(readFileSync(controlJournalFile(stateDir), "utf8").includes("UNIQUE_FILE_CONTENT"), false);
 for (const files of [[], [ids[0], ids[0]], [newUploadId("png", new Date())]]) assert.equal((await controlRequest(record, "send_files", {kind: "message", text: "", files})).ok, false);
 writeFileSync(uploadFile(uploadRoot, ids[0]!)!, Buffer.from([0xc3, 0x28]));
 const invalid = await controlRequest(record, "send_files", {kind: "message", text: "", files: [ids[0]]}); assert.equal(invalid.ok ? null : invalid.status, 400); assert.equal(state.injected.length, 1);
});

test("cp-y43c review 1: while a queued image message is prepared for its handoff, an edit or cancel is 503 being handed over (not already sent); after the claim it is 409 sent", async (t) => {
	const { stateDir, uploadRoot } = scratch(t);
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const { state, ports } = fakePorts(async (bytes, mimeType) => { await gate; return { data: Buffer.from(bytes).toString("base64"), mimeType }; });
	let idle = false;
	ports.isIdle = () => idle;
	const record = await listening(t, stateDir, ports, { uploadRoot });
	const [image] = stored(uploadRoot, 1);
	const sent = await controlRequest(record, "send_images", { kind: "message", text: "with a picture", images: [image] });
	assert.ok(sent.ok && (sent.result as { state: string }).state === "queued", JSON.stringify(sent));
	const id = (sent.result as { id: string }).id;
	idle = true;
	// A later idle send nudges the queue: the held one is shifted off and its image is being prepared.
	await controlRequest(record, "send", { kind: "message", text: "next" });
	for (const op of ["queue_edit", "queue_cancel"] as const) {
		const reply = await controlRequest(record, op, { id, text: "changed" });
		assert.deepEqual([reply.ok, (reply as { status?: number }).status, (reply as { result?: unknown }).result], [false, 503, { id, state: "handing" }], op);
	}
	assert.equal(state.injected.length, 0, "nothing given to pi yet");
	release!();
	await new Promise((done) => setTimeout(done, 20));
	assert.equal(state.injected.length, 1);
	assert.match(state.injected[0]!.text, /^with a picture\n\n/, "the original text: the refused edit changed nothing");
	const late = await controlRequest(record, "queue_edit", { id, text: "changed" });
	assert.deepEqual([(late as { status?: number }).status, (late as { result?: unknown }).result], [409, { id, state: "sent", text: "with a picture" }]);
	assert.deepEqual(journal(stateDir).filter((line) => line.id === id).map((line) => line.type === "outcome" ? line.state : line.type), ["request", "queued", "injected"]);
});

test("cp-y43c review 3: a send made after the held head was shifted off (queue empty, its image still being prepared) queues behind it; pi gets the older one first, each exactly once", async (t) => {
	const { stateDir, uploadRoot } = scratch(t);
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const { state, ports } = fakePorts(async (bytes, mimeType) => { await gate; return { data: Buffer.from(bytes).toString("base64"), mimeType }; });
	let idle = false;
	ports.isIdle = () => idle;
	const control = await startDashboardControl({ stateDir, ports, uploadRoot, deliveredWaitMs: 50, log: () => {} }) as DashboardControl;
	assert.equal(control.state, "listening");
	t.after(() => control.stop());
	const record = (readControlRecord(stateDir) as { record: Record_ }).record;
	const [image] = stored(uploadRoot, 1);
	const older = await controlRequest(record, "send_images", { kind: "message", text: "older, with a picture", images: [image] });
	assert.equal(older.ok && (older.result as { state: string }).state, "queued");
	idle = true;
	control.settled(); // shifts the head off: the queue is now empty while its image waits on the gate
	assert.equal(state.injected.length, 0, "still preparing");
	const newer = await controlRequest(record, "send", { kind: "message", text: "newer, plain text" });
	assert.deepEqual(newer.ok && { state: (newer.result as { state: string }).state, editable: (newer.result as { editable?: boolean }).editable }, { state: "queued", editable: true }, "held behind the handoff in progress, not sent directly");
	assert.equal(state.injected.length, 0, "nothing reaches pi before the older message");
	release!();
	await new Promise((done) => setTimeout(done, 20));
	assert.deepEqual(state.injected.map((sent) => sent.text.split("\n\n")[0]), ["older, with a picture"], "the older one first; the newer waits for the next settled turn");
	control.settled();
	assert.deepEqual(state.injected.map((sent) => sent.text.split("\n\n")[0]), ["older, with a picture", "newer, plain text"]);
	control.settled();
	assert.equal(state.injected.length, 2, "each exactly once");
	const ids = [(older.result as { id: string }).id, (newer.result as { id: string }).id];
	assert.deepEqual(ids.map((id) => journal(stateDir).filter((line) => line.id === id).map((line) => line.type === "outcome" ? line.state : line.type)), [["request", "queued", "injected"], ["request", "queued", "injected"]]);
});
