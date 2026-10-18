/**
 * After-merge deploy (#326): a merge receipt for an opted-in project's deploy branch creates — never dispatches — one
 * `ops:deploy` job, linked to the merged job exactly once (`runs/<merged>/after-merge.json` + `after-merge:<id>` label).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AfterMergeDeploy, type AfterMergeRecord, AfterMergeRecordSchema, isoTimestamp, type Mandate, type MergeReceipt, paths, SCHEMA_VERSION, validate } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { compareActiveGrants } from "./grant-order.ts";
import { atomicWriteJson, atomicWriteText, queued } from "./json-store.ts";
import type { Ledger } from "./ledger.ts";
import { isActive, type MandateStore } from "./mandate.ts";
import type { ProjectRegistry } from "./projects.ts";
import type { RunRegistry } from "./runs.ts";

export interface AfterMergePorts {
	home: string;
	registry: Pick<ProjectRegistry, "get">;
	ledger: () => Ledger;
	mandates: MandateStore;
	fleet: FleetStore;
	runs?: RunRegistry;
	now?: () => Date;
}

/** Deterministic task text frozen beside the merge receipt and handed to `cp_dispatch task_file=`. */
export function afterMergeTaskText(receipt: MergeReceipt, deploy: AfterMergeDeploy): string {
	const sha12 = receipt.merge_commit_sha.slice(0, 12);
	const resources = deploy.resources.map((r) => `resource:${r}`).join(", ");
	return [
		`# Deploy ${sha12} after ${receipt.job_id}`,
		"",
		`- merged job: ${receipt.job_id}`,
		`- PR: ${receipt.pr_url}`,
		`- merge commit: ${receipt.merge_commit_sha}`,
		`- branch: ${deploy.branch}`,
		`- merged at: ${receipt.merged_at ?? receipt.recorded_at}`,
		"",
		"Steps:",
		`1. \`git merge-base --is-ancestor ${receipt.merge_commit_sha} HEAD\` in the worktree; if it fails, report blocked "worktree lacks ${sha12}".`,
		`2. Deploy per the standing instruction under ${resources}: back up, copy, sha256 both sides, start, health check, roll back on any failure.`,
		`3. Report done only after the health check passed — summary line 1 starts \`deployed ${sha12}\`. Rolled back or not deployed → blocked, ` +
			"first blocker question starts `rolled back:` or names the operator-only act.",
		"",
		`Standing instruction (set ${deploy.enabled_at}):`,
		"",
		deploy.task,
		"",
	].join("\n");
}

function readRecord(file: string): AfterMergeRecord | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const parsed = validate<AfterMergeRecord>(AfterMergeRecordSchema, JSON.parse(readFileSync(file, "utf8")));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

/** One operator line for a newly written record; undefined when the project is not opted in or it was already linked. */
export async function afterMergeDeploy(ports: AfterMergePorts, receipt: MergeReceipt): Promise<string | undefined> {
	const merged = receipt.job_id;
	const project = ports.fleet.get(merged)?.project;
	const deploy = project ? ports.registry.get(project)?.after_merge_deploy : undefined;
	if (!project || !deploy) return undefined;
	const file = join(ports.home, paths.afterMergeFile(merged));
	return queued(file, async () => {
		if (readRecord(file)) return undefined;
		const now = isoTimestamp((ports.now ?? (() => new Date()))());
		const base = { schema_version: SCHEMA_VERSION, job_id: merged, merge_commit_sha: receipt.merge_commit_sha, ...(receipt.base_branch ? { base_branch: receipt.base_branch } : {}) };
		const mergedAt = receipt.merged_at ?? receipt.recorded_at;
		const skip = !receipt.base_branch ? "the merge receipt names no base branch"
			: receipt.base_branch !== deploy.branch ? `merged into ${receipt.base_branch}, not the deploy branch ${deploy.branch}`
			: Date.parse(mergedAt) < Date.parse(deploy.enabled_at) ? `merged ${mergedAt}, before after_merge_deploy was enabled ${deploy.enabled_at}`
			: undefined;
		if (skip) {
			atomicWriteJson(file, { ...base, status: "skipped", reason: skip, recorded_at: now });
			return `after-merge deploy skipped: ${skip}`;
		}
		const ledger = ports.ledger();
		const label = `after-merge:${merged}`;
		const deployJob = ledger.read().jobs.find((job) => job.labels.includes(label)) ?? await ledger.create({
			title: `Deploy ${project} ${receipt.merge_commit_sha.slice(0, 12)} after ${merged}`, project, kind: "research", delivery: "local",
			risk: "high", slug: "deploy", labels: ["ops:deploy", ...deploy.resources.map((r) => `resource:${r}`), label],
		});
		if (ledger.read().jobs.some((job) => job.id === merged)) await ledger.addDep(deployJob.id, merged);
		const taskFile = join(ports.home, paths.afterMergeTaskFile(merged));
		if (!existsSync(taskFile)) atomicWriteText(taskFile, afterMergeTaskText(receipt, deploy));
		const notes = `task_file: ${taskFile}`;
		if (deployJob.notes !== notes) await ledger.update(deployJob.id, { notes });
		const coverage = cover(ports, project, merged, deployJob.id, now);
		const record: AfterMergeRecord = { ...base, status: "created", deploy_job_id: deployJob.id, ...coverage, task_file: taskFile, recorded_at: now };
		atomicWriteJson(file, record);
		ports.runs?.open(merged).cp("after_merge_deploy", { deploy_job_id: deployJob.id, coverage: coverage.coverage, merge_commit_sha: receipt.merge_commit_sha });
		const said = coverage.coverage === "enrolled" ? `enrolled in ${coverage.mandate_id}`
			: coverage.coverage === "project_wide" ? `covered by project-wide ${coverage.mandate_id}`
			: `no covering grant — dispatch needs a grant${coverage.reason ? ` (${coverage.reason})` : ""}`;
		return `after-merge deploy ${deployJob.id} created (blocked until ${merged} closes; ${said}): cp_dispatch ${deployJob.id} task_file=${taskFile} base=${deploy.branch}`;
	});
}

/** Enroll into the named active grant listing the merged job; else note a project-wide grant; never dispatch. */
function cover(ports: AfterMergePorts, project: string, merged: string, deployId: string, now: string): Pick<AfterMergeRecord, "coverage" | "mandate_id" | "reason"> {
	const active = ports.mandates.list().filter((grant) => isActive(grant, now) && grant.projects.includes(project)).sort(compareActiveGrants);
	const named = active.find((grant) => grant.job_ids?.includes(merged));
	if (named) {
		try {
			const open = new Set(ports.ledger().read().jobs.filter((job) => job.status !== "closed").map((job) => job.id));
			ports.mandates.enroll(named.id, { jobId: deployId, project, kind: "research" }, ports.fleet.read().jobs, open);
			return { coverage: "enrolled", mandate_id: named.id };
		} catch (error) {
			return { coverage: "none", reason: String((error as Error).message).slice(0, 400) };
		}
	}
	const wide = active.find((grant: Mandate) => !grant.job_ids?.length && !grant.schedule_grant && !grant.exclusions?.job_kinds?.includes("research"));
	return wide ? { coverage: "project_wide", mandate_id: wide.id } : { coverage: "none" };
}

/** The `MergeStore.afterRecorded` port for a CommandPost; every collaborator is read lazily. */
export function afterMergeHook(post: { home: string; registry: ProjectRegistry; ledger(): Ledger; mandates: MandateStore; fleet: FleetStore; runs: RunRegistry }): (receipt: MergeReceipt) => Promise<string | undefined> {
	return (receipt) => afterMergeDeploy({ home: post.home, registry: post.registry, ledger: () => post.ledger(), mandates: post.mandates, fleet: post.fleet, runs: post.runs }, receipt);
}
