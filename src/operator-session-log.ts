/**
 * The cp-bridge's half of the operator session record
 * (cp-sessions-operator-transcript-9giu): `cp_parent start` and `cp_parent send`
 * append the operator session's own `PI_SESSION_FILE` so the read-only viewer
 * can list it. The format and the read path live in
 * `src/viewer/operator-sessions.ts` — the viewer's rule keeps every module
 * there write-free, so the writer is here and imports it.
 *
 * Append-only, one line per newly-seen file, best-effort: a record that cannot
 * be written must never fail a `cp_parent` call.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { operatorSessionsFile, readOperatorSessions } from "./viewer/operator-sessions.ts";

/** Append `sessionFile` unless it is already the newest entry. Never throws. */
export function recordOperatorSession(sessionsDir: string, sessionFile: string | undefined, now = new Date()): void {
	if (!sessionFile?.startsWith("/") || !sessionFile.endsWith(".jsonl")) return;
	try {
		if (readOperatorSessions(sessionsDir)[0]?.file === sessionFile) return;
		mkdirSync(sessionsDir, { recursive: true });
		appendFileSync(operatorSessionsFile(sessionsDir), `${JSON.stringify({ at: now.toISOString(), session_file: sessionFile })}\n`);
	} catch {
		// Best-effort durability: a record write must never take the bridge down with it.
	}
}
