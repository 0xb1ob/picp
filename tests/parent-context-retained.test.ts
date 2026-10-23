import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import "./harness/fake-parent-tracker.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHooks } from "../extensions/command-post/session-hooks.ts";
import { createSessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { CommandPost } from "../src/command-post.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { LAYOUT, type Mandate } from "../src/contracts.ts";
import { effectiveContextTokens, lastValidAssistant, missionRotation, parentCompactInstructions, standingOrdersFile } from "../src/parent-context.ts";
import { cacheRebuildLine, PROMPT_CACHE_TTL_SECONDS, trackAssistant } from "../src/parent-auto-control.ts";
import { parentSendFile, ParentSendOutbox } from "../src/parent-outbox.ts";
import { createScratchHome } from "./harness/index.ts";


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


// N1(c) (cp-c1ur): warm rebuilds were invisible; only a turn that kept its prompt size inside the cache TTL but read
// under half of it is a rebuild — a compaction shrinks the prompt, and a long gap expires the cache by design.
test("N1: trackAssistant logs cache_rebuild only for a same-size prompt inside the TTL that lost its cache", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const turn = (at: number, cacheRead: number, cacheWrite: number) => ({ role: "assistant", stopReason: "stop", timestamp: at, usage: { input: 10, output: 5, cacheRead, cacheWrite } });
	const warm = turn(0, 100_000, 2_000);
	assert.equal(cacheRebuildLine(warm, turn(13_000, 102_000, 1_000)), undefined, "a warm read");
	assert.equal(cacheRebuildLine(warm, turn(13_000, 30_692, 141_748)), "cache_rebuild cr=30692 prev=102010 gap_s=13");
	assert.equal(cacheRebuildLine(warm, turn((PROMPT_CACHE_TTL_SECONDS + 1) * 1000, 0, 150_000)), undefined, "the TTL expired");
	assert.equal(cacheRebuildLine(warm, turn(13_000, 0, 20_000)), undefined, "a compaction shrank the prompt");
	assert.equal(cacheRebuildLine(undefined, turn(13_000, 0, 150_000)), undefined, "nothing to compare");
	const next = turn(13_000, 30_692, 141_748);
	assert.equal(trackAssistant(home.path, warm, next), next);
	assert.equal(trackAssistant(home.path, next, undefined), next, "an unusable assistant keeps the previous one");
	assert.match(readFileSync(join(home.path, LAYOUT.state, "daemon.log"), "utf8"), /parent context cache_rebuild cr=30692 prev=102010 gap_s=13\n$/);
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
