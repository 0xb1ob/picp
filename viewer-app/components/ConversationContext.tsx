import { useLayoutEffect, useRef } from "preact/hooks";
import type { AwaitingDetail, SessionsResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { modelText } from "../../src/viewer/model-text.ts";
import type { ControlView } from "../control.ts";
import { elapsed, jobSuffix, money, percent, time } from "../format.ts";
import type { ProjectSelection } from "../project-filter.ts";
import { sessionHref } from "../routes.ts";
import { contextText } from "./ContextChip.tsx";
import { Icon } from "./icons.tsx";
import { AnswerLine, type Answering, answerView } from "./QuickReplies.tsx";

type Worker = SessionsResponse["workers"][number];
/**
 * `jobs`: `/api/jobs` by exact job id, null until read; `jobsError` names a failed read (facts stay unrecorded).
 * `current` false is a historical file: like its quick replies, the card's options refuse to answer there.
 */
export interface ContextProps {
 asks: AwaitingDetail[]; live: Worker[]; selection: ProjectSelection; control: ControlView | undefined; answering: Answering;
 jobs: Map<string, ViewerJob> | null; jobsError: string | null; current: boolean;
 onClose: () => void; onJob: (id: string) => void; onJobs: () => void;
}
const NONE = "not recorded";

/** The recorded context and the exact recorded options, answered through the chat's one shared answer path. */
function AskCard({ask, control, answering, current}: {ask: AwaitingDetail; control: ControlView | undefined; answering: Answering; current: boolean}) {
 const {disabled} = answerView(ask, control, answering);
 const lines = ask.context?.split("\n").map(line => line.replace(/^\s*(?:[-*•]\s+)?/, "").trim()).filter(Boolean) ?? [];
 return <li class="workspace-context-ask">
  <small>Operator asked · {time(ask.created_at)} · {ask.project}</small>
  <b>{ask.question}</b>
  {lines.length ? <details class="workspace-context-why" open><summary>Context</summary><ul>{lines.map((line, i) => <li key={i}>{line}</li>)}</ul></details>
   : <small class="workspace-context-why">Context {NONE}</small>}
  {!current && <small class="workspace-context-history" role="note">Open now; answer from the latest transcript, not this older file.</small>}
  <ul class="workspace-context-options" aria-label="Options">{ask.options.map(option => <li key={option.label}>
   <button type="button" class={option.label === ask.recommendation ? "workspace-context-option workspace-context-option-suggested" : "workspace-context-option"}
    disabled={disabled || !current} onClick={() => { if (current) answering.answer(ask, option.label); }}>
    <b>{option.label}{option.label === ask.recommendation && <span class="workspace-context-suggested"> · suggested</span>}</b>
    <small>{option.consequence}</small>
   </button>
  </li>)}</ul>
  <AnswerLine ask={ask} control={control} answering={answering}/>
 </li>;
}
/** Wall clock as `elapsed / limit`, its bar only when both are recorded; an unknown never reads as 0. */
function Clock({job}: {job: ViewerJob | undefined}) {
 const spent = job?.elapsed_seconds ?? null, limit = job?.limit_seconds ?? null;
 if (spent === null) return <>{NONE}</>;
 return <span class="workspace-context-clock">{elapsed(spent)} / {limit === null ? `limit ${NONE}` : elapsed(limit)}
  {limit !== null && limit > 0 && <progress aria-label="Wall clock" max="100" value={percent(spent, limit)}/>}</span>;
}

/** The open asks and live workers, joined to `/api/jobs` by exact id; nothing the record lacks is shown as a value. */
function Body({asks, live, selection, control, answering, jobs, jobsError, current, onClose, onJob, onJobs}: ContextProps) {
 return <>
  <header class="workspace-context-head">
   <h2>This conversation</h2>
   <span>{!selection ? "All projects" : "project" in selection ? selection.project : "Untagged"}</span>
   <button type="button" class="workspace-close" aria-label="Close context" onClick={onClose}><Icon name="close"/></button>
  </header>
  <div class="workspace-context-body">
   <section aria-label="Asked you">
    <h3 class={asks.length ? "workspace-context-asked" : undefined}>Asked you · {asks.length}</h3>
    {asks.length ? <ul>{asks.map(ask => <AskCard key={ask.id} ask={ask} control={control} answering={answering} current={current}/>)}</ul> : <p>Nothing is waiting on you.</p>}
   </section>
   <section aria-label="In flight">
    <h3>In flight · {live.length}</h3>
    {jobsError && <p role="status">Job facts unavailable: {jobsError}</p>}
    {/* Cost stays the worker's own record: /api/jobs sums an unrecorded run's spend to 0, which is not a fact. */}
    {live.length ? <ul>{live.map(w => { const job = jobs?.get(w.id), cost = w.cost_usd ?? null; return <li key={w.id} class="workspace-context-job">
     <span class="workspace-context-job-head"><span class="workspace-context-job-glyph" aria-hidden="true"/><code title={w.id}>{jobSuffix(w.id)}</code><span class="workspace-context-job-status">{w.run_phase ?? "no run status"}</span></span>
     <b class="workspace-context-job-title">{job?.title ?? `Title ${NONE}`}</b>
     <dl>
      <dt>Wall clock</dt><dd><Clock job={job}/></dd>
      <dt>Project</dt><dd>{w.project ?? "untagged"}</dd>
      <dt>Context</dt><dd>{w.context ? contextText(w.context) : job?.context ? contextText(job.context) : NONE}</dd>
      <dt>Model</dt><dd>{modelText({model: w.context?.model ?? w.model ?? job?.model ?? null, thinking: w.thinking})}</dd>
      <dt>Cost</dt><dd>{cost === null ? NONE : money(cost)}</dd>
      <dt>Last activity</dt><dd>{w.last_activity ? time(w.last_activity) : NONE}</dd>
     </dl>
     <span class="workspace-context-links"><button type="button" onClick={() => onJob(w.id)}>Open job</button><a href={sessionHref("workers", w.id)}>Session</a></span>
    </li>; })}</ul> : <p>Nothing in flight{selection ? " for this selection" : ""}.</p>}
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
