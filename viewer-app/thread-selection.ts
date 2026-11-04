/**
 * Full match S11: the chat's thread selection in its hash (`thread=th-…` one named thread, `thread=none` No thread,
 * absent All messages), independent of the project filter. Tabs and unread cursors are browser-local, never synced.
 */
import type { SessionEntry, ThreadsResponse } from "../src/viewer/api-types.ts";
import { isOwn } from "./session-rows.ts";

export type ThreadSelection = {thread: string} | {none: true} | null;
const THREAD_ID = /^th-[0-9a-f]{16}$/;

export function readThread(query: string | undefined): ThreadSelection {
 const value = new URLSearchParams(query ?? "").get("thread");
 return value === "none" ? {none: true} : value && THREAD_ID.test(value) ? {thread: value} : null;
}
/** The hash value of a selection: "" is All messages. */
export const threadValue = (s: ThreadSelection): string => !s ? "" : "none" in s ? "none" : s.thread;
/** `hash` with only `thread` replaced; the project filter, session file and every other parameter are kept. */
export function threadHash(hash: string, value: string): string {
 const [path = "", query = ""] = hash.replace(/^#/,"").split("?");
 const q = new URLSearchParams(query);
 if (value) q.set("thread", value); else q.delete("thread");
 const rest = q.toString();
 return `#${path}${rest ? `?${rest}` : ""}`;
}
/** What a send carries: the selected named thread, else an explicit null (No thread and All messages alike). */
export const sendThreadId = (s: ThreadSelection): string | null => s && "thread" in s ? s.thread : null;
/** Recorded membership only: All keeps everything, No thread keeps what no thread claims. */
export const inThread = (id: string | null | undefined, s: ThreadSelection): boolean => !s || ("none" in s ? !id : id === s.thread);

/** Ask and job ids to their thread, from `/api/threads` joins; a record past a join's cap stays unknown (untagged). */
export function members(view: ThreadsResponse | null): {asks: Map<string, string>; jobs: Map<string, string>} {
 const asks = new Map<string, string>(), jobs = new Map<string, string>();
 for (const join of view?.joins ?? []) {
  for (const ask of join.asks) asks.set(ask.id, join.thread_id);
  for (const job of join.jobs) jobs.set(job.id, join.thread_id);
 }
 return {asks, jobs};
}

function stored(key: string): string | null {
 try { return window.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function store(key: string, value: string) {
 try { window.localStorage?.setItem(key, value); } catch (error) { console.warn(`${key} not persisted: ${(error as Error).message}`); }
}
const TABS_KEY = "cp-thread-tabs";
/** The open tabs as selection values ("" All, "none", thread ids), in the order they were opened. */
export function readTabs(): string[] {
 try {
  const value: unknown = JSON.parse(stored(TABS_KEY) ?? "[]");
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && (v === "" || v === "none" || THREAD_ID.test(v))) : [];
 } catch { return []; }
}
export const rememberTabs = (tabs: string[]) => store(TABS_KEY, JSON.stringify(tabs));

const SEEN_KEY = "cp-thread-seen:";
export const readSeen = (id: string): string => stored(`${SEEN_KEY}${id}`) ?? "";
export const rememberSeen = (id: string, at: string) => store(`${SEEN_KEY}${id}`, at);
/** Loaded replies and ask cards in `id` newer than this browser's last look; tool rows and own messages never count. */
export const unread = (entries: SessionEntry[], id: string, seen: string): number =>
 entries.filter(e => e.thread_id === id && e.at > seen && (e.kind === "ask" || (e.kind === "say" && !isOwn(e)))).length;
