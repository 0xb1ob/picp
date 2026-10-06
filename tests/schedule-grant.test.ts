/**
 * Schedules S3 (T3.2, T3.3) — manual `refire` schedules: every Run now mints a fresh schedule grant from the schedule's saved,
 * operator-approved `grant_template`, re-evaluated against the live home; never standing authority.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { mandateSpend } from "../src/mandate-accounting.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { liveFireBounds, pointerRefusal, templateFromSeed } from "../src/schedule-grant.ts";
import { formatScheduleEvent, formatSchedules, Scheduler, type SchedulerPorts } from "../src/scheduler.ts";
import { namesToken } from "../extensions/command-post/tools-schedule.ts";
import { createScratchHome, createScratchLedger, type ScratchHome } from "./harness/index.ts";

const T0 = new Date("2026-07-01T06:00:00Z");
const job = { title: "triage", kind: "research" as const, delivery: "answer" as const };
const approval = { operator_quote: "yes, mint a fresh grant for triage on every Run now", decided_by: "operator-quote" as const };
const quoteTrigger = (n: number) => ({ via: "cp_schedule" as const, tool_call_id: `call-${n}`, operator_quote: `run triage now (${n})`, decided_by: "operator-quote", source_sha: `${n}`.padStart(12, "a") });

function bench(home: ScratchHome, overrides: Partial<SchedulerPorts> = {}) {
	const clock = { now: T0 };
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path, { now: () => clock.now });
	const ports: SchedulerPorts = {
		home: home.path, ledger: () => ledger, mandates, usageJobs: () => [], cloneOf: () => home.path, now: () => clock.now, startedAt: T0,
		mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }),
		...overrides,
	};
	const seed = (extra: Partial<Parameters<MandateStore["issue"]>[0]> = {}) => mandates.issue({
		projects: ["demo"], objective: "triage runs", expiry: "2026-07-03T00:00:00Z", spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 3,
		at: "2026-07-01T00:00:00Z", schedule_grant: true, allowed_actions: ["plan", "implement", "merge"], ask_on: ["plan_approval"], ...extra,
	});
	return { clock, ledger, mandates, ports, seed };
}

test("refire add snapshots the seed as a template, normalizations named; cron/watch and risky seeds refused", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ports, seed } = bench(home);
	const scheduler = new Scheduler(ports);
	const s = seed();
	const added = await scheduler.add({ name: "triage", project: "demo", mandate_id: s.id, manual: true, refire: { approval }, ...job });
	const tpl = added.grant_template!;
	assert.deepEqual([tpl.seed_mandate_id, tpl.expiry_hours, tpl.spend_usd, tpl.spend_tokens, tpl.job_cap], [s.id, 48, 20, 2_000_000, 3]);
	assert.deepEqual(tpl.allowed_actions, ["plan", "implement"], "merge never rides a template");
	assert.deepEqual(tpl.ask_on, ["plan_approval", "merge", "risk:high"]);
	assert.equal(tpl.approval.operator_quote, approval.operator_quote, "verbatim");
	assert.equal(tpl.approval.approved_at, "2026-07-01T06:00:00Z");
	assert.match(added.notes!.join("; "), /merge removed from allowed_actions.*merge and risk:high added to ask_on/);
	assert.equal(scheduler.list()[0]?.grant_template?.seed_mandate_id, s.id, "saved and re-read through the validator");
	assert.match(formatSchedules(scheduler.list()), /refire: each Run now mints a fresh grant .*approved "yes, mint a fresh grant/);

	await assert.rejects(scheduler.add({ name: "c", project: "demo", mandate_id: seed().id, cron: "0 9 * * *", tz: "UTC", refire: { approval }, ...job }), /refire needs a manual schedule/);
	await assert.rejects(scheduler.add({ name: "r", project: "demo", mandate_id: seed({ risk_preapproval: { operator_quote: "ok", decided_by: "operator-quote", scope: "mandate_jobs", granted_at: "2026-07-01T00:00:00Z" } }).id, manual: true, refire: { approval }, ...job }), /risk:high pre-approval/);
	await assert.rejects(scheduler.add({ name: "m", project: "demo", mandate_id: seed({ allowed_actions: ["merge"] }).id, manual: true, refire: { approval }, ...job }), /allows only merge/);
});

test("each Run now mints a fresh grant carrying the approval and trigger, revokes the previous one, and the replayed quote mints nothing", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, ports, seed } = bench(home);
	const scheduler = new Scheduler(ports);
	const s = seed();
	const schedule = await scheduler.add({ name: "triage", project: "demo", mandate_id: s.id, manual: true, refire: { approval }, ...job });

	clock.now = new Date("2026-07-02T10:00:00Z");
	const first = await scheduler.fireNow(schedule.id, quoteTrigger(1));
	assert.equal(first.outcome, "fired", first.reason);
	const grant1 = mandates.get(first.mandate_id)!;
	assert.notEqual(grant1.id, s.id);
	assert.equal(scheduler.list()[0]?.mandate_id, grant1.id, "the pointer names the fire grant");
	assert.deepEqual([grant1.schedule_grant, grant1.expiry, grant1.allowed_actions, grant1.projects], [true, "2026-07-04T10:00:00Z", ["plan", "implement"], ["demo"]]);
	assert.ok(grant1.ask_on.includes("merge") && grant1.ask_on.includes("risk:high"));
	assert.equal(grant1.schedule_fire?.approval.operator_quote, approval.operator_quote);
	assert.deepEqual(grant1.schedule_fire?.trigger, { via: "cp_schedule", operator_quote: "run triage now (1)", decided_by: "operator-quote", source_sha: "aaaaaaaaaaa1" });
	assert.equal(grant1.schedule_fire?.previous_mandate_id, s.id);
	assert.equal(mandates.get(s.id)?.status, "revoked", "the seed stops being standing authority at the first fire");
	assert.match(formatScheduleEvent(first), new RegExp(`minted fire grant ${grant1.id}.*revoked ${s.id}`));
	assert.match((await ledger.show(first.job_id!)).notes ?? "", new RegExp(`under fire grant ${grant1.id}`));

	// The open fire refuses before any mint; so does the replayed quote once it closes.
	const blocked = await scheduler.fireNow(schedule.id, quoteTrigger(2));
	assert.match(blocked.reason, /still open/);
	await ledger.close(first.job_id!, "done");
	const replay = await scheduler.fireNow(schedule.id, quoteTrigger(1));
	assert.match(replay.reason, /already authorized run now/);
	assert.equal(mandates.list().length, 2, "neither refusal minted or revoked anything");
	assert.equal(mandates.get(grant1.id)?.status, "active");

	const second = await scheduler.fireNow(schedule.id, { via: "dashboard", request_id: "req-2", peer: "127.0.0.1" });
	assert.equal(second.outcome, "fired", second.reason);
	const grant2 = mandates.get(second.mandate_id)!;
	assert.deepEqual(grant2.schedule_fire?.trigger, { via: "dashboard", request_id: "req-2", peer: "127.0.0.1" });
	assert.equal(mandates.get(grant1.id)?.status, "revoked");

	const removed = await scheduler.remove(schedule.id);
	assert.match(removed.note, new RegExp(`revoked its grant ${grant2.id}`));
	assert.equal(mandates.get(grant2.id)?.status, "revoked");
});

test("an operator revoke or pause stops a refire schedule; an expired or cap-paused grant re-mints; no mint context fails closed", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const usage: NonNullable<ReturnType<SchedulerPorts["usageJobs"]>>[number][] = [];
	const { clock, ledger, mandates, ports, seed } = bench(home, { usageJobs: () => usage });
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "triage", project: "demo", mandate_id: seed().id, manual: true, refire: { approval }, ...job });
	const fire = async (n: number) => {
		const event = await scheduler.fireNow(schedule.id, quoteTrigger(n));
		if (event.job_id) await ledger.close(event.job_id, "done");
		return event;
	};
	const one = await fire(1);
	// The first fire's job overspends its grant: the sweep pauses it on spend_cap.
	usage.push({ job_id: one.job_id!, project: "demo", kind: "research", schedule_id: schedule.id, usage: { cost_usd: 25, total_tokens: 1000 } });
	const two = await fire(2);
	assert.equal(mandates.get(one.mandate_id)?.pause_reason, "spend_cap");
	assert.equal(two.outcome, "fired", `a cap pause re-mints: ${two.reason}`);
	const grant2 = mandates.get(two.mandate_id)!;
	assert.deepEqual(grant2.usage_baseline?.map((entry) => entry.job_id), [one.job_id], "the earlier fire's spend is the new grant's baseline");
	const spent = mandateSpend(grant2, mandates.withReviewerSpend(usage, [grant2]));
	assert.deepEqual([spent.usd, spent.jobs], [0, 0], "spend from earlier fires is never charged to the new grant (pointer moved before issue)");
	clock.now = new Date("2026-07-10T00:00:00Z"); // past the 48 h fire grant
	const three = await fire(3);
	assert.equal(three.outcome, "fired", "an expired pointer re-mints");
	mandates.pause(three.mandate_id);
	const paused = await fire(4);
	assert.match(paused.reason, /paused \(operator\); a refire schedule never re-mints/);
	await assert.rejects(scheduler.setEnabled(schedule.id, true), /never re-mints past an operator pause/);
	mandates.revoke(three.mandate_id);
	assert.match((await fire(5)).reason, /was revoked; a refire schedule never re-mints/);

	const bare = new Scheduler({ ...ports, mintContext: undefined });
	const other = await bare.add({ name: "other", project: "demo", mandate_id: seed({ expiry: "2026-12-31T00:00:00Z" }).id, manual: true, refire: { approval }, ...job });
	assert.match((await bare.fireNow(other.id, quoteTrigger(9))).reason, /does not wire the refire mint context/);
	const throwing = new Scheduler({ ...ports, mintContext: () => { throw new Error("bad json"); } });
	assert.match((await throwing.fireNow(other.id, quoteTrigger(10))).reason, /unreadable \(bad json\)/);
});

test("live bounds: exclusions only grow, tokens clamp to the ceiling, an excluded kind refuses; pointer rules", () => {
	const home = createScratchHome();
	try {
		const { seed } = bench(home);
		const made = templateFromSeed(seed({ exclusions: { paths: ["secrets/"], job_kinds: ["ship"] } }), approval, "2026-07-01T06:00:00Z");
		assert.ok(!("refusal" in made));
		const defaults = { ...loadMandateDefaults(home.path), exclude_paths: [".env"] };
		const live = liveFireBounds(made.template, { defaults, projectOverride: { exclude_paths: ["infra/"] }, ceiling: 500_000 }, "demo", "research", T0);
		assert.ok(!("refusal" in live));
		assert.deepEqual(live.input.exclusions?.paths, ["secrets/", ".env", "infra/"]);
		assert.equal(live.input.spend_cap.tokens, 500_000);
		assert.match(live.notes.join("; "), /clamped to the home's token_ceiling 500000/);
		assert.match(JSON.stringify(liveFireBounds(made.template, { defaults, ceiling: 500_000 }, "demo", "ship", T0)), /excludes ship jobs/);
		assert.match(JSON.stringify(liveFireBounds(made.template, { defaults, ceiling: 0 }, "demo", "research", T0)), /nothing to spend/);
		assert.equal(pointerRefusal(undefined), undefined, "a pointer with no file (crash between move and issue) re-mints");
	} finally {
		home.cleanup();
	}
});

test("run_now names a schedule only as a whole token", () => {
	assert.ok(namesToken("please run nightly now", "nightly", "i"));
	assert.ok(namesToken("Run NIGHTLY.", "nightly", "i"));
	assert.ok(!namesToken("run nightlyish now", "nightly", "i"));
	assert.ok(!namesToken("run sch-abc1234", "sch-abc123", ""));
	assert.ok(namesToken("fire sch-abc123 please", "sch-abc123", ""));
	assert.ok(namesToken("run (a+b) now", "(a+b)", "i"), "regex metacharacters are escaped");
});
