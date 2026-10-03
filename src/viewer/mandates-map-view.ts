import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { MandatesResponse, MapResponse, MapNode } from "./api-types.ts";
import { JOB_STATUSES } from "../contracts.ts";
import { jobRow, mandateSpend, spendJobs } from "./fleet-view.ts";
import { grantFor } from "./overview-jobs.ts";
import { nonnegative, objectList, parseObject, readBounded, source, strings, text, timestamp, today } from "./overview-read.ts";
import { isSafeId, obj, runtimeRoot, str, type Json, type ViewerState } from "./sessions.ts";
import { modelWindows, workerContext } from "./context-usage.ts";

function sources(state: ViewerState) {
 const grants = source<Json[]>(() => readdirSync(join(state.stateDir,"mandates")).filter(n => /^md-[A-Za-z0-9_-]+\.json$/.test(n)).map(name => {
  const m = parseObject(readBounded(join(state.stateDir,"mandates",name)));
  if (!m || !text(m.id) || !isSafeId(m.id) || !["active","paused","revoked","expired"].includes(str(m.status) ?? "") || !timestamp(m.expiry) || !timestamp(m.issued_at) || !Array.isArray(m.projects) || !m.projects.every(text) || !obj(m.spend_cap)) throw new Error("invalid mandate");
  return m;
 }).sort((a,b) => String(a.issued_at).localeCompare(String(b.issued_at)) || String(a.id).localeCompare(String(b.id))), []);
 const ledger = objectList(join(runtimeRoot(state.home),"jobs.json"),"jobs",j => typeof j.id === "string" && isSafeId(j.id) && (JOB_STATUSES as readonly string[]).includes(str(j.status) ?? "") && (j.blocked_by === undefined || Array.isArray(j.blocked_by) && j.blocked_by.every(id => typeof id === "string" && isSafeId(id))));
 const fleet = objectList(join(state.stateDir,"fleet.json"),"jobs",j => typeof j.job_id === "string" && isSafeId(j.job_id) && text(j.project) && ["waiting","held","done","failed","launching"].includes(str(j.phase) ?? ""));
 return {grants,ledger,fleet,escalations:mandateEscalations(state)};
}
export function mandateEscalations(state: ViewerState) {
 return objectList(join(state.stateDir,"escalations.json"),"items",e=>text(e.id) && text(e.kind) && ["open","answered","withdrawn","superseded"].includes(String(e.status)) && (e.status!=="answered" || text(e.answer) && timestamp(e.answered_at)));
}
/**
 * A mandate's display status, the one rule Map and Board share (audit P2 #11): a grant whose named jobs are all
 * closed today shows "closed". Display completion only: no grant authority is changed, and broad grants cannot imply mission end.
 */
export function mandateDisplay(m: Json, ledger: Json[], escalations: Json[], now: number): {status: string; closed_at?: string} {
 const named=strings(m.job_ids).map(id=>ledger.find(j=>j.id===id));
 const completed=named.length>0 && named.every(j=>j?.status==="closed" && timestamp(j.closed_at) && Date.parse(j.closed_at)<=now);
 const lastClose=completed ? named.map(j=>String(j!.closed_at)).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1) : undefined;
 const missionClosed=m.status==="revoked" && today(m.revoked_at,now) && Date.parse(String(m.revoked_at))<=now && escalations.some(e=>
  e.mandate_id===m.id && e.kind==="mission_end" && e.status==="answered" && Date.parse(String(e.answered_at))<=Date.parse(String(m.revoked_at)) &&
  (Array.isArray(e.options) ? e.options : []).map(obj).some(o=>o?.id==="close" && ["close",str(o.label)?.toLowerCase()].includes(String(e.answer).trim().toLowerCase())));
 const closedAt=missionClosed ? String(m.revoked_at) : m.status!=="paused" && m.status!=="revoked" && today(lastClose,now) ? lastClose : undefined;
 return {status:m.status === "revoked" || m.status === "paused" ? String(m.status) : closedAt ? "closed" : Date.parse(String(m.expiry)) <= now ? "expired" : String(m.status), ...(closedAt ? {closed_at:closedAt} : {})};
}
function project(job: Json): string { return strings(job.labels).find(l => l.startsWith("project:"))?.slice(8) ?? str(job.project) ?? "Unknown project"; }
function projectMandates(state: ViewerState, input: ReturnType<typeof sources>, now: number, usage = input.fleet.availability === "unavailable" ? [] : spendJobs(state,input.grants.value)): MandatesResponse {
 const {grants,ledger,fleet,escalations}=input;
 const assignments = new Map(ledger.value.map(j => [j,grantFor(j,grants.value,now)?.id]));
 const items = grants.value.map(m => {
  return {
  id:String(m.id), ...mandateDisplay(m,ledger.value,escalations.value,now),
  projects:strings(m.projects), objective:str(m.objective) ?? "", expiry:String(m.expiry), pause_reason:str(m.pause_reason) ?? null,
  ask_on:strings(m.ask_on), spend_cap:{usd:nonnegative(obj(m.spend_cap)?.usd),tokens:nonnegative(obj(m.spend_cap)?.tokens)},job_cap:nonnegative(m.job_cap),dispatch_parallelism:nonnegative(m.dispatch_parallelism),
  spend:fleet.availability === "unavailable" ? null : mandateSpend(m,usage),
  job_ids:ledger.value.filter(j => assignments.get(j) === m.id).map(j => String(j.id)),
 }; });
 const count=(status:string) => grants.availability === "unavailable" ? null : items.filter(m=>m.status===status).length;
 return {generated_at:new Date(now).toISOString(),availability:{mandates:grants.availability,fleet:fleet.availability,ledger:ledger.availability,escalations:escalations.availability},items,active_count:count("active"),paused_count:count("paused"),revoked_count:count("revoked")};
}
export function dependencyMap(state: ViewerState, now=Date.now()): MapResponse {
 const input=sources(state);const {ledger,fleet,grants}=input;
 const usage=fleet.availability === "unavailable" ? [] : spendJobs(state,grants.value);
 const data=projectMandates(state,input,now,usage);
 const rows=new Map(usage.map(entry=>[entry.job_id,jobRow(state,entry,undefined)]));
 const watched=objectList(join(state.stateDir,"ci-watch.json"),"jobs",j=>text(j.job_id)); const windows=modelWindows(state.stateDir);
 const ids=new Set([...ledger.value.map(j=>String(j.id)),...fleet.value.map(j=>String(j.job_id)),...ledger.value.flatMap(j=>strings(j.blocked_by))]);
 const nodes:MapNode[]=[...ids].sort().map(id=>{
  const job=ledger.value.find(j=>j.id===id); const entry=fleet.value.find(j=>j.job_id===id);
  const detail=rows.get(id);
  const p=job ? project(job) : str(entry?.project) ?? "Unknown project";
  const grant=grantFor(job ?? {id,labels:[`project:${p}`,`kind:${str(entry?.kind) ?? ""}`]},grants.value,now);
  const phase=entry ? entry.phase === "waiting" ? detail?.run_phase === "starting" ? "launching" : detail?.run_phase ?? "waiting" : String(entry.phase) : fleet.availability === "unavailable" ? "unknown" : job?.status === "closed" ? "done" : "not dispatched";
  return {id,title:str(job?.title) ?? id,project:p,mandate_id:grant ? String(grant.id) : null,phase,ledger_status:str(job?.status) ?? null,model:detail?.model ?? null,cost_usd:detail ? detail.cost_usd+detail.reviewer_cost_usd : entry || fleet.availability === "unavailable" ? null : 0,pr_url:detail?.pr_url ?? null,...(detail?.pr_status ? {pr_status:detail.pr_status} : {}),ci:str(watched.value.find(w=>w.job_id===id)?.last_ci) ?? null,context:entry ? workerContext(state,id,detail?.model,windows) : null};
 });
 const available=ledger.availability !== "unavailable" && grants.availability !== "unavailable";
 const edges:MapResponse["edges"]=ledger.value.flatMap(j=>strings(j.blocked_by).map(from=>{
  const blocker=ledger.value.find(b=>b.id===from);
  const dropped=blocker?.status === "closed" && (str(blocker.close_reason) ?? "").startsWith("dropped:");
  const m=grants.value.find(m=>m.id===nodes.find(n=>n.id===from)?.mandate_id);
  const kind=blocker?.status === "closed" && !dropped ? "satisfied" : !available ? "unknown" : !blocker || dropped || m?.status !== "active" || Date.parse(String(m.expiry))<=now ? "stranded" : "open";
  return {from,to:String(j.id),kind};
 }));
 return {...data,nodes,edges,stranded_count:available ? edges.filter(e=>e.kind==="stranded" && nodes.find(n=>n.id===e.to)?.ledger_status !== "closed").length : null};
}
