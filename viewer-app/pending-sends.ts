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
    if (!item || typeof item.key !== "string" || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)) || (item.id !== null && typeof item.id !== "string") || (item.reason !== null && typeof item.reason !== "string") || (item.ask_id !== undefined && item.ask_id !== null && typeof item.ask_id !== "string") || item.body?.kind !== "message" || typeof item.body.text !== "string" || (item.body.thread !== undefined && typeof item.body.thread !== "string") || (item.body.deliver !== undefined && !["prompt","followUp","steer"].includes(item.body.deliver)) || !["sending","queued","held","delivered","failed"].includes(item.state)) throw new Error("invalid pending send");
    for (const [field,ids] of Object.entries(item.body)) if ((field === "images" || field === "files") && (!Array.isArray(ids) || !ids.every(id=>typeof id === "string"))) throw new Error("invalid pending attachments");
    return [{...item,ask_id:item.ask_id ?? null,...(item.state === "sending" ? {state:"failed" as const,reason:"Send interrupted by reload; check the transcript before retrying"} : {})}];
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

export function reconcilePending(value: PendingState, status: ControlStatus | null, entries: SessionEntry[]): PendingState {
 const removed = value.items.filter(item=>transcriptHasSend(entries,item.id));
 const dismissed = [...new Set([...value.dismissed,...removed.flatMap(item=>item.id ? [item.id] : [])])];
 const items = value.items.filter(item=>!removed.includes(item)).map(item=>({...item}));
 if (status && !("error" in status)) {
  for (const send of status.sends ?? []) {
   if (dismissed.includes(send.id) || transcriptHasSend(entries,send.id)) continue;
   const index = items.findIndex(item=>item.id === send.id);
   // Delivered journal history is not a new pending send. Known sends stay visible through the read/stream race.
   if (index < 0) { if (send.state !== "delivered" && !items.some(item=>item.state === "sending")) items.push({...send,key:send.id}); }
   else items[index] = {...items[index]!,state:send.state,reason:send.reason ?? items[index]!.reason};
  }
  for (const item of items) {
   const recent = status.recent.find(row=>row.id === item.id);
   if (recent?.state === "failed" || recent?.state === "refused") { item.state = "failed"; item.reason = recent.reason ?? "Delivery failed"; }
   else if (recent?.state === "delivered") item.state = "delivered";
  }
 }
 items.sort((a,b)=>a.at.localeCompare(b.at));
 return {...value,items,dismissed};
}
