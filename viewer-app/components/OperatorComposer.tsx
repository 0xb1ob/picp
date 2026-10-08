import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { attachmentSize, attachRefusal, CONTROL_TEXT_MAX, type ControlView, controlFiles, controlImages, controlLine, controlReady, deliveryLine, isTextFile, uploadUrl } from "../control.ts";
import { Icon } from "./icons.tsx";
import { StartSession } from "./StartSession.tsx";
import { restartInFlight } from "../restart-control.ts";
import { threadsReady, type ThreadsView } from "../threads.ts";
import { ThreadPicker } from "./ThreadNav.tsx";

/** The composer's placeholder: short enough for the one-row box at 390px, even with the busy ⋯ button. */
export const COMPOSER_PLACEHOLDER = "Message (Enter to send)";
/** Uploads finish sequentially; failed/unfinished attachments must be removed or resolved before send. */
type Attachment = {key: number; name: string; bytes: number; text: boolean; state: "uploading" | "ready" | "failed"; id?: string; reason?: string};
type Picked = {name: string; type: string; size: number};
/**
 * The Full transcript's composer: text delivered into the running operator session as a user message.
 * One row (mobile-chat-layout): an auto-growing textarea, a round send button doing what Enter does,
 * and, only while busy, a ⋯ menu with "Steer now" and a confirm-tap "Abort turn". While the session takes
 * images, a paperclip (or a paste) attaches up to 8: each uploads at once and shows as a removable thumbnail.
 */
export function OperatorComposer({control, draft, thread}: {control:ControlView; draft?:string; thread?:ThreadsView}) {
 const [text,setText] = useState((draft ?? "").slice(0, CONTROL_TEXT_MAX));
 const [confirmAbort,setConfirmAbort] = useState(false);
 const [attachments,setAttachments] = useState<Attachment[]>([]);
 const field = useRef<HTMLTextAreaElement>(null);
 const menu = useRef<HTMLDetailsElement>(null);
 const picker = useRef<HTMLInputElement>(null);
 const queue = useRef<Promise<unknown>>(Promise.resolve());
 const nextKey = useRef(0);
 const status = control.status;
 const ready = controlReady(status);
 // Held while offline; disabled while a started session comes up or a restart runs, so nothing races its first live token.
 const sending = (!control.pending && control.delivery?.state === "sending") || control.starting?.state === "starting" || restartInFlight(control.restarting);
 const busy = ready && status.running && status.busy === true;
 const upload = controlImages(status) || controlFiles(status) ? control.upload : undefined;
 const images = attachments.flatMap(a => a.state === "ready" && a.id && !a.text ? [a.id] : []);
 const files = attachments.flatMap(a => a.state === "ready" && a.id && a.text ? [a.id] : []);
 // A failed or unfinished attachment blocks sending: remove it or wait.
 const pending = attachments.some(a => a.state !== "ready");
 const canSend = ready && !sending && !pending && (!!text.trim() || images.length > 0 || files.length > 0);
 // Grow with the text; CSS max-height (about five lines) makes it scroll inside past that.
 useLayoutEffect(() => {
  const el = field.current;
  if (!el) return;
  el.style.height = "auto";
  // Empty measures the placeholder, which may wrap: an empty field stays one row.
  if (el.value && el.scrollHeight) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
 },[text,ready]);
 const closeMenu = () => { if (menu.current) menu.current.open = false; setConfirmAbort(false); };
 const update = (key: number, change: Partial<Attachment>) => setAttachments(list => list.map(a => a.key === key ? {...a, ...change} : a));
 const attach = (files: Picked[]) => {
  if (!upload || sending || !files.length) return;
  let count = attachments.filter(a => a.state !== "failed").length;
  const added: Attachment[] = files.map(file => {
   const key = nextKey.current++;
   const text = isTextFile(file);
   const details = {key, name: file.name, bytes: file.size, text};
   const reason = attachRefusal(file, count) ?? (text && !controlFiles(status) ? "Text attachments need a session restart (⋮ → Restart session)" : !text && !controlImages(status) ? "Image attachments need a session restart" : null);
   if (reason) return {...details, state: "failed", reason};
   count++;
   // One upload at a time, in the order attached.
   queue.current = queue.current.then(() => upload(file as File)).catch(() => ({error: "Upload failed"})).then(result => update(key, "error" in result ? {state: "failed", reason: result.error} : {state: "ready", id: result.id, name: result.name ?? file.name, bytes: result.bytes}));
   return {...details, state: "uploading"};
  });
  setAttachments(list => [...list, ...added]);
 };
 const send = (deliver?: "followUp" | "steer") => {
  const body = text.trim();
  if (!canSend) return;
  const extra = {...(deliver ? {deliver} : {}), ...(images.length ? {images} : {}), ...(files.length ? {files} : {}), ...(thread?.selected ? {thread: thread.selected} : {})};
  control.send({kind:"message",text:body,...extra});
  setText("");
  setAttachments([]);
 };
 const abort = () => {
  if (!confirmAbort) { setConfirmAbort(true); return; }
  control.send({kind:"abort"});
  closeMenu();
 };
 const line = deliveryLine(control.delivery);
 const flagged = control.delivery?.state === "failed" || !!control.delivery?.reason;
 const sendLabel = busy ? "Send after this turn" : "Send";
 const optionsLabel = thread?.selected ? `Thread · ${thread.selected}` : "Message options";
 return <section class="operator-composer" aria-label="Message the operator session"
  onDragOver={e => { if (upload && !sending && e.dataTransfer?.types.includes("Files")) e.preventDefault(); }}
  onDrop={e => { if (!upload || sending || !e.dataTransfer?.files.length) return; e.preventDefault(); attach([...e.dataTransfer.files]); }}>
  <div class="operator-composer-meta">
   <p class={ready && status.running ? "operator-composer-state operator-composer-state-ready" : "operator-composer-state"}>{controlLine(status)}</p>
   {ready && ((status.running && status.session_file) || threadsReady(thread?.status)) && <details class="operator-composer-options">
    <summary aria-label={optionsLabel} title={optionsLabel}><span>{optionsLabel}</span><span aria-hidden="true"> ▾</span><Icon name="sessions"/></summary>
    <div class="operator-composer-options-panel">
     {thread && <ThreadPicker threads={thread}/>}
     {status.running && status.session_file && <p>Delivers to the running session <code>{status.session_file}</code></p>}
    </div>
   </details>}
  </div>
  <StartSession control={control}/>
  {ready && attachments.length > 0 && <ul class="operator-composer-attachments" aria-label="Attachments">
   {attachments.map(a => <li key={a.key} class={a.state === "failed" ? "operator-composer-attachment-failed" : a.text ? "operator-composer-file" : undefined}>
    {a.state === "ready" && a.id ? a.text ? <span class="operator-composer-file-name">{a.name}<small>{attachmentSize(a.bytes)}</small></span> : <img class="operator-composer-thumb" src={uploadUrl(a.id)} alt={a.name || "Attached image"}/> : <span class="operator-composer-attachment-state" role={a.state === "failed" ? "alert" : undefined}>{a.state === "failed" ? a.reason : "Uploading…"}</span>}
    <button type="button" class="operator-composer-thumb-remove" aria-label={`Remove ${a.name || "attachment"}`} title="Remove" onClick={() => setAttachments(list => list.filter(b => b.key !== a.key))}><Icon name="close" size={14}/></button>
   </li>)}
  </ul>}
  {ready && <div class="operator-composer-row">
   {upload && <button type="button" class="operator-composer-attach" aria-label="Attach files or images" title="Attach files or images (or paste/drop)" disabled={sending} onClick={() => picker.current?.click()}><Icon name="attach"/></button>}
   {upload && <input ref={picker} type="file" accept={controlFiles(status) ? "image/*,.txt,.md,.html,.json" : "image/*"} multiple hidden onChange={e => { const input = e.currentTarget; attach([...(input.files ?? [])]); input.value = ""; }}/>}
   <textarea ref={field} aria-label="Message to the operator session" maxLength={CONTROL_TEXT_MAX} rows={1} value={text} disabled={sending}
    placeholder={COMPOSER_PLACEHOLDER} title="Enter sends · Shift+Enter for a new line"
    onPaste={e => {
     // File pastes attach; text in a mixed paste keeps the browser's default.
     const files = [...(e.clipboardData?.files ?? [])];
     if (!upload || sending || !files.length) return;
     if (!e.clipboardData?.types.includes("text/plain")) e.preventDefault();
     attach(files);
    }}
    onInput={e => setText(e.currentTarget.value)} onKeyDown={e => { if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return; e.preventDefault(); send(busy ? "followUp" : undefined); }}/>
   {busy && <details class="operator-composer-more" ref={menu} onToggle={() => setConfirmAbort(false)}>
    <summary aria-label="Steer or abort" title="Steer or abort"><Icon name="more"/></summary>
    <div class="operator-composer-menu">
     <button type="button" disabled={!canSend} onClick={() => { send("steer"); closeMenu(); }}>Steer now</button>
     <button type="button" class="operator-composer-abort" disabled={sending} onClick={abort}>{confirmAbort ? "Tap again to abort" : "Abort turn"}</button>
    </div>
   </details>}
   <button type="button" class="operator-composer-send" aria-label={sendLabel} title={sendLabel} disabled={!canSend} onClick={() => send(busy ? "followUp" : undefined)}><Icon name="send"/></button>
  </div>}
  {/* A failure, or a delivered send with a reason (its thread not recorded), is an alert the phone shows too. */}
  {line && <p role={flagged ? "alert" : "status"} class={flagged ? "operator-composer-delivery operator-composer-failed" : "operator-composer-delivery"}>{line}</p>}
 </section>;
}
