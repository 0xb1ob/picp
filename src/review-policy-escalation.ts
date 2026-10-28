/**
 * A complete cp_review `escalate`/`policy` below the review cap is one operator question per head: cp_integrate raises
 * a `conflicting_acceptance` escalation citing that review file, and only an operator-quote `approve` answered after the
 * verdict clears that head. A push is a new head with no such verdict, so it never inherits; the cap stays final_fix's.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DiffVerdict, DiffVerdictSchema, type Escalation, paths, REVIEW_MAX_ATTEMPTS, validate } from "./contracts.ts";
import { EscalationStore } from "./escalation.ts";
import { shaMatches } from "./merge-ask.ts";

const OPTIONS = [
	{ id: "approve", label: "approve this head", consequence: "cp_integrate continues for this exact head; CI, repo permission and every other gate still decide", cost: "accepts the reviewer's escalation without another review" },
	{ id: "hold", label: "hold", consequence: "nothing merges; fix the diff and push a new head for cp_review, or drop the job", cost: "another implementation round" },
];

/** The latest review on `head` when it is a complete, reviewer-decided escalate/policy below the cap. */
function policyReview(home: string, jobId: string, head: string): { verdict: DiffVerdict; file: string } | undefined {
	for (let attempt = REVIEW_MAX_ATTEMPTS; attempt >= 1; attempt -= 1) {
		const file = paths.reviewFile(jobId, attempt);
		if (!existsSync(join(home, file))) continue;
		let parsed;
		try {
			parsed = validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(readFileSync(join(home, file), "utf8")));
		} catch {
			continue;
		}
		if (!parsed.ok || !shaMatches(parsed.value.head_sha, head)) continue;
		const v = parsed.value;
		const held = attempt < REVIEW_MAX_ATTEMPTS && v.verdict === "escalate" && v.cause === "policy" && Boolean(v.model) && !v.diff_stat.truncated;
		return held ? { verdict: v, file } : undefined;
	}
	return undefined;
}

function approvedByOperator(item: Escalation, verdict: DiffVerdict): boolean {
	const quoted = item.basis !== undefined && "operator_quote" in item.basis && !(item.answered_by ?? "").startsWith("mandate:");
	return item.status === "answered" && quoted && /^(?:approve|approved|yes)$/i.test(item.answer?.trim() ?? "") && (item.answered_at ?? "") >= verdict.decided_at;
}

function answersFor(store: EscalationStore, jobId: string, file: string): Escalation[] {
	return store.list({ jobId, kind: "conflicting_acceptance" }).filter((item) => item.evidence_paths.includes(file));
}

/** Teardown's read: the policy review on this head was approved on an operator quote. */
export function policyEscalationApproved(home: string, jobId: string, head: string): boolean {
	const held = policyReview(home, jobId, head);
	if (!held) return false;
	try {
		return answersFor(new EscalationStore({ home }), jobId, held.file).some((item) => approvedByOperator(item, held.verdict));
	} catch {
		return false;
	}
}

/**
 * cp_integrate's review hold for a policy escalate on `head`: undefined when it does not apply, "accepted" (fact pushed)
 * when an operator quote approved it, otherwise a surface naming the one escalation (raised here, duplicate-safe).
 */
export async function policyReviewHold(
	home: string,
	input: { jobId: string; head: string; facts: string[] },
): Promise<"accepted" | { next: "surface"; facts: string[]; reason: string } | undefined> {
	const { jobId, head, facts } = input;
	const held = policyReview(home, jobId, head);
	if (!held) return undefined;
	const short = head.slice(0, 12);
	const surface = (fact: string, reason: string) => ({ next: "surface" as const, facts: [...facts, fact], reason: `${jobId}: ${reason} Nothing was merged.` });
	try {
		const store = new EscalationStore({ home });
		const items = answersFor(store, jobId, held.file);
		const approved = items.find((item) => approvedByOperator(item, held.verdict));
		if (approved) {
			facts.push(`review: policy escalate on ${short} approved on an operator quote (${approved.id}) — not a reviewer pass`);
			return "accepted";
		}
		const answered = items.find((item) => item.status === "answered");
		if (answered) {
			return surface(`review: ${answered.id} answered "${answered.answer ?? "?"}" by ${answered.answered_by ?? "?"}`, `${answered.id} did not approve ${short} on an operator quote; fix the diff and push a new head for cp_review, or drop the job.`);
		}
		const open = items.find((item) => item.status === "open") ?? await store.raise({
			job_ids: [jobId],
			kind: "conflicting_acceptance",
			question: `${jobId}: cp_review attempt ${held.verdict.attempt} escalated (policy) on ${short}: ${held.verdict.reasons[0] ?? "no reason"}. Approve merging this exact head?`.slice(0, 1000),
			options: OPTIONS,
			recommended: "hold",
			evidence_paths: [held.file],
		});
		return surface(`review: policy escalate on ${short} awaits ${open.id}`, `cp_review escalated (policy) on ${short}; relay ${open.id} and answer it with cp_decide on an operator quote that names it. Do not re-review this head.`);
	} catch (error) {
		return surface(`review: policy escalation unreadable (${(error as Error).message})`, `the escalation store could not be read for ${short}.`);
	}
}
