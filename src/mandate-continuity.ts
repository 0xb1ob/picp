import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Job, type Mandate, paths, REVIEW_ORIGINAL_TASK_MAX_BYTES } from "./contracts.ts";
import { parseJobLabels, readJobsDocument } from "./ledger.ts";
import { atomicWriteText, queued } from "./json-store.ts";
import { MandateError, capReached, covers, scheduleIdOf, type MandateUsageJob } from "./mandate-accounting.ts";
import { readTaskAddenda } from "./task-addenda.ts";
import type { MandateStore } from "./mandate.ts";

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

export function admittedWork(grant: Mandate, job: Job): boolean {
	const proof = grant.admissions?.find((entry) => entry.job_id === job.id);
	const labels = parseJobLabels(job.labels);
	return proof !== undefined && proof.admitted_at >= grant.issued_at && proof.admitted_at < grant.expiry &&
		job.created_at <= proof.admitted_at && proof.project === labels.project && proof.kind === labels.kind &&
		proof.scope_digest === originalScopeDigest(job) && grant.job_ids?.includes(job.id) === true &&
		labels.project !== undefined && covers(grant, { jobId: job.id, project: labels.project,
			jobKind: labels.kind, scheduleId: scheduleIdOf(job.labels) });
}

export interface ContinuationResult {
	source_id: string;
	state: "committed" | "ineligible" | "confirmation_required";
	reason?: string;
	job_ids: string[];
	receipt_id: string;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function sourceFingerprint(source: Mandate): string {
	return digest(JSON.stringify({
		id: source.id, issued_by: source.issued_by, issued_at: source.issued_at, expiry: source.expiry,
		objective: source.objective, projects: source.projects, job_ids: source.job_ids,
		allowed_actions: source.allowed_actions, exclusions: source.exclusions, admissions: source.admissions,
		provenance: source.provenance, usage_baseline: source.usage_baseline,
		usd_cap: source.spend_cap.usd, job_cap: source.job_cap,
	}));
}
export async function continueAdmittedWork(
	store: MandateStore, sourceId: string, usage: readonly MandateUsageJob[], write: (grant: Mandate) => Mandate,
): Promise<ContinuationResult> {
	return queued(store.file(sourceId), async () => {
		const source = store.sweep(undefined, usage).find((grant) => grant.id === sourceId);
		const receipt_id = `continuity-${digest(sourceId).slice(0, 32)}`;
		const result = (state: ContinuationResult["state"], reason: string, job_ids: string[] = []): ContinuationResult =>
			({ source_id: sourceId, receipt_id, state, reason, job_ids });
		if (!source) return result("ineligible", "source mandate does not exist");
		if (source.status !== "active" && source.status !== "expired") return result("ineligible", `source is ${source.status}`);
		if (source.schedule_grant || source.schedule_fire) return result("ineligible", "schedule grants use schedule authority");
		if (!["home", "project"].includes(source.provenance?.expiry_hours ?? "")) {
			return result("ineligible", "explicit or unproven expiry cannot become completion authority");
		}
		if (source.expiry > store.authorityNow() && !source.coverage_superseded) return result("ineligible", "admission remains open");
		if (capReached(source, store.withReviewerSpend(usage, [source]))) return result("ineligible", "original budget exhausted");
		if (!source.job_ids?.length) return result("ineligible", "continuation requires named original work");
		const all = readJobsDocument(store.home).jobs;
		const named = source.job_ids.map((id) => all.find((job) => job.id === id));
		if (named.some((job) => !job)) return result("confirmation_required", "original named job evidence is missing", source.job_ids);
		const jobs = named as Job[];
		if (jobs.every((job) => job.status === "closed")) return result("ineligible", "original named work is fulfilled");
		if (jobs.some((job) => !admittedWork(source, job))) {
			return result("confirmation_required", "original admission or unchanged scope requires bounded confirmation", source.job_ids);
		}
		const { continuity: previous, ...authority } = source;
		const fingerprint = sourceFingerprint(source);
		const inputs = jobs.map((job) => {
			const file = join(store.home, paths.originalTaskFile(job.id));
			const task = existsSync(file) ? readFileSync(file, "utf8") : job.description;
			if (!task?.trim()) throw new MandateError(`${job.id}: original governing task is missing; continuation not committed`);
			return { job, task, addenda: readTaskAddenda(store.home, job.id) };
		});
		const snapshot = `${store.file(sourceId)}.governing-inputs`;
		const text = previous ? readFileSync(snapshot, "utf8") : JSON.stringify({ authority, inputs });
		if (previous) {
			const frozen = JSON.parse(text) as { inputs: typeof inputs };
			if (frozen.inputs.length !== inputs.length || frozen.inputs.some((entry, index) =>
				entry.job.id !== inputs[index]!.job.id || entry.task !== inputs[index]!.task ||
				JSON.stringify(entry.addenda) !== JSON.stringify(inputs[index]!.addenda))) {
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
			authority_reference: `${source.id}:typed-admission`,
		};
		atomicWriteText(snapshot, text, { mode: 0o600, syncDir: true });
		write({ ...source, continuity });
		const current = store.get(source.id)!;
		if (sourceFingerprint(current) !== fingerprint || (current.status !== "active" && current.status !== "expired")) return result("ineligible", "source changed during preparation", source.job_ids);
		write({ ...current, continuity: { ...continuity, phase: "committed" } });
		return result("committed", "original admission and accounting root retained", source.job_ids);
	});
}
