/**
 * Full match S10a: thread origins on cp_parent send and ask through the real boundary: the operator's own pi (mock
 * provider) with the real cp-bridge, its dashboard-control owner and parent host, and the fake parent. The owner
 * resolves `source_send_id` only from its own delivery record; an origin rides the outbox entry, an ask its `source`.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { LAYOUT } from "../../src/contracts.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { attachParentHost, currentHost, parentHostPaths } from "../../src/parent-host.ts";
import { ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { controlRequest } from "../../src/viewer/control-api.ts";
import { readControlRecord } from "../../src/viewer/control-files.ts";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { teardownHome } from "../harness/parent-hosts.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, type ScriptStep, startPiChild, waitFor } from "../harness/index.ts";

type Json = Record<string, any>;
const FAKE_PARENT = resolve(import.meta.dirname, "..", "fixtures", "fake-parent.mjs");
const ID = (n: number) => `dc-20261104140000-${n.toString(16).padStart(8, "0")}`;
const FORGED = ID(0x77);
const ask = (question: string) => ({ project: "picp", question, options: [{ label: "Yes", consequence: "Goes ahead" }], recommendation: "Yes" });
const send = (id: string, text: string, source?: string) => ({ id, name: "cp_parent", args: { action: "send", text, ...(source ? { source_send_id: source } : {}) } });
const asking = (id: string, question: string, source: string) => ({ id, name: "cp_parent", args: { action: "ask", ask: ask(question), source_send_id: source } });

/** The operator's pi with the real cp-bridge on a scratch home; resolves once its dashboard control listens. */
async function operator(t: TestContext, steps: (home: string) => ScriptStep[], env: Record<string, string> = {}, seed?: (stateDir: string) => void) {
	const home = createScratchHome();
	const stateDir = join(home.path, LAYOUT.state);
	seed?.(stateDir);
	const provider = await MockProvider.start();
	const model = provider.addScript("s10a-origins", steps(home.path), { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = agent.path;
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous;
	const child = startPiChild({ cwd: home.path, model, sessionDir: join(stateDir, "sessions", "operator"), extensions: [CP_BRIDGE_EXTENSION], env: { ...agent.env, PI_HOME: agent.path, CP_HOME: home.path, CP_MODE: "multi", CP_PARENT_PI_BIN: FAKE_PARENT, ...env } });
	const closers: Array<() => unknown> = [];
	t.after(() => teardownHome(home, ...closers.reverse(), () => child.close(), () => agent.cleanup(), () => provider.stop()));
	const found = await waitFor(() => readControlRecord(stateDir), (row) => row.state === "ok", { timeoutMs: 30_000, what: "dashboard control record" });
	if (found.state !== "ok") throw new Error("no dashboard control");
	const record = found.record;
	const settled = (n: number) => child.waitFor(() => child.eventsOfType("agent_settled").length >= n, 60_000);
	/** One dashboard send the owner delivers (a real control-socket request), then its turn settles. */
	const dashboard = async (n: number, text: string, thread?: string) => {
		const before = child.eventsOfType("agent_settled").length;
		const reply = await controlRequest(record, "send", { kind: "message", text, client_id: ID(n), ...(thread ? { thread_id: thread } : {}) });
		assert.equal(reply.ok, true, JSON.stringify(reply));
		await settled(before + 1);
	};
	const thread = async (n: number, name: string) => String(((await controlRequest(record, "thread_create", { client_id: ID(n), name })).result as Json).thread_id);
	const outbox = () => new ParentSendOutbox({ file: parentSendFile(join(home.path, LAYOUT.sessions, "cp-parent.jsonl")) }).list();
	const result = (id: string) => JSON.stringify(child.eventsOfType("tool_execution_end").find((row) => row.toolCallId === id) ?? null);
	return { home, stateDir, child, settled, dashboard, thread, outbox, result, closers };
}

// The plan's acceptance: sends in threads A, B and No thread, relayed and asked about in interleaved order, each keep
// their own dc id's thread (never the latest delivered or bound one); a retried and a replayed send keep the origin; a
// duplicate text from another thread never rebinds the first; forged ids write nothing; an old ask line reads untagged.
test("thread-origins: interleaved sends and asks keep their own source; retry, replay and duplicates keep the origin", { timeout: 240_000 }, async (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const ids = join(scratch.path, "ids");
	const old = { type: "open", id: "ask-0123456789ab", project: "picp", question: "Old?", options: [{ label: "Yes", consequence: "Goes" }], recommendation: "Yes", created_at: "2026-11-01T00:00:00Z" };
	const o = await operator(t, (home) => [
		{ kind: "tool_calls", calls: [{ id: "start", name: "cp_parent", args: { action: "start", home } }] },
		{ kind: "text", text: "started" },
		{ kind: "text", text: "noted alpha" },
		{ kind: "text", text: "noted beta" },
		{ kind: "tool_calls", calls: [
			send("s-b", "relay beta", ID(11)), asking("a-a", "Ship alpha?", ID(10)), send("s-a", "relay alpha", ID(10)), asking("a-b", "Ship beta?", ID(11)),
			send("s-none", "relay plain", ID(12)), send("s-dup", "relay alpha", ID(11)), send("s-forged", "relay forged", FORGED),
			asking("a-forged", "Forged?", FORGED), asking("a-bad", "Malformed?", "dc-bad"), send("s-retry", "TRANSIENT retry", ID(10)),
		] },
		{ kind: "text", text: "relayed" },
		{ kind: "tool_calls", calls: [send("s-replay", "NOLAND replay", ID(11))] },
		{ kind: "text", text: "replayed" },
	], { FAKE_PARENT_SEND_IDS: ids, FAKE_PARENT_NOLAND_ONCE: join(scratch.path, "noland") }, (stateDir) => {
		mkdirSync(join(stateDir, "operator"), { recursive: true });
		writeFileSync(join(stateDir, "operator", "asks.jsonl"), `${JSON.stringify(old)}\n`);
	});
	await o.child.prompt(`Start the parent under ${o.home.path}.`);
	await o.settled(1);
	assert.match(o.result("start"), /started (clean|resumed) pid=/);
	const [A, B] = [await o.thread(1, "Alpha"), await o.thread(2, "Beta")];
	await o.dashboard(10, "alpha", A);
	await o.dashboard(11, "beta", B);
	let at = performance.now();
	await o.dashboard(12, "plain");
	t.diagnostic(`interleaved turn (10 calls) ${(performance.now() - at).toFixed(1)} ms`);

	let asks: Array<[string, unknown]> | string;
	try { asks = new OperatorAsks(join(o.stateDir, "operator", "asks.jsonl")).list().map((row) => [row.question, row.source ?? "untagged"]); }
	catch (error) { asks = (error as Error).message; }
	assert.deepEqual(Array.isArray(asks) && asks[0], ["Old?", "untagged"], `the old journal line reads untagged: ${String(asks)}`);
	const entries = o.outbox();
	const origin = (text: string) => entries.filter((entry) => entry.text === text).map((entry) => entry.origin ?? "untagged");
	assert.deepEqual({ beta: origin("relay beta"), plain: origin("relay plain"), asks: Array.isArray(asks) && asks.filter(([q]) => q.startsWith("Ship")) }, {
		beta: [{ source_send_id: ID(11), thread_id: B }], plain: [{ source_send_id: ID(12), thread_id: null }],
		asks: [["Ship alpha?", { send_id: ID(10), thread_id: A }], ["Ship beta?", { send_id: ID(11), thread_id: B }]],
	}, "interleaved: each relay and ask keeps its own dc id's thread (No thread is null), never the latest delivered or bound");
	assert.deepEqual(origin("relay alpha"), [{ source_send_id: ID(10), thread_id: A }, { source_send_id: ID(11), thread_id: B }], "a duplicate text from B never rebinds A's send");
	for (const id of ["s-forged", "a-forged"]) assert.match(o.result(id), new RegExp(`source_send_id ${FORGED} is not a dashboard message this operator session delivered; nothing was sent or recorded`), `${id}: a forged dc id is refused`);
	assert.match(o.result("a-bad"), /source_send_id must be a dashboard send id/);
	assert.deepEqual(Array.isArray(asks) && asks.filter(([q]) => q === "Forged?" || q === "Malformed?"), [], "a refused ask writes no question");
	assert.equal(JSON.stringify(entries).includes("relay forged"), false, "a forged id enqueues nothing");
	const known = new Set(entries.map((entry) => entry.id));
	assert.equal(readFileSync(ids, "utf8").split("\n").filter(Boolean).every((id) => known.has(id)), true, "only enqueued sends reached the parent");

	at = performance.now();
	const retried = await waitFor(() => o.outbox().find((entry) => entry.text === "TRANSIENT retry"), (entry) => entry?.state === "settled", { timeoutMs: 60_000, what: "the retried send settles" });
	t.diagnostic(`transient send → settled after the outer retry ${(performance.now() - at).toFixed(1)} ms`);
	assert.deepEqual([retried?.outer_retry_attempts, retried?.origin], [1, { source_send_id: ID(10), thread_id: A }], "the outer retry keeps the origin");

	const host = await attachParentHost({ home: o.home.path, mode: "multi", timeoutMs: 30_000 });
	o.closers.push(() => host.disconnect());
	const pid = (await host.request("status") as { pid: number }).pid;
	await o.child.prompt("Relay the replay.");
	const lost = await waitFor(() => o.outbox().find((entry) => entry.text === "NOLAND replay"), (entry) => entry?.state === "injected", { timeoutMs: 30_000, what: "the send the parent never lands" });
	at = performance.now();
	process.kill(pid, "SIGKILL");
	const replayed = await waitFor(() => o.outbox().find((entry) => entry.id === lost!.id), (entry) => entry?.state === "settled", { timeoutMs: 60_000, what: "the replayed send settles" });
	t.diagnostic(`parent SIGKILL → replayed send settled ${(performance.now() - at).toFixed(1)} ms`);
	assert.deepEqual(replayed?.origin, { source_send_id: ID(11), thread_id: B }, "the replay after a parent restart keeps the origin");
	assert.equal(readFileSync(ids, "utf8").split("\n").filter((id) => id === lost!.id).length, 2, "one dead injection, one replay, same id");
	await o.settled(6);
});

// Capability: a parent host from before S10a answers `sendFrom` as an unknown op (stood in by a relay on its socket);
// source_send_id is refused with the plain reload reason and nothing is enqueued, while a send without it still works.
test("thread-origins: an old parent host refuses source_send_id with the reload reason; a send without it works", { timeout: 120_000 }, async (t) => {
	const o = await operator(t, (home) => [
		{ kind: "tool_calls", calls: [{ id: "start", name: "cp_parent", args: { action: "start", home } }] },
		{ kind: "text", text: "started" },
		{ kind: "tool_calls", calls: [send("s-origin", "relay old", ID(20)), send("s-plain", "plain old")] },
		{ kind: "text", text: "relayed" },
	]);
	// The host runs before the operator attaches, so the bridge's own client connects through the stand-in relay.
	const host = await attachParentHost({ home: o.home.path, mode: "multi", timeoutMs: 30_000 });
	o.closers.push(() => host.disconnect());
	await host.request("start", { home: o.home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	const socket = currentHost(parentHostPaths(o.home.path, "multi")).record!.socket, moved = `${socket}.real`;
	renameSync(socket, moved);
	const refused: string[] = [];
	const relay = createServer((client) => {
		const upstream = createConnection(moved);
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
		upstream.pipe(client);
		let buffer = "";
		client.on("data", (chunk) => {
			buffer += String(chunk);
			for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
				const line = buffer.slice(0, end + 1), frame = JSON.parse(line) as { id: number; op: string };
				buffer = buffer.slice(end + 1);
				if (frame.op === "sendFrom") { refused.push(frame.op); client.write(`${JSON.stringify({ v: 1, id: frame.id, ok: false, error: "unknown parent host op sendFrom" })}\n`); }
				else upstream.write(line);
			}
		});
	});
	await new Promise<void>((done) => relay.listen(socket, done));
	o.closers.push(() => relay.close());
	await o.child.prompt(`Start the parent under ${o.home.path}.`);
	await o.settled(1);
	assert.match(o.result("start"), /already running pid=/);
	await o.dashboard(20, "relay this");
	assert.match(o.result("s-origin"), /source_send_id is unsupported: this parent host predates thread origins; reload the operator session/);
	assert.match(o.result("s-plain"), /receipt: owner_observed/);
	assert.deepEqual(refused, ["sendFrom"], "the origin reached only the stand-in's refusal");
	assert.deepEqual(o.outbox().map((entry) => [entry.text, entry.origin ?? "untagged"]), [["plain old", "untagged"]], "nothing enqueued for the refused send");
});
