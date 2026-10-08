/**
 * cp-7bsr PR2, the viewer's half of Settings: `GET /api/settings`, `POST /api/settings/apply` and
 * `POST /api/settings/restore` against the real bridge socket and the real `settingsPorts`. The refusal order, one
 * `refused` line (kind `settings`) per viewer refusal, the session's outcomes passed through with no viewer line,
 * an older bridge mapped to `unsupported`, and an apply → restore round trip on `data/gate.json`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../src/dashboard-control.ts";
import { settingsPorts } from "../src/settings-control.ts";
import { controlConfigFile, controlJournalFile, controlRecordFile, controlSocketFile, readControlRecord } from "../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../src/viewer/push-files.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { SETTINGS_APPLY_PATH, SETTINGS_PATH, SETTINGS_RESTORE_PATH } from "../src/viewer/settings-api.ts";
import { createScratchHome } from "./harness/index.ts";

const ORIGIN = "https://cp.example.ts.net";
const REQUEST_ID = "req-12345678";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const journal = (stateDir: string): Array<Record<string, unknown>> => existsSync(controlJournalFile(stateDir)) ? readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; text: string }
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => { let body: Record<string, unknown> = {}; try { body = JSON.parse(text); } catch { body = { raw: text }; } resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text }); });
		});
		req.on("error", reject);
		req.end(options.body);
	});
}
const post = (token: string | null, body: unknown, revision: string | null, headers: Record<string, string> = {}) => ({
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
	headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...(revision ? { "if-match": `"${revision}"` } : {}), ...headers },
});

async function setup(t: TestContext, requireTailnet = true) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	put(pushConfigFile(pushDataDir(stateDir)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-01-01T00:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet, log: () => {}, operatorStart: { tmux: null, herdr: null } };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return { home: home.path, stateDir, port: options.port };
}

const basePorts = (): ControlPorts => ({ inject: () => {}, abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => undefined });

async function bridge(t: TestContext, home: string, stateDir: string, withSettings = true): Promise<string> {
	const ports = withSettings ? { ...basePorts(), ...settingsPorts({ target: () => ({ home, mode: "multi" }), env: {} }) } : basePorts();
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {} }) as DashboardControl;
	assert.equal(control.state, "listening");
	t.after(() => control.stop());
	return (readControlRecord(stateDir) as { record: { csrf: string } }).record.csrf;
}

async function journaled(stateDir: string, send: () => Promise<Reply>): Promise<{ reply: Reply; lines: Array<Record<string, unknown>> }> {
	const before = journal(stateDir).length;
	const reply = await send();
	return { reply, lines: journal(stateDir).slice(before) };
}
function oneRefused(result: { reply: Reply; lines: Array<Record<string, unknown>> }, status: number, label: string): void {
	assert.equal(result.reply.status, status, `${label}: ${JSON.stringify(result.reply.body)}`);
	assert.deepEqual(result.lines.map((line) => [line.type, line.by, line.kind, line.status, line.reason]), [["refused", "viewer", "settings", status, result.reply.body.error]], label);
}

test("settings write routes: the refusal order, each viewer refusal one refused line of kind settings", async (t) => {
	const { home, stateDir, port } = await setup(t);
	const revision = "a".repeat(64);
	const apply = (token: string | null, body: unknown, rev: string | null = revision, headers: Record<string, string> = {}) => () => call(port, SETTINGS_APPLY_PATH, post(token, body, rev, headers));
	const good = { changes: { "review.timeout_ms": 60_000 }, request_id: REQUEST_ID };

	const get = await journaled(stateDir, () => call(port, SETTINGS_APPLY_PATH));
	assert.equal(get.reply.status, 405);
	assert.deepEqual(get.lines, [], "the method check precedes the journal");
	oneRefused(await journaled(stateDir, apply(null, good, revision, { origin: "https://evil.example" })), 403, "origin");
	oneRefused(await journaled(stateDir, apply(null, good, revision, { "sec-fetch-site": "cross-site" })), 403, "sec-fetch-site");
	oneRefused(await journaled(stateDir, apply(null, good, revision, { "content-type": "text/plain" })), 415, "content type");
	oneRefused(await journaled(stateDir, apply(null, { ...good, pad: "x".repeat(30_000) })), 413, "size");
	for (const body of [{}, { ...good, extra: 1 }, { changes: {}, request_id: REQUEST_ID }, { ...good, request_id: "x" }, { ...good, dry_run: "yes" }, "[]"]) {
		oneRefused(await journaled(stateDir, apply(null, body)), 400, JSON.stringify(body));
	}
	for (const body of [{ request_id: REQUEST_ID }, { keys: ["review.timeout_ms"], all: true, request_id: REQUEST_ID }, { changes: { a: 1 }, request_id: REQUEST_ID }]) {
		oneRefused(await journaled(stateDir, () => call(port, SETTINGS_RESTORE_PATH, post(null, body, revision))), 400, `restore ${JSON.stringify(body)}`);
	}
	oneRefused(await journaled(stateDir, apply(null, good, null)), 428, "missing If-Match");
	oneRefused(await journaled(stateDir, apply(null, good, null, { "if-match": "W/\"abc\"" })), 400, "malformed If-Match");
	const offline = await journaled(stateDir, apply(null, good));
	oneRefused(offline, 409, "offline");
	assert.equal(offline.reply.body.state, "offline");
	const dryOffline = await journaled(stateDir, apply(null, { ...good, dry_run: true }, null));
	oneRefused(dryOffline, 409, "a dry run needs no If-Match, but still the session");

	await bridge(t, home, stateDir);
	oneRefused(await journaled(stateDir, apply(null, good)), 403, "no token");
	oneRefused(await journaled(stateDir, apply("0".repeat(64), good)), 403, "stale token");

	const closed = await setup(t, false);
	const refused = await journaled(closed.stateDir, () => call(closed.port, SETTINGS_APPLY_PATH, post(null, good, revision)));
	assert.equal(refused.reply.status, 403);
	assert.deepEqual(refused.lines, [], "the --require-tailnet guard precedes the journal");
	assert.equal((await call(closed.port, SETTINGS_PATH)).status, 403);
});

test("settings write routes: the session's outcomes pass through with no viewer line; apply → restore round trip on data/gate.json; GET reads the snapshot without secrets", async (t) => {
	const { home, stateDir, port } = await setup(t);
	const gate = join(home, LAYOUT.gateConfigFile);
	writeFileSync(gate, JSON.stringify({ schema_version: 1 }));
	writeFileSync(join(home, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://secret-gateway.example/", path: "/v1/secret-path" }));
	const csrf = await bridge(t, home, stateDir);
	const status = await call(port, SETTINGS_PATH);
	assert.equal(status.status, 200);
	assert.deepEqual([status.body.enabled, status.body.running, status.body.supported, status.body.writable], [true, true, true, true]);
	assert.equal((status.body.catalog as unknown[]).length, 31);
	for (const secret of ["secret-gateway", "/v1/secret-path", home]) assert.ok(!status.text.includes(secret), `GET leaks ${secret}`);
	const revision = (status.body.snapshot as { revision: string }).revision;

	const pass = async (path: string, body: unknown, rev: string | null, want: number) => {
		const result = await journaled(stateDir, () => call(port, path, post(csrf, body, rev)));
		assert.equal(result.reply.status, want, JSON.stringify(result.reply.body));
		assert.deepEqual(result.lines, [], "the session's outcome is its own audit's, not a viewer line");
		return result.reply.body;
	};
	const preview = await pass(SETTINGS_APPLY_PATH, { changes: { "review.timeout_ms": 60_000 }, request_id: REQUEST_ID, dry_run: true }, null, 200);
	assert.equal(preview.state, "planned");
	assert.deepEqual(JSON.parse(readFileSync(gate, "utf8")), { schema_version: 1 }, "a dry run writes nothing");
	const applied = await pass(SETTINGS_APPLY_PATH, { changes: { "review.timeout_ms": 60_000 }, request_id: REQUEST_ID }, revision, 200);
	assert.equal(applied.state, "applied");
	assert.deepEqual(JSON.parse(readFileSync(gate, "utf8")), { schema_version: 1, review_timeout_ms: 60_000 });
	const stale = await pass(SETTINGS_RESTORE_PATH, { keys: ["review.timeout_ms"], request_id: REQUEST_ID }, revision, 412);
	assert.equal(stale.revision, applied.revision);
	await pass(SETTINGS_APPLY_PATH, { changes: { "models.allow": [] }, request_id: REQUEST_ID }, applied.revision as string, 403);
	await pass(SETTINGS_APPLY_PATH, { changes: { "sessions.tool_call_cap": 5 }, request_id: REQUEST_ID }, applied.revision as string, 403);
	await pass(SETTINGS_APPLY_PATH, { changes: { "review.timeout_ms": 1 }, request_id: REQUEST_ID }, applied.revision as string, 400);
	const restored = await pass(SETTINGS_RESTORE_PATH, { section: "review", request_id: REQUEST_ID }, applied.revision as string, 200);
	assert.equal(restored.state, "applied");
	assert.deepEqual(JSON.parse(readFileSync(gate, "utf8")), { schema_version: 1 });
	const audit = (await call(port, SETTINGS_PATH)).body.audit as Array<{ type: string; actor?: string; peer?: string }>;
	assert.deepEqual(audit.map((line) => line.type), ["intent", "applied", "refused", "refused", "refused", "refused", "intent", "applied"]);
	assert.equal(audit[0]!.peer, "127.0.0.1");
});

test("settings: an older bridge (`unknown op`) is 409 unsupported with one refused line, and GET reports supported:false", async (t) => {
	const { stateDir, port } = await setup(t);
	const socketFile = controlSocketFile(stateDir);
	mkdirSync(dirname(socketFile), { recursive: true });
	const csrf = randomBytes(32).toString("hex");
	const old = createServer((socket) => socket.on("data", (chunk) => {
		const frame = JSON.parse(String(chunk).trim()) as { id: number; op: string };
		socket.end(`${JSON.stringify({ id: frame.id, ok: false, status: 400, error: `unknown op ${frame.op}` })}\n`);
	}));
	await new Promise<void>((resolve) => old.listen(socketFile, resolve));
	t.after(() => old.close());
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: process.pid, socket: socketFile, token: randomBytes(32).toString("hex"), csrf, started_at: "2026-01-01T00:00:00.000Z" }));
	const reply = await journaled(stateDir, () => call(port, SETTINGS_RESTORE_PATH, post(csrf, { all: true, request_id: REQUEST_ID }, "b".repeat(64))));
	oneRefused(reply, 409, "unknown op");
	assert.equal(reply.reply.body.state, "refused");
	assert.match(String(reply.reply.body.error), /^unsupported: .*restart the operator session to load Settings/);
	const status = await call(port, SETTINGS_PATH);
	assert.deepEqual([status.body.enabled, status.body.running, status.body.supported, status.body.writable, status.body.snapshot], [true, true, false, false, null]);
	assert.match(String(status.body.reason), /restart the operator session to load Settings/);
});

test("GET /api/settings: offline is running:false with no snapshot; dashboard control off is enabled:false", async (t) => {
	const { stateDir, port } = await setup(t);
	const offline = await call(port, SETTINGS_PATH);
	assert.equal(offline.status, 200);
	assert.deepEqual([offline.body.enabled, offline.body.running, offline.body.snapshot, offline.body.catalog, offline.body.audit], [true, false, null, null, []]);
	assert.match(String(offline.body.reason), /^Operator session offline/);
	put(controlConfigFile(stateDir), JSON.stringify({ enabled: false }));
	const off = await call(port, SETTINGS_PATH);
	assert.deepEqual([off.status, off.body.enabled, off.body.running, off.body.snapshot], [200, false, false, null]);
});
