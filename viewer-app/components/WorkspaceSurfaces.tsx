import type { ComponentChild } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AwaitingDetail, JobResponse, JobsResponse, SessionsResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import type { ControlView } from "../control.ts";
import { matchesProject, type ProjectSelection, selectionHash, selectionValue } from "../project-filter.ts";
import { jobHref, sessionHref } from "../routes.ts";
import { phaseText } from "../format.ts";
import type { JobDetail } from "../screens/JobDetail.tsx";
import { useScreenData } from "../use-screen-data.ts";
import type { ComposerMenuContext, ThreadPicker } from "./ComposerMenu.tsx";
import { ConversationContext } from "./ConversationContext.tsx";
import { Icon } from "./icons.tsx";
import { JobsDrawer } from "./JobsDrawer.tsx";
import type { Answering } from "./QuickReplies.tsx";
import { SessionDrawer } from "./SessionDrawer.tsx";
import { type LogView, WorkspaceLog } from "./WorkspaceLog.tsx";
import "./workspace.css";

/** Ctrl/Cmd+J, matched the way Shell matches Ctrl/Cmd+K. */
const jobsKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing && e.key?.toLowerCase() === "j";
/** Another dialog or an open menu owns Escape first (search, the header and ⋯ menus, the composer's). */
const OWNERS = "dialog[open]:not(.workspace-jobs):not(.workspace-context):not(.workspace-sessions), .page-header-end details[open], .session-bar-menu[open], .operator-composer details[open]";
const nowWide = () => typeof matchMedia === "function" ? matchMedia("(min-width: 900px)").matches : true;
/** What the chat lends its context and Conversations surfaces; `chats` renders the Chats list with an Operator href. */
export interface ChatContext {
 session: string | null; asks: AwaitingDetail[]; live: SessionsResponse["workers"]; chats: (operatorHref: string) => ComponentChild; onAnswer: () => void;
 /** The chat's control and its one shared answer state: the context card answers through them, never a second path. */
 control: ControlView | undefined; answering: Answering;
 /** False for a historical transcript file: only the current chat opens its inspector by default. */
 current: boolean;
 /** Full match S11: the composer's `#` picker; absent or null hides it. */
 threads?: ThreadPicker | null;
}

type JobTab = Parameters<typeof JobDetail>[0]["initial"];
const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);
/** One job beside the chat (desktop) or over it (phone): a reply's link opens its Log, a drawer pick its Details. */
function JobPane({id, tab, onClose, worker}: {id: string; tab: JobTab; onClose: () => void; worker: SessionsResponse["workers"][number] | undefined}) {
 const resource = useScreenData<JobResponse>(`/api/job/${encodeURIComponent(id)}`, "/api/stream?view=job");
 const close = useRef<HTMLButtonElement>(null), more = useRef<HTMLDetailsElement>(null);
 const [view, setView] = useState<LogView>(tab === "transcript" ? "log" : "details");
 useEffect(() => { close.current?.focus(); }, [id]);
 const job = resource.data?.job;
 // The phone's ⋯ menu (S1's popover): Escape closes it before the pane, as does a tap outside it.
 const menuOpen = () => !!more.current?.hasAttribute("open"), closeMenu = () => more.current?.removeAttribute("open");
 const menuKey = (e: KeyboardEvent) => { if (e.key === "Escape" && menuOpen()) { e.preventDefault(); closeMenu(); more.current!.querySelector("summary")?.focus(); } };
 return <section class="workspace-job" aria-label={`Job ${id}`} onKeyDown={menuKey} onPointerDown={e => { if (menuOpen() && !more.current!.contains(e.target as Node)) closeMenu(); }}>
  <header class="workspace-job-bar">
   <div class="workspace-job-head">
    <div class="workspace-job-name"><b title={job?.title ?? id}>{job?.title ?? id}</b>{job?.title && <code title={id}>{id}</code>}</div>
    {job && <span class="workspace-job-phase">{capital(phaseText(job.phase))}</span>}
   </div>
   <a class="workspace-full" href={jobHref(id)}>Full page</a>
   <details class="workspace-job-more" ref={more}>
    <summary aria-label="More job actions" title="More"><Icon name="more"/></summary>
    <div class="workspace-job-more-sheet"><a href={jobHref(id)} onClick={closeMenu}>Full page</a></div>
   </details>
   <button ref={close} type="button" class="workspace-close" aria-label="Close job" onClick={onClose}><span class="workspace-close-back"><Icon name="back"/></span><span class="workspace-close-x"><Icon name="close"/></span></button>
  </header>
  {resource.error && resource.data && <p role="alert" class="workspace-job-alert">{resource.error} · showing last recorded data</p>}
  {resource.data ? <WorkspaceLog data={resource.data} view={view} onView={setView} initial={tab} worker={worker}/>
   : <div class="workspace-job-body">{resource.error && <p role="alert">{resource.error}</p>}<p role="status">{resource.error ? "Job unavailable" : "Loading"}</p></div>}
 </section>;
}

/**
 * The operator chat's Jobs drawer, the job picked from it, its context (inspector or phone sheet) and the phone's
 * Conversations drawer (M3). `active` registers Ctrl/Cmd+J and reads `/api/jobs` (`flight`, by exact id); leaving,
 * or another session file, drops every surface. From 900 px the current chat opens its inspector by default.
 */
export function useWorkspaceSurfaces(active: boolean, selection: ProjectSelection, chat: ChatContext): {trigger: ComponentChild; surfaces: ComponentChild; conversations: ComponentChild; composer: ComposerMenuContext | null; openJob: ((id: string, tab: JobTab, opener: HTMLElement | null) => void) | null; flight: Map<string, ViewerJob> | null} {
 const jobs = useScreenData<JobsResponse>(active ? "/api/jobs" : null, "/api/stream?view=jobs");
 const flight = jobs.data ? new Map(jobs.data.jobs.map(j => [j.id, j])) : null;
 const opened = active && chat.current && nowWide();
 const [drawer, setDrawer] = useState(false);
 const [job, setJob] = useState<{id: string; tab: JobTab} | null>(null);
 const [panel, setPanel] = useState<"inspector" | "sheet" | null>(opened ? "inspector" : null);
 const [sessions, setSessions] = useState(false);
 const opener = useRef<HTMLElement | null>(null), toggle = useRef<HTMLButtonElement>(null);
 // The user's own close of the default inspector holds until they leave the chat or reload.
 const dismissed = useRef(false);
 const overlays = {drawer, job: job !== null, sheet: panel === "sheet", sessions};
 const restore = () => { const el = opener.current; opener.current = null; if (el?.isConnected) el.focus(); };
 /** Focus returns only once the last overlay closes; the inspector is a panel, never an overlay. */
 const shut = (which: keyof typeof overlays) => { if (!Object.entries(overlays).some(([key, open]) => open && key !== which)) restore(); };
 const from = (el: HTMLElement | null) => { if (!Object.values(overlays).some(Boolean)) opener.current = el; };
 const openDrawer = (el: HTMLElement | null) => { from(el); setDrawer(true); setSessions(false); if (panel === "sheet") setPanel(null); };
 const closeDrawer = () => { setDrawer(false); shut("drawer"); };
 const openJob = (id: string, tab: JobTab, el: HTMLElement | null) => { if (el) from(el); setJob({id, tab}); setDrawer(false); if (panel === "sheet") setPanel(null); };
 // The drawer and context keep the job page's own default tab (Details in the pane).
 const pickJob = (id: string) => openJob(id, undefined, panel === "inspector" ? toggle.current : null);
 const closeJob = () => { setJob(null); shut("job"); };
 const closePanel = () => { if (panel === "sheet") shut("sheet"); else toggle.current?.focus(); setPanel(null); };
 const dismiss = () => { if (panel === "inspector") dismissed.current = true; closePanel(); };
 const closeSessions = () => { setSessions(false); shut("sessions"); };
 useEffect(() => {
  if (!active) dismissed.current = false;
  setDrawer(false); setJob(null); setPanel(opened && !dismissed.current ? "inspector" : null); setSessions(false); opener.current = null;
 }, [active, chat.session]);
 // Layout timing: the listener must see the drawer as soon as `showModal` opens it, or Escape closes a stale surface.
 useLayoutEffect(() => {
  if (!active) return;
  const key = (e: KeyboardEvent) => {
   if (jobsKey(e)) { e.preventDefault(); if (drawer) closeDrawer(); else openDrawer(document.activeElement as HTMLElement | null); return; }
   if (e.key !== "Escape" || e.isComposing || e.defaultPrevented || document.querySelector(OWNERS) || !(drawer || sessions || panel || job)) return;
   e.preventDefault();
   if (drawer) closeDrawer(); else if (sessions) closeSessions(); else if (panel === "sheet") closePanel(); else if (job) closeJob(); else dismiss();
  };
  window.addEventListener("keydown", key);
  return () => window.removeEventListener("keydown", key);
 }, [active, drawer, job, panel, sessions]);
 // The mode was picked at open time: crossing 900 px closes it, so no hidden inspector or desktop sheet stays expanded.
 useEffect(() => {
  if (!active || !panel || typeof matchMedia !== "function") return;
  const query = matchMedia("(min-width: 900px)"), change = () => { if (panel === "sheet" || !job) closePanel(); else setPanel(null); };
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
 }, [active, panel, job]);
 if (!active) return {trigger: null, surfaces: null, conversations: null, composer: null, openJob: null, flight: null};
 const context = {asks: chat.asks, live: chat.live.filter(w => matchesProject(w.project, selection)), selection, onClose: dismiss, onJob: pickJob,
  control: chat.control, answering: chat.answering, jobs: flight, jobsError: jobs.error, current: chat.current,
  onJobs: () => openDrawer(toggle.current), onAnswer: () => { if (panel === "sheet") closePanel(); chat.onAnswer(); }};
 const asked = chat.asks.length;
 return {
  trigger: <>
   <button type="button" class="workspace-jobs-open" aria-haspopup="dialog" aria-expanded={drawer} title="Jobs (Ctrl/⌘ J)" onClick={e => openDrawer(e.currentTarget)}>Jobs<kbd>⌘J</kbd></button>
   <button ref={toggle} type="button" class="workspace-context-open" aria-expanded={panel !== null} aria-label={asked ? `Context, ${asked} asked you` : "Context"} title="Context"
    onClick={e => { if (panel) dismiss(); else if (nowWide()) setPanel("inspector"); else { from(e.currentTarget); setPanel("sheet"); } }}><Icon name="panel"/>{asked > 0 && <span class="workspace-badge workspace-badge-ask" aria-hidden="true">{asked}</span>}</button>
  </>,
  surfaces: <>
   {job && <JobPane key={`${job.id}:${job.tab}`} id={job.id} tab={job.tab} onClose={closeJob} worker={chat.live.find(w => w.job_id === job.id)}/>}
   {panel === "inspector" && !job && <ConversationContext {...context} sheet={false}/>}
   {panel === "sheet" && <ConversationContext {...context} sheet/>}
   {sessions && <SessionDrawer onClose={closeSessions}>{chat.chats(selectionHash(sessionHref("you"), selectionValue(selection)))}</SessionDrawer>}
   {drawer && <JobsDrawer selection={selection} onClose={closeDrawer} onSelect={pickJob}/>}
  </>,
  conversations: <button type="button" class="session-bar-icon workspace-sessions-open" aria-haspopup="dialog" aria-expanded={sessions} aria-label="Conversations"
   onClick={e => { from(e.currentTarget); setSessions(true); }}><Icon name="sessions"/></button>,
  composer: {onJobs: openDrawer, selection, threads: chat.threads},
  openJob, flight,
 };
}
