/**
 * Restart session (cp-aqxl), the bridge half over the real control socket: the `restart` op journals its request
 * first, then refuses (kill switch, unsupported, each blocker, no session file) or writes the pid-bound marker and
 * calls `shutdown` only after the reply is written; `status` reports whether and why.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlPorts, startDashboardControl } from "../src/dashboard-control.ts";
import { RESTART_UNSUPPORTED } from "../src/dashboard-restart.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import { controlConfigFile, controlJournalFile, readControlRecord } from "../src/viewer/control-files.ts";
import { createScratchHome } from "./harness/index.ts";
import bridgeExtension, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { RELAUNCH_ENV } from "../src/operator-relaunch.ts";

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	const session = join(home.path, "2026-01-01T00-00-00-000Z_0123abcd.jsonl");
	writeFileSync(session, "");
	return { home: home.path, stateDir, session, relaunch: join(stateDir, "operator", "relaunch.json") };
}
const journal = (stateDir: string): Array<Record<string, unknown>> => existsSync(controlJournalFile(stateDir)) ? readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

function restartPorts(session: string, relaunch: string | undefined, overrides: Partial<ControlPorts> = {}) {
	const state = { idle: true, sends: [] as string[], shutdowns: 0, injected: 0 };
	const ports: ControlPorts = {
		inject: () => { state.injected += 1; },
		abort: () => {},
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		sessionFile: () => session,
		shutdown: () => { state.shutdowns += 1; },
		relaunchFile: () => relaunch,
		parentSends: () => ({ ids: state.sends, error: null }),
		...overrides,
	};
	return { state, ports };
}

async function listening(t: import("node:test").TestContext, stateDir: string, ports: ControlPorts) {
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 50, log: () => {} });
	assert.equal(control.state, "listening", "reason" in control ? control.reason : "");
	t.after(() => (control as { stop(): void }).stop());
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	return (record as { record: Parameters<typeof controlRequest>[0] }).record;
}

test("restart unsupported: a bridge without the restart ports (plain pi, or a cp-operator that predates this) refuses 409 and says how to restart by hand", async (t) => {
	const { stateDir, session } = scratch(t);
	const { ports, state } = restartPorts(session, undefined);
	const record = await listening(t, stateDir, ports);
	const status = await controlRequest(record, "status", {});
	assert.deepEqual((status as { result: { restart: unknown } }).result.restart, { supported: false, blockers: [], reason: RESTART_UNSUPPORTED });
	const reply = await controlRequest(record, "restart", { peer: "100.64.0.9" });
	assert.deepEqual(reply, { ok: false, status: 409, error: `unsupported: ${RESTART_UNSUPPORTED}` });
	assert.match(RESTART_UNSUPPORTED, /\/quit, then cp-operator -c/);
	assert.equal(state.shutdowns, 0);
	assert.deepEqual(journal(stateDir).map((line) => [line.type, line.kind ?? line.state]), [["request", "restart"], ["outcome", "refused"]], "journaled before the refusal");
});

test("restart refusals: the kill switch, each blocker, and a session file not on disk refuse with the reason; no marker, no shutdown", async (t) => {
	const { stateDir, session, relaunch } = scratch(t);
	const { ports, state } = restartPorts(session, relaunch);
	const record = await listening(t, stateDir, ports);
	const refused = async (pattern: RegExp, status = 409) => {
		const reply = await controlRequest(record, "restart", {});
		assert.equal(reply.ok, false);
		assert.equal((reply as { status: number }).status, status, JSON.stringify(reply));
		assert.match((reply as { error: string }).error, pattern);
	};
	mkdirSync(dirname(controlConfigFile(stateDir)), { recursive: true });
	writeFileSync(controlConfigFile(stateDir), '{"enabled": false}');
	await refused(/^dashboard control is off/, 403);
	writeFileSync(controlConfigFile(stateDir), '{"enabled": true}');

	state.idle = false;
	await refused(/^not now: the session is busy with a turn$/);
	const busy = await controlRequest(record, "status", {});
	assert.deepEqual((busy as { result: { restart: unknown } }).result.restart, { supported: true, blockers: ["the session is busy with a turn"], reason: "not now: the session is busy with a turn" });
	state.idle = true;

	state.sends = ["ps-20260101000000-0123abcd"];
	await refused(/^not now: cp_parent send ps-20260101000000-0123abcd pending$/);
	state.sends = [];

	const other = scratch(t);
	const pending = restartPorts(other.session, other.relaunch, { hasPendingMessages: () => true });
	const otherRecord = await listening(t, other.stateDir, pending.ports);
	const queued = await controlRequest(otherRecord, "restart", {});
	assert.match((queued as { error: string }).error, /^not now: messages are queued for the session$/);

	// An injected dashboard message the session has not echoed back yet is an open request.
	const sent = await controlRequest(record, "send", { kind: "message", text: "hello" });
	assert.equal(sent.ok, true);
	await refused(/^not now: 1 dashboard request\(s\) injected but not seen by the session yet$/);

	const fresh = scratch(t);
	const gone = restartPorts(join(dirname(fresh.session), "gone.jsonl"), fresh.relaunch);
	const goneRecord = await listening(t, fresh.stateDir, gone.ports);
	const reply = await controlRequest(goneRecord, "restart", {});
	assert.match((reply as { error: string }).error, /gone\.jsonl is not on disk; nothing to resume$/);

	// A dashboard answer click on an ask the session has not recorded yet: the restart waits for the answer to land.
	const asked = scratch(t);
	mkdirSync(join(asked.stateDir, "operator"), { recursive: true });
	writeFileSync(join(asked.stateDir, "operator", "asks.jsonl"), `${JSON.stringify({ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: "2026-01-01T00:00:00Z", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] })}\n`);
	const askPorts = restartPorts(asked.session, asked.relaunch);
	const askRecord = await listening(t, asked.stateDir, askPorts.ports);
	assert.equal((await controlRequest(askRecord, "send", { kind: "answer", ask_id: "ask-abcd", label: "Keep" })).ok, true);
	const midAnswer = await controlRequest(askRecord, "restart", {});
	assert.match((midAnswer as { error: string }).error, /ask ask-abcd answered from the dashboard but not recorded yet/);

	assert.equal(state.shutdowns + gone.state.shutdowns + pending.state.shutdowns + askPorts.state.shutdowns, 0, "no refusal stops the session");
	assert.equal([relaunch, other.relaunch, fresh.relaunch, asked.relaunch].some((file) => existsSync(file)), false, "no refusal leaves a marker");
	const lines = journal(stateDir).filter((line) => line.type === "request" && line.kind === "restart");
	assert.equal(lines.length, 4, "every restart request journaled");
});

test("restart accepted: 202-shaped reply, a 0600 marker naming this pid and the exact session file, outcome restarting, shutdown only after the reply", async (t) => {
	const { stateDir, session, relaunch } = scratch(t);
	const { ports, state } = restartPorts(session, relaunch);
	const record = await listening(t, stateDir, ports);
	const reply = await controlRequest(record, "restart", { peer: "100.64.0.9" });
	assert.equal(reply.ok, true, JSON.stringify(reply));
	const result = (reply as { result: { id: string; state: string; session_file: string } }).result;
	assert.equal(result.state, "restarting");
	assert.equal(result.session_file, "2026-01-01T00-00-00-000Z_0123abcd.jsonl", "the basename only: the page never sees a path");
	assert.equal(state.shutdowns, 0, "not before the reply is on its way");
	const marker = JSON.parse(readFileSync(relaunch, "utf8"));
	assert.deepEqual({ ...marker, at: undefined }, { version: 1, id: result.id, pid: process.pid, session_file: session, at: undefined });
	await new Promise((done) => setTimeout(done, 150));
	assert.equal(state.shutdowns, 1, "then the session's own shutdown, once");
	assert.deepEqual(journal(stateDir).map((line) => [line.type, line.kind ?? line.state, line.peer]), [["request", "restart", "100.64.0.9"], ["outcome", "restarting", "100.64.0.9"]]);
});

test("cp-bridge wiring: with CP_OPERATOR_RELAUNCH_FILE set, the real extension reports restart supported and a `restart` frame calls ctx.shutdown exactly once, after the reply; unset, it is unsupported and never shuts down", async (t) => {
	const { home, stateDir, session, relaunch } = scratch(t);
	const saved = { PI_HOME: process.env.PI_HOME, [RELAUNCH_ENV]: process.env[RELAUNCH_ENV] };
	process.env.PI_HOME = join(home, "pi-home");
	delete process.env[RELAUNCH_ENV];
	t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	saveOperatorTarget({ home, mode: "multi", hostPid: 0, parentPid: 0 });
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const emit = async (event: string, payload: unknown, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); };
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as never);
	let shutdowns = 0;
	const ctx = { hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, shutdown: () => { shutdowns += 1; }, sessionManager: { getSessionFile: () => session } };
	await emit("session_start", {}, ctx);
	t.after(() => emit("session_shutdown", {}));
	const record = () => (readControlRecord(stateDir) as { record: Parameters<typeof controlRequest>[0] }).record;

	const plain = await controlRequest(record(), "restart", {});
	assert.deepEqual(plain, { ok: false, status: 409, error: `unsupported: ${RESTART_UNSUPPORTED}` }, "a pi no relaunching cp-operator started");

	process.env[RELAUNCH_ENV] = relaunch;
	const status = await controlRequest(record(), "status", {});
	assert.deepEqual((status as { result: { restart: unknown } }).result.restart, { supported: true, blockers: [], reason: null });
	const reply = await controlRequest(record(), "restart", { peer: "100.64.0.9" });
	assert.equal(reply.ok, true, JSON.stringify(reply));
	assert.equal(shutdowns, 0, "not before the reply");
	assert.deepEqual({ ...JSON.parse(readFileSync(relaunch, "utf8")), id: undefined, at: undefined }, { version: 1, id: undefined, pid: process.pid, session_file: session, at: undefined });
	await new Promise((done) => setTimeout(done, 150));
	assert.equal(shutdowns, 1, "the session's own ctx.shutdown, exactly once");
});
