import assert from "node:assert/strict";
import { test } from "node:test";
import { type Escalation, isoTimestamp, SCHEMA_VERSION } from "../src/contracts.ts";
import { dueDirect } from "../src/escalation-relay-watch.ts";
import type { OperatorAsk } from "../src/operator-asks.ts";

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
