/** cp-6fyl A2–A4 (I3–I6): the operator relay consumer against real outbox and ack files. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, type FleetRecord, isoTimestamp } from "../src/contracts.ts";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { type DrainRecord, drainFile, formatDrain } from "../src/drain.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { atomicWriteJson } from "../src/json-store.ts";
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

test("(g2) cp-ukqv: a drain wake is rechecked against the live state/drain.json; a stale one arrives as one line with no stop or hold to act on", () => {
	const dir = mkdtempSync(join(tmpdir(), "operator-delivery-drain-"));
	const sends = parentSendFile(join(dir, "cp-parent.jsonl"));
	const A = "2030-01-01T00:00:00.000Z";
	const record = (started_at: string, state: DrainRecord["state"]): DrainRecord => ({ state, started_at, deadline: A, timeout_s: 5, survivors: ["cp-busy"], reported: true, jobs: [] });
	const text = formatDrain(record(A, "timeout"), dir);
	assert.match(text, /a restart now kills them/, "fixture: the live notice carries the restart wording");
	const wake = relay({ text, drainId: `drain:${A}:timeout` });
	const check = (label: string, expectStale: boolean) => {
		const verdict = recheckRelay(dir, sends, wake);
		assert.ok("deliver" in verdict, label);
		if (!expectStale) return assert.deepEqual(verdict.deliver, wake, label);
		assert.equal(verdict.deliver.stale, true, label);
		assert.equal(verdict.deliver.text.split("\n").length, 1, `${label}: one line`);
		assert.match(verdict.deliver.text, new RegExp(`^DRAIN: stale notice drain:${A}:timeout: .*nothing to act on\\.$`), label);
		assert.doesNotMatch(verdict.deliver.text, /\b(stop|hold|defer|kill|restart|refused)/i, `${label}: no instruction`);
	};

	atomicWriteJson(drainFile(dir), record(A, "timeout"));
	check("the live drain's own outcome", false);
	atomicWriteJson(drainFile(dir), record("2030-01-01T01:00:00.000Z", "timeout"));
	check("another drain's started_at", true);
	atomicWriteJson(drainFile(dir), record(A, "drained"));
	check("its state moved on", true);
	rmSync(drainFile(dir));
	check("no live drain.json (cancelled or restarted)", true);
	const cancelled = relay({ text: "DRAIN: cancelled", drainId: `drain:${A}:cancelled` });
	assert.deepEqual(recheckRelay(dir, sends, cancelled), { deliver: cancelled }, "a cancel is never stale");

	// Round trip through the real outbox: the drain id survives, and the operator gets the one line.
	const h = home();
	h.outbox.enqueue(wake, "h");
	const c = consumer(h, { recheck: (item) => recheckRelay(dir, sends, item) });
	c.instance.poke();
	assert.equal(c.sent.length, 1);
	assert.match(c.sent[0]?.content ?? "", /DRAIN: stale notice/);
	assert.doesNotMatch(c.sent[0]?.content ?? "", /a restart now kills them/);
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

// cp-nbxo: a wake held past the operator's turn that reports a decision and jobs already moved on.
const T = "2030-01-01T00:00:00Z"; // home()'s clock, so the outbox stamps this queued_at
const at = (seconds: number) => isoTimestamp(new Date(Date.parse(T) + seconds * 1_000));
const OPTIONS = [{ id: "approve", label: "approve", consequence: "proceed", cost: "none" }, { id: "decline", label: "decline", consequence: "hold", cost: "wait" }];

function fleetRecord(overrides: Partial<FleetRecord>): FleetRecord {
	return {
		job_id: "cp-x", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "waiting",
		worker: { pid: 4242, session_id: "abc", session_file: "/sessions/abc.jsonl", profile: "implementer", role: "implementer", model: "anthropic/claude-sonnet-5", started_at: at(-600) },
		worktree: "/wt/cp-x", branch: "cp-x", dispatched_at: at(-600), usage: EMPTY_USAGE,
		...overrides,
	};
}

type Esc = { job_ids: string[]; answeredAt?: string; withdraw?: boolean };

/** The incident by default: es answered 16 s after T, cp-oc0m torn down before T, cp-qwn9 dispatched 83 s after T. */
async function handledHome(
	escalations: Esc[] = [{ job_ids: ["cp-oc0m", "cp-qwn9"], answeredAt: at(16) }],
	jobs: Partial<FleetRecord>[] = [{ job_id: "cp-oc0m", phase: "done" }, { job_id: "cp-qwn9", dispatched_at: at(83) }],
) {
	const dir = mkdtempSync(join(tmpdir(), "operator-delivery-handled-"));
	const store = new EscalationStore({ home: dir });
	const ids: string[] = [];
	for (const [index, esc] of escalations.entries()) {
		const raised = await store.raise({ job_ids: esc.job_ids, kind: "product_ambiguity", question: `approve build ${index}?`, options: OPTIONS, recommended: "approve", at: at(-24) });
		if (esc.answeredAt) await store.answer(raised.id, { answer: "approve", by: "operator", at: esc.answeredAt });
		if (esc.withdraw) await store.withdraw(raised.id);
		ids.push(raised.id);
	}
	const fleet = new FleetStore({ home: dir });
	for (const job of jobs) await fleet.add(fleetRecord(job));
	return { dir, ids, sends: parentSendFile(join(dir, "cp-parent.jsonl")), fleetFile: fleet.file, escalationsFile: store.file };
}

const incidentWake = (id: string, patch: Partial<BridgeRelay> = {}) =>
	relay({ jobId: "cp-oc0m", jobIds: ["cp-oc0m"], text: `[picp] **\`${id}\`** requests approval to build. Build \`cp-qwn9\` remains deferred pending your decision.`, ...patch });

test("(k) cp-nbxo incident replay: a wake whose escalation was answered and whose jobs moved on after it was queued is retired, never delivered", async () => {
	const { dir, ids: [id = ""], sends } = await handledHome();
	const wake = incidentWake(id);
	const reason = `already handled: ${id} answered ${at(16)}; cp-oc0m done; cp-qwn9 dispatched ${at(83)}`;
	assert.deepEqual(recheckRelay(dir, sends, wake, T), { discard: reason });
	assert.deepEqual(recheckRelay(dir, sends, wake), { deliver: wake }, "no queued_at: delivered as before");

	const h = home();
	const wakeId = h.outbox.enqueue(wake, "h");
	const c = consumer(h, { recheck: (item, queuedAt) => recheckRelay(dir, sends, item, queuedAt) });
	c.instance.poke();
	assert.equal(c.sent.length, 0, "queued_at flows from the outbox into the recheck");
	assert.equal(h.acks.fold().discarded.get(wakeId)?.reason, reason);
	assert.ok(c.status.some((line) => line.includes("1 retired") && line.includes(`${wakeId} (already handled:`)));
	h.outbox.enqueue(relay({ text: "next wake" }), "h");
	c.instance.poke();
	assert.match(c.sent[0]?.content ?? "", /retired: wake:.* \(already handled:/);
});

test("(k2) cp-nbxo fail-open: no es- id, an undecided, early, withdrawn, unknown or mixed escalation, an unmoved job or an unreadable store delivers the wake in full", async () => {
	const expectDeliver = (label: string, dir: string, sends: string, wake: BridgeRelay, queuedAt = T) =>
		assert.deepEqual(recheckRelay(dir, sends, wake, queuedAt), { deliver: wake }, label);
	const incident = await handledHome();
	const id = incident.ids[0] ?? "";
	expectDeliver("no es- id in the text", incident.dir, incident.sends, incidentWake(id, { text: "cp-oc0m torn down; cp-qwn9 deferred" }));
	expectDeliver("unknown escalation id", incident.dir, incident.sends, incidentWake("es-zzzz9999"));
	expectDeliver("queued_at unparseable", incident.dir, incident.sends, incidentWake(id), "nope");
	expectDeliver("stamped job missing from the fleet", incident.dir, incident.sends, incidentWake(id, { jobId: "cp-gone", jobIds: ["cp-gone"] }));

	for (const [label, esc] of [
		["escalation open", { job_ids: ["cp-oc0m", "cp-qwn9"] }],
		["answered in the same second as queued_at", { job_ids: ["cp-oc0m", "cp-qwn9"], answeredAt: T }],
		["answered before queued_at", { job_ids: ["cp-oc0m", "cp-qwn9"], answeredAt: at(-5) }],
		["withdrawn", { job_ids: ["cp-oc0m", "cp-qwn9"], withdraw: true }],
	] satisfies [string, Esc][]) {
		const fixture = await handledHome([esc]);
		expectDeliver(label, fixture.dir, fixture.sends, incidentWake(fixture.ids[0] ?? ""));
	}

	const mixed = await handledHome([{ job_ids: ["cp-oc0m", "cp-qwn9"], answeredAt: at(16) }, { job_ids: ["cp-qwn9"] }]);
	expectDeliver("two ids, one still open", mixed.dir, mixed.sends, incidentWake(mixed.ids[0] ?? "", { text: `${mixed.ids[0]} answered; ${mixed.ids[1]} still waits` }));

	const failed = await handledHome(undefined, [{ job_id: "cp-oc0m", phase: "failed", failure: { class: "crash", message: "exit 1", at: at(-3) } }, { job_id: "cp-qwn9", dispatched_at: at(83) }]);
	expectDeliver("job failed", failed.dir, failed.sends, incidentWake(failed.ids[0] ?? ""));
	const held = await handledHome(undefined, [{ job_id: "cp-oc0m", phase: "done" }, { job_id: "cp-qwn9", phase: "held", dispatched_at: at(-60), reported_at: at(-3) }]);
	expectDeliver("job held, reported before queued_at", held.dir, held.sends, incidentWake(held.ids[0] ?? ""));

	const badFleet = await handledHome();
	writeFileSync(badFleet.fleetFile, "{");
	expectDeliver("fleet.json invalid JSON", badFleet.dir, badFleet.sends, incidentWake(badFleet.ids[0] ?? ""));
	const badEsc = await handledHome();
	writeFileSync(badEsc.escalationsFile, "{");
	expectDeliver("escalations.json invalid JSON", badEsc.dir, badEsc.sends, incidentWake(badEsc.ids[0] ?? ""));
});

test("(k3) cp-nbxo: a fleet job named only in the prose blocks the drop until it moved on", async () => {
	const { dir, ids: [id = ""], sends } = await handledHome(undefined, [{ job_id: "cp-oc0m", phase: "done" }, { job_id: "cp-qwn9", dispatched_at: at(83) }, { job_id: "cp-zzzz", dispatched_at: at(-60) }]);
	assert.ok("discard" in recheckRelay(dir, sends, incidentWake(id), T), "fixture: without the mention it is retired");
	const wake = incidentWake(id, { text: `${id} answered; cp-zzzz is still running` });
	assert.deepEqual(recheckRelay(dir, sends, wake, T), { deliver: wake });
});

test("(k4) cp-nbxo: error, escalation and drain relays keep their own rechecks", async () => {
	const { dir, ids: [id = ""], sends } = await handledHome();
	const error = incidentWake(id, { kind: "error" });
	assert.deepEqual(recheckRelay(dir, sends, error, T), { deliver: error });
	assert.deepEqual(recheckRelay(dir, sends, incidentWake(id, { kind: "escalation", escalationId: id }), T), { discard: "superseded: answered" });
	const drain = incidentWake(id, { drainId: `drain:${T}:cancelled` });
	assert.deepEqual(recheckRelay(dir, sends, drain, T), { deliver: drain }, "a drain wake takes the cp-ukqv path only");
});
