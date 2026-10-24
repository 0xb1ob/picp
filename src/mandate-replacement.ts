import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import { type Job, type Mandate, type SameWorkReplacement, paths, REVIEW_ORIGINAL_TASK_MAX_BYTES } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { readPriorAttempts } from "./gate.ts";
import { assertOrdinaryReplacement, prepareGateReplacement } from "./gate-replacement.ts";
import { queued } from "./json-store.ts";
import { type Ledger, requireJobLabels } from "./ledger.ts";
import { MandateError, capReached, scheduleIdOf, workIdentity, type MandateUsageJob } from "./mandate-accounting.ts";
import { originalScopeDigest, sourceFingerprint } from "./mandate-continuity.ts";
import type { MandateStore } from "./mandate.ts";
import { readTaskAddenda } from "./task-addenda.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const replacementTaskFile = (home: string, id: string) => join(home, paths.runDir(id), "revision-task.md");

export function replacementInputDigest(refs: readonly string[]): string {
	let bytes = 0;
	return digest(JSON.stringify(refs.map((file) => {
		const text = readFileSync(file, "utf8");
		bytes += Buffer.byteLength(text);
		if (bytes > REVIEW_ORIGINAL_TASK_MAX_BYTES) throw new MandateError("complete replacement input exceeds the byte cap; nothing truncated");
		return { file, text };
	})));
}

export function validReplacement(home: string, grant: Mandate, job: Job, jobs: readonly Job[]): boolean {
	try {
		const links = grant.same_work_replacements ?? [];
		if (new Set(links.map((entry) => entry.original_job_id)).size !== links.length || new Set(links.map((entry) => entry.replacement_job_id)).size !== links.length) return false;
		const workId = workIdentity(grant, job.id);
		const admitted = jobs.find((entry) => entry.id === workId);
		if (!admitted || workId === job.id) return false;
		let current = job;
		const seen = new Set<string>();
		while (current.id !== workId) {
			if (seen.has(current.id) || scheduleIdOf(current.labels) || addedScope(admitted, current) || readTaskAddenda(home, current.id).length) return false;
			const labels = requireJobLabels(current);
			const originalLabels = requireJobLabels(admitted);
			if (labels.project !== originalLabels.project || labels.kind !== originalLabels.kind || labels.delivery !== originalLabels.delivery) return false;
			seen.add(current.id);
			const link = grant.same_work_replacements?.find((entry) => entry.replacement_job_id === current.id && entry.phase === "committed");
			if (!link || workIdentity(grant, current.id) !== workId || link.prior_findings_refs[0] !== replacementTaskFile(home, current.id) ||
				link.governing_input_digest !== replacementInputDigest(link.prior_findings_refs)) return false;
			const admission = grant.admissions?.find((entry) => entry.job_id === workId);
			if (link.admitted_at !== admission?.admitted_at || link.confirmation_escalation_id !== admission?.confirmation_escalation_id || link.authority_reference !== grant.continuity?.authority_reference) return false;
			const previous = jobs.find((entry) => entry.id === link.original_job_id);
			if (!previous || previous.status !== "closed") return false;
			const history = readPriorAttempts(home, previous.id).decisions;
			if (digest(JSON.stringify(history)) !== link.inherited_gate_history_digest) return false;
			const inherited = readPriorAttempts(home, current.id).decisions.slice(0, history.length);
			if (JSON.stringify(inherited) !== JSON.stringify(history.map((entry) => ({ ...entry, job_id: current.id })))) return false;
			current = previous;
		}
		return true;
	} catch { return false; }
}
function addedScope(original: Job, replacement: Job): boolean {
	return Boolean((replacement.description && replacement.description !== original.description) ||
		(replacement.notes && replacement.notes !== original.notes) ||
		(replacement.external_ref && replacement.external_ref !== original.external_ref) || replacement.script);
}

export interface ReplaceWorkResult {
	source_id: string;
	mandate_id: string;
	original_job_id: string;
	replacement_job_id: string;
	work_id: string;
	link_id: string;
	task_file: string;
	state: "committed" | "ineligible" | "confirmation_required";
	reason?: string;
	escalation_id?: string;
}

export async function replaceAdmittedWork(options: {
	store: MandateStore; ledger: Ledger; fleet: FleetStore; artifacts: ArtifactStore;
	sourceId: string; originalJobId: string; replacementJobId: string;
	usage: () => readonly MandateUsageJob[]; confirmationId?: string;
}): Promise<ReplaceWorkResult> {
	const { store, ledger, fleet, artifacts, sourceId, originalJobId, replacementJobId, usage } = options;
	const continuation = await store.continue(sourceId, usage(), { confirmation_escalation_id: options.confirmationId });
	return queued(store.file(sourceId), async () => {
		let source = store.require(sourceId);
		const workId = workIdentity(source, originalJobId);
		const linkId = `work-${digest(`${sourceId}:${originalJobId}`).slice(0, 32)}`;
		const taskFile = replacementTaskFile(store.home, replacementJobId);
		const result = (state: ReplaceWorkResult["state"], reason?: string): ReplaceWorkResult => ({
			source_id: sourceId, mandate_id: sourceId, original_job_id: originalJobId, replacement_job_id: replacementJobId,
			work_id: workId, link_id: linkId, task_file: taskFile, state, ...(reason ? { reason } : {}),
		});
		if (continuation.state !== "committed") return { ...result(continuation.state, continuation.reason), escalation_id: continuation.escalation_id };
		if (!["active", "expired"].includes(source.status) || !store.continuationProof(originalJobId)[sourceId]) return result("ineligible", "original continuation is stopped or no longer proven");
		if (capReached(source, store.withReviewerSpend(usage(), [source]))) return result("ineligible", "original budget exhausted");
		const existing = source.same_work_replacements?.find((entry) => entry.original_job_id === originalJobId);
		if (existing && existing.replacement_job_id !== replacementJobId) return result("ineligible", `original already bound to ${existing.replacement_job_id}`);
		if (existing?.phase === "committed") return validReplacement(store.home, source, await ledger.show(replacementJobId), await ledger.list({ all: true })) ? result("committed") : result("ineligible", "committed replacement input or history changed");
		const original = await ledger.show(originalJobId);
		const replacement = await ledger.show(replacementJobId);
		const admitted = await ledger.show(workId);
		if (!source.job_ids?.includes(workId) || scheduleIdOf(replacement.labels) || addedScope(admitted, replacement) || readTaskAddenda(store.home, replacementJobId).length) return result("ineligible", "replacement adds scope or has no original admitted work");
		const oldLabels = requireJobLabels(original);
		const labels = requireJobLabels(replacement);
		if (originalJobId === replacementJobId || original.status !== "closed" || fleet.get(originalJobId)?.phase !== "done" ||
			oldLabels.kind !== "research" || readPriorAttempts(store.home, originalJobId).decisions.at(-1)?.verdict !== "revise") return result("ineligible", "original must be closed, torn down research with an actual latest revise");
		if (replacement.status !== "open" || fleet.get(replacementJobId) || labels.project !== oldLabels.project ||
			labels.kind !== oldLabels.kind || labels.delivery !== oldLabels.delivery || artifacts.has(replacementJobId)) return result("ineligible", "replacement must be fresh undispatched research in the same project and delivery");
		if (store.list().some((grant) => grant.same_work_replacements?.some((entry) => entry.replacement_job_id === replacementJobId &&
			(entry.source_grant_id !== sourceId || entry.original_job_id !== originalJobId)))) return result("ineligible", "replacement already belongs to another work link");
		const prior = readPriorAttempts(store.home, originalJobId).decisions;
		const historyDigest = digest(JSON.stringify(prior));
		const proof = source.admissions!.find((entry) => entry.job_id === workId)!;
		if (!proof.admitted_at && !proof.confirmation_escalation_id) return result("ineligible", "original admission evidence is missing");
		const fingerprint = sourceFingerprint(source);
		const link: SameWorkReplacement = existing ?? {
			version: 1, link_id: linkId, source_grant_id: sourceId, accounting_root_id: sourceId, work_id: workId,
			original_job_id: originalJobId, replacement_job_id: replacementJobId,
			...(proof.admitted_at ? { admitted_at: proof.admitted_at } : { confirmation_escalation_id: proof.confirmation_escalation_id! }),
			admission_expiry: source.expiry, original_scope_digest: originalScopeDigest(admitted),
			governing_input_digest: digest("prepared"), prior_findings_refs: [taskFile], inherited_gate_history_digest: historyDigest,
			phase: "prepared", authority_reference: source.continuity!.authority_reference,
		};
		const save = (value: SameWorkReplacement) => store.save({ ...store.require(sourceId), same_work_replacements: [
			...(store.require(sourceId).same_work_replacements ?? []).filter((entry) => entry.original_job_id !== originalJobId), value,
		] }, usage());
		if (!existsSync(join(store.home, paths.originalTaskFile(originalJobId)))) return result("ineligible", "complete original task is missing");
		await assertOrdinaryReplacement({ home: store.home, jobId: originalJobId, replacementJobId, ledger, fleet, artifacts });
		save(link);
		await prepareGateReplacement({ home: store.home, jobId: originalJobId, replacementJobId, ledger, fleet, artifacts });
		const dir = join(store.home, paths.runDir(replacementJobId));
		const refs = [taskFile, ...source.continuity!.governing_input_refs, join(dir, "previous-plan.md"), join(dir, "original-task.md"),
			...prior.map((entry) => join(dir, `gate-${entry.attempt}-raw.json`))];
		if (refs.some((file) => !existsSync(file))) return result("ineligible", "complete original task or findings are missing; preparation remains nonoperative");
		const inputDigest = replacementInputDigest(refs);
		const currentOriginal = await ledger.show(originalJobId);
		const currentReplacement = await ledger.show(replacementJobId);
		source = store.require(sourceId);
		const artifact = artifacts.file(originalJobId);
		if (!artifacts.has(originalJobId) || readFileSync(artifact, "utf8") !== readFileSync(join(dir, "previous-plan.md"), "utf8") ||
			readFileSync(join(store.home, paths.originalTaskFile(originalJobId)), "utf8") !== readFileSync(join(dir, "original-task.md"), "utf8")) return result("ineligible", "original task or prior artifact moved during preparation");
		if (sourceFingerprint(source) !== fingerprint || !["active", "expired"].includes(source.status) || !store.continuationProof(originalJobId)[sourceId] ||
			currentOriginal.status !== "closed" || fleet.get(originalJobId)?.phase !== "done" || digest(JSON.stringify(readPriorAttempts(store.home, originalJobId).decisions)) !== historyDigest ||
			capReached(source, store.withReviewerSpend(usage(), [source])) || fleet.get(replacementJobId) || artifacts.has(replacementJobId) ||
			currentReplacement.status !== "open" || originalScopeDigest(currentReplacement) !== originalScopeDigest(replacement) || replacementInputDigest(refs) !== inputDigest) return result("ineligible", "source or replacement changed during preparation");
		save({ ...link, prior_findings_refs: refs, governing_input_digest: inputDigest, phase: "committed" });
		return result("committed");
	});
}
