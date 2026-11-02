/**
 * The identifier-only reference an operator question may carry: a job, one review attempt, one finding inside it,
 * or the CI observations of one head (one run when its id was recorded). Pure: no filesystem, no policy.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { isSafeJobId, isSafeProjectName, JOB_ID_PATTERN, PROJECT_NAME_PATTERN, REVIEW_MAX_ATTEMPTS } from "./contracts.ts";
import { FLAG_ORDER } from "./evidence-reference-label.ts";

export const EVIDENCE_KINDS = ["job", "review", "finding", "ci"] as const;
export const FINDING_LISTS = ["reasons", "revisions", "flags"] as const;
export const FULL_SHA_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
const FULL_SHA_RE = new RegExp(FULL_SHA_PATTERN);
const FINDING_MAX_ORDINAL = 63;

export const EvidenceReferenceSchema = Type.Object(
	{
		kind: StringEnum([...EVIDENCE_KINDS], { description: "job; review (head_sha+attempt); finding (review + list+ordinal); ci (head_sha, run_id when recorded)" }),
		project: Type.String({ pattern: PROJECT_NAME_PATTERN, description: "the job's project label" }),
		job_id: Type.String({ pattern: JOB_ID_PATTERN, description: "must equal jobs.job_id" }),
		head_sha: Type.Optional(Type.String({ pattern: FULL_SHA_PATTERN, description: "review/finding/ci: the full recorded head sha" })),
		attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: REVIEW_MAX_ATTEMPTS, description: "review/finding: the review attempt" })),
		list: Type.Optional(StringEnum([...FINDING_LISTS], { description: "finding: the verdict list it sits in" })),
		ordinal: Type.Optional(Type.Integer({ minimum: 0, maximum: FINDING_MAX_ORDINAL, description: "finding: zero-based position in that list" })),
		run_id: Type.Optional(Type.Integer({ minimum: 1, description: "ci: the recorded run id; absent means every observation of the head" })),
		run_attempt: Type.Optional(Type.Integer({ minimum: 1, description: "ci: the recorded run attempt, only with run_id" })),
	},
	{ additionalProperties: false, description: "show: resolve one recorded piece of evidence, read-only; identifiers only" },
);
export type EvidenceReference = Static<typeof EvidenceReferenceSchema>;

const ALLOWED: Record<EvidenceReference["kind"], readonly string[]> = {
	job: ["kind", "project", "job_id"],
	review: ["kind", "project", "job_id", "head_sha", "attempt"],
	finding: ["kind", "project", "job_id", "head_sha", "attempt", "list", "ordinal"],
	ci: ["kind", "project", "job_id", "head_sha", "run_id", "run_attempt"],
};
const int = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** Every reason this value is not a well-formed reference; empty when it is one. Never throws. */
export function evidenceReferenceErrors(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return ["evidence must be an object"];
	const ref = value as Record<string, unknown>;
	const kind = ref.kind as EvidenceReference["kind"];
	if (!EVIDENCE_KINDS.includes(kind)) return [`evidence.kind must be one of ${EVIDENCE_KINDS.join("|")}`];
	const errors = Object.keys(ref).filter((key) => !ALLOWED[kind].includes(key)).map((key) => `evidence.${key} does not apply to a ${kind} reference`);
	if (typeof ref.project !== "string" || !isSafeProjectName(ref.project)) errors.push("evidence.project must be a project name");
	if (typeof ref.job_id !== "string" || !isSafeJobId(ref.job_id)) errors.push("evidence.job_id must be a job id");
	if (kind !== "job" && (typeof ref.head_sha !== "string" || !FULL_SHA_RE.test(ref.head_sha))) errors.push("evidence.head_sha must be a full lowercase sha");
	if ((kind === "review" || kind === "finding") && !int(ref.attempt, 1, REVIEW_MAX_ATTEMPTS)) errors.push(`evidence.attempt must be 1..${REVIEW_MAX_ATTEMPTS}`);
	if (kind === "finding" && !FINDING_LISTS.includes(ref.list as never)) errors.push(`evidence.list must be one of ${FINDING_LISTS.join("|")}`);
	if (kind === "finding" && !int(ref.ordinal, 0, ref.list === "flags" ? FLAG_ORDER.length - 1 : FINDING_MAX_ORDINAL)) errors.push("evidence.ordinal is out of range");
	if (kind === "ci" && ref.run_id !== undefined && !int(ref.run_id, 1)) errors.push("evidence.run_id must be a positive integer");
	if (kind === "ci" && ref.run_attempt !== undefined && (!int(ref.run_attempt, 1) || ref.run_id === undefined)) errors.push("evidence.run_attempt needs run_id and must be a positive integer");
	return errors;
}

export { evidenceReferenceLabel, FLAG_ORDER } from "./evidence-reference-label.ts";
