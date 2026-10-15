import type { ViewerJob } from "../../src/viewer/api-types.ts";
import { shortSha } from "../format.ts";

export function PhaseDot({phase}:{phase:string}) { return <span aria-hidden="true" class={`job-dot job-dot-${phase}`}/>; }

/** `review not started` until a review has run; then `review N/5 · <verdict>`. */
export const reviewText = (job:ViewerJob) => {
 const verdict = job.review === "revise" ? "changes requested" : job.review ?? "not recorded for this head";
 return job.review_attempts ? `review ${job.review_attempts}/5 · ${verdict}` : "review not started";
};

/** The red badge for a CI read the token was refused (ask-81b54d83f0b2): never "no CI yet". */
export const CI_UNREADABLE_LABEL = "CI unreadable — token lacks Actions/checks read";
export const CI_READ_NEEDED = "needs fine-grained PAT: Actions read + Checks read + Commit statuses read; classic: repo";
/** `no CI yet` when nothing has run; the red badge when the token was refused; otherwise `CI <state> <sha7>`, `(forwarded)` when only the operator saw it. */
export function CiSignal({job,badge=false}:{job:ViewerJob;badge?:boolean}) {
 const cls = (tone: string) => `job-ci job-ci-${tone}${badge ? " job-badge" : ""}`;
 const tone = (ci: string) => ci === "failed" ? "red" : ci === "in_progress" ? "running" : ci;
 const sha = shortSha(job.head);
 // Forwarded CI only fills what native CI cannot say, and stays labelled: native evidence alone gates the handoff.
 const fwd = job.ci == null || job.ci === "unknown" || job.ci === "unreadable" ? job.ci_forwarded : null;
 const fwdTitle = fwd ? `CI ${tone(fwd.ci)} forwarded by the operator ${fwd.observed_at}${fwd.url ? ` (${fwd.url})` : ""}; display only, native CI still gates the handoff` : null;
 if (job.ci === "unreadable") return <span class={cls("red job-ci-unreadable")} title={[`${CI_UNREADABLE_LABEL}: ${CI_READ_NEEDED}`,fwdTitle].filter(Boolean).join("\n")}><span class="job-ci-dot" aria-hidden="true"/>{CI_UNREADABLE_LABEL}{fwd && <small class="job-ci-forwarded"> · forwarded: CI {tone(fwd.ci)}</small>}</span>;
 if (fwd) return <span class={cls(`${tone(fwd.ci)} job-ci-forwarded`)} title={fwdTitle ?? undefined}><span class="job-ci-dot" aria-hidden="true"/>CI {tone(fwd.ci)} (forwarded){sha && <> <code>{sha}</code></>}</span>;
 const ci = job.ci == null ? null : tone(job.ci);
 return <span class={cls(ci ?? "none")}><span class="job-ci-dot" aria-hidden="true"/>{job.ci == null ? "no CI yet" : <>CI {ci}{sha && <> <code>{sha}</code></>}</>}</span>;
}

/** The model without its provider prefix (`anthropic/claude-opus-5-5` → `claude-opus-5-5`); the full id stays in the title. */
export const shortModel = (id:string | null) => id ? id.slice(id.lastIndexOf("/")+1) : "-";

export function ModelName({job}:{job:ViewerJob}) { const id=job.script_path ?? job.model; return <code title={id ?? undefined}>{shortModel(id)}</code>; }
