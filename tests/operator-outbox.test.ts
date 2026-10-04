/** cp-6fyl A1/A2: the operator relay outbox (host-only writer) and the operator's ack journal. */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import {
	OPERATOR_RELAY_KEEP_CLOSED,
	OperatorRelayAcks,
	OperatorRelayError,
	OperatorRelayOutbox,
	oldestUnacked,
	operatorRelayAcksFile,
	operatorRelayOutboxFile,
	pendingRelays,
	relayIdOf,
	relayIdsOfMessage,
} from "../src/operator-outbox.ts";

const receipt = { level: null, reached: [] };
const relay = (patch: Partial<BridgeRelay>): BridgeRelay => ({ kind: "wake", stale: false, text: "wake", receipt, paths: [], ...patch });

function files(start = "2030-01-01T00:00:00Z") {
	const state = mkdtempSync(join(tmpdir(), "operator-outbox-"));
	let now = new Date(start);
	const clock = () => now;
	return {
		state,
		outbox: new OperatorRelayOutbox(operatorRelayOutboxFile(state), clock),
		acks: new OperatorRelayAcks(operatorRelayAcksFile(state)),
		advance: (ms: number) => (now = new Date(now.getTime() + ms)),
		now: clock,
	};
}

test("ids are stable per send and escalation, unique otherwise; paths sit under state/operator", () => {
	assert.equal(relayIdOf(relay({ kind: "send", sendId: "ps-1" })), "send:ps-1");
	assert.equal(relayIdOf(relay({ kind: "escalation", escalationId: "es-abcd" })), "esc:es-abcd");
	assert.notEqual(relayIdOf(relay({})), relayIdOf(relay({})));
	assert.match(relayIdOf(relay({})), /^wake:[0-9a-f-]{36}$/);
	assert.equal(operatorRelayOutboxFile("/h/s"), "/h/s/operator/relay-outbox.json");
	assert.equal(operatorRelayAcksFile("/h/s"), "/h/s/operator/relay-acks.jsonl");
});

test("enqueue is on disk before it returns", () => {
	const ctx = files();
	const id = ctx.outbox.enqueue(relay({ text: "hello" }), "host.1");
	const onDisk = JSON.parse(readFileSync(ctx.outbox.file, "utf8")) as { entries: Array<{ id: string; producer: string; queued_at: string }> };
	assert.deepEqual(onDisk.entries.map((entry) => [entry.id, entry.producer, entry.queued_at]), [[id, "host.1", "2030-01-01T00:00:00Z"]]);
});

test("a pending esc: re-enqueue replaces its text in place; after an ack a refresh mints esc:<id>#2; same text is a no-op", () => {
	const ctx = files();
	const first = ctx.outbox.enqueue(relay({ kind: "escalation", escalationId: "es-abcd", text: "v1" }), "h");
	ctx.advance(1_000);
	assert.equal(ctx.outbox.enqueue(relay({ kind: "escalation", escalationId: "es-abcd", text: "v2" }), "h", ctx.acks.fold()), first);
	const [entry] = ctx.outbox.read().entries;
	assert.equal(entry?.relay.text, "v2", "newest text wins");
	assert.equal(entry?.queued_at, "2030-01-01T00:00:00Z", "queued_at kept");
	ctx.acks.append([{ type: "ack", id: first, at: ctx.now().toISOString() }]);
	assert.equal(ctx.outbox.enqueue(relay({ kind: "escalation", escalationId: "es-abcd", text: "v2" }), "h", ctx.acks.fold()), first, "same text after the ack: nothing new");
	const refreshed = ctx.outbox.enqueue(relay({ kind: "escalation", escalationId: "es-abcd", text: "v3" }), "h", ctx.acks.fold());
	assert.equal(refreshed, "esc:es-abcd#2");
	assert.deepEqual(pendingRelays(ctx.outbox.read(), ctx.acks.fold()).map((item) => item.id), ["esc:es-abcd#2"]);
});

test("prune never drops a pending entry and keeps the newest closed ones past the TTL", () => {
	const ctx = files();
	const ids: string[] = [];
	for (let index = 0; index < OPERATOR_RELAY_KEEP_CLOSED + 5; index++) ids.push(ctx.outbox.enqueue(relay({ text: `w${index}` }), "h"));
	const pending = ctx.outbox.enqueue(relay({ text: "never acked" }), "h");
	ctx.acks.append(ids.map((id, index) => ({ type: "ack" as const, id, at: new Date(Date.parse("2030-01-01T00:00:00Z") + index * 1_000).toISOString() })));
	assert.equal(ctx.outbox.prune(ctx.acks.fold()), 0, "nothing is older than 24 h yet");
	ctx.advance(25 * 3_600_000);
	assert.equal(ctx.outbox.prune(ctx.acks.fold()), 5);
	const left = ctx.outbox.read().entries.map((entry) => entry.id);
	assert.equal(left.length, OPERATOR_RELAY_KEEP_CLOSED + 1);
	assert.ok(left.includes(pending));
	assert.ok(!left.includes(ids[0] as string), "the oldest closed went first");
	assert.ok(left.includes(ids.at(-1) as string));
});

test("the ack fold skips a torn line; emit_failed clears an emit; a later emit wins", () => {
	const ctx = files();
	ctx.acks.append([
		{ type: "consumer", owner: "o1", pid: 1, at: "2030-01-01T00:00:00Z", protocol: 1 },
		{ type: "emit", id: "a", owner: "o1", session: "s1", at: "2030-01-01T00:00:01Z" },
		{ type: "emit", id: "b", owner: "o1", at: "2030-01-01T00:00:01Z" },
		{ type: "emit_failed", id: "b", owner: "o1", at: "2030-01-01T00:00:02Z" },
		{ type: "ack", id: "c", at: "2030-01-01T00:00:03Z" },
		{ type: "discard", id: "d", reason: "superseded: answered", at: "2030-01-01T00:00:04Z" },
	]);
	appendFileSync(ctx.acks.file, '{"type":"ack","id":"tor');
	const fold = ctx.acks.fold();
	assert.deepEqual(fold.emits.get("a"), { owner: "o1", session: "s1", at: "2030-01-01T00:00:01Z" });
	assert.equal(fold.emits.has("b"), false);
	assert.ok(fold.failed.has("b"));
	assert.equal(fold.acked.get("c"), "2030-01-01T00:00:03Z");
	assert.equal(fold.discarded.get("d")?.reason, "superseded: answered");
	assert.equal(fold.acked.has("tor"), false);
	assert.equal(fold.consumer?.owner, "o1");
	assert.equal(new OperatorRelayAcks(join(ctx.state, "missing.jsonl")).fold().acked.size, 0, "a missing journal folds empty");
});

test("a corrupt outbox throws naming its path, on read and on enqueue", () => {
	const ctx = files();
	ctx.outbox.enqueue(relay({}), "h");
	writeFileSync(ctx.outbox.file, "{not json", "utf8");
	assert.throws(() => ctx.outbox.read(), (error: Error) => error instanceof OperatorRelayError && error.message.includes(ctx.outbox.file));
	writeFileSync(ctx.outbox.file, JSON.stringify({ schema_version: 1, updated_at: "2030-01-01T00:00:00Z", entries: [{ id: "x" }] }), "utf8");
	assert.throws(() => ctx.outbox.enqueue(relay({}), "h"), /violates the operator relay outbox contract/);
});

test("compaction keeps ack/discard lines for ids still in the outbox plus the newest consumer line", () => {
	const ctx = files();
	const kept = ctx.outbox.enqueue(relay({ text: "kept" }), "h");
	const lines = [
		{ type: "consumer" as const, owner: "old", pid: 1, at: "2030-01-01T00:00:00Z", protocol: 1 },
		{ type: "consumer" as const, owner: "new", pid: 2, at: "2030-01-01T00:00:01Z", protocol: 1 },
		{ type: "ack" as const, id: kept, at: "2030-01-01T00:00:02Z" },
	];
	for (let index = 0; index < 200; index++) lines.push({ type: "ack" as const, id: `gone-${index}`, at: "2030-01-01T00:00:03Z" });
	ctx.acks.append(lines);
	assert.equal(ctx.acks.compact(new Set([kept]), 10 ** 9), false, "under the size bound: untouched");
	assert.equal(ctx.acks.compact(new Set([kept]), 1_000), true);
	assert.ok(statSync(ctx.acks.file).size < 1_000);
	const fold = ctx.acks.fold();
	assert.deepEqual([...fold.acked.keys()], [kept]);
	assert.equal(fold.consumer?.owner, "new");
});

test("oldestUnacked and relayIdsOfMessage", () => {
	const ctx = files();
	const first = ctx.outbox.enqueue(relay({ text: "a" }), "h");
	ctx.advance(60_000);
	const second = ctx.outbox.enqueue(relay({ text: "b" }), "h");
	ctx.advance(60_000);
	assert.deepEqual(oldestUnacked(ctx.outbox.read(), ctx.acks.fold(), ctx.now()), { entry: ctx.outbox.read().entries[0], ageSeconds: 120 });
	ctx.acks.append([{ type: "ack", id: first, at: ctx.now().toISOString() }]);
	assert.equal(oldestUnacked(ctx.outbox.read(), ctx.acks.fold(), ctx.now())?.entry.id, second);
	assert.deepEqual(relayIdsOfMessage({ customType: "cp-bridge", details: { relay_ids: ["a", 3, "", "b"] } }), ["a", "b"]);
	assert.deepEqual(relayIdsOfMessage({ customType: "other", details: { relay_ids: ["a"] } }), []);
	assert.deepEqual(relayIdsOfMessage(undefined), []);
});
