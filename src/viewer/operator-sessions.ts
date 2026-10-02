/**
 * The operator session's own pi transcripts (cp-sessions-operator-transcript-9giu):
 * the read half of the record the cp-bridge keeps at
 * `<state>/sessions/operator-sessions.jsonl`.
 *
 * The cp-bridge runs *inside* the operator's main pi session, the one place that
 * knows that session's `PI_SESSION_FILE`; it appends every file it sees there on
 * `cp_parent start` and `cp_parent send`. The viewer lists those recorded paths
 * instead of guessing a pi session directory, and a relaunch (a new file) leaves
 * the older ones listed, newest first.
 *
 * This half only reads — the viewer's own rule keeps every module here
 * dependency-free and write-free (`tests/viewer-workbench.test.ts`), so the
 * writer is `src/operator-session-log.ts`, which imports this file. A malformed
 * line is skipped, never a crash: this sits on the viewer's request path.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const OPERATOR_SESSIONS_FILE = "operator-sessions.jsonl";

export interface OperatorSession {
	/** The recorded file's basename: the viewer's path-free handle for it. */
	id: string;
	file: string;
	at: string;
}

/** `<sessionsDir>/operator-sessions.jsonl` — the one record (docs/storage.md). */
export function operatorSessionsFile(sessionsDir: string): string {
	return join(sessionsDir, OPERATOR_SESSIONS_FILE);
}

/** Recorded files, newest first, one row per file. A malformed line is skipped. */
export function readOperatorSessions(sessionsDir: string): OperatorSession[] {
	let text: string;
	try {
		text = readFileSync(operatorSessionsFile(sessionsDir), "utf8");
	} catch {
		return [];
	}
	const byFile = new Map<string, OperatorSession>();
	for (const line of text.split("\n")) {
		const row = parseLine(line);
		if (row) byFile.set(row.file, row);
	}
	return [...byFile.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** A trusted record's own line, or nothing: only an absolute `.jsonl` path code wrote is served. */
function parseLine(line: string): OperatorSession | undefined {
	if (!line.trim()) return undefined;
	try {
		const value = JSON.parse(line) as { at?: unknown; session_file?: unknown } | null;
		const file = value?.session_file;
		if (typeof value?.at !== "string" || typeof file !== "string" || !file.startsWith("/") || !file.endsWith(".jsonl")) return undefined;
		return { id: basename(file), file, at: value.at };
	} catch {
		return undefined;
	}
}
