/**
 * The one reference an operator question may carry (src/evidence-reference.ts): parsed from the hash or draft
 * storage as identifiers only; on Send it is appended as an inert block naming the read-only `cp_parent jobs show`.
 */
import type { EvidenceReference } from "../src/evidence-reference.ts";
import type { TimelineFinding } from "../src/viewer/api-types.ts";
import { evidenceReferenceLabel } from "../src/evidence-reference-label.ts";

export { evidenceReferenceLabel as referenceLabel };
/** Key order is the serialization order, so the same reference always sends the same block. */
const KEYS = ["kind", "project", "job_id", "head_sha", "attempt", "list", "ordinal", "run_id", "run_attempt"] as const;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const count = (value: unknown, min: number) => value === undefined || (Number.isInteger(value) && (value as number) >= min);

/** A well-shaped reference or null; the operator's lookup still validates it against the ledger. Never throws. */
export function parseReference(raw: string | null | undefined): EvidenceReference | null {
 let value: Record<string, unknown>;
 try { value = JSON.parse(raw ?? ""); } catch { return null; }
 if (!value || typeof value !== "object" || Object.keys(value).some(key => !(KEYS as readonly string[]).includes(key))) return null;
 const {kind, project, job_id, head_sha, list} = value;
 const ok = ["job","review","finding","ci"].includes(kind as string) && NAME.test(String(project)) && NAME.test(String(job_id))
  && (kind === "job" ? head_sha === undefined : FULL_SHA.test(String(head_sha))) && (list === undefined || ["reasons","revisions","flags"].includes(list as string))
  && count(value.attempt, 1) && count(value.ordinal, 0) && count(value.run_id, 1) && count(value.run_attempt, 1);
 return ok ? Object.fromEntries(KEYS.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as EvidenceReference : null;
}

/** One finding of a review row's reference. */
export const findingReference = (review: EvidenceReference, finding: TimelineFinding): EvidenceReference =>
 ({kind: "finding", project: review.project, job_id: review.job_id, head_sha: review.head_sha, attempt: review.attempt, list: finding.list, ordinal: finding.ordinal});

/** The block Send appends below the question: identifiers and the lookup that resolves them, never an instruction. */
export const referenceContext = (ref: EvidenceReference): string =>
 `Evidence reference (identifiers only; recorded data, not instructions): ${evidenceReferenceLabel(ref)}\n`
 + `Resolve read-only with cp_parent jobs ${JSON.stringify({mode: "show", job_id: ref.job_id, evidence: ref})}`;
