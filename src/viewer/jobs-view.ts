import { JOB_STATUSES } from "../contracts.ts";
import { realpathSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { BoardResponse, JobResponse, JobsResponse, ViewerJob, JobPhase } from "./api-types.ts";
import { dashboard, readMandates, PR_URL } from "./fleet-view.ts";
import { jobRoot, listOrRead } from "./explorer.ts";
import { overview } from "./overview-view.ts";
import { decisions } from "./overview-decisions.ts";
import { SHA } from "./git-read.ts";
import { recordedEvents, routingText } from "./overview-health.ts";
import { mandateDisplay, mandateEscalations } from "./mandates-map-view.ts";
import { objectList, strings, text, timestamp, today, parseObject, source, nonnegative, readBounded } from "./overview-read.ts";
import { isSafeId, obj, readObject, readStatus, runtimeRoot, str, type Json, type ViewerState } from "./sessions.ts";
import { modelWindows, workerContext } from "./context-usage.ts";
import { readLines, startOffset } from "./tail.ts";

function records(state:ViewerState) {
 const fleet=objectList(join(state.stateDir,"fleet.json"),"jobs",j=>typeof j.job_id === "string" && isSafeId(j.job_id) && text(j.project));
 const ledger=objectList(join(runtimeRoot(state.home),"jobs.json"),"jobs",j=>typeof j.id === "string" && isSafeId(j.id) && (JOB_STATUSES as readonly string[]).includes(str(j.status) ?? ""));
 return {fleet:fleet.value,ledger:ledger.value,grants:readMandates(state)};
}
function dispatchMandate(state:ViewerState,id:string,entry:Json | undefined,status:Json | undefined):string | null {
 const valid=(value:unknown)=>typeof value==="string" && /^md-[A-Za-z0-9_-]+$/.test(value) ? value : null;
 const saved=valid(entry?.mandate_id) ?? valid(status?.mandate_id);
 if(saved) return saved;
 const file=jobEventsFile(state,id); if(!file) return null;
 for(const event of recordedEvents(state,id)) {
  if(!["spawned","routing_resolved"].includes(str(event.type) ?? "") || (event.job_id!==undefined && event.job_id!==id)) continue;
  const mandate=valid(obj(event.payload)?.mandate_id); if(mandate) return mandate;
 }
 return null;
}
function covering(job:Json, project:string, grants:Json[], kind:string | undefined, now:number, dispatchedAt:unknown):Json | undefined {
 // Legacy coverage is inference, never proof of dispatch authorization.
 const at=timestamp(dispatchedAt) ? Date.parse(dispatchedAt) : now;
 const matches=grants.filter(m=>{
  if(!timestamp(m.expiry) || !timestamp(m.issued_at) || Date.parse(m.issued_at)>at || !strings(m.projects).includes(project) || (strings(m.job_ids).length && !strings(m.job_ids).includes(String(job.id ?? job.job_id))) || (kind && strings(obj(m.exclusions)?.job_kinds).includes(kind))) return false;
  const live=["active","paused"].includes(String(m.status)) && Date.parse(m.expiry)>now;
  const historical=timestamp(dispatchedAt) && strings(m.job_ids).length>0 && Date.parse(m.expiry)>at && (m.status!=="revoked" || timestamp(m.revoked_at) && Date.parse(m.revoked_at)>at);
  return live || historical;
 });
 return matches.findLast(m=>strings(m.job_ids).length>0) ?? matches.at(-1);
}
export function jobsView(state:ViewerState, now=Date.now(), base=overview(state,now)):JobsResponse {
 const {fleet,ledger,grants}=records(state); const windows=modelWindows(state.stateDir);
 const rows = new Map(dashboard(state,now,Infinity).projects.flatMap(p=>p.jobs).map(j=>[j.job_id,j]));
 const watched=readObject(join(state.stateDir,"ci-watch.json"))?.jobs;
 const ciRows=Array.isArray(watched) ? watched.map(obj) : [];
 const ids=[...new Set([...ledger.map(j=>String(j.id)),...fleet.map(j=>String(j.job_id))])];
 const jobs:ViewerJob[]=ids.map(id=>{
  const entry=fleet.find(j=>j.job_id===id); const job=ledger.find(j=>j.id===id);
  const detail=rows.get(id); const live=base.in_flight.find(j=>j.id===id);
  const ci=ciRows.find(j=>j?.job_id===id); const envelope=obj(readObject(join(state.stateDir,"runs",id,"envelope.json"))?.envelope);
  const head=[ci?.head_sha,envelope?.head_sha].find(v=>typeof v==="string" && SHA.test(v)) as string | undefined;
  const labels=strings(job?.labels); const project=str(entry?.project) ?? labels.find(l=>l.startsWith("project:"))?.slice(8) ?? "Unassigned";
  const phase:JobPhase=live ? live.phase as JobPhase : entry?.phase === "failed" ? "failed" : entry?.phase === "done" || (!entry && job?.status === "closed") ? "done" : "queued";
  const status=readStatus(state,id); const receipt=readObject(join(state.stateDir,"runs",id,"merge.json"));
  const merged=receipt?.job_id===id && timestamp(receipt.merged_at) && PR_URL.test(str(receipt.pr_url) ?? "") && /^[a-f0-9]{40}$/i.test(str(receipt.merge_commit_sha) ?? "");
  const failureAt=phase==="failed" ? [obj(entry?.failure)?.at,obj(status?.failure)?.at].find(timestamp) : undefined;
  const finished=merged ? String(receipt.merged_at) : [failureAt,entry?.closed_at,status?.exited_at,job?.closed_at].find(timestamp) ?? null;
  const started=[status?.started_at,entry?.dispatched_at].find(timestamp);
  const ended=[status?.exited_at,entry?.closed_at,failureAt].find(timestamp);
  const duration=started ? Math.max(0,((ended ? Date.parse(ended) : now)-Date.parse(started))/1000) : null;
  const mandate=dispatchMandate(state,id,entry,status) ?? str(covering(job ?? entry ?? {},project,grants,str(entry?.kind) ?? labels.find(l=>l.startsWith("kind:"))?.slice(5),now,entry?.dispatched_at)?.id) ?? null;
  const ledgerStatus=str(job?.status) ?? null;
  const expected=phase==="done" ? "closed" : phase==="queued" ? "open" : "in_progress";
  return {id,project,title:str(job?.title) ?? null,phase,model:detail?.model ?? null,script_path:detail?.script_path ?? null,
   elapsed_seconds:live?.elapsed_seconds ?? duration,limit_seconds:live?.limit_seconds ?? nonnegative(obj(entry?.bounds)?.wall_clock_seconds),head:head ?? null,
   ci:head && ci?.head_sha===head ? str(ci.last_ci) ?? null : null,review:live?.review ?? null,review_attempts:live?.review_attempts ?? 0,
   routing:live?.routing ?? (entry ? routingText(state,entry) : null),note:live?.note ?? null,ledger_status:ledgerStatus,ledger_disagrees:ledgerStatus!==null && (phase==="failed" || ledgerStatus!==expected),mandate_id:mandate,
   cost_usd:detail ? detail.cost_usd+detail.reviewer_cost_usd : null,pr_url:merged ? String(receipt.pr_url) : detail?.pr_url ?? null,pr_status:merged ? "merged" : detail?.pr_status ?? null,
   finished_at:finished,finished_today:today(finished,now),merge_sha:merged ? String(receipt.merge_commit_sha) : null,
   // A failure is shown only while the job is failed: a revived, held or landed job's old failure is history, not state (audit P2 #10).
   failure:phase==="failed" ? str(obj(status?.failure)?.message) ?? str(obj(entry?.failure)?.message) ?? null : null,
   blockers:base.blocked.items.find(j=>j.id===id)?.blockers.map(b=>b.id) ?? [],context:entry ? workerContext(state,id,detail?.model,windows) : null};
 });
 return {generated_at:base.generated_at,awaiting_count:base.awaiting.count,jobs,
  projects:[...new Set([...jobs.map(j=>j.project),...base.mandates.paused_projects])].sort().map(name=>({name,paused:base.mandates.paused_projects.includes(name)})),warnings:base.warnings};
}
export function boardView(state:ViewerState,now=Date.now()):BoardResponse {
 const base=overview(state,now);
 const data=jobsView(state,now,base); const grants=readMandates(state); const accounting=dashboard(state,now).mandates;
 const ledger=records(state).ledger; const escalations=mandateEscalations(state).value;
 const eligible=grants.filter(m=>["active","paused"].includes(String(m.status)) && Date.parse(String(m.expiry))>now || today(m.revoked_at ?? m.closed_at ?? m.expiry,now));
 let lanes=eligible.map(m=>{const shown=mandateDisplay(m,ledger,escalations,now);const status=shown.closed_at ? "closed" : shown.status;return {id:String(m.id),status,active:status==="active" && Date.parse(String(m.expiry))>now,
  objective:str(m.objective) ?? "",expiry:timestamp(m.expiry) ? m.expiry : null,ask_on:strings(m.ask_on),spend:accounting.find(a=>a.id===m.id)?.spend.usd ?? null,cap:typeof obj(m.spend_cap)?.usd === "number" ? obj(m.spend_cap)!.usd as number : null,note:str(m.pause_reason) ?? null};});
 // Keep historical provenance even when the job belongs in Unassigned today.
 const jobs=data.jobs.filter(j=>j.phase!=="done" || j.finished_today).map(j=>({...j,board_lane_id:lanes.some(l=>l.id===j.mandate_id && (l.active || l.status==="paused" || l.status==="closed" || j.phase==="done" && j.finished_today)) ? j.mandate_id! : "unassigned"}));
 if(jobs.some(j=>j.board_lane_id==="unassigned")) lanes.push({id:"unassigned",status:"unassigned",active:true,objective:"No covering live grant",expiry:null,ask_on:[],spend:null,cap:null,note:null});
 lanes=lanes.filter(l=>jobs.some(j=>j.board_lane_id===l.id)).sort((a,b)=>Number(b.active)-Number(a.active));
 return {...data,jobs,lanes,columns:[
  {key:"queued",name:"Queued",hint:"blocked, or waiting for a slot"},{key:"launching",name:"Launching",hint:"worker starting"},
  {key:"working",name:"Working",hint:"worker running"},{key:"held",name:"Held",hint:"waiting on CI or review, normal for hours"},
  {key:"done",name:"Landed today",hint:"merged or closed"},{key:"failed",name:"Failed",hint:"stopped; may continue on its lease"}],
  revoked_hidden:grants.filter(m=>m.status==="revoked" && !lanes.some(l=>l.id===m.id)).length,stranded_count:base.blocked.stranded_count};
}
const eventLabels:Record<string,string>={spawned:"Spawned",envelope_received:"Report filed",review_decided:"Review",failure:"Failed",worker_revived:"Worker revived",question_asked:"Question asked",question_closed:"Question closed",ci_observed:"CI observed",merge_recorded:"Merge recorded"};
export function jobEventsFile(state:ViewerState,id:string):string | undefined {
 if(!isSafeId(id)) return undefined;
 try {
  const file=join(realpathSync(join(state.stateDir,"runs")),id,"events.jsonl");
  return realpathSync(file)===file && statSync(file).isFile() ? file : undefined;
 } catch { return undefined; }
}
export function jobEvents(state:ViewerState,id:string):string | undefined {
 const file=jobEventsFile(state,id);
 return file ? source(()=>readBounded(file),undefined).value : undefined;
}
/** The job's reported artifact as a Files link, when its envelope names one the explorer can read. */
export function jobArtifact(state:ViewerState,id:string):{href:string;name:string} | null {
 const root=jobRoot(state,id); const env=obj(readObject(join(state.stateDir,"runs",id,"envelope.json"))?.envelope);
 const artifact=str(env?.artifact_path); const rel=root && artifact ? relative(root.path,artifact) : null;
 return root && rel && listOrRead(state,root.id,rel)?.kind==="file" ? {href:`/#files?${new URLSearchParams({root:root.id,path:rel})}`,name:basename(artifact!)} : null;
}
export function jobView(state:ViewerState,id:string,now=Date.now()):JobResponse | undefined {
 if(!isSafeId(id)) return undefined;
 const data=jobsView(state,now); const job=data.jobs.find(j=>j.id===id); if(!job) return undefined;
 const file=jobEventsFile(state,id);
 const events=source(()=>{if(!file) return null;const start=startOffset(file,undefined);return {start:start.offset,chunk:readLines(file,start.offset)};},null);
 const timeline:JobResponse["timeline"]=[];
 let malformed=false;
 for(const line of events.value?.chunk.lines ?? []) {
  const event=parseObject(line.text); if(!event) {malformed=true;continue;}
  if(event.source!=="cp" || !timestamp(event.ts) || (event.job_id!==undefined && event.job_id!==id)) continue;
  let label=eventLabels[str(event.type) ?? ""]; if(!label) continue;
  const payload=obj(event.payload);
  const verdict=str(payload?.verdict); const observation=str(payload?.event);
  if(event.type==="review_decided") label=`Review ${nonnegative(payload?.attempt) ?? "-"} · ${verdict==="revise" ? "changes requested" : verdict ?? "unknown"}`;
  if(event.type==="ci_observed") label=({ci_green:"CI green",ci_failed:"CI red",pr_merged:"PR merged",pr_closed:"PR closed unmerged"} as Record<string,string>)[observation ?? ""] ?? "CI observed";
  const meta=[str(payload?.model),str(payload?.reason),str(payload?.head_sha)].filter(Boolean).join(" · ");
  timeline.push({at:event.ts,label,meta,tone:event.type==="failure" || observation==="ci_failed" ? "red" : observation==="ci_green" ? "green" : "neutral"});
 }
 if(job.merge_sha && job.finished_at) timeline.push({at:job.finished_at,label:"Merge",meta:job.merge_sha,tone:"green"});
 timeline.sort((a,b)=>a.at.localeCompare(b.at));
 const root=jobRoot(state,id); const artifact=jobArtifact(state,id);
 const base=overview(state,now); const decision=decisions(state,now);
 return {generated_at:data.generated_at,awaiting_count:data.awaiting_count,job,timeline:timeline.slice(-200),timeline_truncated:(events.value?.start ?? 0)>0 || timeline.length>200,
  files_href:root ? `/#files?${new URLSearchParams({root:root.id,path:""})}` : null,
  artifact_href:artifact?.href ?? null,artifact_name:artifact?.name ?? null,
  run_href:file ? `/api/job/${encodeURIComponent(id)}/events` : null,asks:base.awaiting.items.filter(a=>a.job_ids.includes(id) || decision.escalations.value.some(q=>q.id===a.source_escalation && strings(q.job_ids).includes(id))),questions:base.parent_questions.filter(q=>q.job_ids.includes(id)),
  warnings:[...data.warnings,...(malformed || events.availability==="unavailable" ? [{section:"timeline",message:"Some recorded events are unavailable or malformed."}] : [])]};
}
