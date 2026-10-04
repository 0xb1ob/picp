/**
 * Dashboard image attachments (cp-br81 plan T2): the magic-byte sniff, the id and layout, the 0700/0600 modes,
 * unsafe directories, reads that refuse symlinks and mismatched bytes, the 7-day expiry and the sweep.
 * Every test runs in its own mkdtemp root; none touches /tmp/cp-dashboard-uploads.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureUploadDir, inlineBudget, newUploadId, readUpload, sniffImage, statUpload, sweepUploads, UPLOAD_ID_RE, UPLOAD_ROOT, uploadFile, uploadRoot, writeUpload } from "../src/viewer/uploads.ts";
import { STUBS, syntheticPng } from "./harness/images.ts";

function scratch(t: import("node:test").TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-uploads-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "uploads");
}
// Real time: file mtimes are real, so a fixed date would expire them as the calendar moves on.
const NOW = new Date();
const DAY = NOW.toISOString().slice(0, 10).replace(/-/g, "");
const mode = (path: string) => statSync(path).mode & 0o777;

test("sniff: PNG, JPEG, GIF and WebP by magic bytes; HEIC, SVG, text and truncated bytes refused", () => {
	assert.deepEqual(sniffImage(syntheticPng()), { mime: "image/png", ext: "png" });
	assert.deepEqual(sniffImage(STUBS.jpeg), { mime: "image/jpeg", ext: "jpg" });
	assert.deepEqual(sniffImage(STUBS.gif), { mime: "image/gif", ext: "gif" });
	assert.deepEqual(sniffImage(STUBS.webp), { mime: "image/webp", ext: "webp" });
	assert.deepEqual(sniffImage(STUBS.heic), { refused: "heic" });
	for (const brand of ["heix", "mif1", "msf1"]) assert.deepEqual(sniffImage(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)])), { refused: "heic" }, brand);
	assert.deepEqual(sniffImage(STUBS.svg), { refused: "svg" });
	assert.deepEqual(sniffImage(STUBS.text), { refused: "unknown" });
	assert.deepEqual(sniffImage(syntheticPng().subarray(0, 5)), { refused: "unknown" });
	assert.deepEqual(sniffImage(Buffer.alloc(0)), { refused: "unknown" });
});

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

test("write: id and layout <root>/<yyyymmdd>/<24 hex>.<ext>, dirs 0700 and the file 0600; read gives the bytes back", (t) => {
	const root = scratch(t);
	const id = newUploadId("png", NOW);
	assert.match(id, UPLOAD_ID_RE);
	assert.match(id, new RegExp(`^im-${DAY}-[0-9a-f]{24}\\.png$`));
	const bytes = syntheticPng();
	writeUpload(root, id, bytes);
	const file = uploadFile(root, id)!;
	assert.equal(file, join(root, DAY, id.slice(`im-${DAY}-`.length)));
	assert.equal(mode(root), 0o700);
	assert.equal(mode(join(root, DAY)), 0o700);
	assert.equal(mode(file), 0o600);
	const read = readUpload(root, id, new Date());
	assert.equal(read.state, "ok");
	assert.deepEqual(read.state === "ok" && read.bytes, bytes);
	assert.equal(read.state === "ok" && read.mime, "image/png");
	assert.equal(statUpload(root, id, new Date()).state, "ok");
	assert.throws(() => writeUpload(root, id, bytes), /EEXIST/, "O_EXCL: an id is never overwritten");
	assert.equal(uploadFile(root, "../../etc/passwd"), undefined, "a path is only ever built from an id");
});

test("directories: a symlinked root is refused; a 0755 root of ours is tightened to 0700", (t) => {
	const root = scratch(t);
	const real = `${root}-real`;
	mkdirSync(real, { mode: 0o700 });
	symlinkSync(real, root);
	assert.throws(() => ensureUploadDir(root), /upload directory .* is not safe: it is a symlink/);
	assert.throws(() => writeUpload(root, newUploadId("png", NOW), syntheticPng()), /symlink/);
	assert.equal(readdirSync(real).length, 0, "nothing written through the link");
	const loose = `${root}-loose`;
	mkdirSync(loose, { mode: 0o755 });
	chmodSync(loose, 0o755);
	ensureUploadDir(loose);
	assert.equal(mode(loose), 0o700);
});

test("read: missing, a symlinked file, bytes that do not match the extension, and a file past 7 days (unlinked) are never served", (t) => {
	const root = scratch(t);
	const id = newUploadId("png", NOW);
	assert.equal(readUpload(root, id, NOW).state, "missing");
	writeUpload(root, id, syntheticPng());
	const fake = newUploadId("png", NOW);
	writeFileSync(uploadFile(root, fake)!, STUBS.jpeg, { mode: 0o600 });
	const mismatch = readUpload(root, fake, NOW);
	assert.equal(mismatch.state, "invalid");
	assert.match(mismatch.state === "invalid" ? mismatch.reason : "", /do not match/);
	const linked = newUploadId("png", NOW);
	symlinkSync(uploadFile(root, id)!, uploadFile(root, linked)!);
	assert.deepEqual(readUpload(root, linked, NOW), { state: "invalid", reason: "it is a symlink" });
	const old = new Date(NOW.getTime() - 8 * 86_400_000);
	utimesSync(uploadFile(root, id)!, old, old);
	assert.equal(readUpload(root, id, NOW).state, "missing");
	assert.throws(() => statSync(uploadFile(root, id)!), /ENOENT/, "expired on read is unlinked");
	assert.equal(readUpload(root, "im-nope", NOW).state, "invalid");
});

test("sweep: files past 7 days and then empty day dirs go; the rest is totalled; other names are left alone", (t) => {
	const root = scratch(t);
	const keep = newUploadId("png", NOW);
	const drop = newUploadId("png", new Date("2020-01-01T00:00:00Z"));
	writeUpload(root, keep, syntheticPng());
	writeUpload(root, drop, syntheticPng(4, 4));
	const old = new Date(NOW.getTime() - 8 * 86_400_000);
	utimesSync(uploadFile(root, drop)!, old, old);
	writeFileSync(join(root, DAY, "notes.txt"), "not ours");
	const swept = sweepUploads(root, NOW);
	assert.deepEqual(swept, { total: syntheticPng().length, removed: 1 });
	assert.deepEqual(readdirSync(root).sort(), [DAY], "the emptied day dir is gone");
	assert.ok(readdirSync(join(root, DAY)).includes("notes.txt"));
	assert.deepEqual(sweepUploads(join(root, "absent"), NOW), { total: 0, removed: 0 });
});

test("inline budget: 768 KiB for one image, an even share of 2 MiB beyond", () => {
	assert.deepEqual([1, 4, 8].map(inlineBudget), [786432, 524288, 262144]);
});
