import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHooks } from "../extensions/command-post/session-hooks.ts";
import { createSessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { createWakeupSurfaces, WAKEUP_NUDGE_TYPE } from "../extensions/command-post/wakeup-surfaces.ts";
import { CommandPost } from "../src/command-post.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { frameBatch } from "../src/parent-outbox.ts";
import type { WakeupCarrier } from "../src/wakeups.ts";
import { createScratchHome, readRunEvents } from "./harness/index.ts";

type ContextHook = (event: { messages: WakeupCarrier[] }) => Promise<{ messages: WakeupCarrier[] } | undefined>;

function scratchPost(t: { after(fn: () => void | Promise<void>): void }): CommandPost {
	const home = createScratchHome();
	const previousHome = process.env.CP_HOME;
	const previousMode = process.env.CP_MODE;
	process.env.CP_HOME = home.path;
	process.env.CP_MODE = "multi";
	const post = new CommandPost({ home: home.path, packageRoot: PACKAGE_ROOT });
	t.after(async () => {
		await post.shutdown();
		if (previousHome === undefined) delete process.env.CP_HOME;
		else process.env.CP_HOME = previousHome;
		if (previousMode === undefined) delete process.env.CP_MODE;
		else process.env.CP_MODE = previousMode;
		home.cleanup();
	});
	return post;
}

test("qra: stale and replayed notices stay journaled, not in the parent's model context", async (t) => {
	const post = scratchPost(t);
	const home = { path: post.home };
	post.runs.open("cp-gone");
	const open = (): ContextHook => {
		let context: ContextHook | undefined;
		const pi = {
			on(name: string, handler: ContextHook) { if (name === "context") context = handler; },
			registerEntryRenderer() {},
		} as unknown as ExtensionAPI;
		const state = createSessionState();
		state.post = post;
		const wakeups = createWakeupSurfaces(pi, state, { commandPost: () => post, repaintWidget: () => {} });
		registerSessionHooks(pi, state, createSessionPost(pi, state, wakeups), wakeups);
		assert.ok(context);
		return context;
	};
	const context = open();
	const stale = ["envelope", "ci", "verdict"].map((kind): WakeupCarrier => ({
		role: "custom", customType: `cp-${kind}`, content: `Obsolete ${kind} instructions`,
		details: { cp_wakeup: { kind, job_id: "cp-gone", issued_at: "2026-09-26T08:00:00Z" } },
	}));
	assert.deepEqual(await context({ messages: stale }), { messages: [] }, "stale-only context has nothing to acknowledge");
	assert.ok(stale.every((message) => String(message.content).startsWith("Obsolete")), "session history is not mutated");

	const user: WakeupCarrier = { role: "user", content: "Continue the current work" };
	const fresh: WakeupCarrier = {
		role: "custom", customType: "cp-answered", content: "A new operator decision", timestamp: 1_000,
		details: { cp_wakeup: { kind: "answered", job_id: "cp-gone", keys: ["aw-new"], issued_at: "2026-09-26T08:01:00Z" } },
	};
	const copy = { ...fresh, timestamp: 2_000 };
	const mixed = [user, stale[0]!, fresh, copy];
	assert.deepEqual(await context({ messages: mixed }), { messages: [user, fresh] }, "new answers survive; their duplicate copies do not");
	assert.equal(await context({ messages: [user, fresh] }), undefined, "fresh-only context needs no replacement");
	assert.deepEqual(await open()({ messages: mixed }), { messages: [user, fresh] }, "reload keeps stale notices out and the first answer in");
	// cp-ze1t: the outbox's 120 s re-send of a durable wake-up the parent has not reached yet.
	const landingWakeup = { kind: "recovery", job_id: "cp-gone", issued_at: "2026-09-26T08:02:00Z" };
	const landed: WakeupCarrier = {
		role: "custom", customType: "cp-recovery", content: "HELD PR LANDED — cp-gone merged", timestamp: 3_000,
		details: { durable_id: "continuation:cp-gone:1:done", cp_wakeup: landingWakeup },
	};
	const landedCopy: WakeupCarrier = {
		...landed, timestamp: 4_000,
		details: { durable_id: "continuation:cp-gone:1:done", cp_wakeup: { ...landingWakeup, issued_at: "2026-09-26T08:04:00Z" } },
	};
	assert.deepEqual(await context({ messages: [user, landed, landedCopy] }), { messages: [user, landed] }, "one landing notice reaches the model");
	assert.deepEqual(await open()({ messages: [user, landed, landedCopy] }), { messages: [user, landed] }, "reload keeps the first landing copy and drops the re-send");
	// A jobless recovery stamp lists its candidates in `keys`; its marker lands in each listed job's log.
	const jobless: WakeupCarrier = {
		role: "custom", customType: "cp-recovery", content: "Revive the listed jobs", timestamp: 5_000,
		details: { cp_wakeup: { kind: "recovery", keys: ["cp-gone"], issued_at: "2026-09-26T08:05:00Z" } },
	};
	assert.deepEqual(await context({ messages: [user, jobless] }), { messages: [user] }, "a recovery whose candidates are gone is withheld");
	post.runs.closeAll();
	const suppressed = readRunEvents(home.path, "cp-gone").filter((event) => event.type === "wakeup_suppressed");
	assert.ok(suppressed.length >= 4, "suppression remains observable in the run journal");
	const payloads = suppressed.map((event) => event.payload as { kind: string; stage: string; reason: string; issued_at: string; keys?: string[] });
	for (const kind of ["envelope", "ci", "verdict", "answered", "recovery"]) {
		assert.ok(payloads.some((entry) => entry.kind === kind && entry.stage === "delivery" && entry.reason.length > 0));
	}
	assert.deepEqual(payloads.find((entry) => entry.kind === "answered")?.keys, ["aw-new"], "markers carry the stamp's keys");
	const joblessMarker = payloads.find((entry) => entry.issued_at === "2026-09-26T08:05:00Z");
	assert.equal(joblessMarker?.kind, "recovery");
	assert.equal(joblessMarker?.stage, "delivery");
	assert.deepEqual(joblessMarker?.keys, ["cp-gone"]);
	assert.match(joblessMarker?.reason ?? "", /every candidate it listed has been torn down/);
	assert.doesNotMatch(JSON.stringify(suppressed), /Obsolete .* instructions|A new operator decision|HELD PR LANDED/, "journal records reasons, not message bodies");
});

test("N9: a withheld tail wake never leaves the context ending on assistant", async (t) => {
	const post = scratchPost(t);
	post.runs.open("cp-gone");
	let context: ContextHook | undefined;
	const pi = {
		on(name: string, handler: ContextHook) { if (name === "context") context = handler; },
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI;
	const state = createSessionState();
	state.post = post;
	const wakeups = createWakeupSurfaces(pi, state, { commandPost: () => post, repaintWidget: () => {} });
	registerSessionHooks(pi, state, createSessionPost(pi, state, wakeups), wakeups);
	assert.ok(context);
	const user: WakeupCarrier = { role: "user", content: "Continue the current work" };
	const assistant: WakeupCarrier = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] };
	const staleVerdict: WakeupCarrier = {
		role: "custom", customType: "cp-verdict", content: "Obsolete verdict instructions", timestamp: 7_000,
		details: { cp_wakeup: { kind: "verdict", job_id: "cp-gone", issued_at: "2026-09-26T08:00:00Z" } },
	};
	const input = [user, assistant, staleVerdict];
	const result = await context({ messages: input });
	assert.ok(result);
	assert.equal(result.messages.length, 3);
	assert.equal(result.messages[0], user);
	assert.equal(result.messages[1], assistant);
	const tail = result.messages[2]!;
	assert.equal(tail.role, "custom");
	assert.equal(tail.customType, "cp-withheld-tail");
	assert.equal(tail.timestamp, 7_000, "the stand-in takes the dropped message's place in time");
	assert.equal((tail.details as { cp_wakeup?: unknown } | undefined)?.cp_wakeup, undefined, "the stand-in carries no wake-up stamp");
	assert.doesNotMatch(JSON.stringify(tail.content), /Obsolete|STALE WAKE-UP/, "no stale body, no stale headline");
	assert.equal(input.length, 3, "session history is not mutated");
	assert.equal(input[2], staleVerdict);
	assert.deepEqual(await context({ messages: [user, staleVerdict] }), { messages: [user] }, "a user tail needs no stand-in");
});

// cp-vy73 (PR-3, cp-cc45 F3/F6): the busy-wake gate through the real hook wiring.
test("cp-vy73: busy wake-ups ride along non-triggering, and agent_settled nudges once for a stranded one", async (t) => {
	const post = scratchPost(t);
	const handlers = new Map<string, (event?: unknown) => unknown>();
	const sent: Array<{ message: WakeupCarrier & { content: string }; options: { triggerTurn?: boolean; deliverAs?: string } }> = [];
	const pi = {
		on(name: string, handler: (event?: unknown) => unknown) { handlers.set(name, handler); },
		registerEntryRenderer() {},
		sendMessage(message: WakeupCarrier & { content: string }, options: { triggerTurn?: boolean; deliverAs?: string }) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI;
	const state = createSessionState();
	state.post = post;
	const wakeups = createWakeupSurfaces(pi, state, { commandPost: () => post, repaintWidget: () => {} });
	registerSessionHooks(pi, state, createSessionPost(pi, state, wakeups), wakeups);
	const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event);
	const wake = (tag: string) => wakeups.sendWakeup({ kind: "ci" }, `SYNTH-NOTICE ${tag}`, {});
	const nudges = () => sent.filter((entry) => entry.message.customType === WAKEUP_NUDGE_TYPE);
	const triggering = { deliverAs: "followUp", triggerTurn: true };

	// Case 1: the first wake-up of a busy run triggers; the 2nd and 3rd ride along.
	fire("agent_start");
	fire("before_provider_request");
	for (const tag of ["W1", "W2", "W3"]) assert.ok(wake(tag));
	assert.deepEqual(sent.map((entry) => entry.options), [triggering, { triggerTurn: false }, { triggerTurn: false }]);
	// `answered` stays triggering while busy.
	wakeups.sendWakeup({ kind: "answered", keys: ["aw-synth"] }, "SYNTH-ANSWER", { answered: [] });
	assert.deepEqual(sent.at(-1)?.options, triggering, "answered is never non-triggering");

	// Case 2: a request carried W2/W3; W4 arrives after it, so settle nudges exactly once with N=1.
	fire("before_provider_request");
	assert.ok(wake("W4-late"));
	assert.equal(sent.at(-1)?.options.triggerTurn, false);
	fire("agent_settled");
	assert.equal(nudges().length, 1);
	assert.deepEqual(nudges()[0]?.options, triggering);
	assert.match(nudges()[0]?.message.content ?? "", /^1 fleet notice\(s\) arrived while you were busy/);

	// Case 4: a wake-up after agent_settled is triggering (idle, F6).
	assert.ok(wake("after-settle"));
	assert.deepEqual(sent.at(-1)?.options, triggering);

	// Case 3: every non-triggering wake-up was carried by a later request — no nudge.
	fire("agent_start");
	assert.ok(wake("X1"));
	assert.ok(wake("X2"));
	assert.equal(sent.at(-1)?.options.triggerTurn, false);
	fire("before_provider_request");
	fire("agent_settled");
	assert.equal(nudges().length, 1, "no new nudge without a wake-up after the last request");

	// Abort regression: after an operator abort, a stranded notice starts no turn — not at
	// settle, and not at the next settle either; it reaches the model with the next prompt.
	fire("agent_start");
	assert.ok(wake("Y1"));
	fire("before_provider_request");
	assert.ok(wake("Y2-late"));
	assert.equal(sent.at(-1)?.options.triggerTurn, false);
	fire("agent_end", { messages: [{ role: "user", content: "go" }, { role: "assistant", content: [], stopReason: "aborted" }] });
	fire("agent_settled");
	assert.equal(nudges().length, 1, "an aborted run is not nudged");
	fire("agent_start");
	fire("before_provider_request");
	fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] });
	fire("agent_settled");
	assert.equal(nudges().length, 1, "the aborted run's notice is not nudged later either");

	// The nudge carries no stamp, so the delivery-time review leaves it untouched.
	const context = handlers.get("context") as unknown as ContextHook;
	const nudge: WakeupCarrier = { ...nudges()[0]!.message, role: "custom" };
	assert.equal(await context({ messages: [{ role: "user", content: "go" }, nudge] }), undefined);
});

// unload-parent PR3: the send-first hold through the real hook wiring.
test("unload-parent PR3: wakes wait while a landed operator send is unanswered; answered never waits", async (t) => {
	const post = scratchPost(t);
	const handlers = new Map<string, (event?: unknown) => unknown>();
	const sent: Array<{ message: WakeupCarrier & { content: string }; options: { triggerTurn?: boolean; deliverAs?: string } }> = [];
	const pi = {
		on(name: string, handler: (event?: unknown) => unknown) { handlers.set(name, handler); },
		registerEntryRenderer() {},
		sendMessage(message: WakeupCarrier & { content: string }, options: { triggerTurn?: boolean; deliverAs?: string }) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI;
	const state = createSessionState();
	state.post = post;
	const wakeups = createWakeupSurfaces(pi, state, { commandPost: () => post, repaintWidget: () => {} });
	registerSessionHooks(pi, state, createSessionPost(pi, state, wakeups), wakeups);
	const fire = async (name: string, event: unknown = {}) => handlers.get(name)?.(event);
	const wake = (tag: string) => wakeups.sendWakeup({ kind: "ci" }, `SYNTH-NOTICE ${tag}`, {});
	const contents = () => sent.map((entry) => entry.message.content);
	const operatorSend = { role: "user", content: [{ type: "text", text: frameBatch([{ id: "ps-20300101000000-0000000a", text: "SYNTH operator question" }]) }] };
	const turnEnd = (stopReason: string, toolResults: unknown[] = []) => ({ type: "turn_end", message: { role: "assistant", stopReason }, toolResults });
	const triggering = { deliverAs: "followUp", triggerTurn: true };

	await fire("agent_start");
	await fire("before_provider_request");
	await fire("message_start", { message: operatorSend });
	assert.equal(wake("W1"), true, "a held wake counts as sent: it is not a stale suppression");
	assert.equal(wake("W2"), true);
	assert.deepEqual(contents(), [], "held while the operator send is unanswered");
	wakeups.sendWakeup({ kind: "answered", keys: ["aw-synth"] }, "SYNTH-ANSWER", { answered: [] });
	assert.equal(contents().length, 1, "answered is never held");
	await fire("turn_end", turnEnd("toolUse", [{ role: "toolResult" }]));
	assert.equal(contents().length, 1, "a tool-call turn is not the answer");
	await fire("turn_end", turnEnd("stop"));
	assert.deepEqual(contents().slice(1).map((text) => text.match(/SYNTH-NOTICE (W\d)/)?.[1]), ["W1", "W2"], "the answer releases both, in order");
	assert.deepEqual(sent.slice(1).map((entry) => entry.options), [{ triggerTurn: false }, { triggerTurn: false }], "the busy-wake gate still applies to released wakes");
	assert.ok(wake("W3"));
	assert.equal(contents().length, 4, "answered: the next wake goes straight out");

	// A run that settles without a clean answer releases what it held, triggering (idle).
	await fire("agent_start");
	await fire("message_start", { message: operatorSend });
	assert.ok(wake("W4"));
	assert.equal(contents().length, 4);
	await fire("agent_settled");
	assert.ok(contents()[4]?.includes("W4"));
	assert.deepEqual(sent[4]?.options, triggering);
});
