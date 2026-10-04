/**
 * `cp-parent-control.json` (N9): the parent session file the bridge reopens on
 * start. A saved path whose file is gone is never passed to `--session` (that
 * would open a fresh session under a dangling name); and a spawn whose
 * `getState` reports a different file records that file, so the next start
 * reopens the session that actually holds the transcript. Session jsonl is
 * never deleted or rewritten here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";

export function parentControlFile(home: string): string {
	return join(home, LAYOUT.sessions, "cp-parent-control.json");
}

/** The saved session path when its file exists; otherwise undefined, with one parent-host.log line naming it. */
export function existingSavedSession(saved: string | undefined, log: (line: string) => void = console.error): string | undefined {
	if (saved === undefined || existsSync(saved)) return saved;
	log(`parent host ${process.pid}: saved parent session ${saved} is missing; not reopening it`);
	return undefined;
}

/** After `getState`: a reported session file other than the spawned one becomes the control record. Never throws into the spawn. */
export function recordSpawnedSession(home: string, spawned: string, reported: unknown, model: string | undefined, log: (line: string) => void = console.error): void {
	if (typeof reported !== "string" || reported.length === 0 || reported === spawned) return;
	try {
		atomicWriteJson(parentControlFile(home), { sessionFile: reported, model });
	} catch (error) {
		log(`parent host ${process.pid}: parent control write failed for ${reported}: ${(error as Error).message}`);
	}
}
