import type { DecisionsResponse } from "../../src/viewer/api-types.ts";
import type { ControlView } from "../control.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { elapsed } from "../format.ts";
import { ProjectFilter } from "../components/ProjectFilter.tsx";
import { matchesProject, matchesSelection, pickSelection, type ProjectSelection } from "../project-filter.ts";
import { AwaitingScreen } from "./Awaiting.tsx";
import { DecidedScreen } from "./Decided.tsx";
import { DecisionKinds, ParentQuestions, WorthExplanation } from "./DecisionContext.tsx";

/**
 * Audit P4 #24: Awaiting and Decided as one page. Awaiting's one-click cards on top (`#awaiting`), then the parent's
 * questions the operator session is handling, collapsed to one line, then the Decided log (`#decided`).
 */
export function Decisions({data:all,control,selection=null}: {data:DecisionsResponse;control?:ControlView | undefined;selection?:ProjectSelection}) {
 const names = [...all.items.map(a => a.project),...all.parent_questions.flatMap(q => q.projects ?? []),...all.decided.flatMap(d => d.projects ?? [])];
 const data = selected(all,selection);
 const questions = data.parent_questions, unavailable = data.availability.escalations === "unavailable";
 const oldest = Math.max(0,...questions.map(q => q.age_seconds));
 return <div class="decisions">
  <PageHeader title="Decisions"/>
  <div class="decisions-filter"><ProjectFilter names={names} selection={selection} onChange={pickSelection}/></div>
  <section id="awaiting" tabIndex={-1} aria-label="Awaiting you"><AwaitingScreen data={data} control={control}/></section>
  {(unavailable || questions.length > 0) && <details class={`decisions-handled${oldest >= 600 ? " decisions-handled-overdue" : ""}`}>
   <summary>Being handled &middot; {unavailable ? "-" : questions.length}{questions.length > 0 && <span> (oldest {elapsed(oldest)})</span>}</summary>
   <ParentQuestions items={questions} availability={data.availability.escalations}/>
  </details>}
  <div class="decisions-log"><section id="decided" tabIndex={-1} aria-label="Decision log"><DecidedScreen data={{...data,items:data.decided}}/></section><aside class="decisions-log-aside"><WorthExplanation/>{data.availability.asks !== "unavailable" && data.awaiting_count === 0 && <DecisionKinds/>}</aside></div>
 </div>;
}
/** The page under a selection: each list and the counts it shows narrowed alike; action ids and availability untouched. */
function selected(data: DecisionsResponse, selection: ProjectSelection): DecisionsResponse {
 if (!selection) return data;
 const items = data.items.filter(a => matchesProject(a.project,selection)), decided = data.decided.filter(d => matchesSelection(d.projects,selection));
 const today = (source: string) => decided.filter(d => d.today && d.source === source).length;
 return {...data, items, decided, parent_questions:data.parent_questions.filter(q => matchesSelection(q.projects,selection)),
  awaiting_count:data.awaiting_count === null ? null : items.length,
  decided_today:{...data.decided_today, count:data.decided_today.count === null ? null : today("operator-delegated"), by_you:data.decided_today.by_you == null ? data.decided_today.by_you : today("you")}};
}
