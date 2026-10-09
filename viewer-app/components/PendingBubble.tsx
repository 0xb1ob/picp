import { useState } from "preact/hooks";
import type { ControlView, PendingSend, QueueOutcome } from "../control.ts";
import { controlReady } from "../control.ts";
import { restartInFlight } from "../restart-control.ts";
import { time } from "../format.ts";
import { Markdown } from "./Markdown.tsx";

export function PendingBubble({send,position,total,control}: {send:PendingSend;position:number;total:number;control:ControlView}) {
 const [draft,setDraft] = useState<string | null>(null);
 const [busy,setBusy] = useState(false);
 const [note,setNote] = useState<string | null>(null);
 const failed = send.state === "failed";
 const attachments = Object.entries(send.body).flatMap(([field,ids])=>(field === "images" || field === "files") && Array.isArray(ids) ? ids.map(id=>({id:String(id),label:field === "images" ? "Image" : "File"})) : []);
 const state = failed ? "Failed" : send.state === "delivered" ? "Delivered · waiting for transcript" : `Queued · ${position} of ${total}`;
 const detail = send.state === "sending" ? "Sending…" : send.state === "held" ? "Held until an operator session attaches" : null;
 // cp-y43c: only while the dashboard still holds it; once the session takes it, Edit and Cancel send go away.
 const changeable = send.editable === true && send.state === "queued" && !!control.edit && !!control.cancel && controlReady(control.status) && control.status.running;
 const settle = (outcome: QueueOutcome) => { setBusy(false); if ("error" in outcome) setNote(outcome.error); else { setDraft(null); setNote(null); } };
 const save = () => { if (draft === null || busy || (!draft.trim() && !attachments.length)) return; setBusy(true); void control.edit!(send.key,draft).then(settle); };
 const close = () => { setDraft(null); setNote(null); };
 const remove = () => { if (busy) return; setBusy(true); void control.cancel!(send.key).then(settle); };
 return <article class={`session-message session-say session-bubble session-own session-pending${failed ? " session-pending-failed" : ""}${draft === null ? "" : " session-pending-editing"}`}>
  <div class="session-who"><span>You</span>{send.body.thread && <span class="session-project">{send.body.thread}</span>}<time class="session-time" dateTime={send.at}>{time(send.at)}</time></div>
  <div class="session-body">
   <span class="session-pending-badge">{state}</span>
   {draft === null ? <Markdown text={send.body.text}/> : <div class="session-pending-editor">
    <textarea aria-label="Edit queued message" rows={3} value={draft} disabled={busy} autoFocus onInput={event=>setDraft(event.currentTarget.value)} onKeyDown={event=>{
     if (event.key === "Escape") { event.preventDefault(); close(); }
     else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); save(); }
    }}/>
    <div class="session-pending-actions"><button type="button" class="session-pending-save" disabled={busy || (!draft.trim() && !attachments.length)} onClick={save}>Save</button><button type="button" class="session-pending-close" disabled={busy} onClick={close}>Cancel</button></div>
   </div>}
   {attachments.length ? <ul class="session-pending-attachments" aria-label="Attachments">{attachments.map(({id,label})=><li key={id}>{label} · {id}</li>)}</ul> : null}
   {detail && <p class="session-pending-detail">{detail}</p>}
   {send.reason && <p class="session-pending-detail">{failed ? "Failed: " : ""}{send.reason}</p>}
   {note && <p class="session-pending-detail" role="alert">{note}</p>}
   {changeable && draft === null && <div class="session-pending-actions"><button type="button" class="session-pending-edit" disabled={busy} onClick={()=>{setNote(null);setDraft(send.body.text);}}>Edit</button><button type="button" class="session-pending-cancel" disabled={busy} onClick={remove}>Cancel send</button></div>}
   {failed && <div class="session-pending-actions"><button type="button" disabled={!controlReady(control.status) || control.starting?.state === "starting" || restartInFlight(control.restarting)} onClick={()=>control.retry?.(send.key)}>Retry</button><button type="button" onClick={()=>control.discard?.(send.key)}>Discard</button></div>}
  </div>
 </article>;
}
