/**
 * Groups a schedule's labelled ledger jobs by run (one fire or Run now = one anchor job plus the jobs it fanned out to).
 * Pure and viewer-safe: no I/O, no writes. Anchors are recognised by the scheduler's own note prefixes (scheduler.ts).
 */
import type { Schedule } from "./schedule-core.ts";
import type { ScheduleRunView } from "./api-types.ts";

export const ANCHOR_NOTE = /^(?:scheduled (?:for|by) sch-[0-9a-f]{6}\b|run now from the dashboard \(|run now via cp_schedule \()/;
export const SCHEDULE_RUNS = 5;

type Job = Record<string, unknown>;
type Via = ScheduleRunView["via"];
/** Per-job facts the view reads from the board list and run receipts. */
export interface RunJobFacts { board_href: string | null; pr_url: string | null }
export interface RunGroups {
	runs: ScheduleRunView[];
	/** Labelled jobs no anchor claims. */
	unattributed: string[];
	run_count: number;
	job_count: number;
	last_run: { job_id: string; at: string; via: Via; missed: boolean } | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** `L1 cp-x, …, S1 cp-y` from the newest `expanded:` comment. */
export function expandedRoles(comments: readonly { text?: unknown }[]): Record<string, string> {
	const roles: Record<string, string> = {};
	const body = [...comments].reverse().map((c) => text(c.text)).find((t) => t.startsWith("expanded:"));
	for (const m of body?.matchAll(/\b(L\d+|R\d+|S1) (cp-[A-Za-z0-9_-]+)/g) ?? []) roles[m[1]!] = m[2]!;
	return roles;
}

/** Where a schedule's run results land, from its skill, kind and delivery. */
export function scheduleLands(job: Schedule["job"]): "board" | "report" | "branch" | "pull_request" | "plan" | "answer" {
	if (job.skill === "cp-org-pr-review") return "report";
	if (job.skill) return "board";
	if (job.delivery === "pr") return "pull_request";
	if (job.delivery === "pipeline") return "plan";
	if (job.delivery === "answer") return "answer";
	if (job.delivery === "board") return "board";
	return job.kind === "research" ? "report" : "branch";
}

const viaOf = (notes: string): Via => (notes.startsWith("run now from the dashboard") ? "dashboard" : notes.startsWith("run now via cp_schedule") ? "cp_schedule" : "slot");
const created = (j: Job): string => text(j.created_at);

export function groupScheduleRuns(jobs: readonly Job[], schedule: Schedule, lastFire: Schedule["last_fire"] | undefined, facts: (id: string) => RunJobFacts): RunGroups {
	const anchors = jobs.filter((j) => ANCHOR_NOTE.test(text(j.notes))).sort((a, b) => created(a).localeCompare(created(b)) || text(a.id).localeCompare(text(b.id)));
	const members = new Map<string, Job[]>(anchors.map((a) => [text(a.id), [a]]));
	const unattributed: Job[] = [];
	for (const j of jobs) {
		if (members.has(text(j.id))) continue;
		const suffix = /\s\[([A-Za-z0-9_-]+)\]$/.exec(text(j.title))?.[1];
		let home = suffix && members.has(suffix) ? suffix : undefined;
		// Time-based attribution only for skill schedules: the latest anchor at or before the job (so before the next anchor).
		if (!home && schedule.job.skill) home = anchors.filter((a) => created(a) <= created(j)).map((a) => text(a.id)).pop();
		if (home) members.get(home)!.push(j); else unattributed.push(j);
	}
	const resultOf = (a: Job, group: Job[]): ScheduleRunView["result"] => {
		const id = text(a.id);
		const href = `#job/${id}`;
		const roles = expandedRoles(Array.isArray(a.comments) ? (a.comments as { text?: unknown }[]) : []);
		const board = group.find((j) => facts(text(j.id)).board_href);
		const pr = group.find((j) => facts(text(j.id)).pr_url);
		return board ? { kind: "board", job_id: text(board.id), href: facts(text(board.id)).board_href! }
			: pr ? { kind: "pull_request", job_id: text(pr.id), href: facts(text(pr.id)).pr_url! }
			: schedule.job.delivery === "answer" ? { kind: "answer", job_id: id, href }
			: schedule.job.skill === "cp-org-pr-review" && roles.S1 ? { kind: "report", job_id: roles.S1, href: `#job/${roles.S1}` }
			: schedule.job.kind === "research" && schedule.job.delivery === "local" ? { kind: "report", job_id: id, href }
			: schedule.job.kind === "ship" && schedule.job.delivery === "local" ? { kind: "branch", job_id: id, href }
			: { kind: "job", job_id: id, href };
	};
	const all = anchors.map((a) => {
		const id = text(a.id);
		const group = members.get(id)!;
		const open = group.filter((j) => j.status !== "closed").length;
		const via = viaOf(text(a.notes));
		return { a, group, view: {
			run_id: id, anchor_id: id, via, at: created(a), missed: via === "slot" && lastFire?.job_id === id && lastFire.missed,
			status: open ? "open" : "closed", jobs_open: open, jobs_total: group.length, job_ids: group.map((j) => text(j.id)), result: null,
		} satisfies ScheduleRunView };
	}).sort((a, b) => b.view.at.localeCompare(a.view.at) || b.view.run_id.localeCompare(a.view.run_id));
	const newest = all[0]?.view;
	return {
		runs: all.slice(0, SCHEDULE_RUNS).map(({ a, group, view }) => ({ ...view, result: resultOf(a, group) })),
		unattributed: unattributed.map((j) => text(j.id)), run_count: all.length, job_count: jobs.length,
		last_run: newest ? { job_id: newest.anchor_id, at: newest.at, via: newest.via, missed: newest.missed } : null,
	};
}
