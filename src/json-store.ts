/**
 * Shared write discipline for the parent's state files — the JSON documents
 * (`state/fleet.json`, `data/projects.json`, …) and the markdown memory files
 * under `data/` (`learnings.md`, `candidates.md`, `archive.md`), which are
 * whole-file rewrites for exactly the same reason and lose exactly as much
 * when one tears (cp-nqj).
 *
 * Three guarantees, and nothing else in this file:
 *
 *  - **Atomic on disk.** `write tmp -> fsync -> rename`. A reader never sees a
 *    half-written file, and a crash mid-write leaves the previous version.
 *    `writeFileSync` cannot offer this: it opens `O_TRUNC`, so the target is
 *    zero bytes between the open and the write, and a process killed in that
 *    window leaves nothing at all.
 *  - **Appends stay appends.** `durableAppend` is `O_APPEND` + `fsync`: the
 *    kernel keeps concurrent appenders from clobbering each other, which a
 *    read-modify-write cannot do at any level of atomicity (measured: 4
 *    processes × 400 appends land 1600 lines through `O_APPEND` and 424
 *    through read-modify-write). Durability without giving that up.
 *  - **Serialized in process.** Read-modify-write runs inside pi's per-path
 *    mutation queue, so our writes also queue behind the parent's own `edit`
 *    and `write` tools instead of racing them.
 *
 * Validation is the caller's job and happens *before* the rename: an invalid
 * document is an exception, never a file.
 */

import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** `mode`: the file's permission bits regardless of umask; `syncDir`: fsync the directory after the rename. */
export interface AtomicWriteOptions {
	mode?: number;
	syncDir?: boolean;
}

export function atomicWriteJson(file: string, value: unknown, options?: AtomicWriteOptions): void {
	atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * A per-call temp name. Two writers sharing one `<file>.tmp` would truncate
 * each other's staging file and could rename a mixture of both into place —
 * the very tear the rename exists to prevent, moved one path along.
 */
let tmpCounter = 0;

export function atomicWriteText(file: string, text: string, options?: AtomicWriteOptions): void {
	mkdirSync(dirname(file), { recursive: true });
	tmpCounter = (tmpCounter + 1) % Number.MAX_SAFE_INTEGER;
	const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
	try {
		const buffer = Buffer.from(text, "utf8");
		const fd = options?.mode === undefined ? openSync(tmp, "w") : openSync(tmp, "w", options.mode);
		try {
			// The create mode is masked by umask; fchmod states it exactly.
			if (options?.mode !== undefined) fchmodSync(fd, options.mode);
			// Loop: a short write on the staging file would rename in a truncated
			// document, which is precisely what this function exists to prevent. Safe
			// to loop because nothing else ever writes to this per-call temp name.
			let written = 0;
			while (written < buffer.length) {
				written += writeSync(fd, buffer, written, buffer.length - written);
			}
			// Durability before visibility: a half-written file must never be renamed in.
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		// The target was never opened, so it is untouched. Leave no staging litter.
		rmSync(tmp, { force: true });
		throw error;
	}
	renameSync(tmp, file);
	if (options?.syncDir) {
		// The rename itself is durable only once the directory entry is flushed.
		const dir = openSync(dirname(file), "r");
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	}
}

/**
 * Append `text` to `file` and flush it, without ever opening the file for
 * truncation. `O_APPEND` makes the write atomic against other appenders at the
 * kernel, so this is the only mechanism that is safe for a file two processes
 * may add to at once — and the only one an append-only contract can be held to.
 */
export function durableAppend(file: string, text: string, options?: { mode?: number }): void {
	mkdirSync(dirname(file), { recursive: true });
	const buffer = Buffer.from(text, "utf8");
	const fd = openSync(file, "a", options?.mode ?? 0o666);
	try {
		// Exactly one write, deliberately: `O_APPEND` is atomic per call, so a
		// second call to finish a short write could land after another process's
		// record and interleave the two. A short write (ENOSPC, a signal) is
		// therefore reported rather than papered over.
		const written = writeSync(fd, buffer, 0, buffer.length);
		if (written !== buffer.length) {
			throw new Error(`short append to ${file}: wrote ${written} of ${buffer.length} bytes (out of space?)`);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Run `fn` with exclusive access to `file` within this process. */
export function queued<T>(file: string, fn: () => Promise<T>): Promise<T> {
	return withFileMutationQueue(file, fn);
}

/**
 * Canonicalize a directory once, at construction time. pi's mutation queue is
 * keyed by real path, so a home reached through a symlink (`/var` ->
 * `/private/var` on macOS) would otherwise get two queues for one file — which
 * is exactly the race the queue exists to prevent.
 */
export function canonicalDir(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// It does not exist yet; the literal path is the best identity we have.
		return path;
	}
}
