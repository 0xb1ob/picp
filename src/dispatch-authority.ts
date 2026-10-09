/** Dispatch and same-worker promotion under one selected mandate. */
import { type Mandate, type Risk } from "./contracts.ts";
import { EscalationStore, raiseRiskHigh } from "./escalation.ts";
import { jobCapRefuses, MandateError, mandateSpend, type MandateUsageJob } from "./mandate-accounting.ts";
import type { GrantPermission } from "./mandate-permission.ts";
import type { MandateStore } from "./mandate.ts";
import { riskPreapproval } from "./risk-preapproval.ts";

export interface DispatchAuthorityJob {
	jobId: string; project: string; kind?: "ship" | "research"; pathHints?: string[]; risk?: Risk;
	evidence?: readonly string[]; promotion?: boolean; script?: boolean;
}
export async function assertDispatchAllowed(store: MandateStore, job: DispatchAuthorityJob, jobs: readonly MandateUsageJob[] = []): Promise<GrantPermission> {
	const permission = store.assertPermitted(job.promotion ? "promote" : "dispatch", job, jobs);
	const { selected, cause } = permission;
	if (!selected) return permission;
	const speaking = [selected];
	let preapproved: Mandate[] = [];
	if (job.risk === "high" && speaking.some((mandate) => mandate.ask_on.includes("risk:high"))) {
		const escalations = new EscalationStore({ home: store.home });
		// Explicit approve only: raiseRiskHigh recommends drop, which is never authorization.
		const APPROVE = /^(?:approve|approved|yes)$/i;
		const authorized = escalations.list({ jobId: job.jobId, kind: "risk_high_irreversible" })
			.some((entry) => entry.status === "answered" && APPROVE.test((entry.answer ?? "").trim()));
		const asking = speaking.filter((mandate) => mandate.ask_on.includes("risk:high"));
		const pre = authorized ? undefined : riskPreapproval(asking, job, store.jobCreatedAt(job.jobId));
		if (pre?.covered) preapproved = asking;
		else if (pre) {
			const raised = await raiseRiskHigh(escalations, { jobId: job.jobId, evidence: [...(job.evidence ?? []), ...pre.stops], ...(asking[0] ? { mandateId: asking[0].id } : {}) });
			throw new MandateError(`${job.jobId}: risk:high under ask_on — refused before dispatch; ${raised.id} raised, cp_decide it with an operator quote to authorize it`);
		}
	}
	if (cause === "active") {
		const counted = store.withReviewerSpend(jobs, speaking);
		if (!job.promotion && jobCapRefuses(selected, job.jobId, counted)) {
			throw new MandateError(`${job.jobId}: mandate ${selected.id} job cap ${selected.job_cap} reached — no new dispatch; the jobs it already covers continue (review, repair, merge)`);
		}
		if (selected.dispatch_parallelism && !job.promotion && mandateSpend(selected, counted).inFlight >= selected.dispatch_parallelism) {
			throw new MandateError(`${job.jobId}: mandate ${selected.id} dispatch-parallelism ${selected.dispatch_parallelism} is full`, { code: "parallelism_full" });
		}
	}
	store.recordDispatchPreapproval(preapproved, job);
	return permission;
}
