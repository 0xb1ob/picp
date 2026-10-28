import type { SessionEntry } from "../src/viewer/api-types.ts";
import type { ControlStatus, PendingSend } from "./control.ts";

export const PENDING_KEY = "cp-operator-pending-sends";
export interface PendingState { items: PendingSend[]; dismissed: string[]; error?: string }
export const emptyPending = (): PendingState => ({items:[],dismissed:[]});

export function readPending(): PendingState {
 if (typeof window === "undefined") return emptyPending();
 try {
  const storage = window.localStorage;
  if (!storage) throw new Error("browser storage is unavailable");
  const raw = storage.getItem(PENDING_KEY);
  if (!raw) return emptyPending();
  const value = JSON.parse(raw) as PendingState;
  if (!value || !Array.isArray(value.items)) throw new Error("invalid pending-send list");
  let skipped = 0;
  const items = value.items.flatMap(item=>{
   try {
    if (!item || typeof item.key !== "string" || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)) || (item.id !== null && typeof item.id !== "string") || (item.reason !== null && typeof item.reason !== "string") || (item.ask_id !== undefined && item.ask_id !== null && typeof item.ask_id !== "string") || (item.target_session !== undefined && typeof item.target_session !== "string") || item.body?.kind !== "message" || typeof item.body.text !== "string" || (item.body.deliver !== undefined && !["prompt","followUp","steer"].includes(item.body.deliver)) || !["sending","queued","held","delivered","failed"].includes(item.state)) throw new Error("invalid pending send");
    for (const [field,ids] of Object.entries(item.body)) if ((field === "images" || field === "files") && (!Array.isArray(ids) || !ids.every(id=>typeof id === "string"))) throw new Error("invalid pending attachments");
    const {thread:_retired,...body} = item.body as PendingSend["body"] & {thread?: unknown}; // #588: a stored retired tag is dropped
    return [{...item,body,ask_id:item.ask_id ?? null,...(item.state === "sending" ? {state:"failed" as const,reason:"Send interrupted by reload; check the transcript before retrying"} : {})}];
   } catch { skipped++; return []; }
  });
  const dismissed = Array.isArray(value.dismissed) ? value.dismissed.filter(id=>typeof id === "string") : [];
  skipped += Array.isArray(value.dismissed) ? value.dismissed.length-dismissed.length : 1;
  return {items,dismissed,...(skipped ? {error:`Queued-message recovery incomplete: ${skipped} invalid stored entries skipped; valid sends retained. Check the transcript before retrying.`} : {})};
 } catch (error) { return {...emptyPending(),error:`Queued messages could not be recovered from browser storage: ${error instanceof Error ? error.message : "unavailable"}. Check the transcript before retrying.`}; }
}

export function rememberPending(value: PendingState): PendingState {
 try {
  const storage = window.localStorage;
  if (!storage) throw new Error("browser storage is unavailable");
  storage.setItem(PENDING_KEY,JSON.stringify({items:value.items,dismissed:value.dismissed}));
  return value;
 } catch (error) {
  const message = `Queued messages not persisted: ${error instanceof Error ? error.message : "browser storage unavailable"}. Kept in this view only; check the transcript after reload.`;
  return {...value,error:value.error?.includes(message) ? value.error : [value.error,message].filter(Boolean).join(" ")};
 }
}

/** A delivered status is not a transcript entry. Held sends appear inside the CLI's aggregate inbox replay. */
export function transcriptHasSend(entries: SessionEntry[], id: string | null): boolean {
 return !!id && entries.some(e=>e.dashboard_id === id || (e.who === "Operator" && e.text.startsWith("[cp-dashboard inbox — ") && e.text.includes(`(${id}):`)));
}

/** How long a delivered send may wait for its transcript entry before status alone retires it (picp-cc0). */
export const DELIVERED_GRACE_MS = 60_000;

export function reconcilePending(value: PendingState, status: ControlStatus | null, entries: SessionEntry[], truncated = false): PendingState {
 const removed = value.items.filter(item=>transcriptHasSend(entries,item.id));
 const dismissed = [...new Set([...value.dismissed,...removed.flatMap(item=>item.id ? [item.id] : [])])];
 let items = value.items.filter(item=>!removed.includes(item)).map(item=>({...item}));
 const live = status && !("error" in status) ? status : null;
 if (live) {
  for (const send of live.sends ?? []) {
   if (dismissed.includes(send.id) || transcriptHasSend(entries,send.id)) continue;
   const index = items.findIndex(item=>item.id === send.id);
   if (send.state === "dropped") { if (index >= 0) items.splice(index,1); dismissed.push(send.id); continue; }
   // Delivered journal history is not a new pending send. Known sends stay visible through the read/stream race.
   if (index < 0) { if (send.state !== "delivered" && !items.some(item=>item.state === "sending")) items.push({...send,state:send.state,key:send.id}); }
   else {
    // cp-y43c: the journal's text wins once it shows the saved edit; until then a status read before the save cannot revert it.
    const {edited,editable:_was,...local} = items[index]!;
    const confirmed = edited === undefined || edited === send.body.text;
    items[index] = {...local,state:send.state,reason:send.reason ?? local.reason,...(send.editable === true && !local.sent ? {editable:true} : {}),...(send.target_session ? {target_session:send.target_session} : {}),body:confirmed ? {...local.body,text:send.body.text} : local.body,...(confirmed ? {} : {edited})};
   }
  }
  for (const item of items) {
   const recent = live.recent.find(row=>row.id === item.id);
   if (recent?.state === "failed" || recent?.state === "refused") { item.state = "failed"; item.reason = recent.reason ?? "Delivery failed"; }
   else if (recent?.state === "delivered") item.state = "delivered";
  }
 }
 // picp-cc0: the transcript is a window; a delivered send it can no longer show must not wait for it forever.
 const times = truncated ? entries.map(e=>Date.parse(e.at)).filter(Number.isFinite) : [];
 const oldest = times.length ? Math.min(...times) : NaN;
 const now = live ? Date.parse(live.generated_at) : NaN; // server clock, the same one that stamped the delivery
 const settled = (item: PendingSend) => {
  if (item.state !== "delivered") return false;
  if (Date.parse(item.at) < oldest) return true;
  // The grace runs from delivery (the recent row's time), never from the send time a journal row carries.
  const row = live?.recent.find(row=>row.id === item.id && row.state === "delivered");
  return !!row && now - Date.parse(row.at) > DELIVERED_GRACE_MS;
 };
 const stale = items.filter(settled);
 if (stale.length) { items = items.filter(item=>!stale.includes(item)); dismissed.push(...stale.flatMap(item=>item.id ? [item.id] : [])); }
 items.sort((a,b)=>a.at.localeCompare(b.at));
 return {...value,items,dismissed};
}
