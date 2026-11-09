import { useEffect, useRef, useState } from "preact/hooks";
import type { JobTranscriptResponse, ReportItem, SessionEntry } from "../../src/viewer/api-types.ts";
import { ToolRunRow } from "../components/ToolRunRow.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { time } from "../format.ts";
import { type Held, readDelta } from "../resource.ts";

/** A tool call's arguments and result, split the way parseTranscript joins them (`Arguments\n…\n\nResult\n…`). */
export function parts(entry: SessionEntry): {args: Record<string, unknown>; result: string} {
 const [head = "", ...rest] = entry.text.split("\n\nResult\n");
 let args: Record<string, unknown> = {};
 try { const parsed = JSON.parse(head.replace(/^Arguments\n/, "")); if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>; } catch { /* Not JSON: shown as the raw result only. */ }
 return {args, result: rest.join("\n\nResult\n")};
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ARGS = ["command", "path", "file_path", "url", "job_id", "action"];
const head = (text: string) => text.split("\n").filter(l => l.trim()).slice(0, 3).join("\n").slice(0, 400);
/** An edit's removed and added lines from its recorded old and new text (a line multiset diff); null if unrecorded.
 * pi records `oldText`/`newText`, the Claude CLI `old_string`/`new_string`. */
function editLines(args: Record<string, unknown>): {removed: string[]; added: string[]} | null {
 const edits: unknown[] = Array.isArray(args.edits) ? args.edits : [args];
 const removed: string[] = [], added: string[] = [];
 for (const edit of edits) {
  const e = (edit ?? {}) as Record<string, unknown>, oldText = e.oldText ?? e.old_string, newText = e.newText ?? e.new_string;
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
/** An edit's removed, then added lines from the recorded arguments; no line numbers are recorded. */
function EditBlock({lines}: {lines: {removed: string[]; added: string[]}}) {
 const all = [...lines.removed.map(l => ["del", `- ${l}`]), ...lines.added.map(l => ["add", `+ ${l}`])], more = all.length - INLINE_LINES;
 return <div class="workspace-log-diff workspace-log-edit">
  {all.slice(0, INLINE_LINES).map(([kind, text], i) => <div key={i} class={`workspace-log-diff-line workspace-log-diff-${kind}`}>{text}</div>)}
  {more > 0 && <div class="workspace-log-diff-more">{plural(more, "more line")}</div>}
 </div>;
}
const FULL_MAX = 2000;
/** The output's first FULL_MAX characters behind a toggle, only when the shown head cut lines or characters. */
function FullOutput({result, shown}: {result: string; shown: string}) {
 const [open, setOpen] = useState(false), full = result.slice(0, FULL_MAX);
 if (full.split("\n").filter(l => l.trim()).join("\n") === shown) return null;
 return <>{open && <pre class="jt-full">{full}</pre>}
  <button type="button" class="jt-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show full output"}</button></>;
}
/** One tool call worded Read, Ran 1 shell command, Update or Search; pi's lower-case and native capitalised names
 * alike. A shell or failed call keeps its full output behind a toggle. */
function ToolLine({entry}: {entry: SessionEntry}) {
 const {args, result} = parts(entry), name = entry.name ?? "tool", out = head(result), failed = entry.failed ? " · failed" : "";
 const tool = name.toLowerCase(), search = name === "Grep" || name === "Glob";
 if (tool === "bash") return <><p><b>Ran 1 shell command</b>{failed}</p>{typeof args.command === "string" && <pre>• {args.command}</pre>}{out && <pre>{out}</pre>}
  <FullOutput result={result} shown={out}/></>;
 const target = search && typeof args.pattern === "string" ? args.pattern : ARGS.map(k => args[k]).find((v): v is string => typeof v === "string");
 const label = search ? "Search" : tool === "read" ? "Read" : tool === "edit" ? "Update" : name.charAt(0).toUpperCase() + name.slice(1);
 const lines = tool === "edit" ? editLines(args) : null;
 const note = entry.failed ? out : tool === "read" && result.trim() ? readNote(result)
  : lines ? `Added ${plural(lines.added.length, "line")}, removed ${plural(lines.removed.length, "line")}` : out;
 return <><p><b>{label}</b>{target !== undefined && `(${target})`}{failed}</p>{note && <pre>└ {note}</pre>}
  {lines && !entry.failed && (lines.removed.length + lines.added.length > 0) && <EditBlock lines={lines}/>}{entry.failed && <FullOutput result={result} shown={out}/>}</>;
}

/** A run of tool calls as the shared collapsible row; `open` is only the initial state. */
export function ToolRun({run, open: initial = false}: {run: SessionEntry[]; open?: boolean}) {
 const [open, setOpen] = useState(initial);
 const count = (...names: string[]) => run.filter(e => names.includes((e.name ?? "").toLowerCase())).length;
 const reads = count("read"), edits = count("edit", "write"), commands = count("bash");
 const detail = [reads > 0 && `read ${plural(reads, "file")}`, edits > 0 && `edited ${edits}`, commands > 0 && `ran ${plural(commands, "command")}`].filter(Boolean).join(" · ");
 return <ToolRunRow solid count={run.length} detail={detail} open={open} onToggle={() => setOpen(!open)}>
  {run.map(e => <div class={e.failed ? "jt-tool jt-tool-failed" : "jt-tool"} key={e.id}><ToolLine entry={e}/></div>)}
 </ToolRunRow>;
}

type Block = {kind: "tools"; run: SessionEntry[]} | {kind: "entry"; entry: SessionEntry};
function group(entries: SessionEntry[]): Block[] {
 const out: Block[] = [];
 for (const entry of entries) {
  const last = out.at(-1);
  if (entry.kind === "tool" && entry.name !== "report_result" && entry.name !== "thinking") { if (last?.kind === "tools") last.run.push(entry); else out.push({kind: "tools", run: [entry]}); }
  else if (entry.name !== "thinking") out.push({kind: "entry", entry});
 }
 return out;
}
const isReview = (e: SessionEntry) => /review/i.test(e.bridge?.kind ?? "");
const isReport = (e: SessionEntry) => e.kind === "tool" && e.name === "report_result";
const isWorker = (e: SessionEntry) => e.kind === "say" && e.who === "Worker";

export const POLL_MS = 10_000;
/**
 * Whether a screen refresh should start a transcript request: never while one runs; at most every POLL_MS when live; once when
 * finished, plus one final fetch when the loaded copy predates the finish (`loadedLive`), so the last interval's entries
 * (report, review) are not lost.
 */
export function shouldFetch(s: {inflight: boolean; loaded: boolean; loadedLive: boolean; finished: boolean; sinceMs: number}): boolean {
 return !s.inflight && (!s.loaded || (s.finished ? s.loadedLive : s.sinceMs >= POLL_MS));
}
/**
 * The worker's session as a read-only document: no composer, no POST. A finished job is fetched once; a live one refetches on
 * a screen refresh at most every POLL_MS, one request at a time (aborting on each tick would never let a big session land).
 * The caller keys this by job id, so a switch mounts fresh: no stale transcript, and unmount aborts the request.
 */
export function JobTranscript({jobId, generatedAt, model, reports, finished}: {jobId: string; generatedAt: string; model: string | null; reports: ReportItem[]; finished: boolean}) {
 const [data, setData] = useState<JobTranscriptResponse | null>(null);
 const [failed, setFailed] = useState(false);
 const inflight = useRef<AbortController | null>(null);
 const loaded = useRef(false), loadedLive = useRef(false), lastAt = useRef(0);
 // The shown transcript with its server version: the base the next live tick asks a delta against.
 const held = useRef<Held<JobTranscriptResponse> | null>(null);
 const [settled, setSettled] = useState(0);
 const finishedNow = useRef(finished);
 finishedNow.current = finished;
 useEffect(() => () => { inflight.current?.abort(); inflight.current = null; }, []);
 useEffect(() => {
  if (!shouldFetch({inflight: inflight.current !== null, loaded: loaded.current, loadedLive: loadedLive.current, finished, sinceMs: Date.now() - lastAt.current})) return;
  const abort = inflight.current = new AbortController();
  lastAt.current = Date.now();
  const wasLive = !finished;
  readDelta<JobTranscriptResponse>((url, init) => fetch(url, init), `/api/job/${encodeURIComponent(jobId)}/transcript`, held.current, abort.signal).then(read => read.ok ? read.held : Promise.reject(new Error(String(read.response.status)))).then(next => { held.current = next; loaded.current = true; loadedLive.current = wasLive; setData(next.value); setFailed(false); }).catch(() => { if (!abort.signal.aborted) setFailed(true); }).finally(() => { if (inflight.current !== abort) return; inflight.current = null; if (wasLive && finishedNow.current) setSettled(n => n + 1); });
 }, [jobId, generatedAt, finished, settled]);
 if (failed && !data) return <p class="jobs-empty" role="status">Transcript unavailable</p>;
 if (!data) return <p role="status">Loading</p>;
 return <TranscriptDocument data={data} model={model} reports={reports}/>;
}

/** The transcript page from a fetched response; pure of fetching so a fixture renders it. */
export function TranscriptDocument({data, model, reports}: {data: JobTranscriptResponse; model: string | null; reports: ReportItem[]}) {
 const [fullBrief, setFullBrief] = useState(false);
 const brief = data.entries.find(e => e.kind === "say" && e.who === "Parent");
 const rest = group(data.entries.filter(e => e !== brief));
 const lastKey = rest.map((b, i) => [b, i] as const).filter(([b]) => b.kind === "entry" && (isWorker(b.entry) || isReport(b.entry) || isReview(b.entry))).at(-1)?.[1] ?? rest.length - 1;
 const shown = rest.slice(0, lastKey + 1), trailing = rest.slice(lastKey + 1);
 const hasReport = data.entries.some(isReport), hasReviews = data.entries.some(isReview);
 const jump = (id: string) => () => document.getElementById(id)?.scrollIntoView({block: "start"});
 const render = (b: Block, i: number) => b.kind === "tools" ? <ToolRun key={i} run={b.run}/> : isReport(b.entry)
  ? <div class="jt-report" id="jt-report" key={b.entry.id}><strong>Report filed</strong><span>{time(b.entry.at)}</span>{reports[0] && <a href={reports[0].href} target="_blank" rel="noopener noreferrer">Open report ↗</a>}</div>
  : isReview(b.entry) ? <details class="jt-review" id={i === rest.findIndex(x => x.kind === "entry" && isReview(x.entry)) ? "jt-reviews" : undefined} key={b.entry.id}><summary><span class="jt-caret" aria-hidden="true">▸</span>{b.entry.bridge?.kind} · {time(b.entry.at)}</summary><Markdown text={b.entry.text} links={b.entry.links}/></details>
  : isWorker(b.entry) ? <div class="jt-say" key={b.entry.id}><div class="jt-label">Worker · {time(b.entry.at)}</div><Markdown text={b.entry.text} links={b.entry.links}/></div>
  : <div class="jt-note" key={b.entry.id}><span>{b.entry.who}</span> {b.entry.text.split("\n")[0]?.slice(0, 200)}</div>;
 return <section class="job-transcript" aria-label="Worker transcript">
  <div class="jt-head"><span class="jt-chip">read-only</span><span class="jt-session">Worker session · {model ?? "model not recorded"}{data.from && data.to && ` · ${time(data.from)}–${time(data.to)}`}</span>
   {(brief || hasReport || hasReviews) && <span class="jt-jump">{brief && <button type="button" onClick={jump("jt-brief")}>Jump to Brief</button>}{hasReport && <button type="button" onClick={jump("jt-report")}>Report</button>}{hasReviews && <button type="button" onClick={jump("jt-reviews")}>Reviews</button>}</span>}</div>
  {data.warning && <p class="jobs-empty" role="status">{data.warning}</p>}
  {data.truncated && <p class="job-meta">Recent events shown; the session is longer.</p>}
  {brief && <div class="jt-brief" id="jt-brief"><div class="jt-label">Parent · {time(brief.at)}</div><div class={fullBrief ? "" : "jt-clamp"}><Markdown text={brief.text} links={brief.links}/></div><button type="button" onClick={() => setFullBrief(!fullBrief)}>{fullBrief ? "Show less" : "Show full brief"}</button></div>}
  {shown.map(render)}
  {trailing.length > 0 && <details class="jt-trailing"><summary><span class="jt-caret" aria-hidden="true">▸</span>{plural(trailing.reduce((n, b) => n + (b.kind === "tools" ? b.run.length : 1), 0), "more event")}</summary>{trailing.map((b, i) => render(b, shown.length + i))}</details>}
 </section>;
}
