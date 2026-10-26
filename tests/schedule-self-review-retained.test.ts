/**
 * Retained verbatim from tests/schedule-self-review.test.ts (P13c): advanceSelfReview replayed after a crash, stopped by
 * an injected clock or a cap notice, and handed an anchor the parent already marked expanded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetRecord } from "../src/contracts.ts";
import type { IntakeResult } from "../src/intake.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { ScheduleRunner } from "../src/schedule-runner.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { ScheduleRun } from "../src/viewer/schedule-run-core.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

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
