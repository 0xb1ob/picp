import { useEffect, useRef, useState } from "preact/hooks";
import type { EvidenceReference } from "../../src/evidence-reference.ts";
import type { JobResponse, JobsResponse } from "../../src/viewer/api-types.ts";
import { phaseText } from "../format.ts";
import { matchesProject, type ProjectSelection } from "../project-filter.ts";
import { inFlight, tagOf } from "../screens/Jobs.tsx";
import { useScreenData } from "../use-screen-data.ts";

/** The composer's commands (M3): navigation and an editable draft only; none sends anything. */
export const STATUS_DRAFT = "What is running and what needs me?";
export const COMMANDS = [{name: "status", detail: STATUS_DRAFT}, {name: "jobs", detail: "Open the jobs drawer"}] as const;
export type Command = typeof COMMANDS[number]["name"];
/** What the operator chat lends its composer: the chat's own Jobs opener (as Ctrl/Cmd+J) and the M1 selection. */
export interface ComposerMenuContext { onJobs: (opener: HTMLElement | null) => void; selection: ProjectSelection }

/** A draft that is exactly `/word` offers the commands starting with `word`; any other draft offers none. */
export function slashCommands(text: string) {
 const typed = /^\/([a-z]*)$/.exec(text)?.[1];
 return typed === undefined ? [] : COMMANDS.filter(c => c.name.startsWith(typed));
}

/** The job's own P1 reference, as its job page's Ask builds it (`/api/job`), or why it cannot be referenced. */
async function jobReference(id: string): Promise<EvidenceReference | string> {
 try {
  const response = await fetch(`/api/job/${encodeURIComponent(id)}`);
  if (!response.ok) return `${id} could not be read (${response.status})`;
  const job = await response.json() as JobResponse;
  if (job.evidence_lookup?.supported === false) return `${id} cannot be referenced: ${job.evidence_lookup.why}`;
  return job.ask_reference ?? `${id} has no recorded project to reference`;
 } catch (error) { return `${id} could not be read: ${error instanceof Error ? error.message : "request failed"}`; }
}

function Panel({selection, note, onCommand, onPick}: {selection: ProjectSelection; note: string | null; onCommand: (name: Command) => void; onPick: (id: string) => void}) {
 const resource = useScreenData<JobsResponse>("/api/jobs", "/api/stream?view=jobs");
 const jobs = (resource.data?.jobs ?? []).filter(j => matchesProject(tagOf(j.project), selection));
 const shown = [...jobs.filter(inFlight), ...jobs.filter(j => ["done","failed"].includes(j.phase) && j.finished_today)];
 return <div id="operator-composer-command-menu" class="operator-composer-command-menu" role="group" aria-label="Commands and job references">
  <h3>Commands</h3>
  <ul>{COMMANDS.map(c => <li key={c.name}><button type="button" onClick={() => onCommand(c.name)}><code>/{c.name}</code><small>{c.detail}</small></button></li>)}</ul>
  <h3>Reference a job</h3>
  {note && <p role="status">{note}</p>}
  {!resource.data ? <p role="status">{resource.error ? "Jobs unavailable" : "Loading"}</p>
   : !shown.length ? <p>No jobs in flight or done today</p>
   : <ul>{shown.map(j => <li key={j.id}><button type="button" onClick={() => onPick(j.id)}><code title={j.id}>{j.id}</code><small>{phaseText(j.phase)}</small></button></li>)}</ul>}
 </div>;
}

/**
 * The composer's `/` button (the touch way to the typed `/` commands): commands, then the selection's jobs to attach as
 * the draft's one P1 reference. Escape or a tap outside closes it; nothing here sends.
 */
export function ComposerMenu({context, disabled, onCommand, onRefer}: {context: ComposerMenuContext; disabled: boolean; onCommand: (name: Command) => void; onRefer: (ref: EvidenceReference) => void}) {
 const [open, setOpen] = useState(false);
 const [note, setNote] = useState<string | null>(null);
 const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
 useEffect(() => {
  if (!open) return;
  const outside = (e: Event) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
  document.addEventListener("pointerdown", outside);
  return () => document.removeEventListener("pointerdown", outside);
 }, [open]);
 const pick = (id: string) => void jobReference(id).then(ref => { if (typeof ref === "string") setNote(ref); else { setOpen(false); onRefer(ref); } });
 return <div ref={root} class="operator-composer-commands" onKeyDown={e => { if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); button.current?.focus(); } }}>
  <button ref={button} type="button" class="operator-composer-slash" aria-expanded={open} aria-controls={open ? "operator-composer-command-menu" : undefined}
   aria-label="Commands and job references" title="Commands and job references (or type /)" disabled={disabled} onClick={() => { setNote(null); setOpen(!open); }}>/</button>
  {open && <Panel selection={context.selection} note={note} onCommand={name => { setOpen(false); onCommand(name); }} onPick={pick}/>}
 </div>;
}
