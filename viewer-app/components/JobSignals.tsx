import type { ViewerJob } from "../../src/viewer/api-types.ts";
import { shortSha } from "../format.ts";

export function PhaseDot({phase}:{phase:string}) { return <span aria-hidden="true" class={`job-dot job-dot-${phase}`}/>; }

/** `review not started` until a review has run; then `review N/5 · <verdict>`. */
export const reviewText = (job:ViewerJob) => {
 const verdict = job.review === "revise" ? "changes requested" : job.review ?? "not recorded for this head";
 return job.review_attempts ? `review ${job.review_attempts}/5 · ${verdict}` : "review not started";
};

/** `no CI yet` when nothing has run; otherwise `CI <state> <sha7>`. */
export function CiSignal({job,badge=false}:{job:ViewerJob;badge?:boolean}) {
 const ci = job.ci === "failed" ? "red" : job.ci === "in_progress" ? "running" : job.ci;
 const sha = shortSha(job.head);
 return <span class={`job-ci job-ci-${ci ?? "none"}${badge ? " job-badge" : ""}`}><span class="job-ci-dot" aria-hidden="true"/>{job.ci == null ? "no CI yet" : <>CI {ci}{sha && <> <code>{sha}</code></>}</>}</span>;
}

/** The model without its provider prefix (`anthropic/claude-opus-5-5` → `claude-opus-5-5`); the full id stays in the title. */
export const shortModel = (id:string | null) => id ? id.slice(id.lastIndexOf("/")+1) : "-";

export function ModelName({job}:{job:ViewerJob}) { const id=job.script_path ?? job.model; return <code title={id ?? undefined}>{shortModel(id)}</code>; }
