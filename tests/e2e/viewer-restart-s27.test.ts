import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT, isoTimestamp, layoutForHome } from "../../src/contracts.ts";
import { isPidAlive } from "../../src/fleet.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { RESTART_UNSUPPORTED } from "../../src/dashboard-restart.ts";
import { controlJournalFile, controlRecordFile, controlSocketFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../../src/viewer/push-files.ts";
import { RESTART_PREDATES } from "../../src/viewer/restart-status.ts";
import { createViewer, type ViewerOptions } from "../../src/viewer/server.ts";
import { CP_BRIDGE_EXTENSION, MockProvider, createAgentDir, createScratchHome, startRpc, waitFor } from "../harness/index.ts";

const ORIGIN = "https://cp.example.ts.net";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const journal = (state: string): Array<Record<string, unknown>> => existsSync(controlJournalFile(state)) ? readFileSync(controlJournalFile(state), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function setup(t: TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const state = join(home.path, LAYOUT.state);
	put(pushConfigFile(pushDataDir(state)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-01-01T00:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir: state, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const call = async (path: string, token: string | null = null, body?: unknown, method = body === undefined ? "GET" : "POST") => {
		const response = await fetch(`http://127.0.0.1:${options.port}${path}`, { method, headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}) }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
		return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
	};
	const restart = async (token: string | null, body: unknown = { restart: true }) => {
		const before = journal(state).length;
		const reply = await call("/api/operator/restart", token, body);
		return { ...reply, lines: journal(state).slice(before) };
	};
	const bridge = async (supported: boolean, busy = false) => {
		const provider = await MockProvider.start();
		const gate = join(home.path, "release-model");
		const model = provider.addScript("viewer-restart", [
			...(busy ? [{ kind: "tool_calls" as const, calls: [{ name: "bash", args: { command: `node -e 'const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer)}},20)'` } }] }] : []),
			{ kind: "text", text: "Viewer restart ready." },
		]);
		const agent = createAgentDir({ provider });
		const session = join(home.path, "2026-01-01T00-00-00-000Z_0123abcd.jsonl");
		const marker = join(state, "operator", "relaunch.json");
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_OPERATOR_RELAUNCH_FILE: supported ? marker : undefined }, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--session", session, "--model", model] });
		t.after(async () => { put(gate, "release"); await rpc.close(); agent.cleanup(); await provider.stop(); });
		rpc.send({ type: "prompt", id: "seed", message: "Prepare the restart." });
		if (busy) await rpc.waitFor((r) => r.type === "tool_execution_start", 30_000);
		else await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
		const record = readControlRecord(state);
		assert.equal(record.state, "ok");
		if (record.state !== "ok") throw new Error("bridge offline");
		return { csrf: record.record.csrf, marker, rpc, release: () => put(gate, "release") };
	};
	const control = (op: string, args: object = {}) => new Promise<Record<string, any>>((resolve, reject) => {
		const record = readControlRecord(state);
		if (record.state !== "ok") return reject(new Error("control offline"));
		const client = connect(record.record.socket);
		let response = "";
		client.on("connect", () => client.write(`${JSON.stringify({ v: 1, id: 1, token: record.record.token, op, args })}\n`));
		client.on("data", (chunk) => { response += String(chunk); if (response.includes("\n")) { client.end(); resolve(JSON.parse(response.trim())); } });
		client.on("error", reject);
	});
	return { home: home.path, state, call, restart, bridge, control };
}
function refused(result: { status: number; body: Record<string, any>; lines: Array<Record<string, unknown>> }, status: number) {
	assert.equal(result.status, status, JSON.stringify(result.body));
	assert.deepEqual(result.lines.map((line) => [line.type, line.by, line.kind, line.status, line.reason]), [["refused", "viewer", "restart", status, result.body.error]]);
}

test("S27 viewer restart: HTTP validation, real busy bridge, accepted restart and rate limit preserve audit order", { timeout: 90_000 }, async (t) => {
	const s = await setup(t);
	const offline = await s.restart("x".repeat(64));
	refused(offline, 409);
	assert.equal(offline.body.state, "offline");
	const b = await s.bridge(true, true);
	for (const body of [{}, { restart: "yes" }, { restart: true, extra: 1 }, "[]"]) refused(await s.restart(b.csrf, body), 400);
	refused(await s.restart(null), 403);
	refused(await s.restart("0".repeat(64)), 403);
	const before = journal(s.state).length;
	assert.equal((await s.call("/api/operator/restart")).status, 405);
	assert.equal(journal(s.state).length, before);
	const status = await s.call("/api/operator/control");
	assert.deepEqual(status.body.restart, { supported: true, blockers: ["the session is busy with a turn"], reason: "not now: the session is busy with a turn" });
	assert.equal(typeof status.body.session_started_at, "string");
	const busy = await s.restart(b.csrf);
	assert.deepEqual([busy.status, busy.body], [409, { state: "refused", error: "not now: the session is busy with a turn" }]);
	assert.deepEqual(busy.lines.map((line) => [line.type, line.by, line.kind ?? line.state]), [["request", "bridge", "restart"], ["outcome", "bridge", "refused"]]);
	b.release();
	await b.rpc.waitFor((r) => r.type === "agent_settled", 30_000);
	const accepted = await s.restart(b.csrf);
	assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
	assert.deepEqual({ ...accepted.body, id: undefined }, { state: "restarting", id: undefined, session_file: "2026-01-01T00-00-00-000Z_0123abcd.jsonl" });
	assert.deepEqual(accepted.lines.map((line) => [line.type, line.kind ?? line.state]), [["request", "restart"], ["outcome", "restarting"]]);
	const again = await s.restart(b.csrf);
	refused(again, 429);
	assert.match(again.headers.get("retry-after") ?? "", /^\d+$/);
	await waitFor(() => existsSync(b.marker), Boolean, { what: "restart marker" });
	assert.equal(JSON.parse(readFileSync(b.marker, "utf8")).id, accepted.body.id);
	const pid = JSON.parse(readFileSync(b.marker, "utf8")).pid as number;
	assert.equal(pid, b.rpc.pid, "the marker names the bridge's own pi");
	await waitFor(() => isPidAlive(pid), (alive) => !alive, { timeoutMs: 30_000, what: "accepted restart shuts down its idle RPC pi" });
});

// Restart clean: only `fresh: true` is accepted beside `restart`; the marker carries it and the reply names the newest
// handoff (by mtime) the new session is pointed at. Regression: a clean body used to be a 400.
test("S27 viewer restart: clean restart writes a fresh marker and names the newest handoff", { timeout: 90_000 }, async (t) => {
	const s = await setup(t);
	const handoffs = join(s.home, layoutForHome("multi", s.home).operatorWorkspace, "handoffs");
	put(join(handoffs, "main-session-compact-a.md"), "old");
	utimesSync(join(handoffs, "main-session-compact-a.md"), 1000, 1000);
	put(join(handoffs, "main-session-2026-09-29.md"), "new");
	const b = await s.bridge(true);
	for (const body of [{ restart: true, fresh: false }, { restart: true, fresh: true, extra: 1 }, { fresh: true }]) refused(await s.restart(b.csrf, body), 400);
	const accepted = await s.restart(b.csrf, { restart: true, fresh: true });
	assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
	assert.deepEqual({ ...accepted.body, id: undefined }, { state: "restarting", id: undefined, session_file: "2026-01-01T00-00-00-000Z_0123abcd.jsonl", fresh: true, handoff: "main-session-2026-09-29.md" });
	await waitFor(() => existsSync(b.marker), Boolean, { what: "restart marker" });
	const marker = JSON.parse(readFileSync(b.marker, "utf8"));
	assert.deepEqual([marker.id, marker.fresh, marker.version], [accepted.body.id, true, 1]);
	await waitFor(() => isPidAlive(marker.pid), (alive) => !alive, { timeoutMs: 30_000, what: "clean restart shuts down its idle RPC pi" });
});

test("S27 viewer restart: plain bridge reports unsupported through HTTP status and restart", { timeout: 60_000 }, async (t) => {
	const s = await setup(t);
	const b = await s.bridge(false);
	const result = await s.restart(b.csrf);
	assert.deepEqual([result.status, result.body], [409, { state: "refused", error: `unsupported: ${RESTART_UNSUPPORTED}` }]);
	assert.deepEqual((await s.call("/api/operator/control")).body.restart, { supported: false, blockers: [], reason: RESTART_UNSUPPORTED });
});

test("S27 viewer restart: legacy socket refusal maps to unsupported status and one viewer audit line", async (t) => {
	const s = await setup(t);
	const socket = controlSocketFile(s.state);
	mkdirSync(dirname(socket), { recursive: true });
	const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
	const old = createServer((client) => client.on("data", (chunk) => {
		const frame = JSON.parse(String(chunk).trim()) as { id: number; op: string };
		client.end(`${JSON.stringify(frame.op === "status" ? { id: frame.id, ok: true, result: { busy: false, pending: false, session_file: "x.jsonl", recent: [] } } : { id: frame.id, ok: false, status: 400, error: `unknown op ${frame.op}` })}\n`);
	}));
	await new Promise<void>((resolve) => old.listen(socket, resolve));
	t.after(() => old.close());
	put(controlRecordFile(s.state), JSON.stringify({ version: 1, pid: process.pid, socket, token, csrf, started_at: "2026-01-01T00:00:00.000Z" }));
	const result = await s.restart(csrf);
	assert.deepEqual([result.status, result.body], [409, { state: "refused", error: `unsupported: ${RESTART_PREDATES}` }]);
	refused(result, 409);
	assert.deepEqual((await s.call("/api/operator/control")).body.restart, { supported: false, blockers: [], reason: RESTART_PREDATES });
});

test("S27 restart blockers: real queued answers and pending parent sends appear in order and malformed outboxes fail closed", { timeout: 60_000 }, async (t) => {
	const s = await setup(t);
	const b = await s.bridge(true, true);
	const asks = new OperatorAsks(join(s.state, "operator", "asks.jsonl"));
	const ids: string[] = [];
	for (const question of ["S27 first", "S27 second"]) {
		const ask = asks.open({ project: "demo", question, options: [{ label: "Hold", consequence: "Wait" }], recommendation: "Hold" });
		ids.push(ask.id);
		const reply = await s.control("send", { kind: "answer", ask_id: ask.id, label: "Hold" });
		assert.equal(reply.ok, true, JSON.stringify(reply));
	}
	const outbox = join(s.home, LAYOUT.sessions, "cp-parent.sends.json");
	const pending = "ps-20260102110000-0123abcd";
	put(outbox, JSON.stringify({ schema_version: 1, updated_at: isoTimestamp(), entries: [{ schema_version: 1, id: pending, text: "x", queued_at: isoTimestamp(), state: "injected", attempts: 1 }] }));
	const expected = ["the session is busy with a turn", "messages are queued for the session", "2 dashboard request(s) injected but not seen by the session yet", ...ids.map((id) => `ask ${id} answered from the dashboard but not recorded yet`)];
	const status = await s.control("status");
	assert.deepEqual(status.result.restart.blockers, [...expected, `cp_parent send ${pending} pending`]);
	assert.equal((await s.control("restart")).error, `not now: ${[...expected, `cp_parent send ${pending} pending`].join("; ")}`);
	put(outbox, "{not json");
	const malformed = await s.control("status");
	assert.deepEqual(malformed.result.restart.blockers.slice(0, -1), expected);
	assert.match(malformed.result.restart.blockers.at(-1), /parent send outbox unreadable:.*not valid JSON/);
	b.release();
});
