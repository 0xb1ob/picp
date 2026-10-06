import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import "./harness/fake-parent-tracker.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { CpBridge } from "../src/cp-bridge.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { MandateStore } from "../src/mandate.ts";
import { autoParentContext, digestsInContext, effectiveContextTokens, lastValidAssistant, parentCompactInstructions, parentContextLog, parentSettings } from "../src/parent-context.ts";
import type { ParentStatus } from "../src/cp-bridge.ts";
import { parentSendFile, ParentSendOutbox } from "../src/parent-outbox.ts";
import { WorkerProcess } from "../src/worker-process.ts";
import { COMMAND_POST_EXTENSION, MockProvider, createAgentDir, createScratchHome, startRpc } from "./harness/index.ts";

test("parentSettings defaults an absent parent.json to 200000 and keeps explicit values", () => {
	const home = createScratchHome();
	try {
		assert.deepEqual(parentSettings(home.path), { compact_at_tokens: 200000 });
		mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
		const file = join(home.path, LAYOUT.data, "parent.json");
		writeFileSync(file, '{"compact_at_tokens":150000}');
		assert.deepEqual(parentSettings(home.path), { compact_at_tokens: 150000 });
		writeFileSync(file, "{}");
		assert.deepEqual(parentSettings(home.path), {}, "an explicit file without a valid value stays disabled");
	} finally { home.cleanup(); }
});

// N6 (E7): a length stop that billed 128000 output tokens and stored ~400 chars.
const LENGTH_STOP = {
	role: "assistant", stopReason: "length", usage: { input: 2, output: 128000, cacheRead: 126795, cacheWrite: 801, totalTokens: 255598 },
	content: [{ type: "thinking", thinking: "t".repeat(339) }, { type: "toolCall", name: "cp_schedule", arguments: { a: "x".repeat(40) } }],
};

test("N6: a length stop's discarded output is not context; a normal stop and an unknown reading are unchanged", () => {
	const effective = effectiveContextTokens(255640, LENGTH_STOP)!;
	assert.ok(effective > 127_700 && effective < 127_800 && effective < 200000, String(effective));
	assert.equal(effectiveContextTokens(205000, { role: "assistant", stopReason: "stop", usage: { output: 900, totalTokens: 205000 } }), 205000);
	assert.equal(effectiveContextTokens(null, LENGTH_STOP), null);
	const usage = { input: 1, output: 1, totalTokens: 2 };
	const entry = (message: unknown) => ({ type: "message", message });
	const valid = { role: "assistant", stopReason: "stop", usage };
	assert.equal(lastValidAssistant([entry(valid), entry({ role: "assistant", stopReason: "error", usage }), entry({ role: "assistant", stopReason: "aborted", usage }), entry({ role: "assistant", stopReason: "stop", usage: { totalTokens: 0 } }), entry({ role: "user" })]), valid);
	assert.equal(lastValidAssistant([LENGTH_STOP, { role: "custom" }]), LENGTH_STOP, "plain messages too");
	assert.equal(lastValidAssistant([entry(valid), { type: "compaction" }]), undefined, "nothing before a compaction counts");
});

test("autoParentContext: a failed mission-end rotate falls through to compaction; below the threshold it does nothing", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const calls: string[] = [];
	const status = (contextTokens: number) => async () => ({ contextTokens }) as ParentStatus;
	const control = (contextTokens: number) => ({
		unsettled: () => undefined, status: status(contextTokens),
		rotate: async () => { calls.push("rotate"); throw new Error("new_session rejected: cancelled"); },
		compact: async () => { calls.push("compact"); return { tokensBefore: contextTokens, estimatedTokensAfter: 5000 }; },
	});
	const over = await autoParentContext(home.path, "md-x", undefined, control(205000));
	assert.deepEqual(calls, ["rotate", "compact"]);
	assert.equal(over.rotateFailed, "new_session rejected: cancelled");
	assert.equal(over.event, "compacted");
	assert.equal(over.before, 205000);
	calls.length = 0;
	assert.deepEqual(await autoParentContext(home.path, undefined, undefined, control(150000)), {}, "below the threshold: no outcome");
	assert.deepEqual(calls, []);
	assert.equal((await autoParentContext(home.path, undefined, LENGTH_STOP, control(255640))).event, "skipped_length_stop");
	assert.deepEqual(calls, [], "a length stop is not compacted");
	assert.equal((await autoParentContext(home.path, undefined, undefined, { ...control(205000), unsettled: () => "busy" })).error, "busy");
	const timedOut = await autoParentContext(home.path, undefined, undefined, { ...control(205000), compact: async () => { throw new Error("timeout after 1000ms waiting for response to compact"); } });
	assert.equal(timedOut.event, "timed_out");
	assert.equal((await autoParentContext(home.path, undefined, undefined, { ...control(205000), compact: async () => { throw new Error("compact rejected: x"); } })).event, "failed");
});

test("parentContextLog appends exactly one line to state/daemon.log", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	parentContextLog(home.path, "cp-parent-host", "compacted before=1 after=2 ms=3");
	const text = readFileSync(join(home.path, LAYOUT.state, "daemon.log"), "utf8");
	assert.equal(text.split("\n").filter(Boolean).length, 1);
	assert.match(text, /^\S+ cp-parent-host\[\d+\]: parent context compacted before=1 after=2 ms=3\n$/);
});

test("picp-99l: an identical latest digest pair is not re-sent; a compaction or a changed digest still is", () => {
	const pair = [{ customType: "cp-memory", content: "memory A" }, { customType: "cp-standing-orders", content: "orders A" }];
	const entry = (customType: string, content: string) => ({ type: "custom_message", customType, content });
	const resumed = [entry("cp-memory", "memory A"), entry("cp-standing-orders", "orders A"), { type: "message" }];
	assert.equal(digestsInContext(resumed, pair), true, "a resumed session already holding the pair skips");
	assert.equal(digestsInContext([...resumed, { type: "compaction" }], pair), false, "post-compact always injects");
	assert.equal(digestsInContext([], pair), false, "a fresh session injects");
	assert.equal(digestsInContext(resumed, [pair[0]!, { customType: "cp-standing-orders", content: "orders B" }]), false, "changed orders inject");
	assert.equal(digestsInContext([entry("cp-memory", "memory old"), entry("cp-standing-orders", "orders A"), entry("cp-memory", "memory A")], pair), true, "only the latest of each type counts");
	assert.equal(digestsInContext([entry("cp-memory", "memory A"), entry("cp-standing-orders", "orders A"), entry("cp-memory", "memory B")], pair), false, "a newer different memory digest means send");
	assert.equal(digestsInContext(resumed, [pair[1]!]), false, "a memory digest that disappeared is a change");
});

test("parent compact instructions name current open decisions, held PR jobs and active mandates from disk", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent",
		piBin: resolve(import.meta.dirname, "fixtures/fake-parent.mjs") });
	const mandate = new MandateStore(home.path).issue({ projects: ["demo"], objective: "Ship fixture work",
		expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 100000 }, job_cap: 5 });
	const escalation = await new EscalationStore({ home: home.path }).raise({
		job_ids: ["cp-held-fixture"], kind: "product_ambiguity", question: "Which option?",
		options: [{ id: "keep", label: "Keep", consequence: "Proceed", cost: "none" },
			{ id: "stop", label: "Stop", consequence: "Stop", cost: "none" }],
		recommended: "keep", evidence_paths: [],
	});
	await new FleetStore({ home: home.path }).add({
		job_id: "cp-held-fixture", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN,
		phase: "held", reported_at: isoTimestamp(), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
		branch: "cp-held-fixture", worktree: home.path,
		worker: { pid: 1, session_id: "fixture", session_file: join(home.path, "worker.jsonl"),
			profile: "implementer", role: "implementer", model: "mock/worker", started_at: isoTimestamp() },
	});
	const request = WorkerProcess.prototype.request;
	let instructions = "";
	t.mock.method(WorkerProcess.prototype, "request", function (this: WorkerProcess, ...args: Parameters<typeof request>) {
		if (args[0] === "compact") instructions = String(args[1]?.customInstructions);
		return request.apply(this, args);
	});
	await bridge.compact();
	for (const id of [escalation.id, "cp-held-fixture", mandate.id]) assert.ok(instructions.includes(id), instructions);
	assert.match(instructions, /standing operator instructions/);
	await bridge.compact("Keep the review rationale too.");
	assert.match(instructions, /Keep the review rationale too/);
	assert.ok(instructions.includes(escalation.id), "caller instructions must not discard disk context");
});

test("compact context retains only unsettled bridge sends, including after a session rotation", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const outbox = new ParentSendOutbox({ file: parentSendFile(join(home.path, LAYOUT.sessions, "cp-parent.jsonl")) });
	const queued = outbox.enqueue("Queued operator text");
	const injected = outbox.enqueue("Injected operator text");
	outbox.markInjected([injected.id]);
	const landed = outbox.enqueue("Landed operator text");
	outbox.markLanded([landed.id]);
	const settled = outbox.enqueue("Settled operator text");
	outbox.markLanded([settled.id]);
	outbox.settle(settled.id, { reply: "Done" });
	const failed = outbox.enqueue("Failed operator text");
	outbox.markLanded([failed.id]);
	outbox.settle(failed.id, { error: "Failed" });
	const undeliverable = outbox.enqueue("Undeliverable operator text");
	outbox.markUndeliverable([undeliverable.id], "Stopped");
	writeFileSync(join(home.path, LAYOUT.sessions, "cp-parent-control.json"), JSON.stringify({ sessionFile: join(home.path, "rotated.jsonl") }));
	const instructions = parentCompactInstructions(home.path);
	for (const entry of [queued, injected, landed]) assert.ok(instructions.includes(entry.id), instructions);
	for (const entry of [settled, failed, undeliverable]) assert.ok(!instructions.includes(entry.id), instructions);
	assert.doesNotMatch(instructions, /operator text/);
});

test("successful parent compaction re-delivers both current digests exactly once to the next model request", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const orders = join(home.path, LAYOUT.data, "standing-orders.md");
	const memory = join(home.path, LAYOUT.learningsFile);
	writeFileSync(orders, "# Standing orders\n\nOriginal order.\n");
	writeFileSync(memory, "# Learnings\n\n- Original memory. <!--P-->\n");
	const provider = await MockProvider.start();
	const model = provider.addScript("parent-compact", [
		{ kind: "text", text: "Initial work completed." },
		{ kind: "text", text: "Summary of initial work." },
		{ kind: "text", text: "Continued with refreshed context." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, CP_MODE: "multi", CP_HEADLESS: "1" },
		args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "initial", message: "Begin work." });
	await rpc.waitFor((record) => record.type === "agent_settled", 60_000);
	assert.match(JSON.stringify(provider.requests("parent-compact")[0]?.body), /Original order/);
	assert.match(JSON.stringify(provider.requests("parent-compact")[0]?.body), /Original memory/);
	writeFileSync(orders, "# Standing orders\n\nRefreshed standing order.\n");
	writeFileSync(memory, "# Learnings\n\n- Refreshed memory lesson. <!--P-->\n");
	rpc.send({ type: "compact", id: "compact" });
	const compact = await rpc.waitFor((record) => record.type === "response" && record.id === "compact", 60_000);
	assert.equal(compact.success, true, JSON.stringify(compact));
	rpc.send({ type: "prompt", id: "next", message: "Continue work." });
	await rpc.waitFor((record) => record.type === "message_end" && JSON.stringify(record.message).includes("Continued with refreshed context."), 60_000);
	const next = JSON.stringify(provider.requests("parent-compact").at(-1)?.body);
	assert.equal(next.split("Refreshed standing order.").length - 1, 1, "standing orders re-delivered once");
	assert.equal(next.split("Refreshed memory lesson.").length - 1, 1, "memory re-delivered once");
	const digests = rpc.records().filter((record) => record.type === "message_end")
		.map((record) => record.message as { customType?: string; content?: string; display?: boolean })
		.filter((message) => ["cp-memory", "cp-standing-orders"].includes(message.customType ?? "") && message.content?.includes("Refreshed"));
	assert.equal(digests.length, 2);
	assert.ok(digests.every((message) => message.display === false));
});

test("session start puts memory and standing orders in context before any turn (triggerTurn:false, not nextTurn)", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "standing-orders.md"), "# Standing orders\n\nWake-turn order.\n");
	writeFileSync(join(home.path, LAYOUT.learningsFile), "# Learnings\n\n- Wake-turn memory. <!--P-->\n");
	const provider = await MockProvider.start();
	const model = provider.addScript("parent-start", [{ kind: "text", text: "unused" }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, CP_MODE: "multi", CP_HEADLESS: "1" },
		args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	// No prompt is sent: a `nextTurn` message would sit in pi's pending queue and be absent here.
	rpc.send({ type: "get_messages", id: "ctx" });
	const response = await rpc.waitFor((record) => record.type === "response" && record.id === "ctx", 60_000);
	const text = JSON.stringify(response);
	assert.match(text, /Wake-turn memory/);
	assert.match(text, /Wake-turn order/);
});

test("picp-99l: resuming a parent session with unchanged digests appends no second pair", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "standing-orders.md"), "# Standing orders\n\nResume order.\n");
	writeFileSync(join(home.path, LAYOUT.learningsFile), "# Learnings\n\n- Resume memory. <!--P-->\n");
	const provider = await MockProvider.start();
	const model = provider.addScript("parent-resume", [{ kind: "text", text: "ok" }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const session = join(home.path, "parent-session.jsonl");
	const start = () => startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, CP_MODE: "multi", CP_HEADLESS: "1" },
		args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--session", session, "--model", model] });
	let second: ReturnType<typeof start> | undefined;
	t.after(async () => { await second?.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const first = start();
	first.send({ type: "prompt", id: "p", message: "Begin." });
	await first.waitFor((record) => record.type === "agent_settled", 60_000);
	await first.close();
	second = start();
	second.send({ type: "get_messages", id: "ctx" });
	const text = JSON.stringify(await second.waitFor((record) => record.type === "response" && record.id === "ctx", 60_000));
	assert.equal(text.split("Resume order.").length - 1, 1, "standing orders once");
	assert.equal(text.split("Resume memory.").length - 1, 1, "memory once");
});
