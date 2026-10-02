/**
 * pi-command-post-4mn — the decision details pane.
 *
 * Acceptance, in one sentence: a "review found 3 issues" decision displays all
 * three actionable findings and a clearly labelled recommendation *before* the
 * operator submits an answer. The first test asserts exactly that, through the
 * question the overlay actually renders — not through the builder's internals.
 *
 * Everything else here is the safety envelope around that: the pane is tied to
 * the job, the head and the attempt it describes (stale evidence is labelled,
 * never shown as current), credential-shaped values are redacted, no artifact
 * or diff body can reach it, and the option list — what a stray Enter lands on
 * — is byte-identical with and without a pane.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	buildDecisionContext,
	contextLine,
	type DecisionEvidence,
	EMPTY_DECISION_CONTEXT,
	readDecisionEvidence,
} from "../src/decision-context.ts";
import { answerMenuOptions, driveAwaitingDialog } from "../src/awaiting-dialog.ts";
import { buildAwaitingQuestions, questionOptions } from "../src/awaiting-questionnaire.ts";
import type { ResolvedAwaitingItem } from "../src/awaiting.ts";
import {
	AWAITING_SKIP_OPTION,
	type Checkpoint,
	DECISION_CONTEXT_LINE_MAX_CHARS,
	DECISION_CONTEXT_MAX_LINES,
	DECISION_CONTEXT_RECOMMENDATION_LABEL,
	type DiffVerdict,
	type GateVerdict,
	LAYOUT,
	paths,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

const HEAD = "8c7d0141f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const OLD = "0d03ad1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const SHIP_ITEM: ResolvedAwaitingItem = {
	id: "aw-ship-cp-x",
	type: "approval",
	decision: "Ship cp-x (PR 12), drop it, or open a follow-up?",
	why: "review found 3 issues",
	blocks: "cp-x merge",
	job_id: "cp-x",
	options: ["ship", "drop", "follow-up"],
	opened_at: "2026-09-06T10:00:00Z",
};

function reviewVerdict(overrides: Partial<DiffVerdict> = {}): DiffVerdict {
	return {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-x",
		attempt: 2,
		verdict: "revise",
		cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: [
			"src/pay.ts:41 charges before the idempotency key is written",
			"tests/pay.test.ts covers only the happy path",
			"the retry loop has no bound",
		],
		revisions: ["write the idempotency key first, then charge"],
		model: "anthropic/claude-sonnet-5",
		decided_at: "2026-09-06T09:00:00Z",
		head_sha: HEAD,
		diff_stat: { files: 3, truncated: false },
		...overrides,
	};
}

function gateVerdict(overrides: Partial<GateVerdict> = {}): GateVerdict {
	return {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-x",
		attempt: 1,
		verdict: "escalate",
		cause: "flagged",
		flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: true },
		reasons: ["the plan rotates production credentials with no rollback step"],
		revisions: ["name the rollback"],
		decided_at: "2026-09-06T08:00:00Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

test("acceptance: a 'review found 3 issues' decision shows all three findings and a labelled recommendation", () => {
	const context = buildDecisionContext(SHIP_ITEM, {
		review: reviewVerdict(),
		ci: { head_sha: HEAD, last_ci: "green", last_checked_at: "2026-09-06T09:30:00Z" },
	});

	for (const reason of reviewVerdict().reasons) {
		assert.ok(
			context.lines.some((line) => line.includes(reason.slice(0, 40))),
			`the pane must show the finding ${JSON.stringify(reason)}`,
		);
	}
	assert.equal(context.findings.length, 4, "three reasons plus one required change are all actionable");
	assert.ok(context.findings[0]?.startsWith("1/4 "), "findings are numbered out of their true total");
	assert.ok(context.recommendation?.startsWith(DECISION_CONTEXT_RECOMMENDATION_LABEL));
	assert.match(context.recommendation ?? "", /read the 4 finding\(s\) above before answering/);
	assert.ok(
		(context.recommendation ?? "").length <= DECISION_CONTEXT_LINE_MAX_CHARS,
		"the recommendation says its whole sentence inside the line budget — it is never clipped mid-thought",
	);
	assert.deepEqual(context.stale, []);
	assert.ok(context.sources.includes("review-2"));

	// …and it is on screen *before* submission: the pane is part of the question
	// the overlay renders, not something the operator has to go and find.
	const built = buildAwaitingQuestions({ items: [SHIP_ITEM], context: () => context.lines });
	const question = built.questions[0];
	assert.ok(question, "the item is renderable");
	for (const reason of reviewVerdict().reasons) {
		assert.ok(question.question.includes(reason.slice(0, 40)), "every finding is in the question body");
	}
	assert.ok(question.question.includes(DECISION_CONTEXT_RECOMMENDATION_LABEL));
});

test("the recommendation is never an option: options are byte-identical with and without a pane", () => {
	const context = buildDecisionContext(SHIP_ITEM, { review: reviewVerdict(), ci: { head_sha: HEAD } });
	const withPane = buildAwaitingQuestions({ items: [SHIP_ITEM], context: () => context.lines });
	const without = buildAwaitingQuestions({ items: [SHIP_ITEM] });
	assert.deepEqual(
		withPane.questions[0]?.options,
		without.questions[0]?.options,
		"a pane changes the question, never the answer rows",
	);
	assert.deepEqual(
		questionOptions(SHIP_ITEM, { planViewable: true, planViewed: false }),
		questionOptions(SHIP_ITEM, { planViewable: true, planViewed: false }),
	);
	// The plain menu too: the first option (what a stray Enter lands on) cannot
	// move because evidence appeared, and no line of the pane is selectable.
	const menu = answerMenuOptions(SHIP_ITEM, { planViewable: true, planViewed: false });
	assert.equal(menu[0], "View the plan\u2026");
	for (const line of context.lines) assert.ok(!menu.includes(line), "no evidence line is ever an option");
});

test("the plain dialog renders the pane in the title and keeps the same menu", async () => {
	const context = buildDecisionContext(SHIP_ITEM, { review: reviewVerdict(), ci: { head_sha: HEAD } });
	const titles: string[] = [];
	const menus: string[][] = [];
	const outcome = await driveAwaitingDialog({
		snapshot: () => [SHIP_ITEM],
		formatLine: (item) => item.id,
		select: async (title, options) => {
			titles.push(title);
			menus.push(options);
			// First prompt is the item list; then the item's own menu, which we skip.
			return options.includes(SHIP_ITEM.id) ? SHIP_ITEM.id : AWAITING_SKIP_OPTION;
		},
		input: async () => undefined,
		answer: async () => {
			throw new Error("a skip must never reach a writer");
		},
		context: () => context.lines,
	});
	assert.equal(outcome.steps.at(-1)?.kind, "skipped", "skip is still no answer");
	const itemTitle = titles[1] ?? "";
	assert.ok(itemTitle.startsWith(`${SHIP_ITEM.decision}\n${SHIP_ITEM.why}`), "the decision still leads");
	assert.ok(itemTitle.includes(DECISION_CONTEXT_RECOMMENDATION_LABEL));
	assert.deepEqual(menus[1], answerMenuOptions(SHIP_ITEM, { planViewable: false, planViewed: false }));
});

// ---------------------------------------------------------------------------
// Tied to job, head and attempt
// ---------------------------------------------------------------------------

test("a verdict on a superseded head is labelled stale and contributes no current findings", () => {
	const context = buildDecisionContext(SHIP_ITEM, {
		review: reviewVerdict({ head_sha: OLD }),
		ci: { head_sha: HEAD, last_ci: "green" },
	});
	assert.deepEqual(context.findings, [], "a review of another commit says nothing about this one");
	assert.equal(context.stale.length, 1);
	assert.match(context.stale[0] ?? "", /stale, not shown as current evidence/);
	assert.ok(context.lines.some((line) => line.includes("stale")), "the pane says so on screen");
	assert.match(context.recommendation ?? "", /different head/);
});

test("evidence belonging to another job never reaches the pane", () => {
	const context = buildDecisionContext(SHIP_ITEM, {
		review: reviewVerdict({ job_id: "cp-other" }),
		gate: gateVerdict({ job_id: "cp-other" }),
		checkpoint: {
			job_id: "cp-other",
			question: "authorize?",
			decision: "pending",
			requested_at: "2026-09-06T08:00:00Z",
		},
	});
	assert.deepEqual(context, EMPTY_DECISION_CONTEXT);
});

test("a merge authorization scoped to another commit is stale; a decided checkpoint is not a question", () => {
	const item: ResolvedAwaitingItem = {
		...SHIP_ITEM,
		id: "aw-checkpoint-cp-x.merge-0d03ad1",
		type: "authorization",
		checkpoint_kind: "merge",
		checkpoint_scope: OLD,
		options: ["approve", "decline"],
	};
	const stale = buildDecisionContext(item, {
		checkpoint: { job_id: "cp-x", kind: "merge", scope: OLD, question: "merge it?", decision: "pending", requested_at: "2026-09-06T08:00:00Z" },
		ci: { head_sha: HEAD, last_ci: "green" },
	});
	assert.match(stale.stale.join("\n"), /force-push voids it/);

	const decided = buildDecisionContext(item, {
		checkpoint: { job_id: "cp-x", kind: "merge", scope: HEAD, question: "merge it?", decision: "approved", requested_at: "2026-09-06T08:00:00Z" },
		ci: { head_sha: HEAD, last_ci: "green" },
	});
	assert.match(decided.stale.join("\n"), /already approved/);
});

test("the attempt is on every finding, so 'the reviewer said this' carries 'in which round'", () => {
	const context = buildDecisionContext(SHIP_ITEM, { review: reviewVerdict({ attempt: 3 }), ci: { head_sha: HEAD } });
	for (const finding of context.findings) assert.match(finding, /review-3/);
});

test("a flagged verdict names its flags on their own line, so the recommendation stays one sentence", () => {
	const context = buildDecisionContext(SHIP_ITEM, {
		review: reviewVerdict({ flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: true } }),
		ci: { head_sha: HEAD },
	});
	assert.ok(
		context.lines.some((line) => line.includes("review-2 flags: destructive_scope, blocking_unknowns")),
		"the flags are evidence in the pane, not a tail on the recommendation",
	);
});

test("a red CI head is the recommendation, and merging red is never suggested", () => {
	const context = buildDecisionContext(SHIP_ITEM, {
		review: reviewVerdict({ verdict: "pass", reasons: [], revisions: [] }),
		ci: { head_sha: HEAD, last_ci: "failed" },
	});
	assert.match(context.recommendation ?? "", /merging red is forbidden/);
});

// ---------------------------------------------------------------------------
// Bounded, redacted, never a body
// ---------------------------------------------------------------------------

test("credential-shaped values are redacted wherever they appear in the evidence", () => {
	const context = buildDecisionContext(SHIP_ITEM, {
		review: reviewVerdict({
			reasons: [
				"the fixture hardcodes GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345",
				"curl -H 'Authorization: Bearer sk-live-01234567890abcdef' leaks in the log",
			],
			revisions: [],
		}),
		ci: { head_sha: HEAD },
	});
	const rendered = context.lines.join("\n");
	assert.ok(!rendered.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"), "a token shape never reaches the pane");
	assert.ok(!rendered.includes("sk-live-01234567890abcdef"), "a bearer credential never reaches the pane");
	assert.ok(rendered.includes("\u2022\u2022\u2022"), "the redaction is visible, not silent");
});

test("the pane is bounded: every line is clipped and nothing is dropped without saying so", () => {
	const long = "x".repeat(600);
	const context = buildDecisionContext(SHIP_ITEM, {
		review: reviewVerdict({
			reasons: Array.from({ length: 10 }, (_, index) => `${index}: ${long}`),
			revisions: Array.from({ length: 10 }, (_, index) => `fix ${index}: ${long}`),
		}),
		gate: gateVerdict(),
		checkpoint: {
			job_id: "cp-x",
			question: "authorize?",
			evidence: Array.from({ length: 6 }, (_, index) => `headline evidence ${index}`),
			decision: "pending",
			requested_at: "2026-09-06T08:00:00Z",
		},
		ci: { head_sha: HEAD, last_ci: "green", last_checked_at: "2026-09-06T09:30:00Z" },
	});
	assert.ok(context.lines.length <= DECISION_CONTEXT_MAX_LINES, "the pane fits its budget");
	for (const line of context.lines) assert.ok(line.length <= DECISION_CONTEXT_LINE_MAX_CHARS, `over budget: ${line}`);
	assert.match(context.findings.at(-1) ?? "", /more finding\(s\) \u2014 read them with \/watch cp-x/);
	assert.match(context.lines.at(-1) ?? "", /^\+\d+ more line\(s\) \u2014 \/watch cp-x$/);
	assert.ok(
		context.lines.some((line) => line.includes(DECISION_CONTEXT_RECOMMENDATION_LABEL)),
		"the recommendation is never the line that yields to the budget",
	);
});

// ---------------------------------------------------------------------------
// Untied: no observed head means nothing is current (PR #151 review)
// ---------------------------------------------------------------------------

test("with no observed head, review, gate and merge-scope evidence are untied \u2014 named, counted, never current", () => {
	const context = buildDecisionContext(SHIP_ITEM, { review: reviewVerdict(), gate: gateVerdict() });
	assert.deepEqual(context.findings, [], "a verdict nobody can place is not a current finding");
	assert.equal(context.stale.length, 2, "both records are named rather than dropped");
	assert.match(context.stale.join("\n"), /review-2: revise on 8c7d014 \u2014 untied: no current head is known for cp-x/);
	assert.match(context.stale.join("\n"), /so its 4 finding\(s\) are not shown as current/);
	assert.match(context.stale.join("\n"), /gate-1: escalate\/flagged \u2014 untied/);
	assert.match(context.stale.join("\n"), /read it with \/watch cp-x/);
	assert.match(context.recommendation ?? "", /nothing on screen is current/);
	assert.ok(
		!context.lines.some((line) => line.includes("charges before the idempotency key")),
		"no finding body is rendered as current",
	);
});

test("a head too short to be one this home wrote is no head at all", () => {
	for (const head of ["", "  ", "abc123"]) {
		const context = buildDecisionContext(SHIP_ITEM, { review: reviewVerdict(), ci: { head_sha: head } });
		assert.deepEqual(context.findings, [], `${JSON.stringify(head)} must not be treated as a head`);
		assert.match(context.stale.join("\n"), /untied: no current head is known/);
	}
});

test("an unscoped merge authorization with no observed head is untied, not silently current", () => {
	const item: ResolvedAwaitingItem = {
		...SHIP_ITEM,
		id: "aw-checkpoint-cp-x.merge-0d03ad1",
		type: "authorization",
		checkpoint_kind: "merge",
		checkpoint_scope: OLD,
		options: ["approve", "decline"],
	};
	const context = buildDecisionContext(item, {
		checkpoint: {
			job_id: "cp-x",
			kind: "merge",
			scope: OLD,
			question: "merge it?",
			decision: "pending",
			requested_at: "2026-09-06T08:00:00Z",
		},
	});
	assert.match(context.stale.join("\n"), /checkpoint:merge: authorizes 0d03ad1 \u2014 untied/);
	assert.ok(
		!context.lines.some((line) => line.includes("merge it?")),
		"an authorization nobody can place is not rendered as the current question",
	);
});

test("the head restores currency: the same evidence is current once a matching head is observed", () => {
	const untied = buildDecisionContext(SHIP_ITEM, { review: reviewVerdict() });
	const tied = buildDecisionContext(SHIP_ITEM, { review: reviewVerdict(), ci: { head_sha: HEAD, last_ci: "green" } });
	assert.equal(untied.findings.length, 0);
	assert.equal(tied.findings.length, 4);
	assert.deepEqual(tied.stale, []);
});

// ---------------------------------------------------------------------------
// The budget always announces what it cut (PR #151 review)
// ---------------------------------------------------------------------------

test("tiny and zero line budgets: the marker is inside the bound, and 0 renders nothing", () => {
	const evidence: DecisionEvidence = {
		review: reviewVerdict(),
		ci: { head_sha: HEAD, last_ci: "green", last_checked_at: "2026-09-06T09:30:00Z" },
	};
	const full = buildDecisionContext(SHIP_ITEM, evidence);
	assert.ok(full.lines.length > 3, "the unbounded pane has something to cut");
	for (const maxLines of [1, 2, 3, full.lines.length - 1]) {
		const context = buildDecisionContext(SHIP_ITEM, evidence, { maxLines });
		assert.equal(context.lines.length, maxLines, `maxLines ${maxLines}: the pane fills its bound exactly`);
		assert.match(
			context.lines.at(-1) ?? "",
			/^\+\d+ more line\(s\) \u2014 \/watch cp-x$/,
			`maxLines ${maxLines}: an omission is always announced, never silent`,
		);
	}
	assert.deepEqual(buildDecisionContext(SHIP_ITEM, evidence, { maxLines: 0 }).lines, [], "0 renders nothing at all");
	assert.deepEqual(buildDecisionContext(SHIP_ITEM, evidence, { maxLines: -3 }).lines, []);
	// The render budget bounds the render; it never edits the evidence behind it.
	assert.equal(buildDecisionContext(SHIP_ITEM, evidence, { maxLines: 1 }).findings.length, 4);
});

test("a narrow terminal is budgeted in wrapped rows, not lines, and still announces the cut", () => {
	const evidence: DecisionEvidence = {
		review: reviewVerdict({
			reasons: [
				"src/pay.ts:41 charges the card before the idempotency key is written, so a retried request double-charges",
				"tests/pay.test.ts covers only the happy path: nothing asserts the gateway timing out mid-charge",
				"the retry loop has no bound",
			],
		}),
		ci: { head_sha: HEAD, last_ci: "green", last_checked_at: "2026-09-06T09:30:00Z" },
	};
	const columns = 40;
	const maxRows = 10;
	const context = buildDecisionContext(SHIP_ITEM, evidence, { columns, maxRows });
	const rows = context.lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
	assert.ok(rows <= maxRows, `the pane took ${rows} rows of a ${maxRows}-row budget`);
	assert.match(context.lines.at(-1) ?? "", /^\+\d+ more line\(s\) \u2014 \/watch cp-x$/);
	// The same evidence on a roomy terminal is not cut at all: the budget is the
	// screen's, never a second content rule.
	const wide = buildDecisionContext(SHIP_ITEM, evidence, { columns: 100, maxRows: 60 });
	assert.ok(wide.lines.length > context.lines.length);
	assert.ok(!/more line\(s\)/.test(wide.lines.at(-1) ?? ""));
	// A budget too small for even one line still says how much it hid.
	const crushed = buildDecisionContext(SHIP_ITEM, evidence, { columns: 40, maxRows: 1 });
	assert.equal(crushed.lines.length, 1);
	assert.match(crushed.lines[0] ?? "", /^\+\d+ more line\(s\)/);
});

test("contextLine collapses, redacts and clips; an empty evidence set is an empty pane", () => {
	assert.equal(contextLine("  a\n b  "), "a b");
	assert.equal(contextLine("token=abcdef123456"), "\u2022\u2022\u2022");
	assert.equal(contextLine("y".repeat(50), 10).length, 10);
	assert.deepEqual(buildDecisionContext(SHIP_ITEM, {}), EMPTY_DECISION_CONTEXT);
	assert.deepEqual(buildDecisionContext({ ...SHIP_ITEM, job_id: undefined }, { review: reviewVerdict() }), EMPTY_DECISION_CONTEXT);
});

test("src/decision-context.ts can reach no artifact body, no diff and no run log", () => {
	const source = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "../src/decision-context.ts"),
		"utf8",
	);
	for (const forbidden of [
		"artifactFile",
		"taskFile",
		"originalTaskFile",
		"reviewScratchDir",
		"gateScratchDir",
		"eventsFile",
		"materializeDiff",
		"pi-coding-agent",
	]) {
		assert.ok(!source.includes(forbidden), `src/decision-context.ts mentions ${forbidden}`);
	}
});

// ---------------------------------------------------------------------------
// The reader: local, authoritative files only
// ---------------------------------------------------------------------------

function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value, null, 2));
}

test("readDecisionEvidence takes the newest verdict of each kind, the row's checkpoint and the watcher's CI", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeJson(join(home.path, paths.reviewFile("cp-x", 1)), reviewVerdict({ attempt: 1, head_sha: OLD }));
	writeJson(join(home.path, paths.reviewFile("cp-x", 3)), reviewVerdict({ attempt: 3 }));
	writeJson(join(home.path, paths.gateFile("cp-x", 1)), gateVerdict());
	const checkpoint: Checkpoint = {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-x",
		question: "act on this plan?",
		evidence: ["gate passed on attempt 1"],
		requested_at: "2026-09-06T08:00:00Z",
		decision: "pending",
	};
	writeJson(join(home.path, paths.checkpointFile("cp-x")), checkpoint);
	writeJson(join(home.path, LAYOUT.ciWatchFile), {
		schema_version: SCHEMA_VERSION,
		updated_at: "2026-09-06T09:30:00Z",
		jobs: [{ job_id: "cp-x", head_sha: HEAD, announced: [], last_ci: "green", last_checked_at: "2026-09-06T09:30:00Z" }],
	});

	const evidence = readDecisionEvidence(home.path, SHIP_ITEM);
	assert.equal(evidence.review?.attempt, 3, "the newest review wins, and a gap would not have stopped the scan");
	assert.equal(evidence.gate?.attempt, 1);
	assert.equal(evidence.checkpoint?.question, "act on this plan?");
	assert.deepEqual(evidence.ci, { head_sha: HEAD, last_ci: "green", last_checked_at: "2026-09-06T09:30:00Z" });

	const context = buildDecisionContext(SHIP_ITEM, evidence);
	assert.ok(context.findings.length >= 4, "the findings from disk are the findings on screen");
	assert.ok(context.sources.includes("ci-watch"));
});

test("the reader never reads an artifact body, and an unreadable record is simply no evidence", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const artifact = join(home.path, paths.artifactFile("cp-x"));
	mkdirSync(dirname(artifact), { recursive: true });
	writeFileSync(artifact, "# plan\nSECRET-ARTIFACT-BODY-MARKER\n");
	writeFileSync(join(home.path, LAYOUT.ciWatchFile), "{ not json");
	mkdirSync(join(home.path, LAYOUT.runs, "cp-x"), { recursive: true });
	writeFileSync(join(home.path, paths.reviewFile("cp-x", 1)), "{ not json either");
	writeJson(join(home.path, paths.reviewFile("cp-x", 2)), { job_id: "cp-x", verdict: "nonsense" });

	const evidence = readDecisionEvidence(home.path, SHIP_ITEM);
	assert.deepEqual(evidence, {} as DecisionEvidence, "nothing readable is nothing shown");
	const context = buildDecisionContext(SHIP_ITEM, evidence);
	assert.deepEqual(context, EMPTY_DECISION_CONTEXT);
	assert.ok(!JSON.stringify(context).includes("SECRET-ARTIFACT-BODY-MARKER"));
});

test("a job id the path helpers refuse is no evidence, never a thrown dialog", () => {
	const evidence = readDecisionEvidence("/nonexistent-home", { job_id: "../escape" });
	assert.deepEqual(evidence, {} as DecisionEvidence);
});
