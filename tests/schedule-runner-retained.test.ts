/**
 * Retained verbatim from tests/schedule-runner.test.ts (P13c): claimedRun with a runner whose wake port throws, and
 * sweepReported racing a live onReported. No entry point makes pi.sendMessage throw or interleaves the two.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimedRun } from "../extensions/command-post/session-post.ts";
import type { FleetRecord } from "../src/contracts.ts";
import type { IntakeResult } from "../src/intake.ts";
import type { Ledger } from "../src/ledger.ts";
import { type RunnerPorts, ScheduleRunner } from "../src/schedule-runner.ts";
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

test("sweepReported skips a run a live onReported already took", async (t) => {
	const { calls, fleet, runner, scheduled } = bench(t, [schedule()]);
	const job = await scheduled();
	fleet.push({ job_id: job.id, phase: "held", reported_at: "2026-07-01T00:00:00Z" } as FleetRecord);
	await runner.onReported(report(job.id));
	await runner.sweepReported();
	assert.deepEqual(calls.tearDown, [job.id]);
});
