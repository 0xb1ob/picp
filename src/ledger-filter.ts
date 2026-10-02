/**
 * Job labels' prefixes and the list filter over a jobs document, moved out of
 * `src/ledger.ts` verbatim so the ledger keeps headroom under its size cap.
 * `ledger.ts` re-exports `LABEL_PREFIX` and `ListFilter`; nothing here imports it.
 * It also owns the one label a composed risk writes (cp-yxgl review), so the pipeline
 * can record it without a value import back into `src/pipeline.ts`.
 */
import type { Delivery, Job, JobKind, JobsDocument, JobStatus, Risk, RoutingProvenance } from "./contracts.ts";

export const LABEL_PREFIX = Object.freeze({
	project: "project:",
	delivery: "delivery:",
	kind: "kind:",
	risk: "risk:",
});

export interface ListFilter {
	project?: string;
	delivery?: Delivery;
	kind?: JobKind;
	status?: JobStatus | readonly JobStatus[];
	/** Include closed jobs (job history). */
	all?: boolean;
	/** `0` or absent: unlimited. */
	limit?: number;
	labels?: readonly string[];
}

function wantedLabels(filter: ListFilter): string[] {
	return [
		...(filter.project ? [`${LABEL_PREFIX.project}${filter.project}`] : []),
		...(filter.delivery ? [`${LABEL_PREFIX.delivery}${filter.delivery}`] : []),
		...(filter.kind ? [`${LABEL_PREFIX.kind}${filter.kind}`] : []),
		...(filter.labels ?? []),
	];
}

export function filterJobs(doc: JobsDocument, filter: ListFilter): Job[] {
	const statuses =
		filter.status === undefined ? undefined : Array.isArray(filter.status) ? [...(filter.status as readonly JobStatus[])] : [filter.status as JobStatus];
	const labels = wantedLabels(filter);
	let jobs = doc.jobs.filter((job) => {
		if (statuses) {
			if (!statuses.includes(job.status)) return false;
		} else if (!filter.all && job.status === "closed") {
			return false;
		}
		return labels.every((label) => job.labels.includes(label));
	});
	jobs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
	if (filter.limit !== undefined && filter.limit > 0) jobs = jobs.slice(0, filter.limit);
	return jobs;
}

/**
 * The `risk:` label a composed routing earns (cp-yxgl review): an **assessed** high only — a
 * `defaulted`/`inferred` axis is nobody's record — replacing a stale low rather than sitting
 * beside it. The pipeline handoff owns the ship job and calls this; a write failure is surfaced,
 * never swallowed, because the ledger is the operator's view of what was dispatched.
 */
export async function recordAssessedRisk(
	ledger: {
		show: (id: string) => Promise<{ labels?: readonly string[] }>;
		update: (id: string, patch: { addLabels?: string[]; removeLabels?: string[] }) => Promise<unknown>;
	},
	shipId: string,
	routing: { risk?: Risk; inputsFrom: { risk?: RoutingProvenance } },
): Promise<void> {
	if (routing.risk !== "high" || routing.inputsFrom.risk !== "assessed") return;
	const labels = (await ledger.show(shipId)).labels ?? [];
	if (labels.includes(`${LABEL_PREFIX.risk}high`)) return;
	await ledger.update(shipId, {
		addLabels: [`${LABEL_PREFIX.risk}high`],
		...(labels.includes(`${LABEL_PREFIX.risk}low`) ? { removeLabels: [`${LABEL_PREFIX.risk}low`] } : {}),
	});
}
