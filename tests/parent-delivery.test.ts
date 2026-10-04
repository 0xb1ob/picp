/**
 * Parent delivery (src/parent-delivery.ts) against a scripted parent process:
 * the post-restart reconcile races, and turn-failure accounting for sends
 * whose outcome arrives after their tool result.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanSegmentEnd, wakeSpans } from "../src/bridge-segments.ts";
import type { BridgeRelay } from "../src/cp-bridge.ts";
import { type LandedTurn, ParentDelivery } from "../src/parent-delivery.ts";
import { frameBatch, frameResume, parentSendFile, ParentSendOutbox, sendIdsInText, sharedReplyPointer } from "../src/parent-outbox.ts";
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

/** A lands, the parent answers it only with tool calls (optionally with commentary), B steers in, then one finished answer. */
async function interleaved(commentary?: string) {
	const ctx = scripted();
	const a = ctx.delivery.send("A", 60_000);
	const b = ctx.delivery.send("B", 60_000);
	await flush();
	const turn = ctx.turn();
	ctx.delivery.landed(ctx.sent[0] as string, turn);
	if (commentary) turn.texts.push(commentary);
	turn.assistantCount += 1; // the tool-use message
	ctx.delivery.landed(ctx.sent[1] as string, turn);
	turn.texts.push("Answer B.");
	turn.assistantCount += 1;
	ctx.delivery.segmentEnd(turn);
	const [first, second] = [await a, await b];
	assert.deepEqual(ctx.counted, [false, false]);
	const relays = ctx.relays.length;
	ctx.delivery.settle(turn);
	assert.deepEqual(ctx.counted, [false, false], "settle adds nothing after segmentEnd");
	assert.equal(ctx.relays.length, relays);
	return { first, second };
}

test("a send answered only by tool calls is not settled empty by a later send's answer", async () => {
	const { first, second } = await interleaved();
	assert.equal(first.level, "owner_observed");
	assert.equal(first.reply, "Answer B.");
	assert.equal(second.level, "owner_observed");
	assert.equal(second.reply, sharedReplyPointer(first.send_id as string), "one answer, one copy: B points at A");
});

test("an interleaved send's reply keeps its own commentary and shares the next finished answer", async () => {
	const { first, second } = await interleaved("Checking A now.");
	assert.equal(first.reply, "Checking A now.\nAnswer B.");
	assert.equal(second.reply, sharedReplyPointer(first.send_id as string));
});

test("unload-parent PR3: 12 sends absorbed into one span get one full reply and 11 pointers, each settled once", async () => {
	const ctx = scripted();
	const entries = Array.from({ length: 12 }, (_, n) => ctx.box.enqueue(`SYNTH-SEND ${n}`));
	const turn = ctx.turn();
	ctx.delivery.landed(frameBatch(entries), turn);
	turn.texts.push("One answer to all twelve.");
	turn.assistantCount += 1;
	ctx.delivery.segmentEnd(turn);
	ctx.delivery.settle(turn);
	const [lead, ...rest] = entries.map((entry) => entry.id);
	assert.deepEqual(
		ctx.relays.map((relay) => [relay.sendId, relay.text]),
		[[lead, "One answer to all twelve."], ...rest.map((id) => [id, sharedReplyPointer(lead as string)])],
	);
	assert.equal(ctx.relays.filter((relay) => relay.text.includes("One answer")).length, 1, "the answer text is relayed once");
	assert.deepEqual(ctx.counted, Array(12).fill(false), "each send settles and counts exactly once");
	assert.ok(ctx.box.list().every((entry) => entry.state === "settled"));
});

test("an interleaved send gets the run's error when no answer finished", async () => {
	const ctx = scripted();
	void ctx.delivery.send("A", 10);
	void ctx.delivery.send("B", 10);
	await flush();
	const turn = ctx.turn();
	ctx.delivery.landed(ctx.sent[0] as string, turn);
	turn.assistantCount += 1;
	ctx.delivery.landed(ctx.sent[1] as string, turn);
	turn.assistantCount += 1;
	turn.error = { message: "usage limit reached" };
	ctx.delivery.settle(turn);
	assert.deepEqual(
		ctx.box.list().map((entry) => entry.state),
		["failed", "failed"],
	);
	assert.deepEqual(ctx.counted, [true, true]);
	assert.deepEqual(ctx.slept, [], "a non-transient run error never sleeps for a resume");
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

test("N5: a successor whose transcript already holds an id's resume line does not nudge it again; an empty transcript still nudges once", async () => {
	const ctx = scripted();
	const done = ctx.box.enqueue("D");
	ctx.box.markInjected([done.id]);
	ctx.box.markLanded([done.id]);
	const fresh = ctx.box.enqueue("F");
	ctx.box.markInjected([fresh.id]);
	ctx.box.markLanded([fresh.id]);
	const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
	// A predecessor nudged D (its frameResume line is in the transcript); F only has its delivery marker.
	const ready = ctx.delivery.afterReady(ctx.proc);
	ctx.answer({ entries: [user(frameBatch([fresh])), user(frameResume([done.id]))], dropped: 0 });
	await ready;
	const resumes = ctx.sent.filter((text) => text.includes("— resume]"));
	assert.equal(resumes.length, 1);
	assert.deepEqual(sendIdsInText(resumes[0] as string), [fresh.id], "D's resume line is already in the transcript");
	// A third process with an empty transcript window: F (and D) have no resume line there, so each is nudged once.
	ctx.delivery.failWaiters();
	ctx.sent.length = 0;
	const again = ctx.delivery.afterReady(ctx.proc);
	ctx.answer({ entries: [], dropped: 0 });
	await again;
	assert.deepEqual(ctx.sent.filter((text) => text.includes("— resume]")).map((text) => sendIdsInText(text)), [[done.id, fresh.id]]);
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

test("the transient retry budget is on disk: a restarted delivery continues at the next ordinal and delay", async () => {
	const ctx = laddered(2);
	const delivery = ctx.fresh();
	ctx.fail(delivery);
	assert.deepEqual(ctx.sleeps.map((sleep) => sleep.ms), [OUTER_RETRY_DELAYS_MS[2]]);
	assert.equal(ctx.journal[0]?.payload.attempt, 3);
	assert.equal(ctx.box.get(ctx.entry.id)?.outer_retry_attempts, 3, "reserved before the sleep");
	ctx.sleeps[0]?.release();
	await flush();
	assert.equal(ctx.sent.length, 1, "one nudge, never the original body");
	assert.match(ctx.sent[0] as string, /previous turn failed/);
	assert.equal(ctx.box.get(ctx.entry.id)?.attempts, 1, "injection attempts untouched");
});

test("a death mid-sleep keeps the reservation spent; the stale timer sends nothing and the next failure takes the next ordinal", async () => {
	const ctx = laddered();
	const delivery = ctx.fresh();
	ctx.fail(delivery);
	delivery.failWaiters();
	ctx.sleeps[0]?.release();
	await flush();
	assert.deepEqual(ctx.sent, [], "an obsolete timer sends nothing");
	assert.equal(ctx.box.get(ctx.entry.id)?.outer_retry_attempts, 1);
	ctx.fail(delivery);
	assert.deepEqual(ctx.sleeps.map((sleep) => sleep.ms), [OUTER_RETRY_DELAYS_MS[0], OUTER_RETRY_DELAYS_MS[1]]);
});

test("a second failure while a timer is pending schedules no second timer and spends nothing", () => {
	const ctx = laddered();
	const delivery = ctx.fresh();
	ctx.fail(delivery);
	ctx.fail(delivery);
	assert.equal(ctx.sleeps.length, 1);
	assert.equal(ctx.box.get(ctx.entry.id)?.outer_retry_attempts, 1);
});

test("a spent budget fails the send once: final receipt, no timer, exhausted journaled", () => {
	const ctx = laddered(5);
	const delivery = ctx.fresh();
	ctx.fail(delivery);
	assert.deepEqual(ctx.sleeps, []);
	assert.equal(ctx.box.get(ctx.entry.id)?.state, "failed");
	assert.equal(ctx.box.get(ctx.entry.id)?.outer_retry_attempts, 5, "terminal record keeps the count");
	assert.deepEqual(ctx.journal.map((line) => line.event), ["outer_retry_exhausted"]);
	assert.equal(ctx.journal[0]?.payload.attempts, 5);
	assert.deepEqual(ctx.counted, [true]);
	assert.deepEqual(ctx.relays.map((relay) => relay.sendId), [ctx.entry.id]);
});

test("a success after retries journals the persisted count", () => {
	const ctx = laddered(2);
	const delivery = ctx.fresh();
	const turn = ctx.turn();
	delivery.landed(frameBatch([ctx.entry]), turn);
	turn.texts.push("done");
	turn.assistantCount += 1;
	delivery.settle(turn);
	assert.deepEqual(ctx.journal.map((line) => [line.event, line.payload.afterAttempts]), [["outer_retry_succeeded", 2]]);
	assert.equal(ctx.box.get(ctx.entry.id)?.outer_retry_attempts, 2);
});

test("a reservation that cannot be written is named, schedules no retry and fails the send", () => {
	const ctx = laddered();
	const delivery = ctx.fresh();
	const turn = ctx.turn();
	delivery.landed(frameBatch([ctx.entry]), turn);
	turn.error = { message: "503 service unavailable" };
	writeFileSync(ctx.box.file, "not json", "utf8");
	delivery.settle(turn);
	assert.deepEqual(ctx.sleeps, []);
	assert.deepEqual(ctx.journal.map((line) => line.event), ["outer_retry_reservation_failed"]);
	assert.equal(ctx.journal[0]?.payload.send_id, ctx.entry.id);
	assert.deepEqual(ctx.counted, [true], "failed once, volatile retrying never takes over");
});

/** cp-6fyl B1: a delivery on a movable clock whose parent may be dead (`proc` undefined). */
function swept(proc?: WorkerProcess) {
	let now = new Date("2030-01-01T00:00:00Z");
	const box = new ParentSendOutbox({ file: parentSendFile(join(mkdtempSync(join(tmpdir(), "parent-sweep-")), "cp-parent.jsonl")), now: () => now });
	const relays: BridgeRelay[] = [];
	const delivery = new ParentDelivery(box, { liveProc: () => proc, emit: (relay) => relays.push(relay), sleep: async () => undefined, journal: () => undefined, countTurn: () => undefined });
	return { box, relays, delivery, advance: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
}

test("sweep with no live parent expires a 25 h queued send and relays it undeliverable", () => {
	const ctx = swept();
	const entry = ctx.box.enqueue("old");
	ctx.advance(25 * 3_600_000);
	ctx.delivery.sweep(ctx.now());
	assert.equal(ctx.box.get(entry.id)?.state, "undeliverable");
	const outcome = ctx.relays.find((relay) => relay.kind === "send");
	assert.equal(outcome?.sendId, entry.id);
	assert.match(outcome?.text ?? "", /was not delivered \(stale: queued/);
});

test("a send open past 600 s gets exactly one notice, persisted as pending_notice_at", () => {
	const ctx = swept();
	const entry = ctx.box.enqueue("slow");
	ctx.advance(599_000);
	ctx.delivery.sweep(ctx.now());
	assert.equal(ctx.relays.length, 0, "not yet overdue at 599 s");
	ctx.advance(2_000);
	ctx.delivery.sweep(ctx.now());
	assert.equal(ctx.relays.length, 1);
	assert.equal(ctx.relays[0]?.kind, "error");
	assert.match(ctx.relays[0]?.text ?? "", new RegExp(`send ${entry.id} still queued after 10 min: parent not running`));
	assert.ok(ctx.box.get(entry.id)?.pending_notice_at);
	ctx.advance(60_000);
	ctx.delivery.sweep(ctx.now());
	assert.equal(ctx.relays.length, 1, "a second sweep emits nothing");
	assert.equal(ctx.box.markPendingNotice(entry.id), false, "idempotent");
});

test("a landed send with no reply 24 h after landing ends undeliverable; stop retires a landed send", () => {
	const ctx = swept();
	const late = ctx.box.enqueue("late");
	ctx.box.markInjected([late.id]);
	ctx.box.markLanded([late.id]);
	ctx.advance(24 * 3_600_000 + 1_000);
	ctx.delivery.sweep(ctx.now());
	assert.equal(ctx.box.get(late.id)?.state, "undeliverable");
	assert.match(ctx.box.get(late.id)?.error ?? "", /no reply within 24 h of landing/);
	const stopped = ctx.box.enqueue("stopped");
	ctx.box.markInjected([stopped.id]);
	ctx.box.markLanded([stopped.id]);
	ctx.delivery.discardUnlanded("parent stopped by the operator");
	assert.equal(ctx.box.get(stopped.id)?.state, "undeliverable");
	assert.equal(ctx.box.get(stopped.id)?.error, "parent stopped before replying");
	assert.ok(ctx.relays.some((relay) => relay.sendId === stopped.id));
});
