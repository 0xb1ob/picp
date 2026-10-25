/**
 * P10f retained, verbatim from tests/answered.test.ts: the answered outbox's send failures, losses, rollbacks,
 * reservations and lock gate. A real parent cannot fail or lose a send on demand; see docs/testing-migration/p10f.md.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AnsweredOutbox, answeredDecision, answeredIdsFromMessage, formatAnsweredNotice } from "../src/answered.ts";
import type { AwaitingWriters } from "./harness/awaiting-resolve.ts";
import { CommandPost } from "../src/command-post.ts";
import { acquireParentLock, holdsParentLock } from "../src/parent-lock.ts";
import type { AnsweredDecision, FleetRecord, RunStatus } from "../src/contracts.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, LAYOUT, SCHEMA_VERSION } from "../src/contracts.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { assembleStatus } from "../src/status.ts";
import { createScratchHome } from "./harness/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One "sent" wake-up: the payload the extension puts on a `cp-answered` message. */
type Sent = AnsweredDecision[];

interface Parent {
	post: CommandPost;
	/** Every wake-up handed to the transport, in order. */
	sent: Sent[];
	/** Every wake-up the parent was observed to receive, in order. */
	arrived: Sent[];
	/** Turn the next N deliveries into failures (no live parent, a failed send). */
	failNext: (times: number) => void;
	/** Accept the send but never let the message reach the parent's context. */
	loseNext: (times: number) => void;
	/** The widget tick / session_start drain, as the extension performs it. */
	drain: () => void;
	writers: AwaitingWriters;
}

/**
 * A stand-in for the parent extension: `onAnswered` drains the outbox and
 * "sends", exactly as `surfaceAnswered` does, and a failed send throws so the
 * queue is left intact.
 *
 * cp-nx7: sending and arriving are two separate facts here, because they are
 * two separate facts in pi — `sendMessage` queues a `followUp` and the message
 * reaches the parent's context on some later turn. `arrive()` plays the
 * extension's `message_start` observer: it reads the ids off the message and
 * confirms them, which is the only thing that stamps `delivered_at`.
 */
function parentOn(home: string): Parent {
	// This object plays the *attached* parent, so it owns the home: consuming the
	// answered outbox (reserving an emission, sending it, stamping an arrival) is
	// gated on the parent lock, and a session that never took it drains nothing
	// (pi-command-post-u9q review). Recording an answer is not gated — see the
	// headless tests below, which enqueue with no lock at all and are delivered by
	// the parent that has one.
	acquireParentLock({ home });
	const sent: Sent[] = [];
	const arrived: Sent[] = [];
	let failures = 0;
	let losses = 0;
	const deliver = (decisions: readonly AnsweredDecision[]): void => {
		if (failures > 0) {
			failures -= 1;
			throw new Error("no live parent");
		}
		sent.push([...decisions]);
		if (losses > 0) {
			losses -= 1;
			return; // pi accepted it; it never reached a turn.
		}
		// The message lands in the parent's context: the extension reads its ids
		// back off the message, exactly as `answeredIdsFromMessage` does.
		const message = {
			customType: "cp-answered",
			content: formatAnsweredNotice(decisions),
			details: { answered: decisions },
		};
		const ids = answeredIdsFromMessage(message);
		arrived.push([...decisions]);
		post.confirmAnswered(ids);
	};
	const drain = (): void => {
		try {
			post.drainAnswered(deliver);
		} catch {
			// The extension swallows too: nothing was marked delivered, so the
			// answer is still queued for the next drain.
		}
	};
	const post = new CommandPost({
		home,
		packageRoot: REPO_ROOT,
		onAnswered: () => drain(),
		// This file is about delivering an answer, not about the merge-ask gate
		// (cp-gmy/cp-1som): its rows are merge asks for jobs no fleet record exists
		// for, which the real gate now defers as ignorance. A hermetic probe keeps
		// the subject of these tests the outbox.
		mergeAsk: async () => ({ action: "raise", ci: "green", reason: "CI green (test fixture)" }),
	});
	const writers: AwaitingWriters = {
		decideCheckpoint: (jobId, approved, by, kind) => {
			// The very call /cp-authorize and /cp-decide make — kind-aware since
			// cp-khf, so a diff answer reaches the diff checkpoint's own file.
			const pipeline = post.pipeline();
			const store = kind === "diff" ? pipeline.diffCheckpoints : pipeline.checkpoints;
			store.decide(jobId, approved, { by });
		},
		answerDeclared: async (item, answer, by) => {
			await post.awaiting.answerResolved(item, { answer, by });
		},
	};
	return {
		post,
		sent,
		arrived,
		drain,
		failNext: (times: number) => {
			failures = times;
		},
		loseNext: (times: number) => {
			losses = times;
		},
		writers,
	};
}


function flat(sent: Sent[]): AnsweredDecision[] {
	return sent.flat();
}

// ---------------------------------------------------------------------------
// Honest degradation
// ---------------------------------------------------------------------------

test("a failed delivery leaves the answer recorded and queued, and the next drain delivers it once", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		parent.failNext(1);
		const item = await parent.post.awaiting.declare({
			type: "approval",
			decision: "ship cp-y?",
			why: "research done",
			blocks: "cp-y",
			job_id: "cp-y",
		});
		await parent.post.awaiting.answer(item.id, { answer: "ship", by: "operator command" });

		assert.deepEqual(parent.sent, [], "the send failed");
		// The answer itself is on the record regardless.
		const stored = JSON.parse(readFileSync(join(home.path, LAYOUT.awaitingFile), "utf8")) as {
			items: { id: string; state: string; answer?: string }[];
		};
		assert.equal(stored.items.find((entry) => entry.id === item.id)?.state, "answered");
		assert.equal(parent.post.answered.pending().length, 1, "still queued: a failed send is not a delivery");

		// The next drain (the widget tick, session_start, the next answer) delivers it.
		parent.drain();
		assert.equal(flat(parent.sent).length, 1);
		assert.equal(flat(parent.arrived).length, 1);
		assert.deepEqual(parent.post.answered.pending(), [], "observed arrival is what clears the queue");

		// And never again.
		assert.deepEqual(
			parent.post.drainAnswered(() => {
				throw new Error("drained twice");
			}),
			[],
		);
	} finally {
		home.cleanup();
	}
});

test("a wake-up that never reaches the parent stays pending, is not marked delivered, and is retried", () => {
	const home = createScratchHome();
	try {
		// The outbox on its own, with time injected: pi accepted the send, the
		// message never reached a turn.
		let now = new Date("2026-08-31T12:49:23Z");
		const outbox = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		const decision = answeredDecision({
			id: "aw-4f5fc3f64b",
			type: "approval",
			job_id: "cp-44",
			decision: "Merge PR #44",
			answer: "yes",
			answered_by: "operator dialog (tui)",
			answered_at: "2026-08-31T12:49:23Z",
		});
		assert.equal(outbox.enqueue(decision), true);

		const sends: string[][] = [];
		const send = (decisions: readonly AnsweredDecision[]): void => {
			sends.push(decisions.map((entry) => entry.id));
		};
		outbox.drain(send);
		assert.deepEqual(sends, [["aw-4f5fc3f64b"]], "sent once");
		assert.equal(outbox.delivered("aw-4f5fc3f64b"), false, "a send is not evidence of arrival");
		assert.equal(outbox.pending().length, 1, "still pending, because nobody was observed receiving it");

		// A tick a second later must not re-send: the message may simply be queued.
		now = new Date("2026-08-31T12:49:24Z");
		outbox.drain(send);
		assert.equal(sends.length, 1, "an in-flight wake-up is left alone inside the retry window");
		assert.equal(outbox.stats().in_flight, 1);

		// Past the window it goes out again: a duplicate wake-up beats a lost one.
		now = new Date("2026-08-31T12:53:23Z");
		outbox.drain(send);
		assert.deepEqual(sends, [["aw-4f5fc3f64b"], ["aw-4f5fc3f64b"]], "retried");
		assert.equal(outbox.delivered("aw-4f5fc3f64b"), false, "still not delivered");
		const stats = outbox.stats();
		assert.equal(stats.pending, 1);
		assert.equal(stats.oldest_pending_age_seconds, 240, "the lag is measurable instead of deniable");

		// The retry arrives; only now is it delivered, exactly once.
		assert.deepEqual(outbox.confirmDelivered(["aw-4f5fc3f64b"]), ["aw-4f5fc3f64b"]);
		assert.equal(outbox.delivered("aw-4f5fc3f64b"), true);
		assert.deepEqual(outbox.pending(), []);
		assert.deepEqual(outbox.confirmDelivered(["aw-4f5fc3f64b"]), [], "confirming twice is a no-op");
		outbox.drain(send);
		assert.equal(sends.length, 2, "a delivered answer is never sent again");
	} finally {
		home.cleanup();
	}
});

test("cp-5mgg: a later answer never drags an in-flight one out again, and the in-flight one stays pending", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		parent.loseNext(1);
		const item = await parent.post.awaiting.declare({
			type: "approval",
			decision: "Merge PR #48",
			why: "green",
			blocks: "cp-48",
			job_id: "cp-48",
		});
		await parent.post.awaiting.answer(item.id, { answer: "yes", by: "operator dialog (tui)" });
		assert.equal(parent.sent.length, 1, "sent");
		assert.deepEqual(parent.arrived, [], "never arrived");
		assert.equal(parent.post.answered.pending().length, 1, "so it is still pending");
		assert.equal(parent.post.answered.delivered(item.id), false);

		// A second answer three seconds later. Before cp-5mgg it re-sent the whole
		// pending queue, so the first answer was emitted twice inside its own retry
		// window — the bundled-then-solo pattern the parent was woken by three
		// times. A window that is ignored whenever anything else is due is not a
		// window; the in-flight answer is left alone until it expires.
		const other = await parent.post.awaiting.declare({
			type: "design",
			decision: "one queue or two?",
			why: "affects dispatch",
			blocks: "cp-q",
		});
		await parent.post.awaiting.answer(other.id, { answer: "one", by: "operator command" });
		assert.deepEqual(
			flat(parent.arrived).map((decision) => decision.id),
			[other.id],
			"only the answer that is due travels; the in-flight one is not repeated",
		);
		assert.deepEqual(
			parent.post.answered.pending().map((decision) => decision.id),
			[item.id],
			"and it is not lost either: still queued, still owed a delivery",
		);
		assert.equal(
			parent.post.answered.sends().find((entry) => entry.id === item.id)?.attempts,
			1,
			"one emission on the record, written before the message went out",
		);
		// Its own retry window is what delivers it, and the outbox-level test above
		// ("never reaches the parent … and is retried") is where that clock lives.
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// cp-5mgg: one answer, one delivery — the replay, and what stops it
// ---------------------------------------------------------------------------

/** The incident's own decision: a merge authorization, scoped to a head sha. */
function mergeAuthorization(): AnsweredDecision {
	return answeredDecision({
		id: "aw-checkpoint-cp-ehsc.merge-f7b8769f0606",
		type: "authorization",
		job_id: "cp-ehsc",
		decision: "merge PR #57 at f7b8769f0606?",
		answer: "approved",
		answered_by: "operator dialog (tui)",
		answered_at: "2026-09-01T15:10:09Z",
	});
}

test("cp-5mgg: the emission is recorded on disk before it is sent, so one session cannot repeat it", () => {
	const home = createScratchHome();
	try {
		let now = new Date("2026-09-01T15:10:09Z");
		const outbox = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		const decision = mergeAuthorization();
		outbox.enqueue(decision);

		const sends: string[][] = [];
		const send = (decisions: readonly AnsweredDecision[]): void => {
			sends.push(decisions.map((entry) => entry.id));
		};
		// The send is never confirmed: the parent was mid-turn and the message sat
		// in pi's followUp queue, which is exactly when the replays happened.
		outbox.drain(send);
		const stored = JSON.parse(readFileSync(join(home.path, LAYOUT.answeredFile), "utf8")) as {
			sends?: { id: string; attempts: number; sent_at: string }[];
		};
		assert.deepEqual(
			(stored.sends ?? []).map((entry) => [entry.id, entry.attempts]),
			[[decision.id, 1]],
			"the emission is a fact on disk, not a fact in one process's memory",
		);

		// Another drain of the same parent three seconds later, reading its own
		// record back off disk rather than out of memory. (A drain by a *different*
		// process is the opposite case and is due at once — pi-command-post-u9q
		// below: a dead session's reservation is not the successor's.)
		now = new Date("2026-09-01T15:10:12Z");
		const restarted = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		assert.deepEqual(restarted.drain(send), [], "still inside its retry window, on disk");
		assert.equal(sends.length, 1);
		assert.equal(restarted.stats().in_flight, 1, "and it is visible as owed, not forgotten");

		// Past the window it goes out once more — at most once per window, forever
		// bounded, never a burst.
		now = new Date("2026-09-01T15:13:00Z");
		restarted.drain(send);
		assert.deepEqual(sends, [[decision.id], [decision.id]], "re-delivered at most once per window");
		assert.equal(restarted.stats().attempts, 2, "and both emissions are on the record");
	} finally {
		home.cleanup();
	}
});

test("cp-5mgg: an emission interrupted before its mark landed is still delivered", () => {
	const home = createScratchHome();
	try {
		const now = new Date("2026-09-01T15:10:09Z");
		const crashed = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		const decision = mergeAuthorization();
		crashed.enqueue(decision);
		// The process died between the answer being queued and anything being sent:
		// no emission record, so the answer is due the moment a parent is live.
		const sends: string[][] = [];
		const send = (decisions: readonly AnsweredDecision[]): void => {
			sends.push(decisions.map((entry) => entry.id));
		};
		const restarted = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		assert.deepEqual(restarted.drain(send), [decision], "an unemitted answer is never stranded by a crash");

		// And the other interruption: a send that throws is *observed* non-delivery,
		// so its record is rolled back and the answer is due again at once rather
		// than waiting out a window it never earned.
		const other = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		other.confirmDelivered([decision.id]);
		other.enqueue(
			answeredDecision({
				id: "aw-ae4f05546e",
				type: "approval",
				job_id: "cp-42",
				decision: "ship, drop or follow-up?",
				answer: "ship",
				answered_by: "operator dialog (tui)",
				answered_at: "2026-09-01T15:10:06Z",
			}),
		);
		assert.throws(() =>
			other.drain(() => {
				throw new Error("no live parent");
			}),
		);
		assert.deepEqual(other.sends(), [], "a throw is proof nothing was emitted");
		assert.deepEqual(
			other.drain(send).map((entry) => entry.id),
			["aw-ae4f05546e"],
			"so the very next drain delivers it, with no window to wait out",
		);
	} finally {
		home.cleanup();
	}
});

test("cp-5mgg: a rolled-back emission undoes only what that drain recorded", () => {
	const home = createScratchHome();
	try {
		let now = new Date("2026-09-01T15:10:09Z");
		const outbox = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		const merge = mergeAuthorization();
		const research = answeredDecision({
			id: "aw-ae4f05546e",
			type: "approval",
			job_id: "cp-42",
			decision: "ship, drop or follow-up?",
			answer: "ship",
			answered_by: "operator dialog (tui)",
			answered_at: "2026-09-01T15:10:06Z",
		});
		outbox.enqueue(merge);
		outbox.drain(() => {});
		const emitted = outbox.sends();
		assert.deepEqual(emitted.map((entry) => [entry.id, entry.attempts]), [[merge.id, 1]]);

		// Past the window, so the merge answer is due again. Its send throws — but
		// `send` is arbitrary caller code, and this one records an emission of its
		// own first (the extension's drain is re-entrant through `onAnswered`).
		// Rolling back to a snapshot of the whole array would erase that record;
		// only the ids this drain wrote may be undone.
		now = new Date("2026-09-01T15:13:00Z");
		assert.throws(() =>
			outbox.drain(() => {
				outbox.enqueue(research);
				outbox.drain(() => {});
				throw new Error("no live parent");
			}),
		);
		assert.deepEqual(
			outbox.sends().map((entry) => [entry.id, entry.attempts, entry.sent_at]),
			[
				[research.id, 1, "2026-09-01T15:13:00Z"],
				[merge.id, emitted[0]?.attempts, emitted[0]?.sent_at],
			],
			"the nested emission survives untouched, and the thrown one is back to exactly what it was",
		);
		// A restored record is always an expired one — a record inside its window
		// would not have been drained — so "due again at once" survives the undo.
		assert.deepEqual(
			outbox.drain(() => {}).map((entry) => entry.id),
			[merge.id],
			"due, and alone: the nested emission is still inside its own window",
		);
	} finally {
		home.cleanup();
	}
});

test("cp-5mgg: in flight means emitted and not yet due again, never merely emitted", () => {
	const home = createScratchHome();
	try {
		let now = new Date("2026-09-01T15:10:09Z");
		const outbox = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		outbox.enqueue(mergeAuthorization());
		assert.equal(outbox.stats().in_flight, 0, "queued is not in flight");
		outbox.drain(() => {});
		assert.equal(outbox.stats().in_flight, 1, "emitted, waiting on evidence of arrival");
		now = new Date("2026-09-01T15:13:00Z");
		const stats = outbox.stats();
		assert.equal(stats.in_flight, 0, "past its window it is due again, and due is not in flight");
		assert.equal(stats.pending, 1, "still owed a delivery, and still visible as owed");
		assert.equal(stats.attempts, 1, "the emission stays on the record");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// A dead session's reservation is not this session's (pi-command-post-u9q)
// ---------------------------------------------------------------------------

/** One fleet record whose worker is gone — the fleet the restarted parent finds. */
function deadWorkerRecord(jobId: string): FleetRecord {
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worktree: "/tmp/demo",
		branch: jobId,
		dispatched_at: "2026-09-06T15:30:00Z",
		usage: EMPTY_USAGE,
		worker: {
			pid: 4242,
			session_id: "sess-dead",
			session_file: "/sessions/dead.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-09-06T15:30:00Z",
		},
	} as FleetRecord;
}

/** The two sessions this bug is about: one that died, and the one that follows it. */
const DEAD_SESSION = "4242.deadbeef";
const NEW_SESSION = "4243.0ff1ce00";

/**
 * The outbox a parent left behind when it died. Written as a file rather than
 * produced by an `AnsweredOutbox` in this process, because that is what a crash
 * leaves: bytes on disk, and no process to ask.
 */
function crashedOutbox(
	home: string,
	contents: { pending?: AnsweredDecision[]; sends?: { id: string; sent_at: string; attempts: number; owner?: string }[]; delivered?: { id: string; delivered_at: string }[] },
): void {
	const file = join(home, LAYOUT.answeredFile);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: "2026-09-06T15:37:50Z",
			pending: contents.pending ?? [],
			...(contents.sends ? { sends: contents.sends } : {}),
			delivered: contents.delivered ?? [],
		}),
	);
}

test("u9q: the session that made the send keeps its reservation — no duplicate for a live parent", () => {
	const home = createScratchHome();
	try {
		let now = new Date("2026-09-06T15:37:50Z");
		// One process, and the second `session_start` a reload performs: the owner
		// is the process, not the session file, so its own in-flight emission is
		// still in flight and is not sent twice.
		const live = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: NEW_SESSION });
		const decision = mergeAuthorization();
		live.enqueue(decision);
		const sends: string[][] = [];
		const send = (decisions: readonly AnsweredDecision[]): void => {
			sends.push(decisions.map((entry) => entry.id));
		};
		live.drain(send);
		now = new Date("2026-09-06T15:37:52Z");
		const reloaded = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: NEW_SESSION });
		reloaded.drain(send);
		assert.deepEqual(sends, [[decision.id]], "one emission, however many times this process starts a session");

		// And once it has arrived, no later drain of any session can repeat it.
		reloaded.confirmDelivered([decision.id]);
		now = new Date("2026-09-06T15:45:00Z");
		const next = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: "4244.beefcafe" });
		next.drain(() => assert.fail("a delivered answer must never be replayed"));
		assert.deepEqual(sends, [[decision.id]]);
	} finally {
		home.cleanup();
	}
});

test("u9q: with no owner injected, two outboxes in one process share it and do not re-emit inside the window", async () => {
	const home = createScratchHome();
	try {
		// The production configuration: nobody passes `owner`, so both instances
		// fall back to the module-level `PROCESS_OWNER`. This is the duplicate risk
		// the ownership rule creates — an owner that were per *instance* (or
		// re-randomised per construction) would make every widget tick, every
		// `session_start` and every `new CommandPost` a fresh emitter, and cp-5mgg's
		// window would stop bounding anything at all.
		let now = new Date("2026-09-06T15:37:50Z");
		const decision = mergeAuthorization();
		const first = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		first.enqueue(decision);
		const sends: string[][] = [];
		const send = (decisions: readonly AnsweredDecision[]): void => {
			sends.push(decisions.map((entry) => entry.id));
		};
		first.drain(send);

		const owner = first.sends()[0]?.owner;
		assert.ok(owner, "an emission always records who made it");
		assert.match(owner, new RegExp(`^${process.pid}\\.[0-9a-f]{8}$`), "and it names this process");

		// Every other construction site in one process: the widget tick's read, a
		// second `CommandPost`, the extension's re-entrant drain.
		for (let tick = 0; tick < 4; tick += 1) {
			now = new Date(now.getTime() + 20_000); // still inside the 120s window
			const again = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
			assert.equal(again.sends()[0]?.owner, owner, "the owner is per process, not per instance");
			assert.equal(again.stats().in_flight, 1, "this parent's own emission is still in flight for it");
			assert.deepEqual(again.drain(send), [], "so it is not due, and nothing is emitted twice");
		}
		assert.deepEqual(sends, [[decision.id]], "one emission per window, however many outboxes this process builds");

		// Past the window the same process retries — once, as cp-5mgg requires — and
		// the reclaim rule has not turned that into a burst.
		now = new Date("2026-09-06T15:40:00Z");
		const later = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		later.drain(send);
		assert.deepEqual(sends, [[decision.id], [decision.id]], "re-delivered at most once per window");
		assert.equal(later.sends()[0]?.attempts, 2);

		// A *second instance of the module* in the same process is still the same
		// process: the owner is anchored on globalThis precisely so a duplicate
		// import cannot mint a second emitter and re-emit inside the window.
		// The query suffix is what makes it a second instance; it is built at runtime
		// so this stays one module as far as the type checker is concerned.
		const duplicateSpecifier = `${new URL("../src/answered.ts", import.meta.url).href}?duplicate-module`;
		const { AnsweredOutbox: Duplicate } = (await import(duplicateSpecifier)) as {
			AnsweredOutbox: typeof AnsweredOutbox;
		};
		const duplicate = new Duplicate({ home: home.path, now: () => now, retrySeconds: 120 });
		assert.equal(duplicate.sends()[0]?.owner, owner, "one owner per process, not per module instance");
		assert.deepEqual(duplicate.drain(send), [], "so a second copy of this module cannot re-emit inside the window");

		// And the reclaim still fires for a record this process did not write.
		const successor = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: NEW_SESSION });
		assert.deepEqual(
			successor.drain(send).map((entry) => entry.id),
			[decision.id],
			"a different process is a different owner, and inherits nothing",
		);
	} finally {
		home.cleanup();
	}
});

test("u9q review: a lock-refused session consumes nothing from the outbox, and the owner still delivers once", async () => {
	const home = createScratchHome();
	try {
		// The attached parent, which took the home at `session_start`.
		const owner = parentOn(home.path);

		// A second session on the same home: `/cp-decide` in a `pi -p` re-entry, a
		// second TUI, a headless `/cp-authorize`. Its acquisition is **refused** —
		// that is the premise, asserted rather than assumed — so it owns nothing and
		// may consume nothing. It is played by a second pid because in one process a
		// second acquisition is re-entrant, not a second parent.
		const SECOND_PID = 999_999;
		const refused = acquireParentLock({ home: home.path, pid: SECOND_PID, isPidAlive: () => true });
		assert.equal(refused.ok, false, "the second session must be refused for this test to mean anything");
		assert.equal(holdsParentLock({ home: home.path, pid: SECOND_PID }), false);

		const strayDrains: Sent[] = [];
		const secondary = new CommandPost({
			home: home.path,
			packageRoot: REPO_ROOT,
			holdsParentLock: () => holdsParentLock({ home: home.path, pid: SECOND_PID }),
			// Its own `surfaceAnswered`: the answer trigger, the widget tick and
			// `session_start` all land here.
			onAnswered: () => {
				secondary.drainAnswered((decisions) => strayDrains.push([...decisions]));
			},
			mergeAsk: async () => ({ action: "raise", ci: "green", reason: "CI green (test fixture)" }),
		});

		// The manual surfaces, driven exactly as the slash commands drive them:
		// `/cp-authorize` (CheckpointStore.decide) and `/cp-decide` on a declared row
		// (AwaitingStore.answer). Both are single-writer paths and both still record.
		secondary.checkpoints.request({ jobId: "cp-ship", question: "ship the plan?" });
		secondary.checkpoints.decide("cp-ship", true, { by: "operator command" });
		const row = await secondary.awaiting.declare({
			type: "design",
			decision: "postgres or sqlite?",
			why: "schema choice",
			blocks: "cp-db",
			job_id: "cp-db",
		});
		await secondary.awaiting.answer(row.id, { answer: "sqlite", by: "operator command" });

		// The answers are durable — the gate is on consuming, never on recording,
		// because a decision a human gave must survive whoever heard it.
		const queued = secondary.answered.pending().map((decision) => decision.id);
		assert.equal(queued.length, 2, `both answers are queued: ${JSON.stringify(queued)}`);
		assert.equal(secondary.checkpoints.get("cp-ship")?.decision, "approved", "and the checkpoint's own record stands");

		// Nothing this session did may have touched the outbox's consumption side.
		// `updated_at` is stamped by every mutation, so the file's bytes are the
		// assertion: reserve, emit and acknowledge are all the owner's.
		const file = join(home.path, LAYOUT.answeredFile);
		const before = readFileSync(file, "utf8");
		assert.deepEqual(strayDrains, [], "a lock-refused session emits nothing, on any of its triggers");
		assert.deepEqual(secondary.drainAnswered(() => assert.fail("a widget tick must not emit either")), []);
		assert.deepEqual(secondary.confirmAnswered(queued), [], "and it cannot acknowledge an arrival it never had");
		assert.equal(readFileSync(file, "utf8"), before, "not one byte of the outbox moved");
		assert.deepEqual(secondary.answered.sends(), [], "no reservation was made");
		assert.deepEqual(secondary.answered.pending().map((decision) => decision.id), queued, "and nothing was consumed");

		// The owner — same home, same answers — delivers both, exactly once.
		owner.drain();
		assert.deepEqual(flat(owner.sent).map((decision) => decision.id).sort(), [...queued].sort());
		assert.deepEqual(flat(owner.arrived).map((decision) => decision.id).sort(), [...queued].sort());
		assert.deepEqual(owner.post.answered.pending(), [], "nothing is owed once the owner was observed to receive it");
		owner.drain();
		assert.equal(flat(owner.sent).length, 2, "and no later drain repeats it");
		for (const id of queued) assert.equal(owner.post.answered.delivered(id), true);
	} finally {
		home.cleanup();
	}
});

test("u9q: a send reservation is not a working parent — the fleet's working count reads liveness", () => {
	const home = createScratchHome();
	try {
		// The other half of the report: the session *looked* busy. Nothing in the
		// rendered fleet state reads this outbox — `working` is an alive worker with
		// a `working` run phase, and `StatusFacts` has no outbox in it at all — so a
		// reservation a dead session left behind can never present as work in
		// progress. This is the regression test for wiring one in.
		const decision = mergeAuthorization();
		crashedOutbox(home.path, {
			pending: [decision],
			sends: [{ id: decision.id, sent_at: "2026-09-06T15:37:50Z", attempts: 1, owner: DEAD_SESSION }],
		});
		const snapshot = assembleStatus({
			home: home.path,
			generated_at: "2026-09-06T15:37:52Z",
			include: "active",
			records: [deadWorkerRecord("cp-ship")],
			runs: new Map([["cp-ship", { ...initialStatus("cp-ship"), phase: "working" } as RunStatus]]),
			alive: new Map([["cp-ship", false]]),
			ledger: { ok: true, queried: false },
		});
		assert.equal(snapshot.counts.working, 0, "a dead worker is not working, whatever the outbox reserved");
		assert.equal(snapshot.counts.live, 0);

		const now = new Date("2026-09-06T15:37:52Z");
		const restarted = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: NEW_SESSION });
		assert.equal(restarted.stats().in_flight, 0, "and the one in-flight number this home computes is per parent");
	} finally {
		home.cleanup();
	}
});

test("the arrival observer reads ids off the message, and only off a cp-answered one", () => {
	const decisions = [
		answeredDecision({
			id: "aw-4f5fc3f64b",
			type: "approval",
			decision: "Merge PR #44",
			answer: "yes",
			answered_by: "operator dialog (tui)",
			answered_at: "2026-08-31T12:49:23Z",
		}),
	];
	assert.deepEqual(
		answeredIdsFromMessage({ customType: "cp-answered", content: "x", details: { answered: decisions } }),
		["aw-4f5fc3f64b"],
	);
	assert.deepEqual(
		answeredIdsFromMessage({ customType: "cp-answered", content: formatAnsweredNotice(decisions) }),
		["aw-4f5fc3f64b"],
		"a payload that lost its details still names every id in the notice",
	);
	assert.deepEqual(
		answeredIdsFromMessage({ customType: "cp-envelope", details: { answered: decisions } }),
		[],
		"another message type is never evidence for this one",
	);
	assert.deepEqual(answeredIdsFromMessage(undefined), []);
});

