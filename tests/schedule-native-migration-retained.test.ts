/**
 * Retained from tests/schedule-native-migration.test.ts (P13d): a crash injected after each stage of
 * sweepNativeScheduleMigration resumes to one native revision and the original snapshot; 12-19 pins the rest.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { refused, synthesizedApproval, templateFromSeed } from "../src/schedule-grant.ts";
import { nativeMigrationMarker, sweepNativeScheduleMigration } from "../src/schedule-native-migration.ts";
import { ScheduleRunStore } from "../src/schedule-runs.ts";
import { Scheduler } from "../src/scheduler.ts";
import { readScheduleFile, type Schedule, SCHEDULE_SCHEMA_VERSION } from "../src/viewer/schedule-core.ts";
import { isNativePolicy } from "../src/viewer/schedule-policy.ts";
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

