import { Fragment, type ComponentChild } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { ContextUsage, SessionEntry, SessionsResponse } from "../../src/viewer/api-types.ts";
import { ContextChip, contextText } from "../components/ContextChip.tsx";
import { modelText } from "../../src/viewer/model-text.ts";
import { time } from "../format.ts";
import { sessionHref } from "../routes.ts";
import { InlineText, Linked, Markdown } from "../components/Markdown.tsx";
import { Icon } from "../components/icons.tsx";
import { OperatorComposer } from "../components/OperatorComposer.tsx";
import { DecisionCard } from "../components/DecisionCard.tsx";
import { TranscriptAsk } from "../components/TranscriptAsk.tsx";
import { TranscriptImages } from "../components/TranscriptImages.tsx";
import { TranscriptFiles } from "../components/TranscriptFiles.tsx";
import { PendingBubble } from "../components/PendingBubble.tsx";
import { transcriptHasSend } from "../pending-sends.ts";
import { ShellContext } from "../components/Shell.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { VersionBadge } from "../components/VersionBadge.tsx";
import { RestartSession, restartShown } from "../components/RestartSession.tsx";
import { type ControlView, controlChip, controlLine, controlReady, deliveryLine } from "../control.ts";
import { useViewportFit } from "../viewport-fit.ts";
import { ThreadChips, ThreadSidebar } from "../components/ThreadNav.tsx";
import { threadFilter, type ThreadsView, visibleEntries } from "../threads.ts";

/** A tool call/result longer than this shows its head, with the rest behind one "show all" link. */
const TOOL_TEXT_MAX = 1200;
type Worker = SessionsResponse["workers"][number];
/** Live the way the Overview's `health()` counts it: an in-flight job whose run has not exited, held-idle included. */
export const countedLive = (w: Worker): boolean => ["waiting","held","launching"].includes(w.phase ?? "") && ["starting","working","idle"].includes(w.run_phase ?? "");
const workerPhase = (w: Worker): string => w.run_phase ?? "no run status";
function readStored(key: string): string | null {
 if (typeof window === "undefined") return null;
 try { return window.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function remember(key: string, value: string, what: string) {
 try { window.localStorage?.setItem(key, value); } catch (error) { console.warn(`${what} not persisted: ${(error as Error).message}`); }
}
/** One remembered choice, shared by every view: absent means tool calls are hidden (cp-hidetools). */
const TOOLS_KEY = "cp-sessions-tool-calls";
const readToolCalls = (): boolean => readStored(TOOLS_KEY) === "1";
const rememberToolCalls = (show: boolean) => remember(TOOLS_KEY, show ? "1" : "0", "tool-call toggle");
/** The pinned decisions bar (cp-6kt6): the operator's open/collapsed choice, and the open ask ids it last showed. */
const PINNED_KEY = "cp-sessions-pinned-open", PINNED_SEEN_KEY = "cp-sessions-pinned-seen";
function readSeen(): string[] | null {
 const raw = readStored(PINNED_SEEN_KEY);
 if (raw === null) return null;
 try { const ids: unknown = JSON.parse(raw); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null; }
 catch (error) { console.warn(`seen decisions unreadable, starting over: ${(error as Error).message}`); return null; }
}
/** Consecutive tool entries collapse into one run; every other entry stands alone. */
type Row = {kind:"entry";entry:SessionEntry} | {kind:"run";key:string;entries:SessionEntry[]};
function rows(entries: SessionEntry[]): Row[] {
 const out: Row[] = [];
 for (const entry of entries) {
  const tail = out.at(-1);
  if (entry.kind === "tool" && tail?.kind === "run") { tail.entries.push(entry); continue; }
  out.push(entry.kind === "tool" ? {kind:"run",key:entry.id,entries:[entry]} : {kind:"entry",entry});
 }
 return out;
}

/** The prompting side of a transcript (sessions-view.ts SIDES: the user turns) sits on the right; everything the session says on the left. */
const OWN = new Set(["Operator","Operator → parent","Parent"]);
const isBubble = (e: SessionEntry) => e.kind === "say" || e.kind === "via";
const isOwn = (e: SessionEntry) => e.kind === "via" || OWN.has(e.who);
/** Consecutive messages from one author within this gap share one header (who and time). */
const GROUP_GAP_MS = 5 * 60_000;
/** An opened relay longer than this many lines shows its head, the rest behind "Show more". */
const RELAY_LINES = 6;
/** Which bubbles open a group: the first, a change of author, a notice or card between, or a long gap. Tool calls never split a group. */
function groupStarts(rowList: Row[]): Set<string> {
 const starts = new Set<string>();
 let prev: SessionEntry | undefined;
 for (const row of rowList) {
  if (row.kind === "run") continue;
  const e = row.entry;
  if (!isBubble(e)) { prev = undefined; continue; }
  const gap = prev && e.at && prev.at ? Date.parse(e.at)-Date.parse(prev.at) : 0;
  if (!prev || prev.who !== e.who || !(gap <= GROUP_GAP_MS)) starts.add(e.id);
  prev = e;
 }
 return starts;
}
/** A hidden run of tool calls: one faint line between messages, and clicking it opens that run alone. */
function ToolRun({entries,open,onToggle}: {entries:SessionEntry[];open:boolean;onToggle:()=>void}) {
 return <div class="session-tool-run">
  <button type="button" class="session-tools" aria-expanded={open} onClick={onToggle}>· {entries.length} tool call{entries.length === 1 ? "" : "s"} ·</button>
  {open && entries.map(e=><Entry key={e.id} entry={e}/>)}
 </div>;
}
/**
 * A cp-bridge wake or escalation, or any other system entry (compaction, custom messages): one muted line, the rest and a
 * relay's `paths:` links behind one expander (mobile-chat-layout). An opened relay past RELAY_LINES shows its head and "Show more".
 */
function bridgeWords(b: NonNullable<SessionEntry["bridge"]>): string {
 const verb = b.kind === "wake" ? "woke" : b.kind.replaceAll("_", " ");
 const receipt = b.receipt?.replaceAll("_", " ");
 return ["bridge", verb, b.job].filter(Boolean).join(" ") + (receipt ? ` · ${receipt}` : "");
}
/** A parsed cp-bridge notice: one summary line, the body in a collapsed details when more than one line remains. */
function BridgeNotice({entry:e,clock}: {entry:SessionEntry;clock:ComponentChild}) {
 const [open,setOpen]=useState(false);
 const lines=e.text.length ? e.text.split("\n") : [];
 const links=e.paths ?? [];
 const at=links.length ? lines.findIndex(line=>line.trim() === "paths:") : -1;
 const prose=(at < 0 ? lines : lines.slice(0,at)).join("\n").replace(/\n+$/,"");
 const multi=e.text.includes("\n");
 return <article class="session-message session-notice session-system session-bridge">
  {clock}
  <div class="session-body">
   <div class="session-who"><span>{e.who}</span>{e.tag && <span>{e.tag}</span>}</div>
   <p class="session-bridge-line">{bridgeWords(e.bridge!)}</p>
   {multi ? <details class="session-bridge-details" open={open}><summary class="session-notice-line" aria-expanded={open} onClick={ev=>{ev.preventDefault();setOpen(!open);}}><small>{open ? "Hide notice" : "Show notice"}</small></summary>{open && <div class="session-notice-rest">{prose && <p><InlineText text={prose} links={e.links}/></p>}{links.length > 0 && <ul class="session-notice-paths">{links.map(link=><li key={link.path}>{link.href ? <a href={link.href}>{link.path}</a> : <code>{link.path}</code>}{link.read && <a href={link.read}>read</a>}</li>)}</ul>}</div>}</details>
    : prose ? <p><InlineText text={prose} links={e.links}/></p> : null}
  </div>
 </article>;
}
function Notice({entry:e,clock}: {entry:SessionEntry;clock:ComponentChild}) {
 const [open,setOpen]=useState(false);
 const [full,setFull]=useState(false);
 const lines=e.text.split("\n");
 const links=e.paths ?? [];
 const at=links.length ? lines.findIndex(line=>line.trim() === "paths:") : -1;
 const rest=lines.slice(1,at < 0 ? undefined : at);
 const shown=full ? rest : rest.slice(0,RELAY_LINES);
 const more=lines.length-1;
 return <article class={`session-message session-notice session-system${e.tag === "bridge" ? " session-bridge" : ""}`}>
  {clock}
  <div class="session-body">
   <div class="session-who"><span>{e.who}</span>{e.tag && <span>{e.tag}</span>}</div>
   {/* Open, the first line is text (its links clickable); the toggle stays a button with only its count. */}
   {more > 0 ? <>{open && <p><InlineText text={lines[0]!} links={e.links}/></p>}<button type="button" class="session-notice-line" aria-expanded={open} onClick={()=>setOpen(!open)}>{!open && <span>{lines[0]}</span>}<small>{more} more line{more === 1 ? "" : "s"}</small></button></>
    : <p><InlineText text={e.text} links={e.links}/></p>}
   {open && <div class="session-notice-rest">
    {shown.length > 0 && <p><InlineText text={shown.join("\n")} links={e.links}/></p>}
    {shown.length < rest.length && <button type="button" class="session-notice-more" onClick={()=>setFull(true)}>Show more ({rest.length-shown.length} line{rest.length-shown.length === 1 ? "" : "s"})</button>}
    {links.length > 0 && <ul class="session-notice-paths">{links.map(link=><li key={link.path}>{link.href ? <a href={link.href}>{link.path}</a> : <code>{link.path}</code>}{link.read && <a href={link.read}>read</a>}</li>)}</ul>}
   </div>}
  </div>
 </article>;
}
/** A message bubble: the prompting side on the right in the accent colour, the session on the left; a group's first bubble carries who and when. */
function Bubble({entry:e,first}: {entry:SessionEntry;first:boolean}) {
 return <article class={`session-message session-say session-bubble ${isOwn(e) ? "session-own" : "session-other"}${first ? "" : " session-grouped"}`}>
  {first && <div class="session-who"><span>{e.who}</span>{e.project && <span class="session-project">{e.project}</span>}{e.tag && <span>{e.tag}</span>}{e.at && <time class="session-time" dateTime={e.at}>{time(e.at)}</time>}</div>}
  <div class="session-body"><Markdown text={e.text} links={e.links}/>{e.images?.length ? <TranscriptImages ids={e.images}/> : null}{e.files?.length ? <TranscriptFiles ids={e.files} metadata={e.file_metadata}/> : null}{e.send_id && <code class="session-send">send {e.send_id}</code>}{e.dashboard_id && <code class="session-send">dashboard {e.dashboard_id}{e.ask_id ? ` · ${e.ask_id}` : ""}</code>}</div>
 </article>;
}
function Entry({entry:e,first=true}: {entry:SessionEntry;first?:boolean}) {
 const trace=e.trace.filter(step=>step.at);
 const clock=<code class="session-time">{e.at ? time(e.at) : "-"}</code>;
 const head=e.kind === "tool" && e.text.length > TOOL_TEXT_MAX ? e.text.slice(0,TOOL_TEXT_MAX) : e.text;
 return <div class={e.failed ? "session-entry session-failed" : "session-entry"}>
  {e.kind === "tool" ? <details class="session-tool"><summary>{clock}<code>{e.name}</code><span>{e.summary}</span></summary><pre><Linked text={head} links={e.links}/></pre>{head !== e.text && <details class="session-tool-all"><summary>show all</summary><pre><Linked text={e.text.slice(TOOL_TEXT_MAX)} links={e.links}/></pre></details>}</details> :
   e.kind === "system" || e.tag === "bridge" ? (e.bridge ? <BridgeNotice entry={e} clock={clock}/> : <Notice entry={e} clock={clock}/>) :
   isBubble(e) ? <Bubble entry={e} first={first}/> :
   // Ask and decision cards keep their card look.
   <article class="session-message session-notice">
    {clock}<div class={`session-body ${e.tag === "awaiting you" ? "session-awaiting" : ""}`}><div class="session-who"><span>{e.who}</span>{e.tag && <span>{e.tag}</span>}</div><p class={e.ask?.state === "open" ? "session-oneline" : undefined}><InlineText text={e.text} links={e.links}/></p>{e.ask && <TranscriptAsk ask={e.ask}/>}{e.send_id && <code class="session-send">send {e.send_id}</code>}{e.dashboard_id && <code class="session-send">dashboard {e.dashboard_id}{e.ask_id ? ` · ${e.ask_id}` : ""}</code>}</div>
   </article>}
  {trace.length>0 && <div class="session-trace">{trace.map((step,i)=><details key={`${step.id}-${i}`}><summary><span>{i === 0 && `${step.id} · `}{step.label} {time(step.at!)}</span>{i<trace.length-1 && " →"}</summary><p><InlineText text={step.detail}/></p></details>)}</div>}
 </div>;
}
/** Close the menu a tap came from. */
const closeMenu = (e: {currentTarget: EventTarget | null}) => { const menu = (e.currentTarget as Element | null)?.closest?.("details"); if (menu) (menu as HTMLDetailsElement).open = false; };
/**
 * The mobile top bar (mobile-chat-layout): back to the app, a menu with every session, the view's name, the live dot,
 * a compact ctx chip, the composer's status chip, and one ⋯ menu for tool calls, the session file and search.
 * It replaces the shell header, the tab rows and the heading below 900 px; desktop keeps its sidebar and heading.
 */
const sessionWhen = new Intl.DateTimeFormat("en",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
function sessionOptionLabel(at: string, current: boolean): string {
 const date = new Date(at), when = Number.isNaN(date.getTime()) ? at : sessionWhen.format(date);
 return current ? `${when} · current` : when;
}
const fileOptions = (files: {id:string;at:string}[]) => files.map((s,i)=><option key={s.id} value={s.id} title={s.id}>{sessionOptionLabel(s.at,i === 0)}</option>);
function SessionBar({data,control,context,toolCalls,showTools,hiddenTools,onTools}: {data:SessionsResponse;control:ControlView | undefined;context:ContextUsage | null | undefined;toolCalls:number;showTools:boolean;hiddenTools:number;onTools:()=>void}) {
 const shell = useContext(ShellContext);
 const composer = data.transcript === true && control;
 const files = data.operator_sessions ?? [];
 const views = [["you","Operator ↔ you"],["parent","CP parent"],["workers","Workers"]] as const;
 return <header class="session-bar">
  <a class="session-bar-icon" href="#overview" aria-label="Back to Overview"><Icon name="back"/></a>
  <details class="session-bar-menu session-bar-views">
   <summary aria-label="Switch session"><strong>{data.title}</strong><span aria-hidden="true">▾</span></summary>
   <nav class="session-bar-sheet" aria-label="Session streams">
    {views.map(([id,label]) => <a key={id} href={sessionHref(id)} aria-current={data.selected === id ? "page" : undefined} onClick={closeMenu}>{label}</a>)}
    {data.workers.map(w => <a key={w.id} class="session-bar-worker" href={sessionHref("workers",w.id)} aria-current={data.selected === "workers" && data.session_id === w.id ? "page" : undefined} onClick={closeMenu}><span class={`session-dot session-dot-${w.phase === "held" || w.phase === "failed" ? w.phase : w.run_phase ?? "unknown"}`}/><span>{w.id}</span><small>{workerPhase(w)}</small></a>)}
   </nav>
  </details>
  <span class={`shell-live shell-live-${shell.status}`} role="status" aria-label={`Data ${shell.status}`} title={shell.status}><span/></span>
  {context && <span class={`session-bar-ctx ctx-${context.level ?? "unknown"}`} title={contextText(context)}>{context.percent === null ? "ctx n/a" : `${Math.round(context.percent)}%`}</span>}
  {composer && <span class="session-bar-status" role="status" title={[controlLine(control.status),deliveryLine(control.delivery)].filter(Boolean).join(" · ")}>{controlChip(control.status,control.delivery)}</span>}
  {shell.version && <VersionBadge state={shell.version}/>}
  <details class="session-bar-menu session-bar-more">
   <summary aria-label="More" title="More"><Icon name="more"/></summary>
   <div class="session-bar-sheet">
    {toolCalls > 0 && <button type="button" aria-pressed={showTools} onClick={e => { onTools(); closeMenu(e); }}>{showTools ? "Hide tool calls" : `Show tool calls (${hiddenTools})`}</button>}
    <button type="button" aria-haspopup="dialog" onClick={e => { closeMenu(e); shell.openSearch(); }}>Search</button>
    {data.transcript === true && files.length > 0 && <label class="session-file-picker">Transcript<select aria-label="Operator session file" value={data.operator_session ?? ""} onChange={e=>{window.location.hash=`sessions?view=you&transcript=1&session=${encodeURIComponent(e.currentTarget.value)}`;}}>{fileOptions(files)}</select></label>}
    {composer && controlReady(control.status) && control.status.session_file && <p class="session-bar-file">Delivers to <code>{control.status.session_file}</code></p>}
    {shell.control && restartShown(shell.control) && <div class="session-bar-restart"><RestartSession control={shell.control}/></div>}
   </div>
  </details>
 </header>;
}
export function Sessions({data,control,draft,threads}: {data:SessionsResponse;control?:ControlView;draft?:string;threads?:ThreadsView}) {
 const scroller=useRef<HTMLDivElement>(null);
 const [atBottom,setAtBottom]=useState(true);
 const [showTools,setShowTools]=useState(readToolCalls);
 const [openRuns,setOpenRuns]=useState<string[]>([]);
 const pending = data.selected === "you" && data.transcript === true ? (control?.pending ?? []).filter(send=>!transcriptHasSend(data.entries,send.id) && (!threads?.selected || send.body.thread === threads.selected)) : [];
 const queued = pending.filter(send=>send.state !== "failed" && send.state !== "delivered");
 const pendingKey = pending.map(send=>`${send.key}:${send.state}`).join("|");
 const lastEntry=data.entries.at(-1)?.id;
 const scrollToEnd=()=>{const el=scroller.current; if(el) el.scrollTop=el.scrollHeight;};
 useEffect(()=>{if(atBottom) scrollToEnd();},[lastEntry,pendingKey,showTools,openRuns,threads?.selected]);
 const follow=useRef(true);
 // The pinned decisions bar opens and collapses at every width; the choice is remembered per browser. It opens by
 // itself only when an ask id it has not shown before appears — never because the count alone changed.
 const askIds=data.transcript === true ? (data.open_asks ?? []).map(a=>a.id) : null, askKey=JSON.stringify(askIds);
 const seen=useRef<string[] | null>(null);
 if (seen.current === null && askIds) seen.current=readSeen() ?? askIds;
 const [pinOpen,setPinOpen]=useState(()=>askIds?.some(id=>!seen.current!.includes(id)) === true || readStored(PINNED_KEY) === "1");
 useEffect(()=>{
  if (!askIds) return;
  const shown=seen.current ?? [];
  if (askIds.some(id=>!shown.includes(id))) setPinOpen(true);
  if (JSON.stringify(shown) !== askKey) { seen.current=askIds; remember(PINNED_SEEN_KEY,askKey,"seen decisions"); }
 },[askKey]);
 const togglePin=()=>{const next=!pinOpen; setPinOpen(next); remember(PINNED_KEY,next ? "1" : "0","decisions bar");};
 // Any answer from the pinned sheet (a button, or "Other answer") collapses it back to its one-line bar.
 const pinControl=control && {...control,send:(body:Parameters<ControlView["send"]>[0],ask?:string)=>{setPinOpen(false); control.send(body,ask);}};
// The on-screen keyboard shrinks — and, on iOS, pans — the visual viewport: keep the shell on the visible
// slice and the page itself un-panned, so the composer sits above the keyboard with the chat history above it.
useViewportFit(()=>{if(follow.current) scrollToEnd();});
 // Pinned stays pinned when the entries grow without a new one (web fonts swapping in, a notice opening) or the
 // transcript itself shrinks (the composer's controls arriving). The browser's own scroll anchoring is off (sessions.css).
 useEffect(()=>{
  const el=scroller.current, entries=el?.firstElementChild;
  if(!el || !entries || typeof ResizeObserver === "undefined") return;
  const observer=new ResizeObserver(()=>{if(follow.current) scrollToEnd();});
  observer.observe(el); observer.observe(entries);
  return ()=>observer.disconnect();
 },[]);
 // A tap outside an open top-bar or composer menu closes it.
 useEffect(()=>{
  const outside=(e:Event)=>{for(const menu of document.querySelectorAll<HTMLDetailsElement>(".session-bar-menu[open], .operator-composer-more[open], .operator-composer-options[open]")) if(!menu.contains(e.target as Node)) menu.open=false;};
  const escape=(e:KeyboardEvent)=>{if(e.key !== "Escape") return; const menu=document.querySelector<HTMLDetailsElement>(".operator-composer-options[open]"); if(menu){menu.open=false; menu.querySelector<HTMLElement>("summary")?.focus();}};
  document.addEventListener("pointerdown",outside); document.addEventListener("keydown",escape);
  return ()=>{document.removeEventListener("pointerdown",outside); document.removeEventListener("keydown",escape);};
 },[]);
 // Operator threads (cp-xmw2): own entries, plus shared ones inside that thread's own span; pinned decisions are never filtered.
 const filter=data.transcript === true ? threadFilter(threads?.status,threads?.selected) : null, shown=visibleEntries(data.entries,filter);
 const rowList=rows(shown), starts=groupStarts(rowList);
 const toolCalls=shown.filter(e=>e.kind === "tool").length;
 const hiddenTools=rowList.reduce((n,row)=>row.kind === "run" && !openRuns.includes(row.key) ? n+row.entries.length : n,0);
 const toggleTools=()=>{const next=!showTools; setShowTools(next); rememberToolCalls(next); setOpenRuns([]);};
 const toggleRun=(key:string)=>setOpenRuns(open=>open.includes(key) ? open.filter(k=>k!==key) : [...open,key]);
 const row=(href:string,label:string,meta:string,selected:boolean,phase:string,context?:ContextUsage | null,showModel=false)=><a href={href} aria-current={selected ? "page" : undefined} class="session-choice"><span class={`session-dot session-dot-${phase}`}/><span><strong>{label}</strong><small>{meta}</small>{showModel && context && <small class="session-model">{modelText(context)}</small>}<ContextChip usage={context} compact/></span></a>;
 const files=data.operator_sessions ?? [], open=data.open_asks ?? [];
 const context=data.selected === "you" ? data.operator_context : data.selected === "parent" ? data.parent.context : data.workers.find(w=>w.id===data.session_id)?.context;
 return <div class="sessions">
  <PageHeader title="Sessions"/>
  <aside class="session-sidebar" aria-label="Session streams">
   <section><h2>Operator ↔ you</h2>{row(sessionHref("you"),"Operator ↔ you",data.selected === "you" && data.transcript ? "Transcript" : "Recorded decisions and questions",data.selected === "you","unknown",data.operator_context,true)}</section>
   {data.selected === "you" && data.transcript === true && threads && <ThreadSidebar threads={threads}/>}
   <section><h2>CP parent</h2>{row(sessionHref("parent"),"CP parent",data.parent.live ? "recent activity" : "idle",data.selected === "parent",data.parent.live ? "working" : "unknown",data.parent.context,true)}</section>
   <section><h2>Workers · {data.workers.filter(countedLive).length} live</h2>{data.workers.map(w=><div key={w.id}>{row(sessionHref("workers",w.id),w.id,`${workerPhase(w)} · ${modelText({model:w.context?.model ?? w.model,thinking:w.thinking})}`,data.session_id === w.id,w.phase === "held" || w.phase === "failed" ? w.phase : w.run_phase ?? "unknown",w.context)}</div>)}{!data.workers.length && <p>No workers</p>}</section>
  </aside>
  <div class="session-panel">
   <SessionBar data={data} control={control} context={context} toolCalls={toolCalls} showTools={showTools} hiddenTools={hiddenTools} onTools={toggleTools}/>
   <header class="session-heading"><div><strong>{data.title}</strong>{data.transcript !== true && <span>{data.subtitle}</span>}<ContextChip usage={context}/></div>
    {/* Audit P4 #27: the decision log lives on the Decisions page; a refused transcript still falls back silently. */}
    {data.transcript === true && files.length > 0 && <label class="session-file-picker">Transcript<select aria-label="Operator session file" value={data.operator_session ?? ""} onChange={e=>{window.location.hash=`sessions?view=you&transcript=1&session=${encodeURIComponent(e.currentTarget.value)}`;}}>{fileOptions(files)}</select></label>}
    {toolCalls > 0 && <button type="button" class="session-tools-toggle" aria-pressed={showTools} onClick={toggleTools}>{showTools ? "Hide tool calls" : `Show tool calls (${hiddenTools})`}</button>}
    {data.selected === "you" && data.transcript !== true && <p>Trace a decision: parent’s question → operator’s answer → the message you saw.</p>}</header>
   {control?.pending && <p class="session-pending-live" aria-live="polite" aria-atomic="true">{pending.length ? pending.map(send=>`Message at ${time(send.at)}: ${send.state}${send.reason ? `, ${send.reason}` : ""}`).join(". ") : "No pending messages"}</p>}
   <div class="session-transcript" role="region" aria-label="Transcript" ref={scroller} onScroll={()=>{const el=scroller.current; if(el){follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<48; setAtBottom(follow.current);}}}>
    <div class="session-entries">{data.warnings.map(w=><p class="session-warning" role="alert" key={w}>{w}</p>)}{control?.status && !("error" in control.status) && control.status.sends_error && <p class="session-warning" role="alert">Queued messages unavailable: {control.status.sends_error}</p>}{data.truncated && <p class="session-empty">Recent entries only</p>}{!data.entries.length && !pending.length && <p class="session-empty">No recorded entries</p>}{filter === "none" && !pending.length && <p class="session-empty">No messages in {threads?.selected} yet</p>}{rowList.map(row=>row.kind === "entry" ? <Entry key={row.entry.id} entry={row.entry} first={starts.has(row.entry.id)}/> : showTools ? <Fragment key={row.key}>{row.entries.map(e=><Entry key={e.id} entry={e}/>)}</Fragment> : <ToolRun key={row.key} entries={row.entries} open={openRuns.includes(row.key)} onToggle={()=>toggleRun(row.key)}/>)}{pending.map(send=><PendingBubble key={send.key} send={send} position={queued.indexOf(send)+1} total={queued.length} control={control!}/>)}</div>
    {!atBottom && <div class="session-new-wrap"><button class="session-new" type="button" aria-label="Jump to the newest entries" onClick={()=>{scrollToEnd();follow.current=true;setAtBottom(true);}}><Icon name="down" size={16}/>Jump to latest</button></div>}
   </div>
   {data.transcript === true && open.length > 0 && <section class={pinOpen ? "session-pinned session-pinned-open" : "session-pinned"} aria-label="Open decisions">
    <h2><button type="button" aria-expanded={pinOpen} onClick={togglePin}>{open.length === 1 ? "1 decision waiting" : `${open.length} decisions waiting`}<span aria-hidden="true"> ▾</span></button></h2>
    {open.map(ask=><DecisionCard key={ask.id} ask={ask} control={pinControl} level={3} contextOpen={false}/>)}
   </section>}
   {data.transcript === true && threads && <ThreadChips threads={threads}/>}
   {data.transcript === true && control && <OperatorComposer control={control} draft={draft} thread={threads}/>}
  </div>
 </div>;
}
