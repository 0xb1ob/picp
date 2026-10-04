/**
 * cp-dashboard-operator-control, the operator session's half: the control socket, delivery as a user message,
 * one-click answers, the audit journal, the parsers, and the cp-bridge wiring (plan T1/T2 + addendum 1).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { startDashboardControl, type ControlPorts, type DashboardControl } from "../src/dashboard-control.ts";
import { appendControlAudit } from "../src/viewer/control-audit.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import {
	CONTROL_TEXT_MAX, controlConfigFile, controlInboxFile, controlJournalFile, controlRecordFile, controlSocketFile, dashboardMarker, parseDashboardText, readControlConfig, readControlRecord,
} from "../src/viewer/control-files.ts";
import { operatorSession, readInbox } from "../src/viewer/control-inbox.ts";
import { readOperatorSessions } from "../src/viewer/operator-sessions.ts";
import bridgeExtension, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { createScratchHome } from "./harness/index.ts";

const MARKER = /^\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard(?:; ask=ask-[a-f0-9]+)?\]$/;

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return { home: home.path, stateDir: join(home.path, LAYOUT.state) };
}
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const journal = (stateDir: string): Array<Record<string, unknown>> => existsSync(controlJournalFile(stateDir)) ? readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

function fakePorts(overrides: Partial<ControlPorts> = {}) {
	const state = { idle: true, injected: [] as Array<[string, string | undefined]>, aborted: 0, observer: undefined as DashboardControl | undefined, echo: false };
	const ports: ControlPorts = {
		inject: (text, deliverAs) => {
			state.injected.push([text, deliverAs]);
			if (state.echo) setImmediate(() => state.observer?.observe({ role: "user", content: [{ type: "text", text }] }));
		},
		abort: () => { state.aborted += 1; },
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		sessionFile: () => "/tmp/operator-session.jsonl",
		...overrides,
	};
	return { state, ports };
}

async function listening(t: import("node:test").TestContext, stateDir: string, ports: ControlPorts, extra: Partial<Parameters<typeof startDashboardControl>[0]> = {}) {
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 50, log: () => {}, ...extra });
	assert.equal(control.state, "listening", "reason" in control ? control.reason : "");
	const live = control as DashboardControl;
	t.after(() => live.stop());
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	return { control: live, record: (record as { record: Parameters<typeof controlRequest>[0] }).record };
}

const ASKS = [
	{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: "2026-09-27T08:00:00Z", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }, { label: "Raise", consequence: "Spends more" }] },
	{ type: "open", id: "ask-bbbb", project: "demo", question: "Merge?", created_at: "2026-09-27T08:00:00Z", recommendation: "Yes", options: [{ label: "Yes", consequence: "Merges" }] },
	{ type: "answer", id: "ask-bbbb", answer: "Yes", answered_at: "2026-09-27T08:05:00Z" },
	{ type: "open", id: "ask-cccc", project: "demo", question: "Retry?", created_at: "2026-09-27T08:00:00Z", recommendation: "No", options: [{ label: "No", consequence: "Stops" }] },
	{ type: "withdraw", id: "ask-cccc", reason: "No longer needed" },
];

test("parsers: config defaults on and opts out with enabled:false; record and marker round-trip and refuse malformed input", (t) => {
	const { stateDir } = scratch(t);
	assert.equal(readControlConfig(stateDir).state, "on", "control is on without a config file");
	for (const [text, state] of [['{"enabled": false}', "off"], ['{"enabled": true}', "on"], ["{}", "on"], ['{"enabled": "no"}', "invalid"], ['{"enabled": false, "origin": "x"}', "invalid"], ["not json", "invalid"], ["[]", "invalid"]] as const) {
		put(controlConfigFile(stateDir), text);
		assert.equal(readControlConfig(stateDir).state, state, text);
	}
	assert.equal(readControlRecord(stateDir).state, "absent");
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: 1, socket: "/elsewhere.sock", token: "a".repeat(64), csrf: "b".repeat(64), started_at: "x" }));
	assert.equal(readControlRecord(stateDir).state, "invalid", "a record naming another socket is refused");
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: 1, socket: controlSocketFile(stateDir), token: "a".repeat(64), csrf: "b".repeat(64), started_at: "x" }));
	assert.equal(readControlRecord(stateDir).state, "ok");
	const id = "dc-20260927080000-0123abcd";
	assert.deepEqual(parseDashboardText(`hello\nworld\n\n${dashboardMarker(id)}`), { body: "hello\nworld", id, askId: null });
	assert.deepEqual(parseDashboardText(`ask-abcd: Keep\n\n${dashboardMarker(id, "ask-abcd")}`), { body: "ask-abcd: Keep", id, askId: "ask-abcd" });
	assert.equal(parseDashboardText(`${dashboardMarker(id)}\nmore text after`), undefined, "the marker must be the last line");
	assert.equal(parseDashboardText("x\n[cp-dashboard dc-1 — from the dashboard]"), undefined, "a malformed id is not a marker");
	assert.equal(parseDashboardText("x\n[cp-dashboard dc-20260927080000-0123abcd — from the dashboard; ask=nope]"), undefined);
});

test("lifecycle: {enabled:false} opens nothing; on (default) binds a 0600 socket and record; a bad socket token journals nothing; stop removes both", async (t) => {
	const { stateDir } = scratch(t);
	put(controlConfigFile(stateDir), '{"enabled": false}');
	const off = await startDashboardControl({ stateDir, ports: fakePorts().ports, log: () => {} });
	assert.equal(off.state, "off");
	assert.equal(existsSync(controlSocketFile(stateDir)), false);
	assert.equal(existsSync(controlRecordFile(stateDir)), false);

	put(controlConfigFile(stateDir), '{"enabled": true}');
	const { control, record } = await listening(t, stateDir, fakePorts().ports);
	assert.equal(statSync(controlSocketFile(stateDir)).mode & 0o777, 0o600);
	assert.equal(statSync(controlRecordFile(stateDir)).mode & 0o777, 0o600);
	assert.match(record.token, /^[0-9a-f]{64}$/);
	assert.match(record.csrf, /^[0-9a-f]{64}$/);
	assert.notEqual(record.token, record.csrf);
	const second = await startDashboardControl({ stateDir, ports: fakePorts().ports, log: () => {} });
	assert.equal(second.state, "refused");
	assert.match((second as { reason: string }).reason, new RegExp(`already served by pid ${process.pid}`));

	const closed = await new Promise<string>((resolve) => {
		const socket = createConnection(record.socket);
		let data = "";
		socket.on("data", (chunk) => { data += chunk; });
		socket.on("close", () => resolve(data));
		socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, token: "0".repeat(64), id: 1, op: "send", args: { kind: "message", text: "hi" } })}\n`));
	});
	assert.equal(closed, "", "a wrong socket token closes the connection without a reply");
	assert.deepEqual(journal(stateDir), [], "and appends nothing to the journal");

	control.stop();
	assert.equal(existsSync(controlSocketFile(stateDir)), false);
	assert.equal(existsSync(controlRecordFile(stateDir)), false);
});

test("delivery: a message is injected as a user message with the marker; idle is a prompt, busy defaults to followUp, steer on request; never expandPromptTemplates", async (t) => {
	const { stateDir } = scratch(t);
	const fake = fakePorts();
	const { control, record } = await listening(t, stateDir, fake.ports);
	fake.state.observer = control;

	const queued = await controlRequest(record, "send", { kind: "message", text: "  hello there  ", peer: "100.64.0.9" });
	assert.deepEqual(queued.ok && (queued.result as { state: string; deliver: string }).state, "queued", "unseen within the wait: queued, never delivered");
	const [text, deliverAs] = fake.state.injected[0]!;
	assert.equal(deliverAs, undefined, "idle: deliverAs is absent");
	const [body, marker] = text.split("\n\n");
	assert.equal(body, "hello there");
	assert.match(marker!, MARKER);

	fake.state.echo = true;
	fake.state.idle = false;
	const delivered = await controlRequest(record, "send", { kind: "message", text: "next", peer: "100.64.0.9" });
	assert.equal(delivered.ok && (delivered.result as { state: string }).state, "delivered", "seen in a message_start/context: delivered");
	assert.equal(fake.state.injected[1]![1], "followUp");
	await controlRequest(record, "send", { kind: "message", text: "now", deliver: "steer", peer: "100.64.0.9" });
	assert.equal(fake.state.injected[2]![1], "steer");

	const status = await controlRequest(record, "status", {});
	assert.ok(status.ok);
	assert.deepEqual({ ...(status.result as object), recent: undefined, restart: undefined }, { busy: true, pending: false, session_file: "operator-session.jsonl", recent: undefined, restart: undefined });
	assert.equal((status.result as { restart: { supported: boolean } }).restart.supported, false, "ports without the restart members: Restart session unsupported");
	assert.equal(journal(stateDir).filter((l) => l.type === "request").length, 3, "status writes no journal line");

	const lines = journal(stateDir);
	const first = lines[0]!;
	assert.deepEqual({ ...first, id: undefined, at: undefined }, { type: "request", by: "bridge", id: undefined, at: undefined, peer: "100.64.0.9", kind: "message", text: "hello there", ask_id: null, deliver: "prompt" });
	assert.deepEqual(lines.filter((l) => l.id === first.id).map((l) => l.type === "outcome" ? l.state : l.type), ["request", "injected", "queued"]);
	const second = lines.find((l) => l.type === "request" && l.text === "next")!;
	assert.deepEqual(lines.filter((l) => l.id === second.id).map((l) => l.type === "outcome" ? l.state : l.type), ["request", "injected", "delivered"]);

	control.observe({ role: "user", content: text });
	assert.equal(journal(stateDir).filter((l) => l.id === first.id && l.state === "delivered").length, 1, "a later sighting marks the queued one delivered, once");
	control.observe({ role: "user", content: text });
	assert.equal(journal(stateDir).filter((l) => l.id === first.id && l.state === "delivered").length, 1);
});

test("clicks: the verbatim label with the ask id; unknown label 400, settled ask 409, a second click 409; asks.jsonl never changes", async (t) => {
	const { stateDir } = scratch(t);
	const asksFile = join(stateDir, "operator", "asks.jsonl");
	put(asksFile, ASKS.map((a) => JSON.stringify(a)).join("\n") + "\n");
	const before = readFileSync(asksFile, "utf8");
	const fake = fakePorts();
	const { record } = await listening(t, stateDir, fake.ports);

	const click = await controlRequest(record, "send", { kind: "answer", ask_id: "ask-abcd", label: "Keep", peer: "100.64.0.9" });
	assert.ok(click.ok);
	const [text] = fake.state.injected[0]!;
	assert.match(text, /^ask-abcd: Keep\n\n\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard; ask=ask-abcd\]$/);
	const refusals = [
		[{ ask_id: "ask-abcd", label: "keep" }, 400, /not an option/],
		[{ ask_id: "ask-bbbb", label: "Yes" }, 409, /answered/],
		[{ ask_id: "ask-cccc", label: "No" }, 409, /withdrawn/],
		[{ ask_id: "ask-abcd", label: "Raise" }, 409, /already answered from the dashboard/],
		[{ ask_id: "ask-ffff", label: "Keep" }, 400, /unknown ask/],
	] as const;
	for (const [args, status, reason] of refusals) {
		const reply = await controlRequest(record, "send", { kind: "answer", ...args, peer: "100.64.0.9" });
		assert.equal(reply.ok, false, JSON.stringify(args));
		assert.equal(!reply.ok && reply.status, status, JSON.stringify(args));
		assert.match(!reply.ok ? reply.error : "", reason);
	}
	assert.equal(fake.state.injected.length, 1, "no refusal injects anything");
	assert.equal(readFileSync(asksFile, "utf8"), before, "the click never records the answer itself");
	const lines = journal(stateDir);
	assert.equal(lines.filter((l) => l.type === "request").length, 1 + refusals.length, "every frame: exactly one request line");
	for (const request of lines.filter((l) => l.type === "request").slice(1)) {
		assert.deepEqual(lines.filter((l) => l.id === request.id && l.type === "outcome").map((l) => l.state), ["refused"], "and one final outcome");
	}
});

test("states: a throwing inject fails with its message (and frees the click); abort is refused idle, called busy; turning control off refuses the next frame", async (t) => {
	const { stateDir } = scratch(t);
	put(join(stateDir, "operator", "asks.jsonl"), ASKS.map((a) => JSON.stringify(a)).join("\n") + "\n");
	let fail = true;
	const fake = fakePorts({ inject: () => { if (fail) throw new Error("boom"); } });
	const { record } = await listening(t, stateDir, fake.ports);
	const failed = await controlRequest(record, "send", { kind: "answer", ask_id: "ask-abcd", label: "Keep" });
	assert.deepEqual(failed, { ok: false, status: 502, error: "failed: boom" });
	fail = false;
	assert.ok((await controlRequest(record, "send", { kind: "answer", ask_id: "ask-abcd", label: "Keep" })).ok, "a failed click does not block the retry");

	const rejected = await startDashboardControl({ stateDir: scratch(t).stateDir, ports: fakePorts({ inject: () => Promise.reject(new Error("prompt refused")) }).ports, deliveredWaitMs: 500, log: () => {} }) as DashboardControl;
	t.after(() => rejected.stop());
	const other = readControlRecord(rejected.socket.replace(/\/operator\/dashboard\.sock$/, ""));
	assert.equal(other.state, "ok");
	assert.deepEqual(await controlRequest((other as { record: Parameters<typeof controlRequest>[0] }).record, "send", { kind: "message", text: "x" }), { ok: false, status: 502, error: "failed: prompt refused" });

	const idle = await controlRequest(record, "abort", {});
	assert.deepEqual(idle, { ok: false, status: 409, error: "session is idle; nothing to abort" });
	fake.state.idle = false;
	const abort = await controlRequest(record, "abort", {});
	assert.ok(abort.ok);
	assert.equal(fake.state.aborted, 1);

	put(controlConfigFile(stateDir), '{"enabled": false}');
	const off = await controlRequest(record, "send", { kind: "message", text: "hi" });
	assert.equal(!off.ok && off.status, 403);
	assert.match(!off.ok ? off.error : "", /dashboard control is off/);
});

test("audit: an unwritable request line refuses without injecting; appendControlAudit is 0600, clips text, never throws", async (t) => {
	const { stateDir } = scratch(t);
	const fake = fakePorts();
	const { record } = await listening(t, stateDir, fake.ports, { append: () => ({ ok: false, error: "EACCES" }) });
	const reply = await controlRequest(record, "send", { kind: "message", text: "hi" });
	assert.deepEqual(reply, { ok: false, status: 500, error: "failed: audit journal unwritable (EACCES)" });
	assert.equal(fake.state.injected.length, 0, "never injected");

	const other = scratch(t).stateDir;
	const long = "x".repeat(CONTROL_TEXT_MAX + 50);
	assert.deepEqual(appendControlAudit(other, { type: "refused", by: "viewer", id: null, at: "2026-09-27T08:00:00.000Z", peer: "100.64.0.9", kind: "message", text: long, ask_id: null, status: 403, reason: "r" }), { ok: true });
	assert.equal(statSync(controlJournalFile(other)).mode & 0o777, 0o600);
	assert.equal((journal(other)[0]!.text as string).length, CONTROL_TEXT_MAX);
	const blocked = scratch(t).stateDir;
	put(join(blocked, "operator"), "a file where the directory should be");
	const out = appendControlAudit(blocked, { type: "refused", by: "viewer", id: null, at: "x", peer: null, kind: null, text: null, ask_id: null, status: 403, reason: "r" });
	assert.equal(out.ok, false);
});

test("cp-bridge wiring: session_start opens the socket, a frame reaches pi.sendUserMessage as a user message, message_start marks it delivered, shutdown closes it; off opens nothing", async (t) => {
	const { home, stateDir } = scratch(t);
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = join(home, "pi-home");
	t.after(() => { if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous; });
	saveOperatorTarget({ home, mode: "multi", hostPid: 0, parentPid: 0 });
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const sent: Array<[string, unknown]> = [];
	const emit = async (event: string, payload: unknown, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); };
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		sendUserMessage: (text: string, options?: unknown) => {
			sent.push([text, options]);
			setImmediate(() => void emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } }));
		},
	} as never);
	const sessionFile = join(home, "operator-session.jsonl");
	const ctx = { hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => sessionFile } };
	await emit("session_start", {}, ctx);
	t.after(() => emit("session_shutdown", {}));
	assert.equal(existsSync(controlSocketFile(stateDir)), true, "session_start opened the socket");
	assert.deepEqual(readOperatorSessions(join(home, LAYOUT.sessions)).map((row) => row.file), [sessionFile], "the fresh session file is listed for the Full transcript");
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	const reply = await controlRequest((record as { record: Parameters<typeof controlRequest>[0] }).record, "send", { kind: "message", text: "from the phone" });
	assert.equal(reply.ok && (reply.result as { state: string }).state, "delivered");
	assert.equal(sent.length, 1);
	assert.match(sent[0]![0], /^from the phone\n\n\[cp-dashboard dc-/);
	assert.equal(sent[0]![1], undefined, "idle: a plain user message, no options (no expandPromptTemplates)");
	await emit("session_shutdown", {});
	assert.equal(existsSync(controlSocketFile(stateDir)), false, "shutdown closed it");

	put(controlConfigFile(stateDir), '{"enabled": false}');
	await emit("session_start", {}, ctx);
	assert.equal(existsSync(controlSocketFile(stateDir)), false, "off: no socket");
});

test("cp-bridge wiring: selected.json naming a missing per-home target still starts control on the CP_HOME home; the dashboard does not see the session offline", async (t) => {
	const { home, stateDir } = scratch(t);
	const saved = { PI_HOME: process.env.PI_HOME, CP_HOME: process.env.CP_HOME, CP_MODE: process.env.CP_MODE };
	process.env.PI_HOME = join(home, "pi-home");
	process.env.CP_HOME = home;
	process.env.CP_MODE = "multi";
	t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	// The selector points at a home whose per-home target file does not exist: resolveOperatorTarget() throws.
	put(join(home, "pi-home", "command-post", "operator-targets", "selected.json"), JSON.stringify({ home: join(home, "gone"), mode: "multi" }));
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const emit = async (event: string, payload: unknown, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); };
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as never);
	const ctx = { hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => join(home, "operator-session.jsonl") } };
	await emit("session_start", {}, ctx);
	t.after(() => emit("session_shutdown", {}));
	assert.equal(existsSync(controlRecordFile(stateDir)), true, "session_start wrote state/operator/dashboard.json");
	assert.deepEqual(operatorSession(stateDir).running, true, "the dashboard's offline check sees a running session");
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	const status = await controlRequest((record as { record: Parameters<typeof controlRequest>[0] }).record, "status", {});
	assert.ok(status.ok, "the control API answers status");
});

test("inbox (cp-daemon P3): at listen the held messages arrive once, oldest first, as one user message with their times; >24 h dropped and listed; a closed ask is marked; a refused injection keeps them held", async (t) => {
	const { stateDir } = scratch(t);
	put(join(stateDir, "operator", "asks.jsonl"), ASKS.map((e) => JSON.stringify(e)).join("\n") + "\n");
	const held = (id: string, at: string, text: string, ask_id: string | null = null) => ({ type: "held", id, at, text, ask_id });
	const now = new Date("2026-09-28T12:00:00Z");
	put(controlInboxFile(stateDir), [
		held("dc-20260928110000-00000002", "2026-09-28T11:00:00.000Z", "second"),
		held("dc-20260926100000-00000009", "2026-09-26T10:00:00.000Z", "too old"),
		held("dc-20260928100000-00000001", "2026-09-28T10:00:00.000Z", "ask-bbbb: Yes", "ask-bbbb"),
		{ type: "held", id: "dc-20260928090000-00000000", at: "2026-09-28T09:00:00.000Z", text: "delivered earlier", ask_id: null },
		{ type: "delivered", id: "dc-20260928090000-00000000", at: "2026-09-28T09:30:00.000Z" },
	].map((e) => JSON.stringify(e)).join("\n") + "\n");

	const refused = fakePorts({ inject: () => Promise.reject(new Error("prompt refused")) });
	const lines: string[] = [];
	const first = await startDashboardControl({ stateDir, ports: refused.ports, now: () => now, log: (line) => lines.push(line) }) as DashboardControl;
	await new Promise((done) => setImmediate(done));
	first.stop();
	assert.ok(lines.some((line) => /inbox not delivered \(kept for the next session\): prompt refused/.test(line)), lines.join(""));
	assert.deepEqual(readInbox(stateDir).held.map((m) => m.text), ["ask-bbbb: Yes", "second"], "refused: still held; the stale one is dropped either way");

	const { state, ports } = fakePorts();
	const second = await listening(t, stateDir, ports, { now: () => now });
	await new Promise((done) => setImmediate(done));
	assert.equal(state.injected.length, 1, "one user message");
	const [text, deliverAs] = state.injected[0]!;
	assert.equal(deliverAs, undefined);
	assert.equal(text, [
		"[cp-dashboard inbox — 2 message(s) typed while this session was offline; each line keeps its time; re-check state before acting on them]",
		"- 2026-09-28T10:00:00.000Z (dc-20260928100000-00000001): ask-bbbb: Yes (ask-bbbb is answered, no longer open)",
		"- 2026-09-28T11:00:00.000Z (dc-20260928110000-00000002): second",
	].join("\n"), "oldest first; the dropped one was reported by the first start and never injected");
	assert.deepEqual(readInbox(stateDir).held, [], "each held id delivered once");
	const inbox = readFileSync(controlInboxFile(stateDir), "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(5);
	assert.deepEqual(inbox.map((l) => [l.type, l.id]), [["dropped", "dc-20260926100000-00000009"], ["delivered", "dc-20260928100000-00000001"], ["delivered", "dc-20260928110000-00000002"]]);
	second.control.stop();

	const again = fakePorts();
	await listening(t, stateDir, again.ports, { now: () => now }).then(({ control }) => control.stop());
	assert.equal(again.state.injected.length, 0, "a second session start delivers nothing twice");
});
