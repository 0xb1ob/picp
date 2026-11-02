/**
 * P1 ask-about-evidence: the identifiers a Job page row carries for an operator question, derived from recorded fields
 * only (never a label, a time or a URL), and the identifiable findings of exactly that review attempt.
 */
import { join } from "node:path";
import type { EvidenceReference } from "../evidence-reference.ts";
import { FLAG_ORDER } from "../evidence-reference-label.ts";
import { redactSecrets } from "../redact-secrets.ts";
import type { TimelineFinding } from "./api-types.ts";
import { type Json, obj, readObject, str, type ViewerState } from "./sessions.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** DECISION_CONTEXT_MAX_FINDINGS and DECISION_CONTEXT_LINE_MAX_CHARS (contracts), not imported across the boundary. */
const FINDINGS_MAX = 12;
const LINE_MAX = 160;
const REVIEW_MAX_ATTEMPTS = 5;
const ORDINAL_MAX = 63;
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER) => (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max ? (value as number) : undefined);

/** The job's reference; null without a ledger project, which `cp_parent jobs show` checks first. */
export const jobReference = (project: string | undefined, jobId: string): EvidenceReference | null =>
	project && NAME.test(project) ? { kind: "job", project, job_id: jobId } : null;

/** A review or CI outcome row's reference: without a full head (or attempt) it falls back to the job, never a guess. */
export function rowReference(job: EvidenceReference | null, type: unknown, payload: Json | undefined): EvidenceReference | undefined {
	const ci = type === "ci_observed" && (payload?.event === "ci_green" || payload?.event === "ci_failed");
	if (!job || (type !== "review_decided" && !ci)) return undefined;
	const head = str(payload?.head_sha);
	if (!head || !FULL_SHA.test(head)) return job;
	const at = { project: job.project, job_id: job.job_id, head_sha: head };
	if (!ci) {
		const attempt = positive(payload?.attempt, REVIEW_MAX_ATTEMPTS);
		return attempt ? { kind: "review", ...at, attempt } : job;
	}
	// A CI row without a run id names every observation of the head (labelled so), never "this run".
	const run = positive(payload?.run_id);
	const runAttempt = run ? positive(payload?.run_attempt) : undefined;
	return { kind: "ci", ...at, ...(run ? { run_id: run } : {}), ...(runAttempt ? { run_attempt: runAttempt } : {}) };
}

const line = (text: string) => {
	const collapsed = redactSecrets(text.replace(/\s+/g, " ").trim());
	return collapsed.length <= LINE_MAX ? collapsed : `${collapsed.slice(0, LINE_MAX - 1)}\u2026`;
};

/** review-<attempt>.json's findings only when it is this job's verdict on the referenced head; capped, rest counted. */
export function reviewFindings(state: ViewerState, ref: EvidenceReference): { findings: TimelineFinding[]; elided: number } {
	const verdict = readObject(join(state.stateDir, "runs", ref.job_id, `review-${ref.attempt}.json`));
	if (!verdict || verdict.job_id !== ref.job_id || verdict.attempt !== ref.attempt || verdict.head_sha !== ref.head_sha) return { findings: [], elided: 0 };
	const all: TimelineFinding[] = [];
	for (const list of ["reasons", "revisions"] as const) {
		const items = Array.isArray(verdict[list]) ? (verdict[list] as unknown[]) : [];
		items.forEach((text, ordinal) => {
			if (typeof text === "string" && ordinal <= ORDINAL_MAX) all.push({ list, ordinal, text: line(text) });
		});
	}
	FLAG_ORDER.forEach((flag, ordinal) => {
		if (obj(verdict.flags)?.[flag] === true) all.push({ list: "flags", ordinal, text: flag });
	});
	return { findings: all.slice(0, FINDINGS_MAX), elided: Math.max(0, all.length - FINDINGS_MAX) };
}
