import type { JobReportResponse } from "../../src/viewer/api-types.ts";
import { ReportDocument } from "../components/ReportDocument.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { observedTime } from "../format.ts";
import { jobHref } from "../routes.ts";
import "./report.css";

/** `#report/<id>`: the job's report.md rendered as a readable page at a reading width. */
export function JobReport({data}: {data:JobReportResponse}) {
 return <div class="report-page">
  <header class="report-heading"><PageHeader stack back={{href:jobHref(data.job_id), label:"Job"}} title="Report" detail={data.job_id}/>
   <p class="report-meta">Updated {observedTime(data.modified_at)} · <a href={jobHref(data.job_id)}><code>{data.job_id}</code></a>{data.truncated && ` · first ${Math.round(data.text.length / 1024)} KiB of ${Math.round(data.bytes / 1024)} KiB shown`}</p>
  </header>
  <article aria-label={data.title}><ReportDocument text={data.text} jobId={data.job_id}/></article>
 </div>;
}
