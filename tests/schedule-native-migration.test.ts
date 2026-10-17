/**
 * T7 (PR4): the native schedule migration (src/schedule-native-migration.ts) converts every legacy schedule — the E9
 * sch-514530 shape and the old grant-backed fixtures — into a native revision with no new grant, defers open runs,
 * resumes after a crash at every stage, and leaves a readable rollback manifest. No fire mints a grant afterwards.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { test } from "node:test";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { refused, synthesizedApproval, templateFromSeed } from "../src/schedule-grant.ts";
import { formatNativeMigration, nativeMigrationMarker, sweepNativeScheduleMigration } from "../src/schedule-native-migration.ts";
import { ScheduleRunStore } from "../src/schedule-runs.ts";
import { Scheduler } from "../src/scheduler.ts";
import { readScheduleFile, type Schedule, SCHEDULE_SCHEMA_VERSION } from "../src/viewer/schedule-core.ts";
import { isNativePolicy, policyFromLegacy, type LegacySchedulePolicy, type NativeSchedulePolicy } from "../src/viewer/schedule-policy.ts";
import { readSchedulePolicies, type ScheduleRun } from "../src/viewer/schedule-run-core.ts";
import type { Ledger } from "../src/ledger.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const T0 = new Date("2026-11-02T08:00:00Z");
const AT = "2026-11-01T00:00:00Z";

function bench(t: { after(fn: () => void): void }) {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo", "picp"], home: home.path }).ledger as Ledger;
	const runs = new ScheduleRunStore({ home: home.path });
	const mandates = new MandateStore(home.path, { runs, now: () => T0 });
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, runs, usageJobs: () => [], cloneOf: () => home.path, now: () => T0, startedAt: T0, mintContext: () => ({ defaults: loadMandateDefaults(home.path), ceiling: 100_000_000 }) });
	const write = (schedules: Schedule[]) => { mkdirSync(dirname(scheduler.file), { recursive: true }); writeFileSync(scheduler.file, JSON.stringify({ schema_version: SCHEDULE_SCHEMA_VERSION, schedules })); };
	let n = 0;
	// A legacy grant-backed row exactly as the pre-PR4 add persisted it (scheduler.add is native-only now).
	const legacy = (name: string, over: Partial<Schedule> = {}, seedExtra: Partial<Parameters<MandateStore["issue"]>[0]> = {}): Schedule => {
		const seed = mandates.issue({ projects: ["demo"], objective: name, expiry: "2026-12-01T00:00:00Z", spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 8, dispatch_parallelism: 3, at: AT, schedule_grant: true, allowed_actions: ["plan", "implement", "merge"], ...seedExtra });
		const job = over.job ?? { title: name, kind: "research", delivery: "answer" };
		const derived = templateFromSeed(seed, synthesizedApproval(seed, "cp_schedule add"), AT, job);
		if (refused(derived)) throw new Error(derived.refusal);
		const schedule: Schedule = { id: `sch-${(0xabc000 + ++n).toString(16)}`, name, project: "demo", mandate_id: seed.id, grant_template: derived.template, trigger: { type: "manual" }, job, enabled: true, created_at: AT, ...over };
		write([...(existsSync(scheduler.file) ? readScheduleFile(scheduler.file) : []), schedule]);
		return schedule;
	};
	const sweep = (now = T0) => sweepNativeScheduleMigration({ home: home.path, mandates, runs, now });
	return { home, ledger, runs, mandates, scheduler, write, legacy, sweep };
}

const closedRun = (policy: LegacySchedulePolicy, id: string, phase: "running" | "closed" = "closed"): ScheduleRun => ({
	schema_version: 1, id, schedule_id: policy.schedule_id, policy_revision: policy.revision, policy, trigger: { via: "cp_schedule", at: AT, tool_call_id: `call-${id}` },
	anchor_job_id: null, members: [], phase, outcome: phase === "closed" ? "completed" : null, started_at: AT, deadline_at: "2026-11-08T00:00:00Z",
	...(phase === "closed" ? { closed_at: "2026-11-01T06:00:00Z" } : {}), risk_preapproved: [], authority_log: [], cap_notices: [],
}) as ScheduleRun;

test("E9: sch-514530 (schema 2, no pointer, active legacy revision 2) becomes native revision 3 with identical scope and caps", async (t) => {
	const b = bench(t);
	const schedule: Schedule = { id: "sch-514530", name: "self-review", project: "picp", trigger: { type: "manual" }, job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" }, enabled: true, created_at: AT };
	b.write([schedule]);
	const rev1 = policyFromLegacy({ ...schedule, mandate_id: "md-514530" }, {
		seed_mandate_id: "md-514530", channel: "operator_chat", objective: "self-review", expiry_hours: 36, spend_usd: 40, spend_tokens: 10_000_000, job_cap: 8,
		allowed_actions: ["plan", "review"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "run the self-review", decided_by: "operator-quote", approved_at: AT },
	});
	const rev2: LegacySchedulePolicy = { ...rev1, revision: 2, limits: { ...rev1.limits, parallelism: 6, run_hours: 168 }, exclusions: { paths: ["secrets/"], job_kinds: ["ship"] },
		model_policy: { mode: "pinned", by_role: { implementer: "openai/gpt-6.1-sol", planner: "openai/gpt-6.1-sol", reviewer: "openai/gpt-6.1-sol" } } };
	await b.runs.savePolicyRevision(rev1);
	await b.runs.savePolicyRevision(rev2, { at: AT, provenance: rev2.provenance });
	await b.runs.createRun(closedRun(rev2, "run-20261101000000-aaaaaa"));
	const runsBefore = readFileSync(b.runs.runsFile);

	const report = await b.sweep();
	assert.deepEqual(report.migrated, [{ id: "sch-514530", revision: 3, active: true }]);
	assert.deepEqual([report.skipped, report.deferred], [[], []]);
	assert.deepEqual(b.mandates.list(), [], "no grant minted");
	const active = b.runs.activePolicy("sch-514530")!;
	assert.ok(isNativePolicy(active));
	assert.deepEqual([active.revision, active.saved_by, active.mode, active.kinds, active.effects], [3, "migration", "report-only", ["research"], ["board_publish"]]);
	assert.deepEqual(active.limits, { usd: 40, tokens: 10_000_000, child_jobs: 8, parallelism: 6, run_hours: 168 });
	for (const key of ["project", "recipe", "recipe_config", "trigger", "exclusions", "model_policy"] as const) assert.deepEqual(active[key], rev2[key], key);
	assert.deepEqual(b.runs.policyRecord("sch-514530")!.revisions.slice(0, 2), [rev1, rev2], "old revisions are kept unchanged");
	assert.deepEqual(readFileSync(b.runs.runsFile), runsBefore, "closed runs are untouched");
	assert.deepEqual(readScheduleFile(b.scheduler.file), [schedule], "id, name, trigger and recipe are preserved");
	assert.match(formatNativeMigration(report), /1 migrated, 0 skipped, 0 deferred[\s\S]*sch-514530: native revision 3 active; no grant minted/);

	// Saved pins are run defaults, not a ceiling: a run now may override them; still no grant.
	const fired = await b.scheduler.fireNow("sch-514530", { via: "cp_schedule", tool_call_id: "call-run", overrides: { model: "anthropic/claude-opus-5-5", parallelism: 5 } });
	assert.equal(fired.outcome, "fired", fired.reason);
	assert.deepEqual(b.runs.openRun("sch-514530")?.execution?.effective, { model: "anthropic/claude-opus-5-5", parallelism: 5 });
	assert.equal(b.runs.openRun("sch-514530")?.policy_revision, 3);
	assert.deepEqual(b.mandates.list(), [], "a native start mints nothing");

	const files = [b.scheduler.file, b.runs.policiesFile].map((f) => readFileSync(f));
	const again = await b.sweep();
	assert.equal(again.already_done, true); assert.equal(formatNativeMigration(again), "");
	assert.deepEqual([b.scheduler.file, b.runs.policiesFile].map((f) => readFileSync(f)), files, "a repeat migration is a no-op");
});

test("old grant-backed fixtures: cron, watch, manual, script, PR, pipeline, disabled, operator stops, broken seeds; nothing fires on a grant", async (t) => {
	const b = bench(t);
	const cron = b.legacy("cron", { trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" } });
	const watch = b.legacy("watch", { trigger: { type: "watch", script_path: "scripts/check.sh", every_seconds: 300, on: "changed" } });
	const manual = b.legacy("manual");
	const script = b.legacy("script", { job: { title: "script", kind: "ship", delivery: "local", script_path: "scripts/job.sh" } });
	const pr = b.legacy("pr", { job: { title: "pr", kind: "ship", delivery: "pr" } });
	const pipeline = b.legacy("pipeline", { job: { title: "pipeline", kind: "research", delivery: "pipeline" } });
	const gated = b.legacy("gated pipeline", { job: { title: "gated", kind: "research", delivery: "pipeline" } }, { ask_on: ["plan_approval", "merge", "risk:high"] });
	const disabled = b.legacy("disabled", { enabled: false });
	const revoked = b.legacy("revoked"), paused = b.legacy("paused");
	const missing = b.legacy("missing"), corrupt = b.legacy("corrupt");
	b.mandates.revoke(revoked.mandate_id!, { by: "operator", operator_quote: "stop it", decided_by: "operator-quote" });
	b.mandates.pause(paused.mandate_id!);
	rmSync(b.mandates.file(missing.mandate_id!));
	writeFileSync(b.mandates.file(corrupt.mandate_id!), "{not json");
	const bare: Schedule = { id: "sch-abcfff", name: "bare", project: "demo", trigger: { type: "manual" }, job: { title: "bare", kind: "research", delivery: "answer" }, enabled: true, created_at: AT };
	b.write([...readScheduleFile(b.scheduler.file), bare]);
	const grants = b.mandates.list().length;

	const report = await b.sweep();
	const converted = [cron, watch, manual, script, pr, pipeline, disabled];
	assert.deepEqual(report.migrated, [...converted.map((s) => ({ id: s.id, revision: 1, active: true })), { id: revoked.id, revision: 1, active: false }, { id: paused.id, revision: 1, active: false }]);
	assert.ok(existsSync(report.marker), "skipped schedules never hold the marker");
	const rows = new Map(readScheduleFile(b.scheduler.file).map((s) => [s.id, s]));
	for (const s of converted) {
		const policy = b.runs.activePolicy(s.id)!;
		assert.ok(isNativePolicy(policy), s.name);
		assert.deepEqual([policy.trigger, policy.recipe.title, policy.limits.usd, policy.limits.child_jobs, policy.limits.parallelism], [s.trigger, s.job.title, 20, 8, 3], s.name);
		assert.deepEqual([rows.get(s.id)?.mandate_id, rows.get(s.id)?.grant_template], [undefined, undefined], s.name);
		assert.equal(b.mandates.get(s.mandate_id)?.revoked_by?.by, "system", `${s.name}: the retired pointer is revoked by the system`);
	}
	assert.deepEqual([(b.runs.activePolicy(pr.id) as NativeSchedulePolicy).mode, b.runs.activePolicy(pipeline.id)!.effects], ["write", ["pipeline", "pull_request"]]);
	assert.equal(rows.get(disabled.id)?.enabled, false, "a disabled schedule stays disabled");
	for (const s of [revoked, paused]) {
		assert.equal(b.runs.activePolicy(s.id), undefined, `${s.name}: an operator stop is never undone`);
		assert.match(rows.get(s.id)?.last_skip?.reason ?? "", /^native migration: operator stop on md-.+ preserved: native revision 1 is saved, adopt it to resume$/);
	}
	assert.equal(b.mandates.get(paused.mandate_id)?.status, "paused");
	const reasons = new Map(report.skipped.map((s) => [s.id, s.reason]));
	assert.match(reasons.get(gated.id)!, /^needs scope edit: the legacy grant asked for plan approval before implementing/);
	assert.match(reasons.get(missing.id)!, /^needs setup: seed grant md-.+ is missing; no authority is inferred$/);
	assert.match(reasons.get(corrupt.id)!, /^needs setup: a legacy grant of sch-.+ is unreadable/);
	assert.match(reasons.get(bare.id)!, /^needs setup: no saved policy or grant template/);
	assert.ok(rows.get(gated.id)?.grant_template, "a skipped schedule keeps its legacy rows readable");

	const refusedFire = await b.scheduler.fireNow(missing.id, { via: "cp_schedule", tool_call_id: "call-missing" });
	assert.equal(refusedFire.outcome, "skipped");
	assert.match(refusedFire.reason, /^run now not recorded: native migration: needs setup: seed grant/);
	assert.equal((await b.scheduler.fireNow(cron.id, { via: "cp_schedule", tool_call_id: "call-cron" })).outcome, "fired");
	assert.equal(b.mandates.list().length, grants, "neither a refused nor a native fire mints a grant");
});

test("a migration-skipped schedule saved natively later keeps no grant pointer, template or migration skip", async (t) => {
	// Review 2 of PR4a: the marker is written past skips, so no later sweep heals the row; the native save must.
	const b = bench(t);
	const gated = b.legacy("gated", { job: { title: "gated", kind: "research", delivery: "pipeline" } }, { ask_on: ["plan_approval", "merge", "risk:high"] });
	assert.equal((await b.sweep()).skipped.length, 1);
	const draft = policyFromLegacy(gated, gated.grant_template!, b.mandates.get(gated.mandate_id)!);
	const saved = await b.scheduler.savePolicy(gated.id, draft, { saved_by: "operator-quote", provenance: { channel: "cp_schedule", tool_call_id: "tool", quote_sha: "123456abcdef" } }, 0);
	assert.ok(isNativePolicy(b.runs.activePolicy(gated.id)!), `active ${saved.active_revision}`);
	const row = readScheduleFile(b.scheduler.file)[0]!;
	assert.deepEqual([row.mandate_id, row.grant_template, row.last_skip], [undefined, undefined, undefined]);
	assert.equal(b.mandates.get(gated.mandate_id)?.status, "revoked", "the retired pointer is revoked");
});

test("an open legacy run or job defers its schedule under its original authority; a later sweep converts it and writes the marker", async (t) => {
	const b = bench(t);
	const byRun = b.legacy("open run"), byJob = b.legacy("open job"), ready = b.legacy("ready");
	const frozen = policyFromLegacy(byRun, byRun.grant_template!);
	await b.runs.savePolicyRevision(frozen);
	await b.runs.createRun(closedRun(frozen, "run-20261101000000-bbbbbb", "running"));
	const job = await b.ledger.create({ title: "old fire", project: "demo", kind: "research", delivery: "answer", labels: [`schedule:${byJob.id}`] });

	const first = await b.sweep();
	assert.deepEqual([first.migrated.map((m) => m.id), first.deferred], [[ready.id], [byRun.id, byJob.id]]);
	assert.equal(existsSync(first.marker), false, "a deferred schedule holds the marker back");
	assert.equal(b.mandates.get(byRun.mandate_id)?.status, "active", "a deferred pointer is not retired");
	assert.match(formatNativeMigration(first), /open legacy run or job; continues under its original authority, migrates once drained/);
	const blocked = await b.scheduler.fireNow(byJob.id, { via: "cp_schedule", tool_call_id: "call-blocked" });
	assert.match(blocked.reason, new RegExp(`legacy run ${job.id} is still open: it continues under its original authority`));

	await b.runs.closeRun("run-20261101000000-bbbbbb", "completed", "2026-11-02T07:00:00Z");
	await b.ledger.close(job.id, "drained");
	const retry = await b.sweep(new Date("2026-11-02T09:00:00Z"));
	assert.deepEqual(retry.migrated.map((m) => [m.id, m.revision]), [[byRun.id, 2], [byJob.id, 1]], "the converted revision follows the frozen legacy one");
	assert.ok(existsSync(retry.marker));
	assert.deepEqual(b.runs.run("run-20261101000000-bbbbbb")?.policy, frozen, "the old run keeps its original authority");
	assert.deepEqual(retry.backups.map((r) => r.sha256), first.backups.map((r) => r.sha256).concat(retry.backups.slice(first.backups.length).map((r) => r.sha256)), "the first snapshot is never replaced");
});

for (const stage of ["backup", "save", "activation", "retirement"] as const) {
	test(`a crash after the ${stage} stage resumes to the same end state with one native revision and the original snapshot`, async (t) => {
		const b = bench(t), s = b.legacy(stage);
		const original = readFileSync(b.scheduler.file), grant = readFileSync(b.mandates.file(s.mandate_id!));
		const crash = () => { throw new Error(`injected crash after ${stage}`); };
		const save = b.runs.savePolicyRevision.bind(b.runs), activate = b.runs.activatePolicy.bind(b.runs), revoke = b.mandates.revoke.bind(b.mandates);
		if (stage === "backup") b.runs.savePolicyRevision = async () => crash();
		if (stage === "save") b.runs.savePolicyRevision = async (...args) => { await save(...args); return crash(); };
		if (stage === "activation") b.runs.activatePolicy = async (...args) => { await activate(...args); return crash(); };
		if (stage === "retirement") b.mandates.revoke = (...args) => { revoke(...args); return crash(); };
		await assert.rejects(b.sweep(), new RegExp(`injected crash after ${stage}`));
		assert.deepEqual(readFileSync(b.scheduler.file), original, "the schedule row is rewritten last");
		assert.equal(existsSync(nativeMigrationMarker(b.home.path)), false);
		Object.assign(b.runs, { savePolicyRevision: save, activatePolicy: activate }); b.mandates.revoke = revoke;

		const retry = await b.sweep(new Date("2026-11-02T08:05:00Z"));
		assert.ok(existsSync(retry.marker));
		const record = b.runs.policyRecord(s.id)!;
		assert.deepEqual([record.revisions.length, record.active_revision, isNativePolicy(record.revisions[0])], [1, 1, true], "no duplicate revision");
		assert.equal(b.mandates.get(s.mandate_id)?.revoked_by?.by, "system");
		assert.deepEqual([readScheduleFile(b.scheduler.file)[0]?.mandate_id, readScheduleFile(b.scheduler.file)[0]?.grant_template], [undefined, undefined]);
		const snapshot = (source: string) => readFileSync(retry.backups.find((r) => r.source === source)!.backup!);
		assert.deepEqual([snapshot(b.scheduler.file), snapshot(b.mandates.file(s.mandate_id!))], [original, grant], "the snapshot is the pre-migration state");
	});
}

test("the rollback manifest is verified 0600 bytes; restoring it gives readable pre-migration stores", async (t) => {
	const b = bench(t), s = b.legacy("rollback");
	const before = new Map([b.scheduler.file, b.mandates.file(s.mandate_id!)].map((f) => [f, readFileSync(f)]));
	const report = await b.sweep();
	const manifest = JSON.parse(readFileSync(report.marker.replace(/\.done$/, ".backup.json"), "utf8")) as typeof report.backups;
	assert.deepEqual(manifest, report.backups);
	for (const row of manifest.filter((r) => r.backup)) {
		assert.equal(statSync(row.backup!).mode & 0o777, 0o600);
		assert.equal(createHash("sha256").update(readFileSync(row.backup!)).digest("hex"), row.sha256);
	}
	assert.deepEqual(manifest.filter((r) => !r.backup).map((r) => r.source).sort(), [b.runs.policiesFile, b.runs.runsFile].sort(), "absent stores are named");
	for (const row of manifest) if (row.backup) copyFileSync(row.backup, row.source); else rmSync(row.source, { force: true });
	rmSync(report.marker);
	for (const [file, bytes] of before) assert.deepEqual(readFileSync(file), bytes);
	assert.equal(readScheduleFile(b.scheduler.file)[0]?.grant_template?.seed_mandate_id, s.mandate_id, "the restored legacy row reads");
	assert.equal(b.mandates.get(s.mandate_id)?.status, "active");
	assert.equal(existsSync(b.runs.policiesFile) ? readSchedulePolicies(b.runs.policiesFile).length : 0, 0);
});
