/**
 * The details pane as **production wiring**, at the extension's own path
 * (pi-command-post-4mn; PR #151 review, finding 2).
 *
 * `tests/decision-context.test.ts` proves the projection. This file proves the
 * thing a projection test cannot: that the extension actually *gives* it to
 * both Awaiting-you loops, and that the path with no rich UI at all — the
 * plain prompts and the headless listing — shows the bounded pane and names how
 * to inspect the rest.
 *
 * Everything here is the real code the extension runs: `decisionPaneFactory`
 * and `formatDecideListing` are imported from
 * `extensions/command-post/index.ts` (the same functions the `/cp-decide`
 * handler calls), the evidence is real files under a scratch home read by a
 * real `CommandPost`, and the dialog is the real `driveAwaitingDialog`. The UI
 * is the only fake: `select` records what it was asked, exactly as a
 * `ctx.ui.select` would receive it.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	DECIDE_ANSWER_HINT,
	DECIDE_INSPECT_HINT,
	decisionPaneBudget,
	decisionPaneFactory,
	formatDecideListing,
} from "../extensions/command-post/index.ts";
import { answerMenuOptions, driveAwaitingDialog } from "../src/awaiting-dialog.ts";
import { buildAwaitingQuestions } from "../src/awaiting-questionnaire.ts";
import type { ResolvedAwaitingItem } from "../src/awaiting.ts";
import { CommandPost } from "../src/command-post.ts";
import {
	AWAITING_SKIP_OPTION,
	DECISION_CONTEXT_LINE_MAX_CHARS,
	DECISION_CONTEXT_MAX_LINES,
	DECISION_CONTEXT_RECOMMENDATION_LABEL,
	DECISION_PANE_MIN_ROWS,
	DECISION_PANE_RESERVED_ROWS,
	type DiffVerdict,
	LAYOUT,
	paths,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "8c7d0141f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";

const ITEM: ResolvedAwaitingItem = {
	id: "aw-ship-cp-pane",
	type: "approval",
	decision: "Ship cp-pane (PR 12), drop it, or open a follow-up?",
	why: "review found 3 issues",
	blocks: "cp-pane merge",
	job_id: "cp-pane",
	options: ["ship", "drop", "follow-up"],
	opened_at: "2026-09-06T10:00:00Z",
};

/** A home with one review verdict and one observed head — the acceptance shape. */
function homeWithEvidence(t: { after(fn: () => void): void }): CommandPost {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const verdict: DiffVerdict = {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-pane",
		attempt: 2,
		verdict: "revise",
		cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: [
			"src/pay.ts:41 charges before the idempotency key is written",
			"tests/pay.test.ts covers only the happy path",
			"the retry loop has no bound; GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 is in the fixture",
		],
		revisions: ["write the idempotency key first, then charge"],
		decided_at: "2026-09-06T09:00:00Z",
		head_sha: HEAD,
		diff_stat: { files: 3, truncated: false },
	};
	const file = join(home.path, paths.reviewFile("cp-pane", 2));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(verdict));
	mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
	writeFileSync(
		join(home.path, LAYOUT.ciWatchFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: "2026-09-06T09:30:00Z",
			jobs: [{ job_id: "cp-pane", head_sha: HEAD, announced: [], last_ci: "green", last_checked_at: "2026-09-06T09:30:00Z" }],
		}),
	);
	return new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
}

test("the plain prompts carry the bounded pane the extension builds, and the menu is unchanged", async (t) => {
	const post = homeWithEvidence(t);
	const contextFor = decisionPaneFactory(post);

	const titles: string[] = [];
	const menus: string[][] = [];
	const outcome = await driveAwaitingDialog({
		snapshot: () => [ITEM],
		formatLine: (item) => item.id,
		select: async (title, options) => {
			titles.push(title);
			menus.push(options);
			return options.includes(ITEM.id) ? ITEM.id : AWAITING_SKIP_OPTION;
		},
		input: async () => undefined,
		answer: async () => {
			throw new Error("a skip must never reach a writer");
		},
		context: contextFor,
	});

	const title = titles[1] ?? "";
	assert.ok(title.startsWith(`${ITEM.decision}\n${ITEM.why}`), "the decision still leads the prompt");
	for (const finding of ["charges before the idempotency key", "covers only the happy path", "the retry loop has no bound"]) {
		assert.ok(title.includes(finding), `the plain prompt shows the finding: ${finding}`);
	}
	assert.ok(title.includes(DECISION_CONTEXT_RECOMMENDATION_LABEL), "and the labelled recommendation");
	assert.ok(!title.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"), "redaction survives the production path");

	const pane = title.split("\n").slice(2);
	assert.ok(pane.length <= DECISION_CONTEXT_MAX_LINES, "the prompt's pane is bounded");
	for (const line of pane) assert.ok(line.length <= DECISION_CONTEXT_LINE_MAX_CHARS, `over budget: ${line}`);

	// The answer rows are what they always were: the pane is context, not an option.
	assert.deepEqual(menus[1], answerMenuOptions(ITEM, { planViewable: false, planViewed: false }));
	for (const line of pane) assert.ok(!(menus[1] ?? []).includes(line), "no pane line is selectable");
	assert.equal(outcome.steps.at(-1)?.kind, "skipped", "skip still writes nothing");
});

test("one factory feeds both loops, and it reads each item once", (t) => {
	const post = homeWithEvidence(t);
	let reads = 0;
	const counting = {
		decisionContext: (item: ResolvedAwaitingItem) => {
			reads += 1;
			return post.decisionContext(item);
		},
	};
	const contextFor = decisionPaneFactory(counting);

	const overlay = buildAwaitingQuestions({ items: [ITEM], context: contextFor });
	const question = overlay.questions[0]?.question ?? "";
	assert.ok(question.includes("charges before the idempotency key"), "the overlay question carries the pane");
	assert.ok(question.includes(DECISION_CONTEXT_RECOMMENDATION_LABEL));

	// Same factory, second loop, same lines — and still one read of the home.
	assert.deepEqual(contextFor(ITEM), contextFor(ITEM));
	buildAwaitingQuestions({ items: [ITEM], context: contextFor });
	assert.equal(reads, 1, "memoised per run: a redraw re-reads nothing");
});

test("a home that cannot answer degrades to an empty pane, never to a broken decision", () => {
	const contextFor = decisionPaneFactory({
		decisionContext: () => {
			throw new Error("state/ is unreadable");
		},
	});
	assert.deepEqual(contextFor(ITEM), []);
	const built = buildAwaitingQuestions({ items: [ITEM], context: contextFor });
	assert.ok(built.questions[0], "the item is still answerable");
	assert.deepEqual(
		built.questions[0]?.options.map((option) => option.label),
		buildAwaitingQuestions({ items: [ITEM] }).questions[0]?.options.map((option) => option.label),
		"a pane that could not be built changes nothing about the rows",
	);
});

test("the pane is budgeted against the terminal it shares with the decision (real-TUI round)", (t) => {
	const post = homeWithEvidence(t);

	// A short, narrow terminal: the answer rows must stay on screen, so the pane
	// yields — and says how much it withheld.
	const small = decisionPaneFactory(post, { screen: () => ({ columns: 40, rows: 24 }) })(ITEM);
	const smallRows = small.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 40)), 0);
	assert.ok(smallRows <= 24 - DECISION_PANE_RESERVED_ROWS, `pane took ${smallRows} rows on a 24-row terminal`);
	assert.match(small.at(-1) ?? "", /more line\(s\) \u2014 \/watch cp-pane$/);

	// A roomy terminal shows the whole pane: the budget is the screen's, never a
	// second content rule.
	const large = decisionPaneFactory(post, { screen: () => ({ columns: 120, rows: 60 }) })(ITEM);
	assert.ok(large.length > small.length);
	assert.ok(large.length <= DECISION_CONTEXT_MAX_LINES);
	assert.ok(!/more line\(s\)/.test(large.at(-1) ?? ""));

	// A terminal that reports nothing (headless, a pipe) falls back to the line
	// budget alone, exactly as before the screen was consulted.
	assert.deepEqual(decisionPaneBudget({}), {});
	assert.deepEqual(decisionPaneBudget({ columns: 80 }), {});
	assert.deepEqual(decisionPaneBudget({ columns: 80, rows: 40 }), { columns: 80, maxRows: 40 - DECISION_PANE_RESERVED_ROWS });
	assert.deepEqual(decisionPaneBudget({ columns: 40, rows: 10 }), { columns: 40, maxRows: DECISION_PANE_MIN_ROWS });
	const headless = decisionPaneFactory(post, { screen: () => ({}) })(ITEM);
	assert.deepEqual(headless, large.length <= headless.length ? headless : large, "a size-less terminal is not a smaller pane");
	assert.ok(headless.length <= DECISION_CONTEXT_MAX_LINES);
});

test("the headless listing prints the pane under its row and names how to inspect the rest", (t) => {
	const post = homeWithEvidence(t);
	const pane = decisionPaneFactory(post);
	const text = formatDecideListing([{ line: `${ITEM.id} ${ITEM.decision}`, context: pane(ITEM) }]);
	const lines = text.split("\n");

	assert.equal(lines[0], "Awaiting you:");
	assert.equal(lines[1], `  - ${ITEM.id} ${ITEM.decision}`);
	assert.ok(lines[2]?.startsWith("      evidence for cp-pane"), "the pane is indented under its row");
	for (const finding of ["charges before the idempotency key", "covers only the happy path", "the retry loop has no bound"]) {
		assert.ok(text.includes(finding), `the listing shows the finding: ${finding}`);
	}
	assert.ok(text.includes(DECISION_CONTEXT_RECOMMENDATION_LABEL));
	assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"), "redaction survives the headless path");
	assert.equal(lines.at(-2), DECIDE_ANSWER_HINT);
	assert.equal(lines.at(-1), DECIDE_INSPECT_HINT, "the fallback names /watch and /cp-plan");
	assert.equal(formatDecideListing([]), "Awaiting you: none");
});
