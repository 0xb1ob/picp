import type { JobResponse, ViewerJob } from "../../src/viewer/api-types.ts";
import { elapsed, money, prNumber, shortSha, time } from "../format.ts";
import { CopyReply } from "../components/CopyReply.tsx";
import { ContextChip } from "../components/ContextChip.tsx";
import { PhaseDot, CiSignal, ModelName } from "../components/JobSignals.tsx";
import "./job-detail.css";

function ModelFact({job}: {job: ViewerJob}) {
 const id = job.script_path ?? job.model;
 if (!id) return <>not recorded</>;
 const provider = !job.script_path && id.includes("/") ? id.slice(0,id.lastIndexOf("/")) : null;
 return job.script_path ? <code>{job.script_path}</code> : <><ModelName job={job}/>{provider && <span class="job-provider">{provider}</span>}</>;
}

function reviewFact(job: ViewerJob): string {
 if (!job.review_attempts) return job.review === "pass" ? "0 / 5 · pass (equivalent)" : "not started · 0 / 5";
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
 return <span class="job-sha"><code title={sha}>{shortSha(sha)}</code><CopyReply reply={sha}/></span>;
}

function prFact(job: ViewerJob) {
 const number = prNumber(job.pr_url);
 if (!number || !job.pr_url) return "none yet";
 return <><a href={job.pr_url}>{number} ↗</a>{job.pr_status ? ` ${job.pr_status}` : null}{job.pr_status === "merged" && job.merge_sha ? <> as <ShaCopy sha={job.merge_sha}/></> : null}</>;
}

function RoutingFact({job}: {job: ViewerJob}) {
 const facts = job.routing_facts;
 if (!facts) return <>{job.routing ?? "Not recorded"}</>;
 return <><div class="job-routing-pills">{(["scope","risk"] as const).map(axis => facts[axis] && <span class="job-routing-pill" key={axis}>{axis}:{facts[axis]}{facts.provenance[axis] && ` · ${facts.provenance[axis]}`}</span>)}{facts.rule && <span class="job-routing-pill">{facts.rule}</span>}</div>{facts.reasons.length > 0 && <p>{facts.reasons.join(" · ")}</p>}</>;
}

function TimelineMeta({meta}: {meta: string}) {
 return <div class="job-event-meta">{meta.split(/(\b[a-f0-9]{40}\b)/gi).map((part,index) => /^[a-f0-9]{40}$/i.test(part) ? <ShaCopy key={index} sha={part}/> : part)}</div>;
}

export function JobDetail({data}: {data: JobResponse}) {
 const job = data.job;
 return <div class="job-detail">
  <header class="job-detail-heading">
   <nav class="job-crumb"><a href="#jobs">← Jobs</a> / <code>{job.id}</code></nav>
   <h1>{job.title ?? job.id}</h1>
   <div class="job-badges"><span class={`job-badge job-badge-${job.phase}`}><PhaseDot phase={job.phase}/>{job.phase}</span>{job.pr_url && <a class="job-badge job-badge-pr" href={job.pr_url}>{prNumber(job.pr_url)}{job.pr_status && ` ${job.pr_status}`} ↗</a>}<CiSignal job={job} badge/><span class="job-badge job-badge-review">review {reviewFact(job)}</span></div>
   {job.phase === "held" && <p>held = waiting on CI or review, normal for hours</p>}
  </header>
  <div class="job-detail-body"><div class="job-detail-main">
   {data.questions.map(q => <section class="job-question" key={q.id}><h2>{q.kind === "final_fix" ? "Final-fix approval open" : "Parent question open"}</h2><p><code>{q.id}</code> · {q.question}</p><p>Being handled by the operator session.</p></section>)}
   {data.asks.map(ask => <section class="job-question job-question-awaiting" key={ask.id}><h2>Awaiting you</h2><p>{ask.question}</p>{ask.options.map(option => <CopyReply key={option.label} reply={option.reply}/>)}</section>)}
   {job.summary && <p class="job-summary">{job.summary}</p>}{job.failure && <p class="job-failure">{job.failure}</p>}
  </div><div class="job-detail-side"><dl class="job-facts">
   <div class="job-fact-clock"><dt>Wall clock</dt><dd>{clockFact(job)}</dd></div>
   <div class="job-fact-cost"><dt>Cost</dt><dd>{job.cost_usd === null ? "not recorded" : money(job.cost_usd)}</dd></div>
   <div class="job-fact-model"><dt>Model</dt><dd><ModelFact job={job}/></dd></div>
   <div class="job-fact-head"><dt>Head</dt><dd>{job.head ? <ShaCopy sha={job.head}/> : "no commits yet"}</dd></div>
   <div class="job-fact-wide job-fact-context"><dt>Context</dt><dd>{job.context ? <ContextChip usage={job.context}/> : "none"}</dd></div>
   <div class="job-fact-wide job-fact-routing"><dt>Routing</dt><dd><RoutingFact job={job}/></dd></div>
   <div class="job-fact-mandate"><dt>Mandate</dt><dd>{job.mandate_id ? <a href="#map"><code>{job.mandate_id}</code> →</a> : "none"}</dd></div>
   <div class="job-fact-pr"><dt>PR</dt><dd>{prFact(job)}</dd></div>
   <div class="job-fact-ci"><dt>CI</dt><dd>{ciFact(job)}</dd></div>
   <div class="job-fact-review"><dt>Review</dt><dd>{reviewFact(job)}</dd></div>
  </dl><div class="job-links">{data.artifact_href ? <a href={data.artifact_href}>Artifact · {data.artifact_name}</a> : data.files_href ? <a href={data.files_href}>Files</a> : <span>Files unavailable</span>}{data.run_href ? <a href={data.run_href}>Run log</a> : <span>Run log unavailable</span>}</div></div>
   <section class="job-timeline"><h2>Timeline</h2>{data.timeline_truncated && <p class="job-meta">Recent recorded events shown</p>}{data.timeline.map((event, index) => <div class={`job-event job-event-${event.tone}`} key={`${event.at}-${index}`}><code>{time(event.at)}</code><span class="job-event-stem" aria-hidden="true"><span/></span><div><span>{event.label}</span><TimelineMeta meta={event.meta}/></div></div>)}{!data.timeline.length && <p class="jobs-empty">No recorded events.</p>}{job.phase !== "done" && <div class="job-event job-event-pending"><code></code><span class="job-event-stem" aria-hidden="true"><span/></span><div><span>Merge</span><p>not yet</p></div></div>}</section>
  </div>
 </div>;
}
