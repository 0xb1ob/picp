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

/**
 * Why `labels` may not be added to a job, or undefined: a `schedule:` label is minted by a fire, never by hand. A
 * cp-org-pr-review run also caps its jobs: at most max_reviewers + one synthesis beside the anchor, at most
 * max_reviewers of them risk:high reviewers (`options.risk` is the new job's). `options.reuseId`: an idempotent
 * re-create of a job already in the run is never refused by the cap.
 */
export function scheduleLabelRefusal(labels: readonly string[], jobs: readonly Job[], schedules: readonly Schedule[], options: { reuseId?: string; risk?: string } = {}): string | undefined {
	for (const label of labels) {
		if (!label.startsWith(SCHEDULE_LABEL)) continue;
		const id = label.slice(SCHEDULE_LABEL.length);
		if (!ID_PATTERN.test(id)) return `${label} is not a schedule label (schedule:sch-xxxxxx)`;
		if (!parentExpandedIds(schedules).has(id)) return `${label} is minted by a fire; only a parent-expanded schedule's open run may add jobs to it`;
		const anchor = jobs.find((job) => anchorOpen(job, id));
		if (!anchor) return `no open run of schedule ${id} (Run now first)`;
		const schedule = schedules.find((entry) => entry.id === id);
		if (schedule?.job.skill !== "cp-org-pr-review") continue;
		const run = jobs.filter((job) => job.id !== anchor.id && job.labels.includes(label) && Date.parse(job.created_at) >= Date.parse(anchor.created_at));
		if (options.reuseId !== undefined && run.some((job) => job.id === options.reuseId)) continue;
		const max = orgReviewMaxReviewers(schedule.job.description);
		if (run.length >= max + 1) return `cp-org-pr-review run ${anchor.id} already has ${run.length} job(s) (max_reviewers ${max} plus one synthesis); a fire never fans out wider`;
		const reviewers = run.filter((job) => job.labels.includes("risk:high")).length;
		if (options.risk === "high" && reviewers >= max) return `cp-org-pr-review run ${anchor.id} already has ${reviewers} reviewer job(s) (max_reviewers ${max}); a fire never fans out wider`;
	}
	return undefined;
}
