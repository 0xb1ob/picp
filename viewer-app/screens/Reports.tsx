import type { HandoffPointer, HandoffsResponse, ReportsResponse } from "../../src/viewer/api-types.ts";
import { observedTime } from "../format.ts";
import { handoffsHref, jobHref } from "../routes.ts";
import { PageHeader } from "../components/PageHeader.tsx";

export function Reports({data}: {data:ReportsResponse}) {
	const jobReports = data.job_reports ?? [];
	return <div class="jobs-screen"><header class="jobs-heading"><PageHeader title="Reports"/><p>Published web reports open in a new tab; job reports open here as a page. Nothing here writes.</p></header>
	 <section class="jobs-group" aria-label="Published reports">
	  <header><h2>Published · {data.reports.length}</h2><p>Newest revision per job</p></header>
	  <div class="reports-grid">{data.reports.map(report => <article class="job-row" key={report.slug}>
	   <div class="job-row-heading"><a class="job-title" href={report.href} target="_blank" rel="noopener noreferrer">{report.title}</a><span class="decided-time">{observedTime(report.created_at)}</span></div>
	   <p class="job-meta">{report.description}</p>
	   <div class="decided-job">{report.job_ids.map(id => <a key={id} href={jobHref(id)}><code>{id}</code></a>)}</div>
	  </article>)}</div>
	  {!data.reports.length && <p class="jobs-empty">No published reports yet</p>}
	 </section>
	 <section class="jobs-group" aria-label="Job reports">
	  <header><h2>Job reports · {jobReports.length}</h2><p>Each job's report.md, newest first</p></header>
	  <div class="reports-grid">{jobReports.map(report => <article class="job-row" key={report.job_id}>
	   <div class="job-row-heading"><a class="job-title" href={report.href}>{report.title}</a><span class="decided-time">{observedTime(report.modified_at)}</span></div>
	   <div class="decided-job"><a href={jobHref(report.job_id)}><code>{report.job_id}</code></a></div>
	  </article>)}</div>
	  {!jobReports.length && <p class="jobs-empty">No job reports yet</p>}
	 </section>
	 <section class="jobs-group" aria-label="Handoffs">
	  <header><h2>Handoffs</h2><p>Operator handoff notes indexed by project at read time</p></header>
	  <a class="jobs-history-link reports-handoffs-link" href={handoffsHref()}>Handoffs by project</a>
	 </section>
	</div>;
}

/** Reports' project handoffs (`#reports?view=handoffs&project=`): pointers by project; a note opens as text. */
export function Handoffs({data, refused}: {data: HandoffsResponse | null; refused: boolean}) {
 const groups = data?.groups ?? [];
 return <div class="jobs-screen"><header class="jobs-heading"><PageHeader title="Reports"/><div class="jobs-toolbar"><a class="jobs-history-link" href="#reports">Back to reports</a></div></header>
  <section class="jobs-group jobs-history" aria-label="Project handoffs"><header><h2>Handoffs{data?.project ? ` · ${data.project}` : ""}</h2><p>Matched by exact job id, project name or repository URL; newest first</p></header>
  {refused ? <p role="alert" class="jobs-empty">This project name was refused.</p> : !data ? <p role="status">Loading</p> : <>
   <nav class="jobs-history-pages handoffs-projects" aria-label="Projects"><a href={handoffsHref()} aria-current={data.project ? undefined : "page"}>All</a>{data.projects.map(p => <a key={p} href={handoffsHref(p)} aria-current={p === data.project ? "page" : undefined}>{p}</a>)}</nav>
   {data.warnings.map((w,i) => <p role="alert" class="overview-error" key={i}>{w.section}: {w.message}</p>)}
   {!data.complete && <p class="jobs-empty handoffs-incomplete">Incomplete: {data.scanned} scanned, {data.skipped} not scanned, {data.truncated} matched on their first 64 KiB only.</p>}
   {groups.map(group => <div key={group.project} class="handoffs-group"><h3>{group.project} · {group.handoffs.length}</h3><ol class="jobs-history-rows">{group.handoffs.map(h => <HandoffRow key={h.path} pointer={h}/>)}</ol></div>)}
   {data.unassociated.length > 0 && <div class="handoffs-group"><h3>Unassociated · {data.unassociated.length}</h3><ol class="jobs-history-rows">{data.unassociated.map(h => <HandoffRow key={h.path} pointer={h}/>)}</ol></div>}
   {!groups.length && !data.unassociated.length && <p class="jobs-empty">{data.project ? `No handoff names ${data.project}.` : "No handoffs yet."}</p>}
  </>}
  </section></div>;
}

function HandoffRow({pointer}: {pointer: HandoffPointer}) {
 return <li class="jobs-history-row handoff-row">
  <a class="jobs-history-title" href={pointer.href} target="_blank" rel="noopener noreferrer"><code>{pointer.name}</code></a>
  <span class="jobs-history-meta">{pointer.root} · modified {observedTime(pointer.modified_at)}{pointer.truncated ? " · matched on its first 64 KiB" : ""}</span>
  {pointer.evidence.length > 0 && <span class="jobs-history-reason">Matched {pointer.evidence.map(e => e.value).join(", ")}{pointer.evidence_omitted ? ` and ${pointer.evidence_omitted} more` : ""}</span>}
  {(pointer.reports.length > 0 || pointer.answers.length > 0) && <span class="decided-job">{pointer.reports.map(r => <a key={r.job_id} href={r.href}>Report <code>{r.job_id}</code></a>)}{pointer.answers.map(a => <a key={a.id} href="#answers">Answer <code>{a.id}</code></a>)}</span>}
 </li>;
}
