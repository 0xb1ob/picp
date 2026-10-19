/**
 * Schedules refactor PR3: a native cp-self-review run is driven by the schedule runner in code (six readers, one
 * synthesis) with no parent wake. Scratch home and ledger, fake dispatch/teardown ports.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FleetRecord } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import type { IntakeResult } from "../src/intake.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { cpNext } from "../src/next.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { pendingExpansions, scheduleLabelRefusal } from "../src/schedule-expand.ts";
import { ScheduleRunner } from "../src/schedule-runner.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { readerTask, SELF_REVIEW_READERS, SELF_REVIEW_WALL_CLOCK_SECONDS, selfReviewWindow, windowText } from "../src/schedule-self-review.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { ScheduleRun } from "../src/viewer/schedule-run-core.ts";
import { createScratchHome, createScratchLedger, REPO_ROOT } from "./harness/index.ts";

const ACTION = { saved_by: "operator-quote" as const, provenance: { channel: "cp_schedule" as const, tool_call_id: "call-add", quote_sha: "abcdef123456" } };
const done = (jobId: string, overrides: Partial<IntakeResult> = {}): IntakeResult => ({ job_id: jobId, accepted: true, already: false, phase: "held", next: "teardown", status: "done", summary: "ok", ...overrides });

async function bench(t: import("node:test").TestContext, description = "Review the fleet.", limits: { parallelism: number; child_jobs?: number } = { parallelism: 2 }) {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const ledger = createScratchLedger({ home: home.path, knownProjects: ["demo"] }).ledger;
	const clock = { now: new Date(new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) };
	const runs = openScheduleRunStore(home.path);
	const mandates = new MandateStore(home.path, { runs, now: () => clock.now });
	const defaults = structuredClone(loadMandateDefaults(home.path));
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, runs, usageJobs: () => [], cloneOf: () => home.path, now: () => clock.now, mintContext: () => ({ defaults, ceiling: defaults.token_ceiling! }) });
	const schedule = await scheduler.add({ name: "self-review", project: "demo", native: { action: ACTION, limits }, manual: true, title: "Self-review", description, kind: "research", delivery: "local", skill: "cp-self-review" });
	const fleet: FleetRecord[] = [];
	const calls = { dispatch: [] as { jobId: string; task?: string; wallClockSeconds?: number }[], wake: [] as IntakeResult[], log: [] as string[] };
	const runner = new ScheduleRunner({
		dispatch: async (request) => { calls.dispatch.push(request); fleet.push({ job_id: request.jobId, phase: "waiting" } as FleetRecord); },
		// Real teardown closes the ledger job and settles the fleet record.
		tearDown: async (jobId) => {
			await ledger.close(jobId, `researched: state/artifacts/${jobId}/report.md`);
			fleet.find((record) => record.job_id === jobId)!.phase = "done";
			return { torn_down: true };
		},
		recorded: async (jobId) => done(jobId, { already: true }),
		wake: (result) => calls.wake.push(result),
		ledger: () => ledger, fleetJobs: () => fleet, schedules: () => scheduler.list(), now: () => clock.now,
		log: (line) => calls.log.push(line), runs,
	});
	const fire = async () => {
		const event = await scheduler.fireNow(schedule.id, { via: "cp_schedule", tool_call_id: `call-${Math.random()}` });
		assert.equal(event.outcome, "fired"); assert.equal(event.native, true);
		return event;
	};
	const roles = (run: ScheduleRun): Record<string, string> => Object.fromEntries(run.members.filter((member) => member.role && member.job_id !== run.anchor_job_id).map((member) => [member.role, member.job_id]));
	const report = async (jobId: string) => {
		fleet.find((record) => record.job_id === jobId)!.phase = "held";
		assert.equal(runner.claims(done(jobId)), true, `${jobId} is the runner's`);
		assert.equal(await runner.onReported(done(jobId)), true);
	};
	return { home, ledger, runs, mandates, scheduler, schedule, runner, fleet, calls, clock, fire, roles, report };
}

test("window: N hours ending at the anchor's creation (default 36, window_hours 1-168) and L3-L5 thirds", () => {
	assert.deepEqual(selfReviewWindow("2026-01-02T12:00:00Z"), { start: "2026-01-01T00:00:00Z", end: "2026-01-02T12:00:00Z", hours: 36 });
	assert.equal(selfReviewWindow("2026-01-02T12:00:00Z", "Focus on CI.\nwindow_hours: 6").start, "2026-01-02T06:00:00Z");
	assert.equal(selfReviewWindow("2026-01-02T12:00:00Z", "window_hours: 500").hours, 36, "out of range falls back");
	const window = selfReviewWindow("2026-01-02T12:00:00Z");
	assert.deepEqual([0, 1, 2].map((third) => windowText(window, third as 0 | 1 | 2)), ["[2026-01-01T00:00:00Z, 2026-01-01T12:00:00Z)", "[2026-01-01T12:00:00Z, 2026-01-02T00:00:00Z)", "[2026-01-02T00:00:00Z, 2026-01-02T12:00:00Z]"]);
	const task = readerTask({ id: "run-x", schedule_id: "sch-abc123" } as ScheduleRun, { id: "cp-a", created_at: "2026-01-02T12:00:00Z", description: "" }, SELF_REVIEW_READERS[2]!);
	assert.match(task, /^Self-review reader L3: .*run run-x/); assert.match(task, /\[2026-01-01T00:00:00Z, 2026-01-01T12:00:00Z\)/);
	assert.doesNotMatch(task, /\{\{/, "every placeholder filled");
});

test("a native self-review run expands, dispatches within parallelism and closes in code, with no parent wake", async (t) => {
	const b = await bench(t);
	const fired = await b.fire();
	await b.runner.onFired(fired);
	let run = b.runs.run(fired.run_id!)!;
	const ids = b.roles(run);
	assert.deepEqual(Object.keys(ids).sort(), ["L1", "L2", "L3", "L4", "L5", "L6", "S1"]);
	const s1 = await b.ledger.show(ids.S1!);
	assert.deepEqual([...s1.blocked_by].sort(), ["L1", "L2", "L3", "L4", "L5", "L6"].map((role) => ids[role]).sort());
	assert.ok(s1.labels.includes(`schedule:${b.schedule.id}`) && s1.labels.includes("delivery:board"));
	assert.match((await b.ledger.show(fired.job_id!)).comments.map((comment) => comment.text).join("\n"), new RegExp(`^expanded: L1 ${ids.L1}, .*S1 ${ids.S1}`, "m"));
	assert.deepEqual(b.calls.dispatch.map((call) => call.jobId), [ids.L1, ids.L2], "parallelism 2");
	assert.ok(b.calls.dispatch.every((call) => call.wallClockSeconds === SELF_REVIEW_WALL_CLOCK_SECONDS && /Self-review reader L\d/.test(call.task ?? "")));
	// Replays (a second fire event, ticks) create, admit and dispatch nothing new.
	await b.runner.onFired(fired); await b.runner.retryPending();
	assert.equal(b.runs.run(run.id)!.members.length, run.members.length);
	assert.equal(b.calls.dispatch.length, 2);
	assert.deepEqual(pendingExpansions(b.ledger.read().jobs, b.scheduler.list(), b.runs), [], "never a parent expansion wake");
	assert.match(scheduleLabelRefusal([`schedule:${b.schedule.id}`], b.ledger.read().jobs, b.scheduler.list(), { runs: b.runs }) ?? "", /runner creates this self-review run's jobs in code/);
	// A blocked envelope is the parent's exception; a done one is torn down and starts the next reader.
	assert.equal(b.runner.claims(done(ids.L1!, { status: "blocked" })), false);
	for (const role of ["L1", "L2", "L3", "L4", "L5", "L6"]) await b.report(ids[role]!);
	assert.deepEqual(b.calls.dispatch.map((call) => call.jobId), ["L1", "L2", "L3", "L4", "L5", "L6", "S1"].map((role) => ids[role]));
	const synthesis = b.calls.dispatch.at(-1)!.task ?? "";
	assert.match(synthesis, /^Self-review synthesis S1/); assert.match(synthesis, new RegExp(`state/artifacts/${ids.L6}/report.md`));
	// Pins the report-only proposal contract in the rendered task text; it proves wording, not model behaviour.
	assert.match(synthesis, /"Experiment proposals" section: zero to three proposals/);
	for (const field of ["falsifiable hypothesis", "baseline identity", "the authority it needs", "a rollback", "outcome \"not run\""]) {
		assert.ok(synthesis.includes(field), `S1 proposal field: ${field}`);
	}
	assert.match(synthesis, /No supported\s+experiment\./); assert.match(synthesis, /S1 runs, dispatches and authorizes nothing/);
	assert.match(synthesis, /no builds, tests, installs, git writes, or writes to live state/, "read-only rules stay");
	assert.match(synthesis, /delivery `board`/);
	const legacy = readFileSync(join(REPO_ROOT, "skills/cp-self-review/SKILL.md"), "utf8");
	const contract = synthesis.slice(synthesis.indexOf("Add an \"Experiment proposals\""), synthesis.indexOf("covering authority.") + 19);
	assert.ok(contract.length > 100 && legacy.includes(contract), "the legacy S1 template mirrors the proposal contract");
	// The web board (site/index.html) bullet must carry the proposals too, in both templates, not only report.md.
	for (const text of [synthesis, legacy]) assert.match(text.slice(text.indexOf("`site/index.html`")).split("\n\n")[0]!, /"Experiment proposals" section/);
	await b.report(ids.S1!);
	assert.match((await b.ledger.show(fired.job_id!)).close_reason ?? "", new RegExp(`^researched: synthesis ${ids.S1}`));
	run = b.runs.run(run.id)!;
	assert.equal(run.phase, "closed"); assert.equal(run.outcome, "completed");
	assert.deepEqual(b.calls.wake, [], "no parent success turn");
});

test("crash replay reuses a created job by title; a passed deadline drops unstarted work and S1, so the run is partial", async (t) => {
	const b = await bench(t);
	const fired = await b.fire();
	// A crash after L1's ledger create but before its admission: the replay finds it by its per-anchor title.
	const early = await b.ledger.create({ title: `Review parent session errors [${fired.job_id}]`, project: "demo", kind: "research", delivery: "local", labels: [`schedule:${b.schedule.id}`] });
	await b.runner.retryPending();
	const ids = b.roles(b.runs.run(fired.run_id!)!);
	assert.equal(ids.L1, early.id);
	b.clock.now = new Date(Date.parse(b.runs.run(fired.run_id!)!.deadline_at) + 1000);
	await b.runner.retryPending();
	for (const role of ["L3", "L4", "L5", "L6", "S1"]) assert.match((await b.ledger.show(ids[role]!)).close_reason ?? "", /^dropped: .*deadline passed/);
	await b.report(ids.L1!); await b.report(ids.L2!);
	assert.match((await b.ledger.show(fired.job_id!)).close_reason ?? "", /^dropped: self-review run .* without a synthesis/);
	assert.equal(b.runs.run(fired.run_id!)!.outcome, "partial");
	assert.equal(b.calls.dispatch.length, 2, "S1 never starts without all six reports");
});

// PR3 review medium: a `:1` usd or tokens cap notice is the run's stop like a deadline; started readers finish,
// unstarted ones and S1 drop, and the anchor closes partial.
for (const axis of ["usd", "tokens"] as const) {
	test(`a ${axis}:1 cap notice drops unstarted members and S1; the run closes partial`, async (t) => {
		const b = await bench(t);
		const fired = await b.fire();
		await b.runner.onFired(fired);
		const ids = b.roles(b.runs.run(fired.run_id!)!);
		await b.runs.noteCap(fired.run_id!, `${axis}:0.8`);
		await b.runner.retryPending();
		assert.equal((await b.ledger.show(ids.L3!)).status, "open", "a warning-level notice stops nothing");
		await b.runs.noteCap(fired.run_id!, `${axis}:1`);
		await b.runner.retryPending();
		for (const role of ["L3", "L4", "L5", "L6", "S1"]) assert.match((await b.ledger.show(ids[role]!)).close_reason ?? "", new RegExp(`^dropped: run .*: ${axis} cap reached; not started`));
		await b.report(ids.L1!); await b.report(ids.L2!);
		assert.match((await b.ledger.show(fired.job_id!)).close_reason ?? "", /^dropped: self-review run .* without a synthesis/);
		assert.equal(b.runs.run(fired.run_id!)!.outcome, "partial");
		assert.equal(b.calls.dispatch.length, 2);
	});
}

// PR3 review medium: a run whose anchor the parent already marked `expanded:` before the runner owned it (no admitted
// role) stays the parent's; the runner creates, admits and dispatches nothing for it.
test("a legacy parent-expanded run (expanded: marker, no admitted role) is never re-expanded in code", async (t) => {
	const b = await bench(t);
	const fired = await b.fire();
	await b.ledger.comment(fired.job_id!, "expanded: L1 cp-parent1, S1 cp-parent2 (parent)");
	const jobs = b.ledger.read().jobs.length, members = b.runs.run(fired.run_id!)!.members;
	assert.ok(members.every((member) => member.role === null), "only the role-less anchor");
	await b.runner.onFired(fired); await b.runner.retryPending();
	assert.deepEqual(b.runs.run(fired.run_id!)!.members, members);
	assert.equal(b.ledger.read().jobs.length, jobs, "no job created");
	assert.deepEqual(b.calls.dispatch, []);
});

// PR3 review low: cp_next never offers a runner-owned member (admitted by role); a parent-admitted one (role null) it does.
test("cp_next excludes a self-review run's role members but offers a parent-admitted member", async (t) => {
	const b = await bench(t, undefined, { parallelism: 2, child_jobs: 9 });
	const fired = await b.fire();
	await b.runner.onFired(fired);
	const ids = b.roles(b.runs.run(fired.run_id!)!);
	const extra = await b.ledger.create({ title: "parent follow-up", project: "demo", kind: "research", delivery: "pr", labels: [`schedule:${b.schedule.id}`] });
	await b.runs.admitMember(fired.run_id!, { job_id: extra.id, role: null, admitted_at: extra.created_at });
	const next = await cpNext({ ledger: b.ledger as Ledger, fleet: new FleetStore({ home: b.home.path }), mandates: b.mandates, escalations: new EscalationStore({ home: b.home.path }) }, "demo");
	const offered = [...next.ready.map((job) => job.id), next.action.job_id];
	for (const role of Object.keys(ids)) assert.ok(!offered.includes(ids[role]), `${role} ${ids[role]} is the runner's`);
	assert.ok(next.ready.some((job) => job.id === extra.id), "a role-less member is still the parent's to dispatch");
});

// PR3 review medium: a reader closed as failed (any non-delivery close, not only `dropped:`) is a lost report, so S1
// never synthesizes without it: S1 drops naming it, and the anchor closes partial.
test("a reader closed as failed blocks S1 like a dropped one; the run is partial", async (t) => {
	const b = await bench(t);
	const fired = await b.fire();
	await b.runner.onFired(fired);
	const ids = b.roles(b.runs.run(fired.run_id!)!);
	b.fleet.find((record) => record.job_id === ids.L1)!.phase = "failed";
	await b.ledger.close(ids.L1!, "failed: worker died before its report");
	await b.runner.retryPending();
	for (const role of ["L2", "L3", "L4", "L5", "L6"]) await b.report(ids[role]!);
	assert.match((await b.ledger.show(ids.S1!)).close_reason ?? "", new RegExp(`^dropped: run .*: required reader\\(s\\) ${ids.L1} not delivered`));
	assert.ok(!b.calls.dispatch.some((call) => call.jobId === ids.S1), "S1 never starts without all six reports");
	assert.match((await b.ledger.show(fired.job_id!)).close_reason ?? "", /^dropped: self-review run .* without a synthesis/);
	assert.equal(b.runs.run(fired.run_id!)!.outcome, "partial");
});
