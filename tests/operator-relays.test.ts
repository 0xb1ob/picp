import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { join } from "node:path";
import { initJobsDocument, Ledger } from "../src/ledger.ts";
import { OperatorRelayQueue } from "../src/operator-relays.ts";
import { deliverableRelay } from "../src/relay-scope.ts";
import { createScratchHome } from "./harness/index.ts";

const relay = (fields: Partial<BridgeRelay>): BridgeRelay => ({ kind: "wake", stale: false, text: "", receipt: { level: null, reached: [] }, paths: [], ...fields });

test("mz0: relays during the operator's turn wait for settle, then drop answered and already-replied escalations", () => {
	const delivered: string[] = [];
	const answered = new Set<string>();
	const queue = new OperatorRelayQueue((r) => delivered.push(r.escalationId ?? r.text), (r) => r.escalationId && answered.has(r.escalationId) ? undefined : r);
	queue.push(relay({ text: "idle wake" }));
	assert.deepEqual(delivered, ["idle wake"], "an idle operator gets relays at once");

	queue.started();
	queue.push(relay({ kind: "escalation", escalationId: "es-5d4550" }));
	queue.push(relay({ kind: "escalation", escalationId: "es-aaaa11" }));
	queue.push(relay({ kind: "escalation", escalationId: "es-bbbb22" }));
	queue.push(relay({ text: "busy wake" }));
	queue.replied("reply:\nraised es-5d4550 for your answer");
	answered.add("es-aaaa11");
	assert.deepEqual(delivered, ["idle wake"], "nothing reaches a running operator");
	queue.settled();
	assert.deepEqual(delivered, ["idle wake", "es-bbbb22", "busy wake"]);

	queue.started();
	queue.push(relay({ kind: "escalation", escalationId: "es-cccc33" }));
	queue.push(relay({ kind: "send", sendId: "ps-1", text: "reply: es-cccc33 is open" }));
	queue.settled();
	assert.deepEqual(delivered.slice(3), ["reply: es-cccc33 is open"], "a queued send reply naming the id drops its escalation");
});

test("cp-hhuf P1: a wake about scheduled jobs only is not relayed; escalations, errors and mixed turns still are", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	initJobsDocument(home.path, "cp");
	const ledger = new Ledger({ home: home.path });
	const scheduled = (await ledger.create({ title: "Weather", project: "demo", kind: "research", delivery: "answer", labels: ["schedule:sch-aaaaaa"] })).id;
	const plain = (await ledger.create({ title: "Other", project: "demo", kind: "research", delivery: "answer" })).id;
	const deliver = (fields: Partial<BridgeRelay>) => deliverableRelay(home.path, relay(fields));
	assert.equal(deliver({ jobId: scheduled, jobIds: [scheduled] }), undefined, "a scheduled wake is dropped");
	assert.ok(deliver({ kind: "escalation", jobId: scheduled, jobIds: [scheduled] }), "an escalation for the same job still relays");
	assert.ok(deliver({ kind: "error", jobId: scheduled, jobIds: [scheduled] }), "so does an error");
	assert.ok(deliver({ jobId: plain, jobIds: [scheduled, plain] }), "a mixed turn still relays");
	assert.ok(deliver({ jobId: plain, jobIds: [plain] }), "an unscheduled wake relays");
	assert.ok(deliver({ text: "no stamp" }), "a wake with no job relays");
	assert.ok(deliverableRelay(join(home.path, "missing"), relay({ jobIds: [scheduled] })), "an unreadable ledger drops nothing");
});
