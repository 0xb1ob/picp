/**
 * A parent-expanded schedule (manual + skill) wakes the parent with `cp-schedule` naming the anchor, the schedule and the
 * skill: once on the live Run now, and — after a simulated parent restart — once more per process for an anchor no one
 * has marked `expanded:` yet. The real host (registerScheduleTools), a real ledger, grant, scheduler and control journal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerScheduleTools } from "../extensions/command-post/tools-schedule.ts";
import { isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { Scheduler } from "../src/scheduler.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { join } from "node:path";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Sent { customType: string; content: string; details: Record<string, unknown> }

/** One "parent process": a fresh registration (a fresh `woken` set) over the same home. */
function process_(home: string, ledger: Ledger, mandates: MandateStore, t: { after(fn: () => void): void }) {
	const hooks = new Map<string, () => Promise<void>>();
	const sent: Sent[] = [];
	const post = {
		home, ledger: () => ledger, mandates, fleet: new FleetStore({ home }),
		registry: { pathOf: () => home, archivedNames: () => [], get: (name: string) => (name === "demo" ? {} : undefined) }, dispatchQueue: { drain: async () => {} },
	};
	registerScheduleTools(
		{ on: (event: string, fn: () => Promise<void>) => hooks.set(event, fn), registerTool: () => {}, sendMessage: (message: Sent) => sent.push(message) } as never,
		{ commandPost: () => post, setLive: () => {} } as never,
		() => true, () => {}, () => {},
	);
	t.after(() => hooks.get("session_shutdown")!());
	/** A startup: the catch-up tick runs right after `session_start`. */
	const start = async () => { await hooks.get("session_start")!(); await wait(30); };
	const stop = () => hooks.get("session_shutdown")!();
	return { sent, start, stop };
}

test("a manual skill fire wakes the parent once per process; a restart re-wakes an unexpanded anchor once, an expanded one never", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path);
	const grant = mandates.issue({ projects: ["demo"], objective: "self-review", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, schedule_grant: true });
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, usageJobs: () => new FleetStore({ home: home.path }).read().jobs, cloneOf: () => home.path });
	const schedule = await scheduler.add({ name: "self-review", project: "demo", mandate_id: grant.id, manual: true, title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" });

	// Process 1: the live Run now (the control journal is drained every 2 s).
	const stateDir = join(home.path, LAYOUT.state);
	const at = new Date();
	assert.equal(appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id: "sc-20260701070310-00000001", at: at.toISOString(), peer: "127.0.0.1", op: "run_now", schedule_id: schedule.id }).ok, true);
	const first = process_(home.path, ledger, mandates, t);
	await first.start();
	assert.equal(first.sent.length, 0, "a tick alone never fires a manual schedule");
	for (let waited = 0; first.sent.length === 0 && waited < 15_000; waited += 100) await wait(100); // the 2 s control poll, however loaded the host
	assert.equal(first.sent.length, 1);
	const anchor = (await ledger.list({ labels: [`schedule:${schedule.id}`] }))[0]!;
	assert.equal(anchor.status, "deferred");
	assert.equal(first.sent[0]!.customType, "cp-schedule");
	assert.match(first.sent[0]!.content, new RegExp(`${schedule.id}.*${anchor.id}.*parent-expanded run.*skill cp-self-review`));
	assert.deepEqual([first.sent[0]!.details.schedule_id, first.sent[0]!.details.job_id, first.sent[0]!.details.skill], [schedule.id, anchor.id, "cp-self-review"]);
	// The same process ticking again (a restart of its timers) never wakes twice.
	await first.stop();
	await first.start();
	assert.equal(first.sent.length, 1);
	await first.stop();

	// Process 2 (a restart before the fan-out finished): one re-wake, then none.
	const second = process_(home.path, ledger, mandates, t);
	await second.start();
	assert.equal(second.sent.length, 1);
	assert.match(second.sent[0]!.content, new RegExp(`${anchor.id} is a parent-expanded run — use skill cp-self-review`));
	assert.deepEqual([second.sent[0]!.details.schedule_id, second.sent[0]!.details.job_id, second.sent[0]!.details.skill], [schedule.id, anchor.id, "cp-self-review"]);
	await second.stop();
	await second.start();
	assert.equal(second.sent.length, 1);
	await second.stop();

	// Once the parent marks the anchor `expanded:`, a later restart has nothing to finish.
	await ledger.comment(anchor.id, `expanded: L1 ${anchor.id}`);
	const third = process_(home.path, ledger, mandates, t);
	await third.start();
	assert.deepEqual(third.sent, []);
	assert.equal((await ledger.show(anchor.id)).status, "deferred", "the runner never drops or dispatches the anchor");
});
