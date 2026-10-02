import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHooks } from "../extensions/command-post/session-hooks.ts";
import { createSessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { CommandPost } from "../src/command-post.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import type { WakeupCarrier } from "../src/wakeups.ts";
import { createScratchHome, readRunEvents } from "./harness/index.ts";

type ContextHook = (event: { messages: WakeupCarrier[] }) => Promise<{ messages: WakeupCarrier[] } | undefined>;

test("qra: stale and replayed notices stay journaled, not in the parent's model context", async (t) => {
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
	post.runs.closeAll();
	const suppressed = readRunEvents(home.path, "cp-gone").filter((event) => event.type === "wakeup_suppressed");
	assert.ok(suppressed.length >= 4, "suppression remains observable in the run journal");
	const payloads = suppressed.map((event) => event.payload as { kind: string; stage: string; reason: string });
	for (const kind of ["envelope", "ci", "verdict", "answered", "recovery"]) {
		assert.ok(payloads.some((entry) => entry.kind === kind && entry.stage === "delivery" && entry.reason.length > 0));
	}
	assert.doesNotMatch(JSON.stringify(suppressed), /Obsolete .* instructions|A new operator decision|HELD PR LANDED/, "journal records reasons, not message bodies");
});
