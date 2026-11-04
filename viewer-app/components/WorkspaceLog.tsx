import type { JobReportResponse, JobResponse, JobTranscriptResponse, SessionEntry, SessionsResponse } from "../../src/viewer/api-types.ts";
import { observedTime } from "../format.ts";
import { JobAsk, JobDetail, JobFiles } from "../screens/JobDetail.tsx";
import { JobTranscript, parts } from "../screens/JobTranscript.tsx";
import { useScreenData } from "../use-screen-data.ts";
import { ReportDocument } from "./ReportDocument.tsx";
import "./workspace-log.css";

export type LogView = "log" | "report" | "files" | "details";
type Worker = SessionsResponse["workers"][number];
const VIEWS: [LogView, string][] = [["log", "Log"], ["report", "Report"], ["files", "Files"], ["details", "Details"]];
const NOT = "not recorded";
const ARGS = ["command", "path", "file_path", "url", "job_id", "action"];

/** Frames 2/8: the job's id, worker role · model · thinking, and its worktree root; each unrecorded fact says so. */
function Identity({data, worker}: {data: JobResponse; worker: Worker | undefined}) {
 const job = data.job, root = data.files_href ? new URLSearchParams(data.files_href.split("?")[1]).get("root") : null;
 const facts = [worker?.role ?? `role ${NOT}`, job.script_path ?? job.model ?? worker?.model ?? `model ${NOT}`, worker?.thinking ?? job.context?.thinking ?? `thinking ${NOT}`];
 return <div class="workspace-log-who">
  <span class="workspace-log-mark" aria-hidden="true">&gt;_</span>
  <div><code title={job.id}>{job.id}</code><p>{facts.join(" · ")}</p><p>{root?.startsWith("worktree:") ? <code>{root}</code> : `worktree ${NOT}`}</p></div>
 </div>;
}

const head = (text: string) => text.split("\n").filter(l => l.trim()).slice(0, 3).join("\n").slice(0, 400);
function Line({entry}: {entry: SessionEntry}) {
 if (entry.kind === "tool" && entry.name === "report_result") return <p class="workspace-log-say">• Report filed</p>;
 if (entry.kind === "tool") {
  const {args, result} = parts(entry);
  const target = ARGS.map(k => args[k]).find((v): v is string => typeof v === "string");
  return <div class="workspace-log-tool"><p><b>{entry.name}</b>{target !== undefined && `(${target})`}{entry.failed && " · failed"}</p>{result.trim() && <pre>└ {head(result)}</pre>}</div>;
 }
 if (entry.kind === "say" && entry.who === "Worker") return <p class="workspace-log-say">• {entry.text}</p>;
 return <p class="workspace-log-note">{entry.who} · {entry.text.split("\n")[0]?.slice(0, 200)}</p>;
}

/** The worker's recorded entries in order, as plain monospace lines: read-only, no composer. */
function LogLines({data}: {data: JobTranscriptResponse}) {
 const rows = data.entries.filter(e => e.name !== "thinking");
 return <section class="workspace-log-lines" aria-label="Worker log">
  {data.warning && <p role="status">{data.warning}</p>}{data.truncated && <p>Recent events shown; the session is longer.</p>}
  {rows.map(e => <div class="workspace-log-row" key={e.id}><Line entry={e}/></div>)}
  {!rows.length && !data.warning && <p role="status">No recorded tool output yet</p>}
 </section>;
}

/** The report page's own read (`/api/report/<id>`); no report.md, or one that no longer reads, is unavailable. */
function Report({data}: {data: JobResponse}) {
 const report = useScreenData<JobReportResponse>(data.report_href ? `/api/report/${encodeURIComponent(data.job.id)}` : null, "/api/stream?view=report");
 if (!data.report_href) return <p role="status" class="workspace-log-empty">Report unavailable · no report.md recorded</p>;
 if (!report.data) return <p role="status" class="workspace-log-empty">{report.error ? "Report unavailable · report.md could not be read" : "Loading"}</p>;
 return <article class="workspace-log-report" aria-label={report.data.title}>
  <p class="workspace-log-meta">report.md · updated {observedTime(report.data.modified_at)} · <a href={data.report_href}>Open report page</a>{report.data.truncated && " · first part shown"}</p>
  <ReportDocument text={report.data.text} jobId={report.data.job_id}/>
 </article>;
}

/** P1 only for this job's own reference: the footer drafts in operator Chat and never sends to the worker. */
function AskFooter({data}: {data: JobResponse}) {
 const own = data.ask_reference?.kind === "job" && data.ask_reference.job_id === data.job.id;
 return <footer class="workspace-log-ask">{own || data.job.phase === "failed"
  ? <JobAsk data={own ? data : {...data, ask_reference: null}} label="Ask about this job…"/>
  : <span class="workspace-log-empty">Ask unavailable · no recorded reference for this job</span>}</footer>;
}

/** The chat pane's job surface (frames 2/8); Details keeps the job page's P2 guide and Timeline, Diff waits for S7. */
export function WorkspaceLog({data, view, onView, initial, worker}: {data: JobResponse; view: LogView; onView: (view: LogView) => void; initial: Parameters<typeof JobDetail>[0]["initial"]; worker: Worker | undefined}) {
 const job = data.job;
 return <div class="workspace-log" data-view={view}>
  <div class="workspace-log-tabs" role="tablist" aria-label="Job views">{VIEWS.map(([key, label]) =>
   <button type="button" role="tab" key={key} aria-selected={view === key} class={view === key ? "workspace-log-tab workspace-log-tab-on" : "workspace-log-tab"} onClick={() => onView(key)}>{label}</button>)}</div>
  <div class="workspace-job-body">
   {view !== "details" && <Identity data={data} worker={worker}/>}
   {view === "log" && <JobTranscript key={job.id} jobId={job.id} generatedAt={data.generated_at} model={job.model} reports={data.reports} finished={job.phase === "done" || job.phase === "failed"} view={d => <LogLines data={d}/>}/>}
   {view === "report" && <Report data={data}/>}
   {view === "files" && <div class="job-links workspace-log-files"><JobFiles data={data}/></div>}
   {view === "details" && <JobDetail key={`${job.id}:${initial}`} data={data} wide={false} initial={initial} embedded/>}
  </div>
  {view !== "details" && <AskFooter data={data}/>}
 </div>;
}
