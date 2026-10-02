/**
 * H1 (Pier 2.6): command-post's own outer retry ladder, above pi's own.
 *
 * pi already retries a transient provider failure on its own agent-level
 * ladder (`retry.maxRetries`/`retry.baseDelayMs`, default 3 attempts at a 2 s
 * base — see docs/settings.md "Network and retries"). That setting has no
 * reachable CLI flag or env var for a `--no-approve` worker or the no-trust
 * parent bridge (H1 research, see the job's artifact): it lives only in
 * `settings.json`, which project trust gates and workers never load
 * (`WORKER_REQUIRED_FLAGS` in src/contracts.ts). So this ladder sits ABOVE
 * pi's own, driven entirely from this process over the same RPC channel pi
 * already answers — no pi setting is touched.
 *
 * When pi's own ladder gives up, the failing turn's final assistant message
 * carries `stopReason: "error"` (`readModelCallError`, src/failures.ts) — this
 * is exactly the shape `auto_retry_end` with `success:false` produces one
 * settle later. This module watches for that shape on `agent_settled`, and
 * only when the message reads as a *transient* provider failure (overloaded,
 * rate limit, 5xx, network) rather than quota, a usage limit, or a credential
 * problem: those are never worth retrying with the same call.
 *
 * A retry never repeats the original brief — it sends `RESUME_NUDGE`, a short
 * "continue where you left off" prompt, into the SAME session pi already has
 * loaded. Repeating the brief on a turn that died mid-way would repeat
 * actions (edits, commands, tool calls) it already took.
 */

import { readModelCallError } from "./failures.ts";
import type { RunEvent } from "./contracts.ts";
import type { RunRecorder } from "./run-artifacts.ts";
import type { WorkerEvent, WorkerProcess } from "./worker-process.ts";

/**
 * Delays between outer-ladder attempts, in order: 5 + 10 + 20 + 40 + 80 = 155 s
 * total, doubling from a 5 s base. Chosen to comfortably outlast a short
 * provider blip or rate-limit window once pi's own inner ladder (3 attempts,
 * ~2s/4s/8s) has already given up on it. One named constant: change the
 * policy here, nowhere else.
 */
export const OUTER_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 10_000, 20_000, 40_000, 80_000]);

/** How many outer-ladder attempts one failure gets. */
export const MAX_OUTER_RETRIES = OUTER_RETRY_DELAYS_MS.length;

/**
 * Sent instead of the original brief. Never re-sends the task: a resumed turn
 * must not repeat tool calls / edits / commands the dead turn already made.
 */
export const RESUME_NUDGE =
	"The previous turn failed with a transient provider error. Continue where you left off — " +
	"do not repeat the original task or brief, and do not redo actions you already completed.";

/**
 * Provider-error text that is worth retrying: connectivity and capacity
 * problems the same call is likely to succeed at shortly. Deliberately does
 * NOT match quota, usage-limit, billing, or credential/auth errors — those
 * fail the same way every time and retrying only burns the ladder for
 * nothing (docs/settings.md's own advice about provider retries applies here
 * too: they can delay handling a quota/usage-limit error).
 */
const TRANSIENT_PATTERN = /\b(overloaded|rate.?limit(?:ed)?|429|5\d{2}\b|timed?.?out|timeout|network|econnreset|econnrefused|socket|gateway|unavailable|reset by peer|temporarily)\b/i;
const NEVER_RETRY_PATTERN = /\b(quota|usage.?limit|insufficient.?(credit|balance|quota)|unauthorized|invalid.?api.?key|forbidden|401|403|billing|authentication)\b/i;

/** True only for provider-error text this ladder should retry. */
export function isTransientProviderError(message: string): boolean {
	if (NEVER_RETRY_PATTERN.test(message)) return false;
	return TRANSIENT_PATTERN.test(message);
}

export interface OuterRetryOptions {
	jobId: string;
	worker: WorkerProcess;
	recorder: RunRecorder;
}

function toRunEvent(jobId: string, event: WorkerEvent): RunEvent {
	// SAFETY: mirrors RunRecorder.pi() (src/run-artifacts.ts), which persists a
	// raw WorkerEvent verbatim as a RunEvent's payload — readModelCallError reads
	// `payload.message`, which is exactly `event.message` on a message_end event.
	return {
		ts: new Date().toISOString(),
		job_id: jobId,
		source: "pi",
		type: "message_end",
		payload: event as unknown as Record<string, unknown>,
	} as RunEvent;
}

/** What `watchOuterProviderRetry` returns: a detach function, and a live read of whether a retry is currently claimed for this settle. */
export interface OuterRetryHandle {
	detach(): void;
	/**
	 * True from the moment a transient failure is accepted onto the ladder
	 * (set on the failing `message_end`, BEFORE the `agent_settled` that
	 * follows it) until that attempt is resolved — a later success, a
	 * non-transient error, or the ladder's own cap. `attachWorkerObservers`
	 * hands this to `SettleWatcher` so the same settle that feeds this ladder
	 * cannot also be nudged for an unreported envelope or classified
	 * `model_call_failed` out from under a retry that is already in flight
	 * (cp-h1-outer-retry-races). Deciding this at `message_end` — a strictly
	 * earlier event than `agent_settled` — makes the answer correct regardless
	 * of which listener a given `WorkerProcess` happens to call first for the
	 * settle itself.
	 */
	isPending(): boolean;
	/**
	 * The transient provider error this settle carries when the ladder is
	 * already spent (cp-mub7), else undefined. Decided on the failing
	 * `message_end`, like `isPending`, so `SettleWatcher` reads it as a fact:
	 * a 503 that outlived every retry is a failed model call, never an
	 * unreported settle to nudge.
	 */
	exhaustedError(): string | undefined;
}

/**
 * Watch one worker's live event stream for pi's inner ladder giving up on a
 * transient provider failure, and drive command-post's own outer ladder over
 * it: a resume nudge on each attempt, journaled either way, capped at
 * `MAX_OUTER_RETRIES`, stopping at the first turn that comes back clean.
 *
 * Safe to call alongside `attachWorkerObservers` — this only reads events and
 * calls `worker.send`, it never touches the envelope/settle/failure wiring
 * those own; `isPending()` is exactly the seam that keeps it that way.
 */
export function watchOuterProviderRetry(options: OuterRetryOptions): OuterRetryHandle {
	const { jobId, worker, recorder } = options;
	let attempts = 0;
	let retrying = false;
	let pending = false;
	let detached = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastError: string | undefined;
	let exhausted: string | undefined;

	const off = worker.onEvent((event) => {
		if (detached) return;
		if (event.type === "agent_start") {
			lastError = undefined;
			exhausted = undefined;
			return;
		}
		if (event.type === "message_end") {
			const message = (event as { message?: { role?: unknown } }).message;
			if (!message || message.role !== "assistant") return;
			const modelError = readModelCallError(toRunEvent(jobId, event));
			lastError = modelError?.message;
			// Decided here, before `agent_settled` fires at all (see `OuterRetryHandle.isPending`).
			const transient = lastError !== undefined && isTransientProviderError(lastError);
			pending = transient && attempts < MAX_OUTER_RETRIES;
			exhausted = transient && attempts >= MAX_OUTER_RETRIES ? lastError : undefined;
			return;
		}
		if (event.type !== "agent_settled") return;
		if (retrying) return; // one outer attempt in flight at a time
		if (!lastError) {
			if (attempts > 0) {
				recorder.cp("outer_retry_succeeded", { afterAttempts: attempts });
				attempts = 0;
			}
			pending = false;
			return;
		}
		const message = lastError;
		if (!isTransientProviderError(message)) {
			pending = false; // quota/auth/unknown: leave for ordinary failure handling
			return;
		}
		if (attempts >= MAX_OUTER_RETRIES) {
			recorder.cp("outer_retry_exhausted", { attempts, message });
			pending = false; // the ladder is spent: this settle is ordinary failure handling's now
			return;
		}
		if (!worker.alive) {
			pending = false;
			return;
		}
		attempts += 1;
		const delayMs = OUTER_RETRY_DELAYS_MS[attempts - 1] as number;
		recorder.cp("outer_retry_attempt", { attempt: attempts, delayMs, message });
		retrying = true;
		// `pending` stays true across the wait: set already, above, on this same
		// failing `message_end` — nothing here needs to touch it again until the
		// resumed turn's own `message_end`/`agent_settled` decide the next state.
		timer = setTimeout(() => {
			timer = undefined;
			retrying = false;
			if (detached || !worker.alive) {
				pending = false;
				return;
			}
			void worker.send(RESUME_NUDGE, "prompt").then((result) => {
				// H1 review (finding 4): a refused nudge must stop the ladder visibly,
				// not leave it silently stalled waiting for a settle that will never
				// come. The events log carries the same shape `outer_retry_exhausted`
				// already uses, so a reader never has to learn a second failure shape.
				if (result.receipt === "failed") {
					recorder.cp("outer_retry_exhausted", {
						attempts,
						message: `resume nudge undeliverable: ${result.error ?? "unknown error"}`,
					});
					pending = false;
				}
			});
		}, delayMs);
	});

	return {
		detach: () => {
			detached = true;
			off();
			if (timer) clearTimeout(timer);
		},
		isPending: () => pending,
		exhaustedError: () => exhausted,
	};
}
