/**
 * Byte-offset tailing of a jsonl session file (cp-live-session-viewer).
 *
 * Every complete line is identified by the byte offset just past its newline.
 * That offset is the SSE event id, so a reconnect that sends `Last-Event-ID`
 * resumes exactly after the last line it received: nothing missed, nothing
 * repeated. A partial last line (the writer is mid-append) stays unread until
 * its newline lands.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface TailLine {
	/** Byte offset just past this line's newline — the resume point after it. */
	id: number;
	text: string;
}

export interface TailChunk {
	lines: TailLine[];
	/** Where the next read starts. */
	offset: number;
	/** The file shrank below the offset (truncated or replaced); reading restarted at 0. */
	reset: boolean;
}

/** One read's ceiling; the next poll picks up the rest. */
export const MAX_READ_BYTES = 16 * 1024 * 1024;

/** How much history a fresh connection gets before it starts following. */
export const BACKLOG_BYTES = 4 * 1024 * 1024;

function withFile<T>(file: string, fallback: T, fn: (fd: number, size: number) => T): T {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return fallback;
	}
	try {
		return fn(fd, fstatSync(fd).size);
	} finally {
		closeSync(fd);
	}
}

/** Complete lines from `offset`. A missing file reads as nothing yet. */
export function readLines(file: string, offset: number, maxBytes = MAX_READ_BYTES): TailChunk {
	return withFile(file, { lines: [], offset, reset: false }, (fd, size) => {
		let start = offset;
		let reset = false;
		if (start > size) {
			start = 0;
			reset = true;
		}
		const length = Math.min(size - start, maxBytes);
		const lines: TailLine[] = [];
		if (length <= 0) return { lines, offset: start, reset };
		const buf = Buffer.alloc(length);
		const read = readSync(fd, buf, 0, length, start);
		let lineStart = 0;
		for (let i = 0; i < read; i++) {
			if (buf[i] !== 0x0a) continue;
			const text = buf.subarray(lineStart, i).toString("utf8");
			if (text.trim().length > 0) lines.push({ id: start + i + 1, text });
			lineStart = i + 1;
		}
		// ponytail: a single line longer than maxBytes is emitted as-is (it renders as
		// unparseable) rather than stalling the tail forever; raise MAX_READ_BYTES if it happens.
		if (lineStart === 0 && read === maxBytes) {
			lines.push({ id: start + read, text: buf.toString("utf8") });
			lineStart = read;
		}
		return { lines, offset: start + lineStart, reset };
	});
}

/**
 * Where a stream starts. A `Last-Event-ID` that is a line boundary inside the
 * file resumes there; anything else (absent, garbage, past the end, mid-line)
 * starts a fresh connection at the last `backlog` bytes, aligned to a line.
 *
 * `reset` is true when a supplied id was rejected (the file was rotated,
 * replaced or truncated under the client): what it already shows no longer
 * matches, so it must clear before the backlog arrives or entries duplicate.
 */
export function startOffset(
	file: string,
	lastEventId: string | undefined,
	backlog = BACKLOG_BYTES,
): { offset: number; reset: boolean } {
	const supplied = lastEventId !== undefined && lastEventId.trim().length > 0;
	return withFile(file, { offset: 0, reset: supplied }, (fd, size) => {
		if (supplied && /^\d{1,15}$/.test(lastEventId.trim())) {
			const id = Number(lastEventId.trim());
			if (id === 0) return { offset: 0, reset: false };
			if (id <= size) {
				const byte = Buffer.alloc(1);
				readSync(fd, byte, 0, 1, id - 1);
				if (byte[0] === 0x0a) return { offset: id, reset: false };
			}
		}
		if (size <= backlog) return { offset: 0, reset: supplied };
		const from = size - backlog;
		const buf = Buffer.alloc(backlog);
		const read = readSync(fd, buf, 0, backlog, from);
		const newline = buf.subarray(0, read).indexOf(0x0a);
		return { offset: newline === -1 ? size : from + newline + 1, reset: supplied };
	});
}
