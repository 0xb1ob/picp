import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import "./harness/fake-parent-tracker.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { CpBridge } from "../src/cp-bridge.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { MandateStore } from "../src/mandate.ts";
import { parentCompactInstructions, parentSettings } from "../src/parent-context.ts";
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
