import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JobResponse } from "../../src/viewer/api-types.ts";
import type { ProjectSelection } from "../project-filter.ts";
import { jobHref } from "../routes.ts";
import { JobDetail } from "../screens/JobDetail.tsx";
import { useScreenData } from "../use-screen-data.ts";
import { Icon } from "./icons.tsx";
import { JobsDrawer } from "./JobsDrawer.tsx";
import "./workspace.css";

/** Ctrl/Cmd+J, matched the way Shell matches Ctrl/Cmd+K. */
const jobsKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing && e.key?.toLowerCase() === "j";
/** Another dialog or an open menu owns Escape first (search, the header and ⋯ menus, the composer's). */
const OWNERS = "dialog[open]:not(.workspace-jobs), .page-header-end details[open], .session-bar-menu[open], .operator-composer details[open]";

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
 * The operator chat's Jobs drawer and the job picked from it (M3). `active` (the operator chat is on screen) registers
 * Ctrl/Cmd+J; leaving removes it, so no other screen sees it. Escape closes the top surface, focus back on the opener.
 */
export function useWorkspaceSurfaces(active: boolean, selection: ProjectSelection): {trigger: ComponentChild; surfaces: ComponentChild} {
 const [drawer, setDrawer] = useState(false);
 const [job, setJob] = useState<string | null>(null);
 const opener = useRef<HTMLElement | null>(null);
 const restore = () => { const el = opener.current; opener.current = null; if (el?.isConnected) el.focus(); };
 const openDrawer = (from: HTMLElement | null) => { if (!drawer && !job) opener.current = from; setDrawer(true); };
 const closeDrawer = () => { setDrawer(false); if (!job) restore(); };
 const closeJob = () => { setJob(null); restore(); };
 useEffect(() => {
  if (!active) return;
  const key = (e: KeyboardEvent) => {
   if (jobsKey(e)) { e.preventDefault(); if (drawer) closeDrawer(); else openDrawer(document.activeElement as HTMLElement | null); }
   else if (e.key === "Escape" && (drawer || job) && !e.defaultPrevented && !document.querySelector(OWNERS)) { e.preventDefault(); if (drawer) closeDrawer(); else closeJob(); }
  };
  window.addEventListener("keydown", key);
  return () => window.removeEventListener("keydown", key);
 }, [active, drawer, job]);
 if (!active) return {trigger: null, surfaces: null};
 return {
  trigger: <button type="button" class="workspace-jobs-open" aria-haspopup="dialog" aria-expanded={drawer} title="Jobs (Ctrl/⌘ J)" onClick={e => openDrawer(e.currentTarget)}>Jobs<kbd>⌘J</kbd></button>,
  surfaces: <>{job && <JobPane key={job} id={job} onClose={closeJob}/>}{drawer && <JobsDrawer selection={selection} onClose={closeDrawer} onSelect={id => { setJob(id); setDrawer(false); }}/>}</>,
 };
}
