/**
 * Full match S9, threads on dashboard sends (owner side): a send's explicit `thread_id` is checked against the registry
 * before its request line, and once the owner sees the entry it delivered, that one entry is bound (one line per send).
 * Replies are members by turn at read time (src/viewer/named-threads-view.ts); nothing here parses user prose.
 */

import { bindThread } from "./operator-named-threads.ts";

/** The pi session entry pi persisted for exactly this message object (identity, never text), with its session id. */
export function entryOfMessage(sessionManager: { getEntries(): unknown[]; getSessionId(): string } | undefined, message: unknown): { id: string; session_id: string } | undefined {
	const entry = sessionManager?.getEntries().findLast((row) => (row as { message?: unknown }).message === message) as { id?: unknown } | undefined;
	return entry && typeof entry.id === "string" ? { id: entry.id, session_id: sessionManager!.getSessionId() } : undefined;
}

/**
 * Binds observed entries the owner delivered: `expect` is called only from the owner's own delivery record (once per
 * dc id); `flush` binds those pi has persisted since, so it runs on every later observation and when a turn settles.
 */
export function threadBinder(stateDir: string, entryOf: ((message: unknown) => { id: string; session_id: string } | undefined) | undefined, now: () => Date, log: (line: string) => void) {
	const waiting: { id: string; threadId: string; message: unknown }[] = [];
	const flush = (final: boolean): void => {
		for (const item of [...waiting]) {
			const entry = entryOf?.(item.message);
			if (!entry && !final) continue;
			waiting.splice(waiting.indexOf(item), 1);
			const bound = entry ? bindThread(stateDir, { kind: "message", id: entry.id, session_id: entry.session_id }, item.threadId, now()) : undefined;
			if (!bound?.ok) log(`cp-bridge: thread ${item.threadId} not bound to ${item.id}: ${bound ? bound.error : "its session entry was not found"}\n`);
		}
	};
	return {
		expect(id: string, threadId: string, message: unknown): void { waiting.push({ id, threadId, message }); },
		flush,
	};
}
