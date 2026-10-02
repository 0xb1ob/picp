import type { TranscriptAsk as Ask } from "../../src/viewer/api-types.ts";
import { time } from "../format.ts";

/** An operator ask inline in the Full transcript, as history: open ones point at the pinned card below, settled ones show the answer. */
export function TranscriptAsk({ask}: {ask:Ask}) {
 return <div class={`session-ask session-ask-${ask.state}`}>
  {ask.state === "open" ? <p class="session-ask-pointer">open, answer below</p>
  : <p class="session-ask-settled">{ask.state === "answered" ? `Answered: ${ask.answer ?? ""}${ask.answered_at ? ` · ${time(ask.answered_at)}` : ""}` : `Withdrawn: ${ask.reason ?? ""}`}</p>}
 </div>;
}
