import { type ComponentChild, createContext } from "preact";
import { useContext, useState } from "preact/hooks";
import { time } from "../format.ts";
import { jobTranscriptHref } from "../routes.ts";
import { dayKey, type Row, rowHead } from "../session-rows.ts";
import { chipHrefs } from "./Markdown.tsx";
import { PrChipLink, PrChips } from "./PrChip.tsx";

const isNotice = (r: Row) => r.kind === "entry" && r.entry.kind === "system" && !!r.entry.bridge;
/** Inside a rollup a run of steps shows its wake notice only when its pill is open: one place, not two. */
export const InRollup = createContext(false);
/**
 * Consecutive relay turns about one PR or job: the subject chip (unless the latest relay already chips it), the latest
 * turn's steps, one meta line (time · job · N earlier · N notice) right above the latest relay; one toggle opens the
 * earlier turns (on top, in order) and the latest wake notice in place, rendered through `render`, the screen's own.
 */
export function RelayRollup({ row, render }: { row: Extract<Row, { kind: "rollup" }>; render: (row: Row) => ComponentChild }) {
 const [open, setOpen] = useState(false);
 const chips = useContext(PrChips);
 const url = row.subject.startsWith("pr:") ? row.subject.slice(3) : null, pr = url ? chips[url] : undefined;
 const job = row.subject.startsWith("job:") ? row.subject.slice(4) : pr?.job_id ?? row.turns.map(t => rowHead(t[0]!).bridge?.job).findLast(Boolean) ?? null;
 const earlier = row.turns.slice(0, -1), n = earlier.length, last = row.turns.at(-1)!;
 const notices = last.filter(isNotice), body = last.filter(r => !isNotice(r)), k = notices.length;
 const lead = body.findIndex(r => r.kind !== "steps"), split = lead < 0 ? body.length : lead;
 const inline = body.some(r => r.kind === "entry" && r.entry.kind === "say" && chipHrefs(r.entry.text, r.entry.links).includes(url!));
 const at = rowHead(notices[0] ?? last[0]!).at;
 return <section class="session-rollup" aria-label={`${row.turns.length} updates${pr ? ` on #${pr.number}` : job ? ` on ${job}` : ""}`}>
  <InRollup.Provider value={true}>
  {pr && !inline && <div class="session-rollup-head"><PrChipLink chip={pr}/></div>}
  {open && n > 0 && <div class="session-rollup-earlier">{earlier.flat().map(render)}</div>}
  {body.slice(0, split).map(render)}
  {(n > 0 || k > 0) && <div class="session-rollup-meta">
   {dayKey(at) && <><time class="session-time" dateTime={at}>{time(at)}</time><span aria-hidden="true">·</span></>}
   {/* The id ellipsizes in its middle: the suffix tells jobs apart. */}
   {job && <><a class="session-rollup-job" href={jobTranscriptHref(job)} title={job}><span>{job.slice(0, -5)}</span>{job.slice(-5)}</a><span aria-hidden="true">·</span></>}
   <button type="button" class="session-rollup-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
    {[n > 0 && `${n} earlier`, k > 0 && `${k} notice${k === 1 ? "" : "s"}`].filter(Boolean).join(" · ")} <span aria-hidden="true">{open ? "▾" : "▸"}</span>
   </button>
  </div>}
  {open && notices.map(render)}
  {body.slice(split).map(render)}
  </InRollup.Provider>
 </section>;
}
