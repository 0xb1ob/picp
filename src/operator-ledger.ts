/**
 * `cp_parent jobs`: the operator session's direct, read-only ledger query (list/history/show). It reads the selected
 * home's files only; it never starts or attaches a parent and holds no fleet or ledger writer.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { configureLayout, type Mode } from "./contracts.ts";
import { formatHistory, historyDetails, queryJobs } from "./job-history.ts";
import { HISTORY_DATE_FIELDS, HISTORY_LIMITS } from "./ledger-filter.ts";
import { readJobsDocument } from "./ledger.ts";

export const OperatorJobsQuerySchema = Type.Object(
	{
		mode: StringEnum(["list", "history", "show"], { description: "list: open jobs (all: closed too), created first; history: closed jobs, newest close first; show: one job" }),
		job_id: Type.Optional(Type.String({ description: "show: the job" })),
		project: Type.Optional(Type.String({ description: "list/history: project filter" })),
		all: Type.Optional(Type.Boolean({ description: "list: include closed jobs" })),
		q: Type.Optional(Type.String({ maxLength: HISTORY_LIMITS.maxQuery, description: "list/history: literal, case-insensitive text over id, title, description, notes, labels, ref, close reason, comments and accepted headline" })),
		since: Type.Optional(Type.String({ description: "list/history: UTC instant or YYYY-MM-DD, inclusive" })),
		until: Type.Optional(Type.String({ description: "list/history: UTC instant or YYYY-MM-DD, exclusive" })),
		date_field: Type.Optional(StringEnum([...HISTORY_DATE_FIELDS], { description: "list/history: the date since/until and the order read (history default closed_at, list created_at)" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORY_LIMITS.maxPage, description: `list/history: page size (default ${HISTORY_LIMITS.page})` })),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "list/history: rows to skip (a result's next offset)" })),
	},
	{ additionalProperties: false },
);
export type OperatorJobsQuery = Static<typeof OperatorJobsQuerySchema>;

/** Answer one `cp_parent jobs` call from disk. Throws a named refusal on a bad query or an unknown job. */
export function operatorJobs(target: { home: string; mode: Mode }, query: OperatorJobsQuery | undefined): { text: string; details: Record<string, unknown> } {
	if (!query) throw new Error("cp_parent jobs needs jobs: { mode: list|history|show, … }");
	configureLayout(target.mode, target.home);
	if (query.mode === "show") {
		if (!query.job_id) throw new Error("cp_parent jobs show needs job_id");
		const job = readJobsDocument(target.home).jobs.find((entry) => entry.id === query.job_id);
		if (!job) throw new Error(`no job ${query.job_id} in ${target.home}'s ledger`);
		const lines = [`${job.id}  ${job.status}`, `  title:   ${job.title}`, `  labels:  ${job.labels.join(", ")}`, `  created: ${job.created_at}  updated: ${job.updated_at}`];
		if (job.external_ref) lines.push(`  ref:     ${job.external_ref}`);
		if (job.status === "closed") lines.push(`  closed:  ${job.closed_at}  ${job.close_reason}`);
		for (const comment of job.comments) lines.push(`  comment: ${comment.at} ${comment.author}: ${comment.text}`);
		return { text: lines.join("\n"), details: { job } };
	}
	const { mode, job_id: _id, all, ...input } = query;
	const result = queryJobs(target.home, mode === "list" ? "list" : "history", input, mode === "list" && all ? { all: true } : {});
	return { text: formatHistory(result), details: historyDetails(result) };
}
