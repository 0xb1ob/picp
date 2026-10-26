/**
 * Behavior 19 (P19a): the dashboard's threads and composer attachments as `bin/cp-view` serves them on a scratch home,
 * over real HTTP, with the operator session's own dashboard-control server (src/dashboard-control.ts) on the other end.
 * The Sessions transcripts and the file explorer are in viewer-conversations-sessions.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type ControlPorts, type DashboardControl, type InlineImage, startDashboardControl } from "../../src/dashboard-control.ts";
import { appendAnswerLine, appendThreadLine } from "../../src/viewer/control-audit.ts";
import { type AnswerLine, controlConfigFile, controlInboxFile, controlJournalFile, operatorThreadsFile, readControlRecord, type ThreadLine } from "../../src/viewer/control-files.ts";
import { type Context, type Json, jsonl, lines, mode, pick, send, viewer, write } from "../harness/conversations.ts";
import { STUBS, syntheticPng } from "../harness/images.ts";

/** The operator session's dashboard-control server, pi's ports recorded; `images: false` is a bridge before images. */
async function session(t: Context, stateDir: string, root: string, images = true) {
	const injected: Array<{ text: string; images?: InlineImage[] }> = [];
	const limits: Array<{ maxEdge: number; maxBytes: number }> = [];
	const ports: ControlPorts = {
		inject: (text, _deliverAs, parts) => { injected.push({ text, ...(parts ? { images: parts } : {}) }); },
		abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => join(stateDir, "operator-session.jsonl"),
		...(images ? { prepareImage: async (bytes: Uint8Array, mimeType: string, limit: { maxEdge: number; maxBytes: number }) => (limits.push(limit), { data: Buffer.from(bytes).toString("base64"), mimeType }) } : {}),
	};
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {}, uploadRoot: root }) as DashboardControl;
	assert.equal(control.state, "listening", JSON.stringify(control));
	t.after(() => control.stop());
	return { injected, limits, csrf: (readControlRecord(stateDir) as { record: { csrf: string } }).record.csrf };
}

// ---- threads -------------------------------------------------------------------------------------------------------

const [ALPHA, BETA, GAMMA, DELTA, EPS] = ["a", "b", "c", "d", "e"].map((c) => `th-${c.repeat(12)}`) as [string, string, string, string, string];
const DC1 = "dc-20261006080000-89abcdef";
const open = (id: string, tag: string, at: string): ThreadLine => ({ type: "open", by: "viewer", id, at, tag, peer: null });
const bind = (thread: string, kind: "dashboard" | "ask" | "answer" | "job", id: string, at: string): ThreadLine => ({ type: "bind", by: "bridge", at, thread, ref: { kind, id }, peer: null });
const done = (id: string, at: string): ThreadLine => ({ type: "done", by: "viewer", id, at, peer: null });

/** alpha waits on an open ask, beta on an unacked answer; gamma's refs are settled; delta is done; eps reopened. */
function threads(stateDir: string) {
	write(join(stateDir, "operator", "asks.jsonl"), jsonl([
		{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: "2026-10-06T08:00:00Z", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] },
		{ type: "open", id: "ask-dddd", project: "demo", question: "Merge?", created_at: "2026-10-06T08:00:00Z", recommendation: "Yes", options: [{ label: "Yes", consequence: "Merges" }] },
		{ type: "answer", id: "ask-dddd", answer: "Yes", answered_at: "2026-10-06T08:05:00Z" },
	]));
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

test("P19-threads: /api/threads lists each thread's state, waiting reasons, counts and working jobs; job refs never collide", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	const list = async () => (await d.get("/api/threads")).body as Json;
	const missing = await list();
	assert.deepEqual([missing.availability, missing.threads, missing.total, missing.warning], ["missing", [], 0, null]);
	assert.equal(existsSync(operatorThreadsFile(d.stateDir)), false, "reading never creates the journal");

	threads(d.stateDir);
	appendThreadLine(d.stateDir, bind(BETA, "job", "cp-one", "2026-10-06T08:00:03Z"));
	const listed = await list();
	assert.deepEqual([listed.availability, listed.enabled, listed.total, listed.warning], ["ok", true, 5, null]);
	assert.match(String(listed.token), /^[0-9a-f]{64}$/);
	assert.deepEqual(listed.threads.map((th: Json) => [th.tag, th.state]), [["beta", "waiting"], ["alpha", "waiting"], ["eps", "open"], ["gamma", "open"], ["delta", "done"]], "waiting, then open newest first, then done");
	const by = Object.fromEntries(listed.threads.map((th: Json) => [th.tag, th]));
	assert.deepEqual([by.alpha.waiting, by.beta.waiting], [{ asks: 1, answers: 0 }, { asks: 0, answers: 1 }]);
	assert.deepEqual([by.beta.counts, by.gamma.counts], [{ messages: 1, asks: 0, answers: 1, jobs_working: 0 }, { messages: 0, asks: 1, answers: 1, jobs_working: 0 }]);
	assert.deepEqual([by.delta.done_at, by.eps.done_at, by.delta.id], ["2026-10-06T09:00:00Z", null, DELTA]);

	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	const off = await list();
	assert.deepEqual([off.enabled, off.token, off.threads.length], [false, null, 5], "off: the list stays, the token goes");
	assert.match(String(off.reason), /^Dashboard control is off/);
	assert.equal(existsSync(controlJournalFile(d.stateDir)), false, "the list never writes");
	rmSync(controlConfigFile(d.stateDir));

	const before = (await list()).threads;
	for (const id of [DC1, "ask-abcd", "ans-bbbbbbbbbbbb"]) assert.ok(appendThreadLine(d.stateDir, bind(EPS, "job", id, "2026-10-06T08:00:07Z")).ok);
	assert.deepEqual((await list()).threads, before, "job refs with existing ids add no counts and remove no waiting items");
	const token = String((await list()).token);
	assert.equal((await d.send("/api/threads/done", d.json(token, { id: ALPHA }))).status, 409, "an open ask still blocks done after a colliding job bind");

	const working = async () => (await list()).threads.find((th: Json) => th.tag === "eps").counts.jobs_working;
	assert.equal(await working(), 0, "no fleet.json");
	for (const id of ["cp-live", "cp-idle", "cp-ghost", "../evil", "a/b"]) assert.ok(appendThreadLine(d.stateDir, bind(EPS, "job", id, "2026-10-06T08:00:08Z")).ok, `the journal accepts ${id}`);
	write(join(d.stateDir, "evil", "status.json"), { phase: "working" });
	write(join(d.stateDir, "fleet.json"), { jobs: [{ job_id: "cp-live", phase: "working" }, { job_id: "cp-idle", phase: "working" }, { job_id: "cp-other", phase: "working" }, { phase: "working" }, { job_id: "", phase: "working" }, { job_id: "../evil", phase: "working" }, { job_id: "a/b", phase: "working" }] });
	for (const [job, phase] of [["cp-live", "working"], ["cp-idle", "exited"], ["cp-other", "working"]]) write(join(d.stateDir, "runs", job!, "status.json"), { phase });
	assert.equal(await working(), 1, "only the live worker bound to the thread counts; no status is read outside runs/<id>");
	write(join(d.stateDir, "fleet.json"), "{not json");
	assert.equal(await working(), null, "an unreadable fleet is null, never 0");
});

test("P19-threads-done: POST /api/threads/done refuses in order, journals each refusal once, and 202s only with its done line", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t, { seed: threads });
	const journal = operatorThreadsFile(d.stateDir);
	const audit = controlJournalFile(d.stateDir);
	const token = String((await d.get("/api/threads")).body.token);
	const doneLines = () => lines(journal).filter((l) => l.type === "done").length;
	let baseline = doneLines();
	const refused = async (body: unknown, status: number, reason: RegExp, fields: Json = {}, given: string | null = token) => {
		d.tick();
		const before = lines(audit).length;
		const out = await d.send("/api/threads/done", d.json(given, body));
		assert.equal(out.status, status, JSON.stringify(out.body));
		assert.match(String(out.body.error), reason);
		const after = lines(audit);
		assert.equal(after.length, before + 1, `one audit line for ${status} ${reason}`);
		const line = after.at(-1)!;
		assert.deepEqual(pick(line, ["type", "by", "kind", "status", "peer"]), { type: "refused", by: "viewer", kind: "thread_done", status, peer: "127.0.0.1" });
		for (const [key, value] of Object.entries(fields)) assert.deepEqual(line[key], value, key);
		assert.equal(doneLines(), baseline, "no refusal writes a done line");
	};
	assert.equal((await d.send("/api/threads/done")).status, 405);
	assert.equal(lines(audit).length, 0, "405 is not journaled");
	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	await refused({ id: GAMMA }, 403, /dashboard control is off/);
	rmSync(controlConfigFile(d.stateDir));
	await refused({ id: "th-../x" }, 400, /^body must be \{"id": "th-<12 hex>"\}$/, { thread_id: undefined });
	await refused({ id: GAMMA, extra: 1 }, 400, /body must be/, { thread_id: GAMMA });
	await refused({ id: GAMMA }, 403, /^control token missing or stale; reload the page$/, { thread_id: GAMMA }, null);
	await refused({ id: GAMMA }, 403, /control token missing or stale/, {}, "f".repeat(64));
	await refused({ id: "th-ffffffffffff" }, 404, /^no thread th-ffffffffffff$/);
	await refused({ id: ALPHA }, 409, /^answer or acknowledge first: 1 open ask\(s\), 0 unacknowledged answer\(s\) in alpha$/);
	await refused({ id: BETA }, 409, /^answer or acknowledge first: 0 open ask\(s\), 1 unacknowledged answer\(s\) in beta$/);
	await refused({ id: DELTA }, 409, /^th-d{12} is already done since 2026-10-06T09:00:00Z$/);
	const asks = join(d.stateDir, "operator", "asks.jsonl");
	renameSync(asks, `${asks}.aside`);
	mkdirSync(asks);
	await refused({ id: GAMMA }, 503, /^cannot tell whether th-c{12} is waiting: state\/operator\/asks\.jsonl unreadable$/);
	const blind = (await d.get("/api/threads")).body as Json;
	assert.equal(blind.threads.find((th: Json) => th.id === ALPHA).waiting, null, "unknowable waiting is null, never 0");
	assert.match(String(blind.warning), /asks unavailable/);
	rmSync(asks, { recursive: true });
	renameSync(`${asks}.aside`, asks);

	d.tick();
	const sent = await d.send("/api/threads/done", d.json(token, { id: GAMMA }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual([sent.body.id, sent.body.state], [GAMMA, "done"]);
	assert.match(String(sent.body.done_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	assert.deepEqual(lines(journal).at(-1), { type: "done", by: "viewer", id: GAMMA, at: sent.body.done_at, peer: "127.0.0.1" });
	assert.equal(doneLines(), baseline + 1, "exactly one done line");
	baseline = doneLines();
	const state = async (id: string) => ((await d.get("/api/threads")).body as Json).threads.find((th: Json) => th.id === id).state;
	assert.equal(await state(GAMMA), "done");
	await refused({ id: GAMMA }, 409, /already done since/);
	appendThreadLine(d.stateDir, bind(GAMMA, "dashboard", "dc-20261006100000-00000003", "2026-10-06T10:00:00Z"));
	assert.equal(await state(GAMMA), "open", "a later bind reopens it");

	renameSync(journal, `${journal}.aside`);
	mkdirSync(journal);
	d.tick();
	const unreadable = await d.send("/api/threads/done", d.json(token, { id: GAMMA }));
	assert.equal(unreadable.status, 500);
	assert.match(String(unreadable.body.error), /^threads unreadable: /);
	assert.deepEqual(pick(lines(audit).at(-1)!, ["kind", "status"]), { kind: "thread_done", status: 500 });
	const unavailable = (await d.get("/api/threads")).body as Json;
	assert.deepEqual([unavailable.availability, unavailable.threads], ["unavailable", []]);
	assert.match(String(unavailable.warning), /^threads unavailable: /);

	const plain = await viewer(t, { requireTailnet: false, seed: threads });
	const listOff = await plain.get("/api/threads");
	assert.deepEqual([listOff.status, listOff.body.error], [403, "threads are served only under --require-tailnet"]);
	assert.equal((await plain.send("/api/threads/done", plain.json("x", { id: GAMMA }))).status, 403);
	assert.equal(existsSync(controlJournalFile(plain.stateDir)), false, "off-tailnet refusals are not journaled");
	assert.equal(lines(operatorThreadsFile(plain.stateDir)).filter((l) => l.type === "done").length, 2, "only the fixture's done lines");
});

test("P19-thread-send: a composer send names its thread to the operator session and files the dc- id; offline, the held id", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	const message = "/api/operator/message";
	const offline = String((await d.get("/api/operator/control")).body.inbox_token);
	const held = await d.send(message, d.json(offline, { kind: "message", text: "later", thread: "deploys" }));
	assert.equal(held.status, 202, JSON.stringify(held.body));
	assert.equal(held.body.state, "held");
	assert.deepEqual(lines(controlInboxFile(d.stateDir)).map((l) => [Object.keys(l).sort(), l.thread]), [[["ask_id", "at", "id", "text", "thread", "type"], "deploys"]]);
	let journal = lines(operatorThreadsFile(d.stateDir));
	assert.deepEqual([journal.map((l) => l.type), journal[1]!.ref], [["open", "bind"], { kind: "dashboard", id: held.body.id }]);
	assert.deepEqual(held.body.thread, { tag: "deploys", id: journal[0]!.id, error: null });
	rmSync(controlInboxFile(d.stateDir));
	rmSync(operatorThreadsFile(d.stateDir));

	write(join(d.stateDir, "operator", "asks.jsonl"), jsonl([{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: "2026-10-06T08:00:00Z", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] }]));
	const { injected, csrf } = await session(t, d.stateDir, d.root);
	const requests = () => lines(controlJournalFile(d.stateDir)).filter((l) => l.type === "request");
	const sent = await d.send(message, d.json(csrf, { kind: "message", text: "hello", thread: "  Billing Bug " }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.match(injected[0]!.text, new RegExp(`^hello\\n\\n\\[cp-dashboard ${sent.body.id} — from the dashboard; thread=billing-bug\\]$`), "the session hears the normalized thread");
	assert.deepEqual(pick(requests()[0]!, ["kind", "text", "thread", "peer"]), { kind: "message", text: "hello", thread: "billing-bug", peer: "127.0.0.1" });
	const thread = sent.body.thread as Json;
	assert.deepEqual([thread.tag, thread.error], ["billing-bug", null]);
	assert.match(thread.id, /^th-[0-9a-f]{12}$/);
	journal = lines(operatorThreadsFile(d.stateDir));
	assert.deepEqual(journal.map((l) => l.type), ["open", "bind"]);
	assert.deepEqual([journal[0]!.tag, journal[0]!.id, journal[0]!.by, journal[0]!.peer, journal[1]!.ref], ["billing-bug", thread.id, "viewer", "127.0.0.1", { kind: "dashboard", id: sent.body.id }]);
	assert.match(String(journal[1]!.at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

	const again = await d.send(message, d.json(csrf, { kind: "message", text: "again", thread: "billing-bug" }));
	assert.equal(again.body.thread.id, thread.id, "the tag's thread is reused");
	assert.deepEqual(lines(operatorThreadsFile(d.stateDir)).map((l) => l.type), ["open", "bind", "bind"]);
	const untagged = await d.send(message, d.json(csrf, { kind: "message", text: "no thread" }));
	assert.equal(untagged.status, 202);
	assert.equal("thread" in untagged.body, false, "no thread named: today's body");
	assert.equal(requests()[2]!.thread, undefined, "the untagged request names no thread");
	assert.match(injected[2]!.text, / — from the dashboard\]$/);
	assert.equal(lines(operatorThreadsFile(d.stateDir)).length, 3);

	d.tick();
	const bad = await d.send(message, d.json(csrf, { kind: "message", text: "x", thread: "-nope" }));
	assert.deepEqual([bad.status, bad.body.error], [400, "thread must be a tag: 1-32 of a-z 0-9 -, starting with a letter or digit"]);
	for (const body of [{ kind: "message", text: "x", thread: "x".repeat(33) }, { kind: "message", text: "x", thread: 7 }, { kind: "answer", ask_id: "ask-abcd", label: "Keep", thread: "bad!" }, { kind: "abort", thread: "billing-bug" }]) {
		assert.equal((await d.send(message, d.json(csrf, body))).status, 400, JSON.stringify(body));
	}
	assert.equal(lines(controlJournalFile(d.stateDir)).at(-1)!.thread, "billing-bug", "the refusal records the thread it parsed");
	const answer = await d.send(message, d.json(csrf, { kind: "answer", ask_id: "ask-abcd", label: "Keep", thread: "  Billing Bug " }));
	assert.equal(answer.status, 202, JSON.stringify(answer.body));
	assert.deepEqual(pick(requests().at(-1)!, ["kind", "ask_id", "text", "thread"]), { kind: "answer", ask_id: "ask-abcd", text: "ask-abcd: Keep", thread: "billing-bug" });
	assert.equal(injected.length, 4, "no refused request reaches the session");

	rmSync(operatorThreadsFile(d.stateDir));
	mkdirSync(operatorThreadsFile(d.stateDir));
	const unbound = await d.send(message, d.json(csrf, { kind: "message", text: "still sent", thread: "billing-bug" }));
	assert.equal(unbound.status, 202, "a bind that cannot be written never changes the 202");
	assert.equal(injected.length, 5, "the message was delivered");
	assert.deepEqual([unbound.body.thread.tag, unbound.body.thread.id], ["billing-bug", null]);
	assert.match(unbound.body.thread.error, /threads\.jsonl/);
});

// ---- uploads -------------------------------------------------------------------------------------------------------

const UPLOAD = "/api/operator/upload";
const MESSAGE = "/api/operator/message";
const day = (at = new Date()) => at.toISOString().slice(0, 10).replace(/-/g, "");
/** Where an upload id lives: `<root>/<yyyymmdd>/<24 hex>.<ext>`. */
const stored = (root: string, id: string) => join(root, id.slice(3, 11), id.slice(12));
const heic = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)]);
const EIGHT_DAYS_AGO = () => new Date(Date.now() - 8 * 86_400_000);

test("P19-upload: POST /api/operator/upload refuses in order, stores sniffed images 0600 under 0700 dirs, sweeps, and serves them back hardened", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t, { relativeRoot: true });
	const png = syntheticPng(8, 8);
	const refused = async (status: number, init: Parameters<typeof send>[2], reason: RegExp, at: { send: typeof d.send } = d) => {
		const reply = await at.send(UPLOAD, init);
		assert.equal(reply.status, status, JSON.stringify(reply.body));
		assert.match(String(reply.body.error), reason);
	};
	await refused(405, { method: "GET" }, /POST only/);
	assert.equal((await d.send(UPLOAD, { method: "PUT" })).status, 405);
	const plain = await viewer(t, { requireTailnet: false });
	await refused(403, plain.bytes("x", png), /--require-tailnet/, plain);
	await refused(403, d.bytes("x", png, "image/png", { origin: "https://evil.example" }), /^Origin must be http:\/\/127\.0\.0\.1:\d+ \(no HTTPS origin is configured/);
	await refused(403, d.bytes("x", png, "image/png", { "sec-fetch-site": "cross-site" }), /cross-site/);
	await refused(415, d.bytes("x", png, "application/json"), /Content-Type must be image/);
	await refused(415, d.bytes("x", STUBS.svg, "image/svg+xml"), /Content-Type must be image/);
	await refused(415, d.bytes("x", STUBS.heic, "image/heic"), /HEIC\/HEIF is not supported; share the photo as JPEG/);
	await refused(413, d.bytes("x", png, "image/png", { "content-length": String(10 * 1024 * 1024 + 1) }), /larger than 10485760 bytes/);
	await refused(409, d.bytes("x", png), /need a running operator session/);
	const { csrf } = await session(t, d.stateDir, d.root);
	await refused(403, d.bytes("stale", png), /control token missing or stale/);
	for (const bytes of [STUBS.svg, STUBS.text, png.subarray(0, 5), Buffer.alloc(0)]) await refused(415, d.bytes(csrf, bytes), /not a PNG, JPEG, WebP or GIF image/);
	for (const brand of ["heic", "heix", "mif1", "msf1"]) await refused(415, d.bytes(csrf, heic(brand), "image/jpeg"), /HEIC\/HEIF is not supported/, d);
	assert.equal(existsSync(d.root), false, "nothing stored before the checks pass");
	const audit = () => lines(controlJournalFile(d.stateDir));
	assert.deepEqual(audit().filter((l) => l.type === "refused").map((l) => [l.kind, l.status]), [["upload", 403], ["upload", 403], ["upload", 415], ["upload", 415], ["upload", 415], ["upload", 413], ["upload", 409], ["upload", 403], ...Array(8).fill(["upload", 415])]);

	// The sweep runs before the 256 MiB cap: a sparse filler counts by size, a stale file and its emptied day dir go.
	d.tick();
	mkdirSync(d.root, { mode: 0o755 });
	const filler = join(d.root, "20300101", `${"0".repeat(24)}.png`);
	write(filler, png);
	truncateSync(filler, 256 * 1024 * 1024);
	const stale = join(d.root, "20200101", `${"1".repeat(24)}.png`);
	write(stale, png);
	utimesSync(stale, EIGHT_DAYS_AGO(), EIGHT_DAYS_AGO());
	write(join(d.root, "20300101", "notes.txt"), "not ours");
	await refused(507, d.bytes(csrf, png), new RegExp(`^upload space full: ${256 * 1024 * 1024} of 268435456 bytes used; attachments expire after 7 days, or remove ${d.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
	assert.equal(mode(d.root), 0o700, "a relative CP_UPLOAD_ROOT resolves to this root, and its 0755 is tightened to 0700");
	assert.deepEqual([existsSync(stale), readdirSync(d.root).sort()], [false, ["20300101"]], "the stale file and its emptied day dir are gone");
	assert.deepEqual(readdirSync(join(d.root, "20300101")).sort(), [`${"0".repeat(24)}.png`, "notes.txt"], "other names are left alone");
	rmSync(join(d.root, "20300101"), { recursive: true });

	const first = await d.send(UPLOAD, d.bytes(csrf, png));
	assert.equal(first.status, 201, JSON.stringify(first.body));
	const id = String(first.body.id);
	assert.match(id, /^im-\d{8}-[0-9a-f]{24}\.png$/, "the day is the viewer's pinned clock, not this process's");
	assert.deepEqual({ ...first.body, expires_at: "x" }, { id, mime: "image/png", bytes: png.length, expires_at: "x", url: `/api/operator/uploads/${id}` });
	const file = stored(d.root, id);
	assert.deepEqual(readFileSync(file), png);
	assert.deepEqual([mode(file), mode(d.root), mode(dirname(file))], [0o600, 0o700, 0o700]);
	const uploaded = audit().filter((l) => l.type === "upload");
	assert.deepEqual(uploaded.map((l) => ({ ...l, at: "x" })), [{ type: "upload", by: "viewer", id, at: "x", peer: "127.0.0.1", mime: "image/png", bytes: png.length }]);
	assert.equal(readFileSync(controlJournalFile(d.stateDir), "utf8").includes("iVBOR"), false, "no base64 bytes in the journal");
	for (const [bytes, mime, ext] of [[STUBS.jpeg, "image/jpeg", "jpg"], [STUBS.gif, "image/gif", "gif"], [STUBS.webp, "image/webp", "webp"]] as const) {
		const other = await d.send(UPLOAD, d.bytes(csrf, bytes, mime));
		assert.deepEqual([other.status, other.body.mime, String(other.body.id).split(".").at(-1)], [201, mime, ext]);
	}

	const got = await d.send(first.body.url, { headers: { "sec-fetch-site": "same-origin" } });
	assert.deepEqual([got.status, got.raw], [200, png]);
	assert.deepEqual(pick(got.headers, ["content-type", "x-content-type-options", "cross-origin-resource-policy", "content-security-policy", "cache-control"]), { "content-type": "image/png", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "content-security-policy": "default-src 'none'; img-src 'self'; sandbox", "cache-control": "private, max-age=604800, immutable" });
	const head = await d.send(first.body.url, { method: "HEAD" });
	assert.deepEqual([head.status, head.raw.length], [200, 0]);
	assert.equal((await plain.send(`/api/operator/uploads/${id}`)).status, 403, "served only under --require-tailnet");
	assert.equal((await d.send(`/api/operator/uploads/${id}`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
	assert.equal((await d.send(`/api/operator/uploads/${id}`, { headers: { "sec-fetch-site": "none" } })).status, 200);
	const fresh = `${"tx-20261004-0123456789abcdef01234567"}`;
	for (const bad of ["..%2F..%2Fetc%2Fpasswd", "im-1.png", `${id}x`, `${fresh}.svg`, "im-20261004-0123456789abcdef01234567.txt", `${fresh}.png`]) {
		const reply = await d.send(`/api/operator/uploads/${bad}`);
		assert.deepEqual([reply.status, reply.body.error], [400, "not an upload id"], bad);
	}
	const gone = (hex: string) => `im-${id.slice(3, 11)}-${hex.repeat(24)}.png`;
	assert.deepEqual((await d.send(`/api/operator/uploads/${gone("f")}`)).body, { error: "image expired" });
	write(stored(d.root, gone("a")), STUBS.jpeg);
	symlinkSync(file, stored(d.root, gone("b")));
	for (const hex of ["a", "b"]) assert.deepEqual((await d.send(`/api/operator/uploads/${gone(hex)}`)).body, { error: "image expired" }, "bytes that do not match the extension, or a symlink, are never served");
	utimesSync(file, EIGHT_DAYS_AGO(), EIGHT_DAYS_AGO());
	const expired = await d.send(`/api/operator/uploads/${id}`);
	assert.deepEqual([expired.status, expired.body.error, existsSync(file)], [404, "image expired", false], "past 7 days: refused and unlinked on read");

	renameSync(d.root, `${d.root}-real`);
	symlinkSync(`${d.root}-real`, d.root);
	const kept = readdirSync(`${d.root}-real`, { recursive: true }).length;
	await refused(503, d.bytes(csrf, png), /upload directory .* is not safe: it is a symlink/);
	assert.equal(readdirSync(`${d.root}-real`, { recursive: true }).length, kept, "nothing written through the link");
	rmSync(d.root);
	renameSync(`${d.root}-real`, d.root);

	d.tick();
	for (let i = 0; i < 24; i++) assert.equal((await d.send(UPLOAD, d.bytes(csrf, syntheticPng()))).status, 201, `upload ${i + 1}`);
	const limited = await d.send(UPLOAD, d.bytes(csrf, syntheticPng()));
	assert.equal(limited.status, 429);
	assert.ok(Number(limited.headers["retry-after"]) > 0);
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "still here" }))).status, 202, "text sends keep their own limiter");
});

test("P19-upload-send: images and text files reach the operator session inline, within budget, and an older or absent session refuses them", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t);
	const absent = `im-${day()}-${"c".repeat(24)}.png`;
	const offline = await d.send(MESSAGE, d.json("x", { kind: "message", text: "", images: [absent] }));
	assert.deepEqual([offline.status, offline.body.error], [409, "image attachments need a running operator session (they are never held in the inbox); start it, or send text only"]);
	assert.equal((await d.send(MESSAGE, d.json("x", { kind: "message", text: "x", images: ["nope"] }))).status, 400);
	const older = await viewer(t);
	const old = await session(t, older.stateDir, older.root, false);
	write(stored(older.root, absent), syntheticPng());
	assert.equal("images" in (await older.get("/api/operator/control")).body, false, "no capability, no flag");
	const skew = await older.send(MESSAGE, older.json(old.csrf, { kind: "message", text: "x", images: [absent] }));
	assert.equal(skew.status, 409);
	assert.match(String(skew.body.error), /^unsupported: this session's cp-bridge predates image attachments; restart the session/);
	assert.equal(old.injected.length, 0);

	const { csrf, injected, limits } = await session(t, d.stateDir, d.root);
	const control = async () => (await d.get("/api/operator/control")).body as Json;
	assert.deepEqual([(await control()).images, (await control()).files], [true, true]);
	const upload = async (bytes: Buffer, name?: string) => {
		const reply = await d.send(UPLOAD, d.bytes(csrf, bytes, name === undefined ? "image/png" : "application/octet-stream", name === undefined ? {} : { "x-cp-upload-name": encodeURIComponent(name) }));
		return reply;
	};
	const png = syntheticPng();
	const image = String((await upload(png)).body.id);
	const missing = await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "x", images: [image, absent] }));
	assert.deepEqual([missing.status, missing.body.error], [410, `image ${absent} expired or was never uploaded; attach it again`]);
	const sent = await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", images: [image] }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual(Buffer.from(injected[0]!.images![0]!.data, "base64"), png);
	assert.match(injected[0]!.text, new RegExp(`; images=${image.replace(/\./g, "\\.")}\\]$`));
	assert.ok(injected[0]!.text.startsWith(`image: ${stored(d.root, image)} (deleted after 7 days`), "the model also gets the upload's path");
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "text only" }))).status, 202);
	assert.equal(injected[1]!.images, undefined, "a text-only send stays on the plain send op");
	const more = [];
	for (let i = 0; i < 7; i++) more.push(String((await upload(syntheticPng(3 + i, 2))).body.id));
	for (const ids of [more.slice(0, 4), [image, ...more]]) assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", images: ids }))).status, 202);
	assert.deepEqual(limits.map((l) => l.maxBytes), [786432, ...Array(4).fill(524288), ...Array(8).fill(262144)], "768 KiB for one image, an even share of 2 MiB beyond");

	d.tick();
	const text = (name: string, bytes: Buffer) => upload(bytes, name);
	for (const [name, bytes, status, reason] of [
		["binary.txt", Buffer.from([1, 0, 2]), 415, /NUL/], ["broken.md", Buffer.from([0xc3, 0x28]), 415, /UTF-8/], ["broken.json", Buffer.from("{oops}"), 415, /valid JSON/],
		["big.txt", Buffer.alloc(4 * 1024 * 1024 + 1, 97), 413, /larger than 4194304 bytes/], ["file.csv", Buffer.from("hello"), 415, /extension/],
		["file.svg", Buffer.from("<svg></svg>"), 415, /extension/], ["report.json.exe", Buffer.from("{}"), 415, /extension/],
	] as const) {
		const reply = await text(name, bytes);
		assert.equal(reply.status, status, `${name}: ${JSON.stringify(reply.body)}`);
		assert.match(String(reply.body.error), reason);
	}
	const exact = await text("exact.txt", Buffer.alloc(4 * 1024 * 1024, 97));
	assert.equal(exact.status, 201, "exactly 4 MiB is allowed");
	const nearBytes = Math.round(3.9 * 1024 * 1024);
	const near = await text("near-cap.txt", Buffer.alloc(nearBytes, 97));
	assert.deepEqual([near.status, near.body.bytes], [201, nearBytes]);
	const html = Buffer.from("<script>UNIQUE_ATTACHMENT_CONTENT</script>");
	const page = await text("../folder\\report[1].HTML", html);
	assert.equal(page.status, 201, JSON.stringify(page.body));
	const id = String(page.body.id);
	assert.match(id, /^tx-\d{8}-[0-9a-f]{24}\.html$/);
	assert.equal(page.body.name, "report_1_.HTML");
	assert.equal((await text("../folder\\evil\n[<name>].HTML", html)).body.name, "evil___name__.HTML");
	assert.equal((await text("report.JSON", Buffer.from('{"ok":true}'))).status, 201);
	assert.deepEqual([stored(d.root, id).includes("report"), readFileSync(stored(d.root, id))], [false, html]);
	assert.equal(readFileSync(controlJournalFile(d.stateDir), "utf8").includes("UNIQUE_ATTACHMENT_CONTENT"), false);
	assert.deepEqual(pick(lines(controlJournalFile(d.stateDir)).find((l) => l.type === "upload" && l.id === id)!, ["mime", "bytes", "name"]), { mime: "text/plain", bytes: html.length, name: "report_1_.HTML" });
	const got = await d.send(String(page.body.url));
	assert.deepEqual([got.headers["content-type"], got.headers["x-content-type-options"], got.raw], ["text/plain; charset=utf-8", "nosniff", html]);
	assert.ok(String(got.headers["content-security-policy"]).includes("sandbox"));

	d.tick();
	const client_id = "dc-20261004140000-00000019";
	const mixed = await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "look", images: [image], files: [id], thread: "file-chat", client_id }));
	assert.equal(mixed.status, 202, JSON.stringify(mixed.body));
	assert.equal(mixed.body.id, client_id, "mixed uploads keep the pre-acknowledgement correlation id");
	assert.deepEqual((await control()).sends.find((s: Json) => s.id === client_id)?.body, { kind: "message", text: "look", images: [image], files: [id], thread: "file-chat" }, "the reload projection keeps both kinds and the thread");
	const last = () => injected.at(-1)!;
	assert.equal(last().images!.length, 1);
	assert.ok(last().text.includes("File: report_1_.HTML\n```text\n<script>UNIQUE_ATTACHMENT_CONTENT</script>\n```"));
	assert.match(last().text, /; thread=file-chat; images=im-[^;]+; files=tx-[^\]]+\]$/);
	for (const body of [{ files: [image] }, { images: [id] }, { files: [id, id] }, { files: [] }, { files: "x" }, { files: [id], images: Array.from({ length: 8 }, () => `im-${day()}-${"d".repeat(24)}.png`) }]) {
		assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", ...body }))).status, 400, JSON.stringify(body));
	}
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", files: [id] }))).status, 202);
	assert.equal(last().images, undefined, "a file-only send has no image parts");
	const goneText = `tx-${day()}-${"e".repeat(24)}.txt`;
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", files: [goneText] }))).status, 410);
	assert.deepEqual((await d.send(`/api/operator/uploads/${goneText}`)).body, { error: "file expired" });
	const nearId = String(near.body.id);
	assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", files: [nearId] }))).status, 202);
	assert.ok(last().text.includes("File: near-cap.txt\n"), "the journal's name for the upload");
	assert.ok(last().text.includes(`[truncated — full file at ${stored(d.root, nearId)}]`));
	assert.ok(Buffer.byteLength(last().text) < 16384 + 1024, "only the inline budget is truncated");
	assert.deepEqual(readFileSync(stored(d.root, nearId)), Buffer.alloc(nearBytes, 97));
	write(stored(d.root, id), Buffer.from([0xc3, 0x28]));
	assert.deepEqual((await d.send(`/api/operator/uploads/${id}`)).body, { error: "file expired" }, "a stored text file is revalidated on read");

	// The inline file text: bounded at 16 KiB with robust fences, truncated on UTF-8 boundaries, paths to the full files.
	d.tick();
	const inline = async (files: Array<[string, Buffer]>) => {
		const ids: string[] = [];
		for (const [name, bytes] of files) ids.push(String((await text(name, bytes)).body.id));
		assert.equal((await d.send(MESSAGE, d.json(csrf, { kind: "message", text: "", files: ids }))).status, 202);
		return { ids, text: last().text.slice(0, last().text.indexOf("[cp-dashboard ")) };
	};
	const hostile = "```\n~~~~\n<script>literal</script>\n";
	const heavy = await inline(Array.from({ length: 8 }, (_, i) => [`file-${i}.md`, Buffer.from(hostile + "é".repeat(400_000))]));
	assert.ok(Buffer.byteLength(heavy.text) <= 16384, String(Buffer.byteLength(heavy.text)));
	assert.doesNotMatch(heavy.text, /\uFFFD/);
	for (const file of heavy.ids) assert.ok(heavy.text.includes(`[truncated — full file at ${stored(d.root, file)}]`));
	assert.equal((heavy.text.match(/File: /g) ?? []).length, 8);
	assert.equal((await inline([["small.md", Buffer.from(hostile)]])).text, `File: small.md\n\`\`\`\`text\n${hostile}\n\`\`\`\`\n\n`);
	assert.ok(Buffer.byteLength((await inline([["runs.txt", Buffer.from("`".repeat(100_000) + "~".repeat(100_000))]])).text) <= 16384);
	assert.equal((await inline([["small.txt", Buffer.from("short note ✓")]])).text, "File: small.txt\n```text\nshort note ✓\n```\n\n");
	d.tick();
	const big = Buffer.from(`<!doctype html>\n<p>${"<div class=\"row\">héllo ✓ 😀</div>\n".repeat(5_400)}</p>`);
	const one = await inline([["page.html", big]]);
	assert.ok(Buffer.byteLength(one.text) <= 16384 && !/\uFFFD/.test(one.text) && one.text.includes(`[truncated — full file at ${stored(d.root, one.ids[0]!)}]`));
	const samples = ["é", "✓", "😀", "日本", "ascii ", "```", "~~~", "Ω"];
	const eight = await inline(samples.map((s, i) => [`mix-${i}.md`, Buffer.from(`# ${i}\n` + s.repeat(4_000 + i * 997))]));
	assert.ok(Buffer.byteLength(eight.text) <= 16384 && !/\uFFFD/.test(eight.text), String(Buffer.byteLength(eight.text)));
	assert.equal((eight.text.match(/File: mix-/g) ?? []).length, 8);
	for (const [i, file] of eight.ids.entries()) assert.deepEqual(readFileSync(stored(d.root, file)), Buffer.from(`# ${i}\n` + samples[i]!.repeat(4_000 + i * 997)), "the stored file keeps every byte");
});
