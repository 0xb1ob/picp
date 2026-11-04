/**
 * Full match S8: the named-thread registry through `bin/cp-view` and the operator session's real dashboard-control
 * socket. Create/rename go viewer → owner only; `GET /api/threads` reads and never writes; bind is tested at its
 * module boundary (S8 has no producer).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { bindThread } from "../../src/operator-named-threads.ts";
import { controlJournalFile, controlSocketFile } from "../../src/viewer/control-files.ts";
import { namedThreadsFile } from "../../src/viewer/named-threads-view.ts";
import type { Context } from "../harness/conversations.ts";
import { dashboard, operatorSession } from "../harness/dashboard.ts";

type Viewer = Awaited<ReturnType<typeof dashboard>>;
type Json = Record<string, unknown>;
const ID = (n: number) => `dc-20261104120000-${n.toString(16).padStart(8, "0")}`;
const TH = /^th-[0-9a-f]{16}$/;
const lines = (file: string): Json[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Json) : []);

async function post(d: Viewer, body: unknown) {
	const token = String((await d.get("/api/operator/control")).body.token);
	return d.get("/api/operator/threads", { method: "POST", body: JSON.stringify(body), headers: { origin: d.origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": token } });
}

/** Every regular file under state/operator with its bytes: a GET must leave it identical. */
function snapshot(stateDir: string): string {
	const dir = join(stateDir, "operator");
	return readdirSync(dir).sort().filter((name) => statSync(join(dir, name)).isFile()).map((name) => `${name}:${readFileSync(join(dir, name)).toString("base64")}`).join("\n");
}

async function viewer(t: Context, seed?: (stateDir: string) => void) {
	return dashboard(t, { requireTailnet: true, seed: (stateDir) => seed?.(stateDir) });
}

test("threads-owner: create then rename keep one opaque id across an owner restart; retries replay, never a second line", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t);
	const file = namedThreadsFile(d.stateDir);
	const first = await operatorSession(t, d.stateDir);
	assert.equal((await d.get("/api/operator/control")).body.threads, true, "the owner advertises the thread capability");
	const name = "Résumé 🧵 fix";
	let at = performance.now();
	const created = await post(d, { op: "create", client_id: ID(1), name: `  ${name}  ` });
	t.diagnostic(`create round trip ${(performance.now() - at).toFixed(1)} ms`);
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const id = String(created.body.thread_id);
	assert.match(id, TH);
	assert.deepEqual([created.body.name, created.body.state, created.body.replayed], [name, "created", false], "the name is trimmed");
	const retried = await post(d, { op: "create", client_id: ID(1), name });
	assert.deepEqual([retried.status, retried.body.thread_id, retried.body.replayed], [200, id, true], "same client_id: the first answer, no second thread");
	assert.equal((await post(d, { op: "create", client_id: ID(1), name: "other" })).status, 409, "a reused client_id with another request is refused");
	const twin = await post(d, { op: "create", client_id: ID(2), name });
	assert.equal(twin.status, 201);
	assert.notEqual(twin.body.thread_id, id, "duplicate names are allowed; each create is its own thread");
	const rejected = [" \t ", "a\u0007b", "x".repeat(81)];
	for (const bad of rejected) assert.equal((await post(d, { op: "create", client_id: ID(10 + rejected.indexOf(bad)), name: bad })).status, 400, JSON.stringify(bad));
	assert.equal((await post(d, { op: "create", client_id: ID(20), name: "🧵".repeat(80) })).status, 201, "80 code points fit");
	assert.equal((await post(d, { op: "rename", client_id: ID(21), thread_id: "th-0000000000000000", name: "x" })).status, 404);
	const renamed = await post(d, { op: "rename", client_id: ID(3), thread_id: id, name: "Billing" });
	assert.deepEqual([renamed.status, renamed.body.thread_id, renamed.body.state], [200, id, "renamed"]);
	assert.deepEqual([(await post(d, { op: "rename", client_id: ID(3), thread_id: id, name: "Billing" })).body.replayed], [true]);
	const events = lines(file);
	assert.deepEqual(events.map((e) => [e.v, e.type, e.request_id]), [[1, "create", ID(1)], [1, "create", ID(2)], [1, "create", ID(20)], [1, "rename", ID(3)]],
		"one line per accepted request; retries and refusals append nothing");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const audit = lines(controlJournalFile(d.stateDir)).filter((l) => l.type === "thread");
	assert.ok(audit.length >= 9 && audit.every((l) => l.by === "bridge"), "the owner journals every answer it gives");
	assert.deepEqual(audit.filter((l) => l.state === "replayed").map((l) => l.id), [ID(1), ID(3)]);

	first.control.stop();
	assert.equal((await post(d, { op: "rename", client_id: ID(4), thread_id: id, name: "Offline" })).status, 409, "no owner, no write");
	at = performance.now();
	const offline = await d.get("/api/threads");
	t.diagnostic(`GET /api/threads ${(performance.now() - at).toFixed(1)} ms, ${statSync(file).size} bytes`);
	assert.deepEqual(offline.body.threads, [
		{ id, name: "Billing", created_at: events[0]!.at, renamed_at: events[3]!.at },
		{ id: twin.body.thread_id, name, created_at: events[1]!.at, renamed_at: null },
		{ id: (offline.body.threads as Json[])[2]!.id, name: "🧵".repeat(80), created_at: events[2]!.at, renamed_at: null },
	]);
	await operatorSession(t, d.stateDir);
	const again = await post(d, { op: "rename", client_id: ID(5), thread_id: id, name: "Billing v2" });
	assert.deepEqual([again.status, again.body.thread_id], [200, id], "the restarted owner renames the same id");
	const listed = await d.get("/api/threads");
	assert.deepEqual([listed.body.available, (listed.body.threads as Json[])[0]], [true, { id, name: "Billing v2", created_at: events[0]!.at, renamed_at: lines(file).at(-1)!.at }]);
});

test("threads-old-owner: without the thread capability the write is refused and the owner never gets the frame", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t);
	await operatorSession(t, d.stateDir);
	// An owner from before S8: status without `threads`, `unknown op` for thread frames (counted, never forwarded).
	const socket = controlSocketFile(d.stateDir), moved = `${socket}.real`;
	renameSync(socket, moved);
	const reached: string[] = [];
	const relay = createServer((client) => {
		let buffer = "";
		client.on("error", () => {});
		client.on("data", (chunk) => {
			buffer += String(chunk);
			if (!buffer.includes("\n")) return;
			const frame = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { id: unknown; op: string };
			if (frame.op.startsWith("thread_")) {
				reached.push(frame.op);
				client.end(`${JSON.stringify({ id: frame.id, ok: false, status: 400, error: `unknown op ${frame.op}` })}\n`);
				return;
			}
			const upstream = createConnection(moved, () => upstream.write(buffer));
			let reply = "";
			upstream.on("error", () => client.destroy());
			upstream.on("data", (part) => {
				reply += String(part);
				if (!reply.includes("\n")) return;
				const answer = JSON.parse(reply.slice(0, reply.indexOf("\n"))) as { result?: Json };
				if (answer.result) delete answer.result.threads;
				client.end(`${JSON.stringify(answer)}\n`);
				upstream.destroy();
			});
		});
	});
	await new Promise<void>((done) => relay.listen(socket, done));
	t.after(() => relay.close());
	assert.equal((await d.get("/api/operator/control")).body.threads, undefined, "an older owner advertises nothing");
	const refused = await post(d, { op: "create", client_id: ID(1), name: "Billing" });
	assert.equal(refused.status, 409);
	assert.match(String(refused.body.error), /^unsupported: this operator session predates named threads; restart the session/);
	assert.deepEqual([reached, existsSync(namedThreadsFile(d.stateDir))], [[], false], "no thread frame reached the old owner; nothing written");
	assert.ok(lines(controlJournalFile(d.stateDir)).some((l) => l.type === "refused" && l.kind === "thread" && l.status === 409), "the viewer journals its refusal");
});

test("threads-corrupt: a bad line, a torn line or an unknown version make the registry unavailable and refuse writes", { timeout: 180_000 }, async (t) => {
	const create = { v: 1, type: "create", at: "2026-11-04T12:00:00.000Z", request_id: ID(1), thread_id: "th-0123456789abcdef", name: "Kept", peer: null };
	const d = await viewer(t, (stateDir) => {
		mkdirSync(join(stateDir, "operator"), { recursive: true });
		writeFileSync(namedThreadsFile(stateDir), `${JSON.stringify(create)}\n{"v":1,"type":"create",\n`);
	});
	await operatorSession(t, d.stateDir);
	const file = namedThreadsFile(d.stateDir);
	const cases: Array<[string, RegExp]> = [
		[`${JSON.stringify(create)}\n{"v":1,"type":"create",\n`, /named-threads\.jsonl:2: not JSON$/],
		[`${JSON.stringify(create)}\n${JSON.stringify({ ...create, request_id: ID(2) })}`, /named-threads\.jsonl:2: torn final line/],
		[`${JSON.stringify({ ...create, v: 2 })}\n`, /named-threads\.jsonl:1: unknown version v=2/],
		[`${JSON.stringify({ ...create, name: "a\u0007b" })}\n`, /named-threads\.jsonl:1: name must not contain control characters$/],
	];
	for (const [body, reason] of cases) {
		writeFileSync(file, body);
		const view = await d.get("/api/threads");
		assert.deepEqual([view.body.available, view.body.threads, view.body.bindings], [false, [], []], body);
		assert.match(String(view.body.reason), reason);
		const write = await post(d, { op: "create", client_id: ID(9), name: "New" });
		assert.equal(write.status, 503, JSON.stringify(write.body));
		assert.match(String(write.body.error), /^thread registry unavailable, writes refused: /);
		assert.equal(bindThread(d.stateDir, { kind: "job", id: "cp-x" }, null, new Date()).ok, false, "bind refuses too");
		assert.equal(readFileSync(file, "utf8"), body, "never truncated, repaired or reset");
	}
});

test("threads-retired-and-bind: the retired journal yields nothing; bind is idempotent, a conflict keeps the original; GETs write nothing", { timeout: 180_000 }, async (t) => {
	const retired = `${JSON.stringify({ type: "open", id: "th-aaaaaaaaaaaa", name: "old", at: "2026-01-01T00:00:00Z" })}\n${JSON.stringify({ type: "bind", thread: "th-aaaaaaaaaaaa", id: "dc-20260101000000-00000001" })}\n`;
	const d = await viewer(t, (stateDir) => {
		mkdirSync(join(stateDir, "operator"), { recursive: true });
		writeFileSync(join(stateDir, "operator", "threads.jsonl"), retired);
	});
	const empty = await d.get("/api/threads");
	assert.deepEqual([empty.status, empty.body.available, empty.body.reason, empty.body.threads, empty.body.bindings], [200, true, null, [], []], "no thread and no membership from the retired journal");
	assert.equal(existsSync(namedThreadsFile(d.stateDir)), false, "an absent registry stays absent after a GET");
	await operatorSession(t, d.stateDir);
	const a = String((await post(d, { op: "create", client_id: ID(1), name: "A" })).body.thread_id);
	const b = String((await post(d, { op: "create", client_id: ID(2), name: "B" })).body.thread_id);
	const key = { kind: "message", id: "dc-20261104120000-0000aaaa", session_id: "2026-11-04T11:00:00.000Z" };
	const now = new Date("2026-11-04T12:30:00.000Z");
	const bound = bindThread(d.stateDir, key, a, now);
	assert.deepEqual(bound, { ok: true, result: { ...key, thread_id: a, at: now.toISOString(), unchanged: false } });
	assert.deepEqual(bindThread(d.stateDir, key, a, new Date()), { ok: true, result: { ...key, thread_id: a, at: now.toISOString(), unchanged: true } }, "same key, same thread: no new line");
	const conflict = bindThread(d.stateDir, key, b, new Date());
	assert.deepEqual([conflict.ok, !conflict.ok && conflict.status], [false, 409]);
	assert.equal(bindThread(d.stateDir, { kind: "ask", id: "ask-1" }, null, now).ok, true, "an explicit No thread");
	assert.equal(bindThread(d.stateDir, { kind: "ask", id: "ask-1" }, a, now).ok, false, "No thread is a binding too; it never moves");
	assert.equal(bindThread(d.stateDir, { kind: "job", id: "cp-1", extra: 1 }, a, now).ok, false, "typed keys only");
	assert.equal(bindThread(d.stateDir, { kind: "job", id: "cp-1" }, "th-ffffffffffffffff", now).ok, false, "an unknown thread is refused");
	assert.deepEqual(lines(namedThreadsFile(d.stateDir)).filter((e) => e.type === "bind").map((e) => e.thread_id), [a, null], "one line per new binding");
	const before = snapshot(d.stateDir);
	for (let i = 0; i < 3; i += 1) {
		const view = await d.get("/api/threads");
		assert.deepEqual(view.body.bindings, [{ ...key, thread_id: a, at: now.toISOString() }, { kind: "ask", id: "ask-1", thread_id: null, at: now.toISOString() }], "the original binding is kept");
		await d.get("/api/operator/control");
	}
	assert.equal(snapshot(d.stateDir), before, "no GET writes under state/operator");
	assert.equal(readFileSync(join(d.stateDir, "operator", "threads.jsonl"), "utf8"), retired, "the retired journal is untouched");
	assert.equal((await d.get("/api/threads/done", { method: "POST", body: "{}", headers: { origin: d.origin, "content-type": "application/json" } })).status, 405, "#588's read-only 405 stays");
});
