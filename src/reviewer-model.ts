/** Reviewer preference selection only; permission and capability checks stay at their existing boundaries. */
import { type FleetRecord, isoTimestamp, type ThinkingLevel } from "./contracts.ts";
import { grantStanding } from "./mandate-permission.ts";
import { scheduleScope } from "./mandate-accounting.ts";
import type { MandateStore } from "./mandate.ts";
import type { ProjectRegistry } from "./projects.ts";
import { nativeRunOf, runModelFor } from "./schedule-native.ts";
import type { ScheduleRunStore } from "./schedule-runs.ts";

export interface ReviewerModelSelection {
	model?: string;
	source: "explicit" | "mandate" | "project" | "schedule-run";
	mandate_id?: string;
	/** Set for a native schedule run's member: the run whose frozen execution chose model and thinking. */
	run_id?: string;
	thinking?: ThinkingLevel;
}

export function selectReviewerModel(input: {
	model?: string;
	record?: FleetRecord;
	registry?: Pick<ProjectRegistry, "get">;
	mandates?: Pick<MandateStore, "list" | "scheduleOf" | "scheduleMandates"> & { scheduleRuns?: ScheduleRunStore };
	now?: Date;
}): ReviewerModelSelection | undefined {
	if (input.model !== undefined) return { model: input.model, source: "explicit" };
	const { record, mandates } = input;
	if (!record) return undefined;
	const run = nativeRunOf(mandates?.scheduleRuns, record.job_id);
	const runModel = run && runModelFor(run, "reviewer"), thinking = run?.execution?.effective.thinking as ThinkingLevel | undefined;
	if (run && (runModel || thinking)) return { ...(runModel ? { model: runModel } : {}), source: "schedule-run", run_id: run.id, ...(thinking ? { thinking } : {}) };
	if (mandates) {
		const subject = {
			jobId: record.job_id, project: record.project, jobKind: record.kind,
			startedAt: record.dispatched_at, inFlight: true,
			...(record.schedule_id ? scheduleScope(record.schedule_id, mandates.scheduleMandates()) : mandates.scheduleOf(record.job_id)),
		};
		const eligible = mandates.list().filter((grant) => grant.reviewer_model !== undefined && grant.status !== "paused" && grant.status !== "revoked")
			.map((grant) => ({ grant, at: grantStanding(grant, "review", subject, isoTimestamp(input.now)) }))
			.filter(({ at }) => at.standing === "permit")
			.sort((a, b) => Number(b.at.standing !== "none" && b.at.cause === "active") - Number(a.at.standing !== "none" && a.at.cause === "active")
				|| b.grant.issued_at.localeCompare(a.grant.issued_at) || b.grant.id.localeCompare(a.grant.id));
		const chosen = eligible[0]?.grant;
		if (chosen?.reviewer_model) return { model: chosen.reviewer_model, source: "mandate", mandate_id: chosen.id };
	}
	const model = input.registry?.get(record.project)?.reviewer_model;
	return model ? { model, source: "project" } : undefined;
}
