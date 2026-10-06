/**
 * The dashboard-control audit writer: one append-only line per call to `state/operator/dashboard.jsonl`.
 * The viewer calls it for every POST it refuses after the --require-tailnet guard (src/viewer/control-api.ts);
 * the operator session's bridge half calls it for every request and outcome (src/dashboard-control.ts). The
 * inbox (`state/operator/inbox.jsonl`, cp-daemon P3) takes lines the same way: the viewer's `held`, the
 * session's `delivered`/`dropped`. `state/schedule-control.jsonl` (cp-hhuf P6) has two writers too: the viewer's
 * `request` lines and the parent's `claimed`/`outcome` lines (src/schedule-control.ts). `state/operator/answers.jsonl`
 * (cp-mxk4) too: the session's `posted` lines (src/operator-answers.ts) and the viewer's `acked` lines.
 * `state/operator/threads.jsonl` (cp-xmw2) too: `open`/`bind` lines from the session's bridge and the viewer, `done`
 * lines from the viewer.
 *
 * `O_APPEND` with exactly one `write()` per line, then `fsync` — the `durableAppend` discipline
 * (src/json-store.ts), the only one safe for a file two processes add to at once. That module is not importable
 * from src/viewer/, so this is its copy. Append only: never replaces, renames or deletes; never throws.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { type AnswerLine, CONTROL_TEXT_MAX, controlInboxFile, controlJournalFile, type ControlAuditLine, type InboxLine, isThreadRef, operatorAnswersFile, operatorThreadsFile, readThreads, scheduleControlFile, type ScheduleControlLine, THREAD_TAG_RE, type ThreadLine, type ThreadRef } from "./control-files.ts";

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

/** cp-xmw2: one line to `state/operator/threads.jsonl`, same discipline (`open`/`bind` from the bridge and the viewer, the viewer's `done`). */
export function appendThreadLine(stateDir: string, line: ThreadLine): { ok: true } | { ok: false; error: string } {
	return appendLine(operatorThreadsFile(stateDir), line);
}

export type BindThreadInput = { tag: string; ref: ThreadRef; by: "bridge" | "viewer"; peer: string | null; at: string };
export type BindThreadResult = { ok: true; thread: string; tag: string; opened: boolean } | { ok: false; error: string };

/**
 * cp-xmw2: file `ref` under the thread tagged `tag` (already normalized): reuse the tag's `th-` id or append an `open`
 * with a new one, then append a `bind` unless the ref already belongs to that thread. Never throws; an unreadable
 * journal, a bad tag or ref, or a failed append comes back as `error`.
 */
export function bindThread(stateDir: string, input: BindThreadInput): BindThreadResult {
	const { tag, ref, by, peer, at } = input;
	if (typeof tag !== "string" || !THREAD_TAG_RE.test(tag)) return { ok: false, error: `thread tag ${JSON.stringify(tag)} is not normalized (1-32 of a-z 0-9 -, first a letter or digit)` };
	if (!isThreadRef(ref)) return { ok: false, error: `thread ref ${JSON.stringify(ref)} is not a dashboard, ask or answer id` };
	const journal = readThreads(stateDir);
	if (journal.error) return { ok: false, error: journal.error };
	let thread = journal.threads.find((item) => item.tag === tag)?.id;
	const opened = thread === undefined;
	if (thread === undefined) {
		thread = `th-${randomBytes(6).toString("hex")}`;
		const open = appendThreadLine(stateDir, { type: "open", by, id: thread, at, tag, peer });
		if (!open.ok) return open;
	} else if (journal.refs.get(ref.id) === thread) return { ok: true, thread, tag, opened: false };
	const bind = appendThreadLine(stateDir, { type: "bind", by, at, thread, ref: { kind: ref.kind, id: ref.id }, peer });
	return bind.ok ? { ok: true, thread, tag, opened } : bind;
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
