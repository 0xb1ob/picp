import { useState } from "preact/hooks";
import type { JobDiffResponse, JobReportResponse, JobResponse, JobTranscriptResponse, SessionEntry, SessionsResponse } from "../../src/viewer/api-types.ts";
import { elapsed, observedTime } from "../format.ts";
import { composerHref } from "../routes.ts";
import { JobAsk, jobAskTarget, JobDetail, JobFiles } from "../screens/JobDetail.tsx";
import { JobTranscript, parts } from "../screens/JobTranscript.tsx";
import { useScreenData } from "../use-screen-data.ts";
import { Icon } from "./icons.tsx";
import { ReportDocument } from "./ReportDocument.tsx";
import "./workspace-log.css";

export type LogView = "log" | "report" | "files" | "diff" | "details";
type Worker = SessionsResponse["workers"][number];
const VIEWS: [LogView, string][] = [["log", "Log"], ["report", "Report"], ["files", "Files"], ["diff", "Diff"], ["details", "Details"]];
const NOT = "not recorded";
const ARGS = ["command", "path", "file_path", "url", "job_id", "action"];

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

const head = (text: string) => text.split("\n").filter(l => l.trim()).slice(0, 3).join("\n").slice(0, 400);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** An edit's removed and added lines from its recorded old and new text (a line multiset diff); null if unrecorded. */
function editLines(args: Record<string, unknown>): {removed: string[]; added: string[]} | null {
 const edits: unknown[] = Array.isArray(args.edits) ? args.edits : [args];
 const removed: string[] = [], added: string[] = [];
 for (const edit of edits) {
  const {oldText, newText} = (edit ?? {}) as Record<string, unknown>;
  if (typeof oldText !== "string" || typeof newText !== "string") return null;
  const old = oldText.split("\n");
  for (const line of newText.split("\n")) { const at = old.indexOf(line); if (at < 0) added.push(line); else old.splice(at, 1); }
  removed.push(...old);
 }
 return edits.length ? {removed, added} : null;
}
// pi's read appends `[Showing lines A-B of N. Use offset=…]` or `[K more lines in file. Use offset=…]` (C2).
const NOTICE = /\n*\[(?:Showing lines (\d+)-(\d+) of (\d+)[^\]\n]*|[^\]\n]*Use offset=[^\]\n]*)\]\s*$/;
/** "Read N lines" without pi's trailing notice, or the notice's own range when it names one. */
function readNote(result: string): string {
 const notice = NOTICE.exec(result);
 if (notice?.[1]) return `Read lines ${notice[1]}–${notice[2]} of ${notice[3]}`;
 const body = (notice ? result.slice(0, notice.index) : result).trimEnd();
 return `Read ${plural(body ? body.split("\n").length : 0, "line")}`;
}
const INLINE_LINES = 8;
/** Frame 2's block under Update: removed, then added lines from the recorded arguments; no line numbers are recorded */
function EditBlock({lines}: {lines: {removed: string[]; added: string[]}}) {
 const all = [...lines.removed.map(l => ["del", `- ${l}`]), ...lines.added.map(l => ["add", `+ ${l}`])], more = all.length - INLINE_LINES;
 return <div class="workspace-log-diff workspace-log-edit">
  {all.slice(0, INLINE_LINES).map(([kind, text], i) => <div key={i} class={`workspace-log-diff-line workspace-log-diff-${kind}`}>{text}</div>)}
  {more > 0 && <div class="workspace-log-diff-more">{plural(more, "more line")}</div>}
 </div>;
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
  const lines = name === "edit" ? editLines(args) : null;
  const note = entry.failed ? out : name === "read" && result.trim() ? readNote(result)
   : lines ? `Added ${plural(lines.added.length, "line")}, removed ${plural(lines.removed.length, "line")}` : out;
  return <div class="workspace-log-tool"><p><b>{label}</b>{target !== undefined && `(${target})`}{failed}</p>{note && <pre>└ {note}</pre>}
   {lines && !entry.failed && (lines.removed.length + lines.added.length > 0) && <EditBlock lines={lines}/>}</div>;
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

/** Frame 2's document tab (`>_ <id>`, report.md, Files, Diff, Details) beside frame 8's segment label. */
function TabLabel({view, id, short}: {view: LogView; id: string; short: string}) {
 const doc = view === "log" ? <><span class="workspace-log-tab-glyph" aria-hidden="true">&gt;_</span><span class="workspace-log-tab-id">{id}</span></>
  : view === "report" ? <><Icon name="file" size={14}/>report.md</> : view === "files" ? <><Icon name="files" size={14}/>Files</> : short;
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
    <button type="button" role="tab" key={key} data-view={key} aria-selected={view === key} class={view === key ? "workspace-log-tab workspace-log-tab-on" : "workspace-log-tab"} onClick={() => onView(key)}><TabLabel view={key} id={job.id} short={short}/></button>)}</div>
   {live && <span class="workspace-log-live">{live}</span>}
  </div>
  <div class="workspace-job-body">
   {view !== "details" && <Identity data={data} worker={worker}/>}
   {view === "log" && <JobTranscript key={job.id} jobId={job.id} generatedAt={data.generated_at} model={job.model} reports={data.reports} finished={job.phase === "done" || job.phase === "failed"} view={d => <LogLines data={d}/>}/>}
   {view === "report" && <Report data={data}/>}
   {view === "files" && <div class="job-links workspace-log-files"><JobFiles data={data}/></div>}
   {view === "diff" && <Diff data={data}/>}
   {view === "details" && <JobDetail key={`${job.id}:${initial}`} data={data} wide={false} initial={initial} embedded/>}
  </div>
  {view !== "details" && <AskFooter data={data}/>}
 </div>;
}
