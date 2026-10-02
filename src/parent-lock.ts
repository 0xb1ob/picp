/**
 * One parent process per home, enforced (cp-epy2 §4.2 item 2).
 *
 * Everything that mutates fleet state serializes **in process**: the mutation
 * queue in `src/json-store.ts` is a per-process promise chain, `fleet.json` is
 * rewritten as a whole array, and `cp_send` reaches a worker through a handle
 * only its own parent holds. Two parents on one home therefore do not merely
 * interleave — cp-ga6j showed they orphan live workers by writing each other's
 * jobs away. The broker's queue is a promise about that; this file is the
 * invariant.
 *
 * Three rules, and they are the whole design:
 *
 *  1. **It fails closed.** A lock that cannot be created, read, parsed or
 *     understood is a refusal, never an assumption of exclusivity. A lock that
 *     silently permits two parents is worse than no lock at all, because the
 *     home would then be trusted.
 *  2. **A dead holder is reclaimed, never inherited.** A SIGKILLed parent
 *     leaves its lock behind; the successor takes it over only after probing
 *     the pid, and says so (`reclaimed`), because "the lock was stale" is a
 *     fact an operator should read rather than infer.
 *  3. **Only the holder releases it.** `release()` removes the file only while
 *     it still names this process, so a parent that was reclaimed cannot
 *     delete its successor's lock on the way out. The reclaim path obeys the
 *     same rule: it deletes the file only while it still holds the exact stale
 *     record it classified, so two parents reclaiming at once cannot both end
 *     up believing they hold the home (cp-yu5k review, gap 1).
 *
 * It is deliberately a plain file and not a directory or an flock: an operator
 * must be able to read it (`cat state/parent.lock`) and, when a machine reboots
 * with a stale one, delete it. `/doctor` names both.
 */

import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isIsoTimestamp, isoTimestamp, LAYOUT, SCHEMA_VERSION } from "./contracts.ts";
import { isPidAlive as probePid } from "./fleet.ts";

/** What the lock file holds. Small on purpose: a human reads this. */
export interface ParentLockRecord {
	schema_version: number;
	/** The parent process that holds the home. */
	pid: number;
	started_at: string;
	home: string;
	/** pi's session id, when the caller knows it. Advisory. */
	session_id?: string;
}

export interface ParentLock {
	path: string;
	record: ParentLockRecord;
	/** Set when this acquisition took over a lock whose holder was gone. */
	reclaimed?: ParentLockRecord;
	/** True when the file was already ours (a second `session_start`, same pid). */
	reentrant: boolean;
	/** Remove the lock, but only while it still names this process. */
	release(): boolean;
}

export type ParentLockResult =
	| { ok: true; lock: ParentLock }
	| { ok: false; reason: string; holder?: ParentLockRecord };

export type ParentLockRead =
	| { state: "absent"; path: string }
	| { state: "held"; path: string; record: ParentLockRecord }
	| { state: "unreadable"; path: string; reason: string };

export function parentLockPath(home: string): string {
	return join(resolve(home), LAYOUT.parentLock);
}

export interface ParentLockOptions {
	home: string;
	pid?: number;
	sessionId?: string;
	now?: () => Date;
	/** Injected in tests; production probes the real process table. */
	isPidAlive?: (pid: number) => boolean;
	/**
	 * Test seam, and the only reason it exists: the reclaim path has a
	 * read-then-unlink shape, and this is where a competing parent gets to move
	 * first so the interleaving can be asserted rather than argued about. Called
	 * once, immediately before the stale lock would be removed.
	 */
	onBeforeReclaim?: () => void;
}

/**
 * Read the lock without touching it. `unreadable` is a *state*, not an error
 * to swallow: doctor reports it and `acquire` refuses on it.
 */
export function readParentLock(home: string): ParentLockRead {
	const path = parentLockPath(home);
	let text: string;
	try {
		if (!existsSync(path)) return { state: "absent", path };
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { state: "unreadable", path, reason: (error as Error).message };
	}
	const record = parseParentLock(text);
	if (!record) {
		return {
			state: "unreadable",
			path,
			reason: `${path} is not a parent lock this build wrote (${text.trim().slice(0, 120) || "empty file"})`,
		};
	}
	return { state: "held", path, record };
}

/** Strict: an unrecognised shape is not a lock, and is never treated as one. */
export function parseParentLock(text: string): ParentLockRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const candidate = parsed as Partial<ParentLockRecord>;
	if (!Number.isInteger(candidate.pid) || (candidate.pid as number) <= 0) return undefined;
	if (typeof candidate.started_at !== "string" || !isIsoTimestamp(candidate.started_at)) return undefined;
	if (typeof candidate.home !== "string" || candidate.home.length === 0) return undefined;
	return {
		schema_version: typeof candidate.schema_version === "number" ? candidate.schema_version : SCHEMA_VERSION,
		pid: candidate.pid as number,
		started_at: candidate.started_at,
		home: candidate.home,
		...(typeof candidate.session_id === "string" ? { session_id: candidate.session_id } : {}),
	};
}

/**
 * Take the home, or say precisely why not.
 *
 * The write is `O_EXCL`, so two parents racing this call cannot both win: the
 * loser sees `EEXIST` and goes down the read-and-classify path, which refuses
 * a live holder and (once, non-recursively) reclaims a dead one.
 */
export function acquireParentLock(options: ParentLockOptions): ParentLockResult {
	const home = resolve(options.home);
	const path = parentLockPath(home);
	const pid = options.pid ?? process.pid;
	const isAlive = options.isPidAlive ?? probePid;
	const record: ParentLockRecord = {
		schema_version: SCHEMA_VERSION,
		pid,
		started_at: isoTimestamp(options.now?.() ?? new Date()),
		home,
		...(options.sessionId ? { session_id: options.sessionId } : {}),
	};

	const write = (): { ok: true } | { ok: false; exists: boolean; reason: string } => {
		try {
			mkdirSync(dirname(path), { recursive: true });
			// "wx" is O_CREAT|O_EXCL: the create IS the mutual exclusion.
			const fd = openSync(path, "wx");
			try {
				writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
			} finally {
				closeSync(fd);
			}
			return { ok: true };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return { ok: false, exists: code === "EEXIST", reason: (error as Error).message };
		}
	};

	const held = (reclaimed?: ParentLockRecord): ParentLockResult => ({
		ok: true,
		lock: {
			path,
			record,
			reentrant: false,
			...(reclaimed ? { reclaimed } : {}),
			release: () => releaseParentLock({ home, pid }),
		},
	});

	const first = write();
	if (first.ok) return held();
	if (!first.exists) {
		// Not a contended lock: the home is not writable, which is a refusal for
		// the same reason a corrupt lock is. Nothing about exclusivity is proven.
		return { ok: false, reason: `cannot take the parent lock at ${path}: ${first.reason}` };
	}

	const current = readParentLock(home);
	if (current.state === "unreadable") {
		return {
			ok: false,
			reason: `${current.reason} — refusing to assume this home is free; inspect it and remove it if no parent is running (\`rm ${path}\`)`,
		};
	}
	if (current.state === "absent") {
		// It vanished between the failed create and the read (a racing release).
		const retry = write();
		if (retry.ok) return held();
		return { ok: false, reason: `lost a race for the parent lock at ${path}: ${retry.reason}` };
	}
	if (current.record.pid === pid) {
		// Already ours: a second `session_start` in one process is not a second
		// parent, and must not deadlock the session that already holds the home.
		return {
			ok: true,
			lock: {
				path,
				record: current.record,
				reentrant: true,
				release: () => releaseParentLock({ home, pid }),
			},
		};
	}
	if (isAlive(current.record.pid)) {
		return {
			ok: false,
			holder: current.record,
			reason: `another parent already holds this home: pid ${current.record.pid}, since ${current.record.started_at} (${path}). One parent per home is a contract, not a preference — cp-ga6j showed two of them orphan live workers. Use that session, or stop it before starting another.`,
		};
	}

	// Stale: the holder is gone. Take it over deliberately, in one hop, and
	// report what was reclaimed rather than pretending the home was free.
	const stale = current.record;
	options.onBeforeReclaim?.();
	// Re-read and compare before removing anything. Without this, two parents
	// that both read the same stale record would both unlink and both create —
	// the second one deleting the *first one's fresh lock* and leaving two
	// processes convinced they own the home, which is worse than no lock at all.
	// pid AND started_at must match: a pid is reused, the pair is not.
	const confirm = readParentLock(home);
	if (confirm.state === "held" && confirm.record.pid === stale.pid && confirm.record.started_at === stale.started_at) {
		try {
			unlinkSync(path);
		} catch (error) {
			return {
				ok: false,
				holder: stale,
				reason: `cannot reclaim the stale parent lock at ${path}: ${(error as Error).message}`,
			};
		}
		const reclaimed = write();
		if (reclaimed.ok) return held(stale);
		return {
			ok: false,
			holder: stale,
			reason: `another parent took ${path} while this one was reclaiming it from dead pid ${stale.pid}: ${reclaimed.reason}`,
		};
	}
	if (confirm.state === "absent") {
		// The stale lock was cleared by somebody else (another reclaim, an
		// operator's `rm`). The O_EXCL create is the arbiter: exactly one of the
		// racing parents wins it, and the loser refuses here.
		const afterClear = write();
		if (afterClear.ok) return held(stale);
		return {
			ok: false,
			reason: `another parent took ${path} while this one was reclaiming it from dead pid ${stale.pid}: ${afterClear.reason}`,
		};
	}
	// It changed under us: a fresh holder, or a lock we can no longer read.
	// Refusing (rather than re-classifying in a loop) keeps this a single hop —
	// the caller is a `session_start`, and the next one re-reads from scratch.
	return {
		ok: false,
		...(confirm.state === "held" ? { holder: confirm.record } : {}),
		reason:
			confirm.state === "held"
				? `the stale lock at ${path} (dead pid ${stale.pid}) was reclaimed by pid ${confirm.record.pid} while this parent was taking it over — refusing rather than deleting a live holder's lock; retry if that pid is not a running parent`
				: `${confirm.reason} — refusing to remove it while reclaiming from dead pid ${stale.pid}; inspect it and remove it if no parent is running (\`rm ${path}\`)`,
	};
}

/**
 * Does this process hold the home? Read-only, fails closed, and deliberately a
 * fact about the *file* rather than about a variable somebody set at startup:
 * a session whose `acquireParentLock` was refused (or that never asked) reads
 * `false` here, and so does one whose lock has since been reclaimed.
 *
 * This is the gate on the answered outbox's **consumption** side
 * (pi-command-post-u9q review): reserving an emission, sending it, and stamping
 * an arrival are all the home-owner's to do, because they are exactly the
 * records a second session would burn on a context nobody can be woken in.
 * Recording an answer is *not* gated on it — a headless `/cp-authorize` must
 * still queue its decision durably, which is the whole point of an outbox.
 */
export function holdsParentLock(options: { home: string; pid?: number }): boolean {
	const current = readParentLock(resolve(options.home));
	return current.state === "held" && current.record.pid === (options.pid ?? process.pid);
}

/** Remove the lock only while it still names `pid`. Returns whether it did. */
export function releaseParentLock(options: { home: string; pid?: number }): boolean {
	const home = resolve(options.home);
	const pid = options.pid ?? process.pid;
	const current = readParentLock(home);
	if (current.state !== "held" || current.record.pid !== pid) return false;
	try {
		unlinkSync(current.path);
		return true;
	} catch {
		return false;
	}
}

/** One operator-facing line for a refusal or a reclaim. Never a body. */
export function formatParentLock(result: ParentLockResult): string {
	if (!result.ok) return `parent lock: refused — ${result.reason}`;
	if (result.lock.reclaimed) {
		return `parent lock: reclaimed from pid ${result.lock.reclaimed.pid} (not alive, held since ${result.lock.reclaimed.started_at})`;
	}
	if (result.lock.reentrant) return `parent lock: already held by this process (pid ${result.lock.record.pid})`;
	return `parent lock: held by pid ${result.lock.record.pid}`;
}
