/**
 * The deferred-row recheck, as runtime instead of as prose (cp-runtime-deferred-recheck).
 *
 * A merge ask deferred on "CI still running" or "green but unreviewed" is
 * released by exactly two facts, and neither of them is a parent turn: CI
 * finishing on the branch's current head (the `cp-ci` watch observes it) and a
 * `cp_review` passing on that head (the `cp-verdict` wake-up carries it). Until
 * this module, the re-gate that promotes such a row ran only inside
 * `cp_status_block`, so a decision that had become answerable stayed invisible
 * whenever the parent did not call the tool — an instruction in AGENTS.md, and
 * therefore a model behaviour, not a guarantee. PR #134 made the block opt-in,
 * which widened exactly that gap.
 *
 * So the rule moves to where the event already is. `AwaitingStore.reviewDeferred`
 * is unchanged and still the only writer: this is a *trigger*, not a second
 * gate, and every precondition it enforces (green on the current head, a
 * passing review on that head, red stays refused, a gone job stays orphaned)
 * is fail-closed exactly as before.
 *
 * Three properties this file exists to keep:
 *
 *  - **The row is open before the wake-up is delivered, when the recheck
 *    finishes in time.** Both call sites await this recheck *before* the message
 *    that announces the event reaches the parent (`surfaceCi` sends after it;
 *    `ReviewRuns` awaits `beforeWakeup` before `#send`), so a parent reading "CI
 *    is green on cp-x" already has the merge row in front of it.
 *    Fire-and-forget would have made that ordering a race. The ordering is
 *    **bounded, not unconditional**: a re-gate that throws or outlives
 *    `DEFERRED_RECHECK_MAX_WAIT_MS` gives the wake-up up rather than the other
 *    way round (`recheckDeferredBounded`), and the failure is reported in one
 *    bounded line. At that deadline nothing is opened and nothing is announced
 *    — only the gate opens rows, and it has not finished. If it finishes
 *    afterwards and *does* open rows, those rows are announced late through
 *    `onLate` rather than dropped: a decision that became answerable is news
 *    whenever the evidence arrives.
 *  - **Ordinary turns stay quiet.** Only the two events below re-gate anything.
 *    A widget tick, an envelope, a wedged call, a plan-gate verdict, a quality
 *    verdict and a `revise` mutate no row and cost no CI query.
 *  - **A row opens once.** `reviewDeferred` only ever flips rows that are still
 *    `deferred`, so a second event for the same head raises nothing and there is
 *    nothing to announce twice.
 *
 * The manual fallback is untouched: a row deferred on an *unknown* CI state can
 * become readable with no event at all, and `cp_status_block` remains the
 * parent's way to re-gate it (AGENTS.md §Status block).
 */

import type { AwaitingStore } from "./awaiting.ts";
import type { AwaitingItem } from "./contracts.ts";
import { withDeadline } from "./suggest.ts";

/**
 * How long a re-gate may run before its caller stops waiting for it.
 *
 * The gate itself already bounds each `gh`/`git` query it makes
 * (`MERGE_ASK_QUERY_TIMEOUT_MS`, 15s), but a home with several deferred rows
 * queries once per row, and an `execFile` timeout is not a promise that always
 * settles. The two callers here are a **timer tick** and a **wake-up delivery**,
 * so neither may wait on this indefinitely: what is at stake is the operator's
 * notice, the parent's wake-up and, on the reviewer path, the attempt's slot.
 */
export const DEFERRED_RECHECK_MAX_WAIT_MS = 30_000;

/**
 * What happened. `ci` is one or more `cp-ci` observations for a held PR (a run
 * completed, or the PR merged/closed); `verdict` carries the reviewer wake-up
 * **verbatim and untyped**, because the point of `isPassingDiffReview` is that
 * it reads a payload it does not get to assume the shape of.
 */
export type DeferredRecheckTrigger = { kind: "ci" } | { kind: "verdict"; wakeup: unknown };

/**
 * Is this reviewer wake-up a diff review that passed?
 *
 * **The payload, and where these two fields actually come from.** A
 * `ReviewWakeup` (`src/review-runs.ts`) is built in `DiffReview.finish`
 * (`src/diff-review.ts`): `surface` is the literal `"review"` for a diff review
 * — the plan gate sends `"gate"` and the quality panel `"quality"` — and
 * `details` is the `DiffReviewResult` itself, whose `next` is
 * `nextAction(verdict)` (`src/gate.ts`) and whose `verdict.verdict` is the
 * `pass | revise | escalate` value that produced it. `pass` is the only verdict
 * `nextAction` maps to `proceed`, so the two agree by construction; both are
 * read here anyway, because a payload that disagrees with itself is not
 * evidence of a pass.
 *
 * **Every read is defensive and every failure is `false`.** The wake-up crosses
 * a transport boundary and reaches this function as `unknown`: a missing
 * `details`, a `details` that is null or a string, a `verdict` that is not an
 * object, a field of the wrong type — none of them throws, and none of them
 * re-gates anything. That is the fail-closed direction: a row that is not
 * released here is still deferred, still printed, and still re-gated by the
 * next `cp-ci` observation or by a `cp_status_block` render. Releasing one on a
 * payload nobody could read is the failure that has no second chance.
 */
export function isPassingDiffReview(wakeup: unknown): boolean {
	if (typeof wakeup !== "object" || wakeup === null) return false;
	const { surface, details } = wakeup as { surface?: unknown; details?: unknown };
	// The plan gate and the quality panel say nothing about a head's reviewedness.
	if (surface !== "review") return false;
	if (typeof details !== "object" || details === null) return false;
	const { next, verdict } = details as { next?: unknown; verdict?: unknown };
	// A `revise` moves the head rather than clearing it; `retry`/`surface` are not
	// a pass at all.
	if (next !== "proceed") return false;
	if (typeof verdict === "object" && verdict !== null) {
		const value = (verdict as { verdict?: unknown }).verdict;
		if (typeof value === "string" && value !== "pass") return false;
	}
	return true;
}

/** Does this event change a fact a deferred merge ask is waiting on? */
export function releasesDeferredAsks(trigger: DeferredRecheckTrigger): boolean {
	return trigger.kind === "ci" ? true : isPassingDiffReview(trigger.wakeup);
}

/**
 * Re-gate every deferred row and hand back the ones this event opened. An
 * irrelevant event does nothing at all — not even a read.
 */
export async function recheckDeferred(store: AwaitingStore, trigger: DeferredRecheckTrigger): Promise<AwaitingItem[]> {
	if (!releasesDeferredAsks(trigger)) return [];
	return (await store.reviewDeferred()).raised;
}

export interface BoundedRecheckOptions {
	/** Defaults to `DEFERRED_RECHECK_MAX_WAIT_MS`. */
	timeoutMs?: number;
	/** One bounded line, at most once per call: the bound was spent, or the re-gate failed. */
	onFailure?: (reason: string) => void;
	/**
	 * The rows a **late** re-gate opened — one that finished after the bound was
	 * already spent and its caller had moved on. Called at most once per call, and
	 * only with rows the gate really opened, so it is the same announcement the
	 * in-bound path makes, just later. Never called when the re-gate finished in
	 * time (the caller has the rows as the return value), and never called for a
	 * late failure or a late no-op.
	 */
	onLate?: (raised: AwaitingItem[]) => void;
}

/**
 * `recheckDeferred`, bounded and total: it never throws and never outlives
 * `timeoutMs`.
 *
 * On a throw, a rejection or a spent bound it resolves to `[]` and reports one
 * bounded line through `onFailure`, so the caller's own work — the `cp-ci`
 * notice and wake-up, the reviewer's `#send` and slot cleanup — carries on.
 *
 * **The deadline opens nothing, and it also cancels nothing.** There is no
 * cancellation to be had here: the work under the bound is a `gh` query and a
 * queued write, so "stop waiting" is all a deadline can mean. Two consequences,
 * and both are deliberate:
 *
 *  - **At the deadline no row is open and none is announced.** Only
 *    `AwaitingStore.reviewDeferred` opens a row, so a bound that is spent leaves
 *    every deferred row deferred — the fail-closed direction, a later ask rather
 *    than a wrong one.
 *  - **A late re-gate that *does* open rows is still evidence, so it is
 *    announced.** The slow query finishes, the gate opens the row on the same
 *    terms as ever (green on the current head, reviewed, not merged), and
 *    `onLate` carries exactly those rows to the caller's ordinary announcement
 *    path. Dropping them would mean a decision that became answerable and
 *    nobody was told — the defect this whole change exists to remove.
 *
 * A late *failure* is silent: the deadline already reported one bounded line and
 * a second would be a duplicate about the same call. It is still awaited rather
 * than abandoned — `attempt` is a promise that never rejects (the rejection is
 * mapped to a value), so no path here can produce an unhandled rejection.
 *
 * An irrelevant event still costs nothing at all — not a read, and not a timer.
 */
export async function recheckDeferredBounded(
	store: AwaitingStore,
	trigger: DeferredRecheckTrigger,
	options: BoundedRecheckOptions = {},
): Promise<AwaitingItem[]> {
	if (!releasesDeferredAsks(trigger)) return [];
	const ms = options.timeoutMs ?? DEFERRED_RECHECK_MAX_WAIT_MS;
	const attempt = recheckDeferred(store, trigger).then(
		(raised) => ({ raised }),
		(error: unknown) => ({ raised: [] as AwaitingItem[], reason: `deferred rows not re-gated: ${(error as Error).message}` }),
	);
	let timedOut = false;
	const outcome = await withDeadline(attempt, ms, () => {
		// Only the timeout branch reaches this: `attempt` never rejects, and
		// `withDeadline` calls `onTimeout` for a rejection too.
		timedOut = true;
		return {
			raised: [] as AwaitingItem[],
			reason: `deferred rows not re-gated: the re-gate did not finish within ${ms}ms`,
		};
	});
	if ("reason" in outcome && outcome.reason) report(options.onFailure, outcome.reason);
	if (timedOut) {
		// Exactly one continuation, attached exactly once, on a promise that cannot
		// reject: a late result is either announced or dropped, never thrown.
		void attempt.then((late) => {
			if ("reason" in late && late.reason) return;
			if (late.raised.length === 0) return;
			try {
				options.onLate?.(late.raised);
			} catch {
				// Announcing must never become a failure of its own.
			}
		});
	}
	return outcome.raised;
}

function report(onFailure: ((reason: string) => void) | undefined, reason: string): void {
	try {
		onFailure?.(reason);
	} catch {
		// Reporting a failure must never become one.
	}
}

/** One bounded operator-facing line. Never a table, never a body. */
export function formatRaisedNotice(raised: readonly AwaitingItem[]): string {
	const count = raised.length;
	const head = `${count} decision${count === 1 ? " is" : "s are"} now ready`;
	const decisions = raised.map((item) => item.decision.trim()).join(" · ");
	return `${head}: ${decisions} — answer with cp_decide`.slice(0, 300);
}
