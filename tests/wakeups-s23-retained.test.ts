import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, type TestContext } from "node:test";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { CommandPost } from "../src/command-post.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { acquireParentLock } from "../src/parent-lock.ts";
import { isQuietWakeup } from "../src/wakeup-outbox.ts";
import type { WakeupCarrier } from "../src/wakeups.ts";
import { createScratchHome } from "./harness/index.ts";

function benchOf(t: TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return { home };
}

test("a durable landed notice retries failed sends without repeating the UI notice or waking the parent", async (t) => {
	const b = benchOf(t);
	const lock = acquireParentLock({ home: b.home.path });
	assert.ok(lock.ok);
	t.after(() => lock.lock.release());
	const post = new CommandPost({ home: b.home.path, packageRoot: PACKAGE_ROOT });
	t.after(() => post.shutdown());
	const sent: Array<{ message: WakeupCarrier; options: { triggerTurn?: boolean } }> = [];
	const notices: string[] = [];
	const state = createSessionState();
	const branch: Array<Record<string, unknown>> = [];
	state.live = { hasUI: true, ui: { notify: (text: string) => notices.push(text) }, sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
	let sendAttempts = 0;
	let failSend = true;
	const pi = { sendMessage: (message: WakeupCarrier, options: { triggerTurn?: boolean }) => {
		sendAttempts++;
		if (failSend) throw new Error("transport unavailable");
		sent.push({ message, options });
	} } as unknown as ExtensionAPI;
	const surface = createWakeupSurfaces(pi, state, { commandPost: () => post, repaintWidget: () => {} });
	const entry = { id: "continuation:done:cp-land:1", kind: "recovery" as const, job_id: "cp-land", content: "HELD PR LANDED — cp-land\n  https://github.com/o/r/pull/7" };
	post.durableWakeups.enqueue(entry);
	surface.wakeGate.agentStart();
	surface.surfaceDurableWakeups();
	assert.equal(sendAttempts, 1);
	assert.equal(sent.length, 0);
	assert.equal(notices.length, 1, "the operator already saw the landing before the failed send");
	assert.equal(post.durableWakeups.pending().length, 1, "failed transport leaves the entry pending");
	assert.equal(post.durableWakeups.read().sends?.length ?? 0, 0, "failed transport releases its send reservation");
	surface.surfaceDurableWakeups();
	assert.equal(sendAttempts, 2, "the pending send retries immediately");
	assert.equal(notices.length, 1, "repeated send failure must not repeat the UI notice");
	failSend = false;
	surface.surfaceDurableWakeups();
	assert.equal(sendAttempts, 3);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.options.triggerTurn, false);
	assert.equal(notices.length, 1);
	assert.equal(post.durableWakeups.pending().length, 1);
	branch.push({ ...sent[0]!.message, type: "custom_message" });
	surface.wakeGate.agentSettled();
	assert.equal(post.durableWakeups.enqueue(entry), false);
	surface.surfaceDurableWakeups();
	assert.equal(sent.length, 1, "no resend or nudge");
	assert.equal(notices.length, 1, "one landed notice for the operator");
	post.durableWakeups.enqueue({ ...entry, id: "continuation:done:cp-land:2" });
	surface.surfaceDurableWakeups();
	assert.equal(notices.length, 2, "a distinct durable id still notifies even with identical content");
	assert.equal(sent.length, 2);
	branch.push({ ...sent[1]!.message, type: "custom_message" });
	surface.surfaceDurableWakeups();
	assert.equal(post.durableWakeups.pending().length, 0);
	assert.equal(notices.length, 2);
	assert.equal(sent.length, 2);
	// N9: a review-window WAITING notice is news, not work: it rides along, no turn and no UI notice.
	post.durableWakeups.enqueue({ id: "continuation:window:cp-land:abc", kind: "recovery", job_id: "cp-land", content: "HELD PR WAITING — cp-land" });
	surface.surfaceDurableWakeups();
	assert.equal(sent.at(-1)?.options.triggerTurn, false);
	assert.equal(notices.length, 2);
	// A parked handoff is relayed to the operator and never starts a parent turn.
	post.durableWakeups.enqueue({ id: "continuation:parked:cp-land:1", kind: "recovery", job_id: "cp-land", content: "HELD PR PARKED — cp-land (with the team, awaiting_merge cycle 1)" });
	surface.surfaceDurableWakeups();
	assert.equal(sent.at(-1)?.options.triggerTurn, false);
	assert.equal(notices.length, 3);
	assert.equal(isQuietWakeup("continuation:cp-land:1:stop:x"), false, "a stop still wakes the parent");
});
