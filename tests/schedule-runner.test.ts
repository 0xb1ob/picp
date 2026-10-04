/**
 * schedlater S1: the schedule runner dispatches and tears down answer/board/local
 * fires in code. Fake dispatch/teardown ports, a real scratch ledger.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimedRun } from "../extensions/command-post/session-post.ts";
import type { FleetRecord } from "../src/contracts.ts";
import type { IntakeResult } from "../src/intake.ts";
import type { Ledger } from "../src/ledger.ts";
import { type RunnerPorts, runnerOwns, ScheduleRunner } from "../src/schedule-runner.ts";
import type { Schedule } from "../src/scheduler.ts";
import { createScratchLedger } from "./harness/index.ts";

function schedule(overrides: Omit<Partial<Schedule>, "job"> & { job?: Partial<Schedule["job"]> } = {}): Schedule {
	const { job, ...rest } = overrides;
	return {
		id: "sch-abc123", name: "digest", project: "demo", mandate_id: "md-abcd",
		trigger: { type: "cron", cron: "0 * * * *", tz: "UTC" },
		job: { title: "digest", kind: "research", delivery: "answer", ...job },
		enabled: true, created_at: "2026-01-01T00:00:00Z", ...rest,
	} as Schedule;
}

/** An accepted, teardown-shaped intake result unless overridden. */
function report(jobId: string, overrides: Partial<IntakeResult> = {}): IntakeResult {
	return { job_id: jobId, accepted: true, already: false, phase: "held", next: "answer", status: "done", summary: "digest ready", ...overrides };
}

function bench(t: { after: (fn: () => void) => void }, schedules: Schedule[]) {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const ledger = scratch.ledger as Ledger;
	const clock = { now: new Date() };
	const calls = { dispatch: [] as { jobId: string; task?: string }[], tearDown: [] as string[], log: [] as string[], wake: [] as IntakeResult[] };
	const fleet: FleetRecord[] = [];
	const recordedOutcomes = new Map<string, IntakeResult | Error>();
	const behaviour = { refuse: undefined as string | undefined, tornDown: true };
	const ports: RunnerPorts = {
		dispatch: async (request) => {
			calls.dispatch.push(request);
			if (behaviour.refuse) throw new Error(behaviour.refuse);
		},
		tearDown: async (jobId) => {
			calls.tearDown.push(jobId);
			return behaviour.tornDown ? { torn_down: true } : { torn_down: false, failure: { message: "unpushed commits" } };
		},
		recorded: async (jobId) => {
			const outcome = recordedOutcomes.get(jobId) ?? report(jobId, { already: true });
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		wake: (result) => calls.wake.push(result),
		ledger: () => ledger, fleetJobs: () => fleet, schedules: () => schedules, now: () => clock.now,
		log: (line) => calls.log.push(line),
	};
	const scheduled = (delivery: "answer" | "local" | "pr" = "answer", id = "sch-abc123") =>
		ledger.create({ title: `run ${Math.random()}`, project: "demo", kind: delivery === "answer" ? "research" : "ship", delivery, labels: [`schedule:${id}`] });
	return { ledger, clock, calls, fleet, behaviour, recordedOutcomes, ports, runner: new ScheduleRunner(ports), scheduled };
}

test("runnerOwns: a schedule: label and an answer/board/local delivery", () => {
	assert.equal(runnerOwns({ labels: ["schedule:sch-abc123", "delivery:answer"] }), true);
	assert.equal(runnerOwns({ labels: ["schedule:sch-abc123", "delivery:local"] }), true);
	assert.equal(runnerOwns({ labels: ["schedule:sch-abc123", "delivery:pr"] }), false);
	assert.equal(runnerOwns({ labels: ["delivery:answer"] }), false);
});

test("a parent-expanded schedule's jobs are the parent's: runnerOwns is false and the runner never dispatches, drops or tears them down", async (t) => {
	const expanded = new Set(["sch-abc123"]);
	assert.equal(runnerOwns({ labels: ["schedule:sch-abc123", "delivery:local"] }, expanded), false);
	assert.equal(runnerOwns({ labels: ["schedule:sch-abc123", "delivery:answer"] }, expanded), false);
	assert.equal(runnerOwns({ labels: ["schedule:sch-def456", "delivery:local"] }, expanded), true, "another schedule is unaffected");
	const manual = schedule({ trigger: { type: "manual" }, job: { kind: "research", delivery: "local", skill: "cp-self-review" } });
	const { ledger, calls, clock, runner, scheduled } = bench(t, [manual]);
	const child = await scheduled("local");
	clock.now = new Date(Date.parse(child.created_at) + 400 * 86_400_000);
	await runner.retryPending();
	await runner.sweepReported();
	assert.deepEqual(calls.dispatch, []);
	assert.equal((await ledger.show(child.id)).status, "open", "not dropped");
	assert.equal(runner.claims(report(child.id)), false);
});

test("an LLM schedule dispatches one worker with its description as the task (title when none)", async (t) => {
	const { calls, runner, scheduled } = bench(t, [schedule({ job: { description: "Summarise yesterday's merges." } }), schedule({ id: "sch-def456" })]);
	const first = await scheduled();
	await runner.onFired({ schedule_id: "sch-abc123", job_id: first.id });
	const second = await scheduled("answer", "sch-def456");
	await runner.onFired({ schedule_id: "sch-def456", job_id: second.id });
	assert.deepEqual(calls.dispatch, [{ jobId: first.id, task: "Summarise yesterday's merges." }, { jobId: second.id, task: "digest" }]);
});

test("a script_path schedule dispatches with no task, so CommandPost.dispatch takes dispatchScript (no model)", async (t) => {
	const { calls, runner, scheduled } = bench(t, [schedule({ job: { kind: "ship", delivery: "local", script_path: "scripts/nightly.sh", description: "ignored" } })]);
	const job = await scheduled("local");
	await runner.onFired({ schedule_id: "sch-abc123", job_id: job.id });
	assert.deepEqual(calls.dispatch, [{ jobId: job.id }]);
	assert.equal("task" in calls.dispatch[0]!, false);
});

test("a refused dispatch is noted once, retried each tick, and dropped with the refusal at the next cron slot", async (t) => {
	const { ledger, clock, calls, behaviour, runner, scheduled } = bench(t, [schedule()]);
	const job = await scheduled();
	clock.now = new Date(job.created_at);
	behaviour.refuse = "job cap 1 reached";
	await runner.onFired({ schedule_id: "sch-abc123", job_id: job.id });
	await runner.retryPending();
	await runner.retryPending();
	assert.equal(calls.dispatch.length, 3, "fire + two retries");
	const notes = (await ledger.show(job.id)).comments.filter((comment) => comment.text.startsWith("dispatch refused"));
	assert.equal(notes.length, 1, "the same refusal is noted once");
	assert.match(notes[0]!.text, /job cap 1 reached/);
	clock.now = new Date(Date.parse(job.created_at) + 2 * 3_600_000);
	await runner.retryPending();
	assert.equal(calls.dispatch.length, 3, "no retry past the next slot");
	const dropped = await ledger.show(job.id);
	assert.equal(dropped.status, "closed");
	assert.match(dropped.close_reason ?? "", /^dropped: not dispatched before the next slot: dispatch refused .*job cap 1 reached/);
});

test("a watch schedule's pending job is dropped once every_seconds has passed; a dispatched one is never retried", async (t) => {
	const { ledger, clock, calls, fleet, behaviour, runner, scheduled } = bench(t, [schedule({ trigger: { type: "watch", script_path: "w.sh", every_seconds: 60, on: "exit0" } })]);
	const job = await scheduled();
	const other = await scheduled();
	fleet.push({ job_id: other.id } as FleetRecord);
	behaviour.refuse = "draining";
	clock.now = new Date(Date.parse(job.created_at) + 30_000);
	await runner.retryPending();
	assert.deepEqual(calls.dispatch.map((call) => call.jobId), [job.id], "a job with a fleet record is not redispatched");
	clock.now = new Date(Date.parse(job.created_at) + 61_000);
	await runner.retryPending();
	assert.equal((await ledger.show(job.id)).status, "closed");
	assert.equal((await ledger.show(other.id)).status, "open");
});

test("a pending job of a disabled or removed schedule is dropped, not dispatched", async (t) => {
	const { ledger, calls, runner, scheduled } = bench(t, [schedule({ enabled: false })]);
	const disabled = await scheduled();
	const gone = await scheduled("answer", "sch-ffffff");
	await runner.retryPending();
	assert.deepEqual(calls.dispatch, []);
	assert.match((await ledger.show(disabled.id)).close_reason ?? "", /schedule sch-abc123 is disabled/);
	assert.match((await ledger.show(gone.id)).close_reason ?? "", /schedule sch-ffffff is gone/);
});

test("claims + onReported: torn down in code with no wake; a refused or thrown teardown sends exactly one envelope wake", async (t) => {
	const { calls, behaviour, runner, ports, scheduled } = bench(t, [schedule()]);
	const job = await scheduled();
	const pr = await scheduled("pr");
	assert.equal(runner.claims(report(job.id)), true);
	assert.equal(runner.claims(report(pr.id, { next: "hold" })), false, "pr runs wake the parent as before");
	assert.equal(runner.claims(report(job.id, { already: true })), false, "an idempotent re-intake is not a new run");
	assert.equal(runner.claims(report(job.id, { next: "escalate" })), false, "an escalate outcome is the parent's");
	assert.equal(runner.claims(report(job.id, { escalation_id: "esc-1" })), false, "a raised escalation is the parent's");
	assert.equal(await runner.onReported(report(job.id)), true);
	assert.equal(calls.wake.length, 0);
	behaviour.tornDown = false;
	assert.equal(await runner.onReported(report(job.id)), false);
	assert.deepEqual(calls.wake.map((r) => r.job_id), [job.id], "the runner itself sends the parent's envelope wake");
	assert.ok(calls.log.some((line) => /teardown of .* refused: unpushed commits; waking the parent/.test(line)));
	const throwing = new ScheduleRunner({ ...ports, tearDown: async () => { throw new Error("gh down"); } });
	assert.equal(await throwing.onReported(report(job.id)), false);
	assert.equal(calls.wake.length, 2);
});

test("claimedRun: a runner whose own wake throws does not reject unhandled; the session sends the fallback envelope wake", async (t) => {
	const { calls, behaviour, ports, scheduled } = bench(t, [schedule()]);
	const job = await scheduled();
	behaviour.tornDown = false;
	const runner = new ScheduleRunner({ ...ports, wake: () => { throw new Error("wake down"); } });
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	claimedRun(runner, report(job.id), (result) => calls.wake.push(result), (line) => calls.log.push(line));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls.wake.map((r) => r.job_id), [job.id], "fallback envelope wake");
	assert.ok(calls.log.some((line) => /onReported for .* rejected: wake down/.test(line)));
	assert.deepEqual(unhandled, []);
});

test("sweepReported after a restart: teardown-shaped runs are torn down, a refused one wakes, an escalated or unreadable one wakes without teardown", async (t) => {
	const { calls, fleet, behaviour, recordedOutcomes, ports, scheduled } = bench(t, [schedule()]);
	const held = await scheduled();
	const escalated = await scheduled();
	const unreadable = await scheduled();
	const working = await scheduled();
	const pr = await scheduled("pr");
	const at = "2026-07-01T00:00:00Z";
	fleet.push(
		{ job_id: held.id, phase: "held", reported_at: at } as FleetRecord,
		{ job_id: escalated.id, phase: "held", reported_at: at } as FleetRecord,
		{ job_id: unreadable.id, phase: "held", reported_at: at } as FleetRecord,
		{ job_id: working.id, phase: "waiting" } as FleetRecord,
		{ job_id: pr.id, phase: "held", reported_at: at } as FleetRecord,
	);
	recordedOutcomes.set(escalated.id, report(escalated.id, { already: true, next: "escalate", escalation_id: "esc-9" }));
	recordedOutcomes.set(unreadable.id, new Error("envelope.json missing"));
	const runner = new ScheduleRunner(ports);
	await runner.sweepReported();
	await runner.sweepReported();
	assert.deepEqual(calls.tearDown, [held.id], "only the teardown-shaped run is torn down, once");
	assert.deepEqual(calls.wake.map((r) => r.job_id), [escalated.id, unreadable.id]);
	assert.equal(calls.wake[0]?.escalation_id, "esc-9", "the parent wakes with the recorded outcome");
	assert.match(calls.wake[1]?.summary ?? "", /could not read .* envelope\.json missing/);

	// A second restart where the teardown is refused: the run is woken, never silent.
	behaviour.tornDown = false;
	const restarted = new ScheduleRunner(ports);
	fleet.splice(0, fleet.length, { job_id: held.id, phase: "held", reported_at: at } as FleetRecord);
	await restarted.sweepReported();
	assert.deepEqual(calls.wake.map((r) => r.job_id), [escalated.id, unreadable.id, held.id]);
});

test("sweepReported skips a run a live onReported already took", async (t) => {
	const { calls, fleet, runner, scheduled } = bench(t, [schedule()]);
	const job = await scheduled();
	fleet.push({ job_id: job.id, phase: "held", reported_at: "2026-07-01T00:00:00Z" } as FleetRecord);
	await runner.onReported(report(job.id));
	await runner.sweepReported();
	assert.deepEqual(calls.tearDown, [job.id]);
});
