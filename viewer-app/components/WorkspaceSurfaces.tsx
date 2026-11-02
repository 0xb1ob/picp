import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AwaitingDetail, JobResponse, SessionsResponse } from "../../src/viewer/api-types.ts";
import { matchesProject, type ProjectSelection, selectionHash, selectionValue } from "../project-filter.ts";
import { jobHref, sessionHref } from "../routes.ts";
import { JobDetail } from "../screens/JobDetail.tsx";
import { useScreenData } from "../use-screen-data.ts";
import { ConversationContext } from "./ConversationContext.tsx";
import { Icon } from "./icons.tsx";
import { JobsDrawer } from "./JobsDrawer.tsx";
import { SessionDrawer } from "./SessionDrawer.tsx";
import "./workspace.css";

/** Ctrl/Cmd+J, matched the way Shell matches Ctrl/Cmd+K. */
const jobsKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing && e.key?.toLowerCase() === "j";
/** Another dialog or an open menu owns Escape first (search, the header and ⋯ menus, the composer's). */
const OWNERS = "dialog[open]:not(.workspace-jobs):not(.workspace-context):not(.workspace-sessions), .page-header-end details[open], .session-bar-menu[open], .operator-composer details[open]";
const nowWide = () => typeof matchMedia === "function" ? matchMedia("(min-width: 900px)").matches : true;
/** What the chat lends its context and Conversations surfaces; `chats` renders the Chats list with an Operator href. */
export interface ChatContext {
 session: string | null; asks: AwaitingDetail[]; live: SessionsResponse["workers"]; chats: (operatorHref: string) => ComponentChild; onAnswer: () => void;
}

/** One job beside the chat (desktop) or over it (phone): the existing job page, embedded, with a way back. */
function JobPane({id, onClose}: {id: string; onClose: () => void}) {
 const resource = useScreenData<JobResponse>(`/api/job/${encodeURIComponent(id)}`, "/api/stream?view=job");
 const close = useRef<HTMLButtonElement>(null);
 useEffect(() => { close.current?.focus(); }, [id]);
 return <section class="workspace-job" aria-label={`Job ${id}`}>
  <header class="workspace-job-bar">
   <code title={id}>{id}</code>
   <a class="workspace-full" href={jobHref(id)}>Full page</a>
   <button ref={close} type="button" class="workspace-close" aria-label="Close job" onClick={onClose}><Icon name="close"/></button>
  </header>
  <div class="workspace-job-body">
   {resource.error && <p role="alert">{resource.error}{resource.data && " · showing last recorded data"}</p>}
   {resource.data ? <JobDetail key={id} data={resource.data} wide={false} embedded/> : <p role="status">{resource.error ? "Job unavailable" : "Loading"}</p>}
  </div>
 </section>;
}

/**
 * The operator chat's Jobs drawer, the job picked from it, its context (inspector or phone sheet) and the phone's
 * Conversations drawer (M3). `active` registers Ctrl/Cmd+J; leaving, or another session file, drops every surface.
 * Escape closes the top surface; focus goes back to the opener.
 */
export function useWorkspaceSurfaces(active: boolean, selection: ProjectSelection, chat: ChatContext): {trigger: ComponentChild; surfaces: ComponentChild; conversations: ComponentChild} {
 const [drawer, setDrawer] = useState(false);
 const [job, setJob] = useState<string | null>(null);
 const [panel, setPanel] = useState<"inspector" | "sheet" | null>(null);
 const [sessions, setSessions] = useState(false);
 const opener = useRef<HTMLElement | null>(null), toggle = useRef<HTMLButtonElement>(null);
 const overlays = {drawer, job: job !== null, sheet: panel === "sheet", sessions};
 const restore = () => { const el = opener.current; opener.current = null; if (el?.isConnected) el.focus(); };
 /** Focus returns only once the last overlay closes; the inspector is a panel, never an overlay. */
 const shut = (which: keyof typeof overlays) => { if (!Object.entries(overlays).some(([key, open]) => open && key !== which)) restore(); };
 const from = (el: HTMLElement | null) => { if (!Object.values(overlays).some(Boolean)) opener.current = el; };
 const openDrawer = (el: HTMLElement | null) => { from(el); setDrawer(true); setSessions(false); if (panel === "sheet") setPanel(null); };
 const closeDrawer = () => { setDrawer(false); shut("drawer"); };
 const pickJob = (id: string) => { if (panel === "inspector") from(toggle.current); setJob(id); setDrawer(false); if (panel === "sheet") setPanel(null); };
 const closeJob = () => { setJob(null); shut("job"); };
 const closePanel = () => { if (panel === "sheet") shut("sheet"); else toggle.current?.focus(); setPanel(null); };
 const closeSessions = () => { setSessions(false); shut("sessions"); };
 useEffect(() => { setDrawer(false); setJob(null); setPanel(null); setSessions(false); opener.current = null; }, [active, chat.session]);
 useEffect(() => {
  if (!active) return;
  const key = (e: KeyboardEvent) => {
   if (jobsKey(e)) { e.preventDefault(); if (drawer) closeDrawer(); else openDrawer(document.activeElement as HTMLElement | null); return; }
   if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(OWNERS) || !(drawer || sessions || panel || job)) return;
   e.preventDefault();
   if (drawer) closeDrawer(); else if (sessions) closeSessions(); else if (panel === "sheet") closePanel(); else if (job) closeJob(); else closePanel();
  };
  window.addEventListener("keydown", key);
  return () => window.removeEventListener("keydown", key);
 }, [active, drawer, job, panel, sessions]);
 if (!active) return {trigger: null, surfaces: null, conversations: null};
 const context = {asks: chat.asks, live: chat.live.filter(w => matchesProject(w.project, selection)), selection, onClose: closePanel, onJob: pickJob,
  onJobs: () => openDrawer(toggle.current), onAnswer: () => { if (panel === "sheet") closePanel(); chat.onAnswer(); }};
 const asked = chat.asks.length;
 return {
  trigger: <>
   <button type="button" class="workspace-jobs-open" aria-haspopup="dialog" aria-expanded={drawer} title="Jobs (Ctrl/⌘ J)" onClick={e => openDrawer(e.currentTarget)}>Jobs<kbd>⌘J</kbd></button>
   <button ref={toggle} type="button" class="workspace-context-open" aria-expanded={panel !== null} aria-label={asked ? `Context, ${asked} asked you` : "Context"}
    onClick={e => { if (panel) closePanel(); else if (nowWide()) setPanel("inspector"); else { from(e.currentTarget); setPanel("sheet"); } }}>Context{asked > 0 && <span class="workspace-badge workspace-badge-ask" aria-hidden="true">{asked}</span>}</button>
  </>,
  surfaces: <>
   {job && <JobPane key={job} id={job} onClose={closeJob}/>}
   {panel === "inspector" && !job && <ConversationContext {...context} sheet={false}/>}
   {panel === "sheet" && <ConversationContext {...context} sheet/>}
   {sessions && <SessionDrawer onClose={closeSessions}>{chat.chats(selectionHash(sessionHref("you"), selectionValue(selection)))}</SessionDrawer>}
   {drawer && <JobsDrawer selection={selection} onClose={closeDrawer} onSelect={pickJob}/>}
  </>,
  conversations: <button type="button" class="session-bar-icon workspace-sessions-open" aria-haspopup="dialog" aria-expanded={sessions} aria-label="Conversations"
   onClick={e => { from(e.currentTarget); setSessions(true); }}><Icon name="sessions"/></button>,
 };
}
