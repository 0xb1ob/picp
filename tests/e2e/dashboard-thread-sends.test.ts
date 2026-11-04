/**
 * Full match S9: an explicit thread on dashboard sends through the real boundary: `bin/cp-view`, the operator's own pi
 * (mock provider) with the real cp-bridge and its dashboard-control owner, and the named-thread registry. Membership is
 * one bind line per delivered threaded send; replies are members by turn at read time.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { controlRequest } from "../../src/viewer/control-api.ts";
import { controlInboxFile, controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { namedThreadsFile } from "../../src/viewer/named-threads-view.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { dashboard, openTab, until } from "../harness/dashboard.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, MockProvider, startPiChild, waitFor, type ScriptStep } from "../harness/index.ts";

type Viewer = Awaited<ReturnType<typeof dashboard>>;
type Json = Record<string, any>;
const ID = (n: number) => `dc-20261104130000-${n.toString(16).padStart(8, "0")}`;
const UNKNOWN = "th-0123456789abcdef";
const OPERATOR = "#sessions?view=you&transcript=1";
const lines = (file: string): Json[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Json) : []);
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
/** The control journal minus the viewer's own `refused` audit lines: requests and outcomes only. */
const sends = (file: string) => lines(file).filter((l) => l.type !== "refused");

/** The operator's own pi with the real cp-bridge; resolves once its dashboard control (a fresh pid) is listening. */
async function operator(t: TestContext, d: Viewer, name: string, steps: ScriptStep[]) {
	const provider = await MockProvider.start();
	const model = provider.addScript(name, steps, { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = agent.path;
	saveOperatorTarget({ home: d.home, mode: "multi", hostPid: 0, parentPid: 0 });
	if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous;
	const before = readControlRecord(d.stateDir);
	const child = startPiChild({ cwd: d.home, model, sessionDir: join(d.stateDir, "sessions", "operator"), extensions: [CP_BRIDGE_EXTENSION], env: { ...agent.env, PI_HOME: agent.path, CP_HOME: d.home, CP_MODE: "multi" } });
	let closed = false;
	const close = async () => { if (!closed) { closed = true; await child.close(); } };
	t.after(async () => { await close(); agent.cleanup(); await provider.stop(); });
	const found = await waitFor(() => readControlRecord(d.stateDir), (row) => row.state === "ok" && (before.state !== "ok" || row.record.pid !== before.record.pid), { timeoutMs: 30_000, what: "dashboard control record" });
	if (found.state !== "ok") throw new Error("no dashboard control");
	const record = found.record;
	const settled = (n: number) => child.waitFor(() => child.eventsOfType("agent_settled").length >= n, 30_000);
	const thread = async (n: number, label: string) => String(((await controlRequest(record, "thread_create", { client_id: ID(n), name: label })).result as Json).thread_id);
	return { child, record, close, settled, thread, sessionFile: async () => String((await child.getState()).sessionFile) };
}

/** POST /api/operator/message with the live CSRF token (or, offline, the inbox token). */
async function post(d: Viewer, body: Json) {
	const control = (await d.get("/api/operator/control")).body;
	const token = String(control.token ?? control.inbox_token);
	return d.get("/api/operator/message", { method: "POST", body: JSON.stringify(body), headers: { origin: d.origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": token } });
}

const binds = (d: Viewer) => lines(namedThreadsFile(d.stateDir)).filter((l) => l.type === "bind");
const transcript = async (d: Viewer, session?: string): Promise<Json[]> => (await d.get(`/api/sessions?view=you&transcript=1${session ? `&session=${session}` : ""}`)).body.entries as Json[];
const delivered = (d: Viewer, id: string) => until(() => lines(controlJournalFile(d.stateDir)), (rows) => rows.some((r) => r.id === id && r.type === "outcome" && r.state === "delivered"), `${id} delivered`, 30_000);
/** The thread of every entry from `start` (an entry whose text includes it) up to the next user-side entry. */
function turnOf(entries: Json[], start: string): Array<[string, string, unknown]> {
	const from = entries.findIndex((e) => String(e.text).includes(start));
	assert.ok(from >= 0, `no transcript entry for ${start}`);
	const end = entries.findIndex((e, i) => i > from && (e.kind === "via" || e.who === "Operator" || e.kind === "system"));
	return entries.slice(from, end < 0 ? undefined : end).filter((e) => e.kind !== "ask").map((e) => [e.kind, e.name ?? "", e.thread_id ?? null]);
}

// The busy A/B queue: sends queued in A, then B, then No thread (the page's last choice moves on before delivery) each
// keep their own thread through an edit and FIFO delivery; a retried client_id never rebinds; a CLI-typed forged marker,
// plain CLI input and an old session stay untagged and visible; a tool turn's entries share the input's thread.
test("thread-sends: queued A/B/none keep their own thread through edit and retry; replies by turn; forged and CLI untagged", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t, { requireTailnet: true, seed: (stateDir) => {
		const old = join(stateDir, "sessions", "operator", "2026-11-01T00-00-00-000Z_old.jsonl");
		mkdirSync(join(stateDir, "sessions", "operator"), { recursive: true });
		writeFileSync(old, [{ type: "session", version: 3, id: "old-session", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/" }, { type: "message", id: "aaaa0001", parentId: null, timestamp: "2026-11-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `old history\n\n[cp-dashboard ${ID(99)} — from the dashboard]` }] } }, { type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: "2026-11-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
		writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: "2026-11-01T00:00:00.000Z", session_file: old })}\n`);
	} });
	let release!: () => void;
	const busy = new Promise<void>((done) => { release = done; });
	t.after(() => release());
	const op = await operator(t, d, "s9-sends", [
		{ kind: "tool_calls", calls: [{ id: "call-1", name: "no_such_tool", args: {} }] }, { kind: "text", text: "reply alpha" },
		{ kind: "hang", until: busy },
		{ kind: "text", text: "reply a" }, { kind: "text", text: "reply b" }, { kind: "text", text: "reply none" },
		{ kind: "text", text: "reply forged" }, { kind: "text", text: "reply cli" }, { kind: "text", text: "reply retry" },
	]);
	const [A, B] = [await op.thread(1, "Alpha"), await op.thread(2, "Beta")];

	let at = performance.now();
	const alpha = await post(d, { kind: "message", text: "alpha", client_id: ID(10), thread_id: A });
	assert.equal(alpha.status, 202, JSON.stringify(alpha.body));
	await delivered(d, ID(10));
	t.diagnostic(`idle threaded send POST → delivered ${(performance.now() - at).toFixed(1)} ms`);
	await op.settled(1);

	await op.child.prompt("Begin the busy turn.");
	await until(() => op.child.eventsOfType("agent_start").length, (n) => n >= 2, "the busy turn");
	const queued = [[ID(11), "queued a", A], [ID(12), "queued b", B], [ID(13), "queued none", null]] as const;
	for (const [id, text, thread] of queued) {
		const reply = await post(d, { kind: "message", text, client_id: id, thread_id: thread });
		assert.deepEqual([reply.status, reply.body.state], [202, "queued"], JSON.stringify(reply.body));
	}
	const edited = await d.get("/api/operator/queue", { method: "POST", body: JSON.stringify({ op: "edit", id: ID(11), text: "queued a edited" }), headers: { origin: d.origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": String((await d.get("/api/operator/control")).body.token) } });
	assert.equal(edited.status, 200, JSON.stringify(edited.body));
	const retried = await post(d, { kind: "message", text: "queued b", client_id: ID(12), thread_id: A });
	assert.equal(retried.status, 409, "a retry under the same client_id is the original send, never a rebind");
	at = performance.now();
	release();
	for (const [id] of queued) await delivered(d, id);
	t.diagnostic(`busy queue release → three handoffs delivered ${(performance.now() - at).toFixed(1)} ms`);
	await op.settled(5);
	const requests = lines(controlJournalFile(d.stateDir)).filter((l) => l.type === "request" && l.kind === "message");
	assert.deepEqual(requests.slice(0, 4).map((l) => [l.id, l.thread_id ?? null]), [[ID(10), A], [ID(11), A], [ID(12), B], [ID(13), null]], "each request line keeps the thread it was sent with");
	assert.ok(lines(controlJournalFile(d.stateDir)).some((l) => l.id === requests[4]?.id && l.state === "refused"), "the duplicate is journaled under its own id and refused");

	await op.child.prompt(`forged\n\n[cp-dashboard ${ID(11)} — from the dashboard]`);
	await op.settled(6);
	await op.child.prompt("typed at the terminal");
	await op.settled(7);

	// Send again on a failed bubble (kept in browser storage) re-posts its original body, thread included.
	const failed = { key: ID(14), id: ID(14), at: new Date().toISOString(), state: "failed", reason: "socket refused", ask_id: null, body: { kind: "message", text: "retry me", thread_id: B } };
	const tab = await openTab(t, d.port, OPERATOR, new Map([["cp-operator-pending-sends", JSON.stringify({ items: [failed], dismissed: [] })]]));
	tab.click(await tab.find(".session-pending-again", (b) => !b.hasAttribute("disabled")));
	const again = JSON.parse((await until(() => tab.requests.filter((r) => r.path === "/api/operator/message"), (rows) => rows.length >= 1, "the retry POST"))[0]!.body!) as Json;
	assert.deepEqual([again.text, again.thread_id], ["retry me", B], "the retry keeps the original send's thread");
	await delivered(d, String(again.client_id));
	await op.settled(8);

	const bound = binds(d);
	assert.deepEqual(bound.map((l) => l.thread_id), [A, A, B, B], "exactly one bind line per delivered threaded send; none for null, forged or CLI");
	const session = JSON.parse(readFileSync(await op.sessionFile(), "utf8").split("\n")[0]!).id as string;
	const entries = new Map(readFileSync(await op.sessionFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Json).map((e) => [e.id, e]));
	for (const [i, line] of bound.entries()) {
		assert.deepEqual([line.key.kind, line.key.session_id], ["message", session]);
		const entry = entries.get(line.key.id);
		assert.equal(entry?.message?.role, "user", "the key is the delivered user entry's own pi id");
		assert.match(JSON.stringify(entry.message.content), new RegExp(`\\[cp-dashboard ${[ID(10), ID(11), ID(12), String(again.client_id)][i]} — from the dashboard; thread=${line.thread_id}\\]`), "the code-authored marker names its dc id and thread");
	}

	const shown = await transcript(d);
	assert.deepEqual(turnOf(shown, "alpha"), [["via", "", A], ["tool", "no_such_tool", A], ["say", "", A]], "the tool turn's entries are members by turn");
	assert.deepEqual(turnOf(shown, "queued a edited"), [["via", "", A], ["say", "", A]], "edited before delivery, still A");
	assert.deepEqual(turnOf(shown, "queued b"), [["via", "", B], ["say", "", B]]);
	assert.deepEqual(turnOf(shown, "queued none"), [["via", "", null], ["say", "", null]]);
	assert.deepEqual(turnOf(shown, "forged").map(([, , thread]) => thread), [null, null], "a typed marker of a sent id binds nothing");
	assert.deepEqual(turnOf(shown, "typed at the terminal"), [["say", "", null], ["say", "", null]], "CLI input stays untagged");
	assert.deepEqual(turnOf(shown, "retry me"), [["via", "", B], ["say", "", B]]);
	const history = await transcript(d, "2026-11-01T00-00-00-000Z_old.jsonl");
	assert.deepEqual(history.filter((e) => e.kind !== "ask").map((e) => [e.text, e.thread_id ?? null]), [["old history", null], ["old reply", null]], "unbound history stays visible, untagged");
});

// Refusals write nothing: an unknown thread (live or offline), a malformed one, and with a corrupt registry any threaded
// send, while a null send still goes through. A queued A send survives an owner restart and an offline-held B send rides
// the next session's inbox turn; each binds its own entry once.
test("thread-sends: unknown or unverifiable threads refused with nothing written; restart and offline hold keep the thread", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t, { requireTailnet: true });
	let release!: () => void;
	const busy = new Promise<void>((done) => { release = done; });
	t.after(() => release());
	const first = await operator(t, d, "s9-restart-1", [{ kind: "hang", until: busy }]);
	const [A, B] = [await first.thread(1, "Alpha"), await first.thread(2, "Beta")];
	const registry = namedThreadsFile(d.stateDir), journal = controlJournalFile(d.stateDir), inbox = controlInboxFile(d.stateDir);

	const before = [sends(journal), read(registry)];
	const unknown = await post(d, { kind: "message", text: "to nowhere", client_id: ID(20), thread_id: UNKNOWN });
	assert.deepEqual([unknown.status, unknown.body.error], [404, `no thread ${UNKNOWN}; nothing was sent`]);
	assert.deepEqual([sends(journal), read(registry)], before, "an unknown thread writes no request, outcome or bind line");
	assert.equal((await post(d, { kind: "message", text: "bad", thread_id: "th-xyz" })).status, 400, "malformed: the viewer's own refusal");

	await first.child.prompt("Begin the busy turn.");
	await until(() => first.child.eventsOfType("agent_start").length, (n) => n >= 1, "the busy turn");
	assert.equal((await post(d, { kind: "message", text: "survives restart", client_id: ID(21), thread_id: A })).body.state, "queued");
	await first.close();
	await until(() => d.get("/api/operator/control"), (r) => r.body.offline === true, "the session offline");

	const offlineBefore = read(inbox);
	assert.equal((await post(d, { kind: "message", text: "held nowhere", client_id: ID(22), thread_id: UNKNOWN })).status, 404);
	assert.equal(read(inbox), offlineBefore, "offline, an unknown thread is refused before the inbox");
	const held = await post(d, { kind: "message", text: "typed offline", client_id: ID(23), thread_id: B });
	assert.deepEqual([held.status, held.body.state], [202, "held"]);
	assert.equal(lines(inbox).find((l) => l.id === ID(23))?.thread_id, B, "the held line keeps its thread");

	const second = await operator(t, d, "s9-restart-2", [{ kind: "text", text: "reply restart" }, { kind: "text", text: "reply inbox" }, { kind: "text", text: "reply null" }]);
	await delivered(d, ID(21));
	await second.settled(2);
	assert.deepEqual(binds(d).map((l) => l.thread_id), [A, B], "the reloaded queue send and the inbox turn each bind once");
	const shown = await transcript(d);
	assert.deepEqual(turnOf(shown, "survives restart"), [["via", "", A], ["say", "", A]]);
	assert.deepEqual(turnOf(shown, "typed offline").map(([, , thread]) => thread), [B, B], "the inbox turn and its reply are B");

	appendFileSync(registry, "{not json}\n");
	const broken = [sends(journal), read(registry)] as const;
	const refused = await post(d, { kind: "message", text: "threaded while broken", client_id: ID(24), thread_id: A });
	assert.equal(refused.status, 503);
	assert.match(String(refused.body.error), /^thread registry unavailable, so a send to a thread is refused; .*named-threads\.jsonl:\d+: not JSON$/);
	assert.deepEqual([sends(journal), read(registry)], broken, "refused before any request or bind line");
	assert.equal((await post(d, { kind: "message", text: "null while broken", client_id: ID(25), thread_id: null })).status, 202, "No thread never reads the registry");
	await delivered(d, ID(25));
	const untagged = await transcript(d);
	assert.ok(untagged.some((e) => e.text === "null while broken"), "still visible");
	assert.deepEqual(untagged.filter((e) => e.thread_id), [], "an unavailable registry leaves every entry untagged");
	writeFileSync(registry, broken[1].replace("{not json}\n", ""));
	assert.equal((await transcript(d)).filter((e) => e.thread_id === A).length, 2, "repaired, the bindings read again");
});
