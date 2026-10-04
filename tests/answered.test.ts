/**
 * cp-answer-doesnt-wake acceptance: an answered decision wakes the parent, the
 * same way a report (`cp-envelope`) and a wedged tool call (`cp-wedged`)
 * already do — once per answer, from every source of an answer, and never
 * replayed after a restart.
 *
 * The delivery channel (`pi.sendMessage`) is the extension's; everything below
 * it is hermetic and dependency-injected: `CommandPost`'s `onAnswered` plays
 * the part the extension plays (drain the outbox, "send", record what was
 * sent), so these tests prove the wiring the parent actually depends on
 * without a pi session.
 *
 * `node --test tests/answered.test.ts`
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	AnsweredOutbox,
	answeredDecision,
	answeredIdsFromMessage,
	AnsweredError,
	formatAnsweredNotice,
} from "../src/answered.ts";
import { deriveFromCheckpoints, deriveFromHeldResearch, type ResolvedAwaitingItem } from "../src/awaiting.ts";
import { type AwaitingWriters, resolveAwaitingResponse } from "./harness/awaiting-resolve.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { CommandPost } from "../src/command-post.ts";
import { acquireParentLock, holdsParentLock } from "../src/parent-lock.ts";
import type { AnsweredDecision, FleetRecord, RunStatus, StatusJob } from "../src/contracts.ts";
import { checkpointAwaitingId, DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, SCHEMA_VERSION, validateAnsweredOutboxFile } from "../src/contracts.ts";
import { raisePlanApproval } from "../src/escalation.ts";
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

function heldResearchJob(jobId: string): StatusJob {
	return {
		project: "demo",
		kind: "research",
		delivery: "pipeline",
		origin: "terminal",
		phase: "held",
		title: null,
		br_status: null,
		profile: "planner",
		role: "planner",
		model: "anthropic/claude-sonnet-5",
		run_phase: null,
		current_tool: null,
		current_tool_seconds: null,
		turns: 0,
		tool_calls: 0,
		alive: false,
		pid: 4321,
		session_id: "sess",
		worktree: "/tmp/demo",
		branch: jobId,
		job_id: jobId,
		timestamp: "2026-08-31T09:00:00Z",
		time_source: "dispatched_at",
		age_seconds: 60,
		last_activity_at: null,
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost_usd: 0 },
	} as StatusJob;
}

function flat(sent: Sent[]): AnsweredDecision[] {
	return sent.flat();
}

// ---------------------------------------------------------------------------
// Every source of an answer delivers
// ---------------------------------------------------------------------------

test("answering a declared row delivers one wake-up carrying id, type, job_id and the answer", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		const item = await parent.post.awaiting.declare({
			type: "design",
			decision: "postgres or sqlite?",
			why: "schema choice",
			blocks: "cp-db",
			job_id: "cp-db",
		});
		await parent.post.awaiting.answer(item.id, { answer: "sqlite", by: "operator command" });

		assert.equal(parent.sent.length, 1, "one delivery");
		const [decision] = flat(parent.sent);
		assert.equal(decision?.id, item.id, "the id the operator was shown is the id delivered");
		assert.equal(decision?.type, "design");
		assert.equal(decision?.job_id, "cp-db");
		assert.equal(decision?.answer, "sqlite");
		assert.equal(decision?.answered_by, "operator command");
		assert.match(decision?.answered_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
	} finally {
		home.cleanup();
	}
});

test("answering a derived approval row (finished research, no PR) delivers the same way", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		// The real projection, not a hand-built row: this is what /cp-decide offers.
		const [row] = deriveFromHeldResearch([heldResearchJob("cp-research")]);
		assert.ok(row, "the projection produced an approval row");
		const result = await resolveAwaitingResponse(
			{ id: row.id, kind: "answer", value: "ship", by: "operator dialog (tui)" },
			row,
			parent.writers,
		);
		assert.equal(result.wrote, true);

		assert.equal(parent.sent.length, 1);
		const [decision] = flat(parent.sent);
		assert.equal(decision?.id, "aw-research-cp-research");
		assert.equal(decision?.type, "approval");
		assert.equal(decision?.job_id, "cp-research");
		assert.equal(decision?.answer, "ship");
	} finally {
		home.cleanup();
	}
});

test("a checkpoint authorization resolved through CheckpointStore.decide delivers", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		parent.post.pipeline().checkpoints.request({ jobId: "cp-ship", question: "ship the plan?" });
		const [row] = deriveFromCheckpoints(parent.post.checkpoints.listPending());
		assert.ok(row, "a pending checkpoint derives one authorization row");

		const result = await resolveAwaitingResponse(
			{ id: row.id, kind: "answer", value: "approve", by: "operator dialog (tui)" },
			row,
			parent.writers,
		);
		assert.equal(result.wrote, true);
		assert.equal(parent.post.checkpoints.get("cp-ship")?.decision, "approved");

		assert.equal(parent.sent.length, 1, "an approved pipeline must not stall waiting for a turn");
		const [decision] = flat(parent.sent);
		assert.equal(decision?.id, "aw-checkpoint-cp-ship");
		assert.equal(decision?.type, "authorization");
		assert.equal(decision?.job_id, "cp-ship");
		assert.equal(decision?.answer, "approved");
	} finally {
		home.cleanup();
	}
});

test("/cp-authorize's writer wakes the parent too, and so does /cp-decline", () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		const checkpoints = parent.post.pipeline().checkpoints;
		checkpoints.request({ jobId: "cp-yes", question: "ship a?" });
		checkpoints.request({ jobId: "cp-no", question: "ship b?" });
		checkpoints.decide("cp-yes", true, { by: "operator command" });
		checkpoints.decide("cp-no", false, { by: "operator command" });

		const delivered = flat(parent.sent);
		assert.deepEqual(
			delivered.map((decision) => [decision.job_id, decision.answer]),
			[
				["cp-yes", "approved"],
				["cp-no", "declined"],
			],
			"a declined authorization is a decision too, and the parent must relay it",
		);
	} finally {
		home.cleanup();
	}
});

test("cp-khf: a diff authorization wakes the parent under its own row id, never the ship row's", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		const pipeline = parent.post.pipeline();
		pipeline.checkpoints.request({ jobId: "cp-ship", question: "act on the plan?" });
		pipeline.diffCheckpoints.request({ jobId: "cp-ship", question: "accept the diff?" });

		const rows = [
			...deriveFromCheckpoints(parent.post.checkpoints.listPending(), "ship"),
			...deriveFromCheckpoints(parent.post.diffCheckpoints.listPending(), "diff"),
		];
		const diffRow = rows.find((row) => row.checkpoint_kind === "diff");
		assert.ok(diffRow);
		assert.equal(diffRow.id, "aw-checkpoint-cp-ship.diff");

		const result = await resolveAwaitingResponse(
			{ id: diffRow.id, kind: "answer", value: "approve", by: "operator dialog (tui)" },
			diffRow,
			parent.writers,
		);
		assert.equal(result.wrote, true);

		const delivered = flat(parent.sent);
		assert.deepEqual(
			delivered.map((decision) => [decision.id, decision.answer]),
			[["aw-checkpoint-cp-ship.diff", "approved"]],
			"the wake-up names the row that was actually answered",
		);
		assert.equal(parent.post.checkpoints.get("cp-ship")?.decision, "pending", "the ship checkpoint is untouched");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Skip stays a non-answer
// ---------------------------------------------------------------------------

test("skip delivers nothing and records nothing, anywhere", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		parent.post.pipeline().checkpoints.request({ jobId: "cp-ship", question: "ship the plan?" });
		const rows = [
			...deriveFromCheckpoints(parent.post.checkpoints.listPending()),
			...deriveFromHeldResearch([heldResearchJob("cp-research")]),
		];
		for (const row of rows) {
			const result = await resolveAwaitingResponse({ id: row.id, kind: "skip" }, row, parent.writers);
			assert.equal(result.wrote, false);
		}

		assert.deepEqual(parent.sent, [], "skip wakes nobody");
		assert.deepEqual(parent.post.answered.pending(), [], "skip queues nothing");
		assert.equal(existsSync(join(home.path, LAYOUT.awaitingFile)), false, "skip writes no awaiting row");
		assert.equal(existsSync(join(home.path, LAYOUT.answeredFile)), false, "skip writes no outbox at all");
		assert.equal(parent.post.checkpoints.get("cp-ship")?.decision, "pending");
	} finally {
		home.cleanup();
	}
});

test("free text on an authorization stays a note: nothing is recorded and nobody is woken", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		parent.post.pipeline().checkpoints.request({ jobId: "cp-ship", question: "ship the plan?" });
		const [row] = deriveFromCheckpoints(parent.post.checkpoints.listPending());
		assert.ok(row);
		const result = await resolveAwaitingResponse(
			{ id: row.id, kind: "answer", value: "what about the migration?", by: "operator command" },
			row,
			parent.writers,
		);
		assert.equal(result.wrote, false);
		assert.equal(result.note, "what about the migration?");
		assert.deepEqual(parent.sent, [], "a note is not a verdict, so it is not a wake-up either");
		assert.equal(parent.post.checkpoints.get("cp-ship")?.decision, "pending");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Exactly once
// ---------------------------------------------------------------------------

test("answering twice does not wake twice, declared or authorization", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		const item = await parent.post.awaiting.declare({
			type: "approval",
			decision: "ship cp-x?",
			why: "research done",
			blocks: "cp-x",
			job_id: "cp-x",
		});
		await parent.post.awaiting.answer(item.id, { answer: "ship", by: "operator command" });
		await parent.post.awaiting.answer(item.id, { answer: "ship", by: "operator command" });

		const checkpoints = parent.post.pipeline().checkpoints;
		checkpoints.request({ jobId: "cp-ship", question: "ship the plan?" });
		checkpoints.decide("cp-ship", true, { by: "operator command" });
		checkpoints.decide("cp-ship", true, { by: "operator command" });

		assert.equal(flat(parent.sent).length, 2, "two decisions, two wake-ups, no matter how often they are answered");
	} finally {
		home.cleanup();
	}
});

test("a restart does not replay a delivered answer as a fresh wake-up", async () => {
	const home = createScratchHome();
	try {
		const first = parentOn(home.path);
		const item = await first.post.awaiting.declare({
			type: "design",
			decision: "one queue or two?",
			why: "affects dispatch",
			blocks: "cp-q",
		});
		await first.post.awaiting.answer(item.id, { answer: "one", by: "operator command" });
		assert.equal(first.sent.length, 1);

		// A new parent on the same home: the answer is history, not news.
		const second = parentOn(home.path);
		const drained = second.post.drainAnswered(() => {
			throw new Error("a delivered answer must never be drained again");
		});
		assert.deepEqual(drained, []);
		assert.deepEqual(second.post.answered.pending(), []);
	} finally {
		home.cleanup();
	}
});

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

// ---------------------------------------------------------------------------
// cp-nx7: sent is not delivered, and every pending answer goes out
// ---------------------------------------------------------------------------

test("two answers in one window both reach the parent, and neither is marked delivered until it is observed", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		// The incident, replayed: two merge approvals seven seconds apart.
		const first = await parent.post.awaiting.declare({
			type: "approval",
			decision: "Merge PR #44 once its rebase lands green",
			why: "green on the rebased head",
			blocks: "cp-44",
			job_id: "cp-44",
		});
		const second = await parent.post.awaiting.declare({
			type: "approval",
			decision: "Merge PR #42 once rebased and the question is answered",
			why: "green, question answered",
			blocks: "cp-42",
			job_id: "cp-42",
		});
		// Nothing is live while they are answered: both queue, neither is delivered.
		const headless = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		await headless.awaiting.answer(first.id, { answer: "yes", by: "operator dialog (tui)" });
		await headless.awaiting.answer(second.id, { answer: "yes", by: "operator dialog (tui)" });
		assert.equal(headless.answered.pending().length, 2, "both queued");
		assert.equal(headless.answered.delivered(first.id), false, "queueing is not delivering");
		assert.equal(headless.answered.delivered(second.id), false);

		parent.drain();
		const ids = flat(parent.arrived).map((decision) => decision.id);
		assert.deepEqual(ids.sort(), [first.id, second.id].sort(), "every pending id is present, not just the first");
		assert.equal(parent.sent.length, 1, "coalesced into one wake-up rather than one per window");
		assert.equal(parent.post.answered.delivered(first.id), true, "stamped on evidence of arrival");
		assert.equal(parent.post.answered.delivered(second.id), true);
		assert.deepEqual(parent.post.answered.pending(), []);
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

test("cp-5mgg: a scoped checkpoint id survives the notice round trip, so it can be confirmed at all", () => {
	const decisions = [mergeAuthorization()];
	// The path that broke: a message that reached the parent without its details.
	// The id was read as `aw-checkpoint-cp-ehsc` — the prefix before the `.` —
	// which matched nothing pending, so the answer was never confirmed and was
	// re-emitted every retry window for as long as the session lived.
	assert.deepEqual(
		answeredIdsFromMessage({ customType: "cp-answered", content: formatAnsweredNotice(decisions) }),
		["aw-checkpoint-cp-ehsc.merge-f7b8769f0606"],
		"the whole id, scope and all",
	);
	assert.deepEqual(
		answeredIdsFromMessage({
			customType: "cp-answered",
			content: "DECISION ANSWERED — a human answered aw-checkpoint-cp-x.diff.",
		}),
		["aw-checkpoint-cp-x.diff"],
		"a full stop at the end of a sentence is punctuation, not part of the id",
	);
});

test("cp-5mgg: an answer delivered once is not delivered again by a later drain, render or restart", () => {
	const home = createScratchHome();
	try {
		let now = new Date("2026-09-01T15:10:09Z");
		const outbox = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		const decision = mergeAuthorization();
		assert.equal(outbox.enqueue(decision), true);

		const sends: string[][] = [];
		const send = (decisions: readonly AnsweredDecision[]): void => {
			sends.push(decisions.map((entry) => entry.id));
		};
		outbox.drain(send);
		assert.deepEqual(sends, [[decision.id]], "emitted once");
		// The arrival evidence, read off the message exactly as the extension reads it.
		assert.deepEqual(
			outbox.confirmDelivered(
				answeredIdsFromMessage({ customType: "cp-answered", content: formatAnsweredNotice([decision]) }),
			),
			[decision.id],
			"and confirmable, which is the half that was broken",
		);

		// Every trigger the extension has: the widget tick, another answer, a poll.
		for (let tick = 0; tick < 5; tick += 1) {
			now = new Date(now.getTime() + 130_000);
			outbox.drain(send);
		}
		assert.equal(sends.length, 1, "a delivered answer is never emitted again, however often it is drained");

		// And a parent that restarts on the same home reads the same history.
		const restarted = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		assert.deepEqual(
			restarted.drain(() => {
				throw new Error("a delivered answer must never be emitted again");
			}),
			[],
		);
		assert.deepEqual(restarted.pending(), []);
		assert.deepEqual(restarted.sends(), [], "and the emission record dies with the entry it described");
	} finally {
		home.cleanup();
	}
});

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

test("cp-5mgg: an outbox written before this change reads as never emitted, and is emitted once", () => {
	const home = createScratchHome();
	try {
		// A pre-cp-5mgg file, byte for byte: no `sends` key at all. The claim the
		// schema comment makes is that this still validates and reads as "never
		// emitted" — the fail-safe direction, because the alternative is an answer
		// nobody is ever woken by.
		const decision = mergeAuthorization();
		const file = join(home.path, LAYOUT.answeredFile);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				schema_version: SCHEMA_VERSION,
				updated_at: "2026-09-01T15:10:09Z",
				pending: [decision],
				delivered: [],
			}),
		);

		const now = new Date("2026-09-01T15:10:11Z");
		const outbox = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120 });
		assert.equal(validateAnsweredOutboxFile(JSON.parse(readFileSync(file, "utf8"))).ok, true, "the old shape validates");
		assert.deepEqual(outbox.sends(), [], "an absent record reads as never emitted");
		assert.equal(outbox.stats().in_flight, 0);

		const sends: string[][] = [];
		outbox.drain((decisions) => sends.push(decisions.map((entry) => entry.id)));
		assert.deepEqual(sends, [[decision.id]], "so the answer that was owed goes out at once");

		const upgraded = validateAnsweredOutboxFile(JSON.parse(readFileSync(file, "utf8")));
		assert.equal(upgraded.ok, true, "and the file it wrote is a valid one");
		assert.deepEqual(
			(upgraded.ok ? (upgraded.value.sends ?? []) : []).map((entry) => [entry.id, entry.attempts]),
			[[decision.id, 1]],
			"now carrying the emission record the old file had no room for",
		);
		// And the new rule applies from here on: not due again inside its window.
		assert.deepEqual(outbox.drain(() => assert.fail("emitted twice")), []);
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

test("cp-5mgg: a bundled wake-up marks every decision it carried delivered, not just the first", () => {
	const home = createScratchHome();
	try {
		const now = new Date("2026-09-01T15:10:09Z");
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
		outbox.enqueue(research);
		outbox.enqueue(merge);

		let message: { customType: string; content: string } | undefined;
		outbox.drain((decisions) => {
			assert.equal(decisions.length, 2, "both are due, so both travel in one message");
			// Details stripped on purpose: the transport is allowed to carry only the
			// text, and that is the path the incident took.
			message = { customType: "cp-answered", content: formatAnsweredNotice(decisions) };
		});
		assert.ok(message);
		assert.deepEqual(outbox.confirmDelivered(answeredIdsFromMessage(message)).sort(), [research.id, merge.id].sort());
		assert.equal(outbox.delivered(merge.id), true);
		assert.equal(outbox.delivered(research.id), true);
		assert.deepEqual(outbox.pending(), [], "one message, two decisions, nothing left owed");
		outbox.drain(() => {
			throw new Error("a bundled answer must not come back on the next drain");
		});
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

test("u9q: an answer persisted before any send is delivered by the next parent's first drain", () => {
	const home = createScratchHome();
	try {
		// The crash landed between `enqueue` (the answer is durable) and the send.
		const decision = mergeAuthorization();
		crashedOutbox(home.path, { pending: [decision] });

		const now = new Date("2026-09-06T15:37:52Z");
		const restarted = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: NEW_SESSION });
		const sends: string[][] = [];
		restarted.drain((decisions) => sends.push(decisions.map((entry) => entry.id)));
		assert.deepEqual(sends, [[decision.id]], "the durable answer survives the crash and goes out at once");
	} finally {
		home.cleanup();
	}
});

test("u9q: a reservation held by a dead session is replayed immediately, not after the retry window", () => {
	const home = createScratchHome();
	try {
		// The incident, byte for byte: the answer was emitted by a parent that then
		// died, so the message was queued as a `followUp` into a context that will
		// never take another turn. Before this fix the successor inherited that
		// reservation and the operator waited out SENT_IN_FLIGHT (120s) for a
		// widget tick to resend it.
		const decision = mergeAuthorization();
		crashedOutbox(home.path, {
			pending: [decision],
			sends: [{ id: decision.id, sent_at: "2026-09-06T15:37:50Z", attempts: 1, owner: DEAD_SESSION }],
		});

		// Two seconds later — well inside the window the dead session opened.
		const now = new Date("2026-09-06T15:37:52Z");
		const restarted = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: NEW_SESSION });
		assert.equal(restarted.stats().in_flight, 0, "nothing of this parent's is in flight: the reservation is nobody's");

		const sends: string[][] = [];
		assert.deepEqual(
			restarted.drain((decisions) => sends.push(decisions.map((entry) => entry.id))).map((entry) => entry.id),
			[decision.id],
			"the first drain of the new session — `session_start` — replays it",
		);
		assert.deepEqual(sends, [[decision.id]]);
		assert.equal(restarted.stats().attempts, 2, "and the dead session's emission is still on the record, not erased");
		assert.equal(restarted.stats().in_flight, 1, "the replay is this parent's own reservation now");

		// And it is a reclaim, not a licence to repeat: inside its own window the
		// new session leaves it alone exactly as cp-5mgg requires.
		assert.deepEqual(restarted.drain(() => assert.fail("emitted twice inside one session")), []);
	} finally {
		home.cleanup();
	}
});

test("u9q: an unowned pre-upgrade reservation is reclaimed the same way", () => {
	const home = createScratchHome();
	try {
		// An outbox written by a build that had no `owner` field. Absent reads as
		// somebody else's, which is the fail-safe direction: the answer goes out.
		const decision = mergeAuthorization();
		crashedOutbox(home.path, {
			pending: [decision],
			sends: [{ id: decision.id, sent_at: "2026-09-06T15:37:50Z", attempts: 1 }],
		});
		const now = new Date("2026-09-06T15:37:52Z");
		const restarted = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: NEW_SESSION });
		assert.deepEqual(
			restarted.drain(() => {}).map((entry) => entry.id),
			[decision.id],
		);
	} finally {
		home.cleanup();
	}
});

test("u9q: an acknowledged answer is never replayed by a restart, whatever the dead session reserved", () => {
	const home = createScratchHome();
	try {
		// The dying session emitted it AND observed it arrive: `delivered` is the
		// record of that, and a delivered answer is not pending, so no reclaim can
		// reach it. Exactly-once survives the restart.
		const decision = mergeAuthorization();
		crashedOutbox(home.path, {
			sends: [{ id: decision.id, sent_at: "2026-09-06T15:37:50Z", attempts: 1, owner: DEAD_SESSION }],
			delivered: [{ id: decision.id, delivered_at: "2026-09-06T15:37:51Z" }],
		});
		const now = new Date("2026-09-06T15:37:52Z");
		const restarted = new AnsweredOutbox({ home: home.path, now: () => now, retrySeconds: 120, owner: NEW_SESSION });
		assert.deepEqual(restarted.drain(() => assert.fail("a delivered answer must never be replayed")), []);
		assert.equal(restarted.delivered(decision.id), true);
		assert.equal(
			restarted.enqueue(decision),
			false,
			"and the exactly-once key still refuses it, so nothing can re-queue it either",
		);
	} finally {
		home.cleanup();
	}
});

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

test("u9q: a restarted parent replays the operator's answer on its first drain, end to end", async () => {
	const home = createScratchHome();
	try {
		// The whole path the operator took: /cp-authorize recorded the answer, the
		// parent emitted it, and then the parent died. `parentOn` is the extension's
		// `surfaceAnswered`; its first drain is `session_start`.
		const headless = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		headless.checkpoints.request({ jobId: "cp-ship", question: "ship the plan?" });
		headless.checkpoints.decide("cp-ship", true, { by: "operator command" });
		const [pending] = headless.answered.pending();
		assert.ok(pending, "the answer is durable before anything is sent");
		// The dead parent's emission, left behind exactly as a crash leaves it.
		crashedOutbox(home.path, {
			pending: [pending],
			sends: [{ id: pending.id, sent_at: isoTimestamp(new Date()), attempts: 1, owner: DEAD_SESSION }],
		});

		const parent = parentOn(home.path);
		parent.drain();
		assert.equal(flat(parent.arrived).length, 1, "the successor is woken by its first drain, not by a 120s timer");
		assert.equal(flat(parent.sent)[0]?.job_id, "cp-ship");
		assert.equal(flat(parent.sent)[0]?.type, "authorization", "and an authorization is still a single-writer answer");
		// Arrival was observed, so nothing is owed and no later drain repeats it.
		parent.drain();
		assert.equal(flat(parent.sent).length, 1);
		assert.deepEqual(parent.post.answered.pending(), []);
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

test("an answer recorded with no parent attached at all is delivered by the next parent's first drain", async () => {
	const home = createScratchHome();
	try {
		// No `onAnswered` wired: a headless /cp-authorize, a `pi -p` re-entry.
		const headless = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		headless.checkpoints.request({ jobId: "cp-ship", question: "ship the plan?" });
		headless.checkpoints.decide("cp-ship", true, { by: "operator command" });

		const parent = parentOn(home.path);
		parent.drain();
		assert.equal(flat(parent.arrived).length, 1, "the answer waited in the outbox instead of being dropped");
		assert.equal(flat(parent.sent)[0]?.job_id, "cp-ship");
	} finally {
		home.cleanup();
	}
});

test("an unwritable outbox never fails the answer it could not queue", async () => {
	const home = createScratchHome();
	try {
		// A checkpoint store whose sink throws: the answer is already on disk when
		// the sink runs, so the decision must survive the failure.
		const checkpoints = new CheckpointStore(home.path, {
			onAnswered: () => {
				throw new Error("outbox is unwritable");
			},
		});
		checkpoints.request({ jobId: "cp-ship", question: "ship the plan?" });
		const decided = checkpoints.decide("cp-ship", true, { by: "operator command" });
		assert.equal(decided.decision, "approved");
		assert.equal(checkpoints.get("cp-ship")?.decision, "approved");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The outbox and the notice, on their own
// ---------------------------------------------------------------------------

test("the outbox refuses to queue the same id twice, pending or delivered", () => {
	const home = createScratchHome();
	try {
		const outbox = new AnsweredOutbox({ home: home.path });
		const decision = answeredDecision({
			id: "aw-abc",
			type: "approval",
			job_id: "cp-x",
			decision: "ship cp-x?",
			answer: "ship",
			answered_by: "operator command",
			answered_at: "2026-08-31T10:11:25Z",
		});
		assert.equal(outbox.enqueue(decision), true);
		assert.equal(outbox.enqueue(decision), false, "already pending");
		assert.equal(outbox.pending().length, 1);
		outbox.markDelivered(["aw-abc"]);
		assert.deepEqual(outbox.pending(), []);
		assert.equal(outbox.delivered("aw-abc"), true);
		assert.equal(outbox.enqueue(decision), false, "already delivered");
		assert.deepEqual(outbox.pending(), []);
	} finally {
		home.cleanup();
	}
});

test("an answered decision must carry the answer and who gave it", () => {
	assert.throws(
		() =>
			answeredDecision({
				id: "aw-abc",
				type: "approval",
				decision: "ship?",
				answer: "   ",
				answered_by: "operator command",
			}),
		AnsweredError,
	);
	assert.throws(
		() =>
			answeredDecision({
				id: "aw-abc",
				type: "approval",
				decision: "ship?",
				answer: "ship",
				answered_by: " ",
			}),
		AnsweredError,
	);
});

test("the notice names the id, the type, the job and the answer, and says an authorization is permission", () => {
	const decisions: AnsweredDecision[] = [
		answeredDecision({
			id: "aw-checkpoint-cp-ship",
			type: "authorization",
			job_id: "cp-ship",
			decision: "ship the plan?",
			answer: "approved",
			answered_by: "operator command",
			answered_at: "2026-08-31T10:11:25Z",
		}),
		answeredDecision({
			id: "aw-7d92aa1cce",
			type: "approval",
			job_id: "cp-research",
			decision: "cp-research: ship, drop or follow-up?",
			answer: "ship",
			answered_by: "operator dialog (tui)",
			answered_at: "2026-08-31T10:11:25Z",
		}),
	];
	const notice = formatAnsweredNotice(decisions);
	assert.match(notice, /DECISIONS ANSWERED/);
	assert.match(notice, /aw-checkpoint-cp-ship \[authorization\] cp-ship: ship the plan\? → "approved"/);
	assert.match(notice, /aw-7d92aa1cce \[approval\] cp-research: .* → "ship"/);
	assert.match(notice, /approved means dispatch it/);
	assert.equal(formatAnsweredNotice([]), "", "no answers, no notice");
});

test("one answer reads as one, not as a plural headline", () => {
	const notice = formatAnsweredNotice([
		answeredDecision({
			id: "aw-abc",
			type: "design",
			decision: "one queue or two?",
			answer: "one",
			answered_by: "operator command",
			answered_at: "2026-08-31T10:11:25Z",
		}),
	]);
	assert.match(notice, /DECISION ANSWERED — a human answered 1 open decision/);
	assert.doesNotMatch(notice, /authorization is a human's permission/);
});

test("a mandate's auto-decision reads as decided under mandate, never as a human's answer", () => {
	const mandate = answeredDecision({
		id: "aw-checkpoint-cp-x",
		type: "authorization",
		job_id: "cp-x",
		decision: "ship the plan?",
		answer: "approved",
		answered_by: "mandate:md-94115f",
		answered_at: "2026-09-27T13:55:41Z",
	});
	const notice = formatAnsweredNotice([mandate]);
	assert.match(notice, /DECISION ANSWERED — decided under mandate md-94115f/);
	assert.doesNotMatch(notice, /a human answered/);

	// A batch mixing an operator's answer with a mandate's never claims the
	// mandate's decision came from a human.
	const mixed = formatAnsweredNotice([mandate, answeredDecision({
		id: "aw-7d92aa1cce",
		type: "design",
		decision: "one queue or two?",
		answer: "one",
		answered_by: "operator command",
		answered_at: "2026-09-27T13:56:00Z",
	})]);
	assert.match(mixed, /DECISIONS ANSWERED — 2 open decisions answered/);
	assert.doesNotMatch(mixed, /a human answered/);
});

test("a ResolvedAwaitingItem's id is what the wake-up carries, even for a long derived id", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		const row: ResolvedAwaitingItem = {
			id: "aw-research-cp-a-very-long-research-job-id-that-must-not-be-truncated",
			type: "approval",
			decision: "ship, drop or follow-up?",
			why: "finished research with no ship decision yet",
			blocks: "follow-on work",
			job_id: "cp-a-very-long-research-job-id-that-must-not-be-truncated",
			options: ["ship", "drop", "follow-up"],
			opened_at: "2026-08-31T09:00:00Z",
		};
		await parent.post.awaiting.answerResolved(row, { answer: "follow-up", by: "operator dialog (tui)" });
		assert.equal(flat(parent.sent)[0]?.id, row.id);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Escalation answers wake the parent
// ---------------------------------------------------------------------------

const ESC_OPTIONS = [
	{ id: "approve", label: "approve", consequence: "proceed", cost: "none" },
	{ id: "decline", label: "decline", consequence: "hold", cost: "wait" },
];

test("an unlinked escalation answer queues one es- wake, once, and a restart never replays it", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		const raised = await parent.post.escalations.raise({ job_ids: ["cp-synth1"], kind: "product_ambiguity", question: "which copy?", options: ESC_OPTIONS, recommended: "approve" });
		await parent.post.escalations.answer(raised.id, { answer: "approve", by: "operator command" });
		const delivered = flat(parent.sent);
		assert.equal(delivered.length, 1, "one delivery");
		assert.deepEqual([delivered[0]?.id, delivered[0]?.type, delivered[0]?.job_id, delivered[0]?.answer], [raised.id, "escalation", "cp-synth1", "approve"]);
		await parent.post.escalations.answer(raised.id, { answer: "approve", by: "operator command" });
		assert.equal(flat(parent.sent).length, 1, "an identical repeat wakes nobody");
		const restarted = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		assert.deepEqual(restarted.answered.pending(), [], "delivered is history, not news");
	} finally {
		home.cleanup();
	}
});

test("a plan approval linked to a ship checkpoint wakes once, under the checkpoint row id, with no es- duplicate", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		parent.post.checkpoints.request({ jobId: "cp-synth-ship", question: "ship the plan?" });
		const raised = await raisePlanApproval(parent.post.escalations, { researchId: "cp-synth-res", shipId: "cp-synth-ship", question: "ship the plan?", evidence_paths: [] });
		await parent.post.escalations.answer(raised.id, { answer: "approve", by: "operator command" });
		assert.deepEqual(flat(parent.sent).map((decision) => decision.id), ["aw-checkpoint-cp-synth-ship"]);
	} finally {
		home.cleanup();
	}
});

test("an es- id is confirmable from the notice text alone", () => {
	const decision = answeredDecision({ id: "es-0a0a0a", type: "escalation", job_id: "cp-synth1", decision: "which copy?", answer: "approve", answered_by: "operator command" });
	assert.deepEqual(answeredIdsFromMessage({ customType: "cp-answered", content: formatAnsweredNotice([decision]) }), ["es-0a0a0a"]);
});

test("an alternate-kind (merge) linked checkpoint answered through the escalation wakes once, under its own row id", async () => {
	const home = createScratchHome();
	try {
		const parent = parentOn(home.path);
		const sha = "0123456789abcdef0123456789abcdef01234567";
		parent.post.mergeCheckpoints.request({ jobId: "cp-synth-merge", scope: sha, question: "merge cp-synth-merge?" });
		const raised = await parent.post.escalations.raise({
			job_ids: ["cp-synth-merge"], kind: "merge_refused", question: "merge?", options: ESC_OPTIONS, recommended: "approve",
			checkpoint_job_id: "cp-synth-merge", checkpoint_kind: "merge", checkpoint_scope: sha,
		});
		await parent.post.escalations.answer(raised.id, { answer: "approve", by: "operator command" });
		assert.equal(parent.post.mergeCheckpoints.get("cp-synth-merge", { scope: sha })?.decision, "approved");
		assert.deepEqual(flat(parent.sent).map((decision) => decision.id), [checkpointAwaitingId("cp-synth-merge", "merge", sha)]);
	} finally {
		home.cleanup();
	}
});
