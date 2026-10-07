/**
 * cp-xmw2 S4, the viewer's thread routes: `GET /api/threads` lists threads with their derived state (waiting, done,
 * open) and is --require-tailnet only; `POST /api/threads/done` refuses in the dashboard-control order and then its own
 * (shape, token, journal, known, asks/answers readable, not waiting, not done), journals each refusal as kind
 * `thread_done`, and answers 202 only with its `done` line on disk. Tagged sends forward the normalized thread
 * to the session marker and file the returned (or held) dc- id in state/operator/threads.jsonl.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { ControlLimiter } from "../src/viewer/control-api.ts";
import { appendAnswerLine, appendThreadLine } from "../src/viewer/control-audit.ts";
import { type AnswerLine, controlConfigFile, controlInboxFile, controlJournalFile, controlRecordFile, controlSocketFile, operatorThreadsFile, type ThreadLine } from "../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../src/viewer/push-files.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { createScratchHome } from "./harness/index.ts";

const ORIGIN = "https://cp.example.ts.net";
const LIST = "/api/threads";
const DONE = "/api/threads/done";
const MESSAGE = "/api/operator/message";
const [ALPHA, BETA, GAMMA, DELTA, EPS] = ["a", "b", "c", "d", "e"].map((c) => `th-${c.repeat(12)}`) as [string, string, string, string, string];
const DC1 = "dc-20261006080000-89abcdef";
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
const json = (token: string | null, body: unknown, extra: Record<string, string> = {}) => ({
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
	headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});

async function setup(t: import("node:test").TestContext, viewer: Partial<ViewerOptions> = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	put(pushConfigFile(pushDataDir(stateDir)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-09-27T08:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null }, ...viewer };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return { stateDir, options, port: options.port };
}

const open = (id: string, tag: string, at: string): ThreadLine => ({ type: "open", by: "viewer", id, at, tag, peer: null });
const bind = (thread: string, kind: "dashboard" | "ask" | "answer" | "job", id: string, at: string): ThreadLine => ({ type: "bind", by: "bridge", at, thread, ref: { kind, id }, peer: null });
const done = (id: string, at: string): ThreadLine => ({ type: "done", by: "viewer", id, at, peer: null });

/** alpha waits on an open ask; beta on an unacknowledged answer; gamma's refs are settled (open); delta is done; eps was done, then a bind reopened it. */
function fixture(stateDir: string) {
	put(join(stateDir, "operator", "asks.jsonl"), [
		{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: "2026-10-06T08:00:00Z", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] },
		{ type: "open", id: "ask-dddd", project: "demo", question: "Merge?", created_at: "2026-10-06T08:00:00Z", recommendation: "Yes", options: [{ label: "Yes", consequence: "Merges" }] },
		{ type: "answer", id: "ask-dddd", answer: "Yes", answered_at: "2026-10-06T08:05:00Z" },
	].map((e) => JSON.stringify(e)).join("\n") + "\n");
	const posted = (id: string): AnswerLine => ({ type: "posted", by: "bridge", id, at: "2026-10-06T08:00:00Z", project: "demo", question: "q", answer: "a", evidence_paths: [], job_id: null });
	appendAnswerLine(stateDir, posted("ans-aaaaaaaaaaaa"));
	appendAnswerLine(stateDir, { type: "acked", by: "viewer", id: "ans-aaaaaaaaaaaa", at: "2026-10-06T08:01:00Z", peer: null });
	appendAnswerLine(stateDir, posted("ans-bbbbbbbbbbbb"));
	for (const line of [
		open(ALPHA, "alpha", "2026-10-06T08:00:00Z"), bind(ALPHA, "ask", "ask-abcd", "2026-10-06T08:00:01Z"),
		open(BETA, "beta", "2026-10-06T08:00:00Z"), bind(BETA, "dashboard", DC1, "2026-10-06T08:00:02Z"), bind(BETA, "answer", "ans-bbbbbbbbbbbb", "2026-10-06T08:00:03Z"),
		open(GAMMA, "gamma", "2026-10-06T08:00:00Z"), bind(GAMMA, "ask", "ask-dddd", "2026-10-06T08:00:04Z"), bind(GAMMA, "answer", "ans-aaaaaaaaaaaa", "2026-10-06T08:00:05Z"),
		open(DELTA, "delta", "2026-10-06T08:00:00Z"), bind(DELTA, "dashboard", "dc-20261006080000-00000001", "2026-10-06T08:00:06Z"), done(DELTA, "2026-10-06T09:00:00Z"),
		open(EPS, "eps", "2026-10-06T08:00:00Z"), done(EPS, "2026-10-06T08:30:00Z"), bind(EPS, "dashboard", "dc-20261006080000-00000002", "2026-10-06T08:00:07Z"),
	]) assert.equal(appendThreadLine(stateDir, line).ok, true);
}

test("the list: states, reasons and counts, order, the token only while control is on; missing journal is missing", async (t) => {
	const { stateDir, port } = await setup(t);
	const missing = await call(port, LIST);
	assert.equal(missing.status, 200);
	assert.deepEqual([missing.body.availability, missing.body.threads, missing.body.total, missing.body.warning], ["missing", [], 0, null]);
	assert.equal(existsSync(operatorThreadsFile(stateDir)), false, "reading never creates the journal");

	fixture(stateDir);
	appendThreadLine(stateDir, bind(BETA, "job", "cp-one", "2026-10-06T08:00:03Z"));
	const list = await call(port, LIST);
	assert.equal(list.body.availability, "ok");
	assert.match(String(list.body.token), /^[0-9a-f]{64}$/);
	assert.equal(list.body.enabled, true);
	const threads = list.body.threads as Array<Record<string, unknown>>;
	// Waiting first, then open (newest last_at first: eps's reopening bind 08:00:07 beats gamma's 08:00:05), then done.
	assert.deepEqual(threads.map((th) => [th.tag, th.state]), [["beta", "waiting"], ["alpha", "waiting"], ["eps", "open"], ["gamma", "open"], ["delta", "done"]]);
	const by = Object.fromEntries(threads.map((th) => [th.tag, th]));
	assert.deepEqual(by.alpha!.waiting, { asks: 1, answers: 0 });
	assert.deepEqual(by.beta!.waiting, { asks: 0, answers: 1 });
	assert.deepEqual(by.beta!.counts, { messages: 1, asks: 0, answers: 1 });
	assert.deepEqual(by.gamma!.counts, { messages: 0, asks: 1, answers: 1 });
	assert.deepEqual([by.delta!.done_at, by.eps!.done_at, by.delta!.id], ["2026-10-06T09:00:00Z", null, DELTA]);
	assert.equal(list.body.total, 5);
	assert.equal(list.body.warning, null);

	put(controlConfigFile(stateDir), '{"enabled": false}');
	const off = await call(port, LIST);
	assert.deepEqual([off.body.enabled, off.body.token, (off.body.threads as unknown[]).length], [false, null, 5], "off: the list stays, the token goes");
	assert.match(String(off.body.reason), /^Dashboard control is off/);
	assert.equal(existsSync(controlJournalFile(stateDir)), false, "the list never writes");
});

test("every done refusal, in order, is one viewer line of kind thread_done and never a done line; then 202 with its done line", async (t) => {
	const { stateDir, options, port } = await setup(t);
	fixture(stateDir);
	const journal = operatorThreadsFile(stateDir);
	const audit = controlJournalFile(stateDir);
	const token = String((await call(port, LIST)).body.token);
	const doneLines = () => lines(journal).filter((l) => l.type === "done").length;
	let baseline = doneLines();
	const refused = async (body: unknown, status: number, reason: RegExp, fields: Record<string, unknown> = {}, given: string | null = token) => {
		options.controlLimiter = new ControlLimiter();
		const before = lines(audit).length;
		const out = await call(port, DONE, json(given, body));
		assert.equal(out.status, status, JSON.stringify(out.body));
		assert.match(String(out.body.error), reason);
		const after = lines(audit);
		assert.equal(after.length, before + 1, `one audit line for ${status} ${reason}`);
		const line = after.at(-1)!;
		assert.deepEqual({ type: line.type, by: line.by, kind: line.kind, status: line.status, peer: line.peer }, { type: "refused", by: "viewer", kind: "thread_done", status, peer: "127.0.0.1" });
		for (const [key, value] of Object.entries(fields)) assert.deepEqual(line[key], value, key);
		assert.equal(doneLines(), baseline, "no refusal writes a done line");
	};
	assert.equal((await call(port, DONE)).status, 405);
	assert.equal(lines(audit).length, 0, "405 is not journaled");
	put(controlConfigFile(stateDir), '{"enabled": false}');
	await refused({ id: GAMMA }, 403, /dashboard control is off/);
	rmSync(controlConfigFile(stateDir));
	await refused({ id: "th-../x" }, 400, /^body must be \{"id": "th-<12 hex>"\}$/, { thread_id: undefined });
	await refused({ id: GAMMA, extra: 1 }, 400, /body must be/, { thread_id: GAMMA });
	await refused({ id: GAMMA }, 403, /^control token missing or stale; reload the page$/, { thread_id: GAMMA }, null);
	await refused({ id: GAMMA }, 403, /control token missing or stale/, {}, "f".repeat(64));
	await refused({ id: "th-ffffffffffff" }, 404, /^no thread th-ffffffffffff$/);
	await refused({ id: ALPHA }, 409, /^answer or acknowledge first: 1 open ask\(s\), 0 unacknowledged answer\(s\) in alpha$/);
	await refused({ id: BETA }, 409, /^answer or acknowledge first: 0 open ask\(s\), 1 unacknowledged answer\(s\) in beta$/);
	await refused({ id: DELTA }, 409, /^th-d{12} is already done since 2026-10-06T09:00:00Z$/);
	const asks = join(stateDir, "operator", "asks.jsonl");
	renameSync(asks, `${asks}.aside`);
	mkdirSync(asks);
	await refused({ id: GAMMA }, 503, /^cannot tell whether th-c{12} is waiting: state\/operator\/asks\.jsonl unreadable$/);
	const blind = await call(port, LIST);
	assert.equal((blind.body.threads as Array<Record<string, unknown>>).find((th) => th.id === ALPHA)!.waiting, null, "unknowable waiting is null, never 0");
	assert.match(String(blind.body.warning), /asks unavailable/);
	rmSync(asks, { recursive: true });
	renameSync(`${asks}.aside`, asks);

	options.controlLimiter = new ControlLimiter();
	const sent = await call(port, DONE, json(token, { id: GAMMA }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual([sent.body.id, sent.body.state], [GAMMA, "done"]);
	assert.match(String(sent.body.done_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	const line = lines(journal).at(-1)!;
	assert.deepEqual(line, { type: "done", by: "viewer", id: GAMMA, at: sent.body.done_at, peer: "127.0.0.1" });
	assert.equal(doneLines(), baseline + 1, "exactly one done line");
	baseline = doneLines();
	const after = (await call(port, LIST)).body.threads as Array<Record<string, unknown>>;
	assert.equal(after.find((th) => th.id === GAMMA)!.state, "done");
	await refused({ id: GAMMA }, 409, /already done since/);

	// A later bind reopens it.
	appendThreadLine(stateDir, bind(GAMMA, "dashboard", "dc-20261006100000-00000003", "2026-10-06T10:00:00Z"));
	assert.equal(((await call(port, LIST)).body.threads as Array<Record<string, unknown>>).find((th) => th.id === GAMMA)!.state, "open");

	renameSync(journal, `${journal}.aside`);
	mkdirSync(journal);
	options.controlLimiter = new ControlLimiter();
	const unreadable = await call(port, DONE, json(token, { id: GAMMA }));
	assert.equal(unreadable.status, 500);
	assert.match(String(unreadable.body.error), /^threads unreadable: /);
	assert.deepEqual([lines(audit).at(-1)!.kind, lines(audit).at(-1)!.status], ["thread_done", 500]);
	const unavailable = await call(port, LIST);
	assert.deepEqual([unavailable.body.availability, unavailable.body.threads], ["unavailable", []]);
	assert.match(String(unavailable.body.warning), /^threads unavailable: /);
});

test("without --require-tailnet both thread routes are 403 and nothing is journaled", async (t) => {
	const { stateDir, port } = await setup(t, { requireTailnet: false });
	fixture(stateDir);
	const list = await call(port, LIST);
	assert.deepEqual([list.status, list.body.error], [403, "threads are served only under --require-tailnet"]);
	assert.equal((await call(port, DONE, json("x", { id: GAMMA }))).status, 403);
	assert.equal(existsSync(controlJournalFile(stateDir)), false);
	assert.equal(lines(operatorThreadsFile(stateDir)).filter((l) => l.type === "done").length, 2, "only the fixture's done lines");
});

/** A fake operator session: records every frame and answers `send` with a fresh dc- id. */
async function session(t: import("node:test").TestContext, stateDir: string) {
	const frames: Array<Record<string, unknown>> = [];
	const socketPath = controlSocketFile(stateDir);
	mkdirSync(dirname(socketPath), { recursive: true });
	const fake = createServer((socket) => socket.on("data", (chunk) => {
		for (const line of String(chunk).split("\n").filter(Boolean)) {
			frames.push(JSON.parse(line));
			const id = `dc-20261006080000-${String(frames.length).padStart(8, "0")}`;
			socket.write(`${JSON.stringify({ v: 1, id: 1, ok: true, result: { id, state: "queued", deliver: "prompt" } })}\n`);
		}
	}));
	await new Promise<void>((resolve) => fake.listen(socketPath, resolve));
	t.after(() => fake.close());
	put(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: process.pid, socket: socketPath, token: "b".repeat(64), csrf: "c".repeat(64), started_at: "2026-09-27T08:00:00Z" }));
	return { frames, csrf: "c".repeat(64) };
}

test("a composer send forwards the normalized thread; the 202 names it and binds the dc- id; untagged sends stay unchanged", async (t) => {
	const { stateDir, port } = await setup(t);
	const { frames, csrf } = await session(t, stateDir);
	const sent = await call(port, MESSAGE, json(csrf, { kind: "message", text: "hello", thread: "  Billing Bug " }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.equal(frames.length, 1);
	assert.equal(frames[0]!.op, "send");
	assert.deepEqual(frames[0]!.args, { kind: "message", text: "hello", thread: "billing-bug", peer: "127.0.0.1" });
	const thread = sent.body.thread as { tag: string; id: string; error: null };
	assert.deepEqual([thread.tag, thread.error], ["billing-bug", null]);
	assert.match(thread.id, /^th-[0-9a-f]{12}$/);
	const journal = lines(operatorThreadsFile(stateDir));
	assert.deepEqual(journal.map((l) => l.type), ["open", "bind"]);
	assert.deepEqual([journal[0]!.tag, journal[0]!.id, journal[0]!.by, journal[0]!.peer], ["billing-bug", thread.id, "viewer", "127.0.0.1"]);
	assert.deepEqual(journal[1]!.ref, { kind: "dashboard", id: sent.body.id });
	assert.match(String(journal[1]!.at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

	const second = await call(port, MESSAGE, json(csrf, { kind: "message", text: "again", thread: "billing-bug" }));
	assert.equal((second.body.thread as { id: string }).id, thread.id, "the tag's thread is reused");
	assert.deepEqual(lines(operatorThreadsFile(stateDir)).map((l) => l.type), ["open", "bind", "bind"]);
	const plain = await call(port, MESSAGE, json(csrf, { kind: "message", text: "no thread" }));
	assert.equal(plain.status, 202);
	assert.equal("thread" in plain.body, false, "no thread named: today's body");
	assert.deepEqual(frames[2]!.args, { kind: "message", text: "no thread", peer: "127.0.0.1" }, "untagged frame unchanged");
	assert.equal(lines(operatorThreadsFile(stateDir)).length, 3);

	const bad = await call(port, MESSAGE, json(csrf, { kind: "message", text: "x", thread: "-nope" }));
	assert.deepEqual([bad.status, bad.body.error], [400, "thread must be a tag: 1-32 of a-z 0-9 -, starting with a letter or digit"]);
	assert.equal((await call(port, MESSAGE, json(csrf, { kind: "message", text: "x", thread: "x".repeat(33) }))).status, 400);
	assert.equal((await call(port, MESSAGE, json(csrf, { kind: "message", text: "x", thread: 7 }))).status, 400);
	const answer = await call(port, MESSAGE, json(csrf, { kind: "answer", ask_id: "ask-abcd", label: "Keep", thread: "  Billing Bug " }));
	assert.equal(answer.status, 202);
	assert.deepEqual(frames[3]!.args, { kind: "answer", ask_id: "ask-abcd", label: "Keep", thread: "billing-bug", peer: "127.0.0.1" });
	assert.equal((await call(port, MESSAGE, json(csrf, { kind: "answer", ask_id: "ask-abcd", label: "Keep", thread: "bad!" }))).status, 400);
	assert.equal((await call(port, MESSAGE, json(csrf, { kind: "abort", thread: "billing-bug" }))).status, 400);
	assert.equal(frames.length, 4, "no refused request reaches the session");
	assert.equal(lines(controlJournalFile(stateDir)).at(-1)!.thread, "billing-bug", "the refusal records the thread it parsed");

	// A bind that cannot be written never changes the 202; the body names why.
	rmSync(operatorThreadsFile(stateDir));
	mkdirSync(operatorThreadsFile(stateDir));
	const unbound = await call(port, MESSAGE, json(csrf, { kind: "message", text: "still sent", thread: "billing-bug" }));
	assert.equal(unbound.status, 202);
	assert.equal(frames.length, 5, "the message was delivered");
	const failed = unbound.body.thread as { tag: string; id: null; error: string };
	assert.deepEqual([failed.tag, failed.id], ["billing-bug", null]);
	assert.match(failed.error, /threads\.jsonl/);
});

test("offline: a held message with a thread binds the held dc- id", async (t) => {
	const { stateDir, port } = await setup(t);
	const inbox = String((await call(port, "/api/operator/control")).body.inbox_token);
	const held = await call(port, MESSAGE, json(inbox, { kind: "message", text: "later", thread: "deploys" }));
	assert.equal(held.status, 202, JSON.stringify(held.body));
	assert.equal(held.body.state, "held");
	assert.deepEqual(lines(controlInboxFile(stateDir)).map((l) => Object.keys(l).sort()), [["ask_id", "at", "id", "text", "thread", "type"]]);
	assert.equal(lines(controlInboxFile(stateDir))[0]!.thread, "deploys");
	const journal = lines(operatorThreadsFile(stateDir));
	assert.deepEqual(journal.map((l) => l.type), ["open", "bind"]);
	assert.deepEqual(journal[1]!.ref, { kind: "dashboard", id: held.body.id });
	assert.deepEqual(held.body.thread, { tag: "deploys", id: journal[0]!.id, error: null });
});
