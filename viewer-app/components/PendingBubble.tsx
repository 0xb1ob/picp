import type { ControlView, PendingSend } from "../control.ts";
import { controlReady } from "../control.ts";
import { restartInFlight } from "../restart-control.ts";
import { time } from "../format.ts";
import { Markdown } from "./Markdown.tsx";

export function PendingBubble({send,position,total,control}: {send:PendingSend;position:number;total:number;control:ControlView}) {
 const failed = send.state === "failed";
 const attachments = Object.entries(send.body).flatMap(([field,ids])=>(field === "images" || field === "files") && Array.isArray(ids) ? ids.map(id=>({id:String(id),label:field === "images" ? "Image" : "File"})) : []);
 const state = failed ? "Failed" : send.state === "delivered" ? "Delivered · waiting for transcript" : `Queued · ${position} of ${total}`;
 const detail = send.state === "sending" ? "Sending…" : send.state === "held" ? "Held until an operator session attaches" : null;
 return <article class={`session-message session-say session-bubble session-own session-pending${failed ? " session-pending-failed" : ""}`}>
  <div class="session-who"><span>You</span>{send.body.thread && <span class="session-project">{send.body.thread}</span>}<time class="session-time" dateTime={send.at}>{time(send.at)}</time></div>
  <div class="session-body">
   <span class="session-pending-badge">{state}</span>
   <Markdown text={send.body.text}/>
   {attachments.length ? <ul class="session-pending-attachments" aria-label="Attachments">{attachments.map(({id,label})=><li key={id}>{label} · {id}</li>)}</ul> : null}
   {detail && <p class="session-pending-detail">{detail}</p>}
   {send.reason && <p class="session-pending-detail">{failed ? "Failed: " : ""}{send.reason}</p>}
   {failed && <div class="session-pending-actions"><button type="button" disabled={!controlReady(control.status) || control.starting?.state === "starting" || restartInFlight(control.restarting)} onClick={()=>control.retry?.(send.key)}>Retry</button><button type="button" onClick={()=>control.discard?.(send.key)}>Discard</button></div>}
  </div>
 </article>;
}
