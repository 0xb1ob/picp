import { useLayoutEffect, useRef } from "preact/hooks";
import type { AwaitingDetail, SessionsResponse } from "../../src/viewer/api-types.ts";
import { modelText } from "../../src/viewer/model-text.ts";
import { money, time } from "../format.ts";
import type { ProjectSelection } from "../project-filter.ts";
import { sessionHref } from "../routes.ts";
import { contextText } from "./ContextChip.tsx";
import { Icon } from "./icons.tsx";

type Worker = SessionsResponse["workers"][number];
export interface ContextProps {
 asks: AwaitingDetail[]; live: Worker[]; selection: ProjectSelection;
 onClose: () => void; onAnswer: () => void; onJob: (id: string) => void; onJobs: () => void;
}
const NONE = "not recorded";

/** The open asks (answered in the pinned block) and live workers; nothing the transcript does not record is shown. */
function Body({asks, live, selection, onClose, onAnswer, onJob, onJobs}: ContextProps) {
 return <>
  <header class="workspace-context-head">
   <h2>This conversation</h2>
   <span>{!selection ? "All projects" : "project" in selection ? selection.project : "Untagged"}</span>
   <button type="button" class="workspace-close" aria-label="Close context" onClick={onClose}><Icon name="close"/></button>
  </header>
  <div class="workspace-context-body">
   <section aria-label="Asked you">
    <h3 class={asks.length ? "workspace-context-asked" : undefined}>Asked you · {asks.length}</h3>
    {asks.length ? <ul>{asks.map(ask => <li key={ask.id} class="workspace-context-ask">
     <small>{time(ask.created_at)} · {ask.project}</small>
     <b>{ask.question}</b>
     {ask.recommendation && <small>Suggested: {ask.recommendation}</small>}
     <button type="button" onClick={onAnswer}>Answer</button>
    </li>)}</ul> : <p>Nothing is waiting on you.</p>}
   </section>
   <section aria-label="In flight">
    <h3>In flight · {live.length}</h3>
    {live.length ? <ul>{live.map(w => <li key={w.id} class="workspace-context-job">
     <span class="workspace-context-job-head"><span class={`session-dot session-dot-${w.run_phase ?? "unknown"}`}/><code title={w.id}>{w.id}</code><span>{w.run_phase ?? "no run status"}</span></span>
     <dl>
      <dt>Project</dt><dd>{w.project ?? "untagged"}</dd>
      <dt>Model</dt><dd>{modelText({model: w.context?.model ?? w.model, thinking: w.thinking})}</dd>
      <dt>Context</dt><dd>{w.context ? contextText(w.context) : NONE}</dd>
      <dt>Cost</dt><dd>{w.cost_usd === undefined ? NONE : money(w.cost_usd)}</dd>
      <dt>Last activity</dt><dd>{w.last_activity ? time(w.last_activity) : NONE}</dd>
     </dl>
     <span class="workspace-context-links"><button type="button" onClick={() => onJob(w.id)}>Open job</button><a href={sessionHref("workers", w.id)}>Session</a></span>
    </li>)}</ul> : <p>Nothing in flight{selection ? " for this selection" : ""}.</p>}
   </section>
   <p class="workspace-context-unrecorded">Jobs started from this chat and today's totals are not recorded per conversation.</p>
   <button type="button" class="workspace-context-jobs" onClick={onJobs}>All jobs <kbd>⌘J</kbd></button>
  </div>
 </>;
}

/**
 * The operator chat's context (M3): beside or over the chat from 900 px (`sheet` false, non-modal), a modal bottom
 * sheet on a phone. Escape and focus return belong to WorkspaceSurfaces.
 */
export function ConversationContext(props: ContextProps & {sheet: boolean}) {
 const dialog = useRef<HTMLDialogElement>(null);
 useLayoutEffect(() => { const element = dialog.current; if (!element) return; element.showModal(); return () => element.close(); }, []);
 if (!props.sheet) return <aside class="workspace-context" aria-label="Context"><Body {...props}/></aside>;
 return <dialog ref={dialog} class="workspace-context workspace-context-sheet" aria-label="Context" onCancel={event => { event.preventDefault(); props.onClose(); }}
  onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}><span class="workspace-handle" aria-hidden="true"/><Body {...props}/></dialog>;
}
