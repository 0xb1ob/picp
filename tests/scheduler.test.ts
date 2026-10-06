/**
 * Lane X, Pier 1.5 — saved schedules (cron with TZ, watch) that fire normal
 * jobs under a named mandate, and catch up once when the parent comes back.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, type FleetRecord, WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { cpNext } from "../src/next.ts";
import { formatScheduleEvent, formatSchedules, latestCronSlot, parseCron, runWatchScript, Scheduler, type SchedulerPorts, type WatchRun } from "../src/scheduler.ts";
import { createScratchHome, createScratchLedger, type ScratchHome } from "./harness/index.ts";

const T0 = new Date("2026-07-01T06:00:00Z");

function bench(home: ScratchHome, overrides: Partial<SchedulerPorts> = {}) {
	const clock = { now: T0 };
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path, { now: () => clock.now });
	const fleet = new FleetStore({ home: home.path });
	const ports: SchedulerPorts = {
		home: home.path, ledger: () => ledger, mandates, usageJobs: () => fleet.read().jobs, cloneOf: () => home.path,
		now: () => clock.now, startedAt: T0, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }), ...overrides,
	};
	const grant = (extra: Partial<Parameters<MandateStore["issue"]>[0]> = {}) =>
		mandates.issue({ projects: ["demo"], objective: "nightly", expiry: "2026-12-31T00:00:00Z", spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 5, at: "2026-06-01T00:00:00Z", schedule_grant: true, ...extra });
	return { clock, ledger, mandates, fleet, ports, grant };
}

const job = { title: "nightly report", kind: "research" as const, delivery: "answer" as const };

test("cron: five fields in a time zone, day-of-month OR day-of-week, bad input refused", () => {
	const nine = parseCron("0 9 * * *");
	// 09:00 Warsaw is 07:00Z in July (CEST), 08:00Z in January (CET).
	assert.equal(latestCronSlot(nine, "Europe/Warsaw", new Date("2026-06-30T12:00:00Z"), new Date("2026-07-01T07:30:00Z"))?.toISOString(), "2026-07-01T07:00:00.000Z");
	assert.equal(latestCronSlot(nine, "Europe/Warsaw", new Date("2026-01-14T12:00:00Z"), new Date("2026-01-15T08:10:00Z"))?.toISOString(), "2026-01-15T08:00:00.000Z");
	assert.equal(latestCronSlot(nine, "UTC", new Date("2026-07-01T09:00:30Z"), new Date("2026-07-01T10:00:00Z")), undefined, "the slot is not after `after`");
	// 1st of the month OR a Monday; 2026-07-06 is a Monday.
	const either = parseCron("30 */6 1 * 1");
	assert.equal(latestCronSlot(either, "UTC", new Date("2026-07-02T00:00:00Z"), new Date("2026-07-06T13:00:00Z"))?.toISOString(), "2026-07-06T12:30:00.000Z");
	assert.equal(latestCronSlot(either, "UTC", new Date("2026-07-02T00:00:00Z"), new Date("2026-07-05T23:59:00Z")), undefined);
	assert.equal(parseCron("0 0 * * 7").dow.has(0), true, "7 is Sunday");
	for (const bad of ["* * * *", "60 * * * *", "0 0 * 13 *", "0 0 * * MON", "5-1 * * * *"]) assert.throws(() => parseCron(bad), new RegExp("cron"));
});

test("a cron fire is an ordinary job under the named mandate, the runner's (not cp_next's) to dispatch; the next tick does not refire", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, fleet, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "0 9 * * *", tz: "Europe/Warsaw", ...job });
	assert.deepEqual(await scheduler.tick(), [], "no slot yet");
	clock.now = new Date("2026-07-01T07:00:20Z");
	const [event] = await scheduler.tick();
	assert.equal(event?.outcome, "fired");
	assert.equal(event?.missed_at, undefined, "a live parent's fire is not a missed one");
	const created = await ledger.show(event?.job_id as string);
	assert.equal(created.title, "nightly report (nightly 2026-07-01T07:00Z)");
	assert.ok(created.labels.includes(`schedule:${schedule.id}`) && created.labels.includes("delivery:answer"));
	assert.match(created.notes ?? "", new RegExp(`under fire grant ${event?.mandate_id}`));
	assert.notEqual(event?.mandate_id, mandate.id, "the fire files under a fresh grant, never its seed");
	clock.now = new Date("2026-07-01T07:00:50Z");
	assert.deepEqual(await scheduler.tick(), []);
	assert.equal((await ledger.list()).length, 1);
	// schedlater S1: an answer fire is the schedule runner's, never a cp_next candidate.
	assert.match(formatScheduleEvent(event!), /dispatched by the schedule runner/);
	const next = await cpNext({ ledger, fleet, mandates, escalations: new EscalationStore({ home: home.path }), now: () => clock.now }, "demo");
	assert.deepEqual([next.action.kind, next.ready.map((entry) => entry.id)], ["wait", []]);
});

test("schedlater S1: a pr schedule's fire still wakes the parent and is cp_next's to dispatch", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, fleet, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	await scheduler.add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "0 7 * * *", tz: "UTC", title: "nightly fix", kind: "ship", delivery: "pr" });
	clock.now = new Date("2026-07-01T07:00:20Z");
	const [event] = await scheduler.tick();
	assert.equal(event?.delivery, "pr");
	assert.match(formatScheduleEvent(event!), /Call cp_next/);
	const next = await cpNext({ ledger, fleet, mandates, escalations: new EscalationStore({ home: home.path }), now: () => clock.now }, "demo");
	assert.deepEqual([next.action.kind, next.action.job_id], ["dispatch", event?.job_id]);
});

test("a fire at a millisecond instant survives another grant expiring in the same sweep (2026-10-06T00:05Z)", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, mandates, ports, grant } = bench(home);
	const mandate = grant();
	const other = mandates.issue({ projects: ["demo"], objective: "other", expiry: "2026-07-01T06:30:00Z", spend_cap: { usd: 1, tokens: 1000 }, job_cap: 1, at: "2026-06-01T00:00:00Z" });
	const scheduler = new Scheduler(ports);
	await scheduler.add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "0 7 * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-01T07:00:20.123Z");
	const [event] = await scheduler.tick();
	assert.equal(event?.outcome, "fired", event?.reason);
	const expired = mandates.get(other.id);
	assert.equal(expired?.status, "expired");
	assert.equal(expired?.escalations[0]?.at, "2026-07-01T07:00:20Z");
});

test("run now at a millisecond instant fires while an unrelated grant is expired", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, mandates, ports, grant } = bench(home);
	const mandate = grant();
	mandates.issue({ projects: ["demo"], objective: "other", expiry: "2026-07-01T06:30:00Z", spend_cap: { usd: 1, tokens: 1000 }, job_cap: 1, at: "2026-06-01T00:00:00Z" });
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "on demand", project: "demo", mandate_id: mandate.id, manual: true, ...job });
	clock.now = new Date("2026-07-01T07:00:20.456Z");
	const event = await scheduler.fireNow(schedule.id, "sc-1");
	assert.equal(event.outcome, "fired", event.reason);
});

test("parent start catches up a missed cron slot once, stamped missed <time>", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, grant } = bench(home);
	const mandate = grant();
	clock.now = new Date("2026-06-27T00:00:00Z");
	await new Scheduler(ports).add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "0 9 * * *", tz: "UTC", ...job });
	// The parent was down for four 09:00 slots; it comes up at T0.
	clock.now = T0;
	const restarted = new Scheduler(ports);
	const events = await restarted.tick();
	assert.equal(events.length, 1, "one catch-up, never a backlog");
	assert.equal(events[0]?.missed_at, "2026-06-30T09:00Z");
	const [only] = await ledger.list();
	assert.match(only?.notes ?? "", /missed 2026-06-30T09:00Z/);
	assert.deepEqual(await restarted.tick(), []);
});

test("cron exactly once: a clock set back after a fire never fires the slot again, and last_checked_at never rewinds", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	await scheduler.add({ name: "hourly", project: "demo", mandate_id: mandate.id, cron: "0 * * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-01T07:00:30Z");
	const [fired] = await scheduler.tick();
	assert.equal(fired?.outcome, "fired");
	await ledger.close(fired?.job_id as string, "landed");
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
	const { clock, ledger, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	await scheduler.add({ name: "hourly", project: "demo", mandate_id: mandate.id, cron: "0 * * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-02T07:00:30Z"); // a day ahead by mistake
	const [early] = await scheduler.tick();
	assert.equal(early?.outcome, "fired");
	await ledger.close(early?.job_id as string, "landed");
	clock.now = new Date("2026-07-01T08:00:10Z"); // corrected
	const [reset] = await scheduler.tick();
	assert.equal(reset?.outcome, "skipped");
	assert.match(reset?.reason ?? "", /ahead of the clock/);
	assert.equal(scheduler.list()[0]?.last_checked_at, "2026-07-01T08:00:10.000Z");
	clock.now = new Date("2026-07-01T09:00:10Z");
	const [next] = await scheduler.tick();
	assert.equal(next?.outcome, "fired", "the next slot fires, not a day later");
	await ledger.close(next?.job_id as string, "landed");
	assert.equal(scheduler.list()[0]?.last_fire?.slot, "2026-07-01T09:00:00.000Z");
});

test("cron: after a corrected forward jump, the slot fired early is not fired again when real time reaches it", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	await scheduler.add({ name: "daily", project: "demo", mandate_id: mandate.id, cron: "0 7 * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-02T07:00:30Z"); // a day ahead by mistake
	const [early] = await scheduler.tick();
	await ledger.close(early?.job_id as string, "landed");
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
	const { clock, ledger, ports, grant } = bench(home);
	const mandate = grant();
	clock.now = new Date("2026-10-24T12:00:00Z");
	const scheduler = new Scheduler({ ...ports, startedAt: clock.now });
	await scheduler.add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "30 2 * * *", tz: "Europe/Warsaw", ...job });
	clock.now = new Date("2026-10-25T00:30:20Z"); // 02:30 CEST
	const [fired] = await scheduler.tick();
	assert.equal(fired?.outcome, "fired");
	await ledger.close(fired?.job_id as string, "landed");
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
	const { clock, ledger, ports, grant } = bench(home);
	const mandate = grant();
	clock.now = new Date("2026-10-24T23:30:00Z");
	const scheduler = new Scheduler({ ...ports, startedAt: clock.now });
	await scheduler.add({ name: "hourly", project: "demo", mandate_id: mandate.id, cron: "0 * * * *", tz: "Europe/Warsaw", ...job });
	const outcomes: string[] = [];
	// 00:00Z = 02:00 CEST, 01:00Z = 02:00 CET (the repeated local minute), 02:00Z = 03:00 CET.
	for (const at of ["2026-10-25T00:00:20Z", "2026-10-25T01:00:20Z", "2026-10-25T02:00:20Z"]) {
		clock.now = new Date(at);
		const [event] = await scheduler.tick();
		outcomes.push(event?.outcome ?? "none");
		if (event?.job_id) await ledger.close(event.job_id, "landed");
	}
	assert.deepEqual(outcomes, ["fired", "fired", "fired"]);
	assert.equal((await ledger.list({ all: true })).length, 3, "one job per real hour");
});

test("a fire is never a bypass: no active grant, a job-scoped grant, an open previous fire and the job cap all hold", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, fleet, ports, grant } = bench(home);
	const scoped = grant({ job_ids: ["cp-aaa"] });
	const scheduler = new Scheduler(ports);
	// ship/pr: cp_next is the dispatcher here, so its job cap is observable (runner jobs meet the same cap in dispatch).
	const base = { name: "hourly", project: "demo", cron: "0 * * * *", tz: "UTC", ...job, kind: "ship" as const, delivery: "pr" as const };
	await assert.rejects(scheduler.add({ ...base, mandate_id: scoped.id }), /names job_ids; a schedule grant never does/);
	mandates.revoke(scoped.id); // same issued_at as the next grant: keep cp_next's pick deterministic
	await assert.rejects(scheduler.add({ ...base, mandate_id: "md-ffffff" }), /no mandate md-ffffff/);
	// schedlater S3: a project-wide grant never carries a schedule.
	const wide = grant({ schedule_grant: undefined });
	await assert.rejects(scheduler.add({ ...base, mandate_id: wide.id }), /not a schedule grant.*schedule_grant:true/);
	mandates.revoke(wide.id);
	const mandate = grant({ job_cap: 1 });
	const schedule = await scheduler.add({ ...base, mandate_id: mandate.id });
	// One grant per schedule.
	await assert.rejects(scheduler.add({ ...base, name: "second", mandate_id: mandate.id }), new RegExp(`already the grant of schedule ${schedule.id} \\(hourly\\); one grant per schedule`));

	mandates.pause(mandate.id);
	clock.now = new Date("2026-07-01T07:00:05Z");
	const [skipped] = await scheduler.tick();
	assert.equal(skipped?.outcome, "skipped");
	assert.match(skipped?.reason ?? "", /is paused/);
	assert.equal((await ledger.list()).length, 0);

	mandates.resume(mandate.id);
	clock.now = new Date("2026-07-01T08:00:05Z");
	const [fired] = await scheduler.tick();
	assert.equal(fired?.outcome, "fired");
	clock.now = new Date("2026-07-01T09:00:05Z");
	const [overlap] = await scheduler.tick();
	assert.match(overlap?.reason ?? "", new RegExp(`previous fire ${fired?.job_id} is still open`));

	// schedlater S3: an unrelated ready job is never recommended under the schedule's grant.
	const unrelated = await ledger.create({ title: "unrelated", project: "demo", kind: "ship", delivery: "pr" });
	const scopedNext = await cpNext({ ledger, fleet, mandates, escalations: new EscalationStore({ home: home.path }), now: () => clock.now }, "demo");
	assert.equal(scopedNext.mandate?.id, fired?.mandate_id, "the fire's own fresh grant");
	assert.deepEqual(scopedNext.ready.map((entry) => entry.id), [fired?.job_id], `${unrelated.id} is not the schedule's`);
	assert.equal(scopedNext.action.job_id, fired?.job_id);

	// Job cap: another run of this schedule already holds the one slot, so cp_next will not dispatch the fired job.
	await fleet.add({
		job_id: "cp-other", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "held", reported_at: "2026-07-01T01:00:00Z", worktree: "/wt", branch: "cp-other",
		dispatched_at: "2026-07-01T00:00:00Z", usage: EMPTY_USAGE, schedule_id: schedule.id,
		worker: { pid: 1, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m/x", started_at: "2026-07-01T00:00:00Z" },
	} as FleetRecord);
	const next = await cpNext({ ledger, fleet, mandates, escalations: new EscalationStore({ home: home.path }), now: () => clock.now }, "demo");
	assert.equal(next.action.kind, "wait");
	assert.match(next.action.reason, /job cap 1 reached/);
});

test("a schedule saved with no grant template (pre-migration, or skipped by it) skips every fire and is never fired under its pointer", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, ports, grant } = bench(home);
	const wide = grant({ schedule_grant: undefined });
	const scheduler = new Scheduler(ports);
	const saved = { id: "sch-abc123", name: "legacy", project: "demo", mandate_id: wide.id, trigger: { type: "cron", cron: "0 * * * *", tz: "UTC" }, job, enabled: true, created_at: T0.toISOString() };
	writeFileSync(scheduler.file, JSON.stringify({ schema_version: 1, schedules: [saved] }));
	clock.now = new Date("2026-07-01T07:00:05Z");
	const [skipped] = await scheduler.tick();
	assert.equal(skipped?.outcome, "skipped");
	assert.match(skipped?.reason ?? "", /schedule sch-abc123 has no grant template .*cp_schedule move it to a fresh schedule grant/);
	clock.now = new Date("2026-07-01T08:00:05Z");
	assert.deepEqual(await scheduler.tick(), [], "the same skip is news once");
	assert.match(scheduler.list()[0]?.last_skip?.reason ?? "", /has no grant template/, "recorded on the schedule every time");
	assert.equal(scheduler.list()[0]?.last_skip?.at, "2026-07-01T08:00:05.000Z");
	assert.equal((await ledger.list({ all: true })).length, 0, "no job is ever recorded under it");
	assert.equal(mandates.list().length, 1, "and no grant minted");
});

test("watch: exit 0 fires, changed output fires only on a change, and a missed interval is caught up once", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	let run: WatchRun = { code: 1, stdout: "" };
	const { clock, ledger, ports, grant } = bench(home, { runWatch: async () => run });
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	const zero = await scheduler.add({ name: "ready", project: "demo", mandate_id: mandate.id, watch_script: "scripts/ready.sh", every_seconds: 60, on: "exit0", ...job, title: "ready" });
	await scheduler.add({ name: "diff", project: "demo", mandate_id: grant().id, watch_script: "scripts/diff.sh", every_seconds: 60, on: "changed", ...job, title: "diff" });
	const first = await scheduler.tick();
	assert.deepEqual(first.map((event) => event.outcome), ["skipped"], "exit 1: exit0 waits quietly; changed names the failure");
	run = { code: 0, stdout: "v1" };
	clock.now = new Date(T0.getTime() + 30_000);
	assert.deepEqual(await scheduler.tick(), [], "not due yet");
	clock.now = new Date(T0.getTime() + 61_000);
	const second = await scheduler.tick();
	assert.deepEqual(second.map((event) => [event.name, event.outcome]), [["ready", "fired"]], "the first output is the baseline");
	await ledger.close(second[0]?.job_id as string, "landed");
	run = { code: 0, stdout: "v2" };
	clock.now = new Date(T0.getTime() + 122_000);
	const third = await scheduler.tick();
	assert.deepEqual(third.map((event) => [event.name, event.outcome]), [["ready", "fired"], ["diff", "fired"]]);
	for (const event of third) await ledger.close(event.job_id as string, "landed");

	// Down for ten minutes: the restarted parent runs each watch once and stamps the fire missed.
	clock.now = new Date(T0.getTime() + 722_000);
	const restarted = new Scheduler({ ...ports, startedAt: clock.now });
	const caught = await restarted.tick();
	assert.deepEqual(caught.map((event) => event.name), ["ready"], "exit0 fires; unchanged output does not");
	assert.equal(caught[0]?.missed_at, "2026-07-01T06:03Z");
	assert.equal(caught[0]?.schedule_id, zero.id);
	assert.deepEqual(await restarted.tick(), []);
});

test("cp-hhuf P6: enable is refused unless the schedule's grant passes the fire check; disable never is", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { mandates, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "0 9 * * *", tz: "UTC", ...job });
	mandates.pause(mandate.id);
	assert.equal((await scheduler.setEnabled(schedule.id, false)).enabled, false, "disable is never grant-gated");
	await assert.rejects(scheduler.setEnabled(schedule.id, true), new RegExp(`enable ${schedule.id} refused: ${mandate.id} is paused`));
	assert.equal(scheduler.list()[0]?.enabled, false, "stays disabled");
	mandates.resume(mandate.id);
	assert.equal((await scheduler.setEnabled(schedule.id, true)).enabled, true);
	await scheduler.setEnabled(schedule.id, false);
	mandates.revoke(mandate.id, { operator_quote: "revoke the nightly grant", decided_by: "operator-quote" });
	await assert.rejects(scheduler.setEnabled(schedule.id, true), /was revoked by the operator \(operator-quote\); a schedule never re-mints past an operator revoke/);
	assert.equal(scheduler.list()[0]?.enabled, false);
	await assert.rejects(scheduler.setEnabled("sch-ffffff", true), /no schedule sch-ffffff/);
});

test("cp-hhuf P6 addendum 1: a daily cron disabled for three days, then enabled, files no job until its next slot", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "daily", project: "demo", mandate_id: mandate.id, cron: "0 9 * * *", tz: "UTC", ...job });
	assert.deepEqual(await scheduler.tick(), []);
	await scheduler.setEnabled(schedule.id, false);
	clock.now = new Date("2026-07-04T10:00:00Z"); // the 07-01 .. 07-04 09:00 slots passed while disabled
	await scheduler.setEnabled(schedule.id, true);
	assert.equal(scheduler.list()[0]?.last_checked_at, "2026-07-04T10:00:00.000Z", "evaluation restarts at the enable time");
	assert.deepEqual(await scheduler.tick(), [], "no slot that passed while disabled fires");
	clock.now = new Date("2026-07-05T08:59:00Z");
	assert.deepEqual(await scheduler.tick(), []);
	assert.equal((await ledger.list({ all: true })).length, 0);
	clock.now = new Date("2026-07-05T09:00:20Z");
	const [event] = await scheduler.tick();
	assert.equal(event?.outcome, "fired");
	assert.equal(event?.missed_at, undefined);
	assert.equal((await ledger.show(event?.job_id as string)).title, "nightly report (daily 2026-07-05T09:00Z)");
});

test("cp-hhuf P6: run now is a manual fire under the slot's checks and never touches last_fire/last_skip", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "0 9 * * *", tz: "UTC", ...job });
	await assert.rejects(scheduler.fireNow("sch-ffffff", "sc-x"), /no schedule sch-ffffff/);
	mandates.pause(mandate.id);
	clock.now = new Date("2026-07-01T07:03:10Z");
	const paused = await scheduler.fireNow(schedule.id, "sc-20260701070310-0000abcd");
	assert.equal(paused.outcome, "skipped");
	assert.match(paused.reason, new RegExp(`^run now not recorded: ${mandate.id} is paused`));
	assert.equal((await ledger.list({ all: true })).length, 0);
	assert.equal(scheduler.list()[0]?.last_skip, undefined, "a manual refusal is never recorded on the schedule");
	mandates.resume(mandate.id);
	const fired = await scheduler.fireNow(schedule.id, "sc-20260701070310-0000abcd");
	assert.equal(fired.outcome, "fired");
	assert.equal(fired.manual, "sc-20260701070310-0000abcd");
	assert.equal(fired.delivery, "answer");
	const created = await ledger.show(fired.job_id as string);
	assert.equal(created.title, "nightly report (nightly run now 2026-07-01T07:03Z)");
	assert.ok(created.labels.includes(`schedule:${schedule.id}`));
	assert.match(created.notes ?? "", /run now from the dashboard \(sc-20260701070310-0000abcd\)/);
	assert.equal(scheduler.list()[0]?.last_fire, undefined);
	assert.equal(scheduler.list()[0]?.last_skip, undefined);
	assert.match(formatScheduleEvent(fired), /run now from the dashboard \(sc-20260701070310-0000abcd\)/);
	const open = await scheduler.fireNow(schedule.id, "sc-2");
	assert.match(open.reason, new RegExp(`run now not recorded: the previous fire ${fired.job_id} is still open`));
	await ledger.close(fired.job_id as string, "landed");
	await scheduler.setEnabled(schedule.id, false);
	await assert.rejects(scheduler.fireNow(schedule.id, "sc-3"), new RegExp(`schedule ${schedule.id} is disabled; enable it first`));
});

test("S2: a cp_schedule run now whose quote comment fails still fires, names the warning, and its notes keep the quote single-use", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ledger, ports, grant } = bench(home);
	const failing = new Proxy(ledger, {
		get: (target, key) => {
			if (key === "comment") return async () => { throw new Error("ENOSPC"); };
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const scheduler = new Scheduler({ ...ports, ledger: () => failing });
	const schedule = await scheduler.add({ name: "on demand", project: "demo", mandate_id: grant().id, manual: true, ...job });
	const trigger = { via: "cp_schedule" as const, tool_call_id: "call-1", operator_quote: "Run on demand now.", decided_by: "operator-quote", source_sha: "0123456789ab" };
	const fired = await scheduler.fireNow(schedule.id, trigger);
	assert.equal(fired.outcome, "fired");
	assert.equal(fired.manual_via, "cp_schedule");
	assert.match(fired.reason, /warning: the verbatim quote comment was not written \(ENOSPC\); the job notes carry run-now quote sha 0123456789ab/);
	assert.deepEqual((await ledger.show(fired.job_id as string)).comments, []);
	await ledger.close(fired.job_id as string, "done");
	assert.match((await scheduler.fireNow(schedule.id, { ...trigger, tool_call_id: "call-2" })).reason, new RegExp(`already authorized run now ${fired.job_id}`));
});

test("cp-hhuf P6: a tick fire and a run now started together create exactly one job", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "hourly", project: "demo", mandate_id: mandate.id, cron: "0 * * * *", tz: "UTC", ...job });
	clock.now = new Date("2026-07-01T07:00:05Z");
	const [ticked, manual] = await Promise.all([scheduler.tick(), scheduler.fireNow(schedule.id, "sc-1")]);
	const outcomes = [...ticked.map((event) => event.outcome), manual.outcome].sort();
	assert.deepEqual(outcomes, ["fired", "skipped"]);
	assert.equal((await ledger.list({ all: true })).length, 1);
});

test("an archived project: cp_schedule add is refused, and a schedule saved before the archive never fires", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const archived: string[] = [];
	const { clock, ledger, ports, grant } = bench(home, { archivedProjects: () => archived });
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "hourly", project: "demo", mandate_id: mandate.id, cron: "0 * * * *", tz: "UTC", ...job });
	archived.push("demo");
	await assert.rejects(
		scheduler.add({ name: "other", project: "demo", mandate_id: grant().id, cron: "0 * * * *", tz: "UTC", ...job }),
		/cp_schedule add refused: archived project demo — unarchive with cp_project unarchive first/,
	);
	assert.equal(scheduler.list().length, 1, "the refused add wrote nothing");
	clock.now = new Date("2026-07-01T07:00:05Z");
	const [event] = await scheduler.tick();
	assert.equal(event?.outcome, "skipped");
	assert.match(event?.reason ?? "", /archived project demo/);
	assert.match((await scheduler.fireNow(schedule.id, "sc-1")).reason, /run now not recorded: archived project demo/);
	assert.equal((await ledger.list({ all: true })).length, 0, "no job was recorded");
});


const skillJob = { title: "Self-review", kind: "research" as const, delivery: "local" as const, skill: "cp-self-review" };

test("a manual skill schedule is never ticked: no fire, no write, no job at any clock", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, ports, grant } = bench(home);
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "self-review", project: "demo", mandate_id: grant().id, manual: true, ...skillJob });
	assert.deepEqual([schedule.trigger, schedule.job.skill], [{ type: "manual" }, "cp-self-review"]);
	for (const at of [T0.getTime(), T0.getTime() + 400 * 86_400_000]) {
		clock.now = new Date(at);
		assert.deepEqual(await scheduler.tick(), []);
	}
	const saved = scheduler.list()[0]!;
	assert.deepEqual([saved.last_checked_at, saved.last_fire, saved.last_skip], [undefined, undefined, undefined]);
	assert.equal((await ledger.list({ all: true })).length, 0);
	assert.match(formatSchedules([saved]), /manual \(fires only on Run now\) → expanded by skill cp-self-review/);
});

test("manual/skill add refusals each throw and write nothing", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ports, grant } = bench(home);
	const scheduler = new Scheduler(ports);
	const id = grant().id;
	const base = { name: "self-review", project: "demo", mandate_id: id };
	const refusals: [Partial<Parameters<Scheduler["add"]>[0]>, RegExp][] = [
		[{ manual: true, cron: "0 9 * * *", tz: "UTC", ...skillJob }, /exactly one of cron/],
		[{ ...skillJob, skill: undefined, kind: "research", delivery: "local" }, /exactly one of cron/],
		[{ manual: true, ...skillJob, delivery: "answer" }, /skill needs a manual schedule/],
		[{ manual: true, ...skillJob, kind: "ship" }, /skill needs a manual schedule/],
		[{ manual: true, ...skillJob, script_path: "x.sh" }, /skill needs a manual schedule/],
		[{ manual: true, ...skillJob, skill: "cp-other" }, /unknown skill "cp-other"; known: cp-self-review, cp-pr-review/],
	];
	for (const [input, message] of refusals) await assert.rejects(scheduler.add({ ...base, ...skillJob, ...input } as Parameters<Scheduler["add"]>[0]), message);
	// skill on a cron schedule: the cron branch has manual unset.
	await assert.rejects(scheduler.add({ ...base, cron: "0 9 * * *", tz: "UTC", ...skillJob }), /skill needs a manual schedule/);
	await assert.rejects(scheduler.add({ ...base, manual: true, ...skillJob, mandate_id: grant({ schedule_grant: undefined }).id }), /not a schedule grant/);
	assert.equal(scheduler.list().length, 0);
});

test("run now on a manual skill schedule: grant-checked, one deferred anchor, single flight", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ledger, mandates, ports, grant } = bench(home);
	const mandate = grant();
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "self-review", project: "demo", mandate_id: mandate.id, manual: true, ...skillJob });
	mandates.pause(mandate.id);
	const paused = await scheduler.fireNow(schedule.id, "sc-1");
	assert.equal(paused.outcome, "skipped");
	assert.match(paused.reason, new RegExp(`^run now not recorded: ${mandate.id} is paused`));
	assert.equal((await ledger.list({ all: true })).length, 0);
	mandates.resume(mandate.id);
	const fired = await scheduler.fireNow(schedule.id, "sc-2");
	assert.equal(fired.outcome, "fired");
	assert.equal(fired.skill, "cp-self-review");
	const anchor = await ledger.show(fired.job_id as string);
	assert.equal(anchor.status, "deferred");
	assert.ok(anchor.labels.includes(`schedule:${schedule.id}`));
	assert.match(formatScheduleEvent(fired), /parent-expanded run.*skill cp-self-review/);
	assert.match((await scheduler.fireNow(schedule.id, "sc-3")).reason, new RegExp(`the previous fire ${anchor.id} is still open`));
	assert.equal((await ledger.list({ all: true })).length, 1);
});

test("cp-pr-review add: 1-20 exact pr: urls in the project's own repo, and a fire grant template that holds every reviewer plus the synthesis and the anchor", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ports, grant } = bench(home, { repoOf: (project) => (project === "demo" ? "Acme/Demo" : undefined) });
	const scheduler = new Scheduler(ports);
	const pr = (n: number) => `pr: https://github.com/acme/demo/pull/${n}`;
	const review = { project: "demo", manual: true as const, title: "PR review", kind: "research" as const, delivery: "local" as const, skill: "cp-pr-review" };
	const description = `Review the open queue.\n${pr(7)}\n  ${pr(9)}  \n`;
	const added = await scheduler.add({ ...review, name: "prs", mandate_id: grant().id, description });
	assert.deepEqual([added.job.skill, added.job.description], ["cp-pr-review", description]);
	const refusals: [string, RegExp][] = [
		[`${pr(7)}\npr: https://github.com/other/demo/pull/8`, /not in the project's repo Acme\/Demo/],
		[Array.from({ length: 21 }, (_, i) => pr(i + 1)).join("\n"), /needs 1-20 description lines .*found 21/],
		["no targets here", /needs 1-20 description lines .*found 0/],
		["pr: https://github.com/acme/demo/issues/3", /is not a PR url/],
		["pr: https://github.com/acme/demo/pull/3/files", /is not a PR url/],
		[`${pr(3)}\n${pr(3)}`, /listed twice/],
	];
	for (const [text, message] of refusals) await assert.rejects(scheduler.add({ ...review, name: "bad", mandate_id: grant().id, description: text }), message);
	await assert.rejects(new Scheduler({ ...ports, repoOf: undefined }).add({ ...review, name: "bad", mandate_id: grant().id, description: pr(1) }), /needs the project's GitHub repo/);
	// A3: the template's job cap is raised to N reviewers + 1 synthesis + the anchor (job_cap 2 → 4 for 2 PRs), never refused.
	const tight = await scheduler.add({ ...review, name: "tight", mandate_id: grant({ job_cap: 2 }).id, description: `${pr(1)}\n${pr(2)}` });
	assert.equal(tight.grant_template?.job_cap, 4);
	assert.match(tight.notes!.join("; "), /job cap raised from 2 to 4: one cp-pr-review fire records 3 jobs plus its deferred anchor/);
	const fits = await scheduler.add({ ...review, name: "fits", mandate_id: grant({ job_cap: 9 }).id, description: `${pr(1)}\n${pr(2)}` });
	assert.equal(fits.grant_template?.job_cap, 9);
	assert.deepEqual(scheduler.list().map((entry) => entry.name), ["prs", "tight", "fits"]);
});

test("cp_schedule is parent-only", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_schedule"));
});

test("runWatchScript runs only a tracked script, with the script runner's bare environment", async (t) => {
	const repo = mkdtempSync(join(tmpdir(), "cp-watch-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", repo]);
	writeFileSync(join(repo, "watch.sh"), 'printf "%s" "$HOME"\n');
	writeFileSync(join(repo, "untracked.sh"), "exit 0\n");
	execFileSync("git", ["-C", repo, "add", "watch.sh"]);
	const result = await runWatchScript(repo, "watch.sh", 4_000);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, repo);
	await assert.rejects(runWatchScript(repo, "untracked.sh", 4_000), /not tracked/);
});
