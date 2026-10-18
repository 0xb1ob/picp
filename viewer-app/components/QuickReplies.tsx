import type { AwaitingDetail } from "../../src/viewer/api-types.ts";
import { type ControlView, controlLine, controlReady, deliveryLine } from "../control.ts";
import { restartInFlight } from "../restart-control.ts";

/**
 * Quick replies (chat v2): the verbatim options of one attributable open ask (session-rows.ts replyAsk), each sent as
 * its typed answer through DecisionCard's path. They close only when the journal resolves the ask; a failure re-enables.
 */
export function QuickReplies({ask, control}: {ask: AwaitingDetail; control?: ControlView | undefined}) {
 const ready = controlReady(control?.status);
 const mine = control?.delivery?.ask_id === ask.id ? control.delivery : null;
 const disabled = !ready || control?.delivery?.state === "sending" || control?.starting?.state === "starting" || restartInFlight(control?.restarting) || (mine !== null && mine.state !== "failed");
 return <section class="session-replies" aria-label={`Quick replies to ${ask.id}`}>
  <p class="session-replies-to">Options from <code>{ask.id}</code>: {ask.question}</p>
  <div class="session-replies-chips">{ask.options.map((option, i) => <span key={option.label} class="session-reply-wrap">
   <button type="button" class={ask.recommendation === option.label ? "session-reply session-reply-recommended" : "session-reply"} disabled={disabled} title={option.consequence} aria-describedby={`${ask.id}-reply-${i}`} onClick={() => control?.send({kind: "answer", ask_id: ask.id, label: option.label})}>{option.label}</button>
   <span id={`${ask.id}-reply-${i}`} class="session-replies-why">{ask.recommendation === option.label ? "Recommended. " : ""}{option.consequence}</span>
  </span>)}</div>
  {!ready && <p class="session-replies-state" role="status">{controlLine(control?.status)}</p>}
  {mine && <p role={mine.state === "failed" ? "alert" : "status"} class={mine.state === "failed" ? "session-replies-state session-replies-failed" : "session-replies-state"}>{deliveryLine(mine)}{mine.state === "failed" ? "" : " — the options close when the session records the answer"}</p>}
 </section>;
}
