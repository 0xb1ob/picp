/**
 * cp-hhuf P6, the parent's half: the Schedules page's journaled requests (`state/schedule-control.jsonl`) are
 * claimed before they act, applied through the one Scheduler (grant checks included), and answered with one outcome.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { ScheduleControl } from "../src/schedule-control.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { IncomingMessage } from "node:http";
import type { ScheduleControlStatusResponse } from "../src/viewer/api-types.ts";
import { handleScheduleControlStatus } from "../src/viewer/control-api.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { controlConfigFile, readScheduleControl, scheduleControlFile, type ScheduleControlLine } from "../src/viewer/control-files.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const T0 = new Date("2026-07-01T07:03:00Z");

function bench(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const clock = { now: T0 };
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path, { now: () => clock.now });
	const fleet = new FleetStore({ home: home.path });
	const scheduler = new Scheduler({
		home: home.path, ledger: () => ledger, mandates, usageJobs: () => fleet.read().jobs, cloneOf: () => home.path, now: () => clock.now, startedAt: T0,
		mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }),
	});
	const stateDir = join(home.path, LAYOUT.state);
	const grant = () => mandates.issue({ projects: ["demo"], objective: "nightly", expiry: "2026-12-31T00:00:00Z", spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 5, at: "2026-06-01T00:00:00Z", schedule_grant: true });
	const logs: string[] = [];
	const control = (extra: Partial<ConstructorParameters<typeof ScheduleControl>[0]> = {}) => new ScheduleControl({ stateDir, scheduler, now: () => clock.now, pid: 4242, log: (line) => logs.push(line), ...extra });
	let n = 0;
	const request = (op: "enable" | "disable" | "run_now" | "remove", scheduleId: string, at = clock.now) => {
		const id = `sc-${at.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${String(++n).padStart(8, "0")}`;
		assert.equal(appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id, at: at.toISOString(), peer: "127.0.0.1", op, schedule_id: scheduleId }).ok, true);
		return id;
	};
	const lines = (): ScheduleControlLine[] => existsSync(scheduleControlFile(stateDir)) ? readFileSync(scheduleControlFile(stateDir), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
	const state = (id: string) => readScheduleControl(stateDir).requests.find((entry) => entry.id === id);
	return { clock, ledger, mandates, scheduler, stateDir, grant, control, request, lines, state, logs };
}

const job = { title: "nightly report", kind: "research" as const, delivery: "answer" as const };

test("enable, disable, remove and run now are claimed before they act and answered with one outcome each", async (t) => {
	const { ledger, scheduler, grant, control, request, lines, state, logs } = bench(t);
	const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: grant().id, cron: "0 9 * * *", tz: "UTC", ...job });
	const parent = control();
	const off = request("disable", schedule.id);
	assert.deepEqual(await parent.pass(), []);
	assert.equal(scheduler.list()[0]?.enabled, false);
	assert.deepEqual([state(off)?.state, state(off)?.reason], ["done", `disabled ${schedule.id}`]);
	assert.deepEqual(lines().filter((line) => line.id === off).map((line) => line.type), ["request", "claimed", "outcome"], "claim before act, outcome after");
	const on = request("enable", schedule.id);
	await parent.pass();
	assert.equal(scheduler.list()[0]?.enabled, true);
	assert.equal(state(on)?.state, "done");

	const run = request("run_now", schedule.id);
	const [fired] = await parent.pass();
	assert.equal(fired?.outcome, "fired");
	assert.equal(fired?.manual, run);
	assert.equal(state(run)?.state, "done");
	assert.equal(state(run)?.job_id, fired?.job_id);
	assert.match((await ledger.show(fired?.job_id as string)).title, /nightly run now 2026-07-01T07:03Z/);
	assert.equal(fired?.manual_via, "dashboard");
	assert.match((await ledger.show(fired?.job_id as string)).notes ?? "", new RegExp(`^run now from the dashboard \\(${run}\\) for ${schedule.id} \\(nightly\\) under fire grant ${fired?.mandate_id} \\(minted from the template approved by operator-delegated\\); peer 127\\.0\\.0\\.1$`));
	assert.equal(scheduler.list()[0]?.last_fire, undefined, "a run now never writes last_fire");
	const again = request("run_now", schedule.id);
	assert.deepEqual(await parent.pass(), []);
	assert.equal(state(again)?.state, "refused");
	assert.match(state(again)?.reason ?? "", /still open/);

	const size = readFileSync(scheduleControlFile(dirname(scheduler.file))).length;
	assert.deepEqual(await parent.pass(), [], "a second pass is a no-op");
	assert.equal(readFileSync(scheduleControlFile(dirname(scheduler.file))).length, size);

	const gone = request("remove", schedule.id);
	await parent.pass();
	assert.deepEqual(scheduler.list(), []);
	assert.deepEqual([state(gone)?.state, state(gone)?.reason], ["done", `removed ${schedule.id}; revoked its grant ${fired?.mandate_id} (in-flight workers were not killed)`]);
	assert.ok(logs.some((line) => line.includes(`schedule control ${gone} remove ${schedule.id}: done`)));
	const shown = handleScheduleControlStatus({} as IncomingMessage, { home: dirname(dirname(scheduler.file)), stateDir: dirname(scheduler.file), host: "127.0.0.1", port: 0, requireTailnet: true }, T0).body as ScheduleControlStatusResponse;
	assert.deepEqual(shown.requests.map((entry) => [entry.op, entry.state]), [["disable", "done"], ["enable", "done"], ["run_now", "done"], ["run_now", "refused"], ["remove", "done"]]);
	assert.equal(shown.requests[2]?.job_id, fired?.job_id);
});

test("enable without an active grant is refused and the schedule stays disabled", async (t) => {
	const { mandates, scheduler, grant, control, request, state } = bench(t);
	const mandate = grant();
	const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: mandate.id, cron: "0 9 * * *", tz: "UTC", ...job });
	await scheduler.setEnabled(schedule.id, false);
	mandates.pause(mandate.id);
	const before = readFileSync(scheduler.file, "utf8");
	const id = request("enable", schedule.id);
	await control().pass();
	assert.equal(state(id)?.state, "refused");
	assert.match(state(id)?.reason ?? "", new RegExp(`enable ${schedule.id} refused: ${mandate.id} is paused`));
	assert.equal(readFileSync(scheduler.file, "utf8"), before, "schedules.json unchanged");
});

test("a claim that cannot be journaled acts on nothing and records no outcome", async (t) => {
	const { stateDir, scheduler, grant, control, request, state, lines } = bench(t);
	const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: grant().id, cron: "0 9 * * *", tz: "UTC", ...job });
	const id = request("disable", schedule.id);
	const failing = control({ append: (line) => (line.type === "claimed" ? { ok: false, error: "ENOSPC" } : appendScheduleControlLine(stateDir, line)) });
	await failing.pass();
	assert.equal(scheduler.list()[0]?.enabled, true, "nothing acted");
	assert.equal(state(id)?.state, "queued");
	assert.deepEqual(lines().map((line) => line.type), ["request"], "no claim, no outcome");
	await control().pass();
	assert.equal(state(id)?.state, "done", "a later parent applies it while it is fresh");
});

test("an old request is expired, a foreign claim is interrupted and never re-applied, and the opt-out refuses", async (t) => {
	const { clock, stateDir, scheduler, grant, control, request, state } = bench(t);
	const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: grant().id, cron: "0 9 * * *", tz: "UTC", ...job });
	const old = request("disable", schedule.id, new Date(clock.now.getTime() - 121_000));
	const claimed = request("disable", schedule.id);
	appendScheduleControlLine(stateDir, { type: "claimed", by: "parent", id: claimed, at: clock.now.toISOString(), pid: 999_999 });
	await control().pass();
	assert.equal(state(old)?.state, "expired");
	assert.match(state(old)?.reason ?? "", /within 120 s/);
	assert.equal(state(claimed)?.state, "interrupted");
	assert.match(state(claimed)?.reason ?? "", /parent pid 999999/);
	assert.equal(scheduler.list()[0]?.enabled, true, "neither was applied");

	mkdirSync(dirname(controlConfigFile(stateDir)), { recursive: true });
	writeFileSync(controlConfigFile(stateDir), '{"enabled": false}');
	const refused = request("disable", schedule.id);
	await control().pass();
	assert.equal(state(refused)?.state, "refused");
	assert.match(state(refused)?.reason ?? "", /dashboard control is off/);
	assert.equal(scheduler.list()[0]?.enabled, true);
});
