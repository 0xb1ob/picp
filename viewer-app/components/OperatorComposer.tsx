import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { CONTROL_TEXT_MAX, type ControlView, controlLine, controlReady, deliveryLine } from "../control.ts";
import { Icon } from "./icons.tsx";
import { StartSession } from "./StartSession.tsx";
import { RestartSession } from "./RestartSession.tsx";
import { restartInFlight } from "../restart-control.ts";

/** The composer's placeholder: short enough for the one-row box at 390px, even with the busy ⋯ button. */
export const COMPOSER_PLACEHOLDER = "Message (Enter to send)";
/**
 * The Full transcript's composer: text delivered into the running operator session as a user message.
 * One row (mobile-chat-layout): an auto-growing textarea, a round send button doing what Enter does,
 * and, only while busy, a ⋯ menu with "Steer now" and a confirm-tap "Abort turn".
 */
export function OperatorComposer({control, draft}: {control:ControlView; draft?:string}) {
 const [text,setText] = useState((draft ?? "").slice(0, CONTROL_TEXT_MAX));
 const [confirmAbort,setConfirmAbort] = useState(false);
 const field = useRef<HTMLTextAreaElement>(null);
 const menu = useRef<HTMLDetailsElement>(null);
 const status = control.status;
 const ready = controlReady(status);
 // Held while offline; disabled while a started session comes up or a restart runs, so nothing races its first live token.
 const sending = control.delivery?.state === "sending" || control.starting?.state === "starting" || restartInFlight(control.restarting);
 const busy = ready && status.running && status.busy === true;
 // Grow with the text; CSS max-height (about five lines) makes it scroll inside past that.
 useLayoutEffect(() => {
  const el = field.current;
  if (!el) return;
  el.style.height = "auto";
  // Empty measures the placeholder, which may wrap: an empty field stays one row.
  if (el.value && el.scrollHeight) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
 },[text,ready]);
 const closeMenu = () => { if (menu.current) menu.current.open = false; setConfirmAbort(false); };
 const send = (deliver?: "followUp" | "steer") => {
  const body = text.trim();
  if (!ready || sending || !body) return;
  control.send(deliver ? {kind:"message",text:body,deliver} : {kind:"message",text:body});
  setText("");
 };
 const abort = () => {
  if (!confirmAbort) { setConfirmAbort(true); return; }
  control.send({kind:"abort"});
  closeMenu();
 };
 const line = deliveryLine(control.delivery);
 const sendLabel = busy ? "Send after this turn" : "Send";
 return <section class="operator-composer" aria-label="Message the operator session">
  <p class={ready && status.running ? "operator-composer-state operator-composer-state-ready" : "operator-composer-state"}>{controlLine(status)}{ready && status.running && status.session_file && <span> · delivers to the running session <code>{status.session_file}</code></span>}</p>
  <StartSession control={control}/>
  <RestartSession control={control}/>
  {ready && <div class="operator-composer-row">
   <textarea ref={field} aria-label="Message to the operator session" maxLength={CONTROL_TEXT_MAX} rows={1} value={text} disabled={sending}
    placeholder={COMPOSER_PLACEHOLDER} title="Enter sends · Shift+Enter for a new line"
    onInput={e => setText(e.currentTarget.value)} onKeyDown={e => { if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return; e.preventDefault(); send(busy ? "followUp" : undefined); }}/>
   {busy && <details class="operator-composer-more" ref={menu} onToggle={() => setConfirmAbort(false)}>
    <summary aria-label="Steer or abort" title="Steer or abort"><Icon name="more"/></summary>
    <div class="operator-composer-menu">
     <button type="button" disabled={sending || !text.trim()} onClick={() => { send("steer"); closeMenu(); }}>Steer now</button>
     <button type="button" class="operator-composer-abort" disabled={sending} onClick={abort}>{confirmAbort ? "Tap again to abort" : "Abort turn"}</button>
    </div>
   </details>}
   <button type="button" class="operator-composer-send" aria-label={sendLabel} title={sendLabel} disabled={sending || !text.trim()} onClick={() => send(busy ? "followUp" : undefined)}><Icon name="send"/></button>
  </div>}
  {line && <p role={control.delivery?.state === "failed" ? "alert" : "status"} class={control.delivery?.state === "failed" ? "operator-composer-delivery operator-composer-failed" : "operator-composer-delivery"}>{line}</p>}
 </section>;
}
