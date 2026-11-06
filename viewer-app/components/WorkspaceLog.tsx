import { useState } from "preact/hooks";
import type { JobDiffResponse, JobReportResponse, JobResponse, SessionsResponse } from "../../src/viewer/api-types.ts";
import { elapsed, observedTime } from "../format.ts";
import { composerHref } from "../routes.ts";
import { JobAsk, jobAskTarget, JobDetail, JobFiles } from "../screens/JobDetail.tsx";
import { useScreenData } from "../use-screen-data.ts";
import { Icon } from "./icons.tsx";
import { ReportDocument } from "./ReportDocument.tsx";
import "./workspace-log.css";

export type LogView = "report" | "files" | "diff" | "details";
type Worker = SessionsResponse["workers"][number];
const VIEWS: [LogView, string][] = [["report", "Report"], ["files", "Files"], ["diff", "Diff"], ["details", "Details"]];
const NOT = "not recorded";

/** Frames 2/8: the job's id, worker role · model · thinking, and where it works; each unrecorded fact says so. */
function Identity({data, worker}: {data: JobResponse; worker: Worker | undefined}) {
 const job = data.job, root = data.files_href ? new URLSearchParams(data.files_href.split("?")[1]).get("root") : null;
 const model = job.model ?? worker?.model ?? (job.script_path ? `script ${job.script_path}` : `model ${NOT}`);
 const facts = [worker?.role ?? `role ${NOT}`, model, worker?.thinking ?? job.context?.thinking ?? `thinking ${NOT}`];
 // Roots are named by id, never by path (src/viewer/explorer.ts), and /api/job carries no branch:
 // the root links to Files.
 const where = root?.startsWith("worktree:") ? `${job.project} worktree` : root?.startsWith("project:") ? `${job.project} clone` : null;
 return <div class="workspace-log-who">
  <span class="workspace-log-mark" aria-hidden="true">&gt;_</span>
  <div><code title={job.id}>{job.id}</code><p>{facts.join(" · ")}</p><p>{where && data.files_href ? <a href={data.files_href}>{where}</a> : NOT}</p></div>
 </div>;
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

/** One `git diff` line as plain text (never HTML); a binary file reads "binary, not shown", never as bytes. */
function DiffLine({line}: {line: string}) {
 const binary = /^Binary files (.+) and (.+) differ$/.exec(line);
 if (binary) return <div class="workspace-log-diff-line workspace-log-diff-note">{(binary[2] === "/dev/null" ? binary[1]! : binary[2]!).replace(/^[ab]\//, "")} · binary, not shown</div>;
 const kind = /^(?:diff --git|index |--- |\+\+\+ |similarity |rename |new file|deleted file)/.test(line) ? "file" : line.startsWith("@@") ? "hunk"
  : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
 return <div class={`workspace-log-diff-line workspace-log-diff-${kind}`}>{line || " "}</div>;
}

/**
 * S7's Diff: `/api/diff` of the job's recorded base...head, both full shas labelled. Historical evidence, never the
 * live worktree or PR; unavailable keeps its reason and the forge Files link, truncation is always named.
 */
function Diff({data}: {data: JobResponse}) {
 const read = useScreenData<JobDiffResponse>(`/api/diff?id=${encodeURIComponent(data.job.id)}`, "/api/stream?view=job");
 if (!read.data) return <p role="status" class="workspace-log-empty">{read.error ? "Diff unavailable · the recorded diff could not be read" : "Loading"}</p>;
 const d = read.data, lines = d.text.split("\n");
 if (lines.at(-1) === "") lines.pop();
 const from = (source: string | null) => source === "ci_watch" ? "CI watch" : source === "envelope" ? "envelope" : NOT;
 return <section class="workspace-log-diff-view" aria-label="Recorded diff">
  <dl class="workspace-log-shas">
   <div><dt>base</dt><dd><code>{d.base ?? NOT}</code> · {from(d.provenance.base)}</dd></div>
   <div><dt>head</dt><dd><code>{d.head ?? NOT}</code> · {from(d.provenance.head)}</dd></div>
  </dl>
  <p class="workspace-log-meta">Recorded base...head{d.branch && ` of ${d.branch}`}{d.root && ` in the ${data.job.project} clone`}; not the live worktree or PR</p>
  {d.unavailable !== null ? <p role="status" class="workspace-log-empty">Diff unavailable · {d.unavailable}{d.files_href && <> · <a href={d.files_href} target="_blank" rel="noreferrer">Files on the forge</a></>}</p>
   : <>{d.truncated && <p role="status" class="workspace-log-diff-truncated">Truncated · only the first part of the diff is shown{d.files_href && <> · <a href={d.files_href} target="_blank" rel="noreferrer">Files on the forge</a></>}</p>}
    {lines.length ? <div class="workspace-log-diff">{lines.map((line, i) => <DiffLine key={i} line={line}/>)}</div> : <p role="status" class="workspace-log-empty">No changes between the recorded shas</p>}</>}
 </section>;
}

/**
 * P1 only for this job's own reference. Desktop reads frame 2's read-only line, the phone frame 8's entry; both only
 * open operator Chat with the reference (typed text joins a kept draft) and never send, least of all to the worker.
 */
function AskFooter({data}: {data: JobResponse}) {
 const [text, setText] = useState("");
 const own = data.ask_reference?.kind === "job" && data.ask_reference.job_id === data.job.id;
 if (!own && data.job.phase !== "failed") return <footer class="workspace-log-ask"><span class="workspace-log-empty">Ask unavailable · no recorded reference for this job</span></footer>;
 const safe = own ? data : {...data, ask_reference: null}, ask = jobAskTarget(safe);
 const href = composerHref(text.trim() || ask.question, ask.reference ?? undefined, !!text.trim());
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

/** Frame 2's document tab (report.md, Files, Diff, Details) beside frame 8's segment label. */
function TabLabel({view, short}: {view: LogView; short: string}) {
 const doc = view === "report" ? <><Icon name="file" size={14}/>report.md</> : view === "files" ? <><Icon name="files" size={14}/>Files</> : short;
 return <><span class="workspace-log-tab-short">{short}</span><span class="workspace-log-tab-doc">{doc}</span></>;
}

/** The chat pane's job surface (frames 2/8); Details keeps the job page's P2 guide and Timeline. */
export function WorkspaceLog({data, view, onView, initial, worker}: {data: JobResponse; view: LogView; onView: (view: LogView) => void; initial: Parameters<typeof JobDetail>[0]["initial"]; worker: Worker | undefined}) {
 const job = data.job;
 // S2's strip clock: the job's recorded elapsed, shown only while it works; an unknown never reads as 0.
 const live = job.phase === "working" ? `live${job.elapsed_seconds === null ? "" : ` · ${elapsed(job.elapsed_seconds)}`}` : null;
 return <div class="workspace-log" data-view={view}>
  <div class="workspace-log-bar">
   <div class="workspace-log-tabs" role="tablist" aria-label="Job views">{VIEWS.map(([key, short]) =>
    <button type="button" role="tab" key={key} data-view={key} aria-selected={view === key} class={view === key ? "workspace-log-tab workspace-log-tab-on" : "workspace-log-tab"} onClick={() => onView(key)}><TabLabel view={key} short={short}/></button>)}</div>
   {live && <span class="workspace-log-live">{live}</span>}
  </div>
  <div class="workspace-job-body">
   {view !== "details" && <Identity data={data} worker={worker}/>}
   {view === "report" && <Report data={data}/>}
   {view === "files" && <div class="job-links workspace-log-files"><JobFiles data={data}/></div>}
   {view === "diff" && <Diff data={data}/>}
   {view === "details" && <JobDetail key={`${job.id}:${initial}`} data={data} wide={false} initial={initial} embedded/>}
  </div>
  {view !== "details" && <AskFooter data={data}/>}
 </div>;
}
