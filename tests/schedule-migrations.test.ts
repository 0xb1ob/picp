/**
 * The one-shot fresh-grant-per-fire migration (src/schedule-migrations.ts): every schedule without a `grant_template`
 * gets one derived from its seed grant whatever the seed's status; only a seed that is missing or unparseable (or yields
 * no template) skips, named in `last_skip`. The marker makes a re-run a no-op.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../src/contracts.ts";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { formatScheduleMigration, formatSchedulePolicyImport, policyImportBackups, scheduleMigrationMarkerPath, sweepScheduleGrantTemplates, sweepSchedulePolicyImport } from "../src/schedule-migrations.ts";
import { ScheduleRunStore } from "../src/schedule-runs.ts";
import { object, oneOf, readScheduleFile, scheduleFileErrors, SchedulerError } from "../src/viewer/schedule-core.ts";
import { policyFromLegacy } from "../src/viewer/schedule-policy.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Ledger } from "../src/ledger.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const T0 = new Date("2026-11-02T08:00:00Z");
const job = { title: "triage", kind: "research", delivery: "answer" } as const;

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
	mandates.revoke(revoked.id, { by: "operator", operator_quote: "revoke the triage seed", decided_by: "operator-quote" });
	const legacy = issue();
	mandates.revoke(legacy.id); // revoked before provenance was recorded: no revoked_by
	const projectWide = issue({ schedule_grant: undefined }); // no template derives from it (accepted A2 narrowing)
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
		saved("sch-aaaaa7", legacy.id),
		saved("sch-aaaaa8", projectWide.id),
	] }));

	const report = sweepScheduleGrantTemplates({ home: home.path, mandates, now: T0 });
	assert.equal(report.already_done, false);
	assert.deepEqual(report.migrated.map((entry) => [entry.id, entry.seed]), [["sch-aaaaa1", revoked.id], ["sch-aaaaa2", expired.id], ["sch-aaaaa3", preapproved.id], ["sch-aaaaa4", skill.id], ["sch-aaaaa7", legacy.id]]);
	assert.deepEqual(report.skipped.map((entry) => entry.id), ["sch-aaaaa5", "sch-aaaaa6", "sch-aaaaa8"]);
	const [a1, a2, a3, a4, a5, a6, , a8] = scheduler.list();
	assert.deepEqual([a1?.grant_template?.seed_mandate_id, a1?.grant_template?.job_cap, a1?.grant_template?.allowed_actions], [revoked.id, 3, ["plan", "implement"]], "a revoked seed still yields its bounds");
	assert.deepEqual(a1?.grant_template?.approval, { operator_quote: "nightly triage", decided_by: "operator-delegated", delegation_rule: `schedule migration: the objective of seed grant ${revoked.id}, quoted verbatim`, approved_at: "2026-11-02T08:00:00Z" });
	assert.equal(a2?.grant_template?.expiry_hours, 48);
	assert.match(report.migrated[2]!.notes.join("; "), /risk:high pre-approval is not carried/);
	assert.equal(a4?.grant_template?.job_cap, 8, "a skill template is raised to its fan-out plus anchor");
	assert.match(report.migrated[3]!.notes.join("; "), /job cap raised from 2 to 8/);
	assert.equal(a5?.grant_template, undefined);
	assert.match(a5?.last_skip?.reason ?? "", /^schedule sch-aaaaa5 has no grant template \(migration: seed grant md-ffffff is missing\), so no fire can mint a fresh grant: cp_schedule move it to a schedule grant to resume$/);
	assert.match(a6?.last_skip?.reason ?? "", new RegExp(`^schedule sch-aaaaa6 has no grant template \\(migration: seed grant ${garbled.id} cannot be parsed`));
	assert.match(a8?.last_skip?.reason ?? "", new RegExp(`^schedule sch-aaaaa8 has no grant template \\(migration: ${projectWide.id} is not a schedule grant\\), so no fire can mint a fresh grant: cp_schedule move it to a schedule grant to resume$`));
	assert.ok(existsSync(scheduleMigrationMarkerPath(home.path)));
	assert.match(formatScheduleMigration(report), /5 migrated, 3 skipped/);

	// The template is derived either way; firing still honours the pointer: an expired seed re-mints, an operator-revoked
	// one (revoked with the operator's quote) stops until the schedule is moved to a fresh schedule grant.
	const fired = await scheduler.fireNow("sch-aaaaa2", "req-1");
	assert.equal(fired.outcome, "fired", fired.reason);
	assert.notEqual(fired.mandate_id, expired.id);
	assert.match((await scheduler.fireNow("sch-aaaaa1", "req-3")).reason, /was revoked by the operator \(operator-quote\); a schedule never re-mints past an operator revoke/);
	// A legacy revoke (no revoked_by) is the safe default: stopped until cp_schedule move.
	assert.match((await scheduler.fireNow("sch-aaaaa7", "req-4")).reason, /was revoked with no recorded provenance \(a legacy revoke\), treated as the operator's; a schedule never re-mints past it: cp_schedule move it/);
	// Every later refusal repeats the migration's reason, a cron tick included: never overwritten, never hidden.
	await assert.rejects(scheduler.fireNow("sch-aaaaa5", "req-2"), /has no grant template \(migration: seed grant md-ffffff is missing\)/);
	clock.now = new Date("2026-11-03T09:00:30Z");
	await scheduler.tick();
	assert.match(scheduler.list()[7]?.last_skip?.reason ?? "", /has no grant template \(migration: .* is not a schedule grant\)/);

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

test("a seed revoked by the parent (revoked_by parent, as cp_mandate revoke with no operator_quote records) migrates and its schedule still fires under a fresh grant", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const mandates = new MandateStore(home.path, { now: () => T0 });
	const seed = mandates.issue({ projects: ["demo"], objective: "triage", expiry: "2026-12-01T00:00:00Z", spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 3, at: "2026-11-01T00:00:00Z", schedule_grant: true });
	mandates.revoke(seed.id, { by: "parent" }); // cp_mandate revoke with no operator_quote: the parent's own revoke
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, usageJobs: () => [], cloneOf: () => home.path, now: () => T0, startedAt: T0, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }) });
	writeFileSync(scheduler.file, JSON.stringify({ schema_version: SCHEMA_VERSION, schedules: [{ id: "sch-ccccc1", name: "triage", project: "demo", mandate_id: seed.id, trigger: { type: "manual" }, job, enabled: true, created_at: "2026-11-01T00:00:00Z" }] }));
	assert.equal(sweepScheduleGrantTemplates({ home: home.path, mandates, now: T0 }).migrated.length, 1);
	const fired = await scheduler.fireNow("sch-ccccc1", "req-1");
	assert.equal(fired.outcome, "fired", fired.reason);
	assert.notEqual(fired.mandate_id, seed.id);
});

test("migration with no schedules file writes only the marker", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = sweepScheduleGrantTemplates({ home: home.path, mandates: new MandateStore(home.path), now: T0 });
	assert.deepEqual([report.migrated, report.skipped], [[], []]);
	assert.ok(existsSync(report.marker));
	assert.equal(formatScheduleMigration(report), "");
});


async function importBench(t: { after(fn: () => void): void }) {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const runs = new ScheduleRunStore({ home: home.path });
	const mandates = new MandateStore(home.path, { runs, now: () => T0 });
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, runs, usageJobs: () => [], cloneOf: () => home.path, now: () => T0, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }) });
	const add = async (name: string, extra: Partial<Parameters<Scheduler["add"]>[0]> = {}, seedExtra: Partial<Parameters<MandateStore["issue"]>[0]> = {}) => {
		const seed = mandates.issue({ projects: ["demo"], objective: name, expiry: "2026-12-01T00:00:00Z", spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 8, dispatch_parallelism: 3, at: "2026-11-01T00:00:00Z", schedule_grant: true, ...seedExtra });
		return scheduler.add({ name, project: "demo", mandate_id: seed.id, manual: true, ...job, ...extra });
	};
	const v1 = () => { const schedules = readScheduleFile(scheduler.file); writeFileSync(scheduler.file, JSON.stringify({ schema_version: 1, schedules })); return readFileSync(scheduler.file); };
	const sweep = () => sweepSchedulePolicyImport({ home: home.path, mandates, runs, now: T0 });
	return { home, ledger, runs, mandates, scheduler, add, v1, sweep };
}

test("P4 v1→v2: backup every rewritten store before policy activation/retirement, exact bytes/0600, marker idempotence and drain/restore rollback", async (t) => {
	const b = await importBench(t), schedule = await b.add("importable");
	// Include an existing inactive policy store so its rewrite must be backed up too.
	await b.runs.savePolicyRevision(policyFromLegacy(schedule, schedule.grant_template!));
	const original = b.v1(), originalPolicy = readFileSync(b.runs.policiesFile), originalGrant = readFileSync(b.mandates.file(schedule.mandate_id!));
	const activate = b.runs.activatePolicy.bind(b.runs);
	b.runs.activatePolicy = async (...args) => {
		const manifest = join(b.home.path, ".pi-command-post", "state", ".migrations", "2026-12-schedule-policy-v2.backup.json");
		assert.ok(existsSync(manifest), "backups are published before activation");
		const rows = JSON.parse(readFileSync(manifest, "utf8")) as Array<{ source: string; backup: string }>;
		for (const [source, bytes] of [[b.scheduler.file, original], [b.runs.policiesFile, originalPolicy], [b.mandates.file(schedule.mandate_id!), originalGrant]] as const) {
			assert.deepEqual(readFileSync(rows.find(r => r.source === source)!.backup), bytes, "snapshot verified before activation");
		}
		return activate(...args);
	};
	const report = await b.sweep();
	assert.deepEqual(report.migrated, [schedule.id]);
	const doc = JSON.parse(readFileSync(b.scheduler.file, "utf8"));
	assert.equal(doc.schema_version, 2); assert.equal(doc.schedules[0].mandate_id, undefined); assert.equal(doc.schedules[0].grant_template, undefined);
	const active = b.runs.activePolicy(schedule.id)!;
	assert.deepEqual(active.limits, { usd: 20, tokens: 2_000_000, child_jobs: 8, parallelism: 3, run_hours: 168 });
	assert.deepEqual(active.approval, schedule.grant_template!.approval); assert.deepEqual(active.ask_on, schedule.grant_template!.ask_on);
	assert.deepEqual(active.exclusions, schedule.grant_template!.exclusions ?? {});
	assert.deepEqual(active.provenance, { channel: "migration", legacy_seed: schedule.grant_template!.seed_mandate_id });
	assert.equal(b.mandates.get(schedule.mandate_id)?.revoked_by?.by, "system");
	for (const backup of report.backups.filter(r => r.backup)) {
		assert.equal(statSync(backup.backup!).mode & 0o777, 0o600);
		assert.equal(createHash("sha256").update(readFileSync(backup.backup!)).digest("hex"), backup.sha256);
	}
	assert.match(report.backups.find(r => r.source === b.scheduler.file)!.backup!, /schedules\.v1\..+\.json$/);
	console.log(formatSchedulePolicyImport(report)); // Actual scratch backup paths/hashes for the PR evidence.
	const before = [b.scheduler.file, b.runs.policiesFile, b.mandates.file(schedule.mandate_id!)].map(f => readFileSync(f));
	const again = await b.sweep(); assert.equal(again.already_done, true); assert.equal(formatSchedulePolicyImport(again), "");
	assert.deepEqual([b.scheduler.file, b.runs.policiesFile, b.mandates.file(schedule.mandate_id!)].map(f => readFileSync(f)), before);
	// Rollback only after disabling and draining; no open run exists in this fixture.
	await b.scheduler.setEnabled(schedule.id, false); assert.equal(b.runs.openRun(schedule.id), undefined);
	for (const backup of report.backups) if (backup.backup) copyFileSync(backup.backup, backup.source); else rmSync(backup.source, { force: true });
	rmSync(report.marker);
	assert.deepEqual(readFileSync(b.scheduler.file), original); assert.deepEqual(readFileSync(b.runs.policiesFile), originalPolicy);
	assert.deepEqual(readFileSync(b.mandates.file(schedule.mandate_id!)), originalGrant);
	assert.deepEqual(b.scheduler.list(), JSON.parse(original.toString()).schedules, "rollback restores the persisted store, including every saved field");
});

test("P4 mixed schedules: pipeline legacy, missing template needs setup, operator revoke/pause preserved, open jobs defer and retry", async (t) => {
	const b = await importBench(t), ok = await b.add("ok"), pipeline = await b.add("pipeline", { delivery: "pipeline" }), missing = await b.add("missing"), stopped = await b.add("stopped"), paused = await b.add("paused"), deferred = await b.add("deferred");
	b.mandates.revoke(stopped.mandate_id!, { by: "operator", operator_quote: "stop it", decided_by: "operator-quote" });
	b.mandates.pause(paused.mandate_id!);
	const open = await b.ledger.create({ title: "old run", project: "demo", kind: "research", delivery: "answer", labels: [`schedule:${deferred.id}`] });
	const rows = b.scheduler.list(); delete rows.find(s => s.id === missing.id)!.grant_template;
	writeFileSync(b.scheduler.file, JSON.stringify({ schema_version: 1, schedules: rows }));
	const report = await b.sweep(); assert.deepEqual(report.migrated, [ok.id]); assert.deepEqual(report.deferred, [deferred.id]); assert.equal(existsSync(report.marker), false);
	assert.equal(b.runs.policyRecord(pipeline.id), undefined); assert.equal(b.runs.policyRecord(missing.id), undefined);
	for (const id of [stopped.id, paused.id]) {
		assert.equal(b.runs.activePolicy(id), undefined); assert.equal(b.runs.policyRecord(id)?.revisions.length, 1);
		assert.equal(b.scheduler.list().find(s => s.id === id)?.enabled, true);
		assert.match(b.scheduler.list().find(s => s.id === id)?.last_skip?.reason ?? "", /operator stop on md-.+ preserved; adopt to resume/);
	}
	assert.equal(b.scheduler.list().find(s => s.id === missing.id)?.last_skip?.reason, "needs setup: no template to import; open the editor");
	assert.match(report.skipped.find(s => s.id === pipeline.id)!.reason, /stays on per-fire grants/);
	await b.ledger.close(open.id, "drained");
	const retry = await b.sweep(); assert.ok(existsSync(retry.marker)); assert.ok(b.runs.activePolicy(deferred.id));
	assert.equal(b.runs.policyRecord(stopped.id)?.revisions.length, 1, "retry does not duplicate stopped revision");
	assert.equal(b.runs.policyRecord(paused.id)?.revisions.length, 1);
	assert.equal(b.mandates.get(paused.mandate_id)?.status, "paused");
	assert.ok(b.scheduler.list().find(s => s.id === pipeline.id)?.grant_template);
});

test("P4 backup failure and damaged retry snapshot fail closed before any store rewrite", async (t) => {
	const b = await importBench(t), s = await b.add("backup-failure"), original = b.v1(), grant = readFileSync(b.mandates.file(s.mandate_id!));
	const dir = join(b.home.path, ".pi-command-post", "state", ".migrations", "backups");
	mkdirSync(join(dir, ".."), { recursive: true }); writeFileSync(dir, "not a directory");
	await assert.rejects(b.sweep(), /EEXIST|ENOTDIR/);
	assert.deepEqual(readFileSync(b.scheduler.file), original); assert.deepEqual(readFileSync(b.mandates.file(s.mandate_id!)), grant); assert.equal(existsSync(b.runs.policiesFile), false);
	rmSync(dir); const backups = policyImportBackups(b.home.path, b.mandates, T0);
	writeFileSync(backups.find(r => r.source === b.scheduler.file)!.backup!, "damaged snapshot");
	await assert.rejects(b.sweep(), /backup verification failed/);
	assert.deepEqual(readFileSync(b.scheduler.file), original); assert.deepEqual(readFileSync(b.mandates.file(s.mandate_id!)), grant); assert.equal(existsSync(b.runs.policiesFile), false);
});

test("P4 crash after activation retries retirement/v2 write with the original snapshot, no duplicate revisions", async (t) => {
	const b = await importBench(t), s = await b.add("crash"), original = b.v1();
	const revoke = b.mandates.revoke.bind(b.mandates);
	b.mandates.revoke = () => { throw new Error("injected crash after activation"); };
	await assert.rejects(b.sweep(), /injected crash/);
	assert.ok(b.runs.activePolicy(s.id)); assert.deepEqual(readFileSync(b.scheduler.file), original);
	b.mandates.revoke = revoke; const retry = await b.sweep();
	assert.deepEqual(readFileSync(retry.backups.find(r => r.source === b.scheduler.file)!.backup!), original);
	assert.equal(b.runs.policyRecord(s.id)?.revisions.length, 1); assert.equal(b.mandates.get(s.mandate_id)?.status, "revoked"); assert.ok(existsSync(retry.marker));
});

test("P4 import keeps dashboard-only org-review clearance under the legacy seed conditions", async (t) => {
	const b = await importBench(t);
	const pre = { operator_quote: "Approve safe org PRs", decided_by: "operator-quote" as const, scope: "mandate_jobs" as const, granted_at: "2026-11-01T00:00:00Z" };
	const cleared = await b.add("cleared", { skill: "cp-org-pr-review", delivery: "local", description: "org: acme\nmax_reviewers: 3" }, { risk_preapproval: pre });
	const plain = await b.add("plain", { skill: "cp-org-pr-review", delivery: "local", description: "org: acme" });
	const stopped = await b.add("stopped seed", { skill: "cp-org-pr-review", delivery: "local", description: "org: acme" }, { risk_preapproval: pre });
	b.mandates.revoke(stopped.mandate_id!, { by: "operator", operator_quote: "stop org", decided_by: "operator-quote" });
	b.v1(); await b.sweep();
	const policy = b.runs.activePolicy(cleared.id)!;
	assert.ok(policy.effects.includes("org_review_approve")); assert.deepEqual(policy.effect_channels.org_review_approve, ["dashboard"]);
	assert.equal(policy.recipe_config?.max_reviewers, 3); assert.equal(policy.limits.parallelism, 3); assert.equal(policy.limits.child_jobs, 8);
	for (const id of [plain.id, stopped.id]) assert.equal(b.runs.policyRecord(id)?.revisions[0]?.effects.includes("org_review_approve"), false);
});

test("P4 v1 reads are pure, v2 legacy fields optional, v1-only contract rejects v2 with SchedulerError", async (t) => {
	const b = await importBench(t); await b.add("reader"); const original = b.v1();
	readScheduleFile(b.scheduler.file); assert.deepEqual(readFileSync(b.scheduler.file), original);
	const doc = JSON.parse(original.toString()); delete doc.schedules[0].mandate_id;
	assert.match(scheduleFileErrors(doc).join(), /mandate_id: is required/);
	doc.schema_version = 2; assert.deepEqual(scheduleFileErrors(doc), []);
	// The frozen v1 file envelope uses oneOf([1]); its reader names a contract failure, rather than guessing.
	const v1Only = object({ schema_version: oneOf([1]), schedules: (_v, _p, _e) => {} });
	const oldReader = (raw: unknown) => { const errors: string[] = []; v1Only(raw, "", errors); if (errors.length) throw new SchedulerError(`schedules.json violates the schedule contract:\n  ${errors.join("\n  ")}`); };
	assert.throws(() => oldReader(doc), e => e instanceof SchedulerError && /violates the schedule contract/.test(e.message));
});
