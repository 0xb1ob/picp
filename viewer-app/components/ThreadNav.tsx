import { useState } from "preact/hooks";
import type { ThreadsResponse, ThreadView } from "../../src/viewer/api-types.ts";
import type { ControlView } from "../control.ts";
import { doneRefusal, threadAria, threadBadge, type ThreadsView, threadsReady } from "../threads.ts";
import { NewThreadDialog } from "./NewThreadDialog.tsx";

/** The neutral ` · N working` badge: job refs of the thread that are live workers (null or 0 shows nothing); a chip prefixes the `·` in CSS. */
const working = (t: ThreadView) => t.counts?.jobs_working ? <span class="session-thread-working">{t.counts.jobs_working} working</span> : null;
/** `+` / `+ New`: opens the New thread dialog; nothing is requested until Create. */
function NewThread({threads, control, class: cls, label}: {threads: ThreadsView; control?: ControlView; class: string; label: string}) {
 const [open, setOpen] = useState(false);
 return <>
  <button type="button" class={cls} aria-haspopup="dialog" aria-label="New thread" onClick={() => setOpen(true)}>{label}</button>
  {open && <NewThreadDialog threads={threads} control={control} onClose={() => setOpen(false)}/>}
 </>;
}
/** Operator threads (cp-xmw2 S5): phone chips, the desktop sidebar section and the composer picker. No `.css` import: rules live in sessions.css and control.css. */
const selectedView = (threads: ThreadsView, status: ThreadsResponse): ThreadView | undefined => status.threads.find(t => t.tag === threads.selected);

function MarkDone({threads, status, view, class: cls}: {threads: ThreadsView; status: ThreadsResponse; view: ThreadView; class: string}) {
 if (view.state === "done") return null;
 const refusal = doneRefusal(status, view);
 return <button type="button" class={cls} disabled={!!refusal || threads.sending !== null} title={refusal ?? `Mark ${view.tag} done: bookkeeping only, nothing is sent`} onClick={() => threads.done(view.id)}>{threads.sending === view.id ? "Marking…" : "Mark done"}</button>;
}
const Failed = ({threads}: {threads: ThreadsView}) => threads.failed ? <span class="session-thread-failed" role="alert">Not done: {threads.failed.reason}</span> : null;

/** Below 900 px, the filter line under the top bar: All messages, then each thread not done (a selected new or done tag too), then Mark done for the selected one. */
export function ThreadChips({threads, control}: {threads: ThreadsView; control?: ControlView}) {
 const status = threads.status;
 if (!threadsReady(status)) return null;
 const live = status.threads.filter(t => t.state !== "done");
 const current = selectedView(threads, status);
 const extra = threads.selected && !live.some(t => t.tag === threads.selected) ? threads.selected : null;
 return <nav class="session-threads" aria-label="Threads">
  <button type="button" class="session-thread-chip" aria-pressed={!threads.selected} onClick={() => threads.select(null)}>All messages</button>
  {live.map(t => <button type="button" key={t.id} class="session-thread-chip" aria-pressed={threads.selected === t.tag} aria-label={threadAria(t)} onClick={() => threads.select(t.tag)}>{t.tag}{threadBadge(t)}{working(t)}</button>)}
  {extra && <button type="button" class="session-thread-chip" aria-pressed="true">{extra}</button>}
  <NewThread threads={threads} control={control} class="session-thread-chip session-thread-new" label="+ New"/>
  {current && <MarkDone threads={threads} status={status} view={current} class="session-thread-chip session-thread-done"/>}
  <Failed threads={threads}/>
 </nav>;
}

/** At 900 px and up, under Operator ↔ you: All, each thread not done, then the done ones collapsed. */
export function ThreadSidebar({threads, control}: {threads: ThreadsView; control?: ControlView}) {
 const status = threads.status;
 if (!status) return <section><h2>Threads</h2><p>Checking…</p></section>;
 if ("error" in status) return <section><h2>Threads</h2><p>Threads unavailable: {status.error}</p></section>;
 if (status.availability === "unavailable") return <section><h2>Threads</h2><p role="alert">Threads unavailable: {status.warning ?? "unreadable"}</p></section>;
 const live = status.threads.filter(t => t.state !== "done"), done = status.threads.filter(t => t.state === "done");
 const row = (t: ThreadView) => <div key={t.id} class="session-thread-row">
  <button type="button" class="session-thread-choice" aria-pressed={threads.selected === t.tag} aria-label={threadAria(t)} onClick={() => threads.select(t.tag)}><strong>{t.tag}{threadBadge(t)}</strong><small>{t.state}</small>{working(t)}</button>
  {threads.selected === t.tag && <MarkDone threads={threads} status={status} view={t} class="session-thread-done"/>}
 </div>;
 return <section aria-label="Threads"><h2>Threads<NewThread threads={threads} control={control} class="session-thread-new" label="+"/></h2>
  <button type="button" class="session-thread-choice" aria-pressed={!threads.selected} onClick={() => threads.select(null)}><strong>All messages</strong></button>
  {live.map(row)}
  {done.length > 0 && <details><summary>Done ({done.length})</summary>{done.map(row)}</details>}
  {status.warning && <p role="alert">{status.warning}</p>}
  <Failed threads={threads}/>
 </section>;
}

/** The composer's thread: No thread, each open or waiting tag, and the Done group. New threads are made in the dialog (`+ New`). */
export function ThreadPicker({threads}: {threads: ThreadsView}) {
 const status = threads.status;
 if (!threadsReady(status)) return null;
 const live = status.threads.filter(t => t.state !== "done"), done = status.threads.filter(t => t.state === "done");
 const fresh = threads.selected && !status.threads.some(t => t.tag === threads.selected) ? threads.selected : null;
 return <div class="operator-composer-thread">
  <select aria-label="Thread" value={threads.selected ?? ""} onChange={e => threads.select(e.currentTarget.value || null)}>
   <option value="">No thread</option>
   {fresh && <option value={fresh}>{fresh} (new)</option>}
   {live.map(t => <option key={t.id} value={t.tag}>{t.tag}{threadBadge(t)}</option>)}
   {done.length > 0 && <optgroup label="Done">{done.map(t => <option key={t.id} value={t.tag}>{t.tag}</option>)}</optgroup>}
  </select>
 </div>;
}
