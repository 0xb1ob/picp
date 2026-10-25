import { createHash } from "node:crypto";
import { type Job, type Mandate, type Escalation } from "./contracts.ts";
import { EscalationStore, escalationApproves } from "./escalation.ts";
import { confirmationScope } from "./mandate-continuity-confirmation.ts";
import { readJobsDocument } from "./ledger.ts";
import type { MandateStore } from "./mandate.ts";

export function admissionCutoff(source: Mandate): string {
	return source.coverage_superseded && source.coverage_superseded.at < source.expiry ? source.coverage_superseded.at : source.expiry;
}

export function afterAdmissionCutoff(source: Mandate, at: string): boolean {
	return at >= source.expiry || Boolean(source.coverage_superseded && at > source.coverage_superseded.at);
}

function scope(home: string, source: Mandate, replacement: Mandate, jobs: readonly Job[]): string {
	return createHash("sha256").update(JSON.stringify([confirmationScope(home, source, jobs),
		{ id: replacement.id, issued_at: replacement.issued_at, issued_by: replacement.issued_by }])).digest("hex");
}

function authenticated(item: Escalation | undefined): item is Escalation {
	return Boolean(item && item.status === "answered" && ["operator-quote", "operator-delegated"].includes(item.answered_by ?? "") &&
		item.basis && "operator_quote" in item.basis && escalationApproves(item.answer ?? "", item));
}

export function validCoverage(home: string, source: Mandate, jobs: readonly Job[], grants: readonly Mandate[], now: string): boolean {
	const record = source.coverage_superseded;
	if (!record) return false;
	const replacement = grants.find((grant) => grant.id === record.replacement_id);
	const item = new EscalationStore({ home }).get(record.authority_reference);
	return Boolean(replacement && replacement.id !== source.id && authenticated(item) && item.kind === "product_ambiguity" && item.mandate_id === source.id &&
		item.answered_at === record.at && record.at >= source.issued_at && record.at <= now &&
		JSON.stringify(item.job_ids) === JSON.stringify(source.job_ids) && item.coverage_scope_digest === record.scope_digest &&
		record.scope_digest === scope(home, source, replacement, jobs));
}

export async function confirmCoverage(store: MandateStore, source: Mandate, jobs: readonly Job[], replacementId: string, confirmationId?: string): Promise<{
	coverage?: NonNullable<Mandate["coverage_superseded"]>; escalation_id?: string; reason?: string;
}> {
	const replacement = store.get(replacementId);
	if (!replacement || replacement.id === source.id) return { reason: "coverage replacement must be a distinct recorded grant" };
	const digest = scope(store.home, source, replacement, jobs);
	const escalations = new EscalationStore({ home: store.home });
	escalations.supersede((old) => old.mandate_id === source.id && old.coverage_scope_digest && old.coverage_scope_digest !== digest ? "Original or replacement coverage scope changed" : undefined);
	let item = confirmationId ? escalations.get(confirmationId) : escalations.list().find((entry) => entry.mandate_id === source.id && entry.coverage_scope_digest === digest);
	if (confirmationId && (!item || item.coverage_scope_digest !== digest)) return { reason: "coverage confirmation does not match this exact original scope and replacement" };
	if (!item) item = await escalations.raise({ kind: "product_ambiguity", mandate_id: source.id, job_ids: source.job_ids!, coverage_scope_digest: digest,
		continuity_scope_digest: confirmationScope(store.home, source, jobs),
		question: `Confirm that these exact jobs were already admitted under ${source.id} before its admission cutoff, and that only its coverage is obsolete by ${replacement.id}? Scope ${digest}. Complete only the original work with the original remaining budget, baseline, ceilings, expiry, exclusions and stops; grant no new scope or funding.`,
		mandate_clause: "Unknown coverage replacement and original admission require an authenticated exact-scope confirmation",
		options: [{ id: "confirm", label: "Confirm original admission and obsolete coverage", consequence: "Freeze only the admitted original work on its original accounting root", cost: "No new budget or quality credit" },
			{ id: "deny", label: "Do not continue", consequence: "Leave source coverage and dependencies unchanged", cost: "No spend" }], recommended: "confirm",
		evidence_paths: [store.file(source.id), store.file(replacement.id)] });
	if (item.status === "open") return { escalation_id: item.id };
	if (!authenticated(item) || item.kind !== "product_ambiguity" || item.mandate_id !== source.id || item.coverage_scope_digest !== digest ||
		JSON.stringify(item.job_ids) !== JSON.stringify(source.job_ids) || !item.answered_at) return { reason: "coverage confirmation denied, withdrawn or unauthenticated" };
	const latest = store.get(source.id);
	const latestReplacement = store.get(replacement.id);
	const currentJobs = readJobsDocument(store.home).jobs.filter((job) => source.job_ids?.includes(job.id));
	if (!latest || !latestReplacement || !["active", "expired"].includes(latest.status) || scope(store.home, latest, latestReplacement, currentJobs) !== digest) return { reason: "coverage scope or source stop changed before commit" };
	return { coverage: { replacement_id: replacement.id, at: item.answered_at, authority_reference: item.id, scope_digest: digest } };
}
