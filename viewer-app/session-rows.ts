import type { SessionEntry } from "../src/viewer/api-types.ts";

/** The browser-local calendar day of an ISO time; null when missing or unparseable, so it never opens a day. */
export function dayKey(at: string | null | undefined): string | null {
 const date = at ? new Date(at) : null;
 if (!date || Number.isNaN(date.getTime())) return null;
 return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
/** `Wed, Oct 15` in the browser's zone; the year shows only outside the current one. */
export function dayLabel(at: string, now = new Date()): string {
 const date = new Date(at);
 return new Intl.DateTimeFormat("en-US",{weekday:"short",month:"short",day:"numeric",...(date.getFullYear() === now.getFullYear() ? {} : {year:"numeric"})}).format(date);
}
/** Entry id → day label for each entry opening a new local day after `prev` (the day shown above), in source order. */
export function dayStarts(entries: Pick<SessionEntry,"id"|"at">[], prev: string | null = null): Map<string,string> {
 const out = new Map<string,string>();
 let day = prev;
 for (const e of entries) {
  const key = dayKey(e.at);
  if (key === null || key === day) continue;
  out.set(e.id, dayLabel(e.at));
  day = key;
 }
 return out;
}
/** The local day of the last dated entry: what a list rendered right after these continues from. */
export const lastDay = (entries: SessionEntry[]): string | null => entries.reduce<string | null>((day,e) => dayKey(e.at) ?? day, null);
/** A message, card or lone notice; or a run of steps: contiguous tool calls and the parsed bridge notice just above. */
export type Row = {kind:"entry";entry:SessionEntry} | {kind:"steps";key:string;notice:SessionEntry | null;entries:SessionEntry[]};
/**
 * Rows in source order, never reordered. A run of steps ends at any other entry, a new local day (`days`), another
 * thread, or a gap a filter opened in `order` (source index by id); its key is its first source entry's id.
 */
export function rows(entries: SessionEntry[], days: Map<string,string>, order?: Map<string,number>): Row[] {
 const out: Row[] = [];
 let prev: SessionEntry | undefined;
 for (const e of entries) {
  const tail = out.at(-1);
  const joins = e.kind === "tool" && prev !== undefined && !days.has(e.id) && (prev.thread ?? null) === (e.thread ?? null)
   && (!order || order.get(e.id) === (order.get(prev.id) ?? NaN) + 1);
  if (joins && tail?.kind === "steps") tail.entries.push(e);
  else if (joins && tail?.kind === "entry" && tail.entry.kind === "system" && tail.entry.bridge) out[out.length-1] = {kind:"steps",key:tail.entry.id,notice:tail.entry,entries:[e]};
  else out.push(e.kind === "tool" ? {kind:"steps",key:e.id,notice:null,entries:[e]} : {kind:"entry",entry:e});
  prev = e;
 }
 return out;
}
