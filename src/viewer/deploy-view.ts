import { join } from "node:path";
import type { JobDeploy, ViewerJob } from "./api-types.ts";
import { isSafeId, obj, readObject, str, type ViewerState } from "./sessions.ts";

const COVERAGE = ["enrolled", "project_wide", "none"] as const;
const firstLine = (text: string | undefined) => text?.split("\n").find((l) => l.trim())?.trim().slice(0, 400) ?? null;

/** The after-merge deploy (#326) of merged job `id`, read from `runs/<id>/after-merge.json`; null when none is recorded. */
export function deployView(state: ViewerState, id: string, jobs: readonly ViewerJob[]): JobDeploy | null {
	if (!isSafeId(id)) return null;
	const record = readObject(join(state.stateDir, "runs", id, "after-merge.json"));
	const sha = str(record?.merge_commit_sha);
	if (!record || record.job_id !== id || !sha || !/^[a-f0-9]{40}$/i.test(sha) || !["created", "skipped"].includes(String(record.status))) return null;
	const coverage = COVERAGE.find((c) => c === record.coverage) ?? null;
	const base = { merge_sha: sha, branch: str(record.base_branch) ?? null, reason: firstLine(str(record.reason)), at: null, coverage, mandate_id: str(record.mandate_id) ?? null };
	const deployId = str(record.deploy_job_id);
	if (record.status === "skipped" || !deployId || !isSafeId(deployId)) return { ...base, state: "skipped", deploy_job_id: null, reason: base.reason ?? "no deploy job recorded" };
	const job = jobs.find((j) => j.id === deployId);
	const envelope = obj(readObject(join(state.stateDir, "runs", deployId, "envelope.json"))?.envelope);
	const created = { ...base, deploy_job_id: deployId };
	if (envelope?.status === "done") return { ...created, state: "deployed", reason: null, at: job?.finished_at ?? null };
	if (envelope?.status === "blocked") {
		const first = Array.isArray(envelope.blockers) ? envelope.blockers[0] : undefined;
		return { ...created, state: "blocked", reason: firstLine(str(first) ?? str(obj(first)?.question)) ?? "blocked without a named blocker" };
	}
	if (job?.phase === "failed") return { ...created, state: "failed", reason: firstLine(job.failure ?? undefined) ?? "failed without a recorded cause" };
	if (job?.phase === "done") return { ...created, state: "failed", reason: "closed without a report" };
	if (!job || job.phase === "queued" || job.phase === "launching") return { ...created, state: "queued" };
	return { ...created, state: "deploying" };
}
