import type { ComponentChild } from "preact";
import { useContext, useState } from "preact/hooks";
import { jobTranscriptHref } from "../routes.ts";
import { type Row, rowHead } from "../session-rows.ts";
import { PrChipLink, PrChips } from "./PrChip.tsx";

/**
 * Consecutive relay turns about one PR or job: the subject chip, the job link and the latest turn; the earlier turns sit
 * behind one toggle and render through `render`, the screen's own row renderer.
 */
export function RelayRollup({ row, render }: { row: Extract<Row, { kind: "rollup" }>; render: (row: Row) => ComponentChild }) {
 const [open, setOpen] = useState(false);
 const chips = useContext(PrChips);
 const pr = row.subject.startsWith("pr:") ? chips[row.subject.slice(3)] : undefined;
 const job = row.subject.startsWith("job:") ? row.subject.slice(4) : pr?.job_id ?? row.turns.map(t => rowHead(t[0]!).bridge?.job).findLast(Boolean) ?? null;
 const earlier = row.turns.slice(0, -1), n = earlier.length;
 return <section class="session-rollup" aria-label={`${row.turns.length} updates${pr ? ` on #${pr.number}` : job ? ` on ${job}` : ""}`}>
  <div class="session-rollup-head">
   {pr && <PrChipLink chip={pr}/>}
   {job && <a class="session-rollup-job" href={jobTranscriptHref(job)}>{job}</a>}
   <button type="button" class="session-rollup-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{n} earlier update{n === 1 ? "" : "s"} <span aria-hidden="true">{open ? "▾" : "▸"}</span></button>
  </div>
  {open && <div class="session-rollup-earlier">{earlier.flat().map(render)}</div>}
  {row.turns.at(-1)!.map(render)}
 </section>;
}
