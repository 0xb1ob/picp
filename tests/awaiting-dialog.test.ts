/**
 * cp-viewer-scroll-stuck: the Awaiting-you dialog's state machine, driven with
 * scripted prompts — no pi, no terminal, no home.
 *
 * The defect these tests exist for: reading the plan is a **step**, and after
 * that step the operator must be able to leave the item (Done) or answer it.
 * Before this, the menu re-opened with `View the plan…` highlighted, so the
 * next Enter reopened the pager — "I clicked done and we are still stuck on
 * this decide".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	answerMenuOptions,
	driveAwaitingDialog,
	isAwaitingSentinel,
	type AwaitingDialogDeps,
} from "../src/awaiting-dialog.ts";
import type { ResolvedAwaitingItem } from "../src/awaiting.ts";
import {
	AWAITING_DONE_OPTION,
	AWAITING_SENTINEL_OPTIONS,
	AWAITING_SKIP_OPTION,
	AWAITING_TYPE_OPTION,
	PLAN_VIEW_AGAIN_OPTION,
	PLAN_VIEW_BACK_OPTION,
	PLAN_VIEW_OPTION,
} from "../src/contracts.ts";

const RESEARCH_ITEM: ResolvedAwaitingItem = {
	id: "aw-research-cp-x",
	type: "approval",
	decision: "cp-x: ship, drop or follow-up?",
	why: "finished research with no ship decision yet",
	blocks: "cp-x follow-on work",
	job_id: "cp-x",
	options: ["ship", "drop", "follow-up"],
	opened_at: "2026-08-27T12:00:00Z",
};

const CHECKPOINT_ITEM: ResolvedAwaitingItem = {
	id: "aw-checkpoint-cp-ship",
	type: "authorization",
	decision: "authorize cp-ship?",
	why: "the gate passed",
	blocks: "cp-ship implementation",
	job_id: "cp-ship",
	options: ["approve", "decline"],
	opened_at: "2026-08-27T12:00:00Z",
};

interface Harness {
	deps: AwaitingDialogDeps;
	/** Every (title, options) pair the dialog showed, in order. */
	prompts: Array<{ title: string; options: string[] }>;
	/** Every answer that reached the writer. Empty = nothing recorded. */
	recorded: Array<{ id: string; value: string }>;
	views: string[];
	notices: Array<{ text: string; level: string }>;
}

/**
 * `picks` is answered in order against the prompts the dialog raises: a string
 * is the option chosen (or the free text typed), `undefined` is a dismissal.
 * Anything past the end of the script dismisses, so a runaway loop ends rather
 * than hanging the test.
 */
function harness(options: {
	items: ResolvedAwaitingItem[] | (() => ResolvedAwaitingItem[]);
	picks: Array<string | undefined>;
	typed?: Array<string | undefined>;
	planViewable?: boolean;
	answerThrows?: string;
	note?: string;
	snapshotThrows?: string;
	announceEmpty?: boolean;
}): Harness {
	const prompts: Harness["prompts"] = [];
	const recorded: Harness["recorded"] = [];
	const views: string[] = [];
	const notices: Harness["notices"] = [];
	const picks = [...options.picks];
	const typed = [...(options.typed ?? [])];
	const deps: AwaitingDialogDeps = {
		snapshot: () => {
			if (options.snapshotThrows) throw new Error(options.snapshotThrows);
			return typeof options.items === "function" ? options.items() : options.items;
		},
		formatLine: (item) => `${item.id} — ${item.decision}`,
		select: async (title, opts) => {
			prompts.push({ title, options: [...opts] });
			return picks.length > 0 ? picks.shift() : undefined;
		},
		input: async (title) => {
			prompts.push({ title, options: ["<free text>"] });
			return typed.length > 0 ? typed.shift() : undefined;
		},
		answer: async (item, value) => {
			if (options.answerThrows) throw new Error(options.answerThrows);
			recorded.push({ id: item.id, value });
			return options.note ? { note: options.note } : {};
		},
		planViewable: () => options.planViewable ?? false,
		viewPlan: async (item) => {
			views.push(item.id);
		},
		notify: (text, level) => notices.push({ text, level }),
		...(options.announceEmpty ? { announceEmpty: true } : {}),
	};
	return { deps, prompts, recorded, views, notices };
}

// ---------------------------------------------------------------------------
// The menu itself — ordering is the fix, so it is asserted, not eyeballed
// ---------------------------------------------------------------------------

test("before the plan is read, the viewer is the default option and no answer is", () => {
	const options = answerMenuOptions(RESEARCH_ITEM, { planViewable: true, planViewed: false });
	assert.equal(options[0], PLAN_VIEW_OPTION, "the default-highlighted option must be the non-destructive one");
	assert.deepEqual(options, [PLAN_VIEW_OPTION, "ship", "drop", "follow-up", AWAITING_TYPE_OPTION, AWAITING_SKIP_OPTION]);
});

test("after the plan is read, the default option is Done — never the viewer again", () => {
	const options = answerMenuOptions(RESEARCH_ITEM, { planViewable: true, planViewed: true });
	assert.equal(options[0], PLAN_VIEW_BACK_OPTION, "Enter after reading must go forward, not reopen the pager");
	assert.ok(!options.slice(0, 1).includes(PLAN_VIEW_OPTION));
	assert.ok(options.includes(PLAN_VIEW_AGAIN_OPTION), "re-reading must still be one keystroke away");
	assert.ok(options.indexOf(PLAN_VIEW_AGAIN_OPTION) > 0);
});

test("with no viewable plan the menu is exactly what it always was", () => {
	assert.deepEqual(answerMenuOptions(RESEARCH_ITEM, { planViewable: false, planViewed: false }), [
		"ship",
		"drop",
		"follow-up",
		AWAITING_TYPE_OPTION,
		AWAITING_SKIP_OPTION,
	]);
});

test("every menu label is a sentinel, and no sentinel is an item option", () => {
	for (const option of AWAITING_SENTINEL_OPTIONS) assert.ok(isAwaitingSentinel(option), option);
	assert.equal(isAwaitingSentinel("ship"), false);
	assert.equal(isAwaitingSentinel("approve"), false);
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

test("viewing a plan and choosing Done returns to the item list with nothing recorded", async () => {
	const items = [RESEARCH_ITEM];
	const h = harness({
		items: () => items,
		planViewable: true,
		// list → item, menu → view the plan, menu(after) → Done reading, list → Done
		picks: [h0(items), PLAN_VIEW_OPTION, PLAN_VIEW_BACK_OPTION, AWAITING_DONE_OPTION],
	});
	const outcome = await driveAwaitingDialog(h.deps);

	assert.equal(outcome.reason, "done");
	assert.deepEqual(h.recorded, [], "nothing may be recorded by reading a plan");
	assert.deepEqual(h.views, ["aw-research-cp-x"]);
	// The menu came back for the *same* item, with Done first.
	const menus = h.prompts.filter((prompt) => prompt.title.startsWith(RESEARCH_ITEM.decision));
	assert.equal(menus.length, 2, `the item's menu must be re-shown once: ${JSON.stringify(h.prompts)}`);
	assert.equal(menus[1]?.options[0], PLAN_VIEW_BACK_OPTION);
	// And the item is still open: the list was rendered again after Done reading.
	const lists = h.prompts.filter((prompt) => prompt.title.startsWith("Awaiting you"));
	assert.equal(lists.length, 2);
});

test("answering after viewing records exactly the answer, once", async () => {
	const h = harness({
		items: () => [RESEARCH_ITEM],
		planViewable: true,
		picks: [h0([RESEARCH_ITEM]), PLAN_VIEW_OPTION, "ship", AWAITING_DONE_OPTION],
	});
	const outcome = await driveAwaitingDialog(h.deps);
	assert.deepEqual(h.recorded, [{ id: "aw-research-cp-x", value: "ship" }]);
	assert.deepEqual(
		outcome.steps.map((step) => step.kind),
		["viewed", "answered"],
	);
});

test("re-reading the plan is possible after Done, and still records nothing", async () => {
	const h = harness({
		items: () => [RESEARCH_ITEM],
		planViewable: true,
		picks: [h0([RESEARCH_ITEM]), PLAN_VIEW_OPTION, PLAN_VIEW_AGAIN_OPTION, PLAN_VIEW_BACK_OPTION, AWAITING_DONE_OPTION],
	});
	await driveAwaitingDialog(h.deps);
	assert.deepEqual(h.views, ["aw-research-cp-x", "aw-research-cp-x"]);
	assert.deepEqual(h.recorded, []);
});

test("skipping after viewing leaves the item open and writes nothing", async () => {
	const h = harness({
		items: () => [RESEARCH_ITEM],
		planViewable: true,
		picks: [h0([RESEARCH_ITEM]), PLAN_VIEW_OPTION, AWAITING_SKIP_OPTION, AWAITING_DONE_OPTION],
	});
	const outcome = await driveAwaitingDialog(h.deps);
	assert.deepEqual(h.recorded, []);
	assert.deepEqual(
		outcome.steps.map((step) => step.kind),
		["viewed", "skipped"],
	);
});

test("dismissing the item menu is a skip, never an answer", async () => {
	const h = harness({
		items: () => [RESEARCH_ITEM],
		planViewable: true,
		picks: [h0([RESEARCH_ITEM]), undefined, AWAITING_DONE_OPTION],
	});
	await driveAwaitingDialog(h.deps);
	assert.deepEqual(h.recorded, []);
});

test("free text is still available, and blank free text answers nothing", async () => {
	const answered = harness({
		items: () => [RESEARCH_ITEM],
		planViewable: true,
		picks: [h0([RESEARCH_ITEM]), AWAITING_TYPE_OPTION, AWAITING_DONE_OPTION],
		typed: ["follow-up, with a smaller scope"],
	});
	await driveAwaitingDialog(answered.deps);
	assert.deepEqual(answered.recorded, [{ id: "aw-research-cp-x", value: "follow-up, with a smaller scope" }]);

	const blank = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), AWAITING_TYPE_OPTION, AWAITING_DONE_OPTION],
		typed: ["   "],
	});
	await driveAwaitingDialog(blank.deps);
	assert.deepEqual(blank.recorded, [], "blank free text is not an answer");
});

test("a sentinel can never reach the writer, even typed verbatim as free text", async () => {
	for (const sentinel of AWAITING_SENTINEL_OPTIONS) {
		const h = harness({
			items: () => [RESEARCH_ITEM],
			picks: [h0([RESEARCH_ITEM]), AWAITING_TYPE_OPTION, AWAITING_DONE_OPTION],
			typed: [sentinel],
		});
		await driveAwaitingDialog(h.deps);
		assert.deepEqual(h.recorded, [], `${sentinel} was recorded as an answer`);
	}
});

test("free text on an authorization item is reported as a note, not an answer", async () => {
	const h = harness({
		items: () => [CHECKPOINT_ITEM],
		picks: [h0([CHECKPOINT_ITEM]), AWAITING_TYPE_OPTION, AWAITING_DONE_OPTION],
		typed: ["let me think about it"],
		note: "let me think about it",
	});
	const outcome = await driveAwaitingDialog(h.deps);
	assert.deepEqual(
		outcome.steps.map((step) => step.kind),
		["noted"],
	);
	assert.ok(h.notices.some((notice) => /stays pending/.test(notice.text)));
});

test("a refused write is surfaced and the dialog keeps going instead of throwing out", async () => {
	const h = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), "ship", AWAITING_DONE_OPTION],
		answerThrows: "awaiting item aw-research-cp-x is already answered",
	});
	const outcome = await driveAwaitingDialog(h.deps);
	assert.equal(outcome.reason, "done");
	assert.deepEqual(
		outcome.steps.map((step) => step.kind),
		["failed"],
	);
	assert.ok(h.notices.some((notice) => notice.level === "error"));
});

test("an empty set says so only when asked to, and answers nothing", async () => {
	const quiet = harness({ items: [], picks: [] });
	assert.equal((await driveAwaitingDialog(quiet.deps)).reason, "empty");
	assert.deepEqual(quiet.notices, []);

	const loud = harness({ items: [], picks: [], announceEmpty: true });
	await driveAwaitingDialog(loud.deps);
	assert.deepEqual(loud.notices, [{ text: "Awaiting you: none", level: "info" }]);
});

test("a failed snapshot ends in an error outcome, not an exception", async () => {
	const h = harness({ items: [], picks: [], snapshotThrows: "state/awaiting.json is not valid JSON" });
	const outcome = await driveAwaitingDialog(h.deps);
	assert.equal(outcome.reason, "error");
	assert.match(outcome.message ?? "", /not valid JSON/);
});

test("several items are answerable in one sitting, in any order", async () => {
	const second: ResolvedAwaitingItem = { ...RESEARCH_ITEM, id: "aw-research-cp-y", job_id: "cp-y", decision: "cp-y: ship, drop or follow-up?" };
	let open = [RESEARCH_ITEM, second];
	const h = harness({
		items: () => open,
		picks: [
			// pick the second row first
			"aw-research-cp-y — cp-y: ship, drop or follow-up?",
			"drop",
			// then the first
			"aw-research-cp-x — cp-x: ship, drop or follow-up?",
			"ship",
			AWAITING_DONE_OPTION,
		],
	});
	const deps: AwaitingDialogDeps = {
		...h.deps,
		answer: async (item, value) => {
			h.recorded.push({ id: item.id, value });
			open = open.filter((entry) => entry.id !== item.id);
		},
	};
	await driveAwaitingDialog(deps);
	assert.deepEqual(h.recorded, [
		{ id: "aw-research-cp-y", value: "drop" },
		{ id: "aw-research-cp-x", value: "ship" },
	]);
});

test("the loop cannot spin forever: an always-view script stops at the step cap", async () => {
	const h = harness({
		items: () => [RESEARCH_ITEM],
		planViewable: true,
		picks: Array.from({ length: 200 }, (_, index) => (index === 0 ? h0([RESEARCH_ITEM]) : PLAN_VIEW_AGAIN_OPTION)),
	});
	const outcome = await driveAwaitingDialog({ ...h.deps, maxSteps: 5 });
	assert.equal(outcome.reason, "exhausted");
	assert.deepEqual(h.recorded, []);
	assert.ok(h.notices.some((notice) => notice.level === "error"));
});

test("the state machine cannot reach an artifact body: no fs, no pi, no renderer", () => {
	const source = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "../src/awaiting-dialog.ts"),
		"utf8",
	);
	const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] as string);
	assert.deepEqual(imports.sort(), ["./awaiting.ts", "./contracts.ts"]);
	// The body only ever exists inside the injected `viewPlan`, which writes to a
	// terminal. Nothing here reads a file, and nothing here can append an entry.
	for (const forbidden of ["node:fs", "readFileSync", "appendEntry", "sendMessage", "pi-coding-agent", "pi-tui"]) {
		assert.ok(!source.includes(forbidden), `src/awaiting-dialog.ts mentions ${forbidden}`);
	}
});

/** The list-menu label for the first item, as `formatLine` renders it. */
function h0(items: ResolvedAwaitingItem[]): string {
	const item = items[0] as ResolvedAwaitingItem;
	return `${item.id} — ${item.decision}`;
}

// ---------------------------------------------------------------------------
// cp-7t7: generated candidate answers in the same menu
// ---------------------------------------------------------------------------

test("answerMenuOptions inserts suggestions between the item's options and Type an answer\u2026, never leading", () => {
	const suggestions = ["ship it \u2014 the gate passed", "follow-up: split the migration"];
	const withOptions = answerMenuOptions(RESEARCH_ITEM, { planViewable: false, planViewed: false }, suggestions);
	assert.deepEqual(withOptions, [
		"ship",
		"drop",
		"follow-up",
		...suggestions,
		AWAITING_TYPE_OPTION,
		AWAITING_SKIP_OPTION,
	]);
	assert.notEqual(withOptions[0], suggestions[0]);

	// No item options, no viewable plan: Type an answer\u2026 still leads.
	const bare = answerMenuOptions({ options: [] }, { planViewable: false, planViewed: false }, suggestions);
	assert.equal(bare[0], AWAITING_TYPE_OPTION);
	assert.deepEqual(bare, [AWAITING_TYPE_OPTION, ...suggestions, AWAITING_SKIP_OPTION]);

	// Both plan states, with suggestions present: still never a candidate first.
	const before = answerMenuOptions(RESEARCH_ITEM, { planViewable: true, planViewed: false }, suggestions);
	assert.equal(before[0], PLAN_VIEW_OPTION);
	const after = answerMenuOptions(RESEARCH_ITEM, { planViewable: true, planViewed: true }, suggestions);
	assert.equal(after[0], PLAN_VIEW_BACK_OPTION);

	// suggestions = [] is byte-identical to the pre-cp-7t7 menu (the regression proof).
	assert.deepEqual(
		answerMenuOptions(RESEARCH_ITEM, { planViewable: false, planViewed: false }),
		answerMenuOptions(RESEARCH_ITEM, { planViewable: false, planViewed: false }, []),
	);
});

test("suggestions render, nothing preselected, and reach the menu unmodified", async () => {
	const script = ["ship it \u2014 the gate passed", "follow-up: split the migration"];
	const h = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), "ship it \u2014 the gate passed", AWAITING_DONE_OPTION],
	});
	const deps: AwaitingDialogDeps = { ...h.deps, suggest: () => script };
	const outcome = await driveAwaitingDialog(deps);
	const itemMenu = h.prompts.find((prompt) => prompt.title.startsWith(RESEARCH_ITEM.decision));
	assert.ok(itemMenu, "the item menu must have been shown");
	assert.deepEqual(itemMenu?.options, ["ship", "drop", "follow-up", ...script, AWAITING_TYPE_OPTION, AWAITING_SKIP_OPTION]);
	assert.notEqual(itemMenu?.options[0], script[0]);
	assert.deepEqual(h.recorded, [{ id: "aw-research-cp-x", value: script[0] }]);
	assert.deepEqual(
		outcome.steps.map((step) => step.kind),
		["answered"],
	);
});

test("selecting a suggestion resolves exactly like typing the same text", async () => {
	const text = "follow-up: split the migration";
	const viaSuggestion = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), text, AWAITING_DONE_OPTION],
	});
	const outcomeA = await driveAwaitingDialog({ ...viaSuggestion.deps, suggest: () => [text] });

	const viaTyped = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), AWAITING_TYPE_OPTION, AWAITING_DONE_OPTION],
		typed: [text],
	});
	const outcomeB = await driveAwaitingDialog(viaTyped.deps);

	assert.deepEqual(viaSuggestion.recorded, viaTyped.recorded);
	assert.deepEqual(
		outcomeA.steps.map((step) => step.kind),
		outcomeB.steps.map((step) => step.kind),
	);
	assert.deepEqual(outcomeA.steps, outcomeB.steps);
});

test("a generator that throws, and one that exceeds the deadline, both degrade to today's exact menu", async () => {
	const throwing = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), AWAITING_TYPE_OPTION, AWAITING_DONE_OPTION],
		typed: ["free text still works"],
	});
	const deps1: AwaitingDialogDeps = {
		...throwing.deps,
		suggest: () => {
			throw new Error("boom");
		},
	};
	await driveAwaitingDialog(deps1);
	assert.deepEqual(throwing.recorded, [{ id: "aw-research-cp-x", value: "free text still works" }]);
	const thrownMenu = throwing.prompts.find((prompt) => prompt.title.startsWith(RESEARCH_ITEM.decision));
	assert.deepEqual(thrownMenu?.options, ["ship", "drop", "follow-up", AWAITING_TYPE_OPTION, AWAITING_SKIP_OPTION]);

	const slow = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), AWAITING_TYPE_OPTION, AWAITING_DONE_OPTION],
		typed: ["free text still works"],
	});
	const deps2: AwaitingDialogDeps = {
		...slow.deps,
		suggest: () => new Promise<string[]>(() => {}),
		suggestDeadlineMs: 5,
	};
	await driveAwaitingDialog(deps2);
	assert.deepEqual(slow.recorded, [{ id: "aw-research-cp-x", value: "free text still works" }]);
	const slowMenu = slow.prompts.find((prompt) => prompt.title.startsWith(RESEARCH_ITEM.decision));
	assert.deepEqual(slowMenu?.options, ["ship", "drop", "follow-up", AWAITING_TYPE_OPTION, AWAITING_SKIP_OPTION]);
});

test("skip after suggestions writes nothing, and neither does a dismissal", async () => {
	const skip = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), AWAITING_SKIP_OPTION, AWAITING_DONE_OPTION],
	});
	const outcomeSkip = await driveAwaitingDialog({ ...skip.deps, suggest: () => ["a candidate"] });
	assert.deepEqual(skip.recorded, []);
	assert.deepEqual(
		outcomeSkip.steps.map((step) => step.kind),
		["skipped"],
	);

	const dismiss = harness({
		items: () => [RESEARCH_ITEM],
		picks: [h0([RESEARCH_ITEM]), undefined, AWAITING_DONE_OPTION],
	});
	const outcomeDismiss = await driveAwaitingDialog({ ...dismiss.deps, suggest: () => ["a candidate"] });
	assert.deepEqual(dismiss.recorded, []);
	assert.deepEqual(
		outcomeDismiss.steps.map((step) => step.kind),
		["skipped"],
	);
});

test("authorization items are never offered a generated candidate, even from a misbehaving generator", async () => {
	const h = harness({
		items: () => [CHECKPOINT_ITEM],
		picks: [h0([CHECKPOINT_ITEM]), "approve", AWAITING_DONE_OPTION],
	});
	let called = false;
	const deps: AwaitingDialogDeps = {
		...h.deps,
		suggest: () => {
			called = true;
			return ["approve it, the plan is small", "hold until Monday"];
		},
	};
	await driveAwaitingDialog(deps);
	assert.equal(called, false, "the generator must never be called for an authorization item");
	const menu = h.prompts.find((prompt) => prompt.title.startsWith(CHECKPOINT_ITEM.decision));
	assert.deepEqual(menu?.options, ["approve", "decline", AWAITING_TYPE_OPTION, AWAITING_SKIP_OPTION]);
});

test("an unchanged item is never regenerated: the plan-view round trip reuses the same suggestions", async () => {
	let calls = 0;
	const h = harness({
		items: () => [RESEARCH_ITEM],
		planViewable: true,
		picks: [h0([RESEARCH_ITEM]), PLAN_VIEW_OPTION, PLAN_VIEW_AGAIN_OPTION, PLAN_VIEW_BACK_OPTION, AWAITING_DONE_OPTION],
	});
	const deps: AwaitingDialogDeps = {
		...h.deps,
		suggest: () => {
			calls += 1;
			return ["a candidate"];
		},
	};
	await driveAwaitingDialog(deps);
	assert.equal(calls, 1, "the same item, redrawn three times, must generate exactly once");
});
