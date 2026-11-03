/**
 * Self-review A1: an unresolved gate or plan-approval authority decision holds ship admission for its linked ships and
 * every ship its recorded mandate covers. Withdrawal, planner closure, decline, drop and replan never release it; only
 * `releasesHold` on the same replacement chain does. The hold lives in the escalation journal, so it survives restarts.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type EscalationAuthorityHold, LAYOUT, paths } from "./contracts.ts";
import { EscalationStore, holdRoot, releasesHold } from "./escalation.ts";
import { parseJobLabels, readJobsDocument } from "./ledger.ts";
import { covers, MandateError } from "./mandate-accounting.ts";
import type { MandateStore } from "./mandate.ts";

type PipelineLink = { research_id?: string; ship_id?: string; project?: string; state?: string };

function pipelineLinks(home: string): PipelineLink[] {
	const dir = join(home, LAYOUT.pipelines);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
		try { return [JSON.parse(readFileSync(join(dir, name), "utf8")) as PipelineLink]; } catch { return []; } // PipelineStore reports it
	});
}

/** What a gate or plan decision on `researchId` holds: its project, linked ships, covering mandate and evidence. */
export function authorityHold(home: string, mandates: MandateStore | undefined, researchId: string,
	input: { project?: string; attempt?: number; mandateId?: string } = {}): EscalationAuthorityHold | undefined {
	const jobs = (existsSync(join(home, LAYOUT.jobsFile)) ? readJobsDocument(home).jobs : []).map((job) => ({ ...job, ...parseJobLabels(job.labels) }));
	const pipeline = pipelineLinks(home).find((link) => link.research_id === researchId);
	const project = input.project ?? pipeline?.project ?? jobs.find((job) => job.id === researchId)?.project;
	if (!project) return undefined;
	const ships = [...new Set([pipeline?.ship_id, ...jobs.filter((job) => job.kind === "ship" && job.blocked_by.includes(researchId)).map((job) => job.id)]
		.filter((id): id is string => Boolean(id)))].slice(0, 16);
	const covering = (jobId: string, kind: "ship" | "research") => {
		try { return mandates?.selection("dispatch", { jobId, project, kind })?.grant.id; } catch { return undefined; }
	};
	const mandateId = input.mandateId ?? ships.map((id) => covering(id, "ship")).find(Boolean) ?? covering(researchId, "research");
	const artifact = join(home, paths.artifactFile(researchId));
	return {
		...(mandateId ? { mandate_id: mandateId } : {}),
		project,
		source_job_id: researchId,
		...(ships.length ? { ship_job_ids: ships } : {}),
		...(input.attempt ? { gate_attempt: input.attempt, evidence_path: paths.gateFile(researchId, input.attempt) } : {}),
		...(existsSync(artifact) ? { artifact_sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex") } : {}),
	};
}

/**
 * Refuses a ship an unreleased hold covers, before any schedule-run return, continuation write or lease. An unreadable
 * journal throws (fails closed); so does an escalated pipeline whose hold record is missing.
 */
export function assertNoAuthorityHold(store: MandateStore, job: { jobId: string; project: string; kind?: "ship" | "research"; pathHints?: string[] }): void {
	if (job.kind === "research") return;
	const items = new EscalationStore({ home: store.home }).list();
	const released = new Set(items.filter(releasesHold).map((item) => holdRoot(items, item)));
	const scope = store.scheduleOf(job.jobId);
	const grants = store.list();
	for (const item of items) {
		const hold = item.authority_hold;
		if (!hold || hold.project !== job.project || released.has(holdRoot(items, item))) continue;
		const grant = hold.mandate_id ? grants.find((entry) => entry.id === hold.mandate_id) : undefined;
		// A recorded mandate that no longer exists is missing evidence: hold the whole project.
		const covered = hold.mandate_id !== undefined && (!grant || covers(grant, { jobId: job.jobId, project: job.project, jobKind: job.kind ?? "ship", ...(job.pathHints ? { pathHints: job.pathHints } : {}), ...scope }));
		if (!covered && !hold.ship_job_ids?.includes(job.jobId)) continue;
		const chain = items.filter((entry) => holdRoot(items, entry) === holdRoot(items, item));
		const live = chain.find((entry) => entry.status === "open");
		const last = chain.at(-1) ?? item;
		throw new MandateError(`${job.jobId}: refused before lease — authority hold ${item.id} (${item.kind}, mandate ${hold.mandate_id ?? "none"}) from ${hold.source_job_id} is unreleased; withdrawal or closing the planner never releases it. ` +
			(live ? `cp_decide ${live.id} with an affirmative operator answer naming ${live.id}` : `cp_escalate action replace escalation_id ${last.id}, then cp_decide the replacement with an operator answer naming its own id`));
	}
	const unrecorded = pipelineLinks(store.home).find((link) => link.ship_id === job.jobId && link.state === "escalated" &&
		!items.some((item) => item.authority_hold?.source_job_id === link.research_id) &&
		!items.some((item) => item.job_ids.includes(link.research_id ?? "") && item.question.includes("escalate (operational_persistent)")));
	if (unrecorded) throw new MandateError(`${job.jobId}: refused before lease — ${unrecorded.research_id}'s gate escalated but its authority hold is not recorded; run cp_pipeline advance ${unrecorded.research_id} to record it`);
}
