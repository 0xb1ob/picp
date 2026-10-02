/**
 * Failure taxonomy, budgets, and the bounded recovery ladder.
 *
 * Three separate jobs, deliberately not blended:
 *
 *  1. **Classify** — read the run's event log and name what happened
 *     (`classifyRun`). Classification is evidence-driven: every class points at
 *     the events that produced it, and "nothing conclusive" is a legal answer.
 *  2. **Budget** — accumulate usage from the projection, warn once at
 *     `warn_ratio`, and escalate on breach. A breach **never** kills a worker:
 *     killing mid-edit is how you lose work, and the operator is the one who
 *     decides whether the job is worth more money.
 *  3. **Recover** — decide what may be done about a classified failure
 *     (`decideRecovery`). Bounded by class, by role, and by attempt count.
 *
 * Ported rules that are now code:
 *  - an implementer crash may be re-dispatched with the same brief;
 *  - a research job is **never** re-run because an implementation failed —
 *    findings are not the thing that broke;
 *  - `tool_loop`, `budget_exceeded` and `spawn_failed` are not retried at all;
 *  - provider limits retry the same model first, then a fallback, then surface.
 */

import type { FailJob, FailRecoveryFact } from "./failure-announcer.ts";
import type { FleetStore } from "./fleet.ts";
import type { EnvelopeIntake } from "./intake.ts";
import { readEventLog, rebuildStatus } from "./run-artifacts.ts";
import type { RunRegistry } from "./runs.ts";
import type { WorkerProcess } from "./worker-process.ts";
import {
	type BudgetConfig,
	DEFAULT_BUDGET_CONFIG,
	type Failure,
	type FailureClass,
	FAILURE_RECOVERABLE,
	isoTimestamp,
	type Role,
	type RunEvent,
	type Usage,
} from "./contracts.ts";

/** Identical tool calls in a row before we call it a loop. */
export const TOOL_LOOP_THRESHOLD = 6;
/** Silence past this is a timeout, when the worker is supposed to be working. */
export const DEFAULT_INACTIVITY_MS = 15 * 60_000;
/** How many times a recoverable class may be retried for one job. */
export const MAX_RECOVERY_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface Classification {
	class: FailureClass;
	message: string;
	/** Event types (and seq) that produced this verdict. */
	evidence: string[];
}

export interface ClassifyOptions {
	/** Now, for the inactivity check. */
	now?: Date;
	inactivityMs?: number;
	/** A worker we can still see alive; suppresses `crash`/`timeout` guesses. */
	alive?: boolean;
	toolLoopThreshold?: number;
}

/**
 * A model call that came back an error instead of a turn (cp-0wq7).
 *
 * pi reports it on the assistant message itself: `stopReason: "error"`, empty
 * `content`, zero usage, and the provider's own words in `errorMessage`
 * ("401 Invalid API key"). The agent loop then settles normally, which is why
 * nothing downstream could tell this apart from a worker that simply chose to
 * stop — the turn *looks* complete.
 */
export interface ModelCallError {
	/** The provider's message, trimmed and bounded. Never invented. */
	message: string;
	provider?: string;
	model?: string;
}

/** Keep a provider's error readable inside `Failure.message`'s 2000-char bound. */
const MODEL_ERROR_MAX_CHARS = 300;

/**
 * Read a model-call error off one event, or answer `undefined`. Pure, and
 * deliberately narrow: only an **assistant** message that pi itself marked
 * `stopReason: "error"` counts. A tool result mentioning a 401, an assistant
 * message that merely talks about errors, and a user message are all not this.
 */
export function readModelCallError(event: RunEvent): ModelCallError | undefined {
	if (event.source !== "pi") return undefined;
	if (event.type !== "message_end" && event.type !== "turn_end") return undefined;
	const payload = (event.payload ?? {}) as { message?: unknown };
	const message = payload.message as
		| { role?: unknown; stopReason?: unknown; errorMessage?: unknown; provider?: unknown; model?: unknown }
		| undefined;
	if (!message || message.role !== "assistant" || message.stopReason !== "error") return undefined;
	const text = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	return {
		message: text.length > 0 ? text.slice(0, MODEL_ERROR_MAX_CHARS) : "the provider returned an error with no message",
		...(typeof message.provider === "string" ? { provider: message.provider } : {}),
		...(typeof message.model === "string" ? { model: message.model } : {}),
	};
}

interface Scan {
	spawned: boolean;
	/** Any pi event at all: proof the child came up and spoke. */
	sawPiEvent: boolean;
	/** We asked for this close (teardown); it is not a failure. */
	shutdownRequested: boolean;
	settled: boolean;
	exited: boolean;
	exitCode: number | null;
	reported: boolean;
	assistantText: number;
	toolCalls: string[];
	lastTs?: string;
	retryFinalError?: string;
	budgetExceeded: boolean;
	explicitFailure?: Failure;
	/** The most recent model call that came back an error (cp-0wq7). */
	modelError?: ModelCallError;
	/** How many assistant messages ended `stopReason: "error"`. */
	modelErrors: number;
	/**
	 * pi is mid-retry: an `auto_retry_start` with no matching `auto_retry_end`
	 * (cp-0wq7). pi's own ladder has not finished with this error yet, so nothing
	 * may call the run dead on account of it.
	 */
	retryOpen: boolean;
}

function scan(events: readonly RunEvent[]): Scan {
	const state: Scan = {
		spawned: false,
		sawPiEvent: false,
		shutdownRequested: false,
		settled: false,
		exited: false,
		exitCode: null,
		reported: false,
		assistantText: 0,
		toolCalls: [],
		budgetExceeded: false,
		modelErrors: 0,
		retryOpen: false,
	};
	for (const event of events) {
		state.lastTs = event.ts;
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		if (event.source === "cp") {
			switch (event.type) {
				case "spawned":
					state.spawned = true;
					break;
				case "envelope_received":
					state.reported = true;
					break;
				case "budget_exceeded":
					state.budgetExceeded = true;
					break;
				case "failure":
					state.explicitFailure = payload as unknown as Failure;
					break;
				case "shutdown_requested":
					state.shutdownRequested = true;
					break;
				case "process_exit":
					state.exited = true;
					state.exitCode = (payload.code as number | null | undefined) ?? null;
					break;
				default:
					break;
			}
			continue;
		}
		state.sawPiEvent = true;
		switch (event.type) {
			case "agent_settled":
				state.settled = true;
				break;
			case "tool_execution_start":
				state.toolCalls.push(`${String(payload.toolName ?? "?")}:${stableArgs(payload.args ?? payload.input)}`);
				break;
			case "message_end": {
				const message = payload.message as { role?: string; content?: unknown } | undefined;
				if (message?.role === "assistant" && hasText(message.content)) state.assistantText += 1;
				const modelError = readModelCallError(event);
				if (modelError) {
					state.modelError = modelError;
					state.modelErrors += 1;
				}
				break;
			}
			case "auto_retry_start":
				state.retryOpen = true;
				break;
			case "auto_retry_end":
				state.retryOpen = false;
				if (payload.success === false) {
					state.retryFinalError = String(payload.finalError ?? "provider retries exhausted");
				} else if (payload.success === true) {
					// pi got an answer out of the provider (cp-0wq7): the error that
					// started this retry is history, not a dead call.
					state.modelError = undefined;
				}
				break;
			default:
				break;
		}
	}
	return state;
}

function hasText(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		if (typeof part !== "object" || part === null) return false;
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
	});
}

function stableArgs(value: unknown): string {
	try {
		return JSON.stringify(value ?? null);
	} catch {
		return "?";
	}
}

/**
 * Name what happened, from the log alone. Returns `undefined` when the run is
 * fine or still in progress — an unfinished job is not a failure, and this
 * function never guesses one into existence.
 */
export function classifyRun(events: readonly RunEvent[], options: ClassifyOptions = {}): Classification | undefined {
	const state = scan(events);
	if (state.reported) return undefined;

	if (state.explicitFailure) {
		return {
			class: state.explicitFailure.class,
			message: state.explicitFailure.message,
			evidence: ["cp:failure"],
		};
	}
	if (state.budgetExceeded) {
		return {
			class: "budget_exceeded",
			message: "per-job budget exceeded; the operator decides whether this job continues",
			evidence: ["cp:budget_exceeded"],
		};
	}
	if (state.exited && state.shutdownRequested) {
		// We asked for this close. A deliberate shutdown is not a failure, even
		// though no envelope arrived: whoever asked owns the consequence.
		return undefined;
	}
	if (state.spawned && state.exited && !state.sawPiEvent) {
		return {
			class: "spawn_failed",
			message: `worker exited (code ${state.exitCode ?? "null"}) without emitting a single event — it never came up`,
			evidence: ["cp:spawned", "cp:process_exit"],
		};
	}
	if (state.retryFinalError) {
		return {
			class: "provider_limit",
			message: `provider retries exhausted: ${state.retryFinalError}`,
			evidence: ["auto_retry_end"],
		};
	}
	// cp-0wq7: dead on arrival. Every model call errored and the worker produced
	// nothing at all — no assistant text, no tool call, no tokens. Checked before
	// the exit/settle branches on purpose: this run *did* settle, and calling it
	// `settled_without_report` (or `crash`) hides the one line that explains it
	// and points recovery at a delivery that was never even started.
	const dead = deadModelCall(state);
	if (dead) {
		return {
			class: "model_call_failed",
			message:
				`the model call failed and the worker never ran a turn: ${dead.message}` +
				`${dead.provider || dead.model ? ` (${[dead.provider, dead.model].filter(Boolean).join("/")})` : ""} — ` +
				`${state.modelErrors} model call(s), 0 tool calls, no assistant output. Nothing was delivered and there is ` +
				"nothing to promote: fix the credential or the routed model, then re-dispatch.",
			evidence: ["message_end stopReason=error"],
		};
	}

	const loop = detectToolLoop(state.toolCalls, options.toolLoopThreshold ?? TOOL_LOOP_THRESHOLD);
	if (loop) {
		return {
			class: "tool_loop",
			message: `the same tool call repeated ${loop.count} times in a row (${loop.signature.split(":")[0]})`,
			evidence: ["tool_execution_start"],
		};
	}

	if (state.exited) {
		// A settle before the exit is the whole difference (cp-settle-without-report):
		// a crash is an exit with no settle, and a run that settled cleanly and then
		// ended is a run that finished its work and skipped the last tool call. The
		// branch is often pushed and the PR often open; calling that a crash is how
		// four merge-ready PRs were recorded as failures.
		if (state.settled) {
			return {
				class: "settled_without_report",
				message:
					`the run settled and then exited (code ${state.exitCode ?? "null"}) without calling report_result — ` +
					"the work may be finished and merely unreported. Check the branch and any PR before re-dispatching; " +
					"cp_revive relaunches this worker on its own session file so it can still file its envelope.",
				evidence: ["agent_settled", "cp:process_exit"],
			};
		}
		return {
			class: "crash",
			message: `worker exited (code ${state.exitCode ?? "null"}) without reporting`,
			evidence: ["cp:process_exit"],
		};
	}
	if (state.settled && state.assistantText === 0 && state.toolCalls.length === 0) {
		return {
			class: "agent_empty_output",
			message: "the run settled with no assistant output and no envelope",
			evidence: ["agent_settled"],
		};
	}
	if (options.alive !== false && state.lastTs) {
		const idleMs = (options.now ?? new Date()).getTime() - Date.parse(state.lastTs);
		const limit = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
		if (!state.settled && idleMs > limit) {
			return {
				class: "timeout",
				message: `no events for ${Math.round(idleMs / 1000)}s (limit ${Math.round(limit / 1000)}s) and the run never settled`,
				evidence: [`last event at ${state.lastTs}`],
			};
		}
	}
	return undefined;
}

/**
 * Did every model call in this run fail, with nothing to show for the run?
 *
 * All three halves matter. One errored call in a run that went on to write code
 * is an incident pi already recovered from; an errored call pi is **still
 * retrying** is a recovery in progress; an errored call in a settled run with
 * **no** assistant text and **no** tool call is a worker that never started.
 */
function deadModelCall(state: Scan): ModelCallError | undefined {
	if (!state.modelError) return undefined;
	if (state.assistantText > 0 || state.toolCalls.length > 0) return undefined;
	// pi is still retrying this very error (`auto_retry_start` with no matching
	// `auto_retry_end`): the ladder that owns transient provider failures has not
	// given up, so the call has not finally failed. When it does give up, its
	// `auto_retry_end` says so and `provider_limit` — checked first — is the honest
	// class. Naming it dead here would fail a run mid-recovery, which is the same
	// mistake as inferring death from silence.
	if (state.retryOpen) return undefined;
	return state.modelError;
}

/**
 * The same question, asked of a log instead of a scan (cp-0wq7).
 *
 * The settle boundary calls this before it prompts anything: a nudge sent to a
 * worker whose model call cannot be made produces one more failed call and one
 * more settle, and the run log fills with turns that cost nothing and say
 * nothing. `undefined` means "not this", and the ordinary nudge proceeds.
 */
export function detectDeadModelCall(events: readonly RunEvent[]): ModelCallError | undefined {
	const state = scan(events);
	if (state.reported) return undefined;
	return deadModelCall(state);
}

function detectToolLoop(signatures: readonly string[], threshold: number): { signature: string; count: number } | undefined {
	let run = 0;
	let previous: string | undefined;
	for (const signature of signatures) {
		run = signature === previous ? run + 1 : 1;
		previous = signature;
		if (run >= threshold) return { signature, count: run };
	}
	return undefined;
}

export function toFailure(classification: Classification, at: Date = new Date(), attempt?: number): Failure {
	return {
		class: classification.class,
		message: classification.message,
		at: isoTimestamp(at),
		...(attempt !== undefined ? { attempt } : {}),
	};
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const BUDGET_STATES = ["ok", "warn", "exceeded"] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

export interface BudgetCheck {
	state: BudgetState;
	/** Fraction of the tightest limit that is used (>= 1 means breached). */
	ratio: number;
	tokens: { used: number; limit: number };
	cost: { used: number; limit: number };
	message?: string;
}

/**
 * Billable tokens: `total_tokens` minus `cache_read`. A cache read is priced
 * at roughly a tenth of an input token (and often less), so counting it at
 * full weight makes a long, cheap, mostly-cached run look like it is burning
 * budget when it is not — see cp-d7y: 14.66M total tokens, 14.39M of it
 * cache_read, at $4.07 against a $50 cost limit. The token ceiling exists as
 * a proxy for spend; a metric that is ~98% near-free reads does not serve
 * that purpose.
 */
export function billableTokens(usage: Usage): number {
	return Math.max(0, usage.total_tokens - usage.cache_read);
}

/**
 * Soft gate: checked from usage events *before* the next prompt or steer.
 * Breaching escalates to the operator; nothing is killed here. Delivery
 * itself is never gated on this (see `Sender#send`) — the gate here decides
 * only what the receipt says and whether the operator is warned.
 */
export function checkBudget(
	usage: Usage,
	limits: { tokens: number; cost_usd: number },
	config: BudgetConfig = DEFAULT_BUDGET_CONFIG,
): BudgetCheck {
	const billable = billableTokens(usage);
	const tokenRatio = limits.tokens > 0 ? billable / limits.tokens : 0;
	const costRatio = limits.cost_usd > 0 ? usage.cost_usd / limits.cost_usd : 0;
	const ratio = Math.max(tokenRatio, costRatio);
	const tokens = { used: billable, limit: limits.tokens };
	const cost = { used: usage.cost_usd, limit: limits.cost_usd };
	if (ratio >= 1) {
		return {
			state: "exceeded",
			ratio,
			tokens,
			cost,
			message: `budget exceeded: ${billable}/${limits.tokens} billable tokens (${usage.total_tokens} total, ${usage.cache_read} cache-read), $${usage.cost_usd.toFixed(2)}/$${limits.cost_usd.toFixed(2)} — escalating to the operator, message still delivered`,
		};
	}
	if (ratio >= config.warn_ratio) {
		return {
			state: "warn",
			ratio,
			tokens,
			cost,
			message: `budget at ${Math.round(ratio * 100)}%: ${billable}/${limits.tokens} billable tokens (${usage.total_tokens} total, ${usage.cache_read} cache-read), $${usage.cost_usd.toFixed(2)}/$${limits.cost_usd.toFixed(2)}`,
		};
	}
	return { state: "ok", ratio, tokens, cost };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export const RECOVERY_ACTIONS = ["retry_same", "escalate"] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export interface RecoveryDecision {
	action: RecoveryAction;
	reason: string;
	/** Re-send the original brief rather than composing a new one. */
	same_brief: boolean;
	attempt: number;
}

export interface RecoveryInput {
	class: FailureClass;
	role: Role;
	/** How many recovery attempts this job has already consumed. */
	attempts: number;
	maxAttempts?: number;
}

/**
 * The ladder, bounded on purpose. Escalation is a legitimate outcome, not a
 * last resort: an operator reading one clear message beats a fleet quietly
 * burning tokens on the same failure.
 */
export function decideRecovery(input: RecoveryInput): RecoveryDecision {
	const attempt = input.attempts + 1;
	const max = input.maxAttempts ?? MAX_RECOVERY_ATTEMPTS;
	const base = { attempt, same_brief: true };

	if (input.class === "settled_without_report") {
		// Not "unrecoverable" in the hopeless sense: the work is probably done. What
		// is unrecoverable is *this ladder* — re-running the brief would redo a
		// delivery that already exists. The named path is to look, then decide.
		return {
			...base,
			action: "escalate",
			reason:
				"the run finished and never filed an envelope: the branch may already be pushed and the PR already open. " +
				"Look at the delivery first, then promote (cp_send), revive, or tear down — never re-run the brief blind.",
		};
	}
	if (input.class === "model_call_failed") {
		// Not a ladder's problem: the same call with the same credentials fails the
		// same way. Re-dispatching is only honest once a human has changed
		// something outside this fleet.
		return {
			...base,
			action: "escalate",
			reason:
				"the model call itself failed (credentials, model id or provider refusal): the worker never ran a turn, " +
				"so there is no work to recover and a retry would repeat the same failed call. Fix the credential or the " +
				"routed model first, then re-dispatch.",
		};
	}
	if (!FAILURE_RECOVERABLE[input.class]) {
		return {
			...base,
			action: "escalate",
			reason: `${input.class} is not recoverable by policy — it needs a human decision, not another attempt`,
		};
	}
	if (input.attempts >= max) {
		return {
			...base,
			action: "escalate",
			reason: `${input.class} recurred after ${input.attempts} attempt(s) (cap ${max}) — escalating instead of looping`,
		};
	}
	if (input.class === "provider_limit") {
		// cp-eff: there is no fallback model to try. A provider limit is transient,
		// so it gets its retries on the same model and then escalates like anything
		// else — routing this role elsewhere is an operator decision, not a
		// recovery ladder's.
		return { ...base, action: "retry_same", reason: "provider limits are transient: retry the same model" };
	}
	if (input.class === "envelope_invalid") {
		return {
			...base,
			action: "escalate",
			reason: "the worker already exhausted its in-run repair attempts; a fresh worker would repeat them",
		};
	}
	// crash / timeout / agent_empty_output: re-dispatch the same brief.
	return {
		...base,
		action: "retry_same",
		reason: `${input.class} is transient for a ${input.role}: re-dispatch the same brief (attempt ${attempt}/${max})`,
	};
}

/**
 * The ported cross-role rule: an implementation failure never re-runs the
 * research that preceded it. The findings are not what broke, and re-running
 * them burns tokens to produce the same artifact.
 */
export function mayRerunResearch(failedRole: Role, targetRole: Role): boolean {
	if (targetRole !== "planner") return true;
	return failedRole === "planner";
}

// ---------------------------------------------------------------------------
// Runtime monitor
// ---------------------------------------------------------------------------

export interface FailureMonitorOptions {
	home: string;
	fleet: FleetStore;
	/** The only failed transition. Journals the durable wake-up. */
	fail: FailJob;
	runs: RunRegistry;
	/** Consulted first: a worker that reported did not fail. */
	intake?: EnvelopeIntake;
	now?: () => Date;
	classifyOptions?: ClassifyOptions;
	/** Called once per recorded failure (notify, widget, recovery ladder). */
	onFailure?: (jobId: string, failure: Failure) => void;
	/**
	 * Bounded recovery's `previewDecision` (cur.4.2 review, finding 2): read-only
	 * and synchronous, called just before `fail` so the wake-up it journals
	 * already carries the true `attempted`/`attemptsLeft` facts \u2014 computed from
	 * the same inputs the actual attempt (fired from `onFailure`, after `fail`
	 * returns) decides from a moment later.
	 */
	recoveryFact?: (jobId: string, failure: Failure) => FailRecoveryFact;
	/** The parent is shutting down: a close is its own stop, never classified as a death. */
	closing?: () => boolean;
}

/**
 * Turns an observed close into a classified failure — or into nothing at all.
 *
 * The order matters: intake runs first (idempotent), because a worker that
 * reported and then exited is a success whose process happened to end. Only
 * after the envelope question is settled does the log get read for a cause.
 */
export class FailureMonitor {
	readonly #options: FailureMonitorOptions;

	constructor(options: FailureMonitorOptions) {
		this.#options = options;
	}

	/** Watch one worker. Returns a detach function. */
	watch(jobId: string, worker: WorkerProcess): () => void {
		let detached = false;
		void worker.closed.then(async () => {
			if (detached) return;
			try {
				await this.evaluate(jobId);
			} catch {
				// A monitor that throws on shutdown teaches nobody anything.
			}
		});
		return () => {
			detached = true;
		};
	}

	/**
	 * Classify this job's run, if it still needs one. Idempotent: a job that is
	 * already `failed`, `done`, or reported is left alone.
	 */
	async evaluate(jobId: string): Promise<Failure | undefined> {
		const { fleet, runs } = this.#options;
		await this.#options.intake?.intake(jobId).catch(() => undefined);
		// The envelope question is still settled above; the cause is not. A job the
		// parent stopped stays `waiting` for the next parent's reconcile to judge.
		if (this.#options.closing?.()) return undefined;
		const record = fleet.get(jobId);
		if (!record) return undefined;
		if (record.phase !== "waiting") return undefined;

		// The log is the truth; the projection is only a cache.
		const events = readEventLog(this.#options.home, jobId);
		const classification = classifyRun(events, { alive: false, ...this.#options.classifyOptions });
		if (!classification) return undefined;

		const failure = toFailure(classification, (this.#options.now ?? (() => new Date()))());
		await this.#options.fail(jobId, failure, undefined, this.#options.recoveryFact?.(jobId, failure));
		runs.open(jobId).markFailure(failure);
		this.#options.onFailure?.(jobId, failure);
		return failure;
	}

	/** Fleet usage refreshed from the run projection (the log is the truth). */
	async syncUsage(jobId: string): Promise<Usage | undefined> {
		const { fleet, runs } = this.#options;
		const record = fleet.get(jobId);
		if (!record) return undefined;
		const usage = runs.get(jobId)?.status.usage ?? rebuildStatus(this.#options.home, jobId).usage;
		if (sameUsage(record.usage, usage)) return usage;
		await fleet.patch(jobId, { usage });
		return usage;
	}
}

function sameUsage(a: Usage, b: Usage): boolean {
	return a.total_tokens === b.total_tokens && a.cost_usd === b.cost_usd && a.input === b.input && a.output === b.output;
}


