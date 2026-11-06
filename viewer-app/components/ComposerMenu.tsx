import { useEffect, useRef, useState } from "preact/hooks";
import type { EvidenceReference } from "../../src/evidence-reference.ts";
import type { JobResponse, JobsResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, phaseText, time } from "../format.ts";
import { matchesProject, type ProjectSelection } from "../project-filter.ts";
import { inFlight, tagOf } from "../screens/Jobs.tsx";
import { useScreenData } from "../use-screen-data.ts";

/** The composer's commands: `/jobs` navigates; `/status` and `/stop` prepare a command that only Submit sends (S6). */
export const COMMANDS = [{name: "status", detail: "What is running and what needs me"}, {name: "jobs", detail: "Open the jobs drawer"},
 {name: "stop", detail: "Ask the operator to stop a job"}] as const;
export type Command = typeof COMMANDS[number]["name"];
/** What the operator chat lends its composer: its Jobs opener (as Ctrl/Cmd+J) and the M1 selection. */
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

type Mode = "all" | "jobs";
/** Frames 4/10: `Working · 9m` while in flight, `Done 14:27` once finished; a missing time is left out, never 0m. */
const jobDetail = (job: ViewerJob) => {
 const status = phaseText(job.phase), label = status[0]!.toUpperCase() + status.slice(1);
 if (job.finished_at) return `${label} ${time(job.finished_at)}`;
 return job.elapsed_seconds === null || job.elapsed_seconds === undefined ? label : `${label} · ${elapsed(job.elapsed_seconds)}`;
};
function Panel({commands, selection, mode, target, note, pending, onCommand, onPick}: {commands: typeof COMMANDS[number][]; selection: ProjectSelection; mode: Mode; target: boolean; note: string | null; pending: string | null; onCommand: (name: Command) => void; onPick: (id: string) => void}) {
 const resource = useScreenData<JobsResponse>("/api/jobs", "/api/stream?view=jobs");
 const jobs = (resource.data?.jobs ?? []).filter(j => matchesProject(tagOf(j.project), selection));
 // A `/stop` target is a job still in flight; a reference may also name one done today.
 const shown = target ? jobs.filter(inFlight) : [...jobs.filter(inFlight), ...jobs.filter(j => ["done","failed"].includes(j.phase) && j.finished_today)];
 return <div id="operator-composer-command-menu" class="operator-composer-command-menu" role="group" aria-label={target ? "Stop which job" : mode === "jobs" ? "Job references" : "Commands and job references"}>
  {mode === "all" && !target && <><h3>Commands</h3>
  <ul>{commands.map(c => <li key={c.name}><button type="button" onClick={() => onCommand(c.name)}><code>/{c.name}</code><small>{c.detail}</small></button></li>)}</ul></>}
  <h3>{target ? "Stop which job?" : "Jobs"}</h3>
  {note && <p role="status">{note}</p>}
  {!resource.data ? <p role="status">{resource.error ? "Jobs unavailable" : "Loading"}</p>
   : !shown.length ? <p>{target ? "No jobs in flight" : "No jobs in flight or done today"}</p>
   : <ul>{shown.map(j => <li key={j.id}><button type="button" disabled={pending !== null} aria-busy={pending === j.id} onClick={() => onPick(j.id)}><code title={j.id}>@{j.id}</code><small>{pending === j.id ? "Attaching…" : jobDetail(j)}</small></button></li>)}</ul>}
 </div>;
}

/**
 * The `@ job` and `/ command` chips (the touch way to typed `/` commands): commands and the selection's jobs, picked as
 * the draft's one P1 reference, or as a `/stop` target while `target`. Escape or a tap outside closes; nothing sends.
 */
export function ComposerMenu({context, disabled, target, onCommand, onRefer, onTarget}: {context: ComposerMenuContext; disabled: boolean; target: boolean; onCommand: (name: Command) => void; onRefer: (ref: EvidenceReference) => void; onTarget: (id: string) => void}) {
 const [open, setOpen] = useState<Mode | null>(null);
 const [note, setNote] = useState<string | null>(null), [pending, setPending] = useState<string | null>(null);
 const root = useRef<HTMLDivElement>(null), opener = useRef<HTMLButtonElement | null>(null);
 // `lookup` numbers each pick; closing or unmounting bumps it, so a late or superseded answer attaches nothing.
 const lookup = useRef(0), busy = useRef(false);
 const close = () => { lookup.current++; busy.current = false; setPending(null); setOpen(null); };
 useEffect(() => () => { lookup.current++; }, []);
 useEffect(() => {
  if (!open) return;
  const outside = (e: Event) => { if (!root.current?.contains(e.target as Node)) close(); };
  document.addEventListener("pointerdown", outside);
  return () => document.removeEventListener("pointerdown", outside);
 }, [open]);
 const pick = (id: string) => {
  if (target) { close(); onTarget(id); return; }
  if (busy.current) return;
  busy.current = true;
  const mine = ++lookup.current;
  setPending(id); setNote(null);
  void jobReference(id).then(ref => {
   if (mine !== lookup.current) return;
   busy.current = false; setPending(null);
   if (typeof ref === "string") setNote(ref); else { close(); onRefer(ref); }
  });
 };
 const chip = (mode: Mode, glyph: string, label: string, title: string) => <button type="button" class={mode === "jobs" ? "operator-composer-at" : "operator-composer-slash"}
  aria-expanded={open === mode} aria-controls={open === mode ? "operator-composer-command-menu" : undefined} aria-label={title} title={title} disabled={disabled}
  onClick={e => { opener.current = e.currentTarget; if (open === mode) close(); else { setNote(null); setOpen(mode); } }}><span aria-hidden="true">{glyph}</span><span class="operator-composer-chip-label"> {label}</span></button>;
 return <div ref={root} class="operator-composer-commands" onKeyDown={e => { if (e.key === "Escape" && open) { e.preventDefault(); close(); opener.current?.focus(); } }}>
  {chip("jobs", "@", "job", target ? "Pick the job to stop" : "Reference a job")}
  {chip("all", "/", "command", "Commands and job references (or type /)")}
  {/* `/stop` keeps the menu open on its job list; any other command closes it. */}
  {open && <Panel commands={[...COMMANDS]} selection={context.selection} mode={open} target={target} note={note} pending={pending}
   onCommand={name => { if (name !== "stop") close(); onCommand(name); }} onPick={pick}/>}
 </div>;
}
