import type { ReportsResponse } from "../../src/viewer/api-types.ts";
import { observedTime } from "../format.ts";
import { jobHref } from "../routes.ts";
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
	</div>;
}
