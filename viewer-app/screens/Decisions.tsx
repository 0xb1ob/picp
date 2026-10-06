import type { DecisionsResponse } from "../../src/viewer/api-types.ts";
import type { AnswersControlView } from "../answers-control.ts";
import type { ControlView } from "../control.ts";
import { AnswersSection } from "./Answers.tsx";
import { elapsed } from "../format.ts";
import { AwaitingScreen } from "./Awaiting.tsx";
import { DecidedScreen } from "./Decided.tsx";
import { DecisionKinds, ParentQuestions, WorthExplanation } from "./DecisionContext.tsx";

/**
 * Audit P4 #24: Awaiting and Decided as one page. Awaiting's one-click cards on top (`#awaiting`), then the parent's
 * questions the operator session is handling, collapsed to one line, then the Decided log (`#decided`).
 */
export function Decisions({data,control,answers}: {data:DecisionsResponse;control?:ControlView | undefined;answers?:AnswersControlView | undefined}) {
 const questions = data.parent_questions, unavailable = data.availability.escalations === "unavailable";
 const oldest = Math.max(0,...questions.map(q => q.age_seconds));
 return <div class="decisions">
  <h1>Decisions</h1>
  <section id="awaiting" tabIndex={-1} aria-label="Awaiting you"><AwaitingScreen data={data} control={control}/></section>
  {data.answers.availability !== "missing" && <section id="answers" tabIndex={-1} aria-label="Answers to acknowledge"><AnswersSection data={data.answers} control={answers}/></section>}
  {(unavailable || questions.length > 0) && <details class={`decisions-handled${oldest >= 600 ? " decisions-handled-overdue" : ""}`}>
   <summary>Being handled &middot; {unavailable ? "-" : questions.length}{questions.length > 0 && <span> (oldest {elapsed(oldest)})</span>}</summary>
   <ParentQuestions items={questions} availability={data.availability.escalations}/>
  </details>}
  <div class="decisions-log"><section id="decided" tabIndex={-1} aria-label="Decision log"><DecidedScreen data={{...data,items:data.decided}}/></section><aside class="decisions-log-aside"><WorthExplanation/>{data.availability.asks !== "unavailable" && data.awaiting_count === 0 && <DecisionKinds/>}</aside></div>
 </div>;
}
