/**
 * Retained (P19a): upload units no e2e surface can reach: uploadRoot()'s /tmp default (a test must never write the
 * shared root), writeUpload's O_EXCL (random ids never collide), readUploadMetadata's read counts and returned map
 * (not served), and a tailnet bind's own origin (the harness binds 127.0.0.1). The rest: viewer-conversations e2e.
 */
import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type DashboardControl, startDashboardControl } from "../src/dashboard-control.ts";
import { controlJournalFile, readControlRecord, readUploadMetadata } from "../src/viewer/control-files.ts";
import { createViewer } from "../src/viewer/server.ts";
import { newUploadId, UPLOAD_ROOT, uploadRoot, writeUpload } from "../src/viewer/uploads.ts";
import { send } from "./harness/conversations.ts";
import { createScratchHome } from "./harness/index.ts";
import { syntheticPng } from "./harness/images.ts";

function scratch(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-uploads-retained-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("root: an option wins, then CP_UPLOAD_ROOT (absolute), else the production literal", () => {
	const previous = process.env.CP_UPLOAD_ROOT;
	try {
		assert.equal(uploadRoot("/x/y"), "/x/y");
		process.env.CP_UPLOAD_ROOT = "relative/dir";
		assert.equal(uploadRoot(), join(process.cwd(), "relative/dir"));
		delete process.env.CP_UPLOAD_ROOT;
		assert.equal(uploadRoot(), "/tmp/cp-dashboard-uploads");
		assert.equal(UPLOAD_ROOT, "/tmp/cp-dashboard-uploads");
	} finally {
		if (previous === undefined) delete process.env.CP_UPLOAD_ROOT;
		else process.env.CP_UPLOAD_ROOT = previous;
	}
});

test("write: O_EXCL: an id is never overwritten", (t) => {
	const root = join(scratch(t), "uploads");
	const id = newUploadId("png", new Date());
	writeUpload(root, id, syntheticPng());
	assert.throws(() => writeUpload(root, id, syntheticPng()), /EEXIST/, "O_EXCL: an id is never overwritten");
});

test("metadata polls read only appended bytes, resume after the last newline, and return an isolated map", (t) => {
	const first = "tx-20261004-0123456789abcdef01234567.md", second = "im-20261004-abcdef0123456789abcdef01.png";
	const upload = (id: string, name: string, bytes: number) => JSON.stringify({ type: "upload", id, name, bytes });
	const state = scratch(t);
	mkdirSync(join(state, "operator"));
	const file = controlJournalFile(state);
	const initial = `${upload(first, "../report[1].md", 12)}\n${upload(second, "image.png", 20)}\n`;
	writeFileSync(file, initial);
	const reads = t.mock.method(fs, "readSync");
	syncBuiltinESMExports();
	t.after(() => { reads.mock.restore(); syncBuiltinESMExports(); });
	assert.deepEqual([...readUploadMetadata(state, [first])], [[first, { name: "report_1_.md", bytes: 12 }]]);
	const count = reads.mock.callCount();
	assert.ok(count > 0);
	assert.deepEqual([...readUploadMetadata(state, [second])], [[second, { name: "image.png", bytes: 20 }]]);
	assert.equal(reads.mock.callCount(), count, "unchanged polls perform no journal reads, even for a different id");
	appendFileSync(file, `${upload(first, "latest.md", 30)}\n`);
	readUploadMetadata(state, [first]);
	assert.equal((reads.mock.calls[count]!.arguments as unknown[])[4], Buffer.byteLength(initial), "resume after the previous newline");
	const result = readUploadMetadata(state, [first]);
	result.get(first)!.name = "mutated";
	assert.equal(readUploadMetadata(state, [first]).get(first)!.name, "latest.md");
	assert.deepEqual([...readUploadMetadata(state, [])], []);
});

test("no HTTPS origin configured: a tailnet bind's own http:// origin uploads and sends an image; a foreign origin is refused", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state), root = join(scratch(t), "root");
	const options = { home: home.path, stateDir, host: "100.64.0.9", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null }, uploadRoot: root };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const port = (server.address() as AddressInfo).port;
	const injected: Array<{ images?: Array<{ data: string }> }> = [];
	const control = await startDashboardControl({ stateDir, deliveredWaitMs: 20, log: () => {}, uploadRoot: root, ports: {
		inject: (_text, _deliverAs, parts) => { injected.push(parts ? { images: parts } : {}); }, abort: () => {}, isIdle: () => true, hasPendingMessages: () => false,
		sessionFile: () => join(stateDir, "op.jsonl"), prepareImage: async (bytes: Uint8Array, mimeType: string) => ({ data: Buffer.from(bytes).toString("base64"), mimeType }),
	} }) as DashboardControl;
	t.after(() => control.stop());
	const csrf = (readControlRecord(stateDir) as { record: { csrf: string } }).record.csrf;
	const self = { host: `100.64.0.9:${port}`, origin: `http://100.64.0.9:${port}`, "sec-fetch-site": "same-origin", "x-cp-control-token": csrf };
	const png = syntheticPng();
	const upload = (headers: Record<string, string>) => send(port, "/api/operator/upload", { method: "POST", body: png, headers: { ...self, "content-type": "image/png", ...headers } });
	const foreign = await upload({ origin: "https://evil.example" });
	assert.equal(foreign.status, 403);
	assert.match(String(foreign.body.error), /^Origin must be http:\/\/100\.64\.0\.9:\d+ \(no HTTPS origin is configured/);
	const stored = await upload({});
	assert.equal(stored.status, 201, JSON.stringify(stored.body));
	const body = JSON.stringify({ kind: "message", text: "", images: [stored.body.id] });
	const sent = await send(port, "/api/operator/message", { method: "POST", body, headers: { ...self, "content-type": "application/json" } });
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual(Buffer.from(injected[0]!.images![0]!.data, "base64"), png);
});
