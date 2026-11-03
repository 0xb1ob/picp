import { createContext, Fragment } from "preact";
import type { PrChip } from "../../src/viewer/api-types.ts";

/** Sessions' chips by URL; the empty default keeps `Markdown` everywhere else a plain anchor. */
export const PrChips = createContext<Record<string, PrChip>>({});

const sha7 = (sha: string) => sha.slice(0, 7);
const jobText = (status: string) => `job ${status.replace("_", " ")}`;

/** A PR's merge slot: the latest recorded PR state, `merged <sha>` once merged; null/unknown stays unknown. */
const mergeText = (c: PrChip) => c.state === "merged" ? c.merge_sha ? `merged ${sha7(c.merge_sha)}` : "merged" : !c.state || c.state === "unknown" ? "merge unknown" : c.state;
/** Visible facts as [class, text]: `#N · review … · CI … · merge slot` (unknowns named), or an issue's. */
function segments(c: PrChip): [string, string][] {
 if (c.kind === "issue") return c.state === null ? [["pr-chip-num", `#${c.number}`]] : [["pr-chip-num", `issue #${c.number}`], ["pr-chip-state", c.closed_by ? `closed by #${c.closed_by.number}` : "open"],
  ...(c.job_status ? [["pr-chip-job", jobText(c.job_status)] as [string, string]] : [])];
 const ci = c.ci ?? "unknown", review = c.review ?? "unknown";
 return [["pr-chip-num", `#${c.number}`], [`pr-chip-review pr-chip-review-${review}`, `review ${review}`],
  // Red CI reuses `.job-ci-red` (jobs.css), the palette rule's sanctioned coral for red CI.
  [`pr-chip-ci pr-chip-ci-${ci}${ci === "red" ? " job-ci-red" : ""}`, ci === "unreadable" ? "CI unreadable" : `CI ${ci}`], ["pr-chip-state", mergeText(c)]];
}

/** The full sentence for `title`/`aria-label`: the latest recorded state, never proof of when it held. */
function sentence(c: PrChip): string {
 const facts = c.kind === "issue"
  ? c.state === null ? ["no state on record"] : [c.closed_by ? `closed by #${c.closed_by.number} (merge on record)` : "open: no merged closing PR on record", ...(c.job_status ? [jobText(c.job_status)] : [])]
  : [`review ${c.review ?? "unknown"}`, `CI ${c.ci ?? "unknown"}`, c.state === "draft" ? "draft (not readied by CP)" : c.state === "merged" && c.merge_sha ? `merged as ${sha7(c.merge_sha)}` : mergeText(c),
   ...(c.head_sha ? [`head ${sha7(c.head_sha)}`] : [])];
 return `${c.kind === "issue" ? "Issue" : "PR"} ${c.repo}#${c.number}, latest recorded: ${facts.join(", ")}`;
}

/** A PR or issue link as a chip; a state-less issue is a plain link chip with no dot. */
export function PrChipLink({ chip }: { chip: PrChip }) {
 const label = sentence(chip);
 return <a class={`pr-chip pr-chip-${chip.state ?? "none"}${chip.kind === "issue" ? " issue-chip" : ""}`} href={chip.url} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
  {chip.state !== null && <span class="pr-chip-dot" aria-hidden="true"/>}
  {/* Spaces keep the text apart ("#N draft") where chip CSS is absent; flex drops them and spaces by gap. */}
  {segments(chip).map(([cls, text], i) => <Fragment key={i}>{i > 0 && " "}<span class={cls}>{text}</span></Fragment>)}
 </a>;
}
