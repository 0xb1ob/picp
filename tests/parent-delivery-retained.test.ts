/**
 * Parent delivery, retained: interleaves inside one RPC read or ladder sleep, a wake landing between two steered sends,
 * pi refusing a prompt write, and stop reasons no consumer tells apart. The rest is tests/e2e/parent-delivery-p9f.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanSegmentEnd, wakeSpans } from "../src/bridge-segments.ts";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { type LandedTurn, ParentDelivery } from "../src/parent-delivery.ts";
import { frameBatch, parentSendFile, ParentSendOutbox, sendIdsInText } from "../src/parent-outbox.ts";
import { OUTER_RETRY_DELAYS_MS } from "../src/provider-retry.ts";
import type { WorkerProcess } from "../src/worker-process.ts";

function scripted() {
	const box = new ParentSendOutbox({ file: parentSendFile(join(mkdtempSync(join(tmpdir(), "parent-delivery-")), "cp-parent.jsonl")) });
	const sent: string[] = [];
	const calls: Array<[string | undefined, string | undefined]> = [];
	const counted: boolean[] = [];
	const slept: number[] = [];
	const relays: BridgeRelay[] = [];
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
		sleep: async (ms) => {
			slept.push(ms);
		},
		journal: () => undefined,
		countTurn: (failed) => counted.push(failed),
	});
	const turn = (): LandedTurn => ({ texts: [], assistantCount: 0, landed: [], answers: [] });
	return { box, proc, sent, calls, counted, slept, relays, delivery, turn, answer: (value: { entries: unknown[]; dropped: number }) => answer(value) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** One outbox, two parent processes: `old` is reading its transcript when the bridge moves to `fresh`. */
function superseded() {
	const box = new ParentSendOutbox({ file: parentSendFile(join(mkdtempSync(join(tmpdir(), "parent-delivery-")), "cp-parent.jsonl")) });
	const fake = () => {
		const state = {
			sent: [] as string[],
			reads: 0,
			answer: (_value: { entries: unknown[]; dropped: number }) => undefined as void,
			fail: (_error: Error) => undefined as void,
		};
		const proc = {
			busy: false,
			alive: true,
			send: async (text: string) => {
				state.sent.push(text);
				return { receipt: "injected" };
			},
			getEntries: () => {
				state.reads += 1;
				return new Promise((resolve, reject) => {
					state.answer = resolve;
					state.fail = reject;
				});
			},
		} as unknown as WorkerProcess;
		return { proc, state };
	};
	const old = fake();
	const fresh = fake();
	let live = old.proc;
	const delivery = new ParentDelivery(box, {
		liveProc: () => live,
		emit: () => undefined,
		sleep: async () => undefined,
		journal: () => undefined,
		countTurn: () => undefined,
	});
	const injected = box.enqueue("X");
	box.markInjected([injected.id]);
	const landed = box.enqueue("L");
	box.markInjected([landed.id]);
	box.markLanded([landed.id]);
	const ready = delivery.afterReady(old.proc);
	delivery.failWaiters();
	live = fresh.proc;
	return { box, delivery, old, fresh, ready, injected, landed };
}

/** A landed send with `spent` reservations and a delivery whose sleeps are held until released. */
function laddered(spent = 0) {
	const ctx = scripted();
	const journal: Array<{ event: string; payload: Record<string, unknown> }> = [];
	const sleeps: Array<{ ms: number; release: () => void }> = [];
	const host = {
		liveProc: () => ctx.proc,
		emit: (relay: BridgeRelay) => ctx.relays.push(relay),
		sleep: (ms: number) => new Promise<void>((resolve) => sleeps.push({ ms, release: resolve })),
		journal: (event: string, payload: Record<string, unknown>) => journal.push({ event, payload }),
		countTurn: (failed: boolean) => ctx.counted.push(failed),
	};
	// `fresh()` is a restarted delivery over the same outbox file: nothing volatile carries over.
	const fresh = () => new ParentDelivery(new ParentSendOutbox({ file: ctx.box.file }), host as never);
	const entry = ctx.box.enqueue("task");
	ctx.box.markInjected([entry.id]);
	ctx.box.markLanded([entry.id]);
	for (let i = 0; i < spent; i++) ctx.box.reserveOuterRetry(entry.id, 5);
	const fail = (delivery: ParentDelivery, message = "503 service unavailable") => {
		const turn = ctx.turn();
		delivery.landed(frameBatch([entry]), turn);
		turn.error = { message };
		delivery.settle(turn);
	};
	return { ...ctx, entry, journal, sleeps, fresh, fail };
}

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

test("a superseded afterReady neither reconciles nor RPCs the old process", async () => {
	const ctx = superseded();
	ctx.old.state.answer({ entries: [], dropped: 0 });
	await ctx.ready;
	assert.deepEqual(ctx.old.state.sent, [], "no resume nudge on a process that is no longer live");
	assert.equal(ctx.box.get(ctx.injected.id)?.state, "injected", "no reconcile against the old transcript");
	ctx.delivery.afterSettle();
	await flush();
	assert.equal(ctx.fresh.state.reads, 0, "no stale reconcile flag for the new process");
});

test("a superseded afterReady that fails leaves no stale reconcile flag", async () => {
	const ctx = superseded();
	ctx.old.state.fail(new Error("old process gone"));
	await ctx.ready;
	ctx.delivery.afterSettle();
	await flush();
	assert.equal(ctx.fresh.state.reads, 0);
	const ready = ctx.delivery.afterReady(ctx.fresh.proc);
	ctx.fresh.state.answer({ entries: [], dropped: 0 });
	await ready;
	const resumes = ctx.fresh.state.sent.filter((text) => text.includes("— resume]"));
	assert.equal(resumes.length, 1, "the new process nudges the landed send exactly once");
	assert.deepEqual(sendIdsInText(resumes[0] as string), [ctx.landed.id]);
});

test("N5: a landed-only resume whose transcript read fails still nudges once and drains", async () => {
	const ctx = scripted();
	const entry = ctx.box.enqueue("L");
	ctx.box.markInjected([entry.id]);
	ctx.box.markLanded([entry.id]);
	(ctx.proc as unknown as { getEntries: () => Promise<never> }).getEntries = () => Promise.reject(new Error("get_entries timed out"));
	await ctx.delivery.afterReady(ctx.proc);
	const resumes = ctx.sent.filter((text) => text.includes("— resume]"));
	assert.equal(resumes.length, 1);
	assert.deepEqual(sendIdsInText(resumes[0] as string), [entry.id]);
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

test("a second failure while a timer is pending schedules no second timer and spends nothing", () => {
	const ctx = laddered();
	const delivery = ctx.fresh();
	ctx.fail(delivery);
	ctx.fail(delivery);
	assert.equal(ctx.sleeps.length, 1);
	assert.equal(ctx.box.get(ctx.entry.id)?.outer_retry_attempts, 1);
});

test("a wake turn that recovers resets the ladder; stale, non-transient and send-owned turns are never nudged", async () => {
	const ctx = laddered();
	const delivery = ctx.fresh();
	const errored = (message: string) => {
		const turn = ctx.turn();
		turn.error = { message };
		return turn;
	};
	assert.equal(delivery.retryWake(errored("503 unavailable"), false, () => undefined), true);
	ctx.sleeps[0]?.release();
	await flush();
	assert.equal(ctx.sent.length, 1);
	assert.equal(delivery.retryWake(ctx.turn(), false, () => undefined), false, "a clean settle is not retried");
	assert.equal(delivery.retryWake(errored("503 unavailable"), false, () => undefined), true);
	ctx.sleeps[1]?.release();
	await flush();
	assert.equal(ctx.sleeps[1]?.ms, OUTER_RETRY_DELAYS_MS[0], "the budget restarted after the clean turn");
	assert.equal(delivery.retryWake(errored("503 unavailable"), true, () => undefined), false, "stale wake");
	assert.equal(delivery.retryWake(errored("401 unauthorized"), false, () => undefined), false, "never-retry error");
	const owned = errored("503 unavailable");
	owned.landed.push({ id: ctx.entry.id, index: 0, assistants: 0 });
	assert.equal(delivery.retryWake(owned, false, () => undefined), false, "a send owns its own error");
	assert.equal(ctx.sleeps.length, 2);
});

test("a send-owned clean turn does not reset the wake budget", async () => {
	const ctx = laddered();
	const delivery = ctx.fresh();
	const errored = () => {
		const turn = ctx.turn();
		turn.error = { message: "503 unavailable" };
		return turn;
	};
	const owned = ctx.turn();
	owned.landed.push({ id: ctx.entry.id, index: 0, assistants: 0 });
	for (let attempt = 0; attempt < OUTER_RETRY_DELAYS_MS.length; attempt++) {
		assert.equal(delivery.retryWake(errored(), false, () => undefined), true);
		ctx.sleeps[attempt]?.release();
		await flush();
		assert.equal(delivery.retryWake(owned, false, () => undefined), false);
	}
	assert.equal(delivery.retryWake(errored(), false, () => undefined), false, "budget spent despite interleaved sends");
});

test("a wake nudge that cannot be sent gives the error relay back to the caller", async () => {
	const ctx = laddered();
	const delivery = ctx.fresh();
	(ctx.proc as unknown as { send: () => Promise<unknown> }).send = async () => ({ receipt: "failed", error: "pipe closed" });
	const gaveUp: string[] = [];
	const turn = ctx.turn();
	turn.error = { message: "503 unavailable" };
	assert.equal(delivery.retryWake(turn, false, () => gaveUp.push("relay")), true);
	ctx.sleeps[0]?.release();
	await flush();
	assert.deepEqual(gaveUp, ["relay"]);
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

/** cp-6fyl B1: a delivery on a movable clock whose parent may be dead (`proc` undefined). */
function swept(proc?: WorkerProcess) {
	let now = new Date("2030-01-01T00:00:00Z");
	const box = new ParentSendOutbox({ file: parentSendFile(join(mkdtempSync(join(tmpdir(), "parent-sweep-")), "cp-parent.jsonl")), now: () => now });
	const relays: BridgeRelay[] = [];
	const delivery = new ParentDelivery(box, { liveProc: () => proc, emit: (relay) => relays.push(relay), sleep: async () => undefined, journal: () => undefined, countTurn: () => undefined });
	return { box, relays, delivery, advance: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
}

// #541 review low: P9f-delivery-cap and P9f-send-reconcile sweep at 11 min and 25 h only; the exact edges stay here,
// verbatim from the deleted unit where it had them (599 s, 24 h + 1 s landed) plus the queued 24 h + 1 s edge.
test("sweep edges: no overdue notice at 599 s, and a landed or queued send ages out only past 24 h", () => {
	const ctx = swept();
	const entry = ctx.box.enqueue("slow");
	ctx.advance(599_000);
	ctx.delivery.sweep(ctx.now());
	assert.equal(ctx.relays.length, 0, "not yet overdue at 599 s");
	ctx.advance(2_000);
	ctx.delivery.sweep(ctx.now());
	assert.equal(ctx.relays.length, 1);
	assert.match(ctx.relays[0]?.text ?? "", new RegExp(`send ${entry.id} still queued after 10 min: parent not running`));

	const aged = swept();
	const queued = aged.box.enqueue("queued");
	const late = aged.box.enqueue("late");
	aged.box.markInjected([late.id]);
	aged.box.markLanded([late.id]);
	aged.advance(24 * 3_600_000);
	aged.delivery.sweep(aged.now());
	assert.deepEqual([aged.box.get(queued.id)?.state, aged.box.get(late.id)?.state], ["queued", "landed"], "exactly 24 h is not stale");
	aged.advance(1_000);
	aged.delivery.sweep(aged.now());
	assert.equal(aged.box.get(late.id)?.state, "undeliverable");
	assert.match(aged.box.get(late.id)?.error ?? "", /no reply within 24 h of landing/);
	assert.equal(aged.box.get(queued.id)?.state, "undeliverable");
	assert.match(aged.box.get(queued.id)?.error ?? "", /^stale: queued /);
});
