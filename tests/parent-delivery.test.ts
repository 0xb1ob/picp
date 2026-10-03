/**
 * Parent delivery (src/parent-delivery.ts) against a scripted parent process:
 * the post-restart reconcile races, and turn-failure accounting for sends
 * whose outcome arrives after their tool result.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanSegmentEnd, wakeSpans } from "../src/bridge-segments.ts";
import { type LandedTurn, ParentDelivery } from "../src/parent-delivery.ts";
import { frameBatch, parentSendFile, ParentSendOutbox, sendIdsInText } from "../src/parent-outbox.ts";
import type { WorkerProcess } from "../src/worker-process.ts";

function scripted() {
	const box = new ParentSendOutbox({ file: parentSendFile(join(mkdtempSync(join(tmpdir(), "parent-delivery-")), "cp-parent.jsonl")) });
	const sent: string[] = [];
	const calls: Array<[string | undefined, string | undefined]> = [];
	const counted: boolean[] = [];
	const relays: Array<{ sendId: string; text: string }> = [];
	let answer: (value: { entries: unknown[]; dropped: number }) => void = () => undefined;
	const proc = {
		busy: false,
		alive: true,
		send: async (text: string, mode?: string, behavior?: string) => {
			sent.push(text);
			calls.push([mode, behavior]);
			return { receipt: "injected" };
		},
		getEntries: () => new Promise((resolve) => (answer = resolve)),
	} as unknown as WorkerProcess;
	const delivery = new ParentDelivery(box, {
		liveProc: () => proc,
		emit: (relay) => relays.push(relay),
		sleep: async () => undefined,
		journal: () => undefined,
		countTurn: (failed) => counted.push(failed),
	});
	const turn = (): LandedTurn => ({ texts: [], assistantCount: 0, landed: [] });
	return { box, proc, sent, calls, counted, relays, delivery, turn, answer: (value: { entries: unknown[]; dropped: number }) => answer(value) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("every parent injection is one prompt with streamingBehavior steer, busy or idle", async () => {
	const ctx = scripted();
	(ctx.proc as unknown as { busy: boolean }).busy = true;
	await ctx.delivery.send("A", 10);
	(ctx.proc as unknown as { busy: boolean }).busy = false;
	await ctx.delivery.send("B", 10);
	ctx.box.enqueue("C");
	ctx.delivery.afterSettle();
	await flush();
	assert.deepEqual(ctx.calls, [
		["prompt", "steer"],
		["prompt", "steer"],
		["prompt", "steer"],
	]);
});

test("segmentEnd settles each landed send at its own clean turn_end: own reply, counted once, never relayed again", async () => {
	const ctx = scripted();
	const a = ctx.delivery.send("A", 60_000);
	const b = ctx.delivery.send("B", 60_000);
	await flush();
	const turn = ctx.turn();
	const say = (text: string) => {
		turn.texts.push(text);
		turn.assistantCount += 1;
	};
	ctx.delivery.landed(ctx.sent[0] as string, turn);
	say("answer A");
	ctx.delivery.segmentEnd(turn);
	const first = await a;
	assert.equal(first.level, "owner_observed");
	assert.equal(first.reply, "answer A", "the first waiter gets only its own segment");
	assert.deepEqual(ctx.counted, [false]);
	say("parent's own wake text");
	ctx.delivery.landed(ctx.sent[1] as string, turn);
	say("answer B");
	assert.deepEqual(wakeSpans(turn, 0), ["parent's own wake text"], "text between segments belongs to no send");
	ctx.delivery.settle(turn);
	assert.equal((await b).reply, "answer B");
	assert.deepEqual(ctx.counted, [false, false], "countTurn exactly once per send");
	assert.equal(ctx.box.get(first.send_id as string)?.reply, "answer A");

	// A drained send has no waiter: its relay goes out at the segment end, and not again at the settle.
	const drained = ctx.box.enqueue("C");
	ctx.delivery.afterSettle();
	await flush();
	const next = ctx.turn();
	ctx.delivery.landed(ctx.sent[2] as string, next);
	next.texts.push("answer C");
	next.assistantCount += 1;
	ctx.delivery.segmentEnd(next);
	ctx.delivery.segmentEnd(next);
	ctx.delivery.settle(next);
	assert.deepEqual(ctx.relays.map((relay) => [relay.sendId, relay.text]), [[drained.id, "answer C"]]);
	assert.deepEqual(ctx.counted, [false, false, false]);
});

test("cleanSegmentEnd: only a text-only turn_end that did not fail or get cut off", () => {
	const end = (stopReason: string | undefined, toolResults: unknown[] = []) => ({ type: "turn_end", message: { role: "assistant", stopReason }, toolResults });
	assert.equal(cleanSegmentEnd(end("stop")), true);
	for (const stop of ["error", "aborted", "length", undefined]) assert.equal(cleanSegmentEnd(end(stop)), false, String(stop));
	assert.equal(cleanSegmentEnd(end("toolUse", [{ role: "toolResult" }])), false);
	assert.equal(cleanSegmentEnd({ type: "agent_settled" }), false);
});

test("a send injected or landed while the restart reconcile reads the transcript is never requeued nor nudged", async () => {
	const ctx = scripted();
	// Left by the dead process: X injected (never landed), L landed (no reply yet).
	const x = ctx.box.enqueue("X");
	ctx.box.markInjected([x.id]);
	const l = ctx.box.enqueue("L");
	ctx.box.markInjected([l.id]);
	ctx.box.markLanded([l.id]);

	const ready = ctx.delivery.afterReady(ctx.proc);
	// While get_entries is in flight the live parent takes two sends: Y lands, Z does not yet.
	void ctx.delivery.send("Y", 60_000);
	void ctx.delivery.send("Z", 60_000);
	await flush();
	const y = ctx.box.list().find((entry) => entry.text === "Y");
	const z = ctx.box.list().find((entry) => entry.text === "Z");
	assert.ok(y && z);
	ctx.delivery.landed(frameBatch([y]), ctx.turn());
	ctx.answer({ entries: [], dropped: 0 });
	await ready;

	assert.equal(ctx.box.get(z.id)?.attempts, 1, "Z was injected live: never requeued for a second delivery");
	assert.equal(ctx.box.get(y.id)?.state, "landed");
	const resumes = ctx.sent.filter((text) => text.includes("— resume]"));
	assert.equal(resumes.length, 1);
	assert.deepEqual(sendIdsInText(resumes[0] as string), [l.id], "only L reached the parent before the restart");
	// X was absent from the transcript: requeued and delivered once, as the drain's batch.
	const bodies = ctx.sent.filter((text) => !text.includes("— resume]")).map((text) => sendIdsInText(text));
	assert.deepEqual(bodies, [[y.id], [z.id], [x.id]]);
});

test("a failed turn counts toward the relaunch cap when its outcome is pending or relayed, not only synchronous", async () => {
	const ctx = scripted();
	// Pending: the tool result returned before the turn settled.
	const pending = await ctx.delivery.send("P", 10);
	assert.equal(pending.pending, pending.send_id);
	const turn = ctx.turn();
	ctx.delivery.landed(ctx.sent[0] as string, turn);
	ctx.delivery.settle(turn); // no assistant message: failed
	// Relayed: a drained send with no waiter at all.
	const queued = ctx.box.enqueue("Q");
	ctx.delivery.afterSettle();
	await flush();
	const relayed = ctx.turn();
	ctx.delivery.landed(ctx.sent[1] as string, relayed);
	ctx.delivery.settle(relayed);
	assert.deepEqual(ctx.counted, [true, true]);
	assert.deepEqual(ctx.relays.map((relay) => relay.sendId), [pending.send_id, queued.id]);
	assert.equal(ctx.box.get(queued.id)?.state, "failed");
});

test("H3c: a usage-limit or auth error never enters the outer ladder — zero retries", () => {
	const ctx = scripted();
	const journaled: string[] = [];
	const delivery = new ParentDelivery(ctx.box, {
		liveProc: () => ctx.proc,
		emit: (relay) => ctx.relays.push(relay),
		sleep: async () => {
			assert.fail("a never-retried error must not sleep for a resume");
		},
		journal: (event) => journaled.push(event),
		countTurn: (failed) => ctx.counted.push(failed),
	});
	for (const message of ["usage limit reached", "401 Invalid API key"]) {
		const entry = ctx.box.enqueue(message);
		ctx.box.markInjected([entry.id]);
		const turn = ctx.turn();
		delivery.landed(frameBatch([entry]), turn);
		turn.error = { message };
		delivery.settle(turn);
		assert.equal(ctx.box.get(entry.id)?.state, "failed", `${message}: settled immediately, not resumed`);
	}
	assert.deepEqual(journaled, [], "never-transient errors never touch the outer-retry journal");
});

test("H3c: a settled (never relayed) send is not nudged as 'reached you before the restart' after a relaunch", async () => {
	const ctx = scripted();
	const entry = ctx.box.enqueue("S");
	ctx.box.markInjected([entry.id]);
	ctx.box.markLanded([entry.id]);
	// Settled with a reply, exactly as the synchronous `send()` waiter path
	// leaves it \u2014 never relayed, since the waiter consumed the outcome directly.
	ctx.box.settle(entry.id, { reply: "done" });
	// A relaunch: live tracking is dropped, then the new process reconciles.
	ctx.delivery.failWaiters();
	const ready = ctx.delivery.afterReady(ctx.proc);
	ctx.answer({ entries: [], dropped: 0 });
	await ready;
	const resumes = ctx.sent.filter((text) => text.includes("\u2014 resume]"));
	assert.deepEqual(resumes, [], "a settled send already has its answer; it must never get a restart nudge");
});

test("H3c: a relay that throws is journaled, never aborts the rest of the replay loop, and is retried until it lands", () => {
	const ctx = scripted();
	const bad = ctx.box.enqueue("bad");
	ctx.box.markInjected([bad.id]);
	ctx.box.markLanded([bad.id]);
	ctx.box.settle(bad.id, { reply: "bad reply" });
	const good = ctx.box.enqueue("good");
	ctx.box.markInjected([good.id]);
	ctx.box.markLanded([good.id]);
	ctx.box.settle(good.id, { reply: "good reply" });
	const journaled: Array<{ event: string; send_id?: string }> = [];
	const relayed: string[] = [];
	let badFailedOnce = false;
	const delivery = new ParentDelivery(ctx.box, {
		liveProc: () => ctx.proc,
		emit: (relay) => {
			if (relay.sendId === bad.id && !badFailedOnce) {
				badFailedOnce = true;
				throw new Error("emit boom");
			}
			relayed.push(relay.sendId as string);
		},
		sleep: async () => undefined,
		journal: (event, payload) => journaled.push({ event, send_id: payload.send_id as string | undefined }),
		countTurn: () => undefined,
	});
	for (const item of delivery.outbox.relaysDue()) delivery.relay(item);
	assert.deepEqual(relayed, [good.id], "the failing entry never aborts the loop for the one behind it");
	assert.deepEqual(journaled, [{ event: "relay_failed", send_id: bad.id }], "one journal entry, never swallowed");
	assert.equal(ctx.box.get(bad.id)?.relayed_at, undefined, "left due, so the next pass retries it instead of dropping it");
	assert.equal(ctx.box.get(good.id)?.relayed_at !== undefined, true);

	// Retried on the next pass, this time the emit succeeds: exactly one relay lands for it.
	for (const item of delivery.outbox.relaysDue()) delivery.relay(item);
	assert.deepEqual(relayed, [good.id, bad.id]);
	assert.deepEqual(journaled, [{ event: "relay_failed", send_id: bad.id }], "the earlier failure is journaled exactly once");
});

test("H3c: a relay that keeps throwing for the same send id journals relay_failed only once", () => {
	const ctx = scripted();
	const bad = ctx.box.enqueue("bad");
	ctx.box.markInjected([bad.id]);
	ctx.box.markLanded([bad.id]);
	ctx.box.settle(bad.id, { reply: "bad reply" });
	const journaled: Array<{ event: string; send_id?: string }> = [];
	const relayed: string[] = [];
	let attempts = 0;
	const delivery = new ParentDelivery(ctx.box, {
		liveProc: () => ctx.proc,
		emit: (relay) => {
			attempts += 1;
			if (attempts <= 3) throw new Error(`emit boom ${attempts}`);
			relayed.push(relay.sendId as string);
		},
		sleep: async () => undefined,
		journal: (event, payload) => journaled.push({ event, send_id: payload.send_id as string | undefined }),
		countTurn: () => undefined,
	});
	// Three consecutive failing passes for the same send id.
	for (let pass = 0; pass < 3; pass++) {
		for (const item of delivery.outbox.relaysDue()) delivery.relay(item);
	}
	assert.deepEqual(relayed, [], "still unrelayed after three failing passes");
	assert.deepEqual(journaled, [{ event: "relay_failed", send_id: bad.id }], "one journal entry, not one per failing pass");

	// Fourth pass: emit finally succeeds.
	for (const item of delivery.outbox.relaysDue()) delivery.relay(item);
	assert.deepEqual(relayed, [bad.id]);
	assert.deepEqual(journaled, [{ event: "relay_failed", send_id: bad.id }], "still exactly one journal entry once it lands");
});
