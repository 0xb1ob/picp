/**
 * Remote dashboard PR 1c (T3, viewer half): with provenance in place a Full-control device's writes reach their
 * handlers through the remote listener. The device's id and name come only from the gate (a body `remote` field is
 * refused); the tunnel origin is exact; an older running bridge that cannot keep provenance gets restart-required,
 * never an unlabelled send; offline holds keep the device for replay. View-only stays refused.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { test } from "node:test";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../src/dashboard-control.ts";
import { controlJournalFile, controlRecordFile, controlSocketFile, parseDashboardText } from "../src/viewer/control-files.ts";
import { readInbox } from "../src/viewer/control-inbox.ts";
import { REMOTE_ORIGIN as ORIGIN, remoteRig } from "./harness/remote.ts";

type Rig = Awaited<ReturnType<typeof remoteRig>>;
const MESSAGE = "/api/operator/message";
const post = (cookie: string, token: string | null, body: unknown, extra: Record<string, string> = {}) => ({
	method: "POST", body: JSON.stringify(body),
	headers: { cookie, origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});
const journal = (stateDir: string): Array<Record<string, unknown>> => readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((row) => JSON.parse(row));

async function bridge(t: import("node:test").TestContext, env: Rig, idle: { value: boolean }) {
	const injected: string[] = [];
	const ports: ControlPorts = { inject: (text) => { injected.push(text); }, abort: () => {}, isIdle: () => idle.value, hasPendingMessages: () => false, sessionFile: () => "/tmp/operator-session.jsonl" };
	const control = await startDashboardControl({ stateDir: env.stateDir, ports, deliveredWaitMs: 20, log: () => {} });
	assert.equal(control.state, "listening");
	t.after(() => (control as DashboardControl).stop());
	return injected;
}
const tokenOf = async (env: Rig, cookie: string, key: "token" | "inbox_token") => (await env.r("/api/operator/control", { headers: { cookie } })).body[key] as string | null;

test("Full control: a remote send reaches the bridge stamped with the gate's device; a body cannot name one; the tunnel origin is exact; View-only stays 403", async (t) => {
	const env = await remoteRig(t);
	const idle = { value: true };
	const injected = await bridge(t, env, idle);
	const full = env.pair("Laptop"), view = env.pair("Phone", "view");
	const token = await tokenOf(env, full.cookie, "token");
	assert.match(String(token), /^[0-9a-f]{64}$/, "a Full-control device gets the write token");
	assert.equal(await tokenOf(env, view.cookie, "token"), null, "View-only never does");

	const sent = await env.r(MESSAGE, post(full.cookie, token, { kind: "message", text: "ship it" }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual(parseDashboardText(injected[0]!)?.remote, { sender: { device_id: full.id, name: "Laptop" }, editors: [] });
	assert.equal(parseDashboardText(injected[0]!)?.body, "ship it");

	const named = await env.r(MESSAGE, post(full.cookie, token, { kind: "message", text: "hi", remote: { device_id: view.id, name: "Boss" } }));
	assert.deepEqual([named.status, named.body.error], [400, "unknown field remote"]);
	const local = await env.r(MESSAGE, post(full.cookie, token, { kind: "message", text: "hi" }, { origin: `http://127.0.0.1:${env.options.port}` }));
	assert.deepEqual([local.status, local.body.error], [403, `Origin must be ${ORIGIN}`], "a remote device writes only from its tunnel origin");
	const viewed = await env.r(MESSAGE, post(view.cookie, token, { kind: "message", text: "hi" }));
	assert.deepEqual([viewed.status, viewed.body.error], [403, "View-only device: dashboard writes are refused"]);
	assert.equal(injected.length, 1, "no refused write reached the session");

	idle.value = false;
	const held = await env.r(MESSAGE, post(full.cookie, token, { kind: "message", text: "later" }));
	assert.equal(held.body.state, "queued");
	const edited = await env.r("/api/operator/queue", post(full.cookie, token, { op: "edit", id: held.body.id, text: "later, edited" }));
	assert.equal(edited.status, 200, JSON.stringify(edited.body));
	const line = journal(env.stateDir).find((row) => row.type === "edited" && row.id === held.body.id);
	assert.deepEqual(line?.remote, { device_id: full.id, name: "Laptop" }, "the edit names its device");
});

test("an older running bridge without remote_provenance: a remote send or edit is refused 409 restart-required and nothing reaches it", async (t) => {
	const env = await remoteRig(t);
	const frames: Array<Record<string, unknown>> = [];
	const socket = controlSocketFile(env.stateDir);
	mkdirSync(dirname(socket), { recursive: true });
	const old = createServer((conn) => conn.on("data", (chunk) => {
		const frame = JSON.parse(String(chunk).trim()) as Record<string, unknown>;
		frames.push(frame);
		conn.end(`${JSON.stringify(frame.op === "status" ? { ok: true, result: { busy: false, pending: false, session_file: null, recent: [], files: true } } : { ok: true, result: { id: "dc-20260101000000-00000000", state: "delivered" } })}\n`);
	}));
	await new Promise<void>((done) => old.listen(socket, done));
	t.after(() => old.close());
	const csrf = randomBytes(32).toString("hex");
	writeFileSync(controlRecordFile(env.stateDir), JSON.stringify({ version: 1, pid: process.pid, socket, token: randomBytes(32).toString("hex"), csrf, started_at: new Date().toISOString() }));
	const full = env.pair("Laptop");
	for (const [path, body] of [[MESSAGE, { kind: "message", text: "hi" }], ["/api/operator/queue", { op: "edit", id: "dc-20260101000000-00000000", text: "x" }]] as const) {
		const reply = await env.r(path, post(full.cookie, csrf, body));
		assert.equal(reply.status, 409, path);
		assert.match(String(reply.body.error), /predates remote-device provenance; restart the session/);
	}
	assert.deepEqual(frames.map((frame) => frame.op), ["status", "status"], "only the capability check reached the old bridge");
	const refused = journal(env.stateDir).filter((row) => row.type === "refused");
	assert.equal(refused.length, 2, "each refusal is journaled by the viewer");
});

test("offline: a remote message is held with its device for the next session to replay", async (t) => {
	const env = await remoteRig(t);
	const full = env.pair("Laptop");
	const inboxToken = await tokenOf(env, full.cookie, "inbox_token");
	const held = await env.r(MESSAGE, post(full.cookie, inboxToken, { kind: "message", text: "when you are back" }));
	assert.deepEqual([held.status, held.body.state], [202, "held"]);
	assert.deepEqual(readInbox(env.stateDir).held.map((message) => [message.text, message.remote]), [["when you are back", { device_id: full.id, name: "Laptop" }]]);
});
