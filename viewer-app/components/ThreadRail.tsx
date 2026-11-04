import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { NamedThread, SessionEntry, StartedFromChat, ThreadsResponse } from "../../src/viewer/api-types.ts";
import { type ControlView, createThread, newClientId } from "../control.ts";
import { jobHref } from "../routes.ts";
import { members, readSeen, readTabs, rememberSeen, rememberTabs, threadHash, type ThreadSelection, threadValue, unread } from "../thread-selection.ts";
import { useScreenData } from "../use-screen-data.ts";
import type { ThreadPicker } from "./ComposerMenu.tsx";

/** Rows the rail's Started from chat shows before its "N more". */
const STARTED_SHOWN = 8;
const newKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing && e.key?.toLowerCase() === "n";

/** New thread's inline form: one name, one owner request; a retry of an unknown outcome reuses its client_id. */
function CreateForm({control, onDone, onCancel}: {control: ControlView | undefined; onDone: (thread: NamedThread) => void; onCancel: () => void}) {
 const [name, setName] = useState(""), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
 const id = useRef(newClientId()), field = useRef<HTMLInputElement>(null);
 useEffect(() => { field.current?.focus(); }, []);
 const status = control?.status;
 const submit = (e: Event) => {
  e.preventDefault();
  if (busy || !name.trim() || !status || "error" in status || !status.token) return;
  setBusy(true); setError(null);
  void createThread((u, i) => fetch(u, i), status.token, name, id.current).then(reply => {
   setBusy(false);
   if ("error" in reply) setError(reply.error);
   else onDone({id: reply.thread_id, name: reply.name, created_at: new Date().toISOString(), renamed_at: null});
  });
 };
 return <form class="thread-create" onSubmit={submit} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
  <input ref={field} aria-label="Thread name" placeholder="Thread name" maxLength={80} value={name} disabled={busy}
   onInput={e => { setName(e.currentTarget.value); id.current = newClientId(); }}/>
  <button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</button>
  <button type="button" onClick={onCancel}>Cancel</button>
  {error && <p role="alert">{error}</p>}
 </form>;
}

export interface ThreadUi {
 /** `/api/threads` joins: ask and job ids to their thread. */
 members: ReturnType<typeof members>;
 /** The selection's display name; `unknown` when the registry lacks the selected id. */
 label: string; unknown: boolean;
 /** Why New thread cannot run here, in plain words; null when it can. */
 gate: string | null;
 /** The composer's `#` picker; null hides it (no named thread, an unreadable registry, an owner before threads). */
 picker: ThreadPicker | null;
 rail: (operatorHref: string) => ComponentChild; tabs: ComponentChild;
}

/**
 * Full match S11: the chat's named threads, read from `GET /api/threads` (never written here); New thread goes through
 * the operator session (`createThread`). `active` is the operator Full transcript, the one place a selection applies.
 */
export function useThreads({active, selection, entries, control}: {active: boolean; selection: ThreadSelection; entries: SessionEntry[]; control: ControlView | undefined}): ThreadUi {
 const resource = useScreenData<ThreadsResponse>(active ? "/api/threads" : null, "/api/stream?view=sessions");
 const view = resource.data;
 // A created thread shows at once; the registry read lists it within one refresh.
 const [made, setMade] = useState<NamedThread[]>([]);
 const [creating, setCreating] = useState(false);
 const [tabs, setTabs] = useState(readTabs);
 const [, setSeenTick] = useState(0);
 const opener = useRef<HTMLElement | null>(null);
 const listed = view?.available ? view.threads : [];
 const threads = [...listed, ...made.filter(m => !listed.some(t => t.id === m.id))];
 const names = new Map(threads.map(t => [t.id, t.name]));
 const value = threadValue(selection);
 const unknown = !!selection && "thread" in selection && !!view?.available && !names.has(selection.thread);
 const label = (v: string) => v === "" ? "All messages" : v === "none" ? "No thread" : names.get(v) ?? "Thread unavailable";
 const status = control?.status, running = status && !("error" in status) ? status : null, live = !!running?.running && !!running.token;
 const oldOwner = live && running?.threads !== true;
 const gate = !active ? "Named threads live in the operator chat" : resource.error ? `Named threads unavailable: ${resource.error}`
  : !view ? "Loading threads" : !view.available ? `Thread registry unavailable: ${view.reason}`
  : !live ? "New threads need a running operator session" : oldOwner ? "This operator session predates named threads; restart it (⋮ → Restart session) to create one" : null;
 const go = (v: string) => { window.location.hash = threadHash(location.hash, v); };
 const open = (el: HTMLElement | null) => { if (gate) return; opener.current = el; setCreating(true); };
 const shut = () => { setCreating(false); const el = opener.current; opener.current = null; if (el?.isConnected) el.focus(); };
 // All messages is always the first tab; only a visited thread or No thread is remembered.
 useEffect(() => {
  if (!active || !value || tabs.includes(value)) return;
  const next = [...tabs, value];
  setTabs(next); rememberTabs(next);
 }, [active, value]);
 // Seen: the newest loaded entry of the open thread, so its unread mark clears while it is shown.
 const newest = selection && "thread" in selection ? entries.findLast(e => e.thread_id === selection.thread)?.at ?? "" : "";
 useEffect(() => {
  if (!active || !selection || !("thread" in selection) || !newest || readSeen(selection.thread) >= newest) return;
  rememberSeen(selection.thread, newest); setSeenTick(n => n + 1);
 }, [active, value, newest]);
 useEffect(() => {
  if (!active || gate) return;
  const key = (e: KeyboardEvent) => { if (newKey(e)) { e.preventDefault(); open(document.activeElement as HTMLElement | null); } };
  window.addEventListener("keydown", key);
  return () => window.removeEventListener("keydown", key);
 }, [active, gate]);
 const done = (thread: NamedThread) => { setMade(list => [...list, thread]); setCreating(false); opener.current = null; go(thread.id); };
 const close = (v: string) => {
  const next = tabs.filter(t => t !== v);
  setTabs(next); rememberTabs(next);
  if (v === value) go(next.at(-1) ?? "");
 };
 const joins = view?.available ? view.joins.filter(j => !selection || ("thread" in selection ? j.thread_id === selection.thread : false)) : [];
 const started = joins.flatMap(j => j.started_from_chat).sort((a, b) => b.created_at.localeCompare(a.created_at));
 const more = Math.max(0, started.length - STARTED_SHOWN) + joins.reduce((n, j) => n + j.omitted, 0);
 const startedRow = (s: StartedFromChat) => <li key={s.job_id}><a href={jobHref(s.job_id)} title={s.job_id}>
  <span class="thread-started-head"><b>{s.title || s.job_id}</b><small class="thread-started-state">{s.state}</small></span><small>{s.job_id}</small></a></li>;
 const newButton = (cls: string, text: ComponentChild) => <button type="button" class={cls} disabled={!!gate} aria-label="New thread" title={gate ?? "New thread (Ctrl/⌘ N)"} aria-expanded={creating}
  onClick={e => open(e.currentTarget)}>{text}</button>;
 const rail = (operatorHref: string) => {
  const href = (v: string) => threadHash(active ? location.hash : operatorHref, v);
  const row = (v: string, count = 0) => <li key={v || "all"}><a href={href(v)} class="thread-row" aria-current={active && v === value ? "page" : undefined} title={label(v)}>
   <span aria-hidden="true">#</span><span class="thread-row-name">{label(v)}</span>{count > 0 && <small class="thread-unread" aria-label={`${count} new`}>{count} new</small>}</a></li>;
  return <>
   <div class="thread-rail-new">{newButton("thread-new", <><span aria-hidden="true">+</span> New thread<kbd>⌘N</kbd></>)}
    {gate && active && <p class="thread-gate" role="note">{gate}</p>}
    {creating && <CreateForm control={control} onDone={done} onCancel={shut}/>}</div>
   <ul class="thread-rows" aria-label="Threads">{row("")}{threads.map(t => row(t.id, unread(entries, t.id, readSeen(t.id))))}{row("none")}</ul>
   {(started.length > 0 || more > 0) && <div class="thread-started" role="group" aria-label="Started from chat"><h2>Started from chat</h2>
    <ul>{started.slice(0, STARTED_SHOWN).map(startedRow)}</ul>{more > 0 && <p class="thread-more">{more} more</p>}</div>}
  </>;
 };
 const shown = ["", ...tabs.filter(v => v), ...(value && !tabs.includes(value) ? [value] : [])];
 return {
  members: members(view), label: label(value), unknown, gate,
  // Nothing to pick without a named thread: the `#` chip and `/thread` wait for the first one.
  picker: active && view?.available && threads.length > 0 && !oldOwner ? {threads, selection, label: selection && "thread" in selection ? label(value) : "No thread", onPick: go} : null,
  rail,
  tabs: active ? <nav class="thread-tabs" aria-label="Thread tabs">
   {shown.map(v => <span key={v || "all"} class="thread-tab" aria-current={v === value ? "page" : undefined}>
    <a href={threadHash(location.hash, v)}>{v === "" ? "Operator · All messages" : `# ${label(v)}`}</a>
    {v !== "" && <button type="button" aria-label={`Close tab ${label(v)}`} title="Close tab" onClick={() => close(v)}>×</button>}</span>)}
   {newButton("thread-tab-new", "+")}
  </nav> : null,
 };
}
