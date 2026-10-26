/**
 * Retained from tests/schedule-org-review.test.ts (P13b): verifiedRunNowClick's refusals need a journal line no viewer
 * or parent writes (a forged id, peer, op, pid or claim count); 12-6 pins the verified dashboard click end to end.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { ScheduleControl, verifiedRunNowClick } from "../src/schedule-control.ts";
import { openScheduleRunStore } from "../src/schedule-runs.ts";
import { Scheduler } from "../src/scheduler.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { controlConfigFile } from "../src/viewer/control-files.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const T0 = new Date("2026-07-01T07:03:00Z");
const PID = 4242;

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
		mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }), controlPid: PID,
	});
	const stateDir = join(home.path, LAYOUT.state);
	let n = 0;
	const request = (scheduleId: string, extra: Record<string, unknown> = {}) => {
		const id = `sc-${clock.now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${(++n).toString(16).padStart(8, "0")}`;
		appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id, at: clock.now.toISOString(), peer: "100.64.0.9", op: "run_now", schedule_id: scheduleId, ...extra } as never);
		return id;
	};
	const control = () => new ScheduleControl({ stateDir, scheduler, now: () => clock.now, pid: PID, log: () => {} });
	return { clock, runs, scheduler, stateDir, request, control };
}

test("verifiedRunNowClick: only the viewer's one run_now request for this schedule, claimed once by this parent within 120 s, no outcome, control on", (t) => {
	const { stateDir, request, clock } = bench(t);
	const claim = (id: string, extra: Record<string, unknown> = {}) => appendScheduleControlLine(stateDir, { type: "claimed", by: "parent", id, at: clock.now.toISOString(), pid: PID, ...extra } as never);
	const ok = request("sch-aaaaaa");
	claim(ok);
	assert.deepEqual(verifiedRunNowClick(stateDir, ok, "sch-aaaaaa", PID), { ok: true, peer: "100.64.0.9" });
	const why = (id: string, schedule = "sch-aaaaaa", pid = PID) => { const click = verifiedRunNowClick(stateDir, id, schedule, pid); return click.ok ? "ok" : click.why; };
	assert.match(why("sc-1"), /is not a dashboard request id/);
	assert.match(why(ok, "sch-bbbbbb"), /names "sch-aaaaaa", not sch-bbbbbb/);
	assert.match(why(ok, "sch-aaaaaa", 1), /not this parent \(pid 1\)/);
	const unclaimed = request("sch-aaaaaa");
	assert.match(why(unclaimed), /0 claims after the request/);
	const twice = request("sch-aaaaaa");
	claim(twice);
	claim(twice);
	assert.match(why(twice), /2 claims after the request/);
	const enable = request("sch-aaaaaa", { op: "enable" });
	claim(enable);
	assert.match(why(enable), /is "enable", not run_now/);
	const parent = request("sch-aaaaaa", { by: "parent" });
	claim(parent);
	assert.match(why(parent), /written by "parent", not the viewer/);
	const peerless = request("sch-aaaaaa", { peer: "" });
	claim(peerless);
	assert.match(why(peerless), /records no peer/);
	const late = request("sch-aaaaaa");
	claim(late, { at: new Date(clock.now.getTime() + 121_000).toISOString() });
	assert.match(why(late), /outside 0-120000 ms/);
	const done = request("sch-aaaaaa");
	claim(done);
	appendScheduleControlLine(stateDir, { type: "outcome", by: "parent", id: done, at: clock.now.toISOString(), state: "done", reason: "x" } as never);
	assert.match(why(done), /already has an outcome/);
	mkdirSync(dirname(controlConfigFile(stateDir)), { recursive: true });
	writeFileSync(controlConfigFile(stateDir), '{"enabled": false}');
	assert.match(why(ok), /dashboard control is off/);
});
