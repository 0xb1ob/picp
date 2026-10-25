/** Dispatch and same-worker promotion under one selected mandate. */
import { type Mandate, type Risk } from "./contracts.ts";
import { EscalationStore, raiseRiskHigh } from "./escalation.ts";
import { jobCapRefuses, MandateError, mandateSpend, type MandateUsageJob } from "./mandate-accounting.ts";
import type { GrantPermission } from "./mandate-permission.ts";
import type { MandateStore } from "./mandate.ts";
import { HARD_STOP_SIGNALS, riskPreapproval } from "./risk-preapproval.ts";
import { runStartedBy, scheduleRunVerdict, ScheduleAuthorityError } from "./schedule-authority.ts";
import { continueForJob } from "./mandate-continuity.ts";

export interface DispatchAuthorityJob {
	jobId: string; project: string; kind?: "ship" | "research"; pathHints?: string[]; risk?: Risk;
	evidence?: readonly string[]; promotion?: boolean; script?: boolean;
	/** The resolved profile's `readOnly` frontmatter, set only by dispatch.ts where the profile is resolved. */
	readOnly?: boolean;
	/** An `ops:` job (src/ops-jobs.ts): it acts on a remote host, so a read-only profile never exempts it. */
	ops?: boolean;
}
/** Read-only planning never edits code, so risk:high never gates it; the ship job that implements the plan is. */
export const riskGateExempt = (job: Pick<DispatchAuthorityJob, "kind" | "readOnly" | "promotion" | "script" | "ops">): boolean =>
	job.kind === "research" && job.readOnly === true && !job.promotion && !job.script && !job.ops;
export async function assertDispatchAllowed(store: MandateStore, job: DispatchAuthorityJob, jobs: readonly MandateUsageJob[] = []): Promise<GrantPermission> {
	try {
		const verdict = scheduleRunVerdict(store.runContext(), job.promotion ? "promote" : "dispatch", job, jobs, store.authorityNow());
		if (verdict.source === "schedule-run") return { run: { id: verdict.run.id, schedule_id: verdict.run.schedule_id, started_by: runStartedBy(verdict.run) } };
	} catch (error) {
		if (error instanceof ScheduleAuthorityError && error.escalation) await error.escalation;
		throw error;
	}
	const continuation = await continueForJob(store, job.jobId, jobs, job.promotion ? "promote" : "dispatch");
	let permission: GrantPermission;
	try { permission = store.assertPermitted(job.promotion ? "promote" : "dispatch", job, jobs); }
	catch (error) {
		if (continuation?.escalation_id) throw new MandateError(`${(error as Error).message}; confirm original admission with cp_decide ${continuation.escalation_id}, then retry cp_mandate continue`);
		throw error;
	}
	const { selected, cause } = permission;
	if (!selected) return permission;
	const speaking = [selected];
	let preapproved: Mandate[] = [];
	if (job.risk === "high" && !riskGateExempt(job) && speaking.some((mandate) => mandate.ask_on.includes("risk:high"))) {
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
			// Canonical category labels only — never the matched task text.
			const kinds = [...new Set(pre.stops.flatMap((stop) => HARD_STOP_SIGNALS.filter(({ why }) => stop.startsWith(`hard stop ${why}:`)).map(({ why }) => why)))].slice(0, 4);
			const hard = kinds.length ? `; hard stop in the task text (${kinds.join(", ")}): no standing risk pre-approval covers a hard stop, so another preapprove_risk will not clear it` : "";
			throw new MandateError(`${job.jobId}: risk:high under ask_on — refused before dispatch; ${raised.id} raised, cp_decide it with an operator quote to authorize it${hard}`);
		}
	}
	if (cause === "active" || selected.continuity?.phase === "committed") {
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
