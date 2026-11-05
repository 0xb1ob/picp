/**
 * Settings live apply, slice 1: a `models.parent`/`parent_thinking` write through `POST /api/settings/apply` switches the
 * real parent host's pi parent (mock provider) in place at its next idle point. One host, scenarios S1–S7 in order.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import type { BridgeRelay } from "../../src/cp-bridge.ts";
import { drainFile } from "../../src/drain.ts";
import { attachParentHost } from "../../src/parent-host.ts";
import { type ModelApplyLine, modelApplyFile } from "../../src/session-model-apply.ts";
import { settingsPorts } from "../../src/settings-control.ts";
import { readControlRecord } from "../../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../../src/viewer/push-files.ts";
import { createViewer, type ViewerOptions } from "../../src/viewer/server.ts";
import { createAgentDir, createScratchHome, MockProvider, waitFor } from "../harness/index.ts";
import { operatorSession } from "../harness/dashboard.ts";
import { stopParentHosts } from "../harness/parent-hosts.ts";

const ORIGIN = "https://cp.example.ts.net";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const held = () => { let release!: () => void; const until = new Promise<void>((done) => { release = done; }); return { until, release }; };

// S7 first (an explicit start model, then a Settings write wins), then S1 idle, S2 busy, S3 coalescing, S4 revert,
// S5 a model pi rejects, S6 thinking. Each step asserts the journal row, which script served the next request, and
// that the parent and host pids never change and no drain was asked for: an in-place switch, never a restart.
test("S1-S7: a Settings parent model/thinking write switches the live parent at its next idle point", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const ready = { kind: "text", text: "Ready." } as const;
	const gates = { b: held(), c: held(), e: held() };
	const model = {
		a: provider.addScript("a", [ready], { onExhausted: "repeat" }),
		b: provider.addScript("b", [ready, { kind: "hang", until: gates.b.until }, ready], { onExhausted: "repeat" }),
		c: provider.addScript("c", [ready, { kind: "hang", until: gates.c.until }, ready], { onExhausted: "repeat" }),
		d: provider.addScript("d", [ready], { onExhausted: "repeat" }),
		e: provider.addScript("e", [{ kind: "hang", until: gates.e.until }, ready], { onExhausted: "repeat" }),
		f: provider.addScript("f", [ready], { onExhausted: "repeat" }),
		z: provider.addScript("z", [ready], { onExhausted: "repeat" }),
	};
	const config = provider.modelsJson();
	for (const entry of Object.values(config.providers)) for (const row of (entry as { models: Record<string, unknown>[] }).models) row.reasoning = true;
	writeFileSync(join(agent.path, "models.json"), JSON.stringify(config));
	const env = { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const closers: Array<() => Promise<void> | void> = [];
	t.after(async () => {
		for (const gate of Object.values(gates)) gate.release();
		for (const close of closers.reverse()) await close();
		await stopParentHosts(home.path);
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const state = join(home.path, LAYOUT.state);
	for (const dir of [state, join(home.path, LAYOUT.data)]) mkdirSync(dir, { recursive: true });
	put(pushConfigFile(pushDataDir(state)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-01-01T00:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir: state, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	closers.push(() => { server.close(); });
	await operatorSession(t, state, () => true, settingsPorts({ target: () => ({ home: home.path, mode: "multi" }), env: {} }));
	const record = readControlRecord(state);
	assert.ok(record.state === "ok");
	const csrf = record.record.csrf;
	const call = async (path: string, body?: unknown, revision?: string) => {
		const headers = { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": csrf, ...(revision ? { "if-match": `"${revision}"` } : {}) };
		const response = await fetch(`http://127.0.0.1:${options.port}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: response.status, body: await response.json() as Record<string, any> };
	};
	let writes = 0;
	const write = async (changes: Record<string, unknown>) => {
		const revision = (await call("/api/settings")).body.snapshot.revision as string;
		const reply = await call("/api/settings/apply", { changes, request_id: `req-live-${++writes}` }, revision);
		assert.deepEqual([reply.status, reply.body.state], [200, "applied"], JSON.stringify(reply.body));
	};
	const rows = (): ModelApplyLine[] => existsSync(modelApplyFile(home.path)) ? readFileSync(modelApplyFile(home.path), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	const since = (mark: number) => rows().slice(mark).map((row) => [row.state, row.model, row.thinking]);
	const row = (mark: number, wanted: string, what: string) => waitFor(() => rows().slice(mark), (list) => list.some((r) => r.state === wanted), { timeoutMs: 12_000, what }).then((list) => list.find((r) => r.state === wanted)!);
	const served = (name: keyof typeof model) => provider.requests(name).length;

	await write({ "models.parent": model.z });
	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 30_000 });
	closers.push(() => host.disconnect());
	const relays: BridgeRelay[] = [];
	await host.onRelay((relay) => relays.push(relay));
	await host.request("start", { home: home.path, mode: "multi", model: model.a, modelExplicit: true, requestTimeoutMs: 15_000 });
	await host.request("send", "Say ready.");
	const status = async () => (await host.request("status")) as { pid?: number; model?: string; sessionFile?: string };
	const pids = { host: host.hostPid, parent: (await status()).pid };
	const unchanged = async (label: string) => {
		assert.deepEqual({ host: host.hostPid, parent: (await status()).pid }, pids, `${label}: parent and host pids unchanged`);
		assert.equal(existsSync(drainFile(home.path)), false, `${label}: no drain was asked for`);
	};
	// S7 (A9): the explicit start model runs over the saved one, and the file seen at start applies nothing on its own.
	assert.equal((await status()).model, model.a);
	await new Promise((done) => setTimeout(done, 6_000));
	assert.deepEqual(rows(), [], "the file the parent started with is not a change");

	// S1 (A1, A2, A7, A9): idle parent, the next host tick switches it; the next send is served by the new model.
	let mark = rows().length;
	await write({ "models.parent": model.b });
	assert.equal((await row(mark, "applied", "S1 applied")).model, model.b);
	assert.deepEqual(since(mark), [["applied", model.b, null]], "one applied row, no queued one, for an idle parent");
	await host.request("send", "Next.");
	assert.deepEqual([served("a"), served("b"), (await status()).model], [1, 1, model.b], "the next request goes to the new model");
	await unchanged("S1");

	// S2 (A3): a busy turn finishes on the old model; the switch waits as `queued`, then lands before the next turn.
	mark = rows().length;
	const hold = (await host.request("send", "Hold.", 500)) as { send_id: string };
	await waitFor(() => served("b"), (n) => n === 2, { timeoutMs: 15_000, what: "S2 turn held on b" });
	await write({ "models.parent": model.c });
	assert.equal((await row(mark, "queued", "S2 queued")).model, model.c);
	const queued = (await call("/api/settings")).body.model_apply as ModelApplyLine[];
	assert.deepEqual([queued.at(-1)?.session, queued.at(-1)?.state, queued.at(-1)?.model], ["parent", "queued", model.c], "GET /api/settings serves the queued row");
	gates.b.release();
	// The held send's outcome relays at its turn end; a send then runs on c only via the settle path, not the tick.
	await waitFor(() => relays.some((relay) => relay.kind === "send" && relay.sendId === hold.send_id), (seen) => seen, { timeoutMs: 15_000, what: "S2 held send outcome" });
	await host.request("send", "Next.");
	assert.deepEqual([served("b"), served("c")], [2, 1], "the held turn ended on b; the next turn runs on c");
	assert.deepEqual(since(mark), [["queued", model.c, null], ["applied", model.c, null]]);
	await unchanged("S2");

	// S3 (A4): two writes during one turn apply once, with the last value; the middle model is never requested.
	mark = rows().length;
	await host.request("send", "Hold.", 500);
	await waitFor(() => served("c"), (n) => n === 2, { timeoutMs: 15_000, what: "S3 turn held on c" });
	await write({ "models.parent": model.d });
	await row(mark, "queued", "S3 queued");
	await write({ "models.parent": model.e });
	gates.c.release();
	await row(mark, "applied", "S3 applied");
	assert.deepEqual(since(mark), [["queued", model.d, null], ["applied", model.e, null]]);
	assert.equal(served("d"), 0, "the middle value is never requested");
	await unchanged("S3");

	// S4 (A5): a revert before the apply cancels; the running model stays.
	mark = rows().length;
	await host.request("send", "Hold.", 500);
	await waitFor(() => served("e"), (n) => n === 1, { timeoutMs: 15_000, what: "S4 turn held on e" });
	await write({ "models.parent": model.f });
	await row(mark, "queued", "S4 queued");
	await write({ "models.parent": model.e });
	await row(mark, "cancelled", "S4 cancelled");
	gates.e.release();
	await host.request("send", "Next.");
	assert.deepEqual(since(mark), [["queued", model.f, null], ["cancelled", model.e, null]]);
	assert.equal(rows().at(-1)?.reason, "changed back before it applied");
	assert.deepEqual([served("e"), served("f"), (await status()).model], [2, 0, model.e]);
	await unchanged("S4");

	// S5 (A6): a model pi rejects leaves the old one running, a `failed` row naming why, and one operator error relay.
	mark = rows().length;
	await write({ "models.parent": "mock/nope" });
	const failed = await row(mark, "failed", "S5 failed");
	assert.match(String(failed.reason), /^set_model mock\/nope rejected: .+; mock\/script-e still runs$/);
	await waitFor(() => relays.filter((relay) => relay.kind === "error" && relay.text.includes("parent Settings model apply failed")), (list) => list.length === 1, { what: "S5 error relay" });
	await host.request("send", "Next.");
	assert.deepEqual([served("e"), (await status()).model], [3, model.e], "the next send still runs on e");
	await unchanged("S5");

	// S6: a thinking change alone sends `set_thinking_level`, which pi records in the session file.
	mark = rows().length;
	await write({ "models.parent_thinking": "high" });
	await row(mark, "applied", "S6 applied");
	assert.deepEqual(since(mark), [["applied", model.e, "high"]]);
	const sessionFile = (await status()).sessionFile!;
	const levels = () => readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string; thinkingLevel?: string }).filter((entry) => entry.type === "thinking_level_change").map((entry) => entry.thinkingLevel);
	await waitFor(levels, (list) => list.at(-1) === "high", { what: "S6 thinking_level_change high" });
	await unchanged("S6");
});
