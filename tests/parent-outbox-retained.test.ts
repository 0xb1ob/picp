/**
 * Parent send outbox, retained (no entry point): a refused RPC write's rollback, a race inside reserveOuterRetry, and
 * an invalid limit (its one caller passes a constant). The rest is tests/e2e/parent-send-p9f.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parentSendFile, ParentSendOutbox, ParentSendOutboxError } from "../src/parent-outbox.ts";

function outbox(options: { now?: () => Date; owner?: string } = {}): ParentSendOutbox {
	const dir = mkdtempSync(join(tmpdir(), "parent-outbox-"));
	return new ParentSendOutbox({ file: parentSendFile(join(dir, "cp-parent.jsonl")), owner: "me", ...options });
}

test("injection reserves, a refused write rolls back, landing is idempotent", () => {
	const box = outbox();
	const { id } = box.enqueue("a");
	box.markInjected([id]);
	assert.equal(box.get(id)?.state, "injected");
	assert.equal(box.get(id)?.attempts, 1);
	box.revertInjected([id]);
	assert.equal(box.get(id)?.state, "queued");
	assert.equal(box.get(id)?.attempts, 0);
	box.markInjected([id]);
	assert.deepEqual(box.markLanded([id]), [id]);
	assert.deepEqual(box.markLanded([id]), [id]);
	assert.equal(box.get(id)?.state, "landed");
	box.revertInjected([id]);
	assert.equal(box.get(id)?.state, "landed", "a landed body is never requeued");
});

test("reserveOuterRetry returns no ordinal when nothing was persisted", () => {
	const box = outbox();
	const entry = box.enqueue("raced");
	const before = readFileSync(box.file, "utf8");
	// The record read as landed, but by the write it no longer is: the update moves nothing.
	box.get = () => ({ ...entry, state: "landed" });
	assert.equal(box.reserveOuterRetry(entry.id, 5), undefined);
	assert.equal(readFileSync(box.file, "utf8"), before);
});

test("reserveOuterRetry refuses a limit that is not a positive integer", () => {
	const box = outbox();
	const b = box.enqueue("b");
	box.markInjected([b.id]);
	box.markLanded([b.id]);
	const reloaded = new ParentSendOutbox({ file: box.file });
	for (const limit of [0, -1, 1.5, Number.NaN]) assert.throws(() => reloaded.reserveOuterRetry(b.id, limit), ParentSendOutboxError);
});
