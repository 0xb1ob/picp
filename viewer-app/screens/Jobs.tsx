import { useState } from "preact/hooks";
import type { JobsResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, money, percent, time } from "../format.ts";
import { jobHref } from "../routes.ts";
import { ContextChip } from "../components/ContextChip.tsx";
import { JobsViews } from "../components/JobsViews.tsx";
import "./jobs.css";
import { CiSignal, ModelName, PhaseDot, reviewText, shortModel } from "../components/JobSignals.tsx";
export { CiSignal, PhaseDot, reviewText };
export const inFlight = (job:ViewerJob) => !["done","failed","queued"].includes(job.phase);
/** A list row's CI and review signals: only once the job has a PR or a head, never placeholder dashes before that. */
const signalled = (job:ViewerJob) => Boolean(job.pr_url || job.head);
export function JobSignals({job}:{job:ViewerJob}) {
 return <><span class="job-clock">{elapsed(job.elapsed_seconds)} / {elapsed(job.limit_seconds)}{job.limit_seconds !== null && job.elapsed_seconds !== null && <progress aria-label="Wall clock" max="100" value={percent(job.elapsed_seconds,job.limit_seconds)}/>}</span>{signalled(job) && <><span>{reviewText(job)}</span><CiSignal job={job}/></>}<ModelName job={job}/></>;
}
export function JobRow({job}:{job:ViewerJob}) {
 return <article class="job-row"><a class="job-row-link" href={jobHref(job.id)}><span class="job-row-heading"><span class="job-row-id"><PhaseDot phase={job.phase}/><code>{job.id}</code>{job.ledger_disagrees && <span class="job-ledger">ledger {job.ledger_status}</span>}</span><span class="job-phase">{job.phase}</span></span><span class="job-title">{job.title ?? job.id}</span>
 {inFlight(job) ? <span class="job-signals"><JobSignals job={job}/></span> : <span class="job-meta">{job.failure ?? (job.finished_at ? `${job.pr_status === "merged" ? "merged" : job.phase} ${time(job.finished_at)}` : "not dispatched")}{job.merge_sha && ` · ${job.merge_sha.slice(0,7)}`}<span class="job-meta-cols"> · {shortModel(job.model)} · {money(job.cost_usd)}</span></span>}
 {job.note && <span class="job-note" title={job.note}>{job.note}</span>}{job.blockers.length>0 && <span class="job-note" title={`blocked by ${job.blockers.join(", ")}`}>blocked by {job.blockers.join(", ")}</span>}
 {job.context && <span class="job-row-ctx"><ContextChip usage={job.context} compact/></span>}
 <span class="job-cols"><ModelName job={job}/><span class="job-ctx">{job.context ? <ContextChip usage={job.context} compact/> : "-"}</span>{signalled(job) ? <CiSignal job={job}/> : <span class="job-ci"/>}<span>{money(job.cost_usd)}</span><span>{job.finished_at ? time(job.finished_at) : job.elapsed_seconds !== null ? `ran ${elapsed(job.elapsed_seconds)}` : "-"}</span></span></a></article>;
}
export function Jobs({data}:{data:JobsResponse}) {
 const [filter,setFilter]=useState("all");
 const live=data.jobs.filter(inFlight); const done=data.jobs.filter(j=>["done","failed"].includes(j.phase) && j.finished_today); const queued=data.jobs.filter(j=>j.phase==="queued");
 const older=data.jobs.filter(j=>["done","failed"].includes(j.phase) && !j.finished_today).length;
 return <div class="jobs-screen"><header class="jobs-heading"><h1>Jobs</h1><p>Phases: launching · working · held · done · failed. The ledger status shows only when it disagrees.</p><JobsViews current="jobs"/></header>
 <div class="jobs-segments" role="group" aria-label="Filter jobs">{[["all","All",live.length+done.length+queued.length],["live","In flight",live.length],["done","Finished today",done.length]].map(([key,label,count])=><button type="button" key={key} aria-pressed={filter===key} onClick={()=>setFilter(String(key))}>{label}<span>{count}</span></button>)}</div>
 <div class="jobs-columns" aria-hidden="true"><span>job</span><span>title</span><span>phase</span><span>model</span><span>ctx</span><span>CI</span><span>cost</span><span>time</span></div>
 {filter!=="done" && <section class="jobs-group"><header><h2>In flight · {live.length}</h2><p>held = waiting on CI or review, normal for hours</p></header>{live.map(job=><JobRow key={job.id} job={job}/>)}{!live.length && <p class="jobs-empty">Nothing in flight.</p>}</section>}
 {filter==="all" && queued.length>0 && <section class="jobs-group"><header><h2>Queued · {queued.length}</h2></header>{queued.map(job=><JobRow key={job.id} job={job}/>)}</section>}
 {filter!=="live" && <section class="jobs-group"><header><h2>Finished today · {done.length}</h2></header>{data.projects.map(project=>{const items=done.filter(j=>j.project===project.name);return <section key={project.name} class="jobs-project"><h3>{project.name}{project.paused && <span class="job-ledger">paused</span>}</h3>{items.map(job=><JobRow key={job.id} job={job}/>)}{!items.length && <p class="jobs-empty">No finished jobs today.</p>}</section>;})}{!done.length && !data.projects.length && <p class="jobs-empty">No finished jobs today.</p>}{older>0 && <p class="jobs-older">{older} older finished jobs not shown</p>}</section>}
 </div>;
}
