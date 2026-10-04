/**
 * Restart session (cp-aqxl), the viewer's half: `POST /api/operator/restart` in its refusal order against the real
 * bridge socket, the status it reports, an older bridge mapped to `unsupported`, and the viewer holding no process
 * control at all (it forwards one frame; the session stops itself, its cp-operator relaunches it).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../src/dashboard-control.ts";
import { RESTART_UNSUPPORTED } from "../src/dashboard-restart.ts";
import { controlRecordFile, controlSocketFile, readControlRecord } from "../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../src/viewer/push-files.ts";
import { OPERATOR_RESTART_PATH, RESTART_PREDATES } from "../src/viewer/restart-status.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const ORIGIN = "https://cp.example.ts.net";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

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
const post = (token: string | null, body: unknown) => ({
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
	headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}) },
});

async function setup(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	put(pushConfigFile(pushDataDir(stateDir)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-01-01T00:00:00Z" }));
	const session = join(home.path, "2026-01-01T00-00-00-000Z_0123abcd.jsonl");
	writeFileSync(session, "");
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return { stateDir, session, port: options.port };
}

async function bridge(t: import("node:test").TestContext, stateDir: string, ports: ControlPorts) {
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {} }) as DashboardControl;
	assert.equal(control.state, "listening");
	t.after(() => control.stop());
	const record = readControlRecord(stateDir);
	assert.equal(record.state, "ok");
	return (record as { record: { csrf: string } }).record.csrf;
}

test("restart route: body, offline, token in order; the bridge's refusal passes through and leaves the 60 s window free; accepted is 202, then 429 with retry-after", async (t) => {
	const { stateDir, session, port } = await setup(t);
	const offline = await call(port, OPERATOR_RESTART_PATH, post("x".repeat(64), { restart: true }));
	assert.deepEqual([offline.status, offline.body.state], [409, "offline"]);

	const state = { idle: false, shutdowns: 0 };
	const csrf = await bridge(t, stateDir, {
		inject: () => {}, abort: () => {}, isIdle: () => state.idle, hasPendingMessages: () => false, sessionFile: () => session,
		shutdown: () => { state.shutdowns += 1; }, relaunchFile: () => join(stateDir, "operator", "relaunch.json"), parentSends: () => ({ ids: [], error: null }),
	});
	for (const body of [{}, { restart: "yes" }, { restart: true, extra: 1 }, "[]"]) assert.equal((await call(port, OPERATOR_RESTART_PATH, post(csrf, body))).status, 400, JSON.stringify(body));
	assert.equal((await call(port, OPERATOR_RESTART_PATH, post(null, { restart: true }))).status, 403);
	assert.equal((await call(port, OPERATOR_RESTART_PATH, post("0".repeat(64), { restart: true }))).status, 403);
	assert.equal((await call(port, OPERATOR_RESTART_PATH, { method: "GET" })).status, 405);

	const status = await call(port, "/api/operator/control");
	assert.deepEqual(status.body.restart, { supported: true, blockers: ["the session is busy with a turn"], reason: "not now: the session is busy with a turn" });
	assert.equal(typeof status.body.session_started_at, "string", "the page tells a relaunched session from the old one");

	const busy = await call(port, OPERATOR_RESTART_PATH, post(csrf, { restart: true }));
	assert.deepEqual([busy.status, busy.body], [409, { state: "refused", error: "not now: the session is busy with a turn" }]);
	state.idle = true;
	const accepted = await call(port, OPERATOR_RESTART_PATH, post(csrf, { restart: true }));
	assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
	assert.deepEqual({ ...accepted.body, id: undefined }, { state: "restarting", id: undefined, session_file: "2026-01-01T00-00-00-000Z_0123abcd.jsonl" });
	const again = await call(port, OPERATOR_RESTART_PATH, post(csrf, { restart: true }));
	assert.equal(again.status, 429);
	assert.match(String(again.headers["retry-after"]), /^\d+$/);
	await new Promise((done) => setTimeout(done, 150));
	assert.equal(state.shutdowns, 1, "one accepted restart, one shutdown");
});

test("restart route: a bridge without restart ports is 409 unsupported with the manual way, and its status says so", async (t) => {
	const { stateDir, session, port } = await setup(t);
	const csrf = await bridge(t, stateDir, { inject: () => {}, abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => session });
	const plain = await call(port, OPERATOR_RESTART_PATH, post(csrf, { restart: true }));
	assert.deepEqual([plain.status, plain.body], [409, { state: "refused", error: `unsupported: ${RESTART_UNSUPPORTED}` }]);
	const status = await call(port, "/api/operator/control");
	assert.deepEqual(status.body.restart, { supported: false, blockers: [], reason: RESTART_UNSUPPORTED });
});

test("restart route: an older bridge answering `unknown op restart` is 409 unsupported, and its status (no restart field) reads unsupported", async (t) => {
	const { stateDir, port } = await setup(t);
	const socketFile = controlSocketFile(stateDir);
	mkdirSync(dirname(socketFile), { recursive: true });
	const token = randomBytes(32).toString("hex");
	const csrf = randomBytes(32).toString("hex");
	const old = createServer((socket) => socket.on("data", (chunk) => {
		const frame = JSON.parse(String(chunk).trim()) as { id: number; op: string };
		socket.end(`${JSON.stringify(frame.op === "status" ? { id: frame.id, ok: true, result: { busy: false, pending: false, session_file: "x.jsonl", recent: [] } } : { id: frame.id, ok: false, status: 400, error: `unknown op ${frame.op}` })}\n`);
	}));
	await new Promise<void>((resolve) => old.listen(socketFile, resolve));
	t.after(() => old.close());
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: process.pid, socket: socketFile, token, csrf, started_at: "2026-01-01T00:00:00.000Z" }));
	const reply = await call(port, OPERATOR_RESTART_PATH, post(csrf, { restart: true }));
	assert.deepEqual([reply.status, reply.body], [409, { state: "refused", error: `unsupported: ${RESTART_PREDATES}` }]);
	const status = await call(port, "/api/operator/control");
	assert.deepEqual(status.body.restart, { supported: false, blockers: [], reason: RESTART_PREDATES });
});

test("the viewer has no process control: the restart route and page code import no child_process and never spawn, exec, kill or reach tmux/herdr", () => {
	const files = ["src/viewer/operator-restart.ts", "src/viewer/restart-status.ts", "viewer-app/restart-control.ts", "viewer-app/use-restart.ts", "viewer-app/components/RestartSession.tsx"];
	for (const file of files) {
		const code = readFileSync(join(REPO_ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
		for (const banned of [/child_process/, /\bspawn\w*\(/, /\bexec\w*\(/, /\.kill\(/, /process\.kill/, /launchers/, /herdrCommand|tmuxCommand/, /\.(tmux|herdr)\b/]) assert.doesNotMatch(code, banned, `${file}: ${banned}`);
	}
});
