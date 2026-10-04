/**
 * Operator risk:high pre-approval on a mandate (unload-parent PR0).
 *
 * `cp_mandate preapprove_risk` (or `issue … risk_preapproval`) records one verified, verbatim operator quote on a
 * grant. While it stands, `MandateStore.assertDispatchAllowed` lets a covered job's risk:high dispatch or promotion
 * pass `ask_on: risk:high` with no per-job escalation, and appends one audit row per pass. It never reaches a merge,
 * a checkpoint (`evaluateAuthority`), a script dispatch, or a job outside the grant; and a hard-stop act named in the
 * task text (credentials outside the repo, data deletion, force push, external publishing) still escalates as before.
 */
import { createHash } from "node:crypto";
import type { DelegationProvenance, Mandate, RiskPreapproval, RiskPreapprovedRow, RiskPreapprovedUse } from "./contracts.ts";
import { MandateError } from "./mandate-accounting.ts";
import { benignSenseAt, negatedAt, negatedHeadAt } from "./risk-negation.ts";

/** Narrow on purpose: these are the acts no standing approval covers. A negated mention ("never force-push") is not one. */
export const HARD_STOP_SIGNALS: ReadonlyArray<{ re: RegExp; why: string }> = Object.freeze([
	{ re: /~\/\.ssh\b|\bauth\.json\b|\b(?:rotat(?:e[sd]?|ing)|revok(?:e[sd]?|ing)|print(?:s|ed|ing)?|leak(?:s|ed|ing)?|exfiltrat\w*)\s+(?:(?:the|a|an|any|all|our)\s+)?(?:[\w-]+\s+)?(?:secrets?|tokens?|keys?|credentials?|passwords?)\b/i, why: "credential handling" },
	{ re: /\brm\s+-(?:rf|fr)\b|\bdrop\s+(?:table|database)\b|\b(?:delete|purge|wipe|truncate)\s+(?:(?:the|all)\s+)?(?:production|prod|user|customer)\s+data\b/i, why: "data deletion" },
	{ re: /\bforce[- ]?push\w*|\bgit\s+push\b[^\n]*?\s(?:-f|--force(?:-with-lease)?(?:=\S*)?|\+[^\s`'"]+)(?=[\s`'"]|$)/i, why: "force push" },
	{ re: /\bnpm\s+publish\b|\bgh\s+release\s+create\b|\bdocker\s+push\b|\bpublish(?:es|ed|ing)?\s+to\s+(?:npm|pypi|(?:the\s+)?registry)\b|\bdeploy(?:s|ed|ing)?\s+to\s+prod(?:uction)?\b/i, why: "external publishing" },
]);

/** `why: word` for every affirmative hard-stop act in `text`, in signal then text order. */
export function hardStops(text: string): string[] {
	const found = HARD_STOP_SIGNALS.flatMap(({ re, why }) => [...text.matchAll(new RegExp(re.source, "gi"))].map((match) => ({ at: match.index ?? 0, word: match[0], why })));
	const kept = found.filter(({ at, word }) => !negatedAt(text, at, word) && !negatedHeadAt(text, at) && !benignSenseAt(text, at, word));
	return [...new Set(kept.map(({ why, word }) => `hard stop ${why}: ${word}`.slice(0, 200)))];
}

/** Does `mandate`'s pre-approval name this job? `createdAt` is the ledger job's `created_at` (`MandateStore.jobCreatedAt`). */
export function preapprovalCovers(mandate: Mandate, job: { jobId: string; project: string }, createdAt: string | undefined): boolean {
	const pre = mandate.risk_preapproval;
	if (!pre) return false;
	if (pre.scope === "named_jobs") return pre.job_ids?.includes(job.jobId) === true;
	if (mandate.job_ids?.includes(job.jobId)) return true;
	return !mandate.job_ids?.length && mandate.projects.includes(job.project) && createdAt !== undefined && Date.parse(createdAt) >= Date.parse(mandate.issued_at);
}

/**
 * The risk:high gate's pre-approval read: covered only when every asking grant's pre-approval names the job, the
 * job is no script, and its text names no hard stop. `stops` travels into the escalation evidence when it is not.
 */
export function riskPreapproval(
	asking: readonly Mandate[],
	job: { jobId: string; project: string; pathHints?: readonly string[]; script?: boolean },
	createdAt: string | undefined,
): { covered: boolean; stops: string[] } {
	const stops = hardStops((job.pathHints ?? []).join("\n"));
	const named = asking.length > 0 && asking.every((grant) => preapprovalCovers(grant, job, createdAt));
	return { covered: named && !job.script && stops.length === 0, stops: named ? stops : [] };
}

export function quoteSha(quote: string): string {
	return createHash("sha256").update(quote).digest("hex").slice(0, 12);
}

export function preapprovedRow(grant: Mandate, jobId: string, use: RiskPreapprovedUse, at: string, evidence: readonly string[] = []): RiskPreapprovedRow {
	const pre = grant.risk_preapproval;
	if (!pre) throw new MandateError(`${grant.id} has no risk pre-approval`);
	const rows = evidence.map((line) => line.trim().slice(0, 200)).filter(Boolean).slice(0, 8);
	return { at, job_id: jobId, use, decided_by: "operator-delegated", quote_sha: quoteSha(pre.operator_quote), evidence: rows };
}

/** The record a verified quote (`requireOperatorQuote`, src/decide.ts) becomes; job ids make it `named_jobs`. */
export function preapprovalRecord(
	verified: { decidedBy: "operator-quote" | "operator-delegated"; stored: { operator_quote: string }; provenance?: DelegationProvenance },
	jobIds: readonly string[] | undefined,
	at: string,
): RiskPreapproval {
	return {
		operator_quote: verified.stored.operator_quote,
		decided_by: verified.decidedBy,
		...(verified.provenance ? { delegation_rule: verified.provenance.delegation_rule, send_id: verified.provenance.send_id } : {}),
		...(jobIds?.length ? { job_ids: [...new Set(jobIds)] } : {}),
		scope: jobIds?.length ? "named_jobs" : "mandate_jobs",
		granted_at: at,
	};
}

/** `mandate` carrying `record`, refused for a closed grant or a named job the grant's own `job_ids` leaves out. */
export function withPreapproval(mandate: Mandate, record: RiskPreapproval): Mandate {
	if (mandate.status === "revoked" || mandate.status === "expired") throw new MandateError(`${mandate.id} is ${mandate.status}; it cannot carry a risk pre-approval`);
	if (record.scope === "named_jobs" && !record.job_ids?.length) throw new MandateError("a named_jobs risk pre-approval needs job_ids");
	const outside = mandate.job_ids?.length ? (record.job_ids ?? []).filter((id) => !mandate.job_ids?.includes(id)) : [];
	if (outside.length > 0) throw new MandateError(`${mandate.id} does not cover ${outside.join(", ")}; a pre-approval never widens a grant`);
	return { ...mandate, risk_preapproval: record };
}

/** `cp_mandate show` lines: the quote (120 chars) and every audit row. */
export function formatPreapproval(mandate: Mandate): string[] {
	const pre = mandate.risk_preapproval;
	if (!pre) return [];
	const quote = pre.operator_quote.length > 120 ? `${pre.operator_quote.slice(0, 119)}…` : pre.operator_quote;
	const scope = pre.scope === "named_jobs" ? `jobs ${(pre.job_ids ?? []).join(", ")}` : "jobs created under this grant";
	return [
		`  risk:high pre-approved (dispatch/promote only, never merge) for ${scope} at ${pre.granted_at} by ${pre.decided_by} [${quoteSha(pre.operator_quote)}]: "${quote}"`,
		...(mandate.risk_preapproved ?? []).map((row) => `    - ${row.at} ${row.use} ${row.job_id} (${row.decided_by})${row.evidence.length ? `: ${row.evidence.join("; ")}` : ""}`),
	];
}
