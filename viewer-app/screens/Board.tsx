import { useState } from "preact/hooks";
import type { BoardResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, money, percent, prNumber, shortSha, time } from "../format.ts";
import { jobHref } from "../routes.ts";
import { PhaseDot, reviewText, CiSignal, ModelName } from "../components/JobSignals.tsx";
import { ContextChip } from "../components/ContextChip.tsx";
import { JobsViews } from "../components/JobsViews.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import "./jobs.css";
import "./board.css";

const laneId = (job:ViewerJob) => job.board_lane_id ?? job.mandate_id ?? "unassigned";
export function visibleBoard(data:BoardResponse, mandate:string) {
 const jobs = mandate === "all" ? data.jobs : data.jobs.filter(j=>laneId(j)===mandate);
 return {jobs, lanes:data.lanes.filter(l=>jobs.some(j=>laneId(j)===l.id))};
}
function Card({job,jobs}:{job:ViewerJob;jobs:ViewerJob[]}) {
 const blocks=jobs.filter(o=>o.blockers.includes(job.id));
 return <a class={`board-card board-card-${job.phase}`} href={jobHref(job.id)}>
  <span class="board-card-heading"><PhaseDot phase={job.phase}/><code>{job.id}</code></span>
  <span class="board-card-title" title={job.title ?? job.id}>{job.title ?? job.id}</span>
  <code class="board-card-mandate">{job.mandate_id ?? "unassigned"}</code>
  {job.phase==="queued" ? <span>not dispatched · ledger {job.ledger_status ?? "not recorded"}</span> : job.phase==="done" ? <span class="board-card-facts">
   <span>{job.pr_url ? `${prNumber(job.pr_url)} · ${job.pr_status === "merged" ? "merged" : job.pr_status ?? "status not recorded"}` : "closed without PR"}{job.merge_sha && ` ${shortSha(job.merge_sha)}`}{job.finished_at && ` · ${time(job.finished_at)}`}</span><span>{money(job.cost_usd)}</span>
  </span> : <>
   {job.failure && <span>{job.failure}</span>}
   <span class="job-clock">{elapsed(job.elapsed_seconds)} / {elapsed(job.limit_seconds)}{job.elapsed_seconds !== null && job.limit_seconds !== null && <progress aria-label="Wall clock" max="100" value={percent(job.elapsed_seconds,job.limit_seconds)}/>}</span>
   {job.context ? <ContextChip usage={job.context} compact/> : <span>context n/a</span>}
   <span class="board-card-facts"><span>{reviewText(job)}</span><CiSignal job={job}/></span>
   <span class="board-card-facts"><ModelName job={job}/><span>{money(job.cost_usd)}</span></span>
  </>}
  {job.summary && <span class="board-card-summary" title={job.summary}>{job.summary}</span>}
  {job.blockers.map(id=><span key={id} class="board-tag board-tag-blocked">blocked by {id}</span>)}
  {blocks.map(o=><span key={o.id} class="board-tag">blocks {o.id}</span>)}
  {job.note && <span class="board-tag board-tag-blocked"><span class="board-note" title={job.note}>{job.note}</span></span>}
  {job.ledger_disagrees && <span class="board-tag">ledger {job.ledger_status}</span>}
 </a>;
}
const matches=(job:ViewerJob,key:string)=>key==="waiting" ? ["waiting","idle"].includes(job.phase) : job.phase===key;
const COLUMN_ORDER=["held","working","waiting","launching","queued","failed","done"];
const LANDED_CARDS=4;
function Strip({column}:{column:BoardResponse["columns"][number]}) {
 return <div class="board-strip" aria-label={`${column.name} · 0`}><PhaseDot phase={column.key}/><span class="board-strip-name">{column.name}</span><span>0</span></div>;
}
export function Board({data}:{data:BoardResponse}) {
 const [mandate,setMandate]=useState("all");
 const visible=visibleBoard(data,mandate);
 const columns=COLUMN_ORDER.flatMap(key=>{const column=data.columns.find(c=>c.key===key);return column ? [column] : [];});
 const filled=columns.filter(c=>visible.jobs.some(j=>matches(j,c.key)));
 const folded=columns.filter(c=>!filled.includes(c));
 const selected=data.lanes.find(l=>l.id===mandate);
 return <div class="board-screen">
  <header class="board-heading"><PageHeader title="Jobs"/><JobsViews current="board"/></header>
  <div class="board-toolbar">
   <div class="board-filters" role="group" aria-label="Filter by mandate">
    <button type="button" aria-pressed={mandate==="all"} onClick={()=>setMandate("all")}>All mandates</button>
    {data.lanes.map(l=><button key={l.id} type="button" title={l.objective} aria-pressed={mandate===l.id} onClick={()=>setMandate(l.id)}><code>{l.id==="unassigned" ? "Unassigned" : l.id}</code><span class="board-chip-name">{l.objective}</span>{!l.active && <span class="board-chip-status">{l.status}</span>}</button>)}
   </div>
   <span class="board-desktop board-fold">Empty columns fold to the right</span>
  </div>
  {selected?.note && <p class="board-lane-note">{selected.note}</p>}
  {folded.length>0 && <p class="board-phone board-fold">Empty now: {folded.map(c=>c.name).join(" · ")} · swipe columns</p>}
  <div class="board-columns" role="region" aria-label="Board columns">
   {filled.map(col=>{
    const jobs=visible.jobs.filter(j=>matches(j,col.key));
    if(col.key==="done") jobs.sort((a,b)=>(b.finished_at ?? "").localeCompare(a.finished_at ?? "") || a.id.localeCompare(b.id));
    const shown=col.key==="done" ? jobs.slice(0,LANDED_CARDS) : jobs;
    return <section key={col.key} class="board-column" aria-label={col.name}>
     <div class="board-column-heading"><h2><PhaseDot phase={col.key}/>{col.name}<span>{jobs.length}</span></h2><p>{col.hint}{col.key==="done" && " · newest first"}</p></div>
     {shown.map(job=><Card key={job.id} job={job} jobs={data.jobs}/>)}
     {jobs.length>shown.length && <a class="board-more" href="#jobs">Show {jobs.length-shown.length} more in the list</a>}
    </section>;
   })}
   {folded.map(col=><Strip key={col.key} column={col}/>)}
   {!visible.jobs.length && <p class="board-empty">Nothing here</p>}
  </div>
  <p class="board-footer">{data.stranded_count===null ? "Dependency status unavailable." : data.stranded_count ? `${data.stranded_count} stranded dependencies.` : "No stranded dependencies."} {data.revoked_hidden} revoked mandates hidden.</p>
 </div>;
}
