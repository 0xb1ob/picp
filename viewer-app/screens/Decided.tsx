import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { DecidedResponse, DecisionDetail } from "../../src/viewer/api-types.ts";
import { observedTime, time } from "../format.ts";
import { jobHref } from "../routes.ts";
/** Rows shown before the "N more" button (after the mission-end fold). */
const FOLD_AT = 5;
export function filterDecisions(items:DecisionDetail[], range:"today" | "all", worth:boolean): DecisionDetail[] {
 return items.filter(item => (range === "all" || item.today) && (!worth || item.worth.length > 0));
}
/** The browser-local calendar day a decision was answered on. */
const day = (row:DecisionDetail) => new Date(row.answered_at).toDateString();
const WORTH_EMPTY = "Answers given on the operator\u2019s own judgement appear here. None of the rows shown above qualify: each rests on your words or a standing order.";
type Who = "for" | "you";
function basisView(row:DecisionDetail): {label:string; ref:string | null; standing:boolean} {
 if (row.source === "you") return {label:"your reply", ref:row.basis?.ref ?? row.id, standing:false};
 if (row.basis?.kind === "run") return {label:`run ${row.basis.ref}`, ref:null, standing:false};
 if (row.basis?.kind === "words") return {label:"your words", ref:row.basis.ref, standing:false};
 if (row.basis?.kind === "standing") return {label:"standing order", ref:row.basis.ref, standing:true};
 if (row.basis?.kind === "judgement") return {label:"operator's own judgement", ref:row.basis.ref, standing:false};
 return {label:row.rule ?? "Not recorded", ref:null, standing:false};
}
function DecidedRow({row}: {row:DecisionDetail}) {
 // Audit P2 #16: evidence opens the job the decision names; only a jobless one falls back to the parent transcript.
 const evidence = row.job_ids[0] ? jobHref(row.job_ids[0]) : "#sessions?view=parent";
 const basis = basisView(row);
 const [open,setOpen] = useState(false);
 // The job id already leads the content stack as a link, so a leading "<id>: " prefix is dropped (later mentions stay); the raw text stays in the title.
 const asked = row.job_ids.reduce((q,id) => q.startsWith(id) ? q.slice(id.length).replace(/^[\s:\u00b7,;\u2013\u2014-]+/,"") : q,row.question.trim()) || row.question;
 const toggle = () => setOpen(!open);
 return <article class="decided-row"><div class="decided-time"><code>{row.today ? time(row.answered_at) : observedTime(row.answered_at)}</code></div><div class="decided-content"><div class="decided-job">{row.job_ids.map(id => <a key={id} href={jobHref(id)}><code>{id}</code></a>)}<code class="decided-id">{row.id}</code>{row.source === "you" && <span class="decided-source">answered by you</span>}</div><p class="decided-question" title={row.question}>{asked}</p><div class="decided-answer"><strong>{row.answer}</strong>{row.quote && <span class={`decided-quote${open ? " decided-quote-open" : ""}`} role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e:KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}>&ldquo;{row.quote}&rdquo;</span>}</div></div><p class="decided-rule"><span title={row.worth.length ? row.worth.join(", ") : undefined} class={`decided-basis${basis.standing ? " decided-basis-standing" : ""}${row.basis?.kind === "judgement" ? " decided-basis-judgement" : ""}`}>{basis.label}</span>{basis.ref && <span class="decided-basis-ref">{basis.ref}</span>}</p><div class={`decided-evidence${row.job_ids.length ? "" : " decided-evidence-jobless"}`}>{row.source_escalation ? <a href={evidence}><span class="decision-phone">evidence</span><span class="decision-desktop">open</span> &rarr;</a> : <span title="Operator transcript is not recorded">not recorded</span>}</div></article>;
}
function onTabKey(who:Who, key:string): Who | null {
 if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
 const order: Who[] = ["for", "you"];
 const i = order.indexOf(who);
 return order[(i + (key === "ArrowRight" ? 1 : -1) + order.length) % order.length]!;
}
export function DecidedScreen({data}: {data:DecidedResponse}) {
 const [range,setRangeRaw] = useState<"today" | "all">("today");
 const [worth,setWorthRaw] = useState(false);
 const [who,setWhoRaw] = useState<Who>("for");
 const [more,setMore] = useState(false); // re-closes whenever who/range/worth changes
 const setWho = (v:Who) => { setMore(false); setWhoRaw(v); };
 const setRange = (v:"today" | "all") => { setMore(false); setRangeRaw(v); };
 const setWorth = (v:boolean) => { setMore(false); setWorthRaw(v); };
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
 return <div class="decided-screen"><header class="decided-toolbar"><div class="decided-tabs" role="tablist" aria-label="Who answered"><button type="button" role="tab" id="decided-tab-for" aria-selected={who === "for"} aria-controls="decided-panel-for" tabIndex={who === "for" ? 0 : -1} onKeyDown={move} onClick={() => setWho("for")}>Decided for you {n(forRows.length)}</button><button type="button" role="tab" id="decided-tab-you" aria-selected={who === "you"} aria-controls="decided-panel-you" tabIndex={who === "you" ? 0 : -1} onKeyDown={move} onClick={() => setWho("you")}>Answered by you {n(youRows.length)}</button></div>
  <div class="decided-filter-bar"><div class="decided-range" role="group" aria-label="Range"><button type="button" aria-pressed={range === "today"} onClick={() => setRange("today")}>Today</button><button type="button" aria-pressed={range === "all"} onClick={() => setRange("all")}>All</button></div><button type="button" class="decided-worth" aria-pressed={worth} title="Filters Decided for you by the operator's own judgement" onClick={() => setWorth(!worth)}><span class="decision-diamond"/>Worth a look<span class="decision-desktop"> only</span><span class="decided-worth-count">{complete ? forRows.filter(d => d.worth.length > 0).length : "-"}</span></button></div>
  <p class="decided-summary" role="status">{range === "today" ? "Today" : "All time"} · {complete ? `${forRows.length} decided for you · ${youRows.length} answered by you` : "counts unavailable"}</p></header>
  <p class="decided-legend">Basis: your words, a standing order, or <span class="decision-diamond"/> the operator&rsquo;s own judgement.</p>
  <div class="decided-main">
   {!complete && <p role="alert" class="overview-error">Decisions unavailable for {Object.entries(data.availability).filter(([,v]) => v === "unavailable").map(([key]) => key).join(" and ")}. Showing available records.</p>}
   <div class="decided-columns decision-desktop" aria-hidden="true"><span>time</span><span>decision</span><span>basis</span><span>evidence</span></div>
   <section class="decided-rows" role="tabpanel" id={panel} aria-labelledby={tab}>{(() => {
    const out: ComponentChildren[] = []; let hidden = 0;
    for (const row of rows) {
     let node;
     if (!collapsed(row)) node = <DecidedRow key={row.id} row={row}/>;
     else {
      const key = day(row); if (summarized.has(key)) continue; summarized.add(key);
      node = <p key={`closes-${key}`} class="decided-closes">{closes.get(key)} mandate closes<button type="button" aria-expanded="false" onClick={() => setShown([...shown,key])}>show</button></p>;
     }
     if (!more && out.length >= FOLD_AT) hidden++; else out.push(node);
    }
    if (hidden) out.push(<button key="more" type="button" class="decided-more" onClick={() => setMore(true)}>{hidden} more {who === "you" ? "answered by you" : `decided for you${range === "today" ? " today" : ""}`}</button>);
    return out;
   })()}{!rows.length && complete && (who === "for" && worth ? <p class="decided-empty">{WORTH_EMPTY}</p> : <p class="decided-empty">Nothing here for this filter.</p>)}</section>
  </div></div>;
}
