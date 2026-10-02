/**
 * cp-status-wait-reasons: why a held job cannot advance, on the row itself.
 *
 * The rule is one pure function (`waitReason`) over facts the snapshot already
 * carries, and two renderers that print it — `/status`'s table and the fleet
 * widget. So the tests are: the rule, both renderings, and the disk path that
 * puts the facts on the snapshot in the first place (`state/ci-watch.json`
 * plus this job's own `review-<n>.json`), because "disk-derived" is the whole
 * claim: no `gh` call may appear on a render path.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	LAYOUT,
	paths,
	type PendingReview,
	type StatusSnapshot,
	SCHEMA_VERSION,
	type StatusJob,
	type WorkerHandle,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { assembleStatus, formatStatusTable, type StatusFacts, StatusReporter } from "../src/status.ts";
import { WAIT_REASON_MAX_CHARS, waitReason } from "../src/status-render.ts";
import type { MergeAskCi } from "../src/merge-ask.ts";
import { statusWidgetLines, WIDGET_MIN_WIDTH } from "../src/widget.ts";
import { createScratchHome } from "./harness/index.ts";

const NOW = "2026-08-27T12:00:00Z";
const HOME = "/home/operator/pi-command-post";
const HEAD = "d48a81dfeedfacecafe0000000000000000ab12";
const SHORT = HEAD.slice(0, 7);

function record(overrides: Partial<Omit<FleetRecord, "worker">> & { job_id: string; worker?: Partial<WorkerHandle> }): FleetRecord {
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
		usage: { ...EMPTY_USAGE },
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

function facts(records: readonly FleetRecord[], ci?: Map<string, StatusJob["ci"]>): StatusFacts {
	return {
		home: HOME,
		generated_at: NOW,
		include: "active",
		records,
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: false, queried: false },
		...(ci ? { ci } : {}),
	};
}

/** A snapshot of one job with a reviewer in flight and CI mid-run underneath. */
function assembleWithPendingReview(base: StatusFacts, pending: PendingReview): StatusSnapshot {
	return assembleStatus({
		...base,
		ci: new Map([["cp-held", { head_sha: HEAD, state: "in_progress" }]]),
		pendingReviews: new Map([["cp-held", pending]]),
	});
}

/** One held `delivery:pr` job with the CI facts a render would have read. */
function heldJob(ci: StatusJob["ci"], overrides: Partial<StatusJob> = {}): StatusJob {
	const snapshot = assembleStatus(
		facts(
			[record({ job_id: "cp-held", phase: "held", reported_at: "2026-08-27T11:58:00Z" })],
			ci ? new Map([["cp-held", ci]]) : undefined,
		),
	);
	return { ...(snapshot.jobs[0] as StatusJob), ...overrides };
}

/**
 * Every member of the producer's own union (`MergeAskCi`, what `ciStateOf`
 * writes into `state/ci-watch.json`), so the switch is covered by the type it
 * is keyed on rather than by the states that happened to occur to a test.
 * Adding a classification to the gate breaks this table at compile time.
 */
const EXPECTED: Readonly<Record<MergeAskCi, string | null>> = {
	in_progress: `CI on ${SHORT}`,
	unknown: `CI on ${SHORT}`,
	superseded: `CI to start on ${SHORT}`,
	failed: `a fix for red CI on ${SHORT}`,
	// Green is necessary and not sufficient: an unreviewed head waits on the
	// review, a reviewed one waits on the merge. Same rule the merge ask applies,
	// and the gate's own `unreviewed` is the second spelling of the first case.
	green: `review of green ${SHORT}`,
	unreviewed: `review of green ${SHORT}`,
	// cp-no-ci-repo-derived: a repository with no workflows has no CI to wait for,
	// so the only thing left before the merge is the review of this head.
	no_ci: `review of ${SHORT} (no CI)`,
	// Neither is a wait: the merge landed, or the row's job does not exist.
	already_merged: null,
	job_gone: null,
};

test("a held PR job says what it is waiting on, for every state its producer can write", () => {
	for (const [state, phrase] of Object.entries(EXPECTED)) {
		assert.equal(waitReason(heldJob({ head_sha: HEAD, state })), phrase, `state ${state}`);
	}
	assert.equal(waitReason(heldJob({ head_sha: HEAD, state: "green", reviewed: true })), `merge of reviewed ${SHORT}`);
	assert.equal(waitReason(heldJob({ head_sha: HEAD, state: "no_ci", reviewed: true })), `merge of reviewed ${SHORT}`);
	// A branch nobody pushed is a wait; a `delivery:local` job with no head is not.
	assert.equal(waitReason(heldJob(undefined)), "a pushed head on origin");
	// The one deliberate free-string path: a classification this renderer
	// predates (or a hand-edited file) still names a head worth waiting on.
	assert.equal(waitReason(heldJob({ head_sha: HEAD, state: "a_state_from_the_future" })), `CI on ${SHORT}`);
	assert.equal(waitReason(heldJob({ head_sha: HEAD })), `CI on ${SHORT}`);
});

test("no phrase is ever truncated: the bound is one the phrases satisfy", () => {
	// The reported defect: `a fix for red CI on d48a81d` is 27 characters, and a
	// 26-character ceiling cut the sha to `d48a81` — half an identifier, which is
	// worse in a status row than none at all.
	const phrases = [
		...Object.values(EXPECTED).filter((phrase): phrase is string => phrase !== null),
		`merge of reviewed ${SHORT}`,
		"a pushed head on origin",
	];
	for (const phrase of phrases) {
		assert.ok(phrase.length <= WAIT_REASON_MAX_CHARS, `${phrase} (${phrase.length}) exceeds ${WAIT_REASON_MAX_CHARS}`);
	}
	assert.equal(Math.max(...phrases.map((phrase) => phrase.length)), WAIT_REASON_MAX_CHARS, "the bound is the longest phrase, not a guess");
	// And the rendered widget row carries the whole sha, not a clipped one.
	const snapshot = assembleStatus(
		facts(
			[record({ job_id: "cp-held", phase: "held", reported_at: "2026-08-27T11:58:00Z" })],
			new Map([["cp-held", { head_sha: HEAD, state: "failed" }]]),
		),
	);
	const held = statusWidgetLines(snapshot, { width: 110 }).find((line) => line.includes("cp-held"));
	assert.ok(held?.includes(`waits: a fix for red CI on ${SHORT}`), `expected the whole sha on the row, got: ${held}`);
	assert.match(formatStatusTable(snapshot), new RegExp(`waiting on: a fix for red CI on ${SHORT}`));
});

test("a reviewer in flight is not a wait reason on either surface: the row already says it", () => {
	// One fact, one place. `/status` prints the attempt and its deadline under the
	// row and the widget's activity cell carries `review 2 ⋅ 4m`, so a second
	// `waiting on:` line would restate what is already there — and the suppression
	// lives in `waitReason`, so the two renderers cannot drift apart about it.
	const snapshot = assembleWithPendingReview(facts([record({ job_id: "cp-held", phase: "held", reported_at: "2026-08-27T11:58:00Z" })]), {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-held",
		surface: "review",
		attempt: 2,
		model: "anthropic/claude-sonnet-5",
		started_at: "2026-08-27T11:59:00Z",
		deadline: "2026-08-27T12:20:00Z",
		handed_back: false,
	});
	const job = snapshot.jobs[0] as StatusJob;
	assert.equal(job.pending_review?.attempt, 2, "the pending reviewer must be on the snapshot for this to prove anything");
	assert.equal(job.ci?.state, "in_progress", "and so must a CI state that would otherwise produce a reason");
	assert.equal(waitReason(job), null);

	const table = formatStatusTable(snapshot);
	assert.ok(!table.includes("waiting on:"), `no wait line while a reviewer runs, got:\n${table}`);
	assert.match(table, /review 2 running/, "the reviewer line is what says it instead");
	const row = statusWidgetLines(snapshot, { width: 110 }).find((line) => line.includes("cp-held"));
	assert.ok(!row?.includes("waits:"), `the widget row must not double up either, got: ${row}`);
	assert.ok(row?.includes("review 2"), `the review mark is what says it instead, got: ${row}`);
});

test("a running job has no wait reason", () => {
	// The acceptance's "active/unblocked rows unchanged": a job whose worker is
	// still working is not waiting on anything a file can name.
	const working = assembleStatus(facts([record({ job_id: "cp-working" })])).jobs[0] as StatusJob;
	assert.equal(waitReason(working), null);
	// Even with CI facts on record: the job has not delivered yet.
	assert.equal(waitReason({ ...working, ci: { head_sha: HEAD, state: "in_progress" } }), null);
});

test("the table prints the wait reason under the held row, and nothing under an active one", () => {
	const snapshot = assembleStatus(
		facts(
			[
				record({ job_id: "cp-held", phase: "held", reported_at: "2026-08-27T11:58:00Z" }),
				record({ job_id: "cp-working" }),
			],
			new Map([["cp-held", { head_sha: HEAD, state: "green", reviewed: true }]]),
		),
	);
	const table = formatStatusTable(snapshot);
	assert.match(table, /waiting on: merge of reviewed d48a81d/);
	assert.equal(table.split("\n").filter((line) => line.includes("waiting on:")).length, 1);
});

test("the widget carries the same reason on the held row, bounded, at every width", () => {
	const snapshot = assembleStatus(
		facts(
			[record({ job_id: "cp-held", phase: "held", reported_at: "2026-08-27T11:58:00Z" }), record({ job_id: "cp-working" })],
			new Map([["cp-held", { head_sha: HEAD, state: "in_progress" }]]),
		),
	);
	const wide = statusWidgetLines(snapshot, { width: 110 });
	const held = wide.find((line) => line.includes("cp-held"));
	assert.ok(held?.includes("waits: CI on d48a81d"), `expected the wait reason on the held row, got: ${held}`);
	assert.ok(!wide.find((line) => line.includes("cp-working"))?.includes("waits:"), "an active row says nothing");
	// Narrow layouts stay readable: every line fits the budget it was given.
	for (const width of [WIDGET_MIN_WIDTH, 72, 80, 110]) {
		for (const line of statusWidgetLines(snapshot, { width })) {
			assert.ok(line.length <= width, `line exceeds ${width}: ${line}`);
		}
	}
	// And the reason disappears as the state advances past it.
	const merged = assembleStatus(
		facts(
			[record({ job_id: "cp-held", phase: "held", reported_at: "2026-08-27T11:58:00Z" })],
			new Map([["cp-held", { head_sha: HEAD, state: "already_merged" }]]),
		),
	);
	assert.ok(!statusWidgetLines(merged, { width: 110 }).some((line) => line.includes("waits:")));
});

test("the facts come off disk: ci-watch.json plus this job's own review verdict", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record({ job_id: "cp-held", phase: "held", reported_at: "2026-08-27T11:58:00Z" }));

	writeFileSync(
		join(home.path, LAYOUT.ciWatchFile),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: NOW,
			jobs: [{ job_id: "cp-held", head_sha: HEAD, announced: [], last_ci: "green" }],
		}),
	);
	const reporter = new StatusReporter({ home: home.path, fleet, now: () => new Date(NOW), isPidAlive: () => false });

	// Green, but nothing has reviewed that head yet.
	assert.match(formatStatusTable(reporter.collect()), /waiting on: review of green d48a81d/);

	// A passing cp_review on that exact head moves it on to the merge.
	mkdirSync(join(home.path, paths.runDir("cp-held")), { recursive: true });
	writeFileSync(
		join(home.path, paths.reviewFile("cp-held", 1)),
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			job_id: "cp-held",
			attempt: 1,
			verdict: "pass",
			cause: null,
			flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
			reasons: ["no unfixed findings"],
			decided_at: NOW,
			head_sha: HEAD,
			diff_stat: { files: 3, truncated: false },
		}),
	);
	assert.match(formatStatusTable(reporter.collect()), /waiting on: merge of reviewed d48a81d/);
});
