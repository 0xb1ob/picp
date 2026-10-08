/**
 * Fresh grant per fire (docs/contracts.md *Fresh grant per fire*): every fire of every schedule — cron, watch, the
 * dashboard's Run now, cp_schedule run_now — mints a fresh schedule grant from the schedule's saved `grant_template`,
 * re-evaluated against the live home. Hard-coded: no opt-out, no reuse of a grant.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { mandateSpend } from "../src/mandate-accounting.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { liveFireBounds, pointerRefusal, synthesizedApproval, templateFromSeed } from "../src/schedule-grant.ts";
import { formatScheduleEvent, formatSchedules, type Schedule, type ScheduleEvent, Scheduler, type SchedulerPorts } from "../src/scheduler.ts";
import { namesToken } from "../extensions/command-post/tools-schedule.ts";
import { createScratchHome, createScratchLedger, REPO_ROOT, type ScratchHome } from "./harness/index.ts";

const T0 = new Date("2026-07-01T06:00:00Z");
const job = { title: "triage", kind: "research" as const, delivery: "answer" as const };
const quoteTrigger = (n: number) => ({ via: "cp_schedule" as const, tool_call_id: `call-${n}`, operator_quote: `run triage now (${n})`, decided_by: "operator-quote", source_sha: `${n}`.padStart(12, "a") });
type UsageJob = ReturnType<SchedulerPorts["usageJobs"]>[number];

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
	/** Rewrites one saved schedule in place (a hand edit, a pre-migration file). */
	const edit = (scheduler: Scheduler, id: string, fn: (schedule: Schedule) => void) => {
		const doc = JSON.parse(readFileSync(scheduler.file, "utf8")) as { schedules: Schedule[] };
		fn(doc.schedules.find((entry) => entry.id === id)!);
		writeFileSync(scheduler.file, JSON.stringify(doc));
	};
	return { clock, ledger, mandates, ports, seed, edit };
}

test("every add (cron, watch, manual) snapshots its seed as a template quoting the seed's objective; risky seeds refused", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ports, seed } = bench(home);
	const scheduler = new Scheduler(ports);
	const s = seed();
	const added = await scheduler.add({ name: "triage", project: "demo", mandate_id: s.id, cron: "0 9 * * *", tz: "UTC", ...job });
	const tpl = added.grant_template!;
	assert.deepEqual([tpl.seed_mandate_id, tpl.expiry_hours, tpl.spend_usd, tpl.spend_tokens, tpl.job_cap], [s.id, 48, 20, 2_000_000, 3]);
	assert.deepEqual(tpl.allowed_actions, ["plan", "implement"], "merge never rides a template");
	assert.deepEqual(tpl.ask_on, ["plan_approval", "merge", "risk:high"]);
	assert.deepEqual(tpl.approval, { operator_quote: "triage runs", decided_by: "operator-delegated", delegation_rule: `cp_schedule add: the objective of seed grant ${s.id}, quoted verbatim`, approved_at: "2026-07-01T06:00:00Z" }, "the seed's own words, never invented");
	assert.match(added.notes!.join("; "), /merge removed from allowed_actions.*merge and risk:high added to ask_on/);
	assert.equal(scheduler.list()[0]?.grant_template?.seed_mandate_id, s.id, "saved and re-read through the validator");
	assert.match(formatSchedules(scheduler.list()), /fire grant template: each fire mints a fresh grant .*approved "triage runs" \(operator-delegated\)/);
	const watch = await scheduler.add({ name: "w", project: "demo", mandate_id: seed().id, watch_script: "scripts/w.sh", every_seconds: 60, on: "exit0", ...job });
	const manual = await scheduler.add({ name: "m", project: "demo", mandate_id: seed().id, manual: true, ...job });
	assert.ok(watch.grant_template && manual.grant_template, "every trigger type saves a template");

	await assert.rejects(scheduler.add({ name: "r", project: "demo", mandate_id: seed({ risk_preapproval: { operator_quote: "ok", decided_by: "operator-quote", scope: "mandate_jobs", granted_at: "2026-07-01T00:00:00Z" } }).id, manual: true, ...job }), /risk:high pre-approval/);
	await assert.rejects(scheduler.add({ name: "o", project: "demo", mandate_id: seed({ allowed_actions: ["merge"] }).id, manual: true, ...job }), /allows only merge/);
	// A fire grant never seeds a template.
	const fired = await scheduler.fireNow(manual.id, "req-1");
	const fireGrant = ports.mandates.get(fired.mandate_id)!;
	assert.match(JSON.stringify(templateFromSeed(fireGrant, synthesizedApproval(fireGrant, "cp_schedule add"), "2026-07-01T06:00:00Z")), /is a fire grant minted for .*never reused as a seed/);
});

test("A3: a skill schedule's template job cap is raised to its fan-out plus anchor, named, never refused", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ports, seed } = bench(home);
	const scheduler = new Scheduler(ports);
	const added = await scheduler.add({ name: "self", project: "demo", mandate_id: seed({ job_cap: 3 }).id, manual: true, skill: "cp-self-review", title: "Self-review", kind: "research", delivery: "local" });
	assert.equal(added.grant_template?.job_cap, 8, "six readers + the synthesis + the anchor");
	assert.match(added.notes!.join("; "), /job cap raised from 3 to 8: one cp-self-review fire records 7 jobs plus its deferred anchor/);
	const roomy = await scheduler.add({ name: "roomy", project: "demo", mandate_id: seed({ job_cap: 12 }).id, manual: true, skill: "cp-self-review", title: "Self-review 2", kind: "research", delivery: "local" });
	assert.equal(roomy.grant_template?.job_cap, 12, "a cap already above the floor is kept");
	assert.doesNotMatch((roomy.notes ?? []).join("; "), /job cap raised/);
});

test("cp-7re9: under scope_policy named_jobs_only a schedule seed is issued and Run now still mints a fire grant", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { mandates, ports, seed } = bench(home);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.mandateDefaultsFile), JSON.stringify({ ...loadMandateDefaults(home.path), scope_policy: "named_jobs_only" }));
	assert.throws(() => mandates.issue({ projects: ["demo"], objective: "wide", expiry: "2026-07-03T00:00:00Z", spend_cap: { usd: 1, tokens: 1_000 }, job_cap: 1, at: "2026-07-01T00:00:00Z" }), /named_jobs_only requires explicit job_ids/);
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "triage", project: "demo", mandate_id: seed().id, manual: true, ...job });
	const fired = await scheduler.fireNow(schedule.id, quoteTrigger(1));
	assert.equal(fired.outcome, "fired", fired.reason);
	assert.equal(mandates.get(fired.mandate_id)?.schedule_grant, true);
});

test("cp-7re9: a fire in a denied project is skipped with the settings reason; no fire grant is minted", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { mandates, ports, seed } = bench(home);
	const scheduler = new Scheduler(ports);
	const s = seed();
	const schedule = await scheduler.add({ name: "triage", project: "demo", mandate_id: s.id, manual: true, ...job });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.mandateDefaultsFile), JSON.stringify({ ...loadMandateDefaults(home.path), deny_projects: ["demo"] }));
	const before = mandates.list().length;
	const skipped = await scheduler.fireNow(schedule.id, quoteTrigger(1));
	assert.notEqual(skipped.outcome, "fired");
	assert.match(skipped.reason, /no fire grant minted \(settings: project demo is denied/);
	assert.equal(mandates.list().length, before, "nothing minted");
	assert.equal(mandates.get(s.id)?.status, "active", "the seed is not revoked by a refused mint");
});

test("each Run now mints a fresh grant carrying the template's approval and the trigger, revokes the previous one, and the replayed quote mints nothing", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, ports, seed } = bench(home);
	const scheduler = new Scheduler(ports);
	const s = seed();
	const schedule = await scheduler.add({ name: "triage", project: "demo", mandate_id: s.id, manual: true, ...job });

	clock.now = new Date("2026-07-02T10:00:00Z");
	const first = await scheduler.fireNow(schedule.id, quoteTrigger(1));
	assert.equal(first.outcome, "fired", first.reason);
	const grant1 = mandates.get(first.mandate_id)!;
	assert.notEqual(grant1.id, s.id);
	assert.equal(scheduler.list()[0]?.mandate_id, grant1.id, "the pointer names the fire grant");
	assert.deepEqual([grant1.schedule_grant, grant1.expiry, grant1.allowed_actions, grant1.projects], [true, "2026-07-04T10:00:00Z", ["plan", "implement"], ["demo"]]);
	assert.ok(grant1.ask_on.includes("merge") && grant1.ask_on.includes("risk:high"));
	assert.equal(grant1.schedule_fire?.approval.operator_quote, "triage runs");
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

test("invariant: every trigger mints a fresh grant on every fire, never the previous one; a schedule with no template or one seeded by a used fire grant throws", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, ports, seed, edit } = bench(home, { runWatch: async () => ({ code: 0, stdout: "ok" }) });
	const scheduler = new Scheduler(ports);
	const hourly = await scheduler.add({ name: "hourly", project: "demo", mandate_id: seed().id, cron: "0 * * * *", tz: "UTC", ...job });
	const watch = await scheduler.add({ name: "watch", project: "demo", mandate_id: seed().id, watch_script: "scripts/w.sh", every_seconds: 30, on: "exit0", ...job });
	const manual = await scheduler.add({ name: "triage", project: "demo", mandate_id: seed().id, manual: true, ...job });
	const seeds = new Set(scheduler.list().map((entry) => entry.mandate_id));
	const fired: ScheduleEvent[] = [];
	const keep = async (event: ScheduleEvent | undefined) => {
		assert.equal(event?.outcome, "fired", event?.reason);
		fired.push(event!);
		await ledger.close(event!.job_id!, "done");
	};
	for (const at of ["2026-07-01T07:00:30Z", "2026-07-01T08:00:30Z"]) {
		clock.now = new Date(at);
		const events = await scheduler.tick();
		await keep(events.find((event) => event.schedule_id === hourly.id));
		await keep(events.find((event) => event.schedule_id === watch.id));
		await keep(await scheduler.fireNow(manual.id, `req-${at}`));
		await keep(await scheduler.fireNow(manual.id, quoteTrigger(fired.length)));
	}
	const ids = fired.map((event) => event.mandate_id);
	assert.equal(new Set(ids).size, 8, "eight fires, eight distinct grants");
	assert.ok(ids.every((id) => !seeds.has(id)), "no fire files under its seed");
	assert.deepEqual(fired.map((event) => mandates.get(event.mandate_id)?.schedule_fire?.trigger.via), ["cron", "watch", "dashboard", "cp_schedule", "cron", "watch", "dashboard", "cp_schedule"]);
	assert.deepEqual(mandates.get(fired[0]!.mandate_id)?.schedule_fire?.trigger, { via: "cron", slot: "2026-07-01T07:00:00Z", missed: false });
	assert.deepEqual(mandates.get(fired[1]!.mandate_id)?.schedule_fire?.trigger, { via: "watch", at: "2026-07-01T07:00:30Z", output_sha: "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df" });
	for (const [index, event] of fired.entries()) {
		const grant = mandates.get(event.mandate_id)!;
		assert.notEqual(grant.id, grant.schedule_fire?.previous_mandate_id, "a fire grant is never its own predecessor");
		const later = fired.slice(index + 1).find((next) => next.schedule_id === event.schedule_id);
		if (later) assert.equal(grant.status, "revoked", `${grant.id} is revoked once ${later.mandate_id} replaces it`);
	}
	assert.ok([...seeds].every((id) => mandates.get(id)?.status === "revoked"));

	// A4: the manual schedule now names a live grant it already used. Without a template the fire path throws, never reuses it.
	const used = scheduler.list().find((entry) => entry.id === manual.id)!.mandate_id;
	assert.equal(mandates.get(used)?.status, "active");
	const count = mandates.list().length;
	edit(scheduler, manual.id, (schedule) => delete schedule.grant_template);
	await assert.rejects(scheduler.fireNow(manual.id, "req-wiped"), /has no grant template/);
	// A template built from that used fire grant's id is refused the same way.
	edit(scheduler, manual.id, (schedule) => { schedule.grant_template = { ...hourly.grant_template!, seed_mandate_id: used }; });
	await assert.rejects(scheduler.fireNow(manual.id, "req-reused"), new RegExp(`seeded by fire grant ${used}; a fire grant is never reused`));
	// A tick never reuses either: the cron schedule with no template records a skip.
	edit(scheduler, hourly.id, (schedule) => delete schedule.grant_template);
	clock.now = new Date("2026-07-01T09:00:30Z");
	const [skipped] = (await scheduler.tick()).filter((event) => event.schedule_id === hourly.id);
	assert.equal(skipped?.outcome, "skipped");
	assert.match(skipped?.reason ?? "", /has no grant template/);
	await assert.rejects(scheduler.setEnabled(hourly.id, true), /has no grant template/);
	assert.equal(mandates.list().length, count + 1, "only the watch fire at 09:00 minted; no template, no grant, no reuse");
	assert.equal(mandates.get(used)?.status, "active", "the used grant was not touched");
});

test("A4: the fire path has no branch around #mint and never checks schedule.mandate_id as the grant a job files under", () => {
	const source = readFileSync(join(REPO_ROOT, "src/scheduler.ts"), "utf8");
	const body = (signature: string): string => {
		const start = source.indexOf(signature);
		assert.ok(start > 0, `${signature} exists`);
		return source.slice(start, source.indexOf("\n\t}\n", start));
	};
	const fireOnce = body("async #fireOnce(");
	assert.match(fireOnce, /^\t\tconst template = this\.#template\(schedule\);$/m, "a missing template throws first");
	assert.match(fireOnce, /^\t\tconst fire = await this\.#mint\(/m, "the mint is unconditional, at the method's own level");
	assert.doesNotMatch(fireOnce, /mandateRefusal|grant_template|sweep\(/, "no shared-grant path left in #fireOnce");
	const beforeMint = fireOnce.slice(0, fireOnce.indexOf("this.#mint("));
	assert.deepEqual(
		beforeMint.split("\n").filter((line) => /^\t\t(?:if .*\) )?return\b/.test(line)).map((line) => line.trim()),
		["if (this.#ports.archivedProjects?.().includes(schedule.project)) return refuse(archivedRefusal(schedule.project));", "if (early) return refuse(early);"],
		"before the mint, only the archive refusal and the open-fire/single-use guard",
	);
	const mint = body("async #mint(");
	assert.doesNotMatch(mint, /manual === undefined\) return/, "no trigger is excluded from minting");
	assert.doesNotMatch(mint, /mandateRefusal\([^)]*schedule\.mandate_id/, "the pointer is never the grant a fire files under");
	assert.match(mint, /mandateRefusal\(fire\.grant, fire\.grant\.id,/, "only the fresh grant is checked");
	assert.match(mint, /throw new SchedulerError\(`schedule \$\{schedule\.id\} would reuse/);
});

test("A1: an expired or cap-exhausted pointer never stops the next cron fire or Run now, and no fire asks the operator anything; only an operator revoke or pause stops it", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const usage: UsageJob[] = [];
	const { clock, ledger, mandates, ports, seed } = bench(home, { usageJobs: () => usage });
	const scheduler = new Scheduler(ports);
	const hourly = await scheduler.add({ name: "hourly", project: "demo", mandate_id: seed().id, cron: "0 * * * *", tz: "UTC", ...job });
	const manual = await scheduler.add({ name: "triage", project: "demo", mandate_id: seed().id, manual: true, ...job });
	const cronFire = async (at: string) => {
		clock.now = new Date(at);
		const event = (await scheduler.tick()).find((entry) => entry.schedule_id === hourly.id);
		if (event?.job_id) await ledger.close(event.job_id, "done");
		return event;
	};
	const runNow = async (n: number) => {
		const event = await scheduler.fireNow(manual.id, quoteTrigger(n));
		if (event.job_id) await ledger.close(event.job_id, "done");
		return event;
	};
	const c1 = (await cronFire("2026-07-01T07:00:30Z"))!;
	const r1 = await runNow(1);
	assert.deepEqual([c1.outcome, r1.outcome], ["fired", "fired"]);
	// Both first fires overspend their grants ($25 over the template's $20): the sweep pauses each on spend_cap.
	for (const [event, schedule] of [[c1, hourly], [r1, manual]] as const) usage.push({ job_id: event.job_id!, project: "demo", kind: "research", schedule_id: schedule.id, usage: { cost_usd: 25, total_tokens: 1000 } });
	const c2 = (await cronFire("2026-07-01T08:00:30Z"))!;
	const r2 = await runNow(2);
	assert.equal(c2.outcome, "fired", `a cap-exhausted pointer re-mints for cron: ${c2.reason}`);
	assert.equal(r2.outcome, "fired", `a cap-exhausted pointer re-mints for Run now: ${r2.reason}`);
	assert.equal(mandates.get(c1.mandate_id)?.pause_reason, "spend_cap");
	assert.equal(mandates.get(r1.mandate_id)?.pause_reason, "spend_cap");
	const grant2 = mandates.get(r2.mandate_id)!;
	assert.deepEqual([grant2.spend_cap.usd, grant2.job_cap], [20, 3], "the fire's caps are the template's, never what is left on the pointer");
	assert.deepEqual(grant2.usage_baseline?.map((entry) => entry.job_id), [r1.job_id], "the earlier fire's spend is the new grant's baseline");
	const spent = mandateSpend(grant2, mandates.withReviewerSpend(usage, [grant2]));
	assert.deepEqual([spent.usd, spent.jobs], [0, 0], "spend from earlier fires is never charged to the new grant (pointer moved before issue)");
	// Past the 48 h fire grants: both pointers expire, and both next fires mint fresh.
	const c3 = (await cronFire("2026-07-10T00:00:30Z"))!;
	const r3 = await runNow(3);
	assert.equal(c3.outcome, "fired", `an expired pointer re-mints for cron: ${c3.reason}`);
	assert.equal(r3.outcome, "fired", `an expired pointer re-mints for Run now: ${r3.reason}`);
	assert.equal(new Set([c1, c2, c3, r1, r2, r3].map((event) => event.mandate_id)).size, 6);
	// A3: no fire wrote a budget_exhausted escalation, or any ask about a schedule grant — not in the escalation store,
	// and not in any fire grant's own escalations (c1/r1 were paused on spend_cap by the sweep, silently).
	assert.deepEqual(new EscalationStore({ home: home.path }).list(), [], "a fire never asks the operator about its grant's budget");
	const fireGrants = mandates.list().filter((grant) => grant.schedule_fire);
	assert.equal(fireGrants.length, 6);
	assert.deepEqual(fireGrants.flatMap((grant) => grant.escalations.filter((entry) => entry.kind === "budget_exhausted" || entry.kind.endsWith("_cap")).map((entry) => `${grant.id}: ${entry.kind}`)), [], "no budget_exhausted or cap entry on any fire grant (the pointer included)");

	mandates.pause(c3.mandate_id);
	mandates.pause(r3.mandate_id);
	assert.match((await cronFire("2026-07-10T01:00:30Z"))?.reason ?? "", /paused \(operator\); a schedule never re-mints past an operator pause/);
	assert.match((await runNow(4)).reason, /paused \(operator\); a schedule never re-mints past an operator pause/);
	await assert.rejects(scheduler.setEnabled(manual.id, true), /never re-mints past an operator pause/);
	mandates.revoke(r3.mandate_id, { by: "operator", operator_quote: "revoke the triage grant", decided_by: "operator-quote" });
	assert.match((await runNow(5)).reason, /was revoked by the operator \(operator-quote\); a schedule never re-mints past an operator revoke: cp_schedule move it/);

	const bare = new Scheduler({ ...ports, mintContext: undefined });
	const other = await bare.add({ name: "other", project: "demo", mandate_id: seed({ expiry: "2026-12-31T00:00:00Z" }).id, manual: true, ...job });
	assert.match((await bare.fireNow(other.id, quoteTrigger(9))).reason, /does not wire the fire grant mint context/);
	const throwing = new Scheduler({ ...ports, mintContext: () => { throw new Error("bad json"); } });
	assert.match((await throwing.fireNow(other.id, quoteTrigger(10))).reason, /unreadable \(bad json\)/);
});

test("A1: a pointer revoked by the parent or the system (revoked_by) never stops the next cron fire or Run now; an operator-quoted or legacy (no provenance) revoke does", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { clock, ledger, mandates, ports, seed } = bench(home);
	const scheduler = new Scheduler(ports);
	const hourly = await scheduler.add({ name: "hourly", project: "demo", mandate_id: seed().id, cron: "0 * * * *", tz: "UTC", ...job });
	const manual = await scheduler.add({ name: "triage", project: "demo", mandate_id: seed().id, manual: true, ...job });
	const cronFire = async (at: string) => {
		clock.now = new Date(at);
		const event = (await scheduler.tick()).find((entry) => entry.schedule_id === hourly.id);
		if (event?.job_id) await ledger.close(event.job_id, "done");
		return event;
	};
	const runNow = async (n: number) => {
		const event = await scheduler.fireNow(manual.id, quoteTrigger(n));
		if (event.job_id) await ledger.close(event.job_id, "done");
		return event;
	};
	const c1 = (await cronFire("2026-07-01T07:00:30Z"))!;
	const r1 = await runNow(1);
	// The parent revokes one live pointer, the system the other: each recorded in revoked_by.
	assert.deepEqual(mandates.revoke(c1.mandate_id, { by: "parent" }).revoked_by, { by: "parent" });
	assert.deepEqual(mandates.revoke(r1.mandate_id, { by: "system" }).revoked_by, { by: "system" });
	const c2 = (await cronFire("2026-07-01T08:00:30Z"))!;
	const r2 = await runNow(2);
	assert.equal(c2.outcome, "fired", `a parent-revoked pointer re-mints for cron: ${c2.reason}`);
	assert.equal(r2.outcome, "fired", `a system-revoked pointer re-mints for Run now: ${r2.reason}`);
	assert.equal(new Set([c1, c2, r1, r2].map((event) => event.mandate_id)).size, 4);
	assert.equal((await scheduler.setEnabled(hourly.id, true)).enabled, true, "enable is not refused by a parent revoke either");

	// The operator's revoke (cp_mandate revoke with a verified operator_quote) is recorded, and it stops the schedule.
	const revoked = mandates.revoke(c2.mandate_id, { by: "operator", operator_quote: "stop the hourly schedule", decided_by: "operator-quote" }).revoked_by;
	assert.equal(revoked?.by === "operator" ? revoked.operator_quote : undefined, "stop the hourly schedule");
	assert.match((await cronFire("2026-07-01T09:00:30Z"))?.reason ?? "", /was revoked by the operator \(operator-quote\); a schedule never re-mints past an operator revoke/);
	// A legacy revoke (no revoked_by: revoked before provenance was recorded) is the safe default: stopped until moved.
	assert.equal(mandates.revoke(r2.mandate_id).revoked_by, undefined);
	assert.match((await runNow(3)).reason, /was revoked with no recorded provenance \(a legacy revoke\), treated as the operator's; a schedule never re-mints past it: cp_schedule move it/);
	await assert.rejects(scheduler.setEnabled(manual.id, true), /no recorded provenance/);
});

test("move retargets a stopped schedule to a fresh seed: same id, template from the new seed, old pointer revoked unless shared", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const { ledger, mandates, ports, seed } = bench(home);
	const scheduler = new Scheduler(ports);
	const schedule = await scheduler.add({ name: "triage", project: "demo", mandate_id: seed().id, manual: true, ...job });
	const first = await scheduler.fireNow(schedule.id, "req-1");
	await ledger.close(first.job_id!, "done");
	mandates.pause(first.mandate_id);
	assert.match((await scheduler.fireNow(schedule.id, "req-2")).reason, /paused \(operator\)/);
	const next = seed({ job_cap: 5, objective: "triage again" });
	const moved = await scheduler.move(schedule.id, next.id);
	assert.equal(moved.schedule.id, schedule.id, "same schedule, same schedule:<id> label");
	assert.deepEqual([moved.schedule.mandate_id, moved.schedule.grant_template?.seed_mandate_id, moved.schedule.grant_template?.job_cap, moved.schedule.grant_template?.approval.operator_quote], [next.id, next.id, 5, "triage again"]);
	assert.match(moved.note, new RegExp(`revoked its grant ${first.mandate_id}`));
	assert.equal(mandates.get(first.mandate_id)?.status, "revoked");
	const after = await scheduler.fireNow(schedule.id, "req-3");
	assert.equal(after.outcome, "fired", after.reason);
	assert.equal(mandates.get(after.mandate_id)?.job_cap, 5);
	assert.equal(mandates.get(next.id)?.status, "revoked", "the new seed retires at the first fire, like any seed");

	const other = await scheduler.add({ name: "other", project: "demo", mandate_id: seed().id, manual: true, ...job });
	await assert.rejects(scheduler.move(schedule.id, other.mandate_id), /already the grant of schedule/);
	await assert.rejects(scheduler.move("sch-ffffff", next.id), /no schedule sch-ffffff/);
});

test("live bounds: exclusions only grow, tokens clamp to the ceiling, an excluded kind refuses; pointer rules", () => {
	const home = createScratchHome();
	try {
		const { seed } = bench(home);
		const s = seed({ exclusions: { paths: ["secrets/"], job_kinds: ["ship"] } });
		const made = templateFromSeed(s, synthesizedApproval(s, "cp_schedule add"), "2026-07-01T06:00:00Z");
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
