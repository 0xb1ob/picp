/**
 * One-shot schedule migration (fresh grant per fire): every schedule saved before every fire minted its own grant has
 * no `grant_template`. At session start, once, each such schedule gets one derived from its seed grant's file — its
 * `mandate_id` — whatever that grant's status (active, expired, revoked or cap-paused): the template is bounds, not
 * authority. Only a seed file that is missing or cannot be parsed, or one no template can be derived from (not a
 * schedule grant, job_ids, a zero cap, merge-only), leaves the schedule without one and records why in `last_skip`;
 * its fires are then refused until it is moved to a fresh schedule grant. A skill schedule's job cap is raised to its
 * fan-out plus anchor. The marker `state/.migrations/2026-11-schedule-grant-template.done` makes every later call a no-op.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isoTimestamp, LAYOUT, type Mandate, SCHEMA_VERSION } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";
import type { MandateStore } from "./mandate.ts";
import { refused, synthesizedApproval, templateFromSeed, withSkillJobFloor } from "./schedule-grant.ts";
import { type GrantTemplate, noTemplateReason, readScheduleFile, scheduleFileErrors } from "./viewer/schedule-core.ts";

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
		if (schedule.grant_template) continue;
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
		const doc = { schema_version: SCHEMA_VERSION, schedules };
		const errors = scheduleFileErrors(doc);
		if (errors.length) throw new Error(`schedule migration refused to write an invalid ${file}:\n  ${errors.join("\n  ")}`);
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
