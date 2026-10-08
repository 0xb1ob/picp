import type { SessionEntry } from "../src/viewer/api-types.ts";
import type { ControlStatus, PendingSend } from "./control.ts";

export const PENDING_KEY = "cp-operator-pending-sends";
export interface PendingState { items: PendingSend[]; dismissed: string[] }
export const emptyPending = (): PendingState => ({items:[],dismissed:[]});

export function readPending(): PendingState {
 if (typeof window === "undefined") return emptyPending();
 try {
  const raw = window.localStorage?.getItem(PENDING_KEY);
  if (!raw) return emptyPending();
  const value = JSON.parse(raw) as PendingState;
  if (!Array.isArray(value.items) || !Array.isArray(value.dismissed) || !value.dismissed.every(id=>typeof id === "string")) throw new Error("invalid pending-send record");
  const items = value.items.map(item=>{
   if (!item || typeof item.key !== "string" || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)) || (item.id !== null && typeof item.id !== "string") || item.body?.kind !== "message" || typeof item.body.text !== "string" || (item.body.thread !== undefined && typeof item.body.thread !== "string") || !["sending","queued","held","delivered","failed"].includes(item.state)) throw new Error("invalid pending send");
   for (const [field,ids] of Object.entries(item.body)) if ((field === "images" || field === "files") && (!Array.isArray(ids) || !ids.every(id=>typeof id === "string"))) throw new Error("invalid pending attachments");
   return item.state === "sending" ? {...item,state:"failed" as const,reason:"Send interrupted by reload; check the transcript before retrying"} : item;
  });
  return {items,dismissed:value.dismissed};
 } catch (error) { console.warn(`pending sends unreadable: ${(error as Error).message}`); return emptyPending(); }
}

export function rememberPending(value: PendingState): void {
 try { window.localStorage?.setItem(PENDING_KEY,JSON.stringify(value)); }
 catch (error) { console.warn(`pending sends not persisted: ${(error as Error).message}`); }
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
 return {items,dismissed};
}
