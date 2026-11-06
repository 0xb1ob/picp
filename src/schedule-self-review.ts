/**
 * The cp-self-review recipe in code (schedules refactor PR3): six report-only readers and one board synthesis, driven
 * by the schedule runner for a native run; old runs stay the parent's. Task text lives in prompts/schedules/.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isoTimestamp, type FleetRecord, type Job } from "./contracts.ts";
import { PACKAGE_ROOT } from "./home.ts";
import type { Ledger } from "./ledger.ts";
import type { ScheduleRunStore } from "./schedule-runs.ts";
import { isNativePolicy } from "./viewer/schedule-policy.ts";
import type { ScheduleRun } from "./viewer/schedule-run-core.ts";

export const SELF_REVIEW_SKILL = "cp-self-review";
export const SELF_REVIEW_VERSION = 1;
export const SELF_REVIEW_WALL_CLOCK_SECONDS = 10_800;
const DEFAULT_HOURS = 36;
const EXPANDED = "expanded:";
const LIVE: readonly string[] = ["launching", "waiting"];

interface Reader { role: string; title: string; sources: string; focus: string; third?: 0 | 1 | 2 }
const SLICE_SOURCES = "`state/sessions/<iso>_<uuid>.jsonl` worker transcripts in the slice, `state/runs/<id>/`";
const SLICE_FOCUS = "tool errors, waste, CI, treehouse, wrong repo, rebase, caps, cost outliers; per-job peak context and compactions, jobs that compacted mid-task or hit the window, tool outputs that bloat context (large reads, logs, diffs)";
export const SELF_REVIEW_READERS: readonly Reader[] = [
	{ role: "L1", title: "Review parent session errors",
		sources: "`state/sessions/cp-parent*.jsonl` (archives) and the live session: the `sessionFile` named in `state/sessions/cp-parent-control.json`, a worker-style `<iso>_<uuid>.jsonl` name, read when its interval overlaps the window",
		focus: "protocol errors, self-resolved gates, wrong relays, long turns, duplicate relays; context growth per turn, compactions and rotations (when, tokens before/after, duration, failures/timeouts like 'timeout waiting for response to compact'), what fills the context (relays, wake bodies, tool output, duplicated sends), turns started near/over `compactAtTokens`" },
	{ role: "L2", title: "Review main-session delivery and operator asks",
		sources: "operator session files listed in `state/sessions/operator-sessions.jsonl` (pi session dir for the home cwd), `state/operator/dashboard.jsonl`, `state/operator/asks.jsonl`",
		focus: "missed or late messages, chat-only questions, hung turns, wrong delegations; operator-session context size, compactions and `self_compact` handoffs, what filled it (duplicate relays, long reports)" },
	{ role: "L3", title: "Review worker session failures, slice 1", sources: SLICE_SOURCES, focus: SLICE_FOCUS, third: 0 },
	{ role: "L4", title: "Review worker session failures, slice 2", sources: SLICE_SOURCES, focus: SLICE_FOCUS, third: 1 },
	{ role: "L5", title: "Review worker session failures, slice 3", sources: SLICE_SOURCES, focus: SLICE_FOCUS, third: 2 },
	{ role: "L6", title: "Review daemon health and delivery failures",
		sources: "`state/daemon.log`, `daemon.prev.log`, `escalations.json`, `wakeups.json`, `answered.json`, `update.json` (+ `update-before-reset-*.json`), `health.json`, `runs/*/events.jsonl`",
		focus: "updater rollbacks, missing alerts, stale held rows; compaction/rotation events in daemon/bridge logs and `state/sessions/cp-parent-control.json` history" },
];
export const SELF_REVIEW_SYNTHESIS = { role: "S1", title: "Synthesize self-review against current work" } as const;
const ROLES: readonly string[] = [...SELF_REVIEW_READERS.map((reader) => reader.role), SELF_REVIEW_SYNTHESIS.role];

export interface SelfReviewWindow { start: string; end: string; hours: number }
/** `end` = the anchor's creation, `start` = end - N hours; N from a `window_hours: <1-168>` line, else 36. */
export function selfReviewWindow(anchorCreatedAt: string, description = ""): SelfReviewWindow {
	const asked = Number(/^window_hours:\s*(\d+)\s*$/m.exec(description)?.[1] ?? DEFAULT_HOURS);
	const hours = asked >= 1 && asked <= 168 ? asked : DEFAULT_HOURS;
	const end = Date.parse(anchorCreatedAt);
	return { start: isoTimestamp(new Date(end - hours * 3_600_000)), end: isoTimestamp(new Date(end)), hours };
}

/** The L3-L5 thirds: `[start, start+N/3)`, `[start+N/3, start+2N/3)`, `[start+2N/3, end]`. */
export function windowText(window: SelfReviewWindow, third?: 0 | 1 | 2): string {
	if (third === undefined) return `[${window.start}, ${window.end}]`;
	const start = Date.parse(window.start), step = (Date.parse(window.end) - start) / 3;
	const at = (i: number): string => isoTimestamp(new Date(start + i * step));
	return third === 2 ? `[${at(2)}, ${window.end}]` : `[${at(third)}, ${at(third + 1)})`;
}

function fill(name: string, values: Record<string, string | number>): string {
	return readFileSync(join(PACKAGE_ROOT, "prompts", "schedules", name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		if (!(key in values)) throw new Error(`${name}: no value for {{${key}}}`);
		return String(values[key]);
	}).trim();
}

type Anchor = Pick<Job, "id" | "created_at" | "description">;
const ids = (run: ScheduleRun) => ({ schedule: run.schedule_id, run: run.id, version: SELF_REVIEW_VERSION });

export function readerTask(run: ScheduleRun, anchor: Anchor, reader: Reader): string {
	const window = windowText(selfReviewWindow(anchor.created_at, anchor.description), reader.third);
	return fill("self-review-reader.md", { ...ids(run), role: reader.role, title: reader.title, window, sources: reader.sources, focus: reader.focus });
}

export function synthesisTask(run: ScheduleRun, anchor: Anchor, readers: readonly { role: string; id: string }[], s1: string): string {
	const window = selfReviewWindow(anchor.created_at, anchor.description);
	const lines = readers.map((reader) => `- ${reader.role} ${reader.id}: state/artifacts/${reader.id}/report.md`).join("\n");
	return fill("self-review-synthesis.md", { ...ids(run), s1, project: run.policy.project, start: window.start, end: window.end, readers: lines, job_ids: [...readers.map((reader) => reader.id), s1].join(", ") });
}

export const isSelfReviewRun = (run: ScheduleRun | undefined): run is ScheduleRun => !!run && isNativePolicy(run.policy) && run.policy.recipe.skill === SELF_REVIEW_SKILL;

/** A code-owned member's recipe role; undefined for the anchor, a parent-admitted job (role null) or another run. */
export function selfReviewRole(run: ScheduleRun | undefined, jobId: string): string | undefined {
	const role = isSelfReviewRun(run) ? run.members.find((member) => member.job_id === jobId)?.role : undefined;
	return role && ROLES.includes(role) ? role : undefined;
}

export interface SelfReviewPorts {
	runs: ScheduleRunStore;
	ledger: Ledger;
	/** Never throws: a refusal is noted on the job by the runner and retried on the next event or tick. */
	dispatch: (request: { jobId: string; task: string; wallClockSeconds: number }) => Promise<void>;
	fleetJobs: () => readonly FleetRecord[];
	now: () => Date;
}

/**
 * One idempotent step of a native run: admit seven roles (replay by role, then title), wire S1 <- L1-L6, dispatch
 * within parallelism, then S1, then close the anchor. Deadline/cap or a lost reader drops what has not started.
 */
export async function advanceSelfReview(ports: SelfReviewPorts, runId: string): Promise<void> {
	const { runs, ledger } = ports;
	let run = runs.run(runId);
	if (!isSelfReviewRun(run) || run.phase === "closed" || !run.anchor_job_id) return;
	const anchor = ledger.read().jobs.find((job) => job.id === run!.anchor_job_id);
	if (!anchor || anchor.status === "closed") return;
	// A parent expansion begun before the runner owned this run (marker, no role) stays the parent's.
	if (anchor.comments.some((comment) => comment.text.startsWith(EXPANDED)) && !run.members.some((member) => member.role)) return;
	const roleIds = new Map<string, string>();
	for (const spec of [...SELF_REVIEW_READERS, SELF_REVIEW_SYNTHESIS]) {
		const admitted = run.members.find((member) => member.role === spec.role)?.job_id;
		if (admitted) { roleIds.set(spec.role, admitted); continue; }
		const title = `${spec.title} [${anchor.id}]`, project = run.policy.project;
		const job = ledger.findDuplicate({ title, project }) ?? await ledger.create({ title, project, kind: "research", delivery: spec.role === "S1" ? "board" : "local", labels: [`schedule:${run.schedule_id}`] });
		run = await runs.admitMember(run.id, { job_id: job.id, role: spec.role, admitted_at: job.created_at });
		roleIds.set(spec.role, job.id);
	}
	const readerIds = SELF_REVIEW_READERS.map((reader) => roleIds.get(reader.role)!), s1 = roleIds.get("S1")!;
	const blockers = ledger.read().jobs.find((job) => job.id === s1)?.blocked_by ?? [];
	for (const id of readerIds) if (!blockers.includes(id)) await ledger.addDep(s1, id);
	if (!anchor.comments.some((comment) => comment.text.startsWith(EXPANDED))) {
		await ledger.comment(anchor.id, `${EXPANDED} ${[...roleIds].map(([role, id]) => `${role} ${id}`).join(", ")} (self-review v${SELF_REVIEW_VERSION} in code, run ${run.id})`);
	}
	const fleet = new Map(ports.fleetJobs().map((record) => [record.job_id, record]));
	let jobs = new Map(ledger.read().jobs.map((job) => [job.id, job]));
	const unstarted = (id: string): boolean => jobs.get(id)?.status === "open" && !fleet.has(id);
	const cap = run.cap_notices.find((key) => key.endsWith(":1"));
	const stop = isoTimestamp(ports.now()) >= run.deadline_at ? "deadline passed" : cap ? `${cap.split(":")[0]} cap reached` : undefined;
	// A report exists only behind a teardown's delivery close; any other close (dropped:, failed:, …) lost it.
	const delivered = (id: string): boolean => jobs.get(id)?.status === "closed" && /^(researched|gated):/.test(jobs.get(id)?.close_reason ?? "");
	const lost = readerIds.filter((id) => jobs.get(id)?.status === "closed" && !delivered(id));
	for (const id of [...readerIds, s1].filter(unstarted)) {
		if (stop) await ledger.drop(id, `run ${run.id}: ${stop}; not started`);
		else if (id === s1 && lost.length) await ledger.drop(id, `run ${run.id}: required reader(s) ${lost.join(", ")} not delivered (dropped or failed); no synthesis without all six reports`);
	}
	jobs = new Map(ledger.read().jobs.map((job) => [job.id, job]));
	let live = [...readerIds, s1].filter((id) => LIVE.includes(fleet.get(id)?.phase ?? "")).length;
	const parallelism = run.execution?.effective.parallelism ?? run.policy.limits.parallelism;
	for (const reader of SELF_REVIEW_READERS) {
		const id = roleIds.get(reader.role)!;
		if (live >= parallelism) break;
		if (!unstarted(id)) continue;
		live++;
		await ports.dispatch({ jobId: id, task: readerTask(run, anchor, reader), wallClockSeconds: SELF_REVIEW_WALL_CLOCK_SECONDS });
	}
	if (live < parallelism && unstarted(s1) && readerIds.every(delivered)) {
		const readers = SELF_REVIEW_READERS.map((reader) => ({ role: reader.role, id: roleIds.get(reader.role)! }));
		await ports.dispatch({ jobId: s1, task: synthesisTask(run, anchor, readers, s1), wallClockSeconds: SELF_REVIEW_WALL_CLOCK_SECONDS });
	}
	const synthesis = jobs.get(s1)!;
	if (![...readerIds, s1].every((id) => jobs.get(id)?.status === "closed")) return;
	const board = fleet.get(s1)?.receipts?.find((receipt) => receipt.kind === "board")?.url;
	if (!delivered(s1)) await ledger.drop(anchor.id, `self-review run ${run.id} ended without a synthesis (${synthesis.close_reason})`);
	else await ledger.close(anchor.id, `researched: synthesis ${s1}${board ? ` ${board}` : ""} (self-review run ${run.id})`);
}
