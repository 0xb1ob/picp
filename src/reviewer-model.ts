/** Reviewer preference selection only; permission and capability checks stay at their existing boundaries. */
import { type FleetRecord, isoTimestamp } from "./contracts.ts";
import { grantStanding } from "./mandate-permission.ts";
import { scheduleScope } from "./mandate-accounting.ts";
import type { MandateStore } from "./mandate.ts";
import type { ProjectRegistry } from "./projects.ts";

export interface ReviewerModelSelection {
	model: string;
	source: "explicit" | "mandate" | "project";
	mandate_id?: string;
}

export function selectReviewerModel(input: {
	model?: string;
	record?: FleetRecord;
	registry?: Pick<ProjectRegistry, "get">;
	mandates?: Pick<MandateStore, "list" | "scheduleOf" | "scheduleMandates">;
	now?: Date;
}): ReviewerModelSelection | undefined {
	if (input.model !== undefined) return { model: input.model, source: "explicit" };
	const { record, mandates } = input;
	if (!record) return undefined;
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
