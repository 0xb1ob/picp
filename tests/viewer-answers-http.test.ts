/**
 * cp-mxk4 PR2, the viewer's half: `POST /api/answers/ack` refuses in the dashboard-control order and then its own (shape,
 * token, known id, not yet acknowledged), journals each refusal once as kind `answer_ack`, answers 202 only after its `acked`
 * line is on disk and touches nothing else; `GET /api/answers/control` is --require-tailnet only; `/api/decisions` projects it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { ControlLimiter } from "../src/viewer/control-api.ts";
import { appendAnswerLine } from "../src/viewer/control-audit.ts";
import { controlConfigFile, controlJournalFile, operatorAnswersFile } from "../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../src/viewer/push-files.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { createScratchHome } from "./harness/index.ts";

const ORIGIN = "https://cp.example.ts.net";
const ACK = "/api/answers/ack";
const STATUS = "/api/answers/control";
const A = "ans-aaaaaaaaaaaa";
const B = "ans-bbbbbbbbbbbb";
const C = "ans-cccccccccccc";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const lines = (file: string): Array<Record<string, unknown>> => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

interface Reply { status: number; body: Record<string, unknown> }
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => { let body: Record<string, unknown> = {}; try { body = JSON.parse(text); } catch { body = { raw: text }; } resolve({ status: res.statusCode ?? 0, body }); });
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

const posted = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ type: "posted", by: "bridge", id, at, project: "demo", question: `question ${id}`, answer: `short ${id}\n\nlong ${id}`, evidence_paths: [], job_id: null, ...extra }) as never;

async function setup(t: import("node:test").TestContext, viewer: Partial<ViewerOptions> = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	put(pushConfigFile(pushDataDir(stateDir)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-09-27T08:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { herdr: null }, ...viewer };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return { stateDir, options, port: options.port };
}

const json = (token: string | null, body: unknown, extra: Record<string, string> = {}) => ({
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
	headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});

test("every ack refusal, in order, is one viewer line of kind answer_ack and never an acked line", async (t) => {
	const { stateDir, options, port } = await setup(t);
	const journal = operatorAnswersFile(stateDir);
	appendAnswerLine(stateDir, posted(A, "2026-07-01T00:00:00Z"));
	appendAnswerLine(stateDir, { type: "acked", by: "viewer", id: B, at: "2026-07-01T00:00:01Z", peer: null });
	appendAnswerLine(stateDir, posted(B, "2026-07-01T00:00:02Z"));
	appendAnswerLine(stateDir, { type: "acked", by: "viewer", id: B, at: "2026-07-01T00:00:03Z", peer: null });
	const token = String((await call(port, STATUS)).body.token);
	assert.match(token, /^[0-9a-f]{64}$/);
	const audit = controlJournalFile(stateDir);
	const acks = () => lines(journal).filter((l) => l.type === "acked").length;
	const baseline = acks();
	const refused = async (reply: Promise<Reply>, status: number, reason: RegExp, fields: Record<string, unknown> = {}) => {
		options.controlLimiter = new ControlLimiter();
		const before = lines(audit).length;
		const out = await reply;
		assert.equal(out.status, status, JSON.stringify(out.body));
		assert.match(String(out.body.error), reason);
		const after = lines(audit);
		assert.equal(after.length, before + 1, `one audit line for ${status} ${reason}`);
		const line = after.at(-1)!;
		assert.deepEqual({ type: line.type, by: line.by, kind: line.kind, status: line.status, peer: line.peer }, { type: "refused", by: "viewer", kind: "answer_ack", status, peer: "127.0.0.1" });
		for (const [key, value] of Object.entries(fields)) assert.deepEqual(line[key], value, key);
		assert.equal(acks(), baseline, "no refusal writes an acked line");
	};
	const body = { id: A };
	assert.equal((await call(port, ACK)).status, 405);
	assert.equal(lines(audit).length, 0, "405 is not journaled");
	options.controlLimiter = new ControlLimiter();
	for (let i = 0; i < 20; i++) await call(port, ACK, json(null, "{"));
	assert.equal((await call(port, ACK, json(token, body))).status, 429);
	assert.equal(lines(audit).at(-1)!.status, 429);
	rmSync(audit);

	put(controlConfigFile(stateDir), '{"enabled": false}');
	await refused(call(port, ACK, json(token, body)), 403, /dashboard control is off/);
	rmSync(controlConfigFile(stateDir));
	await refused(call(port, ACK, json(token, body, { origin: "https://evil.example" })), 403, /Origin must be/);
	await refused(call(port, ACK, json(token, body, { "sec-fetch-site": "cross-site" })), 403, /cross-site/);
	await refused(call(port, ACK, json(token, body, { "content-type": "text/plain" })), 415, /application\/json/);
	await refused(call(port, ACK, json(token, { id: A, pad: "z".repeat(21 * 1024) })), 413, /20480 bytes/);
	await refused(call(port, ACK, json(token, "{not json")), 400, /not JSON/);
	await refused(call(port, ACK, json(token, { id: "ans-../x" })), 400, /body must be/, { answer_id: undefined });
	await refused(call(port, ACK, json(token, { id: A, extra: 1 })), 400, /body must be/, { answer_id: A });
	await refused(call(port, ACK, json(null, body)), 403, /control token missing or stale/, { answer_id: A });
	await refused(call(port, ACK, json("f".repeat(64), body)), 403, /control token missing or stale/);
	await refused(call(port, ACK, json(token, { id: C })), 404, /no answer ans-cccccccccccc/);
	await refused(call(port, ACK, json(token, { id: B })), 409, /already acknowledged at 2026-07-01T00:00:03Z/);
});

test("a 202 exists only with its acked line; the item moves to history; no ask, escalation or push file is touched", async (t) => {
	const { stateDir, port } = await setup(t);
	const journal = operatorAnswersFile(stateDir);
	appendAnswerLine(stateDir, posted(A, "2026-07-01T00:00:00Z"));
	appendAnswerLine(stateDir, posted(B, "2026-07-01T00:00:05Z"));
	const before = (await call(port, "/api/decisions")).body.answers as { open: Array<{ id: string }>; open_count: number; history: unknown[] };
	assert.deepEqual(before.open.map((a) => a.id), [B, A], "open is newest first");
	assert.equal(existsSync(controlJournalFile(stateDir)), false);

	const status = await call(port, STATUS);
	assert.deepEqual([status.status, status.body.enabled, status.body.reason], [200, true, null]);
	assert.equal(lines(journal).length, 2, "the status route never writes");
	const sent = await call(port, ACK, json(String(status.body.token), { id: A }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual([sent.body.id, sent.body.state], [A, "acked"]);
	const ack = lines(journal).filter((l) => l.type === "acked");
	assert.equal(ack.length, 1);
	assert.deepEqual([ack[0]?.by, ack[0]?.id, ack[0]?.peer, ack[0]?.at], ["viewer", A, "127.0.0.1", sent.body.acked_at]);
	assert.equal(lines(journal).length, 3, "append-only: the posted line stays");

	const after = (await call(port, "/api/decisions")).body.answers as { open: Array<{ id: string }>; open_count: number; history: Array<{ id: string; acked_at: string }>; history_total: number };
	assert.deepEqual([after.open.map((a) => a.id), after.open_count, after.history.map((a) => a.id), after.history_total], [[B], 1, [A], 1]);
	assert.equal(after.history[0]?.acked_at, sent.body.acked_at);
	assert.equal((await call(port, ACK, json(String(status.body.token), { id: A }))).status, 409);

	for (const file of [join(stateDir, "operator", "asks.jsonl"), join(stateDir, "escalations.json"), join(stateDir, "push-deliveries.json"), join(stateDir, "operator", "inbox.jsonl")]) assert.equal(existsSync(file), false, file);

	put(controlConfigFile(stateDir), '{"enabled": false}');
	const off = await call(port, STATUS);
	assert.deepEqual([off.body.enabled, off.body.token], [false, null], "off: no token");
	assert.match(String(off.body.reason), /^Dashboard control is off/);
	assert.equal(((await call(port, "/api/decisions")).body.answers as { open_count: number }).open_count, 1, "the list still renders read-only");
});

test("projection: board and run evidence resolve to links, the rest is plain; short, clip, warning and availability", async (t) => {
	const { stateDir, port } = await setup(t);
	const decisions = async () => (await call(port, "/api/decisions")).body.answers as Record<string, unknown> & { open: Array<Record<string, unknown>> };
	assert.deepEqual(await decisions(), { availability: "missing", open: [], open_count: 0, history: [], history_total: 0, warning: null });

	put(join(stateDir, "boards", "alpha", "board.json"), JSON.stringify({ title: "Alpha", created_at: "2026-09-01T00:00:00Z" }));
	put(join(stateDir, "boards", "alpha", "site", "index.html"), "<h1>Alpha</h1>");
	const long = `${"word ".repeat(100)}end\nsecond line\n\nsecond paragraph`;
	appendAnswerLine(stateDir, posted(A, "2026-07-01T00:00:00Z", { answer: long, evidence_paths: [`${stateDir}/boards/alpha/index.html`, "/nowhere/else.md"], job_id: "cp-demo" }));
	appendAnswerLine(stateDir, posted(B, "2026-07-01T00:00:01Z", { answer: "see https://example.com/x and javascript:alert(1)" }));
	appendFileGarbage(operatorAnswersFile(stateDir));
	const view = await decisions();
	assert.equal(view.availability, "ok");
	assert.match(String(view.warning), /^1 unreadable line\(s\)/);
	const item = view.open.find((o) => o.id === A)!;
	const short = String(item.short);
	assert.equal(short.length, 281);
	assert.ok(short.endsWith("…"));
	assert.ok(!short.includes("second"), "short is the first paragraph only");
	assert.equal(item.answer, long, "the full answer is kept");
	assert.deepEqual(item.evidence, [{ path: `${stateDir}/boards/alpha/index.html`, href: "#reports", read: "/boards/alpha/" }, { path: "/nowhere/else.md", href: null, read: null }]);
	assert.deepEqual(item.job, { id: "cp-demo", href: "#job/cp-demo", read: null });

	rmSync(operatorAnswersFile(stateDir));
	mkdirSync(operatorAnswersFile(stateDir));
	assert.deepEqual(await decisions(), { availability: "unavailable", open: [], open_count: null, history: [], history_total: null, warning: "Answers unavailable" });
});

function appendFileGarbage(file: string) { writeFileSync(file, `${readFileSync(file, "utf8")}not json\n`); }

test("without --require-tailnet both routes are 403 and nothing is journaled", async (t) => {
	const { stateDir, port } = await setup(t, { requireTailnet: false });
	assert.equal((await call(port, STATUS)).status, 403);
	assert.equal((await call(port, ACK, json("x", { id: A }))).status, 403);
	assert.equal(existsSync(controlJournalFile(stateDir)), false);
	assert.equal(existsSync(operatorAnswersFile(stateDir)), false);
});
