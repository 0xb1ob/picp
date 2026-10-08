import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { controlJournalFile, readUploadMetadata } from "../src/viewer/control-files.ts";

const first = "tx-20261004-0123456789abcdef01234567.md";
const second = "im-20261004-abcdef0123456789abcdef01.png";
const upload = (id: string, name: string, bytes: number) => JSON.stringify({ type: "upload", id, name, bytes });
function journal(t: TestContext): { state: string; file: string } {
	const state = mkdtempSync(join(tmpdir(), "cp-upload-metadata-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	mkdirSync(join(state, "operator"));
	return { state, file: controlJournalFile(state) };
}

test("metadata polls read only appended bytes and preserve filtered, sanitized, latest upload output", t => {
	const { state, file } = journal(t);
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
	appendFileSync(file, `${upload(first, "latest.md", 30)}\nnot json\n${upload(first, "invalid", -1)}\n`);
	assert.deepEqual([...readUploadMetadata(state, [second, first, "unknown"])], [
		[first, { name: "latest.md", bytes: 30 }], [second, { name: "image.png", bytes: 20 }],
	]);
	assert.equal((reads.mock.calls[count]!.arguments as unknown[])[4], Buffer.byteLength(initial), "resume after the previous newline");
	const result = readUploadMetadata(state, [first]);
	result.get(first)!.name = "mutated";
	assert.equal(readUploadMetadata(state, [first]).get(first)!.name, "latest.md");
	assert.deepEqual([...readUploadMetadata(state, [])], []);
});

test("metadata resets on truncation, rotation to a larger inode, and a missing journal", t => {
	const { state, file } = journal(t);
	writeFileSync(file, `${upload(first, "old.md", 1)}\n${upload(second, "old.png", 2)}\n`);
	assert.equal(readUploadMetadata(state, [first, second]).size, 2);
	writeFileSync(file, `${upload(second, "new.png", 3)}\n`);
	assert.deepEqual([...readUploadMetadata(state, [first, second])], [[second, { name: "new.png", bytes: 3 }]]);
	renameSync(file, `${file}.old`);
	writeFileSync(file, `${upload(first, "rotated.md", 4)}\n${JSON.stringify({ type: "request", text: "x".repeat(300) })}\n`);
	assert.deepEqual([...readUploadMetadata(state, [first, second])], [[first, { name: "rotated.md", bytes: 4 }]]);
	rmSync(file);
	assert.equal(readUploadMetadata(state, [first]).size, 0);
	writeFileSync(file, `${upload(second, "restored.png", 5)}\n`);
	assert.deepEqual([...readUploadMetadata(state, [first, second])], [[second, { name: "restored.png", bytes: 5 }]]);
});

test("metadata waits for partial trailing records, including split UTF-8, and detects shrink above the committed offset", t => {
	const { state, file } = journal(t);
	const complete = `${upload(first, "keep.md", 1)}\n`;
	const partial = Buffer.from(upload(second, "café.png", 2));
	const split = partial.indexOf(Buffer.from("é")) + 1;
	writeFileSync(file, Buffer.concat([Buffer.from(complete), partial.subarray(0, split)]));
	assert.equal(readUploadMetadata(state, [first, second]).size, 1);
	appendFileSync(file, partial.subarray(split));
	assert.equal(readUploadMetadata(state, [second]).size, 0, "valid JSON without a newline remains pending");
	appendFileSync(file, "\n");
	assert.deepEqual([...readUploadMetadata(state, [second])], [[second, { name: "caf_.png", bytes: 2 }]]);
	appendFileSync(file, "x".repeat(300));
	readUploadMetadata(state, [first, second]);
	writeFileSync(file, `${upload(first, "replaced.md", 3)}\n${"x".repeat(150)}`);
	assert.deepEqual([...readUploadMetadata(state, [first, second])], [[first, { name: "replaced.md", bytes: 3 }]]);
});

test("metadata reads records across chunk boundaries and retries a large trailing record", t => {
	const { state, file } = journal(t);
	const padding = `${JSON.stringify({ type: "request", text: "x".repeat(1024 * 1024 - 70) })}\n`;
	const record = upload(first, "boundary.md", 8);
	writeFileSync(file, padding + record + "\n");
	assert.deepEqual([...readUploadMetadata(state, [first])], [[first, { name: "boundary.md", bytes: 8 }]]);
	const large = JSON.stringify({ type: "upload", id: second, name: "large.png", bytes: 9, ignored: "x".repeat(1024 * 1024 + 20) });
	appendFileSync(file, large);
	assert.equal(readUploadMetadata(state, [second]).size, 0);
	appendFileSync(file, "\n");
	assert.deepEqual([...readUploadMetadata(state, [second])], [[second, { name: "large.png", bytes: 9 }]]);
});
