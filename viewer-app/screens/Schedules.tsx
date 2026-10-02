import { useState } from "preact/hooks";
import type { ScheduleItem, SchedulesResponse } from "../../src/viewer/api-types.ts";
import { observedTime } from "../format.ts";
import { composerHref, jobHref } from "../routes.ts";
import { ADD_SCHEDULE_DRAFT, latestRequest, requestLine, type ScheduleControlView, scheduleControlLine, scheduleControlReady } from "../schedule-control.ts";
import "./jobs.css";
import "./schedules.css";

/** Where a fired job's result lands, by its template's delivery. */
const LANDS: Record<string, string> = {pr:"a pull request", local:"a pushed branch, no PR", pipeline:"a plan, its gate, then an implementation", answer:"this page's run history (not the operator session)", board:"a published report under Reports"};

export function triggerText(s: ScheduleItem): string {
 const t = s.trigger;
 return t.type === "cron" ? `cron ${t.cron} (${t.tz})` : `watch ${t.script_path} every ${t.every_seconds} s, fires on ${t.on === "changed" ? "changed output" : "exit 0"}`;
}

function Schedule({s, control}: {s:ScheduleItem; control?:ScheduleControlView}) {
 const next = s.next_at ? `${s.trigger.type === "cron" ? "Next fire" : "Next check ≈"} ${observedTime(s.next_at)}` : `Next ${s.trigger.type === "cron" ? "fire" : "check"} unknown: ${s.next_note ?? "not recorded"}`;
 return <article class="job-row schedule-card">
  <div class="job-row-heading"><strong class="job-title">{s.name}</strong><span class="job-ledger">{s.enabled ? "enabled" : "disabled"}</span><span class="job-meta">{s.project}</span></div>
  <p class="job-meta"><code>{triggerText(s)}</code></p>
  <p class="job-meta">{s.enabled ? next : "Disabled: nothing fires until it is enabled"}</p>
  {control && <ScheduleControls s={s} control={control}/>}
  <p class="job-meta">Mandate <code>{s.mandate_id}</code> · {s.mandate_status}{s.mandate_status !== "active" && <strong> · fires are skipped while this grant is {s.mandate_status}</strong>}</p>
  <p class="job-meta">Each fire records a <code>{s.job.kind}</code>/<code>{s.job.delivery}</code> job “{s.job.title}”; its result lands as {LANDS[s.job.delivery] ?? s.job.delivery}.</p>
  <p class="job-meta">Last fire: {s.last_fire ? <><a href={jobHref(s.last_fire.job_id)}><code>{s.last_fire.job_id}</code></a> at {observedTime(s.last_fire.at)} for slot {observedTime(s.last_fire.slot)}{s.last_fire.missed && " (missed)"}</> : "never"}</p>
  {s.last_skip && <p class="job-meta">Last skip {observedTime(s.last_skip.at)}: {s.last_skip.reason}</p>}
  <details><summary class="job-meta">Runs · {s.history.length}</summary>
   {s.history.length ? <ul class="schedule-history">{s.history.map(j => <li key={j.id} class="job-meta">
    <a href={jobHref(j.id)}><code>{j.id}</code></a> {j.status}{j.close_reason && ` · ${j.close_reason}`}
    {j.reported_at && <> · reported {observedTime(j.reported_at)}</>}
    {j.pr_url && <> · <a href={j.pr_url} target="_blank" rel="noopener noreferrer">{j.pr_url}</a></>}
    {j.board_href && <> · <a href={j.board_href} target="_blank" rel="noopener noreferrer">report</a></>}
    {j.summary && <p class="schedule-summary">{j.summary}</p>}
    {j.answer && <pre class="schedule-answer">{j.answer.text}{j.answer.truncated && `\n… truncated at 8 KiB of ${j.answer.bytes} bytes`}</pre>}
   </li>)}</ul> : <p class="jobs-empty">No job fired yet</p>}
  </details>
 </article>;
}

/** Enable/Disable, Run now (enabled only) and a two-tap Remove; disabled unless ready and nothing is pending for this schedule. */
export function ScheduleControls({s, control}: {s:ScheduleItem; control:ScheduleControlView}) {
 const [confirmRemove,setConfirmRemove] = useState(false);
 const latest = latestRequest(control.status, s.id);
 const pending = latest?.state === "queued" || latest?.state === "applying" || control.sending !== null;
 const disabled = !scheduleControlReady(control.status) || pending;
 const failed = control.failed?.schedule_id === s.id ? control.failed.reason : null;
 const remove = () => { if (!confirmRemove) { setConfirmRemove(true); return; } setConfirmRemove(false); control.request("remove", s.id); };
 return <div class="schedule-control">
  <div class="schedule-controls">
   <button type="button" disabled={disabled} onClick={() => control.request(s.enabled ? "disable" : "enable", s.id)}>{s.enabled ? "Disable" : "Enable"}</button>
   {s.enabled && <button type="button" disabled={disabled} onClick={() => control.request("run_now", s.id)}>Run now</button>}
   <button type="button" class="schedule-remove" disabled={disabled} onClick={remove}>{confirmRemove ? "Tap again to remove" : "Remove"}</button>
  </div>
  {failed ? <p role="alert" class="job-meta">Refused: {failed}</p> : latest && <p role="status" class="job-meta">{requestLine(latest)}</p>}
 </div>;
}

export function Schedules({data, control}: {data:SchedulesResponse; control?:ScheduleControlView}) {
 return <div class="jobs-screen"><header class="jobs-heading"><h1>Schedules</h1><p>Saved triggers and the jobs they fired. Enable, disable, run now and remove here while the parent runs: each request is journaled and applied by the parent under the schedule's own grant. Schedules fire in the always-on parent; a slot missed while it was down fires once when it returns.</p>
  <p><a class="schedule-add" href={composerHref(ADD_SCHEDULE_DRAFT)}>Add schedule…</a></p>
  {control && <p role="status" class="job-meta">{scheduleControlLine(control.status)}</p>}</header>
  {data.error && <p role="alert" class="overview-error">Schedules unavailable: {data.error}</p>}
  <section class="jobs-group" aria-label="Schedules">
   <header><h2>Schedules · {data.schedules.length}</h2></header>
   <div class="reports-grid">{data.schedules.map(s => <Schedule key={s.id} s={s} control={control}/>)}</div>
   {!data.schedules.length && !data.error && <p class="jobs-empty">No schedules. Ask the operator session to add one (cp_schedule).</p>}
  </section>
 </div>;
}
