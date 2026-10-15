import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { BlockedJob, FailedJob, FlightJob, ForwardedCi, ShippedJob, TeamJob } from "./api-types.ts";
import type { JobRow } from "./fleet-view.ts";
import { isSafeChangeRequestUrl } from "../forge-url.ts";
import { SHA } from "./git-read.ts";
import { isSafeId, obj, readObject, readStatus, str, type Json, type ViewerState } from "./sessions.ts";
import { nonnegative, parseObject, strings, timestamp, today } from "./overview-read.ts";
import { routingText } from "./overview-health.ts";
import { modelWindows, workerContext } from "./context-usage.ts";
import { compareActiveGrants } from "../grant-order.ts";
import { fileCache } from "./file-cache.ts";
import { readLines, startOffset } from "./tail.ts";
/** The job's recorded reviews: attempt count, and the latest untruncated verdict for `head` (or a patch-equivalent pass). */
export function recordedReview(state: ViewerState, id: string, head: string | null): {review: Json | undefined; attempts: string[]} {
 let names: string[] = []; try { names = readdirSync(join(state.stateDir,"runs",id)); } catch { /* No recorded reviews. */ }
 const attempts = names.filter(n => /^review-[1-9]\d*\.json$/.test(n));
 const reviews = attempts.map(name => readObject(join(state.stateDir,"runs",id,name))).filter((v): v is Json => !!v);
 if (head) { const equivalent = readObject(join(state.stateDir,"runs",id,`review-equivalent-${head}.json`)); if (equivalent) reviews.push(equivalent); }
 const review = reviews.filter(r => head && r.head_sha === head && obj(r.diff_stat)?.truncated === false).sort((a,b) => (str(a.decided_at) ?? "").localeCompare(str(b.decided_at) ?? "")).at(-1);
 return {review, attempts};
}
/** The `last_ci` src/ci-access.ts records when the token was refused a CI read; viewer modules import nothing outside. */
export const CI_UNREADABLE = "unreadable";
/** A ci-watch row's CI for `head`; a refused read is shown whatever head it was for, never as "no CI yet". */
export const jobCi = (row: Json | undefined, head: string | null | undefined): string | null =>
 row?.last_ci === CI_UNREADABLE ? CI_UNREADABLE : head && row?.head_sha === head ? str(row.last_ci) ?? null : null;
const CI_EVENTS_BYTES = 256 * 1024;
const ciEvents = fileCache((path: string) => readLines(path, startOffset(path, undefined, CI_EVENTS_BYTES).offset, CI_EVENTS_BYTES).lines
 .map(l => parseObject(l.text)).filter((e): e is Json => e?.source === "cp" && e.type === "ci_observed")
 .flatMap(e => { const p = obj(e.payload); const ci = p?.event === "ci_green" ? "green" : p?.event === "ci_failed" ? "failed" : null; const head = str(p?.head_sha);
  return ci && head ? [{ci, head}] : []; }));
/** CI for `head`: the current ci-watch row (its `unknown` is the answer), else the last `ci_observed` event for it. */
export function headCi(state: ViewerState, id: string, row: Json | undefined, head: string | null): string | null {
 const watched = jobCi(row,head);
 if (watched || !head || !isSafeId(id)) return watched;
 try { return ciEvents(join(state.stateDir,"runs",id,"events.jsonl")).findLast(e => e.head === head)?.ci ?? null; } catch { return null; }
}
/** A parked job's current head: a moved head (pending `head_moved`) first, else the handed-off one. */
export function parkedHead(job: Json | undefined): string | null {
 const parked = job?.phase === "awaiting_merge" ? obj(job.awaiting_merge) : undefined;
 const head = str(obj(parked?.pending)?.head_sha) ?? str(parked?.head_sha);
 return head && SHA.test(head) ? head : null;
}
/** Execution seconds frozen at parking, null when the job is not parked. */
export const parkedSeconds = (job: Json | undefined): number | null => job?.phase === "awaiting_merge" ? nonnegative(obj(job.awaiting_merge)?.frozen_seconds) : null;
const FORWARDED_VIEW: Record<string, string> = {success:"green", failure:"failed", pending:"in_progress"};
/**
 * The newest operator-forwarded CI for `head` (runs/<id>/ci-evidence.json, src/ci-evidence.ts);
 * display-only, null when none.
 */
export function forwardedCi(state: ViewerState, id: string, head: string | null | undefined): ForwardedCi | null {
 const list = isSafeId(id) && head ? readObject(join(state.stateDir,"runs",id,"ci-evidence.json"))?.observations : undefined;
 const latest = (Array.isArray(list) ? list.map(obj) : []).filter((o): o is Json => o?.source === "forwarded" && str(o.head_sha)?.toLowerCase() === head?.toLowerCase() && Object.hasOwn(FORWARDED_VIEW, str(o.result) ?? "") && timestamp(o.observed_at))
  .sort((a,b) => String(a.observed_at).localeCompare(String(b.observed_at))).at(-1);
 const url = str(latest?.url);
 return latest ? {ci:FORWARDED_VIEW[String(latest.result)]!, observed_at:String(latest.observed_at), url:url && /^https:\/\/[^\s@?#]+$/.test(url) ? url : null} : null;
}
/** Projects with a held job whose CI read the token was refused (ask-81b54d83f0b2), each with those job ids. */
export function ciUnreadable(state: ViewerState, jobs: Json[]): {project: string; job_ids: string[]}[] {
 const watched = readObject(join(state.stateDir,"ci-watch.json"))?.jobs;
 const denied = new Set((Array.isArray(watched) ? watched.map(obj) : []).filter(r => r?.last_ci === CI_UNREADABLE).map(r => String(r?.job_id)));
 const byProject = new Map<string, string[]>();
 for (const job of jobs) if (denied.has(String(job.job_id))) byProject.set(String(job.project), [...byProject.get(String(job.project)) ?? [], String(job.job_id)]);
 return [...byProject].sort(([a],[b]) => a.localeCompare(b)).map(([project,job_ids]) => ({project,job_ids}));
}
/** `rows`: the dashboard's job rows, every finished one included (`dashboard(state,now,Infinity)`), computed once by `overview`. */
export function flights(state: ViewerState, jobs: Json[], escalations: Json[], now: number, rows: readonly JobRow[]): FlightJob[] {
 const watched = readObject(join(state.stateDir,"ci-watch.json"))?.jobs;
 const windows = modelWindows(state.stateDir);
 const ciRows = Array.isArray(watched) ? watched.map(obj) : [];
 // A parked job owing a CP step (pending resume/revalidation) is In flight; only a quiescent one is With the team.
 return jobs.filter(j => ["waiting","held","launching"].includes(String(j.phase)) || (j.phase === "awaiting_merge" && !quiescent(j))).map(job => {
  const id = String(job.job_id); const status = readStatus(state,id);
  const ci = ciRows.find(row => row?.job_id === id);
  const envelope = obj(readObject(join(state.stateDir,"runs",id,"envelope.json"))?.envelope);
  const head = parkedHead(job) ?? [ci?.head_sha,envelope?.head_sha].find((v): v is string => typeof v === "string" && SHA.test(v)) ?? null;
  const started = status?.started_at ?? job.dispatched_at;
  const exited = status?.exited_at ?? obj(job.worker)?.exited_at;
  const elapsed = parkedSeconds(job) ?? (timestamp(started) ? Math.max(0, ((timestamp(exited) ? Date.parse(exited) : now) - Date.parse(started))/1000) : null);
  const {review, attempts} = recordedReview(state,id,head);
  const row = rows.find(r => r.job_id === id);
  const runPhase = str(status?.phase);
  return {id, project:String(job.project), title:row?.title ?? null,
   phase:job.phase === "held" || job.phase === "awaiting_merge" ? "held" : job.phase === "launching" || runPhase === "starting" ? "launching" : ["working","idle"].includes(runPhase ?? "") ? runPhase! : "waiting",
   model:row?.model ?? null, script_path:job.executor === "script" ? str(job.script_path) ?? "script" : null,
   elapsed_seconds:elapsed, limit_seconds:nonnegative(obj(job.bounds)?.wall_clock_seconds) || null, head,
   ci:headCi(state,id,ci,head), ci_forwarded:forwardedCi(state,id,head), parked_pending:str(obj(obj(job.awaiting_merge)?.pending)?.kind) ?? null,
   review:str(review?.verdict) ?? null, review_attempts:Math.min(5,attempts.length), routing:routingText(state,job),
   note:escalations.filter(e => e.status === "open" && strings(e.job_ids).includes(id)).map(e => `${e.id}: ${e.question}`).join(" · ") || null, pr_url:row?.pr_url ?? null,
   context:workerContext(state,id,row?.model,windows), cost_usd:row ? row.cost_usd + row.reviewer_cost_usd : null};
 });
}
/** Quiescent parked jobs (`awaiting_merge`, no pending CP work). Approvals and CI stay null (unknown) until observed. */
export function withTeam(state: ViewerState, jobs: Json[], now: number, rows: readonly JobRow[]): TeamJob[] {
 const watched = readObject(join(state.stateDir,"awaiting-merge-watch.json"))?.prs;
 const watchRows = Array.isArray(watched) ? watched.map(obj) : [];
 const ciWatched = readObject(join(state.stateDir,"ci-watch.json"))?.jobs; const ciRows = Array.isArray(ciWatched) ? ciWatched.map(obj) : [];
 return jobs.flatMap(job => {
  const parked = obj(job.awaiting_merge);
  if (!quiescent(job) || !parked || !timestamp(parked.handed_at)) return [];
  const id = String(job.job_id); const head = str(parked.head_sha); const pr = str(parked.pr_url);
  if (!head || !SHA.test(head) || !pr || !isSafeChangeRequestUrl(pr)) return [];
  // Only this cycle's observation of this head counts; an older cycle's approvals describe another hand-off.
  const seen = watchRows.find(r => r?.job_id === id && r.cycle === parked.cycle && r.head_sha === head);
  const activity = [parked.last_human_activity_at,seen?.last_human_activity_at].filter(timestamp).sort().at(-1) ?? null;
  const required = nonnegative(seen?.approvals_required);
  return [{id, project:String(job.project), title:rows.find(r => r.job_id === id)?.title ?? null, pr_url:pr, head, base:str(parked.base) ?? "",
   handed_at:parked.handed_at, age_seconds:Math.max(0,(now - Date.parse(parked.handed_at))/1000), frozen_seconds:nonnegative(parked.frozen_seconds) ?? 0,
   approvals:nonnegative(seen?.approvals), approvals_required:required === null ? null : Math.floor(required),
   ci:headCi(state,id,ciRows.find(r => r?.job_id === id),head), ci_forwarded:forwardedCi(state,id,head), last_human_activity_at:activity}];
 }).sort((a,b) => a.handed_at.localeCompare(b.handed_at));
}
// Mirrors isQuiescentParked (src/contracts/awaiting-merge.ts); viewer modules cannot import contracts.
export const quiescent = (job: Json): boolean => job.phase === "awaiting_merge" && obj(job.awaiting_merge) !== undefined && obj(job.awaiting_merge)?.pending === undefined;
/** The job's merge receipt, only when it names this job, a PR url and a full merge sha. */
export function mergeReceipt(state: ViewerState, id: string): Json | undefined {
 const receipt = readObject(join(state.stateDir,"runs",id,"merge.json"));
 return receipt?.job_id === id && timestamp(receipt.merged_at) && isSafeChangeRequestUrl(str(receipt.pr_url) ?? "") && /^[a-f0-9]{40}$/i.test(str(receipt.merge_commit_sha) ?? "") ? receipt : undefined;
}
/** Merged today, newest first; `cost_usd` is the Jobs list's (the same `rows`, every finished one included), null when no row (audit P3 #20). */
export function shipped(state: ViewerState, jobs: Json[], ledger: Json[], now: number, rows: readonly JobRow[]): ShippedJob[] {
 return jobs.flatMap(j => {
  const id = String(j.job_id); const receipt = mergeReceipt(state,id);
  if (!receipt || !today(receipt.merged_at,now)) return [];
  const row = rows.find(r => r.job_id === id);
  return [{id, title:str(ledger.find(l => l.id === id)?.title) ?? null, merged_at:String(receipt.merged_at), merge_sha:String(receipt.merge_commit_sha), pr_url:String(receipt.pr_url), cost_usd:row ? row.cost_usd + row.reviewer_cost_usd : null}];
 }).sort((a,b) => b.merged_at.localeCompare(a.merged_at));
}
/** Audit P3 #17: a failed fleet job is the top blocker. Its cause is the failure headline, one line of at most 80 chars. */
export function failedJobs(state: ViewerState, jobs: Json[], ledger: Json[]): FailedJob[] {
 return jobs.filter(j => j.phase === "failed").map(j => {
  const id = String(j.job_id);
  const message = (str(obj(readStatus(state,id)?.failure)?.message) ?? str(obj(j.failure)?.message))?.split("\n").find(line => line.trim())?.trim();
  return {id, project:String(j.project), title:str(ledger.find(l => l.id === id)?.title) ?? null, failure:message ? message.length > 80 ? `${message.slice(0,79)}…` : message : null};
 });
}
/**
 * Done today without a merge receipt: the Board's "Landed today" less the merged rows (audit P2 #12). Same phase and
 * finish order as `jobsView`: a done fleet job (or a closed ledger job the fleet never saw), finished at its fleet close,
 * run exit or ledger close.
 */
export function closedToday(state: ViewerState, jobs: Json[], ledger: Json[], now: number): number {
 const ids = [...new Set([...ledger.map(j => String(j.id)),...jobs.map(j => String(j.job_id))])];
 return ids.filter(id => {
  const entry = jobs.find(j => j.job_id === id); const job = ledger.find(j => j.id === id);
  if (entry ? entry.phase !== "done" : job?.status !== "closed") return false;
  const at = [entry?.closed_at].find(timestamp) ?? [readStatus(state,id)?.exited_at,job?.closed_at].find(timestamp);
  return today(at,now) && !mergeReceipt(state,id);
 }).length;
}
export function grantFor(job: Json, grants: Json[], now: number): Json | undefined {
 const labels = strings(job.labels); const project = labels.find(l => l.startsWith("project:"))?.slice(8) ?? ""; const kind = labels.find(l => l.startsWith("kind:"))?.slice(5);
 const matching = grants.filter(m => strings(m.projects).includes(project) && (!strings(m.job_ids).length || strings(m.job_ids).includes(String(job.id))) && (!kind || !strings(obj(m.exclusions)?.job_kinds).includes(kind)));
 const order = (m: Json) => ({id:String(m.id), issued_at:String(m.issued_at ?? ""), job_ids:strings(m.job_ids)});
 return matching.filter(m => m.status === "active" && Date.parse(String(m.expiry)) > now).sort((a,b) => compareActiveGrants(order(a),order(b)))[0] ?? matching.at(-1);
}
export function blocked(ledger: Json[], grants: Json[], jobs: Json[], now: number, available: boolean) {
 const items: BlockedJob[] = [];
 const stranded = new Set<string>();
 for (const job of ledger.filter(j => j.status !== "closed")) {
  const blockers = strings(job.blocked_by).flatMap(id => {
   if (!isSafeId(id)) return [];
   const dependency = ledger.find(j => j.id === id);
   const dropped = dependency?.status === "closed" && (str(dependency.close_reason) ?? "").startsWith("dropped:");
   if (dependency?.status === "closed" && !dropped) return [];
   const grant = dependency ? grantFor(dependency,grants,now) : undefined;
   const grant_status = grant ? Date.parse(String(grant.expiry)) <= now ? "expired" : String(grant.status) : null;
   const isStranded = !dependency || dropped || grant_status !== "active";
   if (isStranded) stranded.add(id);
   return [{id, phase:str(jobs.find(j => j.job_id === id)?.phase) ?? null, grant_status, mandate_id:grant ? String(grant.id) : null, stranded:isStranded}];
  });
  if (blockers.length) items.push({id:String(job.id), title:str(job.title) ?? null, blockers});
 }
 return {items, stranded_count:available ? stranded.size : null};
}
