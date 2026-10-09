/**
 * Parent-expanded schedules: a manual schedule with a `job.skill`. Its Run now records a `deferred` anchor job (the
 * durable request and the open-fire guard) and wakes the parent, which expands the run with the skill. The jobs it
 * creates carry `schedule:<id>`, so the schedule's grant covers and counts them; they are the parent's, never the
 * schedule runner's. Nothing here writes: it reads schedules and jobs and words the wake and the label refusal.
 */
import { join } from "node:path";
import { LAYOUT, type Job } from "./contracts.ts";
import { orgReviewMaxReviewers, readScheduleFile, type Schedule } from "./viewer/schedule-core.ts";

export const EXPANDED_MARKER = "expanded:";
const SCHEDULE_LABEL = "schedule:";
const ID_PATTERN = /^sch-[0-9a-f]{6}$/;

/** Ids of the schedules whose runs the parent expands with a skill. */
export const parentExpandedIds = (schedules: readonly Schedule[]): Set<string> => new Set(schedules.filter((entry) => entry.job.skill).map((entry) => entry.id));

/** The saved schedules, [] when unreadable: the fail-closed direction (nothing is parent-expanded, so nothing is minted). */
export function readSchedulesOrEmpty(home: string): Schedule[] {
	try { return readScheduleFile(join(home, LAYOUT.state, "schedules.json")); } catch { return []; }
}

export const readParentExpanded = (home: string): Set<string> => parentExpandedIds(readSchedulesOrEmpty(home));

const anchorOpen = (job: Job, id: string): boolean => job.status === "deferred" && job.labels.includes(`${SCHEDULE_LABEL}${id}`);

/** Deferred anchors of parent-expanded schedules the parent has not yet marked `expanded:`. */
export function pendingExpansions(jobs: readonly Job[], schedules: readonly Schedule[]): { anchor: Job; schedule: Schedule }[] {
	const out: { anchor: Job; schedule: Schedule }[] = [];
	for (const schedule of schedules) {
		if (!schedule.job.skill) continue;
		for (const anchor of jobs) {
			if (anchorOpen(anchor, schedule.id) && !anchor.comments.some((comment) => comment.text.startsWith(EXPANDED_MARKER))) out.push({ anchor, schedule });
		}
	}
	return out;
}

export function formatExpansionWake(anchor: Job, schedule: Schedule): string {
	return `[${schedule.project}] schedule ${schedule.name} (${schedule.id}): ${anchor.id} is a parent-expanded run — use skill ${schedule.job.skill} to expand it now: ` +
		`create its jobs with labels ["${SCHEDULE_LABEL}${schedule.id}"], comment "${EXPANDED_MARKER} …" on ${anchor.id}, dispatch per the skill. ` +
		`Never dispatch ${anchor.id}; close it after the synthesis job is torn down.`;
}

const RISK_HIGH = "risk:high";
const isHigh = (job: Job): boolean => job.labels.includes(RISK_HIGH);

/** A cp-org-pr-review open run's jobs beside its anchor; a created_at that does not read as before the anchor counts (fail closed). */
const orgRun = (jobs: readonly Job[], anchor: Job, label: string): Job[] =>
	jobs.filter((job) => job.id !== anchor.id && job.labels.includes(label) && !(Date.parse(job.created_at) < Date.parse(anchor.created_at)));

/**
 * The org run cap for one job (`jobId`, when it already exists) joining or staying in `anchor`'s run: at most
 * max_reviewers + one synthesis beside the anchor (a job already in the run never counts twice), and at most
 * max_reviewers risk:high reviewers when the job is (or becomes) risk:high.
 */
function orgRunRefusal(schedule: Schedule, anchor: Job, jobs: readonly Job[], label: string, jobId: string | undefined, high: boolean): string | undefined {
	const max = orgReviewMaxReviewers(schedule.job.description);
	const run = orgRun(jobs, anchor, label);
	const others = run.filter((job) => job.id !== jobId);
	if (others.length === run.length && run.length >= max + 1) return `cp-org-pr-review run ${anchor.id} already has ${run.length} job(s) (max_reviewers ${max} plus one synthesis); a fire never fans out wider`;
	const reviewers = others.filter(isHigh).length;
	if (high && reviewers >= max) return `cp-org-pr-review run ${anchor.id} already has ${reviewers} reviewer job(s) (max_reviewers ${max}); a fire never fans out wider`;
	return undefined;
}

/**
 * Why `labels` may not be added to a job, or undefined: a `schedule:` label is minted by a fire, never by hand. A
 * cp-org-pr-review run also caps its jobs (`orgRunRefusal`). The job is risk:high when `labels` carry `risk:high` or
 * `options.risk` is high (the create parameter, or the label set an update leaves). `options.reuseId`: the job's id
 * when it already exists (an idempotent re-create, an update), so a job already in the run is never counted twice.
 */
export function scheduleLabelRefusal(labels: readonly string[], jobs: readonly Job[], schedules: readonly Schedule[], options: { reuseId?: string; risk?: string } = {}): string | undefined {
	const high = options.risk === "high" || labels.includes(RISK_HIGH);
	for (const label of labels) {
		if (!label.startsWith(SCHEDULE_LABEL)) continue;
		const id = label.slice(SCHEDULE_LABEL.length);
		if (!ID_PATTERN.test(id)) return `${label} is not a schedule label (schedule:sch-xxxxxx)`;
		if (!parentExpandedIds(schedules).has(id)) return `${label} is minted by a fire; only a parent-expanded schedule's open run may add jobs to it`;
		const anchor = jobs.find((job) => anchorOpen(job, id));
		if (!anchor) return `no open run of schedule ${id} (Run now first)`;
		const schedule = schedules.find((entry) => entry.id === id);
		if (schedule?.job.skill !== "cp-org-pr-review") continue;
		const refusal = orgRunRefusal(schedule, anchor, jobs, label, options.reuseId, high);
		if (refusal) return refusal;
	}
	return undefined;
}

/**
 * Why `addLabels` may not raise an existing job to risk:high, or undefined: a job already in an open cp-org-pr-review
 * run counts against its max_reviewers reviewer cap once it carries `risk:high` (`cp_job update add_labels`). A job
 * outside an open org run, or one already risk:high, is never refused here.
 */
export function scheduleRiskRefusal(jobId: string, addLabels: readonly string[], jobs: readonly Job[], schedules: readonly Schedule[]): string | undefined {
	if (!addLabels.includes(RISK_HIGH)) return undefined;
	const job = jobs.find((entry) => entry.id === jobId);
	if (!job || isHigh(job)) return undefined;
	for (const label of job.labels) {
		if (!label.startsWith(SCHEDULE_LABEL)) continue;
		const id = label.slice(SCHEDULE_LABEL.length);
		const schedule = schedules.find((entry) => entry.id === id);
		const anchor = jobs.find((entry) => anchorOpen(entry, id));
		if (schedule?.job.skill !== "cp-org-pr-review" || !anchor || !orgRun(jobs, anchor, label).some((entry) => entry.id === job.id)) continue;
		const refusal = orgRunRefusal(schedule, anchor, jobs, label, job.id, true);
		if (refusal) return refusal;
	}
	return undefined;
}
