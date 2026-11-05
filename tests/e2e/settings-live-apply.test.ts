/**
 * Settings live apply: a `models.parent`/`parent_thinking` write switches the real parent host's pi parent (S1–S7), and a
 * `models.operator`/`operator_thinking` write the real operator session (O1–O9), in place at the next idle point.
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
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startRpc, waitFor } from "../harness/index.ts";
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

// Slice 2, the real operator session (cp-bridge in a pi RPC child on the mock provider): O9 a launch flag that differs
// from the saved value loses at session start; O1-O5, O8 mirror S1-S5 plus no auth; O7 one write switches both and E
// keeps the saved thinking across each model switch; D an unreadable parent.json relays once; O6 a resume keeps the model.
test("O1-O9, E, D: a Settings operator write switches the live operator session in place", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	// pi resets thinking to its default on a model switch: a default unlike the saved level makes E observable.
	const agent = createAgentDir({ provider, settings: { defaultThinkingLevel: "low" } });
	const ready = { kind: "text", text: "Ready." } as const;
	const gates = { b: held(), c: held(), e: held() };
	const op = {
		a: provider.addScript("oa", [ready], { onExhausted: "repeat" }),
		b: provider.addScript("ob", [ready, { kind: "hang", until: gates.b.until }, ready], { onExhausted: "repeat" }),
		c: provider.addScript("oc", [ready, { kind: "hang", until: gates.c.until }, ready], { onExhausted: "repeat" }),
		d: provider.addScript("od", [ready], { onExhausted: "repeat" }),
		e: provider.addScript("oe", [{ kind: "hang", until: gates.e.until }, ready], { onExhausted: "repeat" }),
		f: provider.addScript("of", [ready], { onExhausted: "repeat" }),
		g: provider.addScript("og", [ready], { onExhausted: "repeat" }),
		pa: provider.addScript("pa", [ready], { onExhausted: "repeat" }),
		pb: provider.addScript("pb", [ready], { onExhausted: "repeat" }),
	};
	const config = provider.modelsJson() as { providers: Record<string, { models: Record<string, unknown>[] } & Record<string, unknown>> };
	for (const row of config.providers.mock!.models) Object.assign(row, { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
	const { apiKey: _key, ...keyless } = config.providers.mock!;
	config.providers.noauth = { ...keyless, models: [{ ...config.providers.mock!.models[0], id: "script-x" }] };
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
	const operatorJson = join(home.path, LAYOUT.data, "operator.json");
	put(pushConfigFile(pushDataDir(state)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-01-01T00:00:00Z" }));
	const options: ViewerOptions = { home: home.path, stateDir: state, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	closers.push(() => { server.close(); });

	// O9 (A): launched at xhigh while Settings says high; session_start compares the LIVE level and applies the file.
	put(operatorJson, JSON.stringify({ thinking: "high" }));
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	const sessionFile = join(home.path, "operator.jsonl");
	const launch = (args: string[]) => startRpc({ cwd: home.path, env, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--session", sessionFile, ...args] });
	let rpc = launch(["--model", op.a, "--thinking", "xhigh"]);
	closers.push(async () => { await rpc.close(); });
	const record = await waitFor(() => readControlRecord(state), (row) => row.state === "ok", { timeoutMs: 30_000, what: "operator dashboard control" });
	assert.ok(record.state === "ok");
	const call = async (path: string, body?: unknown, revision?: string) => {
		const headers = { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": record.record.csrf, ...(revision ? { "if-match": `"${revision}"` } : {}) };
		const response = await fetch(`http://127.0.0.1:${options.port}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: response.status, body: await response.json() as Record<string, any> };
	};
	let writes = 0;
	const write = async (changes: Record<string, unknown>) => {
		const revision = (await call("/api/settings")).body.snapshot.revision as string;
		const reply = await call("/api/settings/apply", { changes, request_id: `req-op-${++writes}` }, revision);
		assert.deepEqual([reply.status, reply.body.state], [200, "applied"], JSON.stringify(reply.body));
	};
	const rows = (): ModelApplyLine[] => existsSync(modelApplyFile(home.path)) ? readFileSync(modelApplyFile(home.path), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	const since = (mark: number, session = "operator") => rows().slice(mark).filter((r) => r.session === session).map((r) => [r.state, r.model, r.thinking]);
	const row = (mark: number, wanted: string, what: string, session = "operator") => waitFor(() => rows().slice(mark).filter((r) => r.session === session), (list) => list.some((r) => r.state === wanted), { timeoutMs: 15_000, what }).then((list) => list.find((r) => r.state === wanted)!);
	const served = (name: string) => provider.requests(name).length;
	let prompts = 0;
	const settles = () => rpc.records().filter((r) => r.type === "agent_settled").length;
	const prompt = async (message: string) => {
		const before = settles();
		rpc.send({ type: "prompt", id: `op-${++prompts}`, message });
		await waitFor(settles, (n) => n > before, { timeoutMs: 20_000, what: `operator settled after "${message}"` });
	};
	const hold = (script: string, count: number) => {
		rpc.send({ type: "prompt", id: `op-${++prompts}`, message: "Hold." });
		return waitFor(() => served(script), (n) => n === count, { timeoutMs: 15_000, what: `operator turn held on ${script}` });
	};
	const release = async (gate: { release: () => void }) => {
		const before = settles();
		gate.release();
		await waitFor(settles, (n) => n > before, { timeoutMs: 20_000, what: "the held operator turn settled" });
	};
	const entries = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string; thinkingLevel?: string });
	// The thinking levels pi recorded after the session's last model switch.
	const levelsAfterSwitch = (file: string) => { const list = entries(file); return list.slice(list.map((e) => e.type).lastIndexOf("model_change") + 1).filter((e) => e.type === "thinking_level_change").map((e) => e.thinkingLevel); };
	const noDrain = (label: string) => assert.equal(existsSync(drainFile(home.path)), false, `${label}: no drain was asked for`);

	assert.deepEqual((await row(0, "applied", "O9 applied")).thinking, "high");
	assert.deepEqual(since(0), [["applied", op.a, "high"]]);
	await prompt("Seed.");
	assert.equal(levelsAfterSwitch(sessionFile).at(-1), "high", "O9: the session file records thinking_level_change high");

	// O1 (+ E for the operator): idle, the write applies at once; the switch re-sends the saved high over pi's default low.
	let mark = rows().length;
	await write({ "models.operator": op.b });
	await row(mark, "applied", "O1 applied");
	assert.deepEqual(since(mark), [["applied", op.b, "high"]], "one applied row, no queued one, for an idle operator");
	await prompt("Next.");
	assert.deepEqual([served("oa"), served("ob")], [1, 1], "the next request goes to the new model");
	assert.deepEqual(levelsAfterSwitch(sessionFile), ["low", "high"], "E: pi's reset to low, then the saved high");
	noDrain("O1");

	// O2: a busy turn finishes on the old model; the switch waits as `queued`, then lands before the next turn.
	mark = rows().length;
	await hold("ob", 2);
	await write({ "models.operator": op.c });
	assert.equal((await row(mark, "queued", "O2 queued")).model, op.c);
	await release(gates.b);
	await row(mark, "applied", "O2 applied");
	await prompt("Next.");
	assert.deepEqual([served("ob"), served("oc")], [2, 1], "the held turn ended on b; the next turn runs on c");
	assert.deepEqual(since(mark), [["queued", op.c, "high"], ["applied", op.c, "high"]]);

	// O3: two writes during one turn apply once, with the last value; the middle model is never requested.
	mark = rows().length;
	await hold("oc", 2);
	await write({ "models.operator": op.d });
	await row(mark, "queued", "O3 queued");
	await write({ "models.operator": op.e });
	await release(gates.c);
	await row(mark, "applied", "O3 applied");
	assert.deepEqual(since(mark), [["queued", op.d, "high"], ["applied", op.e, "high"]]);
	assert.equal(served("od"), 0, "the middle value is never requested");

	// O4: a revert before the apply cancels; the running model stays.
	mark = rows().length;
	await hold("oe", 1);
	await write({ "models.operator": op.f });
	await row(mark, "queued", "O4 queued");
	await write({ "models.operator": op.e });
	await row(mark, "cancelled", "O4 cancelled");
	await release(gates.e);
	await prompt("Next.");
	assert.deepEqual(since(mark), [["queued", op.f, "high"], ["cancelled", op.e, "high"]]);
	assert.deepEqual([served("oe"), served("of")], [2, 0]);

	// O5, O8: a model pi does not know, then one with no auth: a `failed` row, the TUI status line, and e keeps running.
	const statuses = () => rpc.records().filter((r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "settings-apply").map((r) => r.statusText);
	for (const [label, ref, why] of [["O5", "mock/nope", "mock/nope is not in pi's model registry"], ["O8", "noauth/script-x", "no auth configured for noauth/script-x"]] as const) {
		mark = rows().length;
		const before = served("oe");
		await write({ "models.operator": ref });
		assert.equal((await row(mark, "failed", `${label} failed`)).reason, `${why}; ${op.e} still runs`);
		await waitFor(statuses, (list) => list.at(-1) === `settings-apply: operator Settings model apply failed: ${why}; ${op.e} still runs`, { what: `${label} status line` });
		await prompt("Next.");
		assert.equal(served("oe"), before + 1, `${label}: the next request still runs on e`);
	}
	noDrain("O8");

	// O7 (+ E for the parent): one write naming both owners switches both; each keeps the saved thinking high.
	await write({ "models.parent": op.pa, "models.parent_thinking": "high" });
	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 30_000 });
	closers.push(() => host.disconnect());
	const relays: BridgeRelay[] = [];
	await host.onRelay((relay) => relays.push(relay));
	await host.request("start", { home: home.path, mode: "multi", model: op.pa, requestTimeoutMs: 15_000 });
	await host.request("send", "Say ready.");
	const status = async () => (await host.request("status")) as { pid?: number; model?: string; sessionFile?: string };
	assert.equal((await status()).model, op.pa);
	mark = rows().length;
	await write({ "models.parent": op.pb, "models.operator": op.g });
	await row(mark, "applied", "O7 operator applied");
	assert.equal((await row(mark, "applied", "O7 parent applied", "parent")).model, op.pb);
	assert.equal((await status()).model, op.pb);
	assert.equal(levelsAfterSwitch((await status()).sessionFile!).at(-1), "high", "E: the parent keeps thinking high after the switch");
	assert.equal(levelsAfterSwitch(sessionFile).at(-1), "high", "E: the operator keeps thinking high after the switch");
	await prompt("Next.");
	assert.ok(served("og") >= 1, "O7: the operator runs on g");
	noDrain("O7");

	// D: an unreadable data/parent.json never rejects the host's apply: one error relay, not one per 5 s tick.
	mark = rows().length;
	const parentJson = join(home.path, LAYOUT.data, "parent.json");
	const saved = readFileSync(parentJson, "utf8");
	put(parentJson, "{");
	const unreadable = () => relays.filter((relay) => relay.kind === "error" && relay.text.includes("data/parent.json unreadable"));
	await waitFor(unreadable, (list) => list.length === 1, { timeoutMs: 15_000, what: "D one unreadable relay" });
	await new Promise((done) => setTimeout(done, 11_000));
	assert.equal(unreadable().length, 1, "D: the same error relays once across ticks");
	assert.deepEqual(since(mark, "parent"), [], "D: no apply row from an unreadable file");
	put(parentJson, saved);

	// O6 (A8): relaunched on the same session with no --model and no saved model, pi resumes the switched model g.
	await rpc.close();
	put(operatorJson, "{}");
	const operatorScripts = ["oa", "ob", "oc", "od", "oe", "of", "og"];
	const before = operatorScripts.map(served);
	rpc = launch([]);
	await prompt("Resumed.");
	const grew = operatorScripts.filter((name, i) => served(name) > before[i]!);
	assert.deepEqual(grew, ["og"], "O6: the resumed session's requests go to g and nowhere else");
});
