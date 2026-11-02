import type { ReviewGuide as Guide } from "../../src/viewer/api-types.ts";
import { observedTime, prNumber, shortSha } from "../format.ts";
import { parkedPendingText } from "./JobSignals.tsx";
import "./review-guide.css";

/** Full commit ids, never abbreviated: the reader compares them against GitHub. */
const Sha = ({sha}: {sha: string}) => <code class="review-guide-sha">{sha}</code>;
const VERDICT: Record<string, string> = {pass: "pass", revise: "changes requested", escalate: "escalated"};
const verdictText = (v: string | null) => v ? VERDICT[v] ?? v : "not recorded";
const CI: Record<string, string> = {green: "green", failed: "red", red: "red", in_progress: "running", unknown: "unknown"};

function freshnessText(g: Guide): string {
 if (g.freshness === "current") return "Current: the reviewed commit is the latest observed PR head.";
 if (g.freshness === "unknown") return "Unknown: no observation of the PR head is recorded for this hand-off cycle; the review may not describe the PR now.";
 if (g.handoff.state === "merged") return "Historical: this job merged; the summary below is what the local records kept.";
 return g.reviewed_head && g.handed_head && g.reviewed_head !== g.handed_head
  ? "Historical: no review is recorded for the handed-off head."
  : "Historical: the PR head moved after this review; it does not describe the new code.";
}

function sinceText(g: Guide) {
 if (g.kind === "equivalent") return <p>Pass by patch equivalence: no reviewer ran on this head. Its patch is identical to the pass recorded by attempt {g.source_attempt} on <Sha sha={g.source_head!}/>.</p>;
 if (g.kind === "delta") return <><p>Delta review: attempt {g.attempt} reviewed only the change from <Sha sha={g.delta_from!}/> to <Sha sha={g.reviewed_head!}/>.</p>
  {g.compare_href && <p><a href={g.compare_href} target="_blank" rel="noopener noreferrer">Compare {shortSha(g.delta_from)}..{shortSha(g.reviewed_head)} on GitHub ↗</a></p>}</>;
 if (g.kind === "full") return <p>Initial full review of the branch{g.file_count === null ? "" : ` (${g.file_count} ${g.file_count === 1 ? "file" : "files"})`}; no earlier review to compare against.</p>;
 return <p>No review is recorded.</p>;
}

function ciText(g: Guide): string {
 const head = g.ci.head ? ` on ${shortSha(g.ci.head)}` : "";
 if (g.ci.state === "missing") return g.ci.head ? "No CI result is recorded for the reviewed commit." : "No reviewed commit, so no CI result to show.";
 if (g.ci.state === "unreadable") return `CI unreadable${head}: the token was refused the CI read.`;
 const where = g.ci.source === "watch" ? "CI watch" : "recorded CI event";
 return `${CI[g.ci.state] ?? g.ci.state}${head} (${where}${g.ci.at ? `, ${observedTime(g.ci.at)}` : ""})`;
}

function handoffText(g: Guide): string {
 const h = g.handoff;
 if (h.state === "merged") return h.merged_at ? `Merged ${observedTime(h.merged_at)}${h.merge_sha ? ` as ${shortSha(h.merge_sha)}` : ""}.` : "The PR merged.";
 if (h.state === "pending") return `picp owes a step: ${parkedPendingText(h.pending) ?? "pending"}${h.pending_at ? `, observed ${observedTime(h.pending_at)}` : ""}.`;
 if (h.state === "closed") return `The PR was closed without merging (cycle ${g.cycle ?? "?"}).`;
 if (h.state === "with_team") return `With the team${h.handed_at ? ` since ${observedTime(h.handed_at)}` : ""}${g.cycle ? ` (hand-off cycle ${g.cycle})` : ""}: waiting on a human review and merge. picp does nothing until the team acts.`;
 return "Not handed off.";
}

/** P2: the five reading sections for a handed-off PR, from recorded evidence; links open the forge, nothing acts. */
export function ReviewGuide({guide: g}: {guide: Guide}) {
 const pr = g.pr_url ? <a href={g.pr_url} target="_blank" rel="noopener noreferrer">{prNumber(g.pr_url) ?? "PR"} ↗</a> : <span>no PR link recorded</span>;
 const approvals = g.handoff.approvals === null ? "approvals unknown this cycle" : `${g.handoff.approvals}/${g.handoff.approvals_required ?? "?"} approvals this cycle`;
 return <section class={`review-guide review-guide-${g.freshness}`} aria-label="Review guide" data-key={g.key}>
  <h2>Review guide</h2>
  <section class="review-guide-task">
   <h3>Task and head</h3>
   <p>{g.task ?? "No task description recorded."}</p>
   <dl>
    <div><dt>PR</dt><dd>{pr}</dd></div>
    <div><dt>Reviewed commit</dt><dd>{g.reviewed_head ? <><Sha sha={g.reviewed_head}/> <span class="review-guide-meta">attempt {g.attempt} · {verdictText(g.verdict)}{g.reviewed_at ? ` · ${observedTime(g.reviewed_at)}` : ""}</span></> : "no review record retained"}</dd></div>
    <div><dt>Latest observed head</dt><dd>{g.observed_head ? <><Sha sha={g.observed_head}/> <span class="review-guide-meta">observed {g.observed_at ? observedTime(g.observed_at) : "at an unrecorded time"}</span></> : "unknown: not observed this cycle"}</dd></div>
   </dl>
   <p class="review-guide-freshness" role="status">{freshnessText(g)}</p>
  </section>
  <section class="review-guide-start">
   <h3>Start here</h3>
   {g.truncated && <p class="review-guide-warn">The reviewer saw a truncated diff{g.file_count === null ? "" : ` of ${g.file_count} files`}: this review does not cover the whole change.</p>}
   <ol>
    {g.stops.map((s, i) => <li key={i}><span class="review-guide-meta">attempt {s.attempt} · {s.list === "revisions" ? "revision request" : "reviewer reason"}{s.historical ? ` · earlier review (${verdictText(s.verdict)} on ${shortSha(s.head)}), not marked resolved` : ""}</span> {s.text}</li>)}
    <li class="review-guide-files">{g.files_href ? <a href={g.files_href} target="_blank" rel="noopener noreferrer">PR Files ↗</a> : <span>PR files: no safe link recorded</span>} <span class="review-guide-meta">no recorded finding names a file or line</span></li>
   </ol>
   {!g.stops.length && <p class="review-guide-meta">No findings or revision requests are recorded.</p>}
   {g.omitted_count > 0 && <p class="review-guide-meta">{g.omitted_count} more recorded {g.omitted_count === 1 ? "concern" : "concerns"} not shown.</p>}
  </section>
  <section class="review-guide-since">
   <h3>Since the previous review</h3>
   {sinceText(g)}
  </section>
  <section class="review-guide-ci">
   <h3>CI and remaining judgment</h3>
   <p>{ciText(g)}</p>
   {g.ci.read_failure && g.ci.state !== "unreadable" && <p class="review-guide-warn">The latest CI read was refused; that failure says nothing about this commit.</p>}
   {g.ci.forwarded && <p>Forwarded by the operator, display only: {CI[g.ci.forwarded.ci] ?? g.ci.forwarded.ci}, {observedTime(g.ci.forwarded.observed_at)}{g.ci.forwarded.url && <> · <a href={g.ci.forwarded.url} target="_blank" rel="noopener noreferrer">run ↗</a></>}</p>}
   <p>Reviewer verdict: {verdictText(g.verdict)}{g.model ? ` (${g.model})` : ""}.{g.flags.length ? ` Flags: ${g.flags.join(", ")}.` : ""}{g.stops.some(s => !s.historical) ? " Its recorded reasons are in Start here; no severity is recorded for them." : ""}</p>
  </section>
  <section class="review-guide-handoff">
   <h3>Handoff status</h3>
   <p>{handoffText(g)}</p>
   {g.handoff.state !== "merged" && g.handoff.state !== "not_parked" && <p class="review-guide-meta">{approvals}{g.handoff.last_human_activity_at ? ` · human activity ${observedTime(g.handoff.last_human_activity_at)}` : " · no human activity recorded"}</p>}
   {g.incomplete.length > 0 && <ul class="review-guide-incomplete" aria-label="Incomplete records">{g.incomplete.map((line, i) => <li key={i}>{line}</li>)}</ul>}
   {g.pr_url && <p><a class="review-guide-pr" href={g.pr_url} target="_blank" rel="noopener noreferrer">Open {prNumber(g.pr_url) ?? "the PR"} ↗</a></p>}
  </section>
 </section>;
}
