/**
 * cp-6lg7 acceptance: a Q&A job's answer survives the job.
 *
 * The incident these tests encode: `cp-n9jh` (a `delivery:answer` job) filed
 * its envelope at 17:41:07, the parent tore it down seven seconds later exactly
 * as the loop prescribes, and the operator saw **nothing**. The run log kept
 * the only trace — `wakeup_suppressed { kind: envelope, stage: delivery,
 * delay_seconds: 7, reason: "cp-n9jh is already done: the delivery landed and
 * the job was torn down" }` — while the 4571-byte answer sat unread on disk.
 * `cp-5vl9` lost its answer the same way an hour earlier. For a Q&A job the
 * answer is the whole deliverable, so that is silent total loss, and it fires
 * precisely when the parent is prompt.
 *
 * Everything below is hermetic: `CommandPost` does the queueing (the wiring the
 * parent actually depends on), a sink plays the extension's surface, and
 * teardown is reproduced as the two facts it writes to the record — `done` and
 * `closed_at` — because those are the facts every phase-keyed surface reads.
 *
 * `node --test tests/answer-delivery.test.ts`
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	AnswerCardOutbox,
	answerCardDue,
	answerCardId,
	AnswerCardError,
	answerCardRecord,
} from "../src/answer-delivery.ts";
import { CommandPost } from "../src/command-post.ts";
import {
	ANSWER_CARD_DEFER_SECONDS,
	type AnswerCardChannel,
	type AnswerCardRecord,
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	isoTimestamp,
	LAYOUT,
	paths,
	SCHEMA_VERSION,
	validateAnswerCardOutboxFile,
} from "../src/contracts.ts";
import { initJobsDocument, Ledger } from "../src/ledger.ts";
import { answerCardChannel } from "../extensions/command-post/wakeup-surfaces.ts";
import { checkWakeup, wakeupFacts, type WakeupStamp } from "../src/wakeups.ts";
import { createScratchHome, readRunEvents, REPO_ROOT, type ScratchHome } from "./harness/index.ts";

/** The answer body. It must never appear anywhere but the artifact file. */
const ANSWER_BODY = [
	"# Does detection find the pi-installed packages?",
	"",
	"Yes: both are found under ~/.pi/agent/npm/node_modules.",
	"SECRET-BODY-MARKER-ONLY-IN-THE-ARTIFACT",
].join("\n");

const HEADLINE = "Yes: both packages are found; the detector's only root is the one pi install writes to.";

interface Bench {
	home: ScratchHome;
	post: CommandPost;
	/** Every card a surface accepted, in order. */
	shown: AnswerCardRecord[];
	/** Drain the queue the way the extension does. */
	drain(options?: { idle?: boolean; surface?: AnswerCardChannel | undefined; now?: Date }): AnswerCardRecord[];
	answerPath(jobId: string): string;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }): Bench {
	const home = createScratchHome();
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	const shown: AnswerCardRecord[] = [];
	t.after(() => {
		post.runs.closeAll();
		home.cleanup();
	});
	return {
		home,
		post,
		shown,
		drain(options = {}) {
			const surface = "surface" in options ? options.surface : ("card" as const);
			return post.drainAnswerCards(
				(record) => {
					if (!surface) return undefined;
					shown.push(record);
					return surface;
				},
				{ idle: options.idle ?? true, ...(options.now ? { now: options.now } : {}) },
			);
		},
		/** Where intake stores the answer: the durable copy the card points at. */
		answerPath(jobId: string) {
			return join(home.path, paths.artifactFile(jobId));
		},
	};
}

function answerJob(home: string, jobId: string): FleetRecord {
	return {
		job_id: jobId,
		project: "pi-command-post",
		kind: "research",
		delivery: "answer",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(home, "s.jsonl"),
			profile: "planner",
			role: "planner",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: join(home, "wt"),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
}

/** The worker's two writes: the answer file, then the envelope naming it. */
function reportAnswer(b: Bench, jobId: string): string {
	const answer = join(b.home.path, "answers", `${jobId}.md`);
	mkdirSync(join(b.home.path, "answers"), { recursive: true });
	writeFileSync(answer, `${ANSWER_BODY}\n`);
	mkdirSync(join(b.home.path, paths.runDir(jobId)), { recursive: true });
	writeFileSync(
		join(b.home.path, paths.envelopeFile(jobId)),
		`${JSON.stringify(
			{
				schema_version: SCHEMA_VERSION,
				job_id: jobId,
				received_at: isoTimestamp(),
				attempt: 1,
				envelope: {
					job_id: jobId,
					kind: "research",
					status: "done",
					summary: HEADLINE,
					artifact_path: answer,
				},
			},
			null,
			2,
		)}\n`,
	);
	return answer;
}

/** What `cp_teardown` writes to the record, and nothing else. */
async function tearDown(b: Bench, jobId: string): Promise<void> {
	await b.post.fleet.patch(jobId, {
		phase: "done",
		closed_at: isoTimestamp(),
		closed_reason: "gated",
	});
	b.post.runs.close(jobId);
}

// ---------------------------------------------------------------------------
// 1. the incident
// ---------------------------------------------------------------------------

test("envelope, then teardown seconds later: the card still reaches the operator", async (t) => {
	const b = benchOf(t);
	await b.post.fleet.add(answerJob(b.home.path, "cp-n9jh"));
	reportAnswer(b, "cp-n9jh");

	const reported = await b.post.intake.intake("cp-n9jh");
	assert.equal(reported.accepted, true);
	assert.equal(reported.delivery, "answer");
	assert.equal(reported.next, "teardown", "a Q&A job is torn down the moment it reports — that is the loop");
	assert.equal(b.post.answerCards.pending().length, 1, "the card is on disk before anybody is told anything");

	// The parent does exactly what AGENTS.md says: relay, then tear down. Seven
	// seconds, as observed on cp-n9jh.
	await tearDown(b, "cp-n9jh");
	assert.equal(b.post.fleet.require("cp-n9jh").phase, "done");

	// The envelope wake-up is *correctly* superseded by that teardown: it tells
	// the parent to act on a job that is over. This is the suppression the card
	// used to ride on, and it is unchanged.
	const stamp: WakeupStamp = {
		kind: "envelope",
		job_id: "cp-n9jh",
		generation: reported.generation ?? 1,
		...(reported.reported_at ? { reported_at: reported.reported_at } : {}),
		issued_at: reported.reported_at ?? isoTimestamp(),
	};
	const verdict = checkWakeup(stamp, wakeupFacts({ record: (jobId) => b.post.fleet.get(jobId) }));
	assert.equal(verdict.state, "superseded", "the wake-up is still stale — the parent must not act on a torn-down job");
	assert.match(verdict.reason ?? "", /already done/);

	// The card is not a wake-up, and it does not care what the phase became.
	const shown = b.drain();
	assert.equal(shown.length, 1, "the answer reaches the operator after the teardown that used to eat it");
	assert.equal(shown[0]?.job_id, "cp-n9jh");
	assert.equal(shown[0]?.summary, HEADLINE);
	assert.equal(shown[0]?.path, b.answerPath("cp-n9jh"));
	assert.equal(b.post.answerCards.pending().length, 0);
	assert.equal(b.post.answerCards.delivered(answerCardId("cp-n9jh", 1)), true);

	// And the fact is in the job's own run log, whatever its phase has become.
	const kinds = readRunEvents(b.home.path, "cp-n9jh").map((event) => event.type);
	assert.ok(kinds.includes("answer_card_queued"), `queued is a fact: ${kinds.join(", ")}`);
	assert.ok(kinds.includes("answer_card_delivered"), `so is delivery: ${kinds.join(", ")}`);
});

// ---------------------------------------------------------------------------
// 2. exactly once
// ---------------------------------------------------------------------------

test("a card that reached the operator is never shown again, and never resurrected", async (t) => {
	const b = benchOf(t);
	await b.post.fleet.add(answerJob(b.home.path, "cp-once"));
	reportAnswer(b, "cp-once");
	await b.post.intake.intake("cp-once");

	assert.equal(b.drain().length, 1);
	assert.equal(b.drain().length, 0, "a second drain shows nothing");
	assert.equal(b.shown.length, 1);

	// The trigger fires from three places (intake, session_start, widget tick);
	// none of them may mint a second card.
	assert.equal(b.drain().length, 0);
	assert.equal(b.drain({ idle: false }).length, 0);

	// Intake is idempotent, and a re-intake must not re-queue a shown card.
	const again = await b.post.intake.intake("cp-once");
	assert.equal(again.already, true);
	assert.equal(b.post.answerCards.pending().length, 0, "an already-reported envelope queues nothing");

	// A restart reads the same file and knows the card is history.
	const restarted = new AnswerCardOutbox({ home: b.home.path });
	assert.equal(restarted.pending().length, 0);
	assert.equal(restarted.delivered(answerCardId("cp-once", 1)), true);
	assert.equal(
		restarted.enqueue({
			job_id: "cp-once",
			generation: 1,
			summary: HEADLINE,
			path: b.answerPath("cp-once"),
			bytes: 10,
			reported_at: isoTimestamp(),
		}),
		false,
		"a delivered card can never be queued again",
	);
	assert.equal(restarted.pending().length, 0);
});

test("queueing twice queues once", async (t) => {
	const b = benchOf(t);
	const outbox = b.post.answerCards;
	const input = {
		job_id: "cp-dup",
		generation: 1,
		summary: HEADLINE,
		path: b.answerPath("cp-dup"),
		bytes: 4571,
		reported_at: isoTimestamp(),
	};
	assert.equal(outbox.enqueue(input), true);
	assert.equal(outbox.enqueue(input), false, "same envelope generation, same id, one card");
	assert.equal(outbox.pending().length, 1);

	// A promote that reopens the slot mints a new generation, and a new answer.
	assert.equal(outbox.enqueue({ ...input, generation: 2 }), true);
	assert.equal(outbox.pending().length, 2);
	assert.deepEqual(
		outbox.pending().map((card) => card.id),
		[answerCardId("cp-dup", 1), answerCardId("cp-dup", 2)],
	);
});

// ---------------------------------------------------------------------------
// 3. delivery is not consumed by a surface that cannot show it
// ---------------------------------------------------------------------------

test("a mode with no operator surface leaves the card queued", async (t) => {
	const b = benchOf(t);
	await b.post.fleet.add(answerJob(b.home.path, "cp-headless"));
	reportAnswer(b, "cp-headless");
	await b.post.intake.intake("cp-headless");

	// A headless re-entry into this home (print/json, no UI) must not eat the
	// answer the operator's terminal is going to show.
	assert.equal(b.drain({ surface: undefined }).length, 0);
	assert.equal(b.post.answerCards.pending().length, 1, "still owed");

	// The operator's session starts and takes it.
	assert.equal(b.drain().length, 1);
	assert.equal(b.post.answerCards.delivered(answerCardId("cp-headless", 1)), true);
});

test("cp-hhuf P1: a scheduled job's answer is delivered to the Schedules page, not the operator transcript", async (t) => {
	const b = benchOf(t);
	initJobsDocument(b.home.path, "cp");
	const ledger = new Ledger({ home: b.home.path });
	const scheduled = await ledger.create({ title: "Digest", project: "pi-command-post", kind: "research", delivery: "answer", labels: ["schedule:sch-aaaaaa"] });
	const plain = await ledger.create({ title: "Question", project: "pi-command-post", kind: "research", delivery: "answer" });
	for (const job of [scheduled, plain]) {
		await b.post.fleet.add(answerJob(b.home.path, job.id));
		reportAnswer(b, job.id);
		await b.post.intake.intake(job.id);
	}
	// The extension sink's own routing (wakeup-surfaces.ts), in a TUI session: scheduled wins over the card.
	const tui = { mode: "tui", hasUI: true };
	const channels = new Map<string, AnswerCardChannel | undefined>();
	b.post.drainAnswerCards((record) => {
		const channel = answerCardChannel(b.home.path, record.job_id, tui);
		channels.set(record.job_id, channel);
		return channel;
	}, { idle: true });
	assert.equal(channels.get(scheduled.id), "schedules_page");
	assert.equal(channels.get(plain.id), "card");
	assert.equal(answerCardChannel(b.home.path, scheduled.id, undefined), "schedules_page", "no operator surface needed");
	assert.equal(answerCardChannel(b.home.path, plain.id, { mode: "rpc", hasUI: true }), "notice");
	assert.equal(answerCardChannel(b.home.path, plain.id, undefined), undefined, "no surface: stays queued");
	assert.equal(b.post.answerCards.pending().length, 0, "both delivered, exactly once");
	const delivered = readRunEvents(b.home.path, scheduled.id).find((event) => event.type === "answer_card_delivered");
	assert.equal((delivered?.payload as { channel?: string } | undefined)?.channel, "schedules_page");
	const file = JSON.parse(readFileSync(join(b.home.path, LAYOUT.answerCardsFile), "utf8"));
	assert.equal(validateAnswerCardOutboxFile(file).ok, true, "the outbox file accepts the new channel");
});

test("a sink that throws leaves its card queued, and never un-delivers the ones before it", async (t) => {
	const b = benchOf(t);
	for (const jobId of ["cp-a1", "cp-a2"]) {
		await b.post.fleet.add(answerJob(b.home.path, jobId));
		reportAnswer(b, jobId);
		await b.post.intake.intake(jobId);
	}
	assert.equal(b.post.answerCards.pending().length, 2);

	assert.throws(() =>
		b.post.drainAnswerCards(
			(record) => {
				if (record.job_id === "cp-a2") throw new Error("renderer blew up");
				return "card";
			},
			{ idle: true },
		),
	);
	assert.equal(b.post.answerCards.delivered(answerCardId("cp-a1", 1)), true, "the card that was shown stays shown");
	assert.deepEqual(
		b.post.answerCards.pending().map((card) => card.job_id),
		["cp-a2"],
		"the one that failed is still owed",
	);
	assert.equal(b.drain().length, 1, "and reaches the operator on the next tick");
});

// ---------------------------------------------------------------------------
// 4. when a card is due
// ---------------------------------------------------------------------------

test("a card waits for an idle session, but never longer than the defer window", () => {
	const queued = "2026-09-04T17:41:07Z";
	const card = answerCardRecord({
		job_id: "cp-defer",
		generation: 1,
		summary: HEADLINE,
		path: "/tmp/answer.md",
		bytes: 10,
		reported_at: queued,
		queued_at: queued,
	});
	const at = (seconds: number) => new Date(Date.parse(queued) + seconds * 1000);

	assert.equal(answerCardDue(card, { idle: true, now: at(0) }), true, "idle wins immediately");
	assert.equal(answerCardDue(card, { idle: false, now: at(5) }), false, "mid-turn, the card waits");
	assert.equal(
		answerCardDue(card, { idle: false, now: at(ANSWER_CARD_DEFER_SECONDS - 1) }),
		false,
		"still inside the window",
	);
	assert.equal(
		answerCardDue(card, { idle: false, now: at(ANSWER_CARD_DEFER_SECONDS) }),
		true,
		"a parent that never rests still delivers: late is a nuisance, never is the bug",
	);
});

test("the drain defers a mid-turn card and the widget tick picks it up", async (t) => {
	const b = benchOf(t);
	await b.post.fleet.add(answerJob(b.home.path, "cp-midturn"));
	reportAnswer(b, "cp-midturn");
	await b.post.intake.intake("cp-midturn");

	// Intake fires while the parent is streaming: nothing is shown, nothing lost.
	assert.equal(b.drain({ idle: false }).length, 0);
	assert.equal(b.post.answerCards.pending().length, 1);

	// The next tick finds the session between turns.
	assert.equal(b.drain({ idle: true }).length, 1);
	assert.equal(b.post.answerCards.pending().length, 0);
});

// ---------------------------------------------------------------------------
// 5. what may never travel
// ---------------------------------------------------------------------------

test("the queue holds a pointer and a headline — never the answer body", async (t) => {
	const b = benchOf(t);
	await b.post.fleet.add(answerJob(b.home.path, "cp-body"));
	reportAnswer(b, "cp-body");
	await b.post.intake.intake("cp-body");

	const raw = readFileSync(b.post.answerCards.file, "utf8");
	assert.ok(!raw.includes("SECRET-BODY-MARKER-ONLY-IN-THE-ARTIFACT"), "the body is not in the outbox");
	assert.ok(raw.includes(JSON.stringify(b.answerPath("cp-body")).slice(1, -1)), "the pointer is");
	const parsed = validateAnswerCardOutboxFile(JSON.parse(raw));
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));

	const [card] = b.drain();
	assert.ok(card);
	assert.equal(card.summary, HEADLINE);
	assert.equal(card.bytes, `${ANSWER_BODY}\n`.length);
	assert.ok(!JSON.stringify(card).includes("SECRET-BODY-MARKER-ONLY-IN-THE-ARTIFACT"));

	// The run log is read by /watch, and it is not a body either.
	const events = readRunEvents(b.home.path, "cp-body");
	assert.ok(!JSON.stringify(events).includes("SECRET-BODY-MARKER-ONLY-IN-THE-ARTIFACT"));
});

// ---------------------------------------------------------------------------
// 6. what is not a card
// ---------------------------------------------------------------------------

test("only a done delivery:answer envelope with an artifact mints a card", async (t) => {
	const b = benchOf(t);

	// A research job that is not delivery:answer writes an artifact and mints no
	// card: the plan is read with /cp-plan, and always was.
	const plan = answerJob(b.home.path, "cp-plan");
	await b.post.fleet.add({ ...plan, delivery: "pipeline" });
	reportAnswer(b, "cp-plan");
	await b.post.intake.intake("cp-plan");
	assert.equal(b.post.answerCards.pending().length, 0);

	// A blocked Q&A job answers nothing.
	await b.post.fleet.add(answerJob(b.home.path, "cp-blocked"));
	mkdirSync(join(b.home.path, paths.runDir("cp-blocked")), { recursive: true });
	writeFileSync(
		join(b.home.path, paths.envelopeFile("cp-blocked")),
		`${JSON.stringify({
			schema_version: SCHEMA_VERSION,
			job_id: "cp-blocked",
			received_at: isoTimestamp(),
			attempt: 1,
			envelope: {
				job_id: "cp-blocked",
				kind: "research",
				status: "blocked",
				summary: "The repository this question is about is not registered here.",
				blockers: ["no clone for the project named in the question"],
			},
		})}\n`,
	);
	await b.post.intake.intake("cp-blocked");
	assert.equal(b.post.answerCards.pending().length, 0, "a blocked job owes the operator a blocker, not a card");
});

test("a card refuses to be built without the facts that make it renderable", () => {
	assert.throws(
		() =>
			answerCardRecord({
				job_id: "cp-x",
				generation: 1,
				summary: HEADLINE,
				path: "   ",
				bytes: 1,
				reported_at: isoTimestamp(),
			}),
		AnswerCardError,
	);
	assert.throws(
		() =>
			answerCardRecord({
				job_id: "cp-x",
				generation: 0,
				summary: HEADLINE,
				path: "/tmp/a.md",
				bytes: 1,
				reported_at: isoTimestamp(),
			}),
		AnswerCardError,
	);
});
