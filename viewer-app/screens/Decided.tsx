import { useState } from "preact/hooks";
import type { DecidedResponse, DecisionDetail } from "../../src/viewer/api-types.ts";
import { observedTime, time } from "../format.ts";
import { jobHref } from "../routes.ts";
export function filterDecisions(items:DecisionDetail[], range:"today" | "all", worth:boolean): DecisionDetail[] {
 return items.filter(item => (range === "all" || item.today) && (!worth || item.worth.length > 0));
}
/** The browser-local calendar day a decision was answered on. */
const day = (row:DecisionDetail) => new Date(row.answered_at).toDateString();
function DecidedRow({row}: {row:DecisionDetail}) {
 // Audit P2 #16: evidence opens the job the decision names; only a jobless one falls back to the parent transcript.
 const evidence = row.job_ids[0] ? jobHref(row.job_ids[0]) : "#sessions?view=parent";
 return <article class="decided-row"><div class="decided-time"><code>{row.today ? time(row.answered_at) : observedTime(row.answered_at)}</code>{row.worth.length > 0 && <span class="decided-flag"><span class="decision-diamond"/>{row.worth.join(", ")}</span>}</div><div class="decided-job">{row.job_ids.map(id => <a key={id} href={jobHref(id)}><code>{id}</code></a>)}<code class="decided-id">{row.id}</code>{row.source === "you" && <span class="decided-source">answered by you</span>}</div><p class="decided-question" title={row.question}>{row.question}</p><div class="decided-answer"><strong>{row.answer}</strong>{row.quote && <span>&ldquo;{row.quote}&rdquo;</span>}</div><p class="decided-rule"><span class="decision-phone">rule &middot; </span>{row.rule ?? (row.source === "you" ? "Your reply" : "Not recorded")}</p><div class="decided-evidence">{row.source_escalation ? <a href={evidence}><span class="decision-phone">evidence</span><span class="decision-desktop">open</span> &rarr;</a> : <span title="Operator transcript is not recorded">not recorded</span>}</div></article>;
}
export function DecidedScreen({data}: {data:DecidedResponse}) {
 const [range,setRange] = useState<"today" | "all">("today");
 const [worth,setWorth] = useState(false);
 const unfiltered = filterDecisions(data.items,range,false);
 // Audit P2 #13: "decided for you" is the Awaiting page's count (operator-delegated); your own answers are counted apart.
 const forYou = unfiltered.filter(d => d.source !== "you").length, byYou = unfiltered.length - forYou;
 const rows = filterDecisions(data.items,range,worth);
 // Audit P1 #6: a day's routine mission-end closes fold into one line until shown; one close alone stays a row.
 const [shown,setShown] = useState<string[]>([]);
 const closes = new Map<string,number>();
 for (const row of rows) if (row.kind === "mission_end") closes.set(day(row),(closes.get(day(row)) ?? 0)+1);
 const collapsed = (row:DecisionDetail) => row.kind === "mission_end" && (closes.get(day(row)) ?? 0) > 1 && !shown.includes(day(row));
 const summarized = new Set<string>();
 const complete = data.availability.asks !== "unavailable" && data.availability.escalations !== "unavailable";
 const first = data.items.at(-1)?.answered_at;
 const period = range === "today" ? "today" : first ? `since ${new Intl.DateTimeFormat("en",{month:"short",day:"numeric"}).format(new Date(first))}` : "";
 return <div class="decided-screen"><header class="decision-heading"><div><h2>Decided for you</h2><p>Answers the operator session gave on your behalf, under your standing delegation. Check its judgement <span class="decision-phone">here.</span><span class="decision-desktop">after the fact.</span></p></div></header>
  <div class="decided-main"><div class="decided-filter-bar"><div class="decided-range" role="group" aria-label="Range"><button type="button" aria-pressed={range === "today"} onClick={() => setRange("today")}>Today</button><button type="button" aria-pressed={range === "all"} onClick={() => setRange("all")}>All</button></div><button type="button" class="decided-worth" aria-pressed={worth} onClick={() => setWorth(!worth)}><span class="decision-diamond"/>Worth a look<span class="decision-desktop"> only</span></button><p>{complete ? forYou : "-"} decided for you {period}{complete && byYou > 0 && <> &middot; {byYou} by you</>} &middot; {complete ? unfiltered.filter(d => d.worth.length > 0).length : "-"} worth a look</p></div>
   {!complete && <p role="alert" class="overview-error">Decisions unavailable for {Object.entries(data.availability).filter(([,v]) => v === "unavailable").map(([key]) => key).join(" and ")}. Showing available records.</p>}
   <div class="decided-columns decision-desktop" aria-hidden="true"><span>time</span><span>job</span><span>question</span><span>answer</span><span>rule</span><span>evidence</span></div>
   <section class="decided-rows" aria-label="Decisions">{rows.map(row => {
    if (!collapsed(row)) return <DecidedRow key={row.id} row={row}/>;
    const key = day(row); if (summarized.has(key)) return null; summarized.add(key);
    return <p key={`closes-${key}`} class="decided-closes">{closes.get(key)} mandate closes<button type="button" aria-expanded="false" onClick={() => setShown([...shown,key])}>show</button></p>;
   })}{!rows.length && complete && <p class="decided-empty">Nothing here for this filter.</p>}</section>
  </div></div>;
}
