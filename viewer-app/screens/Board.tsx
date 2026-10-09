import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { BoardResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, money, prNumber, time } from "../format.ts";
import { jobHref } from "../routes.ts";
import { PhaseDot, CiSignal } from "../components/JobSignals.tsx";
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
  {job.phase==="queued" ? <span>not dispatched · ledger {job.ledger_status ?? "not recorded"}</span> : job.phase==="done" ? <span class="board-card-meta">{[job.pr_url ? `${prNumber(job.pr_url)} · ${job.pr_status === "merged" ? "merged" : job.pr_status ?? "status not recorded"}` : "closed without PR",job.finished_at && time(job.finished_at),money(job.cost_usd)].filter(Boolean).join(" · ")}</span> : <>
   {job.failure && <span>{job.failure}</span>}
   <span class="board-card-facts"><span class="board-card-meta">{job.phase} · {elapsed(job.elapsed_seconds)} / {elapsed(job.limit_seconds)} · {money(job.cost_usd)}</span><CiSignal job={job}/></span>
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
type Opt={id:string;sub:string;status:string};
function Strip({column}:{column:BoardResponse["columns"][number]}) {
 return <div class="board-strip" aria-label={`${column.name} · 0`}><PhaseDot phase={column.key}/><span class="board-strip-name">{column.name}</span><span>0</span></div>;
}
export function Board({data}:{data:BoardResponse}) {
 const [mandate,setMandate]=useState("all");
 const [open,setOpen]=useState(false);
 const [query,setQuery]=useState("");
 const [revoked,setRevoked]=useState(false);
 const [cursor,setCursor]=useState(0);
 const visible=visibleBoard(data,mandate);
 const columns=COLUMN_ORDER.flatMap(key=>{const column=data.columns.find(c=>c.key===key);return column ? [column] : [];});
 const filled=columns.filter(c=>visible.jobs.some(j=>matches(j,c.key)));
 const folded=columns.filter(c=>!filled.includes(c));
 const selected=data.lanes.find(l=>l.id===mandate);
 const hidden=data.hidden_mandates;
 const q=query.trim().toLowerCase();
 const fits=(o:Opt)=>!q || `${o.id} ${o.sub} ${o.status}`.toLowerCase().includes(q);
 const lane=(l:BoardResponse["lanes"][number]):Opt=>({id:l.id,sub:l.objective,status:l.status});
 const activeOpts=data.lanes.filter(l=>l.active && l.id!=="unassigned").map(lane).filter(fits);
 const otherOpts=[...data.lanes.filter(l=>!l.active || l.id==="unassigned").map(lane),...(revoked ? hidden.map(m=>({id:m.id,sub:m.objective,status:m.status})) : [])].filter(fits);
 const allOpt:Opt={id:"all",sub:"",status:""};
 const flat=[...(fits({...allOpt,sub:"All mandates"}) ? [allOpt] : []),...activeOpts,...otherOpts];
 const at=Math.min(cursor,Math.max(0,flat.length-1));
 const pick=(id:string)=>{setMandate(id);setOpen(false);};
 const keys=(e:KeyboardEvent)=>{
  if(e.key==="ArrowDown"){e.preventDefault();setCursor(Math.min(at+1,flat.length-1));}
  else if(e.key==="ArrowUp"){e.preventDefault();setCursor(Math.max(at-1,0));}
  else if(e.key==="Enter"){e.preventDefault();if(flat[at]) pick(flat[at]!.id);}
  else if(e.key==="Escape"){e.preventDefault();setOpen(false);}
 };
 const option=(o:Opt,label:ComponentChildren)=><li key={o.id} id={`board-opt-${o.id}`} role="option" aria-selected={mandate===o.id} class={flat[at]?.id===o.id ? "board-option board-option-cursor" : "board-option"} title={o.sub || undefined} onClick={()=>pick(o.id)}>{label}</li>;
 const row=(o:Opt)=>option(o,<><code>{o.id==="unassigned" ? "Unassigned" : o.id}</code><span class="board-option-name">{o.sub}</span>{o.status && o.status!=="active" && <span class="board-option-status">{o.status}</span>}</>);
 const current=mandate==="all" ? "All mandates" : mandate==="unassigned" ? "Unassigned" : mandate;
 const status=data.stranded_count===null ? "Dependency status unavailable." : data.stranded_count ? `${data.stranded_count} stranded dependencies.` : "No stranded dependencies.";
 return <div class="board-screen">
  <header class="board-heading"><PageHeader title="Jobs"/><JobsViews current="board"/></header>
  <div class="board-toolbar">
   <div class="board-picker">
    <button type="button" class="board-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={()=>{setOpen(!open);setQuery("");setCursor(0);}}><span class="board-trigger-label">Mandate</span><code>{current}</code></button>
    {open && <div class="board-popover" onKeyDown={keys}>
     <div class="board-sheet-title"><strong>Mandate</strong><button type="button" onClick={()=>setOpen(false)}>Done</button></div>
     <div class="board-popover-filter"><input type="text" role="combobox" aria-expanded="true" aria-controls="board-listbox" aria-activedescendant={flat[at] ? `board-opt-${flat[at]!.id}` : undefined} aria-label="Filter mandates" placeholder="Filter mandates" autoFocus value={query} onInput={e=>{setQuery((e.target as HTMLInputElement).value);setCursor(0);}}/><span class="board-desktop board-keyhint" aria-hidden="true">↑↓ ↵</span></div>
     <ul id="board-listbox" role="listbox" aria-label="Mandate">
      {fits({...allOpt,sub:"All mandates"}) && option(allOpt,<span class="board-option-name">All mandates · {data.jobs.length} jobs</span>)}
      {activeOpts.length>0 && <li role="presentation" class="board-group">Active · {activeOpts.length}</li>}
      {activeOpts.map(row)}
      {otherOpts.length>0 && <li role="presentation" class="board-group">Other</li>}
      {otherOpts.map(row)}
      {!flat.length && <li role="presentation" class="board-group">No matching mandates</li>}
     </ul>
     {hidden.length>0 && <label class="board-switch"><span>Include {hidden.length} revoked mandates</span><input type="checkbox" role="switch" checked={revoked} onClick={()=>setRevoked(!revoked)}/></label>}
    </div>}
   </div>
   <span class="board-status">{status}</span>
  </div>
  {selected?.note && <p class="board-lane-note">{selected.note}</p>}
  <div class="board-columns" role="region" aria-label="Board columns">
   {filled.map(col=>{
    const jobs=visible.jobs.filter(j=>matches(j,col.key));
    if(col.key==="done") jobs.sort((a,b)=>(b.finished_at ?? "").localeCompare(a.finished_at ?? "") || a.id.localeCompare(b.id));
    const shown=col.key==="done" ? jobs.slice(0,LANDED_CARDS) : jobs;
    return <section key={col.key} class="board-column" aria-label={col.name}>
     <div class="board-column-heading"><h2 title={`${col.hint}${col.key==="done" ? " · newest first" : ""}`}><PhaseDot phase={col.key}/>{col.name}<span>{jobs.length}</span></h2></div>
     {shown.map(job=><Card key={job.id} job={job} jobs={data.jobs}/>)}
     {jobs.length>shown.length && <a class="board-more" href="#jobs">Show {jobs.length-shown.length} more in the list</a>}
    </section>;
   })}
   {folded.map(col=><Strip key={col.key} column={col}/>)}
   {!visible.jobs.length && <p class="board-empty">Nothing here</p>}
  </div>
 </div>;
}
