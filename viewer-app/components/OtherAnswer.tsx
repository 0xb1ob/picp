import { useLayoutEffect, useRef } from "preact/hooks";
import type { AwaitingDetail } from "../../src/viewer/api-types.ts";
import { CONTROL_TEXT_MAX } from "../control.ts";

const DISCARD = "Discard this answer?";
/**
 * An ask's free-text answer in a centered modal, since the sidebar is too narrow to read a long reply. `text` is the
 * card's draft, so a failed send reopens with it; Escape, the backdrop and Cancel confirm before dropping typed text.
 */
export function OtherAnswer({ask, text, disabled, onText, onSend, onClose}: {ask: AwaitingDetail; text: string; disabled: boolean;
 onText: (text: string) => void; onSend: () => void; onClose: () => void}) {
 const dialog = useRef<HTMLDialogElement>(null), field = useRef<HTMLTextAreaElement>(null);
 useLayoutEffect(() => {
  const opener = document.activeElement as HTMLElement | null, element = dialog.current!;
  element.showModal(); field.current?.focus();
  return () => { element.close(); if (opener?.isConnected) opener.focus(); };
 }, []);
 useLayoutEffect(() => { const el = field.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [text]);
 const empty = !text.trim();
 const cancel = () => { if (empty || confirm(DISCARD)) { onText(""); onClose(); } };
 const send = () => { if (!empty && !disabled) onSend(); };
 const heading = `ask-other-${ask.id}`;
 return <dialog ref={dialog} class="ask-other" aria-labelledby={heading} onCancel={event => { event.preventDefault(); cancel(); }}
  onClick={event => { if (event.target === event.currentTarget) cancel(); }}
  onKeyDown={event => {
   if (event.isComposing) return;
   if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
   else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); }
  }}>
  <div class="ask-other-body">
   <small>Other answer · {ask.project}</small>
   <h2 id={heading}>{ask.question}</h2>
   {ask.context && <details class="ask-other-context"><summary>Context</summary><p>{ask.context}</p></details>}
   <textarea ref={field} aria-label={`Other answer to ${ask.id}`} placeholder="Type your answer…" rows={4} maxLength={CONTROL_TEXT_MAX - ask.id.length - 2}
    value={text} onInput={event => onText(event.currentTarget.value)}/>
   <div class="ask-other-actions">
    <small>Enter adds a line · Ctrl/⌘ Enter sends</small>
    <button type="button" onClick={cancel}>Cancel</button>
    <button type="button" class="ask-other-send" disabled={empty || disabled} onClick={send}>Send</button>
   </div>
  </div>
 </dialog>;
}
