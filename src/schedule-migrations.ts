/**
 * One-shot schedule migration (fresh grant per fire): every schedule saved before every fire minted its own grant has
 * no `grant_template`. At session start, once, each such schedule gets one derived from its seed grant's file — its
 * `mandate_id` — whatever that grant's status (active, expired, revoked or cap-paused): the template is bounds, not
 * authority. Only a seed file that is missing or cannot be parsed, or one no template can be derived from (not a
 * schedule grant, job_ids, a zero cap, merge-only), leaves the schedule without one and records why in `last_skip`;
 * its fires are then refused until it is moved to a fresh schedule grant. A skill schedule's job cap is raised to its
 * fan-out plus anchor. The marker `state/.migrations/2026-11-schedule-grant-template.done` makes every later call a no-op.
 */

import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isoTimestamp, LAYOUT, type Mandate } from "./contracts.ts";
import { atomicWriteJson, atomicWriteText, queued } from "./json-store.ts";
import { readJobsDocument } from "./ledger.ts";
import type { ScheduleRunStore } from "./schedule-runs.ts";
import { policyFromLegacy, schedulePolicyErrors, type SchedulePolicy } from "./viewer/schedule-policy.ts";
import type { MandateStore } from "./mandate.ts";
import { refused, synthesizedApproval, templateFromSeed, withSkillJobFloor } from "./schedule-grant.ts";
import { type GrantTemplate, noTemplateReason, operatorStop, readScheduleFile, SCHEDULE_SCHEMA_VERSION, scheduleFileErrors, SchedulerError } from "./viewer/schedule-core.ts";

export const SCHEDULE_TEMPLATE_MIGRATION_MARKER = "2026-11-schedule-grant-template.done";

export interface ScheduleMigrationReport {
	marker: string;
	already_done: boolean;
	migrated: Array<{ id: string; seed: string; notes: string[] }>;
	skipped: Array<{ id: string; reason: string }>;
}

export function scheduleMigrationMarkerPath(home: string): string {
	return join(home, LAYOUT.migrationsDir, SCHEDULE_TEMPLATE_MIGRATION_MARKER);
}

/** Why `seed` yields no template, or its template and notes. */
function derive(id: string, seed: Mandate | undefined, at: string): { template: GrantTemplate; notes: string[] } | { refusal: string } {
	if (!seed) return { refusal: `seed grant ${id} is missing` };
	// A pre-approval is never carried into a template; at migration it is dropped and named rather than skipping the schedule.
	const { risk_preapproval, ...bounds } = seed;
	const derived = templateFromSeed(bounds, synthesizedApproval(seed, "schedule migration"), at);
	if (refused(derived)) return derived;
	return { template: derived.template, notes: risk_preapproval ? [...derived.notes, "the seed's risk:high pre-approval is not carried: a fire grant always asks for risk:high"] : derived.notes };
}

/** Run the migration once; idempotent by the marker. A schedules file that does not validate throws (nothing written). */
export function sweepScheduleGrantTemplates(options: { home: string; mandates: MandateStore; now?: Date }): ScheduleMigrationReport {
	const marker = scheduleMigrationMarkerPath(options.home);
	if (existsSync(marker)) return { marker, already_done: true, migrated: [], skipped: [] };
	const file = join(options.home, LAYOUT.state, "schedules.json");
	const schedules = readScheduleFile(file);
	const now = options.now ?? new Date();
	const at = isoTimestamp(now);
	const report: ScheduleMigrationReport = { marker, already_done: false, migrated: [], skipped: [] };
	for (const schedule of schedules) {
		if (schedule.grant_template || !schedule.mandate_id) continue;
		let seed: Mandate | undefined;
		let unreadable = "";
		try {
			seed = options.mandates.get(schedule.mandate_id);
		} catch (error) {
			unreadable = `seed grant ${schedule.mandate_id} cannot be parsed (${(error as Error).message})`;
		}
		const derived = unreadable ? { refusal: unreadable } : derive(schedule.mandate_id, seed, at);
		if ("refusal" in derived) {
			const reason = noTemplateReason(schedule.id, `migration: ${derived.refusal}`);
			schedule.last_skip = { at: now.toISOString(), reason };
			report.skipped.push({ id: schedule.id, reason });
			continue;
		}
		const floored = withSkillJobFloor(derived.template, schedule.job);
		schedule.grant_template = floored.template;
		report.migrated.push({ id: schedule.id, seed: schedule.mandate_id, notes: [...derived.notes, ...(floored.note ? [floored.note] : [])] });
	}
	if (report.migrated.length || report.skipped.length) {
		const doc = { schema_version: SCHEDULE_SCHEMA_VERSION, schedules };
		const errors = scheduleFileErrors(doc);
		if (errors.length) throw new Error(`schedule migration refused to write an invalid ${file}:\n  ${errors.join("\n  ")}`);
		policyImportBackups(options.home, options.mandates, now);
		atomicWriteJson(file, doc);
	}
	mkdirSync(join(options.home, LAYOUT.migrationsDir), { recursive: true });
	writeFileSync(marker, `${now.toISOString()}\n`);
	return report;
}

/** One notice line per migrated or skipped schedule; empty when there was nothing to say. */
export function formatScheduleMigration(report: ScheduleMigrationReport): string {
	if (report.already_done || (!report.migrated.length && !report.skipped.length)) return "";
	return [
		`pi-command-post: schedules migrated to a fresh grant per fire (${report.migrated.length} migrated, ${report.skipped.length} skipped)`,
		...report.migrated.map((entry) => `  ${entry.id}: template from ${entry.seed}${entry.notes.length ? ` — ${entry.notes.join("; ")}` : ""}`),
		...report.skipped.map((entry) => `  ${entry.id}: ${entry.reason}`),
	].join("\n");
}

export const SCHEDULE_POLICY_IMPORT_MARKER = "2026-12-schedule-policy-v2.done";
export interface ScheduleImportBackup { source: string; backup: string | null; sha256: string | null }
export interface SchedulePolicyImportReport {
	marker: string; already_done: boolean; backups: ScheduleImportBackup[];
	migrated: string[]; skipped: Array<{ id: string; reason: string }>; deferred: string[];
}

/** A persistent rollback snapshot: retries verify the original bytes, never replace them with partial imports. */
export function policyImportBackups(home: string, mandates: MandateStore, now: Date): ScheduleImportBackup[] {
	const dir = join(home, LAYOUT.migrationsDir, "backups");
	const manifest = join(home, LAYOUT.migrationsDir, "2026-12-schedule-policy-v2.backup.json");
	let rows: ScheduleImportBackup[] = [];
	if (existsSync(manifest)) {
		const raw = JSON.parse(readFileSync(manifest, "utf8"));
		if (!Array.isArray(raw) || raw.some((r) => !r || typeof r.source !== "string" || (r.backup === null ? r.sha256 !== null : typeof r.backup !== "string" || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)))) throw new SchedulerError(`invalid schedule import backup manifest ${manifest}`);
		rows = raw;
	}
	const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
	for (const row of rows) {
		if (row.backup && (hash(row.backup) !== row.sha256 || (statSync(row.backup).mode & 0o777) !== 0o600)) throw new SchedulerError(`schedule import backup verification failed: ${row.backup}`);
	}
	const file = join(home, LAYOUT.state, "schedules.json");
	const sources = [file, join(home, LAYOUT.state, "schedule-policies.json"), ...new Set(readScheduleFile(file).flatMap(s => s.mandate_id ? [mandates.file(s.mandate_id)] : []))];
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const source of sources) {
		if (rows.some(r => r.source === source)) continue;
		if (!existsSync(source)) { rows.push({ source, backup: null, sha256: null }); continue; }
		const name = source === file ? `schedules.v${JSON.parse(readFileSync(source, "utf8")).schema_version}` : source.split("/").at(-1)!.replace(/\.json$/, "");
		const backup = join(dir, `${name}.${now.toISOString()}.json`);
		const sha256 = hash(source);
		// Exclusive create: a crash before the manifest must not overwrite a recoverable snapshot.
		if (!existsSync(backup)) copyFileSync(source, backup, constants.COPYFILE_EXCL);
		chmodSync(backup, 0o600);
		const fd = openSync(backup, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
		if (hash(backup) !== sha256) throw new SchedulerError(`schedule import backup verification failed: ${backup}`);
		rows.push({ source, backup, sha256 });
	}
	atomicWriteJson(manifest, rows, { mode: 0o600, syncDir: true });
	return rows;
}

/** Startup only, before ticks: no live adoption by the implementer. Every destructive store write follows backup verification. */
export function sweepSchedulePolicyImport(options: { home: string; mandates: MandateStore; runs: ScheduleRunStore; now?: Date }): Promise<SchedulePolicyImportReport> {
	const file = join(options.home, LAYOUT.state, "schedules.json");
	return queued(file, async () => {
		const { home, mandates, runs } = options;
		const marker = join(home, LAYOUT.migrationsDir, SCHEDULE_POLICY_IMPORT_MARKER);
		const report: SchedulePolicyImportReport = { marker, already_done: existsSync(marker), backups: [], migrated: [], skipped: [], deferred: [] };
		if (report.already_done) return report;
		if (!runs.active) throw new SchedulerError("schedule policy import requires active run stores; nothing written");
		const schedules = readScheduleFile(file), now = options.now ?? new Date(), at = isoTimestamp(now);
		// Validate both stores and the ledger before making any authority change. A missing ledger is not proof of drain.
		runs.runs();
		const jobs = schedules.length ? readJobsDocument(home).jobs : [];
		const candidates = new Map<string, SchedulePolicy>();
		for (const schedule of schedules) {
			const record = runs.policyRecord(schedule.id);
			if (record?.active_revision != null || schedule.job.delivery === "pipeline" || !schedule.grant_template) continue;
			if (jobs.some(j => j.status !== "closed" && j.labels.includes(`schedule:${schedule.id}`))) continue;
			const policy = policyFromLegacy(schedule, schedule.grant_template, mandates.get(schedule.grant_template.seed_mandate_id));
			policy.revision = (record?.revisions.at(-1)?.revision ?? 0) + 1;
			policy.saved_at = at;
			const errors = schedulePolicyErrors(policy);
			if (errors.length) throw new SchedulerError(`schedule policy import refused for ${schedule.id}: ${errors.join("; ")}`);
			candidates.set(schedule.id, policy);
		}
		report.backups = policyImportBackups(home, mandates, now);
		for (const schedule of schedules) {
			if (!runs.activePolicy(schedule.id)) {
				if (schedule.job.delivery === "pipeline") { report.skipped.push({ id: schedule.id, reason: "stays on per-fire grants" }); continue; }
				if (jobs.some(j => j.status !== "closed" && j.labels.includes(`schedule:${schedule.id}`)) || runs.openRun(schedule.id)) { report.deferred.push(schedule.id); continue; }
				let reason: string | undefined;
				if (!schedule.grant_template) reason = "needs setup: no template to import; open the editor";
				else {
					const policy = candidates.get(schedule.id)!;
					const latest = runs.policyRecord(schedule.id)?.revisions.at(-1);
					// Resume a crash after save without appending the same revision again.
					const imported = latest?.saved_by === "migration" && JSON.stringify({ ...latest, revision: 0, saved_at: "" }) === JSON.stringify({ ...policy, revision: 0, saved_at: "" }) ? latest : policy;
					if (imported === policy) await runs.savePolicyRevision(policy);
					if (operatorStop(mandates.get(schedule.mandate_id))) reason = `operator stop on ${schedule.mandate_id} preserved; adopt to resume`;
					else await runs.activatePolicy(schedule.id, imported.revision, at, imported.provenance);
				}
				if (reason) { schedule.last_skip = { at, reason }; report.skipped.push({ id: schedule.id, reason }); continue; }
			}
			// Heal an activation interrupted before retirement; another schedule's pointer is never retired.
			const pointer = mandates.get(schedule.mandate_id);
			if (pointer && (pointer.status === "active" || pointer.status === "paused") && !schedules.some(s => s.id !== schedule.id && s.mandate_id === pointer.id)) mandates.revoke(pointer.id, { by: "system" });
			delete schedule.mandate_id;
			delete schedule.grant_template;
			delete schedule.last_skip;
			report.migrated.push(schedule.id);
		}
		if (existsSync(file)) {
			const doc = { schema_version: SCHEDULE_SCHEMA_VERSION, schedules };
			const errors = scheduleFileErrors(doc);
			if (errors.length) throw new SchedulerError(`invalid schedule import: ${errors.join("; ")}`);
			atomicWriteJson(file, doc, { mode: 0o600, syncDir: true });
		}
		if (!report.deferred.length) atomicWriteText(marker, `${at}\n`, { mode: 0o600, syncDir: true });
		return report;
	});
}

export function formatSchedulePolicyImport(report: SchedulePolicyImportReport): string {
	if (report.already_done) return "";
	return [
		`pi-command-post: schedule policy v2 import (${report.migrated.length} migrated, ${report.skipped.length} skipped, ${report.deferred.length} deferred)`,
		...report.backups.map(b => `  backup ${b.source}: ${b.backup ? `${b.backup} (sha256 ${b.sha256}, verified 0600)` : "absent before import"}`),
		...report.migrated.map(id => `  ${id}: policy active; no grant minted`),
		...report.skipped.map(s => `  ${s.id}: ${s.reason}`),
		...report.deferred.map(id => `  ${id}: open legacy/run job; retry next session start`),
	].join("\n");
}
