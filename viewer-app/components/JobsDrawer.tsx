import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JobsResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, jobSuffix, money, phaseText, prNumber, time } from "../format.ts";
import { matchesProject, type ProjectSelection, selectionHash, selectionValue } from "../project-filter.ts";
import { inFlight, tagOf } from "../screens/Jobs.tsx";
import { useScreenData } from "../use-screen-data.ts";
import { Icon } from "./icons.tsx";
import { PhaseDot } from "./JobSignals.tsx";
import { ProjectFilter } from "./ProjectFilter.tsx";

type Filter = "today" | "live" | "all";
/** Rows a group shows before its Show more (design frame 9). */
const ROWS = 5;
const UNRECORDED = "not recorded";

/** The Done column: a finished job's time, a running one's elapsed; never 0m for a missing fact. */
const when = (job: ViewerJob) => job.finished_at ? time(job.finished_at) : job.elapsed_seconds === null ? UNRECORDED : elapsed(job.elapsed_seconds);

function JobButton({job, onSelect}: {job: ViewerJob; onSelect: (id: string) => void}) {
 const merged = job.pr_status === "merged" || job.merge_sha !== null, pr = prNumber(job.pr_url);
 const status = merged ? `merged${pr ? ` ${pr}` : ""}` : phaseText(job.phase), cost = job.cost_usd === null ? null : money(job.cost_usd);
 // Working glyphs stay neutral; the Working status label is green and Merged blue, per design frames 3 and 9.
 const tone = merged ? " workspace-jobs-status-merged" : job.phase === "working" ? " workspace-jobs-status-working" : "";
 return <li><button type="button" class="workspace-jobs-row" data-job={job.id} onClick={() => onSelect(job.id)}>
  <span class="workspace-jobs-job"><PhaseDot phase={job.phase}/><code title={job.id}>{jobSuffix(job.id)}</code></span>
  <span class="workspace-jobs-title"><b title={job.title ?? job.id}>{job.title ?? job.id}</b>
   <span class="workspace-jobs-id"><code title={job.id}>{job.id}</code> · {job.project}</span>
   <span class="workspace-jobs-meta"><code>{jobSuffix(job.id)}</code> · {[job.model, cost ?? `cost ${UNRECORDED}`].filter(Boolean).join(" · ")}</span></span>
  <span class={`workspace-jobs-status${tone}`}>{status[0]!.toUpperCase() + status.slice(1)}</span>
  <span class="workspace-jobs-done">{when(job)}</span>
  <span class="workspace-jobs-cost">{cost ?? UNRECORDED}</span>
 </button></li>;
}

/**
 * The operator chat's Jobs list (M3): a modal drawer on desktop, a bottom sheet on a phone. It reads `/api/jobs` only
 * while open, filters by the chat's project selection (the hash, M1) and a local query, and hands a pick to `onSelect`.
 */
export function JobsDrawer({selection, onSelect, onClose}: {selection: ProjectSelection; onSelect: (id: string) => void; onClose: () => void}) {
 const dialog = useRef<HTMLDialogElement>(null), field = useRef<HTMLInputElement>(null), menu = useRef<HTMLDetailsElement>(null), focus = useRef<string | null>(null);
 const [filter, setFilter] = useState<Filter>("today");
 const [query, setQuery] = useState(""), [searching, setSearching] = useState(false);
 const [more, setMore] = useState<Record<string, boolean>>({});
 const resource = useScreenData<JobsResponse>("/api/jobs", "/api/stream?view=jobs");
 useLayoutEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
 // Show more and the phone's search move focus once the new rows or the field exist.
 useLayoutEffect(() => {
  const id = focus.current; focus.current = null;
  if (id === "") field.current?.focus();
  else if (id) [...dialog.current!.querySelectorAll<HTMLElement>("button[data-job]")].find(b => b.getAttribute("data-job") === id)?.focus();
 });
 const all = resource.data?.jobs ?? [];
 const needle = query.trim().toLowerCase();
 const jobs = all.filter(j => matchesProject(tagOf(j.project), selection) && (!needle || [j.id, j.title ?? "", j.project].some(v => v.toLowerCase().includes(needle))));
 const names = all.flatMap(j => tagOf(j.project) ?? []);
 const live = jobs.filter(inFlight), team = jobs.filter(j => j.phase === "awaiting_merge"), queued = jobs.filter(j => j.phase === "queued");
 const finished = jobs.filter(j => ["done","failed"].includes(j.phase)).sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
 const done = finished.filter(j => j.finished_today);
 const groups: [string, ViewerJob[], boolean][] = [["In flight", live, true], ["With the team", team, filter !== "live"], ["Queued", queued, filter !== "live"],
  ["Done today", done, filter === "today"], ["Done", finished, filter === "all"]];
 const visible = groups.filter(([, items, shown]) => shown && items.length > 0);
 const counts: [Filter, string, number | null][] = [["today", "Today", live.length + team.length + queued.length + done.length], ["live", "In flight", live.length], ["all", "All", null]];
 const scope = !selection ? "All projects" : "project" in selection ? selection.project : "Untagged";
 const showMore = (title: string, items: ViewerJob[]) => { focus.current = items[ROWS]!.id; setMore(m => ({...m, [title]: true})); };
 const menuOpen = () => !!menu.current?.hasAttribute("open"), closeMenu = () => menu.current?.removeAttribute("open");
 // The project pill (S1's popover): Escape closes it before the drawer, as does a tap outside it.
 const menuKey = (event: KeyboardEvent) => { if (event.key === "Escape" && menuOpen()) { event.preventDefault(); closeMenu(); menu.current!.querySelector("summary")?.focus(); } };
 return <dialog ref={dialog} class="workspace-jobs" aria-label="Jobs" onKeyDown={menuKey} onPointerDown={event => { if (menuOpen() && !menu.current!.contains(event.target as Node)) closeMenu(); }}
  onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
  <div class="workspace-jobs-inner">
   <header class="workspace-jobs-head">
    <h2>Jobs</h2>
    <span class="workspace-jobs-scope">{scope} · {filter === "all" ? "all days" : "today"}</span>
    <div class="workspace-jobs-bar">
     <details class="workspace-jobs-project" ref={menu}>
      <summary aria-label={`Project: ${scope}`} title="Filter by project"><span class="workspace-jobs-project-dot" aria-hidden="true"/><span>{scope}</span><span aria-hidden="true">▾</span></summary>
      <div class="workspace-jobs-project-sheet"><ProjectFilter names={names} selection={selection} onChange={value => { closeMenu(); window.location.hash = selectionHash(location.hash, value); }}/></div>
     </details>
     <div class="jobs-segments" role="group" aria-label="Filter jobs">{counts.map(([key, label, count]) => <button type="button" key={key} class={`workspace-jobs-seg-${key}`} aria-pressed={filter === key}
      title={key === "today" ? "In flight, with the team, queued and done today (this calendar day)" : key === "all" ? "Every recorded job, any day" : undefined}
      onClick={() => setFilter(key)}>{label}{count !== null && <span>{count}</span>}</button>)}</div>
    </div>
    <button type="button" class="workspace-jobs-search" aria-label="Search jobs" aria-expanded={searching || !!query} onClick={() => { focus.current = searching ? null : ""; setSearching(!searching); }}><Icon name="search"/></button>
    <a class="workspace-full" href={selectionHash("#jobs", selectionValue(selection))}><span class="workspace-full-open">Open full page</span><span class="workspace-full-short">Full page</span><span class="workspace-full-arrow" aria-hidden="true"> ↗</span></a>
    <button type="button" class="workspace-close" aria-label="Close jobs" onClick={onClose}><Icon name="close"/></button>
    <label class="workspace-jobs-find" data-open={searching || query ? "" : undefined}><Icon name="search" size={16}/>
     <input ref={field} type="search" aria-label="Filter jobs by id, title or project" placeholder="Filter by id, title or project" value={query} onInput={e => setQuery(e.currentTarget.value)}/></label>
   </header>
   <div class="workspace-jobs-cols" aria-hidden="true"><span>Job</span><span>Title / context</span><span>Status</span><span>Done</span><span>Cost</span></div>
   <div class="workspace-jobs-list">
    {resource.error && <p role="alert">{resource.error}{resource.data && " · showing last recorded data"}</p>}
    {resource.data?.warnings.map(w => <p role="alert" key={w.section}>{w.section}: {w.message}</p>)}
    {!resource.data ? <p role="status">{resource.error ? "Recorded data unavailable" : "Loading"}</p>
     : !visible.length ? <p role="status">{needle ? `No ${filter === "live" ? "in-flight " : ""}jobs match “${query.trim()}”${filter === "today" ? " today" : ""}`
      : jobs.length ? filter === "live" ? "Nothing in flight" : "Nothing today"
      : !selection ? "No jobs" : "project" in selection ? `No jobs for ${selection.project}` : "No untagged jobs"}</p>
     : visible.map(([title, items]) => <section key={title} aria-label={title}><h3>{title} · {items.length}</h3>
      <ul>{(more[title] ? items : items.slice(0, ROWS)).map(job => <JobButton key={job.id} job={job} onSelect={onSelect}/>)}</ul>
      {!more[title] && items.length > ROWS && <button type="button" class="workspace-jobs-more" onClick={() => showMore(title, items)}>Show {items.length - ROWS} more</button>}</section>)}
   </div>
   <p class="workspace-jobs-hint">Pick a job to read it beside the chat; <kbd>Esc</kbd> returns to the conversation.</p>
  </div>
 </dialog>;
}
