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
import { ensureUploadDir, inlineBudget, inlineTextFiles, isImageUploadId, isTextUploadId, newUploadId, readUpload, sanitizeUploadName, sniffImage, statUpload, sweepUploads, textExtension, TEXT_MESSAGE_INLINE_BYTES, TEXT_UPLOAD_MAX_BYTES, UPLOAD_ID_RE, UPLOAD_ROOT, uploadFile, uploadRoot, validateText, writeUpload } from "../src/viewer/uploads.ts";
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


test("text validation: UTF-8, no NUL, valid JSON, and 1 MiB; safe tx ids and revalidation on read", t => {
 const root = scratch(t);
 for (const ext of ["txt", "md", "html", "json"] as const) {
  const bytes = Buffer.from(ext === "json" ? '{"ok":true}' : "<script>literal</script> café");
  assert.ok("text" in validateText(bytes, ext));
  const id = newUploadId(ext, NOW);
  assert.ok(isTextUploadId(id)); assert.equal(isImageUploadId(id), false);
  assert.match(id, UPLOAD_ID_RE); assert.equal(uploadFile(root, id), join(root, DAY, id.slice(12)));
  writeUpload(root, id, bytes);
  const read = readUpload(root, id, NOW);
  assert.equal(read.state, "ok"); assert.equal(read.state === "ok" && read.mime, "text/plain");
  writeFileSync(uploadFile(root, id)!, Buffer.from([0xc3, 0x28]));
  assert.equal(readUpload(root, id, NOW).state, "invalid");
 }
 for (const [bytes, ext, reason] of [[Buffer.from([0]), "txt", /NUL/], [Buffer.from([0xc3, 0x28]), "md", /UTF-8/], [Buffer.from("{bad}"), "json", /valid JSON/], [Buffer.alloc(TEXT_UPLOAD_MAX_BYTES + 1, 97), "html", /1 MiB/]] as const) {
  const result = validateText(bytes, ext); assert.ok("refused" in result); assert.match(result.refused, reason);
 }
 assert.ok("text" in validateText(Buffer.alloc(TEXT_UPLOAD_MAX_BYTES, 97), "txt"));
 for (const id of ["tx-20261004-0123456789abcdef01234567.svg", "im-20261004-0123456789abcdef01234567.txt", "tx-20261004-0123456789abcdef01234567.png"]) assert.equal(uploadFile(root, id), undefined);
 assert.equal(sanitizeUploadName("../folder\\evil\n[<name>].HTML"), "evil___name__.HTML");
 assert.equal(textExtension("report.JSON"), "json"); assert.equal(textExtension("report.json.exe"), undefined);
});

test("text inline: bounded total including robust fences and paths, truncation keeps UTF-8 and full stored bytes", () => {
 const hostile = "```\n~~~~\n<script>literal</script>\n";
 const bytes = Buffer.from(hostile + "é".repeat(400_000));
 const files = Array.from({length: 8}, (_, i) => ({name: `file-${i}.md`, path: `/tmp/store/file-${i}.md`, bytes}));
 const inline = inlineTextFiles(files);
 assert.ok(Buffer.byteLength(inline) <= TEXT_MESSAGE_INLINE_BYTES);
 assert.doesNotMatch(inline, /\uFFFD/);
 for (const file of files) assert.ok(inline.includes(`[truncated — full file at ${file.path}]`));
 assert.equal((inline.match(/File: /g) ?? []).length, 8);
 const short = inlineTextFiles([{name: "small.md", path: "/tmp/store/small.md", bytes: Buffer.from(hostile)}]);
 assert.equal(short, `File: small.md\n\`\`\`\`text\n${hostile}\n\`\`\`\`\n\n`);
 const pathological = inlineTextFiles([{name: "runs.txt", path: "/tmp/runs.txt", bytes: Buffer.from("`".repeat(100_000) + "~".repeat(100_000))}]);
 assert.ok(Buffer.byteLength(pathological) <= TEXT_MESSAGE_INLINE_BYTES);
 assert.equal(inlineTextFiles([]), "");
});
