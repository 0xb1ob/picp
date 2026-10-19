import { ToolRunRow } from "../components/ToolRunRow.tsx";
import type { ComponentChild } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { ContextUsage, SessionEntry, SessionsResponse } from "../../src/viewer/api-types.ts";
import { contextText } from "../components/ContextChip.tsx";
import { modelText } from "../../src/viewer/model-text.ts";
import { stamp, time } from "../format.ts";
import { jobHref, jobTranscriptHref, sessionHref } from "../routes.ts";
import { InlineText, Linked, Markdown } from "../components/Markdown.tsx";
import { PrChips } from "../components/PrChip.tsx";
import { Icon } from "../components/icons.tsx";
import { OperatorComposer } from "../components/OperatorComposer.tsx";
import { DecisionCard } from "../components/DecisionCard.tsx";
import { TranscriptAsk } from "../components/TranscriptAsk.tsx";
import { TranscriptImages } from "../components/TranscriptImages.tsx";
import { TranscriptFiles } from "../components/TranscriptFiles.tsx";
import { TranscriptSkills } from "../components/TranscriptSkills.tsx";
import { PendingBubble } from "../components/PendingBubble.tsx";
import { transcriptHasSend } from "../pending-sends.ts";
import { ShellContext } from "../components/Shell.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { VersionBadge } from "../components/VersionBadge.tsx";
import { badgeView } from "../use-version.ts";
import { RestartSession, restartShown } from "../components/RestartSession.tsx";
import { type ControlView, controlReady } from "../control.ts";
import { useViewportFit } from "../viewport-fit.ts";
import { NewThread, ThreadChips, ThreadPicker, ThreadSidebar } from "../components/ThreadNav.tsx";
import { QuickReplies } from "../components/QuickReplies.tsx";
import { threadBands, threadFilter, type ThreadsView, threadsReady } from "../threads.ts";
import { dayKey, dayStarts, isOwn, lastDay, replyAsk, rollups, type Row, rowHead, rows } from "../session-rows.ts";
import { RelayRollup } from "../components/RelayRollup.tsx";

/** A tool call/result longer than this shows its head, with the rest behind one "show all" link. */
const TOOL_TEXT_MAX = 1200;
type Worker = SessionsResponse["workers"][number];
/** Live the way the Overview's `health()` counts it: an in-flight job whose run has not exited, held-idle included. */
export const countedLive = (w: Worker): boolean => ["waiting","held","launching"].includes(w.phase ?? "") && ["starting","working","idle"].includes(w.run_phase ?? "");
/** The context percent alone (`16%`, or `ctx 16%` with `label`): the full figures sit in its title. */
function CtxPct({usage,label=false}: {usage:ContextUsage | null | undefined;label?:boolean}) {
 if (!usage) return null;
 const text = usage.percent === null ? "ctx n/a" : `${label ? "ctx " : ""}${Math.round(usage.percent)}%`;
 return <span class={`session-ctx ctx-${usage.level ?? "unknown"}`} title={contextText(usage)}>{text}</span>;
}
const workerPhase = (w: Worker): string => w.run_phase ?? "no run status";
const workerDot = (w: Worker): string => w.phase === "held" || w.phase === "failed" ? w.phase : w.run_phase ?? "unknown";
/**
 * The conversation header's state line and dot, from recorded facts only: missing busy is unknown (never Idle), an older
 * file names no model, and a parent's recorded activity is not liveness.
 */
function headerState(data: SessionsResponse, status: ControlView["status"] | undefined, history: boolean): {text: string; dot: string} {
 if (data.selected === "parent") return {text: `${data.parent.live ? "Recorded activity" : "No recent recorded activity"} · ${modelText(data.parent.context ?? {})}`, dot: data.parent.live ? "working" : "unknown"};
 const w = data.selected === "workers" ? data.workers.find(w => w.id === data.session_id) : undefined;
 if (w) return {text: `${workerPhase(w)} · ${modelText({model: w.context?.model ?? w.model, thinking: w.thinking})}`, dot: workerDot(w)};
 if (data.selected !== "you" || data.transcript !== true) return {text: data.subtitle, dot: "unknown"};
 if (history) return {text: "Historical transcript", dot: "unknown"};
 const state = !status ? "Checking status" : "error" in status ? "Status unavailable" : !status.enabled ? "Dashboard control off" : status.offline ? "Offline"
  : !status.running ? "Not running" : status.busy === true ? "Working" : status.busy === false ? "Idle" : "Status unknown";
 return {text: `${state} · ${modelText(data.operator_context ?? {})}`, dot: state === "Working" ? "working" : state === "Idle" ? "idle" : "unknown"};
}
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

const isBubble = (e: SessionEntry) => e.kind === "say" || e.kind === "via";
/** Consecutive messages from one author within this gap share one header (who and time). */
const GROUP_GAP_MS = 5 * 60_000;
/** An opened relay longer than this many lines shows its head, the rest behind "Show more". */
const RELAY_LINES = 6;
/**
 * Bubbles that open a group: the first, a new author or day, after a notice or card, or a long gap.
 * Tool calls never split a group; a run of steps holding a wake notice does.
 */
function groupStarts(rowList: Row[], days: Map<string,string>): Set<string> {
 const starts = new Set<string>();
 let prev: SessionEntry | undefined;
 for (const row of rowList) {
  if (row.kind === "steps") { if (row.notice) prev = undefined; continue; }
  if (row.kind === "rollup") { for (const id of groupStarts(row.turns.flat(), days)) starts.add(id); prev = undefined; continue; }
  const e = row.entry;
  if (!isBubble(e)) { prev = undefined; continue; }
  const gap = prev && e.at && prev.at ? Date.parse(e.at)-Date.parse(prev.at) : 0;
  if (!prev || days.has(e.id) || prev.who !== e.who || !(gap <= GROUP_GAP_MS)) starts.add(e.id);
  prev = e;
 }
 return starts;
}
/**
 * A run of steps (chat v2): one pill opening one card — the wake notice with its own toggle, compact tool rows and,
 * for a recorded job, its transcript link. Tools on (no `onToggle`) shows every card open, without pills.
 */
function Steps({row,open,onToggle}: {row:Extract<Row,{kind:"steps"}>;open:boolean;onToggle?:()=>void}) {
 const job=row.notice?.bridge?.job ?? null;
 // Open, a summary preview would repeat the first row right below it; the job id never does.
 return <ToolRunRow steps count={row.entries.length+(row.notice ? 1 : 0)} detail={job ?? (open ? null : row.entries.find(e=>e.summary)?.summary)} open={open} onToggle={onToggle} notice={row.notice && <BridgeNotice entry={row.notice} clock={clockOf(row.notice)} chips/>}>
  <div class="session-steps-rows">{row.entries.map(e=><Entry key={e.id} entry={e}/>)}</div>
  {job && <a class="session-steps-link" href={jobTranscriptHref(job)}>Open job transcript →</a>}
 </ToolRunRow>;
}
const clockOf=(e:SessionEntry)=><code class="session-time">{dayKey(e.at) ? time(e.at) : "-"}</code>;
const dayPill=(id:string,at:string,label:string)=><p key={`day-${id}`} class="session-day"><time dateTime={dayKey(at)!}>{label}</time></p>;
const baseName=(path:string)=>path.replace(/\/+$/,"").split("/").at(-1) || path;
/** A parsed cp-bridge notice: one row (chip, verb, job, receipt, notice toggle), the body below; `chips`: basenames. */
function BridgeNotice({entry:e,clock,chips=false}: {entry:SessionEntry;clock:ComponentChild;chips?:boolean}) {
 const [open,setOpen]=useState(false);
 const b=e.bridge!;
 const lines=e.text.length ? e.text.split("\n") : [];
 const links=e.paths ?? [];
 const at=links.length ? lines.findIndex(line=>line.trim() === "paths:") : -1;
 const prose=(at < 0 ? lines : lines.slice(0,at)).join("\n").replace(/\n+$/,"");
 const multi=e.text.includes("\n");
 const receipt=b.receipt?.replaceAll("_", " ");
 return <article class="session-message session-notice session-system session-bridge">
  {clock}
  <div class="session-body">
   <div class="session-bridge-line">
    <span class="session-bridge-chip">bridge</span>
    <span class="session-bridge-what">{b.kind === "wake" ? "woke" : b.kind.replaceAll("_", " ")}{b.job && <> <a href={jobHref(b.job)}>{b.job}</a></>}</span>
    {receipt && <small class="session-bridge-receipt">· {receipt}</small>}
    {multi && <button type="button" class="session-notice-line" aria-expanded={open} aria-label={open ? "Hide notice" : "Show notice"} onClick={()=>setOpen(!open)}>notice <span aria-hidden="true">{open ? "▾" : "▸"}</span></button>}
   </div>
   {multi ? open && <div class="session-notice-rest">{prose && <p><InlineText text={prose} links={e.links}/></p>}{links.length > 0 && <ul class={chips ? "session-notice-paths session-notice-chips" : "session-notice-paths"}>{links.map(link=><li key={link.path}>{link.href ? <a href={link.href} title={link.path}>{chips ? baseName(link.path) : link.path}</a> : <code title={link.path}>{chips ? baseName(link.path) : link.path}</code>}{link.read && <a href={link.read}>read</a>}</li>)}</ul>}</div>
    : prose ? <p><InlineText text={prose} links={e.links}/></p> : null}
  </div>
 </article>;
}
/**
 * A cp-bridge wake or escalation, or any other system entry (compaction, custom messages): one muted line, the rest and a
 * relay's `paths:` links behind one expander (mobile-chat-layout). An opened relay past RELAY_LINES shows its head and "Show more".
 */
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
/** A message bubble: your side a right-hand pill, time below; the session a card under avatar, name and time. */
const initials = (who: string) => who.replace(/[^A-Za-z]/g,"").slice(0,2).toUpperCase();
function Bubble({entry:e,first,you}: {entry:SessionEntry;first:boolean;you:boolean}) {
 // In the operator transcript the person is "You" and the session they talk to is "Operator" (frame 06); other views keep the recorded name.
 const own = isOwn(e), who = you ? (own ? "You" : e.who === "Assistant" ? "Operator" : e.who) : e.who;
 // A group names its author once: later own bubbles keep only their time (the "You" name is screen-reader text).
 const meta = <div class="session-who">{own ? (you || first) && <span class={you ? "session-who-name" : undefined}>{who}</span> : <><span class={`session-avatar${who === "Operator" ? " session-avatar-bot" : ""}`} aria-hidden="true">{initials(who)}</span><span>{who}</span></>}{e.project && <span class="session-project">{e.project}</span>}{e.tag && <span>{e.tag}</span>}{dayKey(e.at) && <time class="session-time" dateTime={e.at}>{time(e.at)}</time>}</div>;
 return <article class={`session-message session-say session-bubble ${own ? "session-own" : "session-other"}${first ? "" : " session-grouped"}`}>
  {!own && first && meta}
  <div class="session-body"><Markdown text={e.text} links={e.links}/>{e.images?.length ? <TranscriptImages ids={e.images}/> : null}{e.files?.length ? <TranscriptFiles ids={e.files} metadata={e.file_metadata}/> : null}{e.skills?.length ? <TranscriptSkills names={e.skills}/> : null}{e.send_id && <code class="session-send">send {e.send_id}</code>}{e.dashboard_id && <code class="session-send">dashboard {e.dashboard_id}{e.ask_id ? ` · ${e.ask_id}` : ""}</code>}</div>
  {own && meta}
 </article>;
}
function Entry({entry:e,first=true,you=false}: {entry:SessionEntry;first?:boolean;you?:boolean}) {
 const trace=e.trace.filter(step=>step.at);
 const clock=clockOf(e);
 const head=e.kind === "tool" && e.text.length > TOOL_TEXT_MAX ? e.text.slice(0,TOOL_TEXT_MAX) : e.text;
 return <div class={e.failed ? "session-entry session-failed" : "session-entry"}>
  {e.kind === "tool" ? <details class="session-tool"><summary>{clock}<code title={e.name ?? undefined}>{e.name === "thinking" ? "think" : e.name}</code><span>{e.summary}</span></summary><pre><Linked text={head} links={e.links} chips={false}/></pre>{head !== e.text && <details class="session-tool-all"><summary>show all</summary><pre><Linked text={e.text.slice(TOOL_TEXT_MAX)} links={e.links} chips={false}/></pre></details>}</details> :
   e.kind === "system" || e.tag === "bridge" ? (e.bridge ? <BridgeNotice entry={e} clock={clock}/> : <Notice entry={e} clock={clock}/>) :
   isBubble(e) ? <Bubble entry={e} first={first} you={you}/> :
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
 * The phone top bar (chat v2): back, avatar, the name (a menu with every session) over the # thread filter or the state
 * line, and one ⋯ sheet: the state with ctx, the thread chips (New, Mark done), tools, search, file, version, restart.
 * It replaces the shell header and the heading below 900 px; desktop keeps its sidebar and heading.
 */
const sessionWhen = new Intl.DateTimeFormat("en",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
function sessionOptionLabel(at: string, current: boolean): string {
 const date = new Date(at), when = Number.isNaN(date.getTime()) ? at : sessionWhen.format(date);
 return current ? `${when} · current` : when;
}
const fileOptions = (files: {id:string;at:string}[]) => files.map((s,i)=><option key={s.id} value={s.id} title={s.id}>{sessionOptionLabel(s.at,i === 0)}</option>);
function SessionBar({data,control,context,toolCalls,showTools,hiddenTools,onTools,threads,state}: {data:SessionsResponse;control:ControlView | undefined;context:ContextUsage | null | undefined;toolCalls:number;showTools:boolean;hiddenTools:number;onTools:()=>void;threads:ThreadsView | false | undefined;state:{text:string;dot:string}}) {
 const shell = useContext(ShellContext);
 const composer = data.transcript === true && control;
 const files = data.operator_sessions ?? [];
 const views = [["you","Operator ↔ you"],["parent","CP parent"],["workers","Workers"]] as const;
 const filter = threads && threadsReady(threads.status);
 const alert = !!shell.version && badgeView(shell.version, null).level === "alert";
 // The name is text: the # filter's select covers the whole name column (a 48 px target); switching lives in ⋯.
 return <header class="session-bar">
  <a class="session-bar-icon" href="#overview" aria-label="Back to Overview"><Icon name="back"/></a>
  {data.selected !== "workers" && <span class={data.selected === "you" ? "session-avatar session-avatar-bot" : "session-avatar"} aria-hidden="true">{data.selected === "you" ? "OP" : "CP"}</span>}
  <div class="session-bar-id">
   <strong>{data.selected === "you" && data.transcript === true ? "Operator" : data.title}</strong>
   <span class="session-bar-sub"><span class={`session-dot session-dot-${state.dot}`} role="img" aria-label={state.text} title={state.text}/>{filter ? <ThreadPicker threads={threads} filter/> : <span aria-hidden="true">{state.text}</span>}</span>
  </div>
  <span class={`shell-live shell-live-${shell.status}`} role="status" aria-label={`Data ${shell.status}`} title={shell.status}><span/></span>
  <details class="session-bar-menu session-bar-more">
   <summary aria-label="More" title="More"><Icon name="more"/>{alert && <span class="shell-more-dot" role="status" aria-label="Version alert"/>}</summary>
   <div class="session-bar-sheet">
    <p class="session-bar-state" role="status"><span class={`session-dot session-dot-${state.dot}`}/><span>{state.text}</span><CtxPct usage={context} label/></p>
    <nav class="session-bar-views" aria-label="Session streams">
     {views.map(([id,label]) => <a key={id} href={sessionHref(id)} aria-current={data.selected === id ? "page" : undefined} onClick={closeMenu}>{label}</a>)}
     {data.workers.map(w => <a key={w.id} class="session-bar-worker" href={sessionHref("workers",w.id)} aria-current={data.selected === "workers" && data.session_id === w.id ? "page" : undefined} onClick={closeMenu}><span class={`session-dot session-dot-${workerDot(w)}`}/><span>{w.id}</span><small>{workerPhase(w)}</small></a>)}
    </nav>
    {/* Picking a thread closes the sheet; + New and Mark done keep it open for their dialog or refusal. */}
    {filter && <div class="session-bar-threads" onClick={e => { if ((e.target as Element).closest?.(".session-thread-chip:not(.session-thread-new):not(.session-thread-done)")) closeMenu(e); }}><ThreadChips threads={threads} control={control}/></div>}
    {toolCalls > 0 && <button type="button" aria-pressed={showTools} onClick={e => { onTools(); closeMenu(e); }}>{showTools ? "Hide tool calls" : `Show tool calls (${hiddenTools})`}</button>}
    <button type="button" aria-haspopup="dialog" onClick={e => { closeMenu(e); shell.openSearch(); }}>Search</button>
    {data.transcript === true && files.length > 0 && <label class="session-file-picker">Transcript<select aria-label="Operator session file" value={data.operator_session ?? ""} onChange={e=>{window.location.hash=`sessions?view=you&transcript=1&session=${encodeURIComponent(e.currentTarget.value)}`;}}>{fileOptions(files)}</select></label>}
    {composer && controlReady(control.status) && control.status.session_file && <p class="session-bar-file">Delivers to <code>{control.status.session_file}</code></p>}
    {shell.version && <div class="shell-more-version"><span>Viewer</span><VersionBadge state={shell.version} labelled/></div>}
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
 // A tap outside an open top-bar or composer menu closes it; Escape closes the top bar's ⋯ or Options, focus back on it.
 useEffect(()=>{
  const outside=(e:Event)=>{for(const menu of document.querySelectorAll<HTMLDetailsElement>(".session-bar-menu[open], .operator-composer-more[open], .operator-composer-options[open]")) if(!menu.contains(e.target as Node)) menu.open=false;};
  const escape=(e:KeyboardEvent)=>{if(e.key !== "Escape") return; const menu=document.querySelector<HTMLDetailsElement>(".session-bar-menu[open], .operator-composer-options[open]"); if(menu){menu.open=false; menu.querySelector<HTMLElement>("summary")?.focus();}};
  document.addEventListener("pointerdown",outside); document.addEventListener("keydown",escape);
  return ()=>{document.removeEventListener("pointerdown",outside); document.removeEventListener("keydown",escape);};
 },[]);
 // Operator threads (cp-xmw2): own entries, plus shared ones inside that thread's own span; pinned decisions are never filtered.
 const filter=data.transcript === true ? threadFilter(threads?.status,threads?.selected) : null, bands=threadBands(data.entries,filter), shown=bands.inside;
 // `Show N earlier / later`: what the thread filter hides around its span, collapsed until asked for; a new selection collapses them again.
 const [edges,setEdges]=useState({tag:threads?.selected ?? null,before:false,after:false});
 const edgeOpen=edges.tag === (threads?.selected ?? null) ? edges : {tag:threads?.selected ?? null,before:false,after:false};
 // A local-day separator opens each new day; a band continues from the day shown right above it.
 const beforeDay=edgeOpen.before ? lastDay(bands.before) : null, insideDay=lastDay(shown) ?? beforeDay;
 // Pending sends follow the later band only while it is open; one queued past local midnight opens its own day.
 const pendingDays=dayStarts(pending.map(send=>({id:send.key,at:send.at})),(edgeOpen.after ? lastDay(bands.after) : null) ?? insideDay);
 // Source order by id: a run of steps never spans entries the thread filter left out.
 const order=new Map(data.entries.map((e,i)=>[e.id,i]));
 const rowList=rows(shown,dayStarts(shown,beforeDay),order);
 // One renderer for the thread and its earlier/later bands: tool runs follow `showTools` / `openRuns` everywhere.
 // Tools on, every row stands alone: rollups fold relay turns only in the chat view of the operator transcript.
 const renderRows=(list:SessionEntry[],prev:string | null)=>{const days=dayStarts(list,prev), base=rows(list,days,order), rl=data.transcript === true && !showTools ? rollups(base,days,order,data.pr_chips ?? {},replyAt) : base, st=groupStarts(rl,days);
 const node=(row:Row):ComponentChild=>row.kind === "entry" ? <Entry key={row.entry.id} entry={row.entry} first={st.has(row.entry.id)} you={data.selected === "you"}/> : row.kind === "steps" ? <Steps key={row.key} row={row} open={showTools || openRuns.includes(row.key)} onToggle={showTools ? undefined : ()=>toggleRun(row.key)}/> : <RelayRollup key={row.key} row={row} render={node}/>;
 return rl.flatMap(row=>{
  const head=rowHead(row), label=days.get(head.id);
  const out=label ? [dayPill(head.id,head.at,label),node(row)] : [node(row)];
  return replies && row.kind === "entry" && row.entry.id === replyAt ? [...out,replies] : out;
 });};
 const edge=(side:"before"|"after",list:SessionEntry[],word:string,prev:string | null)=>list.length > 0 && (edgeOpen[side] ? <div class="session-edge" key={side}>{renderRows(list,prev)}</div> : <button type="button" key={side} class="session-edge-toggle" onClick={()=>setEdges({...edgeOpen,[side]:true})}><span>{list.length} {word} {list.length === 1 ? "message" : "messages"} in other threads · show</span></button>);
 const toolCalls=shown.filter(e=>e.kind === "tool").length;
 const hiddenTools=rowList.reduce((n,row)=>row.kind === "steps" && !openRuns.includes(row.key) ? n+row.entries.length : n,0);
 const toggleTools=()=>{const next=!showTools; setShowTools(next); rememberToolCalls(next); setOpenRuns([]);};
 const toggleRun=(key:string)=>setOpenRuns(open=>open.includes(key) ? open.filter(k=>k!==key) : [...open,key]);
 /** A Chats row: avatar (none on a worker nested under CP parent), name, dot, ctx, recorded time, one meta line. */
 const row=(href:string,label:string,meta:string,selected:boolean,{avatar,phase,at,context,preview=false}:{avatar?:string;phase?:string;at?:string | undefined;context?:ContextUsage | null | undefined;preview?:boolean})=><a href={href} aria-current={selected ? "page" : undefined} class={avatar ? "session-choice" : "session-choice session-choice-nested"}>
  {avatar && <span class={`session-avatar${avatar === "OP" ? " session-avatar-bot" : ""}`} aria-hidden="true">{avatar}</span>}
  <span class="session-choice-head"><strong title={label}>{label}</strong>{phase && <span class={`session-dot session-dot-${phase}`}/>}<CtxPct usage={context}/>{dayKey(at) && <time class="session-time" dateTime={at} title={stamp(at!,true)}>{time(at!)}</time>}</span>
  <small class={preview ? "session-model session-preview" : "session-model"}>{meta}</small></a>;
 const files=data.operator_sessions ?? [], open=data.open_asks ?? [];
 const context=data.selected === "you" ? data.operator_context : data.selected === "parent" ? data.parent.context : data.workers.find(w=>w.id===data.session_id)?.context;
 // The Operator preview comes only from the latest file's loaded transcript; history and other tiers keep theirs.
 const history=data.transcript === true && !!data.operator_session && !!files[0] && data.operator_session !== files[0].id;
 const last=data.selected === "you" && data.transcript === true && !history ? data.entries.findLast(e=>isBubble(e) && e.text.trim() !== "") : undefined;
 const preview=last && `${isOwn(last) ? "You: " : ""}${last.text.replace(/[`*#>|]/g,"").replace(/\s+/g," ").trim().slice(0,200)}`;
 const threadsOn=data.selected === "you" && data.transcript === true && threads;
 // Quick replies follow the newest shown operator-session message or card (else the rows), before the pending tail.
 const replyTo=data.selected === "you" && data.transcript === true && !history ? replyAsk(data.entries,open,filter) : null;
 const replies=replyTo && <QuickReplies key={`replies-${replyTo.id}`} ask={replyTo} control={control}/>;
 const replyAt=replies ? shown.findLast(e=>!isOwn(e) && (isBubble(e) || e.kind === "ask"))?.id : undefined;
 const state=headerState(data,control?.status,history);
 return <div class="sessions">
  {/* The ⋮ menu carries the transcript file and the tool-call toggle; the phone's ⋯ sheet keeps its own. */}
  <PageHeader title="Chats" menu={(files.length > 0 && data.transcript === true) || toolCalls > 0 ? <div class="session-menu">
   {/* Audit P4 #27: the decision log lives on the Decisions page; a refused transcript still falls back silently. */}
   {data.transcript === true && files.length > 0 && <label class="session-file-picker">Transcript<select aria-label="Operator session file" value={data.operator_session ?? ""} onChange={e=>{window.location.hash=`sessions?view=you&transcript=1&session=${encodeURIComponent(e.currentTarget.value)}`;}}>{fileOptions(files)}</select></label>}
   {toolCalls > 0 && <button type="button" class="session-tools-toggle" aria-pressed={showTools} aria-label={showTools ? "Hide tool calls" : `Show tool calls (${hiddenTools})`} title={showTools ? "Hide tool calls" : `Show tool calls (${hiddenTools})`} onClick={toggleTools}>Tools {toolCalls}</button>}
  </div> : undefined}/>
  {threadsOn && threadsReady(threadsOn.status) && <NewThread threads={threadsOn} control={control} class="session-chats-new" label="+"/>}
  <aside class="session-sidebar" aria-label="Session streams">
   <section aria-label="Operator">{row(sessionHref("you"),"Operator",history ? "Historical transcript" : preview || modelText(data.operator_context ?? {}),data.selected === "you",{avatar:"OP",at:last?.at,context:preview ? null : data.operator_context,preview:!!preview})}</section>
   {threadsOn && <ThreadSidebar threads={threadsOn}/>}
   <section><h2>Fleet · {data.workers.filter(countedLive).length} live</h2>{row(sessionHref("parent"),"CP parent",`${modelText(data.parent.context ?? {})} · ${data.parent.live ? "recent activity" : "no recent activity"}`,data.selected === "parent",{avatar:"CP",phase:data.parent.live ? "working" : "unknown",at:data.parent.last_activity,context:data.parent.context})}{data.workers.map(w=><div key={w.id}>{row(sessionHref("workers",w.id),w.id,`${modelText({model:w.context?.model ?? w.model,thinking:w.thinking})} · ${workerPhase(w)}`,data.session_id === w.id,{phase:workerDot(w),at:w.last_activity,context:w.context})}</div>)}{!data.workers.length && <p>No workers</p>}</section>
  </aside>
  <div class="session-panel">
   <SessionBar data={data} control={control} context={context} toolCalls={toolCalls} showTools={showTools} hiddenTools={hiddenTools} onTools={toggleTools} threads={threadsOn} state={state}/>
   <header class="session-heading">{data.selected !== "workers" && <span class={data.selected === "you" ? "session-avatar session-avatar-bot" : "session-avatar"} aria-hidden="true">{data.selected === "you" ? "OP" : "CP"}</span>}
    <div><strong>{data.selected === "you" && data.transcript === true ? "Operator" : data.title}</strong><span class="session-heading-state"><span class={`session-dot session-dot-${state.dot}`}/><span>{state.text}</span><CtxPct usage={context} label/></span></div>
    {threadsOn && <ThreadPicker threads={threadsOn} filter/>}
    {data.selected === "you" && data.transcript !== true && <p>Trace a decision: parent’s question → operator’s answer → the message you saw.</p>}</header>
   {control?.pending_error && <p class="session-warning" role="status" aria-live="polite" aria-atomic="true">{control.pending_error}</p>}
   {control?.pending && <p class="session-pending-live" aria-live="polite" aria-atomic="true">{pending.length ? pending.map(send=>`Message at ${time(send.at)}: ${send.state}${send.reason ? `, ${send.reason}` : ""}`).join(". ") : "No pending messages"}</p>}
   <div class="session-transcript" role="region" aria-label="Transcript" ref={scroller} onScroll={()=>{const el=scroller.current; if(el){follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<48; setAtBottom(follow.current);}}}>
    <div class="session-entries"><PrChips.Provider value={data.pr_chips ?? {}}>{data.warnings.map(w=><p class="session-warning" role="alert" key={w}>{w}</p>)}{control?.status && !("error" in control.status) && control.status.sends_error && <p class="session-warning" role="alert">Queued messages unavailable: {control.status.sends_error}</p>}{data.truncated && <p class="session-empty">Recent entries only</p>}{!data.entries.length && !pending.length && <p class="session-empty">No recorded entries</p>}{filter === "none" && !pending.length && <p class="session-empty">No messages in {threads?.selected} yet</p>}{edge("before",bands.before,"earlier",null)}{renderRows(shown,beforeDay)}{edge("after",bands.after,"later",insideDay)}{!replyAt && replies}{pending.flatMap(send=>{const label=pendingDays.get(send.key), node=<PendingBubble key={send.key} send={send} position={queued.indexOf(send)+1} total={queued.length} control={control!} viewing={data.operator_session ?? null} truncated={data.truncated === true}/>; return label ? [dayPill(send.key,send.at,label),node] : [node];})}</PrChips.Provider></div>
    {!atBottom && <div class="session-new-wrap"><button class="session-new" type="button" aria-label="Jump to the newest entries" onClick={()=>{scrollToEnd();follow.current=true;setAtBottom(true);}}><Icon name="down" size={16}/>Jump to latest</button></div>}
   </div>
   {data.transcript === true && open.length > 0 && <section class={pinOpen ? "session-pinned session-pinned-open" : "session-pinned"} aria-label="Open decisions">
    <h2><button type="button" aria-expanded={pinOpen} onClick={togglePin}>{open.length === 1 ? "1 decision waiting" : `${open.length} decisions waiting`}<span aria-hidden="true"> ▾</span></button></h2>
    {open.map(ask=><DecisionCard key={ask.id} ask={ask} control={pinControl} level={3} contextOpen={false}/>)}
   </section>}
   {data.transcript === true && control && <OperatorComposer control={control} draft={draft} thread={threads}/>}
  </div>
 </div>;
}
