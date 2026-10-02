/** Dependency explanations shared by cp_next and the status block; reads never change readiness. */
import type { Mandate } from "./contracts.ts";
import { type Job, type Ledger, openBlockersOf, parseJobLabels, wasDropped } from "./ledger.ts";
import { covers, scheduleIdOf, scheduleScope } from "./mandate-accounting.ts";
import { isExpired } from "./mandate-permission.ts";
import type { EscalationStore } from "./escalation.ts";

export interface BlockedJob {
	job: Job;
	blockers: Job[];
	waiting_on: string;
	escalation_ids?: string[];
}

/** `schedules`: schedule id -> the mandate it names (`MandateStore.scheduleMandates`), so a scheduled job is covered only by its schedule's grant. */
function coveringGrant(job: Job, grants: readonly Mandate[], now: string, schedules: ReadonlyMap<string, string>): Mandate | undefined {
	const labels = parseJobLabels(job.labels);
	const matching = grants.filter((grant) => covers(grant, { jobId: job.id, project: labels.project ?? "", jobKind: labels.kind, ...scheduleScope(scheduleIdOf(job.labels), schedules) }));
	return matching.findLast((grant) => grant.status === "active" && !isExpired(grant, now)) ?? matching.at(-1);
}

export function blockedJobs(ledger: Ledger, grants: readonly Mandate[], now: string, project?: string, schedules: ReadonlyMap<string, string> = new Map()): BlockedJob[] {
	const doc = ledger.read();
	const byId = new Map(doc.jobs.map((job) => [job.id, job]));
	return doc.jobs.filter((job) => job.status !== "closed" && (!project || parseJobLabels(job.labels).project === project)).flatMap((job) => {
		const blockers = openBlockersOf(doc, job.id).map((id) => byId.get(id)!);
		if (blockers.length === 0) return [];
		const details = blockers.slice(0, 3).map((blocker) => {
			if (wasDropped(blocker)) return `${blocker.id} (closed as dropped)`;
			const grant = coveringGrant(blocker, grants, now, schedules);
			if (!grant) return `${blocker.id} (no active grant covers it)`;
			const state = isExpired(grant, now) ? "expired" : grant.status;
			return state === "active" ? blocker.id : `${blocker.id} (under ${state} ${grant.id})`;
		});
		const text = details.join(", ");
		const waiting_on = `${text.slice(0, 280)}${text.length > 280 ? "..." : ""}${blockers.length > 3 ? `; +${blockers.length - 3} more blockers` : ""}`;
		return [{ job, blockers, waiting_on }];
	});
}

/** One question per ordered pair, even when several grants cover the dependent. */
export async function raiseDroppedDependencies(rows: readonly BlockedJob[], grants: readonly Mandate[], store: EscalationStore, now: string, schedules: ReadonlyMap<string, string> = new Map()): Promise<void> {
	for (const row of rows) {
		const { job, blockers } = row;
		const grant = coveringGrant(job, grants.filter((grant) => (grant.status === "active" || grant.status === "paused") && !isExpired(grant, now)), now, schedules);
		if (!grant) continue;
		for (const blocker of blockers.filter(wasDropped)) {
			const prior = store.list({ jobId: job.id }).find((item) => item.dropped_dependency?.job_id === job.id && item.dropped_dependency.blocker_id === blocker.id && (item.status === "open" || item.status === "answered"));
			const raised = prior ?? await store.raise({
				job_ids: [job.id, blocker.id], kind: "scope_expansion", mandate_id: grant.id,
				mandate_clause: "Proceeding without a required dependency changes the accepted scope",
				dropped_dependency: { job_id: job.id, blocker_id: blocker.id },
				question: `${job.id} depends on ${blocker.id}, closed as ${blocker.close_reason}. Proceed without its result, drop the dependent, or re-open the work?`.slice(0, 1000),
				options: [
					{ id: "proceed", label: "proceed", consequence: "remove this dependency", cost: "accept the missing result" },
					{ id: "drop", label: "drop", consequence: "drop the dependent with a reason", cost: "abandon the dependent" },
					{ id: "reopen", label: "reopen", consequence: "re-open the blocker; keep the dependency", cost: "finish the missing work" },
				],
				recommended: "reopen",
			});
			(row.escalation_ids ??= []).push(raised.id);
		}
	}
}
