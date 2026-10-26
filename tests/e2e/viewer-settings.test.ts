/**
 * Behavior 20 (P20): Dashboard schedules and settings through `bin/cp-view` on a scratch home with its clock pinned
 * (tests/harness/process-clock.ts), real HTTP and the served app in a tests/harness/dashboard.ts tab. The operator
 * session is the real dashboard-control server with the real settings ports; `pi --list-models` is a stub on PATH.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { LAYOUT } from "../../src/contracts.ts";
import { openScheduleRunStore } from "../../src/schedule-runs.ts";
import { resolveExecution } from "../../src/schedule-native.ts";
import type { RunExecution } from "../../src/viewer/schedule-run-core.ts";
import type { Ledger } from "../../src/ledger.ts";
import { MandateStore } from "../../src/mandate.ts";
import { loadMandateDefaults } from "../../src/mandate-defaults.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { readScheduleFile } from "../../src/viewer/schedule-core.ts";
import { nativePolicyDraft, policyFromLegacy } from "../../src/viewer/schedule-policy.ts";
import type { ControlPorts } from "../../src/dashboard-control.ts";
import { settingsPorts } from "../../src/settings-control.ts";
import { appendScheduleControlLine } from "../../src/viewer/control-audit.ts";
import { controlConfigFile, controlJournalFile, controlRecordFile, controlSocketFile, readControlRecord, scheduleControlFile } from "../../src/viewer/control-files.ts";
import { dashboard, operatorSession, startViewer, type Tab, until } from "../harness/dashboard.ts";
import { createScratchHome, createScratchLedger, REPO_ROOT } from "../harness/index.ts";
import type { Init, Reply } from "../harness/remote.ts";

process.env.TZ = "UTC";
type View = Awaited<ReturnType<typeof dashboard>>;
type Line = Record<string, unknown>;
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const lines = (file: string): Line[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line) : [];
const iso = (at: number) => new Date(at).toISOString();

/** A guarded JSON POST from this viewer's own origin; `extra` overrides any header. */
const post = (view: View, body: unknown, token: string | null, extra: Record<string, string> = {}): Init => ({
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
	headers: { origin: view.origin, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});

/** The viewer's clock (pinned at `start`); `step` moves it `shift` ms on, past the 60 s control-limiter window. */
function clock(view: View, start: number) {
	let at = start, real = Date.now();
	view.pin(iso(start));
	const now = () => at + Date.now() - real;
	return { now, step: (shift = 61_000) => { at = now() + shift; real = Date.now(); view.pin(iso(at)); return at; } };
}

/** The real dashboard-control server, with the real settings ports on `home` unless `settings` is false. */
async function session(t: TestContext, home: string, stateDir: string, settings = true, extra: Partial<ControlPorts> = {}): Promise<string> {
	await operatorSession(t, stateDir, () => true, { ...(settings ? settingsPorts({ target: () => ({ home, mode: "multi" }), env: {} }) : {}), ...extra });
	return (readControlRecord(stateDir) as { record: { csrf: string } }).record.csrf;
}

/** Forces the tab's screen to re-read its data: the harness stubs the refresh stream, a visibility flip refetches. */
async function refresh(tab: Tab) {
	for (const hidden of [true, false]) {
		Object.defineProperty(tab.document, "hidden", { configurable: true, value: hidden });
		tab.document.dispatchEvent(new tab.window.Event("visibilitychange"));
	}
	await new Promise((done) => setTimeout(done, 200));
}

// ---------------------------------------------------------------------------------------------------------------
// Schedule control over HTTP (baseline tests/viewer-schedule-control-http.test.ts).

const SCHEDULE = "sch-abc123";
const NIGHTLY = { id: SCHEDULE, name: "nightly", project: "demo", mandate_id: "md-abcd1234", trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, job: { title: "nightly report", kind: "research", delivery: "answer" }, enabled: true, created_at: "2026-07-01T00:00:00Z" };
const T0 = Date.parse("2026-07-01T07:00:00Z");
const seedNightly = (stateDir: string) => {
	put(join(stateDir, "parent.lock"), JSON.stringify({ pid: process.pid, started_at: "2026-07-01T00:00:00Z" }));
	put(join(stateDir, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [NIGHTLY] }));
};

test("P20-schedule-control-http: every refusal, in order, is one viewer line of kind schedule and never a request line; a 202 only with its request line", { timeout: 120_000 }, async (t) => {
	const view = await dashboard(t, { at: iso(T0), seed: seedNightly });
	const { stateDir } = view;
	const time = clock(view, T0);
	const status0 = await view.get("/api/schedules/control");
	assert.equal(status0.status, 200);
	assert.deepEqual([status0.body.enabled, status0.body.reason, status0.body.error, status0.body.requests, (status0.body.parent as Line).running], [true, null, null, [], true]);
	assert.equal(existsSync(scheduleControlFile(stateDir)), false, "the status route never writes");
	const token = String(status0.body.token);
	assert.match(token, /^[0-9a-f]{64}$/);
	const audit = controlJournalFile(stateDir);
	const body = { op: "disable", schedule_id: SCHEDULE };
	const send = (payload: unknown, tok: string | null = token, extra: Record<string, string> = {}) => view.get("/api/schedules/request", post(view, payload, tok, extra));
	const refused = async (reply: () => Promise<Reply>, status: number, reason: RegExp, fields: Line = {}) => {
		time.step();
		const before = lines(audit).length;
		const out = await reply();
		assert.equal(out.status, status, JSON.stringify(out.body));
		assert.match(String(out.body.error), reason);
		const after = lines(audit);
		assert.equal(after.length, before + 1, `one audit line for ${status} ${reason}`);
		const line = after.at(-1)!;
		assert.deepEqual({ type: line.type, by: line.by, kind: line.kind, status: line.status, peer: line.peer }, { type: "refused", by: "viewer", kind: "schedule", status, peer: "127.0.0.1" });
		for (const [key, value] of Object.entries(fields)) assert.deepEqual(line[key], value, key);
		assert.equal(lines(scheduleControlFile(stateDir)).filter((l) => l.type === "request").length, 0, "no refusal writes a request line");
	};
	assert.equal((await view.get("/api/schedules/request")).status, 405);
	assert.equal(lines(audit).length, 0, "the method check precedes the journal");
	for (let i = 0; i < 20; i++) await send("{");
	const limited = await send(body);
	assert.equal(limited.status, 429, "20 per 60 s per client address, refusals counted");
	assert.equal(lines(audit).at(-1)!.status, 429);
	rmSync(audit);

	put(controlConfigFile(stateDir), '{"enabled": "maybe"}');
	await refused(() => send(body), 503, /config is invalid/);
	put(controlConfigFile(stateDir), '{"enabled": false}');
	await refused(() => send(body), 403, /dashboard control is off/);
	rmSync(controlConfigFile(stateDir));
	await refused(() => send(body, token, { origin: "https://evil.example" }), 403, /Origin must be/);
	await refused(() => send(body, token, { "sec-fetch-site": "cross-site" }), 403, /cross-site/);
	await refused(() => send(body, token, { "content-type": "text/plain" }), 415, /application\/json/);
	await refused(() => send({ ...body, pad: "z".repeat(21 * 1024) }), 413, /20480 bytes/);
	await refused(() => send("{not json"), 400, /not JSON/);
	await refused(() => send({ op: "shell", schedule_id: SCHEDULE }), 400, /body must be/, { schedule_id: SCHEDULE });
	await refused(() => send({ ...body, extra: 1 }), 400, /body must be/, { op: "disable" });
	await refused(() => send({ op: "run_now", schedule_id: "sch-../x" }), 400, /body must be/, { op: "run_now", schedule_id: undefined });
	put(join(stateDir, "parent.lock"), JSON.stringify({ pid: 2 ** 30, started_at: "2026-07-01T00:00:00Z" }));
	await refused(() => send(body), 503, /parent not running: the recorded parent pid 1073741824 is not running/, { op: "disable", schedule_id: SCHEDULE });
	put(join(stateDir, "parent.lock"), JSON.stringify({ pid: process.pid, started_at: "2026-07-01T00:00:00Z" }));
	await refused(() => send(body, null), 403, /control token missing or stale/);
	await refused(() => send(body, "f".repeat(64)), 403, /control token missing or stale/);
	await refused(() => send({ op: "remove", schedule_id: "sch-ffffff" }), 404, /no schedule sch-ffffff/);
	put(join(stateDir, "schedules.json"), "{");
	await refused(() => send(body), 503, /schedules unreadable/);
	put(join(stateDir, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [NIGHTLY] }));

	time.step();
	for (let i = 0; i < 20; i++) appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id: `sc-00000000000000-${String(i).padStart(8, "0")}`, at: iso(time.now()), peer: null, op: "disable", schedule_id: SCHEDULE });
	const queued = lines(scheduleControlFile(stateDir)).length;
	const full = await send(body);
	assert.equal(full.status, 409);
	assert.match(String(full.body.error), /20 schedule requests already wait for the parent/);
	assert.equal(lines(scheduleControlFile(stateDir)).length, queued, "a full queue writes no request line");
	rmSync(scheduleControlFile(stateDir));
	// Readable (one JSON number) but unwritable even as root: kernfs refuses writes to a 0444 attribute.
	symlinkSync("/sys/devices/system/cpu/kernel_max", scheduleControlFile(stateDir));
	await refused(() => send(body), 500, /schedule control journal unwritable/);
	rmSync(scheduleControlFile(stateDir));

	time.step();
	const sent = await send({ op: "run_now", schedule_id: SCHEDULE });
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.match(String(sent.body.id), /^sc-\d{14}-[0-9a-f]{8}$/);
	assert.equal(sent.body.state, "queued");
	const [line] = lines(scheduleControlFile(stateDir));
	assert.deepEqual([line?.type, line?.by, line?.id, line?.op, line?.schedule_id, line?.peer], ["request", "viewer", sent.body.id, "run_now", SCHEDULE, "127.0.0.1"]);
	appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id: "sc-00000000000000-00000000", at: iso(time.now() - 121_000), peer: null, op: "disable", schedule_id: SCHEDULE });
	const after = (await view.get("/api/schedules/control")).body.requests as Line[];
	assert.deepEqual(after.map((r) => [r.op, r.state]), [["disable", "expired"], ["run_now", "queued"]], "one 121 s old expired");
	assert.match(String(after[0]?.reason), /not taken by the parent within 120 s/);

	// client_id: a resend returns the first receipt and writes nothing; policy ops keep the same guard chain.
	time.step();
	rmSync(scheduleControlFile(stateDir));
	const adopt = { op: "adopt", schedule_id: SCHEDULE, revision: 0, client_id: "sk-20261009090000-abcdef12" };
	assert.equal((await send(adopt, null)).status, 403);
	assert.equal((await send(adopt, token, { origin: "https://evil.example" })).status, 403);
	assert.equal((await send({ ...adopt, revision: -1 })).status, 400);
	assert.equal((await send({ ...adopt, op: "save_policy", policy: {} })).status, 400);
	const first = await send(adopt);
	assert.equal(first.status, 202);
	const journal = readFileSync(scheduleControlFile(stateDir), "utf8");
	assert.deepEqual((await send(adopt)).body, first.body, "one receipt per client_id");
	assert.equal(readFileSync(scheduleControlFile(stateDir), "utf8"), journal, "without another request");
	appendScheduleControlLine(stateDir, { type: "outcome", by: "parent", id: String(first.body.id), at: iso(time.now()), state: "done", reason: "Settings saved", job_id: null });
	const done = await send(adopt);
	assert.deepEqual([done.body.id, done.body.state], [first.body.id, "done"]);
	const requests = (await view.get("/api/schedules/control")).body.requests as Line[];
	assert.deepEqual([requests[0]?.client_id, requests[0]?.revision], [adopt.client_id, 0]);
	assert.equal(lines(scheduleControlFile(stateDir)).filter((r) => r.type === "request").length, 1);
	assert.equal((await send({ op: "deactivate", schedule_id: SCHEDULE })).status, 202);

	put(controlConfigFile(stateDir), '{"enabled": false}');
	const off = await view.get("/api/schedules/control");
	assert.deepEqual([off.body.enabled, off.body.token], [false, null], "off: no token");
	assert.match(String(off.body.reason), /^Dashboard control is off/);
	rmSync(controlConfigFile(stateDir));
	rmSync(join(stateDir, "parent.lock"));
	assert.equal((await view.get("/api/schedules/control")).body.reason, "Parent not running: no parent lock");
	assert.equal((await view.get("/api/schedules", { method: "POST" })).status, 405, "/api/schedules stays read-only");
});

test("P20-schedule-policy-http: the policy GET is tailnet-only and pure; neither schedule route answers without --require-tailnet", { timeout: 120_000 }, async (t) => {
	const view = await dashboard(t, { at: iso(T0), seed: seedNightly });
	const { stateDir } = view;
	const path = `/api/schedules/policy?schedule_id=${SCHEDULE}`;
	const before = readFileSync(join(stateDir, "schedules.json"), "utf8");
	const policy = await view.get(path);
	assert.equal(policy.status, 200);
	assert.deepEqual([policy.body.policy, policy.body.legacy], [null, null]);
	assert.match(String(policy.body.blocking), /needs setup/, "an absent policy names its readiness");
	assert.equal(readFileSync(join(stateDir, "schedules.json"), "utf8"), before);
	assert.deepEqual([existsSync(join(stateDir, "schedule-policies.json")), existsSync(scheduleControlFile(stateDir))], [false, false], "the read writes nothing");
	assert.equal((await view.get("/api/schedules/policy?schedule_id=../bad")).status, 400);
	assert.equal((await view.get("/api/schedules/policy?schedule_id=sch-ffffff")).status, 404);
	put(join(stateDir, "schedule-policies.json"), "{");
	assert.equal((await view.get(path)).status, 503, "a malformed policy store is unavailable");

	const open = await dashboard(t, { at: iso(T0), requireTailnet: false, seed: seedNightly });
	assert.equal((await open.get("/api/schedules/control")).status, 403);
	assert.equal((await open.get("/api/schedules/request", post(open, { op: "disable", schedule_id: SCHEDULE }, "x"))).status, 403);
	assert.equal((await open.get(path)).status, 403);
	assert.deepEqual([existsSync(controlJournalFile(open.stateDir)), existsSync(scheduleControlFile(open.stateDir))], [false, false], "nothing is journaled");
});

// ---------------------------------------------------------------------------------------------------------------
// Settings over HTTP and the model list (baseline tests/viewer-settings-http.test.ts, tests/viewer-model-list.test.ts).

const APPLY = "/api/settings/apply";
const RESTORE = "/api/settings/restore";
const REQUEST_ID = "req-12345678";
const TABLE = "provider   model         context  max-out  thinking  images\nanthropic  claude-opus-5-5  200K  32K  yes  yes\nopenai     gpt-5         400K     128K     yes       yes\n";

/** A stub `pi` on the viewer's PATH: it counts calls, waits while `hold()`, then prints `out` and exits `status`. */
function stubPi(home: string) {
	const dir = join(home, "stub-bin");
	const script = join(dir, "pi");
	const write = () => { put(script, '#!/bin/sh\nd="$(dirname "$0")"\necho 1 >> "$d/calls"\nwhile [ -e "$d/hold" ]; do sleep 0.05; done\ncat "$d/out"\nexit "$(cat "$d/status")"\n'); chmodSync(script, 0o755); };
	const answer = (out: string, status = 0) => { put(join(dir, "out"), out); put(join(dir, "status"), String(status)); };
	write();
	answer(TABLE);
	return {
		env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin` }, answer,
		hold: () => put(join(dir, "hold"), ""), release: () => rmSync(join(dir, "hold"), { force: true }),
		calls: () => lines(join(dir, "calls")).length, remove: () => rmSync(script), restore: write,
	};
}

/** A scratch home whose viewer runs `pi` from the stub; `data/` exists. */
async function settingsHome(t: TestContext, options: { requireTailnet?: boolean } = {}) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const stub = stubPi(scratch.path);
	mkdirSync(join(scratch.path, LAYOUT.data), { recursive: true });
	mkdirSync(join(scratch.path, LAYOUT.state), { recursive: true });
	const view = { home: scratch.path, stateDir: join(scratch.path, LAYOUT.state), ...(await startViewer(t, { home: scratch.path, at: iso(T0), env: stub.env, ...options })) };
	return { view, stub };
}

const settingsPost = (view: View, token: string | null, body: unknown, revision: string | null, headers: Record<string, string> = {}) =>
	post(view, body, token, { ...(revision ? { "if-match": `"${revision}"` } : {}), ...headers });

async function journaled(stateDir: string, send: () => Promise<Reply>): Promise<{ reply: Reply; lines: Line[] }> {
	const before = lines(controlJournalFile(stateDir)).length;
	const reply = await send();
	return { reply, lines: lines(controlJournalFile(stateDir)).slice(before) };
}
function oneRefused(result: { reply: Reply; lines: Line[] }, status: number, label: string): void {
	assert.equal(result.reply.status, status, `${label}: ${JSON.stringify(result.reply.body)}`);
	assert.deepEqual(result.lines.map((line) => [line.type, line.by, line.kind, line.status, line.reason]), [["refused", "viewer", "settings", status, result.reply.body.error]], label);
}

test("P20-settings-refusals: the settings write routes refuse in order, each viewer refusal one refused line of kind settings", { timeout: 120_000 }, async (t) => {
	const { view } = await settingsHome(t);
	const { home, stateDir } = view;
	const time = clock(view, T0);
	const revision = "a".repeat(64);
	const good = { changes: { "review.timeout_ms": 60_000 }, request_id: REQUEST_ID };
	const apply = (token: string | null, body: unknown, rev: string | null = revision, headers: Record<string, string> = {}) => () => view.get(APPLY, settingsPost(view, token, body, rev, headers));
	const refused = async (send: () => Promise<Reply>, status: number, label: string) => { time.step(); const result = await journaled(stateDir, send); oneRefused(result, status, label); return result; };

	const get = await journaled(stateDir, () => view.get(APPLY));
	assert.equal(get.reply.status, 405);
	assert.deepEqual(get.lines, [], "the method check precedes the journal");
	await refused(apply(null, good, revision, { origin: "https://evil.example" }), 403, "origin");
	await refused(apply(null, good, revision, { "sec-fetch-site": "cross-site" }), 403, "sec-fetch-site");
	await refused(apply(null, good, revision, { "content-type": "text/plain" }), 415, "content type");
	await refused(apply(null, { ...good, pad: "x".repeat(30_000) }), 413, "size");
	for (const body of [{}, { ...good, extra: 1 }, { changes: {}, request_id: REQUEST_ID }, { ...good, request_id: "x" }, { ...good, dry_run: "yes" }, "[]"]) {
		await refused(apply(null, body), 400, JSON.stringify(body));
	}
	for (const body of [{ request_id: REQUEST_ID }, { keys: ["review.timeout_ms"], all: true, request_id: REQUEST_ID }, { changes: { a: 1 }, request_id: REQUEST_ID }]) {
		await refused(() => view.get(RESTORE, settingsPost(view, null, body, revision)), 400, `restore ${JSON.stringify(body)}`);
	}
	await refused(apply(null, good, null), 428, "missing If-Match");
	await refused(apply(null, good, null, { "if-match": 'W/"abc"' }), 400, "malformed If-Match");
	const offline = await refused(apply(null, good), 409, "offline");
	assert.equal(offline.reply.body.state, "offline");
	await refused(apply(null, { ...good, dry_run: true }, null), 409, "a dry run needs no If-Match, but still the session");
	await session(t, home, stateDir);
	await refused(apply(null, good), 403, "no token");
	await refused(apply("0".repeat(64), good), 403, "stale token");

	const { view: closed } = await settingsHome(t, { requireTailnet: false });
	const outside = await journaled(closed.stateDir, () => closed.get(APPLY, settingsPost(closed, null, good, revision)));
	assert.equal(outside.reply.status, 403);
	assert.deepEqual(outside.lines, [], "the --require-tailnet guard precedes the journal");
	assert.equal((await closed.get("/api/settings")).status, 403);
});

test("P20-settings-relay: the session's outcomes pass through with no viewer line, apply → restore round-trips data/gate.json, GET leaks no secret", { timeout: 120_000 }, async (t) => {
	const { view } = await settingsHome(t);
	const { home, stateDir } = view;
	const gate = join(home, LAYOUT.gateConfigFile);
	writeFileSync(gate, JSON.stringify({ schema_version: 1 }));
	writeFileSync(join(home, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://secret-gateway.example/", path: "/v1/secret-path" }));
	const csrf = await session(t, home, stateDir);
	const status = await view.get("/api/settings");
	assert.equal(status.status, 200);
	assert.deepEqual([status.body.enabled, status.body.running, status.body.supported, status.body.writable], [true, true, true, true]);
	assert.equal((status.body.catalog as unknown[]).length, 32);
	assert.ok("available_models" in status.body && "models_error" in status.body, "the model list rides the read: a list or a note, never missing");
	for (const secret of ["secret-gateway", "/v1/secret-path", home]) assert.ok(!status.text.includes(secret), `GET leaks ${secret}`);
	const revision = (status.body.snapshot as { revision: string }).revision;
	const pass = async (path: string, body: unknown, rev: string | null, want: number) => {
		const result = await journaled(stateDir, () => view.get(path, settingsPost(view, csrf, body, rev)));
		assert.equal(result.reply.status, want, JSON.stringify(result.reply.body));
		assert.deepEqual(result.lines, [], "the session's outcome is its own audit's, not a viewer line");
		return result.reply.body;
	};
	const preview = await pass(APPLY, { changes: { "review.timeout_ms": 60_000 }, request_id: REQUEST_ID, dry_run: true }, null, 200);
	assert.equal(preview.state, "planned");
	assert.deepEqual(JSON.parse(readFileSync(gate, "utf8")), { schema_version: 1 }, "a dry run writes nothing");
	const applied = await pass(APPLY, { changes: { "review.timeout_ms": 60_000 }, request_id: REQUEST_ID }, revision, 200);
	assert.equal(applied.state, "applied");
	assert.deepEqual(JSON.parse(readFileSync(gate, "utf8")), { schema_version: 1, review_timeout_ms: 60_000 });
	const stale = await pass(RESTORE, { keys: ["review.timeout_ms"], request_id: REQUEST_ID }, revision, 412);
	assert.equal(stale.revision, applied.revision);
	await pass(APPLY, { changes: { "models.allow": [] }, request_id: REQUEST_ID }, applied.revision as string, 403);
	await pass(APPLY, { changes: { "sessions.tool_call_cap": 5 }, request_id: REQUEST_ID }, applied.revision as string, 403);
	await pass(APPLY, { changes: { "review.timeout_ms": 1 }, request_id: REQUEST_ID }, applied.revision as string, 400);
	const restored = await pass(RESTORE, { section: "review", request_id: REQUEST_ID }, applied.revision as string, 200);
	assert.equal(restored.state, "applied");
	assert.deepEqual(JSON.parse(readFileSync(gate, "utf8")), { schema_version: 1 });
	const audit = (await view.get("/api/settings")).body.audit as Array<{ type: string; peer?: string }>;
	assert.deepEqual(audit.map((line) => line.type), ["intent", "applied", "refused", "refused", "refused", "refused", "intent", "applied"]);
	assert.equal(audit[0]!.peer, "127.0.0.1");
});

test("P20-settings-session: an older session (`unknown op`) is 409 unsupported with one refused line; offline and opted-out reads say so", { timeout: 120_000 }, async (t) => {
	const { view } = await settingsHome(t);
	const { home, stateDir } = view;
	const offline = await view.get("/api/settings");
	assert.equal(offline.status, 200);
	assert.deepEqual([offline.body.enabled, offline.body.running, offline.body.snapshot, offline.body.catalog, offline.body.audit], [true, false, null, null, []]);
	assert.match(String(offline.body.reason), /^Operator session offline/);
	put(controlConfigFile(stateDir), JSON.stringify({ enabled: false }));
	const off = await view.get("/api/settings");
	assert.deepEqual([off.status, off.body.enabled, off.body.running, off.body.snapshot], [200, false, false, null]);
	rmSync(controlConfigFile(stateDir));

	const csrf = await session(t, home, stateDir, false);
	const reply = await journaled(stateDir, () => view.get(RESTORE, settingsPost(view, csrf, { all: true, request_id: REQUEST_ID }, "b".repeat(64))));
	oneRefused(reply, 409, "unknown op");
	assert.equal(reply.reply.body.state, "refused");
	assert.match(String(reply.reply.body.error), /^unsupported: .*restart the operator session to load Settings/);
	const status = await view.get("/api/settings");
	assert.deepEqual([status.body.enabled, status.body.running, status.body.supported, status.body.writable, status.body.snapshot], [true, true, false, false, null]);
	assert.match(String(status.body.reason), /restart the operator session to load Settings/);
});

test("P20-model-list: GET /api/settings never waits for pi --list-models; one shared run, a 5 min list, a 30 s note per failure", { timeout: 180_000 }, async (t) => {
	const { view, stub } = await settingsHome(t);
	await session(t, view.home, view.stateDir);
	const time = clock(view, T0);
	const read = async () => (await view.get("/api/settings")).body;
	const models = (body: Line) => [body.available_models, body.models_error, body.models_loading];
	stub.hold();
	const first = await read();
	assert.deepEqual([...models(first), (first.catalog as unknown[]).length], [null, null, true, 32], "a listing that never returns answers loading at once");
	assert.deepEqual(models(await read()), [null, null, true]);
	await until(stub.calls, (n) => n === 1, "the one background run");
	assert.equal(stub.calls(), 1, "repeat reads share the one background run");
	stub.release();
	const both = ["anthropic/claude-opus-5-5", "openai/gpt-5"];
	await until(read, (body) => JSON.stringify(models(body)) === JSON.stringify([both, null, false]), "the list once it lands");
	const landed = time.now();

	time.step(landed + 290_000 - time.now());
	assert.deepEqual((await read()).available_models, both);
	await new Promise((done) => setTimeout(done, 1_000)); // a background run started by that read would have spawned by now
	assert.equal(stub.calls(), 1, "a good list is fresh for 5 minutes");
	stub.answer("provider model\nopenai gpt-6.1-sol\n");
	stub.hold();
	time.step(20_000);
	assert.deepEqual((await read()).available_models, both, "the stale list answers at once");
	await until(stub.calls, (n) => n === 2, "the refresh");
	await read();
	assert.equal(stub.calls(), 2, "one refresh, not two");
	stub.release();
	await until(read, (body) => JSON.stringify(body.available_models) === '["openai/gpt-6.1-sol"]', "the refreshed list");

	const failures: Array<[string, () => void, string]> = [
		["No models available", () => stub.answer("No models available. Set up authentication first.\n"), "pi lists no usable models"],
		["an unreadable table", () => stub.answer("something else entirely"), "model list unavailable"],
		["a non-zero exit", () => stub.answer(TABLE, 1), "model list unavailable"],
		["no pi on PATH", () => stub.remove(), "model list unavailable"],
	];
	for (const [label, fail, error] of failures) {
		fail();
		time.step(310_000);
		const noted = await until(read, (body) => body.models_error === error, label);
		assert.deepEqual(models(noted), [null, error, false], `${label}: a note, never an error`);
		const calls = stub.calls();
		time.step(20_000);
		assert.equal((await read()).models_error, error, `${label}: a failure is cached briefly`);
		assert.equal(stub.calls(), calls);
		stub.restore();
		stub.answer(TABLE);
		time.step(15_000);
		assert.equal((await read()).models_error, error, `${label}: the failure is served while pi is asked again`);
		await until(read, (body) => body.models_error === null, `${label}: asked again after 30 s`);
		assert.equal(stub.calls(), calls + 1);
	}
});

// ---------------------------------------------------------------------------------------------------------------
// The Settings page in a served tab (baseline tests/viewer-settings-ui.test.ts).

const MODELS = "provider model\nopenai gpt-5\nanthropic claude-opus-5-5\nanthropic claude-haiku-5\n";
const optionTexts = (select: Element) => [...select.querySelectorAll("option")].map((option) => option.textContent);
const settle = () => new Promise((done) => setTimeout(done, 150));

/** Settings in a tab on a home with the shipped routing.json (unless `routing` is false) and a live session. */
async function settingsTab(t: TestContext, { routing = true, models = MODELS, status = 0, pending = false, ports = {} }: { routing?: boolean; models?: string; status?: number; pending?: boolean; ports?: Partial<ControlPorts> } = {}) {
	const { view, stub } = await settingsHome(t);
	if (routing) copyFileSync(join(REPO_ROOT, "defaults/routing.default.json"), join(view.home, LAYOUT.routingFile));
	stub.answer(models, status);
	if (pending) stub.hold();
	const csrf = await session(t, view.home, view.stateDir, true, ports);
	if (!pending) await until(() => view.get("/api/settings").then((reply) => reply.body.models_loading), (loading) => loading === false, "the first model listing");
	const tab = await view.open("#settings");
	await tab.find('section[aria-label="Auto-compaction"]');
	const section = (title: string) => tab.$(`section[aria-label="${title}"]`)!;
	const press = async (scope: Element, label: string) => { tab.click([...scope.querySelectorAll("button")].find((b) => b.textContent === label)!); await settle(); };
	const choose = async (select: Element, value: string) => {
		for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === value);
		select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
		await settle();
	};
	const enter = async (input: Element, value: string, event = "input") => {
		(input as HTMLInputElement).value = value;
		input.dispatchEvent(new tab.window.Event(event, { bubbles: true }));
		await settle();
	};
	const posts = () => tab.requests.filter((r) => r.method === "POST").map((r) => ({ ...r, json: JSON.parse(r.body ?? "{}") as Line }));
	const snapshot = async () => (await view.get("/api/settings")).body.snapshot as { revision: string; fields: Array<{ key: string; value: unknown }> };
	return { view, stub, csrf, tab, section, press, choose, enter, posts, snapshot };
}

test("P20-settings-page: four sections; Save posts If-Match, the control token and only the drafted keys; a 412 keeps the draft", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t);
	assert.deepEqual(ui.tab.$$("section.settings-section > h2").map((h) => h.textContent), ["Model routing", "Parent and operator models", "Grant defaults", "Auto-compaction", "Devices"], "the four settings sections, then the served page's Devices");
	assert.equal(ui.section("Model routing").querySelectorAll("li.settings-rule").length, 6, "one row per shipped rubric entry");
	const people = ui.section("Parent and operator models");
	const parent = people.querySelector("#setting-models-parent")!;
	await ui.choose(parent, "custom");
	await ui.enter(parent.parentElement!.querySelector("input")!, "anthropic/claude-opus-5-5");
	assert.equal(people.querySelector(".settings-unsaved")?.textContent, "1 unsaved change");
	const loaded = (await ui.snapshot()).revision;
	writeFileSync(join(ui.view.home, LAYOUT.gateConfigFile), JSON.stringify({ schema_version: 1, review_timeout_ms: 60_000 }));
	const fresh = (await ui.snapshot()).revision;
	assert.notEqual(fresh, loaded, "a change on disk the page has not seen");
	await ui.press(people, "Save");
	await ui.tab.find(".settings-stale", (el) => /Changed on disk/.test(el.textContent ?? ""));
	const [stale] = ui.posts();
	assert.deepEqual([stale?.path, stale?.status, stale?.headers["if-match"], stale?.headers["x-cp-control-token"]], ["/api/settings/apply", 412, `"${loaded}"`, ui.csrf]);
	assert.deepEqual(stale?.json.changes, { "models.parent": "anthropic/claude-opus-5-5" });
	assert.match(String(stale?.json.request_id), /^[A-Za-z0-9_-]{16}$/);
	assert.equal((people.querySelector("#setting-models-parent")!.parentElement!.querySelector("input") as HTMLInputElement).value, "anthropic/claude-opus-5-5", "the draft survives a 412");
	await ui.press(people, "Save");
	await ui.tab.find(".settings-ok", (el) => /^Saved · 1 change$/.test(el.textContent ?? ""));
	assert.equal(ui.posts()[1]?.headers["if-match"], `"${fresh}"`, "the retry carries the fresh revision");
	assert.deepEqual(ui.posts()[1]?.json.changes, { "models.parent": "anthropic/claude-opus-5-5" });
	assert.equal((await ui.snapshot()).fields.find((f) => f.key === "models.parent")?.value, "anthropic/claude-opus-5-5", "written by the session");
});

test("P20-settings-rubric: rubric edits post the whole row list; restore bodies per section; a refusal lists its errors", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t);
	const shipped = (await ui.snapshot()).fields.find((field) => field.key === "models.rubric")!.value as Line[];
	const workers = ui.section("Model routing");
	const first = workers.querySelector("li.settings-rule")!;
	await ui.choose(first.querySelector("select")!, "custom");
	await ui.enter(first.querySelector("input")!, "openai/gpt-6.1-sol");
	ui.tab.click([...first.querySelectorAll("button")].find((b) => b.textContent === "×")!);
	await settle();
	for (const added of ["a/b", "c/d"]) {
		await ui.choose(first.querySelector("select[aria-label='Add a fallback to risky-any']")!, "custom");
		await ui.enter(first.querySelector("input[aria-label='Add a fallback to risky-any: custom id']")!, added, "change");
	}
	const thinking = [...first.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Thinking"))!;
	await ui.choose(thinking.querySelector("select")!, "low");
	assert.equal(workers.querySelector(".settings-unsaved")?.textContent, "1 unsaved change", "counts changed rows, not edits");
	assert.equal(workers.querySelectorAll("li.settings-rule-edited").length, 1);
	await ui.press(workers, "Save");
	await ui.tab.find(".settings-ok");
	assert.deepEqual((ui.posts()[0]!.json.changes as Line)["models.rubric"], [{ ...shipped[0], model: "openai/gpt-6.1-sol", fallbacks: ["a/b", "c/d"], thinking: "low" }, ...shipped.slice(1)]);
	await ui.press(workers, "Restore defaults");
	await ui.press(ui.section("Parent and operator models"), "Restore defaults");
	await ui.press(ui.section("Grant defaults"), "Restore defaults");
	await until(() => ui.posts().length, (n) => n === 4, "three restores");
	assert.deepEqual(ui.posts().slice(1).map((p) => [p.path, p.json.keys ?? p.json.section]), [
		["/api/settings/restore", ["models.rubric"]],
		["/api/settings/restore", ["models.parent", "models.operator"]],
		["/api/settings/restore", "grants"],
	]);
	const grants = ui.posts()[3]!;
	assert.deepEqual([grants.headers["content-type"], grants.headers["if-match"], grants.headers["x-cp-control-token"]], ["application/json", `"${(await ui.snapshot()).revision}"`, ui.csrf], "the exact restore request");
	assert.deepEqual(Object.keys(grants.json), ["section", "request_id"]);

	// A rubric changed on disk under a draft: the 412 refreshes the revision, the retry is refused row by row.
	const row = ui.section("Model routing").querySelector("li.settings-rule")!;
	await ui.choose(row.querySelector("select")!, "openai/gpt-5");
	const routingFile = join(ui.view.home, LAYOUT.routingFile);
	const routing = JSON.parse(readFileSync(routingFile, "utf8")) as { rubric: unknown[] };
	writeFileSync(routingFile, JSON.stringify({ ...routing, rubric: routing.rubric.slice(0, -1) }));
	await ui.press(ui.section("Model routing"), "Save");
	await ui.tab.find(".settings-stale");
	await ui.press(ui.section("Model routing"), "Save");
	const errors = await ui.tab.find(".settings-error");
	assert.equal(ui.posts().at(-1)?.status, 400);
	assert.deepEqual([...errors.querySelectorAll("li")].map((li) => li.textContent), ["models.rubric: 6 rows sent for 5; rows cannot be added, removed or reordered here"]);
});

test("P20-settings-compaction: both keys with what is in force; a bad threshold blocks Save; save and restore round-trip the file", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t);
	const compaction = ui.section("Auto-compaction");
	const effective = () => [...compaction.querySelectorAll(".settings-effective")].map((p) => p.textContent);
	assert.match(compaction.querySelector(".settings-help")?.textContent ?? "", /tokens.*next compaction check/);
	assert.deepEqual(effective(), ["In force: 200000 tokens, from code", "In force: 200000 tokens, from code"]);
	const parent = compaction.querySelector("#setting-sessions-parent_compact_at_tokens")!;
	assert.ok(compaction.querySelector("#setting-sessions-operator_compact_at_tokens"));
	const save = () => [...compaction.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
	for (const [typed, error] of [["0", "Must be at least 1"], ["1.5", "Must be a whole number"], ["", "A value is required"]] as const) {
		await ui.enter(parent, typed);
		assert.equal(compaction.querySelector("[role=alert]")?.textContent, error);
		assert.ok(save().hasAttribute("disabled"), `Save is blocked on ${JSON.stringify(typed)}`);
	}
	assert.equal(ui.posts().length, 0, "a blocked Save posts nothing");
	await ui.enter(parent, "150000");
	assert.equal(compaction.querySelector("[role=alert]"), null);
	await ui.press(compaction, "Save");
	await ui.tab.find(".settings-ok", (el) => /^Saved/.test(el.textContent ?? ""));
	assert.deepEqual(ui.posts()[0]!.json.changes, { "sessions.parent_compact_at_tokens": 150000 });
	await until(effective, (now) => now[0] === "In force: 150000 tokens, from file", "the re-read snapshot");
	assert.deepEqual(effective(), ["In force: 150000 tokens, from file", "In force: 200000 tokens, from code"], "the re-read snapshot shows the written file");
	await ui.press(compaction, "Restore defaults");
	assert.deepEqual(ui.posts()[1]!.json.keys, ["sessions.parent_compact_at_tokens", "sessions.operator_compact_at_tokens"]);
	await until(async () => (await ui.snapshot()).fields.find((f) => f.key === "sessions.parent_compact_at_tokens")!.value, (value) => value === 200000, "the restored default");
});

test("P20-settings-readonly: no control token is read only with every control disabled; an absent routing.json is one line, no rubric controls", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t, { routing: false, ports: { sessionFile: () => { throw new Error("status down"); } } });
	assert.equal(ui.tab.$(".settings-readonly")?.textContent, "Read only: no operator session serves dashboard control; start it to change settings");
	const controls = ui.tab.$$("section.settings-section").flatMap((s) => [...s.querySelectorAll("input, select, textarea, button")]);
	assert.ok(controls.length > 0 && controls.every((el) => el.hasAttribute("disabled") || el.closest("fieldset[disabled]")), "every settings control is disabled");
	const workers = ui.section("Model routing");
	assert.equal(workers.querySelector(".settings-readonly")?.textContent, "No data/routing.json: workers use each profile's own model.");
	assert.equal(workers.querySelectorAll("input, button").length, 0);
	assert.equal(ui.posts().length, 0);
});

test("P20-settings-dropdowns: grouped by provider; (unset) only for parent/operator; unlisted kept; Custom…; fallbacks cap at 4 and save", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t);
	assert.equal(ui.tab.$("datalist"), null, "no datalist any more");
	const people = ui.section("Parent and operator models");
	const parent = people.querySelector("#setting-models-parent")!;
	assert.equal(parent.tagName, "SELECT");
	assert.deepEqual([...parent.querySelectorAll("optgroup")].map((group) => [group.getAttribute("label"), [...group.querySelectorAll("option")].map((o) => o.getAttribute("value"))]), [
		["anthropic", ["anthropic/claude-haiku-5", "anthropic/claude-opus-5-5"]],
		["openai", ["openai/gpt-5"]],
	], "providers alphabetical, models alphabetical within each");
	assert.deepEqual(optionTexts(parent), ["(unset)", "anthropic/claude-haiku-5", "anthropic/claude-opus-5-5", "openai/gpt-5", "Custom…"]);
	assert.ok(people.querySelector("#setting-models-operator"), "the operator model is a dropdown too");
	const workers = ui.section("Model routing");
	const first = workers.querySelector("li.settings-rule")!;
	const model = first.querySelector("select")!;
	assert.equal(optionTexts(model)[0], "anthropic/claude-haiku-5", "a rubric model has no (unset)");
	assert.equal(optionTexts(first.querySelector("select[aria-label='Fallback 1 of risky-any']")!)[0], "openai/gpt-6.1-sol (not in pi's list)", "the unlisted current value stays selectable");
	const warns = (scope: Element) => [...scope.querySelectorAll(".settings-warn")].map((warn) => warn.textContent);
	assert.deepEqual(warns(first), ["Not in pi's model list: openai/gpt-6.1-sol. It can still be saved."]);
	assert.equal(first.querySelector("input"), null, "no text input until Custom…");
	await ui.choose(model, "custom");
	const custom = first.querySelector("input[aria-label='Model of risky-any: custom id']") as HTMLInputElement;
	assert.equal(custom.value, "anthropic/claude-opus-5-5", "Custom… opens on the current value");
	await ui.enter(custom, "my/other");
	assert.equal(warns(first).length, 2, "an unlisted custom model warns too");
	await ui.choose(model, "openai/gpt-5");
	assert.equal(first.querySelector("input[aria-label='Model of risky-any: custom id']"), null, "picking a listed model closes the custom input");
	assert.equal(warns(first).length, 1, "a listed value does not warn");
	const add = () => first.querySelector("select[aria-label='Add a fallback to risky-any']");
	assert.equal(optionTexts(add()!)[0], "Add fallback…");
	await ui.choose(add()!, "anthropic/claude-haiku-5");
	await ui.choose(add()!, "anthropic/claude-opus-5-5");
	await ui.choose(add()!, "custom");
	await ui.enter(first.querySelector("input[aria-label='Add a fallback to risky-any: custom id']")!, "my/fourth", "change");
	assert.equal(first.querySelectorAll(".settings-chip:not(.settings-add) select").length, 4);
	assert.equal(add(), null, "no Add fallback past 4");
	await ui.press(first, "×");
	assert.equal(first.querySelectorAll(".settings-chip:not(.settings-add) select").length, 3, "× removed one fallback (the saved list says which)");
	assert.ok(add(), "Add fallback is back under 4");
	await ui.choose(parent, "custom");
	await ui.enter(parent.parentElement!.querySelector("input")!, "my/custom-model");
	assert.match(people.querySelector(".settings-warn")?.textContent ?? "", /my\/custom-model/);
	await ui.press(workers, "Save");
	await until(() => ui.posts().length, (n) => n === 1, "the rubric save");
	const rows = ui.posts()[0]!.json.changes as { "models.rubric": Array<{ model: string; fallbacks?: string[] }> };
	assert.deepEqual([rows["models.rubric"][0]!.model, rows["models.rubric"][0]!.fallbacks], ["openai/gpt-5", ["anthropic/claude-haiku-5", "anthropic/claude-opus-5-5", "my/fourth"]]);
	await ui.tab.find(".settings-ok");
	await ui.press(people, "Save");
	await until(() => ui.posts().length, (n) => n === 2, "the parent save");
	assert.deepEqual(ui.posts()[1]!.json.changes, { "models.parent": "my/custom-model" });
});

test("P20-settings-unset: picking (unset) saves null", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t, { models: "provider model\nopenai gpt-5\n" });
	const people = ui.section("Parent and operator models");
	await ui.choose(people.querySelector("#setting-models-operator")!, "openai/gpt-5");
	await ui.choose(people.querySelector("#setting-models-operator")!, "");
	await ui.choose(people.querySelector("#setting-models-parent")!, "openai/gpt-5");
	await ui.press(people, "Save");
	await until(() => ui.posts().length, (n) => n === 1, "the save");
	assert.deepEqual(ui.posts()[0]!.json.changes, { "models.operator": null, "models.parent": "openai/gpt-5" });
});

test("P20-settings-listing: while pi's first listing runs, the current value and Custom… only, then the list after a retry", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t, { models: "provider model\nopenai gpt-5\n", pending: true });
	const status = () => ui.section("Model routing").querySelector("p[role=status]");
	assert.equal(status()?.textContent, "Loading the model list…");
	assert.deepEqual(optionTexts(ui.section("Model routing").querySelector("select")!), ["anthropic/claude-opus-5-5", "Custom…"]);
	assert.deepEqual(optionTexts(ui.tab.$("#setting-models-parent")!), ["(unset)", "Custom…"]);
	ui.stub.release();
	await ui.tab.find("optgroup");
	assert.deepEqual(optionTexts(ui.tab.$("#setting-models-parent")!), ["(unset)", "openai/gpt-5", "Custom…"], "the retry picked the list up");
	assert.equal(status(), null);
	assert.ok(ui.tab.requests.filter((r) => r.path === "/api/settings").length >= 2, "the page asked again");
});

test("P20-settings-unavailable: an unavailable list keeps each current value plus Custom…, and one note", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t, { status: 1 });
	assert.equal(ui.tab.$("optgroup"), null);
	const first = ui.section("Model routing").querySelector("li.settings-rule")!;
	assert.deepEqual(optionTexts(first.querySelector("select")!), ["anthropic/claude-opus-5-5", "Custom…"]);
	assert.deepEqual(optionTexts(first.querySelector("select[aria-label='Fallback 1 of risky-any']")!), ["openai/gpt-6.1-sol", "Custom…"]);
	assert.deepEqual(optionTexts(first.querySelector("select[aria-label='Add a fallback to risky-any']")!), ["Add fallback…", "Custom…"]);
	assert.equal(ui.tab.$$(".settings-warn").length, 0);
	assert.match(ui.section("Model routing").querySelector("p[role=status]")?.textContent ?? "", /^Model list unavailable \(model list unavailable\): type a provider\/model\.$/);
});

test("P20-settings-stale-token: a refusal with no transaction body is the page's error, verbatim", { timeout: 120_000 }, async (t) => {
	const ui = await settingsTab(t);
	const record = JSON.parse(readFileSync(controlRecordFile(ui.view.stateDir), "utf8")) as Line;
	writeFileSync(controlRecordFile(ui.view.stateDir), JSON.stringify({ ...record, csrf: "f".repeat(64) }));
	const grants = ui.section("Grant defaults");
	await ui.press(grants, "Restore defaults");
	const error = await ui.tab.find(".settings-error");
	assert.equal(ui.posts()[0]?.status, 403);
	assert.equal(error.querySelector("p, span, div")?.textContent ?? error.textContent, "Not saved: control token missing or stale; reload the page");
});

// ---------------------------------------------------------------------------------------------------------------
// The version badge's settling detail (baseline tests/viewer-version-badge.test.ts; #325).

test("P20-version-badge: #325 a settling updater's raw-ISO detail stays hidden for an idle, null or missing phase", { timeout: 120_000 }, async (t) => {
	// A checkout on this repo's HEAD (the commit the viewer loaded), borrowing its objects; origin/main is one ahead.
	const repo = mkdtempSync(join(tmpdir(), "cp-p20-repo-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "p20", GIT_AUTHOR_EMAIL: "p20@example.test", GIT_COMMITTER_NAME: "p20", GIT_COMMITTER_EMAIL: "p20@example.test" } }).trim();
	git("init", "-q", "-b", "main");
	const common = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
	writeFileSync(join(repo, ".git", "objects", "info", "alternates"), `${resolve(REPO_ROOT, common, "objects")}\n`);
	git("update-ref", "refs/heads/main", execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
	git("update-ref", "refs/remotes/origin/main", git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "upstream"));
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	put(join(scratch.path, LAYOUT.data, "update.json"), JSON.stringify({ enabled: true, interval_min: 5, quiet_min: 20 }));
	const view = await startViewer(t, { home: scratch.path, at: iso(T0), env: { CP_VERSION_REPO: repo } });
	const to = "a".repeat(40);
	const detail = `origin/main at aaaaaaa first seen ${iso(T0 - 9 * 60_000)}; quiet until ${iso(T0 + 11 * 60_000)}`;
	const headline = "1 behind (update to aaaaaaa waits for quiet origin/main until 07:11Z)";
	const badge = async (phase: string | null | undefined) => {
		const update: Line = { last_result: "skipped_settling", last_run_at: iso(T0 - 60_000), to, first_seen_sha: to, first_seen_at: iso(T0 - 9 * 60_000), detail };
		if (phase !== undefined) update.phase = phase;
		put(join(scratch.path, LAYOUT.state, "update.json"), JSON.stringify(update));
		const tab = await view.open("#settings");
		const more = (await tab.find("details.shell-more")) as HTMLDetailsElement;
		more.open = true;
		more.dispatchEvent(new tab.window.Event("toggle"));
		const summary = await tab.find(".shell-version summary", (el) => (el.getAttribute("title") ?? "").startsWith("1 behind"));
		const details = summary.parentElement as HTMLDetailsElement;
		details.open = true;
		details.dispatchEvent(new tab.window.Event("toggle"));
		const head = await tab.find(".shell-version-head");
		const text = details.textContent ?? "";
		tab.close();
		return { title: summary.getAttribute("title"), head: head.textContent, text };
	};
	// A record written before `phase` existed (or with phase null) is idle: the detail would only repeat the clock as ISO.
	for (const phase of ["idle", null, undefined]) {
		const seen = await badge(phase);
		assert.deepEqual([seen.title, seen.head], [headline, headline], String(phase));
		assert.match(seen.text, /waits for quiet origin\/main until 07:11Z/, String(phase));
		assert.doesNotMatch(seen.text, /T06:51:00/, String(phase));
	}
	assert.match((await badge("draining")).text, /T06:51:00/, "a running phase is not settled: the detail shows");
});

// ---------------------------------------------------------------------------------------------------------------
// The Schedules projection over GET /api/schedules (baseline tests/viewer-schedules.test.ts).

const NOW = Date.parse("2026-09-28T01:41:00Z");
const TEMPLATE = {
	seed_mandate_id: "md-seed1", channel: "operator_chat", objective: "triage", expiry_hours: 24, spend_usd: 10, spend_tokens: 500000, job_cap: 2,
	allowed_actions: ["plan", "implement"], ask_on: ["merge", "risk:high"],
	approval: { operator_quote: `Yes, triage. ${"long-unbroken-quote-".repeat(60)}`, decided_by: "operator-quote", approved_at: "2026-09-01T00:00:00Z" },
};
const CRON = {
	id: "sch-aaaaaa", name: "weekly digest", project: "demo", mandate_id: "md-live1",
	trigger: { type: "cron", cron: "0 6 * * 1", tz: "Europe/Warsaw" },
	job: { title: "Digest", kind: "research", delivery: "answer" },
	enabled: true, created_at: "2026-09-01T00:00:00Z", last_checked_at: "2026-09-28T01:40:00Z",
	last_fire: { at: "2026-09-21T04:00:10Z", slot: "2026-09-21T04:00:00.000Z", job_id: "cp-fire2", missed: true },
	grant_template: TEMPLATE,
};
const WATCH = {
	id: "sch-bbbbbb", name: "dep watch", project: "demo", mandate_id: "md-paus1",
	trigger: { type: "watch", script_path: "scripts/x.sh", every_seconds: 300, on: "changed" },
	job: { title: "Bump deps", kind: "ship", delivery: "pr" },
	enabled: false, created_at: "2026-09-01T00:00:00Z", last_checked_at: "2026-09-28T01:00:00Z", last_output_sha: "abc",
	last_skip: { at: "2026-09-28T01:00:00Z", reason: "fire at 2026-09-28T01:00Z not recorded: md-paus1 is paused" },
	grant_template: TEMPLATE,
};
const MANUAL = {
	id: "sch-cccccc", name: "self-review", project: "demo", mandate_id: "md-live1",
	trigger: { type: "manual" }, job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" },
	enabled: true, created_at: "2026-09-01T00:00:00Z",
};
const ANSWER = `ANSWER-HEAD Sunny, 29 C\n${"x".repeat(9000)}ANSWER-TAIL`;
const scheduleFile = (...schedules: unknown[]) => JSON.stringify({ schema_version: 2, schedules });
type Schedules = { generated_at: string; error: string | null; schedules: Array<Record<string, any>> };

/** A scratch home seeded as the scheduler, cp_mandate and intake leave it; `cp-view` on it, pinned at NOW. */
async function schedulesHome(t: TestContext, schedules?: string, requireTailnet = true) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const stateDir = join(home, LAYOUT.state);
	mkdirSync(join(stateDir, "mandates"), { recursive: true });
	if (schedules !== undefined) writeFileSync(join(stateDir, "schedules.json"), schedules);
	const mandate = (id: string, status: string, extra: Line = {}) => writeFileSync(join(stateDir, "mandates", `${id}.json`), JSON.stringify({ id, status, expiry: "2026-12-01T00:00:00Z", issued_at: "2026-09-01T00:00:00Z", projects: ["demo"], spend_cap: { usd: 10 }, ...extra }));
	mandate("md-live1", "active");
	mandate("md-paus1", "paused");
	mandate("md-prev1", "revoked", { revoked_at: "2026-09-27T00:00:00Z", revoked_by: { by: "parent" } });
	mandate("md-sysr1", "revoked", { revoked_at: "2026-09-27T00:00:00Z", revoked_by: { by: "system" } });
	mandate("md-oprv1", "revoked", { revoked_at: "2026-09-27T00:00:00Z", revoked_by: { by: "operator", operator_quote: "revoke the triage grant", decided_by: "operator-quote" } });
	mandate("md-lgcy1", "revoked", { revoked_at: "2026-09-27T00:00:00Z" });
	const jobs = (list: Line[]) => writeFileSync(join(home, ".pi-command-post", "jobs.json"), JSON.stringify({ jobs: list }));
	jobs([
		{ id: "cp-fire1", title: "Digest (weekly digest 2026-09-14T04:00Z)", status: "closed", close_reason: "answered", labels: ["schedule:sch-aaaaaa", "delivery:answer"], created_at: "2026-09-14T04:00:10Z" },
		{ id: "cp-fire2", title: "Digest (weekly digest 2026-09-21T04:00Z)", status: "open", labels: ["schedule:sch-aaaaaa"], created_at: "2026-09-21T04:00:10Z" },
		{ id: "cp-other", title: "unrelated", status: "open", labels: [], created_at: "2026-09-21T04:00:10Z" },
	]);
	const report = join(stateDir, "artifacts", "cp-fire1", "report.md");
	put(report, ANSWER);
	const envelope = (job: string, envelope: Line, extra: Line = {}) => put(join(stateDir, "runs", job, "envelope.json"), JSON.stringify({ envelope, ...extra }));
	envelope("cp-fire1", { pr_url: "https://github.com/acme/repo/pull/9", summary: "Warsaw: sunny, 29 C", artifact_path: report }, { received_at: "2026-09-14T04:05:00Z" });
	const view = await startViewer(t, { home, at: iso(NOW), requireTailnet });
	const read = async () => { const reply = await view.get("/api/schedules"); assert.equal(reply.status, 200, reply.text); return reply.body as unknown as Schedules; };
	const write = (text: string) => writeFileSync(join(stateDir, "schedules.json"), text);
	return { view, home, stateDir, read, write, jobs, envelope, report, mandate };
}
const first = (data: Schedules) => data.schedules[0]!;

test("P20-schedules-file: no file is empty; bad JSON and every contract breach are one named error; the read is GET only", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t);
	const empty = await s.read();
	assert.deepEqual([empty.generated_at.slice(0, 16), empty.error, empty.schedules], ["2026-09-28T01:41", null, []]);
	s.write("{not json");
	const broken = await s.read();
	assert.match(broken.error ?? "", /schedules\.json is not valid JSON/);
	assert.deepEqual(broken.schedules, []);
	const refused = async (schedule: unknown, pattern: RegExp, wrapper?: unknown) => {
		s.write(JSON.stringify(wrapper ?? { schema_version: 2, schedules: [schedule] }));
		const data = await s.read();
		assert.match(data.error ?? "", /violates the schedule contract/, JSON.stringify(schedule));
		assert.match(data.error ?? "", pattern);
		assert.deepEqual(data.schedules, []);
	};
	await refused({ ...CRON, id: "bad" }, /\/schedules\/0\/id/);
	await refused({ ...CRON, extra: 1 }, /\/schedules\/0\/extra: unexpected property/);
	await refused({ ...CRON, name: "two\nlines" }, /\/schedules\/0\/name/);
	await refused({ ...CRON, mandate_id: "md-X" }, /mandate_id/);
	await refused({ ...CRON, job: { ...CRON.job, kind: "deploy" } }, /job\/kind/);
	await refused({ ...WATCH, trigger: { ...WATCH.trigger, every_seconds: 10 } }, /every_seconds/);
	await refused({ ...CRON, trigger: { type: "cron", cron: "* * * * *" } }, /trigger\/tz: is required/);
	await refused({ ...CRON, last_fire: { at: "x", slot: "x", job_id: "x" } }, /last_fire\/missed: is required/);
	await refused(null, /schema_version/, { schema_version: 3, schedules: [] });
	await refused(null, /schedules: must be an array/, { schema_version: 2, schedules: {} });
	await refused({ ...MANUAL, job: { ...MANUAL.job, skill: "cp-other" } }, /job\/skill: must be one of cp-self-review, cp-pr-review/);
	await refused({ ...MANUAL, trigger: { type: "manual", cron: "* * * * *" } }, /trigger\/cron: unexpected property/);
	const template = (patch: Line) => ({ ...MANUAL, job: { title: "Triage", kind: "research", delivery: "answer" }, grant_template: { ...TEMPLATE, ...patch } });
	await refused(template({ allowed_actions: ["merge"] }), /grant_template\/allowed_actions/);
	await refused(template({ ask_on: ["merge"] }), /grant_template\/ask_on/);
	await refused(template({ expiry_hours: 169 }), /grant_template\/expiry_hours/);
	await refused(template({ approval: { ...TEMPLATE.approval, operator_quote: "" } }), /grant_template\/approval\/operator_quote/);
	s.write(scheduleFile(CRON, WATCH, MANUAL, { ...MANUAL, id: "sch-c0c0c0", job: { ...MANUAL.job, skill: "cp-pr-review" } }, template({})));
	assert.equal((await s.read()).error, null, "the valid shapes, a cp-pr-review skill and a fire grant template included");
	s.write(scheduleFile());
	assert.deepEqual((await s.read()).schedules, []);
	assert.equal((await s.view.get("/api/schedules", { method: "POST" })).status, 405, "read-only");
	assert.equal((await s.view.get("/api/stream?view=schedules", { method: "HEAD" })).status, 200, "the refresh stream accepts the view");
});

test("P20-schedules-projection: cron and watch with next fire, mandate state and history; the answer capped; a manual schedule never fires", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(CRON, WATCH));
	const data = await s.read();
	assert.equal(data.error, null);
	const [c, w] = data.schedules;
	assert.equal(c?.next_at, "2026-09-28T04:00:00.000Z", "06:00 CEST");
	assert.equal(c?.mandate_status, "active");
	assert.deepEqual(c?.history.map((j: Line) => j.id), ["cp-fire2", "cp-fire1"], "newest first, only this schedule's label");
	const fired = c?.history[1];
	assert.deepEqual([fired.close_reason, fired.pr_url, fired.summary, fired.reported_at], ["answered", "https://github.com/acme/repo/pull/9", "Warsaw: sunny, 29 C", "2026-09-14T04:05:00Z"]);
	assert.equal(fired.answer.truncated, true, "capped");
	assert.equal(Buffer.byteLength(fired.answer.text), 8192);
	assert.equal(fired.answer.bytes, Buffer.byteLength(ANSWER));
	assert.match(fired.answer.text, /^ANSWER-HEAD/);
	assert.doesNotMatch(fired.answer.text, /ANSWER-TAIL/);
	assert.deepEqual([c?.history[0].summary, c?.history[0].reported_at, c?.history[0].answer], [null, null, null], "an unreported run");
	assert.equal(w?.next_at, "2026-09-28T01:05:00.000Z", "last_checked_at + every_seconds");
	assert.equal(w?.mandate_status, "paused");
	assert.equal("last_output_sha" in (w ?? {}), false, "the watch output hash is not served");
	assert.deepEqual(w?.history, []);

	const quarter = { ...CRON, id: "sch-c1c1c1", trigger: { type: "cron", cron: "*/15 * * * *", tz: "UTC" }, last_fire: undefined };
	s.write(scheduleFile(CRON, quarter, MANUAL));
	const next = async () => (await s.read()).schedules.map((item) => item.next_at);
	assert.deepEqual(await next(), ["2026-09-28T04:00:00.000Z", "2026-09-28T01:45:00.000Z", null]);
	assert.equal((await s.read()).schedules[2]?.next_note, "manual: fires only on Run now");
	s.view.pin("2026-09-28T04:00:00.000Z");
	assert.equal((await next())[0], "2026-10-05T04:00:00.000Z", "strictly after");
	s.view.pin("2026-10-20T00:00:00.000Z");
	assert.equal((await next())[0], "2026-10-26T05:00:00.000Z", "06:00 CET after the clocks go back");
});

test("P20-schedules-links: a GitLab MR on a custom host links; an unsafe url never does; the merge receipt wins", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(CRON));
	const link = async () => first(await s.read()).history.find((j: Line) => j.id === "cp-fire1")?.pr_url;
	const mr = "https://git.example.test/code/group/sub/repo/-/merge_requests/4";
	s.envelope("cp-fire1", { pr_url: mr, summary: "done" });
	assert.equal(await link(), mr);
	for (const unsafe of ["https://user:token@git.example.test/g/r/-/merge_requests/4", "http://gitlab.com/g/r/-/merge_requests/4", "https://gitlab.com/g/r/-/merge_requests/0"]) {
		s.envelope("cp-fire1", { pr_url: unsafe, summary: "done" });
		assert.equal(await link(), null, unsafe);
	}
	put(join(s.stateDir, "runs", "cp-fire1", "merge.json"), JSON.stringify({ job_id: "cp-fire1", pr_url: mr }));
	assert.equal(await link(), mr, "the merge receipt's MR link wins over an unsafe envelope url");
	s.envelope("cp-fire1", { pr_url: "https://github.com/acme/repo/pull/9", summary: "done" });
	assert.equal(await link(), mr, "and over a safe envelope url: the receipt is read first");
	rmSync(join(s.stateDir, "runs", "cp-fire1", "merge.json"));
	assert.equal(await link(), "https://github.com/acme/repo/pull/9", "with no receipt, the safe envelope url links");
});

test("P20-schedules-answer: an answer is read only from the job's own artifact dir, never through a symlink, traversal or another job", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(CRON));
	const dir = join(s.stateDir, "artifacts", "cp-fire1");
	const outside = join(s.home, "outside.md");
	writeFileSync(outside, "OUTSIDE-SECRET");
	const answer = async (job = "cp-fire1") => first(await s.read()).history.find((j: Line) => j.id === job)?.answer;
	s.envelope("cp-fire1", { summary: "s", artifact_path: outside });
	assert.match((await answer())?.text ?? "", /^ANSWER-HEAD/, "an outside artifact_path falls back to the intake copy in the job's dir");
	rmSync(join(dir, "report.md"));
	assert.equal(await answer(), null, "and with no copy, the outside file is never read");
	symlinkSync(outside, join(dir, "report.md"));
	assert.equal(await answer(), null, "a symlink out of the dir is refused");
	s.envelope("cp-fire1", { summary: "s", artifact_path: join(dir, "..", "..", "..", "..", "outside.md") });
	assert.equal(await answer(), null, "so is a traversal");
	put(join(s.stateDir, "artifacts", "cp-other", "report.md"), "OTHER-JOB");
	s.envelope("cp-fire1", { summary: "s", artifact_path: join(s.stateDir, "artifacts", "cp-other", "report.md") });
	assert.equal(await answer(), null, "another job's artifact is refused");

	const external = join(s.home, "external-dir");
	put(join(external, "outside.txt"), "SYNTHETIC_SECRET");
	symlinkSync(external, join(s.stateDir, "artifacts", "cp-link"));
	s.jobs([{ id: "cp-link", title: "linked", status: "closed", labels: ["schedule:sch-aaaaaa"], created_at: "2026-09-14T04:00:10Z" }]);
	s.envelope("cp-link", { summary: "s", artifact_path: join(external, "outside.txt") });
	assert.equal(first(await s.read()).history[0]?.id, "cp-link");
	assert.equal(await answer("cp-link"), null, "an artifact path in a symlinked job dir is refused");
	put(join(external, "report.md"), "SYNTHETIC_SECRET");
	assert.equal(await answer("cp-link"), null, "so is the intake copy");
	s.jobs([{ id: "../artifacts/cp-other", title: "unsafe", status: "closed", labels: ["schedule:sch-aaaaaa"], created_at: "2026-09-13T04:00:10Z" }]);
	assert.doesNotMatch(JSON.stringify(await s.read()), /SYNTHETIC_SECRET|OUTSIDE-SECRET|OTHER-JOB/, "an unsafe id never reaches a path");
});

test("P20-schedules-answer-roots: a symlinked artifacts root or state dir still serves the real job dir; the cap ends on a whole character", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(CRON));
	const answer = async () => first(await s.read()).history.find((j: Line) => j.id === "cp-fire1")?.answer;
	assert.match((await answer())?.text ?? "", /^ANSWER-HEAD/, "baseline");
	const moved = join(s.home, "moved-artifacts");
	renameSync(join(s.stateDir, "artifacts"), moved);
	symlinkSync(moved, join(s.stateDir, "artifacts"));
	s.envelope("cp-fire1", { summary: "s" });
	assert.match((await answer())?.text ?? "", /^ANSWER-HEAD/, "a symlinked artifacts root");
	// 1 + 3n bytes: the 8192-byte cap falls inside the 2731st euro sign.
	writeFileSync(join(moved, "cp-fire1", "report.md"), `a${"€".repeat(3000)}`);
	const euro = await answer();
	assert.deepEqual([euro?.text, euro?.truncated], [`a${"€".repeat(2730)}`, true]);
	assert.equal(euro?.text.includes("\uFFFD"), false, "no replacement character");

	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const real = join(scratch.path, "real-state");
	renameSync(s.stateDir, real);
	rmSync(join(real, "artifacts"));
	renameSync(moved, join(real, "artifacts"));
	writeFileSync(join(real, "artifacts", "cp-fire1", "report.md"), ANSWER);
	symlinkSync(real, s.stateDir);
	s.envelope("cp-fire1", { summary: "s", artifact_path: join(s.stateDir, "artifacts", "cp-fire1", "report.md") });
	assert.match((await answer())?.text ?? "", /^ANSWER-HEAD/, "a symlinked state dir");
});

test("P20-schedules-runs: an activated schedule counts durable runs and legacy jobs once; a new trigger shows while the open run keeps its snapshot", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(CRON));
	const ledger = JSON.parse(readFileSync(join(s.home, ".pi-command-post", "jobs.json"), "utf8")) as { jobs: Line[] };
	ledger.jobs.find((job) => job.id === "cp-fire1")!.notes = "scheduled for sch-aaaaaa";
	s.jobs(ledger.jobs);
	const schedule = readScheduleFile(join(s.stateDir, "schedules.json"))[0]!;
	const runs = openScheduleRunStore(s.home);
	const policy = policyFromLegacy(schedule, schedule.grant_template!);
	await runs.savePolicyRevision(policy, { at: "2026-09-21T04:00:00Z", provenance: { channel: "dashboard" } });
	const id = "run-20260921040000-abcdef";
	await runs.createRun({ schema_version: 1, id, schedule_id: schedule.id, policy_revision: 1, policy, trigger: { via: "dashboard", at: "2026-09-21T04:00:10Z", request_id: "sc-20260921040010-abcdef12" }, anchor_job_id: null, members: [], phase: "accepted", outcome: null, started_at: "2026-09-21T04:00:10Z", deadline_at: "2026-09-22T04:00:10Z", risk_preapproved: [], authority_log: [], cap_notices: [] });
	await runs.attachAnchor(id, { job_id: "cp-fire2", role: null, admitted_at: "2026-09-21T04:00:10Z" });
	await runs.setPhase(id, "running");
	const view = first(await s.read());
	assert.deepEqual([view.policy?.active_revision, view.policy?.limits, view.active_run?.id], [1, policy.limits, id]);
	assert.deepEqual([view.run_count, view.job_count], [2, 2]);
	assert.deepEqual(view.runs.map((run: Line) => run.run_id), [id, "cp-fire1"]);
	assert.equal(view.history.find((job: Line) => job.id === "cp-fire2")?.run_id, id);
	assert.equal(view.runs[0]?.card, undefined, "no result queued yet");
	runs.editRun(id, (row) => { row.result = { source_key: `${id}:cp-fire2:1`, job_id: "cp-fire2", generation: 1, outcome: "completed", headline: "done", at: "2026-09-21T04:05:00Z", links: [], answer_id: null, delivered_at: null, error: "answers journal unwritable: EACCES" }; });
	assert.deepEqual(first(await s.read()).runs[0]?.card, { state: "pending", answer_id: null, error: "answers journal unwritable: EACCES" });

	const updated = structuredClone(policy);
	updated.revision = 2;
	updated.trigger = { type: "manual" };
	await runs.savePolicyRevision(updated, { at: "2026-09-21T04:01:00Z", provenance: { channel: "dashboard" } });
	const moved = first(await s.read());
	assert.equal(moved.policy?.active_revision, 2);
	assert.deepEqual([moved.trigger, moved.next_at], [updated.trigger, null]);
	assert.match(moved.next_note, /Run now/);
	assert.deepEqual([moved.active_run?.policy_revision, moved.active_run?.policy.trigger], [1, policy.trigger], "the open run keeps its snapshot");
	await runs.closeRun(id, "completed", "2026-09-21T04:02:00Z");
	const closed = first(await s.read());
	assert.deepEqual([closed.trigger, closed.active_run], [updated.trigger, null]);
	writeFileSync(runs.runsFile, "{");
	assert.match((await s.read()).error ?? "", /JSON/, "an unreadable run store is the page's error");
});

test("P20-schedules-org-review: the view names the fan-out and the seed's Run now clearance by sha only; a named_jobs pre-approval is not carried", { timeout: 120_000 }, async (t) => {
	const quote = "Approve the org reviews, SECRET-WORDS-NEVER-SHOWN";
	const org = {
		id: "sch-ffffff", name: "org review", project: "demo", mandate_id: "md-live1", trigger: { type: "manual" },
		job: { title: "Org review", kind: "research", delivery: "local", skill: "cp-org-pr-review", description: `org: acme\nteam: ${"platform-infrastructure-".repeat(3)}core\nteam: web\nhold: https://github.com/acme/api/pull/7\nmax_reviewers: 2` },
		enabled: true, created_at: "2026-09-01T00:00:00Z", grant_template: TEMPLATE,
	};
	const s = await schedulesHome(t, scheduleFile(org, { ...org, id: "sch-a0a0a0", name: "broken", job: { ...org.job, description: "no org line" } }, CRON));
	const seed = (pre?: Line) => s.mandate("md-seed1", "revoked", { revoked_by: { by: "system" }, schedule_grant: true, ...(pre ? { risk_preapproval: pre } : {}) });
	seed();
	const bare = await s.read();
	assert.deepEqual(bare.schedules[0]?.fan_out, { reviewers: 2, org: "acme", user: null, teams: [`${"platform-infrastructure-".repeat(3)}core`, "web"], holds: 1, error: null });
	assert.equal(bare.schedules[0]?.run_now_clearance, null);
	assert.match(bare.schedules[1]?.fan_out?.error ?? "", /cp-org-pr-review: needs exactly one description line "org: <github-org>"/);
	assert.equal(bare.schedules[2]?.fan_out, null, "other schedules have none");
	seed({ operator_quote: quote, decided_by: "operator-quote", scope: "mandate_jobs", granted_at: "2026-09-02T00:00:00Z" });
	const data = await s.read();
	assert.deepEqual(data.schedules[0]?.run_now_clearance, { quote_sha: createHash("sha256").update(quote).digest("hex").slice(0, 12), granted_at: "2026-09-02T00:00:00Z" });
	assert.doesNotMatch(JSON.stringify(data), /SECRET-WORDS/, "the quote never leaves the home");
	seed({ operator_quote: quote, decided_by: "operator-quote", scope: "named_jobs", job_ids: ["cp-abcd"], granted_at: "2026-09-02T00:00:00Z" });
	assert.equal(first(await s.read()).run_now_clearance, null, "a named_jobs pre-approval is never carried");
});

test("P20-schedules-pointers: legacy grant pointers project pause, revoke provenance and stop exactly", { timeout: 120_000 }, async (t) => {
	const triage = (id: string, mandate_id: string) => ({ ...MANUAL, id, name: "triage", mandate_id, job: { title: "Triage", kind: "research", delivery: "answer" }, grant_template: TEMPLATE });
	const s = await schedulesHome(t, scheduleFile(triage("sch-dddddd", "md-paus1"), triage("sch-eeeeee", "md-live1"), triage("sch-d1d1d1", "md-prev1"), triage("sch-d2d2d2", "md-sysr1"), triage("sch-d3d3d3", "md-oprv1"), triage("sch-d4d4d4", "md-lgcy1")));
	assert.deepEqual((await s.read()).schedules.map((item) => [item.mandate_id, item.mandate_status, item.mandate_pause_reason ?? null, item.grant_stopped]), [
		["md-paus1", "paused", "operator", true],
		["md-live1", "active", null, false],
		["md-prev1", "active", null, false],
		["md-sysr1", "active", null, false],
		["md-oprv1", "revoked", null, true],
		["md-lgcy1", "revoked", null, true],
	], "a parent or system revoke is no stop; an operator pause, an operator or a legacy revoke is");
});

// ---------------------------------------------------------------------------------------------------------------
// The served Schedules page (baseline tests/viewer-schedules.test.ts renders), DOM and text only, no layout.

/** The Schedules page in a tab; `cards()` are the schedule cards, in file order. */
async function schedulesPage(s: Awaited<ReturnType<typeof schedulesHome>>) {
	const tab = await s.view.open("#schedules");
	await tab.find(".schedule-screen");
	await until(() => tab.$$("[role=alert], article.schedule-card").length > 0 || /No schedules\./.test(tab.text()), Boolean, "the schedules page");
	await new Promise((done) => setTimeout(done, 300));
	return { tab, cards: () => tab.$$("article.schedule-card"), html: () => tab.root.innerHTML };
}

test("P20-schedules-page: empty and error states; cron and watch cards with facts, history, answer and links; Add prefills the composer", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t);
	const empty = await schedulesPage(s);
	assert.match(empty.tab.text(), /No schedules\. Ask the operator session to add one \(cp_schedule\)\./);
	assert.match(empty.tab.text(), /fire in the always-on parent; a slot missed while it was down fires once when it returns/);
	empty.tab.close();
	s.write("{");
	const broken = await schedulesPage(s);
	assert.match((await broken.tab.find("[role=alert]")).textContent ?? "", /^Schedules unavailable: .*schedules\.json is not valid JSON/);
	broken.tab.close();

	s.write(scheduleFile(CRON, WATCH));
	const page = await schedulesPage(s);
	const { tab } = page;
	const nav = tab.$('nav[aria-label="Schedules and files"]')!;
	assert.equal(nav.querySelector('[aria-current="page"]')?.getAttribute("href"), "#schedules");
	assert.equal(nav.querySelector('a[href="#files"]')?.textContent, "Files");
	assert.equal(tab.$(".schedule-add")?.textContent, "+ Add schedule");
	assert.equal(tab.$(".schedule-add-long")?.textContent, " schedule", "phone CSS hides the long label");
	assert.ok(tab.$(".schedule-card-heading .schedule-pill"), "enabled state is a pill");
	assert.equal(tab.$(".schedule-how-phone")?.hasAttribute("open"), false, "phone gets a closed how-schedules-run disclosure");
	assert.equal(tab.$(".schedule-heading .schedule-add-phone")?.textContent, "+ Add", "phone + Add sits in the title row");
	assert.equal(tab.$(".schedule-heading")?.textContent?.includes("Saved triggers and the jobs they fired."), false, "the old tagline is gone");
	assert.match(tab.$(".schedule-card .schedule-policy-line")?.textContent ?? "", /^1 at a time, plus an answer; \$10\/run; model routing default\.$/, "never more concurrency than exists");
	assert.equal(page.cards().length, 2);
	assert.equal(tab.$(".schedule-last-runs h3")?.textContent, "Last 3 runs");
	assert.equal(tab.$$(".schedule-screen form, .schedule-screen [style]").length, 0, "no form, no inline style");
	assert.ok(tab.$(".schedule-layout > aside"), "explanation beside the schedule list");
	for (const card of page.cards()) {
		assert.deepEqual([...card.querySelectorAll(".schedule-facts > dt")].map((e) => e.textContent), ["Trigger", "Recipe", "Mandate", "Last fire"]);
		const details = card.querySelector(".schedule-details")!;
		assert.ok(details && !details.hasAttribute("open"), "advanced grant/template/history details start collapsed");
		assert.ok(details.querySelector(".schedule-approval"), "verbatim template approval remains reachable");
		assert.ok(details.querySelector(".schedule-history") || details.textContent?.includes("No job fired yet"));
		assert.equal(card.querySelector(".schedule-result")?.closest("details"), null, "result destination is a primary fact");
	}
	const html = page.html();
	const text = tab.text();
	assert.match(text, /this page's run history \(not the operator session\)/);
	assert.doesNotMatch(text, /an answer card in the operator session/);
	for (const shown of [/weekly digest/, /cron 0 6 \* \* 1 \(Europe\/Warsaw\)/, /Next fire /, /watch scripts\/x\.sh every 300 s, fires on changed output/, /Warsaw: sunny, 29 C/, /truncated at 8 KiB/, /reported /, /a pull request/, /\(missed\)/]) assert.match(text, shown);
	assert.match(text, /no fire mints a grant: fire at 2026-09-28T01:00Z not recorded: md-paus1 is paused/, "a recorded skip is shown verbatim");
	assert.match(tab.$("pre.schedule-answer")?.textContent ?? "", /^ANSWER-HEAD Sunny, 29 C/);
	assert.ok(tab.$('a[href="#job/cp-fire2"]') && tab.$('a[href="https://github.com/acme/repo/pull/9"]'));
	assert.match(page.cards()[1]!.querySelector(".schedule-pill")?.textContent ?? "", /disabled/);
	assert.match(tab.$("a.schedule-add")?.getAttribute("href") ?? "", /^#sessions\?view=you&transcript=1&draft=Add\+a\+schedule/, "Add prefills the composer");
	assert.doesNotMatch(html, /<script|onclick=/i);
});

test("P20-schedules-page-control: a ready parent gives each card its buttons and the latest request's state; a parent down disables every one", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(CRON, WATCH));
	put(join(s.stateDir, "parent.lock"), JSON.stringify({ pid: process.pid, started_at: "2026-09-28T00:00:00Z" }));
	const id = "sc-20260928014000-00000001";
	appendScheduleControlLine(s.stateDir, { type: "request", by: "viewer", id, at: "2026-09-28T01:40:00.000Z", peer: null, op: "enable", schedule_id: "sch-bbbbbb" });
	appendScheduleControlLine(s.stateDir, { type: "outcome", by: "parent", id, at: "2026-09-28T01:40:01.000Z", state: "refused", reason: "enable sch-bbbbbb refused: md-paus1 is paused", job_id: null });
	const live = await schedulesPage(s);
	await live.tab.find(".schedule-card button");
	const buttons = (card: Element) => [...card.querySelectorAll(".schedule-controls button, .schedule-actions button")].map((b) => [b.textContent, b.hasAttribute("disabled")]);
	const [cronCard, watchCard] = live.cards();
	assert.deepEqual(buttons(cronCard!), [["Run now", false], ["Disable", false], ["Remove…", false]]);
	assert.deepEqual(buttons(watchCard!), [["Enable", false], ["Remove…", false]], "no run now on a disabled schedule");
	assert.match(watchCard!.textContent ?? "", /Refused: enable sch-bbbbbb refused: md-paus1 is paused/);
	assert.match(live.tab.text(), /Controls ready/);
	live.tab.close();
	rmSync(join(s.stateDir, "parent.lock"));
	const down = await schedulesPage(s);
	await down.tab.find(".schedule-card button");
	assert.match(down.tab.text(), /Parent not running: no parent lock/);
	const all = down.cards().flatMap((card) => buttons(card));
	assert.ok(all.length > 0 && all.every(([, disabled]) => disabled), "every button disabled while the parent is down");
});

/** The stylesheet text the served page links (CSS assertions are on served text, not layout). */
async function servedCss(view: Pick<View, "get">): Promise<string> {
	const page = await view.get("/");
	const hrefs = [...page.text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]!);
	return (await Promise.all(hrefs.map(async (href) => (await view.get(href)).text))).join("\n");
}

test("P20-schedules-page-texts: manual, org-review, fire-grant, pointer and skipped schedules each say what a fire does", { timeout: 120_000 }, async (t) => {
	const quote = "Approve the org reviews, SECRET-WORDS-NEVER-SHOWN";
	const org = { ...MANUAL, id: "sch-ffffff", name: "org review", job: { title: "Org review", kind: "research", delivery: "local", skill: "cp-org-pr-review", description: `org: acme\nteam: ${"platform-infrastructure-".repeat(3)}core\nteam: web\nmax_reviewers: 2` }, grant_template: TEMPLATE };
	const triage = (id: string, mandate_id: string, extra: Line = {}) => ({ ...MANUAL, id, name: "triage", mandate_id, job: { title: "Triage", kind: "research", delivery: "answer" }, grant_template: TEMPLATE, ...extra });
	const skipped = "schedule sch-a4a4a4 has no grant template (migration: md-live1 is not a schedule grant), so no fire can mint a fresh grant: save a native policy in the editor to resume";
	const { grant_template: _, ...untemplated } = triage("sch-a4a4a4", "md-live1", { last_skip: { at: "2026-09-28T00:00:00Z", reason: skipped } });
	const s = await schedulesHome(t, scheduleFile(MANUAL, org, { ...org, id: "sch-a0a0a0", name: "broken", job: { ...org.job, description: "no org line" } },
		triage("sch-dddddd", "md-paus1"), triage("sch-a1a1a1", "md-prev1"), triage("sch-a2a2a2", "md-sysr1"), triage("sch-a3a3a3", "md-oprv1"), triage("sch-a5a5a5", "md-lgcy1"), untemplated));
	s.mandate("md-seed1", "revoked", { revoked_by: { by: "system" }, schedule_grant: true });
	put(join(s.stateDir, "parent.lock"), JSON.stringify({ pid: process.pid, started_at: "2026-09-28T00:00:00Z" }));
	const page = await schedulesPage(s);
	const [manual, cleared, broken, paused, parent, system, operator, legacy, skip] = page.cards().map((card) => card.textContent ?? "");
	assert.match(manual!, /manual \(Run now only\), expanded by skill cp-self-review/);
	assert.match(manual!, /Manual: fires only on Run now/);
	assert.match(manual!, /Each Run now records a deferred anchor job and wakes the parent to fan out the cp-self-review recipe under a saved native policy, once one is active\./);
	assert.match(manual!, /Grant md-live1 · active · no grant template, so every fire is refused: open the editor to set up this schedule/, "a template-less schedule with no recorded reason says so");
	assert.doesNotMatch(manual!, /Next fire|Next check/);
	assert.match(cleared!, /Run now fans out to up to 2 reviewers over acme's requested-review queue \(the gh user; teams platform-infrastructure-/);
	assert.match(cleared!, /Reviewers wait for a risk:high approval \(no standing pre-approval on the seed\)/);
	assert.match(broken!, /Recipe error: cp-org-pr-review: needs exactly one/);
	assert.equal(page.cards()[2]!.querySelector('[role="alert"].job-meta')?.textContent?.startsWith("Recipe error:"), true);
	assert.match(paused!, /Legacy grant md-paus1 · paused \(operator\) · no fire mints a grant: the operator pause is kept when it migrates to a native policy/);
	for (const [card, id] of [[parent, "md-prev1"], [system, "md-sysr1"]] as const) {
		assert.match(card!, new RegExp(`Legacy grant ${id} · active · no fire mints a grant: it migrates to a native policy once no legacy run is open`), `${id}: operatorStop is no stop`);
		assert.doesNotMatch(card!, /next fire mints a fresh grant/);
	}
	for (const [card, id] of [[operator, "md-oprv1"], [legacy, "md-lgcy1"]] as const) {
		assert.match(card!, new RegExp(`Legacy grant ${id} · revoked · no fire mints a grant: the operator revoke is kept when it migrates to a native policy`));
		assert.doesNotMatch(card!, /resume it|next fire mints a fresh grant/);
	}
	assert.match(page.cards()[3]!.querySelector(".schedule-approval")?.textContent ?? "", /^Template of md-seed1: 24 h, \$10, 500000 tokens, job cap 2; allowed plan, implement; asks on merge, risk:high\. Approved .*“Yes, triage\. long-unbroken/);
	assert.doesNotMatch(paused!, /no grant template/);
	assert.match(skip!, new RegExp(`Grant md-live1 · active · no grant template, so every fire is refused: ${skipped.replace(/[()]/g, "\\$&")}`));
	page.tab.close();

	s.mandate("md-seed1", "revoked", { revoked_by: { by: "system" }, schedule_grant: true, risk_preapproval: { operator_quote: quote, decided_by: "operator-quote", scope: "mandate_jobs", granted_at: "2026-09-02T00:00:00Z" } });
	const clear = await schedulesPage(s);
	const card = clear.cards()[1]!.textContent ?? "";
	assert.match(card, new RegExp(`Run now carries the operator's risk:high pre-approval \\[${createHash("sha256").update(quote).digest("hex").slice(0, 12)}\\]`));
	assert.doesNotMatch(clear.tab.root.innerHTML, /SECRET-WORDS/);
	assert.doesNotMatch(card, /Reviewers wait for a risk:high approval/);
	// Long text wraps at any width: the screen sets overflow-wrap, never a fixed width (served CSS text, not layout).
	const css = await servedCss(s.view);
	assert.match(css, /\.schedule-screen ?\{ ?overflow-wrap: ?anywhere;? ?\}/);
	assert.match(css, /\.schedule-fan-out ?\{[^}]*min-width: ?0;?/);
});

test("P20-schedules-page-runs: a manual skill's dashboard run is Last fire; runs and jobs count apart; results link the board or the S1 job", { timeout: 120_000 }, async (t) => {
	const org = { ...MANUAL, id: "sch-dddddd", name: "org review", job: { ...MANUAL.job, skill: "cp-org-pr-review", description: "org: acme" } };
	const s = await schedulesHome(t, scheduleFile(MANUAL, org));
	const lab = (id: string) => [`schedule:${id}`];
	const kids = (anchor: string, labels: string[]) => [1, 2, 3, 4, 5, 6].map((n) => ({ id: `${anchor}-l${n}`, title: `L${n} [${anchor}]`, status: "closed", labels, created_at: `2026-09-10T10:0${n}:00Z` }));
	s.jobs([
		{ id: "cp-ra", title: "Self-review", status: "closed", labels: lab(MANUAL.id), created_at: "2026-09-10T10:00:00Z", notes: "run now from the dashboard (req-1) for sch-cccccc (self-review)" },
		...kids("cp-ra", lab(MANUAL.id)),
		{ id: "cp-s1", title: "S1 synthesis", status: "closed", labels: lab(MANUAL.id), created_at: "2026-09-10T11:00:00Z" },
		{ id: "cp-oa", title: "Org review", status: "closed", labels: lab(org.id), created_at: "2026-09-10T10:00:00Z", notes: "run now from the dashboard (req-2) for sch-dddddd (org review)", comments: [{ at: "x", author: "p", text: "expanded: R1 cp-or1, S1 cp-os1" }] },
		{ id: "cp-os1", title: "S1 [cp-oa]", status: "closed", labels: lab(org.id), created_at: "2026-09-10T11:00:00Z" },
	]);
	const data = await s.read();
	const [m, o] = data.schedules;
	assert.deepEqual([m?.run_count, m?.job_count, m?.runs[0]?.jobs_total, m?.lands, m?.last_run?.via], [1, 8, 8, "board", "dashboard"]);
	assert.deepEqual(o?.runs[0]?.result, { kind: "report", job_id: "cp-os1", href: "#job/cp-os1" });
	assert.equal(m?.history.every((job: Line) => job.run_id === "cp-ra"), true);
	const page = await schedulesPage(s);
	const [card, orgCard] = page.cards();
	assert.match(card!.querySelector(".schedule-facts")?.textContent ?? "", /Last fire.*cp-ra.*Run now \(dashboard\).*1 recent run · 8 jobs/);
	assert.match(card!.querySelector(".schedule-result")?.textContent ?? "", /report board/);
	assert.doesNotMatch(card!.textContent ?? "", /pushed branch/);
	assert.equal(card!.querySelectorAll(".schedule-history > li").length, 1, "one run");
	assert.equal(card!.querySelectorAll(".schedule-run-jobs > li").length, 8);
	assert.match(card!.textContent ?? "", /run history · 1 run/);
	assert.match(orgCard!.textContent ?? "", /1 recent run · 2 jobs/);
	assert.deepEqual([...card!.querySelectorAll(".schedule-runs-table th")].map((e) => e.textContent), ["Started", "Job", "Status", "Transcript", "Report"]);
	assert.equal(card!.querySelector(".schedule-last-runs header h3")?.textContent, "Last 3 runs");
	assert.equal(card!.querySelector(".schedule-all-runs")?.textContent, "All 1 run →");
	assert.match(card!.querySelector(".schedule-runs-table tbody")?.textContent ?? "", /cp-ra.*closed · 8 jobs.*Transcript.*Web report ↗/);
	assert.equal(card!.querySelectorAll(".schedule-runs-blocks li .schedule-run-buttons a").length, 2, "phone blocks: Transcript and Web report buttons");
	assert.ok([...orgCard!.querySelectorAll('a[href="#job/cp-os1"]')].some((a) => a.textContent === "Report"), "the S1 job is the report");
	page.tab.close();
	s.jobs([]);
	const none = await schedulesPage(s);
	assert.match(none.cards()[0]!.textContent ?? "", /0 recent runs · 0 jobs.*run history · 0 runs/s);
});

test("P20-schedules-page-policy: a policy-only v2 schedule renders its saved run authority; result cards posted and pending wrap as text", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(CRON, WATCH));
	const file = join(s.stateDir, "schedules.json");
	const saved = readScheduleFile(file)[0]!;
	const runs = openScheduleRunStore(s.home);
	const policy = policyFromLegacy(saved, saved.grant_template!);
	await runs.savePolicyRevision(policy, { at: "2026-09-28T01:00:00Z", provenance: { channel: "migration", legacy_seed: policy.provenance.legacy_seed } });
	const { mandate_id: _pointer, grant_template: _template, ...v2 } = saved;
	v2.name = "long-schedule-name-".repeat(4);
	writeFileSync(file, JSON.stringify({ schema_version: 2, schedules: [v2, WATCH] }));
	const data = await s.read();
	assert.equal(data.error, null);
	assert.deepEqual([data.schedules[0]?.mandate_id, data.schedules[0]?.policy?.active_revision, data.schedules[1]?.mandate_id, data.schedules[1]?.policy], [undefined, 1, WATCH.mandate_id, null]);
	const run = (n: number, at: string) => runs.createRun({ schema_version: 1, id: `run-2026092104000${n}-abcdef`, schedule_id: saved.id, policy_revision: 1, policy, trigger: { via: "slot", at }, anchor_job_id: null, members: [], phase: "accepted", outcome: null, started_at: at, deadline_at: "2026-09-22T04:00:10Z", risk_preapproved: [], authority_log: [], cap_notices: [] });
	const result = (n: number, answer_id: string | null, delivered_at: string | null, error: string | null) => runs.editRun(`run-2026092104000${n}-abcdef`, (row) => { row.result = { source_key: `k${n}`, job_id: `cp-fire${n}`, generation: 1, outcome: "completed", headline: "done", at: "2026-09-21T04:05:00Z", links: [], answer_id, delivered_at, ...(error ? { error } : {}) }; });
	await run(1, "2026-09-21T04:00:20Z");
	await runs.closeRun("run-20260921040001-abcdef", "completed", "2026-09-21T04:06:00Z");
	result(1, "ans-aaaaaaaaaaaa", "2026-09-21T04:05:30Z", null);
	await run(2, "2026-09-21T04:00:10Z");
	await runs.closeRun("run-20260921040002-abcdef", "completed", "2026-09-21T04:06:00Z");
	result(2, null, null, `answers journal unwritable: ${"x".repeat(900)}`);
	const page = await schedulesPage(s);
	const card = page.cards()[0]!;
	assert.match(card.querySelector(".schedule-identity")?.textContent ?? "", /policy revision 1/);
	assert.match(card.querySelector(".schedule-facts")?.textContent ?? "", /Policyrevision 1 · saved run authority/);
	assert.match(card.querySelector(".schedule-details")?.textContent ?? "", /each fire starts a run; no grant minted/);
	assert.doesNotMatch(card.textContent ?? "", /no grant template|every fire is refused|undefined/);
	assert.match(card.querySelector(".schedule-policy-line")?.textContent ?? "", /\$10\/run/);
	assert.equal(card.querySelectorAll("[style], form").length, 0);
	assert.match(card.querySelector(".schedule-result")?.textContent ?? "", /Each run also posts one result card to Answers/);
	const heads = [...card.querySelectorAll(".schedule-run-head")].map((head) => head.textContent ?? "");
	assert.ok(heads.some((head) => /Result card in Answers/.test(head)), heads.join(" | "));
	assert.ok(heads.some((head) => new RegExp(`Result card pending: answers journal unwritable: x{900}`).test(head)), "a long error is text in the wrapping run head");
	assert.match(await servedCss(s.view), /overflow-wrap: ?anywhere/);
});

// ---------------------------------------------------------------------------------------------------------------
// Run grouping as /api/schedules serves it (baseline tests/viewer-schedule-run-groups.test.ts).

const PLAIN = { ...MANUAL, id: "sch-b1b1b1", name: "bump", job: { title: "Bump", kind: "ship", delivery: "local" } };
const ORG = { ...MANUAL, id: "sch-b2b2b2", name: "org", job: { ...MANUAL.job, skill: "cp-org-pr-review", description: "org: acme" } };
const ledgerJob = (schedule: string, id: string, at: string, extra: Line = {}) => ({ id, title: id, status: "closed", created_at: at, labels: [`schedule:${schedule}`], ...extra });
const anchorJob = (schedule: string, id: string, at: string, extra: Line = {}) => ledgerJob(schedule, id, at, { notes: `run now from the dashboard (req-1) for ${schedule} (x)`, ...extra });
const runsOf = (item: Record<string, any>) => item.runs.map((run: Line) => [run.run_id, run.job_ids]);

test("P20-schedules-run-groups: a skill run is anchor + readers + S1; suffix beats time; expanded: comments; legacy anchors; the 5-run window; results", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(MANUAL, PLAIN, ORG));
	const item = async (id: string) => (await s.read()).schedules.find((x) => x.id === id)!;
	const skill = MANUAL.id;
	const readers = [1, 2, 3, 4, 5, 6].map((n) => ledgerJob(skill, `cp-l${n}`, `2026-09-01T10:0${n}:00Z`, { title: `L${n} [cp-a1]` }));
	put(join(s.stateDir, "boards", "self-review-x", "board.json"), JSON.stringify({ title: "Self review", created_at: "2026-09-01T10:30:00Z", job_ids: ["cp-s1"] }));
	s.jobs([anchorJob(skill, "cp-a1", "2026-09-01T10:00:00Z", { comments: [{ text: "expanded: L1 cp-old" }, { text: "note" }, { text: "expanded: L1 cp-l1, L2 cp-l2, S1 cp-s1" }] }), ...readers, ledgerJob(skill, "cp-s1", "2026-09-01T10:30:00Z", { status: "open" })]);
	const one = await item(skill);
	assert.equal(one.runs.length, 1, "one run");
	assert.deepEqual([one.job_count, one.runs[0].jobs_total, one.runs[0].jobs_open, one.runs[0].status], [8, 8, 1, "open"]);
	assert.deepEqual(one.runs[0].result, { kind: "board", job_id: "cp-s1", href: "/boards/self-review-x/" }, "the newest expanded: comment names the S1");
	assert.deepEqual(one.last_run, { job_id: "cp-a1", at: "2026-09-01T10:00:00Z", via: "dashboard", missed: false });

	const a1 = anchorJob(skill, "cp-a1", "2026-09-01T10:00:00Z");
	s.jobs([a1, anchorJob(skill, "cp-a2", "2026-09-02T10:00:00Z"), ledgerJob(skill, "cp-m", "2026-09-02T11:00:00Z", { title: "M [cp-a1]" })]);
	assert.deepEqual(runsOf(await item(skill)), [["cp-a2", ["cp-a2"]], ["cp-a1", ["cp-a1", "cp-m"]]], "the title suffix wins over time");
	const legacyRun = (schedule: string) => [anchorJob(schedule, "cp-a1", "2026-09-01T10:00:00Z"), ledgerJob(schedule, "cp-old", "2026-09-02T11:00:00Z")];
	s.jobs([...legacyRun(PLAIN.id)]);
	assert.equal((await item(PLAIN.id)).history.find((job: Line) => job.id === "cp-old")?.run_id, null, "a note-less job of a non-skill schedule is unattributed");
	s.jobs([...legacyRun(skill)]);
	assert.deepEqual(runsOf(await item(skill)), [["cp-a1", ["cp-a1", "cp-old"]]], "a skill schedule's job joins the latest earlier anchor");
	s.jobs([ledgerJob(skill, "cp-old", "2026-09-02T11:00:00Z")]);
	assert.deepEqual([(await item(skill)).runs, (await item(skill)).history[0]?.run_id], [[], null], "no anchor before it");

	const interleaved = (second: Line) => [anchorJob(skill, "cp-a1", "2026-09-01T10:00:00Z", { comments: [{ text: "expanded: L1 cp-l1, S1 cp-s1" }] }), second, ledgerJob(skill, "cp-l1", "2026-09-01T10:01:00Z", { title: "L1 [cp-a1]" }), ledgerJob(skill, "cp-s1", "2026-09-01T10:20:00Z", { status: "open" })];
	s.jobs(interleaved(anchorJob(skill, "cp-a2", "2026-09-01T10:10:00Z")));
	const [r2, r1] = (await item(skill)).runs;
	assert.deepEqual([r1.run_id, r1.job_ids, r1.jobs_total, r1.status, r1.result?.kind], ["cp-a1", ["cp-a1", "cp-l1", "cp-s1"], 3, "open", "board"], "an unsuffixed S1 stays with the anchor that named it");
	assert.deepEqual([r2.run_id, r2.job_ids, r2.status, r2.result?.kind], ["cp-a2", ["cp-a2"], "closed", "report"]);
	s.jobs(interleaved(anchorJob(skill, "cp-a2", "2026-09-01T10:10:00Z", { comments: [{ text: "expanded: S1 cp-s1" }] })));
	assert.deepEqual((await item(skill)).runs.map((run: Line) => [run.run_id, run.jobs_total]), [["cp-a2", 1], ["cp-a1", 3]], "named by two anchors: the earliest keeps it");

	s.write(scheduleFile({ ...PLAIN, last_fire: { at: "2026-09-01T10:00:00Z", slot: "2026-09-01T10:00:00.000Z", job_id: "cp-leg", missed: true } }, MANUAL, ORG));
	s.jobs([ledgerJob(PLAIN.id, "cp-leg", "2026-09-01T10:00:00Z", { notes: `scheduled by ${PLAIN.id} (x)` })]);
	assert.deepEqual([(await item(PLAIN.id)).runs[0]?.via, (await item(PLAIN.id)).runs[0]?.missed], ["slot", true], "a legacy `scheduled by` note is an anchor; missed comes from last_fire");
	s.jobs(Array.from({ length: 7 }, (_, n) => anchorJob(PLAIN.id, `cp-r${n}`, `2026-09-0${n + 1}T10:00:00Z`)));
	const window = await item(PLAIN.id);
	assert.deepEqual([window.runs.length, window.run_count, window.job_count, window.runs[0]?.run_id], [5, 7, 7, "cp-r6"], "the window keeps the latest 5");

	const comments = [{ text: "expanded: R1 cp-r0, S1 cp-s0" }, { text: "note" }, { text: "expanded: R1 cp-r1, S1 cp-s1" }];
	const expanded = (schedule: string) => anchorJob(schedule, "cp-a1", "2026-09-01T10:00:00Z", { comments });
	s.jobs([expanded(ORG.id), expanded(PLAIN.id)]);
	assert.deepEqual((await item(ORG.id)).runs[0]?.result, { kind: "report", job_id: "cp-s1", href: "#job/cp-s1" }, "the newest expanded: comment names the S1");
	assert.deepEqual((await item(PLAIN.id)).runs[0]?.result, { kind: "branch", job_id: "cp-a1", href: "#job/cp-a1" });
	assert.equal((await item(PLAIN.id)).lands, "branch", "a ship/local schedule lands a branch");
	const results = async (...jobs: Line[]) => {
		const shapes = [{ ...PLAIN, job: { ...PLAIN.job, kind: "research" } }, { ...PLAIN, id: "sch-b3b3b3", job: { ...PLAIN.job, kind: "research", delivery: "answer" } }, { ...PLAIN, id: "sch-b4b4b4", job: { ...PLAIN.job, delivery: "pr" } }];
		s.write(scheduleFile(...shapes, MANUAL, ORG));
		s.jobs([...shapes.map((shape) => ({ ...expanded(shape.id) } as Line)).map((job, n) => ({ ...job, id: `cp-a${n + 1}` })), ...jobs]);
		const data = await s.read();
		return shapes.map((shape) => data.schedules.find((x) => x.id === shape.id)!.runs[0]?.result?.kind);
	};
	assert.deepEqual(await results(), ["report", "answer", "job"], "research/local report, answer, ship/pr job");
	s.envelope("cp-a1", { pr_url: "https://github.com/a/b/pull/1" });
	assert.equal((await results())[0], "pull_request");
	const data = await s.read();
	assert.deepEqual([MANUAL.id, ORG.id, "sch-b1b1b1", "sch-b4b4b4"].map((id) => data.schedules.find((x) => x.id === id)?.lands), ["board", "report", "report", "pull_request"]);
});

test("P20-schedules-anchor-notes: the notes the real Scheduler writes for a cron fire, a dashboard and a cp_schedule Run now each anchor a run", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t);
	const at = { now: new Date("2026-07-01T06:00:00Z") };
	rmSync(join(s.home, ".pi-command-post", "jobs.json"));
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: s.home }).ledger as Ledger;
	const runs = openScheduleRunStore(s.home);
	const mandates = new MandateStore(s.home, { runs, now: () => at.now });
	const scheduler = new Scheduler({ home: s.home, ledger: () => ledger, mandates, runs, usageJobs: () => [], cloneOf: () => s.home, now: () => at.now, startedAt: at.now, mintContext: () => ({ defaults: loadMandateDefaults(s.home), ceiling: 100_000_000 }) });
	const native = { action: { saved_by: "operator-quote" as const, provenance: { channel: "cp_schedule" as const, tool_call_id: "call-add", quote_sha: "abcdef123456" } }, limits: {} };
	const base = { project: "demo", title: "triage", kind: "research" as const, delivery: "answer" as const };
	const hourly = await scheduler.add({ name: "hourly", native, cron: "0 * * * *", tz: "UTC", ...base });
	const manual = await scheduler.add({ name: "manual", native, manual: true, ...base });
	at.now = new Date("2026-07-01T07:00:30Z");
	const cron = (await scheduler.tick()).find((event) => event.schedule_id === hourly.id);
	const dash = await scheduler.fireNow(manual.id, { via: "dashboard", request_id: "req-1", peer: "127.0.0.1" });
	await ledger.close(dash.job_id!, "done");
	await runs.closeRun(dash.run_id!, "completed", "2026-07-01T07:00:31Z");
	const quote = await scheduler.fireNow(manual.id, { via: "cp_schedule", tool_call_id: "call-1" });
	for (const event of [cron, dash, quote]) assert.equal(event?.outcome, "fired", event?.reason);
	const data = await s.read();
	assert.equal(data.error, null);
	const of = (id: string) => data.schedules.find((x) => x.id === id)!;
	assert.deepEqual(of(hourly.id).runs.map((run: Line) => [run.anchor_id, run.via]), [[cron!.job_id, "slot"]]);
	assert.deepEqual(of(manual.id).runs.map((run: Line) => [run.via, run.anchor_id]).sort(), [["cp_schedule", quote.job_id], ["dashboard", dash.job_id]]);
	// Those notes on a legacy schedule's jobs (no run store) anchor a run each: here only ANCHOR_NOTE groups them.
	const notes = await Promise.all([cron, dash, quote].map(async (event) => (await ledger.show(event!.job_id!)).notes ?? ""));
	const legacy = await schedulesHome(t, scheduleFile(PLAIN));
	legacy.jobs(notes.map((note, n) => ledgerJob(PLAIN.id, `cp-n${n}`, `2026-09-0${n + 1}T10:00:00Z`, { notes: note })));
	const grouped = first(await legacy.read()).runs.map((run: Line) => [run.run_id, run.via]);
	assert.deepEqual(grouped, [["cp-n2", "cp_schedule"], ["cp-n1", "dashboard"], ["cp-n0", "slot"]], "each real note is an anchor");
});

// ---------------------------------------------------------------------------------------------------------------
// The Schedules page's buttons and request lines in a tab (baseline tests/viewer-schedule-control-ui.test.ts).

const NIGHT = { ...MANUAL, id: "sch-aaaaaa", name: "nightly", job: { title: "T", kind: "research", delivery: "answer" }, grant_template: TEMPLATE };
const control = async (s: Awaited<ReturnType<typeof schedulesHome>>, lock = true) => {
	if (lock) put(join(s.stateDir, "parent.lock"), JSON.stringify({ pid: process.pid, started_at: "2026-09-28T00:00:00Z" }));
	const page = await schedulesPage(s);
	await page.tab.find(".schedule-controls button");
	const card = () => page.cards()[0]!;
	const buttons = () => [...card().querySelectorAll(".schedule-controls button")].map((b) => b.textContent);
	const press = async (label: string) => { page.tab.click([...card().querySelectorAll("button")].find((b) => b.textContent === label)!); await new Promise((done) => setTimeout(done, 300)); };
	const posts = () => page.tab.requests.filter((r) => r.method === "POST" && r.path === "/api/schedules/request").map((r) => ({ ...r, json: JSON.parse(r.body ?? "{}") as Line }));
	const line = () => card().querySelector('.schedule-control [role="status"], .schedule-control [role="alert"]');
	const allDisabled = () => [...card().querySelectorAll(".schedule-controls button")].every((b) => b.hasAttribute("disabled"));
	return { ...page, card, buttons, press, posts, line, allDisabled };
};
/** A native policy for `schedule` from its legacy limits, with its project registered so the live bounds read. */
const native = (s: Awaited<ReturnType<typeof schedulesHome>>, schedule: ReturnType<typeof readScheduleFile>[number]) => {
	put(join(s.home, LAYOUT.projectsFile), JSON.stringify({ projects: [{ name: "demo", clone_url: "https://github.com/o/demo.git" }] }));
	const legacy = policyFromLegacy(schedule, schedule.grant_template!);
	return nativePolicyDraft({ schedule_id: schedule.id, project: legacy.project, recipe: legacy.recipe, recipe_config: legacy.recipe_config, trigger: legacy.trigger, limits: legacy.limits }, { revision: 1, saved_at: "2026-09-21T04:00:00Z", saved_by: "operator-quote", provenance: { channel: "dashboard" } });
};
const journal = (s: Awaited<ReturnType<typeof schedulesHome>>) => lines(scheduleControlFile(s.stateDir));
const outcome = (s: Awaited<ReturnType<typeof schedulesHome>>, id: string, state: string, reason: string | null = null, job_id: string | null = null) =>
	appendScheduleControlLine(s.stateDir, { type: "outcome", by: "parent", id, at: iso(NOW), state, reason, job_id } as never);

test("P20-schedule-control-ui: Run now sends run_now with the token; Remove needs two taps; a pending request disables every action", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(NIGHT));
	const ui = await control(s);
	assert.deepEqual(ui.buttons(), ["Run now", "Disable", "Remove…"]);
	assert.equal(ui.card().querySelector(".schedule-controls button")?.className, "schedule-primary");
	const token = String((await s.view.get("/api/schedules/control")).body.token);
	await ui.press("Run now");
	const [run] = ui.posts();
	assert.deepEqual([run?.status, run?.headers["content-type"], run?.headers["x-cp-control-token"]], [202, "application/json", token]);
	assert.deepEqual(Object.keys(run!.json), ["op", "schedule_id", "client_id"], "the exact body, client_id last");
	assert.deepEqual([run!.json.op, run!.json.schedule_id], ["run_now", "sch-aaaaaa"]);
	assert.match(String(run!.json.client_id), /^sk-[0-9]{14}-[0-9a-f]{8}$/, "the client id has the server's shape");
	const id = String(journal(s).at(-1)!.id);
	assert.equal(ui.line()?.textContent, `Request queued · run_now · ${id}`);
	assert.ok(ui.allDisabled(), "a queued request disables every action");
	appendScheduleControlLine(s.stateDir, { type: "claimed", by: "parent", id, at: iso(NOW), pid: process.pid });
	await refresh(ui.tab);
	assert.equal(ui.line()?.textContent, "Starting run…");
	assert.ok(ui.allDisabled(), "so does one being applied");
	outcome(s, id, "done", null, "cp-job");
	await refresh(ui.tab);
	assert.match(ui.line()?.textContent ?? "", /^Run accepted · cp-job · view run$/, "accepted, never completed");
	assert.equal(ui.line()?.querySelector("a")?.getAttribute("href"), "#job/cp-job");

	await ui.press("Remove…");
	assert.equal(ui.posts().length, 1, "the first tap only arms Remove");
	assert.equal(ui.card().querySelector(".schedule-remove")?.textContent, "Tap again to remove");
	await ui.press("Tap again to remove");
	assert.deepEqual([ui.posts().length, ui.posts()[1]?.json.op], [2, "remove"]);
	assert.equal(ui.card().querySelector(".schedule-remove")?.textContent, "Remove…", "and disarms again");
	outcome(s, String(journal(s).at(-1)!.id), "refused", "grant is stopped: move the schedule to a new grant");
	await refresh(ui.tab);
	assert.equal(ui.line()?.textContent, "Refused: grant is stopped: move the schedule to a new grant");
	await ui.press("Disable");
	assert.equal(ui.posts()[2]?.json.op, "disable");
	outcome(s, String(journal(s).at(-1)!.id), "done");
	await refresh(ui.tab);
	assert.equal(ui.line()?.textContent, "Done · Disable");

	s.write(scheduleFile({ ...NIGHT, enabled: false }));
	await refresh(ui.tab);
	assert.deepEqual(ui.buttons(), ["Enable", "Remove…"], "disabled schedules cannot Run now");
	await ui.press("Enable");
	assert.equal(ui.posts()[3]?.json.op, "enable");
	rmSync(join(s.stateDir, "parent.lock"));
	outcome(s, String(journal(s).at(-1)!.id), "done");
	await ui.press("Remove…");
	await ui.press("Tap again to remove");
	assert.equal(ui.posts()[4]?.status, 503);
	assert.match(ui.line()?.textContent ?? "", /^Refused: parent not running/, "a refused send is the card's alert");
	assert.equal(ui.card().querySelector('[role="alert"]')?.textContent, ui.line()?.textContent);
	await refresh(ui.tab);
	assert.ok(ui.allDisabled(), "a parent down disables every action");

	const closed = await schedulesHome(t, scheduleFile(NIGHT), false);
	const off = await control(closed);
	assert.match(off.tab.text(), /Controls not available: schedule controls are served only under --require-tailnet/);
	assert.ok(off.allDisabled(), "unavailable controls disable every action");
});

test("P20-schedule-control-policy: a policy-bound card sends a revision-bound Run now, shows View active run while one is open; readiness reads the policy", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(NIGHT));
	put(join(s.stateDir, "parent.lock"), JSON.stringify({ pid: process.pid, started_at: "2026-09-28T00:00:00Z" }));
	const held = await s.view.open("#schedules", /^\/api\/schedules\/policy/);
	await held.find(".schedule-readiness");
	assert.equal(held.$(".schedule-readiness")?.textContent, "Checking readiness");
	held.release();
	const blocking = (await s.view.get(`/api/schedules/policy?schedule_id=${NIGHT.id}`)).body.blocking as string[];
	assert.ok(blocking.length > 0, "a legacy grant-shaped policy blocks");
	await held.find(".schedule-readiness", (el) => el.textContent === `Blocked: ${blocking.join("; ")}`);
	held.close();

	const schedule = readScheduleFile(join(s.stateDir, "schedules.json"))[0]!;
	const runs = openScheduleRunStore(s.home);
	const policy = native(s, schedule);
	await runs.savePolicyRevision(policy, { at: "2026-09-21T04:00:00Z", provenance: { channel: "dashboard" } });
	const revision = Number(first(await s.read()).policy?.active_revision);
	const ui = await control(s, false);
	await ui.tab.find(".schedule-readiness", (el) => el.textContent === "Ready");
	await ui.press("Run now");
	assert.deepEqual([ui.posts()[0]?.json.op, ui.posts()[0]?.json.revision], ["run_now", revision]);
	const id = "run-20260921040000-abcdef";
	await runs.createRun({ schema_version: 1, id, schedule_id: schedule.id, policy_revision: revision, policy, start_key: "dashboard:sc-20260921040010-abcdef12", execution: resolveExecution(policy) as RunExecution, trigger: { via: "dashboard", at: "2026-09-21T04:00:10Z", slot: "2026-09-21T04:00:10Z", missed: false, request_id: "sc-20260921040010-abcdef12" }, anchor_job_id: null, members: [], phase: "accepted", outcome: null, started_at: "2026-09-21T04:00:10Z", deadline_at: "2026-09-29T04:00:10Z", risk_preapproved: [], authority_log: [], cap_notices: [] });
	await refresh(ui.tab);
	assert.equal(ui.card().querySelector(".schedule-controls .schedule-primary")?.textContent, "Run starting…");
	await runs.attachAnchor(id, { job_id: "cp-anchor", role: null, admitted_at: "2026-09-21T04:00:10Z" });
	await refresh(ui.tab);
	assert.equal(ui.card().querySelector(".schedule-view-run")?.getAttribute("href"), "#job/cp-anchor");
	assert.equal(ui.buttons().includes("Run now"), false);
	put(join(s.stateDir, "schedule-policies.json"), "{");
	await refresh(ui.tab);
	assert.match(ui.tab.text(), /Schedules unavailable: \S+schedule-policies\.json is not valid JSON .*; refusing to guess/, "an unreadable policy store refuses the page");
	assert.equal(ui.cards().length, 0, "and offers no action on a guessed policy");
});

test("P20-schedule-request-lines: save_policy and deactivate outcomes read as the parent wrote them", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(NIGHT));
	const schedule = readScheduleFile(join(s.stateDir, "schedules.json"))[0]!;
	const policy = policyFromLegacy(schedule, schedule.grant_template!);
	const request = (id: string, op: string, extra: Line = {}) => appendScheduleControlLine(s.stateDir, { type: "request", by: "viewer", id, at: iso(NOW), peer: null, op, schedule_id: NIGHT.id, ...extra } as never);
	request("sc-20260928014100-00000001", "save_policy", { revision: 0, policy });
	outcome(s, "sc-20260928014100-00000001", "done", "Settings saved · revision 2 (applies to the next run)");
	const ui = await control(s);
	assert.equal(ui.line()?.textContent, "Settings saved · revision 2 (applies to the next run)");
	request("sc-20260928014100-00000002", "deactivate");
	outcome(s, "sc-20260928014100-00000002", "done");
	await refresh(ui.tab);
	assert.equal(ui.line()?.textContent, "Deactivated · no new runs until a revision is adopted");
	request("sc-20260928014100-00000003", "run_now");
	outcome(s, "sc-20260928014100-00000003", "done");
	await refresh(ui.tab);
	assert.equal(ui.line()?.textContent, "Run accepted", "a run with no job yet is accepted, not completed");
});

// ---------------------------------------------------------------------------------------------------------------
// The typed editor and the control receipts in a tab (baseline tests/viewer-schedule-editor.test.ts).

/** A ready card for NIGHT (its project registered) with the editor opened by its own button. */
async function editor(s: Awaited<ReturnType<typeof schedulesHome>>) {
	put(join(s.home, LAYOUT.projectsFile), JSON.stringify({ projects: [{ name: "demo", clone_url: "https://github.com/o/demo.git" }] }));
	const ui = await control(s);
	await ui.tab.find(".schedule-settings button");
	await ui.press("Edit settings");
	await ui.tab.find(".schedule-editor");
	const field = (label: RegExp) => [...ui.card().querySelectorAll(".schedule-editor label")].find((l) => label.test(l.querySelector("span")?.textContent ?? ""))!;
	const input = (label: RegExp) => field(label).querySelector("input") as unknown as { value: string } & Element;
	const type = async (label: RegExp, value: string) => { ui.tab.type(input(label), value); await new Promise((done) => setTimeout(done, 50)); };
	const button = (name: string) => [...ui.card().querySelectorAll(".schedule-editor button")].find((b) => b.textContent === name);
	const saves = () => ui.posts().filter((p) => p.json.op === "save_policy");
	return { ...ui, field, input, type, button, saves };
}

test("P20-schedule-editor: a bad field shows its own error and blocks Save; ceilings are read-only; Save sends one save_policy", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(NIGHT));
	const ed = await editor(s);
	const effective = (await s.view.get(`/api/schedules/policy?schedule_id=${NIGHT.id}`)).body.effective as { limits: Record<string, number> };
	assert.equal(ed.button("Save settings")?.hasAttribute("disabled"), false);
	const ceilings = ed.card().querySelector(".schedule-editor .schedule-readonly")?.textContent ?? "";
	assert.match(ceilings, new RegExp(`^Inherited ceilings \\(read-only, they can only narrow\\): \\$${effective.limits.usd}, ${effective.limits.tokens} tokens`));
	assert.equal(ed.card().querySelectorAll(".schedule-editor .schedule-readonly input").length, 0, "inherited ceilings have no input");
	await ed.type(/At once/, "0");
	assert.equal(ed.button("Save settings")?.hasAttribute("disabled"), true);
	assert.equal(ed.field(/At once/).querySelector(".schedule-field-error")?.textContent, "must be a whole number, at least 1", "under its own field");
	assert.equal(ed.field(/USD/).querySelector(".schedule-field-error"), null);
	await ed.type(/USD/, "7");
	await ed.type(/At once/, "1");
	assert.equal(ed.button("Save settings")?.hasAttribute("disabled"), false);
	await ed.press("Save settings");
	assert.equal(ed.saves().length, 1, "one save_policy");
	const sent = ed.saves()[0]!.json as { schedule_id: string; revision: number; policy: { limits: { usd: number; parallelism: number } } };
	assert.deepEqual([sent.schedule_id, sent.revision, sent.policy.limits.usd, sent.policy.limits.parallelism], [NIGHT.id, 0, 7, 1]);
	assert.equal(ed.saves()[0]!.status, 202);
});

test("P20-schedule-editor-refusal: a server refusal lands under its field, binds to the values it answered, and a correction resubmits", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(NIGHT));
	const ed = await editor(s);
	const errors = () => ed.field(/Run hours/).querySelector(".schedule-field-error")?.textContent ?? null;
	await ed.type(/Run hours/, "100000");
	assert.equal(ed.button("Save settings")?.hasAttribute("disabled"), false, "the browser checks only what it cheaply can");
	await ed.press("Save settings");
	const first = ed.saves()[0]!;
	assert.equal(first.status, 400);
	const reason = String(lines(controlJournalFile(s.stateDir)).at(-1)!.reason);
	assert.match(reason, /^invalid schedule policy: \/limits\/run_hours: /);
	assert.equal(errors(), reason.replace(/^invalid schedule policy: \/limits\/run_hours: /, ""), "the server's text, under its field");
	assert.equal(ed.button("Save settings")?.hasAttribute("disabled"), true, "the refusal blocks the values it answered");
	await ed.type(/Run hours/, "200000");
	assert.equal(errors(), null, "a correction clears the refusal");
	assert.equal(ed.button("Save settings")?.hasAttribute("disabled"), false);
	await ed.press("Save settings");
	assert.equal(ed.saves().length, 2);
	assert.equal(errors(), reason.replace(/^invalid schedule policy: \/limits\/run_hours: /, ""), "the same reason on the new draft shows");
	assert.equal(ed.button("Save settings")?.hasAttribute("disabled"), true);
	await ed.type(/Run hours/, "24");
	assert.equal(ed.card().querySelectorAll(".schedule-field-error").length, 0);
	await ed.press("Save settings");
	assert.deepEqual(ed.saves().map((p) => p.status), [400, 400, 202], "the corrected draft resubmits");
});

test("P20-schedule-editor-stale: a newer saved revision never rebases the draft; Save stays off until Reload latest settings", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(NIGHT));
	const schedule = readScheduleFile(join(s.stateDir, "schedules.json"))[0]!;
	const runs = openScheduleRunStore(s.home);
	const base = native(s, schedule);
	await runs.savePolicyRevision({ ...base, limits: { ...base.limits, usd: 5 } }, { at: "2026-09-21T04:00:00Z", provenance: { channel: "dashboard" } });
	const ed = await editor(s);
	await ed.type(/USD/, "7");
	await runs.savePolicyRevision({ ...base, revision: 2, limits: { ...base.limits, usd: 11 } }, { at: "2026-09-21T05:00:00Z", provenance: { channel: "dashboard" } });
	s.view.pin(iso(NOW + 60_000));
	await refresh(ed.tab);
	await ed.tab.find(".schedule-editor .schedule-field-error");
	assert.equal(ed.button("Save settings")?.hasAttribute("disabled"), true, "a stale draft cannot be saved");
	assert.match(ed.card().querySelector(".schedule-editor .schedule-field-error")?.textContent ?? "", /^Settings changed elsewhere while you were editing \(revision 2\)/);
	assert.equal(ed.input(/USD/).value, "7", "the draft keeps its own values");
	await ed.press("Save settings");
	assert.equal(ed.saves().length, 0, "nothing is sent against the newer revision");
	await ed.press("Reload latest settings");
	assert.equal(ed.input(/USD/).value, "11", "reload re-opens on the newest settings");
	await ed.press("Save settings");
	assert.deepEqual([ed.saves().length, ed.saves()[0]?.json.revision], [1, 2]);
});

test("P20-schedule-receipts: a double click sends once; the receipt id survives a reload, which resends nothing", { timeout: 120_000 }, async (t) => {
	const s = await schedulesHome(t, scheduleFile(NIGHT));
	const ui = await control(s);
	const run = [...ui.card().querySelectorAll("button")].find((b) => b.textContent === "Run now")!;
	ui.tab.click(run);
	ui.tab.click(run);
	await new Promise((done) => setTimeout(done, 300));
	assert.equal(ui.posts().length, 1, "a double click sends once");
	const id = String(journal(s).at(-1)!.id);
	assert.deepEqual(JSON.parse(ui.tab.storage.get("cp-schedule-receipts")!), [id], "ids only, never a body");
	const again = await ui.tab.reopen();
	await again.find(".schedule-controls button");
	await new Promise((done) => setTimeout(done, 300));
	assert.deepEqual(JSON.parse(again.storage.get("cp-schedule-receipts")!), [id], "the reload keeps the receipt");
	assert.equal(again.requests.filter((r) => r.method === "POST").length, 0, "and resends nothing");
	assert.equal(journal(s).filter((l) => l.type === "request").length, 1);
	assert.equal(again.$$("article.schedule-card").length, 1);
	const script = (await s.view.get("/")).text.match(/<script type="module" src="([^"]+)"/)![1]!;
	assert.doesNotMatch((await s.view.get(script)).text, /from ?"node:|require\("node:|import\("node:/, "a browser build: no node module");
});
