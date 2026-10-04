/**
 * The dashboard-control audit writer: one append-only line per call to `state/operator/dashboard.jsonl`.
 * The viewer calls it for every POST it refuses after the --require-tailnet guard (src/viewer/control-api.ts);
 * the operator session's bridge half calls it for every request and outcome (src/dashboard-control.ts). The
 * inbox (`state/operator/inbox.jsonl`, cp-daemon P3) takes lines the same way: the viewer's `held`, the
 * session's `delivered`/`dropped`. `state/schedule-control.jsonl` (cp-hhuf P6) has two writers too: the viewer's
 * `request` lines and the parent's `claimed`/`outcome` lines (src/schedule-control.ts). `state/operator/answers.jsonl`
 * (cp-mxk4) too: the session's `posted` lines (src/operator-answers.ts) and the viewer's `acked` lines.
 *
 * `O_APPEND` with exactly one `write()` per line, then `fsync` — the `durableAppend` discipline
 * (src/json-store.ts), the only one safe for a file two processes add to at once. That module is not importable
 * from src/viewer/, so this is its copy. Append only: never replaces, renames or deletes; never throws.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { type AnswerLine, CONTROL_TEXT_MAX, controlInboxFile, controlJournalFile, type ControlAuditLine, type InboxLine, operatorAnswersFile, scheduleControlFile, type ScheduleControlLine } from "./control-files.ts";

export function appendControlAudit(stateDir: string, line: ControlAuditLine): { ok: true } | { ok: false; error: string } {
	const clipped = "text" in line && typeof line.text === "string" && line.text.length > CONTROL_TEXT_MAX ? { ...line, text: line.text.slice(0, CONTROL_TEXT_MAX) } : line;
	return appendLine(controlJournalFile(stateDir), clipped);
}

/** cp-daemon P3: one line to `state/operator/inbox.jsonl`, same discipline (the viewer's `held`, the session's `delivered`/`dropped`). */
export function appendInboxLine(stateDir: string, line: InboxLine): { ok: true } | { ok: false; error: string } {
	return appendLine(controlInboxFile(stateDir), line);
}

/** cp-hhuf P6: one line to `state/schedule-control.jsonl`, same discipline (the viewer's `request`, the parent's `claimed`/`outcome`). */
export function appendScheduleControlLine(stateDir: string, line: ScheduleControlLine): { ok: true } | { ok: false; error: string } {
	return appendLine(scheduleControlFile(stateDir), line);
}

/** cp-mxk4: one line to `state/operator/answers.jsonl`, same discipline (the session's `posted`, the viewer's `acked`). */
export function appendAnswerLine(stateDir: string, line: AnswerLine): { ok: true } | { ok: false; error: string } {
	return appendLine(operatorAnswersFile(stateDir), line);
}

function appendLine(file: string, line: unknown): { ok: true } | { ok: false; error: string } {
	const buffer = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const fd = openSync(file, "a", 0o600);
		try {
			const written = writeSync(fd, buffer, 0, buffer.length);
			if (written !== buffer.length) throw new Error(`short append to ${file}: wrote ${written} of ${buffer.length} bytes (out of space?)`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error: `${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
	}
}
