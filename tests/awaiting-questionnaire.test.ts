/**
 * cp-vvaz: the Awaiting-you decide UI as a questionnaire, not as a stack of
 * select dialogs.
 *
 * Everything here runs with no pi, no terminal and no package: `ask` is an
 * injected dependency that returns what a submitted overlay would return, and
 * the writers are spies. The properties under test are the ones a wrong
 * projection would break silently — an option string that does not round-trip,
 * a sentinel that reaches a writer, an unanswered tab that writes something, an
 * item the overlay cannot render being dropped instead of deferred, and a loop
 * that does not converge.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AskQuestionnaireOutcome,
	type AwaitingQuestion,
	buildAwaitingQuestions,
	driveAwaitingQuestionnaire,
	QUESTIONNAIRE_MAX_LABEL_LENGTH,
	QUESTIONNAIRE_MAX_OPTIONS,
	QUESTIONNAIRE_MAX_QUESTIONS,
	QUESTIONNAIRE_RESERVED_LABELS,
	questionHeader,
	questionOptions,
	renderOptions,
} from "../src/awaiting-questionnaire.ts";
import type { ResolvedAwaitingItem } from "../src/awaiting.ts";
import {
	AWAITING_SKIP_OPTION,
	PLAN_VIEW_AGAIN_OPTION,
	PLAN_VIEW_OPTION,
} from "../src/contracts.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function item(overrides: Partial<ResolvedAwaitingItem> = {}): ResolvedAwaitingItem {
	return {
		id: "aw-1",
		type: "approval",
		decision: "Ship cp-x, drop it, or open a follow-up?",
		why: "research finished with no PR",
		blocks: "the whole pipeline",
		options: ["ship", "drop", "follow-up"],
		opened_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

const authorization = () =>
	item({ id: "aw-2", type: "authorization", decision: "Authorize cp-y?", options: ["approve", "decline"] });

// ---------------------------------------------------------------------------
// 1. One item's option list
// ---------------------------------------------------------------------------

test("the plan row leads while unread and trails once read", () => {
	const unread = questionOptions(item(), { planViewable: true, planViewed: false });
	assert.deepEqual(unread, [PLAN_VIEW_OPTION, "ship", "drop", "follow-up"]);
	const read = questionOptions(item(), { planViewable: true, planViewed: true });
	assert.deepEqual(read, ["ship", "drop", "follow-up", PLAN_VIEW_AGAIN_OPTION]);
});

test("no plan means the item's own options, unreordered", () => {
	assert.deepEqual(questionOptions(item(), { planViewable: false, planViewed: false }), ["ship", "drop", "follow-up"]);
});

test("never more than the package's four options, and an option is never dropped", () => {
	const four = item({ options: ["a", "b", "c", "d"] });
	// The plan row cannot fit, so it is not offered — but every option the item
	// carries is still there.
	assert.deepEqual(questionOptions(four, { planViewable: true, planViewed: false }), ["a", "b", "c", "d"]);
	const five = item({ options: ["a", "b", "c", "d", "e"] });
	assert.equal(questionOptions(five, { planViewable: false, planViewed: false }), undefined);
});

test("a single-option item is padded with Skip, never with an invented answer", () => {
	assert.deepEqual(questionOptions(item({ options: ["ship"] }), { planViewable: false, planViewed: false }), [
		"ship",
		AWAITING_SKIP_OPTION,
	]);
	// Nothing at all to offer: the overlay cannot render it.
	assert.equal(questionOptions(item({ options: [] }), { planViewable: false, planViewed: false }), undefined);
});

test("candidates fill the room that is left and never displace the way back to the pager", () => {
	const menu = questionOptions(item({ options: ["ship"] }), { planViewable: true, planViewed: true }, ["Monday", "never"]);
	assert.deepEqual(menu, ["ship", "Monday", "never", PLAN_VIEW_AGAIN_OPTION]);
	assert.ok((menu as string[]).length <= QUESTIONNAIRE_MAX_OPTIONS);
});

test("no menu this projection can produce carries a reserved label", () => {
	for (const options of [[], ["ship"], ["approve", "decline"], ["a", "b", "c", "d"]]) {
		for (const planViewable of [false, true]) {
			for (const planViewed of [false, true]) {
				const menu = questionOptions(item({ options }), { planViewable, planViewed }, ["x"]);
				for (const label of menu ?? []) assert.ok(!QUESTIONNAIRE_RESERVED_LABELS.has(label), label);
			}
		}
	}
});

// ---------------------------------------------------------------------------
// 2. Rendering, and the identity guarantee
// ---------------------------------------------------------------------------

test("short options render verbatim; long ones are numbered with the full string as description", () => {
	const verbatim = renderOptions(["ship", "drop"]);
	assert.ok(verbatim);
	assert.equal(verbatim.verbatim, true);
	assert.deepEqual(
		verbatim.options.map((option) => option.label),
		["ship", "drop"],
	);

	const long = `ship it once CI is green on the pushed head ${"and".repeat(20)}`;
	const rendered = renderOptions([long, "drop"]);
	assert.ok(rendered);
	assert.equal(rendered.verbatim, false);
	for (const option of rendered.options) assert.ok(option.label.length <= QUESTIONNAIRE_MAX_LABEL_LENGTH, option.label);
	assert.equal(rendered.options[0]?.description, long);
	assert.equal(rendered.originalByLabel.get(rendered.options[0]?.label as string), long);
});

// ---------------------------------------------------------------------------
// 3. Building one batch
// ---------------------------------------------------------------------------

test("a batch is at most four questions, each with a bounded header and a unique body", () => {
	const items = [1, 2, 3, 4, 5].map((n) => item({ id: `aw-${n}` }));
	const built = buildAwaitingQuestions({ items });
	assert.equal(built.questions.length, QUESTIONNAIRE_MAX_QUESTIONS);
	assert.equal(new Set(built.questions.map((question) => question.question)).size, QUESTIONNAIRE_MAX_QUESTIONS);
	for (const question of built.questions) {
		assert.ok(question.header.length <= 16);
		assert.ok(question.question.includes(question.item.id), "the id is in the body, so two rows are never the same question");
		assert.ok(question.question.includes(question.item.decision));
	}
	assert.deepEqual(built.deferred, []);
	assert.equal(questionHeader({ type: "authorization" }), "Authorize");
});

test("an item the overlay cannot render is deferred with a reason, never dropped", () => {
	const built = buildAwaitingQuestions({ items: [item({ id: "aw-9", options: [] }), item()] });
	assert.equal(built.questions.length, 1);
	assert.equal(built.deferred.length, 1);
	assert.equal(built.deferred[0]?.item.id, "aw-9");
	assert.match(built.deferred[0]?.reason as string, /options/);
});

test("a viewable plan that does not fit becomes a hint in the question body", () => {
	const built = buildAwaitingQuestions({
		items: [item({ options: ["a", "b", "c", "d"], job_id: "cp-x" })],
		planViewable: () => true,
		planHint: (row) => `read the plan first with /cp-plan ${row.job_id}`,
	});
	assert.ok(built.questions[0]?.question.includes("/cp-plan cp-x"));
});

// ---------------------------------------------------------------------------
// 4. The loop
// ---------------------------------------------------------------------------

interface DriveHarness {
	answers: { id: string; value: string }[];
	asked: AwaitingQuestion[][];
	viewed: string[];
	notices: { text: string; level: string }[];
}

function drive(
	items: ResolvedAwaitingItem[],
	reply: (questions: AwaitingQuestion[], round: number) => AskQuestionnaireOutcome,
	overrides: Partial<Parameters<typeof driveAwaitingQuestionnaire>[0]> = {},
) {
	const h: DriveHarness = { answers: [], asked: [], viewed: [], notices: [] };
	let open = [...items];
	let round = 0;
	const outcome = driveAwaitingQuestionnaire({
		snapshot: () => open,
		ask: async (questions) => {
			h.asked.push(questions);
			const result = reply(questions, round);
			round += 1;
			return result;
		},
		answer: async (row, value) => {
			h.answers.push({ id: row.id, value });
			open = open.filter((entry) => entry.id !== row.id);
		},
		viewPlan: async (row) => {
			h.viewed.push(row.id);
		},
		notify: (text, level) => h.notices.push({ text, level }),
		...overrides,
	});
	return { h, outcome };
}

test("a submitted option is recorded byte-identically, even when its label was truncated", async () => {
	const long = `ship it once CI is green on the pushed head ${"and".repeat(20)}`;
	const { h, outcome } = drive([item({ options: [long, "drop"] })], (questions) => ({
		kind: "answers",
		answers: [{ kind: "option", label: questions[0]?.options[0]?.label as string }],
	}));
	const result = await outcome;
	assert.deepEqual(h.answers, [{ id: "aw-1", value: long }]);
	assert.equal(result.steps.filter((step) => step.kind === "answered").length, 1);
});

test("every open item is one tab of one overlay call", async () => {
	const items = [1, 2, 3].map((n) => item({ id: `aw-${n}` }));
	const { h, outcome } = drive(items, () => ({
		kind: "answers",
		answers: [{ kind: "none" }, { kind: "none" }, { kind: "none" }],
	}));
	await outcome;
	assert.equal(h.asked.length, 1);
	assert.equal(h.asked[0]?.length, 3);
});

test("an unanswered tab writes nothing and is not re-asked in the same run", async () => {
	const { h, outcome } = drive([item(), item({ id: "aw-2" })], () => ({
		kind: "answers",
		answers: [{ kind: "none" }, { kind: "none" }],
	}));
	const result = await outcome;
	assert.deepEqual(h.answers, []);
	assert.equal(h.asked.length, 1);
	assert.equal(result.reason, "done");
	assert.equal(result.steps.filter((step) => step.kind === "skipped").length, 2);
});

test("Esc is a skip for the whole batch and writes nothing", async () => {
	const { h, outcome } = drive([item()], () => ({ kind: "cancelled" }));
	const result = await outcome;
	assert.equal(result.reason, "cancelled");
	assert.deepEqual(h.answers, []);
});

test("free text is recorded as the answer; blank free text is a skip", async () => {
	const typed = await drive([item()], () => ({ kind: "answers", answers: [{ kind: "custom", text: "  ship Monday " }] }));
	await typed.outcome;
	assert.deepEqual(typed.h.answers, [{ id: "aw-1", value: "ship Monday" }]);

	const blank = await drive([item()], () => ({ kind: "answers", answers: [{ kind: "custom", text: "   " }] }));
	await blank.outcome;
	assert.deepEqual(blank.h.answers, []);
});

test("a label the overlay was never given is a skip, never a guessed answer", async () => {
	const { h, outcome } = drive([item()], () => ({
		kind: "answers",
		answers: [{ kind: "option", label: "something the operator never saw" }],
	}));
	await outcome;
	assert.deepEqual(h.answers, []);
});

test("Skip is a sentinel: it never reaches a writer", async () => {
	const { h, outcome } = drive([item({ options: ["ship"] })], (questions) => {
		const skip = questions[0]?.options.find((option) => option.label === AWAITING_SKIP_OPTION);
		assert.ok(skip);
		return { kind: "answers", answers: [{ kind: "option", label: skip.label }] };
	});
	await outcome;
	assert.deepEqual(h.answers, []);
});

test("reading the plan records nothing and re-offers the item with the pager last", async () => {
	const { h, outcome } = drive(
		[item({ job_id: "cp-x" })],
		(questions, round) =>
			round === 0
				? { kind: "answers", answers: [{ kind: "option", label: PLAN_VIEW_OPTION }] }
				: { kind: "answers", answers: [{ kind: "option", label: questions[0]?.options[0]?.label as string }] },
		{ planViewable: () => true },
	);
	const result = await outcome;
	assert.deepEqual(h.viewed, ["aw-1"]);
	assert.equal(h.asked.length, 2);
	assert.equal(h.asked[0]?.[0]?.options[0]?.label, PLAN_VIEW_OPTION);
	assert.equal(h.asked[1]?.[0]?.options.at(-1)?.label, PLAN_VIEW_AGAIN_OPTION);
	// The second round answered the first option, which is now `ship`.
	assert.deepEqual(h.answers, [{ id: "aw-1", value: "ship" }]);
	assert.equal(result.reason, "done");
});

test("an unavailable overlay reports the reason and answers nothing", async () => {
	const { h, outcome } = drive([item()], () => ({ kind: "unavailable", reason: "package not installed" }));
	const result = await outcome;
	assert.equal(result.reason, "unavailable");
	assert.equal(result.message, "package not installed");
	assert.deepEqual(h.answers, []);
});

test("a note-only write is reported as noted, and a refused write as failed", async () => {
	const noted = driveAwaitingQuestionnaire({
		snapshot: () => [authorization()],
		ask: async (questions) => ({
			kind: "answers",
			answers: [{ kind: "option", label: questions[0]?.options[0]?.label as string }],
		}),
		answer: async () => ({ note: "kept as a note" }),
	});
	assert.equal((await noted).steps[0]?.kind, "noted");

	const failed = driveAwaitingQuestionnaire({
		snapshot: () => [authorization()],
		ask: async (questions) => ({
			kind: "answers",
			answers: [{ kind: "option", label: questions[0]?.options[0]?.label as string }],
		}),
		answer: async () => {
			throw new Error("only CheckpointStore.decide records one");
		},
	});
	const failedOutcome = await failed;
	assert.equal(failedOutcome.steps[0]?.kind, "failed");
	assert.equal(failedOutcome.reason, "done");
});

test("a failed snapshot is an outcome, never a throw into the decision", async () => {
	const outcome = await driveAwaitingQuestionnaire({
		snapshot: () => {
			throw new Error("state/awaiting.json is unreadable");
		},
		ask: async () => ({ kind: "cancelled" }),
		answer: async () => undefined,
	});
	assert.equal(outcome.reason, "error");
	assert.match(outcome.message as string, /unreadable/);
});

test("nothing open says so once, and asks nothing", async () => {
	const notices: string[] = [];
	const outcome = await driveAwaitingQuestionnaire({
		snapshot: () => [],
		ask: async () => assert.fail("must not ask"),
		answer: async () => undefined,
		announceEmpty: true,
		notify: (text) => notices.push(text),
	});
	assert.equal(outcome.reason, "empty");
	assert.deepEqual(notices, ["Awaiting you: none"]);
});

test("deferred items are carried out of the loop so the caller can answer them plainly", async () => {
	const { outcome } = drive([item({ id: "aw-9", options: [] }), item()], () => ({
		kind: "answers",
		answers: [{ kind: "none" }],
	}));
	const result = await outcome;
	assert.deepEqual(
		result.deferred.map((entry) => entry.item.id),
		["aw-9"],
	);
});

test("authorization rows are never sent to the candidate generator", async () => {
	let asked = 0;
	await driveAwaitingQuestionnaire({
		snapshot: () => [authorization()],
		ask: async () => ({ kind: "cancelled" }),
		answer: async () => undefined,
		suggest: () => {
			asked += 1;
			return ["something"];
		},
	});
	assert.equal(asked, 0);
});

test("the loop converges even if the operator keeps reading the plan", async () => {
	let rounds = 0;
	const outcome = await driveAwaitingQuestionnaire({
		snapshot: () => [item({ job_id: "cp-x" })],
		ask: async (built) => {
			rounds += 1;
			const pager = built[0]?.options.find(
				(option) => option.label === PLAN_VIEW_OPTION || option.label === PLAN_VIEW_AGAIN_OPTION,
			);
			assert.ok(pager, "the pager is always one keystroke away");
			return { kind: "answers", answers: [{ kind: "option", label: pager.label }] };
		},
		answer: async () => assert.fail("nothing is answered by reading a plan"),
		planViewable: () => true,
		viewPlan: async () => undefined,
		maxRounds: 5,
	});
	assert.equal(outcome.reason, "exhausted");
	assert.equal(rounds, 5);
});
