/**
 * The settle boundary — one prompt between "finished" and "lost"
 * (cp-settle-without-report).
 *
 * The defect this exists to make impossible: five workers were dispatched in
 * parallel and left unattended. All five ran to completion — four committed,
 * pushed, opened PRs (#29–#32, every one green and rebased), the fifth wrote a
 * 19KB research artifact — and every one of them ended
 * `agent_end -> agent_settled` with no `report_result` call. The parent sleeps
 * on envelopes by design, so it slept for fourteen hours while four
 * merge-ready PRs sat untouched, and every one of those finished jobs was
 * recorded as `failed`.
 *
 * Two things were wrong, and they are separate:
 *
 *  1. **A missing report was fatal instead of recoverable.** A settled worker
 *     is idle, alive, and holding all of the job's context; its envelope slot
 *     is open (`reported=false`). Nothing asked it for the one tool call it
 *     owed. A settled agent will never report without another prompt — the
 *     gate module has known this since T20 ("a settled reviewer will never
 *     report without another prompt") and applied it only to reviewers.
 *  2. **Finished work was called `failed`.** `cp_send` refuses any job that is
 *     not live, so marking a job `failed` closed the one natural recovery path
 *     (promote the worker that is standing right there) at exactly the moment
 *     it was needed.
 *
 * So: on an unreported settle this **prompts the worker once**, records the
 * nudge as a fact, and leaves the job `waiting` — promotable, with an open
 * slot. If the next settle still has no envelope, the fact is recorded as a
 * fact (`cp:settled_without_report`, and a counter on the record that `/status`
 * and the status block render as `unreported`) and the worker is never
 * prompted again. One prompt, then the truth.
 *
 * What this is NOT: a poll. Every trigger here is an `agent_settled` event
 * from the worker's own stream, the same fact intake already wakes on. The
 * parent still sleeps on envelopes.
 *
 * ## cp-0dhw: unreported-with-work, recovered automatically and bounded
 *
 * One prompt then the truth was right for the incident above (four pushed,
 * green PRs: nothing was at risk but the envelope). It was not enough for the
 * shape that followed. In a single day, seven workers settled with the work
 * still **in the worktree** — modified and untracked files, up to 834
 * insertions across 12 files, three of them cut off mid-turn by provider
 * incidents. Every one was recovered by the parent noticing by hand, running
 * `git status` in the worktree, and sending a promote that said: *this is what
 * is on disk, do not redo it, commit it, push it, report.*
 *
 * So the settle boundary now does three things instead of one:
 *
 *  1. **It looks.** `inspectWorktreeWork` (read-only git) classifies the
 *     worktree as `clean`, `dirty`, `unpushed` or `unknown`, and the result is
 *     written to the fleet record as `unreported_work` — a fact, not a log
 *     line, so `/status`, `/watch` and the wake-up all read one observation.
 *  2. **It acts, with evidence.** When there is work, the prompt carries the
 *     file list, the counts and whether origin has the branch, and asks for
 *     exactly the mechanical finish: commit, push, verify, report once.
 *  3. **It stops.** `MAX_RECOVERY_PROMPTS` attempts per generation, counted on
 *     the same `unreported_settles` counter that already exists (on disk, so a
 *     parent restart cannot hand out a fresh budget), and then never again for
 *     that generation: the fact is recorded with its evidence and a human
 *     decides. The operator's constraint was explicit — automatic recovery must
 *     not burn tokens indefinitely when the problem persists.
 *
 * Three things it must never do, and each is enforced above rather than
 * remembered: prompt a job that **has reported** (the cp-rud loop — read the
 * same `reported_at` the accept path writes, plus the envelope on disk), prompt
 * a job whose **delivery landed** (a merge receipt or a `done` job), and prompt
 * a job that is **mid-tool-call** (wedged and unreported are mutually exclusive
 * by construction, cp-m44c — this keeps it that way). And nothing in this path
 * ever deletes, resets or cleans a worktree: the work on disk is the whole
 * reason the path exists.
 *
 * ## cp-0wq7: a settle that follows a model call that never happened
 *
 * There is one settle this boundary must NOT prompt. When the model call
 * itself fails — an invalid API key, an unroutable model — pi still starts the
 * agent loop, still emits `turn_start`/`message_start`, and still settles; the
 * assistant message just comes back `stopReason: "error"` with zero tokens.
 * Four workers went through this path in one session and every prompt aimed at
 * them (the nudge, then a revive, then a hand-written promote) produced another
 * two-second, zero-token settle, because a prompt cannot fix a credential.
 *
 * So the boundary looks at the run log first. A run with an errored model call
 * and **nothing else at all** — no assistant text, no tool call — is not
 * unreported: it is `model_call_failed`, and it is recorded as a failure with
 * the provider's own words, on the spot, with no prompt sent. That is the
 * fail-closed answer the DOA shape was missing: `/status` says failed with a
 * cause instead of `unreported`, which nobody could act on.
 */

import { join } from "node:path";
import {
	describeUnreportedWork,
	type EnvelopeCorrection,
	type Failure,
	type FleetRecord,
	isoTimestamp,
	paths,
	type RunStatus,
	type SendReceipt,
	type UnreportedWork,
	unreportedWorkPresent,
} from "./contracts.ts";
import type { FailJob } from "./failure-announcer.ts";
import { detectDeadModelCall, type ModelCallError } from "./failures.ts";
import { type FleetStore, hasEnvelopeOnDisk } from "./fleet.ts";
import type { EnvelopeIntake } from "./intake.ts";
import { readMergeReceipt } from "./merges.ts";
import { LIVE_PHASES } from "./preflight.ts";
import { readEventLog, readStatusFile } from "./run-artifacts.ts";
import type { RunRegistry } from "./runs.ts";
import type { WorkerEvent } from "./worker-process.ts";
import { inspectWorktreeWork } from "./worktree-work.ts";

/** How many unreported settles a brief gets before the nudge stops. */
export const MAX_REPORT_NUDGES = 1;

/**
 * How many automatic recovery prompts a generation gets when work is observed
 * on disk (cp-0dhw). Two, and the second one says it is the last: a recovery
 * that is interrupted by the same provider incident that caused the silence is
 * the common case (three of the seven), and one retry costs a short prompt
 * where losing the work costs the whole job. Three would be a loop.
 */
export const MAX_RECOVERY_PROMPTS = 2;

/**
 * The nudge itself. Deliberately short, deliberately imperative, and it names
 * the one legal shape of the answer: the worker is not being asked whether it
 * is finished, it is being told that finishing means reporting. `blocked` is
 * offered as a first-class outcome so a worker that genuinely cannot finish
 * has somewhere to go other than silence.
 */
export const REPORT_NUDGE_TEXT = [
	"You have stopped without calling report_result. Your work does not reach the operator until you do:",
	"the parent wakes on envelopes, and there is no other channel — a pushed branch, an open PR and a written",
	"artifact are all invisible to it until an envelope is filed.",
	"",
	"Call report_result now, exactly once, as your only remaining action:",
	'  - status "done" with the summary of what you delivered (and pr_url for delivery: pr), or',
	'  - status "blocked" with concrete blockers if the work is not finished.',
	"",
	"Do not redo the work, do not re-verify, do not push again. If the work is complete, report it as done;",
	"if it is not, report it as blocked. This is the only prompt you get: after it the job is recorded as",
	"having finished without reporting, and a human has to reconstruct what you did.",
].join("\n");

/**
 * The automatic recovery prompt (cp-0dhw), built from what is actually on disk.
 *
 * Shaped after the seven hand-written promotes that worked: evidence first, one
 * mechanical instruction list, and an explicit ban on redoing or re-analysing
 * anything. It is deliberately not a re-brief — the worker still holds the
 * job's context, and re-describing the task is exactly the token cost the
 * operator's bound exists to avoid.
 */
export function recoveryPromptText(
	record: Pick<FleetRecord, "job_id" | "branch" | "worktree" | "delivery">,
	work: UnreportedWork,
	attempt: number,
): string {
	const shown = work.files.map((file) => `    - ${file}`);
	const more = work.file_count - work.files.length;
	if (more > 0) shown.push(`    - … ${more} more file(s)`);
	const origin =
		work.branch_on_origin === undefined
			? "origin could not be asked about the branch"
			: work.branch_on_origin
				? `origin has ${record.branch}`
				: `origin does NOT have ${record.branch} yet`;
	const last = attempt >= MAX_RECOVERY_PROMPTS;
	return [
		`You stopped without calling report_result, and your work is still sitting in the worktree, uncommitted or unpushed.`,
		`Do NOT redo it, do NOT re-analyse it, do NOT start anything new. It is already there.`,
		"",
		`What the parent observed in ${record.worktree} at ${work.observed_at}:`,
		`  branch ${record.branch}; ${origin}`,
		`  ${describeUnreportedWork(work)}`,
		...(shown.length > 0 ? ["  uncommitted paths:", ...shown] : []),
		"",
		"Finish the delivery from exactly that state, and nothing more:",
		`  1. commit what is there on branch ${record.branch} (git add -A, then git commit -F <file> or -m "…"; never a detached HEAD).`,
		"  2. push it (git push, or --force-with-lease if you rebased), then verify: git status --porcelain empty, git rev-parse HEAD.",
		`  3. call report_result exactly once — status "done" with head_sha (and the PR url for delivery: ${record.delivery}),`,
		'     or status "blocked" with the exact command and error that stopped you.',
		"",
		last
			? `This is automatic recovery attempt ${attempt} of ${MAX_RECOVERY_PROMPTS}, and the last one: after it no further prompt is sent, the job is recorded as unreported-with-work, and a human has to reconstruct it by hand.`
			: `This is automatic recovery attempt ${attempt} of ${MAX_RECOVERY_PROMPTS}. Nothing has been deleted and nothing will be: the worktree is untouched.`,
	].join("\n");
}

/**
 * The prompt for a worker whose report was REFUSED, not missing
 * (pi-command-post-uad).
 *
 * The nudge above says "you stopped without calling report_result", which is
 * false here and dangerous: the generation has exactly one correction, and a
 * worker told only to report again spends it re-filing the same invalid
 * envelope. So this names the reason intake gave and the bound.
 */
export function correctionPromptText(correction: EnvelopeCorrection): string {
	return [
		"Your report_result was REFUSED by the command post: it never reached the operator, and the record you filed",
		`has been quarantined (kept, not deleted) at ${correction.quarantined}.`,
		"",
		`Reason it was refused: ${correction.reason}`,
		"",
		"The report slot is open again for exactly ONE corrected report. Do not redo the work, do not re-verify it and",
		"do not start anything new: fix only what that reason names — if it names an artifact path, either write that",
		"file or leave artifact_path out — and call report_result once with the corrected envelope.",
		"",
		"A second refusal of this report cannot be corrected: the job is recorded as failed and a human has to",
		"reconstruct what you did.",
	].join("\n");
}

/**
 * The correction slot this job's CURRENT generation has open: an unstamped
 * refusal it has not answered yet. Generation-stamped on purpose — a
 * correction recorded before a promote belongs to the generation it refused,
 * and must never speak for this one.
 */
export function openCorrection(record: FleetRecord): EnvelopeCorrection | undefined {
	const correction = record.envelope_correction;
	if (!correction || record.reported_at !== undefined) return undefined;
	return correction.generation === (record.supersessions ?? 0) + 1 ? correction : undefined;
}

/**
 * The slice of `WorkerProcess` this module uses. Narrow on purpose: a test
 * needs a stub with two methods, not a child process — and a real
 * `WorkerProcess` satisfies it structurally.
 */
export interface NudgeableWorker {
	readonly alive: boolean;
	send(
		message: string,
		mode?: "prompt" | "steer" | "follow_up",
	): Promise<{ receipt: SendReceipt; error?: string }>;
	onEvent(listener: (event: WorkerEvent) => void): () => void;
}

/** What one unreported settle produced. Every branch is observable. */
export type SettleOutcome =
	/** An envelope is filed for the live generation: nothing to do. */
	| { action: "reported" }
	/** Not this module's business (no record, terminal phase, gate slot, ...). */
	| { action: "ignored"; reason: string }
	/**
	 * The worker was prompted: `report` is the bare nudge (nothing on disk to
	 * recover), `recovery` carries the worktree evidence (cp-0dhw).
	 */
	| {
			action: "nudged";
			settles: number;
			receipt: SendReceipt;
			/** `correction`: intake refused the filed envelope (pi-command-post-uad). */
			prompt: "report" | "recovery" | "correction";
			work?: UnreportedWork;
	  }
	/**
	 * The prompt budget is spent (or undeliverable): recorded, not repeated.
	 * `reason` is the evidence the record was made on — it travels so the
	 * operator's one line names a cause instead of a category
	 * (pi-command-post-3ip).
	 */
	| { action: "recorded"; settles: number; failure?: Failure; work?: UnreportedWork; reason?: string };

export interface SettleWatcherOptions {
	fleet: FleetStore;
	/** The only failed transition. Journals the durable wake-up. */
	fail: FailJob;
	runs: RunRegistry;
	/**
	 * Consulted first, and idempotent: an envelope may already be on disk when
	 * the settle arrives (the worker writes it, then the run settles). Asking
	 * intake is how "did it report?" stays a fact rather than a race.
	 */
	intake?: EnvelopeIntake;
	now?: () => Date;
	/** Called once per settle that produced a nudge or a recorded fact. */
	onUnreported?: (jobId: string, outcome: SettleOutcome) => void;
	/**
	 * How the worktree is observed (cp-0dhw). Injected so the settle boundary is
	 * testable without a git repo; the default is read-only git in the job's own
	 * leased worktree. It never throws: a failed observation is `unknown`, and
	 * `unknown` never produces a prompt.
	 */
	inspect?: (record: FleetRecord) => Promise<UnreportedWork>;
	/**
	 * Stops and unregisters the worker after a model-call failure (cp-mub7),
	 * the same step the bound path takes after its `fail()`. Without it the
	 * failed job keeps a registered idle `pi`, `cp_revive` refuses it as
	 * `worker_already_live` and `cp_send` refuses it as failed.
	 */
	shutdown?: (jobId: string) => Promise<void>;
}

/**
 * Watches workers for the one event that used to mean silent loss: a settle
 * with no envelope behind it.
 */
export class SettleWatcher {
	readonly #options: SettleWatcherOptions;
	/** Serialized per job: two settles must not race each other's counter. */
	readonly #inFlight = new Map<string, Promise<SettleOutcome>>();
	/**
	 * H1 review (finding 1): per-job "an outer provider retry already claimed
	 * this settle" checks, set by `watch`'s optional third argument. Consulted
	 * as the very first thing `#settled` does \u2014 before intake, before the
	 * dead-on-arrival check that would otherwise mark the job `model_call_failed`
	 * \u2014 so the same settle a pending retry owns is never also nudged for an
	 * unreported envelope or failed closed underneath it.
	 */
	readonly #retryPending = new Map<string, () => boolean>();
	/** cp-mub7: per-job "the outer ladder is spent on this settle" reads, set by `watch`'s fourth argument. */
	readonly #retryExhausted = new Map<string, () => string | undefined>();

	constructor(options: SettleWatcherOptions) {
		this.#options = options;
	}

	/**
	 * Attach to a worker's event stream. Returns a detach function. Nothing is
	 * polled and nothing is timed: `agent_settled` is a fact the worker reports
	 * about itself.
	 *
	 * `isRetryPending`, when given, is asked on every settle for this job before
	 * anything else: a `true` answer means command-post's own outer provider
	 * retry ladder (`src/provider-retry.ts`) already has this failure and this
	 * settle is not this watcher's business.
	 */
	watch(
		jobId: string,
		worker: NudgeableWorker,
		isRetryPending?: () => boolean,
		retryExhausted?: () => string | undefined,
	): () => void {
		if (isRetryPending) this.#retryPending.set(jobId, isRetryPending);
		if (retryExhausted) this.#retryExhausted.set(jobId, retryExhausted);
		const detach = worker.onEvent((event) => {
			if (event.type !== "agent_settled") return;
			void this.settled(jobId, worker).catch(() => {
				// A watcher that throws on a settle takes the listener down with it,
				// and the next settle would then be the silent one.
			});
		});
		// The listener and its retry guard are one attachment: detaching drops
		// both, or a stale predicate outlives the worker it was watching. A
		// later watch for the same job id replaces the entry, so only drop it
		// when it is still this watch's own predicate.
		return () => {
			detach();
			if (isRetryPending && this.#retryPending.get(jobId) === isRetryPending) this.#retryPending.delete(jobId);
			if (retryExhausted && this.#retryExhausted.get(jobId) === retryExhausted) this.#retryExhausted.delete(jobId);
		};
	}

	/** One settle, decided. Idempotent per job while a decision is in flight. */
	async settled(jobId: string, worker: NudgeableWorker): Promise<SettleOutcome> {
		const existing = this.#inFlight.get(jobId);
		if (existing) return existing;
		const promise = this.#settled(jobId, worker).finally(() => this.#inFlight.delete(jobId));
		this.#inFlight.set(jobId, promise);
		return promise;
	}

	async #settled(jobId: string, worker: NudgeableWorker): Promise<SettleOutcome> {
		// H1 review (finding 1): checked before anything else, including intake.
		// This settle is exactly the one a pending transient-failure retry is
		// driving; leaving it alone here is what keeps the nudge and the
		// dead-on-arrival classification from firing underneath that retry.
		const retryPending = this.#retryPending.get(jobId);
		// The guard lives as long as the worker can settle again: the outer
		// ladder re-arms `pending` on every transient failure, so an ordinary
		// settle must leave the entry in place for the next retry (H1 review,
		// finding 1). A worker that can settle no more is the one safe point to
		// drop it here; `watch`'s detach drops the rest.
		const retryExhausted = this.#retryExhausted.get(jobId);
		if (!worker.alive) {
			this.#retryPending.delete(jobId);
			this.#retryExhausted.delete(jobId);
		}
		if (retryPending?.()) {
			return this.#ignore(jobId, "an outer provider retry is pending for this settle");
		}
		const { fleet, runs } = this.#options;
		// The worker writes envelope.json and the run settles; both orders happen.

		// Intake is idempotent, so asking it here costs nothing and removes the
		// race entirely.
		await this.#options.intake?.intake(jobId).catch(() => undefined);

		const record = fleet.get(jobId);
		if (!record) return this.#ignore(jobId, "no fleet record (yet)");
		if (record.reported_at !== undefined) return { action: "reported" };

		// cp-rud: if intake failed (threw and was caught above) but the worker DID
		// write an envelope to disk, the job has reported — we just failed to stamp
		// the receipt. Retry intake once so the fleet and status files catch up.
		// Without this, a transient fleet.mutate failure caused the settle watcher
		// to fire cp-unreported for a job that had in fact reported.
		if (this.#options.intake && hasEnvelopeOnDisk(fleet.home, jobId)) {
			// pi-command-post-3ip: keep why it failed. "intake could not stamp the
			// receipt" named no cause, so the one line an operator had to act on told
			// them nothing about which of a contract violation, a missing artifact or a
			// failed write they were looking at.
			let why: string | undefined;
			try {
				why = (await this.#options.intake.intake(jobId)).failure?.message;
			} catch (error) {
				// Intake failed again on the retry.
				why = error instanceof Error ? error.message : String(error);
			}
			// Re-read: the retry may have stamped reported_at.
			const refreshed = fleet.get(jobId);
			if (refreshed?.reported_at !== undefined) return { action: "reported" };
			// Envelope exists but intake cannot process it — record but do not
			// nudge. A nudge would make the worker call report_result again, which
			// the worker-reporter would refuse ("already filed").
			return this.#record(
				jobId,
				(record.unreported_settles ?? 0) + 1,
				undefined,
				`${join(fleet.home, paths.envelopeFile(jobId))} exists but intake could not stamp the receipt` +
					`${why ? `: ${why}` : " (no reason recorded)"} — escalate, do not nudge: the work is on disk and a ` +
					"second report_result would be refused as already filed.",
			);
		}
		if (!LIVE_PHASES.includes(record.phase)) return this.#ignore(jobId, `phase ${record.phase}`);

		// cp-0dhw: a delivery that landed is never prompted. The work is off this
		// machine and merged; asking the worker to "commit and push what is there"
		// would be asking it to redo a job that no longer exists.
		const landed = deliveryLanded(fleet.home, record);
		if (landed) return this.#ignore(jobId, landed);

		// cp-0dhw/cp-m44c: never prompt a job that is mid-tool-call. A settle and an
		// open call cannot both be true of the same moment, so this only fires when
		// the projection has already moved on (the worker started a new turn between
		// the settle and this read) — and in that case the run is `working`, which is
		// wedged's territory, never unreported's.
		const run = readStatusFile(fleet.home, jobId);
		if (run?.phase === "working" && run.current_tool) {
			return this.#ignore(jobId, `the run is working again (${run.current_tool.name} in flight): not unreported`);
		}

		// cp-0wq7: before any prompt is composed, ask whether this worker can talk
		// to a model at all. A dead-on-arrival run is failed closed here, with the
		// provider's message, and never nudged: another prompt is another failed
		// call, and "unreported" is the wrong word for a job that never started.
		// The projection gates the log read — see `mayBeDeadOnArrival`.
		// cp-mub7: the outer ladder is spent on this very settle. A transient
		// provider error that outlived every retry is a failed model call whatever
		// the worker did before it: no nudge (it would only be one more failed
		// call), and the report budget is not touched. The worktree is kept.
		const exhausted = retryExhausted?.();
		if (exhausted) {
			return this.#failModelCall(jobId, (record.unreported_settles ?? 0) + 1, { message: exhausted.slice(0, 300) }, true);
		}
		if (mayBeDeadOnArrival(run)) {
			const dead = detectDeadModelCall(readEventLog(fleet.home, jobId));
			if (dead) return this.#failModelCall(jobId, (record.unreported_settles ?? 0) + 1, dead, false);
		}

		// The observation, before anything is sent: the prompt is built from it and
		// the bound depends on it.
		const work = await this.#inspect(record);
		const settles = (record.unreported_settles ?? 0) + 1;
		// One patch, both facts: the counter that bounds the recovery and the
		// evidence that justifies it are read together by everything downstream.
		await fleet.patch(jobId, { unreported_settles: settles, unreported_work: work });

		const hasWork = unreportedWorkPresent(work);
		const bound = hasWork ? MAX_RECOVERY_PROMPTS : MAX_REPORT_NUDGES;
		if (settles > bound) {
			return this.#record(
				jobId,
				settles,
				work,
				hasWork
					? `automatic recovery is spent (${bound} prompt(s)) and the work is still on disk`
					: "the nudge to report was already spent",
			);
		}
		if (!worker.alive) {
			// Nothing to prompt. The observed close is classified by FailureMonitor;
			// this records the settle itself so the run log says which of the two
			// happened first.
			return this.#record(jobId, settles, work, "the worker was gone before it could be prompted");
		}

		// pi-command-post-uad: an open correction slot means this worker DID report
		// and intake refused it. Telling it to "call report_result, you never did"
		// would spend the generation's one correction on the same invalid envelope,
		// so the refusal reason is what it gets instead.
		const correction = openCorrection(record);
		const text = correction
			? correctionPromptText(correction)
			: hasWork
				? recoveryPromptText(record, work, settles)
				: REPORT_NUDGE_TEXT;
		const outcome = await worker.send(text, "prompt");
		runs.open(jobId).cp(hasWork && !correction ? "recovery_prompted" : "report_nudged", {
			receipt: outcome.receipt,
			settles,
			bytes: text.length,
			...(correction ? { correction: correction.generation, quarantined: correction.quarantined } : {}),
			...(hasWork && !correction ? { attempt: settles, of: MAX_RECOVERY_PROMPTS, work } : {}),
			...(outcome.error ? { error: outcome.error } : {}),
		});
		if (outcome.receipt === "failed") {
			return this.#record(
				jobId,
				settles,
				work,
				`the ${hasWork ? "recovery prompt" : "nudge"} could not be delivered: ${outcome.error ?? "unknown error"}`,
			);
		}
		const nudged: SettleOutcome = {
			action: "nudged",
			settles,
			receipt: outcome.receipt,
			prompt: correction ? "correction" : hasWork ? "recovery" : "report",
			...(hasWork ? { work } : {}),
		};
		this.#options.onUnreported?.(jobId, nudged);
		return nudged;
	}

	/** Never throws, and never modifies: a failed look is `unknown`. */
	async #inspect(record: FleetRecord): Promise<UnreportedWork> {
		const inspect =
			this.#options.inspect ?? ((job: FleetRecord) => inspectWorktreeWork(job.worktree, job.branch));
		try {
			return await inspect(record);
		} catch (error) {
			return {
				state: "unknown",
				files: [],
				file_count: 0,
				commits_ahead: 0,
				observed_at: isoTimestamp((this.#options.now ?? (() => new Date()))()),
				reason: `the worktree could not be observed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	#ignore(jobId: string, reason: string): SettleOutcome {
		return { action: "ignored", reason: `${jobId}: ${reason}` };
	}

	/**
	 * A worker that cannot reach its model is failed, not prompted (cp-0wq7).
	 *
	 * This is the one place the settle boundary marks a job `failed`, and the
	 * reason it may is the exact inverse of why it must not for an ordinary
	 * unreported settle: there is no delivery to look at, no branch to inspect and
	 * no worker worth promoting — 0 tokens, 0 tool calls, and a provider error in
	 * the log. Leaving it `waiting` is what made four such jobs look like they
	 * were still owed an envelope.
	 */
	async #failModelCall(jobId: string, settles: number, error: ModelCallError, retryExhausted: boolean): Promise<SettleOutcome> {
		const at = isoTimestamp((this.#options.now ?? (() => new Date()))());
		const where = [error.provider, error.model].filter(Boolean).join("/");
		const failure: Failure = {
			class: "model_call_failed",
			message: retryExhausted
				? `the provider kept failing after the outer retry ladder was spent: ${error.message} — ` +
					"not nudged: another prompt is another failed call. The worktree and session are kept; once the provider " +
					`recovers, continue it with cp_revive ${jobId} continue_failed:true.`
				: `the model call failed and the worker never ran a turn: ${error.message}${where ? ` (${where})` : ""} — ` +
					"no assistant output, no tool calls, no delivery. Not nudged: a prompt cannot fix a credential or a " +
					"routed model. Fix it, then re-dispatch.",
			at,
		};
		const recorder = this.#options.runs.open(jobId);
		recorder.markFailure(failure);
		await this.#options.fail(jobId, failure);
		const outcome: SettleOutcome = {
			action: "recorded",
			settles,
			failure,
			...(retryExhausted ? { reason: "outer provider retry exhausted" } : {}),
		};
		this.#options.onUnreported?.(jobId, outcome);
		// cp-mub7: the bound path's second half (src/bounds.ts). A failed job must
		// not keep a registered worker: that is what made cp_revive answer
		// worker_already_live while cp_send answered "failed, use cp_revive".
		await this.#options.shutdown?.(jobId);
		return outcome;
	}

	/**
	 * Record the fact and stop. The job is **not** marked `failed`: its worker
	 * may still be idle and alive with an open envelope slot, and `cp_send`
	 * refuses anything that is not live — calling finished work failed is what
	 * closed the recovery path in the first place. The counter on the record is
	 * what `/status` and the status block render as `unreported`.
	 */
	async #record(jobId: string, settles: number, work: UnreportedWork | undefined, why: string): Promise<SettleOutcome> {
		const at = isoTimestamp((this.#options.now ?? (() => new Date()))());
		const recorder = this.#options.runs.open(jobId);
		recorder.cp("settled_without_report", { settles, reason: why, at, ...(work ? { work } : {}) });
		// cp-0dhw: the bound is spent and there is work on disk. Its own event, so
		// the one line a human has to act on is not buried in a generic record.
		if (unreportedWorkPresent(work) && settles > MAX_RECOVERY_PROMPTS) {
			recorder.cp("recovery_exhausted", { settles, attempts: MAX_RECOVERY_PROMPTS, work: work as UnreportedWork, at });
		}
		const outcome: SettleOutcome = { action: "recorded", settles, reason: why, ...(work ? { work } : {}) };
		this.#options.onUnreported?.(jobId, outcome);
		return outcome;
	}
}

/**
 * Could this run be dead on arrival at all? Cheap, and asked of the projection
 * `status.json` that this boundary has already read (cp-0wq7).
 *
 * `detectDeadModelCall` parses the whole of `events.jsonl`, and a long job's log
 * is megabytes: doing that on every settle of every job would put a full parse
 * of the largest file the fleet writes in front of every nudge. It never has to.
 * A dead-on-arrival run produced **nothing** — no tokens and no tool calls — and
 * the projection already knows both numbers, so a run that did any work at all
 * skips the read entirely. The logs that are still parsed are the ones belonging
 * to runs that emitted a handful of events and stopped: tiny, by construction.
 *
 * A missing or unreadable projection answers `true`: this gate exists to save
 * work, never to decide the question, and ignorance must not hide a failure.
 */
export function mayBeDeadOnArrival(run: RunStatus | undefined): boolean {
	if (!run) return true;
	return run.usage.total_tokens === 0 && run.tool_calls === 0;
}

/**
 * Has this job's delivery already landed? Read from evidence only: a merge
 * receipt (`cp_merged`, written from what GitHub itself reported) or a `merged`
 * PR receipt on the record. A `done` job is included because teardown means the
 * lease is gone — there is no worktree left to recover from.
 */
function deliveryLanded(home: string, record: FleetRecord): string | undefined {
	if (record.phase === "done") return "the job is done: its delivery landed and its lease was returned";
	if (readMergeReceipt(home, record.job_id)) return "a merge receipt says this job's PR merged: nothing to recover";
	const merged = record.receipts?.some((receipt) => receipt.kind === "pr" && receipt.status.toLowerCase() === "merged");
	return merged ? "the PR receipt says merged: nothing to recover" : undefined;
}

/**
 * One operator line for a settle that produced no envelope. Never a body: the
 * summary that would have travelled is exactly the thing that was not written.
 */
export function formatSettleOutcome(jobId: string, outcome: SettleOutcome): string | undefined {
	if (outcome.action === "nudged") {
		if (outcome.prompt === "recovery" && outcome.work) {
			return (
				`${jobId}: settled without filing an envelope, with work still on disk (${describeUnreportedWork(outcome.work)}) — ` +
				`automatically prompted to commit, push and report (attempt ${outcome.settles} of ${MAX_RECOVERY_PROMPTS}, ${outcome.receipt}).`
			);
		}
		return `${jobId}: settled without filing an envelope — prompted once to call report_result (${outcome.receipt}).`;
	}
	if (outcome.action === "recorded") {
		if (outcome.failure?.class === "model_call_failed" && outcome.reason) {
			return (
				`${jobId}: model call failed — ${outcome.failure.message}\n` +
				"The job is marked failed and its worker stopped; no report nudge was sent. Work on disk is kept."
			);
		}
		if (outcome.failure?.class === "model_call_failed") {
			return (
				`${jobId}: dead on arrival — ${outcome.failure.message}\n` +
				"The job is marked failed with that cause; no prompt was sent, because another one would only repeat the " +
				"failed call. Tear it down and re-dispatch once the credential or the routed model is fixed."
			);
		}
		if (unreportedWorkPresent(outcome.work) && outcome.work) {
			return (
				`${jobId}: settled ${outcome.settles}x without filing an envelope and the work is STILL on disk (${describeUnreportedWork(outcome.work)}).\n` +
				`Automatic recovery is spent (${MAX_RECOVERY_PROMPTS} prompt(s)); nothing was deleted and the worktree is intact.\n` +
				`Decide: promote it (cp_send ${jobId}) with what to do, or tear it down — never re-dispatch the brief blind.`
			);
		}
		return (
			`${jobId}: settled ${outcome.settles} time(s) without filing an envelope. The work may be complete — ` +
			`check the branch and any PR, then promote it (cp_send ${jobId}) or tear it down. It is not a failure and it is not reported.` +
			// The cause, when there is one: an envelope that exists but cannot be
			// stamped is a different problem from a worker that filed nothing, and the
			// two used to read identically (pi-command-post-3ip).
			`${outcome.reason ? `\n  ${outcome.reason}` : ""}`
		);
	}
	return undefined;
}
