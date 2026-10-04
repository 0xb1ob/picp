/** cp-6fyl A2–A4 (I3–I6): the operator relay consumer against real outbox and ack files. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { OperatorRelayConsumer, RELAY_COALESCE_MAX, type RelayMessage, type RelayVerdict, recheckRelay } from "../src/operator-delivery.ts";
import { OperatorRelayAcks, OperatorRelayOutbox, operatorRelayAcksFile, operatorRelayOutboxFile } from "../src/operator-outbox.ts";
import { parentSendFile, ParentSendOutbox } from "../src/parent-outbox.ts";

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

function consumer(h: Home, options: { owner?: string; session?: string; recheck?: (relay: BridgeRelay) => RelayVerdict; send?: (message: RelayMessage) => void } = {}) {
	const sent: RelayMessage[] = [];
	const status: string[] = [];
	const instance = new OperatorRelayConsumer({
		outbox: () => h.outbox,
		acks: () => h.acks,
		sessionFile: () => options.session ?? "s1",
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

test("(a) one relay is one message, acked only at context entry; a new owner over the same files delivers nothing", () => {
	const h = home();
	const id = h.outbox.enqueue(relay({ text: "hello" }), "h");
	const first = consumer(h);
	first.instance.poke();
	assert.equal(first.sent.length, 1);
	assert.deepEqual(first.sent[0]?.details.relay_ids, [id]);
	assert.match(first.sent[0]?.content ?? "", /hello/);
	assert.equal(h.acks.fold().acked.has(id), false, "a hand-off is an emit, never an ack");
	assert.ok(h.acks.fold().emits.has(id));
	first.enterContext();
	assert.ok(h.acks.fold().acked.has(id));
	const next = consumer(h, { owner: "o2", session: "s2" });
	next.instance.sessionStarted();
	assert.deepEqual(next.sent, [], "exactly once in context, across processes");
});

test("(b) emitted but unacked: a new owner re-emits once", () => {
	const h = home();
	const id = h.outbox.enqueue(relay({}), "h");
	consumer(h).instance.poke();
	const next = consumer(h, { owner: "o2" });
	next.instance.sessionStarted();
	next.instance.poke();
	assert.equal(next.sent.length, 1);
	assert.deepEqual(next.sent[0]?.details.relay_ids, [id]);
});

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
	c.enterContext();
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 2, "acked: never again");
});

test("(e) three relays raised during the operator's turn go out as one coalesced message on settle", () => {
	const h = home();
	const c = consumer(h);
	c.instance.started();
	const ids = ["a", "b", "c"].map((text) => h.outbox.enqueue(relay({ text }), "h"));
	for (let index = 0; index < 3; index++) c.instance.poke();
	assert.equal(c.sent.length, 0, "nothing while the turn runs");
	c.instance.settled({ idle: true, pending: false });
	assert.equal(c.sent.length, 1);
	assert.deepEqual(c.sent[0]?.details.relay_ids, ids);
});

test("coalescing is capped; the remainder goes on the next pass; a send outcome stays alone with its send_id", () => {
	const h = home();
	for (let index = 0; index < RELAY_COALESCE_MAX + 3; index++) h.outbox.enqueue(relay({ text: `w${index}` }), "h");
	const sendId = h.outbox.enqueue(relay({ kind: "send", sendId: "ps-20300101000000-abcdef01", text: "reply" }), "h");
	const c = consumer(h);
	c.instance.poke();
	assert.equal(c.sent.length, 2);
	assert.deepEqual(c.sent[0]?.details, { relay_ids: [sendId], send_id: "ps-20300101000000-abcdef01" });
	assert.equal(c.sent[1]?.details.relay_ids.length, RELAY_COALESCE_MAX);
	c.instance.poke();
	assert.equal(c.sent[2]?.details.relay_ids.length, 3);
});

test("(f) an escalation answered before delivery is a discard line with its reason and a retired: status, never a bare skip", () => {
	const h = home();
	const id = h.outbox.enqueue(relay({ kind: "escalation", escalationId: "es-abcd", text: "ship?" }), "h");
	const c = consumer(h, { recheck: (item) => (item.escalationId ? { discard: "superseded: answered" } : { deliver: item }) });
	c.instance.poke();
	assert.equal(c.sent.length, 0);
	assert.equal(h.acks.fold().discarded.get(id)?.reason, "superseded: answered");
	assert.ok(c.status.some((line) => line.includes("1 retired") && line.includes(`${id} (superseded: answered)`)));
	h.outbox.enqueue(relay({ text: "next wake" }), "h");
	c.instance.poke();
	assert.match(c.sent[0]?.content ?? "", /retired: esc:es-abcd \(superseded: answered\)/, "named once in the next delivered message");
	h.outbox.enqueue(relay({ text: "third" }), "h");
	c.instance.poke();
	assert.doesNotMatch(c.sent[1]?.content ?? "", /retired:/);
});

test("(g) a send outcome a tool result already returned is discarded 'returned in tool result'", () => {
	const dir = mkdtempSync(join(tmpdir(), "operator-delivery-sends-"));
	const sends = new ParentSendOutbox({ file: parentSendFile(join(dir, "cp-parent.jsonl")) });
	const entry = sends.enqueue("go");
	sends.markInjected([entry.id]);
	sends.markLanded([entry.id]);
	sends.settle(entry.id, { reply: "done" });
	const outcome = relay({ kind: "send", sendId: entry.id, text: "done" });
	assert.deepEqual(recheckRelay(dir, sends.file, outcome), { deliver: outcome }, "not yet observed: delivered");
	sends.markObserved(entry.id);
	assert.deepEqual(recheckRelay(dir, sends.file, outcome), { discard: "returned in tool result" });
	const h = home();
	const id = h.outbox.enqueue(outcome, "h");
	const c = consumer(h, { recheck: (item) => recheckRelay(dir, sends.file, item) });
	c.instance.poke();
	assert.equal(c.sent.length, 0);
	assert.equal(h.acks.fold().discarded.get(id)?.reason, "returned in tool result");
});

test("(h) a 2 h old wake is delivered headline-only under stale — do not act, and still acked", () => {
	const h = home();
	const id = h.outbox.enqueue(relay({ jobId: "cp-old", text: "first line\nsecond line with an instruction" }), "h");
	h.advance(2 * 3_600_000);
	const fresh = h.outbox.enqueue(relay({ text: "fresh wake" }), "h");
	const c = consumer(h);
	c.instance.poke();
	assert.equal(c.sent.length, 1);
	const content = c.sent[0]?.content ?? "";
	assert.match(content, /fresh wake/);
	assert.match(content, /stale — do not act \(older than 60 min; headlines only\):\n- \[wake job=cp-old\] first line/);
	assert.doesNotMatch(content, /second line/);
	assert.deepEqual(c.sent[0]?.details.relay_ids, [fresh, id]);
	c.enterContext();
	assert.ok(h.acks.fold().acked.has(id));
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

test("(j) an escalation named in a send reply is a discard line; an overdue backstop relay is still delivered", () => {
	const h = home();
	const named = h.outbox.enqueue(relay({ kind: "escalation", escalationId: "es-named1", text: "q1" }), "h");
	const c = consumer(h);
	c.instance.replied("I raised es-named1 for you");
	c.instance.poke();
	assert.equal(c.sent.length, 0);
	assert.equal(h.acks.fold().discarded.get(named)?.reason, "named in send reply");
	c.instance.replied("also es-overdue1");
	c.instance.direct(relay({ kind: "escalation", escalationId: "es-overdue1", text: "q2" }), "esc:es-overdue1", true);
	assert.deepEqual(c.sent.map((message) => message.details.relay_ids), [["esc:es-overdue1"]]);
	c.instance.direct(relay({ kind: "escalation", escalationId: "es-overdue1", text: "q2" }), "esc:es-overdue1", true);
	assert.equal(c.sent.length, 1, "a direct id is delivered once");
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

test("a send reply that names an escalation queued in the same pass retires it (replied rule before classify)", () => {
	const h = home();
	const esc = h.outbox.enqueue(relay({ kind: "escalation", escalationId: "es-same01", text: "q" }), "h");
	h.outbox.enqueue(relay({ kind: "send", sendId: "ps-20300101000000-abcdef02", text: "raised es-same01" }), "h");
	const c = consumer(h);
	c.instance.poke();
	assert.equal(h.acks.fold().discarded.get(esc)?.reason, "named in send reply");
	assert.deepEqual(c.sent.map((message) => message.details.send_id), ["ps-20300101000000-abcdef02"]);
});

test("unreadable files are named on the status line, never treated as empty silence", () => {
	const h = home();
	const c = new OperatorRelayConsumer({
		outbox: () => h.outbox,
		acks: () => { throw new Error("EACCES"); },
		sessionFile: () => "s1",
		recheck: (item) => ({ deliver: item }),
		send: () => assert.fail("nothing is delivered without an ack fold"),
		status: (line) => assert.match(line, /acks unreadable \(EACCES\)/),
		owner: "o1",
	});
	c.poke();
});
