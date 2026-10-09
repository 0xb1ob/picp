import { useState } from "preact/hooks";
import type { ScheduleHistoryJob, ScheduleItem, SchedulesResponse } from "../../src/viewer/api-types.ts";
import { observedTime } from "../format.ts";
import { composerHref, jobHref, navigation } from "../routes.ts";
import { acceptedRunJob, ADD_SCHEDULE_DRAFT, latestRequest, readinessLine, requestLine, type ScheduleControlView, scheduleControlLine, scheduleControlReady } from "../schedule-control.ts";
import { useSchedulePolicy } from "../use-schedule-control.ts";
import { ScheduleEditor } from "./ScheduleEditor.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import "./jobs.css";
import "./schedules.css";

/** Where a fired job's result lands, by its template's delivery. */
const LANDS_TEXT: Record<ScheduleItem["lands"], string> = {pull_request:"a pull request", branch:"a pushed branch, no PR", plan:"a plan, its gate, then an implementation", answer:"this page's run history (not the operator session)", board:"a report board under Reports", report:"a report (the run's job page)"};
const TRIGGER_TEXT = {slot:"Scheduled", dashboard:"Run now (dashboard)", cp_schedule:"Run now (cp_schedule)"};
const RESULT_TEXT: Record<NonNullable<ScheduleItem["runs"][number]["result"]>["kind"], string> = {board:"Report board", pull_request:"Pull request", answer:"Answer", report:"Report", branch:"Branch (no PR)", job:"Job"};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const EFFECT_TEXT: Record<ScheduleItem["lands"], string> = {pull_request: "a pull request", branch: "a pushed branch", plan: "a plan", answer: "an answer", board: "a report board", report: "a report"};

/** One line of what a run may do. Concurrency is capped by the child-job cap, so it never claims more than can exist. */
export function policySummary(s: ScheduleItem): string | null {
 const t = s.grant_template;
 const limits = s.policy?.limits ?? (t ? {usd: t.spend_usd, tokens: t.spend_tokens, child_jobs: t.job_cap, parallelism: t.dispatch_parallelism ?? 1} : null);
 if (!limits) return null;
 const at = Math.max(1, Math.min(limits.parallelism, limits.child_jobs));
 const model = s.policy?.model.mode === "pinned" ? `pinned (${Object.entries(s.policy.model.by_role).map(([role, id]) => `${role} ${id}`).join(", ")})` : "routing default";
 return `${s.fan_out ? `Up to ${s.fan_out.reviewers} reviewers, ` : ""}${at === 1 ? "1 at a time" : `${at} at once`}, plus ${EFFECT_TEXT[s.lands]}; $${limits.usd}/run; model ${model}.`;
}

/** Stage, child progress and limits of the open run. Spend is not in the projection, so it is not shown; a limit is not a spend. */
function ActiveRun({s}: {s: ScheduleItem}) {
 const run = s.active_run;
 if (!run) return null;
 return <p class="job-meta schedule-active-run" role="status">Active run <code>{run.id}</code> · {run.phase === "accepted" ? "accepted, not yet started" : "running"} · {run.members.length} of {run.policy.limits.child_jobs} child jobs admitted · limit ${run.policy.limits.usd} / {run.policy.limits.tokens} tokens · must finish by {observedTime(run.deadline_at)}{run.outcome === "partial" && " · partial"}</p>;
}

const reportLink = (r: ScheduleItem["runs"][number]) => r.result ? <a href={r.result.href} {...(r.result.kind === "board" || r.result.kind === "report" ? {target: "_blank", rel: "noopener noreferrer"} : {})}>{r.result.kind === "board" || r.result.kind === "report" ? "Web report ↗" : RESULT_TEXT[r.result.kind]}</a> : <span class="schedule-no-report">no report</span>;
const runState = (r: ScheduleItem["runs"][number]) => <span class="schedule-run-state"><span class={`schedule-run-dot schedule-run-${r.status}`} aria-hidden="true"/>{r.status === "open" ? `open · ${r.jobs_open} of ${r.jobs_total} jobs` : `closed · ${r.jobs_total} jobs`}</span>;

/** The three newest runs (frames 09/19): a table on desktop, blocks on a phone. "closed" means every job closed; it does not say the run succeeded. */
function LastRuns({s}: {s: ScheduleItem}) {
 const runs = s.runs.slice(0, 3);
 return <section class="schedule-last-runs" aria-label="Last 3 runs"><header><h3>Last 3 runs</h3>{s.run_count > 0 && <a class="schedule-all-runs" href="#jobs">All {s.run_count} {s.run_count === 1 ? "run" : "runs"} →</a>}</header>
  <ActiveRun s={s}/>
  {runs.length ? <>
   <table class="schedule-runs-table"><thead><tr><th>Started</th><th>Job</th><th>Status</th><th>Transcript</th><th>Report</th></tr></thead>
    <tbody>{runs.map(r => <tr key={r.run_id}><td>{observedTime(r.at)}{r.missed && " (missed)"}<span class="schedule-run-via"> · {TRIGGER_TEXT[r.via]}</span></td><td><a href={jobHref(r.anchor_id)}><code>{r.anchor_id}</code></a></td><td>{runState(r)}</td><td><a href={jobHref(r.anchor_id)}>Transcript</a></td><td>{reportLink(r)}</td></tr>)}</tbody></table>
   <ol class="schedule-runs-blocks">{runs.map(r => <li key={r.run_id}>
    <p class="schedule-run-top"><span class="schedule-run-id"><span class={`schedule-run-dot schedule-run-${r.status}`} aria-hidden="true"/><a href={jobHref(r.anchor_id)}><code>{r.anchor_id}</code></a></span><time>{observedTime(r.at)}{r.missed && " (missed)"}</time></p>
    <p class="schedule-run-buttons"><a href={jobHref(r.anchor_id)}>Transcript</a>{reportLink(r)}</p>
   </li>)}</ol></> : <p class="job-meta">No runs yet</p>}
 </section>;
}

function JobRow({j}: {j:ScheduleHistoryJob}) {
 return <li key={j.id} class="job-meta">
  <a href={jobHref(j.id)}><code>{j.id}</code></a> {j.status}{j.close_reason && ` · ${j.close_reason}`}
  {j.reported_at && <> · reported {observedTime(j.reported_at)}</>}
  {j.pr_url && <> · <a href={j.pr_url} target="_blank" rel="noopener noreferrer">{j.pr_url}</a></>}
  {j.board_href && <> · <a href={j.board_href} target="_blank" rel="noopener noreferrer">report</a></>}
  {j.summary && <p class="schedule-summary">{j.summary}</p>}
  {j.answer && <pre class="schedule-answer">{j.answer.text}{j.answer.truncated && `\n… truncated at 8 KiB of ${j.answer.bytes} bytes`}</pre>}
 </li>;
}

function RunHistory({s}: {s:ScheduleItem}) {
 const jobs = (ids: (string|null)[]) => s.history.filter(j => ids.includes(j.run_id));
 const loose = s.history.filter(j => j.run_id === null);
 return <ul class="schedule-history">{s.runs.map(r => <li key={r.run_id} class="job-meta">
  <p class="schedule-run-head"><a href={jobHref(r.anchor_id)}><code>{r.anchor_id}</code></a> · {TRIGGER_TEXT[r.via]}{r.missed && " (missed)"} · {observedTime(r.at)} · {r.status} ({r.jobs_open} of {r.jobs_total} jobs open){r.result && <> · <a href={r.result.href}>{RESULT_TEXT[r.result.kind]}</a></>}</p>
  <ul class="schedule-run-jobs">{jobs([r.run_id]).map(j => <JobRow key={j.id} j={j}/>)}</ul>
 </li>)}
  {loose.length > 0 && <li class="job-meta"><p class="schedule-run-head">Unattributed jobs</p><ul class="schedule-run-jobs">{loose.map(j => <JobRow key={j.id} j={j}/>)}</ul></li>}
 </ul>;
}

export function triggerText(s: ScheduleItem): string {
 const t = s.trigger;
 if (t.type === "manual") return `manual (Run now only)${s.job.skill ? `, expanded by skill ${s.job.skill}` : ""}`;
 return t.type === "cron" ? `cron ${t.cron} (${t.tz})` : `watch ${t.script_path} every ${t.every_seconds} s, fires on ${t.on === "changed" ? "changed output" : "exit 0"}`;
}


function Schedule({s, control}: {s:ScheduleItem; control?:ScheduleControlView}) {
 const stamp = control?.status && "generated_at" in control.status ? control.status.generated_at : null;
 const policy = useSchedulePolicy(!!control && scheduleControlReady(control.status), s.id, stamp);
 const summary = policySummary(s);
 const next = s.trigger.type === "manual" ? "Manual: fires only on Run now" : s.next_at ? `${s.trigger.type === "cron" ? "Next fire" : "Next check ≈"} ${observedTime(s.next_at)}` : `Next ${s.trigger.type === "cron" ? "fire" : "check"} unknown: ${s.next_note ?? "not recorded"}`;
 return <article class="schedule-card">
  <div class="schedule-card-heading"><h2>{s.name}</h2><span class={`schedule-pill${s.enabled ? " schedule-pill-on" : ""}`}>{s.enabled ? "enabled" : "disabled"}</span><span class="schedule-project">{s.project}</span></div>
  <p class="schedule-identity">{s.job.title} · {s.trigger.type} · {s.policy ? `policy revision ${s.policy.active_revision}` : <code>{s.mandate_id ?? "needs setup"}</code>}</p>
  <p class="schedule-result">Records a job “{s.job.title}”. Its result lands as {LANDS_TEXT[s.lands]}.</p>
  <dl class="schedule-facts">
   <dt>Trigger</dt><dd>{s.trigger.type === "manual" ? "manual · Run now only" : s.trigger.type === "watch" ? `Watch · every ${s.trigger.every_seconds} s · ${s.trigger.on === "changed" ? "changed output" : "exit 0"}` : <code>{triggerText(s)}</code>}{(!s.enabled || s.trigger.type !== "manual") && <p class="job-meta">{s.enabled ? next : "Disabled: nothing fires until it is enabled"}</p>}</dd>
   <dt>Recipe</dt><dd>{s.job.skill ? <><code>{s.job.skill}</code> skill</> : "Saved job"}</dd>
   <dt>{s.policy ? "Policy" : "Mandate"}</dt><dd>{s.policy ? <>revision {s.policy.active_revision} · saved run authority</> : <><code>{s.mandate_id ?? "none"}</code> · {s.mandate_status}{s.grant_stopped ? " · stopped" : !s.grant_template ? " · no grant template" : ""}</>}</dd>
   <dt>Last fire</dt><dd>{s.last_run ? <><a href={jobHref(s.last_run.job_id)}><code>{s.last_run.job_id}</code></a> at {observedTime(s.last_run.at)} · {TRIGGER_TEXT[s.last_run.via]}{s.last_run.missed && " (missed)"}</> : s.last_fire ? <><a href={jobHref(s.last_fire.job_id)}><code>{s.last_fire.job_id}</code></a> at {observedTime(s.last_fire.at)}{s.last_fire.missed && " (missed)"}</> : "never"} · {plural(s.run_count, "recent run")} · {plural(s.job_count, "job")}</dd>
  </dl>
  {s.last_skip && <p class="job-meta">Last skip {observedTime(s.last_skip.at)}: {s.last_skip.reason}</p>}
  {summary && <p class="schedule-policy-line">{summary}</p>}
  {control && scheduleControlReady(control.status) && <p class="job-meta schedule-readiness">{readinessLine(policy)}</p>}
  <LastRuns s={s}/>
  <details class="schedule-details"><summary>Grant, template &amp; run history · {plural(s.runs.length, "run")}</summary>
   {s.grant_template ? <>
    <p class="job-meta">Fire grant <code>{s.mandate_id}</code> · {s.mandate_status}{s.mandate_pause_reason && ` (${s.mandate_pause_reason})`}{s.grant_stopped ? <strong> · fires are refused while this grant is {s.mandate_status}: {s.mandate_status === "paused" ? "resume it, or move the schedule to a new grant" : "move the schedule to a new grant"}</strong> : " · next fire mints a fresh grant"}</p>
    <p class="job-meta schedule-approval">Template of <code>{s.grant_template.seed_mandate_id}</code>: {s.grant_template.expiry_hours} h, ${s.grant_template.spend_usd}, {s.grant_template.spend_tokens} tokens, job cap {s.grant_template.job_cap}; allowed {s.grant_template.allowed_actions.join(", ")}; asks on {s.grant_template.ask_on.join(", ")}. Approved {observedTime(s.grant_template.approval.approved_at)}: “{s.grant_template.approval.operator_quote}”</p>
   </> : s.policy ? <p class="job-meta">Policy revision {s.policy.active_revision}: each fire starts a run; no grant minted.</p> : <p class="job-meta">Grant <code>{s.mandate_id ?? "none"}</code> · {s.mandate_status}<strong> · no grant template, so every fire is refused: {s.last_skip?.reason ?? (s.mandate_id ? "move it to a schedule grant to resume" : "open the editor to set up this schedule")}</strong></p>}
   {s.trigger.type === "manual" && <p class="job-meta">{next}</p>}
   <p class="job-meta"><code>{triggerText(s)}</code> · <code>{s.job.kind}</code>/<code>{s.job.delivery}</code></p>
   {s.job.skill && <p class="job-meta">Each Run now records a deferred anchor job and wakes the parent to fan out the {s.job.skill} recipe under {s.policy ? "that run's saved policy" : "that fire's own grant"}.</p>}
   {s.last_fire && <p class="job-meta">Last fire slot: {observedTime(s.last_fire.slot)}</p>}
   {s.history.length ? <RunHistory s={s}/> : <p class="jobs-empty">No job fired yet</p>}
  </details>
  {control && <ScheduleControls s={s} control={control} policy={policy}/>}
 </article>;
}

type PolicyState = ReturnType<typeof useSchedulePolicy>;

/** Run now (revision-bound once a policy is active) or View active run, Enable/Disable, a two-tap Remove; settings actions sit below. Disabled unless ready and nothing is pending for this schedule. */
export function ScheduleControls({s, control, policy = null}: {s:ScheduleItem; control:ScheduleControlView; policy?: PolicyState}) {
 const [confirmRemove,setConfirmRemove] = useState(false);
 const [editing,setEditing] = useState(false);
 const latest = latestRequest(control.status, s.id);
 const pending = latest?.state === "queued" || latest?.state === "applying" || control.sending !== null;
 const disabled = !scheduleControlReady(control.status) || pending;
 const failed = control.failed?.schedule_id === s.id ? control.failed.reason : null;
 const remove = () => { if (!confirmRemove) { setConfirmRemove(true); return; } setConfirmRemove(false); control.request("remove", s.id); };
 const answered = policy && !("error" in policy) ? policy : null;
 const anchor = s.active_run?.anchor_job_id ?? null;
 const acceptedJob = latest && !failed ? acceptedRunJob(latest) : null;
 return <div class="schedule-control">
  <div class="schedule-controls">
   {s.enabled && (s.active_run ? (anchor ? <a class="schedule-primary schedule-view-run" href={jobHref(anchor)}>View active run</a> : <button type="button" class="schedule-primary" disabled>Run starting…</button>) : <button type="button" class="schedule-primary" disabled={disabled} onClick={() => control.request("run_now", s.id, s.policy ? {revision: s.policy.active_revision} : {})}>Run now</button>)}
   <button type="button" disabled={disabled} onClick={() => control.request(s.enabled ? "disable" : "enable", s.id)}>{s.enabled ? "Disable" : "Enable"}</button>
   <button type="button" class="schedule-remove" disabled={disabled} onClick={remove}>{confirmRemove ? "Tap again to remove" : "Remove…"}</button>
  </div>
  {answered && <div class="schedule-settings">
   <button type="button" disabled={disabled} aria-expanded={editing} onClick={() => setEditing(open => !open)}>{editing ? "Close editor" : "Edit settings"}</button>
   {!s.policy && (answered.policy || answered.legacy) && <button type="button" disabled={disabled || answered.blocking.length > 0} onClick={() => control.request("adopt", s.id, {revision: answered.policy?.revision ?? 0})}>Adopt saved settings</button>}
   {s.policy && <button type="button" disabled={disabled || !!s.active_run} onClick={() => control.request("deactivate", s.id)}>Back to per-fire grants</button>}
  </div>}
  {editing && answered && <ScheduleEditor s={s} policy={answered} control={control} onClose={() => setEditing(false)}/>}
  {s.fan_out && <FanOut s={s} fan={s.fan_out}/>}
  {failed ? <p role="alert" class="job-meta">Refused: {failed}</p> : latest && <p role="status" class="job-meta">{acceptedJob ? <>Run accepted · <code>{acceptedJob}</code> · <a href={jobHref(acceptedJob)}>view run</a></> : requestLine(latest)}</p>}
 </div>;
}

/** cp-org-pr-review: what Run now fans out to, and whether it carries the seed's standing risk:high pre-approval (its sha only). */
function FanOut({s, fan}: {s:ScheduleItem; fan:NonNullable<ScheduleItem["fan_out"]>}) {
 const scope = fan.org ? `${fan.org}'s requested-review queue (${fan.user ?? "the gh user"}${fan.teams.length ? `; teams ${fan.teams.join(", ")}` : ""}; ${fan.holds} held)` : "the org review queue";
 return <div class="schedule-fan-out">
  <p class="job-meta">Run now fans out to up to {fan.reviewers} reviewers over {scope}.</p>
  {fan.error && <p role="alert" class="job-meta">Recipe error: {fan.error}</p>}
  <p class="job-meta">{s.run_now_clearance ? `Run now carries the operator's risk:high pre-approval [${s.run_now_clearance.quote_sha}] (granted ${observedTime(s.run_now_clearance.granted_at)}).` : "Reviewers wait for a risk:high approval (no standing pre-approval on the seed)."}</p>
 </div>;
}

export function Schedules({data, control}: {data:SchedulesResponse; control?:ScheduleControlView}) {
 return <div class="jobs-screen schedule-screen">
  <header class="schedule-heading"><PageHeader title="Schedules"/><a class="schedule-add-phone" href={composerHref(ADD_SCHEDULE_DRAFT)}>+ Add</a></header>
  <div class="schedule-toolbar">
   <nav class="board-view" aria-label="Schedules and files">{navigation.filter(n => n.id === "schedules" || n.id === "files").map(n => <a key={n.id} href={n.href} aria-current={n.id === "schedules" ? "page" : undefined}>{n.label}</a>)}</nav>
   {control && <p role="status" class="job-meta schedule-status"><span class="schedule-status-dot" aria-hidden="true"/>{scheduleControlLine(control.status)}</p>}
   <a class="schedule-add" href={composerHref(ADD_SCHEDULE_DRAFT)}><span>+ Add<span class="schedule-add-long"> schedule</span></span></a>
  </div>
  {data.error && <p role="alert" class="overview-error">Schedules unavailable: {data.error}</p>}
  <div class="schedule-layout">
   <section class="schedule-list" aria-label={`Schedules · ${data.schedules.length}`}>
    {data.schedules.map(s => <Schedule key={s.id} s={s} control={control}/>)}
    {!data.schedules.length && !data.error && <p class="jobs-empty">No schedules. Ask the operator session to add one (cp_schedule).</p>}
   </section>
   <aside class="schedule-how"><h2>How schedules run</h2><p>Every request is journaled and applied by the parent under the schedule's own grant. Schedules fire in the always-on parent; a slot missed while it was down fires once when it returns.</p></aside>
   <details class="schedule-how-phone"><summary>How schedules run</summary><p>Every request is journaled and applied by the parent under the schedule's own grant. Schedules fire in the always-on parent; a slot missed while it was down fires once when it returns.</p></details>
  </div>
 </div>;
}
