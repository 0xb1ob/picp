/**
 * cp-6fyl/picp-75g, retained: the reclaim, emit_failed and backstop-recheck paths need a hand-off of this process that
 * never reached context, which a real pi never produces. The rest is tests/e2e/operator-relay-p9f.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { OperatorRelayConsumer, type RelayMessage, type RelayVerdict } from "../src/operator-delivery.ts";
import { OperatorRelayAcks, OperatorRelayOutbox, operatorRelayAcksFile, operatorRelayOutboxFile } from "../src/operator-outbox.ts";

const receipt = { level: null, reached: [] };
const relay = (patch: Partial<BridgeRelay>): BridgeRelay => ({ kind: "wake", stale: false, text: "wake", receipt, paths: [], ...patch });

function home() {
	const state = mkdtempSync(join(tmpdir(), "operator-delivery-"));
	let now = new Date("2030-01-01T00:00:00Z");
	const clock = () => now;
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(state), clock);
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(state));
	return { state, outbox, acks, now: clock, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

type Home = ReturnType<typeof home>;

function consumer(h: Home, options: { owner?: string; session?: string; sessionFile?: () => string; busy?: () => boolean; recheck?: (relay: BridgeRelay, queuedAt: string) => RelayVerdict; send?: (message: RelayMessage) => void } = {}) {
	const sent: RelayMessage[] = [];
	const status: string[] = [];
	const instance = new OperatorRelayConsumer({
		outbox: () => h.outbox,
		acks: () => h.acks,
		sessionFile: options.sessionFile ?? (() => options.session ?? "s1"),
		...(options.busy ? { busy: options.busy } : {}),
		recheck: options.recheck ?? ((item) => ({ deliver: item })),
		send: options.send ?? ((message) => sent.push(message)),
		status: (line) => status.push(line),
		now: h.now,
		owner: options.owner ?? "o1",
	});
	/** pi's `message_start` for every message handed off so far. */
	const enterContext = () => { for (const message of sent) instance.ack({ customType: "cp-bridge", details: message.details }); };
	return { instance, sent, status, enterContext };
}

test("(b') the same owner in a new session file re-emits", () => {
	const h = home();
	h.outbox.enqueue(relay({}), "h");
	consumer(h).instance.poke();
	const resumed = consumer(h, { session: "s2" });
	resumed.instance.poke();
	assert.equal(resumed.sent.length, 1);
});

test("(c) same owner and session: three pokes are one emit, never a trickle", () => {
	const h = home();
	h.outbox.enqueue(relay({}), "h");
	const c = consumer(h);
	c.instance.poke();
	c.instance.poke();
	c.instance.deliverDue();
	assert.equal(c.sent.length, 1);
});

test("(d) an idle settle with nothing pending re-emits this session's unacked emits; pending messages hold them", () => {
	const h = home();
	h.outbox.enqueue(relay({}), "h");
	const c = consumer(h);
	c.instance.poke();
	c.instance.started();
	c.instance.settled({ idle: true, pending: true });
	assert.equal(c.sent.length, 1, "pi still holds it");
	c.instance.started();
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 2, "pi no longer holds it: due again");
	c.instance.started();
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 2, "reclaimed once: never a third hand-off before ack");
	c.enterContext();
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 2, "acked: never again");
});

test("(d2) picp-75g: reclaim-once is per consumer instance and per session", () => {
	const h = home();
	const id = h.outbox.enqueue(relay({}), "h");
	const c = consumer(h);
	c.instance.poke();
	c.instance.settled({ idle: true, pending: false });
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 2, "same owner and session: one reclaim");
	const reloaded = consumer(h); // `/reload`: same process owner, new instance
	reloaded.instance.settled({ idle: true, pending: false });
	reloaded.instance.settled({ idle: true, pending: false });
	assert.equal(reloaded.sent.length, 1, "a new instance reclaims once");
	let session = "s1";
	const switched = consumer(h, { sessionFile: () => session });
	session = "s2";
	switched.instance.sessionStarted();
	assert.deepEqual(switched.sent.map((message) => message.details.relay_ids), [[id]], "a new session file re-emits");
	switched.instance.settled({ idle: true, pending: false });
	switched.instance.settled({ idle: true, pending: false });
	assert.equal(switched.sent.length, 2, "and re-arms one reclaim");
});

test("(d3) picp-75g: a failed reclaim is not counted; an ack clears", () => {
	const h = home();
	const id = h.outbox.enqueue(relay({}), "h");
	let fail = false;
	const sent: RelayMessage[] = [];
	const c = consumer(h, { send: (message) => { if (fail) throw new Error("pi refused"); sent.push(message); } });
	c.instance.poke();
	fail = true;
	c.instance.settled({ idle: true, pending: false });
	assert.ok(h.acks.fold().failed.has(id), "the reclaim failed: emit_failed");
	fail = false;
	c.instance.poke();
	assert.equal(sent.length, 2, "due again as fresh");
	c.instance.settled({ idle: true, pending: false });
	assert.equal(sent.length, 3, "the failed reclaim was not spent");
	c.instance.settled({ idle: true, pending: false });
	assert.equal(sent.length, 3);
	c.instance.ack({ customType: "cp-bridge", details: { relay_ids: [id] } });
	c.instance.sessionStarted();
	c.instance.settled({ idle: true, pending: false });
	assert.equal(sent.length, 3, "acked: never again");
});

test("(d4) picp-75g: busy holds the whole pass and never spends the reclaim", () => {
	const h = home();
	const id = h.outbox.enqueue(relay({}), "h");
	let busy = true;
	const c = consumer(h, { busy: () => busy });
	c.instance.poke();
	assert.equal(c.sent.length, 0);
	assert.equal(h.acks.fold().emits.has(id), false, "nothing journaled while busy");
	busy = false;
	c.instance.poke();
	assert.equal(c.sent.length, 1);
	busy = true;
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 1, "no reclaim while compacting");
	busy = false;
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 2, "the reclaim was not spent");
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 2);
});

test("(i) a throwing hand-off appends emit_failed and the relay is due at the next poke", () => {
	const h = home();
	const id = h.outbox.enqueue(relay({}), "h");
	let fail = true;
	const sent: RelayMessage[] = [];
	const c = consumer(h, { send: (message) => { if (fail) throw new Error("pi refused"); sent.push(message); } });
	c.instance.poke();
	assert.ok(h.acks.fold().failed.has(id));
	assert.ok(c.status.some((line) => line.includes("delivery failed (pi refused); due again")));
	fail = false;
	c.instance.poke();
	assert.deepEqual(sent.map((message) => message.details.relay_ids), [[id]]);
});

test("cp-gb8d: an overdue backstop relay survives a send-reply mention, never the answered recheck", () => {
	const h = home();
	const answered = new Set<string>();
	const c = consumer(h, { recheck: (item) => (item.escalationId && answered.has(item.escalationId) ? { discard: "superseded: answered" } : { deliver: item }) });
	c.instance.replied("reply: es-dddd44 was mentioned in prose");
	answered.add("es-dddd44");
	c.instance.direct(relay({ kind: "escalation", escalationId: "es-dddd44", text: "q" }), "esc:es-dddd44", true);
	assert.equal(c.sent.length, 0, "the recheck still drops an answered id, overdue or not");
	assert.equal(h.acks.fold().discarded.get("esc:es-dddd44")?.reason, "superseded: answered");
});
