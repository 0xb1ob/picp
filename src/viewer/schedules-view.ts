/**
 * The Schedules page's projection: every saved schedule (`state/schedules.json`,
 * read and validated by `readScheduleFile` in schedule-core.ts, the reader the scheduler itself uses), its next fire
 * from the scheduler's cron walk (same module), its mandate's state, and the last ledger jobs
 * labelled `schedule:<id>`. Read-only; changes are `cp_schedule`'s or the page's journaled requests (control-api.ts,
 * src/schedule-control.ts).
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { nextCronSlot, parseCron, readScheduleFile, type Schedule } from "./schedule-core.ts";
import type { ScheduleHistoryJob, ScheduleItem, SchedulesResponse } from "./api-types.ts";
import { listBoards, type BoardWarn } from "./boards.ts";
import { PR_URL, readMandates } from "./fleet-view.ts";
import { objectList, strings } from "./overview-read.ts";
import { isSafeId, obj, readObject, runtimeRoot, str, type Json, type ViewerState } from "./sessions.ts";

export const SCHEDULE_HISTORY = 10;

function next(schedule: Schedule, now: number): Pick<ScheduleItem, "next_at" | "next_note"> {
	const trigger = schedule.trigger;
	if (trigger.type === "manual") return { next_at: null, next_note: "manual: fires only on Run now" };
	if (trigger.type === "watch") {
		const due = schedule.last_checked_at ? Date.parse(schedule.last_checked_at) + trigger.every_seconds * 1000 : Date.parse(schedule.created_at);
		return Number.isFinite(due) ? { next_at: new Date(due).toISOString(), next_note: null } : { next_at: null, next_note: "no recorded check time" };
	}
	try {
		const slot = nextCronSlot(parseCron(trigger.cron), trigger.tz, new Date(now));
		return slot ? { next_at: slot.toISOString(), next_note: null } : { next_at: null, next_note: "no slot within a year" };
	} catch (error) {
		return { next_at: null, next_note: (error as Error).message };
	}
}

function mandateStatus(grants: Json[], id: string, now: number): ScheduleItem["mandate_status"] {
	const m = grants.find((g) => g.id === id);
	if (!m) return "missing";
	if (m.status === "active") return Date.parse(String(m.expiry)) <= now ? "expired" : "active";
	return m.status === "paused" || m.status === "revoked" || m.status === "expired" ? m.status : "missing";
}

function prUrl(state: ViewerState, id: string, envelope: Json | undefined): string | null {
	if (!isSafeId(id)) return null;
	const receipt = str(readObject(join(state.stateDir, "runs", id, "merge.json"))?.pr_url);
	return [receipt, str(envelope?.pr_url)].find((url): url is string => !!url && PR_URL.test(url)) ?? null;
}

/** Mirrors `ANSWER_MAX_BYTES` (src/contracts); tests/viewer-schedules.test.ts pins it. */
export const SCHEDULE_ANSWER_MAX_BYTES = 8192;

/** The length of `buffer` without a trailing, cut-off UTF-8 character. */
function utf8Boundary(buffer: Buffer): number {
	let start = buffer.length - 1;
	while (start > 0 && (buffer[start]! & 0xc0) === 0x80) start -= 1;
	const lead = buffer[start] ?? 0;
	const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	return start + width > buffer.length ? start : buffer.length;
}

/** The run's answer, read only from inside its own `state/artifacts/<id>/` (symlinks resolved), capped. */
export function scheduleAnswer(state: ViewerState, id: string, artifactPath: string | undefined): ScheduleHistoryJob["answer"] {
	if (!isSafeId(id)) return null;
	try {
		const root = realpathSync(join(state.stateDir, "artifacts"));
		const dir = realpathSync(join(root, id));
		if (dir !== join(root, id)) return null; // a symlinked job dir would redefine the allowed root
		const inside = (path: string): string | undefined => {
			try { const real = realpathSync(path); return real.startsWith(`${dir}${sep}`) && statSync(real).isFile() ? real : undefined; } catch { return undefined; }
		};
		// Intake copies an answer written elsewhere to report.md; a path outside the job's own dir is never read.
		const file = (artifactPath ? inside(artifactPath) : undefined) ?? inside(join(dir, "report.md"));
		if (!file) return null;
		const size = statSync(file).size;
		const buffer = Buffer.alloc(Math.min(size, SCHEDULE_ANSWER_MAX_BYTES));
		const fd = openSync(file, "r");
		try { readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
		const truncated = size > SCHEDULE_ANSWER_MAX_BYTES;
		return { text: buffer.subarray(0, truncated ? utf8Boundary(buffer) : buffer.length).toString("utf8"), bytes: size, truncated };
	} catch {
		return null; // no answer on disk (yet): the row still shows the status and summary
	}
}

export function schedulesView(state: ViewerState, warn: BoardWarn = () => {}, now = Date.now()): SchedulesResponse {
	const generated_at = new Date(now).toISOString();
	let schedules: Schedule[];
	try {
		schedules = readScheduleFile(join(state.stateDir, "schedules.json"));
	} catch (error) {
		return { generated_at, error: (error as Error).message, schedules: [] };
	}
	if (!schedules.length) return { generated_at, error: null, schedules: [] };
	const grants = readMandates(state);
	const ledger = objectList(join(runtimeRoot(state.home), "jobs.json"), "jobs", (j) => typeof j.id === "string" && isSafeId(j.id)).value;
	const boards = listBoards(state, warn);
	return {
		generated_at, error: null,
		schedules: schedules.map(({ last_output_sha: _sha, ...schedule }): ScheduleItem => ({
			...schedule,
			...next(schedule, now),
			mandate_status: mandateStatus(grants, schedule.mandate_id, now),
			history: ledger
				.filter((j) => strings(j.labels).includes(`schedule:${schedule.id}`))
				.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || String(b.id).localeCompare(String(a.id)))
				.slice(0, SCHEDULE_HISTORY)
				.map((j) => {
					const id = String(j.id);
					const board = boards.find((b) => b.job_ids.includes(id));
					const record = readObject(join(state.stateDir, "runs", id, "envelope.json"));
					const envelope = obj(record?.envelope);
					return {
						id, title: str(j.title) ?? null, status: str(j.status) ?? "unknown", close_reason: str(j.close_reason) ?? null,
						created_at: str(j.created_at) ?? null, pr_url: prUrl(state, id, envelope), board_href: board ? `/boards/${board.slug}/` : null,
						summary: str(envelope?.summary) ?? null, reported_at: envelope ? str(record?.received_at) ?? null : null,
						answer: strings(j.labels).includes("delivery:answer") ? scheduleAnswer(state, id, str(envelope?.artifact_path)) : null,
					};
				}),
		})),
	};
}
