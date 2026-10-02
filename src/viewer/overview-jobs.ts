import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { BlockedJob, FailedJob, FlightJob, ShippedJob } from "./api-types.ts";
import { type JobRow, PR_URL } from "./fleet-view.ts";
import { SHA } from "./git-read.ts";
import { isSafeId, obj, readObject, readStatus, str, type Json, type ViewerState } from "./sessions.ts";
import { nonnegative, strings, timestamp, today } from "./overview-read.ts";
import { routingText } from "./overview-health.ts";

/** `rows`: the dashboard's job rows, every finished one included (`dashboard(state,now,Infinity)`), computed once by `overview`. */
export function flights(state: ViewerState, jobs: Json[], escalations: Json[], now: number, rows: readonly JobRow[]): FlightJob[] {
 const watched = readObject(join(state.stateDir,"ci-watch.json"))?.jobs;
 const ciRows = Array.isArray(watched) ? watched.map(obj) : [];
 return jobs.filter(j => ["waiting","held","launching"].includes(String(j.phase))).map(job => {
  const id = String(job.job_id); const status = readStatus(state,id);
  const ci = ciRows.find(row => row?.job_id === id);
  const envelope = obj(readObject(join(state.stateDir,"runs",id,"envelope.json"))?.envelope);
  const head = [ci?.head_sha,envelope?.head_sha].find((v): v is string => typeof v === "string" && SHA.test(v)) ?? null;
  const started = status?.started_at ?? job.dispatched_at;
  const exited = status?.exited_at ?? obj(job.worker)?.exited_at;
  const elapsed = timestamp(started) ? Math.max(0, ((timestamp(exited) ? Date.parse(exited) : now) - Date.parse(started))/1000) : null;
  let names: string[] = []; try { names = readdirSync(join(state.stateDir,"runs",id)); } catch { /* No recorded reviews. */ }
  const attempts = names.filter(n => /^review-[1-9]\d*\.json$/.test(n));
  const reviews = attempts.map(name => readObject(join(state.stateDir,"runs",id,name))).filter((v): v is Json => !!v);
  if (head) { const equivalent = readObject(join(state.stateDir,"runs",id,`review-equivalent-${head}.json`)); if (equivalent) reviews.push(equivalent); }
  const review = reviews.filter(r => head && r.head_sha === head && obj(r.diff_stat)?.truncated === false).sort((a,b) => (str(a.decided_at) ?? "").localeCompare(str(b.decided_at) ?? "")).at(-1);
  const row = rows.find(r => r.job_id === id);
  const runPhase = str(status?.phase);
  return {id, project:String(job.project), title:row?.title ?? null,
   phase:job.phase === "held" ? "held" : job.phase === "launching" || runPhase === "starting" ? "launching" : ["working","idle"].includes(runPhase ?? "") ? runPhase! : "waiting",
   model:row?.model ?? null, script_path:job.executor === "script" ? str(job.script_path) ?? "script" : null,
   elapsed_seconds:elapsed, limit_seconds:nonnegative(obj(job.bounds)?.wall_clock_seconds) || null, head,
   ci:head && ci?.head_sha === head ? str(ci.last_ci) ?? null : null,
   review:str(review?.verdict) ?? null, review_attempts:Math.min(5,attempts.length), routing:routingText(state,job),
   note:escalations.filter(e => e.status === "open" && strings(e.job_ids).includes(id)).map(e => `${e.id}: ${e.question}`).join(" · ") || null, pr_url:row?.pr_url ?? null};
 });
}
/** The job's merge receipt, only when it names this job, a PR url and a full merge sha. */
export function mergeReceipt(state: ViewerState, id: string): Json | undefined {
 const receipt = readObject(join(state.stateDir,"runs",id,"merge.json"));
 return receipt?.job_id === id && timestamp(receipt.merged_at) && PR_URL.test(str(receipt.pr_url) ?? "") && /^[a-f0-9]{40}$/i.test(str(receipt.merge_commit_sha) ?? "") ? receipt : undefined;
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
 return matching.findLast(m => m.status === "active" && Date.parse(String(m.expiry)) > now) ?? matching.at(-1);
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
