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
	const one = "im-20261004-0123456789abcdef01234567.png";
	const eight = Array.from({ length: 8 }, (_, i) => `im-20261004-${String(i).repeat(24)}.${["png", "jpg", "webp", "gif"][i % 4]}`);
	assert.deepEqual(parseDashboardText(`look\n\n${dashboardMarker(id, null, [one])}`), { body: "look", id, askId: null, images: [one] });
	assert.deepEqual(parseDashboardText(dashboardMarker(id, null, eight)), { body: "", id, askId: null, images: eight }, "eight ids, no text");
	assert.equal(parseDashboardText(`x\n\n[cp-dashboard ${id} — from the dashboard; images=im-1.png]`), undefined, "a malformed image id is not a marker");
	assert.equal(parseDashboardText(dashboardMarker(id, null, [...eight, one])), undefined, "nine ids are not a marker");
	assert.deepEqual(parseDashboardText(`hello\n\n[cp-dashboard ${id} — from the dashboard; thread=billing-bug]`), { body: "hello", id, askId: null, thread: "billing-bug" });
	assert.deepEqual(parseDashboardText(`click\n\n[cp-dashboard ${id} — from the dashboard; ask=ask-abcd; thread=billing-bug; images=${one}]`), { body: "click", id, askId: "ask-abcd", thread: "billing-bug", images: [one] });
	for (const tag of ["-bad", "Bad", "bad tag", "x".repeat(33)]) assert.equal(parseDashboardText(`[cp-dashboard ${id} — from the dashboard; thread=${tag}]`), undefined);
	const file = "tx-20261004-0123456789abcdef01234567.html";
	const marker = dashboardMarker(id, "ask-abcd", [one], "billing-bug", [file]);
	assert.equal(marker, `[cp-dashboard ${id} — from the dashboard; ask=ask-abcd; thread=billing-bug; images=${one}; files=${file}]`);
	assert.deepEqual(parseDashboardText(`files\n\n${marker}`), {body: "files", id, askId: "ask-abcd", thread: "billing-bug", images: [one], files: [file]});
	assert.equal(parseDashboardText(marker.replace(`files=${file}`, `files=${one}`)), undefined);
	assert.equal(parseDashboardText(marker.replace(`images=${one}`, `images=${file}`)), undefined);
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

test("delivery: a message is injected as a user message with the marker; idle is a prompt, busy is held by the dashboard until a settled turn, steer on request; never expandPromptTemplates", async (t) => {
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
	const held = await controlRequest(record, "send", { kind: "message", text: "next", peer: "100.64.0.9" });
	assert.ok(held.ok);
	assert.deepEqual({ ...(held.result as object), id: undefined }, { id: undefined, state: "queued", deliver: "followUp", editable: true }, "busy: the dashboard holds it");
	assert.equal(fake.state.injected.length, 1, "cp-y43c: a busy session is not given the message (no pi followUp)");
	await controlRequest(record, "send", { kind: "message", text: "now", deliver: "steer", peer: "100.64.0.9" });
	assert.equal(fake.state.injected[1]![1], "steer", "a steer is never queued");

	const status = await controlRequest(record, "status", {});
	assert.ok(status.ok);
	assert.deepEqual({ ...(status.result as object), recent: undefined, restart: undefined }, { busy: true, pending: false, session_file: "operator-session.jsonl", recent: undefined, restart: undefined, files: true });
	assert.equal((status.result as { restart: { supported: boolean } }).restart.supported, false, "ports without the restart members: Restart session unsupported");
	assert.equal(journal(stateDir).filter((l) => l.type === "request").length, 3, "status writes no journal line");

	fake.state.idle = true;
	control.settled();
	await new Promise((done) => setImmediate(done));
	assert.equal(fake.state.injected.length, 3, "the settled turn hands the queued one over");
	assert.deepEqual([fake.state.injected[2]![0].split("\n\n")[0], fake.state.injected[2]![1]], ["next", undefined], "as a prompt: the session is idle");

	const lines = journal(stateDir);
	const first = lines[0]!;
	assert.deepEqual({ ...first, id: undefined, at: undefined, session_started_at: undefined, session_file: undefined }, { type: "request", by: "bridge", id: undefined, at: undefined, session_started_at: undefined, session_file: undefined, peer: "100.64.0.9", kind: "message", text: "hello there", ask_id: null, deliver: "prompt" });
	assert.deepEqual(lines.filter((l) => l.id === first.id).map((l) => l.type === "outcome" ? l.state : l.type), ["request", "injected", "queued"]);
	const second = lines.find((l) => l.type === "request" && l.text === "next")!;
	assert.deepEqual(lines.filter((l) => l.id === second.id).map((l) => l.type === "outcome" ? l.state : l.type), ["request", "queued", "injected", "delivered"]);

	control.observe({ role: "user", content: text });
	assert.equal(journal(stateDir).filter((l) => l.id === first.id && l.state === "delivered").length, 1, "a later sighting marks the queued one delivered, once");
	control.observe({ role: "user", content: text });
	assert.equal(journal(stateDir).filter((l) => l.id === first.id && l.state === "delivered").length, 1);
	assert.equal(typeof first.session_started_at, "string");
	assert.equal(first.session_file, "/tmp/operator-session.jsonl");
	fake.state.echo = false;
	const pending = await controlRequest(record, "send", {kind:"message",text:"abandoned"});
	const pendingId = pending.ok && (pending.result as {id:string}).id;
	control.stop(); control.stop();
	assert.equal(journal(stateDir).filter(row=>row.id === pendingId && row.state === "dropped").length,1,"shutdown settles unseen accepted messages exactly once");
	assert.equal(journal(stateDir).filter(row=>row.id === first.id && row.state === "dropped").length,0,"delivered outcomes survive shutdown");
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

test("threaded sends: normalize the tag in the footer; clicks keep ask=; invalid tags inject nothing", async (t) => {
	const { stateDir } = scratch(t);
	put(join(stateDir, "operator", "asks.jsonl"), ASKS.map((a) => JSON.stringify(a)).join("\n") + "\n");
	const fake = fakePorts();
	const { record } = await listening(t, stateDir, fake.ports);
	assert.ok((await controlRequest(record, "send", { kind: "message", text: "billing?", thread: "  Billing Bug " })).ok);
	assert.match(fake.state.injected[0]![0], /^billing\?\n\n\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard; thread=billing-bug\]$/);
	assert.ok((await controlRequest(record, "send", { kind: "answer", ask_id: "ask-abcd", label: "Keep", thread: "Billing Bug" })).ok);
	assert.match(fake.state.injected[1]![0], /^ask-abcd: Keep\n\n\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard; ask=ask-abcd; thread=billing-bug\]$/);
	for (const thread of ["-bad", "x".repeat(33), 7, null]) {
		const refused = await controlRequest(record, "send", { kind: "message", text: "bad", thread });
		assert.equal(refused.ok, false);
		assert.match(refused.ok ? "" : refused.error, /thread must be a tag/);
	}
	assert.equal(fake.state.injected.length, 2);
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

test("held thread tags survive replay without changing untagged messages or sharing the replay turn", async (t) => {
	const { stateDir } = scratch(t);
	put(controlInboxFile(stateDir), JSON.stringify({ type: "held", id: "dc-20261006080000-89abcdef", at: "2026-10-06T08:00:00Z", text: "later", ask_id: null, thread: "billing-bug" }) + "\n");
	const fake = fakePorts();
	await listening(t, stateDir, fake.ports, { now: () => new Date("2026-10-06T08:01:00Z") });
	assert.equal(fake.state.injected[0]![0], "[cp-dashboard inbox — 1 message(s) typed while this session was offline; each line keeps its time; re-check state before acting on them]\n- 2026-10-06T08:00:00Z (dc-20261006080000-89abcdef): later\n[cp-dashboard dc-20261006080000-89abcdef — from the dashboard; thread=billing-bug]");
});

// cp-y43c: the dashboard holds busy messages; one handoff per settled turn, FIFO; edit/cancel until the handoff.
const head = (injected: Array<[string, string | undefined]>) => injected.map(([text]) => text.split("\n\n")[0]);
const states = (stateDir: string, id: string) => journal(stateDir).filter((l) => l.id === id).map((l) => l.type === "outcome" ? l.state : l.type);
const tick = () => new Promise((done) => setImmediate(done));
async function queued(record: Parameters<typeof controlRequest>[0], text: string): Promise<string> {
	const reply = await controlRequest(record, "send", { kind: "message", text });
	assert.ok(reply.ok && (reply.result as { state: string }).state === "queued", `${text} is held`);
	return (reply.result as { id: string }).id;
}

test("queue: busy messages wait in the dashboard, one per settled turn, oldest first; edit and cancel apply before the handoff", async (t) => {
	const { stateDir } = scratch(t);
	const fake = fakePorts();
	fake.state.idle = false;
	const { control, record } = await listening(t, stateDir, fake.ports);
	const [a, b, c] = [await queued(record, "alpha"), await queued(record, "bravo"), await queued(record, "charlie")];
	assert.equal(fake.state.injected.length, 0, "nothing reaches pi while it is busy");
	const edited = await controlRequest(record, "queue_edit", { id: a, text: "  alpha, edited  " });
	assert.deepEqual(edited.ok && edited.result, { id: a, state: "queued", text: "alpha, edited", editable: true });
	const cancelled = await controlRequest(record, "queue_cancel", { id: b });
	assert.deepEqual(cancelled.ok && cancelled.result, { id: b, state: "cancelled" });
	assert.equal((await controlRequest(record, "queue_edit", { id: a, text: "   " })).ok, false, "an empty edit is refused");
	assert.equal((await controlRequest(record, "queue_edit", { id: "dc-20261006080000-00000000", text: "x" }) as { status?: number }).status, 404);

	control.settled();
	assert.equal(fake.state.injected.length, 0, "still busy: nothing handed over");
	fake.state.idle = true;
	control.settled();
	await tick();
	assert.deepEqual(head(fake.state.injected), ["alpha, edited"], "the saved text, as one prompt");
	control.settled();
	await tick();
	assert.deepEqual(head(fake.state.injected), ["alpha, edited", "charlie"], "next turn, next message; the cancelled one is skipped, never delivered");
	assert.deepEqual(states(stateDir, a), ["request", "queued", "edited", "injected"]);
	assert.deepEqual(states(stateDir, b), ["request", "queued", "cancelled"]);
	assert.deepEqual(states(stateDir, c), ["request", "queued", "injected"]);

	const late = await controlRequest(record, "queue_edit", { id: a, text: "too late" });
	assert.equal(late.ok, false);
	assert.deepEqual((late as { status: number; result?: unknown }).status, 409);
	assert.deepEqual((late as { result?: unknown }).result, { id: a, state: "sent", text: "alpha, edited" }, "already sent names the text the session got");
	const gone = await controlRequest(record, "queue_cancel", { id: b });
	assert.equal((gone as { status?: number }).status, 409, "a cancelled message cannot be cancelled or sent again");
});

test("queue race: edit or cancel while the handoff is in flight never sends twice or loses the message; a late failure frees the next turn", async (t) => {
	const { stateDir } = scratch(t);
	let release: (() => void) | undefined;
	let reject: ((error: Error) => void) | undefined;
	const fake = fakePorts({ inject: (text, deliverAs) => { fake.state.injected.push([text, deliverAs]); return new Promise<void>((resolve, fail) => { release = resolve; reject = fail; }); } });
	fake.state.idle = false;
	const { control, record } = await listening(t, stateDir, fake.ports);
	const [a, b] = [await queued(record, "first"), await queued(record, "second")];
	fake.state.idle = true;
	control.settled();
	assert.deepEqual(head(fake.state.injected), ["first"], "handed over synchronously with the claim");
	const [edit, cancel] = await Promise.all([controlRequest(record, "queue_edit", { id: a, text: "changed" }), controlRequest(record, "queue_cancel", { id: a })]);
	for (const reply of [edit, cancel]) assert.deepEqual([reply.ok, (reply as { status?: number }).status, (reply as { result?: unknown }).result], [false, 409, { id: a, state: "sent", text: "first" }]);
	reject!(new Error("pi refused"));
	await tick();
	await tick();
	assert.deepEqual(states(stateDir, a), ["request", "queued", "injected", "failed"], "the refusal is journaled; nothing pretends it was applied");
	assert.deepEqual(head(fake.state.injected), ["first", "second"], "a failed handoff frees the next one without a turn");
	const edited = await controlRequest(record, "queue_edit", { id: b, text: "second, changed" });
	assert.equal((edited as { status?: number }).status, 409, "second is in flight: too late");
	release!();
	await tick();
	assert.deepEqual(head(fake.state.injected), ["first", "second"], "each message given to pi exactly once");
	assert.deepEqual(states(stateDir, b), ["request", "queued", "injected"]);
});

test("queue restart: a stopped bridge's held messages reload in order with their edits; a handed-over one is never resent", async (t) => {
	const { stateDir } = scratch(t);
	const first = fakePorts();
	first.state.idle = false;
	const one = await listening(t, stateDir, first.ports);
	const [a, b, c, d] = [await queued(one.record, "one"), await queued(one.record, "two"), await queued(one.record, "three"), await queued(one.record, "four")];
	await controlRequest(one.record, "queue_edit", { id: c, text: "three, edited" });
	await controlRequest(one.record, "queue_cancel", { id: d });
	first.state.idle = true;
	one.control.settled();
	await tick();
	assert.deepEqual(head(first.state.injected), ["one"]);
	one.control.stop();
	assert.deepEqual(states(stateDir, a), ["request", "queued", "injected", "dropped"], "unseen at stop: dropped, never resent (at most once)");

	const second = fakePorts();
	const two = await listening(t, stateDir, second.ports);
	assert.deepEqual(head(second.state.injected), ["two"], "idle at start: the oldest held message, once");
	two.control.settled();
	await tick();
	assert.deepEqual(head(second.state.injected), ["two", "three, edited"]);
	two.control.settled();
	await tick();
	assert.equal(second.state.injected.length, 2, "the cancelled one and the handed-over one stay gone");
	two.control.stop();

	const third = fakePorts();
	await listening(t, stateDir, third.ports).then(({ control }) => control.stop());
	assert.equal(third.state.injected.length, 0, "a third start has nothing to resend");
	assert.deepEqual([b, c].map((id) => states(stateDir, id).filter((s) => s === "injected").length), [1, 1]);
});

test("queue restart, FIFO across the offline inbox (review 1): an older held message goes before the inbox turn, a newer one after; one handoff per settled turn", async (t) => {
	for (const order of ["held-first", "inbox-first"] as const) await t.test(order, async (t) => {
		const { stateDir } = scratch(t);
		const at = new Date("2026-10-09T12:00:00Z");
		const minutes = (m: number) => new Date(at.getTime() + m * 60_000).toISOString();
		const [heldAt, inboxAt] = order === "held-first" ? [minutes(-20), minutes(-10)] : [minutes(-10), minutes(-20)];
		put(controlJournalFile(stateDir), [
			{ type: "request", by: "bridge", id: "dc-20261009114000-0000a001", at: heldAt, kind: "message", text: "held in the queue", ask_id: null, deliver: "followUp", peer: null },
			{ type: "outcome", by: "bridge", id: "dc-20261009114000-0000a001", at: heldAt, peer: null, state: "queued", reason: null },
		].map((line) => JSON.stringify(line)).join("\n") + "\n");
		put(controlInboxFile(stateDir), JSON.stringify({ type: "held", id: "dc-20261009115000-0000b001", at: inboxAt, text: "typed offline", ask_id: null }) + "\n");
		const fake = fakePorts();
		const { control, record } = await listening(t, stateDir, fake.ports, { now: () => at });
		const first = order === "held-first" ? /^held in the queue\n\n/ : /^\[cp-dashboard inbox — 1 message/;
		const second = order === "held-first" ? /^\[cp-dashboard inbox — 1 message/ : /^held in the queue\n\n/;
		assert.equal(fake.state.injected.length, 1, "one handoff at start");
		assert.match(fake.state.injected[0]![0], first, "the older one first");
		const later = await controlRequest(record, "send", { kind: "message", text: "typed after the start" });
		assert.equal(later.ok && (later.result as { state: string }).state, "queued", "an idle send waits behind both");
		control.settled();
		assert.equal(fake.state.injected.length, 2);
		assert.match(fake.state.injected[1]![0], second);
		control.settled();
		assert.deepEqual(head(fake.state.injected).slice(2), ["typed after the start"]);
		control.settled();
		assert.equal(fake.state.injected.length, 3, "each once");
	});
});

test("queue keeps ask ids (review 1): a held message's ask id survives reload into the handoff marker; a card's free-text reply keeps its ask prefix; a click answer never queues", async (t) => {
	const { stateDir } = scratch(t);
	put(join(stateDir, "operator", "asks.jsonl"), ASKS.map((a) => JSON.stringify(a)).join("\n") + "\n");
	const id = "dc-20261009114000-0000a5c1";
	const at = new Date().toISOString();
	put(controlJournalFile(stateDir), [
		{ type: "request", by: "bridge", id, at, kind: "message", text: "linked to a card", ask_id: "ask-abcd", deliver: "followUp", peer: null },
		{ type: "outcome", by: "bridge", id, at, peer: null, state: "queued", reason: null },
	].map((line) => JSON.stringify(line)).join("\n") + "\n");
	const fake = fakePorts();
	fake.state.idle = false;
	const { control, record } = await listening(t, stateDir, fake.ports);
	const reply = await queued(record, "ask-abcd: keep it, but ask me tomorrow");
	const click = await controlRequest(record, "send", { kind: "answer", ask_id: "ask-abcd", label: "Keep" });
	assert.ok(click.ok);
	assert.equal(fake.state.injected.length, 1, "the click is not queued behind the held messages");
	assert.match(fake.state.injected[0]![0], /^ask-abcd: Keep\n\n\[cp-dashboard dc-\S+ — from the dashboard; ask=ask-abcd\]$/);
	assert.equal(fake.state.injected[0]![1], "followUp");
	fake.state.idle = true;
	control.settled();
	assert.match(fake.state.injected[1]![0], new RegExp(`^linked to a card\\n\\n\\[cp-dashboard ${id} — from the dashboard; ask=ask-abcd\\]$`), "reloaded with its ask id");
	control.settled();
	assert.match(fake.state.injected[2]![0], /^ask-abcd: keep it, but ask me tomorrow\n\n\[cp-dashboard dc-\S+ — from the dashboard\]$/);
	assert.equal(journal(stateDir).find((line) => line.id === reply && line.type === "request")!.ask_id, null);
});

test("queue edit whitespace matches the composer (review 1): ends trimmed, inner spaces and blank lines kept", async (t) => {
	const { stateDir } = scratch(t);
	const fake = fakePorts();
	fake.state.idle = false;
	const { control, record } = await listening(t, stateDir, fake.ports);
	const id = await queued(record, "  first draft  ");
	const edited = await controlRequest(record, "queue_edit", { id, text: "\n  line one\n\n    indented  two  \n" });
	assert.equal(edited.ok && (edited.result as { text: string }).text, "line one\n\n    indented  two");
	fake.state.idle = true;
	control.settled();
	assert.equal(fake.state.injected[0]![0].split("\n\n[cp-dashboard")[0], "line one\n\n    indented  two");
});
