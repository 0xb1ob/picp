/**
 * cp-br81 units retained by P9d: the bridge always wires pi's resizeImage, so no entry point can hold, stall or omit
 * image preparation; the deadline, the missing capability and the mid-handoff races reach the control only directly.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlPorts, type DashboardControl, type InlineImage, startDashboardControl } from "../src/dashboard-control.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import { controlJournalFile, readControlRecord } from "../src/viewer/control-files.ts";
import { newUploadId, writeUpload } from "../src/viewer/uploads.ts";
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
		hasPendingMessages: () => true, // Holds each handoff unseen; re-hand evidence: e2e/headless-lifecycle.test.ts.
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

test("send_images refusals: a resize past the deadline 504 — nothing injected", async (t) => {
	const slow = scratch(t);
	const never = fakePorts(() => new Promise(() => {}));
	const slowRecord = await listening(t, slow.stateDir, never.ports, { uploadRoot: slow.uploadRoot, imagePrepMs: 50 });
	const late = await controlRequest(slowRecord, "send_images", { kind: "message", text: "x", images: stored(slow.uploadRoot, 1) });
	assert.deepEqual(late.ok ? null : late.status, 504);
	assert.equal(never.state.injected.length, 0, "nothing sent past the deadline");
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
