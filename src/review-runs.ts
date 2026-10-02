/**
 * ReviewRuns — the one place a background reviewer attempt is pending
 * (spec 2026-09-05-async-reviewers).
 *
 * Three surfaces (the plan gate, the diff review, the quality panel) each
 * spawn a one-shot reviewer and used to block the parent's tool call until
 * its verdict landed. They now split at that wait: everything before it is
 * the surface's `start()`, everything after it is its `finish()`, and this
 * registry chains the two around the waiter so the tool call can return
 * `wait` at once.
 *
 * What this module owns, and only this:
 *
 *  - **one pending attempt per (job, surface)** — a `start` that finds one is
 *    refused with the record, never allowed to spawn a second reviewer (D9);
 *  - **`pending.json`** in the attempt directory, written before the waiter
 *    starts and deleted before the wake-up is sent (D5, D8): the fact three
 *    readers agree on without a subprocess — the status view, the duplicate
 *    check and the orphan sweep;
 *  - **the handback barrier** (D7): a wake-up is not sent until the caller
 *    that started the attempt says it has composed its own result, because a
 *    reviewer that refuses its brief in under a second would otherwise wake
 *    the parent about an attempt the parent has not been told exists;
 *  - **the orphan sweep** (D4): a `pending.json` whose pid is dead and whose
 *    attempt has no decision belonged to a reviewer that died with a previous
 *    parent; it is finished as an operational fault by the owning surface, and
 *    the wake-up is sent only if the parent had been handed a `wait` for it.
 *
 * It knows nothing about verdicts. The waiter and the finisher are the
 * surface's; the registry only orders them, records them, and never lets an
 * attempt stay pending after its waiter has resolved or thrown.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	isoTimestamp,
	PENDING_REVIEW_FILE,
	type PendingReview,
	paths,
	REVIEW_SURFACES,
	type ReviewSurface,
	SCHEMA_VERSION,
	validatePendingReview,
	VERDICT_DELIVERY_RETRY_SECONDS,
	VERDICT_SUPPRESSED_RETRY_MAX_SECONDS,
} from "./contracts.ts";
import { isPidAlive } from "./fleet.ts";
import { atomicWriteJson } from "./json-store.ts";
import { withDeadline } from "./suggest.ts";
import type { RunRegistry } from "./runs.ts";

/** The wake-up a finished attempt asks the transport to send. */
export interface ReviewWakeup {
	jobId: string;
	surface: ReviewSurface;
	attempt: number;
	/** `surface: review` only: the head the verdict describes (stamp `keys[2]`). */
	headSha?: string;
	/** The formatted result plus one directive line. Never an artifact body. */
	content: string;
	/** The full result object, for `details`. */
	details: Record<string, unknown>;
}

/** The transport. Returns whether the wake-up was sent; may throw. */
export type WakeupPort = (wakeup: ReviewWakeup) => boolean;

/** What `start` hands back to its caller: the reviewer is running, nothing else. */
export interface ReviewWait {
	next: "wait";
	surface: ReviewSurface;
	attempt: number;
	model: string;
	deadline: string;
	key: string;
}

/** One attempt, as the owning surface describes it. `T` is the waiter's outcome. */
export interface ReviewAttempt<T> {
	jobId: string;
	surface: ReviewSurface;
	attempt: number;
	model: string;
	pid?: number;
	deadline: string;
	subject?: PendingReview["subject"];
	/** The background wait (`awaitVerdict`, or the panel's vote loop). */
	wait: () => Promise<T>;
	/** Everything after the wait: decide, write, deliver, clean up. */
	finish: (outcome: T) => Promise<ReviewWakeup | undefined>;
}

/** Finish an attempt whose reviewer is gone, with no worker to wait on. */
export type OrphanFinisher = (pending: PendingReview, reason: string) => Promise<ReviewWakeup | undefined>;

export interface OrphanReport {
	finished: PendingReview[];
	skipped: { pending: PendingReview; reason: string }[];
}

export const ORPHAN_REASON = "reviewer lost with the parent session";

/**
 * How long the wake-up waits for its caller's handback before it goes anyway.
 *
 * The barrier (D7) exists so a reviewer that finishes in under a second cannot
 * wake the parent about an attempt the parent has not been told exists. It is
 * an ordering rule, not a permission: a caller that never hands back — a tool
 * result that threw between `start` and `handBack`, a pipeline `advance` whose
 * own turn died — must not be able to park the chain, pin the slot as
 * in-flight, and swallow the verdict. So the wait is bounded, and the decision
 * (already on disk by then, D8) is announced when the bound is spent.
 */
export const HANDBACK_MAX_WAIT_MS = 60_000;

/**
 * How long `beforeWakeup` may take before the wake-up goes without it.
 *
 * Same shape of rule as the handback above, and for the same reason: the hook
 * is arbitrary caller code (today it re-gates deferred merge rows, which means
 * a `gh` query), and arbitrary code that never settles must not be able to pin
 * the slot as in-flight and swallow a verdict that is already on disk. So the
 * wait is bounded and the wake-up is delivered when the bound is spent — the
 * hook orders work *before* delivery, it never gets a veto over it.
 */
export const BEFORE_WAKEUP_MAX_WAIT_MS = 30_000;

export class ReviewRunsError extends Error {
	readonly pending: PendingReview;
	constructor(message: string, pending: PendingReview) {
		super(message);
		this.pending = pending;
	}
}

export interface ReviewRunsOptions {
	home: string;
	wakeup?: WakeupPort;
	/**
	 * Ran (and awaited) after the decision is on disk and **before** the wake-up
	 * is sent — the one place a fact derived from a verdict can be made true
	 * before the parent reads about it (cp-runtime-deferred-recheck: a passing
	 * diff review releases a merge ask deferred as `green but unreviewed`, and
	 * the parent must find that row already open).
	 *
	 * Deliberately not part of `WakeupPort`: the port is synchronous and only
	 * reports whether the transport accepted a message, while this is work that
	 * has to finish first. A hook that throws, rejects **or never settles** must
	 * never cost the wake-up: `#run` catches the first two and bounds the third at
	 * `BEFORE_WAKEUP_MAX_WAIT_MS`, after which the wake-up is sent and the slot is
	 * released regardless. This is an ordering guarantee, not a veto.
	 */
	beforeWakeup?: (wakeup: ReviewWakeup) => Promise<void> | void;
	/** Reported when the hook threw or ran out of time. Never fatal. */
	onBeforeWakeupFailure?: (reason: string, wakeup: ReviewWakeup) => void;
	/**
	 * A `finish` threw and no safe cp-verdict exists (partial write, or the operational
	 * fallback threw or produced nothing). Once per attempt, after cleanup; never fatal.
	 */
	onFinishFailure?: (pending: PendingReview, reason: string) => void;
	runs?: RunRegistry;
	now?: () => Date;
	isAlive?: (pid: number) => boolean;
	/** Override `HANDBACK_MAX_WAIT_MS` (tests). */
	handbackTimeoutMs?: number;
	/** Override `BEFORE_WAKEUP_MAX_WAIT_MS` (tests). */
	beforeWakeupTimeoutMs?: number;
}

interface Slot {
	pending: PendingReview;
	handedBack: Promise<void>;
	handBack: () => void;
	/** Resolves once `finish` and the wake-up (or its failure) are done. */
	settled: Promise<void>;
}

/** Read one attempt's `pending.json`. Unreadable or invalid means "none". */
export function readPendingReview(
	home: string,
	jobId: string,
	surface: ReviewSurface,
	attempt: number,
): PendingReview | undefined {
	const file = join(home, paths.pendingReviewFile(jobId, surface, attempt));
	if (!existsSync(file)) return undefined;
	try {
		const parsed = validatePendingReview(JSON.parse(readFileSync(file, "utf8")));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

/** Every pending review for a job, across surfaces and attempts, files only. */
export function listPendingReviews(home: string, jobId: string): PendingReview[] {
	const runDir = join(home, paths.runDir(jobId));
	if (!existsSync(runDir)) return [];
	const found: PendingReview[] = [];
	for (const entry of readdirSync(runDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const located = attemptOfDirName(entry.name);
		if (!located) continue;
		if (!existsSync(join(runDir, entry.name, PENDING_REVIEW_FILE))) continue;
		const pending = readPendingReview(home, jobId, located.surface, located.attempt);
		if (pending) found.push(pending);
	}
	return found.sort((a, b) => a.surface.localeCompare(b.surface) || a.attempt - b.attempt);
}

/** `gate-2` → gate/2, `review-3` → review/3, `quality-panel` → quality/1; anything else is not an attempt dir. */
function attemptOfDirName(name: string): { surface: ReviewSurface; attempt: number } | undefined {
	const gate = /^gate-(\d+)$/.exec(name);
	if (gate) return { surface: "gate", attempt: Number(gate[1]) };
	const review = /^review-(\d+)$/.exec(name);
	if (review) return { surface: "review", attempt: Number(review[1]) };
	if (name === paths.reviewAttemptDir("x", "quality", 1).split("/").at(-1)) return { surface: "quality", attempt: 1 };
	return undefined;
}

/** Does the attempt's decision file exist? The surface's own file names, read by shape. */
export function decisionExists(home: string, pending: PendingReview): boolean {
	switch (pending.surface) {
		case "gate":
			return existsSync(join(home, paths.gateFile(pending.job_id, pending.attempt)));
		case "review":
			return existsSync(join(home, paths.reviewFile(pending.job_id, pending.attempt)));
		case "quality":
			return existsSync(join(home, paths.qualityFile(pending.job_id)));
	}
}

/**
 * One line, schema-sized: a persisted operational reason is at most 400
 * characters (`DiffVerdictSchema`/`GateVerdictSchema`), and a validation error
 * message is multi-line and unbounded.
 */
function finishFailureReason(prefix: string, error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
	const line = `${prefix}: ${message || "no message"}`;
	return line.length <= 400 ? line : `${line.slice(0, 399)}…`;
}

/** The durable notice for `onFinishFailure`: where to look, and that it authorizes nothing. */
export function formatReviewFinishFailure(pending: Pick<PendingReview, "job_id" | "surface" | "attempt">, reason: string): string {
	const job = pending.job_id;
	const status = pending.surface === "quality" ? "/status" : `cp_${pending.surface === "review" ? "review" : "gate"} ${job} action:status`;
	return [
		`REVIEW FINISH FAILED — ${job} ${pending.surface} attempt ${pending.attempt}`,
		`  ${reason}`,
		"  No cp-verdict was sent for this attempt: any decision on disk was never announced, and this notice authorizes nothing.",
		`  next: read ${status} and /watch ${job} before acting; cp_integrate still gates on the persisted decision alone — never merge on this notice.`,
	].join("\n");
}

export class ReviewRuns {
	readonly #options: ReviewRunsOptions;
	readonly #slots = new Map<string, Slot>();
	/** Sent wake-ups nobody has confirmed yet, by `${job}|${surface}|${attempt}`. */
	readonly #inFlight = new Map<string, { wakeup: ReviewWakeup; sentAt: number; firstSentAt: number; resent: boolean }>();
	#port: WakeupPort | undefined;

	constructor(options: ReviewRunsOptions) {
		this.#options = options;
	}

	static key(jobId: string, surface: ReviewSurface, attempt: number): string {
		return `${jobId}#${surface}-${attempt}`;
	}

	static deliveryKey(wakeup: Pick<ReviewWakeup, "jobId" | "surface" | "attempt">): string {
		return `${wakeup.jobId}|${wakeup.surface}|${wakeup.attempt}`;
	}

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}

	#record(
		jobId: string,
		kind: "review_started" | "verdict_wakeup_sent" | "review_orphaned",
		payload: Record<string, unknown>,
	): void {
		try {
			this.#options.runs?.open(jobId).cp(kind, payload);
		} catch {
			// The run log explains; it never decides. A log that cannot be written
			// must not change what happens to the attempt.
		}
	}

	/** The pending attempt for a slot: this process's memory first, then disk. */
	pending(jobId: string, surface: ReviewSurface): PendingReview | undefined {
		for (const slot of this.#slots.values()) {
			if (slot.pending.job_id === jobId && slot.pending.surface === surface) return slot.pending;
		}
		return listPendingReviews(this.#options.home, jobId).find((pending) => pending.surface === surface);
	}

	/** Every pending attempt for a job, files only (the status view's read). */
	pendingFor(jobId: string): PendingReview[] {
		return listPendingReviews(this.#options.home, jobId);
	}

	/**
	 * Register an attempt whose reviewer is already spawned, write its
	 * `pending.json`, start the waiter, and return `wait`. The chain
	 * `wait → finish → handback → wakeup` runs in the background; it never
	 * rejects, and it always clears the slot.
	 */
	start<T>(attempt: ReviewAttempt<T>): ReviewWait {
		const existing = this.pending(attempt.jobId, attempt.surface);
		if (existing) {
			throw new ReviewRunsError(
				`${attempt.jobId} already has a ${attempt.surface} review in flight (attempt ${existing.attempt}, ` +
					`started ${existing.started_at}, deadline ${existing.deadline}) — one reviewer per job and surface; wait for its cp-verdict wake-up`,
				existing,
			);
		}
		const key = ReviewRuns.key(attempt.jobId, attempt.surface, attempt.attempt);
		const pending: PendingReview = {
			schema_version: SCHEMA_VERSION,
			job_id: attempt.jobId,
			surface: attempt.surface,
			attempt: attempt.attempt,
			model: attempt.model,
			...(attempt.pid !== undefined ? { pid: attempt.pid } : {}),
			started_at: isoTimestamp(this.#now()),
			deadline: attempt.deadline,
			handed_back: false,
			...(attempt.subject ? { subject: attempt.subject } : {}),
		};
		atomicWriteJson(
			join(this.#options.home, paths.pendingReviewFile(pending.job_id, pending.surface, pending.attempt)),
			pending,
		);
		this.#record(attempt.jobId, "review_started", {
			surface: pending.surface,
			attempt: pending.attempt,
			model: pending.model,
			...(pending.pid !== undefined ? { pid: pending.pid } : {}),
			deadline: pending.deadline,
		});

		let handBack: () => void = () => {};
		const handedBack = new Promise<void>((resolve) => {
			handBack = resolve;
		});
		const slot: Slot = { pending, handedBack, handBack, settled: Promise.resolve() };
		this.#slots.set(key, slot);
		slot.settled = this.#run(key, slot, attempt, handedBack);
		return {
			next: "wait",
			surface: pending.surface,
			attempt: pending.attempt,
			model: pending.model,
			deadline: pending.deadline,
			key,
		};
	}

	async #run<T>(key: string, slot: Slot, attempt: ReviewAttempt<T>, handedBack: Promise<void>): Promise<void> {
		let wakeup: ReviewWakeup | undefined;
		let finishFailure: string | undefined;
		const pending = slot.pending;
		try {
			let outcome: T;
			try {
				outcome = await attempt.wait();
			} catch (error) {
				// A waiter that throws is an operational outcome, never a pending
				// attempt nobody will ever finish. The surfaces' outcome types all
				// carry `operational` — SAFETY: that is the cast's invariant, the seam's one concession.
				outcome = { operational: `reviewer wait failed: ${(error as Error).message}` } as unknown as T;
			}
			try {
				wakeup = await attempt.finish(outcome);
			} catch (error) {
				const reason = finishFailureReason("reviewer finish failed", error);
				this.#record(pending.job_id, "review_orphaned", {
					surface: pending.surface,
					attempt: pending.attempt,
					reason,
				});
				if (decisionExists(this.#options.home, pending)) {
					// A partial finish: the decision is on disk, something after it threw.
					// A fallback would write a second, conflicting decision; a cp-verdict
					// built here would vouch for a file this code did not validate.
					finishFailure = `${reason}; a decision was already written for this attempt`;
				} else {
					// The same `{ operational }` the waiter-throw path uses: persisted as
					// escalate/operational, so the attempt is spent and the next review
					// is attempt N+1, never a replay of its scratch verdict. SAFETY: same cast as above.
					try {
						wakeup = await attempt.finish({ operational: reason } as unknown as T);
						if (!wakeup) finishFailure = `${reason}; the operational fallback produced no wake-up`;
					} catch (fallbackError) {
						finishFailure = `${reason}; ${finishFailureReason("operational fallback also failed", fallbackError)}`;
					}
				}
			}
		} finally {
			// D8: the slot is cleared — and the file is gone — before anything is
			// announced. `finish` has already written the decision (or failed to,
			// in which case the next start/advance finds no decision and retries).
			this.#clear(pending);
		}
		if (finishFailure) {
			// D7 holds for the notice too: never before the caller holds its `wait`.
			await this.#awaitHandback(handedBack);
			this.#reportFinishFailure(pending, finishFailure);
		}
		if (!wakeup) {
			this.#slots.delete(key);
			return;
		}
		// D7: the caller holds its `wait` result before the parent hears the verdict
		// — but bounded, so a caller that never hands back cannot swallow it.
		await this.#awaitHandback(handedBack);
		// cp-runtime-deferred-recheck: everything that must be true *before* the
		// parent is woken happens here, awaited, with the decision already on disk —
		// and bounded, so "before" can never become "instead of".
		await this.#runBeforeWakeup(wakeup);
		this.#send(wakeup);
		this.#slots.delete(key);
	}

	/**
	 * The hook, or the bound, whichever comes first. Three failure modes, one
	 * outcome: a synchronous throw, a rejection and a promise that never settles
	 * all resolve here, are reported once, and leave `#send` and the slot cleanup
	 * below to run exactly as they would have. Nothing the hook did or did not do
	 * is recorded as having succeeded — it writes through its own store, so a
	 * spent bound simply means it did not finish.
	 */
	async #runBeforeWakeup(wakeup: ReviewWakeup): Promise<void> {
		const hook = this.#options.beforeWakeup;
		if (!hook) return;
		const ms = this.#options.beforeWakeupTimeoutMs ?? BEFORE_WAKEUP_MAX_WAIT_MS;
		let started: Promise<void>;
		try {
			started = Promise.resolve(hook(wakeup));
		} catch (error) {
			this.#reportBeforeWakeup(`beforeWakeup threw: ${(error as Error).message}`, wakeup);
			return;
		}
		const failure = await withDeadline(
			started.then(
				() => undefined,
				(error: unknown) => `beforeWakeup failed: ${(error as Error).message}`,
			),
			ms,
			() => `beforeWakeup did not finish within ${ms}ms; the verdict was delivered anyway`,
		);
		if (failure) this.#reportBeforeWakeup(failure, wakeup);
	}

	#reportBeforeWakeup(reason: string, wakeup: ReviewWakeup): void {
		try {
			this.#options.onBeforeWakeupFailure?.(reason, wakeup);
		} catch {
			// Reporting a failure must not become one.
		}
		this.#record(wakeup.jobId, "verdict_wakeup_sent", {
			surface: wakeup.surface,
			attempt: wakeup.attempt,
			before_wakeup: reason,
		});
	}

	/**
	 * A finish that left no safe wake-up behind: said once, after cleanup, and
	 * never allowed to become a second failure. No cp-verdict is sent for it.
	 */
	#reportFinishFailure(pending: PendingReview, reason: string): void {
		try {
			this.#options.onFinishFailure?.(pending, reason);
		} catch {
			// Reporting a failure must not become one.
		}
	}

	/**
	 * The handback, or the bound, whichever comes first. The timer is `unref`ed:
	 * a pending wake-up must never be the reason a process stays alive.
	 */
	async #awaitHandback(handedBack: Promise<void>): Promise<void> {
		const ms = this.#options.handbackTimeoutMs ?? HANDBACK_MAX_WAIT_MS;
		await Promise.race([
			handedBack,
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, ms);
				timer.unref?.();
			}),
		]);
	}

	#clear(pending: PendingReview): void {
		rmSync(join(this.#options.home, paths.pendingReviewFile(pending.job_id, pending.surface, pending.attempt)), {
			force: true,
		});
	}

	/** Tests and shutdown swap the transport after construction. */
	set wakeupPort(port: WakeupPort | undefined) {
		this.#port = port;
	}

	#send(wakeup: ReviewWakeup, resend = false): void {
		let sent = false;
		try {
			sent = (this.#port ?? this.#options.wakeup)?.(wakeup) ?? false;
		} catch {
			sent = false;
		}
		this.#record(wakeup.jobId, "verdict_wakeup_sent", {
			surface: wakeup.surface,
			attempt: wakeup.attempt,
			sent,
			resend,
			...(wakeup.headSha ? { head_sha: wakeup.headSha } : {}),
		});
		// cp-nx7: a send is a hand-off to a queue, not evidence of arrival. Keep it
		// until the message is observed in the parent's context, or resent once.
		const key = ReviewRuns.deliveryKey(wakeup);
		const existing = this.#inFlight.get(key);
		// pi-command-post-b04: a send the staleness check withheld put nothing in
		// front of anybody, so it cannot spend the one resend. Only a copy that
		// actually reached the transport does — a wake-up suppressed by a fact that
		// is still catching up (a lagging CI observation) stays eligible, bounded by
		// `VERDICT_DELIVERY_MAX_SENDS` rather than by the first withheld attempt.
		const at = this.#now().getTime();
		this.#inFlight.set(key, {
			wakeup,
			sentAt: at,
			firstSentAt: existing?.firstSentAt ?? at,
			resent: (resend && sent) || existing?.resent === true,
		});
	}

	/** The message reached the parent: these keys are delivered. Returns the ones that were still in flight. */
	confirm(keys: readonly string[]): string[] {
		const fresh: string[] = [];
		for (const key of keys) {
			if (this.#inFlight.delete(key)) fresh.push(key);
		}
		return fresh;
	}

	/**
	 * Resend every unconfirmed wake-up older than the retry window, once each.
	 * A duplicate that lands is idempotent — acting on it means reading a
	 * decision file that has not changed — while a lost one is invisible, which
	 * is why this exists. After the one *delivered* resend the key is dropped:
	 * two copies is the bound, not a stream.
	 *
	 * A send the staleness check withheld delivered nothing, so it spends no copy
	 * and keeps its eligibility (pi-command-post-b04). What bounds *that* is time,
	 * not a count, and the time is the watcher's: a suppressed verdict is normally
	 * waiting on a CI observation that can be `CI_WATCH_MAX_BACKOFF_MS` away, so
	 * the key survives until `VERDICT_SUPPRESSED_RETRY_MAX_SECONDS` past its first
	 * send and is then dropped for good. Duplicate delivery stays bounded at two
	 * either way, because a withheld attempt reaches nobody.
	 */
	resendDue(now: Date = this.#now()): string[] {
		const resent: string[] = [];
		for (const [key, entry] of this.#inFlight) {
			if (entry.resent || now.getTime() - entry.firstSentAt >= VERDICT_SUPPRESSED_RETRY_MAX_SECONDS * 1000) {
				this.#inFlight.delete(key);
				continue;
			}
			if (now.getTime() - entry.sentAt < VERDICT_DELIVERY_RETRY_SECONDS * 1000) continue;
			this.#send(entry.wakeup, true);
			resent.push(key);
		}
		return resent;
	}

	/** The caller has composed its result: release the wake-up and flip the flag on disk. */
	handBack(key: string): void {
		const slot = this.#slots.get(key);
		if (!slot) return;
		slot.handBack();
		const file = join(
			this.#options.home,
			paths.pendingReviewFile(slot.pending.job_id, slot.pending.surface, slot.pending.attempt),
		);
		if (existsSync(file)) {
			slot.pending = { ...slot.pending, handed_back: true };
			atomicWriteJson(file, slot.pending);
		}
	}

	/** Resolves once the attempt's chain has run to its end. For tests and shutdown. */
	async settled(key: string): Promise<void> {
		await this.#slots.get(key)?.settled;
	}

	/**
	 * Finish every attempt a previous parent left pending: a dead pid and no
	 * decision on disk. Live pids, decided attempts and surfaces with no
	 * finisher are reported and left alone. Nothing here spawns anything.
	 */
	async sweepOrphans(
		finishers: Partial<Record<ReviewSurface, OrphanFinisher>>,
		jobIds: readonly string[],
	): Promise<OrphanReport> {
		const report: OrphanReport = { finished: [], skipped: [] };
		const alive = this.#options.isAlive ?? isPidAlive;
		for (const jobId of jobIds) {
			for (const pending of listPendingReviews(this.#options.home, jobId)) {
				if (this.#slots.has(ReviewRuns.key(pending.job_id, pending.surface, pending.attempt))) continue;
				if (pending.pid !== undefined && alive(pending.pid)) {
					report.skipped.push({ pending, reason: "reviewer still alive" });
					continue;
				}
				if (decisionExists(this.#options.home, pending)) {
					// A crash between the decision write and the pending delete: the
					// decision stands, the marker is stale. Clear it without a wake-up —
					// the next start/advance reads the decision from disk.
					this.#clear(pending);
					report.skipped.push({ pending, reason: "decision already on disk" });
					continue;
				}
				const finisher = finishers[pending.surface];
				if (!finisher) {
					report.skipped.push({ pending, reason: `no finisher for ${pending.surface}` });
					continue;
				}
				let wakeup: ReviewWakeup | undefined;
				try {
					wakeup = await finisher(pending, ORPHAN_REASON);
				} catch (error) {
					// The orphan finish *is* the operational outcome, so there is no
					// fallback to try: report it once and keep sweeping the rest.
					const reason = finishFailureReason("orphaned reviewer finish failed", error);
					this.#clear(pending);
					this.#record(pending.job_id, "review_orphaned", { surface: pending.surface, attempt: pending.attempt, reason });
					this.#reportFinishFailure(pending, reason);
					report.skipped.push({ pending, reason });
					continue;
				}
				this.#clear(pending);
				this.#record(pending.job_id, "review_orphaned", {
					surface: pending.surface,
					attempt: pending.attempt,
					reason: ORPHAN_REASON,
					handed_back: pending.handed_back,
				});
				report.finished.push(pending);
				if (wakeup && pending.handed_back) this.#send(wakeup);
			}
		}
		return report;
	}
}

/** Exported for the status view and the widget: which surfaces exist. */
export const SURFACES: readonly ReviewSurface[] = REVIEW_SURFACES;
