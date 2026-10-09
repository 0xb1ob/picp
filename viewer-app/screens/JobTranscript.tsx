import { useEffect, useRef, useState } from "preact/hooks";
import type { JobTranscriptResponse, ReportItem, SessionEntry } from "../../src/viewer/api-types.ts";
import { Markdown } from "../components/Markdown.tsx";
import { time } from "../format.ts";

/** A tool call's arguments and result, split the way parseTranscript joins them (`Arguments\n…\n\nResult\n…`). */
function parts(entry: SessionEntry): {args: Record<string, unknown>; result: string} {
 const [head = "", ...rest] = entry.text.split("\n\nResult\n");
 let args: Record<string, unknown> = {};
 try { const parsed = JSON.parse(head.replace(/^Arguments\n/, "")); if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>; } catch { /* Not JSON: shown as the raw result only. */ }
 return {args, result: rest.join("\n\nResult\n")};
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ToolRun({run}: {run: SessionEntry[]}) {
 const count = (...names: string[]) => run.filter(e => names.includes(e.name ?? "")).length;
 const reads = count("read"), edits = count("edit", "write"), commands = count("bash");
 return <details class="jt-tools"><summary><span class="jt-caret" aria-hidden="true">▸</span>{plural(run.length, "tool call")}{reads > 0 && ` · read ${plural(reads, "file")}`}{edits > 0 && ` · edited ${edits}`}{commands > 0 && ` · ran ${plural(commands, "command")}`}</summary>
  {run.map(e => {
   const {args, result} = parts(e);
   const command = e.name === "bash" && typeof args.command === "string" ? args.command : null;
   const target = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
   return <div class={e.failed ? "jt-tool jt-tool-failed" : "jt-tool"} key={e.id}>
    <div class="jt-tool-head"><code>{e.name}</code>{target && <span>{target}</span>}{e.failed && <b class="jt-failed">failed</b>}</div>
    {command ? <pre class="jt-command">{command}</pre> : null}
    {(command || e.failed) && result ? <pre class="jt-result">{result.slice(0, 2000)}</pre> : null}
   </div>;
  })}
 </details>;
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

/** The worker's session as a read-only document: no composer, no POST. */
export function JobTranscript({jobId, generatedAt, model, reports}: {jobId: string; generatedAt: string; model: string | null; reports: ReportItem[]}) {
 const [data, setData] = useState<JobTranscriptResponse | null>(null);
 const [failed, setFailed] = useState(false);
 const [fullBrief, setFullBrief] = useState(false);
 const live = useRef<AbortController | null>(null);
 useEffect(() => () => { live.current?.abort(); live.current = null; }, [jobId]);
 // One request at a time: the page refreshes every second or so, and a big session parses slower than that, so aborting on each
 // generated_at change would never let a transcript land. A change while one is in flight is picked up by the next change.
 useEffect(() => {
  if (live.current) return;
  const abort = live.current = new AbortController();
  fetch(`/api/job/${encodeURIComponent(jobId)}/transcript`, {signal: abort.signal}).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).then((body: JobTranscriptResponse) => { setData(body); setFailed(false); }).catch(() => { if (!abort.signal.aborted) setFailed(true); }).finally(() => { if (live.current === abort) live.current = null; });
 }, [jobId, generatedAt]);
 if (failed && !data) return <p class="jobs-empty" role="status">Transcript unavailable</p>;
 if (!data) return <p role="status">Loading</p>;
 const brief = data.entries.find(e => e.kind === "say" && e.who === "Parent");
 const rest = group(data.entries.filter(e => e !== brief));
 const lastKey = rest.map((b, i) => [b, i] as const).filter(([b]) => b.kind === "entry" && (isWorker(b.entry) || isReport(b.entry))).at(-1)?.[1] ?? rest.length - 1;
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
