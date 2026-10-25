import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Job, type Mandate, isoTimestamp, paths, REVIEW_ORIGINAL_TASK_MAX_BYTES } from "./contracts.ts";
import { parseJobLabels, readJobsDocument } from "./ledger.ts";
import { atomicWriteText, queued } from "./json-store.ts";
import { MandateError, capReached, covers, scheduleIdOf, workIdentity, type MandateUsageJob } from "./mandate-accounting.ts";
import { replacementTaskFile, validReplacement } from "./mandate-replacement.ts";
import { readTaskAddenda, taskAddendaBlock } from "./task-addenda.ts";
import { pathExcluded, subsystemExcluded, MandateStore } from "./mandate.ts";
import { ArtifactStore } from "./artifacts.ts";
import { normalPassDigest } from "./gate-pass.ts";
import { admissionEvidence, confirmedAdmission, confirmedDefaultExpiry } from "./mandate-continuity-confirmation.ts";
import { readPriorAttempts } from "./gate.ts";
import { pendingHandoffs } from "./gate-handoff-store.ts";
import { afterAdmissionCutoff, confirmCoverage, validCoverage } from "./mandate-coverage.ts";

export function workUnfinished(home: string, job: Job, grant?: Mandate): boolean {
	const admission = grant?.admissions?.find((entry) => entry.job_id === job.id);
	if (admission && admission.scope_digest !== originalScopeDigest(job)) return true;
	const mandates = new MandateStore(home);
	const roots = grant ? [grant, ...mandates.list().filter((entry) => entry.id !== grant.id)] : mandates.list();
	let current = job;
	const seen = new Set<string>();
	for (;;) {
		const owner = roots.find((entry) => entry.same_work_replacements?.some((link) => link.original_job_id === current.id && link.phase === "committed"));
		const link = owner?.same_work_replacements?.find((entry) => entry.original_job_id === current.id && entry.phase === "committed");
		if (!link) break;
		const jobs = readJobsDocument(home).jobs;
		const replacement = jobs.find((entry) => entry.id === link.replacement_job_id);
		if (seen.has(current.id) || !replacement || !validReplacement(home, owner!, replacement, jobs)) return true;
		seen.add(current.id);
		current = replacement;
	}
	if (current.status !== "closed" || pendingHandoffs(home, current.id).length) return true;
	if (parseJobLabels(current.labels).kind !== "research") return false;
	const decision = readPriorAttempts(home, current.id).decisions.at(-1);
	if (!decision && !seen.size && !roots.some((entry) => entry.same_work_replacements?.some((link) => link.replacement_job_id === current.id))) return false;
	try { return !normalPassDigest(home, current.id, new ArtifactStore({ home }), mandates); }
	catch { return true; }
}

export function originalScopeDigest(job: Job): string {
	return createHash("sha256").update(JSON.stringify({
		id: job.id, title: job.title, description: job.description, notes: job.notes,
		external_ref: job.external_ref, labels: job.labels, script: job.script,
	})).digest("hex");
}

export function issueAdmissions(grant: Mandate, jobs: readonly Job[], at = grant.issued_at): NonNullable<Mandate["admissions"]> {
	if (grant.schedule_grant || at < grant.issued_at || at >= grant.expiry) return [];
	return jobs.flatMap((job) => {
		const labels = parseJobLabels(job.labels);
		if (job.created_at > at || !grant.job_ids?.includes(job.id) || !labels.project || !labels.kind ||
			!covers(grant, { jobId: job.id, project: labels.project, jobKind: labels.kind,
				scheduleId: scheduleIdOf(job.labels) })) return [];
		return [{
			job_id: job.id, admitted_at: at, project: labels.project, kind: labels.kind,
			scope_digest: originalScopeDigest(job),
		}];
	});
}

export function admittedWork(grant: Mandate, job: Job, confirmationId?: string): boolean {
	const proof = grant.admissions?.find((entry) => entry.job_id === job.id);
	const labels = parseJobLabels(job.labels);
	const timed = proof?.admitted_at !== undefined && proof.admitted_at >= grant.issued_at &&
		!afterAdmissionCutoff(grant, proof.admitted_at) && job.created_at <= proof.admitted_at;
	return proof !== undefined && (timed || (confirmationId !== undefined && proof.confirmation_escalation_id === confirmationId && !afterAdmissionCutoff(grant, job.created_at))) &&
		proof.project === labels.project && proof.kind === labels.kind &&
		proof.scope_digest === originalScopeDigest(job) && grant.job_ids?.includes(job.id) === true &&
		labels.project !== undefined && covers(grant, { jobId: job.id, project: labels.project,
			jobKind: labels.kind, scheduleId: scheduleIdOf(job.labels) });
}

export interface ContinuationResult {
	source_id: string;
	state: "committed" | "ineligible" | "confirmation_required";
	reason?: string;
	escalation_id?: string;
	job_ids: string[];
	receipt_id: string;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function sourceFingerprint(source: Mandate): string {
	return digest(JSON.stringify({
		id: source.id, issued_by: source.issued_by, issued_at: source.issued_at, expiry: source.expiry,
		objective: source.objective, projects: source.projects, job_ids: source.job_ids,
		allowed_actions: source.allowed_actions, exclusions: source.exclusions, ask_on: source.ask_on, admissions: source.admissions,
		provenance: source.provenance, usage_baseline: source.usage_baseline,
		usd_cap: source.spend_cap.usd, job_cap: source.job_cap,
	}));
}

export function governingInputs(home: string, jobs: readonly Job[]) {
	return jobs.map((job) => {
		const file = join(home, paths.originalTaskFile(job.id));
		const task = existsSync(file) ? readFileSync(file, "utf8") : job.description;
		if (!task?.trim()) throw new MandateError(`${job.id}: original governing task is missing; continuation not committed`);
		return { job, task, task_file: existsSync(file) ? file : undefined, addenda: readTaskAddenda(home, job.id) };
	});
}
export async function continueAdmittedWork(
	store: MandateStore, sourceId: string, usage: readonly MandateUsageJob[], write: (grant: Mandate) => Mandate,
	options: { confirmation_escalation_id?: string; replacement_id?: string } = {},
): Promise<ContinuationResult> {
	return queued(store.file(sourceId), async () => {
		let source = store.sweep(undefined, usage).find((grant) => grant.id === sourceId);
		const receipt_id = `continuity-${digest(sourceId).slice(0, 32)}`;
		const result = (state: ContinuationResult["state"], reason: string, job_ids: string[] = []): ContinuationResult =>
			({ source_id: sourceId, receipt_id, state, reason, job_ids });
		if (!source) return result("ineligible", "source mandate does not exist");
		if (source.status !== "active" && source.status !== "expired") return result("ineligible", `source is ${source.status}`);
		if (source.schedule_grant || source.schedule_fire) return result("ineligible", "schedule grants use schedule authority");
		if (options.replacement_id && source.coverage_superseded && source.coverage_superseded.replacement_id !== options.replacement_id) return result("ineligible", "replacement does not match the committed typed coverage mapping");
		if (source.provenance?.expiry_hours === "explicit" && source.expiry <= store.authorityNow()) return result("ineligible", "explicit completion deadline remains binding");
		if (source.expiry > store.authorityNow() && !source.coverage_superseded && !options.replacement_id) return result("ineligible", "admission remains open");
		if (capReached(source, store.withReviewerSpend(usage, [source]))) return result("ineligible", "original budget exhausted");
		if (!source.job_ids?.length) return result("ineligible", "continuation requires named original work");
		const all = readJobsDocument(store.home).jobs;
		const named = source.job_ids.map((id) => all.find((job) => job.id === id));
		if (named.some((job) => !job)) return result("ineligible", "original named job evidence is missing; full scope cannot be frozen", source.job_ids);
		const jobs = named as Job[];
		if (jobs.some((job) => {
			const labels = parseJobLabels(job.labels);
			return !labels.project || !labels.kind || !covers(source!, { jobId: job.id, project: labels.project, jobKind: labels.kind, scheduleId: scheduleIdOf(job.labels) });
		})) return result("ineligible", "original project, kind or exclusions do not cover this work");
		if (jobs.every((job) => !workUnfinished(store.home, job, source))) return result("ineligible", "original named work is fulfilled");
		const initialSource = source;
		if (jobs.some((job) => {
			const proof = initialSource.admissions?.find((entry) => entry.job_id === job.id);
			const at = proof?.admitted_at;
			return afterAdmissionCutoff(initialSource, job.created_at) || job.created_at > store.authorityNow() || (proof !== undefined && proof.scope_digest !== originalScopeDigest(job)) ||
				(at !== undefined && (at < initialSource.issued_at || afterAdmissionCutoff(initialSource, at) || at > store.authorityNow() || job.created_at > at));
		})) return result("ineligible", "original scope changed or admission was outside the original window");
		if (jobs.some((job) => readTaskAddenda(store.home, job.id).some((entry) => afterAdmissionCutoff(initialSource, entry.added_at) || entry.added_at > store.authorityNow()))) return result("ineligible", "scope additions after admission closed require independent authority");
		const scopeText = governingInputs(store.home, jobs).map(({ task, job, addenda }) => [task, job.description ?? "", job.notes ?? "", ...addenda.map((entry) => entry.text)].join("\n")).join("\n");
		if (pathExcluded(source, undefined, scopeText) || subsystemExcluded(source, undefined, scopeText)) return result("ineligible", "original exclusions remain binding");
		let coverageConfirmation: string | undefined;
		if (options.replacement_id && !source.coverage_superseded) {
			const coverage = await confirmCoverage(store, source, jobs, options.replacement_id, options.confirmation_escalation_id);
			if (!coverage.coverage) return { ...result(coverage.escalation_id ? "confirmation_required" : "ineligible", coverage.reason ?? "confirm exact original admission and obsolete coverage", source.job_ids), escalation_id: coverage.escalation_id };
			coverageConfirmation = coverage.coverage.authority_reference;
			source = write({ ...store.require(sourceId), coverage_superseded: coverage.coverage });
		}
		if (source.coverage_superseded && !validCoverage(store.home, source, jobs, store.list(), store.authorityNow())) return result("ineligible", "obsolete coverage proof is missing, withdrawn or changed");
		const originalFingerprint = sourceFingerprint(initialSource);
		const evidence = await admissionEvidence(store, source, jobs, options.confirmation_escalation_id ?? coverageConfirmation);
		if (!evidence.admissions) return { ...result(evidence.confirmation_required ? "confirmation_required" : "ineligible", evidence.reason ?? "original admission is unproven", source.job_ids), escalation_id: evidence.escalation_id };
		const currentSource = store.require(sourceId);
		if (sourceFingerprint(currentSource) !== originalFingerprint || !["active", "expired"].includes(currentSource.status)) return result("ineligible", "source changed while checking admission");
		const otherRoots = store.list().filter((grant) => grant.id !== sourceId);
		source = { ...currentSource, admissions: currentSource.continuity ? evidence.admissions : evidence.admissions.map((entry) => ({ ...entry,
			continuation_work: !otherRoots.some((grant) => grant.continuity?.admissions.some((old) => old.job_id === entry.job_id && old.continuation_work !== false) || grant.same_work_replacements?.some((link) => link.original_job_id === entry.job_id || link.replacement_job_id === entry.job_id)) && workUnfinished(store.home, jobs.find((job) => job.id === entry.job_id)!, currentSource),
		})) };
		if (!source.admissions!.some((entry) => entry.continuation_work !== false)) return result("ineligible", "no unfinished original work owned by this accounting root");
		const { continuity: previous, ...authority } = source;
		const fingerprint = sourceFingerprint(source);
		const inputs = governingInputs(store.home, jobs);
		const snapshot = `${store.file(sourceId)}.governing-inputs`;
		const text = previous ? readFileSync(snapshot, "utf8") : JSON.stringify({ authority, inputs });
		if (previous && (Buffer.byteLength(text) > REVIEW_ORIGINAL_TASK_MAX_BYTES || digest(text) !== previous.governing_input_digest)) {
			return result("ineligible", "frozen governing snapshot is missing or changed", source.job_ids);
		}
		if (previous) {
			const frozen = JSON.parse(text) as { inputs: typeof inputs };
			if (frozen.inputs.length !== inputs.length || frozen.inputs.some((entry, index) => {
				const original = join(store.home, paths.originalTaskFile(entry.job.id));
				if (entry.task_file !== undefined && entry.task_file !== original) return true;
				const task = entry.task_file ? readFileSync(original, "utf8") : inputs[index]!.job.description;
				return entry.job.id !== inputs[index]!.job.id || entry.task !== task ||
					JSON.stringify(entry.addenda) !== JSON.stringify(inputs[index]!.addenda);
			})) {
				return result("ineligible", "governing inputs changed since preparation", source.job_ids);
			}
		}
		if (Buffer.byteLength(text) > REVIEW_ORIGINAL_TASK_MAX_BYTES) throw new MandateError("continuity governing inputs exceed the byte cap; nothing truncated");
		const inputDigest = digest(text);
		if (previous && (previous.source_fingerprint !== fingerprint || previous.governing_input_digest !== inputDigest)) {
			return result("ineligible", "governing source changed since preparation", source.job_ids);
		}
		if (previous?.phase === "committed") {
			if (!existsSync(snapshot) || digest(readFileSync(snapshot, "utf8")) !== inputDigest) throw new MandateError("committed governing snapshot is missing or changed");
			return result("committed", "original admission and accounting root retained", source.job_ids);
		}
		const continuity: NonNullable<Mandate["continuity"]> = {
			version: 1, receipt_id, source_grant_id: source.id, accounting_root_id: source.id,
			source_fingerprint: fingerprint, admission_expiry: source.expiry, admissions: source.admissions!,
			governing_input_digest: inputDigest, governing_input_refs: [snapshot], phase: "prepared",
			authority_reference: evidence.authority_reference!,
		};
		atomicWriteText(snapshot, text, { mode: 0o600, syncDir: true });
		write({ ...source, continuity });
		const current = store.get(source.id)!;
		if (sourceFingerprint(current) !== fingerprint || (current.status !== "active" && current.status !== "expired")) return result("ineligible", "source changed during preparation", source.job_ids);
		write({ ...current, continuity: { ...continuity, phase: "committed" } });
		return result("committed", "original admission and accounting root retained", source.job_ids);
	});
}

export function assertContinuationTask(grant: Mandate | undefined, jobId: string, text: string, home: string): void {
	if (grant?.continuity?.phase !== "committed") return;
	const frozen = JSON.parse(readFileSync(grant.continuity.governing_input_refs[0]!, "utf8")) as { inputs: { job: { id: string }; task: string }[] };
	const expected = workIdentity(grant, jobId) === jobId ? frozen.inputs.find((entry) => entry.job.id === jobId)?.task : readFileSync(replacementTaskFile(home, jobId), "utf8");
	if (expected !== text) throw new MandateError(`${jobId}: continuation task differs from its frozen original scope; supply the original task without added scope`);
}

export function continuationProof(home: string, job: Job | undefined, grants: readonly Mandate[], now = isoTimestamp()): Record<string, string> {
	const proof: Record<string, string> = {};
	if (!job) return proof;
	for (const grant of grants) {
		const receipt = grant.continuity;
		if (receipt?.phase !== "committed" || receipt.source_grant_id !== grant.id || receipt.accounting_root_id !== grant.id) continue;
		const records = readJobsDocument(home).jobs;
		const originalJobs = grant.job_ids?.map((id) => records.find((entry) => entry.id === id));
		if (!originalJobs?.length || originalJobs.some((entry) => !entry)) continue;
		if (grant.coverage_superseded && !validCoverage(home, grant, originalJobs as Job[], grants, now)) continue;
		const confirmationId = confirmedAdmission(home, grant, originalJobs as Job[]);
		if (receipt.authority_reference.startsWith("confirmation:") && !confirmationId) continue;
		if (grant.expiry <= now && !confirmedDefaultExpiry(home, grant, originalJobs as Job[])) continue;
		const admitted = records.find((entry) => entry.id === workIdentity(grant, job.id));
		if (!admitted || grant.admissions?.find((entry) => entry.job_id === admitted.id)?.continuation_work === false || (admitted.id !== job.id && !validReplacement(home, grant, job, records))) continue;
		if (receipt.admission_expiry !== grant.expiry || receipt.source_fingerprint !== sourceFingerprint(grant) || !admittedWork(grant, admitted, confirmationId)) continue;
		const snapshot = `${join(home, paths.mandateFile(grant.id))}.governing-inputs`;
		if (receipt.governing_input_refs.length !== 1 || receipt.governing_input_refs[0] !== snapshot || !existsSync(snapshot)) continue;
		const text = readFileSync(snapshot, "utf8");
		if (Buffer.byteLength(text) > REVIEW_ORIGINAL_TASK_MAX_BYTES || digest(text) !== receipt.governing_input_digest) continue;
		const frozen = JSON.parse(text) as { inputs: { job: Job; task: string; task_file?: string; addenda: ReturnType<typeof readTaskAddenda> }[] };
		const entry = frozen.inputs.find((input) => input.job.id === admitted.id);
		const original = join(home, paths.originalTaskFile(admitted.id));
		if (entry?.task_file !== undefined && entry.task_file !== original) continue;
		const task = entry?.task_file ? readFileSync(original, "utf8") : admitted.description;
		if (!entry || entry.task !== task || JSON.stringify(entry.addenda) !== JSON.stringify(readTaskAddenda(home, admitted.id))) continue;
		proof[grant.id] = receipt.governing_input_digest;
	}
	return proof;
}

export async function continueForJob(store: MandateStore, jobId: string, usage: readonly MandateUsageJob[]): Promise<ContinuationResult | undefined> {
	const job = store.runContext().ledgerJob(jobId);
	if (!job || scheduleIdOf(job.labels)) return;
	for (const grant of store.list()) {
		const replaced = grant.same_work_replacements?.find((entry) => entry.original_job_id === jobId);
		if (replaced) throw new MandateError(`${jobId}: same work is bound to ${replaced.replacement_job_id}; original history cannot be rerun`);
		const pending = grant.same_work_replacements?.find((entry) => entry.replacement_job_id === jobId && entry.phase === "prepared");
		if (pending) throw new MandateError(`${jobId}: same-work link ${pending.link_id} is not committed; retry cp_mandate replace_work for ${pending.original_job_id}`);
	}
	const labels = parseJobLabels(job.labels);
	if (!labels.project) return;
	const subject = { jobId, project: labels.project, kind: labels.kind };
	if (store.selection("dispatch", subject, usage)?.at.cause === "active") return;
	const refused = new Map<string, ContinuationResult>();
	let pending: ContinuationResult | undefined;
	for (const source of store.list()) {
		if (!source.job_ids?.includes(workIdentity(source, jobId)) || (source.expiry > store.authorityNow() && !source.coverage_superseded) ||
			!["active", "expired"].includes(source.status)) continue;
		const result = await store.continue(source.id, usage);
		if (result.state === "confirmation_required") pending = result;
		if (result.state === "ineligible") refused.set(source.id, result);
	}
	const selected = store.selection("dispatch", subject, usage);
	const refusal = selected ? refused.get(selected.grant.id) : refused.values().next().value;
	if (refusal) throw new MandateError(`${refusal.source_id}: ${refusal.reason}`);
	return pending;
}

export function continuityInputsBlock(store: MandateStore | undefined, jobId: string, grant?: Mandate): string {
	const job = store?.runContext().ledgerJob(jobId);
	if (!store || !job) return "";
	const labels = parseJobLabels(job.labels);
	if (!labels.project) return "";
	const selected = grant ? { grant, at: { standing: "permit" } } : store.selection("review", { jobId, project: labels.project, kind: labels.kind });
	const receipt = selected?.grant.continuity;
	if (selected?.at.standing !== "permit" || receipt?.phase !== "committed") return "";
	const original = workIdentity(selected.grant, jobId);
	const addenda = original === jobId ? "" : taskAddendaBlock({ home: store.home, jobId: original, scratch: join(store.home, paths.runDir(jobId)) });
	const findings = selected.grant.same_work_replacements?.find((entry) => entry.replacement_job_id === jobId && entry.phase === "committed")?.prior_findings_refs ?? [];
	const refs = [...new Set([...receipt.governing_input_refs, ...findings])];
	return `\n\n## Complete governing continuity input\nRead these frozen mandate, original task, ordered addenda and actual prior findings in full:\n${refs.join("\n")}\n${addenda}`;
}
