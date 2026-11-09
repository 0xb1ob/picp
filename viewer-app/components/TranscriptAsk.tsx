import type { TranscriptAsk as Ask } from "../../src/viewer/api-types.ts";
import { time } from "../format.ts";

/** An inline operator ask, as history: an open one points at the Context card, a settled one shows its answer. */
export function TranscriptAsk({ask}: {ask:Ask}) {
 return <div class={`session-ask session-ask-${ask.state}`}>
  {ask.state === "open" ? <p class="session-ask-pointer">open, answer in Context</p>
  : <p class="session-ask-settled">{ask.state === "answered" ? `Answered: ${ask.answer ?? ""}${ask.answered_at ? ` · ${time(ask.answered_at)}` : ""}` : `Withdrawn: ${ask.reason ?? ""}`}</p>}
 </div>;
}
