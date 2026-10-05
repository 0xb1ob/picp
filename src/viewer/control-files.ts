/**
 * Dashboard control (cp-dashboard-operator-control), read-only: where its files live and how a reader tells a good
 * one from a bad one. Shared by the viewer's control routes, `/doctor` and the operator session's bridge half
 * (src/dashboard-control.ts), so all three agree on one layout:
 *
 *   data/dashboard-control.json     optional opt-out, by hand: `{"enabled": false}`; absent is on
 *   state/operator/dashboard.json   0600: the serving session's pid, socket, socket token and CSRF token
 *   state/operator/dashboard.sock   0600: the operator session's control socket
 *   state/operator/dashboard.jsonl  0600: the append-only audit journal (bridge and viewer)
 *   state/operator/inbox.jsonl      0600: messages held while no operator session runs (cp-daemon P3)
 *   state/schedule-control.jsonl    0600: Schedules page requests (viewer request lines) and the parent's
 *                                   claimed/outcome lines (cp-hhuf P6)
 *   state/operator/answers.jsonl    0600: answers the operator asked for (bridge posted lines, viewer acked lines)
 *
 * Nothing in this file writes.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pushDataDir, readPushConfig } from "./push-files.ts";
import { UPLOAD_ID_SOURCE } from "./uploads.ts";

export const CONTROL_PROTOCOL = 1;
/** Composer text cap; with its JSON envelope it fits the body cap. */
export const CONTROL_TEXT_MAX = 16_000;
export const CONTROL_BODY_MAX_BYTES = 20 * 1024;
export const CONTROL_RATE_LIMIT = 20;
export const CONTROL_RATE_WINDOW_MS = 60_000;
const ASK_ID_RE = /^ask-[a-f0-9]+$/;

export const controlConfigFile = (stateDir: string): string => join(pushDataDir(stateDir), "dashboard-control.json");
export const controlRecordFile = (stateDir: string): string => join(stateDir, "operator", "dashboard.json");
export const controlSocketFile = (stateDir: string): string => join(stateDir, "operator", "dashboard.sock");
export const controlJournalFile = (stateDir: string): string => join(stateDir, "operator", "dashboard.jsonl");
/** cp-daemon P3: composer messages held while no operator session runs (viewer appends `held`, the session `delivered`/`dropped`). */
export const controlInboxFile = (stateDir: string): string => join(stateDir, "operator", "inbox.jsonl");
export const INBOX_MAX_HELD = 20;
/** A held message older than this is dropped and reported at delivery, never injected. */
export const INBOX_MAX_AGE_MS = 24 * 3_600_000;
export type InboxLine =
	| { type: "held"; id: string; at: string; text: string; ask_id: string | null }
	| { type: "delivered"; id: string; at: string }
	| { type: "dropped"; id: string; at: string; reason: string };

/** cp-hhuf P6: Schedules page requests; the viewer appends `request`, the parent `claimed` then `outcome`. */
export const scheduleControlFile = (stateDir: string): string => join(stateDir, "schedule-control.jsonl");
export const SCHEDULE_CONTROL_OPS = ["enable", "disable", "run_now", "remove"] as const;
export type ScheduleControlOp = (typeof SCHEDULE_CONTROL_OPS)[number];
/** A request the parent has not claimed within this is expired, never applied. */
export const SCHEDULE_CONTROL_MAX_AGE_MS = 120_000;
export const SCHEDULE_CONTROL_MAX_PENDING = 20;
export type ScheduleControlState = "queued" | "applying" | "done" | "refused" | "expired" | "interrupted";
export type ScheduleControlLine =
	| { type: "request"; by: "viewer"; id: string; at: string; peer: string | null; op: ScheduleControlOp; schedule_id: string }
	| { type: "claimed"; by: "parent"; id: string; at: string; pid: number }
	| { type: "outcome"; by: "parent"; id: string; at: string; state: "done" | "refused" | "expired" | "interrupted"; reason: string | null; job_id: string | null };
export interface ScheduleControlRequest {
	id: string;
	at: string;
	peer: string | null;
	op: ScheduleControlOp;
	schedule_id: string;
	state: ScheduleControlState;
	claimed_pid: number | null;
	reason: string | null;
	job_id: string | null;
}
const OUTCOME_STATES = ["done", "refused", "expired", "interrupted"];

/** Every request with its latest state, oldest first; `error` names an unreadable file (never silently empty). */
export function readScheduleControl(stateDir: string): { requests: ScheduleControlRequest[]; error: string | null } {
	const file = scheduleControlFile(stateDir);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return { requests: [], error: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : `${file}: ${(error as Error).message}` };
	}
	const requests = new Map<string, ScheduleControlRequest>();
	for (const row of text.split("\n")) {
		let line: Record<string, unknown>;
		try {
			line = JSON.parse(row) as Record<string, unknown>;
		} catch {
			continue; // a torn last line: the next append starts a fresh one
		}
		if (typeof line?.id !== "string" || typeof line.at !== "string") continue;
		if (line.type === "request") {
			if (requests.has(line.id) || !(SCHEDULE_CONTROL_OPS as readonly unknown[]).includes(line.op) || typeof line.schedule_id !== "string") continue;
			requests.set(line.id, { id: line.id, at: line.at, peer: typeof line.peer === "string" ? line.peer : null, op: line.op as ScheduleControlOp, schedule_id: line.schedule_id, state: "queued", claimed_pid: null, reason: null, job_id: null });
			continue;
		}
		const request = requests.get(line.id);
		if (!request) continue;
		if (line.type === "claimed" && request.state === "queued") Object.assign(request, { state: "applying", claimed_pid: typeof line.pid === "number" ? line.pid : null });
		else if (line.type === "outcome" && OUTCOME_STATES.includes(line.state as string)) {
			Object.assign(request, { state: line.state, reason: typeof line.reason === "string" ? line.reason : null, job_id: typeof line.job_id === "string" ? line.job_id : null });
		}
	}
	return { requests: [...requests.values()].sort((a, b) => a.at.localeCompare(b.at)), error: null };
}

/** cp-mxk4: answers the operator asked for; the bridge appends `posted`, the viewer `acked`. */
export const operatorAnswersFile = (stateDir: string): string => join(stateDir, "operator", "answers.jsonl");
export const ANSWER_ID_RE = /^ans-[a-f0-9]{12}$/;
export const isAnswerId = (value: unknown): value is string => typeof value === "string" && ANSWER_ID_RE.test(value);
export const ANSWER_QUESTION_MAX = 500;
export const ANSWER_TEXT_MAX = 8000;
export const ANSWER_EVIDENCE_MAX = 10;
export const ANSWER_PROJECT_MAX = 120;
export const ANSWERS_MAX_BYTES = 16 * 1024 * 1024;
export type AnswerLine =
	| { type: "posted"; by: "bridge"; id: string; at: string; project: string; question: string; answer: string; evidence_paths: string[]; job_id: string | null }
	| { type: "acked"; by: "viewer"; id: string; at: string; peer: string | null };
export interface RecordedAnswer {
	id: string;
	project: string;
	question: string;
	answer: string;
	evidence_paths: string[];
	job_id: string | null;
	posted_at: string;
	acked_at: string | null;
	acked_peer: string | null;
}
// Kept inline: this module may not import src/viewer/overview-read.ts.
const ANSWER_TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const isText = (value: unknown): value is string => typeof value === "string";

/**
 * Fold the answers journal, oldest first. An unterminated last line (torn) is ignored; a complete line that is not
 * JSON or not a valid line, a repeated `posted` id or `job_id` (the first wins) and an `acked` for an unknown id count
 * in `skipped`; a repeated `acked` is ignored. `error` names an unreadable or oversized file (never silently empty).
 */
export function readAnswers(stateDir: string): { exists: boolean; answers: RecordedAnswer[]; skipped: number; error: string | null } {
	const file = operatorAnswersFile(stateDir);
	let text: string;
	try {
		const size = statSync(file).size;
		if (size > ANSWERS_MAX_BYTES) return { exists: true, answers: [], skipped: 0, error: `${file} is ${size} bytes, over the ${ANSWERS_MAX_BYTES} byte cap; move it aside` };
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, answers: [], skipped: 0, error: null };
		return { exists: true, answers: [], skipped: 0, error: `${file}: ${(error as Error).message}` };
	}
	const rows = text.split("\n");
	rows.pop(); // "" after the final newline, or the torn last line
	const byId = new Map<string, RecordedAnswer>();
	const jobs = new Set<string>();
	let skipped = 0;
	for (const row of rows) {
		let line: Record<string, unknown>;
		try {
			line = JSON.parse(row) as Record<string, unknown>;
		} catch {
			skipped++;
			continue;
		}
		if (line === null || typeof line !== "object" || !isAnswerId(line.id) || !isText(line.at) || !ANSWER_TIME_RE.test(line.at)) {
			skipped++;
			continue;
		}
		if (line.type === "posted" && line.by === "bridge") {
			const evidence = line.evidence_paths;
			const job = line.job_id === null ? null : isText(line.job_id) ? line.job_id : undefined;
			if (!isText(line.project) || !isText(line.question) || !isText(line.answer) || !Array.isArray(evidence) || !evidence.every(isText) || job === undefined || byId.has(line.id) || (job !== null && jobs.has(job))) {
				skipped++;
				continue;
			}
			if (job !== null) jobs.add(job);
			byId.set(line.id, { id: line.id, project: line.project, question: line.question, answer: line.answer, evidence_paths: evidence, job_id: job, posted_at: line.at, acked_at: null, acked_peer: null });
		} else if (line.type === "acked" && line.by === "viewer" && (line.peer === null || isText(line.peer))) {
			const known = byId.get(line.id);
			if (!known) skipped++;
			else if (known.acked_at === null) Object.assign(known, { acked_at: line.at, acked_peer: line.peer });
		} else skipped++;
	}
	return { exists: true, answers: [...byId.values()], skipped, error: null };
}

export type ControlConfig = { state: "on" | "off" | "invalid"; reason: string };

/** On unless `data/dashboard-control.json` says `{"enabled": false}`; anything else in that file is invalid (fail closed). */
export function readControlConfig(stateDir: string): ControlConfig {
	const file = controlConfigFile(stateDir);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "on", reason: "on by default (no data/dashboard-control.json)" };
		return { state: "invalid", reason: `${file} is unreadable: ${(error as Error).message}` };
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { state: "invalid", reason: `${file} is not a JSON object` };
	const extra = Object.keys(raw).filter((key) => key !== "enabled");
	if (extra.length) return { state: "invalid", reason: `${file} has unknown key ${extra.join(", ")}; the only key is "enabled"` };
	const enabled = (raw as { enabled?: unknown }).enabled;
	if (enabled === false) return { state: "off", reason: "data/dashboard-control.json has enabled:false" };
	if (enabled === true || enabled === undefined) return { state: "on", reason: "data/dashboard-control.json has enabled:true" };
	return { state: "invalid", reason: `${file}: enabled must be true or false` };
}

/** The dashboard's public origin: the one `/api/push` reports (data/push/config.json), or null when push is not set up. */
export function controlOrigin(stateDir: string): string | null {
	return readPushConfig(pushDataDir(stateDir))?.origin ?? null;
}

export interface ControlRecord {
	version: 1;
	pid: number;
	socket: string;
	token: string;
	csrf: string;
	started_at: string;
	/** The commit the operator session loaded (src/viewer/loaded-commit.ts); absent in a record written before cp-kz20. */
	commit?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Read fresh on every call: a session start rotates both tokens. */
export function readControlRecord(stateDir: string): { state: "absent" } | { state: "invalid"; reason: string } | { state: "ok"; record: ControlRecord } {
	const file = controlRecordFile(stateDir);
	let raw: Partial<ControlRecord>;
	try {
		raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ControlRecord>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "invalid", reason: `${file} is unreadable: ${(error as Error).message}` };
	}
	if (raw?.version !== 1 || !Number.isInteger(raw.pid) || raw.socket !== controlSocketFile(stateDir) || !HEX64.test(String(raw.token)) || !HEX64.test(String(raw.csrf)) || typeof raw.started_at !== "string") {
		return { state: "invalid", reason: `${file} is not a record this build wrote` };
	}
	return { state: "ok", record: raw as ControlRecord };
}

/** The last line of every message the dashboard injects: an id, never an instruction; attached images list their upload ids. */
export function dashboardMarker(id: string, askId?: string | null, images?: readonly string[]): string {
	return `[cp-dashboard ${id} — from the dashboard${askId ? `; ask=${askId}` : ""}${images?.length ? `; images=${images.join(",")}` : ""}]`;
}

const MARKER_RE = new RegExp(`(?:^|\\n)\\[cp-dashboard (dc-\\d{14}-[0-9a-f]{8}) — from the dashboard(?:; ask=(ask-[a-f0-9]+))?(?:; images=(${UPLOAD_ID_SOURCE}(?:,${UPLOAD_ID_SOURCE}){0,7}))?\\]\\s*$`);

/** A dashboard-sent user message: its body without the marker, the request id, the ask a click answered and its image ids. */
export function parseDashboardText(text: string): { body: string; id: string; askId: string | null; images?: string[] } | undefined {
	const match = MARKER_RE.exec(text);
	if (!match) return undefined;
	return { body: text.slice(0, match.index).trimEnd(), id: match[1]!, askId: match[2] ?? null, ...(match[3] ? { images: match[3].split(",") } : {}) };
}

export const isAskId = (value: unknown): value is string => typeof value === "string" && ASK_ID_RE.test(value);

export type ControlKind = "message" | "answer" | "abort" | "restart";
export type ControlDeliver = "prompt" | "followUp" | "steer" | "abort" | "restart";

/**
 * One audit line. The bridge writes request/outcome; the viewer writes refused (after the --require-tailnet guard)
 * and one `upload` line per stored image. Image lines carry upload ids, mime types and byte counts, never bytes.
 */
export type ControlAuditLine =
	| { type: "request"; by: "bridge"; id: string; at: string; peer: string | null; kind: ControlKind; text: string | null; ask_id: string | null; deliver: ControlDeliver; images?: string[] }
	| { type: "outcome"; by: "bridge"; id: string; at: string; peer: string | null; state: "injected" | "delivered" | "queued" | "failed" | "refused" | "restarting"; reason: string | null }
	| { type: "refused"; by: "viewer"; id: null; at: string; peer: string | null; kind: ControlKind | "start" | "schedule" | "answer_ack" | "upload" | null; text: string | null; ask_id: string | null; status: number; reason: string; bytes?: number; via?: "herdr" | "tmux"; op?: ScheduleControlOp; schedule_id?: string; answer_id?: string; images?: string[]; mime?: string }
	| { type: "upload"; by: "viewer"; id: string; at: string; peer: string | null; mime: string; bytes: number }
	| { type: "start"; by: "viewer"; id: null; at: string; peer: string | null; via: "herdr" | "tmux"; resume?: true; state: "starting" | "unavailable"; reason: string | null };
