import { useState } from "preact/hooks";
import type { BoardResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, money, percent, time } from "../format.ts";
import { jobHref } from "../routes.ts";
import { PhaseDot, reviewText, CiSignal } from "./Jobs.tsx";
import { JobsViews } from "../components/JobsViews.tsx";
import "./board.css";
export function visibleBoard(data:BoardResponse,inactive:boolean,mandate:string) {
 const lanes=data.lanes.filter(l=>(inactive || l.active) && (mandate==="all" || l.id===mandate) && data.jobs.some(j=>l.id===(j.board_lane_id ?? j.mandate_id ?? "unassigned"))).sort((a,b)=>Number(b.active)-Number(a.active));
 return {lanes,jobs:data.jobs.filter(j=>lanes.some(l=>l.id===(j.board_lane_id ?? j.mandate_id ?? "unassigned")))};
}
function Card({job,mandate,jobs}:{job:ViewerJob;mandate:boolean;jobs:ViewerJob[]}) {
 const blocks=jobs.filter(o=>o.blockers.includes(job.id));
 return <a class={`board-card board-card-${job.phase}`} href={jobHref(job.id)}><span class="board-card-heading"><PhaseDot phase={job.phase}/><code>{job.id}</code></span><span class="board-card-title">{job.title ?? job.id}</span>{mandate && <code class="board-card-mandate">{job.mandate_id ?? "unassigned"}</code>}
 {job.phase==="queued" ? <span>not dispatched · ledger {job.ledger_status ?? "-"}</span> : job.phase==="done" ? <span>{job.pr_url && `#${job.pr_url.split("/").at(-1)} · `}{job.merge_sha?.slice(0,7)}{job.finished_at && ` · ${time(job.finished_at)}`}</span> : <><span>{job.failure ?? `${elapsed(job.elapsed_seconds)} / ${elapsed(job.limit_seconds)}`} · {job.script_path ?? job.model ?? "-"}</span><span>{reviewText(job)}</span><CiSignal job={job}/></>}
 {job.summary && <span class="board-card-summary" title={job.summary}>{job.summary}</span>}{job.blockers.map(id=><span key={id} class="board-tag board-tag-blocked">blocked by {id}</span>)}{blocks.map(o=><span key={o.id} class="board-tag">blocks {o.id}</span>)}{job.note && <span class="board-tag board-tag-blocked"><span class="board-note" title={job.note}>{job.note}</span></span>}{job.ledger_disagrees && <span class="board-tag">ledger {job.ledger_status}</span>}</a>;
}
const matches=(job:ViewerJob,key:string)=>key==="waiting" ? ["waiting","idle"].includes(job.phase) : job.phase===key;
const PHONE_ORDER=["held","working","waiting","launching","queued","failed","done"];
/** Empty means no card. Desktop Landed today counts every lane (audit P2 #12), so a paused done job keeps that column. */
function splitColumns(columns:BoardResponse["columns"], jobs:ViewerJob[], doneJobs:ViewerJob[]|null) {
 const pool=(key:string)=>key==="done" && doneJobs ? doneJobs : jobs;
 const folded=columns.filter(c=>!pool(c.key).some(j=>matches(j,c.key)));
 return {filled:columns.filter(c=>!folded.includes(c)), folded};
}
function Strip({name}:{name:string}) {
 return <div class="board-strip" aria-label={`${name} · 0`}><span class="board-strip-name">{name}</span><span>0</span></div>;
}
export function Board({data}:{data:BoardResponse}) {
 const [flat,setFlat]=useState(false); const [inactive,setInactive]=useState(false); const [mandate,setMandate]=useState("all");
 const visible=visibleBoard(data,inactive,"all");
 const phone=visibleBoard(data,true,mandate);
 const desktopCols=splitColumns(data.columns, visible.jobs, data.jobs);
 const phoneCols=splitColumns(PHONE_ORDER.flatMap(key=>{const col=data.columns.find(c=>c.key===key);return col ? [col] : [];}), phone.jobs, null);
 const heading=(column:BoardResponse["columns"][number],items=visible.jobs)=><div class="board-column-heading"><h2><PhaseDot phase={column.key}/>{column.name}<span>{items.filter(j=>matches(j,column.key)).length}</span></h2><p>{column.hint}</p></div>;
 const fold=<p class="board-fold">Empty columns fold to the right</p>;
 return <div class="board-screen"><header class="board-heading"><div><h1><span class="board-desktop">Board</span><span class="board-phone">Board</span></h1><p class="board-desktop">Jobs by phase, in lanes by the mandate that covers them. Cards move as the ledger changes; nothing here can be dragged.</p><p class="board-phone">Jobs by phase · swipe columns</p></div><div class="board-toolbar"><div class="board-controls board-desktop"><div class="jobs-segments" role="group" aria-label="Group"><button type="button" aria-pressed={!flat} onClick={()=>setFlat(false)}>By mandate</button><button type="button" aria-pressed={flat} onClick={()=>setFlat(true)}>All jobs</button></div><label class="board-inactive"><input type="checkbox" checked={inactive} onChange={e=>setInactive(e.currentTarget.checked)}/>Paused &amp; closed</label></div><JobsViews current="board"/></div></header>
 <div class="board-filters board-phone" role="group" aria-label="Filter by mandate"><button type="button" aria-pressed={mandate==="all"} onClick={()=>setMandate("all")}><code>All mandates</code></button>{data.lanes.map(l=><button key={l.id} type="button" aria-pressed={mandate===l.id} onClick={()=>setMandate(l.id)}><code>{l.id==="unassigned" ? "Unassigned" : l.id}</code><span class="board-chip-name" title={l.objective}>{l.objective}</span></button>)}</div>
 <div class="board-phone board-columns" role="region" aria-label="Board columns">{phoneCols.filled.map(col=>{const jobs=phone.jobs.filter(j=>matches(j,col.key));return <section key={col.key} class="board-column">{heading(col,phone.jobs)}{jobs.map(job=><Card key={job.id} job={job} mandate jobs={data.jobs}/>)}</section>;})}{phoneCols.folded.map(col=><Strip key={col.key} name={col.name}/>)}</div>
 {phoneCols.folded.length>0 && <div class="board-phone">{fold}</div>}
 {/* Landed today counts every lane, shown or not, so it matches Overview and Jobs (audit P2 #12). */}
 <div class="board-stage board-desktop"><div class="board-desktop board-grid-head">{desktopCols.filled.map(col=><div key={col.key}>{heading(col,col.key==="done" ? data.jobs : visible.jobs)}</div>)}</div>
 <div class="board-desktop board-lanes">{(flat && visible.jobs.length ? [{id:"all",active:true}] : visible.lanes).map(lane=>{const info=visible.lanes.find(l=>l.id===lane.id);const jobs=visible.jobs.filter(j=>flat || (j.board_lane_id ?? j.mandate_id ?? "unassigned")===lane.id);return <section class={`board-lane${lane.active ? "" : " board-lane-inactive"}`} key={lane.id}>{info && <header><code>{lane.id==="unassigned" ? "Unassigned" : info.id}</code><span>{info.status}</span><p title={info.objective}>{info.objective}</p><span class="board-spend">{info.spend!==null && info.cap!==null && <progress aria-label={`${info.id} spend`} max="100" value={percent(info.spend,info.cap)}/>} {money(info.spend)} / {money(info.cap)}</span><code class="board-asks">{info.ask_on.length ? `asks on ${info.ask_on.join(" · ")}` : ""}</code><span>{info.expiry && info.active ? `${elapsed(Math.max(0,(Date.parse(info.expiry)-Date.parse(data.generated_at))/1000))} left` : info.status}</span></header>}<div class="board-cells">{desktopCols.filled.map(col=><div class="board-cell" key={col.key}>{jobs.filter(j=>matches(j,col.key)).map(job=><Card key={job.id} job={job} mandate={flat || lane.id==="unassigned"} jobs={data.jobs}/>)}</div>)}</div>{info?.note && <p class="board-lane-note">{info.note}</p>}</section>;})}{!visible.lanes.length && <p class="board-empty">Nothing here</p>}<p class="board-footer">{data.stranded_count===null ? "Dependency status unavailable." : data.stranded_count ? `${data.stranded_count} stranded dependencies.` : "No stranded dependencies."} {data.revoked_hidden} revoked mandates hidden.</p>{desktopCols.folded.length>0 && fold}</div>
 <div class="board-strips">{desktopCols.folded.map(col=><Strip key={col.key} name={col.name}/>)}</div></div>
 </div>;
}
