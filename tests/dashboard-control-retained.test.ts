/**
 * Dashboard control, the halves no real session can drive: parsers, fake-port faults and echo timing, the viewer's
 * audit writer, a refused inbox injection and the handoff race. The rest: P9e-control* in e2e.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { startDashboardControl, type ControlPorts, type DashboardControl } from "../src/dashboard-control.ts";
import { appendControlAudit } from "../src/viewer/control-audit.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import {
	CONTROL_TEXT_MAX, controlConfigFile, controlInboxFile, controlJournalFile, controlRecordFile, controlSocketFile, dashboardMarker, parseDashboardText, readControlConfig, readControlRecord,
} from "../src/viewer/control-files.ts";
import { readInbox } from "../src/viewer/control-inbox.ts";
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
	const state = { idle: true, injected: [] as Array<[string, string | undefined]>, aborted: 0, observer: undefined as DashboardControl | undefined, echo: false, pending: false };
	const ports: ControlPorts = {
		inject: (text, deliverAs) => {
			state.injected.push([text, deliverAs]);
			if (state.echo) setImmediate(() => state.observer?.observe({ role: "user", content: [{ type: "text", text }] }));
		},
		abort: () => { state.aborted += 1; },
		isIdle: () => state.idle,
		// Pending handoffs stay unseen; re-hand evidence: e2e/headless-lifecycle.test.ts.
		hasPendingMessages: () => state.pending,
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
	assert.deepEqual({ ...(status.result as object), recent: undefined, restart: undefined }, { busy: true, pending: false, session_file: "operator-session.jsonl", recent: undefined, restart: undefined, files: true, remote_provenance: 1 });
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
	control.settled(); // the handed-over "next" ran its turn; until then an idle send would queue behind it (review 3)
	const pending = await controlRequest(record, "send", {kind:"message",text:"abandoned"});
	assert.equal(pending.ok && (pending.result as {state:string}).state, "queued", "idle, nothing in flight: injected directly, unseen within the wait");
	assert.equal(fake.state.injected.at(-1)![0].split("\n\n")[0], "abandoned");
	const pendingId = pending.ok && (pending.result as {id:string}).id;
	control.stop(); control.stop();
	assert.equal(journal(stateDir).filter(row=>row.id === pendingId && row.state === "dropped").length,1,"shutdown settles unseen accepted messages exactly once");
	assert.equal(journal(stateDir).filter(row=>row.id === first.id && row.state === "dropped").length,0,"delivered outcomes survive shutdown");
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

test("audit: appendControlAudit is 0600, clips text, never throws", (t) => {
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

// cp-y43c: the dashboard holds busy messages; one handoff per settled turn, FIFO; edit/cancel until the handoff.
const head = (injected: Array<[string, string | undefined]>) => injected.map(([text]) => text.split("\n\n")[0]);
const states = (stateDir: string, id: string) => journal(stateDir).filter((l) => l.id === id).map((l) => l.type === "outcome" ? l.state : l.type);
const tick = () => new Promise((done) => setImmediate(done));
async function queued(record: Parameters<typeof controlRequest>[0], text: string): Promise<string> {
	const reply = await controlRequest(record, "send", { kind: "message", text });
	assert.ok(reply.ok && (reply.result as { state: string }).state === "queued", `${text} is held`);
	return (reply.result as { id: string }).id;
}

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
