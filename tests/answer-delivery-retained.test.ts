/**
 * Retained verbatim from answer-delivery (P11); the rest is P11-answer in tests/e2e/research-delivery.test.ts.
 * Each declaration names its missing entry point in docs/testing-migration/p11.md.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	answerCardId,
	AnswerCardError,
	AnswerCardOutbox,
	answerCardRecord,
} from "../src/answer-delivery.ts";
import { CommandPost } from "../src/command-post.ts";
import {
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
// 6. what is not a card
// ---------------------------------------------------------------------------

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
