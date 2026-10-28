import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CpBridge } from "../../src/cp-bridge.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { FleetStore } from "../../src/fleet.ts";
import { MandateStore } from "../../src/mandate.ts";
import { ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startRpc, type ScriptStep, waitFor } from "../harness/index.ts";

async function fixture(t: TestContext, steps: ScriptStep[], raw?: string, timeout?: number) {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	if (raw !== undefined) writeFileSync(join(home.path, LAYOUT.data, "parent.json"), raw);
	const provider = await MockProvider.start();
	const model = provider.addScript("s25-parent", steps, { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const previous = { ...process.env };
	Object.assign(process.env, agent.env);
	const bridge = new CpBridge();
	t.after(async () => {
		await bridge.stop();
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	return { home: home.path, bridge, provider,
		start: (extension = COMMAND_POST_EXTENSION) => bridge.start({ home: home.path, mode: "multi", model, cwd: home.path, commandPostExtension: extension, requestTimeoutMs: timeout }),
		input: () => JSON.stringify(provider.requests("s25-parent").at(-1)?.body),
	};
}

for (const [index, raw, expected] of [[0, undefined, 150000], [1, '{"compact_at_tokens":175000}', 175000], [2, '{}', undefined]] as const) {
	test("S25 parent: settings reach bridge status", { timeout: 60_000 }, async (t) => {
		t.diagnostic(`settings ${index}`);
		const f = await fixture(t, [{ kind: "text", text: "Ready." }], raw);
		await f.start();
		assert.equal(f.bridge.status().compactAtTokens, expected);
	});
}

test("S25 parent: compaction carries disk decisions alongside caller instructions", { timeout: 90_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Initial work finished." }, { kind: "text", text: "Summary." }, { kind: "text", text: "Continued." }], '{}');
	await f.start();
	await f.bridge.send("Begin work.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => ["settled", "failed", "undeliverable"].includes(send.state)), { timeoutMs: 10_000, what: "parent send settled" });
	await f.bridge.statusWithContext();
	const mandate = new MandateStore(f.home).issue({ projects: ["demo"], objective: "ship", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 100000 }, job_cap: 5 });
	const escalation = await new EscalationStore({ home: f.home }).raise({ job_ids: ["cp-held-s25"], kind: "product_ambiguity", question: "Which option?", options: [{ id: "keep", label: "Keep", consequence: "Proceed", cost: "none" }, { id: "stop", label: "Stop", consequence: "Stop", cost: "none" }], recommended: "keep", evidence_paths: [] });
	await new FleetStore({ home: f.home }).add({ job_id: "cp-held-s25", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: isoTimestamp(), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, branch: "cp-held-s25", worktree: f.home, worker: { pid: 1, session_id: "fixture", session_file: join(f.home, "worker.jsonl"), profile: "implementer", role: "implementer", model: "mock/worker", started_at: isoTimestamp() } });
	await f.bridge.compact("S25 preserve review rationale.");
	const input = f.input();
	for (const id of [mandate.id, escalation.id, "cp-held-s25"]) assert.ok(input.includes(id), id);
	assert.match(input, /S25 preserve review rationale/);
});

test("S25 parent: manual compact excludes drain until completion and cancel remains available", { timeout: 90_000 }, async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const f = await fixture(t, [{ kind: "text", text: "Initial." }, { kind: "hang", until: gate }], '{}');
	await f.start(); await f.bridge.send("Begin.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => ["settled", "failed", "undeliverable"].includes(send.state)), { timeoutMs: 10_000, what: "parent send settled" });
	await f.bridge.statusWithContext();
	const compact = f.bridge.compact();
	t.after(() => release());
	await waitFor(() => f.provider.requests("s25-parent").length, (count) => count === 2, { timeoutMs: 10_000, what: "summarizer entered" });
	for (const seconds of [undefined, 30]) await assert.rejects(f.bridge.drain(seconds), /no drain starts until it settles/);
	// With no drain record, a cancel reaching /cp-drain says so; a refused drain that reached the RPC would have left one.
	const cancelled = await f.bridge.drainCancel();
	assert.match(cancelled.text, /^DRAIN: .*no drain to cancel/);
	release();
	await compact;
});


test("S25 parent: start, compact and resume deliver current hidden guidance once", { timeout: 90_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Initial work." }, { kind: "text", text: "Summary." }, { kind: "text", text: "Continued." }], '{}');
	const orders = join(f.home, LAYOUT.data, "standing-orders.md");
	const memory = join(f.home, LAYOUT.learningsFile);
	writeFileSync(orders, "# Standing orders\n\nS25 original order.\n");
	writeFileSync(memory, "# Learnings\n\n- S25 original memory. <!--P-->\n");
	await f.start();
	assert.equal(f.provider.requests("s25-parent").length, 0, "guidance starts no model turn");
	await f.bridge.send("Begin.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "initial send settled" });
	await f.bridge.statusWithContext();
	assert.match(f.input(), /S25 original order/);
	assert.match(f.input(), /S25 original memory/);
	writeFileSync(orders, "# Standing orders\n\nS25 refreshed order.\n");
	writeFileSync(memory, "# Learnings\n\n- S25 refreshed memory. <!--P-->\n");
	await f.bridge.compact();
	await f.bridge.send("Continue.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "continued send settled" });
	for (const text of ["S25 refreshed order.", "S25 refreshed memory.", "Parent only: Put independent tool calls"]) assert.equal(f.input().split(text).length - 1, 1, text);
	assert.match(f.input(), /15 model rounds/);
	await f.bridge.stop();
	await f.start();
	await f.bridge.send("Resume.");
	for (const text of ["S25 refreshed order.", "S25 refreshed memory.", "Parent only: Put independent tool calls"]) assert.equal(f.input().split(text).length - 1, 1, `resume ${text}`);
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "resumed send settled" });
	await f.bridge.stop();
	writeFileSync(memory, "# Learnings\n\n- S25 newer memory. <!--P-->\n");
	await f.start(); await f.bridge.send("Use changed memory.");
	assert.equal(f.input().split("S25 newer memory.").length - 1, 1);
	assert.equal(f.input().split("S25 refreshed order.").length - 1, 2, "changed memory reinjects the pair");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "changed memory settled" });
	await f.bridge.stop();
	writeFileSync(memory, "# Learnings\n\n");
	await f.start(); await f.bridge.send("Memory is now empty.");
	assert.equal(f.input().split("S25 refreshed order.").length - 1, 3, "disappeared memory changes the digest set");
});


for (const [tag, summary, outcome] of [
	["success", { kind: "text", text: "Automatic summary." }, "compacted"],
	["failure", { kind: "error", status: 400, message: "S25 summarizer rejected" }, "failed"],
	["timeout", { kind: "hang", ms: 7000 }, "timed_out"],
] as const) {
	test("S25 parent: automatic compaction outcomes reach the daemon log and error relay", { timeout: 60_000 }, async (t) => {
		t.diagnostic(tag);
		const f = await fixture(t, [{ kind: "text", text: "S25 finished work.", usage: { prompt_tokens: 205000 } }, summary], '{"compact_at_tokens":200000}', tag === "timeout" ? 5000 : 30000);
		const relays: string[] = [];
		f.bridge.onRelay((relay) => relays.push(relay.text));
		await f.start();
		await f.bridge.send("Begin automatic control.");
		const log = join(f.home, LAYOUT.state, "daemon.log");
		await waitFor(() => { try { return readFileSync(log, "utf8"); } catch { return ""; } }, (text) => text.includes(`parent context ${outcome}`), { timeoutMs: 15_000, what: `automatic ${outcome}` });
		assert.match(readFileSync(log, "utf8"), /raw=2050\d+ effective=2050\d+ threshold=200000/);
		if (tag === "success") {
			const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("parent context compacted"));
			assert.equal(lines.length, 1);
			assert.match(lines[0]!, /^\S+ cp-parent-host\[\d+\]: parent context compacted before=\d+ after=\d+ ms=\d+ raw=\d+ effective=\d+ threshold=200000$/);
		}
		if (tag === "timeout") assert.ok(relays.some((text) => /timed out:.*retry the compaction once the parent has settled.*rotation or restart can abort running workers/.test(text)));
		if (tag === "failure") {
			assert.ok(relays.some((text) => /parent automatic context control failed:/.test(text)));
			assert.ok(!relays.some((text) => /retry the compaction/.test(text)), "a failure relay carries no retry advice");
		}
		if (tag === "timeout") assert.match(readFileSync(log, "utf8"), /timed_out .*error="timeout after 5000ms/);
		if (tag === "failure") assert.ok(relays.some((text) => text.includes("S25 summarizer rejected")));
	});
}

test("S25 parent: revoking the newest mandate rotates once with its true trigger", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Work finished.", usage: { prompt_tokens: 1000 } }], '{}');
	await f.start();
	const store = new MandateStore(f.home);
	const grant = store.issue({ projects: ["demo"], objective: "ship", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 1, tokens: 1000 }, job_cap: 1 });
	store.revoke(grant.id, { by: "parent" });
	await f.bridge.send("Finish the mission.");
	const log = join(f.home, LAYOUT.state, "daemon.log");
	await waitFor(() => { try { return readFileSync(log, "utf8"); } catch { return ""; } }, (text) => text.includes(`rotated mission=${grant.id}`), { timeoutMs: 15_000, what: "mission rotation" });
	assert.match(readFileSync(log, "utf8"), /trigger="revoked by parent"/);
	await f.bridge.send("Continue after rotation.");
	assert.equal(readFileSync(log, "utf8").split(`rotated mission=${grant.id}`).length - 1, 1);
});


test("S25 parent: cancelled mission rotation falls through to threshold compaction", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Finished.", usage: { prompt_tokens: 205000 } }, { kind: "text", text: "Fallback summary." }], '{"compact_at_tokens":200000}');
	const extension = join(f.home, "cancel-rotation.ts");
	writeFileSync(extension, `import commandPost from ${JSON.stringify(COMMAND_POST_EXTENSION)};\nexport default function(pi) { commandPost(pi); pi.on("session_before_switch", () => ({ cancel: true })); }\n`);
	await f.start(extension);
	const store = new MandateStore(f.home);
	const grant = store.issue({ projects: ["demo"], objective: "ship", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 1, tokens: 1000 }, job_cap: 1 });
	store.revoke(grant.id, { by: "parent" });
	await f.bridge.send("Finish.");
	const log = join(f.home, LAYOUT.state, "daemon.log");
	await waitFor(() => { try { return readFileSync(log, "utf8"); } catch { return ""; } }, (text) => text.includes("parent context compacted"), { timeoutMs: 15_000, what: "fallback compaction" });
	assert.match(readFileSync(log, "utf8"), /rotate_failed.*new_session rejected: cancelled/);
	assert.ok(f.provider.requests("s25-parent").length >= 2, "fallback reaches summarizer");
});


test("S25 parent: startup guidance is hidden and present before any model request", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Unused." }]);
	writeFileSync(join(f.home, LAYOUT.data, "standing-orders.md"), "# Standing orders\n\nS25 wake order.\n");
	writeFileSync(join(f.home, LAYOUT.learningsFile), "# Learnings\n\n- S25 wake memory. <!--P-->\n");
	const rpc = startRpc({ cwd: f.home, env: { CP_HOME: f.home, CP_MODE: "multi", CP_HEADLESS: "1" }, args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session", "--model", "mock/s25-parent"] });
	t.after(() => rpc.close());
	rpc.send({ type: "get_messages", id: "messages" });
	const response = await rpc.waitFor((record) => record.type === "response" && record.id === "messages", 30_000);
	const messages = (response.data as { messages: Array<{ customType?: string; content?: string; display?: boolean }> }).messages;
	for (const type of ["cp-memory", "cp-standing-orders", "cp-parent-guidance"]) {
		const selected = messages.filter((message) => message.customType === type);
		assert.equal(selected.length, 1, type);
		assert.equal(selected[0]!.display, false);
	}
	assert.match(JSON.stringify(messages), /S25 wake order/);
	assert.match(JSON.stringify(messages), /S25 wake memory/);
	assert.match(JSON.stringify(messages), /15 model rounds/);
	assert.match(JSON.stringify(messages), /compact or end the turn and report decisions already made/);
	assert.equal(f.provider.requests("s25-parent").length, 0);
});

test("S25 parent: default compact deadline exceeds the ordinary thirty-second request budget", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Initial." }, { kind: "hang", ms: 31000 }, { kind: "text", text: "Split summary." }], '{}');
	await f.start(); await f.bridge.send("Begin.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "initial send settled" });
	await f.bridge.statusWithContext();
	await f.bridge.compact();
	assert.ok(f.provider.requests("s25-parent").length >= 2);
});


for (const [tag, reply] of [
	["low", { kind: "text", text: "Below threshold.", usage: { prompt_tokens: 149000 } }],
	["length", { kind: "text", text: "Discarded output.", finishReason: "length", usage: { prompt_tokens: 127500, completion_tokens: 128000 } }],
] as const) {
	test("S25 parent: low and length-stop context avoid automatic compaction", { timeout: 60_000 }, async (t) => {
		t.diagnostic(tag);
		const f = await fixture(t, [reply, { kind: "text", text: "S25 followup." }]);
		await f.start(); await f.bridge.send("Begin.");
		await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "first send settled" });
		await f.bridge.send("Continue after the control pass.");
		assert.equal(f.provider.requests("s25-parent").length, 2, "no intervening summarizer request");
		const log = (() => { try { return readFileSync(join(f.home, LAYOUT.state, "daemon.log"), "utf8"); } catch { return ""; } })();
		if (tag === "low") assert.doesNotMatch(log, /parent context/, "below threshold logs nothing");
		else assert.match(log, /parent context skipped_length_stop raw=2\d{5} effective=1\d{5} threshold=150000/);
	});
}


test("S25 parent: startup compaction retains only unsettled durable sends", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "Initial.", usage: { prompt_tokens: 205000 } }, { kind: "text", text: "Startup summary." }, { kind: "text", text: "Recovered send." }], '{}');
	await f.start(); await f.bridge.send("Begin.");
	await waitFor(() => f.bridge.status().sends, (sends) => sends.every((send) => send.state === "settled"), { timeoutMs: 10_000, what: "initial send settled" });
	await f.bridge.statusWithContext(); await f.bridge.stop();
	const outbox = new ParentSendOutbox({ file: parentSendFile(join(f.home, LAYOUT.sessions, "cp-parent.jsonl")) });
	const queued = outbox.enqueue("S25 private queued text");
	const settled = outbox.enqueue("S25 private settled text"); outbox.markLanded([settled.id]); outbox.settle(settled.id, { reply: "Done" });
	const failed = outbox.enqueue("S25 private failed text"); outbox.markLanded([failed.id]); outbox.settle(failed.id, { error: "Failed" });
	const undeliverable = outbox.enqueue("S25 private undeliverable text"); outbox.markUndeliverable([undeliverable.id], "Stopped");
	writeFileSync(join(f.home, LAYOUT.data, "parent.json"), '{"compact_at_tokens":200000}');
	await f.start();
	await waitFor(() => f.provider.requests("s25-parent"), (requests) => requests.length >= 2, { timeoutMs: 10_000, what: "startup summarizer" });
	const input = JSON.stringify(f.provider.requests("s25-parent")[1]!.body);
	assert.match(input, /Bridge sends not yet settled/);
	assert.ok(input.includes(queued.id), queued.id);
	for (const send of [settled, failed, undeliverable]) assert.ok(!input.includes(send.id), send.id);
	assert.doesNotMatch(input, /S25 private/);
});

// A prompt that kept its size but lost its cache inside the TTL logs one line; a warm cache logs none (the control).
for (const [tag, cached] of [["rebuilt", 1000], ["warm", 8000]] as const) {
	test("S25 parent: cache rebuild within the TTL reaches the daemon log", { timeout: 60_000 }, async (t) => {
		t.diagnostic(tag);
		const usage = (cached_tokens: number) => ({ prompt_tokens: 10000, cached_tokens });
		const f = await fixture(t, [{ kind: "text", text: "First.", usage: usage(8000) }, { kind: "text", text: "Second.", usage: usage(cached) }], '{}');
		await f.start(); await f.bridge.send("Begin."); await f.bridge.send("Continue.");
		const log = (() => { try { return readFileSync(join(f.home, LAYOUT.state, "daemon.log"), "utf8"); } catch { return ""; } })();
		if (tag === "rebuilt") assert.match(log, /cp-parent-host\[\d+\]: parent context cache_rebuild cr=1000 prev=10000 gap_s=\d+\n/);
		else assert.doesNotMatch(log, /cache_rebuild/);
	});
}
