/**
 * The status block's Shipped memory (cp-b5eg).
 *
 * ## The defect
 *
 * AGENTS.md §Status block says Shipped is "capped to what is new since the
 * block you last rendered this session; a job already shown collapses to a
 * one-line count instead of repeating its row". `renderShipped` implements
 * that correctly and always did — it takes the already-shown set as an
 * argument and is pure.
 *
 * What was wrong is where that set lived. It was one `let shownShipped =
 * new Set<string>()` in the extension's activation closure, reset in the
 * `session_start` handler. `session_start` does not mean "a new session": pi
 * fires it with `reason: "startup" | "reload" | "new" | "resume" | "fork"`, and
 * a `/reload` (or anything else that rebinds extensions) emits
 * `session_shutdown` for the old extension instance and `session_start` for the
 * new one **inside the same session, with the same conversation and the same
 * session id**. The variable went with the old instance.
 *
 * That last clause is checked, not assumed: pi's `AgentSession.reload()`
 * (`dist/core/agent-session.js`) emits `session_shutdown { reason: "reload" }`,
 * invalidates the extension runner, rebuilds the *extension* runtime and emits
 * `session_start { reason: "reload" }` — it never touches `this.sessionManager`,
 * which is assigned exactly once, in the constructor. `getSessionId()` is
 * therefore identical across a reload while every closure variable is gone,
 * which is the whole asymmetry this module absorbs.
 *
 * That produces exactly the observed signature: one status block replays the
 * whole session's shipped history (~80 rows), and the block before it and the
 * block after it both collapse correctly — because the render that replayed
 * also refilled the set. It is intermittent because reloads are, and it looked
 * unrelated to the render's own inputs (labels, awaiting rows) because it is:
 * those never touched this state.
 *
 * ## The fix
 *
 * The set is persisted, keyed by pi's own session id, and read from disk on
 * every render. A new extension instance in the same session sees what the
 * previous one reported; a genuinely new session (new id) starts empty, which
 * is the contract. Nothing here truncates the Shipped section — a cap on the
 * output would have hidden the replay instead of fixing it.
 *
 * ## Discipline
 *
 * - Read is best-effort and never throws: an unreadable file degrades to "this
 *   process's own memory", not to an exception in the middle of the parent's
 *   only report.
 * - The in-memory mirror is a floor, never the source: the union of disk and
 *   mirror is what a render sees, so a failed *write* cannot un-report a row
 *   this process already printed.
 * - A failed write is reported to the caller so the operator sees a warning,
 *   because a silently lost memory is the bug this module exists to end.
 * - Recorded ids are the *candidates* the render saw, not just the fresh ones
 *   (`StatusBlockResult.shippedIds` already has that meaning).
 * - An unreadable file is **rebuilt**, not endured. A corrupt document used to
 *   fail the read *and* the read-modify-write behind it, degrading the memory
 *   permanently with no remediation named; now the write starts from empty and
 *   says so, and every degradation names the file and that deleting it is safe.
 *
 * ## Concurrency
 *
 * This is a read-modify-write on one JSON file with **no lock**, and that is a
 * deliberate, bounded choice rather than an oversight:
 *
 * - The file is only ever written by `cp_status_block`, i.e. by an attached
 *   parent taking a turn. Workers never touch it, and no timer does.
 * - The write itself is `atomicWriteJson` (write temp → fsync → rename) — the
 *   same mechanism cp-nqj (PR #86) established in `src/json-store.ts` for every
 *   whole-file write in this home, for the same reason: `writeFileSync` opens
 *   `O_TRUNC`, so the target is zero bytes between the open and the write and a
 *   kill in that window destroys it. A structural test keeps this store on that
 *   path. `durableAppend` is the wrong half of that precedent here: this is one
 *   document that is rewritten, not a log that is added to. Because the rename
 *   is atomic, a reader never sees a torn document however many writers there
 *   are: two parents on one home cannot corrupt the file, only interleave.
 * - What an interleaving can lose is one *entry*: if A and B both read, then
 *   both write, the later write carries A's or B's view of the other sessions.
 *   Each session writes only its own entry and copies the rest, so the loss is
 *   at most another session's memory, and its cost is one repeated Shipped
 *   section in that other session — never a wrong row, never a lost PR url.
 * - Sequential writers (the common case: one parent, and a reload replacing it)
 *   never lose anything, because each re-reads before it writes. A test pins
 *   that a second store writing a *different* session id keeps the first
 *   session's entry.
 *
 * A lock would buy strictly less than it costs here: the failure it prevents is
 * a duplicated section, and the failure it introduces (a stale lock file
 * blocking the parent's only report) is worse.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	EMPTY_SHIPPED_SEEN_FILE,
	isoTimestamp,
	LAYOUT,
	SCHEMA_VERSION,
	SHIPPED_SEEN_KEEP_SESSIONS,
	SHIPPED_SEEN_MAX_IDS,
	type ShippedSeenFile,
	type ShippedSeenSession,
	type StatusSnapshot,
	validateShippedSeenFile,
} from "./contracts.ts";
import { atomicWriteJson, canonicalDir } from "./json-store.ts";
import { assembleStatusBlock, type StatusBlockInput, type StatusBlockResult } from "./status-block.ts";

/** What a render is told about the memory it just used. */
export interface ShippedSeenRead {
	/** job ids already reported under Shipped in this session. */
	ids: ReadonlySet<string>;
	/** Set when the store could not be read; the render proceeds regardless. */
	error?: string;
}

export interface ShippedSeenWrite {
	persisted: boolean;
	error?: string;
	/**
	 * Set when an unreadable file was rebuilt from scratch by this write. A
	 * corrupt memory is a degraded memory, never a permanently degraded one: the
	 * cost is that other sessions' entries in the unreadable file are gone, which
	 * is one replayed section each, and the operator is told so.
	 */
	healed?: string;
}

/**
 * The remediation, named wherever the memory degrades. It is safe advice: this
 * file holds only "which rows have already been printed this session", so the
 * worst consequence of deleting it is one Shipped section that repeats itself.
 */
export function shippedSeenRemedy(file: string): string {
	return `${file} is safe to delete (it only records which Shipped rows have already been printed; deleting it repeats one section at most)`;
}

export class ShippedSeenStore {
	readonly home: string;
	readonly file: string;
	readonly #now: () => Date;
	/**
	 * Per-session floor for this process. Never authoritative on its own: it is
	 * unioned with disk so a write that failed cannot make an already-printed row
	 * look new to the very next render in the same process.
	 */
	readonly #mirror = new Map<string, Set<string>>();

	constructor(options: { home: string; now?: () => Date }) {
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.shippedSeenFile);
		this.#now = options.now ?? (() => new Date());
	}

	read(): ShippedSeenFile {
		if (!existsSync(this.file)) return EMPTY_SHIPPED_SEEN_FILE;
		const result = validateShippedSeenFile(JSON.parse(readFileSync(this.file, "utf8")));
		if (!result.ok) throw new Error(`invalid ${this.file}: ${result.errors.join("; ")}`);
		return result.value;
	}

	/** What this session has already reported. Never throws. */
	shown(sessionId: string): ShippedSeenRead {
		const mirrored = this.#mirror.get(sessionId) ?? new Set<string>();
		try {
			const stored = this.read().sessions.find((session) => session.session_id === sessionId);
			return { ids: new Set([...mirrored, ...(stored?.shipped_ids ?? [])]) };
		} catch (error) {
			// A corrupt or unreadable memory must not take the status block down with
			// it: the worst case is one replayed section, and the operator is told —
			// with the file named and the remediation stated, because "unreadable" on
			// its own is a fact nobody can act on.
			return { ids: new Set(mirrored), error: `${(error as Error).message}; ${shippedSeenRemedy(this.file)}` };
		}
	}

	/** Fold `ids` into this session's memory. Never throws. */
	record(sessionId: string, ids: readonly string[]): ShippedSeenWrite {
		const mirror = this.#mirror.get(sessionId) ?? new Set<string>();
		for (const id of ids) mirror.add(id);
		this.#mirror.set(sessionId, mirror);
		// A read that throws must not make the *write* impossible too: that is how a
		// single corrupt file turned into a permanently degraded memory, replaying a
		// section on every render for the rest of the home's life with nothing said
		// about how to fix it. An unreadable file is rebuilt here, once, and the
		// rebuild is announced.
		let current: ShippedSeenFile;
		let healed: string | undefined;
		try {
			current = this.read();
		} catch (error) {
			current = EMPTY_SHIPPED_SEEN_FILE;
			healed = `rebuilt ${this.file} from scratch (it was unreadable: ${(error as Error).message}); other sessions' Shipped memories in it are gone`;
		}
		try {
			const others = current.sessions.filter((session) => session.session_id !== sessionId);
			const previous = current.sessions.find((session) => session.session_id === sessionId);
			const merged: string[] = [];
			for (const id of [...(previous?.shipped_ids ?? []), ...ids]) {
				if (!merged.includes(id)) merged.push(id);
			}
			const session: ShippedSeenSession = {
				session_id: sessionId,
				// Oldest first, so an over-long history drops the ids least likely to
				// still be in any snapshot.
				shipped_ids: merged.slice(Math.max(0, merged.length - SHIPPED_SEEN_MAX_IDS)),
				updated_at: isoTimestamp(this.#now()),
			};
			// Newest last: the tail is what a bound keeps.
			const sessions = [...others, session].slice(-SHIPPED_SEEN_KEEP_SESSIONS);
			const next: ShippedSeenFile = {
				schema_version: SCHEMA_VERSION,
				updated_at: isoTimestamp(this.#now()),
				sessions,
			};
			const result = validateShippedSeenFile(next);
			if (!result.ok) throw new Error(result.errors.join("; "));
			atomicWriteJson(this.file, next);
			return { persisted: true, ...(healed ? { healed } : {}) };
		} catch (error) {
			return { persisted: false, error: `${(error as Error).message}; ${shippedSeenRemedy(this.file)}` };
		}
	}
}

export interface SessionStatusBlockResult extends StatusBlockResult {
	/** Operator-facing warnings about the memory itself. Never part of `text`. */
	warnings: string[];
}

/**
 * Render a status block for one session, remembering what it reported.
 *
 * This composition is the unit under test for cp-b5eg: it is the whole path the
 * extension's `cp_status_block` takes, minus pi's context. A test can therefore
 * do the thing that actually broke — construct a *second* store (a new
 * extension instance, i.e. a reload) for the same session id — and assert the
 * second block still collapses.
 */
export function renderSessionStatusBlock(args: {
	store: ShippedSeenStore;
	sessionId: string;
	snapshot: StatusSnapshot;
	input?: StatusBlockInput;
	width?: number;
}): SessionStatusBlockResult {
	const warnings: string[] = [];
	const shown = args.store.shown(args.sessionId);
	if (shown.error) {
		warnings.push(`Shipped memory unreadable, this block may repeat rows: ${shown.error}`);
	}
	const result = assembleStatusBlock(
		args.snapshot,
		args.input ?? {},
		{ shownShipped: shown.ids, ...(args.width ? { width: args.width } : {}) },
	);
	const written = args.store.record(args.sessionId, result.shippedIds);
	if (written.healed) {
		warnings.push(`Shipped memory ${written.healed}`);
	}
	if (written.error) {
		warnings.push(`Shipped memory not persisted, the next block may repeat rows: ${written.error}`);
	}
	return { ...result, warnings };
}
