/**
 * Bounded job-history reads shared by `cp_job history`, `/cp-jobs history` and the operator's `cp_parent jobs`: the pure
 * query in ledger-filter.ts over the ledger plus accepted envelope headlines. Read-only; never a report body.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { type FleetRecord, type Job, paths } from "./contracts.ts";
import { FleetStore } from "./fleet.ts";
import { envelopeHeadline, filterJobs, HISTORY_LIMITS, historyQuery, type HistoryQueryInput, type ListFilter, runHistoryQuery } from "./ledger-filter.ts";
import { jobsFile, parseJobLabels, readJobsDocument, wasDropped } from "./ledger.ts";

export interface HistoryWarning { section: string; message: string }
export interface HistoryRow {
	id: string; title: string; status: string; project: string | null; created_at: string; updated_at: string;
	closed_at: string | null; close_reason: string | null; dropped: boolean; report_status: "done" | "blocked" | "failed" | null; headline: string | null;
}
export interface HistoryResult { mode: "history" | "list"; rows: HistoryRow[]; total: number; offset: number; limit: number; next_offset: number | null; warnings: HistoryWarning[] }

/** A list call naming any of these is a bounded, paged query; without them `cp_job list` keeps its old behavior. */
export const LIST_QUERY_KEYS = ["q", "since", "until", "date_field", "offset"] as const;
export const isQueryList = (input: Partial<Record<(typeof LIST_QUERY_KEYS)[number], unknown>>): boolean => LIST_QUERY_KEYS.some((key) => input[key] !== undefined);

/** Bounded before allocation on one descriptor, like the viewer's reads. */
function readCapped(file: string, max: number): string {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		if (size > max) throw new Error(`over ${max} bytes`);
		const buffer = Buffer.alloc(size);
		if (readSync(fd, buffer, 0, size, 0) !== size) throw new Error("changed while read");
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** Validate first (a bad query refuses even on an empty home), then read, filter, sort and page. Throws only on a bad query. */
export function queryJobs(home: string, mode: "history" | "list", input: HistoryQueryInput, filter: Omit<ListFilter, "limit" | "project"> = {}): HistoryResult {
	const query = historyQuery(input, mode === "history" ? { dateField: "closed_at", order: "desc" } : { dateField: "created_at", order: "asc" });
	const warnings: HistoryWarning[] = [];
	let jobs: Job[] = [];
	try {
		if (existsSync(jobsFile(home))) {
			const doc = readJobsDocument(home);
			jobs = filterJobs(doc, mode === "history" ? { ...filter, status: "closed" } : filter);
		} else warnings.push({ section: "ledger", message: "no ledger file yet; nothing is recorded" });
	} catch (error) {
		warnings.push({ section: "ledger", message: `unavailable: ${(error as Error).message.split("\n")[0]}` });
	}
	let fleet: Map<string, FleetRecord> | undefined;
	let unread = 0;
	const facts = new Map<string, ReturnType<typeof envelopeHeadline>>();
	const report = (job: Job) => {
		if (facts.has(job.id)) return facts.get(job.id);
		if (!fleet) {
			try {
				fleet = new Map(new FleetStore({ home }).read().jobs.map((record) => [record.job_id, record]));
			} catch (error) {
				fleet = new Map();
				warnings.push({ section: "fleet", message: `unreadable, headlines omitted: ${(error as Error).message.split("\n")[0]}` });
			}
		}
		let found: ReturnType<typeof envelopeHeadline>;
		if (fleet.get(job.id)?.reported_at) {
			try {
				found = envelopeHeadline(JSON.parse(readCapped(join(home, paths.envelopeFile(job.id)), HISTORY_LIMITS.envelopeBytes)));
			} catch { /* counted below */ }
			if (!found) unread += 1;
		}
		facts.set(job.id, found);
		return found;
	};
	const page = runHistoryQuery(jobs, query, (job) => report(job)?.headline);
	const rows = page.rows.map((job): HistoryRow => {
		const found = report(job);
		return {
			id: job.id, title: job.title, status: job.status, project: parseJobLabels(job.labels).project ?? null,
			created_at: job.created_at, updated_at: job.updated_at, closed_at: job.closed_at ?? null, close_reason: job.close_reason ?? null,
			dropped: wasDropped(job), report_status: found?.status ?? null, headline: found?.headline ?? null,
		};
	});
	if (unread > 0) warnings.push({ section: "envelopes", message: `${unread} reported envelope(s) unreadable or over ${HISTORY_LIMITS.envelopeBytes} bytes; headline omitted` });
	return { mode, rows, total: page.total, offset: query.offset, limit: query.limit, next_offset: page.next_offset, warnings };
}

/** One line per row, a paging header and every source warning: the text all three ledger surfaces return. */
export function formatHistory(result: HistoryResult): string {
	const shown = result.rows.length === 0 ? "none" : `${result.offset + 1}-${result.offset + result.rows.length}`;
	const lines = [`${result.mode}: ${shown} of ${result.total}${result.next_offset !== null ? `; next offset ${result.next_offset}` : ""}`];
	for (const row of result.rows) {
		const when = result.mode === "history" ? `closed ${row.closed_at}` : `${row.status} since ${row.created_at}`;
		lines.push(`${row.id}  ${when}  ${row.project ?? "?"}  ${row.title}${row.close_reason ? ` — ${row.dropped ? "DROPPED " : ""}${row.close_reason}` : ""}`);
		if (row.headline) lines.push(`    report ${row.report_status?.toUpperCase()}: ${row.headline}`);
	}
	if (result.rows.length === 0) lines.push(result.warnings.length > 0 ? "no rows (sources limited, see below)" : "no jobs match");
	for (const warning of result.warnings) lines.push(`source warning: ${warning.section}: ${warning.message}`);
	return lines.join("\n");
}

export const historyDetails = (result: HistoryResult): Record<string, unknown> => ({ ...result, ids: result.rows.map((row) => row.id) });
