/**
 * Retained verbatim from tests/scheduler.test.ts (P13c): Scheduler.tick and fireNow under an injected clock that is
 * set back, jumped forward, crosses a DST fall-back, or races a run now. A parent reads only the system clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { Scheduler, type ScheduleEvent, type SchedulerPorts } from "../src/scheduler.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { createScratchHome, createScratchLedger, type ScratchHome } from "./harness/index.ts";

const T0 = new Date("2026-07-01T06:00:00Z");
const ACTION = { saved_by: "operator-quote" as const, provenance: { channel: "cp_schedule" as const, tool_call_id: "call-add", quote_sha: "abcdef123456" } };
const NATIVE = { action: ACTION, limits: {} };

function bench(home: ScratchHome, overrides: Partial<SchedulerPorts> = {}) {
	const clock = { now: T0 };
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const runs = openScheduleRunStore(home.path);
	const mandates = new MandateStore(home.path, { runs, now: () => clock.now });
	const fleet = new FleetStore({ home: home.path });
	const ports: SchedulerPorts = {
		home: home.path, ledger: () => ledger, mandates, runs, usageJobs: () => fleet.read().jobs, cloneOf: () => home.path,
		now: () => clock.now, startedAt: T0, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }), ...overrides,
	};
	/** Closes a fire's anchor and its run, as the schedule runner would once the run settles. */
	const settle = async (event: ScheduleEvent | undefined) => {
		await ledger.close(event?.job_id as string, "landed");
		await runs.closeRun(event?.run_id as string, "completed", clock.now.toISOString().replace(/\.\d{3}Z$/, "Z"));
	};
	return { clock, ledger, runs, mandates, fleet, ports, settle };
}

const job = { title: "nightly report", kind: "research" as const, delivery: "answer" as const };

test("cron exactly once: a clock set back after a fire never fires the slot again, and last_checked_at never rewinds", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, settle } = bench(home);
	const scheduler = new Scheduler(ports);
	await scheduler.add({ name: "hourly", project: "demo", native: NATIVE, cron: "0 * * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-01T07:00:30Z");
	const [fired] = await scheduler.tick();
	assert.equal(fired?.outcome, "fired");
	await settle(fired);
	clock.now = new Date("2026-07-01T06:00:10Z"); // set back an hour
	assert.deepEqual(await scheduler.tick(), []);
	assert.equal(scheduler.list()[0]?.last_checked_at, "2026-07-01T07:00:30.000Z", "monotonic");
	clock.now = new Date("2026-07-01T07:00:40Z"); // the 07:00 slot comes round again
	assert.deepEqual(await scheduler.tick(), []);
	assert.equal((await ledger.list({ all: true })).length, 1, "one job for the 07:00 slot");
});

test("cron: a corrected forward clock jump restarts slot evaluation from now instead of silencing the schedule until the future checkpoint", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ports, settle } = bench(home);
	const scheduler = new Scheduler(ports);
	await scheduler.add({ name: "hourly", project: "demo", native: NATIVE, cron: "0 * * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-02T07:00:30Z"); // a day ahead by mistake
	const [early] = await scheduler.tick();
	assert.equal(early?.outcome, "fired");
	await settle(early);
	clock.now = new Date("2026-07-01T08:00:10Z"); // corrected
	const [reset] = await scheduler.tick();
	assert.equal(reset?.outcome, "skipped");
	assert.match(reset?.reason ?? "", /ahead of the clock/);
	assert.equal(scheduler.list()[0]?.last_checked_at, "2026-07-01T08:00:10.000Z");
	clock.now = new Date("2026-07-01T09:00:10Z");
	const [next] = await scheduler.tick();
	assert.equal(next?.outcome, "fired", "the next slot fires, not a day later");
	await settle(next);
	assert.equal(scheduler.list()[0]?.last_fire?.slot, "2026-07-01T09:00:00.000Z");
});

test("cron: after a corrected forward jump, the slot fired early is not fired again when real time reaches it", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, settle } = bench(home);
	const scheduler = new Scheduler(ports);
	await scheduler.add({ name: "daily", project: "demo", native: NATIVE, cron: "0 7 * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-02T07:00:30Z"); // a day ahead by mistake
	const [early] = await scheduler.tick();
	await settle(early);
	clock.now = new Date("2026-07-01T08:00:10Z"); // corrected: restart from now
	assert.match((await scheduler.tick())[0]?.reason ?? "", /ahead of the clock/);
	clock.now = new Date("2026-07-02T07:00:20Z");
	const [repeat] = await scheduler.tick();
	assert.equal(repeat?.outcome, "skipped");
	assert.match(repeat?.reason ?? "", /repeats the local minute of 2026-07-02T07:00Z/);
	assert.equal((await ledger.list({ all: true })).length, 1);
});

test("cron exactly once: a DST fall-back repeated hour fires its slot once (Europe/Warsaw 2026-10-25 02:30)", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, settle } = bench(home);
	clock.now = new Date("2026-10-24T12:00:00Z");
	const scheduler = new Scheduler({ ...ports, startedAt: clock.now });
	await scheduler.add({ name: "nightly", project: "demo", native: NATIVE, cron: "30 2 * * *", tz: "Europe/Warsaw", ...job });
	clock.now = new Date("2026-10-25T00:30:20Z"); // 02:30 CEST
	const [fired] = await scheduler.tick();
	assert.equal(fired?.outcome, "fired");
	await settle(fired);
	clock.now = new Date("2026-10-25T01:30:20Z"); // 02:30 CET, the same wall-clock minute
	const [repeat] = await scheduler.tick();
	assert.equal(repeat?.outcome, "skipped");
	assert.match(repeat?.reason ?? "", /repeats the local minute/);
	clock.now = new Date("2026-10-25T01:31:00Z");
	assert.deepEqual(await scheduler.tick(), [], "the skip is not re-evaluated");
	clock.now = new Date("2026-10-26T01:30:20Z"); // the next night fires as usual
	assert.equal((await scheduler.tick())[0]?.outcome, "fired");
	assert.equal((await ledger.list({ all: true })).length, 2);
});

test("cron: a wildcard-hour cron fires in both real hours of a DST fall-back repeated local hour", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, settle } = bench(home);
	clock.now = new Date("2026-10-24T23:30:00Z");
	const scheduler = new Scheduler({ ...ports, startedAt: clock.now });
	await scheduler.add({ name: "hourly", project: "demo", native: NATIVE, cron: "0 * * * *", tz: "Europe/Warsaw", ...job });
	const outcomes: string[] = [];
	// 00:00Z = 02:00 CEST, 01:00Z = 02:00 CET (the repeated local minute), 02:00Z = 03:00 CET.
	for (const at of ["2026-10-25T00:00:20Z", "2026-10-25T01:00:20Z", "2026-10-25T02:00:20Z"]) {
		clock.now = new Date(at);
		const [event] = await scheduler.tick();
		outcomes.push(event?.outcome ?? "none");
		if (event?.job_id) await settle(event);
	}
	assert.deepEqual(outcomes, ["fired", "fired", "fired"]);
	assert.equal((await ledger.list({ all: true })).length, 3, "one job per real hour");
});

test("cp-hhuf P6: a tick fire and a run now started together create exactly one job", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports } = bench(home);
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "hourly", project: "demo", native: NATIVE, cron: "0 * * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-01T07:00:05Z");
	const [ticked, manual] = await Promise.all([scheduler.tick(), scheduler.fireNow(schedule.id, "sc-1")]);
	const outcomes = [...ticked.map((event) => event.outcome), manual.outcome].sort();
	assert.deepEqual(outcomes, ["fired", "skipped"]);
	assert.equal((await ledger.list({ all: true })).length, 1);
});
