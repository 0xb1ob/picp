import { useEffect, useRef, useState } from "preact/hooks";
import type { AwaitingDetail } from "../../src/viewer/api-types.ts";
import { type ControlView, controlLine, controlReady, deliveryLine } from "../control.ts";
import { restartInFlight } from "../restart-control.ts";

/** The asks a click or a typed reply answered, kept per chat so the context card sends one answer request at a time. */
export interface Answering { asks: string[]; answer(ask: AwaitingDetail, label: string): void; reply(ask: AwaitingDetail, text: string): void }
const failedFor = (id: string, control?: ControlView) => control?.delivery?.ask_id === id ? control.delivery.state === "failed"
 : control?.pending?.some(p => p.ask_id === id && p.state === "failed") === true;
/** Only a failure re-enables an answer; the ref refuses a second click that lands before the first one re-renders. */
export function useAnswering(control?: ControlView): Answering {
 const [asks, setAsks] = useState<string[]>([]);
 const inflight = useRef(new Set<string>());
 const failed = asks.filter(id => failedFor(id, control)), key = failed.join();
 useEffect(() => {
  if (!failed.length) return;
  for (const id of failed) inflight.current.delete(id);
  setAsks(list => list.filter(id => !failed.includes(id)));
 }, [key]);
 const hold = (id: string, send: () => void) => {
  if (inflight.current.has(id)) return;
  inflight.current.add(id); setAsks(list => [...list, id]); send();
 };
 // A reply is the Awaiting card's "Other answer" message: `<ask-id>: <text>`, tied to its card by `send`'s ask_id.
 return {asks, answer: (a, label) => hold(a.id, () => control?.send({kind: "answer", ask_id: a.id, label})),
  reply: (a, text) => hold(a.id, () => control?.send({kind: "message", text: `${a.id}: ${text.trim()}`}, a.id))};
}
/**
 * One ask's answer state: held while any answer to it is clicked, pending or recorded,
 * until the journal closes it; only a failure re-enables. A later send can replace `delivery`; `pending` then decides.
 */
export function answerView(ask: AwaitingDetail, control: ControlView | undefined, answering: Answering) {
 const ready = controlReady(control?.status);
 const mine = control?.delivery?.ask_id === ask.id ? control.delivery : null;
 const failed = failedFor(ask.id, control);
 const status = control?.status;
 const recorded = controlReady(status) && status.recent.some(r => r.ask_id === ask.id && r.state !== "failed" && r.state !== "dropped");
 const pending = control?.pending?.some(p => p.ask_id === ask.id && p.state !== "failed") === true;
 const answered = (!failed && (answering.asks.includes(ask.id) || mine !== null)) || recorded || pending;
 const disabled = !ready || control?.delivery?.state === "sending" || control?.starting?.state === "starting" || restartInFlight(control?.restarting) || answered;
 return {ready, mine, answered, disabled};
}
/** The state line under the context card's options. */
export function AnswerLine({ask, control, answering}: {ask: AwaitingDetail; control: ControlView | undefined; answering: Answering}) {
 const {ready, mine, answered} = answerView(ask, control, answering);
 return <>
  {!ready && <p class="session-replies-state" role="status">{controlLine(control?.status)}</p>}
  {mine ? <p role={mine.state === "failed" ? "alert" : "status"} class={mine.state === "failed" ? "session-replies-state session-replies-failed" : "session-replies-state"}>{deliveryLine(mine)}{mine.state === "failed" ? "" : " — the options close when the session records the answer"}</p>
   : answered && <p role="status" class="session-replies-state">An answer is on its way — the options close when the session records it</p>}
 </>;
}
