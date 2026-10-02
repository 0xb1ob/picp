/**
 * T23 acceptance: the fleet view.
 *
 * Golden files pin the three rendered surfaces (table, `--json`, widget) so a
 * change to what the operator sees has to be reviewed as a diff. Everything
 * else asserts the policy the port had to preserve: exact phases, no `stalled`,
 * `exited` only from an observed close, a degraded ledger that still renders,
 * and counts that agree with the rows they summarize.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseStatusArgs } from "../extensions/command-post/index.ts";
import {
	DEFAULT_BUDGET_CONFIG,
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	type JobPhase,
	type JobRouting,
	JobRoutingSchema,
	LONG_TOOL_CALL_SECONDS,
	paths,
	type RunStatus,
	SCHEMA_VERSION,
	type StatusJob,
	type StatusSnapshot,
	type Usage,
	validate,
	validateStatusSnapshot,
	type WorkerHandle,
} from "../src/contracts.ts";
import { checkBudget } from "../src/failures.ts";
import { FleetStore } from "../src/fleet.ts";
import { type Job, Ledger } from "../src/ledger.ts";
import { initialStatus, readStatusFile, rebuildStatus, RunRecorder } from "../src/run-artifacts.ts";
import { renderHeader } from "../src/watch.ts";
import { formatScopeRisk, formatThinking } from "../src/status-render.ts";
import {
	ageSeconds,
	assembleStatus,
	formatAge,
	formatCost,
	formatDrainLine,
	formatStatusJson,
	formatStatusTable,
	formatTokens,
	runLabel,
	shortModel,
	type StatusFacts,
	StatusError,
	StatusReporter,
	statusHeadline,
	toolCell,
} from "../src/status.ts";
import { statusWidgetLines } from "../src/widget.ts";
import { assertGolden, COMMAND_POST_EXTENSION, createScratchHome, createScratchLedger, REPO_ROOT, startRpc } from "./harness/index.ts";

const NOW = "2026-08-27T12:00:00Z";
const HOME = "/home/operator/pi-command-post";

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

function issue(overrides: Partial<Job> & { id: string }): Job {
	return {
		title: "a job",
		status: "in_progress",
		labels: ["project:demo", "delivery:pr", "kind:ship"],
		blocked_by: [],
		comments: [],
		created_at: "2026-08-27T11:00:00Z",
		updated_at: "2026-08-27T11:50:00Z",
		...overrides,
	};
}

/**
 * The reviewed fixture behind the golden files: one worker mid-tool, one held
 * job whose worker is idle, one crashed job, one torn-down job (hidden by
 * default) and one job br says is in flight that this fleet never dispatched.
 */
function fixture(overrides: Partial<StatusFacts> = {}): StatusFacts {
	const records: FleetRecord[] = [
		record({
			job_id: "cp-ship-a1",
			kind: "ship",
			dispatched_at: "2026-08-27T11:56:00Z",
			usage: usage({ input: 11_000, output: 1300, total_tokens: 12_300, cost_usd: 0.042 }),
			// Explicit: the caller named scope/risk (or the pipeline's self_assessment
			// did), so no `?` marker.
			routing: { scope: "S", risk: "low", thinking: "medium", inferred: false },
		}),
		record({
			job_id: "cp-research-b2",
			project: "atlas",
			kind: "research",
			delivery: "pipeline",
			phase: "held",
			reported_at: "2026-08-27T11:58:30Z",
			dispatched_at: "2026-08-27T11:31:00Z",
			usage: usage({ input: 240_000, output: 9000, total_tokens: 249_000, cost_usd: 1.2 }),
			worker: { profile: "planner", role: "planner", pid: 4243, session_id: "sess-b2" },
			receipts: [{ kind: "artifact", status: "stored", title: "report.md" }],
			// Inferred: nobody supplied scope/risk, so `inferScopeAndRisk` filled them
			// in at dispatch time -- marked with `?` wherever it renders.
			routing: { scope: "M", risk: "high", thinking: "high", inferred: true },
		}),
		record({
			job_id: "cp-ship-c3",
			phase: "failed",
			dispatched_at: "2026-08-27T09:00:00Z",
			usage: usage({ input: 3000, output: 200, total_tokens: 3200, cost_usd: 0.01 }),
			failure: { class: "crash", message: "pid no longer exists", at: "2026-08-27T10:02:00Z" },
			worker: { pid: 4244, session_id: "sess-c3", exited_at: "2026-08-27T10:02:00Z", exit_code: 1 },
			// No `routing` at all: dispatched before this field existed. Must render
			// as unknown (—), never a guessed S/low.
		}),
		record({
			job_id: "cp-ship-d4",
			phase: "done",
			dispatched_at: "2026-08-26T09:00:00Z",
			closed_at: "2026-08-26T10:00:00Z",
			reported_at: "2026-08-26T09:50:00Z",
			usage: usage({ input: 5000, output: 500, total_tokens: 5500, cost_usd: 0.02 }),
			worker: { pid: 4245, session_id: "sess-d4", exited_at: "2026-08-26T10:00:00Z", exit_code: 0 },
		}),
	];
	const runs = new Map<string, RunStatus>([
		[
			"cp-ship-a1",
			run("cp-ship-a1", {
				phase: "working",
				turns: 3,
				tool_calls: 7,
				// The run projection is what a live worker actually updates; the fleet
				// record mirrors it here to keep this fixture's totals stable. See the
				// dedicated "the run projection wins" test below for the case where
				// they disagree -- that is the bug this fixes.
				usage: usage({ input: 11_000, output: 1300, total_tokens: 12_300, cost_usd: 0.042 }),
				current_tool: { name: "bash", tool_call_id: "call-1", started_at: "2026-08-27T11:59:50Z" },
				last_activity_at: "2026-08-27T11:59:50Z",
			}),
		],
		[
			"cp-research-b2",
			run("cp-research-b2", {
				phase: "idle",
				turns: 9,
				tool_calls: 31,
				reported: true,
				usage: usage({ input: 240_000, output: 9000, total_tokens: 249_000, cost_usd: 1.2 }),
				last_activity_at: "2026-08-27T11:58:30Z",
			}),
		],
		[
			"cp-ship-c3",
			run("cp-ship-c3", {
				phase: "exited",
				turns: 1,
				tool_calls: 2,
				usage: usage({ input: 3000, output: 200, total_tokens: 3200, cost_usd: 0.01 }),
				exited_at: "2026-08-27T10:02:00Z",
				exit_code: 1,
				last_activity_at: "2026-08-27T10:02:00Z",
			}),
		],
	]);
	return {
		home: HOME,
		generated_at: NOW,
		include: "active",
		records,
		runs,
		alive: new Map([
			["cp-ship-a1", true],
			["cp-research-b2", true],
		]),
		ledger: { ok: true, queried: true },
		issues: [
			issue({ id: "cp-ship-a1", title: "Add the retry ladder" }),
			issue({ id: "cp-research-b2", title: "Investigate the flaky import", labels: ["project:atlas", "delivery:pipeline", "kind:research"] }),
			issue({ id: "cp-ship-c3", title: "Migrate the config loader" }),
			issue({ id: "cp-ship-d4", title: "Fix the docs link", status: "closed" }),
			issue({ id: "cp-ghost-e5", title: "Someone else claimed this", updated_at: "2026-08-27T08:15:00.000000Z" }),
		],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Golden files: exactly what the operator sees
// ---------------------------------------------------------------------------

test("golden: the table renders the fleet, its totals and the unclaimed job", () => {
	assertGolden("status-table.txt", formatStatusTable(assembleStatus(fixture())));
});

test("golden: --json is the whole snapshot", () => {
	assertGolden("status.json", formatStatusJson(assembleStatus(fixture())));
});

test("golden: the widget groups the fleet by what it asks of the operator", () => {
	assertGolden("status-widget.txt", statusWidgetLines(assembleStatus(fixture())).join("\n"));
});

test("golden: an empty fleet with a degraded ledger still renders", () => {
	const snapshot = assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [],
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: false, queried: true, error: "br: command not found" },
	});
	assertGolden("status-table-empty.txt", formatStatusTable(snapshot));
	assert.deepEqual(statusWidgetLines(snapshot), [], "an empty fleet clears the widget instead of drawing a header");
});

test("a job waiting on a human says so, in the table and in the widget", () => {
	// T31: the phase is still `waiting` — a question is a fact with a timestamp,
	// not a fifth phase — but a quiet worker and a worker waiting on the operator
	// must not look identical.
	const facts = fixture();
	const jobId = facts.records[0]?.job_id as string;
	const snapshot = assembleStatus({
		...facts,
		questions: new Map([[jobId, { seq: 1, question: "Postgres or SQLite?", asked_at: NOW }]]),
	});
	const job = snapshot.jobs.find((row) => row.job_id === jobId);
	assert.equal(job?.phase, "waiting", "asking does not re-phase a job");
	assert.deepEqual(job?.open_question, { seq: 1, question: "Postgres or SQLite?", asked_at: NOW });
	assert.ok(validateStatusSnapshot(snapshot).ok, "the snapshot stays schema-valid with a question on it");

	const table = formatStatusTable(snapshot);
	assert.ok(!table.includes("asked you"), "the asked-you marker is gone");
	const widget = statusWidgetLines(snapshot).join("\n");
	assert.match(widget, /NEEDS YOU \(1\)/, "the widget gives the job that needs a human its own section");
	assert.match(widget, /\? cp-ship-a1\s+asked \d+\w ago: Postgres or SQLite\?/, "and says what was asked");

	// And without a question nothing changes: no column, no marker.
	assert.equal(assembleStatus(facts).jobs.find((row) => row.job_id === jobId)?.open_question, undefined);
	assert.ok(!formatStatusTable(assembleStatus(facts)).includes("asked you"));
});

// ---------------------------------------------------------------------------
// Phases: exactly four, and `stalled` is not one of them
// ---------------------------------------------------------------------------

test("script status has a pid/path/exit without model, role, profile or session", () => {
 // SAFETY: the fleet validator admits script records with no worker; FleetRecord still types legacy model readers.
 const script = { ...record({ job_id: "cp-script" }), delivery: "local", executor: "script", script_path: "scripts/run.sh", worker: undefined, script_process: { pid: 4242, started_at: NOW, exited_at: NOW, exit_code: 7 } } as unknown as FleetRecord;
 const snapshot = assembleStatus(fixture({ records: [script], runs: new Map(), alive: new Map() }));
 const job = snapshot.jobs[0]!;
 assert.equal(job.model, undefined);
 assert.equal(job.session_id, undefined);
 assert.equal(job.script_path, "scripts/run.sh");
 assert.equal(job.script_process?.exit_code, 7);
 assert.match(formatStatusTable(snapshot), /script scripts\/run.sh pid 4242/);
 assert.match(renderHeader("cp-script", undefined, script, NOW), /script scripts\/run.sh.*pid 4242.*exited/);
 const pidless = { ...script, phase: "failed", script_process: undefined, script_observed_exit: { exited_at: NOW, exit_code: null, signal: null }, failure: { class: "spawn_failed", message: "spawn_error", at: NOW }, reported_at: NOW } as unknown as FleetRecord;
 const withoutPid = assembleStatus(fixture({ records: [pidless], runs: new Map(), alive: new Map() }));
 assert.equal(withoutPid.jobs[0]?.pid, null);
 assert.equal(withoutPid.jobs[0]?.script_observed_exit?.exited_at, NOW);
 assert.match(formatStatusTable(withoutPid), /pid unknown exited/);
 assert.match(renderHeader("cp-script", undefined, pidless, NOW), /pid unknown.*exited/);
});

test("the snapshot never invents a phase, however old a job is", () => {
	// A dispatch from three hours ago with no envelope: command-post called this
	// `stalled` from an idle pane. Here it is still `waiting`.
	const facts = fixture({
		records: [record({ job_id: "cp-old", dispatched_at: "2026-08-27T09:00:00Z" })],
		runs: new Map([["cp-old", run("cp-old", { phase: "idle" })]]),
		alive: new Map([["cp-old", true]]),
		issues: [],
	});
	const snapshot = assembleStatus(facts);
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(job.phase, "waiting");
	assert.equal(job.run_phase, "idle");
	assert.equal(job.age_seconds, 3 * 3600);
	assert.equal(formatAge(job.age_seconds), "3h");
	assert.ok(!JSON.stringify(snapshot).includes("stalled"));
});

test("a tool call running past the threshold is a measured fact, never a phase", () => {
	// The incident this exists for: a worker wedged inside `git rebase
	// --continue` for seven minutes with no editor set. Nothing surfaced it.
	// current_tool_seconds is sourced from the same run projection everything
	// else reads (current_tool.started_at), so there is no second source of
	// truth for it.
	const startedAt = "2026-08-27T11:41:02Z"; // NOW - 18m58s
	const facts = fixture({
		records: [record({ job_id: "cp-wedged", dispatched_at: "2026-08-27T11:41:00Z" })],
		runs: new Map([
			[
				"cp-wedged",
				run("cp-wedged", {
					phase: "working",
					current_tool: { name: "bash", tool_call_id: "call-wedged", started_at: startedAt },
				}),
			],
		]),
		alive: new Map([["cp-wedged", true]]),
		issues: [],
	});
	const snapshot = assembleStatus(facts);
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];

	// A fact, not a phase: job.phase and job.run_phase are unaffected.
	assert.equal(job.phase, "waiting");
	assert.equal(job.run_phase, "working");
	assert.equal(job.current_tool, "bash");
	const expectedSeconds = ageSeconds(startedAt, NOW);
	assert.ok(expectedSeconds >= LONG_TOOL_CALL_SECONDS, "fixture must actually exceed the threshold");
	assert.equal(job.current_tool_seconds, expectedSeconds);
	assert.ok(!JSON.stringify(snapshot).includes("stalled"), "still no inferred phase, however long the call has run");

	// Surfaced where the operator and parent already look.
	assert.match(toolCell(job), /^bash \(\d+m!\)$/);
	const table = formatStatusTable(snapshot);
	assert.match(table, /long-running tool call: bash for \d+m/);
	// In the widget a long call is what ATTENTION exists for: the incident this
	// threshold comes from is a worker wedged for seven minutes with nothing
	// surfacing it, so the row leaves the routine RUNNING list entirely.
	const widget = statusWidgetLines(snapshot).join("\n");
	assert.match(widget, /ATTENTION \(1\)/);
	assert.match(widget, /cp-wedged\s+bash running \d+m/);

	// A short call gets no marker at all: this is a threshold, not decoration.
	const quick = assembleStatus(
		fixture({
			records: [record({ job_id: "cp-quick", dispatched_at: NOW })],
			runs: new Map([
				["cp-quick", run("cp-quick", { phase: "working", current_tool: { name: "read", tool_call_id: "c", started_at: NOW } })],
			]),
			alive: new Map([["cp-quick", true]]),
			issues: [],
		}),
	).jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(quick.current_tool_seconds, 0);
	assert.equal(toolCell(quick), "read");
	assert.ok(!formatStatusTable(assembleStatus(fixture())).includes("long-running"), "the reviewed fixture's 10s bash call stays unmarked");
});

test("`exited` is only ever an observed close; a vanished pid reads as no-pid", () => {
	const snapshot = assembleStatus(fixture());
	const byId = new Map(snapshot.jobs.map((job) => [job.job_id, job]));

	const working = byId.get("cp-ship-a1");
	assert.ok(working);
	assert.equal(runLabel(working), "working");

	const crashed = byId.get("cp-ship-c3");
	assert.ok(crashed);
	assert.equal(crashed.run_phase, "exited");
	assert.equal(crashed.alive, false);
	assert.equal(runLabel(crashed), "exited");

	// Run projection says working, but the pid does not answer: we know the pid
	// is gone, we did NOT observe a close, so we must not print `exited`.
	const gone = assembleStatus(
		fixture({
			records: [record({ job_id: "cp-gone" })],
			runs: new Map([["cp-gone", run("cp-gone", { phase: "working" })]]),
			alive: new Map([["cp-gone", false]]),
			issues: [],
		}),
	).jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(gone.run_phase, "working");
	assert.equal(gone.alive, false);
	assert.equal(runLabel(gone), "no-pid");

	// A run with no projection at all is unknown, not dead.
	const fresh = assembleStatus(
		fixture({
			records: [record({ job_id: "cp-fresh" })],
			runs: new Map(),
			alive: new Map([["cp-fresh", true]]),
			issues: [],
		}),
	).jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(fresh.run_phase, null);
	assert.equal(runLabel(fresh), "-");
});

test("an observed close outranks a live pid (pids are reused, observations are not)", () => {
	const snapshot = assembleStatus(
		fixture({
			records: [record({ job_id: "cp-reused", phase: "done", closed_at: NOW, worker: { exited_at: "2026-08-27T11:59:00Z" } })],
			runs: new Map(),
			// The probe would say yes; the record says we watched it close.
			alive: new Map([["cp-reused", true]]),
			include: "all",
			issues: [],
		}),
	);
	assert.equal(snapshot.jobs[0]?.alive, false);
	assert.equal(snapshot.counts.live, 0);
});

// ---------------------------------------------------------------------------
// Filters and counts
// ---------------------------------------------------------------------------

test("`active` hides torn-down jobs; `--all` shows them, and counts follow the rows", () => {
	const active = assembleStatus(fixture());
	assert.deepEqual(
		active.jobs.map((job) => job.job_id),
		["cp-ship-a1", "cp-research-b2", "cp-ship-c3"],
		"waiting, then held, then failed; done is hidden",
	);
	assert.equal(active.counts.done, 0);
	assert.equal(active.counts.jobs, 3);
	assert.equal(active.usage.total_tokens, 12_300 + 249_000 + 3200);

	const all = assembleStatus(fixture({ include: "all" }));
	assert.equal(all.counts.jobs, 4);
	assert.equal(all.counts.done, 1);
	assert.equal(all.jobs.at(-1)?.job_id, "cp-ship-d4", "done sorts last: it needs nothing");
	assert.equal(all.usage.total_tokens, 12_300 + 249_000 + 3200 + 5500);
});

test("a project filter scopes the rows but never turns a claimed job into an unclaimed one", () => {
	const snapshot = assembleStatus(fixture({ project: "atlas" }));
	assert.deepEqual(
		snapshot.jobs.map((job) => job.job_id),
		["cp-research-b2"],
	);
	assert.equal(snapshot.filter.project, "atlas");
	// cp-ghost-e5 is a `demo` job: filtered out of unclaimed, not promoted into it.
	assert.deepEqual(snapshot.unclaimed, []);

	const unfiltered = assembleStatus(fixture());
	assert.deepEqual(
		unfiltered.unclaimed.map((entry) => entry.job_id),
		["cp-ghost-e5"],
		"only the br job with no fleet record at all is unclaimed",
	);
	const ghost = unfiltered.unclaimed[0];
	assert.ok(ghost);
	assert.equal(ghost.time_source, "br_updated_at");
	assert.equal(ghost.timestamp, "2026-08-27T08:15:00Z", "br's sub-second stamp is truncated to the contract format");
	assert.equal(ghost.age_seconds, 3 * 3600 + 45 * 60);
});

test("counts and rows can never disagree: an invalid snapshot is a crash, not a view", () => {
	assert.throws(
		() =>
			assembleStatus(
				fixture({ records: [record({ job_id: "cp-twice" }), record({ job_id: "cp-twice" })], runs: new Map(), issues: [] }),
			),
		(error: unknown) => error instanceof StatusError && /duplicate job_id/.test((error as Error).message),
	);
	assert.ok(validateStatusSnapshot(assembleStatus(fixture())).ok);
});

test("a job filtered out of the view is not counted in its totals", () => {
	const snapshot = assembleStatus(fixture({ project: "demo" }));
	const rows = snapshot.jobs.length;
	const phases: JobPhase[] = ["waiting", "held", "done", "failed"];
	assert.equal(
		phases.reduce((total, phase) => total + snapshot.counts[phase], 0),
		rows,
	);
	assert.equal(
		snapshot.usage.cost_usd.toFixed(3),
		snapshot.jobs.reduce((total, job) => total + job.usage.cost_usd, 0).toFixed(3),
	);
});

// ---------------------------------------------------------------------------
// Formatting units (ported from `cmdp status`'s age())
// ---------------------------------------------------------------------------

test("age uses one unit and never runs backwards", () => {
	assert.equal(formatAge(0), "0s");
	assert.equal(formatAge(59), "59s");
	assert.equal(formatAge(60), "1m");
	assert.equal(formatAge(3599), "59m");
	assert.equal(formatAge(3600), "1h");
	assert.equal(formatAge(86_399), "23h");
	assert.equal(formatAge(86_400), "1d");
	// A clock that ran backwards is not evidence a job started in the future.
	assert.equal(ageSeconds("2026-08-27T12:00:10Z", NOW), 0);
	assert.equal(ageSeconds("nonsense", NOW), 0);
});

test("tokens and cost are readable at a glance", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(12_300), "12.3k");
	assert.equal(formatTokens(1_250_000), "1.25M");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(1.239), "$1.24");
});

test("the short model id drops the provider prefix, and an unknown model is a placeholder, never 'undefined'", () => {
	assert.equal(shortModel("anthropic/claude-sonnet-5"), "claude-sonnet-5");
	assert.equal(shortModel("mock/scripted"), "scripted");
	// No provider prefix at all: the whole string is already the short id.
	assert.equal(shortModel("scripted"), "scripted");
	assert.equal(shortModel(undefined), "-");
	assert.equal(shortModel(null), "-");
	assert.equal(shortModel(""), "-");
});

test("the model on the line is the run projection's, not a second source: it wins over the dispatch-time fleet record", () => {
	// Same rule as usage: the run projection is what a live worker updates on
	// every event; the fleet record is fixed at dispatch. A promoted job whose
	// override never got mirrored back into fleet.json must still show what is
	// actually running.
	const snapshot = assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [record({ job_id: "cp-promoted", worker: { model: "anthropic/claude-sonnet-5" } })],
		runs: new Map([["cp-promoted", run("cp-promoted", { model: "anthropic/claude-opus-5" })]]),
		alive: new Map([["cp-promoted", true]]),
		ledger: { ok: false, queried: false },
	});
	assert.equal(snapshot.jobs[0]?.model, "anthropic/claude-opus-5");

	// No run projection at all (before the first event): the fleet record is
	// the only fact there is, so it is the fallback, not a blank.
	const beforeFirstEvent = assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [record({ job_id: "cp-fresh", worker: { model: "anthropic/claude-sonnet-5" } })],
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: false, queried: false },
	});
	assert.equal(beforeFirstEvent.jobs[0]?.model, "anthropic/claude-sonnet-5");
});

// The widget's own degradation, height and section rules live in
// tests/widget.test.ts, next to the renderer they pin.

test("defect 2: one held+working job is one job, not three, and a multi-job fleet stays legible", () => {
	// The reported symptom was a single job rendering as
	// '1 job · 1 held · 1 live · 1 working' -- held, live and working are
	// facets of the SAME job, not three jobs. The headline must say so.
	const oneJob = assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [
			record({
				job_id: "cp-solo",
				phase: "held",
				reported_at: "2026-08-27T11:30:00Z",
				usage: usage({ total_tokens: 4_334_147, cost_usd: 2.03 }),
			}),
		],
		runs: new Map([["cp-solo", run("cp-solo", { phase: "working", usage: usage({ total_tokens: 4_334_147, cost_usd: 2.03 }) })]]),
		alive: new Map([["cp-solo", true]]),
		ledger: { ok: false, queried: false },
	});
	assert.equal(oneJob.counts.jobs, 1);
	const headline = statusHeadline(oneJob);
	assert.equal(headline, "1 job · 1 held · of which 1 live, 1 working");
	// The number '1' never appears as if it were a second or third job count of
	// jobs -- every count after the total is scoped by 'held' or 'of which'.
	assert.ok(!/^1 job · 1 held · 1 live · 1 working$/.test(headline), "must not read as three separate jobs");

	// Multi-job fleet: the fixture already mixes waiting/held/failed with
	// overlapping live/working facets -- assert the phase counts are disjoint
	// and sum to the total, while live/working are called out separately.
	const fleet = assembleStatus(fixture());
	const phaseSum = (["waiting", "held", "failed", "done"] as const).reduce((total, phase) => total + fleet.counts[phase], 0);
	assert.equal(phaseSum, fleet.counts.jobs, "phase counts are disjoint and sum to the total");
	assert.equal(statusHeadline(fleet), "3 jobs · 1 waiting, 1 held, 1 failed · of which 2 live, 1 working");
});

test("defect 3: a promoted held job's RUN leads and PHASE is clearly the policy state, not a second liveness fact", () => {
	// Reported symptom: PHASE=held, RUN=working after a promote (cp_send to a
	// held worker), rendered as the ambiguous 'held/working'. `held` is job
	// POLICY (an envelope was filed; nothing un-holds it but teardown or a
	// fresh dispatch) and is allowed to coexist with a live, working run -- see
	// LIVE_PHASES in preflight.ts, which lets cp_send target a held job. The
	// fix is presentation: lead with the liveness fact (RUN) and parenthesize
	// the policy fact (PHASE), so the line reads unambiguously instead of like
	// a contradiction.
	const snapshot = assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [record({ job_id: "cp-promoted", phase: "held", reported_at: "2026-08-27T11:30:00Z" })],
		runs: new Map([["cp-promoted", run("cp-promoted", { phase: "working" })]]),
		alive: new Map([["cp-promoted", true]]),
		ledger: { ok: false, queried: false },
	});
	const job = snapshot.jobs[0] as StatusSnapshot["jobs"][number];
	assert.equal(job.phase, "held", "phase is job policy and stays held until teardown");
	assert.equal(job.run_phase, "working", "run_phase is the process-liveness fact and reflects the promote");
	// In the widget the two facts stop sharing a cell entirely (cp-8tu): policy
	// is the section the row is in, liveness is the word on the row, so nothing
	// has to be parenthesized to read unambiguously.
	const widget = statusWidgetLines(snapshot).join("\n");
	assert.match(widget, /RUNNING \(1\)/, "a promoted held job is running, and the section says so");
	assert.match(widget, /cp-promoted\s+.*working/, "the row carries the liveness fact as a word");
});

// ---------------------------------------------------------------------------
// Collection from files, and the ledger join
// ---------------------------------------------------------------------------



test("defect 1: /status, /watch and the cp_send budget gate read the same usage for a live run", async (t) => {
	// A worker mid-run: the fleet record's usage is EMPTY_USAGE, exactly as it
	// is between dispatch and the intake/teardown that eventually patches it.
	// The run projection (status.json), written on every event, is the only
	// place real numbers exist yet. A renderer that reads the fleet record
	// instead of the run projection here reproduces the reported bug: 0
	// tokens / $0.00 while the job has actually spent real money.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const jobId = "cp-live-spend";
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record({ job_id: jobId, phase: "waiting", usage: usage(), budget: { tokens: 5_000_000, cost_usd: 50 } }));

	const recorder = RunRecorder.open({ home: home.path, jobId, meta: { pid: 4242, model: "mock/scripted" } });
	recorder.cp("spawned", { pid: 4242, model: "mock/scripted" });
	recorder.pi({ type: "agent_start" } as never);
	recorder.pi({
		type: "message_end",
		message: {
			role: "assistant",
			usage: { input: 4_000_000, output: 334_147, cacheRead: 0, cacheWrite: 0, totalTokens: 4_334_147, cost: { total: 2.03 } },
		},
	} as never);

	// The fleet record on disk still says zero: only intake/teardown patch it.
	assert.deepEqual(fleet.get(jobId)?.usage, usage());

	// 1. /status: the assembled snapshot must show the run's real usage, not
	// the fleet record's stale zero.
	const reporter = new StatusReporter({ home: home.path, fleet, now: () => new Date(NOW), isPidAlive: () => true });
	const snapshot = reporter.collect();
	const job = snapshot.jobs.find((row) => row.job_id === jobId);
	assert.equal(job?.usage.total_tokens, 4_334_147, "/status must read the run projection, not an unpopulated fleet counter");
	assert.equal(job?.usage.cost_usd, 2.03);
	assert.equal(snapshot.usage.total_tokens, 4_334_147, "the TOTAL row follows the same source");
	assert.match(formatStatusTable(snapshot), /4\.33M\s+\$2\.03/, "the rendered table must not print 0 / \$0.00");

	// 2. /watch: the same status.json, rendered by the watch header.
	const runStatus = readStatusFile(home.path, jobId);
	const header = renderHeader(jobId, runStatus, fleet.get(jobId), NOW);
	assert.match(header, /4\.33M \$2\.03/);

	// 3. cp_send's budget gate: same numbers again, independent of the other two.
	const budget = checkBudget(runStatus?.usage ?? usage(), { tokens: 5_000_000, cost_usd: 50 }, DEFAULT_BUDGET_CONFIG);
	assert.equal(budget.tokens.used, 4_334_147);
	assert.equal(budget.cost.used, 2.03);

	// All three views agree with each other and with `rebuildStatus` (the log
	// is the truth): one source, read three times, not three counters.
	const rebuilt = rebuildStatus(home.path, jobId);
	assert.equal(job?.usage.total_tokens, rebuilt.usage.total_tokens);
	assert.equal(job?.usage.cost_usd, rebuilt.usage.cost_usd);
	assert.equal(budget.tokens.used, rebuilt.usage.total_tokens);
});

test("the reporter reads files only: fleet.json plus each run's status.json", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record({ job_id: "cp-alive" }));
	await fleet.add(record({ job_id: "cp-nostatus", dispatched_at: "2026-08-27T11:00:00Z" }));

	const runDir = join(home.path, paths.runDir("cp-alive"));
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(home.path, paths.statusFile("cp-alive")),
		JSON.stringify(
			run("cp-alive", {
				phase: "working",
				turns: 2,
				tool_calls: 5,
				current_tool: { name: "read", tool_call_id: "c1", started_at: "2026-08-27T11:59:00Z" },
			}),
		),
	);
	// A corrupt projection must not take the view down with it.
	mkdirSync(join(home.path, paths.runDir("cp-nostatus")), { recursive: true });
	writeFileSync(join(home.path, paths.statusFile("cp-nostatus")), "{ not json");

	const reporter = new StatusReporter({
		home: home.path,
		fleet,
		now: () => new Date(NOW),
		isPidAlive: (pid) => pid === 4242,
	});

	const snapshot = reporter.collect();
	assert.equal(snapshot.home, home.path);
	assert.equal(snapshot.ledger.queried, false, "collect() never reads the ledger");
	assert.equal(snapshot.counts.jobs, 2);
	const alive = snapshot.jobs.find((job) => job.job_id === "cp-alive");
	assert.equal(alive?.run_phase, "working");
	assert.equal(alive?.current_tool, "read");
	assert.equal(alive?.tool_calls, 5);
	assert.equal(alive?.title, null, "no join, no titles");
	const broken = snapshot.jobs.find((job) => job.job_id === "cp-nostatus");
	assert.equal(broken?.run_phase, null, "an unreadable projection is unknown, not a crash");
	assert.ok(validateStatusSnapshot(snapshot).ok);
});

test("the ledger join adds titles and finds jobs the ledger thinks are in flight", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record({ job_id: "cp-known" }));

	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	await scratch.ledger.importJobs([
		issue({ id: "cp-known", title: "Known job" }),
		issue({ id: "cp-elsewhere", title: "Claimed elsewhere" }),
	]);

	const reporter = new StatusReporter({
		home: home.path,
		fleet,
		now: () => new Date(NOW),
		isPidAlive: () => true,
		ledger: () => scratch.ledger,
	});

	const snapshot = await reporter.snapshot();
	assert.equal(snapshot.ledger.ok, true);
	assert.equal(snapshot.ledger.queried, true);
	assert.equal(snapshot.jobs[0]?.title, "Known job");
	assert.equal(snapshot.jobs[0]?.br_status, "in_progress");
	assert.deepEqual(
		snapshot.unclaimed.map((entry) => entry.job_id),
		["cp-elsewhere"],
	);

	// --no-titles is the widget's path: files only, no ledger read.
	const quiet = await reporter.snapshot({ titles: false });
	assert.equal(quiet.ledger.queried, false);
});

test("an unreadable ledger degrades the view instead of refusing it", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record({ job_id: "cp-known" }));

	const reporter = new StatusReporter({
		home: home.path,
		fleet,
		now: () => new Date(NOW),
		isPidAlive: () => true,
		ledger: () => new Ledger({ home: join(home.path, "nowhere") }),
	});

	const snapshot = await reporter.snapshot();
	assert.equal(snapshot.ledger.ok, false);
	assert.equal(snapshot.ledger.queried, true);
	assert.match(snapshot.ledger.error ?? "", /no ledger at/);
	assert.equal(snapshot.counts.jobs, 1, "the workers are still reported");
	assert.match(formatStatusTable(snapshot), /LEDGER degraded/);

	// No ledger wired in at all is the same kind of honest degradation.
	const bare = await new StatusReporter({ home: home.path, fleet, now: () => new Date(NOW) }).snapshot();
	assert.equal(bare.ledger.ok, false);
	assert.match(bare.ledger.error ?? "", /no ledger configured/);
});

test("an empty home is an empty fleet, not an error", () => {
	const home = createScratchHome();
	try {
		const snapshot = new StatusReporter({
			home: home.path,
			fleet: new FleetStore({ home: home.path }),
			now: () => new Date(NOW),
		}).collect();
		assert.equal(snapshot.counts.jobs, 0);
		assert.equal(snapshot.schema_version, SCHEMA_VERSION);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// `/status` argument parsing
// ---------------------------------------------------------------------------

test("/status and the widget work in a real pi session", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	// This process is alive, so the pid probe has something true to find.
	await fleet.add(record({ job_id: "cp-live-job", worker: { pid: process.pid } }));

	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		env: { CP_HOME: home.path },
	});
	// Close the child before removing the home it writes into: a cleanup hook
	// that throws skips every later hook (cp-widget-test-hangs).
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});

	const commands = (await rpc.waitFor((r) => {
		rpc.send({ id: "cmds", type: "get_commands" });
		return r.type === "response" && r.id === "cmds";
	})) as { data?: { commands?: Array<{ name: string }> } };
	assert.ok(
		(commands.data?.commands ?? []).some((command) => command.name === "status"),
		"/status is not registered",
	);

	// The widget is set from session_start, before anyone asks for anything.
	const widget = await rpc.waitFor((r) => r.type === "extension_ui_request" && r.method === "setWidget");
	assert.equal(widget.widgetKey, "command-post");
	const lines = widget.widgetLines as string[];
	assert.ok(Array.isArray(lines) && lines.length >= 3, `unexpected widget payload: ${JSON.stringify(widget)}`);
	assert.match(lines[0] as string, /^command post · 1 job/);
	assert.equal(lines[1], "RUNNING (1)");
	assert.match(lines[2] as string, /^ {2}○ cp-live-job\s+claude-sonnet-5/);
	// RPC gets plain strings: component factories are ignored over the protocol
	// and the client receives these verbatim, so styling must never reach here.
	for (const line of lines) assert.ok(!line.includes("\u001b"), `ANSI leaked into an RPC widget payload: ${JSON.stringify(line)}`);

	rpc.send({ id: "status", type: "prompt", message: "/status --no-titles" });
	const notify = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("FLEET "),
	);
	const table = String(notify.message);
	assert.match(table, /1 job · 1 waiting · of which 1 live/);
	assert.match(table, /cp-live-job/);
	assert.ok(!table.includes("LEDGER degraded"), "--no-titles must not query br at all");

	const done = await rpc.waitFor((r) => r.type === "response" && r.id === "status");
	assert.equal(done.success, true);
});

test("/status parses its flags and refuses the ones it does not know", () => {
	assert.deepEqual(parseStatusArgs(""), { json: false, query: {} });
	assert.deepEqual(parseStatusArgs("  --json  --all "), { json: true, query: { include: "all" } });
	assert.deepEqual(parseStatusArgs("--project demo"), { json: false, query: { project: "demo" } });
	assert.deepEqual(parseStatusArgs("--no-titles"), { json: false, query: { titles: false } });
	assert.throws(() => parseStatusArgs("--serve"), /unknown argument/);
	assert.throws(() => parseStatusArgs("--html"), /unknown argument/);
	assert.throws(() => parseStatusArgs("--project"), /needs a project name/);
	assert.throws(() => parseStatusArgs("--project --json"), /needs a project name/);
});

// ---------------------------------------------------------------------------
// cp-epy2 §4.2 item 3: the drain line ("may this parent die now?")
// ---------------------------------------------------------------------------

test("the drain projection is a render option, not part of the snapshot", () => {
	const snapshot = assembleStatus(fixture());

	// Absent by default, which is what keeps every pinned golden byte-identical:
	// the goldens, the widget and `--json` all have no manager to ask.
	assert.ok(!formatStatusTable(snapshot).includes("DRAIN"));
	assert.ok(!formatStatusJson(snapshot).includes("drain"));

	// A job still working: the parent may not exit, and the line names the job.
	const working = formatStatusTable(snapshot, { drain: { active: 2, busy: ["cp-t23-alpha"] } });
	assert.match(working, /DRAIN 2 worker\(s\) in this session, 1 busy: cp-t23-alpha — not drained/);
	assert.match(working, /exiting now kills it/);

	// A job that has settled: drained, and the reason a parent may go is stated
	// (its held/waiting records survive as revivable, they are not lost).
	const drained = formatStatusTable(snapshot, { drain: { active: 2, busy: [] } });
	assert.match(drained, /DRAIN 2 worker\(s\) in this session, 0 busy — drained/);
	assert.match(drained, /revivable/);

	// No workers at all is still an answer, not a blank.
	assert.match(formatDrainLine({ active: 0, busy: [] }), /^DRAIN 0 workers in this session — drained/);

	// It renders on an empty fleet too: "no jobs" and "may I exit" are different
	// questions, and a broker asks the second one.
	const empty = assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "active",
		records: [],
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: true, queried: true },
	});
	assert.match(formatStatusTable(empty, { drain: { active: 0, busy: [] } }), /no jobs \(active\)[\s\S]*DRAIN 0 workers/);
});

// ---------------------------------------------------------------------------
// Pending reviews (spec 2026-09-05-async-reviewers)
// ---------------------------------------------------------------------------

const PENDING_GATE = {
	schema_version: SCHEMA_VERSION,
	job_id: "cp-pr",
	surface: "gate" as const,
	attempt: 2,
	model: "mock/reviewer",
	pid: 1,
	started_at: "2026-08-27T11:56:00Z",
	deadline: "2026-08-27T12:11:00Z",
	handed_back: true,
};

test("a pending review is carried onto the job row from pending.json, files only", () => {
	const job = record({ job_id: "cp-pr" });
	const base = {
		home: HOME,
		generated_at: NOW,
		include: "all" as const,
		records: [job],
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: false, queried: false },
	};
	const snapshot = assembleStatus({ ...base, pendingReviews: new Map([["cp-pr", PENDING_GATE]]) });
	assert.deepEqual(snapshot.jobs[0]?.pending_review, {
		surface: "gate",
		attempt: 2,
		started_at: "2026-08-27T11:56:00Z",
		deadline: "2026-08-27T12:11:00Z",
	});
	assert.ok(validateStatusSnapshot(snapshot).ok);
	assert.match(formatStatusTable(snapshot), /gate 2 running 4m/);
	assert.equal(assembleStatus(base).jobs[0]?.pending_review, undefined);
});

test("StatusReporter reads pending.json off disk for each fleet job", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record({ job_id: "cp-pr" }));
	const file = join(home.path, paths.pendingReviewFile("cp-pr", "gate", 1));
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify({ ...PENDING_GATE, attempt: 1, handed_back: false }));
	const reporter = new StatusReporter({ home: home.path, fleet, now: () => new Date(NOW), isPidAlive: () => true });
	assert.equal(reporter.collect({ include: "all" }).jobs.find((job) => job.job_id === "cp-pr")?.pending_review?.attempt, 1);
});

// ---------------------------------------------------------------------------
// cp-routing-provenance: the scope/risk cell, per axis
// ---------------------------------------------------------------------------

/** `formatScopeRisk`/`formatThinking` read only `job.routing`; nothing else. */
function routed(routing: JobRouting | undefined): StatusJob {
	return { job_id: "cp-x", ...(routing ? { routing } : {}) } as StatusJob;
}

test("cp-routing-provenance: the scope/risk cell marks each axis from its own provenance", () => {
	// Chosen, either by a human or by a planner's own measurement: no marker.
	assert.equal(formatScopeRisk(routed({ scope: "S", risk: "low", inferred: false, provenance: { scope: "explicit", risk: "explicit" } })), "S/low");
	assert.equal(formatScopeRisk(routed({ scope: "L", risk: "high", inferred: false, provenance: { scope: "assessed", risk: "assessed" } })), "L/high");
	// Both inferred: `?` on both sides, as before.
	assert.equal(formatScopeRisk(routed({ scope: "M", risk: "high", inferred: true, provenance: { scope: "inferred", risk: "inferred" } })), "M?/high?");
	// Mixed — the case the one-bit flag could not express. One inferred axis
	// must not put a `?` on the axis the caller named, in either direction.
	assert.equal(formatScopeRisk(routed({ scope: "M", risk: "high", inferred: true, provenance: { scope: "explicit", risk: "inferred" } })), "M/high?");
	assert.equal(formatScopeRisk(routed({ scope: "M", risk: "low", inferred: true, provenance: { scope: "inferred", risk: "explicit" } })), "M?/low");
});

test("cp-routing-provenance: a defaulted axis renders '-', never the default it used", () => {
	// Routing ran as S/low, but nobody decided that — printing `S/low` would
	// claim a decision, which is the silent-default bug cp-rte fixed for routing.
	assert.equal(formatScopeRisk(routed({ scope: "S", risk: "low", inferred: false, provenance: { scope: "defaulted", risk: "defaulted" } })), "-/-");
	assert.equal(formatScopeRisk(routed({ scope: "M", risk: "low", inferred: true, provenance: { scope: "inferred", risk: "defaulted" } })), "M?/-");
	assert.equal(formatScopeRisk(routed({ scope: "S", risk: "high", inferred: true, provenance: { scope: "defaulted", risk: "inferred" } })), "-/high?");
});

test("cp-routing-provenance: records without provenance render exactly as they did before", () => {
	// The legacy one-bit fallback, unchanged: both sides take the same mark.
	assert.equal(formatScopeRisk(routed({ scope: "S", risk: "low", inferred: false })), "S/low");
	assert.equal(formatScopeRisk(routed({ scope: "M", risk: "high", inferred: true })), "M?/high?");
	assert.equal(formatScopeRisk(routed({ scope: "M", inferred: true })), "M?/-", "a legacy record missing one side still prints '-' there");
	// And no routing decision at all is still the one unknown placeholder.
	assert.equal(formatScopeRisk(routed(undefined)), "\u2014");
	assert.equal(formatThinking(routed(undefined)), "\u2014");
	assert.equal(formatThinking(routed({ scope: "S", risk: "low", inferred: false, provenance: { scope: "defaulted", risk: "defaulted" } })), "-");
});

test("cp-routing-provenance: a hand-edited half provenance never inherits the legacy mark", () => {
	// The contract requires both axes inside a `provenance` object, so this
	// shape should not exist. If one ever reaches a reader, the axis it does not
	// describe stays unmarked rather than borrowing the other axis's `?` from
	// the one-bit flag — the exact relabelling this field exists to remove.
	const half = { scope: "M", risk: "high", inferred: true, provenance: { scope: "inferred" } } as unknown as JobRouting;
	assert.equal(formatScopeRisk(routed(half)), "M?/high");
	assert.equal(
		validate(JobRoutingSchema, half).ok,
		false,
		"and the contract refuses it: a provenance object describes both axes or neither",
	);
});

test("cp-routing-provenance: every routing reader carries a defaulted decision through as decided-by-nobody", () => {
	// The readers of `FleetRecord.routing`: /status carries it verbatim, the
	// widget and the status block render it through `formatScopeRisk`, and
	// revive reads only `thinking`. None of them may re-read `S`/`low` as a
	// choice somebody made.
	const routing: JobRouting = { scope: "S", risk: "low", thinking: "medium", inferred: false, provenance: { scope: "defaulted", risk: "defaulted" } };
	const snapshot = assembleStatus(fixture({ records: [record({ job_id: "cp-defaulted", dispatched_at: "2026-08-27T11:56:00Z", routing })] }));
	const job = snapshot.jobs.find((entry) => entry.job_id === "cp-defaulted");
	assert.deepEqual(job?.routing, routing, "/status carries the decision through verbatim, provenance included");
	assert.equal(formatScopeRisk(job as StatusJob), "-/-");
	assert.ok(validateStatusSnapshot(snapshot).ok, "and the snapshot still satisfies the contract");
	// The widget reads the same cell, so it cannot disagree with the table.
	const lines = statusWidgetLines(snapshot, { width: 110 });
	assert.ok(
		lines.some((line) => line.includes("cp-defaulted") && line.includes("-/-/medium")),
		`widget did not render the defaulted cell: ${lines.join("\n")}`,
	);
});

test("a blocked planner is an ordinary waiting job with the blocker count", async () => {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(
		record({
			job_id: "cp-plan-b1",
			kind: "research",
			phase: "waiting",
			planner_blocked_rounds: 1,
			reported_at: NOW,
			worker: { role: "planner", profile: "planner" },
		}),
	);
	const file = join(home.path, paths.envelopeFile("cp-plan-b1"));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ envelope: { blockers: [{ question: "a" }, { question: "b" }] } }));
	const snapshot = new StatusReporter({ home: home.path, fleet, now: () => new Date(NOW), isPidAlive: () => false }).collect();
	const job = snapshot.jobs.find((row) => row.job_id === "cp-plan-b1");
	assert.equal(job?.phase, "waiting");
	assert.equal(job?.blockers, 2);
	const lines = statusWidgetLines(snapshot).join("\n");
	assert.match(lines, /2 blockers/);
	assert.ok(!lines.includes("asked you"));
	assert.ok(!lines.includes("plan ready"));
	home.cleanup();
});
