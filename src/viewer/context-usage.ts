/**
 * Context-window usage for a pi session, the number pi's footer shows: tokens
 * currently in context against the model's window — never cumulative spend.
 *
 * Tokens follow pi's own calculation (@earendil-works/pi-coding-agent
 * `dist/core/compaction/compaction.js` `calculateContextTokens`: `totalTokens`,
 * else input + output + cacheRead + cacheWrite) on the last assistant message
 * that is not aborted, not an error and not all-zero; `AgentSession.getContextUsage`
 * (`dist/core/agent-session.js`) reports unknown when a compaction came after
 * that message, and so does this.
 *
 * The window comes from pi's model registry. The viewer may not import pi, so the
 * parent records `provider/id → contextWindow` from its `ctx.modelRegistry` at
 * session start (`src/model-windows.ts`) and this reads that snapshot.
 *
 * Unknown is `tokens` or `window` null with a `reason`, never 0.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import type { ContextUsage } from "./api-types.ts";
import { fileCache } from "./file-cache.ts";
import { parseObject, timestamp } from "./overview-read.ts";
import { readOperatorSessions } from "./operator-sessions.ts";
import { num, obj, readObject, resolveSessionFile, sessionRoots, str, type SessionRow, type ViewerState } from "./sessions.ts";
import { readLines, startOffset } from "./tail.ts";

export const MODEL_WINDOWS_FILE = "model-windows.json";
/** How much of a session's tail is scanned for its last assistant message. */
export const SCAN_BYTES = 1024 * 1024;
export const WARN_PERCENT = 70;
export const HIGH_PERCENT = 90;

export const contextLevel = (percent: number): NonNullable<ContextUsage["level"]> =>
	percent >= HIGH_PERCENT ? "high" : percent >= WARN_PERCENT ? "warn" : "ok";

/**
 * `<state>/model-windows.json`: `{recorded_at, windows: {"provider/id": tokens}}`. Not under
 * `sessions/`: that directory is a worker session's, and a preview must not create it.
 */
export function modelWindows(stateDir: string): Map<string, number> | undefined {
	const windows = obj(readObject(join(stateDir, MODEL_WINDOWS_FILE))?.windows);
	if (!windows) return undefined;
	return new Map(Object.entries(windows).flatMap(([model, value]) => { const n = num(value); return n && n > 0 ? [[model, n] as const] : []; }));
}

export interface SessionScan { tokens: number | null; model: string | null; thinking: string | null; last_compact_at: string | null; reason: string | null }

/** How much of a long session's head is read for the model/thinking changes pi records at session start. */
export const HEAD_BYTES = 64 * 1024;

type Head = { model: string | null; thinking: string | null };

/** The latest model_change / thinking_level_change in the file's first HEAD_BYTES. */
function readHead(file: string): Head {
	let model: string | null = null, thinking: string | null = null;
	for (const line of readLines(file, 0, HEAD_BYTES).lines) {
		const record = parseObject(line.text);
		if (record?.type === "model_change" && str(record.provider) && str(record.modelId)) model = `${record.provider}/${record.modelId}`;
		else if (record?.type === "thinking_level_change") thinking = str(record.thinkingLevel) ?? thinking;
	}
	return { model, thinking };
}

const heads = new Map<string, { id: string; size: number; head: Head }>();

/**
 * The head, kept across append-only growth: a session that only grows past HEAD_BYTES leaves its head window
 * untouched, so a poll after an append (which changes fileCache's identity) does not re-read it. A shrink or a
 * replaced file (new inode/birthtime) reads again.
 * ponytail: an in-place rewrite that regrows past the old size between two polls is not seen; pi appends.
 */
function scanHead(file: string): Head {
	const st = statSync(file), id = `${st.dev}:${st.ino}:${st.birthtimeMs}`, prior = heads.get(file);
	if (prior && prior.id === id && prior.size >= HEAD_BYTES && st.size >= prior.size) { prior.size = st.size; return prior.head; }
	const head = readHead(file);
	heads.delete(file); heads.set(file, { id, size: st.size, head });
	if (heads.size > 256) heads.delete(heads.keys().next().value!);
	return head;
}
// fileCache serves an unchanged file without even a stat-and-compare of the memo.
const cachedHead = fileCache(scanHead, () => 256);

function scan(file: string): SessionScan {
	const start = startOffset(file, undefined, SCAN_BYTES);
	let thinking: string | null = null, anyAssistantModel: string | null = null;
	let tokens: number | null = null, model: string | null = null, compactAt: string | null = null, compactedSince = false;
	for (const line of readLines(file, start.offset, SCAN_BYTES).lines) {
		const record = parseObject(line.text);
		if (!record) continue;
		if (record.type === "compaction") { compactAt = timestamp(record.timestamp) ? record.timestamp : compactAt; compactedSince = true; continue; }
		if (record.type === "model_change" && str(record.provider) && str(record.modelId)) { model = `${record.provider}/${record.modelId}`; continue; }
		if (record.type === "thinking_level_change") { thinking = str(record.thinkingLevel) ?? thinking; continue; }
		const message = obj(record.message);
		if (record.type === "message" && message?.role === "assistant" && str(message.provider) && str(message.model)) anyAssistantModel = `${message.provider}/${message.model}`;
		if (record.type !== "message" || message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = obj(message.usage);
		const total = usage ? num(usage.totalTokens) || (num(usage.input) ?? 0) + (num(usage.output) ?? 0) + (num(usage.cacheRead) ?? 0) + (num(usage.cacheWrite) ?? 0) : 0;
		if (total <= 0) continue;
		tokens = total; compactedSince = false;
		if (str(message.provider) && str(message.model)) model = `${message.provider}/${message.model}`;
	}
	// A session past SCAN_BYTES: pi's changes usually sit at its head, out of the tail. The tail wins; the head only fills what it lacks.
	if (start.offset > 0 && (thinking === null || (model === null && anyAssistantModel === null))) {
		const head = cachedHead(file);
		thinking ??= head.thinking; if (model === null && anyAssistantModel === null) model = head.model;
	}
	// ponytail: the tail's last line is taken as pi's current branch; a /tree jump back reads the newer branch until its next reply.
	const reason = compactedSince ? "no assistant reply since the last compaction" : tokens === null ? start.offset > 0 ? "no assistant reply in the session's last 1 MiB" : "no assistant reply yet" : null;
	return { tokens: compactedSince ? null : tokens, model: model ?? anyAssistantModel, thinking, last_compact_at: compactAt, reason };
}

const cachedScan = fileCache(scan, () => 256);

/** The session file's own reading; a file that is missing or unreadable names it. */
export function scanSession(file: string): SessionScan {
	try {
		return cachedScan(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { tokens: null, model: null, thinking: null, last_compact_at: null, reason: code === "ENOENT" ? "session file missing" : "session file unreadable" };
	}
}

/** Tokens against the window, or the first reason either is unknown. */
export function contextUsage(scan: SessionScan, fallbackModel: string | null | undefined, windows: Map<string, number> | undefined): ContextUsage {
	const model = scan.model ?? fallbackModel ?? null;
	const window = model ? windows?.get(model) ?? null : null;
	const reason = scan.tokens === null ? scan.reason ?? "no assistant reply yet"
		: !model ? "model not recorded"
		: !windows ? "model windows not recorded yet (the parent records pi's registry at session start)"
		: window === null ? `no context window known for ${model}` : null;
	const percent = scan.tokens !== null && window !== null ? (scan.tokens / window) * 100 : null;
	return { tokens: scan.tokens, window, percent, level: percent === null ? null : contextLevel(percent), reason, model, thinking: scan.thinking, last_compact_at: scan.last_compact_at };
}

const windowsFor = (state: ViewerState) => modelWindows(state.stateDir);

/** A job's live or last worker, or null when it has no recorded worker session. */
export function workerContext(state: ViewerState, id: string, model?: string | null, windows = windowsFor(state)): ContextUsage | null {
	const file = resolveSessionFile(state, id);
	return file ? contextUsage(scanSession(file), model, windows) : null;
}

/**
 * The parent: pi's own `contextUsage.tokens` as `get_session_stats` last recorded it
 * (`cp-parent-context.json`, src/parent-context.ts) when there is a number, else its
 * session file read like a worker's. The model is the transcript's, else the bridge's.
 */
export function parentContext(state: ViewerState, parent: SessionRow, windows = windowsFor(state)): ContextUsage {
	const file = resolveSessionFile(state, parent.id);
	const read = file ? scanSession(file) : { tokens: null, model: null, thinking: null, last_compact_at: null, reason: "parent session file not recorded" };
	const control = str(readObject(join(state.stateDir, "sessions", "cp-parent-control.json"))?.model);
	const recorded = num(parent.context_tokens);
	const scan = recorded !== undefined && recorded > 0 ? { ...read, tokens: recorded, reason: null } : read;
	return contextUsage({ ...scan, last_compact_at: parent.last_compact_at ?? scan.last_compact_at }, control, windows);
}

/** The operator session: its newest recorded pi file (`operator-sessions.jsonl`). */
export function operatorContext(state: ViewerState, windows = windowsFor(state)): ContextUsage {
	const file = readOperatorSessions(sessionRoots(state)[0]!)[0]?.file;
	return contextUsage(file ? scanSession(file) : { tokens: null, model: null, thinking: null, last_compact_at: null, reason: "no operator session recorded yet" }, null, windows);
}
