// C1/picp-80q (T3): the parent's compaction hold, pure and through the real hook wiring.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHooks } from "../extensions/command-post/session-hooks.ts";
import { createSessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { registerScheduleTools } from "../extensions/command-post/tools-schedule.ts";
import { MandateStore } from "../src/mandate.ts";
import { createScratchLedger } from "./harness/index.ts";
import { CommandPost } from "../src/command-post.ts";
import { isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { type ContextReading, PARENT_COMPACT_HOLD_MS, PARENT_COMPACT_START_MS, ParentCompactHold } from "../src/parent-compact-hold.ts";
import { frameBatch } from "../src/parent-outbox.ts";
import { daemonPaths } from "../src/service/daemon-files.ts";
import type { WakeupKind } from "../src/wakeups.ts";
import { createScratchHome } from "./harness/index.ts";

// One home for the file: currentRuntime() caches the first CP_HOME it resolves (E12).
const home = createScratchHome();
const previous = { home: process.env.CP_HOME, mode: process.env.CP_MODE };
process.env.CP_HOME = home.path;
process.env.CP_MODE = "multi";
mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 200000 }));
const post = new CommandPost({ home: home.path, packageRoot: PACKAGE_ROOT });
after(async () => {
	await post.shutdown();
	for (const [key, value] of [["CP_HOME", previous.home], ["CP_MODE", previous.mode]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	home.cleanup();
});

const logLines = (): string[] => {
	const file = daemonPaths(home.path).log;
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line.includes("cp-parent[")) : [];
};
/** The per-case delta of matching parent lines. */
const mark = () => {
	const base = logLines().length;
	return (pattern: RegExp): number => logLines().slice(base).filter((line) => pattern.test(line)).length;
};

const LENGTH_STOP = {
	type: "message",
	message: {
		role: "assistant", stopReason: "length", usage: { input: 2, output: 128000, cacheRead: 126795, cacheWrite: 801, totalTokens: 255598 },
		content: [{ type: "thinking", thinking: "t".repeat(360) }, { type: "text", text: "x".repeat(40) }],
	},
};
const ctxAt = (tokens: number, branch: unknown[] = [], mode = "rpc") => ({ mode, getContextUsage: () => ({ tokens }), sessionManager: { getBranch: () => branch } });
const OVER = ctxAt(210000);
const triggering = { deliverAs: "followUp", triggerTurn: true };

type Sent = { message: { customType?: string; content: string; display?: boolean; details?: Record<string, unknown> }; options: { triggerTurn?: boolean; deliverAs?: string } };
type ExecuteSchedule = (id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;
function open() {
	const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();
	const sent: Sent[] = [];
	let executeSchedule: ExecuteSchedule;
	const pi = {
		on(name: string, handler: (event?: unknown, ctx?: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerEntryRenderer() {},
		registerTool(tool: { name: string; execute: ExecuteSchedule }) { if (tool.name === "cp_schedule") executeSchedule = tool.execute; },
		sendMessage(message: Sent["message"], options: Sent["options"]) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI;
	const state = createSessionState();
	state.post = post;
	const wakeups = createWakeupSurfaces(pi, state, { commandPost: () => post, repaintWidget: () => {} });
	registerSessionHooks(pi, state, createSessionPost(pi, state, wakeups), wakeups);
	const scheduleHome = createScratchHome();
	after(() => scheduleHome.cleanup());
	const ledger = createScratchLedger({ home: scheduleHome.path, knownProjects: ["demo"] }).ledger;
	const mandates = new MandateStore(scheduleHome.path);
	const schedulePost = { home: scheduleHome.path, ledger: () => ledger, mandates, fleet: { read: () => ({ jobs: [] }) },
		registry: { pathOf: () => scheduleHome.path, archivedNames: () => [], get: () => ({}) } };
	registerScheduleTools(pi, { commandPost: () => schedulePost, setLive: () => {} } as never, () => true, () => {}, () => {}, (deliver) => {
		if (wakeups.compactHold.offer(deliver) === "send") deliver();
	});
	const schedule = async (tag: string) => {
		const seed = mandates.issue({ projects: ["demo"], objective: tag, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 1000000 }, job_cap: 2, schedule_grant: true });
		const call = (params: Record<string, unknown>, quote = "") => executeSchedule("call-1", params, undefined, undefined, { sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: quote } }] } });
		const added = await call({ action: "add", name: `SYNTH-NOTICE ${tag}`, project: "demo", mandate_id: seed.id, manual: true, title: tag, kind: "ship", delivery: "pr" });
		const id = /added (sch-[0-9a-f]{6})/.exec(added.content[0]!.text)![1]!;
		const quote = `Run ${id} now.`;
		return call({ action: "run_now", id, operator_quote: quote }, quote);
	};
	const fire = (name: string, event: unknown = {}, ctx?: unknown) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) { const value = handler(event, ctx); if (value !== undefined) result = value; }
		return result;
	};
	const wake = (tag: string, kind: WakeupKind = "ci") => wakeups.sendWakeup(kind === "answered" ? { kind, keys: [`aw-${tag}`] } : { kind }, `SYNTH-NOTICE ${tag}`, kind === "answered" ? { answered: [] } : {});
	const tags = () => sent.map((entry) => entry.message.content.match(/SYNTH-NOTICE (\S+)/)?.[1] ?? entry.message.customType);
	return { fire, wake, schedule, sent, tags, hold: wakeups.compactHold };
}

test("T3(a): the pure hold — settle, timers, failures, busy phase, runStarted, not_over", () => {
	let now = 0;
	const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
	const lines: string[] = [];
	const hold = new ParentCompactHold({
		now: () => now,
		timer: (fn, ms) => { const entry = { fn, ms, live: true }; timers.push(entry); return () => { entry.live = false; }; },
		log: (line) => lines.push(line),
	});
	const live = () => timers.filter((entry) => entry.live);
	const fireLive = (ms: number) => { for (const entry of live().filter((e) => e.ms === ms)) { entry.live = false; entry.fn(); } };
	const over: ContextReading = { over: true, raw: 210000, effective: 210000, threshold: 200000 };
	const under: ContextReading = { over: false, raw: 150000, effective: 150000, threshold: 200000 };
	const out: number[] = [];

	hold.settled(over);
	for (const n of [1, 2, 3]) assert.equal(hold.offer(() => out.push(n)), "hold");
	now = 500;
	hold.compacted();
	assert.deepEqual(out, [1, 2, 3]);
	assert.match(lines.at(-1)!, /^hold released reason=compacted held=3 ms=500$/);
	assert.equal(hold.offer(() => out.push(4)), "send");

	hold.settled(over);
	hold.offer(() => out.push(5));
	fireLive(PARENT_COMPACT_START_MS);
	assert.deepEqual(out.slice(3), [5], "15 s with no start releases");
	hold.settled(over);
	hold.offer(() => out.push(6));
	hold.compactionStarted();
	assert.deepEqual(live().map((entry) => entry.ms), [PARENT_COMPACT_HOLD_MS], "the start timer gives way to the cap");
	fireLive(PARENT_COMPACT_HOLD_MS);
	assert.deepEqual(out.slice(4), [6]);
	hold.settled(over);
	hold.failed();
	assert.equal(hold.enabled, false, "three failures or expiries disable");
	assert.equal(lines.filter((line) => line === "hold disabled failures=3").length, 1);
	hold.settled(over);
	assert.equal(hold.holding, false, "disabled: never holds");
	hold.compacted();
	assert.equal(hold.enabled, true, "a compaction re-enables");

	const before = timers.length;
	hold.turnEnded(over);
	assert.equal(hold.offer(() => out.push(7)), "hold", "busy phase holds");
	assert.equal(timers.length, before, "and arms no timer");
	hold.settled(over);
	hold.runStarted();
	assert.equal(live().length, 0, "runStarted clears the start timer");
	assert.equal(out.at(-1), 6, "and does not flush");
	hold.settled(under);
	assert.equal(out.at(-1), 7);
	assert.match(lines.at(-1)!, /reason=not_over/);
});

test("T3(b): over the threshold, settle holds fleet and schedule wakes in offer order until session_compact", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const count = mark();
	const p = open();
	p.fire("agent_settled", {}, OVER);
	p.wake("C1");
	await p.schedule("S1");
	p.wake("E1", "envelope");
	await p.schedule("S2");
	p.wake("A1", "answered");
	assert.equal(p.sent.length, 0, "no wake reaches pi while held");
	p.fire("session_compact", {});
	assert.equal(p.sent.length, 0, "released after pi's compact() returns");
	t.mock.timers.tick(0);
	assert.deepEqual(p.tags(), ["C1", "S1", "E1", "S2", "A1"]);
	assert.ok(p.sent.every((entry) => entry.options.triggerTurn === true && entry.options.deliverAs === "followUp"));
	assert.ok(p.sent.filter((entry) => entry.message.customType === "cp-schedule").every((entry) => entry.message.display === true && entry.message.details?.outcome === "fired"));
	assert.equal(count(/hold engaged phase=settled/), 1);
	assert.equal(count(/hold released reason=compacted/), 1);
});

test("T3(c)/(d): below the threshold, or off a headless parent, nothing holds", async () => {
	const count = mark();
	for (const ctx of [ctxAt(150000), ctxAt(210000, [], "tui")]) {
		const p = open();
		p.fire("agent_settled", {}, ctx);
		assert.equal(p.wake("now"), true);
		await p.schedule("immediate");
		assert.deepEqual(p.sent.map((entry) => entry.options), [triggering, triggering]);
	}
	assert.equal(count(/hold /), 0);
});

test("T3(e): N6 — a length stop cancels pi's threshold compaction and never holds", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const count = mark();
	const p = open();
	const event = (reason: string) => ({ type: "session_before_compact", reason, preparation: { tokensBefore: 255640 }, branchEntries: [LENGTH_STOP] });
	assert.deepEqual(p.fire("session_before_compact", event("threshold")), { cancel: true });
	assert.equal(p.fire("session_before_compact", event("manual")), undefined);
	assert.equal(count(/threshold_compaction_cancelled tokens_before=255640 effective=127\d{3} threshold=200000/), 1);
	for (let i = 0; i < 3; i++) p.fire("session_compact_failed", { reason: "threshold", aborted: true });
	assert.equal(p.hold.enabled, true, "a cancelled threshold compaction is not a hold failure");
	p.fire("agent_settled", {}, ctxAt(255640, [LENGTH_STOP]));
	assert.equal(count(/hold skipped_length_stop raw=255640/), 1);
	assert.equal(p.hold.holding, false);
	p.fire("agent_settled", {}, OVER);
	assert.equal(p.hold.holding, true, "a later over-threshold settle still holds");
	p.fire("session_compact", {});
	t.mock.timers.tick(0);
});

test("T3(f): an over-threshold run holds every wake, including schedule and send-first release, until compaction", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const count = mark();
	const p = open();
	p.fire("agent_start");
	p.fire("turn_end", { type: "turn_end", message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{}] }, OVER);
	assert.equal(count(/hold engaged phase=busy/), 1);
	p.wake("W1");
	p.wake("W2", "envelope");
	assert.equal(p.sent.length, 0, "neither followUp nor quiet");
	await p.schedule("S1");
	const operatorSend = { role: "user", content: [{ type: "text", text: frameBatch([{ id: "ps-20300101000000-0000000a", text: "SYNTH operator question" }]) }] };
	p.fire("message_start", { message: operatorSend });
	p.wake("W3");
	p.fire("turn_end", { type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, OVER);
	assert.equal(p.sent.length, 0, "the send-first release is held too");
	p.fire("agent_settled", {}, OVER);
	t.mock.timers.tick(PARENT_COMPACT_START_MS - 1);
	assert.equal(p.sent.length, 0);
	p.fire("session_before_compact", { reason: "manual" });
	t.mock.timers.tick(PARENT_COMPACT_HOLD_MS - 1);
	assert.equal(p.sent.length, 0);
	p.fire("session_compact", {});
	t.mock.timers.tick(0);
	assert.deepEqual(p.tags(), ["W1", "W2", "S1", "W3"]);
	assert.ok(p.sent.every((entry) => entry.options.deliverAs === "followUp" && entry.options.triggerTurn === true));
	assert.equal(count(/hold released reason=compacted/), 1);
});

test("T3(g)/(h): failure, start timeout and cap release; three disable; agent_start never releases", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const count = mark();
	const p = open();
	const run = async (tag: string) => {
		p.fire("agent_start");
		p.fire("turn_end", { type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, OVER);
		await p.schedule(tag);
		p.fire("agent_settled", {}, OVER);
		assert.equal(p.tags().includes(tag), false, `${tag} held`);
	};
	await run("G1");
	assert.deepEqual(p.fire("session_before_compact", { reason: "threshold", preparation: { tokensBefore: 255640 }, branchEntries: [LENGTH_STOP] }), { cancel: true });
	p.fire("session_compact_failed", { reason: "threshold", aborted: true });
	assert.deepEqual(p.sent, [], "threshold cancellation cannot release a schedule wake");
	p.fire("session_compact_failed", { reason: "manual" });
	await run("G2");
	t.mock.timers.tick(PARENT_COMPACT_START_MS);
	await run("G3");
	p.fire("session_before_compact", { reason: "manual" });
	t.mock.timers.tick(PARENT_COMPACT_HOLD_MS);
	assert.deepEqual(p.tags(), ["G1", "G2", "G3"]);
	for (const reason of ["failed", "start_timeout", "cap_timeout"]) assert.equal(count(new RegExp(`hold released reason=${reason} `)), 1, reason);
	assert.equal(count(/hold disabled failures=3/), 1);
	assert.equal(p.hold.enabled, false);
	p.fire("agent_settled", {}, OVER);
	await p.schedule("disabled");
	assert.equal(p.tags().at(-1), "disabled", "disabled holding delivers schedules immediately");
	p.fire("session_compact", {});
	t.mock.timers.tick(0);
	assert.equal(p.hold.enabled, true, "a compaction re-enables");

	p.fire("agent_settled", {}, OVER);
	await p.schedule("H1");
	p.fire("agent_start");
	assert.equal(p.tags().includes("H1"), false, "agent_start is not a release");
	p.fire("agent_settled", {}, OVER);
	assert.equal(p.tags().includes("H1"), false);
	t.mock.timers.tick(PARENT_COMPACT_START_MS);
	assert.equal(p.tags().filter((tag) => tag === "H1").length, 1);
});

test("schedule wakes release on a below-threshold settle, and deliver immediately with context control disabled", async () => {
	const p = open();
	p.fire("agent_settled", {}, OVER);
	await p.schedule("under");
	assert.deepEqual(p.sent, []);
	p.fire("agent_settled", {}, ctxAt(150000));
	assert.deepEqual(p.tags(), ["under"]);
	const settings = join(home.path, LAYOUT.data, "parent.json");
	try {
		writeFileSync(settings, JSON.stringify({ compact_at_tokens: null }));
		p.fire("agent_settled", {}, OVER);
		await p.schedule("off");
		assert.deepEqual(p.tags(), ["under", "off"]);
	} finally {
		writeFileSync(settings, JSON.stringify({ compact_at_tokens: 200000 }));
	}
});
