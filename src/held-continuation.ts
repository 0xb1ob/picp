/**
 * The held-PR continuation (pi-command-post-epic-pr-a-jje.2): what moves a held
 * `delivery:pr` job from "reported" to "merged and closed" when only facts
 * changed — no model turn in between.
 *
 * PR #219 sat green for twelve minutes, two verdict revisions were missed and a
 * PR was torn down on a redelivered do-not-act notice (2026-09-25): every one of
 * those waited on a parent turn to call `cp_integrate`, or acted on a notice
 * instead of on facts. So the parent now continues by itself on four triggers —
 * an accepted envelope, a CI/PR fact the watcher observed for the held head, a
 * diff review that passed, and startup — and each runs the same loop over
 * `Integrator.advance`, the one merge sequence. It inherits every gate that has:
 * each step re-reads the pushed head, CI and GitHub's own merge permission, and
 * nothing here decides to merge, mints an approval or waits for CI.
 *
 *  - **Serial per project**, shared with a manual `cp_integrate`: one merge step
 *    at a time per base, so a second PR's step reads the base the first merge
 *    left instead of racing it.
 *  - **Coalesced per `job|head|event`**, plus the run attempt for a CI fact, and
 *    checked for phase, generation and head *at execution*: a stale or replayed
 *    event acts on nothing, whatever became of the notice that described it.
 *  - **Stops on anything but `advance`.** `wait` is left to the watcher's next
 *    fact; `review` starts one `cp_review` (never while one is pending — its
 *    verdict resumes this); resolve/surface/retry/done leave one durable notice.
 *    An operational fault is never retried here.
 *  - **Respects a drain** (unload-parent PR2): while `state/drain.json` is on disk
 *    (or unreadable) no step is taken and the key is not consumed; the restart's
 *    startup `resume()` re-triggers. A landing (`done`) calls `onLanded`, which
 *    releases dispatches armed on that job (src/dependency-dispatch.ts).
 */

import { isWatched } from "./ci-watch.ts";
import type { IntegrationNext } from "./contracts.ts";
import { type DiffReviewStart, isDiffReviewWait } from "./diff-review.ts";
import type { FleetStore } from "./fleet.ts";
import type { IntegrateResult } from "./integrate.ts";
import { shaMatches } from "./merge-ask.ts";
import type { ReviewRuns, ReviewWakeup } from "./review-runs.ts";
import type { RunRegistry } from "./runs.ts";
import { boundedWakeupId } from "./wakeup-outbox.ts";

/** How many handled keys a process remembers before it forgets them all (at worst, one repeat pass). */
const CONTINUATION_KEY_MEMORY = 512;

/** Bounds one trigger: a merge is at most update → merge → finish, so this is slack, not a loop. */
export const CONTINUATION_MAX_STEPS = 6;

export type ContinuationEvent = "envelope" | "startup" | "verdict" | "ci_green" | "ci_failed" | "pr_merged" | "pr_closed";

export interface ContinuationTrigger {
	jobId: string;
	event: ContinuationEvent;
	/** The head the event is about, re-checked at execution against the source that owns it. */
	head?: string;
	/**
	 * The CI run identity a CI fact was observed on (`CiObservation.run_identity`):
	 * a re-run on the same head is a new attempt, not a replay of the one already
	 * acted on (pi-command-post-rerunwake-12z). Absent for non-CI triggers.
	 */
	run?: string;
	/** The envelope generation it is about. */
	generation?: number;
	/** The review attempt a verdict trigger is about. */
	attempt?: number;
}

export type ContinuationAction =
	| "disabled"
	| "coalesced"
	| "stale"
	| "wait"
	| "review_started"
	| "review_pending"
	| "stopped"
	| "done"
	| "draining"
	| "error";

export interface ContinuationOutcome {
	job_id: string;
	key: string;
	action: ContinuationAction;
	next?: IntegrationNext;
	steps: number;
	reason: string;
}

export interface HeldContinuationDeps {
	/** Off: triggers do nothing, and `serialize` still orders a manual `cp_integrate`. */
	enabled: () => boolean;
	fleet: Pick<FleetStore, "get" | "list">;
	/** One `Integrator.advance` step — raw, never re-entering `serialize`. */
	advance: (jobId: string) => Promise<IntegrateResult>;
	/** Start one `cp_review` (a revise still goes to the job's own implementer). */
	review: (jobId: string) => Promise<DiffReviewStart>;
	reviews: Pick<ReviewRuns, "pending" | "handBack">;
	/** The head its owning source holds now: the fleet's reported head, or the watcher's observed one. */
	head: (jobId: string, owner: "fleet" | "observed") => string | undefined;
	/** One durable notice; ids repeat for the same outcome, so the outbox delivers it once. */
	notify: (notice: { id: string; job_id: string; content: string; keys?: string[] }) => void;
	runs?: RunRegistry;
	maxSteps?: number;
	/** One line naming the tracker write-back for a landed job (laf); never throws. */
	writeBack?: (jobId: string) => string;
	/** True while `state/drain.json` is on disk: no step is taken (no review, merge or rerun); a throw reads as draining. */
	draining?: () => boolean;
	/** A held PR landed (`done`): its dependents may be released (`ArmedDispatches.release`); never throws into the step. */
	onLanded?: (jobId: string) => void;
}

const NEXT_HINT: Readonly<Record<string, string>> = Object.freeze({
	done: "merged, torn down and closed without a parent turn: relay the PR URL, then cp_next.",
	resolve: "the job's own implementer was promoted to fix it; its next envelope resumes this. Wait — never re-dispatch.",
	surface: "stopped on a human or repository decision: relay it. Nothing retries this automatically.",
	retry: "an operational fault; nothing was mutated and nothing retries automatically. Call cp_integrate once the cause clears.",
});

/** Which source owns a trigger's head: the watcher for a GitHub fact, the fleet's reported head otherwise. */
function headOwner(event: ContinuationEvent): "fleet" | "observed" {
	return event === "ci_green" || event === "ci_failed" || event === "pr_merged" || event === "pr_closed" ? "observed" : "fleet";
}

export function continuationKey(trigger: ContinuationTrigger): string {
	const attempt = trigger.attempt !== undefined ? `:${trigger.attempt}` : "";
	const run = trigger.run !== undefined && trigger.run.length > 0 ? `#${trigger.run}` : "";
	const generation = trigger.generation !== undefined ? `@${trigger.generation}` : "";
	return `${trigger.jobId}|${trigger.head ?? ""}|${trigger.event}${attempt}${run}${generation}`;
}

export function formatContinuationNotice(jobId: string, next: string, reason: string, prUrl?: string, extra?: string): string {
	return [
		`HELD PR ${next === "done" ? "LANDED" : "STOPPED"} — ${jobId} (continuation, next: ${next})`,
		`  ${reason}`,
		...(prUrl ? [`  ${prUrl}`] : []),
		...(extra ? [`  ${extra}`] : []),
		`  ${NEXT_HINT[next] ?? NEXT_HINT.surface}`,
	].join("\n");
}

export class HeldContinuation {
	readonly #deps: HeldContinuationDeps;
	readonly #lanes = new Map<string, Promise<unknown>>();
	/** Keys queued, running or handled. A `wait` releases its key so the watch can re-trigger the same fact. */
	readonly #seen = new Set<string>();
	/** Jobs whose continuation is mid-drive (one at a time per lane). */
	readonly #driving = new Set<string>();

	constructor(deps: HeldContinuationDeps) {
		this.#deps = deps;
	}

	/** True while a continuation step sequence is driving this job (HeldRelease never releases it then). */
	driving(jobId: string): boolean {
		return this.#driving.has(jobId);
	}

	/** Run `fn` after every earlier step on the same project's lane. */
	serialize<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
		const lane = this.#deps.fleet.get(jobId)?.project ?? jobId;
		const run = (this.#lanes.get(lane) ?? Promise.resolve()).then(fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.#lanes.set(lane, tail);
		void tail.then(() => {
			if (this.#lanes.get(lane) === tail) this.#lanes.delete(lane);
		});
		return run;
	}

	/**
	 * Every trigger is snapshotted when observed: the generation, and the head its owning
	 * source holds (unless the event carries its own). Both are its identity and are
	 * required to still match before each step.
	 */
	async trigger(observed: ContinuationTrigger): Promise<ContinuationOutcome> {
		const record = this.#deps.fleet.get(observed.jobId);
		const generation = observed.generation ?? (record ? (record.supersessions ?? 0) + 1 : undefined);
		const head = observed.head ?? this.#deps.head(observed.jobId, headOwner(observed.event));
		const trigger: ContinuationTrigger = { ...observed, ...(generation !== undefined ? { generation } : {}), ...(head ? { head } : {}) };
		const key = continuationKey(trigger);
		const skip = (action: ContinuationAction, reason: string): ContinuationOutcome => ({ job_id: trigger.jobId, key, action, steps: 0, reason });
		if (!this.#deps.enabled()) return skip("disabled", "the continuation is off in this process");
		// Not added to #seen: the drain ends in a restart, and startup `resume()` owes this job its pass.
		if (this.#draining()) {
			const draining = skip("draining", `${trigger.jobId}: the home is draining for a restart — no review, merge or rerun starts; startup resumes it`);
			this.#journal(trigger, draining);
			return draining;
		}
		if (this.#seen.has(key)) return skip("coalesced", `${key} was already handled or is queued`);
		if (this.#seen.size >= CONTINUATION_KEY_MEMORY) this.#seen.clear();
		this.#seen.add(key);
		const outcome = await this.serialize(trigger.jobId, async () => {
			this.#driving.add(trigger.jobId);
			try {
				return await this.#drive(trigger, key);
			} catch (error) {
				const reason = `${trigger.jobId}: continuation failed: ${(error as Error).message.split("\n")[0]}`;
				this.#notice(trigger.jobId, `error:${key}`, "retry", reason);
				return { ...skip("error", reason), next: "retry" as const };
			} finally {
				this.#driving.delete(trigger.jobId);
			}
		});
		// Re-armed only after it settles: while queued or running the key still coalesces.
		if (outcome.action === "wait" || outcome.action === "draining") this.#seen.delete(key);
		this.#journal(trigger, outcome);
		return outcome;
	}

	onEnvelope(result: { job_id: string; accepted: boolean; already: boolean; next?: string; generation?: number }): void {
		if (!result.accepted || result.already || result.next !== "hold") return;
		void this.trigger({ jobId: result.job_id, event: "envelope", ...(result.generation !== undefined ? { generation: result.generation } : {}) });
	}

	onCi(jobId: string, observation: { event: ContinuationEvent; head_sha: string; run_identity?: string }): void {
		void this.trigger({
			jobId,
			event: observation.event,
			...(observation.head_sha ? { head: observation.head_sha } : {}),
			...(observation.run_identity ? { run: observation.run_identity } : {}),
		});
	}

	/** At verdict due time (`beforeWakeup`): only a passing diff review has anything left to continue. */
	async onVerdict(wakeup: ReviewWakeup): Promise<void> {
		if (wakeup.surface !== "review" || (wakeup.details as { next?: unknown }).next !== "proceed") return;
		await this.trigger({ jobId: wakeup.jobId, event: "verdict", attempt: wakeup.attempt, ...(wakeup.headSha ? { head: wakeup.headSha } : {}) });
	}

	/** Startup reconciliation: every held PR gets one pass, in its project's lane. */
	async resume(): Promise<ContinuationOutcome[]> {
		if (!this.#deps.enabled()) return [];
		let held;
		try {
			held = this.#deps.fleet.list().filter((record) => record.kind === "ship" && isWatched(record));
		} catch {
			return []; // An unreadable fleet is reconcile's to report; the next fact re-triggers.
		}
		return Promise.all(held.map((record) => this.trigger({ jobId: record.job_id, event: "startup" })));
	}

	/** Why this trigger may not take a step now: `stale` for good, or `wait` when its head cannot be confirmed. */
	#stale(trigger: ContinuationTrigger): { action: "stale" | "wait"; reason: string } | undefined {
		const stale = (reason: string) => ({ action: "stale" as const, reason });
		const record = this.#deps.fleet.get(trigger.jobId);
		if (!record) return stale(`there is no fleet record for ${trigger.jobId}`);
		if (record.kind !== "ship" || !isWatched(record)) {
			return stale(`${trigger.jobId} is no longer a held delivery:pr ship job with an open PR (phase ${record.phase})`);
		}
		const generation = (record.supersessions ?? 0) + 1;
		if (trigger.generation !== undefined && trigger.generation !== generation) {
			return stale(`${trigger.jobId} moved from generation ${trigger.generation} to ${generation}`);
		}
		if (trigger.head) {
			const owner = headOwner(trigger.event);
			const current = this.#deps.head(trigger.jobId, owner);
			// Fail closed: a head nobody can read confirms nothing, so the step waits for the next fact.
			if (!current) {
				return { action: "wait", reason: `${trigger.jobId}: the ${owner} head cannot be read, so ${trigger.head.slice(0, 12)} is unconfirmed — waiting` };
			}
			if (!shaMatches(current, trigger.head)) return stale(`${trigger.jobId} moved from ${trigger.head.slice(0, 12)} to ${current.slice(0, 12)}`);
		}
		return undefined;
	}

	async #drive(trigger: ContinuationTrigger, key: string): Promise<ContinuationOutcome> {
		const { jobId } = trigger;
		const out = (action: ContinuationAction, steps: number, reason: string, next?: IntegrationNext): ContinuationOutcome => ({
			job_id: jobId,
			key,
			action,
			steps,
			reason,
			...(next ? { next } : {}),
		});
		const max = this.#deps.maxSteps ?? CONTINUATION_MAX_STEPS;
		for (let step = 1; step <= max; step += 1) {
			// Before every step, not once: a worker, a push or a promote can land between
			// two awaited steps, and a stale trigger must not keep reviewing or merging.
			const stale = this.#stale(trigger);
			if (stale) return out(stale.action, step - 1, stale.reason, stale.action === "wait" ? "wait" : undefined);
			if (this.#draining()) return out("draining", step - 1, `${jobId}: a drain started mid-sequence — no further step; startup resumes it`);
			const result = await this.#deps.advance(jobId);
			if (result.next === "advance") continue;
			if (result.next === "wait") return out("wait", step, result.reason, "wait");
			const tag = `${result.head_sha?.slice(0, 12) ?? "-"}:${result.step}`;
			if (result.next === "review") {
				// The awaited step may have outlived the trigger: never spend a review on a stale one.
				// The watcher's head can lag the remote: the head the step itself read decides too.
				const reviewing = result.head_sha && trigger.head && !shaMatches(result.head_sha, trigger.head)
					? { action: "stale" as const, reason: `${jobId} moved from ${trigger.head.slice(0, 12)} to ${result.head_sha.slice(0, 12)} on the remote` }
					: undefined;
				const staleNow = this.#stale(trigger) ?? reviewing;
				if (staleNow) return out(staleNow.action, step, staleNow.reason, staleNow.action === "wait" ? "wait" : undefined);
				if (this.#deps.reviews.pending(jobId, "review")) {
					return out("review_pending", step, `${jobId}: a cp_review is already in flight; its verdict resumes this`, "review");
				}
				let started: DiffReviewStart;
				try {
					started = await this.#deps.review(jobId);
				} catch (error) {
					const reason = `${jobId}: cp_review could not start — ${(error as Error).message.split("\n")[0]}`;
					this.#notice(jobId, `${tag}:review`, "surface", reason, result.pr_url);
					return out("stopped", step, reason, "surface");
				}
				if (isDiffReviewWait(started)) {
					this.#deps.reviews.handBack(started.key);
					return out("review_started", step, `${jobId}: cp_review attempt ${started.attempt} started on ${started.head_sha.slice(0, 12)}`, "review");
				}
				if (started.next === "proceed") continue;
				const reason = `${jobId}: cp_review decided ${started.verdict.verdict}/${started.verdict.cause ?? "none"} without a pass (next ${started.next})`;
				this.#notice(jobId, `${tag}:review`, "surface", reason, result.pr_url);
				return out("stopped", step, reason, "surface");
			}
			this.#notice(jobId, result.next === "done" ? "done" : `${tag}:${result.next}`, result.next, result.reason, result.pr_url);
			if (result.next === "done") this.#landed(jobId);
			return out(result.next === "done" ? "done" : "stopped", step, result.reason, result.next);
		}
		const reason = `${jobId}: ${max} integration steps advanced without settling`;
		this.#notice(jobId, "exhausted", "surface", reason);
		return out("stopped", max, reason, "surface");
	}

	/** Fail closed: a drain flag that cannot be read is a drain (`readDrain` throws on an unreadable file). */
	#draining(): boolean {
		try {
			return this.#deps.draining?.() === true;
		} catch {
			return true;
		}
	}

	#landed(jobId: string): void {
		try {
			this.#deps.onLanded?.(jobId);
		} catch {
			// The landing already happened; a release fault is the scheduler tick's to retry.
		}
	}

	#notice(jobId: string, tag: string, next: string, reason: string, prUrl?: string): void {
		const generation = (this.#deps.fleet.get(jobId)?.supersessions ?? 0) + 1;
		try {
			this.#deps.notify({
				id: boundedWakeupId(`continuation:${jobId}:${generation}:${tag}`),
				job_id: jobId,
				content: formatContinuationNotice(jobId, next, reason, prUrl, next === "done" ? this.#deps.writeBack?.(jobId) : undefined),
				// A stop is stale once the job is done; the landing notice is about exactly that.
				...(next === "done" ? {} : { keys: [jobId] }),
			});
		} catch {
			// The run-log line below still records the outcome.
		}
	}

	#journal(trigger: ContinuationTrigger, outcome: ContinuationOutcome): void {
		try {
			this.#deps.runs?.open(trigger.jobId).cp("continuation", { event: trigger.event, ...outcome });
		} catch {
			// A run log that cannot be written must never undo a step that happened.
		}
	}
}
