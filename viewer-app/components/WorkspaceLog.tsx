import { useState } from "preact/hooks";
import type { JobReportResponse, JobResponse, JobTranscriptResponse, SessionEntry, SessionsResponse } from "../../src/viewer/api-types.ts";
import { elapsed, observedTime } from "../format.ts";
import { composerHref } from "../routes.ts";
import { JobAsk, jobAskTarget, JobDetail, JobFiles } from "../screens/JobDetail.tsx";
import { JobTranscript, parts } from "../screens/JobTranscript.tsx";
import { useScreenData } from "../use-screen-data.ts";
import { Icon } from "./icons.tsx";
import { ReportDocument } from "./ReportDocument.tsx";
import "./workspace-log.css";

export type LogView = "log" | "report" | "files" | "details";
type Worker = SessionsResponse["workers"][number];
const VIEWS: [LogView, string][] = [["log", "Log"], ["report", "Report"], ["files", "Files"], ["details", "Details"]];
const NOT = "not recorded";
const ARGS = ["command", "path", "file_path", "url", "job_id", "action"];

/** Frames 2/8: the job's id, worker role · model · thinking, and where it works; each unrecorded fact says so. */
function Identity({data, worker}: {data: JobResponse; worker: Worker | undefined}) {
 const job = data.job, root = data.files_href ? new URLSearchParams(data.files_href.split("?")[1]).get("root") : null;
 const model = job.model ?? worker?.model ?? (job.script_path ? `script ${job.script_path}` : `model ${NOT}`);
 const facts = [worker?.role ?? `role ${NOT}`, model, worker?.thinking ?? job.context?.thinking ?? `thinking ${NOT}`];
 // Roots are named by id, never by path (src/viewer/explorer.ts), and /api/job carries no branch: the root links to Files.
 const where = root?.startsWith("worktree:") ? `${job.project} worktree` : root?.startsWith("project:") ? `${job.project} clone` : null;
 return <div class="workspace-log-who">
  <span class="workspace-log-mark" aria-hidden="true">&gt;_</span>
  <div><code title={job.id}>{job.id}</code><p>{facts.join(" · ")}</p><p>{where && data.files_href ? <a href={data.files_href}>{where}</a> : NOT}</p></div>
 </div>;
}

const head = (text: string) => text.split("\n").filter(l => l.trim()).slice(0, 3).join("\n").slice(0, 400);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Added and removed lines from an edit's recorded old and new text (a line multiset diff); null when not recorded. */
function changed(args: Record<string, unknown>): string | null {
 const edits: unknown[] = Array.isArray(args.edits) ? args.edits : [args];
 let added = 0, removed = 0;
 for (const edit of edits) {
  const {oldText, newText} = (edit ?? {}) as Record<string, unknown>;
  if (typeof oldText !== "string" || typeof newText !== "string") return null;
  const old = oldText.split("\n");
  for (const line of newText.split("\n")) { const at = old.indexOf(line); if (at < 0) added++; else old.splice(at, 1); }
  removed += old.length;
 }
 return edits.length ? `Added ${plural(added, "line")}, removed ${plural(removed, "line")}` : null;
}

/** One entry as frames 2/8 word it: Read, Ran 1 shell command, Update; any other tool keeps its name, capitalised. */
function Line({entry}: {entry: SessionEntry}) {
 if (entry.kind === "tool" && entry.name === "report_result") return <p class="workspace-log-say">• Report filed</p>;
 if (entry.kind === "tool") {
  const {args, result} = parts(entry), name = entry.name ?? "tool", out = head(result), failed = entry.failed ? " · failed" : "";
  if (name === "bash") return <div class="workspace-log-tool"><p><b>Ran 1 shell command</b>{failed}</p>
   {typeof args.command === "string" && <pre>• {args.command}</pre>}{out && <pre>{out}</pre>}</div>;
  const target = ARGS.map(k => args[k]).find((v): v is string => typeof v === "string");
  const label = name === "read" ? "Read" : name === "edit" ? "Update" : name.charAt(0).toUpperCase() + name.slice(1);
  const note = entry.failed ? out : name === "read" && result.trim() ? `Read ${plural(result.trimEnd().split("\n").length, "line")}`
   : name === "edit" ? changed(args) ?? out : out;
  return <div class="workspace-log-tool"><p><b>{label}</b>{target !== undefined && `(${target})`}{failed}</p>{note && <pre>└ {note}</pre>}</div>;
 }
 if (entry.kind === "say" && entry.who === "Worker") return <p class="workspace-log-say">• {entry.text}</p>;
 return <p class="workspace-log-note">{entry.who} · {entry.text.split("\n")[0]?.slice(0, 200)}</p>;
}

/** The worker's recorded entries in order, as plain monospace lines: read-only. */
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

/**
 * P1 only for this job's own reference. Desktop reads frame 2's read-only line, the phone frame 8's entry; both only open
 * operator Chat with the reference (the entry's text as its draft) and never send, least of all to the worker.
 */
function AskFooter({data}: {data: JobResponse}) {
 const [text, setText] = useState("");
 const own = data.ask_reference?.kind === "job" && data.ask_reference.job_id === data.job.id;
 if (!own && data.job.phase !== "failed") return <footer class="workspace-log-ask"><span class="workspace-log-empty">Ask unavailable · no recorded reference for this job</span></footer>;
 const safe = own ? data : {...data, ask_reference: null}, ask = jobAskTarget(safe);
 const href = composerHref(text.trim() || ask.question, ask.reference ?? undefined);
 return <footer class="workspace-log-ask">
  <p class="workspace-log-readonly">Read-only. Steer this job from the chat with <JobAsk data={safe} label={`@${data.job.id}`}/></p>
  {ask.reference && ask.unsupported ? <span class="workspace-log-entry workspace-log-empty">Ask unavailable · {ask.unsupported}</span>
   : <div class="workspace-log-entry">
    <input type="text" aria-label="Ask the Operator about this job" placeholder="Ask the Operator about this job…" value={text}
     onInput={e => setText((e.currentTarget as HTMLInputElement).value)} onKeyDown={e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); location.hash = href; } }}/>
    <a class="workspace-log-send" href={href} title="Open in Chat as a draft; nothing is sent"><Icon name="send"/></a>
   </div>}
 </footer>;
}

/** Frame 2's document tab (`>_ <id>`, report.md, Files, Details) beside frame 8's segment label. */
function TabLabel({view, id, short}: {view: LogView; id: string; short: string}) {
 const doc = view === "log" ? <><span class="workspace-log-tab-glyph" aria-hidden="true">&gt;_</span><span class="workspace-log-tab-id">{id}</span></>
  : view === "report" ? <><Icon name="file" size={14}/>report.md</> : view === "files" ? <><Icon name="files" size={14}/>Files</> : "Details";
 return <><span class="workspace-log-tab-short">{short}</span><span class="workspace-log-tab-doc">{doc}</span></>;
}

/** The chat pane's job surface (frames 2/8); Details keeps the job page's P2 guide and Timeline, Diff waits for S7. */
export function WorkspaceLog({data, view, onView, initial, worker}: {data: JobResponse; view: LogView; onView: (view: LogView) => void; initial: Parameters<typeof JobDetail>[0]["initial"]; worker: Worker | undefined}) {
 const job = data.job;
 // S2's strip clock: the job's recorded elapsed, shown only while it works; an unknown never reads as 0.
 const live = job.phase === "working" ? `live${job.elapsed_seconds === null ? "" : ` · ${elapsed(job.elapsed_seconds)}`}` : null;
 return <div class="workspace-log" data-view={view}>
  <div class="workspace-log-bar">
   <div class="workspace-log-tabs" role="tablist" aria-label="Job views">{VIEWS.map(([key, short]) =>
    <button type="button" role="tab" key={key} data-view={key} aria-selected={view === key} class={view === key ? "workspace-log-tab workspace-log-tab-on" : "workspace-log-tab"} onClick={() => onView(key)}><TabLabel view={key} id={job.id} short={short}/></button>)}</div>
   {live && <span class="workspace-log-live">{live}</span>}
  </div>
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
