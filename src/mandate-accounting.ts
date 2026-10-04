/**
 * What a mandate counts: which jobs it covers, their spend (worker and reviewer, non-cached tokens) counting only
 * usage accrued after issue (`usage_baseline`), the job cap's one rule (new dispatches only), and which open
 * escalations its revoke, expiry or replacement supersedes.
 * Pure over contracts types; `src/mandate.ts` re-exports every name here, so callers import from there.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Escalation, ESCALATION_NO_MANDATE, type JobKind, type Mandate, paths, validateRunStatus } from "./contracts.ts";

/** Every mandate refusal. Lives here so the permission gate (`src/mandate-permission.ts`) needs no runtime import of `mandate.ts`. */
export class MandateError extends Error {
	/** Set only where a caller branches: `parallelism_full` keeps a queued dispatch at its head (src/dispatch-queue.ts). */
	readonly code?: "parallelism_full";
	constructor(message: string, options?: { code?: "parallelism_full" }) {
		super(message);
		if (options?.code !== undefined) this.code = options.code;
	}
}

export interface MandateUsageJob {
	job_id: string;
	project: string;
	kind?: JobKind;
	phase?: string;
	/** The job's dispatch time, retained when projecting fleet usage. */
	dispatched_at?: string;
	usage?: { cost_usd: number; total_tokens: number; cache_read?: number };
	/** Diff-review, gate and quality-panel reviewer spend on this job (`MandateStore.withReviewerSpend`); counted like `usage`. */
	reviewer_usage?: { cost_usd: number; total_tokens: number; cache_read?: number };
	paths?: string[];
	subsystem?: string;
	/** The fleet record's schedule (schedlater S3). */
	schedule_id?: string;
	/** The mandate that schedule names: never persisted, laid on by `MandateStore.withReviewerSpend` from state/schedules.json. */
	schedule_mandate?: string;
}

/** The schedule a scheduled job belongs to, and the mandate that schedule names (schedlater S3): what `covers` needs to keep schedule grants and project-wide grants apart. */
export interface ScheduleScope {
	scheduleId?: string;
	scheduleMandate?: string;
}

/** The `schedule:<id>` label's id, when the job has one that is a schedule id (`sch-` + 6 hex). */
export const scheduleIdOf = (labels: readonly string[] | undefined): string | undefined =>
	labels?.map((label) => /^schedule:(sch-[0-9a-f]{6})$/.exec(label)?.[1]).find((id) => id !== undefined);

/** The fleet record's `schedule_id` field for a job with these ledger labels: written by both dispatch paths. */
export const scheduleRecord = (labels: readonly string[] | undefined): { schedule_id?: string } => {
	const id = scheduleIdOf(labels);
	return id ? { schedule_id: id } : {};
};

/** `scheduleId` with the mandate its schedule names (`byId`: schedule id -> mandate id); an unscheduled job has neither. */
export function scheduleScope(scheduleId: string | undefined, byId: ReadonlyMap<string, string>): ScheduleScope {
	if (!scheduleId) return {};
	const scheduleMandate = byId.get(scheduleId);
	return { scheduleId, ...(scheduleMandate ? { scheduleMandate } : {}) };
}

export function covers(mandate: Mandate, job: {
	jobId: string;
	project: string;
	jobKind?: JobKind;
	pathHints?: string[];
	subsystem?: string;
} & ScheduleScope): boolean {
	if (!mandate.projects.includes(job.project)) return false;
	// A schedule grant covers only the jobs of the one schedule naming it; any other grant covers no scheduled job.
	if (mandate.schedule_grant ? !job.scheduleId || job.scheduleMandate !== mandate.id : job.scheduleId !== undefined) return false;
	if (mandate.job_ids && mandate.job_ids.length > 0 && !mandate.job_ids.includes(job.jobId)) return false;
	const exclusions = mandate.exclusions;
	if (exclusions?.job_kinds && job.jobKind && exclusions.job_kinds.includes(job.jobKind)) return false;
	return true;
}

export function matchingJobs(mandate: Mandate, jobs: readonly MandateUsageJob[]): MandateUsageJob[] {
	return jobs.filter((job) =>
		covers(mandate, {
			jobId: job.job_id,
			project: job.project,
			jobKind: job.kind,
			pathHints: job.paths,
			subsystem: job.subsystem,
			...(job.schedule_id ? { scheduleId: job.schedule_id } : {}),
			...(job.schedule_mandate ? { scheduleMandate: job.schedule_mandate } : {}),
		}),
	);
}

/** What a token cap counts: non-cached tokens, input + output + cache_write = total minus cache_read (as `billableTokens`, src/failures.ts). */
export const mandateTokens = (usage?: { total_tokens: number; cache_read?: number }): number => Math.max(0, (usage?.total_tokens ?? 0) - (usage?.cache_read ?? 0));

/** One covered job's usage when its grant was issued (`Mandate.usage_baseline`, written by `MandateStore.issue`). */
export type UsageBaselineEntry = NonNullable<Mandate["usage_baseline"]>[number];

/** What a new grant records at issue: every covered job's worker and reviewer usage (USD, non-cached tokens) now. */
export function usageBaseline(mandate: Mandate, jobs: readonly MandateUsageJob[]): UsageBaselineEntry[] {
	return matchingJobs(mandate, jobs).map((job) => ({
		job_id: job.job_id,
		usd: job.usage?.cost_usd ?? 0,
		tokens: mandateTokens(job.usage),
		...(job.reviewer_usage ? { reviewer_usd: job.reviewer_usage.cost_usd, reviewer_tokens: mandateTokens(job.reviewer_usage) } : {}),
	}));
}

const past = (now: number, then = 0): number => Math.max(0, now - then);

/** What a grant counts of one covered job: worker and reviewer spend each past its baseline, never below zero. */
function accrued(job: MandateUsageJob, base: UsageBaselineEntry | undefined): { usd: number; tokens: number } {
	return {
		usd: past(job.usage?.cost_usd ?? 0, base?.usd) + past(job.reviewer_usage?.cost_usd ?? 0, base?.reviewer_usd),
		tokens: past(mandateTokens(job.usage), base?.tokens) + past(mandateTokens(job.reviewer_usage), base?.reviewer_tokens),
	};
}

export function mandateSpend(
	mandate: Mandate,
	jobs: readonly MandateUsageJob[],
): { usd: number; tokens: number; jobs: number; inFlight: number } {
	const matched = matchingJobs(mandate, jobs);
	const baseline = new Map((mandate.usage_baseline ?? []).map((entry) => [entry.job_id, entry]));
	const named = (mandate.job_ids?.length ?? 0) > 0;
	let usd = 0;
	let tokens = 0;
	let counted = 0;
	let inFlight = 0;
	for (const job of matched) {
		const base = baseline.get(job.job_id);
		const spent = accrued(job, base);
		usd += spent.usd;
		tokens += spent.tokens;
		// A named grant counts every job it names; a project-wide one counts jobs dispatched after issue and
		// pre-existing jobs once they spend under it, so a project's history never fills its job cap.
		if (named || !base || spent.usd > 0 || spent.tokens > 0) counted += 1;
		// A working worker holds a parallelism slot; a `held` job has reported and waits on its
		// delivery (a promote moves it back to `waiting`). Held jobs still count toward spend and jobs.
		if (job.phase === "waiting" || job.phase === "launching") inFlight += 1;
	}
	return { usd, tokens, jobs: counted, inFlight };
}

/** The caps that pause a grant: money and tokens. The job cap never pauses (see `jobCapRefuses`). */
export function capReached(mandate: Mandate, jobs: readonly MandateUsageJob[]): "spend" | "token" | undefined {
	const spend = mandateSpend(mandate, jobs);
	if (spend.usd >= mandate.spend_cap.usd) return "spend";
	if (spend.tokens >= mandate.spend_cap.tokens) return "token";
	return undefined;
}

export function isActive(mandate: Mandate, now: string): boolean {
	if (mandate.status !== "active") return false;
	if (mandate.expiry <= now) return false;
	return true;
}

/**
 * The job cap limits new dispatches only: a job with a covered fleet record keeps its review, repair, promotion,
 * merge and re-dispatch; a job with none is refused once the grant's job count (`mandateSpend().jobs`) is at the cap.
 */
export function jobCapRefuses(mandate: Mandate, jobId: string, jobs: readonly MandateUsageJob[]): boolean {
	const matched = matchingJobs(mandate, jobs);
	return mandateSpend(mandate, matched).jobs >= mandate.job_cap && !matched.some((job) => job.job_id === jobId);
}

/**
 * Warning for a fresh project-wide grant (no `job_ids`): `mandateSpend` counts every job in its projects dispatched
 * after issue, including jobs another active mandate covers, so those fill its job cap too. Undefined for a named or schedule grant.
 */
export function projectWideCapWarning(mandate: Mandate, all: readonly Mandate[], now: string): string | undefined {
	if (mandate.job_ids?.length || mandate.schedule_grant) return undefined;
	const others = all.filter((other) => other.id !== mandate.id && isActive(other, now) && other.projects.some((project) => mandate.projects.includes(project))).map((other) => other.id);
	const shared = others.length ? `, including jobs covered by ${others.join(", ")}` : "";
	return `warning: ${mandate.id} is project-wide, so its job cap ${mandate.job_cap} counts every job dispatched in ${mandate.projects.join(", ")} while it stands${shared}; prefer a named-jobs grant (job_ids) with home-default bounds`;
}

/** Why `mandate` cannot take a tracker import (B4) into `project`/`kind`: only an active, uncapped named-jobs (batch) grant can. */
export function batchRefusal(mandate: Mandate | undefined, id: string, job: { project: string; kind: JobKind }, jobs: readonly MandateUsageJob[], now: string): string | undefined {
	if (!mandate) return `no mandate ${id}`;
	if (!mandate.job_ids?.length) return `${id} is project-wide (no job_ids); tracker import runs only under a named-jobs (batch) grant`;
	if (!isActive(mandate, now)) return `${id} is ${mandate.status === "active" ? "expired" : mandate.status}`;
	if (!mandate.projects.includes(job.project)) return `${id} does not cover project ${job.project}`;
	if (mandate.exclusions?.job_kinds?.includes(job.kind)) return `${id} excludes ${job.kind} jobs`;
	const cap = capReached(mandate, jobs);
	return cap ? `${id} ${cap} cap reached` : undefined;
}

/** MandateSchema's `job_ids` maxItems. */
const MANDATE_JOB_IDS_MAX = 64;

/**
 * Jobs a named-jobs grant may still enroll: its job cap less its dispatched jobs and its listed jobs still waiting
 * to dispatch (`open`: ids of non-closed ledger jobs), and never past the 64 `job_ids` a grant holds.
 */
export function enrollCapacity(mandate: Mandate, jobs: readonly MandateUsageJob[], open: ReadonlySet<string>): number {
	const dispatched = new Set(matchingJobs(mandate, jobs).map((job) => job.job_id));
	const ids = mandate.job_ids ?? [];
	const waiting = ids.filter((id) => !dispatched.has(id) && open.has(id)).length;
	return Math.max(0, Math.min(mandate.job_cap - dispatched.size - waiting, MANDATE_JOB_IDS_MAX - ids.length));
}

/** The mandate an escalation belongs to: its `mandate_id`, or — raised before that was recorded — a leading `md-…` in its question. */
export function escalationMandateId(item: Escalation): string | undefined {
	if (item.mandate_id !== ESCALATION_NO_MANDATE) return item.mandate_id;
	return /^(md-[0-9a-f]{6})\b/.exec(item.question)?.[1];
}

const REVIEWER_RUN_DIR = /^(?:gate|review|quality)-[a-z0-9_-]+$/;

/** Summed usage of every reviewer run (gate, diff review, quality panel) under `state/runs/<jobId>/`. */
export function reviewerUsage(home: string, jobId: string): { cost_usd: number; total_tokens: number; cache_read: number } | undefined {
	const dir = join(home, paths.runDir(jobId));
	if (!existsSync(dir)) return undefined;
	let total: { cost_usd: number; total_tokens: number; cache_read: number } | undefined;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !REVIEWER_RUN_DIR.test(entry.name)) continue;
		const file = join(dir, entry.name, "status.json");
		if (!existsSync(file)) continue;
		try {
			const parsed = validateRunStatus(JSON.parse(readFileSync(file, "utf8")));
			if (!parsed.ok) continue;
			const usage = parsed.value.usage;
			total = {
				cost_usd: (total?.cost_usd ?? 0) + usage.cost_usd,
				total_tokens: (total?.total_tokens ?? 0) + usage.total_tokens,
				cache_read: (total?.cache_read ?? 0) + usage.cache_read,
			};
		} catch {
			// A torn reviewer status is skipped, never fatal to a cap check.
		}
	}
	return total;
}

/**
 * Why `item` is superseded, or undefined: its mandate (`escalationMandateId`) was revoked, has expired, or was
 * replaced — paused, with a later-issued active grant covering the escalation's first job.
 */
export function supersedeReason(item: Escalation, all: readonly Mandate[], jobs: readonly MandateUsageJob[], now: string): string | undefined {
	const mandate = all.find((candidate) => candidate.id === escalationMandateId(item));
	if (!mandate) return undefined;
	if (mandate.status === "revoked") return `${mandate.id} was revoked`;
	if (mandate.status === "expired" || mandate.expiry <= now) return `${mandate.id} expired`;
	if (mandate.status !== "paused") return undefined;
	const jobId = item.job_ids[0] as string;
	const record = jobs.find((job) => job.job_id === jobId);
	const project = record?.project;
	const scope = { ...(record?.schedule_id ? { scheduleId: record.schedule_id } : {}), ...(record?.schedule_mandate ? { scheduleMandate: record.schedule_mandate } : {}) };
	const replacement = all.find(
		(other) =>
			other.issued_at > mandate.issued_at &&
			isActive(other, now) &&
			(other.job_ids?.includes(jobId) || (project !== undefined && covers(other, { jobId, project, ...scope }))),
	);
	return replacement ? `${mandate.id} was replaced by ${replacement.id}` : undefined;
}
