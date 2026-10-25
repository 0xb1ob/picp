import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ArtifactStore } from "./artifacts.ts";
import { paths } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { GateError, readPriorAttempts } from "./gate.ts";
import { atomicWriteJson } from "./json-store.ts";
import { requireJobLabels, type Ledger } from "./ledger.ts";
import { prepareRecovery } from "./gate-recovery-preparation.ts";
import type { MandateStore } from "./mandate.ts";
import { recoveryFile, recoveryTarget } from "./gate-recovery.ts";
import { readTaskAddenda, taskAddendaText } from "./task-addenda.ts";

export async function assertOrdinaryReplacement(options: Parameters<typeof prepareGateReplacement>[0]) {
	const { home, jobId, replacementJobId, ledger, fleet } = options;
	for (const id of [jobId, replacementJobId]) {
		const dir = join(home, paths.runDir(id));
		if (existsSync(recoveryFile(dir, "source")) || existsSync(recoveryFile(dir, "reservation"))) throw new GateError(`${id}: recovery binding forbids ordinary replacement or chaining`);
		recoveryTarget(home, id);
	}
	const old = await ledger.show(jobId);
	const replacement = await ledger.show(replacementJobId);
	const oldLabels = requireJobLabels(old);
	const labels = requireJobLabels(replacement);
	if (jobId === replacementJobId || old.status !== "closed" || fleet.get(jobId)?.phase !== "done" || oldLabels.kind !== "research") throw new GateError(`${jobId}: replacement requires a torn-down, closed research planner`);
	if (replacement.status !== "open" || fleet.get(replacementJobId) || labels.kind !== "research" || labels.project !== oldLabels.project || labels.delivery !== oldLabels.delivery) throw new GateError(`${replacementJobId}: use a fresh, undispatched research job with the same project and delivery`);
	const prior = readPriorAttempts(home, jobId);
	const verdict = prior.decisions.at(-1);
	if (verdict?.verdict !== "revise") throw new GateError(`${jobId}: the latest gate must say revise`);
	return { prior, verdict };
}

/** Prepare files only: dispatch (and its mandate/budget checks) remains the parent's next step. */
export async function prepareGateReplacement(options: {
	home: string;
	jobId: string;
	replacementJobId: string;
	ledger: Ledger;
	fleet: FleetStore;
	artifacts: ArtifactStore;
	replanEscalationId?: string;
	mandates?: MandateStore;
}): Promise<{ job_id: string; replacement_job_id: string; task_file: string; recovery?: import("./contracts.ts").GateRecoveryStatus }> {
	const { home, jobId, replacementJobId, artifacts } = options;
	if (options.replanEscalationId) return prepareRecovery({ ...options, replanEscalationId: options.replanEscalationId });
	const { prior, verdict } = await assertOrdinaryReplacement(options);
	const link = join(home, paths.runDir(jobId), "gate-replacement.json");
	const dir = join(home, paths.runDir(replacementJobId));
	const bindings = options.mandates?.list().flatMap((grant) => grant.same_work_replacements ?? [])
		.filter((entry) => entry.original_job_id === jobId || entry.replacement_job_id === replacementJobId) ?? [];
	if (bindings.some((entry) => entry.original_job_id !== jobId || entry.replacement_job_id !== replacementJobId)) throw new GateError(`${jobId}: original work is already bound to another replacement`);
	if (!existsSync(link) && bindings.some((entry) => entry.phase === "committed")) throw new GateError(`${jobId}: committed replacement projection is missing; frozen inputs cannot be rewritten`);
	if (existsSync(link)) {
		let saved: { job_id: string; replacement_job_id: string; task_file: string };
		try {
			saved = JSON.parse(readFileSync(link, "utf8"));
			if (saved?.job_id !== jobId || saved.replacement_job_id !== replacementJobId || saved.task_file !== join(dir, "revision-task.md") ||
				Object.keys(saved).sort().join(",") !== "job_id,replacement_job_id,task_file") throw new Error("replacement binding changed or belongs to another job");
		} catch (error) {
			throw new GateError(`${link}: ${(error as Error).message}`);
		}
		if (!bindings.some((entry) => entry.phase === "prepared")) return saved;
	}
	// A crash can leave inherited gate-N.json before gate-replacement.json. Retry accepts that copy only when it matches exactly.
	const inherited = prior.decisions.map((decision) => ({ ...decision, job_id: replacementJobId }));
	const existing = readPriorAttempts(home, replacementJobId).decisions;
	if (artifacts.has(replacementJobId) || (existing.length > 0 && !isDeepStrictEqual(existing, inherited))) {
		throw new GateError(`${replacementJobId}: replacement already has an artifact or gate history`);
	}
	mkdirSync(dir, { recursive: true });
	const plan = join(dir, "previous-plan.md");
	artifacts.get(jobId, plan);
	const raw = join(dir, `gate-${verdict.attempt}-raw.json`);
	const findings = prior.decisions.map((decision) => {
		const target = join(dir, `gate-${decision.attempt}-raw.json`);
		const source = join(home, paths.gateFileRaw(jobId, decision.attempt));
		if (existsSync(source)) copyFileSync(source, target);
		else atomicWriteJson(target, decision);
		return target;
	});
	const originalTask = join(home, paths.originalTaskFile(jobId));
	const taskCopy = join(dir, "previous-original-task.md");
	if (existsSync(originalTask)) {
		copyFileSync(originalTask, taskCopy);
		copyFileSync(originalTask, join(home, paths.originalTaskFile(replacementJobId)));
	}
	const addenda = readTaskAddenda(home, jobId);
	const addendaCopy = join(dir, "previous-task-addenda.md");
	if (addenda.length) writeFileSync(addendaCopy, taskAddendaText(addenda));
	const task_file = join(dir, "revision-task.md");
	writeFileSync(task_file, [
		`# Revise the plan from ${jobId}`,
		`You are a replacement read-only planner for ${replacementJobId}. Do not implement code.`,
		`Read the previous plan in full: ${plan}`,
		`Read the full gate feedback in full: ${raw}`,
		...(existsSync(taskCopy) ? [`Read the original scope in full: ${taskCopy}`] : []),
		...(addenda.length ? [`Read the complete ordered original task addenda: ${addendaCopy}`] : []),
		...findings.filter((file) => file !== raw).map((file) => `Read the complete earlier gate findings: ${file}`),
		`Address the required revisions within the original scope. Write the revised plan to ${artifacts.path(replacementJobId)}.`,
		"Report the revised plan with report_result. The one revision allowance is already spent; the next gate is pass or escalate.",
	].join("\n") + "\n");
	// Keep the original decisions intact; the replacement inherits the same revision budget.
	for (const decision of prior.decisions) {
		atomicWriteJson(join(home, paths.gateFile(replacementJobId, decision.attempt)), { ...decision, job_id: replacementJobId });
	}
	const result = { job_id: jobId, replacement_job_id: replacementJobId, task_file };
	atomicWriteJson(link, result);
	return result;
}
