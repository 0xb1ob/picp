/**
 * Dashboard image attachments, the operator session's half (cp-br81 plan T4): `userMessageContent` builds the
 * image parts pi.sendUserMessage receives, the `send_images` op reads, resizes and injects them, and cp-bridge
 * wires both (real pi resizeImage). Every upload root is a mkdtemp dir; none is /tmp/cp-dashboard-uploads.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlPorts, type DashboardControl, type InlineImage, startDashboardControl, userMessageContent } from "../src/dashboard-control.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import { controlJournalFile, parseDashboardText, readControlRecord } from "../src/viewer/control-files.ts";
import { inlineBudget, newUploadId, uploadFile, writeUpload } from "../src/viewer/uploads.ts";
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
	assert.equal(parseDashboardText(sent.text)?.body, "");
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
	assert.ok(text.startsWith(`see\n\n[image ${kept} could not be attached inline; file: ${uploadFile(nulls.uploadRoot, kept!)}]\n\n[cp-dashboard `), text);
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
	assert.match(parts[0]!.text!, new RegExp(`^what is this\\?\\n\\n\\[cp-dashboard dc-\\d{14}-[0-9a-f]{8} — from the dashboard; images=${id!.replace(/\./g, "\\.")}\\]$`));
	assert.equal(parts[1]!.type, "image");
	assert.equal(parts[1]!.mimeType, "image/png");
	assert.equal(Buffer.from(parts[1]!.data!, "base64").subarray(1, 4).toString("latin1"), "PNG", "a real PNG, base64");
});
