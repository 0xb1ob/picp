import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { EvidenceReference } from "../../src/evidence-reference.ts";
import { attachmentSize, attachRefusal, CONTROL_TEXT_MAX, type ControlView, controlFiles, controlImages, controlLine, controlReady, deliveryLine, isTextFile, newClientId, uploadUrl } from "../control.ts";
import { parseReference, referenceContext } from "../evidence-ref.ts";
import { type Command, ComposerMenu, type ComposerMenuContext, slashCommands } from "./ComposerMenu.tsx";
import { EvidenceChip } from "./EvidenceReference.tsx";
import { Icon } from "./icons.tsx";
import { StartSession } from "./StartSession.tsx";
import { restartInFlight } from "../restart-control.ts";
import { composerMentions, matchSkills, mentionAt, type SkillCatalog } from "../skills.ts";

/** The composer's placeholder (chat v2): short enough for the one-row box at 390px, even with the busy ⋯ button. */
export const COMPOSER_PLACEHOLDER = "Message Operator…";
/** Uploads finish sequentially; failed/unfinished attachments must be removed or resolved before send. */
type Attachment = {key: number; name: string; bytes: number; text: boolean; state: "uploading" | "ready" | "failed"; id?: string; reason?: string};
type Picked = {name: string; type: string; size: number};
/** The unsent text per operator session file (`offline` while none is known); absent when empty. */
const DRAFT_KEY = "cp-composer-draft:";
const OFFLINE_DRAFT_KEY = `${DRAFT_KEY}offline`;
/** The draft's one evidence reference (identifiers JSON), a sibling of the text key; text keys are unchanged. */
const REF_KEY = "cp-composer-ref:";
const OFFLINE_REF_KEY = `${REF_KEY}offline`;
/** A consumed reference link leaves the hash (replaced, not pushed), so reload or Back cannot re-add a removed chip. */
function dropComposerLink() {
 const [path = "", query = ""] = location.hash.split("?");
 const params = new URLSearchParams(query);
 params.delete("draft"); params.delete("ref"); params.delete("append");
 const rest = params.toString();
 location.replace(`${path}${rest ? `?${rest}` : ""}`);
}
let draftWarned = false;
function readDraft(key: string): string {
 try { return window.localStorage?.getItem(key) ?? ""; } catch { return ""; }
}
function rememberDraft(key: string, text: string) {
 try { if (text) window.localStorage?.setItem(key, text.slice(0, CONTROL_TEXT_MAX)); else window.localStorage?.removeItem(key); }
 catch (error) { if (!draftWarned) console.warn(`composer draft not persisted: ${(error as Error).message}`); draftWarned = true; }
}
/**
 * The Full transcript's composer, into the running operator session. One rounded box (chat v2): the growing textarea
 * over attach, Options, busy ⋯ (steer, confirm-tap abort) and send; one row below 900 px. Up to 8 attachments.
 */
export function OperatorComposer({control, draft, reference, chat}: {control:ControlView; draft?:string; reference?:string; chat?:ComposerMenuContext | null}) {
 // A reference link (composerHref) keeps saved text: its draft is only a suggestion for an empty composer.
 const linked = useMemo(() => parseReference(reference), [reference]);
 const [text,setText] = useState(linked ? "" : (draft ?? "").slice(0, CONTROL_TEXT_MAX));
 const [attached,setAttached] = useState<EvidenceReference | null>(null);
 const [confirmAbort,setConfirmAbort] = useState(false);
 // Full match S6: the prepared command beside the text draft; its client_id is the one idempotency key for its Submits.
 const [command,setCommand] = useState<{name: "status" | "stop"; job?: string; client_id: string; error?: string; sending?: true} | null>(null);
 const [attachments,setAttachments] = useState<Attachment[]>([]);
 // `@skill` autocomplete: the catalogue (fetched on the first `@`), the caret, the highlighted option, and Escape's close.
 const [catalog,setCatalog] = useState<SkillCatalog | null>(null);
 const [caret,setCaret] = useState<number | null>(null);
 const [active,setActive] = useState(0);
 const [closed,setClosed] = useState(false);
 const asked = useRef(false);
 const placeCaret = useRef<number | null>(null);
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
 const draftKey = ready ? status.session_file ? `${DRAFT_KEY}${status.session_file}` : OFFLINE_DRAFT_KEY : null;
 const refKey = draftKey && `${REF_KEY}${draftKey.slice(DRAFT_KEY.length)}`;
 const restored = useRef<string | null>(null);
 const consumed = useRef<string | undefined>(undefined);
 // Restore once per key; an explicit draft link without a reference wins, and text already typed is never replaced.
 useEffect(() => {
  // A link left the hash: selecting the same evidence again is a new selection.
  if (!linked) consumed.current = undefined;
  const link = linked && consumed.current !== reference ? linked : null;
  if (!draftKey || !refKey || (restored.current === draftKey && !link)) return;
  restored.current = draftKey;
  if (draft !== undefined && !linked) return;
  consumed.current = reference;
  let saved = readDraft(draftKey), savedRef = readDraft(refKey);
  // The session came up: an empty session draft adopts what was typed (and attached) while offline.
  if (!saved && !savedRef && draftKey !== OFFLINE_DRAFT_KEY && (readDraft(OFFLINE_DRAFT_KEY) || readDraft(OFFLINE_REF_KEY))) {
   saved = readDraft(OFFLINE_DRAFT_KEY); savedRef = readDraft(OFFLINE_REF_KEY);
   rememberDraft(draftKey, saved); rememberDraft(refKey, savedRef); rememberDraft(OFFLINE_DRAFT_KEY, ""); rememberDraft(OFFLINE_REF_KEY, "");
  }
  // A reference link's draft is a suggestion: saved (or typed) text is kept, and the suggestion is saved like typing.
  // Text typed into a job's Ask entry (`append=1`, full match C2) is no suggestion: it joins kept text on a new line.
  const typed = !!link && !!draft && new URLSearchParams(location.hash.split("?")[1] ?? "").get("append") === "1";
  const suggested = link && draft && (!saved || typed) ? (saved ? `${saved}\n${draft}` : draft).slice(0, CONTROL_TEXT_MAX) : "";
  if (suggested) rememberDraft(draftKey, suggested);
  const restoredText = (suggested || saved).slice(0, CONTROL_TEXT_MAX);
  if (restoredText) setText(current => typed ? restoredText : current || restoredText);
  const ref = link ?? parseReference(savedRef);
  if (ref) { setAttached(ref); rememberDraft(refKey, JSON.stringify(ref)); }
  // Consumed: the link leaves the URL, so a reload restores storage (a removed chip stays removed), never the link.
  if (link) dropComposerLink();
 },[draftKey,draft,linked,reference]);
 const edit = (next: string) => { setText(next); if (draftKey) rememberDraft(draftKey, next); };
 const pin = (ref: EvidenceReference | null) => { setAttached(ref); if (refKey) rememberDraft(refKey, ref ? JSON.stringify(ref) : ""); };
 const outgoing = [text.trim(), attached ? referenceContext(attached) : ""].filter(Boolean).join("\n\n");
 // Never truncate the question to fit the reference: refuse visibly instead.
 const tooLong = !!attached && outgoing.length > CONTROL_TEXT_MAX;
 const canSend = ready && !sending && !pending && !tooLong && (!!text.trim() || images.length > 0 || files.length > 0);
 // Grow with the text; CSS max-height (about five lines) makes it scroll inside past that.
 useLayoutEffect(() => {
  const el = field.current;
  if (!el) return;
  el.style.height = "auto";
  // Empty measures the placeholder, which may wrap: an empty field stays one row.
  if (el.value && el.scrollHeight) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  // A picked skill puts the caret after its `@name `.
  if (placeCaret.current !== null) { el.setSelectionRange?.(placeCaret.current, placeCaret.current); placeCaret.current = null; }
 },[text,ready]);
 const mention = mentionAt(text, Math.min(caret ?? text.length, text.length));
 const skills = catalog && !("error" in catalog) ? catalog.skills : null;
 const matches = mention && skills ? matchSkills(skills, mention.query) : [];
 // A `/word` draft offers the commands (operator chat only); anything else keeps the `@skill` list.
 const commands = chat ? slashCommands(text) : [];
 const options = commands.length ? commands.map(c => ({name: `/${c.name}`, description: c.detail})) : matches.map(s => ({name: `@${s.name}`, description: s.description}));
 const listOpen = ready && !sending && !closed && options.length > 0;
 const highlighted = Math.min(active, options.length - 1);
 const mentions = skills ? composerMentions(text, skills) : {known: [], unknown: []};
 // The token being completed is not "unknown" yet while the list still offers names for it.
 const unknown = mentions.unknown.filter(name => !(listOpen && name === mention?.query));
 useEffect(() => {
  if (asked.current || !control.skills || !text.includes("@")) return;
  asked.current = true;
  void control.skills().catch((error: unknown) => ({error: error instanceof Error ? error.message : "request failed"})).then(setCatalog);
 },[text,control.skills]);
 const pick = (name: string) => {
  if (!mention) return;
  const end = mention.start + 1 + mention.query.length;
  const next = `${text.slice(0, mention.start)}@${name} ${text.slice(end)}`.slice(0, CONTROL_TEXT_MAX);
  const at = Math.min(mention.start + name.length + 2, next.length);
  edit(next);
  setCaret(at);
  setActive(0);
  placeCaret.current = at;
 };
 /** Choosing never sends: `/jobs` opens the drawer; `/status` and `/stop` prepare a command (typed text kept). */
 const run = (name: Command) => {
  const kept = /^\/[a-z]*$/.test(text) ? "" : text;
  setActive(0);
  edit(kept);
  if (name === "jobs") { chat?.onJobs(field.current); return; }
  setCommand({name, client_id: newClientId()});
  if (name === "status") field.current?.focus();
 };
 const commandReady = !!command && !command.sending && ready && status.running && !sending && (command.name === "status" || !!command.job);
 /** One POST per prepared command (its client_id); a refusal keeps the command, the text and the attachments. */
 const submitting = useRef(false);
 const submit = () => {
  if (!command || !commandReady || !control.command || submitting.current) return;
  const prepared = command;
  submitting.current = true;
  setCommand({...prepared, sending: true, error: undefined});
  void control.command({kind: "command", command: prepared.name, ...(prepared.job ? {job_id: prepared.job} : {}), client_id: prepared.client_id})
   .then(error => { submitting.current = false; setCommand(error === null ? null : {...prepared, error}); });
 };
 const choose = (i: number) => { if (commands.length) run(commands[i]!.name); else pick(matches[i]!.name); };
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
  if (command) { submit(); return; }
  if (!canSend) return;
  const extra = {...(deliver ? {deliver} : {}), ...(images.length ? {images} : {}), ...(files.length ? {files} : {})};
  control.send({kind:"message",text:outgoing,...extra});
  edit("");
  pin(null);
  rememberDraft(OFFLINE_DRAFT_KEY, "");
  rememberDraft(OFFLINE_REF_KEY, "");
  setAttachments([]);
 };
 const abort = () => {
  if (!confirmAbort) { setConfirmAbort(true); return; }
  control.send({kind:"abort"});
  closeMenu();
 };
 const line = deliveryLine(control.delivery);
 const flagged = control.delivery?.state === "failed" || !!control.delivery?.reason;
 const sendLabel = command ? `Submit /${command.name}` : busy ? "Send after this turn" : "Send";
 return <section class="operator-composer" aria-label="Message the operator session"
  onDragOver={e => { if (upload && !sending && e.dataTransfer?.types.includes("Files")) e.preventDefault(); }}
  onDrop={e => { if (!upload || sending || !e.dataTransfer?.files.length) return; e.preventDefault(); attach([...e.dataTransfer.files]); }}>
  <p class={ready && status.running ? "operator-composer-state operator-composer-state-ready" : "operator-composer-state"}>{controlLine(status)}</p>
  <StartSession control={control}/>
  {ready && attachments.length > 0 && <ul class="operator-composer-attachments" aria-label="Attachments">
   {attachments.map(a => <li key={a.key} class={a.state === "failed" ? "operator-composer-attachment-failed" : a.text ? "operator-composer-file" : undefined}>
    {a.state === "ready" && a.id ? a.text ? <span class="operator-composer-file-name">{a.name}<small>{attachmentSize(a.bytes)}</small></span> : <img class="operator-composer-thumb" src={uploadUrl(a.id)} alt={a.name || "Attached image"}/> : <span class="operator-composer-attachment-state" role={a.state === "failed" ? "alert" : undefined}>{a.state === "failed" ? a.reason : "Uploading…"}</span>}
    <button type="button" class="operator-composer-thumb-remove" aria-label={`Remove ${a.name || "attachment"}`} title="Remove" onClick={() => setAttachments(list => list.filter(b => b.key !== a.key))}><Icon name="close" size={14}/></button>
   </li>)}
  </ul>}
  {ready && attached && <EvidenceChip reference={attached} onRemove={() => pin(null)}/>}
  {ready && tooLong && <p role="alert" class="operator-composer-hint">Too long with the reference: shorten the question by {outgoing.length - CONTROL_TEXT_MAX} characters, or remove the reference</p>}
  {ready && command && <div class="operator-composer-command" role="group" aria-label="Prepared command">
   <code>/{command.name}{command.job ? ` ${command.job}` : ""}</code>
   <span>{command.sending ? "Submitting…" : !status.running ? "Commands need a running operator session" : command.name === "stop" && !command.job ? "Pick the job to stop with @ job" : "Submit sends it to the operator once"}</span>
   <button type="button" class="operator-composer-command-remove" aria-label="Remove the command" title="Remove" disabled={command.sending} onClick={() => setCommand(null)}><Icon name="close" size={14}/></button>
   {command.error && <p role="alert" class="operator-composer-failed">{command.error}</p>}
  </div>}
  {ready && <div class="operator-composer-box">
   <div class="operator-composer-field">
   {listOpen && <ul role="listbox" id="operator-composer-skills" class="operator-composer-skills" aria-label={commands.length ? "Commands" : "Installed skills"}>
    {options.map((s, i) => <li key={s.name} id={`operator-composer-skill-${i}`} role="option" aria-selected={i === highlighted} onMouseDown={e => { e.preventDefault(); choose(i); }}>
     <span>{s.name}</span>{s.description && <small>{s.description}</small>}
    </li>)}
   </ul>}
   <textarea ref={field} aria-label="Message to the operator session" maxLength={CONTROL_TEXT_MAX} rows={1} value={text} disabled={sending}
    aria-autocomplete="list" aria-expanded={listOpen} aria-controls={listOpen ? "operator-composer-skills" : undefined} aria-activedescendant={listOpen ? `operator-composer-skill-${highlighted}` : undefined}
    placeholder={COMPOSER_PLACEHOLDER} title="Enter sends · Shift+Enter for a new line"
    onPaste={e => {
     // File pastes attach; text in a mixed paste keeps the browser's default.
     const files = [...(e.clipboardData?.files ?? [])];
     if (!upload || sending || !files.length) return;
     if (!e.clipboardData?.types.includes("text/plain")) e.preventDefault();
     attach(files);
    }}
    onClick={e => setCaret(e.currentTarget.selectionStart ?? null)}
    onInput={e => { edit(e.currentTarget.value); setCaret(e.currentTarget.selectionStart ?? null); setActive(0); setClosed(false); }} onKeyDown={e => {
     if (e.isComposing || e.keyCode === 229) return;
     if (listOpen) {
      // The open list owns the arrows, Enter/Tab (pick) and Escape; Enter sends only while it is closed.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((highlighted + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length); return; }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); choose(highlighted); return; }
      if (e.key === "Escape") { e.preventDefault(); setClosed(true); return; }
     }
     if (e.key !== "Enter" || e.shiftKey) return; e.preventDefault(); send(busy ? "followUp" : undefined); }}/>
   </div>
   <div class="operator-composer-footer">
   {/* The paperclip always leads the footer; disabled, its title says why it cannot attach now. */}
   {control.upload && <button type="button" class="operator-composer-attach" aria-label="Attach files or images" title={upload ? "Attach files or images (or paste/drop)" : status.running ? "This session does not take attachments (⋮ → Restart session)" : "Attachments need a running session"} disabled={sending || !upload} onClick={() => picker.current?.click()}><Icon name="attach"/></button>}
   {upload && <input ref={picker} type="file" accept={controlFiles(status) ? "image/*,.txt,.md,.html,.json" : "image/*"} multiple hidden onChange={e => { const input = e.currentTarget; attach([...(input.files ?? [])]); input.value = ""; }}/>}
   {chat && <ComposerMenu context={chat} disabled={sending} target={command?.name === "stop" && !command.sending} onCommand={run} onRefer={ref => { pin(ref); field.current?.focus(); }}
    onTarget={job => { setCommand(current => current && {...current, job, error: undefined}); field.current?.focus(); }}/>}
   {status.running && status.session_file && <details class="operator-composer-options">
    <summary aria-label="Message options" title="Message options"><span>Options</span><span aria-hidden="true"> ▾</span></summary>
    <div class="operator-composer-options-panel"><p>Delivers to the running session <code>{status.session_file}</code></p></div>
   </details>}
   {busy && <details class="operator-composer-more" ref={menu} onToggle={() => setConfirmAbort(false)}>
    <summary aria-label="Steer or abort" title="Steer or abort"><Icon name="more"/></summary>
    <div class="operator-composer-menu">
     <button type="button" disabled={!canSend || !!command} onClick={() => { send("steer"); closeMenu(); }}>Steer now</button>
     <button type="button" class="operator-composer-abort" disabled={sending} onClick={abort}>{confirmAbort ? "Tap again to abort" : "Abort turn"}</button>
    </div>
   </details>}
   <button type="button" class="operator-composer-send" aria-label={sendLabel} title={sendLabel} disabled={command ? !commandReady : !canSend} onClick={() => send(busy ? "followUp" : undefined)}><Icon name="send"/></button>
   </div>
  </div>}
  {ready && mentions.known.length > 0 && <ul class="operator-composer-mentions" aria-label="Skills mentioned">{mentions.known.map(name => <li key={name}><code>@{name}</code></li>)}</ul>}
  {ready && unknown.map(name => <p key={name} role="status" class="operator-composer-hint">@{name} is not an installed skill — sent as plain text</p>)}
  {ready && catalog && "error" in catalog && <p role="status" class="operator-composer-hint">skill list unavailable: {catalog.error}</p>}
  {/* A failure, or a delivered send with a reason, is an alert the phone shows too. */}
  {line && <p role={flagged ? "alert" : "status"} class={flagged ? "operator-composer-delivery operator-composer-failed" : "operator-composer-delivery"}>{line}</p>}
 </section>;
}
