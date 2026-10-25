/**
 * `cp-parent-control.json` (N9): the parent session file the bridge reopens on
 * start. A saved path whose file is gone is never passed to `--session` (that
 * would open a fresh session under a dangling name); and a spawn whose
 * `getState` reports an existing file records that file — the spawned path
 * included — so the next start reopens the session that actually holds the
 * transcript. Session jsonl is never deleted or rewritten here.
 */
import { existsSync, readFileSync } from "node:fs";
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

/** After `getState`: the reported session file, when it exists, becomes the control record — the spawned path too, which repairs a dangling saved one. A saved model is kept; a missing file is logged and the old record kept. Never throws into the spawn. */
export function recordSpawnedSession(home: string, reported: unknown, model: string | undefined, log: (line: string) => void = console.error): void {
	if (typeof reported !== "string" || reported.length === 0) return;
	if (!existsSync(reported)) {
		log(`parent host ${process.pid}: reported parent session ${reported} is not on disk; keeping the saved control record`);
		return;
	}
	const file = parentControlFile(home);
	// The path repair keeps a saved model: start precedence treats it as the operator's choice
	// (tests/e2e/cp-bridge-p9h.test.ts).
	let saved: unknown;
	if (existsSync(file)) {
		try { saved = (JSON.parse(readFileSync(file, "utf8")) as { model?: unknown }).model; }
		catch (error) { log(`parent host ${process.pid}: parent control ${file} unreadable (${(error as Error).message}); rewriting it for ${reported}`); }
	}
	try {
		atomicWriteJson(file, { sessionFile: reported, model: typeof saved === "string" ? saved : model });
	} catch (error) {
		log(`parent host ${process.pid}: parent control write failed for ${reported}: ${(error as Error).message}`);
	}
}
