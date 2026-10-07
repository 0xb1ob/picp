import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import { paths } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { GateError, readPriorAttempts } from "./gate.ts";
import { atomicWriteJson } from "./json-store.ts";
import { requireJobLabels, type Ledger } from "./ledger.ts";

/** Prepare files only: dispatch (and its mandate/budget checks) remains the parent's next step. */
export async function prepareGateReplacement(options: {
	home: string;
	jobId: string;
	replacementJobId: string;
	ledger: Ledger;
	fleet: FleetStore;
	artifacts: ArtifactStore;
}): Promise<{ job_id: string; replacement_job_id: string; task_file: string }> {
	const { home, jobId, replacementJobId, ledger, fleet, artifacts } = options;
	const old = await ledger.show(jobId);
	const replacement = await ledger.show(replacementJobId);
	const oldLabels = requireJobLabels(old);
	const labels = requireJobLabels(replacement);
	if (jobId === replacementJobId || old.status !== "closed" || fleet.get(jobId)?.phase !== "done" || oldLabels.kind !== "research") {
		throw new GateError(`${jobId}: replacement requires a torn-down, closed research planner`);
	}
	if (replacement.status !== "open" || fleet.get(replacementJobId) || labels.kind !== "research" ||
		labels.project !== oldLabels.project || labels.delivery !== oldLabels.delivery) {
		throw new GateError(`${replacementJobId}: use a fresh, undispatched research job with the same project and delivery`);
	}
	const prior = readPriorAttempts(home, jobId);
	const verdict = prior.decisions.at(-1);
	if (verdict?.verdict !== "revise") throw new GateError(`${jobId}: the latest gate must say revise`);
	const link = join(home, paths.runDir(jobId), "gate-replacement.json");
	if (existsSync(link)) {
		let saved: { replacement_job_id: string; task_file: string };
		try {
			saved = JSON.parse(readFileSync(link, "utf8"));
			if (typeof saved?.replacement_job_id !== "string" || typeof saved.task_file !== "string") throw new Error("invalid replacement record");
		} catch (error) {
			throw new GateError(`${link}: ${(error as Error).message}`);
		}
		if (saved.replacement_job_id !== replacementJobId) throw new GateError(`${jobId}: replacement already prepared for ${saved.replacement_job_id}`);
		return { job_id: jobId, replacement_job_id: saved.replacement_job_id, task_file: saved.task_file };
	}
	if (artifacts.has(replacementJobId) || readPriorAttempts(home, replacementJobId).decisions.length) {
		throw new GateError(`${replacementJobId}: replacement already has an artifact or gate history`);
	}
	const dir = join(home, paths.runDir(replacementJobId));
	mkdirSync(dir, { recursive: true });
	const plan = join(dir, "previous-plan.md");
	artifacts.get(jobId, plan);
	const raw = join(dir, `gate-${verdict.attempt}-raw.json`);
	const sourceRaw = join(home, paths.gateFileRaw(jobId, verdict.attempt));
	if (existsSync(sourceRaw)) copyFileSync(sourceRaw, raw);
	else atomicWriteJson(raw, verdict);
	const originalTask = join(home, paths.originalTaskFile(jobId));
	const taskCopy = join(dir, "original-task.md");
	if (existsSync(originalTask)) copyFileSync(originalTask, taskCopy);
	const task_file = join(dir, "revision-task.md");
	writeFileSync(task_file, [
		`# Revise the plan from ${jobId}`,
		`You are a replacement read-only planner for ${replacementJobId}. Do not implement code.`,
		`Read the previous plan in full: ${plan}`,
		`Read the full gate feedback in full: ${raw}`,
		...(existsSync(taskCopy) ? [`Read the original scope in full: ${taskCopy}`] : []),
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
