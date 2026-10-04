import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type Escalation, type GateVerdict, isoTimestamp, SCHEMA_VERSION } from "../src/contracts.ts";
import { EscalationRelayLedger, escalationRelayLedgerFile, runEscalationBackstop } from "../src/escalation-backstop.ts";
import { directRelay, dueDirect, runEscalationRelayWatch } from "../src/escalation-relay-watch.ts";
import { EscalationStore, raiseForGate } from "../src/escalation.ts";
import type { OperatorAsk } from "../src/operator-asks.ts";
import { OperatorRelayOutbox, operatorRelayOutboxFile } from "../src/operator-outbox.ts";
import { createScratchHome } from "./harness/index.ts";

const NOW = new Date("2026-10-02T16:00:00Z");
const ago = (seconds: number) => isoTimestamp(new Date(NOW.getTime() - seconds * 1000));
const escalation = (fields: Partial<Escalation>): Escalation => ({
	schema_version: SCHEMA_VERSION, id: "es-aaaa11", job_ids: ["cp-job"], kind: "risk_high_irreversible", question: "ship?",
	options: [{ id: "hold", label: "Hold", consequence: "waits", cost: "time" }], recommended: "hold",
	mandate_id: "no mandate", mandate_clause: "no mandate", evidence_paths: [], created_at: ago(11), status: "open", ...fields,
});
const ask = (fields: Partial<OperatorAsk>): OperatorAsk => ({
	id: "ask-01", created_at: ago(5), state: "open", project: "demo", question: "q?", options: [{ label: "a", consequence: "b" }], recommendation: "a", ...fields,
});
const due = (open: Escalation[], extra: Partial<Parameters<typeof dueDirect>[0]> = {}) =>
	dueDirect({ open, asks: [], ledger: new Set(), outboxIds: [], now: NOW, ...extra }).map((item) => item.id);

test("dueDirect: open past the 10 s grace; each existing relay path suppresses it", () => {
	assert.deepEqual(due([escalation({})]), ["es-aaaa11"]);
	assert.deepEqual(due([escalation({ created_at: ago(9) })]), [], "inside the grace the parent's own relay wins");
	assert.deepEqual(due([escalation({ status: "answered" })]), []);
	assert.deepEqual(due([escalation({})], { asks: [ask({ source_escalation: "es-aaaa11" })] }), [], "an open ask represents it");
	assert.deepEqual(due([escalation({})], { ledger: new Set(["es-aaaa11"]) }), [], "already relayed to a session");
	for (const id of ["esc:es-aaaa11", "esc:es-aaaa11#2"]) assert.deepEqual(due([escalation({})], { outboxIds: [id] }), [], `${id} in the outbox`);
	assert.deepEqual(due([escalation({})], { outboxIds: ["esc:es-aaaa110", "send:ps-1"] }), ["es-aaaa11"], "another id is not this one");
	assert.deepEqual(due([escalation({ kind: "service_health", created_at: ago(1) })]), ["es-aaaa11"], "service_health is immediate");
});

const gateVerdict: GateVerdict = {
	schema_version: SCHEMA_VERSION, job_id: "cp-gjva", attempt: 1, verdict: "escalate", cause: "policy",
	flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
	reasons: ["conflicting acceptance"], revisions: [], model: "mock/one", decided_at: ago(30), 
};

test("host watch: a code-raised escalation lands once as esc:<id> in the outbox; restart, ticks and acks add nothing; backstop still fires if undelivered", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const raised = await raiseForGate(new EscalationStore({ home: home.path, now: () => new Date(NOW.getTime() - 11_000) }), gateVerdict);
	assert.ok(raised);
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(join(home.path, ".pi-command-post", "state")));
	const published: string[] = [];
	const tick = (sent = new Set<string>(), at = NOW) => runEscalationRelayWatch({
		home: home.path, sent, now: () => at,
		open: () => new EscalationStore({ home: home.path }).open(),
		asks: () => [],
		ledgerIds: () => new EscalationRelayLedger(escalationRelayLedgerFile(home.path, "multi")).ids(),
		outboxIds: () => outbox.read().entries.map((entry) => entry.id),
		publish: (relay) => { published.push(outbox.enqueue(relay, "test")); },
	});

	assert.deepEqual(tick(new Set(), new Date(NOW.getTime() - 5_000)), [], "5 s old: inside the grace");
	const sent = new Set<string>();
	assert.deepEqual(tick(sent), [raised.id]);
	assert.deepEqual(published, [`esc:${raised.id}`]);
	const [entry] = outbox.read().entries;
	assert.equal(entry?.relay.kind, "escalation");
	assert.match(entry?.relay.text ?? "", new RegExp(`^\\[.*${raised.id} \\(conflicting_acceptance\\) — `));
	assert.deepEqual(tick(sent), [], "second tick: nothing");
	assert.deepEqual(tick(), [], "a restarted host (fresh memory) finds it in the outbox");
	assert.equal(outbox.read().entries.length, 1);

	// Never delivered to a session: the 600 s backstop is untouched and still relays it.
	const backstop: string[] = [];
	const later = new Date(NOW.getTime() + 600_000);
	assert.deepEqual(runEscalationBackstop({
		home: home.path, open: () => new EscalationStore({ home: home.path }).open(), asks: () => [],
		ledger: new EscalationRelayLedger(escalationRelayLedgerFile(home.path, "multi")), relay: (relay) => backstop.push(relay.text), now: () => later,
	}), [raised.id]);
	assert.equal(published.length, 1);
});

test("a failing outbox write is reported by the caller and is not re-framed by this process each tick", () => {
	const sent = new Set<string>();
	let calls = 0;
	const run = () => runEscalationRelayWatch({
		home: "/nonexistent", sent, now: () => NOW, open: () => [escalation({})], asks: () => [], ledgerIds: () => new Set(), outboxIds: () => [],
		publish: () => { calls += 1; },
	});
	assert.deepEqual(run(), ["es-aaaa11"]);
	assert.deepEqual(run(), []);
	assert.equal(calls, 1);
});

test("a store, ledger or outbox read failure propagates (the host logs it; never a silent skip)", () => {
	assert.throws(() => runEscalationRelayWatch({
		home: "/nonexistent", sent: new Set(), open: () => [escalation({})], asks: () => [], ledgerIds: () => new Set(),
		outboxIds: () => { throw new Error("outbox corrupt"); }, publish: () => {},
	}), /outbox corrupt/);
});

test("directRelay: project-tagged, escalation kind, id and question in the text", () => {
	const home = createScratchHome();
	try {
		const relay = directRelay(home.path, escalation({ question: "ship it?" }));
		assert.equal(relay.kind, "escalation");
		assert.equal(relay.escalationId, "es-aaaa11");
		assert.equal(relay.jobId, "cp-job");
		assert.match(relay.text, /^\[.*\] es-aaaa11 \(risk_high_irreversible\) — ship it\?$/);
	} finally { home.cleanup(); }
});
