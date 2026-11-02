/** Dependency-free half of src/evidence-reference.ts, shared with the viewer: flag order and the short label. */
import type { EvidenceReference } from "./evidence-reference.ts";

/** A finding in `flags` is the flag at this zero-based position, whatever the others hold. */
export const FLAG_ORDER = ["destructive_scope", "scope_growth", "blocking_unknowns"] as const;

/** A short human label: `review 2 of cp-x @ 1a2b3c4d5e6f`. Identifiers only. */
export function evidenceReferenceLabel(ref: EvidenceReference): string {
	const head = ref.head_sha ? ` @ ${ref.head_sha.slice(0, 12)}` : "";
	if (ref.kind === "job") return `job ${ref.job_id} (${ref.project})`;
	if (ref.kind === "review") return `review ${ref.attempt} of ${ref.job_id}${head}`;
	if (ref.kind === "finding") return `review ${ref.attempt} ${ref.list}[${ref.ordinal}] of ${ref.job_id}${head}`;
	if (ref.run_id === undefined) return `CI observations for ${ref.job_id}${head}`;
	return `CI run ${ref.run_id}${ref.run_attempt === undefined ? "" : ` attempt ${ref.run_attempt}`} of ${ref.job_id}${head}`;
}
