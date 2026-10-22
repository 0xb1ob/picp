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
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { createScratchLedger } from "./harness/index.ts";
import { CommandPost } from "../src/command-post.ts";
import { LAYOUT } from "../src/contracts.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { PARENT_COMPACT_HOLD_MS, PARENT_COMPACT_START_MS } from "../src/parent-compact-hold.ts";
import { frameBatch } from "../src/parent-outbox.ts";
import { daemonPaths } from "../src/service/daemon-files.ts";
import type { WakeupKind } from "../src/wakeups.ts";
import { createScratchHome } from "./harness/index.ts";

// currentRuntime() caches the first CP_HOME it resolves.
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
	const mandates = new MandateStore(scheduleHome.path, { runs: openScheduleRunStore(scheduleHome.path) });
	const schedulePost = { home: scheduleHome.path, ledger: () => ledger, mandates, fleet: { read: () => ({ jobs: [] }) },
		registry: { pathOf: () => scheduleHome.path, archivedNames: () => [], get: () => ({}) } };
	registerScheduleTools(pi, { commandPost: () => schedulePost, setLive: () => {} } as never, () => true, () => {}, () => {}, (deliver) => {
		if (wakeups.compactHold.offer(deliver) === "send") deliver();
	});
	const schedule = async (tag: string) => {
		const call = (params: Record<string, unknown>, quote = "", id = `call-${tag}`) => executeSchedule(id, params, undefined, undefined, { sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: quote } }] } });
		const said = `Add the SYNTH-NOTICE ${tag} schedule.`;
		const added = await call({ action: "add", name: `SYNTH-NOTICE ${tag}`, project: "demo", manual: true, title: tag, kind: "ship", delivery: "pr", operator_quote: said, limits: {} }, said, `add-${tag}`);
		const id = /added (sch-[0-9a-f]{6})/.exec(added.content[0]!.text)![1]!;
		return call({ action: "run_now", id }, "", `run-${tag}`);
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
	assert.equal(PARENT_COMPACT_HOLD_MS, 270_000, "the hold outlasts the bridge's 240 s compact timeout");
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
	t.mock.timers.tick(PARENT_COMPACT_HOLD_MS - 1);
	assert.equal(p.tags().includes("G3"), false, "held until the 270 s cap");
	t.mock.timers.tick(1);
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
