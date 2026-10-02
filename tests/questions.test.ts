/**
 * T31 acceptance: operator questions — policy, journal and relay.
 *
 * No model and no worker anywhere in this file: the relay is code, so every
 * branch that decides whether a human is asked (and what a worker is told when
 * nobody answers) is provable for free.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
	isoTimestamp,
	authorizationTrigger,
	looksLikeAuthorization,
	QUESTION_AUTHORIZATION_PATTERNS,
	paths,
	QUESTION_ANSWER_MAX_CHARS,
	QUESTION_MAX_CHARS,
	QUESTION_MAX_PER_JOB,
	REVIEW_DIALOG_TITLE,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import {
	type Asker,
	ASKING_ROLES,
	decideAsk,
	formatQuestion,
	type HandleResult,
		normaliseReviewRequest,
	type OperatorQuestion,
	QuestionError,
	QuestionRelay,
	QuestionStore,
} from "../src/questions.ts";
import { createScratchHome } from "./harness/index.ts";

const BR = "cp-ask1";

function request(overrides: Record<string, unknown> = {}): {
	id: string;
	method: string;
	title?: string;
	options?: unknown;
} {
	return { id: "dlg-1", method: "select", title: "Postgres or SQLite?", options: ["Postgres", "SQLite"], ...overrides };
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

test("only a planner may ask, and only when a human is attached", () => {
	assert.deepEqual([...ASKING_ROLES], ["planner"], "asking is a planning act, not an implementing one");

	const base = { request: request(), spent: 0, hasOperator: true };
	assert.equal(decideAsk({ ...base, role: "planner" }).allowed, true);

	// An implementer that stops to ask is an implementer not implementing.
	const implementer = decideAsk({ ...base, role: "implementer" });
	assert.equal(implementer.allowed, false);
	assert.match(implementer.reason ?? "", /does not ask the operator/);
	assert.match(implementer.reason ?? "", /report blocked/, "the refusal names the sanctioned path");

	// A reviewer judges an artifact in a fresh context; there is nobody to ask.
	assert.equal(decideAsk({ ...base, role: "gate-reviewer" }).allowed, false);
	// No role at all: refuse rather than guess.
	assert.equal(decideAsk(base).allowed, false);

	// No operator: fail closed, exactly as before T31.
	const headless = decideAsk({ ...base, role: "planner", hasOperator: false });
	assert.equal(headless.allowed, false);
	assert.match(headless.reason ?? "", /no operator is attached/);
});

test("a question is bounded: count, shape and length", () => {
	const base = { role: "planner" as const, hasOperator: true };

	// The cap is counted, not estimated.
	assert.equal(decideAsk({ ...base, request: request(), spent: QUESTION_MAX_PER_JOB }).allowed, false);
	const capped = decideAsk({ ...base, request: request(), spent: 1, maxPerJob: 1 });
	assert.equal(capped.allowed, false);
	assert.match(capped.reason ?? "", /Unknowns\/Blockers/, "the refusal says where the rest of the questions go");

	// A select with nothing to select is not a question.
	assert.equal(decideAsk({ ...base, spent: 0, request: request({ options: [] }) }).allowed, false);
	// An input needs no options.
	assert.equal(
		decideAsk({ ...base, spent: 0, request: request({ method: "input", options: undefined }) }).allowed,
		true,
	);
	// `editor` is not a question, and neither is a made-up method.
	assert.equal(decideAsk({ ...base, spent: 0, request: request({ method: "editor" }) }).allowed, false);
	assert.equal(decideAsk({ ...base, spent: 0, request: request({ method: "wat" }) }).allowed, false);
	// An empty question cannot be answered.
	assert.equal(
		decideAsk({ ...base, spent: 0, request: request({ title: "   ", method: "input", options: undefined }) }).allowed,
		false,
	);

	// Long questions are capped, options trimmed and limited.
	const long = decideAsk({
		...base,
		spent: 0,
		request: request({ title: "x".repeat(QUESTION_MAX_CHARS + 500), options: Array(20).fill("  option  ") }),
	});
	assert.equal(long.allowed, true);
	assert.equal(long.question?.length, QUESTION_MAX_CHARS);
	assert.ok((long.options?.length ?? 0) <= 6, "options are capped");
	assert.equal(long.options?.[0], "option", "options are trimmed");
});

test("a question that asks for permission is refused, and told why", () => {
	for (const question of [
		"May I proceed with the migration?",
		"Can I ship this?",
		"Please approve the plan",
		"Do I have authorization to push?",
		"ok to merge?",
		"go / no-go on the rewrite?",
	]) {
		assert.equal(looksLikeAuthorization(question), true, `should read as authorization: ${question}`);
		const decision = decideAsk({
			role: "planner",
			hasOperator: true,
			spent: 0,
			request: request({ title: question, method: "input", options: undefined }),
		});
		assert.equal(decision.allowed, false, `must be refused: ${question}`);
		assert.match(decision.reason ?? "", /A dialog is not a checkpoint/);
		assert.match(decision.reason ?? "", /cp-authorize/, "the refusal names who may authorize");
	}

	// The boundary is authorization, not caution: real design questions pass.
	for (const question of [
		"Postgres or SQLite for the cache?",
		"Should the retry budget be per job or per fleet?",
		"Which module owns the token refresh?",
	]) {
		assert.equal(looksLikeAuthorization(question), false, `should not read as authorization: ${question}`);
		assert.equal(
			decideAsk({
				role: "planner",
				hasOperator: true,
				spent: 0,
					request: request({ title: question, method: "input", options: undefined }),
			}).allowed,
			true,
			`must be allowed: ${question}`,
		);
	}
});

test("cp-nz95: authorizationTrigger quotes the wording, and never decides what is refused", () => {
	// The predicate and the description are separate functions on purpose: the
	// description may fail to produce a quotable phrase; the refusal must not
	// change because of it.
	for (const question of [
		"May I proceed with the migration?",
		"Please approve the plan",
		"ok to merge?",
		"go / no-go on the rewrite?",
		"Postgres or SQLite for the cache?",
		"Which module owns the token refresh?",
	]) {
		const trigger = authorizationTrigger(question);
		assert.equal(
			looksLikeAuthorization(question),
			QUESTION_AUTHORIZATION_PATTERNS.some((pattern) => pattern.test(question)),
			`the predicate must be exactly the pattern set, unchanged: ${question}`,
		);
		if (looksLikeAuthorization(question)) {
			assert.ok(trigger && trigger.length > 0, `a real trigger is quotable: ${question}`);
			assert.match(question.toLowerCase(), new RegExp(trigger!.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		} else {
			assert.equal(trigger, undefined, `nothing to quote: ${question}`);
		}
	}
});

test("cp-nz95: authorizationTrigger is pure over a /g pattern and quotes nothing for a whitespace-only match", () => {
	// A /g (or /y) regex carries `lastIndex` between calls, so a naive `match`
	// would answer differently on the second call. The same input must give the
	// same trigger every time.
	const global = [/\bapprove\b/gi];
	assert.equal(authorizationTrigger("please approve the plan", global), "approve");
	assert.equal(authorizationTrigger("please approve the plan", global), "approve", "a /g pattern must not drift");
	assert.equal(authorizationTrigger("nothing to see", global), undefined);

	// A pattern that can match only whitespace has matched — there is simply no
	// phrase worth printing. The description says undefined; the predicate, which
	// is the thing that refuses, is untouched by that.
	const whitespace = [/\s+/];
	assert.equal(authorizationTrigger("ship it — or drop it?", whitespace), undefined);
	assert.equal(looksLikeAuthorization("ship it — or drop it?"), false, "the predicate never consults the trigger");
});

// ---------------------------------------------------------------------------
// the journal
// ---------------------------------------------------------------------------

test("the journal is append-only, validated, and survives a torn line", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new QuestionStore(home.path);

	assert.deepEqual(store.list(BR), [], "no file is not an error");
	assert.equal(store.count(BR), 0);
	assert.equal(store.open(BR), undefined);

	const asked = store.append({
		schema_version: SCHEMA_VERSION,
		job_id: BR,
		seq: 1,
		dialog_id: "dlg-1",
		role: "planner",
		method: "select",
		question: "Postgres or SQLite?",
		options: ["Postgres", "SQLite"],
		asked_at: isoTimestamp(),
		outcome: "timeout",
	});
	assert.equal(asked.seq, 1);
	assert.equal(store.open(BR)?.dialog_id, "dlg-1", "an unclosed exchange is the open one");

	store.append({
		...asked,
		closed_at: isoTimestamp(),
		outcome: "answered",
		answer: "Postgres",
		answered_by: "operator dialog (tui)",
	});
	assert.equal(store.list(BR).length, 2, "closing a question appends; it never rewrites");
	assert.equal(store.list(BR).at(-1)?.answer, "Postgres");
	// One exchange, two lines: the cap counts exchanges or it halves itself, and
	// an answered exchange is no longer open.
	assert.equal(store.count(BR), 1);
	assert.equal(store.open(BR), undefined);

	// A half-written last line (a crash mid-append) must not break a job.
	writeFileSync(store.file(BR), `${readFileSync(store.file(BR), "utf8")}{"job_id":"cp-ask1","seq"`);
	assert.equal(store.list(BR).length, 2, "a torn line is skipped, not thrown");

	// Garbage in is refused at the door.
	assert.throws(() => store.append({ job_id: BR } as never), QuestionError);
});

// ---------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------

function relayWith(home: string, asker?: Asker, options: { maxPerJob?: number } = {}): QuestionRelay {
	return new QuestionRelay({
		home,
		...(asker ? { asker } : {}),
		...(options.maxPerJob !== undefined ? { maxPerJob: options.maxPerJob } : {}),
	});
}

test("an answered question reaches the worker and lands in the journal", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const seen: OperatorQuestion[] = [];
	const events: Array<[string, string]> = [];
	const relay = new QuestionRelay({
		home: home.path,
		asker: {
			async ask(question) {
				seen.push(question);
				return { answer: "Postgres", by: "operator dialog (tui)" };
			},
		},
		onEvent: (jobId, kind) => events.push([jobId, kind]),
	});

	const result = await relay.handle({ jobId: BR, role: "planner", request: request() });
	assert.deepEqual(result.answer, { value: "Postgres" }, "the worker gets the operator's words verbatim");
	assert.equal(result.outcome, "answered");
	assert.equal(seen[0]?.question, "Postgres or SQLite?");
	assert.ok(seen[0]?.timeout_ms > 0, "the asker is given the deadline; it does not invent one");

	// Both halves are on the record: asked, then closed.
	const journal = relay.store.list(BR);
	assert.equal(journal.length, 2);
	assert.equal(journal[0]?.closed_at, undefined);
	assert.equal(journal[1]?.outcome, "answered");
	assert.equal(journal[1]?.answered_by, "operator dialog (tui)");
	// And the run log carries the exchange, because /watch is not the parent's context.
	assert.deepEqual(events, [
		[BR, "question_asked"],
		[BR, "question_closed"],
	]);
});

test("every way of not answering ends as `no answer`, on the record", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	// Dismissed.
	const dismissed = relayWith(home.path, { async ask() { return undefined; } });
	const a = await dismissed.handle({ jobId: "cp-dismiss", role: "planner", request: request() });
	assert.deepEqual(a.answer, { cancelled: true });
	assert.equal(a.outcome, "cancelled");
	assert.equal(dismissed.store.list("cp-dismiss").at(-1)?.outcome, "cancelled");

	// An asker that throws is not a worker's problem to solve.
	const broken = relayWith(home.path, {
		async ask() {
			throw new Error("the dialog exploded");
		},
	});
	const b = await broken.handle({ jobId: "cp-broken", role: "planner", request: request() });
	assert.deepEqual(b.answer, { cancelled: true });
	assert.equal(b.outcome, "cancelled");

	// No operator at all: distinct outcome, because it is an environment fact
	// rather than a policy decision.
	const headless = relayWith(home.path);
	assert.equal(headless.hasOperator, false);
	const c = await headless.handle({ jobId: "cp-headless", role: "planner", request: request() });
	assert.deepEqual(c.answer, { cancelled: true });
	assert.equal(c.outcome, "no_operator");
	assert.equal(headless.store.list("cp-headless").at(-1)?.outcome, "no_operator");

	// A refusal is journaled with its reason: "the worker tried to ask" is never
	// invisible.
	const refusing = relayWith(home.path, { async ask() { return { answer: "yes", by: "x" }; } });
	const d = await refusing.handle({ jobId: "cp-refused", role: "implementer", request: request() });
	assert.equal(d.outcome, "refused");
	assert.deepEqual(d.answer, { cancelled: true });
	assert.match(refusing.store.list("cp-refused").at(-1)?.reason ?? "", /does not ask the operator/);
});

test("the relay counts refusals against the cap and never asks a human twice", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	let asked = 0;
	const relay = relayWith(
		home.path,
		{
			async ask() {
				asked += 1;
				return { answer: "one", by: "operator dialog (tui)" };
			},
		},
		{ maxPerJob: 1 },
	);

	const first = await relay.handle({ jobId: "cp-cap", role: "planner", request: request() });
	assert.equal(first.outcome, "answered");
	const second = await relay.handle({ jobId: "cp-cap", role: "planner", request: request({ id: "dlg-2" }) });
	assert.equal(second.outcome, "refused", "the second question is refused by the cap");
	assert.equal(asked, 1, "and the human is not disturbed by a question that was never allowed");
});

test("a confirm becomes a boolean, and a long answer is truncated", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	for (const [answer, expected] of [["yes", true], ["y", true], ["ok", true], ["no", false], ["maybe", false]] as const) {
		const relay = relayWith(home.path, { async ask() { return { answer, by: "operator dialog (tui)" }; } });
		const result = await relay.handle({
			jobId: `cp-confirm-${answer}`,
			role: "planner",
			request: request({ method: "confirm", options: undefined }),
		});
		assert.deepEqual(result.answer, { confirmed: expected }, `confirm("${answer}") should be ${expected}`);
	}

	const chatty = relayWith(home.path, {
		async ask() {
			return { answer: "x".repeat(QUESTION_ANSWER_MAX_CHARS + 500), by: "operator dialog (tui)" };
		},
	});
	const result = await chatty.handle({ jobId: "cp-long", role: "planner", request: request() });
	const value = (result.answer as { value: string }).value;
	assert.equal(value.length, QUESTION_ANSWER_MAX_CHARS, "a worker's context is not an inbox");
});

test("the journal lives in the run dir, and one line renders for an operator", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const relay = relayWith(home.path, { async ask() { return { answer: "SQLite", by: "operator dialog (tui)" }; } });
	await relay.handle({ jobId: BR, role: "planner", request: request() });

	assert.ok(relay.store.file(BR).endsWith(paths.questionsFile(BR)), "questions.jsonl belongs to the job's run dir");
	const rendered = formatQuestion(relay.store.list(BR).at(-1) as never);
	assert.match(rendered, /cp-ask1 q1 \[answered\]/, "both lines of one exchange share its number");
	assert.match(rendered, /Postgres or SQLite\? → SQLite \(operator dialog \(tui\)\)/);
});

// ---------------------------------------------------------------------------
// cp-xbxz: a worker that dies mid-question
// ---------------------------------------------------------------------------

test("cp-xbxz: a worker that dies mid-question closes `worker_exited`, and the journal never says answered", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const controller = new AbortController();
	const handed: (AbortSignal | undefined)[] = [];
	const events: Array<[string, string]> = [];
	const relay = new QuestionRelay({
		home: home.path,
		asker: {
			// An asker that ignores the signal completely and answers anyway: the
			// relay must neither hang on it nor believe it.
			async ask(question) {
				handed.push(question.signal);
				await new Promise((resolve) => setTimeout(resolve, 40));
				return { answer: "Postgres", by: "operator dialog (tui)" };
			},
		},
		onEvent: (jobId, kind) => events.push([jobId, kind]),
	});

	const pending = relay.handle({
		jobId: "cp-died",
		role: "planner",
		request: request(),
		signal: controller.signal,
	});
	assert.ok(handed[0] instanceof AbortSignal, "the signal is handed to the asker, for its own dialog to honour");
	controller.abort(new Error("worker exited (code=null signal=SIGKILL)"));

	const result = await pending;
	assert.equal(result.outcome, "worker_exited", "death is its own outcome, never `answered`");
	assert.deepEqual(result.answer, { cancelled: true });

	const journal = relay.store.list("cp-died");
	assert.equal(journal.length, 2, "asked, then closed — append-only as ever");
	const closed = journal.at(-1);
	assert.equal(closed?.outcome, "worker_exited");
	assert.equal(closed?.answer, undefined, "an answer nobody received is not journaled as one");
	assert.equal(closed?.answered_by, undefined);
	// The exchange happened, so it is counted: `worker_exited` is not a free retry.
	assert.equal(relay.store.count("cp-died"), 1);
	assert.equal(relay.store.open("cp-died"), undefined, "and the exchange is closed, not left hanging");
	assert.deepEqual(events, [
		["cp-died", "question_asked"],
		["cp-died", "question_closed"],
	]);
	// One operator-facing line, and it cannot be mistaken for an answer.
	const rendered = formatQuestion(closed as never);
	assert.match(rendered, /\[worker_exited\]/);
	assert.ok(!rendered.includes("→"), `no answer arrow: nothing was answered here — ${rendered}`);
	assert.ok(!rendered.includes("operator dialog"), `and no human is credited with it — ${rendered}`);
});

test("cp-xbxz: a question for an already-dead worker never reaches a human", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	let asked = 0;
	const relay = new QuestionRelay({
		home: home.path,
		asker: {
			async ask() {
				asked += 1;
				return { answer: "Postgres", by: "operator dialog (tui)" };
			},
		},
	});
	const result = await relay.handle({
		jobId: "cp-gone",
		role: "planner",
		// Either place carries it; the transport puts it on the request.
		request: { ...request(), signal: AbortSignal.abort() },
	});
	assert.equal(result.outcome, "worker_exited");
	assert.equal(asked, 0, "nobody is interrupted for a worker that cannot receive the answer");
	assert.equal(relay.store.list("cp-gone").at(-1)?.answer, undefined);
});

test("cp-xbxz: an asker that hangs forever still resolves the relay when the worker dies", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const controller = new AbortController();
	const relay = new QuestionRelay({
		home: home.path,
		// The pathological case: a dialog nobody will ever answer or dismiss.
		asker: { ask: () => new Promise(() => {}) },
	});
	const pending = relay.handle({ jobId: "cp-hang", role: "planner", request: request(), signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	const result = await pending;
	assert.equal(result.outcome, "worker_exited", "the relay races the signal; it does not trust the asker to");
	assert.deepEqual(result.answer, { cancelled: true });
});


test("review: a cp:plan-review dialog is method review, and the summary is the question", () => {
	const request = normaliseReviewRequest({ id: "d1", method: "input", title: REVIEW_DIALOG_TITLE, placeholder: "Plan written; cache in redis." });
	assert.equal(request.method, "review");
	assert.equal(request.message, "Plan written; cache in redis.");
});

test("review: a plan review is a decision, not a dialog", () => {
	const base = { request: normaliseReviewRequest({ id: "d1", method: "input", title: REVIEW_DIALOG_TITLE, placeholder: "May I proceed? Plan ready." }), spent: 99, hasOperator: true };
	const planner = decideAsk({ ...base, role: "planner" });
	assert.equal(planner.allowed, false);
	assert.match(planner.reason ?? "", /decision/);
	const implementer = decideAsk({ ...base, role: "implementer" });
	assert.equal(implementer.allowed, false);
});
