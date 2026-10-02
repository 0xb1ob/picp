import type { Question, SourceAvailability } from "../../src/viewer/api-types.ts";
import { elapsed } from "../format.ts";
import { jobHref } from "../routes.ts";
export function DecisionKinds() {
 return <section class="decision-kinds"><h2>What comes here</h2><ul>{["Irreversible actions","Raising a USD spending cap","Real scope changes","Work on paused projects","Unclear product questions"].map(kind => <li key={kind}>{kind}</li>)}</ul><p>Everything else falls under your standing delegation and shows up in <a href="#decided">Decided</a>.</p></section>;
}
export function ParentQuestions({items,availability}: {items:Question[];availability:SourceAvailability}) {
 // Rendered only inside the Decisions page's collapsed "Being handled" line (audit P4 #24), which carries the count.
 return <section class="decision-parent" aria-label="Parent's open questions"><p class="decision-parent-intro">Being handled by the operator session. Amber only after 10 minutes unanswered.</p>
  {availability === "unavailable" ? <p class="overview-error">Parent questions unavailable</p> : items.map(q => <article key={q.id} class={`decision-parent-item ${q.age_seconds >= 600 ? "decision-overdue" : ""}`}><div class="decision-parent-meta"><span class="overview-question-ring"/><code>{q.id}</code><span>open {elapsed(q.age_seconds)}</span></div><div class="decision-job-links">{q.job_ids.map(id => <a key={id} href={jobHref(id)}><code>{id}</code></a>)}</div><p>{q.question}</p><span class="decision-parent-note">{q.age_seconds >= 600 ? "Unanswered past 10 minutes: the operator session may be down or stuck." : "Being handled by the operator session"}</span></article>)}
 </section>;
}
