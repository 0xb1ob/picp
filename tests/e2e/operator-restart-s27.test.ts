import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT, isoTimestamp } from "../../src/contracts.ts";
import { readControlRecord } from "../../src/viewer/control-files.ts";
import { CP_BRIDGE_EXTENSION, MockProvider, createAgentDir, createScratchHome, startRpc, waitFor } from "../harness/index.ts";

test("S27 restart: real bridge blocks pending outbox entries, preserves unreadable evidence and writes an owner-only marker", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s27-restart", [{ kind: "text", text: "Ready to restart." }]);
	const agent = createAgentDir({ provider });
	const state = join(home.path, LAYOUT.state);
	const marker = join(state, "operator", "relaunch.json");
	const session = join(home.path, "2026-01-01T00-00-00-000Z_0123abcd.jsonl");
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_OPERATOR_RELAUNCH_FILE: marker },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--session", session, "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "seed", message: "Create resumable context." });
	await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
	const record = await waitFor(() => readControlRecord(state), (r) => r.state === "ok", { what: "bridge control record" });
	assert.equal(record.state, "ok");
	if (record.state !== "ok") throw new Error("bridge offline");
	const call = (op: string) => new Promise<Record<string, any>>((resolve, reject) => {
		const socket = connect(record.record.socket);
		let response = "";
		socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, id: 1, token: record.record.token, op })}\n`));
		socket.on("data", (chunk) => { response += String(chunk); if (response.includes("\n")) { socket.end(); resolve(JSON.parse(response.trim())); } });
		socket.on("error", reject);
	});
	const outbox = join(home.path, LAYOUT.sessions, "cp-parent.sends.json");
	mkdirSync(dirname(outbox), { recursive: true });
	const entry = (id: string, age: number, extra: object = {}) => ({ schema_version: 1, id, text: "x", queued_at: isoTimestamp(new Date(Date.now() - age)), state: "settled", attempts: 1, ...extra });
	const pending = "ps-20260102110000-0123abcd";
	writeFileSync(outbox, JSON.stringify({ schema_version: 1, updated_at: isoTimestamp(), later: true, entries: [
		entry(pending, 1000, { state: "injected", future_optional: 1 }),
		entry("ps-20260102100000-0123abce", 1000, { owner_observed_at: isoTimestamp() }),
		entry("ps-20260101000000-0123abcf", 25 * 3600000),
	] }));
	const blocked = await call("restart");
	assert.equal(blocked.ok, false);
	assert.equal(blocked.error, `not now: cp_parent send ${pending} pending`);
	assert.equal(existsSync(marker), false);
	writeFileSync(outbox, "{not json");
	assert.match(String((await call("restart")).error), /parent send outbox unreadable:.*not valid JSON/);
	writeFileSync(outbox, JSON.stringify({ schema_version: 1, updated_at: isoTimestamp(), entries: [] }));
	const accepted = await call("restart");
	assert.equal(accepted.ok, true, JSON.stringify(accepted));
	assert.equal(accepted.result.state, "restarting");
	assert.equal(statSync(marker).mode & 0o777, 0o600);
	const written = JSON.parse(readFileSync(marker, "utf8"));
	assert.equal(written.version, 1);
	assert.equal(written.session_file, session);
	assert.equal(typeof written.pid, "number");
	assert.equal(written.id, accepted.result.id);
	assert.deepEqual(readdirSync(dirname(marker)).filter((name) => name.endsWith(".tmp")), []);
	assert.equal(provider.remaining("s27-restart"), 0);
});

for (const mode of ["plain", "relative", "unwritable", "ephemeral"] as const) {
	test(`S27 restart: ${mode} session refuses without shutting down`, { timeout: 60_000 }, async (t) => {
		const home = createScratchHome();
		const provider = await MockProvider.start();
		const model = provider.addScript(`s27-${mode}`, [{ kind: "text", text: "Session remains available." }]);
		const agent = createAgentDir({ provider });
		const state = join(home.path, LAYOUT.state);
		const marker = join(home.path, "blocked", "marker.json");
		writeFileSync(join(home.path, "blocked"), "not a directory");
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, PI_HOME: home.path,
			CP_OPERATOR_RELAUNCH_FILE: mode === "plain" ? undefined : mode === "relative" ? "relative.json" : marker },
			args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, ...(mode === "ephemeral" ? ["--no-session"] : ["--session", join(home.path, "session.jsonl")]), "--model", model] });
		t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
		rpc.send({ type: "prompt", id: "seed", message: "Make this session idle." });
		await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
		const record = readControlRecord(state);
		assert.equal(record.state, "ok");
		if (record.state !== "ok") throw new Error("bridge offline");
		const reply = await new Promise<Record<string, any>>((resolve, reject) => {
			const socket = connect(record.record.socket);
			let response = "";
			socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, id: 1, token: record.record.token, op: "restart" })}\n`));
			socket.on("data", (chunk) => { response += String(chunk); if (response.includes("\n")) { socket.end(); resolve(JSON.parse(response.trim())); } });
			socket.on("error", reject);
		});
		assert.equal(reply.ok, false);
		assert.match(String(reply.error), mode === "plain" || mode === "relative" ? /unsupported:.*cp-operator/ : mode === "ephemeral" ? /session file .*not on disk/ : /relaunch marker unwritable/);
		rpc.send({ type: "get_state", id: "still-alive" });
		await rpc.waitFor((r) => r.type === "response" && r.id === "still-alive", 10_000);
		assert.equal(existsSync(marker), false);
		assert.equal(provider.remaining(`s27-${mode}`), 0);
	});
}
