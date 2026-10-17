import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import "./harness/fake-parent-tracker.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHooks } from "../extensions/command-post/session-hooks.ts";
import { createSessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { CommandPost } from "../src/command-post.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { CpBridge } from "../src/cp-bridge.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { MandateStore } from "../src/mandate.ts";
import { autoParentContext, digestsInContext, effectiveContextTokens, lastValidAssistant, missionRotation, parentCompactInstructions, parentContextLog, parentSettings, standingOrdersFile } from "../src/parent-context.ts";
import type { Mandate } from "../src/contracts.ts";
import { runAutoControl } from "../src/parent-auto-control.ts";
import { PARENT_CONTROL_BUSY } from "../src/parent-diagnostics.ts";
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

test("runAutoControl: a timed_out compact relay names the retry and the worker consequence; a failure does not", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const control = (error: string) => ({
		unsettled: () => undefined, status: async () => ({ contextTokens: 205000 }) as ParentStatus,
		rotate: async () => undefined, compact: async () => { throw new Error(error); },
	});
	const relayed: string[] = [];
	await runAutoControl(home.path, undefined, undefined, control("timeout after 240000ms waiting for response to compact"), (text) => relayed.push(text));
	await runAutoControl(home.path, undefined, undefined, control("compact rejected: x"), (text) => relayed.push(text));
	assert.equal(relayed.length, 2);
	assert.match(relayed[0]!, /^parent automatic context control timed out: timeout after 240000ms .*retry the compaction once the parent has settled.*rotation or restart can abort running workers/);
	assert.equal(relayed[1], "parent automatic context control failed: compact rejected: x");
	const log = readFileSync(join(home.path, LAYOUT.state, "daemon.log"), "utf8");
	assert.match(log, /timed_out .*error="timeout after 240000ms/, "the log keeps the error evidence");
});

test("N17: rotation follows the grant that actually ended — a parent revoke counts, a stale cp_next mission id does not", () => {
	const grant = (id: string, status: Mandate["status"], extra: Partial<Mandate> = {}) => ({ id, status, expiry: "2026-12-01T00:00:00Z", ...extra }) as Mandate;
	const closed = grant("md-old", "revoked", { revoked_at: "2026-10-16T12:36:11Z", revoked_by: { by: "system" } });
	const revoked = grant("md-new", "revoked", { revoked_at: "2026-10-16T14:12:25Z", revoked_by: { by: "parent" } });
	assert.deepEqual(missionRotation([closed, revoked], "md-old", {}), { id: "md-new", trigger: "revoked by parent" }, "the newest end, not the stale id");
	assert.equal(missionRotation([closed, revoked, grant("md-live", "active")], "md-old", {}), undefined, "a grant still active");
	const done = { lastMissionEnd: "md-new", lastRotateAt: "2026-10-16T14:12:38Z" };
	assert.equal(missionRotation([closed, revoked], "md-old", done), undefined, "no new end since the last rotation");
	const later = grant("md-later", "revoked", { revoked_at: "2026-10-16T17:30:51Z", revoked_by: { by: "parent" } });
	assert.deepEqual(missionRotation([closed, revoked, later], "md-old", done), { id: "md-later", trigger: "revoked by parent" });
	assert.deepEqual(missionRotation([grant("md-x", "active")], "md-x", {}), { id: "md-x", trigger: "cp_next mission_end" });
	assert.equal(missionRotation([grant("md-x", "active")], "md-x", { lastMissionEnd: "md-x" }), undefined);
});

test("N17: runAutoControl rotates after a parent revoke with no cp_next mission end, and logs the true trigger", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = store.issue({ projects: ["demo"], objective: "ship", expiry: isoTimestamp(new Date(Date.now() + 86400000)), spend_cap: { usd: 1, tokens: 1000 }, job_cap: 1 });
	store.revoke(grant.id, { by: "parent" });
	const rotated: string[] = [];
	const control = { unsettled: () => undefined, status: async () => ({ contextTokens: 1000 }) as ParentStatus, rotate: async (mission: string) => void rotated.push(mission), compact: async () => ({}) };
	await runAutoControl(home.path, undefined, undefined, control, () => assert.fail("no error relay"));
	assert.deepEqual(rotated, [grant.id]);
	assert.match(readFileSync(join(home.path, LAYOUT.state, "daemon.log"), "utf8"), new RegExp(`rotated mission=${grant.id} trigger="revoked by parent"`));
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
	const guidance = { customType: "cp-parent-guidance", content: "parent guidance" };
	assert.equal(digestsInContext(resumed, [...pair, guidance]), false, "an old pair needs the new parent guidance");
	assert.equal(digestsInContext([...resumed, entry(guidance.customType, guidance.content)], [...pair, guidance]), true);
});

test("cp-35d0 S10: a queued digest set is reserved per session and successful-compaction epoch", async (t) => {
	const home = createScratchHome();
	const previous = { home: process.env.CP_HOME, mode: process.env.CP_MODE };
	process.env.CP_HOME = home.path;
	process.env.CP_MODE = "multi";
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const fire = async (name: string, ctx?: unknown) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
	type Digest = { message: { customType: string; content: string; display?: boolean }; options: { triggerTurn?: boolean } };
	const sent: Digest[] = [];
	let failSend = false;
	const DIGESTS = ["cp-parent-guidance", "cp-memory", "cp-standing-orders"];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerEntryRenderer() {}, registerTool() {}, getAllTools: () => [],
		sendMessage(message: Digest["message"], options: Digest["options"]) {
			if (!DIGESTS.includes(message.customType)) return;
			if (failSend) throw new Error("synthetic send failure");
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	const state = createSessionState();
	state.post = new CommandPost({ home: home.path, packageRoot: PACKAGE_ROOT });
	state.parentLock = { release() {} } as never;
	state.installNudgeShown = state.piVersionNudgeShown = state.routingNudgeShown = true;
	const wakeups = createWakeupSurfaces(pi, state, { commandPost: () => state.post!, repaintWidget: () => {} });
	registerSessionHooks(pi, state, createSessionPost(pi, state, wakeups), wakeups);
	t.after(async () => {
		await fire("session_shutdown");
		for (const [key, value] of [["CP_HOME", previous.home], ["CP_MODE", previous.mode]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		home.cleanup();
	});
	// The branch never shows what was just queued: that is the same-tick race.
	const session = (id: string, branch: unknown[] = []) => ({ hasUI: false, cwd: home.path, sessionManager: { getSessionId: () => id, getBranch: () => branch } });

	await fire("session_start", session("A"));
	const size = sent.length;
	assert.ok(size >= 2, "guidance and standing orders at least");
	assert.ok(sent.every((entry) => entry.message.display === false && entry.options.triggerTurn === false), "no model turn starts");
	await fire("session_start", session("A"));
	assert.equal(sent.length, size, "a duplicate session_start for the same session and epoch enqueues one set");
	const recorded = sent.map((entry) => ({ type: "custom_message", customType: entry.message.customType, content: entry.message.content }));
	await fire("session_start", session("B", recorded));
	assert.equal(sent.length, size, "a resumed session already holding the set skips");
	await fire("session_start", session("C"));
	assert.equal(sent.length, 2 * size, "a new session sends a fresh set");
	await fire("session_compact", session("C"));
	assert.equal(sent.length, 3 * size, "a successful compaction opens a fresh epoch");
	await fire("session_compact", session("C"));
	assert.equal(sent.length, 4 * size);
	writeFileSync(standingOrdersFile(home.path), "changed orders\n");
	await fire("session_start", session("C"));
	assert.equal(sent.length, 5 * size, "a changed digest sends");
	assert.match(sent.at(-1)!.message.content, /changed orders/);

	writeFileSync(standingOrdersFile(home.path), "orders after a failed send\n");
	failSend = true;
	await assert.rejects(fire("session_start", session("C")), /synthetic send failure/);
	failSend = false;
	await fire("session_start", session("C"));
	assert.equal(sent.length, 6 * size, "a failed send releases its reservation, so the retry goes out");
	await fire("session_start", session("C"));
	assert.equal(sent.length, 6 * size);
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
	const timeouts: (number | undefined)[] = [];
	t.mock.method(WorkerProcess.prototype, "request", function (this: WorkerProcess, ...args: Parameters<typeof request>) {
		if (args[0] === "compact") { instructions = String(args[1]?.customInstructions); timeouts.push(args[2]); }
		return request.apply(this, args);
	});
	await bridge.compact();
	for (const id of [escalation.id, "cp-held-fixture", mandate.id]) assert.ok(instructions.includes(id), instructions);
	assert.match(instructions, /standing operator instructions/);
	await bridge.compact("Keep the review rationale too.");
	assert.match(instructions, /Keep the review rationale too/);
	assert.ok(instructions.includes(escalation.id), "caller instructions must not discard disk context");
	assert.deepEqual(timeouts, [240_000, 240_000], "an unset requestTimeoutMs gives compact 240 s");
	await bridge.stop();
	const explicit = new CpBridge();
	t.after(() => explicit.stop());
	await explicit.start({ home: home.path, mode: "multi", model: "mock/parent", requestTimeoutMs: 45_000,
		piBin: resolve(import.meta.dirname, "fixtures/fake-parent.mjs") });
	await explicit.compact();
	assert.equal(timeouts.at(-1), 45_000, "an explicit requestTimeoutMs override is honored");
});

test("cp-35d0 S6: a new drain is refused with PARENT_CONTROL_BUSY and no drain RPC while a compaction runs; a cancel still goes through", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: resolve(import.meta.dirname, "fixtures/fake-parent.mjs") });
	const request = WorkerProcess.prototype.request;
	const requests: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	t.mock.method(WorkerProcess.prototype, "request", function (this: WorkerProcess, ...args: Parameters<typeof request>) {
		requests.push(String(args[0]));
		return args[0] === "compact" ? gate.then(() => request.apply(this, args)) : request.apply(this, args);
	});
	const compacting = bridge.compact();
	for (const timeoutS of [undefined, 30] as const) {
		await assert.rejects(bridge.drain(timeoutS), (error: Error) => error.message === PARENT_CONTROL_BUSY);
	}
	assert.deepEqual(requests, ["compact"], "refused before any diagnostic RPC");
	await bridge.drainCancel().catch((error: Error) => assert.notEqual(error.message, PARENT_CONTROL_BUSY));
	assert.equal(requests[1], "get_commands", "a cancel is never refused by the control gate");
	release();
	await compacting;
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
	assert.match(next, /15 model rounds/);
	assert.equal(next.split("Parent only: Put independent tool calls").length - 1, 1);
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
	assert.match(text, /Put independent tool calls in one assistant message/);
	assert.match(text, /15 model rounds/);
	assert.match(text, /compact or end the turn and report decisions already made/);
	const guidance = (response.data as { messages: Array<{ customType?: string; display?: boolean }> }).messages.filter((message) => message.customType === "cp-parent-guidance");
	assert.equal(guidance.length, 1);
	assert.equal(guidance[0]!.display, false);
	assert.equal(provider.requests("parent-start").length, 0, "guidance starts no model turn");
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
	assert.equal(text.split("Parent only: Put independent tool calls").length - 1, 1, "guidance once on resume");
});
