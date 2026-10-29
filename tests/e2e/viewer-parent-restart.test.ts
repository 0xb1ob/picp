import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { drainFile, readDrain } from "../../src/drain.ts";
import { attachParentHost } from "../../src/parent-host.ts";
import { controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../../src/viewer/push-files.ts";
import { createViewer, type ViewerOptions } from "../../src/viewer/server.ts";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startRpc, waitFor } from "../harness/index.ts";
import { until } from "../harness/dashboard.ts";
import { stopParentHosts } from "../harness/parent-hosts.ts";

const ORIGIN = "https://cp.example.ts.net";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

// B2-B5 through the real viewer, operator bridge and parent host (mock parent model): undrained is refused 409 with
// the parent untouched; a drained restart resumes, then cleans (archived file); the new parent consumes the drain; a
// failed start leaves the parent down with the gate open, and a retry restarts it.
test("B: dashboard parent restart is drain-gated by the host, reports resumed/clean, and survives a failed start", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const parentModel = provider.addScript("b-parent", [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
	const operatorModel = provider.addScript("b-operator", [{ kind: "text", text: "Noted." }], { onExhausted: "repeat" });
	agent.writeModels(provider);
	const env = { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const closers: Array<() => Promise<void> | void> = [];
	t.after(async () => {
		for (const close of closers.reverse()) await close();
		await stopParentHosts(home.path);
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const state = join(home.path, LAYOUT.state);
	put(pushConfigFile(pushDataDir(state)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-01-01T00:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir: state, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	closers.push(() => { server.close(); });
	const call = async (path: string, token: string | null = null, body?: unknown) => {
		const response = await fetch(`http://127.0.0.1:${options.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}) }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
		return { status: response.status, body: await response.json() as Record<string, any> };
	};
	const journal = (): Array<Record<string, any>> => existsSync(controlJournalFile(state)) ? readFileSync(controlJournalFile(state), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

	for (const body of [{}, { restart: true }, { restart: "resume", fresh: true }, { restart: "again" }, "[]"]) assert.equal((await call("/api/parent/restart", "x".repeat(64), body)).status, 400, JSON.stringify(body));
	const offline = await call("/api/parent/restart", "x".repeat(64), { restart: "resume" });
	assert.equal(offline.status, 409);
	assert.equal(offline.body.state, "offline");

	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 30_000 });
	closers.push(() => host.disconnect());
	await host.request("start", { home: home.path, mode: "multi", model: parentModel, requestTimeoutMs: 15_000 });
	await host.request("send", "Say ready."); // the reply writes the session, so a restart can resume it
	const parentPid = async () => (await host.request("status") as { pid?: number; alive: boolean });
	const first = (await parentPid()).pid;
	assert.ok(first);

	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	const rpc = startRpc({ cwd: home.path, env, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--session", join(home.path, "operator.jsonl"), "--model", operatorModel] });
	closers.push(async () => { await rpc.close(); });
	rpc.send({ type: "prompt", id: "seed", message: "Watch the parent." });
	await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
	const record = await waitFor(() => readControlRecord(state), (row) => row.state === "ok", { timeoutMs: 20_000, what: "dashboard control" });
	assert.ok(record.state === "ok");
	const csrf = record.record.csrf;
	assert.equal((await call("/api/parent/restart", "0".repeat(64), { restart: "resume" })).status, 403);
	const gate = async () => (await call("/api/operator/control")).body.parent_restart as { safe: boolean; reason: string; last: string | null };
	const undrained = await gate();
	assert.equal(undrained.safe, false);
	assert.match(undrained.reason, /^warning: not drained; this kills 0 live worker\(s\) \(cp_parent drain first/);
	assert.equal(undrained.last, null);

	// B4 negative control: posted anyway while undrained, refused with the gate's reason; the parent is untouched.
	const refused = await call("/api/parent/restart", csrf, { restart: "resume" });
	assert.equal(refused.status, 409, JSON.stringify(refused.body));
	assert.deepEqual(refused.body, { state: "refused", error: `not safe to restart: ${undrained.reason}` });
	assert.equal((await parentPid()).pid, first, "a refused restart leaves the parent pid unchanged");

	const restart = async (mode: "resume" | "clean", before: string | null) => {
		const accepted = await call("/api/parent/restart", csrf, { restart: mode });
		assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
		assert.deepEqual([accepted.body.state, accepted.body.mode], ["restarting", mode]);
		let last = before;
		for (const deadline = Date.now() + 90_000; last === before && Date.now() < deadline;) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			last = (await gate()).last;
		}
		assert.ok(last !== null && last !== before, `${mode} restart outcome within 90 s`);
		return { id: accepted.body.id as string, last };
	};
	const drain = async () => assert.match((await host.request("drain", 7) as { text: string }).text, /^DRAIN: drained: safe to restart/);

	await drain();
	assert.equal((await gate()).safe, true);
	const resumed = await restart("resume", null);
	const second = Number(/^restarted resumed pid=(\d+) session=\S+$/.exec(resumed.last)?.[1]);
	assert.ok(second && second !== first, resumed.last);
	assert.equal((await parentPid()).pid, second);
	assert.deepEqual(journal().filter((line) => line.id === resumed.id).map((line) => [line.type, line.kind ?? line.state]), [["request", "parent_restart"], ["outcome", "restarting"], ["outcome", "restarted"]]);
	// Transition (a): the started parent consumes the drain, so the gate closes until the next drain.
	await waitFor(() => existsSync(drainFile(home.path)), (present) => !present, { timeoutMs: 20_000, what: "drain consumed by the new parent" });
	assert.equal((await gate()).safe, false);

	await drain();
	const clean = await restart("clean", resumed.last);
	const archived = /^restarted clean pid=\d+ session=\S+ \(archived (\S+)\)$/.exec(clean.last)?.[1];
	assert.ok(archived && existsSync(archived), clean.last);

	// Failed start: the parent model is gone from the registry; the parent stays down and the drain stays open.
	await drain();
	const models = join(agent.path, "models.json");
	const registry = readFileSync(models, "utf8");
	writeFileSync(models, JSON.stringify({ providers: {} }));
	const failed = await restart("resume", clean.last);
	assert.match(failed.last, /^failed: parent stopped; start failed: .*the parent is down/s);
	assert.equal((await parentPid()).alive, false);
	assert.equal(readDrain(home.path)?.state, "drained");
	assert.equal((await gate()).safe, true);
	writeFileSync(models, registry);
	const retried = await restart("resume", failed.last);
	assert.match(retried.last, /^restarted (resumed|clean) pid=\d+/);
	assert.equal((await parentPid()).alive, true);
});

// The `cp_parent restart` tool resumes the drained parent. The host re-checks its gate inside its queue: a drain gone
// after the bridge's gate read is refused there, pid unchanged. A host request held past CP_PARENT_RESTART_TIMEOUT_MS
// reports `failed: no answer`, frees the latch for the next restart, and the late restart still lands.
test("B: cp_parent restart, the host's queued re-check, and a held host request that does not block later restarts", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const held = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
	const release = { a: held(), b: held() };
	// The second `ready` answers the new parent's RESTART AFTER DRAIN turn; each hang holds one `Hold.` send.
	const ready = { kind: "text", text: "Ready." } as const;
	const parentModel = provider.addScript("b2-parent", [ready, ready, { kind: "hang", until: release.a.promise }, { kind: "hang", until: release.b.promise }, ready], { onExhausted: "repeat" });
	const operatorModel = provider.addScript("b2-operator", [{ kind: "text", text: "Noted." }, { kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "restart" } }] }, { kind: "text", text: "Done." }], { onExhausted: "repeat" });
	agent.writeModels(provider);
	const env = { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const closers: Array<() => Promise<void> | void> = [];
	t.after(async () => {
		release.a.resolve(); release.b.resolve();
		for (const close of closers.reverse()) await close();
		await stopParentHosts(home.path);
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const state = join(home.path, LAYOUT.state);
	put(pushConfigFile(pushDataDir(state)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-01-01T00:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir: state, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	closers.push(() => { server.close(); });
	const call = async (path: string, token: string | null = null, body?: unknown) => {
		const response = await fetch(`http://127.0.0.1:${options.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: response.status, body: await response.json() as Record<string, any> };
	};
	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 30_000 });
	closers.push(() => host.disconnect());
	await host.request("start", { home: home.path, mode: "multi", model: parentModel, requestTimeoutMs: 15_000 });
	await host.request("send", "Say ready.");
	const parent = async () => (await host.request("status") as { pid?: number; alive: boolean });
	const drain = async () => assert.match((await host.request("drain", 7) as { text: string }).text, /^DRAIN: drained: safe to restart/);

	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	const rpc = startRpc({ cwd: home.path, env: { ...env, CP_PARENT_RESTART_TIMEOUT_MS: "8000" }, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--session", join(home.path, "operator.jsonl"), "--model", operatorModel] });
	closers.push(async () => { await rpc.close(); });
	rpc.send({ type: "prompt", id: "seed", message: "Watch the parent." });
	await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
	const record = await waitFor(() => readControlRecord(state), (row) => row.state === "ok", { timeoutMs: 20_000, what: "dashboard control" });
	assert.ok(record.state === "ok");
	const csrf = record.record.csrf;
	const gate = async () => (await call("/api/operator/control")).body.parent_restart as { safe: boolean; reason: string; last: string | null };
	const lastMatching = (pattern: RegExp, what: string) => until(async () => (await gate()).last ?? "", (last) => pattern.test(last), what, 60_000);

	// B5 through the tool: `cp_parent restart` on a drained parent prints `restarted resumed pid=<new>`.
	await drain();
	const first = (await parent()).pid;
	const beforeTool = rpc.records().length;
	rpc.send({ type: "prompt", id: "restart", message: "Restart the parent." });
	const tool = await rpc.waitFor((r) => rpc.records().indexOf(r) >= beforeTool && r.type === "tool_execution_end" && r.toolName === "cp_parent", 60_000);
	const toolPid = Number(/restarted resumed pid=(\d+) session=/.exec(JSON.stringify(tool.result))?.[1]);
	assert.ok(toolPid && toolPid !== first, JSON.stringify(tool.result));
	assert.equal((await parent()).pid, toolPid);
	await rpc.waitFor((r) => rpc.records().indexOf(r) >= beforeTool && r.type === "agent_settled", 20_000);

	// The bridge's gate read passes while a send holds the host queue; the drain is gone before the queued restart runs.
	await waitFor(() => existsSync(drainFile(home.path)), (present) => !present, { timeoutMs: 20_000, what: "drain consumed" });
	await waitFor(() => provider.remaining("b2-parent"), (left) => left === 3, { timeoutMs: 20_000, what: "RESTART AFTER DRAIN turn" });
	await drain();
	const heldA = host.request("send", "Hold.", 120_000);
	await waitFor(() => provider.remaining("b2-parent"), (left) => left === 2, { timeoutMs: 20_000, what: "parent turn held" });
	const queuedA = await call("/api/parent/restart", csrf, { restart: "resume" });
	assert.equal(queuedA.status, 202, JSON.stringify(queuedA.body));
	rmSync(drainFile(home.path), { force: true });
	release.a.resolve();
	await heldA;
	await lastMatching(/^refused: not safe to restart: warning: not drained/, "host re-check refusal");
	assert.equal((await parent()).pid, toolPid, "the host's refusal leaves the parent pid unchanged");

	// A held host request: `failed: no answer` after 8 s frees the latch; a second restart is accepted; the first lands.
	await drain();
	const heldB = host.request("send", "Hold.", 120_000);
	await waitFor(() => provider.remaining("b2-parent"), (left) => left === 1, { timeoutMs: 20_000, what: "parent turn held" });
	assert.equal((await call("/api/parent/restart", csrf, { restart: "resume" })).status, 202);
	await lastMatching(/^failed: no answer from the parent host within 8 s/, "bounded host request");
	assert.equal((await gate()).safe, true, "the latch is free again");
	const later = await call("/api/parent/restart", csrf, { restart: "resume" });
	assert.equal(later.status, 202, JSON.stringify(later.body));
	release.b.resolve();
	await heldB;
	await until(parent, (status) => status.alive && status.pid !== toolPid, "the late restart lands", 60_000);
});
