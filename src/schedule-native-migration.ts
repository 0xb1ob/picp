/**
 * Schedules refactor PR4: each legacy schedule gains a native revision with no grant or ask (docs/contracts.md,
 * *Native schedule migration*): verified backups first, open work deferred, marker once nothing is deferred.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isoTimestamp, LAYOUT, type Mandate } from "./contracts.ts";
import { atomicWriteJson, atomicWriteText, queued } from "./json-store.ts";
import { readJobsDocument } from "./ledger.ts";
import type { MandateStore } from "./mandate.ts";
import { policyImportBackups, type ScheduleImportBackup } from "./schedule-migrations.ts";
import type { ScheduleRunStore } from "./schedule-runs.ts";
import { operatorStop, readScheduleFile, type Schedule, SCHEDULE_SCHEMA_VERSION, scheduleFileErrors, SchedulerError } from "./viewer/schedule-core.ts";
import { isNativePolicy, nativePolicyDraft, policyFromLegacy, schedulePolicyErrors, type LegacySchedulePolicy, type NativeSchedulePolicy } from "./viewer/schedule-policy.ts";

export const SCHEDULE_NATIVE_MIGRATION = "2027-01-schedule-native";
/** Every skip reason starts with this, so a fire's refusal can quote it back (`nativeMigrationReason`). */
export const NATIVE_MIGRATION_PREFIX = "native migration: ";

export interface NativeMigrationReport {
	marker: string; already_done: boolean; backups: ScheduleImportBackup[];
	migrated: Array<{ id: string; revision: number; active: boolean }>; skipped: Array<{ id: string; reason: string }>; deferred: string[];
}

export const nativeMigrationMarker = (home: string): string => join(home, LAYOUT.migrationsDir, `${SCHEDULE_NATIVE_MIGRATION}.done`);

/** The migration's saved reason for a schedule left off native authority, as a fire quotes it. */
export const nativeMigrationReason = (schedule: Schedule): string | undefined => schedule.last_skip?.reason.match(/native migration: .*/)?.[0];

/** Converts only what the legacy revision demonstrably authorized; anything wider needs one explicit operator edit. */
export function nativeFromLegacy(legacy: LegacySchedulePolicy, revision: number, at: string): NativeSchedulePolicy | { refusal: string } {
	const needs = (why: string) => ({ refusal: `needs scope edit: ${why}; save a native policy in the editor` });
	const { recipe } = legacy;
	if (legacy.effects.includes("org_review_approve")) return needs("its org-review approval was cleared for dashboard starts only and is never widened to every start");
	if (recipe.delivery === "pipeline" && recipe.kind !== "research") return needs("a native pipeline's anchor is its research stage");
	const actions = recipe.delivery === "pipeline" ? ["plan", "implement"] : [recipe.kind === "research" ? "plan" : "implement"];
	const missing = actions.filter((action) => !(legacy.allowed_actions as readonly string[]).includes(action));
	if (missing.length) return needs(`the legacy grant never allowed ${missing.join(", ")}`);
	if (actions.includes("implement") && legacy.ask_on.includes("plan_approval")) return needs("the legacy grant asked for plan approval before implementing");
	const seed = legacy.provenance.legacy_seed;
	const policy = nativePolicyDraft(
		{ schedule_id: legacy.schedule_id, project: legacy.project, recipe, recipe_config: legacy.recipe_config, trigger: legacy.trigger, limits: legacy.limits, model_policy: legacy.model_policy, exclusions: legacy.exclusions },
		{ revision, saved_at: at, saved_by: "migration", provenance: { channel: "migration", ...(seed ? { legacy_seed: seed } : {}), delegation_rule: `native migration of revision ${legacy.revision}` } },
	);
	const errors = schedulePolicyErrors(policy);
	return errors.length ? needs(errors.join("; ")) : policy;
}

type Plan = { schedule: Schedule; policy?: NativeSchedulePolicy; reuse?: boolean; stopped?: string; reason?: string; heal?: true };

/** Startup and tick-retry entry point: validates every input before any write; idempotent and crash-resumable. */
export function sweepNativeScheduleMigration(options: { home: string; mandates: MandateStore; runs: ScheduleRunStore; now?: Date }): Promise<NativeMigrationReport> {
	const file = join(options.home, LAYOUT.state, "schedules.json");
	return queued(file, async () => {
		const { home, mandates, runs } = options;
		const marker = nativeMigrationMarker(home);
		const report: NativeMigrationReport = { marker, already_done: existsSync(marker), backups: [], migrated: [], skipped: [], deferred: [] };
		if (report.already_done) return report;
		if (!runs.active) throw new SchedulerError("native schedule migration requires active run stores; nothing written");
		const schedules = readScheduleFile(file), now = options.now ?? new Date(), at = isoTimestamp(now);
		// A missing or unreadable ledger is never proof of drain: it throws before anything is written.
		const all = runs.runs(), jobs = schedules.length ? readJobsDocument(home).jobs : [];
		const plans: Plan[] = [];
		for (const schedule of schedules) {
			const active = runs.activePolicy(schedule.id);
			if (isNativePolicy(active)) {
				if (schedule.mandate_id || schedule.grant_template || nativeMigrationReason(schedule)) plans.push({ schedule, heal: true });
				continue;
			}
			if (all.some((run) => run.schedule_id === schedule.id && run.phase !== "closed") || jobs.some((job) => job.status !== "closed" && job.labels.includes(`schedule:${schedule.id}`))) {
				report.deferred.push(schedule.id);
				continue;
			}
			plans.push(plan(schedule, active, runs, mandates, at));
		}
		// An unchanged skip is not rewritten, so a tick retry with nothing new writes and backs up nothing.
		const writes = plans.filter((entry) => entry.policy || entry.heal || !entry.schedule.last_skip?.reason.includes(entry.reason ?? ""));
		if (writes.length) {
			const extra = [runs.runsFile, ...new Set(schedules.flatMap((s) => s.grant_template ? [mandates.file(s.grant_template.seed_mandate_id)] : []))];
			report.backups = policyImportBackups(home, mandates, now, { name: SCHEDULE_NATIVE_MIGRATION, extra });
		}
		for (const entry of writes) {
			const { schedule } = entry;
			if (entry.reason) {
				schedule.last_skip = { at: now.toISOString(), reason: `${NATIVE_MIGRATION_PREFIX}${entry.reason}` };
				report.skipped.push({ id: schedule.id, reason: entry.reason });
				continue;
			}
			if (entry.policy) {
				if (!entry.reuse) await runs.savePolicyRevision(entry.policy);
				if (!entry.stopped) await runs.activatePolicy(schedule.id, entry.policy.revision, at, entry.policy.provenance);
				report.migrated.push({ id: schedule.id, revision: entry.policy.revision, active: !entry.stopped });
				if (entry.stopped) {
					const reason = `operator stop on ${schedule.mandate_id} preserved: native revision ${entry.policy.revision} is saved, adopt it to resume`;
					schedule.last_skip = { at: now.toISOString(), reason: `${NATIVE_MIGRATION_PREFIX}${reason}` };
					report.skipped.push({ id: schedule.id, reason });
					continue;
				}
			}
			// Retire the legacy pointer last: a crash before it heals on the next sweep; a shared pointer is never revoked.
			const pointer = safeGet(mandates, schedule.mandate_id);
			if (pointer && (pointer.status === "active" || pointer.status === "paused") && !schedules.some((s) => s.id !== schedule.id && s.mandate_id === pointer.id)) mandates.revoke(pointer.id, { by: "system" });
			delete schedule.mandate_id;
			delete schedule.grant_template;
			delete schedule.last_skip;
		}
		if (writes.length && existsSync(file)) {
			const doc = { schema_version: SCHEDULE_SCHEMA_VERSION, schedules };
			const errors = scheduleFileErrors(doc);
			if (errors.length) throw new SchedulerError(`invalid native schedule migration: ${errors.join("; ")}`);
			atomicWriteJson(file, doc, { mode: 0o600, syncDir: true });
		}
		if (!report.deferred.length) atomicWriteText(marker, `${at}\n`, { mode: 0o600, syncDir: true });
		return report;
	});
}

function safeGet(mandates: MandateStore, id: string | undefined): Mandate | undefined {
	try { return mandates.get(id); } catch { return undefined; }
}

/** One drained schedule's conversion, or why it stays off native authority (pure; no writes). */
function plan(schedule: Schedule, active: LegacySchedulePolicy | undefined, runs: ScheduleRunStore, mandates: MandateStore, at: string): Plan {
	let legacy = active, stopped: string | undefined;
	if (!legacy) {
		const template = schedule.grant_template;
		if (!template) return { schedule, reason: "needs setup: no saved policy or grant template; save a native policy in the editor" };
		let seed: Mandate | undefined, pointer: Mandate | undefined;
		try { seed = mandates.get(template.seed_mandate_id); pointer = mandates.get(schedule.mandate_id); }
		catch (error) { return { schedule, reason: `needs setup: a legacy grant of ${schedule.id} is unreadable (${(error as Error).message}); no authority is inferred` }; }
		if (!seed) return { schedule, reason: `needs setup: seed grant ${template.seed_mandate_id} is missing; no authority is inferred` };
		stopped = operatorStop(pointer);
		legacy = policyFromLegacy(schedule, template, seed);
	}
	const latest = runs.policyRecord(schedule.id)?.revisions.at(-1);
	const converted = nativeFromLegacy(legacy, (latest?.revision ?? 0) + 1, at);
	if ("refusal" in converted) return { schedule, reason: converted.refusal };
	// Resume a crash after the save: the same conversion is already the latest revision.
	const same = (policy: unknown) => JSON.stringify({ ...(policy as object), revision: 0, saved_at: "" });
	if (latest && isNativePolicy(latest) && latest.saved_by === "migration" && same(latest) === same({ ...converted, provenance: latest.provenance })) {
		return { schedule, policy: latest, reuse: true, ...(stopped ? { stopped } : {}) };
	}
	return { schedule, policy: converted, ...(stopped ? { stopped } : {}) };
}

/** One notice line per converted, skipped or deferred schedule; empty when there was nothing to say. */
export function formatNativeMigration(report: NativeMigrationReport): string {
	if (report.already_done || (!report.migrated.length && !report.skipped.length && !report.deferred.length)) return "";
	return [
		`pi-command-post: native schedule migration (${report.migrated.length} migrated, ${report.skipped.length} skipped, ${report.deferred.length} deferred)`,
		...report.backups.map((b) => `  backup ${b.source}: ${b.backup ? `${b.backup} (sha256 ${b.sha256}, verified 0600)` : "absent before migration"}`),
		...report.migrated.filter((m) => m.active).map((m) => `  ${m.id}: native revision ${m.revision} active; no grant minted`),
		...report.skipped.map((s) => `  ${s.id}: ${s.reason}`),
		...report.deferred.map((id) => `  ${id}: open legacy run or job; continues under its original authority, migrates once drained`),
	].join("\n");
}
