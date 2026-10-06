import { useState } from "preact/hooks";
import type { JobsResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, money, percent, phaseText, prNumber, shortSha, time } from "../format.ts";
import { jobHref } from "../routes.ts";
import { ContextChip } from "../components/ContextChip.tsx";
import { JobsViews } from "../components/JobsViews.tsx";
import "./jobs.css";
import { CiSignal, ModelName, PhaseDot, reviewText } from "../components/JobSignals.tsx";
export { CiSignal, PhaseDot, reviewText };
export const inFlight = (job:ViewerJob) => !["done","failed","queued"].includes(job.phase);
const DONE_ROWS = 5;
export function JobSignals({job}:{job:ViewerJob}) {
 return <><span class="job-clock">{elapsed(job.elapsed_seconds)} / {elapsed(job.limit_seconds)}{job.limit_seconds !== null && job.elapsed_seconds !== null && <progress aria-label="Wall clock" max="100" value={percent(job.elapsed_seconds,job.limit_seconds)}/>}</span><span class="job-context"><ContextChip usage={job.context} compact/>{!job.context && "context n/a"}</span><span class="job-review">{reviewText(job)}</span><CiSignal job={job}/><span class="job-model"><ModelName job={job}/></span><span class="job-cost">{money(job.cost_usd)}</span></>;
}
export function JobRow({job}:{job:ViewerJob}) {
 const flight = inFlight(job); const finished = ["done","failed"].includes(job.phase);
 const merged = job.pr_status === "merged" || job.merge_sha !== null;
 return <article class={`job-row ${flight ? "job-row-flight" : finished ? "job-row-done" : "job-row-queued"}`}><a class="job-row-link" href={jobHref(job.id)} title={job.ledger_disagrees ? `ledger ${job.ledger_status} · run ${phaseText(job.phase)}` : undefined}><span class="job-row-heading"><span class="job-row-id"><PhaseDot phase={job.phase}/><code>{job.id}</code>{job.ledger_disagrees && <span class="job-ledger">ledger {job.ledger_status}</span>}</span><span class="job-phase">{phaseText(job.phase)}<span class="job-project"> · {job.project}</span></span></span><span class="job-title" title={job.title ?? job.id}>{job.title ?? job.id}</span></a>
 {flight ? <div class="job-signals"><JobSignals job={job}/></div> : finished ? <div class="job-finished"><span class="job-outcome">{job.pr_url && <a href={job.pr_url} target="_blank" rel="noopener noreferrer">{prNumber(job.pr_url)} ↗</a>} {merged ? "merged" : job.phase === "failed" ? "failed" : job.pr_url ? `PR ${job.pr_status ?? "status not recorded"}` : "closed · no PR"}</span><code class="job-commit" title={job.merge_sha ?? job.head ?? undefined}>{shortSha(job.merge_sha ?? job.head) ?? "no commits"}</code><span class="job-model"><ModelName job={job}/></span><span class="job-finished-at">{job.finished_at ? time(job.finished_at) : "not recorded"}</span><span class="job-cost">{money(job.cost_usd)}</span></div> : <span class="job-meta">not dispatched</span>}
 {job.failure && <span class="job-note" title={job.failure}>{job.failure}</span>}{job.note && <span class="job-note" title={job.note}>{job.note}</span>}{job.blockers.length>0 && <span class="job-note" title={`blocked by ${job.blockers.join(", ")}`}>blocked by {job.blockers.join(", ")}</span>}
 </article>;
}
function JobColumns({finished=false}:{finished?:boolean}) {
 return <div class={`jobs-columns ${finished ? "jobs-columns-done" : "jobs-columns-flight"}`} aria-hidden="true">{(finished ? ["job","title","outcome","commit","model","finished","cost"] : ["job","title","elapsed / budget","context","review","CI","model","cost"]).map(label=><span key={label}>{label}</span>)}</div>;
}
function projectList(projects: {name: string; paused: boolean}[]): string {
 const labels = projects.map(p => p.paused ? `${p.name} (paused)` : p.name);
 if (labels.length < 2) return labels[0] ?? "";
 return `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
}
function doneGroups(jobs: ViewerJob[], projects: JobsResponse["projects"]) {
 const sorted = [...jobs].sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
 const groups: {name: string; items: ViewerJob[]}[] = [];
 for (const job of sorted) {
  const group = groups.find(g => g.name === job.project);
  if (group) group.items.push(job); else groups.push({name: job.project, items: [job]});
 }
 return {groups, empty: projects.filter(p => !groups.some(g => g.name === p.name))};
}
function DoneGroup({name, items, open, onMore}: {name: string; items: ViewerJob[]; open: boolean; onMore: () => void}) {
 const shown = open ? items : items.slice(0, DONE_ROWS);
 const rest = items.length - DONE_ROWS;
 const merged = items.filter(j => j.pr_status === "merged" || j.merge_sha !== null).length;
 const closed = items.filter(j => j.phase === "done" && j.pr_status !== "merged" && j.merge_sha === null).length;
 const costs = items.flatMap(j => j.cost_usd === null ? [] : [j.cost_usd]);
 return <section class="jobs-project"><h3><strong>{name}</strong><span> · {merged} merged · {closed} closed without PR</span><span class="jobs-project-cost"> · {money(costs.length ? costs.reduce((sum, c) => sum + c, 0) : null)}</span></h3><JobColumns finished/>{shown.map(job => <JobRow key={job.id} job={job}/>)}{rest > 0 && !open && <button type="button" class="jobs-more" onClick={onMore}>Show {rest} more from {name}</button>}</section>;
}
export function Jobs({data}:{data:JobsResponse}) {
 const [filter,setFilter]=useState("all");
 const [open,setOpen]=useState<Record<string, boolean>>({});
 const live=data.jobs.filter(inFlight); const done=data.jobs.filter(j=>["done","failed"].includes(j.phase) && j.finished_today); const queued=data.jobs.filter(j=>j.phase==="queued");
 const older=data.jobs.filter(j=>["done","failed"].includes(j.phase) && !j.finished_today).length;
 const {groups, empty} = doneGroups(done, data.projects);
 return <div class="jobs-screen"><header class="jobs-heading"><h1>Jobs</h1><div class="jobs-toolbar"><JobsViews current="jobs"/>
 <div class="jobs-segments" role="group" aria-label="Filter jobs">{[["all","All",live.length+done.length+queued.length],["live","In flight",live.length],["done","Done today",done.length]].map(([key,label,count])=><button type="button" key={key} aria-pressed={filter===key} onClick={()=>setFilter(String(key))}>{label}<span>{count}</span></button>)}</div><p>held = waiting on CI or review, normal for hours</p></div></header>
 {filter!=="done" && <section class="jobs-group"><header><h2>In flight · {live.length}</h2><p>held = waiting on CI or review, normal for hours</p></header>{live.length>0 && <JobColumns/>}{live.map(job=><JobRow key={job.id} job={job}/>)}{!live.length && <p class="jobs-empty">Nothing in flight.</p>}</section>}
 {filter==="all" && queued.length>0 && <section class="jobs-group"><header><h2>Queued · {queued.length}</h2></header>{queued.map(job=><JobRow key={job.id} job={job}/>)}</section>}
 {filter!=="live" && <section class="jobs-group"><header><h2>Done today · {done.length}</h2></header>{groups.map(group => <DoneGroup key={group.name} name={group.name} items={group.items} open={open[group.name] === true} onMore={() => setOpen(s => ({...s, [group.name]: true}))}/>)}{empty.length > 0 && <p class="jobs-empty">Nothing done today in {projectList(empty)}.</p>}{!done.length && !data.projects.length && <p class="jobs-empty">No finished jobs today.</p>}{older>0 && <p class="jobs-older">{older} older finished jobs not shown</p>}</section>}
 </div>;
}
