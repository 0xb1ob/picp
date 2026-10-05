import type { JobResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, money, prNumber, shortSha, time } from "../format.ts";
import { CopyReply } from "../components/CopyReply.tsx";
import { ContextChip } from "../components/ContextChip.tsx";
import { PhaseDot, reviewText, CiSignal } from "./Jobs.tsx";
import "./job-detail.css";

/** Short name plus its provider (`anthropic/claude` → `claude · anthropic`). A script path is shown as recorded. */
function modelFact(job: ViewerJob): string {
 const id = job.script_path ?? job.model;
 if (!id) return "not recorded";
 const slash = id.lastIndexOf("/");
 return slash > 0 ? `${id.slice(slash + 1)} · ${id.slice(0, slash)}` : id;
}

function reviewFact(job: ViewerJob): string {
 if (!job.review_attempts) return "not started · 0 / 5";
 const verdict = job.review === "revise" ? "changes requested" : job.review ?? "not recorded for this head";
 return `${job.review_attempts} / 5 · ${verdict}`;
}

function ciFact(job: ViewerJob): string {
 if (!job.ci) return "not run yet";
 const state = job.ci === "failed" ? "red" : job.ci === "in_progress" ? "running" : job.ci;
 const sha = shortSha(job.head);
 return sha ? `${state} on ${sha}` : state;
}

function clockFact(job: ViewerJob): string {
 if (job.elapsed_seconds === null && job.limit_seconds === null) return "not recorded";
 const side = (seconds: number | null) => seconds === null ? "not recorded" : elapsed(seconds);
 return `${side(job.elapsed_seconds)} / ${side(job.limit_seconds)}`;
}

function ShaCopy({sha}: {sha: string}) {
 return <span class="job-sha"><code>{shortSha(sha)}</code><CopyReply reply={sha}/></span>;
}

function prFact(job: ViewerJob) {
 const number = prNumber(job.pr_url);
 if (!number || !job.pr_url) return "none yet";
 return <><a href={job.pr_url}>{number} ↗</a>{job.pr_status ? ` ${job.pr_status}` : null}{job.pr_status === "merged" && job.merge_sha ? <> as <code>{shortSha(job.merge_sha)}</code><CopyReply reply={job.merge_sha}/></> : null}</>;
}

export function JobDetail({data}: {data: JobResponse}) {
 const job = data.job;
 return <div class="job-detail"><div class="job-detail-main"><header class="job-detail-heading"><nav class="job-crumb"><a href="#jobs">← Jobs</a> / <code>{job.id}</code></nav><div class="job-badges"><span class={`job-badge job-badge-${job.phase}`}><PhaseDot phase={job.phase}/>{job.phase}</span><CiSignal job={job} badge/><span class="job-badge job-badge-review">{reviewText(job)}</span></div><h1>{job.title ?? job.id}</h1>{job.phase === "held" && <p>held = waiting on CI or review, normal for hours</p>}</header>
 {data.questions.map(q => <section class="job-question" key={q.id}><h2>{q.kind === "final_fix" ? "Final-fix approval open" : "Parent question open"}</h2><p><code>{q.id}</code> · {q.question}</p><p>Being handled by the operator session.</p></section>)}
 {data.asks.map(ask => <section class="job-question job-question-awaiting" key={ask.id}><h2>Awaiting you</h2><p>{ask.question}</p>{ask.options.map(option => <CopyReply key={option.label} reply={option.reply}/>)}</section>)}
 {job.summary && <p class="job-summary">{job.summary}</p>}{job.failure && <p class="job-failure">{job.failure}</p>}</div><div class="job-detail-side"><dl class="job-facts"><div><dt>Wall clock</dt><dd>{clockFact(job)}</dd></div><div class="job-fact-wide"><dt>Head</dt><dd>{job.head ? <ShaCopy sha={job.head}/> : "no commits yet"}</dd></div><div class="job-fact-wide"><dt>PR</dt><dd>{prFact(job)}</dd></div><div><dt>CI</dt><dd>{ciFact(job)}</dd></div><div><dt>Review</dt><dd>{reviewFact(job)}</dd></div><div><dt>Model</dt><dd>{modelFact(job)}</dd></div><div class="job-fact-wide"><dt>Context</dt><dd>{job.context ? <ContextChip usage={job.context}/> : "none"}</dd></div><div><dt>Mandate</dt><dd>{job.mandate_id ? <a href="#map"><code>{job.mandate_id}</code> →</a> : "none"}</dd></div><div><dt>Cost</dt><dd>{job.cost_usd === null ? "not recorded" : money(job.cost_usd)}</dd></div><div class="job-fact-wide"><dt>Routing</dt><dd>{job.routing ?? "Not recorded"}</dd></div></dl>
 <div class="job-links">{data.artifact_href ? <a href={data.artifact_href}>Artifact · {data.artifact_name}</a> : data.files_href ? <a href={data.files_href}>Files</a> : <span>Files unavailable</span>}{data.run_href ? <a href={data.run_href}>Run log · events.jsonl</a> : <span>Run log unavailable</span>}</div></div>
 <section class="job-timeline"><h2>Timeline</h2>{data.timeline_truncated && <p class="job-meta">Recent recorded events shown</p>}{data.timeline.map((event, index) => <div class={`job-event job-event-${event.tone}`} key={`${event.at}-${index}`}><code>{time(event.at)}</code><span class="job-event-stem" aria-hidden="true"><span/></span><div><span>{event.label}</span><p>{event.meta}</p></div></div>)}{!data.timeline.length && <p class="jobs-empty">No recorded events.</p>}{job.phase !== "done" && <div class="job-event job-event-pending"><code></code><span class="job-event-stem" aria-hidden="true"><span/></span><div><span>Merge</span><p>not yet</p></div></div>}</section>
 </div>;
}
