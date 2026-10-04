/**
 * cp-8tu: the fleet widget.
 *
 * The renderer is pure over a snapshot — width, line cap, awaiting items and
 * the alphabet are arguments — so nothing here needs a terminal, a clock or a
 * theme. Golden files pin what the operator sees at five widths; the property
 * tests pin the three rules the old renderer broke: every line fits, columns
 * are fleet-wide, and the height is bounded by pi's own widget cap.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { styleWidgetLine, styleWidgetLines } from "../extensions/command-post/fleet-widget.ts";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	LONG_TOOL_CALL_SECONDS,
	type RunStatus,
	SCHEMA_VERSION,
	type StatusSnapshot,
	type Usage,
	type WorkerHandle,
} from "../src/contracts.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { assembleStatus, type StatusFacts } from "../src/status.ts";
import { jobState } from "../src/status-render.ts";
import {
	renderFleetWidget,
	statusWidgetLines,
	WIDGET_MAX_LINES,
	WIDGET_MAX_WIDTH,
	type WidgetAwaitingItem,
	type WidgetLine,
} from "../src/widget.ts";
import { assertGolden, COMMAND_POST_EXTENSION, createScratchHome, REPO_ROOT, startRpc } from "./harness/index.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { FleetStore } from "../src/fleet.ts";

const NOW = "2026-08-27T12:00:00Z";
const HOME = "/home/operator/pi-command-post";
const FULL_WIDTH = 110;

function usage(overrides: Partial<Usage> = {}): Usage {
	return { ...EMPTY_USAGE, ...overrides };
}

function record(
	overrides: Partial<Omit<FleetRecord, "worker">> & { job_id: string; worker?: Partial<WorkerHandle> },
): FleetRecord {
	const { worker, ...rest } = overrides;
	return {
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worktree: `/home/operator/.treehouse/demo/${overrides.job_id}`,
		branch: overrides.job_id,
		dispatched_at: "2026-08-27T11:56:00Z",
		usage: usage(),
		...rest,
		worker: {
			pid: 4242,
			session_id: `sess-${overrides.job_id}`,
			session_file: `/sessions/${overrides.job_id}.jsonl`,
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-08-27T11:56:00Z",
			...worker,
		},
	} as FleetRecord;
}

function run(jobId: string, overrides: Partial<RunStatus> = {}): RunStatus {
	return { ...initialStatus(jobId, {}, "2026-08-27T11:56:00Z"), ...overrides } as RunStatus;
}

function snapshotOf(facts: Partial<StatusFacts> & Pick<StatusFacts, "records">): StatusSnapshot {
	return assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "active",
		runs: new Map(),
		alive: new Map(facts.records.map((entry) => [entry.job_id, !entry.worker.exited_at])),
		ledger: { ok: false, queried: false },
		...facts,
	});
}

/**
 * The reviewed fixture: the operator's own jobs (the fleet whose widget started
 * this job), plus the states their paste happened not to contain — a worker
 * that asked a question, a held research job awaiting a decision, and a job
 * that failed. Every job id and model id is real-shaped, because the defect this
 * design fixes was a width one.
 *
 * Five jobs, deliberately: two needing a human, two needing attention and one
 * running is exactly ten lines with the marker, i.e. the fleet that fills pi's
 * widget cap without collapsing anything. The overflow fixture below is where
 * collapsing is pinned.
 */
function fleet(): StatusFacts {
	const records: FleetRecord[] = [
		record({
			job_id: "cp-qzs",
			dispatched_at: "2026-08-27T11:55:00Z",
			usage: usage({ total_tokens: 2_390_000, cost_usd: 1.03 }),
			routing: { scope: "M", risk: "low", thinking: "medium", inferred: false },
		}),
		record({
			job_id: "cp-held-cannot-report-nu2",
			dispatched_at: "2026-08-27T11:56:00Z",
			usage: usage({ total_tokens: 1_220_000, cost_usd: 1.38 }),
			worker: { model: "anthropic/claude-opus-5" },
			routing: { scope: "S", risk: "high", thinking: "high", inferred: false },
		}),
		record({
			job_id: "cp-rebase-before-report-jue",
			dispatched_at: "2026-08-27T11:57:00Z",
			usage: usage({ total_tokens: 1_210_000, cost_usd: 0.24 }),
			worker: { model: "anthropic/claude-haiku-4-5" },
			routing: { scope: "S", risk: "low", thinking: "low", inferred: false },
		}),
		record({
			job_id: "cp-research-b2",
			kind: "research",
			delivery: "pipeline",
			phase: "held",
			reported_at: "2026-08-27T11:31:30Z",
			dispatched_at: "2026-08-27T11:31:00Z",
			usage: usage({ total_tokens: 249_000, cost_usd: 0.62 }),
			worker: { profile: "planner", role: "planner" },
			receipts: [{ kind: "artifact", status: "stored", title: "report.md" }],
		}),
		record({
			job_id: "cp-ship-c3",
			phase: "failed",
			dispatched_at: "2026-08-27T09:00:00Z",
			usage: usage({ total_tokens: 3200, cost_usd: 0.01 }),
			failure: { class: "crash", message: "pid no longer exists", at: "2026-08-27T10:02:00Z" },
			worker: { exited_at: "2026-08-27T10:02:00Z", exit_code: 1 },
		}),
	];
	return {
		home: HOME,
		generated_at: NOW,
		include: "active",
		records,
		runs: new Map<string, RunStatus>([
			["cp-qzs", run("cp-qzs", { phase: "working", usage: usage({ total_tokens: 2_390_000, cost_usd: 1.03 }), last_activity_at: "2026-08-27T11:58:00Z" })],
			[
				"cp-held-cannot-report-nu2",
				run("cp-held-cannot-report-nu2", {
					phase: "working",
					usage: usage({ total_tokens: 1_220_000, cost_usd: 1.38 }),
					// Seven minutes inside one bash call: the incident the threshold exists for.
					current_tool: { name: "bash", tool_call_id: "call-1", started_at: "2026-08-27T11:53:00Z" },
					last_activity_at: "2026-08-27T11:53:00Z",
				}),
			],
			[
				"cp-rebase-before-report-jue",
				run("cp-rebase-before-report-jue", {
					phase: "working",
					usage: usage({ total_tokens: 1_210_000, cost_usd: 0.24 }),
					current_tool: { name: "bash", tool_call_id: "call-2", started_at: "2026-08-27T11:59:57Z" },
					last_activity_at: "2026-08-27T11:59:57Z",
				}),
			],
			[
				"cp-research-b2",
				run("cp-research-b2", { phase: "idle", reported: true, usage: usage({ total_tokens: 249_000, cost_usd: 0.62 }), last_activity_at: "2026-08-27T11:31:30Z" }),
			],
			[
				"cp-ship-c3",
				run("cp-ship-c3", {
					phase: "exited",
					usage: usage({ total_tokens: 3200, cost_usd: 0.01 }),
					exited_at: "2026-08-27T10:02:00Z",
					exit_code: 1,
					last_activity_at: "2026-08-27T10:02:00Z",
				}),
			],
		]),
		alive: new Map([
			["cp-qzs", true],
			["cp-held-cannot-report-nu2", true],
			["cp-rebase-before-report-jue", true],
			["cp-research-b2", true],
		]),
		ledger: { ok: false, queried: false },
		questions: new Map([["cp-qzs", { seq: 1, question: "Postgres or SQLite for the cache?", asked_at: "2026-08-27T11:58:00Z" }]]),
	};
}

/** Two open decisions: a pending checkpoint for a job the fleet is not running,
 * and the held research job's "ship, drop or follow-up?" — the two derived
 * sources `awaitingSnapshotSync()` merges (cp-av8). */
const AWAITING: WidgetAwaitingItem[] = [
	{ id: "aw-checkpoint-cp-atlas-plan", type: "authorization", decision: "authorize cp-atlas-plan?", job_id: "cp-atlas-plan" },
	{ id: "aw-research-cp-research-b2", type: "approval", decision: "cp-research-b2: ship, drop or follow-up?", job_id: "cp-research-b2" },
];

// ---------------------------------------------------------------------------
// 1. Goldens
// ---------------------------------------------------------------------------

test("golden: the chosen layout at full width", () => {
	assertGolden("status-widget-full.txt", statusWidgetLines(snapshotOf(fleet()), { width: FULL_WIDTH, awaiting: AWAITING }).join("\n"));
});

test("golden: the same fleet at 80 columns", () => {
	assertGolden("status-widget-80.txt", statusWidgetLines(snapshotOf(fleet()), { width: 80, awaiting: AWAITING }).join("\n"));
});

test("golden: the same fleet at the 60-column floor", () => {
	assertGolden("status-widget-narrow.txt", statusWidgetLines(snapshotOf(fleet()), { width: 60, awaiting: AWAITING }).join("\n"));
});

test("golden: one job", () => {
	const one = snapshotOf({
		records: [
			record({
				job_id: "cp-8km",
				dispatched_at: "2026-08-27T11:59:00Z",
				usage: usage({ total_tokens: 558_000, cost_usd: 0.37 }),
				routing: { scope: "L", risk: "low", thinking: "medium", inferred: true },
			}),
		],
		runs: new Map([
			[
				"cp-8km",
				run("cp-8km", {
					phase: "working",
					usage: usage({ total_tokens: 558_000, cost_usd: 0.37 }),
					current_tool: { name: "read", tool_call_id: "call-3", started_at: "2026-08-27T11:59:51Z" },
					last_activity_at: "2026-08-27T11:59:51Z",
				}),
			],
		]),
	});
	assertGolden("status-widget-one.txt", statusWidgetLines(one, { width: FULL_WIDTH }).join("\n"));
});

test("golden: twelve jobs collapse per section inside pi's own ten-line cap", () => {
	assertGolden("status-widget-overflow.txt", statusWidgetLines(twelve(), { width: FULL_WIDTH, awaiting: [AWAITING[0] as WidgetAwaitingItem] }).join("\n"));
});

test("golden: ASCII mode for a terminal that cannot draw the glyphs", () => {
	assertGolden(
		"status-widget-ascii.txt",
		statusWidgetLines(snapshotOf(fleet()), { width: FULL_WIDTH, awaiting: AWAITING, ascii: true }).join("\n"),
	);
});

test("golden: the style role of every line", () => {
	// Pinned separately from the text so a styling change is reviewed as a diff,
	// and so no test in this file needs a theme to assert one.
	const lines = renderFleetWidget(snapshotOf(fleet()), { width: FULL_WIDTH, awaiting: AWAITING });
	const rendered = lines.map((line) => `${line.role.padEnd(14)}${line.text}`).join("\n");
	assertGolden("status-widget-roles.txt", rendered);
});

// ---------------------------------------------------------------------------
// 1b. Attach (cp-ft3d): the same two marks the table shows
// ---------------------------------------------------------------------------

/** A research job whose gate reviewer is running (spec 2026-09-05). */
function reviewingFleet(): StatusFacts {
	return {
		...fleet(),
		pendingReviews: new Map([
			[
				"cp-rebase-before-report-jue",
				{
					schema_version: SCHEMA_VERSION,
					job_id: "cp-rebase-before-report-jue",
					surface: "gate" as const,
					attempt: 2,
					model: "mock/reviewer",
					pid: 4242,
					started_at: "2026-08-27T11:56:00Z",
					deadline: "2026-08-27T12:11:00Z",
					handed_back: true,
				},
			],
		]),
	};
}

test("golden: a research job with its gate reviewer running", () => {
	const rendered = statusWidgetLines(snapshotOf(reviewingFleet()), { width: FULL_WIDTH, awaiting: AWAITING }).join("\n");
	assertGolden("status-widget-review.txt", rendered);
	assert.match(rendered, /gate 2 · 4m/);
});

/** Twelve jobs: one asking, one failed, ten working. The height bound's case. */
function twelve(generatedAt: string = NOW): StatusSnapshot {
	const records: FleetRecord[] = [];
	const runs = new Map<string, RunStatus>();
	for (let index = 1; index <= 12; index += 1) {
		const jobId = `cp-job-${String(index).padStart(2, "0")}`;
		const failed = index === 11;
		records.push(
			record({
				job_id: jobId,
				dispatched_at: `2026-08-27T11:${String(48 + index).padStart(2, "0")}:00Z`,
				usage: usage({ total_tokens: 310_000 + index * 1000, cost_usd: 0.21 }),
				routing: { scope: "M", risk: "low", thinking: "medium", inferred: false },
				...(failed
					? {
							phase: "failed" as const,
							failure: { class: "budget_exceeded" as const, message: "over the cap", at: "2026-08-27T11:48:00Z" },
							worker: { exited_at: "2026-08-27T11:48:00Z", exit_code: 1 },
						}
					: {}),
			}),
		);
		runs.set(
			jobId,
			run(jobId, {
				phase: failed ? "exited" : "working",
				usage: usage({ total_tokens: 310_000 + index * 1000, cost_usd: 0.21 }),
				current_tool: failed ? null : { name: "read", tool_call_id: `call-${index}`, started_at: "2026-08-27T11:59:55Z" },
				last_activity_at: "2026-08-27T11:59:55Z",
			}),
		);
	}
	return assembleStatus({
		home: HOME,
		generated_at: generatedAt,
		include: "active",
		records,
		runs,
		alive: new Map(records.map((entry) => [entry.job_id, !entry.worker.exited_at])),
		ledger: { ok: false, queried: false },
		questions: new Map([["cp-job-04", { seq: 1, question: "Rebase or merge the base branch?", asked_at: "2026-08-27T11:54:00Z" }]]),
	});
}

// ---------------------------------------------------------------------------
// 2. Every line fits — the property the per-row ladder got wrong
// ---------------------------------------------------------------------------

test("no rendered line ever exceeds the width it was given", () => {
	// A 28-character job id and a 60-character model id: the shape that made the
	// old renderer drop the model from some rows and not others.
	const jobId = "cp-a-very-long-branch-name-x";
	const facts = fleet();
	const stressed = snapshotOf({
		...facts,
		records: [
			...facts.records,
			record({
				job_id: jobId,
				worker: { model: "some-provider-with-a-long-name/an-extremely-long-model-identifier-xyz" },
				routing: { scope: "M", risk: "high", thinking: "high", inferred: true },
			}),
		],
	});
	for (let width = 60; width <= 140; width += 1) {
		for (const line of statusWidgetLines(stressed, { width, awaiting: AWAITING })) {
			assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

// ---------------------------------------------------------------------------
// 3. Columns are fleet-wide: the reported missing-model defect
// ---------------------------------------------------------------------------

test("the model is on every running row or on none, at every width", () => {
	const facts = fleet();
	const stressed = snapshotOf({
		...facts,
		questions: new Map(),
		records: facts.records.filter((entry) => entry.phase === "waiting"),
	});
	const models = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"];
	for (let width = 60; width <= 140; width += 1) {
		const rows = statusWidgetLines(stressed, { width }).filter((line) => /^ {2}[\u25b6\u25cb]/.test(line));
		assert.ok(rows.length > 0, `no running rows at width ${width}`);
		const withModel = rows.filter((line) => models.some((model) => line.includes(model))).length;
		assert.ok(
			withModel === 0 || withModel === rows.length,
			`the model column is present on ${withModel} of ${rows.length} rows at width ${width}`,
		);
	}
});

test("a column is dropped whole, and never at the cost of tokens or cost", () => {
	const jobId = "cp-a-very-long-branch-name-indeed-and-more-please";
	const snapshot = snapshotOf({
		records: [
			record({
				job_id: jobId,
				worker: { model: "some-provider-with-a-long-name/some-extremely-long-model-identifier-string" },
				routing: { scope: "M", risk: "high", thinking: "high", inferred: true },
			}),
		],
		runs: new Map([[jobId, run(jobId, { phase: "working" })]]),
	});
	const narrow = statusWidgetLines(snapshot, { width: 60 });
	const row = narrow.at(-1) as string;
	assert.ok(row.endsWith("$0.00"), `cost was the casualty of a long id: ${row}`);
	assert.ok(!row.includes("M?/high?"), `scope/risk half-rendered instead of being dropped whole: ${row}`);
	assert.ok(!row.includes("some-extremely-long"), `the model leaked onto an overflowing line: ${row}`);

	// Roomy: the same job keeps both cells. Dropping is a response to the width,
	// never an unconditional rule.
	const roomy = statusWidgetLines(snapshotOf({ records: [record({ job_id: "cp-roomy", routing: { scope: "M", risk: "high", thinking: "high", inferred: true } })] }), {
		width: FULL_WIDTH,
	});
	assert.ok((roomy.at(-1) as string).includes("M?/high?/high"), `expected scope/risk/thinking on a roomy line: ${roomy.at(-1)}`);
});

// ---------------------------------------------------------------------------
// 4. Height
// ---------------------------------------------------------------------------

test("a twelve-job fleet renders inside pi's own widget cap, and the count is stable", () => {
	const lines = statusWidgetLines(twelve(), { width: FULL_WIDTH });
	assert.ok(lines.length <= WIDGET_MAX_LINES, `widget is ${lines.length} lines, past pi's cap of ${WIDGET_MAX_LINES}`);

	// Same fleet four seconds later: the shape is a function of the fleet, not
	// of elapsed time, so the widget does not grow or shrink under the editor.
	const later = statusWidgetLines(twelve("2026-08-27T12:00:04Z"), { width: FULL_WIDTH });
	assert.equal(later.length, lines.length);
});

test("a tighter cap collapses sections rather than dropping the fleet's shape", () => {
	const lines = statusWidgetLines(twelve(), { width: FULL_WIDTH, maxLines: 5 });
	assert.ok(lines.length <= 5);
	assert.ok(lines.some((line) => line.includes("NEEDS YOU")), `the section that needs a human survived: ${JSON.stringify(lines)}`);
});

// ---------------------------------------------------------------------------
// 5. Priority: what a human is blocking on is never the thing that falls off
// ---------------------------------------------------------------------------

test("the one job that asked a question is shown even when it sorts last, and hidden rows are counted", () => {
	const snapshot = twelve();
	const asking = snapshot.jobs.filter((job) => job.open_question).map((job) => job.job_id);
	assert.deepEqual(asking, ["cp-job-04"], "fixture must have exactly one asking job");
	const lines = statusWidgetLines(snapshot, { width: FULL_WIDTH });
	assert.ok(lines.some((line) => line.includes("cp-job-04")), "the asking job is missing from the widget");
	const overflow = lines.find((line) => line.includes("more running") || line.includes("running (/status)"));
	assert.ok(overflow, `expected a per-section overflow count: ${JSON.stringify(lines)}`);
	assert.match(overflow as string, /\d+ .*running \(\/status\)/);
});

test("an open awaiting item puts its job under NEEDS YOU, not just a count on the marker", () => {
	const lines = statusWidgetLines(snapshotOf(fleet()), { width: FULL_WIDTH, awaiting: AWAITING });
	assert.match(lines[0] as string, /^\u29d7 2 decisions awaiting you/);
	const needsIndex = lines.findIndex((line) => line.startsWith("NEEDS YOU"));
	assert.ok(needsIndex > 0, "expected a NEEDS YOU section");
	assert.ok(lines.some((line) => line.includes("cp-research-b2") && line.includes("ship, drop or follow-up?")));

	// Without the items the same job is just another row: the section is derived
	// from facts passed in, never invented.
	const bare = statusWidgetLines(snapshotOf(fleet()), { width: FULL_WIDTH });
	assert.ok(!bare.some((line) => line.includes("ship, drop or follow-up?")));
});

// ---------------------------------------------------------------------------
// 6-8. Empty fleets, no blank lines, no dropped jobs
// ---------------------------------------------------------------------------

test("an empty fleet clears the widget; an empty fleet with a decision is one line", () => {
	const empty = snapshotOf({ records: [] });
	assert.deepEqual(statusWidgetLines(empty), []);
	const marker = statusWidgetLines(empty, { awaiting: [AWAITING[0] as WidgetAwaitingItem] });
	assert.equal(marker.length, 1);
	assert.match(marker[0] as string, /^\u29d7 1 decision awaiting you \u2014 \/cp-awaiting$/);
});

test("no line is ever blank: a spacer would vanish in the TUI and survive over RPC", () => {
	for (let width = 60; width <= 140; width += 5) {
		for (const line of statusWidgetLines(snapshotOf(fleet()), { width, awaiting: AWAITING })) {
			assert.notEqual(line.trim(), "", `blank widget line at width ${width}`);
		}
	}
});

test("every job lands in exactly one section, so no row is ever silently dropped", () => {
	const snapshot = snapshotOf(fleet());
	const sections = snapshot.jobs.map((job) => jobState(job).section);
	assert.equal(sections.length, snapshot.jobs.length);
	// Section membership is total: `running` is the residual, by construction.
	for (const section of sections) assert.ok(["needs", "attention", "running"].includes(section));
	const lines = statusWidgetLines(snapshot, { width: FULL_WIDTH, maxLines: 40, awaiting: AWAITING });
	for (const job of snapshot.jobs) {
		assert.ok(lines.some((line) => line.includes(job.job_id)), `${job.job_id} is in no section`);
	}
});

test("a long tool call is what ATTENTION is for; a short one is not", () => {
	const snapshot = snapshotOf(fleet());
	const wedged = snapshot.jobs.find((job) => job.job_id === "cp-held-cannot-report-nu2");
	assert.ok(wedged);
	assert.ok((wedged.current_tool_seconds ?? 0) >= LONG_TOOL_CALL_SECONDS, "fixture must exceed the threshold");
	assert.equal(jobState(wedged).section, "attention");
	const quick = snapshot.jobs.find((job) => job.job_id === "cp-rebase-before-report-jue");
	assert.ok(quick);
	assert.ok((quick.current_tool_seconds ?? 0) < LONG_TOOL_CALL_SECONDS, "fixture must stay under the threshold");
	assert.equal(jobState(quick).section, "running");
});

// ---------------------------------------------------------------------------
// 9. Quiet
// ---------------------------------------------------------------------------

test("an unchanged fleet renders byte-identically four seconds later", () => {
	const before = statusWidgetLines(snapshotOf(fleet()), { width: FULL_WIDTH, awaiting: AWAITING });
	const after = statusWidgetLines(assembleStatus({ ...fleet(), generated_at: "2026-08-27T12:00:04Z" }), {
		width: FULL_WIDTH,
		awaiting: AWAITING,
	});
	assert.deepEqual(after, before, "a repaint changed bytes without a fact changing");

	// A minute later only the age cells move — the line count does not.
	const later = statusWidgetLines(assembleStatus({ ...fleet(), generated_at: "2026-08-27T12:01:04Z" }), {
		width: FULL_WIDTH,
		awaiting: AWAITING,
	});
	assert.equal(later.length, before.length);
	assert.notDeepEqual(later, before);
});

// ---------------------------------------------------------------------------
// 10. ASCII
// ---------------------------------------------------------------------------

test("ascii mode emits no codepoint above U+007F", () => {
	for (let width = 60; width <= 140; width += 7) {
		for (const line of statusWidgetLines(snapshotOf(fleet()), { width, awaiting: AWAITING, ascii: true })) {
			assert.ok(/^[\x20-\x7e]*$/.test(line), `non-ASCII survived at width ${width}: ${JSON.stringify(line)}`);
		}
	}
	// The unknown-routing placeholder stays distinguishable from a missing side.
	const legacy = statusWidgetLines(snapshotOf({ records: [record({ job_id: "cp-legacy" })], runs: new Map([["cp-legacy", run("cp-legacy", { phase: "working" })]]) }), {
		width: FULL_WIDTH,
		ascii: true,
	});
	assert.ok((legacy.at(-1) as string).includes("--"), `expected the ascii no-routing placeholder: ${legacy.at(-1)}`);
});

// ---------------------------------------------------------------------------
// 11. Styling is additive
// ---------------------------------------------------------------------------

/** A theme stand-in: real SGR wrappers, no colour table needed. */
const fakeTheme = {
	fg: (_color: string, text: string) => `\u001b[38;5;7m${text}\u001b[39m`,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
	// cp-g1tc: the picker's highlight. The spike observed pi's own widget factory
	// draw the selected row with `theme.inverse` (`^[[7m> cp-ccc planner^[[0m`).
	inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
} as never;

test("applying the role styles changes no character and no width", () => {
	const lines = renderFleetWidget(snapshotOf(fleet()), { width: FULL_WIDTH, awaiting: AWAITING });
	const styled = styleWidgetLines(fakeTheme, lines);
	assert.equal(styled.length, lines.length);
	for (const [index, line] of lines.entries()) {
		const rendered = styled[index] as string;
		assert.ok(rendered.includes("\u001b"), `line ${index} was not styled at all: ${line.text}`);
		assert.equal(stripTerminalSequences(rendered), line.text, "styling changed the text");
		assert.equal(visibleWidth(rendered), visibleWidth(line.text), "styling changed the width");
	}
});

test("every role has a style, and a running row dims from the job id onward", () => {
	const lines = renderFleetWidget(snapshotOf(fleet()), { width: FULL_WIDTH, awaiting: AWAITING });
	const roles = new Set(lines.map((line) => line.role));
	for (const role of ["marker", "headline", "section", "section-alert", "row", "row-alert"]) {
		assert.ok(roles.has(role as WidgetLine["role"]), `fixture never produced the ${role} role`);
	}
	const runningRow = lines.find((line) => line.role === "row" && line.dimFrom !== undefined);
	assert.ok(runningRow, "expected a running row with a recessive half");
	// The dim split falls after the job id, which is what carries the operator's
	// "make the worker rows smaller" as intensity instead of a font size.
	assert.ok((runningRow.dimFrom as number) > 4);
	assert.ok(styleWidgetLine(fakeTheme, runningRow).includes("\u001b"));
});

// ---------------------------------------------------------------------------
// The RPC fallback width is documented, not guessed
// ---------------------------------------------------------------------------

test("the extension feeds the widget the awaiting items it already computes", { timeout: 90_000 }, async (t) => {
	// The marker line and the NEEDS YOU row come from the same snapshot
	// (`awaitingSnapshotSync`), so a pending checkpoint must produce both: a count
	// with no job attached to it is exactly the "which one?" this design fixes.
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record({ job_id: "cp-live-job", worker: { pid: process.pid } }));
	new CheckpointStore(home.path).request({ jobId: "cp-live-job", question: "ship the plan?" });

	const rpc = startRpc({ cwd: REPO_ROOT, args: ["--no-session", "-e", COMMAND_POST_EXTENSION], env: { CP_HOME: home.path } });
	// One hook, in this order: close the child, then remove the home it was
	// writing into. Registered as two hooks with the cleanup first, a failed `rm`
	// threw and node:test skipped every later hook — so the pi child was never
	// closed and held this runner open forever (cp-widget-test-hangs).
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});
	const widget = await rpc.waitFor((r) => r.type === "extension_ui_request" && r.method === "setWidget");
	const lines = widget.widgetLines as string[];
	assert.match(lines[0] as string, /^\u29d7 1 decision awaiting you/);
	assert.ok(
		lines.some((line) => line.startsWith("NEEDS YOU")),
		`the pending checkpoint produced a count but no row: ${JSON.stringify(lines)}`,
	);
	assert.ok(lines.some((line) => line.includes("cp-live-job") && line.includes("authorize")), JSON.stringify(lines));
});

test("the default width is the documented RPC fallback", () => {
	const withDefault = statusWidgetLines(snapshotOf(fleet()), { awaiting: AWAITING });
	const explicit = statusWidgetLines(snapshotOf(fleet()), { awaiting: AWAITING, width: WIDGET_MAX_WIDTH });
	assert.deepEqual(withDefault, explicit);
	for (const line of withDefault) assert.ok(visibleWidth(line) <= WIDGET_MAX_WIDTH);
});
