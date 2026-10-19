import type { AwaitingDetail, PrChip, SessionEntry } from "../src/viewer/api-types.ts";
import { linkify } from "../src/viewer/linkify.ts";

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
/**
 * A message, card or lone notice; a run of steps: contiguous tool calls and the parsed bridge notice just above; or a
 * rollup: consecutive relay turns about one subject (`pr:<url>` or `job:<id>`), each turn its own rows.
 */
export type Row = {kind:"entry";entry:SessionEntry} | {kind:"steps";key:string;notice:SessionEntry | null;entries:SessionEntry[]}
 | {kind:"rollup";key:string;subject:string;turns:Row[][]};
/** The prompting side of a transcript (sessions-view.ts SIDES: the user turns); everything the session says is not. */
const OWN = new Set(["Operator","Operator → parent","Parent"]);
export const isOwn = (e: SessionEntry) => e.kind === "via" || OWN.has(e.who);
/** A row's entries in source order. */
const entriesOf = (row: Row): SessionEntry[] => row.kind === "entry" ? [row.entry] : row.kind === "steps" ? [...(row.notice ? [row.notice] : []), ...row.entries] : row.turns.flat().flatMap(entriesOf);
/** The entry a row opens with: where its day pill goes. */
export const rowHead = (row: Row): SessionEntry => entriesOf(row)[0]!;
/**
 * Rows in source order, never reordered. A run of steps ends at any other entry, a new local day (`days`), another
 * thread, or a gap a filter opened in `order` (source index by id); its key is its first source entry's id.
 */
export function rows(entries: SessionEntry[], days: Map<string,string>, order?: Map<string,number>): Exclude<Row,{kind:"rollup"}>[] {
 const out: Exclude<Row,{kind:"rollup"}>[] = [];
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
const clean = (url: string) => url.trim().replace(/\/+$/, "");
/** One wake and its relay: a bridge notice (or steps opened by one), then the session's own replies adjacent in source. */
type Turn = {rows: Row[]; entries: SessionEntry[]; subject: string | null};
const isHead = (row: Row) => row.kind === "steps" ? !!row.notice?.bridge : row.kind === "entry" && row.entry.kind === "system" && !!row.entry.bridge;
const follows = (a: SessionEntry, b: SessionEntry, order: Map<string,number>) => order.get(b.id) === (order.get(a.id) ?? NaN) + 1;
/**
 * The turn's subject: the one PR chip its relays name, else its job's one PR chip, else `job:<id>`. None for a turn
 * holding `keep`, a day start past its head, or two threads: such a turn is never folded.
 */
function subjectOf(rows: Row[], entries: SessionEntry[], days: Map<string,string>, chips: Record<string,PrChip>, keep?: string): string | null {
 if (entries.some((e,i) => e.id === keep || (i > 0 && days.has(e.id)) || (e.thread ?? null) !== (entries[0]!.thread ?? null))) return null;
 const named = new Set(rows.flatMap(row => row.kind === "entry" && row.entry.kind === "say"
  ? [...linkify(row.entry.text, row.entry.links).flatMap(s => s.href ? [s.href] : []), ...Object.values(row.entry.links ?? {})].map(clean) : []).filter(url => chips[url]?.kind === "pr"));
 if (named.size === 1) return `pr:${[...named][0]}`;
 const job = rowHead(rows[0]!).bridge?.job ?? null, own = Object.values(chips).filter(c => c.kind === "pr" && job !== null && c.job_id === job);
 return own.length === 1 ? `pr:${clean(own[0]!.url)}` : job ? `job:${job}` : null;
}
/**
 * Fold ≥2 consecutive turns with one subject into a rollup row, on one thread, adjacent in `order`, with no day start
 * after its first row and never past `keep` (the quick-reply anchor). Every other row passes through in order.
 */
export function rollups(list: Row[], days: Map<string,string>, order: Map<string,number>, chips: Record<string,PrChip>, keep?: string): Row[] {
 const out: Row[] = [];
 let run: Turn[] = [];
 const flush = () => { out.push(...(run.length > 1 ? [{kind:"rollup",key:`rollup-${run[0]!.entries[0]!.id}`,subject:run[0]!.subject!,turns:run.map(t => t.rows)} as Row] : run.flatMap(t => t.rows))); run = []; };
 for (let i = 0; i < list.length;) {
  if (!isHead(list[i]!)) { flush(); out.push(list[i++]!); continue; }
  const rows = [list[i++]!];
  for (let next = list[i]; next?.kind === "entry" && next.entry.kind === "say" && !isOwn(next.entry) && follows(entriesOf(rows.at(-1)!).at(-1)!, next.entry, order); next = list[++i]) rows.push(next);
  const entries = rows.flatMap(entriesOf), turn = {rows, entries, subject: subjectOf(rows, entries, days, chips, keep)};
  const last = run.at(-1)?.entries.at(-1);
  if (!(last && turn.subject === run[0]!.subject && (entries[0]!.thread ?? null) === (last.thread ?? null) && !days.has(entries[0]!.id) && follows(last, entries[0]!, order))) flush();
  if (turn.subject) run.push(turn); else out.push(...rows);
 }
 flush();
 return out;
}
/**
 * The one open ask quick replies may answer: still open, carded in this transcript (filed under the selected thread
 * when `filter` names one), and the only such ask. None otherwise: chips are never guessed.
 */
export function replyAsk(entries: SessionEntry[], open: AwaitingDetail[], filter: string | null): AwaitingDetail | null {
 if (filter === "none") return null;
 const carded = new Set(entries.flatMap(e => e.kind === "ask" && e.ask?.state === "open" && (filter === null || e.thread === filter) ? [e.ask.id] : []));
 const eligible = open.filter(ask => carded.has(ask.id));
 return eligible.length === 1 ? eligible[0]! : null;
}
