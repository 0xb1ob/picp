/**
 * `GET /api/jobs/history`: closed ledger jobs through the same pure query as `cp_job history` (src/ledger-filter.ts),
 * with accepted envelope headlines. Read-only and bounded; never a report body.
 */
import { join } from "node:path";
import type { JobsHistoryResponse } from "./api-types.ts";
import { envelopeHeadline, HISTORY_LIMITS, historyQuery, type HistoryJob, type HistoryQueryInput, runHistoryQuery } from "../ledger-filter.ts";
import { LEDGER_STATUSES, objectList, readBounded, strings } from "./overview-read.ts";
import { isSafeId, obj, runtimeRoot, str, type Json, type ViewerState } from "./sessions.ts";

const NUMBER = /^\d+$/;

function parse(params: URLSearchParams): HistoryQueryInput | string {
 const value = (name: string) => params.get(name)?.trim() || undefined;
 const input: HistoryQueryInput = {};
 for (const name of ["project", "q", "since", "until", "date_field"] as const) { const v = value(name); if (v !== undefined) input[name] = v; }
 for (const name of ["limit", "offset"] as const) {
  const v = value(name);
  if (v === undefined) continue;
  if (!NUMBER.test(v)) return `${name} must be a non-negative integer`;
  input[name] = Number(v);
 }
 return input;
}

function historyJob(raw: Json): HistoryJob {
 const comments = (Array.isArray(raw.comments) ? raw.comments : []).flatMap((c) => { const text = str(obj(c)?.text); return text === undefined ? [] : [{ text }]; });
 return { id: String(raw.id), title: str(raw.title) ?? "", status: String(raw.status), labels: strings(raw.labels), created_at: str(raw.created_at) ?? "", updated_at: str(raw.updated_at) ?? "",
  closed_at: str(raw.closed_at), description: str(raw.description), notes: str(raw.notes), external_ref: str(raw.external_ref), close_reason: str(raw.close_reason), comments };
}

export function ledgerHistoryView(state: ViewerState, params: URLSearchParams, now: number): { status: 200; body: JobsHistoryResponse } | { status: 400; body: { error: string } } {
 const input = parse(params);
 if (typeof input === "string") return { status: 400, body: { error: input } };
 let query: ReturnType<typeof historyQuery>;
 try { query = historyQuery(input, { dateField: "closed_at", order: "desc" }); }
 catch (error) { return { status: 400, body: { error: (error as Error).message } }; }
 const warnings: JobsHistoryResponse["warnings"] = [];
 const ledger = objectList(join(runtimeRoot(state.home), "jobs.json"), "jobs", (j) => typeof j.id === "string" && isSafeId(j.id) && LEDGER_STATUSES.includes(str(j.status) ?? ""));
 if (ledger.availability === "missing") warnings.push({ section: "ledger", message: "no ledger file yet; nothing is recorded" });
 if (ledger.availability === "unavailable") warnings.push({ section: "ledger", message: "unavailable: unreadable or not a valid jobs document" });
 const closed = ledger.value.filter((j) => j.status === "closed").map(historyJob);
 let fleet: Set<string> | undefined;
 let unread = 0;
 const facts = new Map<string, ReturnType<typeof envelopeHeadline>>();
 const report = (job: HistoryJob) => {
  if (facts.has(job.id)) return facts.get(job.id);
  if (!fleet) {
   const read = objectList(join(state.stateDir, "fleet.json"), "jobs", (j) => typeof j.job_id === "string");
   if (read.availability === "unavailable") warnings.push({ section: "fleet", message: "unreadable, headlines omitted" });
   fleet = new Set(read.value.filter((j) => typeof j.reported_at === "string" && j.reported_at).map((j) => String(j.job_id)));
  }
  let found: ReturnType<typeof envelopeHeadline>;
  if (fleet.has(job.id)) {
   try { found = envelopeHeadline(JSON.parse(readBounded(join(state.stateDir, "runs", job.id, "envelope.json"), HISTORY_LIMITS.envelopeBytes))); } catch { /* counted below */ }
   if (!found) unread += 1;
  }
  facts.set(job.id, found);
  return found;
 };
 const page = runHistoryQuery(closed, query, (job) => report(job)?.headline);
 const rows = page.rows.map((job) => {
  const found = report(job);
  return { id: job.id, title: job.title, project: job.labels.find((l) => l.startsWith("project:"))?.slice(8) ?? null, status: job.status, created_at: job.created_at, updated_at: job.updated_at,
   closed_at: job.closed_at ?? null, close_reason: job.close_reason ?? null, dropped: (job.close_reason ?? "").startsWith("dropped:"), report_status: found?.status ?? null, headline: found?.headline ?? null };
 });
 if (unread > 0) warnings.push({ section: "envelopes", message: `${unread} reported envelope(s) unreadable or over ${HISTORY_LIMITS.envelopeBytes} bytes; headline omitted` });
 const projects = [...new Set(closed.flatMap((j) => j.labels.filter((l) => l.startsWith("project:")).map((l) => l.slice(8))))].sort();
 return { status: 200, body: { generated_at: new Date(now).toISOString(), total: page.total, offset: query.offset, limit: query.limit, next_offset: page.next_offset,
  query: { project: input.project ?? null, q: query.q ?? null, since: input.since ?? null, until: input.until ?? null, date_field: query.dateField }, rows, projects, warnings } };
}
