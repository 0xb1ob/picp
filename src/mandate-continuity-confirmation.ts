import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Job, type Mandate, paths, REVIEW_ORIGINAL_TASK_MAX_BYTES } from "./contracts.ts";
import { EscalationStore, escalationApproves } from "./escalation.ts";
import { admittedWork, governingInputs, originalScopeDigest, sourceFingerprint } from "./mandate-continuity.ts";
import { parseJobLabels } from "./ledger.ts";
import type { MandateStore } from "./mandate.ts";
import { atomicWriteText } from "./json-store.ts";

export function confirmationScope(home: string, source: Mandate, jobs: readonly Job[]): string {
	let inputs = governingInputs(home, jobs);
	const receipt = source.continuity;
	if (receipt) {
		const file = `${join(home, paths.mandateFile(source.id))}.governing-inputs`;
		const text = readFileSync(file, "utf8");
		if (receipt.governing_input_refs.length !== 1 || receipt.governing_input_refs[0] !== file ||
			Buffer.byteLength(text) > REVIEW_ORIGINAL_TASK_MAX_BYTES ||
			createHash("sha256").update(text).digest("hex") !== receipt.governing_input_digest) {
			throw new Error(`${source.id}: frozen confirmation input is missing or changed`);
		}
		try { inputs = (JSON.parse(text) as { inputs: typeof inputs }).inputs; }
		catch (cause) { throw new Error(`${source.id}: invalid frozen confirmation input`, { cause }); }
	}
	return createHash("sha256").update(JSON.stringify({
		source: sourceFingerprint({ ...source, admissions: undefined }),
		inputs: inputs.map(({ job, task, task_file, addenda }) => ({ scope: originalScopeDigest(job), task, task_file, addenda })),
	})).digest("hex");
}

export function confirmedAdmission(home: string, source: Mandate, jobs: readonly Job[], id?: string): string | undefined {
	const reference = id ?? source.continuity?.authority_reference.replace(/^confirmation:/, "");
	if (!reference?.startsWith("es-")) return undefined;
	const item = new EscalationStore({ home }).get(reference);
	if (!item || item.kind !== "product_ambiguity" || item.mandate_id !== source.id ||
		item.continuity_scope_digest !== confirmationScope(home, source, jobs) ||
		JSON.stringify(item.job_ids) !== JSON.stringify(source.job_ids) || item.status !== "answered" ||
		!escalationApproves(item.answer ?? "", item) || !["operator-quote", "operator-delegated"].includes(item.answered_by ?? "") ||
		!item.basis || !("operator_quote" in item.basis)) return undefined;
	return item.id;
}

export async function admissionEvidence(store: MandateStore, source: Mandate, jobs: readonly Job[], confirmationId?: string): Promise<{
	admissions?: NonNullable<Mandate["admissions"]>; authority_reference?: string; escalation_id?: string; reason?: string; confirmation_required?: boolean;
}> {
	const confirmed = confirmedAdmission(store.home, source, jobs, confirmationId);
	const admissions = jobs.flatMap((job) => {
		const old = source.admissions?.find((entry) => entry.job_id === job.id);
		if (old && admittedWork(source, job, confirmed)) return [old];
		const labels = parseJobLabels(job.labels);
		if (!labels.project || !labels.kind) return [];
		const identity = { job_id: job.id, project: labels.project, kind: labels.kind, scope_digest: originalScopeDigest(job) };
		if (job.created_at <= source.issued_at && job.updated_at < source.issued_at &&
			source.usage_baseline?.some((entry) => entry.job_id === job.id) &&
			existsSync(join(store.home, paths.originalTaskFile(job.id)))) return [{ ...identity, admitted_at: source.issued_at }];
		return confirmed ? [{ ...identity, confirmation_escalation_id: confirmed }] : [];
	});
	const defaultExpiry = ["home", "project"].includes(source.provenance?.expiry_hours ?? "");
	if (admissions.length === jobs.length && (defaultExpiry || source.expiry > store.authorityNow() || confirmed)) {
		return { admissions, authority_reference: confirmed ? `confirmation:${confirmed}` : `${source.id}:typed-admission` };
	}
	const scope = confirmationScope(store.home, source, jobs);
	const escalations = new EscalationStore({ home: store.home });
	if (confirmationId && !confirmed) return { reason: "confirmation is missing, denied, unauthenticated or for different scope" };
	const existing = escalations.list().find((item) => item.kind === "product_ambiguity" && item.mandate_id === source.id && item.continuity_scope_digest === scope);
	if (existing && existing.status !== "open") return { reason: "original admission confirmation was denied or withdrawn", escalation_id: existing.id };
	escalations.supersede((item) => item.kind === "product_ambiguity" && item.mandate_id === source.id &&
		item.continuity_scope_digest && item.continuity_scope_digest !== scope ? "original continuity input changed" : undefined);
	const inputFile = `${store.file(source.id)}.confirmation-${scope}`;
	if (!existsSync(inputFile)) {
		const text = JSON.stringify({ authority: source, inputs: governingInputs(store.home, jobs) });
		if (Buffer.byteLength(text) > REVIEW_ORIGINAL_TASK_MAX_BYTES) throw new Error("confirmation input exceeds the byte cap; nothing truncated");
		atomicWriteText(inputFile, text, { mode: 0o600, syncDir: true });
	}
	const item = existing ?? await escalations.raise({
		kind: "product_ambiguity", mandate_id: source.id, job_ids: source.job_ids!, continuity_scope_digest: scope,
		mandate_clause: `${source.id}: confirm original admission only; original caps, baseline and stops remain binding`,
		question: `Confirm that ${source.job_ids!.join(", ")} are the complete unchanged original admitted work under ${source.id}${defaultExpiry || source.provenance?.expiry_hours === "explicit" ? "" : ", and its expiry was a default admission window rather than an explicit completion deadline"}? No new work or budget is authorized.`,
		options: [{ id: "confirm", label: "Confirm original admission", consequence: "Continue only these preserved inputs under the original remaining limits", cost: "No new budget" },
			{ id: "deny", label: "Deny", consequence: "Do not create completion authority", cost: "No new spend" }],
		recommended: "confirm", evidence_paths: [store.file(source.id), inputFile],
	});
	return { escalation_id: item.id, confirmation_required: true, reason: "confirm original admission with cp_decide, then retry cp_mandate continue with confirmation_escalation_id" };
}
