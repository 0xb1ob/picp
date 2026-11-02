import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JobsResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { money, phaseText, prNumber, time } from "../format.ts";
import { matchesProject, type ProjectSelection, selectionHash, selectionValue } from "../project-filter.ts";
import { inFlight, tagOf } from "../screens/Jobs.tsx";
import { useScreenData } from "../use-screen-data.ts";
import { Icon } from "./icons.tsx";
import { PhaseDot } from "./JobSignals.tsx";
import { ProjectFilter } from "./ProjectFilter.tsx";

type Filter = "all" | "live" | "done";

function JobButton({job, onSelect}: {job: ViewerJob; onSelect: (id: string) => void}) {
 const merged = job.pr_status === "merged" || job.merge_sha !== null, pr = prNumber(job.pr_url);
 const status = merged ? `merged${pr ? ` ${pr}` : ""}` : phaseText(job.phase);
 return <li><button type="button" class="workspace-jobs-row" onClick={() => onSelect(job.id)}>
  <PhaseDot phase={job.phase}/>
  <span class="workspace-jobs-title"><b title={job.title ?? job.id}>{job.title ?? job.id}</b><span><code title={job.id}>{job.id}</code> · {job.project}</span></span>
  <span class="workspace-jobs-status">{status}{job.finished_at && <small>{time(job.finished_at)}</small>}</span>
  <span class="workspace-jobs-cost">{money(job.cost_usd)}</span>
 </button></li>;
}

/**
 * The operator chat's Jobs list (M3): a modal drawer on desktop, a bottom sheet on a phone. It reads `/api/jobs` only
 * while open, filters by the chat's project selection (the hash, M1) and hands a picked job to `onSelect`.
 */
export function JobsDrawer({selection, onSelect, onClose}: {selection: ProjectSelection; onSelect: (id: string) => void; onClose: () => void}) {
 const dialog = useRef<HTMLDialogElement>(null);
 const [filter, setFilter] = useState<Filter>("all");
 const resource = useScreenData<JobsResponse>("/api/jobs", "/api/stream?view=jobs");
 useLayoutEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
 const all = resource.data?.jobs ?? [];
 const jobs = all.filter(j => matchesProject(tagOf(j.project), selection));
 const names = all.flatMap(j => tagOf(j.project) ?? []);
 const live = jobs.filter(inFlight), team = jobs.filter(j => j.phase === "awaiting_merge"), queued = jobs.filter(j => j.phase === "queued");
 const done = jobs.filter(j => ["done","failed"].includes(j.phase) && j.finished_today).sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
 const groups: [string, ViewerJob[], boolean][] = [["In flight", live, filter !== "done"], ["With the team", team, filter === "all"], ["Queued", queued, filter === "all"], ["Done today", done, filter !== "live"]];
 const counts: [Filter, string, number][] = [["all", "All", live.length + team.length + queued.length + done.length], ["live", "In flight", live.length], ["done", "Done today", done.length]];
 return <dialog ref={dialog} class="workspace-jobs" aria-label="Jobs" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
  <div class="workspace-jobs-inner">
   <header class="workspace-jobs-head">
    <h2>Jobs</h2>
    <a class="workspace-full" href={selectionHash("#jobs", selectionValue(selection))}>Full page</a>
    <button type="button" class="workspace-close" aria-label="Close jobs" onClick={onClose}><Icon name="close"/></button>
   </header>
   <div class="workspace-jobs-bar">
    <div class="jobs-segments" role="group" aria-label="Filter jobs">{counts.map(([key, label, count]) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{count}</span></button>)}</div>
    <ProjectFilter names={names} selection={selection} onChange={value => { window.location.hash = selectionHash(location.hash, value); }}/>
   </div>
   <div class="workspace-jobs-list">
    {resource.error && <p role="alert">{resource.error}{resource.data && " · showing last recorded data"}</p>}
    {resource.data?.warnings.map(w => <p role="alert" key={w.section}>{w.section}: {w.message}</p>)}
    {!resource.data ? <p role="status">{resource.error ? "Recorded data unavailable" : "Loading"}</p>
     : !jobs.length ? <p role="status">{!selection ? "No jobs" : "project" in selection ? `No jobs for ${selection.project}` : "No untagged jobs"}</p>
     : groups.map(([title, items, shown]) => shown && items.length > 0 && <section key={title} aria-label={title}><h3>{title} · {items.length}</h3><ul>{items.map(job => <JobButton key={job.id} job={job} onSelect={onSelect}/>)}</ul></section>)}
   </div>
   <p class="workspace-jobs-hint">Pick a job to read it beside the chat; <kbd>Esc</kbd> returns to the conversation.</p>
  </div>
 </dialog>;
}
