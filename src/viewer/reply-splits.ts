/** The header guard's sidecar (issue 589): `state/operator/reply-splits.jsonl`, read by the operator transcript. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "./api-types.ts";
import type { ReplySegment } from "./reply-split.ts";

/**
 * One guard outcome for an assistant text block, keyed by its `message.timestamp` and content index:
 * `split` auto-tags a reply re-sent still without headers, `superseded` folds the reply a re-send replaced,
 * `hidden` folds the `NO-PROJECT` answer.
 */
export interface ReplySplitRecord {
	type: "split" | "superseded" | "hidden";
	session_file: string;
	ts: number;
	block: number;
	segments?: ReplySegment[];
}

export const replySplitsFile = (stateDir: string): string => join(stateDir, "operator", "reply-splits.jsonl");
export const replyKey = (ts: unknown, block: number): string => `${String(ts)}:${block}`;

const TAIL_BYTES = 4 * 1024 * 1024;

/** The last `TAIL_BYTES` of the file from a line start. Never rotated: records older than the tail read as none. */
function readTail(file: string): string {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES), buf = Buffer.alloc(size - start);
		const text = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, start));
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text; // a cut first line is dropped
	} finally { closeSync(fd); }
}

/** A `split` record must carry segments with a `projects` array; the other types carry nothing more. */
const wellFormed = (r: ReplySplitRecord): boolean =>
	["split", "superseded", "hidden"].includes(r.type) &&
	(r.type !== "split" || (Array.isArray(r.segments) && r.segments.every((s) => Array.isArray(s?.projects) && typeof s.text === "string")));

/** The records for one session file, by key; the last record for a key wins. Missing or torn lines read as none. */
export function readReplySplits(stateDir: string, sessionFile: string): Map<string, ReplySplitRecord> {
	let raw = "";
	try { raw = readTail(replySplitsFile(stateDir)); } catch { return new Map(); }
	const out = new Map<string, ReplySplitRecord>();
	for (const line of raw.split("\n")) {
		let record: ReplySplitRecord | undefined;
		try { record = JSON.parse(line) as ReplySplitRecord; } catch { continue; }
		if (record?.session_file === sessionFile && typeof record.ts === "number" && Number.isInteger(record.block) && wellFormed(record)) out.set(replyKey(record.ts, record.block), record);
	}
	return out;
}

/** A `split` record replaces the read-time split; `superseded`/`hidden` fold the entry behind its original. */
export function applyReplySplits(entries: SessionEntry[], keys: Map<SessionEntry, string>, records: Map<string, ReplySplitRecord>): void {
	if (records.size === 0) return;
	for (const e of entries) {
		const key = keys.get(e), record = key === undefined ? undefined : records.get(key);
		if (!record) continue;
		if (record.type !== "split") { e.collapsed = record.type; continue; }
		const segments = Array.isArray(record.segments) ? record.segments : [];
		if (segments.length > 1) { e.segments = segments; e.project = null; continue; }
		delete e.segments;
		e.project = segments[0]?.projects.join(", ") || null;
	}
}
