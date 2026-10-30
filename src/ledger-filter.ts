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

// ---------------------------------------------------------------------------
// History query: pure and import-free at runtime, so the viewer shares it (tests/viewer-boundary.test.ts).
// ---------------------------------------------------------------------------

export const HISTORY_DATE_FIELDS = ["created_at", "updated_at", "closed_at"] as const;
export type HistoryDateField = (typeof HISTORY_DATE_FIELDS)[number];
export const HISTORY_LIMITS = { page: 20, maxPage: 100, maxQuery: 200, envelopeBytes: 65_536 } as const;

/** The ledger fields a history query reads; a `Job` satisfies it, the viewer maps its raw rows onto it. */
export interface HistoryJob {
	id: string;
	title: string;
	status: string;
	labels: readonly string[];
	created_at: string;
	updated_at: string;
	closed_at?: string | undefined;
	description?: string | undefined;
	notes?: string | undefined;
	external_ref?: string | undefined;
	close_reason?: string | undefined;
	comments?: readonly { text: string }[] | undefined;
}
export interface HistoryQueryInput { project?: string; q?: string; since?: string; until?: string; date_field?: string; limit?: number; offset?: number }
export interface HistoryQuery { project?: string; q?: string; since?: number; until?: number; dateField: HistoryDateField; order: "asc" | "desc"; limit: number; offset: number }
export interface HistoryPage<T> { rows: T[]; total: number; next_offset: number | null }

/** A strict UTC instant or `YYYY-MM-DD` (midnight UTC) as epoch ms; throws on anything else or a non-calendar date. */
function historyDate(name: string, value: string): number {
	const ms = /^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{1,3})?Z)?$/.test(value) ? Date.parse(value) : NaN;
	if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value.slice(0, 10)) {
		throw new Error(`${name} must be a UTC instant (YYYY-MM-DDTHH:MM:SSZ) or a date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
	}
	return ms;
}

/** Validate a history query: dates are `[since, until)`, a page is 1..100 rows (default 20). Throws a named refusal. */
export function historyQuery(input: HistoryQueryInput, defaults: { dateField: HistoryDateField; order: "asc" | "desc" }): HistoryQuery {
	const dateField = input.date_field ?? defaults.dateField;
	if (!(HISTORY_DATE_FIELDS as readonly string[]).includes(dateField)) throw new Error(`date_field must be one of ${HISTORY_DATE_FIELDS.join("|")}`);
	const limit = input.limit ?? HISTORY_LIMITS.page;
	if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMITS.maxPage) throw new Error(`limit must be an integer 1..${HISTORY_LIMITS.maxPage}`);
	const offset = input.offset ?? 0;
	if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
	const q = input.q?.trim();
	if (q && q.length > HISTORY_LIMITS.maxQuery) throw new Error(`q is at most ${HISTORY_LIMITS.maxQuery} characters`);
	const since = input.since === undefined ? undefined : historyDate("since", input.since);
	const until = input.until === undefined ? undefined : historyDate("until", input.until);
	if (since !== undefined && until !== undefined && since >= until) throw new Error("since must be before until");
	return {
		dateField: dateField as HistoryDateField, order: defaults.order, limit, offset,
		...(input.project ? { project: input.project } : {}), ...(q ? { q } : {}),
		...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}),
	};
}

/**
 * Filter, sort and only then page `jobs`. Text is a literal, case-insensitive match over id, title, description, notes,
 * labels, external ref, close reason, comments and the accepted headline (`headline` is asked only when the rest misses).
 */
export function runHistoryQuery<T extends HistoryJob>(jobs: readonly T[], query: HistoryQuery, headline: (job: T) => string | undefined = () => undefined): HistoryPage<T> {
	const at = (job: T): number => {
		const value = job[query.dateField];
		return value ? Date.parse(value) : NaN;
	};
	const needle = query.q?.toLowerCase();
	const matches = (job: T): boolean => {
		if (!needle) return true;
		const fields = [job.id, job.title, job.description, job.notes, ...job.labels, job.external_ref, job.close_reason, ...(job.comments ?? []).map((c) => c.text)];
		return fields.some((field) => field?.toLowerCase().includes(needle)) || (headline(job)?.toLowerCase().includes(needle) ?? false);
	};
	const sign = query.order === "desc" ? -1 : 1;
	const hits = jobs
		.filter((job) => {
			if (query.project && !job.labels.includes(`${LABEL_PREFIX.project}${query.project}`)) return false;
			if (query.since !== undefined || query.until !== undefined) {
				const time = at(job);
				if (!Number.isFinite(time) || (query.since !== undefined && time < query.since) || (query.until !== undefined && time >= query.until)) return false;
			}
			return matches(job);
		})
		.sort((a, b) => {
			const [x, y] = [at(a), at(b)];
			if (Number.isFinite(x) !== Number.isFinite(y)) return Number.isFinite(x) ? -1 : 1; // undated rows last
			return (Number.isFinite(x) && x !== y ? sign * (x - y) : 0) || a.id.localeCompare(b.id);
		});
	const rows = hits.slice(query.offset, query.offset + query.limit);
	return { rows, total: hits.length, next_offset: query.offset + rows.length < hits.length ? query.offset + rows.length : null };
}

/** An accepted envelope file's status and first summary line; undefined unless it is a done/blocked/failed report. */
export function envelopeHeadline(file: unknown): { status: "done" | "blocked" | "failed"; headline: string } | undefined {
	const envelope = (file as { envelope?: { status?: unknown; summary?: unknown } } | null)?.envelope;
	const status = envelope?.status;
	if (typeof envelope?.summary !== "string" || (status !== "done" && status !== "blocked" && status !== "failed")) return undefined;
	const headline = envelope.summary.split("\n").find((line) => line.trim())?.trim();
	return headline ? { status, headline } : undefined;
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
