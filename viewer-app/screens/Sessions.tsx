import { Fragment, type ComponentChild } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { ContextUsage, SessionEntry, SessionsResponse } from "../../src/viewer/api-types.ts";
import { ContextChip, contextText } from "../components/ContextChip.tsx";
import { modelText } from "../../src/viewer/model-text.ts";
import { time } from "../format.ts";
import { sessionHref } from "../routes.ts";
import { linkify } from "../../src/viewer/linkify.ts";
import { Icon } from "../components/icons.tsx";
import { OperatorComposer } from "../components/OperatorComposer.tsx";
import { DecisionCard } from "../components/DecisionCard.tsx";
import { TranscriptAsk } from "../components/TranscriptAsk.tsx";
import { ShellContext } from "../components/Shell.tsx";
import { type ControlView, controlChip, controlLine, controlReady, deliveryLine } from "../control.ts";
import { useViewportFit } from "../viewport-fit.ts";

/** A tool call/result longer than this shows its head, with the rest behind one "show all" link. */
const TOOL_TEXT_MAX = 1200;
type Worker = SessionsResponse["workers"][number];
/** Live the way the Overview's `health()` counts it: an in-flight job whose run has not exited, held-idle included. */
export const countedLive = (w: Worker): boolean => ["waiting","held","launching"].includes(w.phase ?? "") && ["starting","working","idle"].includes(w.run_phase ?? "");
/** One remembered choice, shared by every view: absent means tool calls are hidden (cp-hidetools). */
const TOOLS_KEY = "cp-sessions-tool-calls";
function readToolCalls(): boolean {
 if (typeof window === "undefined") return false;
 try { return window.localStorage?.getItem(TOOLS_KEY) === "1"; } catch { return false; }
}
function rememberToolCalls(show: boolean) {
 try { window.localStorage?.setItem(TOOLS_KEY, show ? "1" : "0"); } catch (error) { console.warn(`tool-call toggle not persisted: ${(error as Error).message}`); }
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

/** Text with its links as elements (linkify.ts): external ones open in a new tab; nothing is ever raw HTML. */
function Linked({text,links}: {text:string;links?:Record<string,string> | undefined}) {
 return <>{linkify(text,links).map((s,i)=>s.href ? <a key={i} href={s.href} {...(s.external ? {target:"_blank",rel:"noopener noreferrer"} : {})}>{s.text}</a> : s.text)}</>;
}
function InlineText({text,links}: {text:string;links?:Record<string,string> | undefined}) {
 return <>{text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part,i)=>i % 2 === 1 && part.startsWith("`") ? <code key={i}><Linked text={part.slice(1,-1)} links={links}/></code> : i % 2 === 1 ? <strong key={i}>{part.slice(2,-2)}</strong> : <Linked key={i} text={part} links={links}/>)}</>;
}
/** A hidden run of tool calls: one faint line between messages, and clicking it opens that run alone. */
function ToolRun({entries,open,onToggle}: {entries:SessionEntry[];open:boolean;onToggle:()=>void}) {
 return <div class="session-tool-run">
  <button type="button" class="session-tools" aria-expanded={open} onClick={onToggle}>· {entries.length} tool call{entries.length === 1 ? "" : "s"} ·</button>
  {open && entries.map(e=><Entry key={e.id} entry={e}/>)}
 </div>;
}
/** A cp-bridge wake or escalation (mobile-chat-layout): its first line, the rest and its `paths:` links behind one expander. */
function BridgeNotice({entry:e,clock}: {entry:SessionEntry;clock:ComponentChild}) {
 const [open,setOpen]=useState(false);
 const lines=e.text.split("\n");
 const links=e.paths ?? [];
 const at=links.length ? lines.findIndex(line=>line.trim() === "paths:") : -1;
 const rest=lines.slice(1,at < 0 ? undefined : at);
 const more=lines.length-1;
 return <article class="session-message session-notice session-system session-bridge">
  {clock}
  <div class="session-body">
   <div class="session-who"><span>{e.who}</span>{e.tag && <span>{e.tag}</span>}</div>
   {/* Open, the first line is text (its links clickable); the toggle stays a button with only its count. */}
   {more > 0 ? <>{open && <p><InlineText text={lines[0]!} links={e.links}/></p>}<button type="button" class="session-notice-line" aria-expanded={open} onClick={()=>setOpen(!open)}>{!open && <span>{lines[0]}</span>}<small>{more} more line{more === 1 ? "" : "s"}</small></button></>
    : <p><InlineText text={e.text} links={e.links}/></p>}
   {open && <div class="session-notice-rest">
    {rest.length > 0 && <p><InlineText text={rest.join("\n")} links={e.links}/></p>}
    {links.length > 0 && <ul class="session-notice-paths">{links.map(link=><li key={link.path}>{link.href ? <a href={link.href}>{link.path}</a> : <code>{link.path}</code>}{link.read && <a href={link.read}>read</a>}</li>)}</ul>}
   </div>}
  </div>
 </article>;
}
function Entry({entry:e}: {entry:SessionEntry}) {
 const trace=e.trace.filter(step=>step.at);
 const clock=<code class="session-time">{e.at ? time(e.at) : "-"}</code>;
 const head=e.kind === "tool" && e.text.length > TOOL_TEXT_MAX ? e.text.slice(0,TOOL_TEXT_MAX) : e.text;
 return <div class={e.failed ? "session-entry session-failed" : "session-entry"}>
  {e.kind === "tool" ? <details class="session-tool"><summary>{clock}<code>{e.name}</code><span>{e.summary}</span></summary><pre><Linked text={head} links={e.links}/></pre>{head !== e.text && <details class="session-tool-all"><summary>show all</summary><pre><Linked text={e.text.slice(TOOL_TEXT_MAX)} links={e.links}/></pre></details>}</details> :
   e.tag === "bridge" ? <BridgeNotice entry={e} clock={clock}/> :
   <article class={`session-message ${e.kind === "say" ? "session-say" : e.kind === "system" ? "session-notice session-system" : "session-notice"}`}>
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
    {data.workers.map(w => <a key={w.id} class="session-bar-worker" href={sessionHref("workers",w.id)} aria-current={data.selected === "workers" && data.session_id === w.id ? "page" : undefined} onClick={closeMenu}><span class={`session-dot session-dot-${w.phase === "held" || w.phase === "failed" ? w.phase : w.run_phase ?? "unknown"}`}/><span>{w.id}</span><small>{w.phase}</small></a>)}
   </nav>
  </details>
  <span class={`shell-live shell-live-${shell.status}`} role="status" aria-label={`Data ${shell.status}`} title={shell.status}><span/></span>
  {context && <span class={`session-bar-ctx ctx-${context.level ?? "unknown"}`} title={contextText(context)}>{context.percent === null ? "ctx n/a" : `${Math.round(context.percent)}%`}</span>}
  {composer && <span class="session-bar-status" role="status" title={[controlLine(control.status),deliveryLine(control.delivery)].filter(Boolean).join(" · ")}>{controlChip(control.status,control.delivery)}</span>}
  <details class="session-bar-menu session-bar-more">
   <summary aria-label="More" title="More"><Icon name="more"/></summary>
   <div class="session-bar-sheet">
    {toolCalls > 0 && <button type="button" aria-pressed={showTools} onClick={e => { onTools(); closeMenu(e); }}>{showTools ? "Hide tool calls" : `Show tool calls (${hiddenTools})`}</button>}
    <button type="button" aria-haspopup="dialog" onClick={e => { closeMenu(e); shell.openSearch(); }}>Search</button>
    {data.transcript === true && files.length > 1 && <select aria-label="Operator session file" value={data.operator_session ?? ""} onChange={e=>{window.location.hash=`sessions?view=you&transcript=1&session=${encodeURIComponent(e.currentTarget.value)}`;}}>{files.map(s=><option key={s.id} value={s.id}>{s.id} · {time(s.at)}</option>)}</select>}
    {composer && controlReady(control.status) && control.status.session_file && <p class="session-bar-file">Delivers to <code>{control.status.session_file}</code></p>}
   </div>
  </details>
 </header>;
}
export function Sessions({data,control,draft}: {data:SessionsResponse;control?:ControlView;draft?:string}) {
 const scroller=useRef<HTMLDivElement>(null);
 const [atBottom,setAtBottom]=useState(true);
 const [showTools,setShowTools]=useState(readToolCalls);
 const [openRuns,setOpenRuns]=useState<string[]>([]);
 const lastEntry=data.entries.at(-1)?.id;
 const scrollToEnd=()=>{const el=scroller.current; if(el) el.scrollTop=el.scrollHeight;};
 useEffect(()=>{if(atBottom) scrollToEnd();},[lastEntry,showTools,openRuns]);
 const follow=useRef(true);
 const [pinOpen,setPinOpen]=useState(false);
 // Any answer from the pinned sheet (a button, or "Other answer") collapses it back to its one-line bar.
 const pinControl=control && {...control,send:(body:Parameters<ControlView["send"]>[0],ask?:string)=>{setPinOpen(false); control.send(body,ask);}};
// The on-screen keyboard shrinks — and, on iOS, pans — the visual viewport: keep the shell on the visible
// slice and the page itself un-panned, so the composer sits above the keyboard with the chat history above it.
useViewportFit(()=>{if(follow.current) scrollToEnd();});
 // A tap outside an open top-bar or composer menu closes it.
 useEffect(()=>{
  const outside=(e:Event)=>{for(const menu of document.querySelectorAll<HTMLDetailsElement>(".session-bar-menu[open], .operator-composer-more[open]")) if(!menu.contains(e.target as Node)) menu.open=false;};
  document.addEventListener("pointerdown",outside);
  return ()=>document.removeEventListener("pointerdown",outside);
 },[]);
 const rowList=rows(data.entries);
 const toolCalls=data.entries.filter(e=>e.kind === "tool").length;
 const hiddenTools=rowList.reduce((n,row)=>row.kind === "run" && !openRuns.includes(row.key) ? n+row.entries.length : n,0);
 const toggleTools=()=>{const next=!showTools; setShowTools(next); rememberToolCalls(next); setOpenRuns([]);};
 const toggleRun=(key:string)=>setOpenRuns(open=>open.includes(key) ? open.filter(k=>k!==key) : [...open,key]);
 const row=(href:string,label:string,meta:string,selected:boolean,phase:string,context?:ContextUsage | null,showModel=false)=><a href={href} aria-current={selected ? "page" : undefined} class="session-choice"><span class={`session-dot session-dot-${phase}`}/><span><strong>{label}</strong><small>{meta}</small>{showModel && context && <small class="session-model">{modelText(context)}</small>}<ContextChip usage={context} compact/></span></a>;
 const files=data.operator_sessions ?? [], open=data.open_asks ?? [];
 const context=data.selected === "you" ? data.operator_context : data.selected === "parent" ? data.parent.context : data.workers.find(w=>w.id===data.session_id)?.context;
 return <div class="sessions">
  <aside class="session-sidebar" aria-label="Session streams">
   <section><h2>Operator ↔ you</h2>{row(sessionHref("you"),"Operator session",data.selected === "you" && data.transcript ? "Full transcript" : "Recorded decisions and questions",data.selected === "you","unknown",data.operator_context,true)}</section>
   <section><h2>CP parent</h2>{row(sessionHref("parent"),"CP parent",data.parent.live ? "recent activity" : "idle",data.selected === "parent",data.parent.live ? "working" : "unknown",data.parent.context,true)}</section>
   <section><h2>Workers · {data.workers.filter(countedLive).length} live</h2>{data.workers.map(w=><div key={w.id}>{row(sessionHref("workers",w.id),w.id,modelText({model:w.context?.model ?? w.model,thinking:w.thinking}),data.session_id === w.id,w.phase === "held" || w.phase === "failed" ? w.phase : w.run_phase ?? "unknown",w.context)}</div>)}{!data.workers.length && <p>No workers</p>}</section>
  </aside>
  <div class="session-panel">
   <SessionBar data={data} control={control} context={context} toolCalls={toolCalls} showTools={showTools} hiddenTools={hiddenTools} onTools={toggleTools}/>
   <header class="session-heading"><div><strong>{data.title}</strong><span>{data.subtitle}</span><ContextChip usage={context}/></div>
    {/* Audit P4 #27: no Decisions | Full transcript toggle; the decision log lives on the Decisions page (a refused transcript still falls back silently). */}
    {data.transcript === true && files.length > 1 && <select aria-label="Operator session file" value={data.operator_session ?? ""} onChange={e=>{window.location.hash=`sessions?view=you&transcript=1&session=${encodeURIComponent(e.currentTarget.value)}`;}}>{files.map(s=><option key={s.id} value={s.id}>{s.id} · {time(s.at)}</option>)}</select>}
    {toolCalls > 0 && <button type="button" class="session-tools-toggle" aria-pressed={showTools} onClick={toggleTools}>{showTools ? "Hide tool calls" : `Show tool calls (${hiddenTools})`}</button>}
    {data.selected === "you" && <p>{data.transcript === true ? "The operator session's own pi transcript, entry for entry, newest last." : "Trace a decision: parent’s question → operator’s answer → the message you saw."}</p>}</header>
   <div class="session-transcript" role="region" aria-label="Transcript" ref={scroller} onScroll={()=>{const el=scroller.current; if(el){follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<48; setAtBottom(follow.current);}}}>
    <div class="session-entries">{data.warnings.map(w=><p class="session-warning" role="alert" key={w}>{w}</p>)}{data.truncated && <p class="session-empty">Recent entries only</p>}{!data.entries.length && <p class="session-empty">No recorded entries</p>}{rowList.map(row=>row.kind === "entry" ? <Entry key={row.entry.id} entry={row.entry}/> : showTools ? <Fragment key={row.key}>{row.entries.map(e=><Entry key={e.id} entry={e}/>)}</Fragment> : <ToolRun key={row.key} entries={row.entries} open={openRuns.includes(row.key)} onToggle={()=>toggleRun(row.key)}/>)}</div>
    {!atBottom && <div class="session-new-wrap"><button class="session-new" type="button" aria-label="Jump to the newest entries" onClick={()=>{scrollToEnd();follow.current=true;setAtBottom(true);}}><Icon name="down" size={16}/>New</button></div>}
   </div>
   {data.transcript === true && open.length > 0 && <section class={pinOpen ? "session-pinned session-pinned-open" : "session-pinned"} aria-label="Open decisions">
    <h2><button type="button" aria-expanded={pinOpen} onClick={()=>setPinOpen(!pinOpen)}>{open.length === 1 ? "1 decision waiting" : `${open.length} decisions waiting`}<span aria-hidden="true"> ▾</span></button></h2>
    {open.map(ask=><DecisionCard key={ask.id} ask={ask} control={pinControl} level={3} contextOpen={false}/>)}
   </section>}
   {data.transcript === true && control && <OperatorComposer control={control} draft={draft}/>}
  </div>
 </div>;
}
