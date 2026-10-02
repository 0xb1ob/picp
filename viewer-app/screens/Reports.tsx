import type { ReportsResponse } from "../../src/viewer/api-types.ts";
import { observedTime } from "../format.ts";
import { jobHref } from "../routes.ts";

export function Reports({data}: {data:ReportsResponse}) {
	return <div class="jobs-screen"><header class="jobs-heading"><h1>Reports</h1><p>Published web reports, newest first. Each title opens in a new tab; nothing here writes.</p></header>
	 <section class="jobs-group" aria-label="Published reports">
	  <header><h2>Published · {data.reports.length}</h2><p>Newest revision per job</p></header>
	  <div class="reports-grid">{data.reports.map(report => <article class="job-row" key={report.slug}>
	   <div class="job-row-heading"><a class="job-title" href={report.href} target="_blank" rel="noopener noreferrer">{report.title}</a><span class="decided-time">{observedTime(report.created_at)}</span></div>
	   <p class="job-meta">{report.description}</p>
	   <div class="decided-job">{report.job_ids.map(id => <a key={id} href={jobHref(id)}><code>{id}</code></a>)}</div>
	  </article>)}</div>
	  {!data.reports.length && <p class="jobs-empty">No published reports yet</p>}
	 </section>
	</div>;
}
