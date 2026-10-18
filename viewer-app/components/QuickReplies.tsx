import { useEffect, useState } from "preact/hooks";
import type { AwaitingDetail } from "../../src/viewer/api-types.ts";
import { type ControlView, controlLine, controlReady, deliveryLine } from "../control.ts";
import { restartInFlight } from "../restart-control.ts";

/**
 * Quick replies (chat v2): the verbatim options of one attributable open ask (session-rows.ts replyAsk), each sent as
 * its typed answer through DecisionCard's path. They hold while any answer to the ask is clicked here, pending or
 * recorded, until the journal closes it; only a failure re-enables. Key it by ask id.
 */
export function QuickReplies({ask, control}: {ask: AwaitingDetail; control?: ControlView | undefined}) {
 const ready = controlReady(control?.status);
 const mine = control?.delivery?.ask_id === ask.id ? control.delivery : null;
 const failed = mine?.state === "failed";
 // A click holds the chips even after a later send (the composer's, another card's) replaces `delivery`.
 const [clicked,setClicked] = useState(false);
 useEffect(() => { if (failed) setClicked(false); }, [failed]);
 const status = control?.status;
 const recorded = controlReady(status) && status.recent.some(r => r.ask_id === ask.id && r.state !== "failed" && r.state !== "dropped");
 const pending = control?.pending?.some(p => p.ask_id === ask.id && p.state !== "failed") === true;
 const answered = (!failed && (clicked || mine !== null)) || recorded || pending;
 const disabled = !ready || control?.delivery?.state === "sending" || control?.starting?.state === "starting" || restartInFlight(control?.restarting) || answered;
 return <section class="session-replies" aria-label={`Quick replies to ${ask.id}`}>
  <p class="session-replies-to">Options from <code>{ask.id}</code>: {ask.question}</p>
  <div class="session-replies-chips">{ask.options.map((option, i) => <span key={option.label} class="session-reply-wrap">
   <button type="button" class={ask.recommendation === option.label ? "session-reply session-reply-recommended" : "session-reply"} disabled={disabled} title={option.consequence} aria-describedby={`${ask.id}-reply-${i}`} onClick={() => { setClicked(true); control?.send({kind: "answer", ask_id: ask.id, label: option.label}); }}>{option.label}</button>
   <span id={`${ask.id}-reply-${i}`} class="session-replies-why">{ask.recommendation === option.label ? "Recommended. " : ""}{option.consequence}</span>
  </span>)}</div>
  {!ready && <p class="session-replies-state" role="status">{controlLine(control?.status)}</p>}
  {mine ? <p role={mine.state === "failed" ? "alert" : "status"} class={mine.state === "failed" ? "session-replies-state session-replies-failed" : "session-replies-state"}>{deliveryLine(mine)}{mine.state === "failed" ? "" : " — the options close when the session records the answer"}</p>
   : answered && <p role="status" class="session-replies-state">An answer is on its way — the options close when the session records it</p>}
 </section>;
}
