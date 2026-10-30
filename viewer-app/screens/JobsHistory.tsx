import { useState } from "preact/hooks";
import type { JobsHistoryResponse } from "../../src/viewer/api-types.ts";
import { observedTime } from "../format.ts";
import { jobHref, jobsHistoryHref } from "../routes.ts";
import { JobsViews } from "../components/JobsViews.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import "./jobs.css";

type Field = "q" | "since" | "until";

/** Jobs History (`#jobs?view=history`): closed jobs from `/api/jobs/history`; the hash carries every filter. */
export function JobsHistory({data, query}: {data: JobsHistoryResponse | null; query: string}) {
 const applied = Object.fromEntries(new URLSearchParams(query)) as Record<string, string>;
 delete applied.view;
 const [form,setForm] = useState<Record<Field, string>>({q: applied.q ?? "", since: applied.since ?? "", until: applied.until ?? ""});
 const go = (change: Record<string, string | number | null> = {}) => { location.hash = jobsHistoryHref({...applied, ...form, offset: null, ...change}); };
 const field = (key: Field, label: string, type: string) => <label class="jobs-history-field"><span>{label}</span><input type={type} value={form[key]}
  onInput={e => { const value = e.currentTarget.value; setForm(f => ({...f, [key]: value})); }} onKeyDown={e => { if (e.key === "Enter") go(); }}/></label>;
 const projects = data?.projects ?? [];
 const project = applied.project ?? "";
 const page = (offset: number) => jobsHistoryHref({...applied, offset: offset > 0 ? offset : null});
 return <div class="jobs-screen"><header class="jobs-heading"><PageHeader title="Jobs"/><div class="jobs-toolbar"><JobsViews current="jobs"/><a class="jobs-history-link" href="#jobs">Back to today</a></div></header>
  <section class="jobs-group jobs-history"><header><h2>History{data ? ` · ${data.total}` : ""}</h2><p>closed jobs, newest close first; dates are UTC</p></header>
  <div class="jobs-history-filters" role="search">
   <label class="jobs-history-field"><span>Project</span><select value={project} onChange={e => go({project: e.currentTarget.value})}><option value="">All</option>{project && !projects.includes(project) && <option value={project}>{project}</option>}{projects.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
   {field("q","Text","search")}{field("since","Closed from","date")}{field("until","Closed before","date")}
   <button type="button" class="jobs-history-search" onClick={() => go()}>Search</button>
  </div>
  {!data ? <p role="alert" class="jobs-empty">This search was refused: dates are YYYY-MM-DD, Closed from earlier than Closed before.</p> : <>
   {data.warnings.map(w => <p role="alert" class="overview-error" key={w.section}>{w.section}: {w.message}</p>)}
   {data.rows.length === 0 ? <p class="jobs-empty">{data.warnings.length ? "No rows: a source is unavailable (above)." : "No closed jobs match."}</p> :
    <ol class="jobs-history-rows">{data.rows.map(row => <li key={row.id} class="jobs-history-row">
     <a class="jobs-history-title" href={jobHref(row.id)}><code>{row.id}</code><span title={row.title}>{row.title}</span></a>
     <span class="jobs-history-meta">{row.project ?? "no project"} · closed {row.closed_at ? observedTime(row.closed_at) : "not recorded"}</span>
     {row.close_reason && <span class="jobs-history-reason">{row.dropped ? "Dropped · " : ""}{row.close_reason}</span>}
     {row.headline && <span class="jobs-history-headline">Report {row.report_status}: {row.headline}</span>}
    </li>)}</ol>}
   <nav class="jobs-history-pages" aria-label="History pages">{data.offset > 0 && <a href={page(data.offset - data.limit)}>Newer</a>}<span>{data.rows.length ? `${data.offset + 1}–${data.offset + data.rows.length} of ${data.total}` : `0 of ${data.total}`}</span>{data.next_offset !== null && <a href={page(data.next_offset)}>Older</a>}</nav>
  </>}
  </section></div>;
}
