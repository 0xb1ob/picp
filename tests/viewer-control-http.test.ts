/**
 * cp-dashboard-operator-control, the viewer's half: `GET /api/operator/control` and `POST /api/operator/message`
 * in their refusal order, against the real bridge server (plan T3, with addendum 1: no identity, no allowlist;
 * on by default; 20 KiB body; 20 requests per 60 s).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { startDashboardControl, type ControlPorts, type DashboardControl } from "../src/dashboard-control.ts";
import { herdrCommand } from "../src/viewer/launchers.ts";
import { ControlLimiter } from "../src/viewer/control-api.ts";
import { controlConfigFile, controlInboxFile, controlJournalFile, controlRecordFile, controlSocketFile, readControlRecord } from "../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../src/viewer/push-files.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { createScratchHome } from "./harness/index.ts";

const ORIGIN = "https://cp.example.ts.net";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const journalText = (stateDir: string) => existsSync(controlJournalFile(stateDir)) ? readFileSync(controlJournalFile(stateDir), "utf8") : "";
const journal = (stateDir: string): Array<Record<string, unknown>> => journalText(stateDir).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => { let body: Record<string, unknown> = {}; try { body = JSON.parse(text); } catch { body = { raw: text }; } resolve({ status: res.statusCode ?? 0, headers: res.headers, body }); });
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

async function setup(t: import("node:test").TestContext, viewer: Partial<ViewerOptions> = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	put(pushConfigFile(pushDataDir(stateDir)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-09-27T08:00:00Z" }));
	put(join(stateDir, "operator", "asks.jsonl"), [
		{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: "2026-09-27T08:00:00Z", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] },
		{ type: "open", id: "ask-bbbb", project: "demo", question: "Merge?", created_at: "2026-09-27T08:00:00Z", recommendation: "Yes", options: [{ label: "Yes", consequence: "Merges" }] },
		{ type: "answer", id: "ask-bbbb", answer: "Yes", answered_at: "2026-09-27T08:05:00Z" },
	].map((e) => JSON.stringify(e)).join("\n") + "\n");
	// herdr: null unless a test names one, so no test ever reaches a real herdr on this host.
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null }, ...viewer };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return { stateDir, options, port: options.port };
}

async function bridge(t: import("node:test").TestContext, stateDir: string) {
	const injected: Array<[string, string | undefined]> = [];
	const ports: ControlPorts = { inject: (text, deliverAs) => { injected.push([text, deliverAs]); }, abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => "/tmp/op.jsonl" };
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {} }) as DashboardControl;
	assert.equal(control.state, "listening");
	t.after(() => control.stop());
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	return { injected, csrf: (record as { record: { csrf: string } }).record.csrf };
}

const json = (token: string | null, body: unknown, extra: Record<string, string> = {}) => ({
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
	headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});
const MESSAGE = "/api/operator/message";

test("control is on without a config file: a valid send is 202 and reaches the session once; a click sends the verbatim label; the bridge journals, the viewer does not", async (t) => {
	const { stateDir, port } = await setup(t);
	assert.equal(existsSync(controlConfigFile(stateDir)), false);
	const { injected, csrf } = await bridge(t, stateDir);
	const status = await call(port, "/api/operator/control");
	assert.equal(status.status, 200);
	assert.equal(status.body.enabled, true);
	assert.equal(status.body.running, true);
	assert.equal(status.body.token, csrf, "the page fetches this session's CSRF token itself");
	assert.equal(journalText(stateDir), "", "the status route never writes");

	const sent = await call(port, MESSAGE, json(csrf, { kind: "message", text: "hello" }));
	assert.equal(sent.status, 202);
	assert.match(String(sent.body.id), /^dc-\d{14}-[0-9a-f]{8}$/);
	assert.equal(sent.body.deliver, "prompt");
	assert.equal(injected.length, 1);
	assert.match(injected[0]![0], /^hello\n\n\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard\]$/);

	const click = await call(port, MESSAGE, json(csrf, { kind: "answer", ask_id: "ask-abcd", label: "Keep" }));
	assert.equal(click.status, 202);
	assert.match(injected[1]![0], /^ask-abcd: Keep\n\n\[cp-dashboard dc-.* — from the dashboard; ask=ask-abcd\]$/);
	const answered = await call(port, MESSAGE, json(csrf, { kind: "answer", ask_id: "ask-bbbb", label: "Yes" }));
	assert.equal(answered.status, 409, "an answered ask cannot be clicked");

	const lines = journal(stateDir);
	assert.equal(lines.filter((l) => l.by === "viewer").length, 0, "accepted sends and bridge refusals are the bridge's lines, not the viewer's");
	assert.deepEqual(lines.filter((l) => l.type === "request").map((l) => [l.kind, l.peer]), [["message", "127.0.0.1"], ["answer", "127.0.0.1"], ["answer", "127.0.0.1"]], "every line records the client address, never an identity");

	// Body cap 20 KiB: a full 16,000-character message fits with its envelope.
	const big = await call(port, MESSAGE, json(csrf, { kind: "message", text: "y".repeat(16_000) }));
	assert.equal(big.status, 202);
});

test("refusals, in order, each named and each journaled once by the viewer with the client address", async (t) => {
	const { stateDir, options, port } = await setup(t);
	const { csrf } = await bridge(t, stateDir);
	const refused = async (reply: Promise<Reply>, status: number, reason: RegExp, fields: Record<string, unknown> = {}) => {
		const before = journal(stateDir).length;
		const out = await reply;
		assert.equal(out.status, status, JSON.stringify(out.body));
		assert.match(String(out.body.error), reason);
		const lines = journal(stateDir);
		assert.equal(lines.length, before + 1, `one audit line for ${status} ${reason}`);
		const line = lines.at(-1)!;
		assert.deepEqual({ type: line.type, by: line.by, status: line.status, peer: line.peer }, { type: "refused", by: "viewer", status, peer: "127.0.0.1" });
		assert.match(String(line.reason), reason);
		for (const [key, value] of Object.entries(fields)) assert.deepEqual(line[key], value, key);
		return out;
	};
	await refused(call(port, MESSAGE, json(csrf, { kind: "message", text: "x" }, { origin: "https://evil.example" })), 403, /Origin must be https:\/\/cp\.example\.ts\.net/);
	await refused(call(port, MESSAGE, json(csrf, { kind: "message", text: "x" }, { "sec-fetch-site": "cross-site" })), 403, /cross-site/);
	await refused(call(port, MESSAGE, json(csrf, "hello", { "content-type": "text/plain" })), 415, /application\/json/);
	await refused(call(port, MESSAGE, json(csrf, { kind: "message", text: "z".repeat(21 * 1024) })), 413, /20480 bytes/, { text: null });
	assert.equal(typeof journal(stateDir).at(-1)!.bytes, "number", "an oversized body records its size, never its bytes");
	await refused(call(port, MESSAGE, json(csrf, { kind: "message", text: "q".repeat(16_001) })), 400, /longer than 16000/, { kind: "message" });
	await refused(call(port, MESSAGE, json(csrf, "{not json")), 400, /not JSON/, { text: null });
	await refused(call(port, MESSAGE, json(csrf, { kind: "shell", text: "rm" })), 400, /kind must be/);
	await refused(call(port, MESSAGE, json(null, { kind: "message", text: "no token" })), 403, /control token missing or stale/, { kind: "message", text: "no token" });
	await refused(call(port, MESSAGE, json("f".repeat(64), { kind: "answer", ask_id: "ask-abcd", label: "Keep" })), 403, /reload the transcript/, { kind: "answer", ask_id: "ask-abcd", text: "Keep" });

	// Rate: 20 per 60 s per client address, refusals included; only the first 429 per window is journaled.
	options.controlLimiter = new ControlLimiter();
	for (let i = 0; i < 20; i++) await call(port, MESSAGE, json(null, { kind: "message", text: `n${i}` }));
	const limited = await refused(call(port, MESSAGE, json(csrf, { kind: "message", text: "21st" })), 429, /too many dashboard requests: 20 per 60 s/);
	assert.ok(Number(limited.headers["retry-after"]) >= 1);
	const count = journal(stateDir).length;
	assert.equal((await call(port, MESSAGE, json(csrf, { kind: "message", text: "22nd" }))).status, 429);
	assert.equal(journal(stateDir).length, count, "repeated 429s in one window add no line");
	options.controlLimiter = new ControlLimiter();

	// Opt-out: {"enabled": false} refuses; an invalid file refuses 503 (fail closed).
	put(controlConfigFile(stateDir), '{"enabled": false}');
	await refused(call(port, MESSAGE, json(csrf, { kind: "message", text: "x" })), 403, /dashboard control is off/);
	const off = await call(port, "/api/operator/control");
	assert.deepEqual([off.body.enabled, off.body.token], [false, null], "off: status carries no token");
	put(controlConfigFile(stateDir), '{"enabled": "maybe"}');
	await refused(call(port, MESSAGE, json(csrf, { kind: "message", text: "x" })), 503, /config is invalid/);
	rmSync(controlConfigFile(stateDir));
});

test("no HTTPS origin configured: a tailnet bind accepts only its own http:// origin for messages and clicks; a configured origin keeps its old rule; push still needs setup", async (t) => {
	const { stateDir, port } = await setup(t, { host: "100.64.0.9" });
	rmSync(pushConfigFile(pushDataDir(stateDir)));
	const { injected, csrf } = await bridge(t, stateDir);
	const self = `http://100.64.0.9:${port}`;
	const at = (origin: string, body: unknown, extra: Record<string, string> = {}) => {
		const req = json(csrf, body, { origin, ...extra });
		return call(port, MESSAGE, { ...req, headers: { ...req.headers, host: `100.64.0.9:${port}` } });
	};
	assert.equal((await at(self, { kind: "message", text: "over http" })).status, 202);
	assert.equal((await at(self, { kind: "answer", ask_id: "ask-abcd", label: "Keep" })).status, 202);
	assert.equal(injected.length, 2);
	for (const foreign of ["https://evil.example", `https://100.64.0.9:${port}`, `http://100.64.0.9:${port + 1}`, `http://127.0.0.1:${port}`, ""]) {
		const out = await at(foreign, { kind: "message", text: "x" });
		assert.equal(out.status, 403, foreign);
		assert.match(String(out.body.error), new RegExp(`^Origin must be http://100\\.64\\.0\\.9:${port} \\(no HTTPS origin is configured`));
	}
	assert.equal((await at(self, { kind: "message", text: "x" }, { "sec-fetch-site": "cross-site" })).status, 403, "Sec-Fetch-Site still guards");
	assert.equal(injected.length, 2);
	const sub = await call(port, "/api/push/subscription", { method: "POST", body: "{}", headers: { host: `100.64.0.9:${port}`, origin: self, "content-type": "application/json" } });
	assert.equal(sub.status, 409, "push still needs push:init (HTTPS)");

	put(pushConfigFile(pushDataDir(stateDir)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-09-27T08:00:00Z" }));
	const configured = await at(self, { kind: "message", text: "x" });
	assert.equal(configured.status, 403, "configured: a non-loopback bind's own origin stays refused");
	assert.match(String(configured.body.error), /^Origin must be https:\/\/cp\.example\.ts\.net$/);
	assert.equal((await at(ORIGIN, { kind: "message", text: "via https" })).status, 202);
});

test("offline (no record, or its pid gone): the status carries the inbox token; a send is held with it as a 202; abort is 409; a stale token 403; at most 20 wait", async (t) => {
	const { stateDir, port } = await setup(t);
	const status = await call(port, "/api/operator/control");
	assert.deepEqual([status.body.enabled, status.body.running, status.body.token, status.body.offline, status.body.held], [true, false, null, true, 0]);
	assert.match(String(status.body.reason), /^Operator session offline: no dashboard control record at .*dashboard\.json$/);
	const inbox = String(status.body.inbox_token);
	assert.match(inbox, /^[0-9a-f]{64}$/);
	assert.equal(journalText(stateDir), "", "the status route never writes");

	const stale = await call(port, MESSAGE, json("a".repeat(64), { kind: "message", text: "x" }));
	assert.equal(stale.status, 403);
	assert.match(String(stale.body.error), /inbox token missing or stale/);
	assert.equal(journal(stateDir).at(-1)!.status, 403, "journaled by the viewer");
	const held = await call(port, MESSAGE, json(inbox, { kind: "message", text: "  deploy when green  " }));
	assert.equal(held.status, 202);
	assert.equal(held.body.state, "held");
	assert.match(String(held.body.id), /^dc-\d{14}-[0-9a-f]{8}$/);
	const click = await call(port, MESSAGE, json(inbox, { kind: "answer", ask_id: "ask-abcd", label: "Keep" }));
	assert.equal(click.status, 202);
	const lines = readFileSync(controlInboxFile(stateDir), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(lines.map((line) => [line.type, line.text, line.ask_id]), [["held", "deploy when green", null], ["held", "ask-abcd: Keep", "ask-abcd"]]);
	assert.equal((statSync(controlInboxFile(stateDir)).mode & 0o777).toString(8), "600");
	const abort = await call(port, MESSAGE, json(inbox, { kind: "abort" }));
	assert.equal(abort.status, 409);
	assert.match(String(abort.body.error), /nothing to abort; the operator session is offline/);
	assert.equal((await call(port, "/api/operator/control")).body.held, 2);

	for (let i = 2; i < 20; i++) appendFileSync(controlInboxFile(stateDir), `${JSON.stringify({ type: "held", id: `dc-20260928000000-${String(i).padStart(8, "0")}`, at: "2026-09-28T00:00:00Z", text: `m${i}`, ask_id: null })}\n`);
	const full = await call(port, MESSAGE, json(inbox, { kind: "message", text: "21st" }));
	assert.equal(full.status, 409);
	assert.match(String(full.body.error), /already holds 20 messages/);

	// A record whose pid is gone is offline too; one whose pid lives but whose socket is gone is a 503.
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: 2 ** 22 + 7, socket: controlSocketFile(stateDir), token: "a".repeat(64), csrf: "a".repeat(64), started_at: "2026-09-27T08:00:00Z" }));
	assert.equal((await call(port, "/api/operator/control")).body.offline, true);
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: process.pid, socket: controlSocketFile(stateDir), token: "a".repeat(64), csrf: "a".repeat(64), started_at: "2026-09-27T08:00:00Z" }));
	const gone = await call(port, MESSAGE, json("a".repeat(64), { kind: "message", text: "x" }));
	assert.equal(gone.status, 503);
	assert.match(String(gone.body.error), /session not running: .* refused the connection \((ECONNREFUSED|ENOENT)\)/);
	assert.equal(journal(stateDir).at(-1)!.status, 503);
});

const START = "/api/operator/start";

const TMUX = { via: "tmux" };
const HERDR = { via: "herdr" };

/** Start in tmux's seams: a fake absolute tmux, a real wrapper file, the env cp-daemon gives its viewer. */
function tmuxSeams(t: import("node:test").TestContext, env: NodeJS.ProcessEnv = DAEMON_VIEWER_ENV) {
	const dir = mkdtempSync(join(tmpdir(), "cp-tmux-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const wrapper = join(dir, "cp-operator");
	writeFileSync(wrapper, "#!/bin/sh\n");
	return { tmux: TMUX_BIN, wrapper, env };
}
const TMUX_BIN = "/opt/tmux/bin/tmux";
const DAEMON_VIEWER_ENV = { HOME: "/home/u", PATH: "/opt/tmux/bin:/usr/bin", CP_HOME: "/home/u/.pi-command-post", CP_MODE: "multi", CP_DAEMON_ROLE: "viewer" };

test("Start session: every refusal in order, each journaled; {via} is exactly herdr or tmux; then exactly `<tmux> new-session -d -s cp-operator <wrapper>` with the viewer's env minus CP_DAEMON_*, nothing from the request; one start per 60 s", async (t) => {
	const ran: Array<readonly string[]> = [];
	const envs: Array<NodeJS.ProcessEnv | undefined> = [];
	const seams = tmuxSeams(t);
	const { stateDir, options, port } = await setup(t, { operatorStart: { ...seams, herdr: null, run: async (argv, _timeoutMs, env) => { ran.push(argv); envs.push(env); return { status: 0, output: "" }; } } });
	const status = (await call(port, "/api/operator/control")).body;
	assert.deepEqual(status.launchers, { tmux: true, herdr: false }, "herdr binary missing: only tmux is offered");
	assert.equal(status.start_unavailable, null);
	const inbox = String(status.inbox_token);
	const refused = async (reply: Promise<Reply>, code: number, reason: RegExp) => {
		const out = await reply;
		assert.equal(out.status, code, JSON.stringify(out.body));
		assert.match(String(out.body.error), reason);
		const line = journal(stateDir).at(-1)!;
		assert.deepEqual([line.type, line.kind, line.status], ["refused", "start", code]);
		return out;
	};
	assert.equal((await call(port, START)).status, 405, "GET");
	assert.equal((await call((await setup(t, { requireTailnet: false })).port, START, json(inbox, TMUX))).status, 403, "not under --require-tailnet");
	await refused(call(port, START, json(inbox, TMUX, { origin: "https://evil.example" })), 403, /Origin must be/);
	await refused(call(port, START, json(inbox, TMUX, { "sec-fetch-site": "cross-site" })), 403, /cross-site/);
	await refused(call(port, START, json(inbox, JSON.stringify(TMUX), { "content-type": "text/plain" })), 415, /application\/json/);
	await refused(call(port, START, json(inbox, "{nope")), 400, /not JSON/);
	for (const body of [{}, { via: "screen" }, { via: "TMUX" }, { via: ["tmux"] }, { via: "tmux", unit: "evil.service" }, { argv: ["rm", "-rf"] }, ["tmux"], "tmux", null]) {
		await refused(call(port, START, json(inbox, JSON.stringify(body))), 400, /body must be \{"via": "herdr"\} or \{"via": "tmux"\}/);
	}
	await refused(call(port, START, json("b".repeat(64), TMUX)), 403, /inbox token missing or stale/);
	put(controlConfigFile(stateDir), '{"enabled": false}');
	await refused(call(port, START, json(inbox, TMUX)), 403, /dashboard control is off/);
	rmSync(controlConfigFile(stateDir));
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: process.pid, socket: controlSocketFile(stateDir), token: "a".repeat(64), csrf: "a".repeat(64), started_at: "2026-09-27T08:00:00Z" }));
	for (const body of [TMUX, HERDR]) {
		const already = await refused(call(port, START, json(inbox, body)), 409, /already running \(pid \d+\)/);
		assert.deepEqual([already.body.state, already.body.via, journal(stateDir).at(-1)!.via], ["already_running", body.via, body.via], `already_running in ${body.via}`);
	}
	rmSync(controlRecordFile(stateDir));
	assert.deepEqual(ran, [], "no refusal reached the command");

	const started = await call(port, START, json(inbox, TMUX, { "x-unit": "evil.service" }));
	assert.equal(started.status, 202);
	assert.deepEqual(started.body, { state: "starting", via: "tmux" });
	assert.deepEqual(ran, [[TMUX_BIN, "new-session", "-d", "-s", "cp-operator", seams.wrapper]], "the fixed argv, nothing from the request");
	const { CP_DAEMON_ROLE, ...rest } = DAEMON_VIEWER_ENV;
	assert.equal(CP_DAEMON_ROLE, "viewer");
	assert.deepEqual(envs, [rest], "the tmux client gets the viewer's env minus CP_DAEMON_*");
	const line = journal(stateDir).at(-1)!;
	assert.deepEqual([line.type, line.state, line.via], ["start", "starting", "tmux"], "one audit line per start, with via");
	await refused(call(port, START, json(inbox, TMUX)), 429, /one start per 60 s/);
	assert.equal(ran.length, 1);

	// A cp-operator tmux session already exists (tmux: "duplicate session"): 409 already_running, journaled.
	options.controlLimiter = new ControlLimiter();
	options.operatorStart!.lastAt = undefined;
	options.operatorStart!.run = async () => ({ status: 1, output: "duplicate session: cp-operator" });
	const duplicate = await refused(call(port, START, json(inbox, TMUX)), 409, /tmux session cp-operator already runs: tmux attach -t cp-operator/);
	assert.deepEqual([duplicate.body.state, duplicate.body.via], ["already_running", "tmux"]);
	options.operatorStart!.lastAt = undefined;
	options.operatorStart!.run = async () => ({ status: 1, output: "no server running on /tmp/tmux-1000/default\nmore" });
	const failed = await call(port, START, json(inbox, TMUX));
	assert.deepEqual([failed.status, failed.body.state], [503, "unavailable"]);
	assert.equal(failed.body.reason, `${TMUX_BIN} new-session -d exited 1: no server running on /tmp/tmux-1000/default`);
	options.operatorStart!.lastAt = undefined;

	options.controlLimiter = new ControlLimiter();
	for (let i = 0; i < 20; i++) await call(port, START, json("b".repeat(64), TMUX));
	await refused(call(port, START, json(inbox, TMUX)), 429, /too many dashboard requests/);
});

test("Start in tmux unavailable — a viewer cp-daemon does not run (legacy cp-view.service, bin/cp-view), no tmux, no wrapper — and no herdr: the status says why, the start answers unavailable and runs nothing", async (t) => {
	const { CP_DAEMON_ROLE: _role, ...notDaemon } = DAEMON_VIEWER_ENV;
	const cases = [
		{ seams: tmuxSeams(t, notDaemon), reason: /^Start in tmux needs the cp-daemon-run dashboard: rerun cp-install$/ },
		{ seams: tmuxSeams(t, { ...DAEMON_VIEWER_ENV, CP_DAEMON_ROLE: "health" }), reason: /^Start in tmux needs the cp-daemon-run dashboard/ },
		{ seams: { ...tmuxSeams(t), tmux: null }, reason: /^tmux is not on PATH: install tmux/ },
		{ seams: { ...tmuxSeams(t), wrapper: "/nonexistent/cp-operator" }, reason: /^\/nonexistent\/cp-operator is not installed: rerun cp-install$/ },
	];
	for (const { seams, reason } of cases) {
		const ran: Array<readonly string[]> = [];
		const { stateDir, port } = await setup(t, { operatorStart: { ...seams, herdr: null, run: async (argv) => { ran.push(argv); return { status: 0, output: "" }; } } });
		const status = await call(port, "/api/operator/control");
		assert.deepEqual([status.body.launchers, status.body.resume], [{ tmux: false, herdr: false }, { tmux: false, herdr: false }]);
		assert.match(String(status.body.start_unavailable), new RegExp(`${reason.source.replace(/\$$/, "")}.*; herdr is not on PATH$`));
		for (const [body, why] of [[TMUX, reason], [{ ...TMUX, resume: true }, reason], [HERDR, /^herdr is not on PATH$/]] as const) {
			const out = await call(port, START, json(String(status.body.inbox_token), body));
			assert.equal(out.status, 503, JSON.stringify(out.body));
			assert.deepEqual([out.body.state, out.body.via], ["unavailable", body.via]);
			assert.match(String(out.body.reason), why);
			const line = journal(stateDir).at(-1)!;
			assert.deepEqual([line.type, line.state, line.via], ["start", "unavailable", body.via]);
		}
		assert.deepEqual(ran, [], "nothing ran");
	}
});

test("Start in herdr: server check, then workspace create and pane run with fixed argv (≤ 10 s each, nothing from the request); server down is unavailable; a failed pane run closes the workspace; launchers cached ≤ 30 s", async (t) => {
	// A space and a quote in the wrapper path: the pane's shell must still get it as one word.
	const dir = mkdtempSync(join(tmpdir(), "cp herdr'-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const wrapper = join(dir, "cp-operator");
	writeFileSync(wrapper, "#!/bin/sh\n");
	const herdr = "/opt/herdr/bin/herdr";
	const calls: Array<{ argv: readonly string[]; timeoutMs: number }> = [];
	let server = true;
	let paneStatus = 0;
	const run = async (argv: readonly string[], timeoutMs: number) => {
		calls.push({ argv, timeoutMs });
		if (argv[1] === "status") return { status: 0, output: "", stdout: JSON.stringify({ status: server ? "running" : "stopped", running: server }) };
		if (argv[2] === "create") return { status: 0, output: "", stdout: JSON.stringify({ result: { workspace: { workspace_id: "w_7" }, root_pane: { pane_id: "p_7" } } }) };
		if (argv[2] === "run") return { status: paneStatus, output: paneStatus ? "pane p_7 is gone" : "" };
		return { status: 0, output: "" };
	};
	const { stateDir, options, port } = await setup(t, { operatorStart: { tmux: null, herdr, wrapper, run } });
	const home = resolve(options.home);
	const status = (await call(port, "/api/operator/control")).body;
	assert.deepEqual([status.launchers, status.start_unavailable], [{ tmux: false, herdr: true }, null], "herdr binary and server: offered");
	await call(port, "/api/operator/control");
	assert.equal(calls.length, 1, "the server check is cached");
	const inbox = String(status.inbox_token);

	server = false;
	options.operatorStart!.herdrChecked = undefined;
	const down = (await call(port, "/api/operator/control")).body;
	assert.deepEqual(down.launchers, { tmux: false, herdr: false });
	assert.match(String(down.start_unavailable), /herdr server not running/);
	const refused = await call(port, START, json(inbox, HERDR));
	assert.equal(refused.status, 503);
	assert.deepEqual(refused.body, { state: "unavailable", via: "herdr", reason: "herdr server not running" });
	assert.ok(!calls.some((c) => c.argv[1] === "workspace"), "server down: no workspace");

	server = true;
	calls.length = 0;
	const started = await call(port, START, json(inbox, HERDR, { "x-cwd": "/etc", "x-label": "evil" }));
	assert.equal(started.status, 202, JSON.stringify(started.body));
	assert.deepEqual(started.body, { state: "starting", via: "herdr" });
	assert.deepEqual(calls.map((c) => c.argv), [
		[herdr, "status", "server", "--json"],
		[herdr, "workspace", "create", "--cwd", home, "--label", "cp-operator", "--env", `CP_HOME=${home}`, "--no-focus"],
		[herdr, "pane", "run", "p_7", `'${wrapper.replace(/'/g, "'\\''")}'`],
	], "the fixed argv; the pane id parsed from the workspace JSON; nothing from the request");
	assert.ok(calls.every((c) => c.timeoutMs <= 10_000), "every herdr call ≤ 10 s");
	const line = journal(stateDir).at(-1)!;
	assert.deepEqual([line.type, line.state, line.via], ["start", "starting", "herdr"]);

	options.operatorStart!.lastAt = undefined;
	paneStatus = 1;
	calls.length = 0;
	const failed = await call(port, START, json(inbox, HERDR));
	assert.equal(failed.status, 503);
	assert.equal(failed.body.state, "unavailable");
	assert.match(String(failed.body.reason), /herdr pane run exited 1: pane p_7 is gone/);
	assert.deepEqual(calls.at(-1)!.argv, [herdr, "workspace", "close", "w_7"], "a failed pane run closes the workspace it created");
});

test("Resume last session: {via, resume: true} runs the wrapper with the fixed -c (tmux: `<tmux> new-session -d -s cp-operator <wrapper> -c`; herdr: typed); resume must be literally true; no wrapper is unavailable", async (t) => {
	const seams = tmuxSeams(t);
	const wrapper = seams.wrapper;
	const herdr = "/opt/herdr/bin/herdr";
	const ran: Array<readonly string[]> = [];
	const run = async (argv: readonly string[]) => {
		ran.push(argv);
		if (argv[1] === "status") return { status: 0, output: "", stdout: JSON.stringify({ running: true }) };
		if (argv[2] === "create") return { status: 0, output: "", stdout: JSON.stringify({ result: { workspace: { workspace_id: "w_1" }, root_pane: { pane_id: "p_1" } } }) };
		return { status: 0, output: "" };
	};
	const { stateDir, options, port } = await setup(t, { operatorStart: { ...seams, wrapper: "/nonexistent/cp-operator", herdr, run } });
	const before = (await call(port, "/api/operator/control")).body;
	assert.deepEqual(before.resume, { tmux: false, herdr: true }, "no wrapper: tmux resume not offered");
	const inbox = String(before.inbox_token);
	for (const body of [{ via: "tmux", resume: false }, { via: "tmux", resume: "true" }, { via: "tmux", resume: true, argv: ["-c"] }, { resume: true }]) {
		const out = await call(port, START, json(inbox, JSON.stringify(body)));
		assert.equal(out.status, 400, JSON.stringify(body));
	}
	const missing = await call(port, START, json(inbox, JSON.stringify({ via: "tmux", resume: true })));
	assert.equal(missing.status, 503);
	assert.deepEqual([missing.body.state, missing.body.resume], ["unavailable", true]);
	assert.match(String(missing.body.reason), /\/nonexistent\/cp-operator is not installed: rerun cp-install/);
	assert.deepEqual(ran.filter((argv) => argv[0] === seams.tmux), [], "nothing ran");

	options.operatorStart!.wrapper = wrapper;
	assert.deepEqual((await call(port, "/api/operator/control")).body.resume, { tmux: true, herdr: true });
	const tmux = await call(port, START, json(inbox, JSON.stringify({ via: "tmux", resume: true })));
	assert.equal(tmux.status, 202, JSON.stringify(tmux.body));
	assert.deepEqual(tmux.body, { state: "starting", via: "tmux", resume: true });
	assert.deepEqual(ran.at(-1), [seams.tmux, "new-session", "-d", "-s", "cp-operator", wrapper, "-c"], "the wrapper with the fixed -c");
	const line = journal(stateDir).at(-1)!;
	assert.deepEqual([line.type, line.state, line.via, line.resume], ["start", "starting", "tmux", true]);

	options.operatorStart!.lastAt = undefined;
	const viaHerdr = await call(port, START, json(inbox, JSON.stringify({ via: "herdr", resume: true })));
	assert.equal(viaHerdr.status, 202, JSON.stringify(viaHerdr.body));
	assert.deepEqual(ran.at(-1), [herdr, "pane", "run", "p_1", `'${wrapper}' '-c'`], "the wrapper with the fixed -c, one quoted command");

	options.operatorStart!.lastAt = undefined;
	await call(port, START, json(inbox, HERDR));
	assert.deepEqual(ran.at(-1), [herdr, "pane", "run", "p_1", `'${wrapper}'`], "a fresh start stays without -c");
});

test("herdr launch args: the pane command is one argv element herdr cannot parse flags from; the pane's shell splits it back into the exact words (--session <id> included)", () => {
	const words = ["/home/u/my home/.local/bin/cp-operator", "--session", "0198-ab'cd", "$(touch /tmp/x)"];
	const command = herdrCommand(words);
	assert.ok(!command.startsWith("-"), "never an option to herdr's own parser");
	const split = execFileSync("/bin/sh", ["-c", `for w in ${command}; do printf '%s\\n' "$w"; done`], { encoding: "utf8" });
	assert.deepEqual(split.trimEnd().split("\n"), words, "the shell gets every word verbatim, nothing expanded");
});

test("methods and read-only: no --require-tailnet refuses both routes unjournaled; GET/PUT/DELETE are 405; GETs never write and only send status frames", async (t) => {
	const plain = await setup(t, { requireTailnet: false });
	for (const reply of [await call(plain.port, MESSAGE, json("a".repeat(64), { kind: "message", text: "x" })), await call(plain.port, "/api/operator/control")]) {
		assert.equal(reply.status, 403);
		assert.match(String(reply.body.error), /--require-tailnet/);
	}
	assert.equal(journalText(plain.stateDir), "", "a refusal before the --require-tailnet guard is stderr-only");

	const { stateDir, port } = await setup(t);
	for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await call(port, MESSAGE, { method })).status, 405, method);
	for (const path of ["/api/operator/control", "/api/sessions", "/api/overview", "/api/awaiting"]) assert.equal((await call(port, path, json(null, {}))).status, 405, `POST ${path}`);
	assert.equal(journalText(stateDir), "");

	// A fake session socket: the status route sends one `status` frame and nothing else.
	const frames: Array<Record<string, unknown>> = [];
	const socketPath = controlSocketFile(stateDir);
	mkdirSync(dirname(socketPath), { recursive: true });
	const fake = createServer((socket) => socket.on("data", (chunk) => {
		for (const line of String(chunk).split("\n").filter(Boolean)) { frames.push(JSON.parse(line)); socket.write(`${JSON.stringify({ v: 1, id: 1, ok: true, result: { busy: false, pending: false, session_file: "op.jsonl", recent: [] } })}\n`); }
	}));
	await new Promise<void>((resolve) => fake.listen(socketPath, resolve));
	t.after(() => fake.close());
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: process.pid, socket: socketPath, token: "b".repeat(64), csrf: "c".repeat(64), started_at: "2026-09-27T08:00:00Z" }));
	for (let i = 0; i < 3; i++) {
		assert.equal((await call(port, "/api/operator/control")).body.token, "c".repeat(64));
		await call(port, "/api/sessions?view=you&transcript=1");
	}
	assert.deepEqual([...new Set(frames.map((f) => f.op))], ["status"]);
	assert.equal(journalText(stateDir), "", "status and transcript GETs leave the journal byte-identical");
});

test("an unwritable journal never hides a refusal: the status stands and the body says the audit line is unwritten", async (t) => {
	const { stateDir, port } = await setup(t);
	mkdirSync(controlJournalFile(stateDir), { recursive: true }); // a directory where the journal should be
	put(controlConfigFile(stateDir), '{"enabled": false}');
	const out = await call(port, MESSAGE, json("a".repeat(64), { kind: "message", text: "x" }));
	assert.equal(out.status, 403);
	assert.match(String(out.body.audit), /^unwritten: /);
});


test("queued send status is journal-backed across reload/session restart, with text, attachments, tags, late failure and inbox drop", async t=>{
 const {stateDir,port}=await setup(t);
 const {csrf}=await bridge(t,stateDir);
 const client_id="dc-20261004140000-00000009";
 const accepted=await call(port,MESSAGE,json(csrf,{kind:"message",text:"keep the queued text",thread:"layout",client_id}));
 assert.equal(accepted.body.id,client_id,"the transcript marker can match before the POST acknowledgement");
 assert.equal((await call(port,MESSAGE,json(csrf,{kind:"message",text:"duplicate",client_id}))).status,409);
 assert.equal((await call(port,MESSAGE,json(csrf,{kind:"message",text:"invalid",client_id:"not-an-id"}))).status,400);
 const queued=(await call(port,"/api/operator/control")).body.sends as Array<Record<string,unknown>>;
 assert.equal(queued.length,1);
 assert.deepEqual(queued[0]!.body,{kind:"message",text:"keep the queued text",thread:"layout"});
 assert.equal(queued[0]!.id,accepted.body.id);
 const id="dc-20261004140000-00000001", image="im-20261004-0123456789abcdef01234567.png";
 appendFileSync(controlJournalFile(stateDir),[
  {type:"request",by:"bridge",id,at:"2026-10-04T14:00:00Z",kind:"message",text:"attached",images:[image],thread:"images",ask_id:null,deliver:"followUp",peer:null},
  {type:"outcome",by:"bridge",id,at:"2026-10-04T14:00:01Z",state:"queued",reason:null},
  {type:"outcome",by:"bridge",id,at:"2026-10-04T14:00:02Z",state:"failed",reason:"late rejection"},
 ].map(line=>JSON.stringify(line)).join("\n")+"\n");
 const heldId="dc-20261004140100-00000002";
 put(controlInboxFile(stateDir),[
  {type:"held",id:heldId,at:"2026-10-04T14:01:00Z",text:"while offline",ask_id:null,thread:"offline"},
  {type:"dropped",id:heldId,at:"2026-10-05T14:02:00Z",reason:"held longer than 24 h"},
 ].map(line=>JSON.stringify(line)).join("\n")+"\n");
 // A restarted/offline session has no recent outcomes; the persisted queue and failure still reconstruct.
 rmSync(controlRecordFile(stateDir));
 const recovered=(await call(port,"/api/operator/control")).body;
 assert.deepEqual(recovered.recent,[]);
 const sends=recovered.sends as Array<Record<string,unknown>>;
 const failed=sends.find(send=>send.id === id)!;
 assert.deepEqual([failed.state,failed.reason],["failed","late rejection"]);
 assert.deepEqual(failed.body,{kind:"message",text:"attached",deliver:"followUp",images:[image],thread:"images"});
 assert.deepEqual(sends.find(send=>send.id === heldId)?.state,"failed","dropped held sends remain visible failures");
 assert.equal(recovered.sends_error,null);
 appendFileSync(controlJournalFile(stateDir),'{"torn":');
 assert.equal((await call(port,"/api/operator/control")).body.sends_error,null,"torn final line waits for its newline");
 appendFileSync(controlJournalFile(stateDir),"\n");
 assert.match(String((await call(port,"/api/operator/control")).body.sends_error),/invalid journal line/);
 const forbidden=await call((await setup(t,{requireTailnet:false})).port,"/api/operator/control");
 assert.equal(forbidden.status,403);assert.equal(forbidden.body.sends,undefined,"text stays behind the same tailnet guard");
});
