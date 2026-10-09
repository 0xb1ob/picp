import { useEffect, useRef, useState } from "preact/hooks";
import { CONTROL_TEXT_MAX, type ControlView, controlReady } from "../control.ts";
import { normalizeTag, type ThreadsView } from "../threads.ts";
import { Icon } from "./icons.tsx";

/**
 * New thread (cp-6rsr): a desktop dialog, a bottom sheet below 900 px (CSS). Nothing is requested until Create; Create selects the tag,
 * and only with a first message sends it once through the composer's own POST. Esc, the scrim and × close without selecting.
 */
export function NewThreadDialog({threads, control, onClose}: {threads: ThreadsView; control?: ControlView; onClose: () => void}) {
 const [name, setName] = useState("");
 const [text, setText] = useState("");
 const field = useRef<HTMLInputElement>(null);
 useEffect(() => {
  field.current?.focus();
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
  document.addEventListener("keydown", esc);
  return () => document.removeEventListener("keydown", esc);
 }, []);
 const tag = normalizeTag(name);
 const canMessage = !!control && controlReady(control.status);
 const create = () => {
  if (!tag) return;
  threads.select(tag);
  if (canMessage && text.trim()) control!.send({kind: "message", text: text.trim(), thread: tag});
  onClose();
 };
 return <div class="new-thread-scrim">
  <button type="button" class="new-thread-hit" tabIndex={-1} aria-label="Close" onClick={onClose}/>
  <div class="new-thread" role="dialog" aria-modal="true" aria-labelledby="new-thread-title">
   <div class="new-thread-grab" aria-hidden="true"/>
   <header><h2 id="new-thread-title">New thread</h2><button type="button" class="new-thread-close" aria-label="Close" onClick={onClose}><Icon name="close" size={16}/></button></header>
   <p>A thread is a filter of the operator conversation. Messages you send in it carry its tag; jobs the operator starts from them are filed in it.</p>
   <label><span>Name</span>
    <span class="new-thread-name"><span aria-hidden="true">#</span><input ref={field} type="text" maxLength={33} value={name} placeholder="design-review" onInput={e => setName(e.currentTarget.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); create(); } }}/></span>
   </label>
   {name && !tag
    ? <small class="new-thread-help new-thread-error" role="alert">1–32 characters: a-z, 0-9 and - only.</small>
    : <small class="new-thread-help">Lowercase words and hyphens.<span class="new-thread-shown"> Shown as <span class="new-thread-chip"># {tag ?? "design-review"}</span> on messages and jobs.</span></small>}
   {canMessage && <label><span>First message <span class="new-thread-optional">· optional</span></span><textarea rows={3} placeholder="Sent to the operator, tagged with this thread" maxLength={CONTROL_TEXT_MAX} value={text} onInput={e => setText(e.currentTarget.value)}/></label>}
   <footer><small>The new thread opens filtered, ready to post.</small><button type="button" class="new-thread-cancel" onClick={onClose}>Cancel</button><button type="button" class="new-thread-create" disabled={!tag} onClick={create}>Create thread</button></footer>
  </div>
 </div>;
}
