/**
 * cp-y43c, the dashboard queue as `state/operator/dashboard.jsonl` records it. While the operator session is busy a
 * composer message is not handed to pi: the bridge (src/dashboard-control.ts) journals `outcome queued` and owns the
 * message until the session settles, one per settled turn, oldest first. Per id the lines run
 * `request → queued → edited* → injected → delivered | failed | dropped`, or `… → cancelled`. `injected` is the
 * handoff, appended before pi is given the text, so a restarted bridge never hands the same id over twice.
 *
 * A message is held by the dashboard (editable, cancellable) exactly while its latest outcome is a `queued` that no
 * `injected` preceded. Its text is the request's, replaced by each `edited` line in journal order. Read-only.
 */
import { readFileSync, statSync } from "node:fs";
import { controlJournalFile, DASHBOARD_ID_RE } from "./control-files.ts";

export interface QueuedMessage {
	id: string;
	at: string;
	peer: string | null;
	text: string;
	deliver: string;
	images?: string[];
	files?: string[];
	thread?: string;
	/** The latest outcome, or `requested` before the first one. */
	state: string;
	/** True once a handoff (`injected`) line exists: never queued, edited or handed over again. */
	injected: boolean;
	edits: number;
}

/** Whether the dashboard still holds `entry`: queued, never handed to pi. */
export const dashboardHeld = (entry: QueuedMessage): boolean => entry.state === "queued" && !entry.injected;

const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

/** Every composer message the journal names, in request order; `error` names an unreadable file (never silently empty). */
export function readQueueJournal(stateDir: string): { messages: Map<string, QueuedMessage>; error: string | null } {
	const messages = new Map<string, QueuedMessage>();
	const file = controlJournalFile(stateDir);
	let text: string;
	try {
		if (statSync(file).size > 16 * 1024 * 1024) return { messages, error: `${file}: over the 16 MiB read cap` };
		text = readFileSync(file, "utf8");
	} catch (error) {
		return { messages, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : `${file}: ${(error as Error).message}` };
	}
	const lines = text.split("\n");
	lines.pop(); // a torn final line waits for its newline
	for (const row of lines) {
		let line: Record<string, unknown>;
		try { line = JSON.parse(row) as Record<string, unknown>; } catch { continue; }
		if (!line || typeof line.id !== "string" || !DASHBOARD_ID_RE.test(line.id)) continue;
		if (line.type === "request") {
			if (line.kind !== "message" || messages.has(line.id) || typeof line.at !== "string") continue;
			const images = strings(line.images), files = strings(line.files);
			messages.set(line.id, {
				id: line.id, at: line.at, peer: typeof line.peer === "string" ? line.peer : null, text: typeof line.text === "string" ? line.text : "",
				deliver: typeof line.deliver === "string" ? line.deliver : "prompt", ...(images ? { images } : {}), ...(files ? { files } : {}),
				...(typeof line.thread === "string" ? { thread: line.thread } : {}), state: "requested", injected: false, edits: 0,
			});
			continue;
		}
		const message = messages.get(line.id);
		if (!message) continue;
		if (line.type === "edited" && typeof line.text === "string") {
			// Only the bridge writes these, and only while it holds the message; anything later is ignored, not applied.
			if (dashboardHeld(message)) { message.text = line.text; message.edits += 1; }
		} else if (line.type === "outcome" && typeof line.state === "string") {
			message.state = line.state;
			if (line.state === "injected") message.injected = true;
		}
	}
	return { messages, error: null };
}
