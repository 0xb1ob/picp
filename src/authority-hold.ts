/**
 * Self-review A1: an unresolved gate or plan-approval authority decision holds ship admission for its linked ships and
 * every ship its recorded mandate covers. Withdrawal, planner closure, decline, drop and replan never release it; only
 * `releasesHold` on the same replacement chain does. The hold lives in the escalation journal, so it survives restarts.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { type EscalationAuthorityHold, LAYOUT, paths } from "./contracts.ts";
import { EscalationStore, holdRoot, releasesHold } from "./escalation.ts";
import { gateInputDigest } from "./gate-input.ts";
import { parseJobLabels, readJobsDocument } from "./ledger.ts";
import { covers, MandateError } from "./mandate-accounting.ts";
import type { MandateStore } from "./mandate.ts";

type PipelineLink = { research_id?: string; ship_id?: string; project?: string; state?: string };

/** Readable pipeline records, and the relative path of every file that could not be read or parsed. */
function pipelineLinks(home: string): { links: PipelineLink[]; unreadable: string[] } {
	const dir = join(home, LAYOUT.pipelines);
	const links: PipelineLink[] = [], unreadable: string[] = [];
	if (!existsSync(dir)) return { links, unreadable };
	for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
		try {
			const link: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (!link || typeof link !== "object") throw new Error("not an object");
			links.push(link as PipelineLink);
		} catch {
			unreadable.push(`${LAYOUT.pipelines}/${name}`);
		}
	}
	return { links, unreadable };
}

/** Gate attempt numbers whose `gate-<n>.json` is present for `jobId`, ascending; no attempt cap. */
function gateAttempts(home: string, jobId: string): number[] {
	const dir = join(home, paths.runDir(jobId));
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => /^gate-(\d+)\.json$/.exec(name)?.[1] ?? []).map(Number).sort((a, b) => a - b);
}

/** The `cause` of a research job's latest readable gate verdict; undefined when none is readable. */
function latestGateCause(home: string, researchId: string): string | undefined {
	const attempt = gateAttempts(home, researchId).at(-1);
	if (attempt === undefined) return undefined;
	try { return String((JSON.parse(readFileSync(join(home, paths.gateFile(researchId, attempt)), "utf8")) as { cause?: unknown }).cause ?? "") || undefined; } catch { return undefined; }
}

/** The research job a hold's plan lives in now: its source, or the last replacement `gate-replacement.json` names. */
function lineageHead(home: string, sourceId: string): string {
	let head = sourceId;
	for (const seen = new Set<string>(); !seen.has(head);) {
		seen.add(head);
		const file = `${paths.runDir(head)}/gate-replacement.json`;
		if (!existsSync(join(home, file))) break;
		try {
			const next = String((JSON.parse(readFileSync(join(home, file), "utf8")) as { replacement_job_id?: unknown }).replacement_job_id);
			paths.runDir(next); // refuses an id that is not job-shaped
			head = next;
		} catch {
			throw new MandateError(`replacement link ${file} is unreadable, so the plan an authority hold approved cannot be traced; repair it, then retry`);
		}
	}
	return head;
}

/**
 * Why a released hold's consent no longer applies: the gate inputs of the plan in its lineage moved past the answered
 * attempt, and no later pass or policy gate bound the current inputs. Undefined when it applies; unreadable is stale.
 */
function staleConsent(store: MandateStore, hold: EscalationAuthorityHold): string | undefined {
	const home = store.home;
	const head = lineageHead(home, hold.source_job_id);
	const artifacts = new ArtifactStore({ home });
	const relative = paths.artifactFile(head);
	if (!artifacts.has(head)) return head === hold.source_job_id && !hold.artifact_sha256 ? undefined : `the approved plan ${relative} is missing`;
	let current: string;
	try { current = gateInputDigest(home, head, artifacts, store); } catch (error) { return `the gate inputs of ${head} are unreadable (${(error as Error).message})`; }
	const answered = head === hold.source_job_id ? hold.gate_attempt : undefined;
	let bound = false;
	for (const attempt of gateAttempts(home, head).reverse()) {
		const file = paths.gateFile(head, attempt);
		let verdict: { verdict?: unknown; cause?: unknown };
		try { verdict = JSON.parse(readFileSync(join(home, file), "utf8")); } catch { return `gate decision ${file} is unreadable`; }
		if (attempt !== answered && verdict.verdict !== "pass" && verdict.cause !== "policy") continue;
		const binding = join(home, paths.gateRunDir(head, attempt), "input-digest");
		if (!existsSync(binding)) continue;
		if (readFileSync(binding, "utf8") === current) return undefined;
		if (attempt === answered) bound = true;
	}
	// A hold answered before gates bound their inputs falls back to the artifact digest it recorded.
	if (!bound && hold.artifact_sha256 === createHash("sha256").update(readFileSync(artifacts.file(head))).digest("hex")) return undefined;
	return `${relative} or its gate inputs changed after the answered gate attempt ${answered ?? "(none)"} and no later gate bound them; ` +
		`a stale consent never admits — run cp_gate ${head} for a fresh gate`;
}

/** What a gate or plan decision on `researchId` holds: its project, linked ships, covering mandate and evidence. */
export function authorityHold(home: string, mandates: MandateStore | undefined, researchId: string,
	input: { project?: string; attempt?: number; mandateId?: string } = {}): EscalationAuthorityHold | undefined {
	const jobs = (existsSync(join(home, LAYOUT.jobsFile)) ? readJobsDocument(home).jobs : []).map((job) => ({ ...job, ...parseJobLabels(job.labels) }));
	const pipeline = pipelineLinks(home).links.find((link) => link.research_id === researchId);
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
 * Refuses a ship an unreleased hold covers, or a released one whose plan changed since (`staleConsent`), before any
 * schedule-run return, continuation write, lease, launch or promotion. Unreadable evidence throws (fails closed).
 */
export function assertNoAuthorityHold(store: MandateStore, job: { jobId: string; project: string; kind?: "ship" | "research"; pathHints?: string[] }): void {
	if (job.kind === "research") return;
	const items = new EscalationStore({ home: store.home }).list();
	const released = new Set(items.filter(releasesHold).map((item) => holdRoot(items, item)));
	const scope = store.scheduleOf(job.jobId);
	const grants = store.list();
	for (const item of items) {
		const hold = item.authority_hold;
		if (!hold || hold.project !== job.project) continue;
		const grant = hold.mandate_id ? grants.find((entry) => entry.id === hold.mandate_id) : undefined;
		// A recorded mandate that no longer exists is missing evidence: hold the whole project.
		const covered = hold.mandate_id !== undefined && (!grant || covers(grant, { jobId: job.jobId, project: job.project, jobKind: job.kind ?? "ship", ...(job.pathHints ? { pathHints: job.pathHints } : {}), ...scope }));
		if (!covered && !hold.ship_job_ids?.includes(job.jobId)) continue;
		if (released.has(holdRoot(items, item))) {
			const stale = staleConsent(store, hold);
			if (stale) throw new MandateError(`${job.jobId}: refused before lease — authority hold ${item.id} (mandate ${hold.mandate_id ?? "none"}) was released, but ${stale}`);
			continue;
		}
		const chain = items.filter((entry) => holdRoot(items, entry) === holdRoot(items, item));
		const live = chain.find((entry) => entry.status === "open");
		const last = chain.at(-1) ?? item;
		throw new MandateError(`${job.jobId}: refused before lease — authority hold ${item.id} (${item.kind}, mandate ${hold.mandate_id ?? "none"}) from ${hold.source_job_id} is unreleased; withdrawal or closing the planner never releases it. ` +
			(live ? `cp_decide ${live.id} with an affirmative operator answer naming ${live.id}` : `cp_escalate action replace escalation_id ${last.id}, then cp_decide the replacement with an operator answer naming its own id`));
	}
	const { links, unreadable } = pipelineLinks(store.home);
	const ledger = existsSync(join(store.home, LAYOUT.jobsFile)) ? readJobsDocument(store.home).jobs : [];
	// An unreadable pipeline may hide a hold's links: refuse its research job's project, or every project if unknown.
	const broken = unreadable.find((file) => {
		const owner = ledger.find((entry) => `${LAYOUT.pipelines}/${entry.id}.json` === file);
		const project = owner && parseJobLabels(owner.labels).project;
		return !project || project === job.project;
	});
	if (broken) throw new MandateError(`${job.jobId}: refused before lease — pipeline file ${broken} is unreadable, so its authority holds cannot be checked; repair or remove it, then retry`);
	const unrecorded = links.find((link) => link.ship_id === job.jobId && link.state === "escalated" &&
		!items.some((item) => item.authority_hold?.source_job_id === link.research_id) &&
		(latestGateCause(store.home, link.research_id ?? "") ?? "policy") === "policy");
	if (unrecorded) throw new MandateError(`${job.jobId}: refused before lease — ${unrecorded.research_id}'s gate escalated but its authority hold is not recorded; run cp_pipeline advance ${unrecorded.research_id} to record it`);
}
