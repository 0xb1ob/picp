import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import bridgeExtension from "../extensions/cp-bridge/index.ts";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { type Escalation, type GateVerdict, isoTimestamp, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import {
	dueEscalations,
	ESCALATION_RELAY_LEDGER_KEEP,
	EscalationRelayLedger,
	escalationRelayLedgerFile,
	noteBridgeRelay,
	runEscalationBackstop,
} from "../src/escalation-backstop.ts";
import { EscalationStore, raiseForGate } from "../src/escalation.ts";
import type { OperatorAsk } from "../src/operator-asks.ts";
import { createScratchHome } from "./harness/index.ts";

const NOW = new Date("2026-10-02T16:00:00Z");
const ago = (seconds: number) => isoTimestamp(new Date(NOW.getTime() - seconds * 1000));
const escalation = (fields: Partial<Escalation>): Escalation => ({
	schema_version: SCHEMA_VERSION, id: "es-aaaa11", job_ids: ["cp-job"], kind: "conflicting_acceptance", question: "ship?",
	options: [{ id: "hold", label: "Hold", consequence: "waits", cost: "time" }], recommended: "hold",
	mandate_id: "no mandate", mandate_clause: "no mandate", evidence_paths: [], created_at: ago(601), status: "open", ...fields,
});
const ask = (fields: Partial<OperatorAsk>): OperatorAsk => ({
	id: "ask-01", created_at: ago(30), state: "open", project: "demo", question: "q?", options: [{ label: "a", consequence: "b" }], recommendation: "a", ...fields,
});
const due = (open: Escalation[], asks: OperatorAsk[] = [], relayed: string[] = []) =>
	dueEscalations({ open, asks, relayed: new Set(relayed), now: NOW }).map((item) => item.id);

test("T5a: due means open, at least 600 s old, no open ask for it, never relayed", () => {
	assert.deepEqual(due([escalation({})]), ["es-aaaa11"], "601 s, no ask: due");
	assert.deepEqual(due([escalation({ created_at: ago(599) })]), [], "599 s: not yet");
	assert.deepEqual(due([escalation({})], [ask({ source_escalation: "es-aaaa11" })]), [], "an open ask represents it");
	assert.deepEqual(due([escalation({})], [ask({ source_escalation: "es-aaaa11", state: "answered" })]), ["es-aaaa11"], "only an answered ask: due");
	assert.deepEqual(due([escalation({})], [], ["es-aaaa11"]), [], "already relayed");
	for (const status of ["answered", "withdrawn", "superseded"] as const) {
		assert.deepEqual(due([escalation({ status })]), [], `${status}: not due`);
	}
	assert.deepEqual(due([escalation({ id: "es-new", created_at: ago(700) }), escalation({ id: "es-old", created_at: ago(900) })]), ["es-old", "es-new"], "oldest first");
});

test("T5b: the ledger records once, persists, refuses bad JSON, keeps the newest 512, notes bridge escalations only", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = escalationRelayLedgerFile(home.path, "multi");
	const ledger = new EscalationRelayLedger(file);
	assert.equal(ledger.note("es-aaaa11", "backstop"), true);
	assert.equal(ledger.note("es-aaaa11", "backstop"), false);
	assert.ok(new EscalationRelayLedger(file).ids().has("es-aaaa11"), "a new instance reads the same file");

	const many = new EscalationRelayLedger(join(home.path, "many.json"));
	for (let i = 0; i <= ESCALATION_RELAY_LEDGER_KEEP; i++) many.note(`es-n${i}`, "backstop", isoTimestamp(new Date(NOW.getTime() + i * 1000)));
	const ids = many.ids();
	assert.equal(ids.size, ESCALATION_RELAY_LEDGER_KEEP);
	assert.equal(ids.has("es-n0"), false, "the oldest is dropped");
	assert.ok(ids.has(`es-n${ESCALATION_RELAY_LEDGER_KEEP}`));

	const relay = (fields: Partial<BridgeRelay>): BridgeRelay => ({ kind: "wake", stale: false, text: "", receipt: { level: null, reached: [] }, paths: [], ...fields });
	const other = createScratchHome();
	t.after(() => other.cleanup());
	noteBridgeRelay(other.path, "multi", relay({ jobId: "cp-job" }));
	assert.equal(existsSync(escalationRelayLedgerFile(other.path, "multi")), false, "a wake relay writes nothing");
	noteBridgeRelay(other.path, "multi", relay({ kind: "escalation", escalationId: "es-bbbb22" }));
	const written = JSON.parse(readFileSync(escalationRelayLedgerFile(other.path, "multi"), "utf8")) as { items: Array<{ id: string; via: string }> };
	assert.deepEqual(written.items.map(({ id, via }) => ({ id, via })), [{ id: "es-bbbb22", via: "bridge" }]);

	writeFileSync(file, "{not json");
	assert.throws(() => new EscalationRelayLedger(file).ids(), (error: Error) => error.message.includes(file) && /refusing to guess/.test(error.message));
});

test("T5f: open ids are pinned past 512 later relays; only settled history is capped, and the backstop never re-relays a pinned id", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ledger = new EscalationRelayLedger(join(home.path, "pinned.json"));
	const open = new Set(["es-open01"]);
	ledger.note("es-open01", "bridge", isoTimestamp(NOW), open);
	for (let i = 1; i <= ESCALATION_RELAY_LEDGER_KEEP; i++) ledger.note(`es-n${i}`, "backstop", isoTimestamp(new Date(NOW.getTime() + i * 1000)), open);
	assert.ok(ledger.ids().has("es-open01"), "an open id survives 512 later relays");
	assert.equal(ledger.ids().size, ESCALATION_RELAY_LEDGER_KEEP + 1);
	ledger.note("es-late", "backstop", isoTimestamp(new Date(NOW.getTime() + 600_000)), new Set());
	assert.equal(ledger.ids().has("es-open01"), false, "settled, it is pruned under the cap");
	assert.equal(ledger.ids().size, ESCALATION_RELAY_LEDGER_KEEP);

	const raised = await gateEscalation(home.path);
	const file = escalationRelayLedgerFile(home.path, "multi");
	const real = new EscalationRelayLedger(file);
	const pin = new Set([raised.id]);
	real.note(raised.id, "bridge", isoTimestamp(NOW), pin);
	for (let i = 1; i <= ESCALATION_RELAY_LEDGER_KEEP; i++) real.note(`es-m${i}`, "backstop", isoTimestamp(new Date(NOW.getTime() + i * 1000)), pin);
	const sent: BridgeRelay[] = [];
	assert.deepEqual(runEscalationBackstop({
		home: home.path, open: () => new EscalationStore({ home: home.path }).open(), asks: () => [], ledger: real, relay: (relay) => sent.push(relay), now: () => NOW,
	}), []);
	assert.equal(sent.length, 0);
});

const gateVerdict: GateVerdict = {
	schema_version: SCHEMA_VERSION, job_id: "cp-gjva", attempt: 1, verdict: "escalate", cause: "policy",
	flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
	reasons: ["conflicting acceptance"], revisions: [], model: "mock/one", decided_at: ago(660),
};

async function gateEscalation(home: string): Promise<Escalation> {
	const raised = await raiseForGate(new EscalationStore({ home, now: () => new Date(NOW.getTime() - 11 * 60_000) }), gateVerdict);
	assert.ok(raised);
	return raised;
}

test("T5c: a gate-raised escalation (the es-8d0465 shape) is relayed once, across runs and ledger instances", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const raised = await gateEscalation(home.path);
	assert.equal(raised.kind, "conflicting_acceptance");
	assert.equal(raised.mandate_id, "no mandate");
	const file = escalationRelayLedgerFile(home.path, "multi");
	const sent: BridgeRelay[] = [];
	const run = (ledger = new EscalationRelayLedger(file)) => runEscalationBackstop({
		home: home.path, open: () => new EscalationStore({ home: home.path }).open(), asks: () => [], ledger, relay: (relay) => sent.push(relay), now: () => NOW,
	});
	assert.deepEqual(run(), [raised.id]);
	assert.equal(sent.length, 1);
	const [relay] = sent;
	assert.equal(relay?.kind, "escalation");
	assert.equal(relay?.escalationId, raised.id);
	assert.match(relay?.text ?? "", /^\[/);
	assert.match(relay?.text ?? "", /never relayed to this session/);
	assert.ok(relay?.paths.includes(paths.gateFile("cp-gjva", 1)), "the evidence path is named");
	assert.deepEqual(run(), [], "a second run relays nothing");
	assert.deepEqual(run(new EscalationRelayLedger(file)), [], "nor does a fresh ledger instance");
	assert.equal(sent.length, 1);
});

test("T5d: an unreadable ledger relays nothing and writes nothing", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	await gateEscalation(home.path);
	const file = escalationRelayLedgerFile(home.path, "multi");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "[]");
	const sent: BridgeRelay[] = [];
	assert.throws(() => runEscalationBackstop({
		home: home.path, open: () => new EscalationStore({ home: home.path }).open(), asks: () => [], ledger: new EscalationRelayLedger(file), relay: (relay) => sent.push(relay), now: () => NOW,
	}), /refusing to guess/);
	assert.equal(sent.length, 0);
	assert.equal(readFileSync(file, "utf8"), "[]", "no partial write");
});

test("T5e: the operator session relays an overdue escalation once at session_start, and a second session does not repeat it", async (t) => {
	const home = createScratchHome();
	const env = { PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const shutdowns: Array<() => Promise<void>> = [];
	t.after(async () => {
		for (const shutdown of shutdowns) await shutdown();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		home.cleanup();
	});
	const raised = await new EscalationStore({ home: home.path, now: () => new Date(Date.now() - 11 * 60_000) }).raise({
		job_ids: ["cp-job"], kind: "product_ambiguity", question: "ship?", options: [{ id: "hold", label: "Hold", consequence: "waits", cost: "time" }], recommended: "hold",
	});
	const session = { hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => join(home.path, "operator.jsonl"), getEntries: () => [{ type: "message" }] } };
	const instance = () => {
		const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
		const sent: Array<{ customType: string; content: string }> = [];
		const emit = async (event: string, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
		bridgeExtension({
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			sendMessage: (message: { customType: string; content: string }) => void sent.push(message),
			sendUserMessage: () => {},
		} as never);
		let down = false;
		const shutdown = async () => { if (!down) { down = true; await emit("session_shutdown"); } };
		shutdowns.push(shutdown);
		return { sent, start: () => emit("session_start", session), shutdown };
	};
	const bridged = (sent: Array<{ customType: string; content: string }>) => sent.filter((message) => message.customType === "cp-bridge");

	const a = instance();
	await a.start();
	const relayed = bridged(a.sent);
	assert.equal(relayed.length, 1, "exactly one backstop relay");
	assert.match(relayed[0]!.content, /\[cp-bridge escalation .*id=es-/);
	assert.ok(relayed[0]!.content.includes(`id=${raised.id}`));
	await a.shutdown();

	const b = instance();
	await b.start();
	assert.equal(bridged(b.sent).length, 0, "a new session on the same home does not repeat it");
	await b.shutdown();
});
