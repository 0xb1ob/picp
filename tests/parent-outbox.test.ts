/**
 * Parent send outbox: the durable record behind every `cp_parent send`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	frameBatch,
	operatorSendTexts,
	PARENT_SEND_KEEP_OBSERVED,
	PARENT_SEND_MAX_ATTEMPTS,
	parentSendFile,
	ParentSendOutbox,
	ParentSendOutboxError,
	receiptOf,
	sendIdOfMessage,
	sendIdsInText,
	sendIdsInTranscript,
	sendMarker,
} from "../src/parent-outbox.ts";

function outbox(options: { now?: () => Date; owner?: string } = {}): ParentSendOutbox {
	const dir = mkdtempSync(join(tmpdir(), "parent-outbox-"));
	return new ParentSendOutbox({ file: parentSendFile(join(dir, "cp-parent.jsonl")), owner: "me", ...options });
}

test("the outbox file sits beside the session file", () => {
	assert.equal(parentSendFile("/h/state/sessions/cp-parent.jsonl"), "/h/state/sessions/cp-parent.sends.json");
});

test("enqueue is on disk before it returns, with a well-formed id", () => {
	const box = outbox();
	const entry = box.enqueue("ship it");
	assert.match(entry.id, /^ps-\d{14}-[0-9a-f]{8}$/);
	const onDisk = JSON.parse(readFileSync(box.file, "utf8")) as { entries: Array<{ id: string; state: string }> };
	assert.deepEqual(onDisk.entries.map((item) => [item.id, item.state]), [[entry.id, "queued"]]);
	assert.throws(() => box.enqueue(""), ParentSendOutboxError);
});

test("delegation survives reload and batching without changing legacy send records", () => {
	const box = outbox();
	const old = box.enqueue("human answer");
	const rule = "approvals: 'on my behalf' [scope]\nnext line";
	const delegated = box.enqueue("delegated answer", { delegated: true, delegation_rule: rule });
	const implicit = box.enqueue("another delegated answer", { delegated: true });
	const off = box.enqueue("another human answer", { delegated: false, delegation_rule: "unused" });
	const reloaded = new ParentSendOutbox({ file: box.file });
	assert.deepEqual(reloaded.get(old.id), old);
	const framed = frameBatch(reloaded.list());
	assert.deepEqual(operatorSendTexts(framed), [
		{ text: "human answer" },
		{ text: "delegated answer", provenance: { delegation_rule: rule, send_id: delegated.id } },
		{ text: "another delegated answer", provenance: { delegation_rule: "operator delegation", send_id: implicit.id } },
		{ text: "another human answer" },
	]);
	assert.deepEqual(sendIdsInText(framed), [old.id, delegated.id, implicit.id, off.id]);
	for (const delegation_rule of ["", " "]) {
		assert.throws(() => box.enqueue("no write", { delegated: true, delegation_rule }), ParentSendOutboxError);
	}
	assert.equal(box.list().length, 4);
});

test("send rules are trimmed and truncated to 200 characters before persistence and framing", () => {
	const box = outbox();
	for (const [input, expected] of [
		["  standing approval \n", "standing approval"],
		["x".repeat(200), "x".repeat(200)],
		["x".repeat(201), `${"x".repeat(199)}…`],
		["x".repeat(400), `${"x".repeat(199)}…`],
	]) {
		const entry = box.enqueue("approve", { delegated: true, delegation_rule: input });
		assert.equal(box.get(entry.id)?.delegation_rule, expected);
		assert.deepEqual(operatorSendTexts(frameBatch([entry])), [{ text: "approve", provenance: { delegation_rule: expected, send_id: entry.id } }]);
		assert.equal(sendMarker(entry.id, { delegated: true, delegation_rule: input }), sendMarker(entry.id, { delegated: true, delegation_rule: expected }));
	}
});

test("truncation preserves Unicode boundaries through accepted send framing", () => {
	const box = outbox();
	for (const [input, expected] of [
		[`${"x".repeat(198)}\u{1F600}more`, `${"x".repeat(198)}…`],
		[`${"x".repeat(197)}\u{1F600}more`, `${"x".repeat(197)}\u{1F600}…`],
	]) {
		const entry = box.enqueue("approve", { delegated: true, delegation_rule: input });
		const framed = frameBatch([entry]);
		assert.equal(entry.delegation_rule, expected);
		assert.ok(entry.delegation_rule && entry.delegation_rule.length <= 200);
		assert.deepEqual(operatorSendTexts(framed), [{ text: "approve", provenance: { delegation_rule: expected, send_id: entry.id } }]);
	}
});

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

test("receipts map each state onto the existing levels; failed never reaches owner_observed", () => {
	const box = outbox();
	const ok = box.enqueue("ok");
	assert.equal(receiptOf(box.get(ok.id)!).level, null);
	box.markInjected([ok.id]);
	assert.equal(receiptOf(box.get(ok.id)!).level, "injected");
	box.markLanded([ok.id]);
	assert.equal(receiptOf(box.get(ok.id)!).pending, ok.id);
	assert.equal(box.settle(ok.id, { reply: "done" }), true);
	assert.equal(box.settle(ok.id, { reply: "again" }), false);
	assert.equal(receiptOf(box.get(ok.id)!).level, "turn_settled");
	assert.equal(box.markObserved(ok.id), true);
	assert.equal(box.markObserved(ok.id), false);
	assert.deepEqual(receiptOf(box.get(ok.id)!), {
		level: "owner_observed",
		reached: ["injected", "turn_settled", "owner_observed"],
		reply: "done",
		send_id: ok.id,
	});
	const bad = box.enqueue("bad");
	box.markInjected([bad.id]);
	box.markLanded([bad.id]);
	box.settle(bad.id, { error: "404" });
	box.markObserved(bad.id);
	const failed = receiptOf(box.get(bad.id)!);
	assert.equal(failed.level, "turn_failed");
	assert.equal(failed.reached.includes("owner_observed"), false);
	assert.equal(failed.error, "404");
	const lost = box.enqueue("lost");
	box.markUndeliverable([lost.id], "gone");
	assert.deepEqual(receiptOf(box.get(lost.id)!), { level: null, reached: [], error: "gone", send_id: lost.id });
});

test("the attempt ceiling and the max age end a send undeliverable, never silently", () => {
	let now = new Date("2026-09-24T00:00:00Z");
	const box = outbox({ now: () => now });
	const { id } = box.enqueue("retry me");
	for (let i = 0; i < PARENT_SEND_MAX_ATTEMPTS; i += 1) {
		assert.deepEqual(box.due().map((entry) => entry.id), [id]);
		box.markInjected([id]);
		box.reconcile({ entries: [], dropped: 0 });
	}
	assert.equal(box.get(id)?.state, "undeliverable");
	assert.match(box.get(id)?.error ?? "", /not delivered after 5 attempts/);
	assert.deepEqual(box.due(), []);
	const old = box.enqueue("old");
	now = new Date("2026-09-25T00:00:01Z");
	assert.deepEqual(box.due(), []);
	assert.deepEqual(box.expireStale().map((entry) => entry.id), [old.id]);
	assert.match(box.get(old.id)?.error ?? "", /^stale: queued 2026-09-24T00:00:00Z/);
});

test("reconcile: seen lands, absent requeues, unprovable is undeliverable", () => {
	const box = outbox({ now: () => new Date("2026-09-24T10:00:00Z") });
	const seen = box.enqueue("seen");
	const absent = box.enqueue("absent");
	box.markInjected([seen.id, absent.id]);
	const entries = [
		{ type: "message", timestamp: "2026-09-24T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: frameBatch([seen]) }] } },
		{ type: "message", message: { role: "assistant", content: `${sendMarker(absent.id)}` } },
		{ type: "custom_message", message: { role: "user", content: sendMarker(absent.id) } },
	];
	assert.deepEqual([...sendIdsInTranscript(entries)], [seen.id]);
	assert.deepEqual(box.reconcile({ entries, dropped: 0 }), []);
	assert.equal(box.get(seen.id)?.state, "landed");
	assert.equal(box.get(absent.id)?.state, "queued");
	box.markInjected([absent.id]);
	const window = [{ type: "message", timestamp: "2026-09-24T11:00:00.000Z", message: { role: "user", content: "x" } }];
	const lost = box.reconcile({ entries: window, dropped: 3 });
	assert.deepEqual(lost.map((entry) => entry.id), [absent.id]);
	assert.match(box.get(absent.id)?.error ?? "", /landing unprovable/);
});

test("relaysDue skips this owner's own relays and keeps another owner's unobserved ones", () => {
	const box = outbox({ owner: "a" });
	const mine = box.enqueue("mine");
	box.markInjected([mine.id]);
	box.markLanded([mine.id]);
	box.settle(mine.id, { reply: "r" });
	assert.deepEqual(box.relaysDue().map((entry) => entry.id), [mine.id], "never relayed yet");
	box.markRelayed(mine.id);
	assert.deepEqual(box.relaysDue(), []);
	const other = new ParentSendOutbox({ file: box.file, owner: "b" });
	assert.deepEqual(other.relaysDue().map((entry) => entry.id), [mine.id]);
	other.markObserved(mine.id);
	assert.deepEqual(other.relaysDue(), []);
});

test("trimming keeps every unobserved entry and the newest observed ones", () => {
	const box = outbox();
	const first = box.enqueue("keep me");
	const at = "2026-09-24T00:00:00Z";
	const observed = Array.from({ length: PARENT_SEND_KEEP_OBSERVED + 2 }, (_, i) => ({
		schema_version: 1,
		id: `ps-20260924000000-${i.toString(16).padStart(8, "0")}`,
		text: `n${i}`,
		queued_at: at,
		state: "undeliverable",
		attempts: 0,
		error: "x",
		owner_observed_at: at,
	}));
	writeFileSync(box.file, JSON.stringify({ schema_version: 1, updated_at: at, entries: [...box.list(), ...observed] }), "utf8");
	box.enqueue("one more write");
	const entries = box.list();
	assert.equal(entries.some((entry) => entry.id === observed[0]?.id), false, "the oldest observed entries go first");
	assert.ok(entries.some((entry) => entry.id === first.id));
	assert.equal(entries.filter((entry) => entry.owner_observed_at).length, PARENT_SEND_KEEP_OBSERVED);
});

test("an invalid file is refused, naming the path", () => {
	const box = outbox();
	writeFileSync(box.file, "{ nope", "utf8");
	assert.throws(() => box.list(), (error: unknown) => error instanceof ParentSendOutboxError && (error as Error).message.includes(box.file));
	writeFileSync(box.file, JSON.stringify({ schema_version: 1, updated_at: "x", entries: [] }), "utf8");
	assert.throws(() => box.enqueue("a"), (error: unknown) => error instanceof ParentSendOutboxError && (error as Error).message.includes(box.file));
});

test("frameBatch round-trips through sendIdsInText; relays carry send_id in details", () => {
	const box = outbox();
	const a = box.enqueue("one");
	const b = box.enqueue("two");
	const framed = frameBatch([a, b]);
	assert.deepEqual(sendIdsInText(framed), [a.id, b.id]);
	assert.match(framed, /one[\s\S]*---[\s\S]*two/);
	assert.equal(sendIdOfMessage({ customType: "cp-bridge", details: { send_id: a.id } }), a.id);
	assert.equal(sendIdOfMessage({ customType: "cp-ci", details: { send_id: a.id } }), undefined);
	assert.equal(sendIdOfMessage({ customType: "cp-bridge", details: {} }), undefined);
});

test("reserveOuterRetry: landed-only, capped, independent of injections, survives reload and settle", () => {
	const box = outbox();
	const a = box.enqueue("a");
	const b = box.enqueue("b");
	assert.equal(a.outer_retry_attempts, 0);
	assert.equal(box.reserveOuterRetry(a.id, 3), undefined, "queued: nothing to retry");
	box.markInjected([a.id, b.id]);
	box.markLanded([a.id, b.id]);
	const before = readFileSync(box.file, "utf8");
	assert.equal(box.reserveOuterRetry("ps-20000101000000-00000000", 3), undefined);
	assert.equal(readFileSync(box.file, "utf8"), before, "a no-op never writes");
	assert.deepEqual([1, 2, 3].map(() => box.reserveOuterRetry(a.id, 3)), [1, 2, 3]);
	assert.equal(box.reserveOuterRetry(a.id, 3), undefined, "cap reached");
	assert.equal(box.reserveOuterRetry(b.id, 3), 1, "counters are per send id");
	const reloaded = new ParentSendOutbox({ file: box.file });
	assert.equal(reloaded.get(a.id)?.outer_retry_attempts, 3);
	assert.equal(reloaded.get(a.id)?.attempts, 1, "injection attempts are a separate count");
	assert.equal(reloaded.reserveOuterRetry(b.id, 3), 2, "reload continues at the next ordinal");
	reloaded.settle(a.id, { error: "boom" });
	assert.equal(reloaded.get(a.id)?.outer_retry_attempts, 3, "the terminal record keeps the count");
	assert.equal(reloaded.reserveOuterRetry(a.id, 9), undefined, "terminal: nothing to retry");
	for (const limit of [0, -1, 1.5, Number.NaN]) assert.throws(() => reloaded.reserveOuterRetry(b.id, limit), ParentSendOutboxError);
});

test("a record without outer_retry_attempts reads as zero; a negative or fractional one is refused", () => {
	const box = outbox();
	const entry = box.enqueue("legacy");
	box.markInjected([entry.id]);
	box.markLanded([entry.id]);
	const file = JSON.parse(readFileSync(box.file, "utf8")) as { entries: Array<Record<string, unknown>> };
	delete file.entries[0]?.outer_retry_attempts;
	writeFileSync(box.file, JSON.stringify(file), "utf8");
	assert.equal(box.get(entry.id)?.outer_retry_attempts, undefined);
	assert.equal(box.reserveOuterRetry(entry.id, 5), 1);
	for (const bad of [-1, 0.5]) {
		file.entries[0]!.outer_retry_attempts = bad;
		writeFileSync(box.file, JSON.stringify(file), "utf8");
		assert.throws(() => box.reserveOuterRetry(entry.id, 5), ParentSendOutboxError);
	}
});
