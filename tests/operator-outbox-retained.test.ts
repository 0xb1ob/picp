/** Retained from tests/operator-outbox.test.ts (P9b): inputs no entry point produces; see testing-migration/p9.md. */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperatorRelayAcks, operatorRelayAcksFile, relayIdsOfMessage } from "../src/operator-outbox.ts";

test("the ack fold skips a torn line; emit_failed clears an emit; a later emit wins", () => {
	const state = mkdtempSync(join(tmpdir(), "operator-outbox-"));
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(state));
	acks.append([
		{ type: "consumer", owner: "o1", pid: 1, at: "2030-01-01T00:00:00Z", protocol: 1 },
		{ type: "emit", id: "a", owner: "o1", session: "s1", at: "2030-01-01T00:00:01Z" },
		{ type: "emit", id: "b", owner: "o1", at: "2030-01-01T00:00:01Z" },
		{ type: "emit_failed", id: "b", owner: "o1", at: "2030-01-01T00:00:02Z" },
		{ type: "ack", id: "c", at: "2030-01-01T00:00:03Z" },
		{ type: "discard", id: "d", reason: "superseded: answered", at: "2030-01-01T00:00:04Z" },
	]);
	appendFileSync(acks.file, '{"type":"ack","id":"tor');
	const fold = acks.fold();
	assert.deepEqual(fold.emits.get("a"), { owner: "o1", session: "s1", at: "2030-01-01T00:00:01Z" });
	assert.equal(fold.emits.has("b"), false);
	assert.ok(fold.failed.has("b"));
	assert.equal(fold.acked.get("c"), "2030-01-01T00:00:03Z");
	assert.equal(fold.discarded.get("d")?.reason, "superseded: answered");
	assert.equal(fold.acked.has("tor"), false);
	assert.equal(fold.consumer?.owner, "o1");
	assert.equal(new OperatorRelayAcks(join(state, "missing.jsonl")).fold().acked.size, 0, "a missing journal folds empty");
});

test("relayIdsOfMessage drops malformed ids and foreign messages", () => {
	assert.deepEqual(relayIdsOfMessage({ customType: "cp-bridge", details: { relay_ids: ["a", 3, "", "b"] } }), ["a", "b"]);
	assert.deepEqual(relayIdsOfMessage({ customType: "other", details: { relay_ids: ["a"] } }), []);
	assert.deepEqual(relayIdsOfMessage(undefined), []);
});
