import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { ScheduleControl } from "../src/schedule-control.ts";
import { Scheduler } from "../src/scheduler.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { readScheduleControl, scheduleControlFile, type ScheduleControlLine } from "../src/viewer/control-files.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";

const T0 = new Date("2026-07-01T07:03:00Z");

function bench(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const clock = { now: T0 };
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const runs = openScheduleRunStore(home.path);
	const mandates = new MandateStore(home.path, { runs, now: () => clock.now });
	const fleet = new FleetStore({ home: home.path });
	const scheduler = new Scheduler({
		home: home.path, ledger: () => ledger, mandates, runs, usageJobs: () => fleet.read().jobs, cloneOf: () => home.path, now: () => clock.now, startedAt: T0,
		mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }),
	});
	const stateDir = join(home.path, LAYOUT.state);
	const native = { action: { saved_by: "operator-quote" as const, provenance: { channel: "cp_schedule" as const, tool_call_id: "call-add", quote_sha: "abcdef123456" } }, limits: {} };
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
	return { clock, ledger, mandates, scheduler, stateDir, native, control, request, lines, state, logs };
}

const job = { title: "nightly report", kind: "research" as const, delivery: "answer" as const };

test("a claim that cannot be journaled acts on nothing and records no outcome", async (t) => {
	const { stateDir, scheduler, native, control, request, state, lines } = bench(t);
	const schedule = await scheduler.add({ name: "nightly", project: "demo", native, cron: "0 9 * * *", tz: "UTC", ...job });
	const id = request("disable", schedule.id);
	const failing = control({ append: (line) => (line.type === "claimed" ? { ok: false, error: "ENOSPC" } : appendScheduleControlLine(stateDir, line)) });
	await failing.pass();
	assert.equal(scheduler.list()[0]?.enabled, true, "nothing acted");
	assert.equal(state(id)?.state, "queued");
	assert.deepEqual(lines().map((line) => line.type), ["request"], "no claim, no outcome");
	await control().pass();
	assert.equal(state(id)?.state, "done", "a later parent applies it while it is fresh");
});
