import type { SessionEntry, ThreadDoneResponse, ThreadsResponse, ThreadView } from "../src/viewer/api-types.ts";
import { failure } from "./control.ts";

/** Operator threads (cp-xmw2 S5): views of the one chat, bookkeeping only; docs/contracts.md §Operator threads. */
export const THREADS_URL = "/api/threads";
export const THREAD_DONE_URL = "/api/threads/done";
/** The one selection (a tag): it filters the transcript, drives the chips and the sidebar, and is the composer's thread. */
export const THREAD_KEY = "cp-thread";
export const THREAD_TAG_RULE = "1-32 of a-z 0-9 -, starting with a letter or digit";
export type ThreadsStatus = ThreadsResponse | {error: string};
export interface ThreadsView {
 status: ThreadsStatus | null;
 /** The selected tag; null is All. */
 selected: string | null;
 select(tag: string | null): void;
 done(id: string): void;
 /** The th- id being marked done now. */
 sending: string | null;
 failed: {id: string; reason: string} | null;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function readThreads(fetch: Fetch, signal?: AbortSignal): Promise<ThreadsStatus> {
 try {
  const response = await fetch(THREADS_URL, signal ? {signal} : {});
  return response.ok ? await response.json() as ThreadsResponse : {error: await failure(response)};
 } catch {
  return {error: "Threads unavailable"};
 }
}

export async function sendThreadDone(fetch: Fetch, token: string, id: string): Promise<ThreadDoneResponse | {error: string; status: number}> {
 let response: Response;
 try {
  response = await fetch(THREAD_DONE_URL, {method: "POST", headers: {"content-type": "application/json", "x-cp-control-token": token}, body: JSON.stringify({id})});
 } catch {
  return {error: "Could not reach this home", status: 0};
 }
 if (response.status === 202) return await response.json() as ThreadDoneResponse;
 return {error: await failure(response), status: response.status};
}

/** The server's rule (src/viewer/control-files.ts normalizeThreadTag: trim, ASCII-lowercase, whitespace runs to `-`; null unless a tag), after the client alone strips one leading `#` (the dialog's adornment). The server still refuses `#x`; the client never sends it. */
export function normalizeTag(raw: string): string | null {
 const tag = raw.trim().replace(/^#/, "").replace(/[A-Z]/g, char => char.toLowerCase()).replace(/\s+/g, "-");
 return /^[a-z0-9][a-z0-9-]{0,31}$/.test(tag) ? tag : null;
}

/** The list is usable: served and readable (a missing journal is an empty list). */
export const threadsReady = (status: ThreadsStatus | null | undefined): status is ThreadsResponse =>
 status != null && !("error" in status) && status.availability !== "unavailable";

/** The filter a selection means: null shows all; a th- id; "none" for a tag no thread has yet (no entries). */
export function threadFilter(status: ThreadsStatus | null | undefined, selected: string | null | undefined): string | null {
 if (!selected || !threadsReady(status)) return null;
 return status.threads.find(t => t.tag === selected)?.id ?? "none";
}

/** All (`null`) is every entry. A thread shows its own entries, and a shared entry only inside its own span (first own entry through last). `"none"`, or a thread with no own entries, shows nothing. */
export function visibleEntries(entries: SessionEntry[], filter: string | null): SessionEntry[] {
 if (filter === null) return entries;
 if (filter === "none") return [];
 const first = entries.findIndex(e => e.thread === filter);
 const last = entries.findLastIndex(e => e.thread === filter);
 if (first < 0) return [];
 return entries.slice(first, last + 1).filter(e => e.shared || e.thread === filter);
}

/** The same selection split around its span: entries before the first and after the last own entry (for `Show N earlier / later`). All, `"none"` or a thread with no own entries has no bands. */
export function threadBands(entries: SessionEntry[], filter: string | null): {before: SessionEntry[]; inside: SessionEntry[]; after: SessionEntry[]} {
 const inside = visibleEntries(entries, filter);
 if (filter === null || filter === "none") return {before: [], inside, after: []};
 const first = entries.findIndex(e => e.thread === filter);
 const last = entries.findLastIndex(e => e.thread === filter);
 if (first < 0) return {before: [], inside, after: []};
 return {before: entries.slice(0, first), inside, after: entries.slice(last + 1)};
}

const waitingCount = (view: ThreadView): number => view.waiting ? view.waiting.asks + view.waiting.answers : 0;
/** The chip's waiting badge, e.g. ` · 2`. */
export const threadBadge = (view: ThreadView): string => view.state === "waiting" && waitingCount(view) ? ` · ${waitingCount(view)}` : "";
/** The reasons, spelled out. */
export function threadAria(view: ThreadView): string {
 if (view.state === "waiting" && view.waiting) return `${view.tag}: waiting, ${view.waiting.asks} open ask(s), ${view.waiting.answers} unacknowledged answer(s)`;
 return `${view.tag}: ${view.state}`;
}
/** Why Mark done cannot run on this thread now, or null. */
export function doneRefusal(status: ThreadsResponse, view: ThreadView): string | null {
 if (!status.token) return status.reason ?? "Dashboard control is off";
 if (view.state === "waiting" && view.waiting) return `Answer or acknowledge first: ${view.waiting.asks} open ask(s), ${view.waiting.answers} unacknowledged answer(s)`;
 if (!view.waiting) return "Cannot tell whether it is waiting: asks or answers unreadable";
 return null;
}
