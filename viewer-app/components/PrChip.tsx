import { createContext, Fragment } from "preact";
import type { PrChip } from "../../src/viewer/api-types.ts";

/** Sessions' chips by URL; the empty default keeps `Markdown` everywhere else a plain anchor. */
export const PrChips = createContext<Record<string, PrChip>>({});

const sha7 = (sha: string) => sha.slice(0, 7);
const jobText = (status: string) => `job ${status.replace("_", " ")}`;

/** Visible facts as [class, text]: `#N · state · CI … · review …`, or `issue #N · open|closed by #M · job …`. */
function segments(c: PrChip): [string, string][] {
 if (c.kind === "issue") return c.state === null ? [["pr-chip-num", `#${c.number}`]] : [["pr-chip-num", `issue #${c.number}`], ["pr-chip-state", c.closed_by ? `closed by #${c.closed_by.number}` : "open"],
  ...(c.job_status ? [["pr-chip-job", jobText(c.job_status)] as [string, string]] : [])];
 return [["pr-chip-num", `#${c.number}`], ["pr-chip-state", c.state === "merged" && c.merge_sha ? `merged ${sha7(c.merge_sha)}` : c.state ?? "unknown"],
  // Red CI reuses `.job-ci-red` (jobs.css), the palette rule's sanctioned coral for red CI.
  ...(c.ci ? [[`pr-chip-ci pr-chip-ci-${c.ci}${c.ci === "red" ? " job-ci-red" : ""}`, c.ci === "unreadable" ? "CI unreadable" : `CI ${c.ci}`] as [string, string]] : []),
  ...(c.review ? [[`pr-chip-review pr-chip-review-${c.review}`, `review ${c.review}`] as [string, string]] : [])];
}

/** The full sentence for `title`/`aria-label`; names the head only when one is recorded. */
function sentence(c: PrChip): string {
 const facts = c.kind === "issue"
  ? c.state === null ? ["no state on record"] : [c.closed_by ? `closed by #${c.closed_by.number} (merge on record)` : "open: no merged closing PR on record", ...(c.job_status ? [jobText(c.job_status)] : [])]
  : [c.state === "draft" ? "draft (not readied by CP)" : c.state === "merged" && c.merge_sha ? `merged as ${sha7(c.merge_sha)}` : c.state ?? "unknown",
   ...(c.ci ? [`CI ${c.ci}`] : []), ...(c.review ? [`review ${c.review}`] : []), ...(c.head_sha ? [`head ${sha7(c.head_sha)}`] : [])];
 return `${c.kind === "issue" ? "Issue" : "PR"} ${c.repo}#${c.number}: ${facts.join(", ")}`;
}

/** A PR or issue link as a chip; a state-less issue is a plain link chip with no dot. */
export function PrChipLink({ chip }: { chip: PrChip }) {
 const label = sentence(chip);
 return <a class={`pr-chip pr-chip-${chip.state ?? "none"}${chip.kind === "issue" ? " issue-chip" : ""}`} href={chip.url} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
  {chip.state !== null && <span class="pr-chip-dot" aria-hidden="true"/>}
  {/* Spaces keep the text apart ("#381 draft") where chip CSS is absent; flex drops them and spaces by gap. */}
  {segments(chip).map(([cls, text], i) => <Fragment key={i}>{i > 0 && " "}<span class={cls}>{text}</span></Fragment>)}
 </a>;
}
