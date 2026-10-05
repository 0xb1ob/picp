import { useState } from "preact/hooks";
import type { DecidedResponse, DecisionDetail } from "../../src/viewer/api-types.ts";
import { observedTime, time } from "../format.ts";
import { jobHref } from "../routes.ts";
export function filterDecisions(items:DecisionDetail[], range:"today" | "all", worth:boolean): DecisionDetail[] {
 return items.filter(item => (range === "all" || item.today) && (!worth || item.worth.length > 0));
}
/** The browser-local calendar day a decision was answered on. */
const day = (row:DecisionDetail) => new Date(row.answered_at).toDateString();
const WORTH_EMPTY = "Answers given on the operator\u2019s own judgement appear here. None of the rows shown above qualify: each rests on your words or a standing order.";
type Who = "for" | "you";
function basisView(row:DecisionDetail): {label:string; ref:string | null; standing:boolean} {
 if (row.source === "you") return {label:"your reply", ref:row.basis?.ref ?? row.id, standing:false};
 if (row.basis?.kind === "words") return {label:"your words", ref:row.basis.ref, standing:false};
 if (row.basis?.kind === "standing") return {label:"standing order", ref:row.basis.ref, standing:true};
 if (row.basis?.kind === "judgement") return {label:"operator's own judgement", ref:row.basis.ref, standing:false};
 return {label:row.rule ?? "Not recorded", ref:null, standing:false};
}
function DecidedRow({row}: {row:DecisionDetail}) {
 // Audit P2 #16: evidence opens the job the decision names; only a jobless one falls back to the parent transcript.
 const evidence = row.job_ids[0] ? jobHref(row.job_ids[0]) : "#sessions?view=parent";
 const basis = basisView(row);
 return <article class="decided-row"><div class="decided-time"><code>{row.today ? time(row.answered_at) : observedTime(row.answered_at)}</code>{row.worth.length > 0 && <span class="decided-flag"><span class="decision-diamond"/>{row.worth.join(", ")}</span>}</div><div class="decided-job">{row.job_ids.map(id => <a key={id} href={jobHref(id)}><code>{id}</code></a>)}<code class="decided-id">{row.id}</code>{row.source === "you" && <span class="decided-source">answered by you</span>}</div><p class="decided-question" title={row.question}>{row.question}</p><div class="decided-answer"><strong>{row.answer}</strong>{row.quote && <span>&ldquo;{row.quote}&rdquo;</span>}</div><p class="decided-rule"><span class={`decided-basis${basis.standing ? " decided-basis-standing" : ""}`}>{basis.label}</span>{basis.ref && <span class="decided-basis-ref">{basis.ref}</span>}</p><div class="decided-evidence">{row.source_escalation ? <a href={evidence}><span class="decision-phone">evidence</span><span class="decision-desktop">open</span> &rarr;</a> : <span title="Operator transcript is not recorded">not recorded</span>}</div></article>;
}
function onTabKey(who:Who, key:string): Who | null {
 if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
 const order: Who[] = ["for", "you"];
 const i = order.indexOf(who);
 return order[(i + (key === "ArrowRight" ? 1 : -1) + order.length) % order.length]!;
}
export function DecidedScreen({data}: {data:DecidedResponse}) {
 const [range,setRange] = useState<"today" | "all">("today");
 const [worth,setWorth] = useState(false);
 const [who,setWho] = useState<Who>("for");
 const ranged = filterDecisions(data.items,range,false);
 const forRows = ranged.filter(d => d.source !== "you");
 const youRows = ranged.filter(d => d.source === "you");
 const rows = who === "you" ? youRows : (worth ? forRows.filter(d => d.worth.length > 0) : forRows);
 // Audit P1 #6: a day's routine mission-end closes fold into one line until shown; one close alone stays a row.
 const [shown,setShown] = useState<string[]>([]);
 const closes = new Map<string,number>();
 for (const row of rows) if (row.kind === "mission_end") closes.set(day(row),(closes.get(day(row)) ?? 0)+1);
 const collapsed = (row:DecisionDetail) => row.kind === "mission_end" && (closes.get(day(row)) ?? 0) > 1 && !shown.includes(day(row));
 const summarized = new Set<string>();
 const complete = data.availability.asks !== "unavailable" && data.availability.escalations !== "unavailable";
 const n = (count:number) => complete ? String(count) : "-";
 const tab = who === "for" ? "decided-tab-for" : "decided-tab-you";
 const panel = who === "for" ? "decided-panel-for" : "decided-panel-you";
 const move = (e: KeyboardEvent) => {
  const next = onTabKey(who, e.key);
  if (!next) return;
  e.preventDefault();
  setWho(next);
  const id = next === "for" ? "decided-tab-for" : "decided-tab-you";
  queueMicrotask(() => { const node = document.getElementById(id); if (typeof node?.focus === "function") node.focus(); });
 };
 return <div class="decided-screen"><header class="decision-heading"><div class="decided-tabs" role="tablist" aria-label="Who answered"><button type="button" role="tab" id="decided-tab-for" aria-selected={who === "for"} aria-controls="decided-panel-for" tabIndex={who === "for" ? 0 : -1} onKeyDown={move} onClick={() => setWho("for")}>Decided for you {n(forRows.length)}</button><button type="button" role="tab" id="decided-tab-you" aria-selected={who === "you"} aria-controls="decided-panel-you" tabIndex={who === "you" ? 0 : -1} onKeyDown={move} onClick={() => setWho("you")}>Answered by you {n(youRows.length)}</button></div></header>
  <div class="decided-main"><div class="decided-filter-bar"><div class="decided-range" role="group" aria-label="Range"><button type="button" aria-pressed={range === "today"} onClick={() => setRange("today")}>Today</button><button type="button" aria-pressed={range === "all"} onClick={() => setRange("all")}>All</button></div><button type="button" class="decided-worth" aria-pressed={worth} onClick={() => setWorth(!worth)}><span class="decision-diamond"/>Worth a look<span class="decision-desktop"> only</span></button></div>
   {!complete && <p role="alert" class="overview-error">Decisions unavailable for {Object.entries(data.availability).filter(([,v]) => v === "unavailable").map(([key]) => key).join(" and ")}. Showing available records.</p>}
   <div class="decided-columns decision-desktop" aria-hidden="true"><span>time</span><span>job</span><span>question</span><span>answer</span><span>basis</span><span>evidence</span></div>
   <section class="decided-rows" role="tabpanel" id={panel} aria-labelledby={tab}>{rows.map(row => {
    if (!collapsed(row)) return <DecidedRow key={row.id} row={row}/>;
    const key = day(row); if (summarized.has(key)) return null; summarized.add(key);
    return <p key={`closes-${key}`} class="decided-closes">{closes.get(key)} mandate closes<button type="button" aria-expanded="false" onClick={() => setShown([...shown,key])}>show</button></p>;
   })}{!rows.length && complete && (who === "for" && worth ? <p class="decided-empty">{WORTH_EMPTY}</p> : <p class="decided-empty">Nothing here for this filter.</p>)}</section>
  </div></div>;
}
