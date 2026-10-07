/** Parent-expanded schedule wakes share the compaction hold, including startup recovery. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { registerScheduleTools } from "../extensions/command-post/tools-schedule.ts";
import { isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { ParentCompactHold } from "../src/parent-compact-hold.ts";
import { Scheduler } from "../src/scheduler.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

interface Sent { customType: string; content: string; display: boolean; details: Record<string, unknown> }

function completion() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

/** A fresh registration has its own anchor dedupe set, just like a new parent process. */
function process_(home: string, ledger: Ledger, mandates: MandateStore, t: TestContext, deferParentWake: (deliver: () => void) => void) {
	const hooks = new Map<string, () => Promise<void>>();
	const sent: Sent[] = [];
	const options: unknown[] = [];
	const dispatched: string[] = [];
	let offered = completion();
	const post = {
		home, ledger: () => ledger, mandates, fleet: new FleetStore({ home }),
		registry: { pathOf: () => home, archivedNames: () => [], get: (name: string) => (name === "demo" ? {} : undefined) },
		dispatchQueue: { drain: async () => {} }, armedDispatches: { release: async () => {} },
		dispatch: async (request: { jobId: string }) => { dispatched.push(request.jobId); },
	};
	registerScheduleTools(
		{ on: (event: string, fn: () => Promise<void>) => hooks.set(event, fn), registerTool: () => {}, sendMessage: (message: Sent, opts: unknown) => { sent.push(message); options.push(opts); } } as never,
		{ commandPost: () => post, setLive: () => {} } as never,
		() => true, () => {}, () => {}, (deliver) => { deferParentWake(deliver); offered.resolve(); },
	);
	t.after(() => hooks.get("session_shutdown")!());
	return { sent, options, dispatched, start: () => hooks.get("session_start")!(), stop: () => hooks.get("session_shutdown")!(),
		nextOffer: () => { offered = completion(); return offered.promise; } };
}

for (const held of [false, true]) test(`skill fire and restart recovery: ${held ? "held" : "immediate"} transport, one offer per process`, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path);
	const grant = mandates.issue({ projects: ["demo"], objective: "self-review", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, schedule_grant: true });
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, usageJobs: () => new FleetStore({ home: home.path }).read().jobs, cloneOf: () => home.path });
	const schedule = await scheduler.add({ name: "self-review", project: "demo", mandate_id: grant.id, manual: true, title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" });
	const hold = new ParentCompactHold({ timer: () => () => {} });
	if (held) hold.settled({ over: true, raw: 210000, effective: 210000, threshold: 200000 });
	let offers = 0;
	const defer = (deliver: () => void) => { offers++; if (hold.offer(deliver) === "send") deliver(); };

	// Explicit completion barrier for each catch-up tick, after the host's tick continuation.
	const tick = Scheduler.prototype.tick;
	let completed = completion();
	t.mock.method(Scheduler.prototype, "tick", async function (this: Scheduler) {
		const events = await tick.call(this);
		const done = completed;
		queueMicrotask(() => done.resolve());
		return events;
	});
	const start = async (parent: ReturnType<typeof process_>) => {
		completed = completion();
		await parent.start();
		t.mock.timers.tick(0);
		await completed.promise;
	};

	const first = process_(home.path, ledger, mandates, t, defer);
	await start(first);
	assert.equal(offers, 0, "startup cannot fire a manual schedule");
	assert.equal(appendScheduleControlLine(join(home.path, LAYOUT.state), { type: "request", by: "viewer", id: "sc-20260701070310-00000001", at: new Date().toISOString(), peer: "127.0.0.1", op: "run_now", schedule_id: schedule.id }).ok, true);
	const liveOffer = first.nextOffer();
	t.mock.timers.tick(2000);
	await liveOffer;
	assert.equal(offers, 1);
	assert.equal(first.sent.length, held ? 0 : 1);
	const anchor = (await ledger.list({ labels: [`schedule:${schedule.id}`] }))[0]!;
	assert.equal(anchor.status, "deferred");
	const grants = mandates.list();
	await first.stop();
	await start(first);
	assert.equal(offers, 1, "recovery does not requeue an anchor already offered while held");
	await first.stop();

	// Simulated crash before expansion: a fresh process recovers the existing anchor/grant.
	const second = process_(home.path, ledger, mandates, t, defer);
	await start(second);
	assert.equal(offers, 2);
	assert.equal(second.sent.length, held ? 0 : 1);
	await second.stop();
	await start(second);
	assert.equal(offers, 2);
	await second.stop();
	hold.compacted();
	assert.equal(first.sent.length, 1);
	assert.equal(second.sent.length, 1);
	for (const parent of [first, second]) {
		assert.deepEqual(parent.dispatched, [], "a local skill anchor belongs to the parent, never the runner");
		assert.equal(parent.sent[0]!.customType, "cp-schedule");
		assert.equal(parent.sent[0]!.display, true);
		assert.match(parent.sent[0]!.content, /parent-expanded run/);
		assert.deepEqual([parent.sent[0]!.details.schedule_id, parent.sent[0]!.details.job_id, parent.sent[0]!.details.skill], [schedule.id, anchor.id, "cp-self-review"]);
		assert.deepEqual(parent.options, [{ deliverAs: "followUp", triggerTurn: true }]);
	}
	assert.match(first.sent[0]!.content, /run now from the dashboard/);
	assert.match(second.sent[0]!.content, /use skill cp-self-review to expand it now/);
	assert.deepEqual(mandates.list(), grants, "recovery/release mints no grant");
	assert.equal((await ledger.list({ labels: [`schedule:${schedule.id}`] })).length, 1);

	await ledger.comment(anchor.id, `expanded: L1 ${anchor.id}`);
	const third = process_(home.path, ledger, mandates, t, defer);
	await start(third);
	assert.equal(offers, 2, "expanded anchor is never recovered");
	assert.deepEqual(third.sent, []);
	assert.equal((await ledger.show(anchor.id)).status, "deferred");
});
