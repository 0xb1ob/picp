/**
 * The one-shot fresh-grant-per-fire migration (src/schedule-migrations.ts): every schedule without a `grant_template`
 * gets one derived from its seed grant whatever the seed's status; only a seed that is missing or unparseable (or yields
 * no template) skips, named in `last_skip`. The marker makes a re-run a no-op.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../src/contracts.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { formatScheduleMigration, scheduleMigrationMarkerPath, sweepScheduleGrantTemplates } from "../src/schedule-migrations.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Ledger } from "../src/ledger.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const T0 = new Date("2026-11-02T08:00:00Z");
const job = { title: "triage", kind: "research", delivery: "answer" };

test("migration derives a template from a revoked, expired or pre-approved seed; a missing or unparseable seed skips with last_skip; the marker makes a re-run a no-op", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const clock = { now: new Date("2026-07-01T00:00:00Z") };
	const mandates = new MandateStore(home.path, { now: () => clock.now });
	const issue = (extra: Partial<Parameters<MandateStore["issue"]>[0]> = {}) => mandates.issue({
		projects: ["demo"], objective: "nightly triage", expiry: "2026-07-03T00:00:00Z", spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 3,
		at: "2026-07-01T00:00:00Z", schedule_grant: true, allowed_actions: ["plan", "implement", "merge"], ...extra,
	});
	const revoked = issue();
	mandates.revoke(revoked.id);
	const expired = issue(); // its expiry is long past at T0
	const preapproved = issue({ risk_preapproval: { operator_quote: "ok", decided_by: "operator-quote", scope: "mandate_jobs", granted_at: "2026-07-01T00:00:00Z" } });
	const skill = issue({ job_cap: 2 });
	const garbled = issue();
	writeFileSync(mandates.file(garbled.id), "{not json");
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	clock.now = T0;
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, usageJobs: () => [], cloneOf: () => home.path, now: () => clock.now, startedAt: T0, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }) });
	const saved = (id: string, mandate_id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, project: "demo", mandate_id, trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, job, enabled: true, created_at: "2026-07-01T00:00:00Z", ...extra });
	writeFileSync(scheduler.file, JSON.stringify({ schema_version: SCHEMA_VERSION, schedules: [
		saved("sch-aaaaa1", revoked.id),
		saved("sch-aaaaa2", expired.id),
		saved("sch-aaaaa3", preapproved.id),
		saved("sch-aaaaa4", skill.id, { trigger: { type: "manual" }, job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" } }),
		saved("sch-aaaaa5", "md-ffffff"),
		saved("sch-aaaaa6", garbled.id),
	] }));

	const report = sweepScheduleGrantTemplates({ home: home.path, mandates, now: T0 });
	assert.equal(report.already_done, false);
	assert.deepEqual(report.migrated.map((entry) => [entry.id, entry.seed]), [["sch-aaaaa1", revoked.id], ["sch-aaaaa2", expired.id], ["sch-aaaaa3", preapproved.id], ["sch-aaaaa4", skill.id]]);
	assert.deepEqual(report.skipped.map((entry) => entry.id), ["sch-aaaaa5", "sch-aaaaa6"]);
	const [a1, a2, a3, a4, a5, a6] = scheduler.list();
	assert.deepEqual([a1?.grant_template?.seed_mandate_id, a1?.grant_template?.job_cap, a1?.grant_template?.allowed_actions], [revoked.id, 3, ["plan", "implement"]], "a revoked seed still yields its bounds");
	assert.deepEqual(a1?.grant_template?.approval, { operator_quote: "nightly triage", decided_by: "operator-delegated", delegation_rule: `schedule migration: the objective of seed grant ${revoked.id}, quoted verbatim`, approved_at: "2026-11-02T08:00:00Z" });
	assert.equal(a2?.grant_template?.expiry_hours, 48);
	assert.match(report.migrated[2]!.notes.join("; "), /risk:high pre-approval is not carried/);
	assert.equal(a4?.grant_template?.job_cap, 8, "a skill template is raised to its fan-out plus anchor");
	assert.match(report.migrated[3]!.notes.join("; "), /job cap raised from 2 to 8/);
	assert.equal(a5?.grant_template, undefined);
	assert.match(a5?.last_skip?.reason ?? "", /^migration: seed grant md-ffffff is missing; no fire grant template, so every fire is refused: cp_schedule move it to a fresh schedule grant$/);
	assert.match(a6?.last_skip?.reason ?? "", new RegExp(`^migration: seed grant ${garbled.id} cannot be parsed`));
	assert.ok(existsSync(scheduleMigrationMarkerPath(home.path)));
	assert.match(formatScheduleMigration(report), /4 migrated, 2 skipped/);

	// The template is derived either way; firing still honours the pointer: an expired seed re-mints, an operator-revoked
	// one stops until the schedule is moved to a fresh schedule grant.
	const fired = await scheduler.fireNow("sch-aaaaa2", "req-1");
	assert.equal(fired.outcome, "fired", fired.reason);
	assert.notEqual(fired.mandate_id, expired.id);
	assert.match((await scheduler.fireNow("sch-aaaaa1", "req-3")).reason, /was revoked; a schedule never re-mints past an operator revoke/);
	await assert.rejects(scheduler.fireNow("sch-aaaaa5", "req-2"), /has no grant template/);

	const before = readFileSync(scheduler.file, "utf8");
	const again = sweepScheduleGrantTemplates({ home: home.path, mandates, now: new Date("2026-11-03T00:00:00Z") });
	assert.deepEqual([again.already_done, again.migrated, again.skipped], [true, [], []]);
	assert.equal(readFileSync(scheduler.file, "utf8"), before, "the marker makes a re-run touch nothing");
	assert.equal(formatScheduleMigration(again), "");
});

test("two pre-rule schedules sharing one seed: each fire mints its own grant and never revokes the seed the other still names", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path, { now: () => T0 });
	const seed = mandates.issue({ projects: ["demo"], objective: "shared", expiry: "2026-12-01T00:00:00Z", spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 3, at: "2026-11-01T00:00:00Z", schedule_grant: true });
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, usageJobs: () => [], cloneOf: () => home.path, now: () => T0, startedAt: T0, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }) });
	const manual = (id: string) => ({ id, name: id, project: "demo", mandate_id: seed.id, trigger: { type: "manual" }, job, enabled: true, created_at: "2026-11-01T00:00:00Z" });
	writeFileSync(scheduler.file, JSON.stringify({ schema_version: SCHEMA_VERSION, schedules: [manual("sch-bbbbb1"), manual("sch-bbbbb2")] }));
	assert.equal(sweepScheduleGrantTemplates({ home: home.path, mandates, now: T0 }).migrated.length, 2);
	const first = await scheduler.fireNow("sch-bbbbb1", "req-1");
	assert.equal(first.outcome, "fired", first.reason);
	assert.equal(mandates.get(seed.id)?.status, "active", "sch-bbbbb2 still names it");
	const second = await scheduler.fireNow("sch-bbbbb2", "req-2");
	assert.equal(second.outcome, "fired", second.reason);
	assert.notEqual(first.mandate_id, second.mandate_id);
	assert.equal(mandates.get(first.mandate_id)?.status, "active", "one schedule's fire never revokes another's fire grant");
	assert.equal(mandates.get(seed.id)?.status, "revoked", "retired once no schedule names it");
});

test("migration with no schedules file writes only the marker", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = sweepScheduleGrantTemplates({ home: home.path, mandates: new MandateStore(home.path), now: T0 });
	assert.deepEqual([report.migrated, report.skipped], [[], []]);
	assert.ok(existsSync(report.marker));
	assert.equal(formatScheduleMigration(report), "");
});
