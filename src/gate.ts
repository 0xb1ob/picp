/**
 * The gate — one fresh-context review of a research artifact, then policy.
 *
 * Ported from `cmdp gate`, with the prose parser deleted. The shape of the
 * thing is unchanged and deliberate:
 *
 *   reviewer OBSERVES  ->  parent DECIDES
 *
 * The reviewer worker (profile `gate-reviewer`, read-only, scratch cwd, never
 * the worktree) reads exactly one file — a copy of the artifact — and calls
 * `report_verdict` with what it saw: verdict, three flags, reasons, revisions.
 * It never decides `cause`, never applies flags-force-escalate, and never
 * counts attempts. That is this module's job, and it is code:
 *
 *  1. a veto flag true               -> escalate (`GATE_VETO_FLAGS`; cause
 *     `flagged` on a reviewer pass, else `policy`). `blocking_unknowns` is
 *     reported, never a veto (cp-unknowns-no-veto)
 *  2. revise when a revise exists    -> escalate, cause `policy` (GATE_MAX_REVISE)
 *  3. no usable verdict              -> escalate, cause `operational`, and
 *     `operational_persistent` when the previous attempt was already
 *     operational (the in-worker repair is already spent as bounded
 *     repair, so the ladder's next rung is a different model, then surface)
 *  4. cause is null on pass and revise; **branch on cause, never on prose**
 *
 * Every attempt leaves `state/runs/<job-id>/gate-<n>.json` (the decision) beside
 * `state/runs/<job-id>/gate-<n>/` (the reviewer's own run: events, status, its
 * write-once `verdict.json`). Prior attempts are read from those files, so the
 * revise cap survives a parent restart.
 *
 * Gate pass is quality, never authorization: shipping still needs the T21
 * checkpoint.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { CapacityReader } from "./capacity.ts";
import { basename, join, resolve, sep } from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { type EscalationStore, raiseForGate } from "./escalation.ts";
import {
	DEFAULT_GATE_CONFIG,
	type Delivery,
	type FleetRecord,
	GATE_MAX_REVISE,
	GATE_REASONS_MAX_ITEMS,
	GATE_RUBRIC_STATEMENT,
	GATE_REVIEW_TIMEOUT_MAX_MS,
	GATE_REVIEW_TIMEOUT_MIN_MS,
	GATE_VERDICT_WORD_CAP,
	GATE_VETO_FLAGS,
	type GateCause,
	type GateConfig,
	GateConfigSchema,
	type GateFlags,
	type GateReview,
	type GateVerdict,
	GateVerdictSchema,
	type GateVerdictValue,
	isoTimestamp,
	LAYOUT,
	paths,
	REVIEW_MAX_ATTEMPTS,
	REVIEW_ORIGINAL_TASK_MAX_BYTES,
	type RoutingConfig,
	SCHEMA_VERSION,
	type SendReceipt,
	terminatingToolForRole,
	validate,
	type VerdictRecord,
	VerdictRecordSchema,
	type WorkerProfile,
} from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import type { PendingReview } from "./contracts.ts";
import { ReviewRunsError, type ReviewRuns, type ReviewWait, type ReviewWakeup } from "./review-runs.ts";
import { assembleBrief, profileForRole, readBriefTemplate } from "./profiles.ts";
import { atomicWriteJson } from "./json-store.ts";
import { type ModelProbe, resolveWithCapacity, type ReviewerRoute, reviewerRoutingEvent, reviewerRoutingInputs } from "./routing.ts";
import { RunRecorder } from "./run-artifacts.ts";
import type { RunRegistry } from "./runs.ts";
import type { Sender } from "./send.ts";
import { taskAddendaBlock } from "./task-addenda.ts";
import type { WorkerManager } from "./worker-manager.ts";
import type { MandateStore } from "./mandate.ts";
import type { ProjectRegistry } from "./projects.ts";
import { selectReviewerModel } from "./reviewer-model.ts";

export class GateError extends Error {}

/** How long a one-shot review may take before it counts as operational. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
/** Grace after `agent_settled` for the verdict file to appear. */
export const SETTLE_GRACE_MS = 500;
/**
 * Backstop poll interval for `awaitVerdict`. The wait is event-driven (it wakes
 * on `tool_execution_end` for the verdict tool, `agent_settled` and worker
 * close) — this is only the net under a missed event, so it is deliberately
 * much coarser than a real poll loop would need to be. Exported so tests can
 * assert the event path is faster than this without hardcoding a duplicate.
 */
export const BACKSTOP_POLL_INTERVAL_MS = 1_000;

/**
 * `data/gate.json` — the operator knob for `DEFAULT_REVIEW_TIMEOUT_MS`.
 *
 * Read fresh by `#awaitVerdict` on every attempt, never cached at construction
 * (this repo already shipped the cached-config bug once: cp-sr5, a budget raise
 * that needed a parent restart because it was read once at startup). A missing
 * file, like a missing `data/routing.json` or `data/budgets.json`, means "no
 * override configured" and falls back to the built-in default — no behaviour
 * change for an operator who never opts in.
 */
export function loadGateConfig(home: string): GateConfig {
	const file = join(home, LAYOUT.gateConfigFile);
	if (!existsSync(file)) return DEFAULT_GATE_CONFIG;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new GateError(`${file} is not valid JSON (${(error as Error).message}); refusing to guess a review timeout`);
	}
	const result = validate<GateConfig>(GateConfigSchema, parsed);
	if (!result.ok) {
		throw new GateError(
			`${file} violates the gate config contract:\n  ${result.errors.join("\n  ")}\n` +
				`review_timeout_ms must be an integer between ${GATE_REVIEW_TIMEOUT_MIN_MS} and ${GATE_REVIEW_TIMEOUT_MAX_MS} (ms). ` +
				`Fix or remove ${file} to fall back to the default (${DEFAULT_REVIEW_TIMEOUT_MS}ms).`,
		);
	}
	return result.value;
}

/** The timeout a review attempt starting right now would actually get. */
export function resolveReviewTimeoutMs(home: string): number {
	return loadGateConfig(home).review_timeout_ms ?? DEFAULT_REVIEW_TIMEOUT_MS;
}

/** All flags false — what a decision carries when there was no verdict to read. */
export const NO_FLAGS: GateFlags = Object.freeze({
	destructive_scope: false,
	scope_growth: false,
	blocking_unknowns: false,
});

/**
 * What the caller should do next. It is derived from `verdict` + `cause`, so
 * the ported ladder lives in code instead of in the operator's memory.
 */
export const GATE_NEXT = ["proceed", "revise", "retry", "surface", "authorize", "wait"] as const;
export type GateNext = (typeof GATE_NEXT)[number];

export interface GateResult {
	verdict: GateVerdict;
	/** proceed | revise | retry (different model) | surface (stop looping). */
	next: GateNext;
	/** `state/runs/<job-id>/gate-<attempt>.json`. */
	path: string;
	model: string;
	/** The reviewer's raw observation, when there was one. */
	review?: GateReview;
	/** Set when a `revise` was pushed to the still-live planner. */
	revise_receipt?: SendReceipt;
	revise_error?: string;
}

/** `cp_gate` returned before the verdict exists (spec 2026-09-05). */
export interface GateWait extends ReviewWait {
	surface: "gate";
}
export type GateStart = GateResult | GateWait;
export function isGateWait(value: GateStart): value is GateWait {
	return (value as GateWait).next === "wait" && (value as GateWait).surface === "gate";
}

export interface GateOptions {
	capacity?: CapacityReader;
	home: string;
	profilesDir: string;
	briefsDir: string;
	artifacts: ArtifactStore;
	manager: WorkerManager;
	routing: RoutingConfig;
	probe: ModelProbe;
	fleet?: FleetStore;
	registry?: ProjectRegistry;
	mandates?: MandateStore;
	/** The job's own run log, for the `cp:gate_decided` marker. */
	runs?: RunRegistry;
	/** Present: a `revise` is delivered to the live planner (promote). */
	sender?: Sender;
	reviewTimeoutMs?: number;
	/**
	 * Removes one gate attempt's reviewer scratch cwd. Injected only by tests:
	 * the default is `rmSync(dir, { recursive: true, force: true })`, and the
	 * path it is handed is always one `removeGateScratch` has already proved is
	 * inside `home` and named `review` (cp-yi73).
	 */
	rmScratch?: (dir: string) => void;
	now?: () => Date;
	parentEnv?: NodeJS.ProcessEnv;
	/**
	 * The registry that makes an attempt asynchronous (spec 2026-09-05). Absent
	 * only in tests that exercise the pieces separately: production always
	 * passes `CommandPost.reviewRuns`.
	 */
	reviews?: ReviewRuns;
	/** When set, escalate/policy writes an escalation record (parent relays, does not compose). */
	escalations?: EscalationStore;
}

export interface GateRequest {
	jobId: string;
	/** Caller-named reviewer model (authorization; still allowlisted). */
	model?: string;
	/** Deliver a `revise` to the live planner. Default true when a sender exists. */
	deliverRevise?: boolean;
	/** The wake-up's "Next:" line. Default: "act on next". */
	directive?: string;
}

// ---------------------------------------------------------------------------
// Policy (pure)
// ---------------------------------------------------------------------------

export interface PriorAttempts {
	/** Decisions already on disk, oldest first. */
	decisions: GateVerdict[];
	attempt: number;
	/**
	 * The revise budget is spent: a `revise` this attempt must become an
	 * escalate instead. How that is computed is the *subject's* rule, not this
	 * function's — see `capExhausted`.
	 */
	priorRevise: boolean;
	/** Cause of the immediately previous attempt (the ladder's input). */
	priorCause: GateCause;
}

export interface PriorAttemptsOptions {
	/** Highest attempt number scanned for on disk. */
	max?: number;
	/**
	 * Is the revise budget spent, given the decisions already on disk?
	 *
	 * Defaults to the **plan gate's** rule and only that rule: one revise per
	 * artifact (`GATE_MAX_REVISE`). A diff review passes its own predicate
	 * (`reviewCapExhausted`, `src/diff-review.ts`) because its subject is a
	 * moving head commit rather than one filed document — the two ladders keep
	 * sharing every line of policy below and differ only in when the budget
	 * runs out.
	 */
	capExhausted?: (decisions: readonly GateVerdict[]) => boolean;
}

/**
 * The plan gate's rule: one revise per artifact, then escalate. A reviewer revise that a veto
 * flag rewrote to `escalate`/`policy` spends that revise too (its stored row is never `revise`);
 * `flagged` and `operational` rows do not.
 */
export function gateCapExhausted(decisions: readonly GateVerdict[]): boolean {
	return decisions.filter((decision) => decision.verdict === "revise" || isVetoPolicy(decision)).length >= GATE_MAX_REVISE;
}

/** A stored `escalate`/`policy` decision with a `GATE_VETO_FLAGS` flag raised. */
export function isVetoPolicy(decision: Pick<GateVerdict, "verdict" | "cause" | "flags">): boolean {
	return decision.verdict === "escalate" && decision.cause === "policy" && GATE_VETO_FLAGS.some((flag) => decision.flags[flag]);
}

/**
 * The **diff review's** rule, living here beside the gate's so the two budgets
 * are one page of code and neither ladder is forked to hold its own.
 *
 * True when the review about to run is the *last* one this branch may get: a
 * `revise` there would ask for a fix nobody is allowed to re-read, so remaining
 * findings surface to the operator instead. A review past the cap is refused
 * outright by `DiffReview.review` and by the pipeline's review step.
 */
export function reviewCapExhausted(decisions: readonly GateVerdict[]): boolean {
	return decisions.length + 1 >= REVIEW_MAX_ATTEMPTS;
}

/** The reason a capped review records, so the operator sees why it stopped. */
export function reviewCapReason(attempt: number, branch: string): string {
	return (
		`review cap: this is review ${attempt} of ${REVIEW_MAX_ATTEMPTS} on ${branch} (REVIEW_MAX_ATTEMPTS) and ` +
		`findings remain — surfacing to the operator instead of asking for another revision`
	);
}

/**
 * Read `state/runs/<job-id>/<prefix>-*.json` — the revise cap survives restarts.
 *
 * `pathFn` defaults to `paths.gateFile` (the plan gate's own attempt files);
 * a diff-review orchestrator points this at `paths.reviewFile` instead, so
 * the two ladders read disjoint attempt sequences for the same `jobId`
 * without forking this function (cp-diffgate-redo-hxb, Constraints §3).
 *
 * `schema` defaults to `GateVerdictSchema` for the same reason `pathFn`
 * defaults to `paths.gateFile`: the plan gate's own files. A diff-review
 * decision is a `DiffVerdict`, which carries `head_sha` and `diff_stat` —
 * two fields `GateVerdictSchema`'s `additionalProperties: false` refuses by
 * contract — so that caller passes `DiffVerdictSchema`. The attempt count and
 * the revise cap below are computed from the shared fields either way, which
 * is the whole point of not forking this function.
 */
export function readPriorAttempts(
	home: string,
	jobId: string,
	pathFn: (jobId: string, attempt: number) => string = paths.gateFile,
	schema: unknown = GateVerdictSchema,
	options: PriorAttemptsOptions = {},
): PriorAttempts {
	const max = options.max ?? 32;
	const capExhausted = options.capExhausted ?? gateCapExhausted;
	const decisions: GateVerdict[] = [];
	for (let attempt = 1; attempt <= max; attempt += 1) {
		const file = join(home, pathFn(jobId, attempt));
		if (!existsSync(file)) break;
		const parsed = validate<GateVerdict>(schema, JSON.parse(readFileSync(file, "utf8")));
		if (!parsed.ok) {
			throw new GateError(`${file} violates the gate verdict contract:\n  ${parsed.errors.join("\n  ")}`);
		}
		decisions.push(parsed.value);
	}
	return {
		decisions,
		attempt: decisions.length + 1,
		priorRevise: capExhausted(decisions),
		priorCause: decisions.at(-1)?.cause ?? null,
	};
}

export interface DecideInput {
	jobId: string;
	attempt: number;
	prior: Pick<PriorAttempts, "priorRevise" | "priorCause">;
	model: string;
	/** What the reviewer reported, when it reported anything usable. */
	review?: GateReview;
	/** Why there is no usable verdict (missing, rejected, dead, timed out). */
	operational?: string;
	/**
	 * The reason recorded when `prior.priorRevise` turns a `revise` into an
	 * escalate. Defaults to the plan gate's one-revise wording; a diff review
	 * passes its own, because its cap is a review count and not a revise count.
	 */
	capReason?: string;
	at?: string;
	/** Flags that force escalate. Defaults to `GATE_VETO_FLAGS` (plan gate). DiffReview passes `[]`. */
	vetoFlags?: ReadonlyArray<keyof GateFlags>;
	/** When true, a `revise` with no `[severity: high] [confidence: high]` finding is a `pass`. */
	highOnlyBar?: boolean;
}

const HIGH_HIGH = /\[severity:\s*high\]\s*\[confidence:\s*high\]/i;

function hasHighHighFinding(review: GateReview): boolean {
	return [...review.reasons, ...(review.revisions ?? [])].some((line) => HIGH_HIGH.test(line));
}

/**
 * The whole of gate policy, as a pure function of the observation and the
 * attempt history. Every branch here was a paragraph of AGENTS.md.
 */
export function decideGate(
	input: DecideInput,
): GateVerdict & { raw?: { reasons: string[]; revisions?: string[] } } {
	const decidedAt = input.at ?? isoTimestamp();
	const base = {
		schema_version: SCHEMA_VERSION,
		job_id: input.jobId,
		attempt: input.attempt,
		model: input.model,
		decided_at: decidedAt,
		// cp-950e: every verdict names the rubric that produced it, in its own
		// field so it can never displace a reviewer's reason under the cap.
		rubric: GATE_RUBRIC_STATEMENT,
	};

	// 3. No usable verdict: operational, then persistently operational.
	if (!input.review) {
		const persistent = input.prior.priorCause === "operational" || input.prior.priorCause === "operational_persistent";
		const reasons = [input.operational ?? "the reviewer produced no usable verdict"];
		if (persistent) {
			reasons.push("prior attempt was already operational: the reviewer model cannot meet the verdict contract");
		}
		const cappedOp = capPayload(reasons, undefined);
		return {
			...base,
			verdict: "escalate",
			cause: persistent ? "operational_persistent" : "operational",
			flags: { ...NO_FLAGS },
			reasons: cappedOp.reasons,
			...(cappedOp.raw ? { raw: cappedOp.raw } : {}),
		};
	}

	const flags = input.review.flags;
	const reasons = [...input.review.reasons];
	const reviewerVerdict = input.review.verdict;
	let verdict: GateVerdictValue = reviewerVerdict;
	let cause: GateCause = null;

	// DiffReview only: a revise with no high/high finding is a pass. Order is
	// bar, then veto, then revise-cap — so a medium revise plus a formerly-vetoing
	// flag on an empty veto list lands as pass.
	if (input.highOnlyBar && verdict === "revise" && !hasHighHighFinding(input.review)) {
		verdict = "pass";
		pushOnce(reasons, "downgraded: no high/high finding");
	}
	const revising = verdict === "revise";

	// 1. A veto flag is not advice: a true one forces escalate. When the
	// reviewer judged the artifact sound on every other criterion (`pass`), the
	// flags are the ONLY objection: `flagged`, so it can still reach a human
	// checkpoint with the danger carried into the evidence. Anything else the
	// reviewer said (revise, or its own escalate) means the plan itself is
	// unresolved or disputed — that stays `policy`, never authorizable.
	//
	// Which flags veto defaults to `GATE_VETO_FLAGS`; DiffReview passes `[]`.
	// `blocking_unknowns` is not in the default set (cp-unknowns-no-veto): a
	// correctly decomposed ticket satisfies its rubric definition by construction,
	// so vetoing on it made incremental delivery an unauthorizable `policy`
	// escalate. It is still persisted in `flags` and still gets its own line in
	// `reasons` — reported, not vetoed.
	const vetoFlags = input.vetoFlags ?? GATE_VETO_FLAGS;
	const raised = (Object.keys(flags) as Array<keyof GateFlags>).filter((flag) => flags[flag]);
	const vetoing = raised.filter((flag) => (vetoFlags as ReadonlyArray<keyof GateFlags>).includes(flag));
	if (vetoing.length > 0) {
		verdict = "escalate";
		cause = reviewerVerdict === "pass" ? "flagged" : "policy";
		pushOnce(reasons, `flag forced escalate: ${vetoing.join(", ")}`);
	}
	const reported = raised.filter((flag) => !(vetoFlags as ReadonlyArray<keyof GateFlags>).includes(flag));
	if (reported.length > 0) pushOnce(reasons, `flag reported, no veto: ${reported.join(", ")}`);

	// 2. The revise budget, counted by the parent (one revise per artifact for a
	// plan gate; `REVIEW_MAX_ATTEMPTS` reviews per branch for a diff review). An
	// exhausted budget is always policy: the subject was never judged sound. A revise
	// the veto above already rewrote still names the cap, so a re-gate shows why it stopped.
	if (revising && input.prior.priorRevise) {
		verdict = "escalate";
		cause = "policy";
		pushOnce(
			reasons,
			input.capReason ?? `attempt cap: a prior revise already exists (${GATE_MAX_REVISE} revision max)`,
		);
	}

	// A reviewer's own escalate is a judgment about the artifact — policy.
	if (verdict === "escalate" && cause === null) cause = "policy";

	const revisions = verdict === "revise" ? [...(input.review.revisions ?? [])] : undefined;
	const capped = capPayload(reasons, revisions);
	const decision = input.review.decision_summary;
	return {
		...base,
		verdict,
		cause,
		flags: { ...flags },
		reasons: capped.reasons,
		...(capped.revisions ? { revisions: capped.revisions } : {}),
		...(decision ? { decision_summary: decision } : {}),
		...(capped.raw ? { raw: capped.raw } : {}),
	};
}

/** proceed | revise | retry | surface — derived, never stored. */
export function nextAction(verdict: GateVerdict): GateNext {
	if (verdict.verdict === "pass") return "proceed";
	if (verdict.verdict === "revise") return "revise";
	// escalate: the cause decides whether this is a fleet problem, a policy
	// call, or a flagged-but-sound plan that a human may still authorize.
	if (verdict.cause === "operational") return "retry";
	if (verdict.cause === "flagged") return "authorize";
	return "surface";
}

/** One relayable line per decision (the verdict travels verbatim). */
export function formatGate(result: GateResult): string {
	const { verdict } = result;
	const head = `${verdict.job_id} gate attempt ${verdict.attempt}: ${verdict.verdict}${
		verdict.cause ? ` (cause: ${verdict.cause})` : ""
	} [${result.model}] -> ${result.next}`;
	const flags = (Object.keys(verdict.flags) as Array<keyof GateFlags>).filter((flag) => verdict.flags[flag]);
	const lines = [head];
	if (verdict.rubric) lines.push(`  rubric: ${verdict.rubric}`);
	if (flags.length > 0) lines.push(`  flags: ${flags.join(", ")}`);
	for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
	if (verdict.revisions?.length) {
		lines.push("  revisions:");
		for (const revision of verdict.revisions) lines.push(`    - ${revision}`);
	}
	if (result.revise_receipt) lines.push(`  revise delivered: ${result.revise_receipt}`);
	if (result.revise_error) lines.push(`  revise NOT delivered: ${result.revise_error}`);
	return lines.join("\n");
}

/** The wake-up body: the decision, then one line saying what to do with it. */
export function gateDirective(result: GateResult, directive: string): string {
	return `${formatGate(result)}\nNext: ${directive}.`;
}

/** One line for a tool result that returned `wait`. */
export function formatGateWait(wait: GateWait): string {
	return (
		`${wait.surface} review attempt ${wait.attempt} is running [${wait.model}] -> wait\n` +
		`  deadline: ${wait.deadline}\n` +
		"  End the turn; a cp-verdict wake-up will arrive with the verdict. Do not call status to wait."
	);
}

/** What `cp_gate action:status` prints: pending attempt plus every decision. */
export function formatGateStatus(
	jobId: string,
	status: { pending?: PendingReview; decisions: GateVerdict[] },
): string {
	const lines = [
		`${jobId} gate: ${status.decisions.length} decided attempt(s)${
			status.pending ? `, attempt ${status.pending.attempt} running (deadline ${status.pending.deadline})` : ""
		}`,
	];
	for (const decision of status.decisions) {
		lines.push(`  ${decision.attempt}: ${decision.verdict}${decision.cause ? ` (${decision.cause})` : ""} at ${decision.decided_at}`);
	}
	return lines.join("\n");
}

function pushOnce(items: string[], value: string): void {
	if (!items.includes(value)) items.push(value);
}

function words(value: string): number {
	return value.trim().split(/\s+/).filter(Boolean).length;
}

/** What `capPayload` dropped, kept verbatim so it can be persisted uncapped. */
export interface CappedPayload {
	reasons: string[];
	revisions?: string[];
	/** Set only when something was dropped: the pre-cap arrays, for the raw file. */
	raw?: { reasons: string[]; revisions?: string[] };
}

/**
 * Keep the decision small enough to relay verbatim AND small enough to fit
 * the schema's `maxItems` (`GATE_REASONS_MAX_ITEMS`) — both bounds are
 * enforced here, together, so nothing downstream can assemble an
 * unrepresentable decision (cp-yg2: a dozen short reasons fit easily under
 * the word cap while still being one item over the schema's item cap, and
 * that overflow used to reach `validate()` only at the moment of persistence,
 * discarding a completed review instead of degrading it).
 *
 * Ported behaviour, simpler implementation: keep whole items while they fit,
 * then say out loud that the rest was dropped. Truncating a reason mid-sentence
 * (the old `fitWordCap`) produced quotes nobody could act on. When anything is
 * dropped, the pre-cap arrays travel back on `.raw` so the caller can persist
 * the full decision alongside the capped one — a truncated verdict is never
 * the only copy.
 */
export function capPayload(
	reasons: readonly string[],
	revisions: readonly string[] | undefined,
	cap: number = GATE_VERDICT_WORD_CAP,
	maxItems: number = GATE_REASONS_MAX_ITEMS,
): CappedPayload {
	const keptReasons: string[] = [];
	const keptRevisions: string[] = [];
	let used = 0;
	let droppedReasons = 0;
	let droppedRevisions = 0;
	for (const reason of reasons) {
		const size = words(reason);
		if (keptReasons.length < maxItems && used + size <= cap) {
			keptReasons.push(reason);
			used += size;
		} else {
			droppedReasons += 1;
		}
	}
	for (const revision of revisions ?? []) {
		const size = words(revision);
		if (keptRevisions.length < maxItems && used + size <= cap) {
			keptRevisions.push(revision);
			used += size;
		} else {
			droppedRevisions += 1;
		}
	}
	const dropped = droppedReasons + droppedRevisions;
	if (dropped === 0) {
		if (keptReasons.length === 0) keptReasons.push("(no reasons within the cap)");
		return { reasons: keptReasons, ...(revisions ? { revisions: keptRevisions } : {}) };
	}
	// Something was dropped: say so, and make room for the note without ever
	// pushing either array back over `maxItems`.
	const note = `(${dropped} further item(s) dropped: capped at ${maxItems} items / ${cap} words — the full decision is kept on disk, uncapped)`;
	if (keptRevisions.length > 0 || droppedRevisions > 0) {
		if (keptRevisions.length >= maxItems) keptRevisions.pop();
		keptRevisions.push(note);
	} else {
		if (keptReasons.length >= maxItems) keptReasons.pop();
		keptReasons.push(note);
	}
	if (keptReasons.length === 0) keptReasons.push("(no reasons within the cap)");
	return {
		reasons: keptReasons,
		...(revisions ? { revisions: keptRevisions } : {}),
		raw: { reasons: [...reasons], ...(revisions ? { revisions: [...revisions] } : {}) },
	};
}

// ---------------------------------------------------------------------------
// The review input (do8.3, do8.4): the original task beside the thing under
// review — the candidate artifact here, the materialized diff in
// `src/diff-review.ts`. One copier, one bound, both surfaces.
// ---------------------------------------------------------------------------

/** The frozen task's name inside the reviewer's scratch cwd. */
export const ORIGINAL_TASK_COPY = "original-task.md";

/** The truncation notice a bounded copy ends with. Never a silent cut. */
export function originalTaskTruncationNote(kept: number, size: number): string {
	return (
		`\n\n[bounded review packet: the first ${kept} of ${size} bytes of the original task are shown above; ` +
		`${size - kept} byte(s) were omitted to keep this reviewer's input bounded. Nothing is hidden — the full ` +
		"task is on the parent's disk. Judge only what you can see, and say so when the omitted tail could matter.]\n"
	);
}

/**
 * Copy the task this job was dispatched with into the reviewer's scratch cwd,
 * beside the artifact copy, and return the path the reviewer will read.
 *
 * `undefined` when this job has no frozen task: a job dispatched before do8.3,
 * or an artifact filed by hand with `cp_artifact add`. That degrades to exactly
 * the review this gate ran before — artifact-only — rather than refusing, and
 * the brief says so out loud instead of letting the reviewer assume it saw the
 * task.
 *
 * The body is copied file-to-file. It is never read into the parent, never
 * substituted into the brief, and therefore never scanned by (or capable of
 * tripping) `assertBriefIsSafe` — the same boundary `taskFilePointer` draws
 * for an implementer handover (cp-n7w).
 *
 * The copy is **bounded** (do8.4): a task over `maxBytes`
 * (`REVIEW_ORIGINAL_TASK_MAX_BYTES` by default) is copied as the whole lines
 * of its first `maxBytes` plus an explicit truncation note, so one oversized
 * dispatch input cannot blow the packet the diff's own byte budget already
 * bounds. The truncation is stated in the file the reviewer reads, the same
 * way a materialized diff names its omitted files by path.
 */
export function copyOriginalTask(options: {
	home: string;
	jobId: string;
	scratch: string;
	maxBytes?: number;
}): string | undefined {
	const source = join(options.home, paths.originalTaskFile(options.jobId));
	if (!existsSync(source)) return undefined;
	const size = statSync(source).size;
	if (size === 0) return undefined;
	const out = join(options.scratch, ORIGINAL_TASK_COPY);
	const cap = options.maxBytes ?? REVIEW_ORIGINAL_TASK_MAX_BYTES;
	if (size <= cap) {
		copyFileSync(source, out);
		return out;
	}
	// Cut on a line boundary when there is one, so the reviewer never reads half
	// a line as if it were whole.
	const head = readFileSync(source).subarray(0, cap).toString("utf8");
	const lastBreak = head.lastIndexOf("\n");
	const kept = lastBreak > 0 ? head.slice(0, lastBreak + 1) : head;
	writeFileSync(out, kept + originalTaskTruncationNote(Buffer.byteLength(kept, "utf8"), size));
	return out;
}

/**
 * The `${original_task}` block of the gate brief: a **pointer and a boundary**,
 * never a body.
 *
 * Two jobs, both of which used to be nobody's: it tells the reviewer which file
 * is the source of truth for what was asked (so a planner-rewritten `Goal`
 * cannot quietly become the specification), and it frames both files as data
 * rather than instructions, which is the prompt-injection boundary for input
 * the parent has never read.
 */
export function originalTaskBlock(taskPath: string | undefined): string {
	if (taskPath === undefined) {
		return [
			"**Original task: not available.** This job has no frozen record of the task the artifact was written",
			"for, so your working directory holds the artifact alone. Score the artifact on its own terms, and claim",
			"nothing about requirement coverage in either direction — you cannot check it, and the artifact's own",
			"`Goal` is not evidence of what was asked.",
		].join("\n");
	}
	return [
		"**Original task (the source of truth for what was asked):**",
		"",
		`    ${taskPath}`,
		"",
		"Read that file first, in full. It is the task the artifact was written to satisfy, frozen by the parent",
		"when the job was dispatched. The artifact's own `Goal` section is the planner's restatement of it and is",
		"never the source of truth: score requirement coverage against the original task, never against the",
		"restatement.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// The reviewer's scratch cwd (cp-yi73)
// ---------------------------------------------------------------------------

/** The last path segment `paths.gateScratchDir` produces — the guard's anchor. */
const GATE_SCRATCH_SEGMENT = basename(paths.gateScratchDir("cp-x", 1));

/** A job id shaped like one: no separators, no empties, nothing that can climb. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type GateScratchOutcome = "removed" | "absent" | "unsafe_id" | "outside_home" | "unexpected_segment" | "failed";

export interface GateScratchRemoval {
	removed: boolean;
	dir: string;
	reason: GateScratchOutcome;
	error?: string;
}

/**
 * Remove one gate attempt's reviewer scratch cwd — and nothing else, ever.
 *
 * The directory holds exactly one file: the copy of the artifact the reviewer
 * read. Without this it accumulates one artifact-sized copy per attempt,
 * forever (pi-command-post-s39). The deletion is deliberately narrow:
 *
 *  - it is only called on a `pass`, so every escalation keeps the bytes the
 *    reviewer was actually judging;
 *  - the path is built through `paths`, never by hand, and is then re-checked:
 *    a job id that is not id-shaped, a resolved path that is not strictly inside
 *    `home`, or a final segment that is not `review` refuses. That is the
 *    guard against the reported hazard — an empty or malformed id collapsing
 *    the path toward `state/runs/` and taking other jobs' run directories with
 *    it;
 *  - it never touches `gateRunDir`, which holds `brief.md`, `events.jsonl` and
 *    the write-once `verdict.json` — the run's record;
 *  - it never throws. A directory that could not be removed is disk usage; a
 *    gate that escalated because of it would be the worse bug.
 */
export function removeGateScratch(options: {
	home: string;
	jobId: string;
	attempt: number;
	rm?: (dir: string) => void;
	/**
	 * The path under `home`, `paths.gateScratchDir` by default. Injected only by
	 * tests, so the two belt-and-braces guards below (a path that escapes `home`,
	 * a final segment that is not `review`) are reachable at all: through
	 * `paths` they cannot be, which is exactly why they are cheap to keep.
	 */
	scratchDir?: (jobId: string, attempt: number) => string;
}): GateScratchRemoval {
	const { home, jobId, attempt } = options;
	if (!SAFE_JOB_ID.test(jobId) || !Number.isInteger(attempt) || attempt < 1) {
		return { removed: false, dir: "", reason: "unsafe_id" };
	}
	const dir = resolve(join(home, (options.scratchDir ?? paths.gateScratchDir)(jobId, attempt)));
	const root = resolve(home);
	if (dir === root || !dir.startsWith(root + sep)) return { removed: false, dir, reason: "outside_home" };
	if (basename(dir) !== GATE_SCRATCH_SEGMENT) return { removed: false, dir, reason: "unexpected_segment" };
	if (!existsSync(dir)) return { removed: false, dir, reason: "absent" };
	try {
		const rm = options.rm ?? ((target: string) => rmSync(target, { recursive: true, force: true }));
		rm(dir);
		return { removed: true, dir, reason: "removed" };
	} catch (error) {
		return { removed: false, dir, reason: "failed", error: (error as Error).message };
	}
}

// ---------------------------------------------------------------------------
// The gate run
// ---------------------------------------------------------------------------

export class Gate {
	readonly #options: GateOptions;
	/**
	 * The last result `finish` produced for an attempt, kept only so the
	 * blocking test helper can return the object the wake-up described —
	 * receipts and the reviewer's raw observation included — instead of the
	 * thinner one a decision file can be rebuilt into.
	 */
	readonly #finished = new Map<number, GateResult>();

	constructor(options: GateOptions) {
		this.#options = options;
	}

	/**
	 * Spawn a reviewer and return `wait` (spec 2026-09-05). Everything that used
	 * to happen before `awaitVerdict` happens here; everything after it is
	 * `finish`, run by the registry when the waiter resolves. If this attempt is
	 * already decided on disk, the decision is returned as it stands.
	 */
	async start(request: GateRequest): Promise<GateStart> {
		const { home, artifacts, manager, reviews } = this.#options;
		const now = this.#options.now ?? (() => new Date());
		const jobId = request.jobId;
		const directive = request.directive ?? "act on next";

		if (!artifacts.has(jobId)) {
			throw new GateError(
				`no artifact for ${jobId} — cannot gate. The planner must write ${artifacts.file(jobId)} first ` +
					"(cp_artifact add files an existing report into the store).",
			);
		}
		const inFlight = reviews?.pending(jobId, "gate");
		if (inFlight) {
			throw new ReviewRunsError(
				`${jobId} already has a gate review in flight (attempt ${inFlight.attempt}, started ${inFlight.started_at}, ` +
					`deadline ${inFlight.deadline}) — wait for its cp-verdict wake-up instead of starting another`,
				inFlight,
			);
		}

		const prior = readPriorAttempts(home, jobId);
		// A passed artifact is not re-gated: the decision stands until the artifact
		// moves, so a second `start` returns it instead of spawning a second
		// reviewer. A revise or an escalate is an open loop the caller may re-run.
		const last = prior.decisions.at(-1);
		if (last?.verdict === "pass") {
			const info = artifacts.info(jobId);
			const moved = info.modified_at !== undefined && info.modified_at > last.decided_at;
			if (!moved) {
				return {
					verdict: last,
					next: nextAction(last),
					path: join(home, paths.gateFile(jobId, last.attempt)),
					model: last.model ?? request.model ?? "unknown",
				};
			}
		}
		const attempt = prior.attempt;
		const profile = profileForRole(this.#options.profilesDir, "gate-reviewer");
		const record = this.#options.fleet?.get(jobId);
		const selection = selectReviewerModel({ model: request.model, record, registry: this.#options.registry, mandates: this.#options.mandates, now: now() });
		const route = await this.#route(profile, jobId, record, selection?.model);
		const model = route.decision.model;

		// The reviewer sees one file, in a directory that contains nothing else.
		const gateRunDir = join(home, paths.gateRunDir(jobId, attempt));
		const scratch = join(home, paths.gateScratchDir(jobId, attempt));
		mkdirSync(scratch, { recursive: true });
		const artifactCopy = artifacts.get(jobId, join(scratch, "artifact.md")).out;
		// The bounded review input: the frozen original task beside the candidate
		// artifact, both as files in a directory that contains nothing else (do8.3).
		const taskCopy = copyOriginalTask({ home, jobId, scratch });

		const brief = assembleBrief({
			profile,
			template: readBriefTemplate(this.#options.briefsDir, profile.frontmatter.briefTemplate),
			values: {
				job_id: jobId,
				project: record?.project ?? "unregistered",
				artifact_path: artifactCopy,
				original_task: originalTaskBlock(taskCopy) + taskAddendaBlock({ home, jobId, scratch }),
			},
		});
		writeFileSync(join(gateRunDir, "brief.md"), brief);

		const recorder = RunRecorder.open({ home, jobId, dir: gateRunDir });
		// The decision this attempt is about to spawn, recorded once, before the
		// spawn that could fail (cp-reviewer-routing): inputs, provenance and the
		// effort, not just the model.
		recorder.cp("routing_resolved", reviewerRoutingEvent({ surface: "gate", attempt, ...route }));
		if (selection) recorder.cp("reviewer_model_selected", { surface: "gate", attempt, ...selection });
		const key = `${jobId}#gate-${attempt}`;
		const timeoutMs = this.#options.reviewTimeoutMs ?? resolveReviewTimeoutMs(home);
		const deadline = isoTimestamp(new Date(now().getTime() + timeoutMs));
		const deliverRevise = request.deliverRevise ?? true;

		await manager.ready();
		let managed: ReturnType<WorkerManager["spawn"]>;
		try {
			managed = manager.spawn({
				key,
				identity: {
					jobId,
					kind: "research",
					delivery: (record?.delivery ?? "pipeline") as Delivery,
					runDir: gateRunDir,
					worktree: scratch,
				},
				profile,
				model,
				// The resolved effort travels with the resolved model: a rubric row that
				// routes reviewers at medium must not be spawned at the profile's high.
				...(route.decision.thinking ? { thinking: route.decision.thinking } : {}),
				brief,
				sessionDir: join(home, LAYOUT.sessions),
				sessionName: key,
				...(this.#options.parentEnv ? { parentEnv: this.#options.parentEnv } : {}),
			});
		} catch (error) {
			// A reviewer that cannot even start is an operational fault, not a
			// judgment about the artifact — decided now, synchronously, so the
			// ladder can retry. Nothing is pending because nothing is running.
			recorder.close();
			const { result } = await this.finish({
				jobId,
				attempt,
				model,
				prior,
				outcome: { operational: `reviewer could not run: ${(error as Error).message}` },
				deliverRevise,
				directive,
			});
			return result;
		}
		recorder.markSpawned({ pid: managed.worker.pid, model, profile: profile.frontmatter.name });
		recorder.attach(managed.worker);

		const worker = managed.worker;
		const wait = async (): Promise<{ review?: GateReview; operational?: string }> => {
			const receipt = await worker.send(brief);
			recorder.cp("prompt_sent", { receipt: receipt.receipt, bytes: brief.length });
			if (receipt.receipt === "failed") {
				return { operational: `reviewer refused the brief: ${receipt.error ?? "unknown error"}` };
			}
			return this.#awaitVerdict(jobId, attempt, worker);
		};

		if (!reviews) {
			// No registry (a unit test of the pieces): behave as the old blocking
			// gate did, so the ladder tests keep their shape.
			let outcome: { review?: GateReview; operational?: string };
			try {
				outcome = await wait();
			} catch (error) {
				outcome = { operational: `reviewer wait failed: ${(error as Error).message}` };
			}
			return (
				await this.finish({ jobId, attempt, model, prior, outcome, deliverRevise, directive, managedKey: key, recorder })
			).result;
		}

		return {
			...reviews.start({
				jobId,
				surface: "gate",
				attempt,
				model,
				...(worker.pid !== undefined ? { pid: worker.pid } : {}),
				deadline,
				wait,
				finish: async (outcome) =>
					(
						await this.finish({
							jobId,
							attempt,
							model,
							prior,
							outcome,
							deliverRevise,
							directive,
							managedKey: key,
							recorder,
						})
					).wakeup,
			}),
			surface: "gate",
		};
	}

	/**
	 * Everything after the wait, unchanged from the blocking gate: decide, write
	 * `gate-<n>.json` (and the raw file), shut the reviewer down, clean scratch
	 * on a pass, record `gate_decided`, deliver a revise. Returns the result
	 * and the wake-up the registry sends once the caller has been handed `wait`.
	 */
	async finish(input: {
		jobId: string;
		attempt: number;
		model: string;
		prior: PriorAttempts;
		outcome: { review?: GateReview; operational?: string };
		deliverRevise: boolean;
		directive: string;
		managedKey?: string;
		recorder?: RunRecorder;
	}): Promise<{ result: GateResult; wakeup: ReviewWakeup }> {
		const { home, manager, runs } = this.#options;
		const now = this.#options.now ?? (() => new Date());
		const { jobId, attempt, model, prior } = input;
		const { review, operational } = input.outcome;

		// One-shot: the reviewer never survives its own verdict.
		if (input.managedKey) await manager.shutdown(input.managedKey);
		input.recorder?.close();

		const { raw, ...verdict } = decideGate({
			jobId,
			attempt,
			prior,
			model,
			...(review ? { review } : {}),
			...(operational ? { operational } : {}),
			at: isoTimestamp(now()),
		});
		const validated = validate<GateVerdict>(GateVerdictSchema, verdict);
		if (!validated.ok) {
			throw new GateError(`gate decision for ${jobId} violates the contract:\n  ${validated.errors.join("\n  ")}`);
		}
		const path = join(home, paths.gateFile(jobId, attempt));
		atomicWriteJson(path, verdict);
		// Something was too big for the schema and got capped above: the operator
		// can see THAT from the note in `reasons`, but the full pre-cap decision
		// still needs to be recoverable, not merely announced as missing (cp-yg2).
		if (raw) {
			const rawPath = join(home, paths.gateFileRaw(jobId, attempt));
			atomicWriteJson(rawPath, { ...verdict, reasons: raw.reasons, ...(raw.revisions ? { revisions: raw.revisions } : {}) });
		}

		// The reviewer's scratch cwd is spent once the attempt passed: the copy it
		// read is byte-identical to the store's, which is untouched. An escalate or
		// a revise keeps it, because after a revise the store has moved on and this
		// copy is the only record of what that attempt was judging (cp-yi73).
		// `manager.shutdown(key)` has already resolved, so no live process is
		// standing in the directory being removed.
		if (verdict.verdict === "pass") {
			try {
				const removal = removeGateScratch({
					home,
					jobId,
					attempt,
					...(this.#options.rmScratch ? { rm: this.#options.rmScratch } : {}),
				});
				runs?.open(jobId).cp("gate_scratch_removed", {
					attempt,
					dir: removal.dir,
					removed: removal.removed,
					reason: removal.reason,
					...(removal.error ? { error: removal.error } : {}),
				});
			} catch {
				// Cleanup is never allowed to change a decided verdict.
			}
		}

		const result: GateResult = {
			verdict,
			next: nextAction(verdict),
			path,
			model,
			...(review ? { review } : {}),
		};

		// The job's own run log learns the outcome; the gate run keeps the detail.
		runs?.open(jobId).cp("gate_decided", {
			attempt,
			verdict: verdict.verdict,
			cause: verdict.cause,
			model,
			next: result.next,
			path,
		});
		if (this.#options.escalations) {
			try {
				await raiseForGate(this.#options.escalations, verdict);
			} catch {
				// An escalation write must never discard a decided verdict.
			}
		}

		if (result.next === "revise" && input.deliverRevise) {
			await this.#deliverRevise(result);
		}
		this.#finished.set(attempt, result);
		const wakeup: ReviewWakeup = {
			jobId,
			surface: "gate",
			attempt,
			content: gateDirective(result, input.directive),
			details: result as unknown as Record<string, unknown>,
		};
		return { result, wakeup };
	}

	/** What is on disk for this job's gate: the pending attempt, if any, and every decision. */
	status(jobId: string): { pending?: PendingReview; decisions: GateVerdict[] } {
		const pending = this.#options.reviews?.pending(jobId, "gate");
		return { ...(pending ? { pending } : {}), decisions: readPriorAttempts(this.#options.home, jobId).decisions };
	}

	/**
	 * Finish an attempt whose reviewer died with a previous parent (D4): no
	 * worker, an operational outcome, the ordinary ladder. The registry decides
	 * whether the wake-up is sent (only when the parent had been handed `wait`).
	 */
	async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined> {
		const prior = readPriorAttempts(this.#options.home, pending.job_id);
		if (prior.attempt !== pending.attempt) return undefined; // decided meanwhile
		return (
			await this.finish({
				jobId: pending.job_id,
				attempt: pending.attempt,
				model: pending.model,
				prior,
				outcome: { operational: reason },
				deliverRevise: false,
				directive: "act on next",
			})
		).wakeup;
	}

	/**
	 * Blocking convenience for tests: start, hand back, await the registry's
	 * chain, and return the decision the wake-up described. Production code
	 * never calls this — the whole point of the split is that it does not wait.
	 */
	async gateAndWait(request: GateRequest): Promise<GateResult> {
		const started = await this.start(request);
		if (!isGateWait(started)) return started;
		const reviews = this.#options.reviews;
		if (!reviews) throw new GateError("gateAndWait needs a ReviewRuns registry");
		reviews.handBack(started.key);
		await reviews.settled(started.key);
		const finished = this.#finished.get(started.attempt);
		if (finished) return finished;
		const decisions = readPriorAttempts(this.#options.home, request.jobId).decisions;
		const verdict = decisions[started.attempt - 1];
		if (!verdict) throw new GateError(`attempt ${started.attempt} for ${request.jobId} left no decision on disk`);
		return {
			verdict,
			next: nextAction(verdict),
			path: join(this.#options.home, paths.gateFile(request.jobId, started.attempt)),
			model: started.model,
		};
	}

	/**
	 * The reviewer's whole routing decision for this job — model and effort — plus
	 * the subject inputs it was given (cp-reviewer-routing). Reviewing an L/high
	 * plan is L/high work, so the subject job's own recorded axes are the
	 * reviewer's; an axis the subject never recorded stays `unknown` rather than
	 * being claimed as a measured `S`/`low`.
	 *
	 * cp-eff removed the gate's "different model on a repeat operational fault"
	 * rung, and pi-command-post-0a9's ordered `fallbacks` do **not** bring it
	 * back: fallback is a resolution-time mechanism, walked once before the spawn
	 * when a candidate is unusable, never a retry mechanism. A retry therefore
	 * re-runs the same decision, which is the right move for a transient fault
	 * (timeout, a truncated stream) and is bounded anyway — a second operational
	 * fault becomes `operational_persistent` and lands on the operator. To review
	 * on a different model deliberately, route the role elsewhere in
	 * data/routing.json, or pass an explicit override (which never falls back).
	 */
	async #route(profile: WorkerProfile, jobId: string, record: FleetRecord | undefined, override?: string): Promise<ReviewerRoute> {
		const inputs = reviewerRoutingInputs(record);
		const decision = await resolveWithCapacity(
			{
				profile,
				jobId,
				project: record?.project ?? "unregistered",
				kind: "research",
				...(inputs.scope ? { scope: inputs.scope } : {}),
				...(inputs.risk ? { risk: inputs.risk } : {}),
				...(override ? { override } : {}),
			},
			this.#options.routing,
			this.#options.probe,
			this.#options.capacity,
		);
		return { decision, inputs };
	}

	/**
	 * Wait for a terminal fact, never for a guess — see `awaitVerdict`, which is
	 * the one implementation of that wait (the diff-review orchestrator reuses it
	 * by import rather than copying the loop).
	 */
	async #awaitVerdict(
		jobId: string,
		attempt: number,
		worker: { closed: Promise<unknown>; onEvent(listener: (event: { type: string }) => void): () => void },
	): Promise<{ review?: GateReview; operational?: string }> {
		const home = this.#options.home;
		return awaitVerdict({
			jobId,
			verdictFile: join(home, paths.gateVerdictFile(jobId, attempt)),
			rejectedFile: join(home, paths.gateRunDir(jobId, attempt), "verdict-rejected.json"),
			// Read per attempt, not once at construction: an operator who edits
			// data/gate.json must see it on the very next review, with no parent
			// restart (cp-sr5 shipped the opposite bug once already). The explicit
			// constructor option still wins, for callers (tests) that want a fixed
			// timeout regardless of what is on disk.
			timeoutMs: this.#options.reviewTimeoutMs ?? resolveReviewTimeoutMs(home),
			worker,
		});
	}

	/**
	 * Prefer the live planner; a closed planner uses the explicit replacement
	 * preparation path, followed by normal dispatch with all its gates.
	 */
	async #deliverRevise(result: GateResult): Promise<void> {
		const sender = this.#options.sender;
		if (!sender) return;
		if (this.#options.fleet?.get(result.verdict.job_id)?.phase === "done") {
			result.revise_error = `Planner is torn down. Create a fresh research job with the same project and delivery, then use cp_gate action: replace_planner, job_id: ${result.verdict.job_id}, replacement_job_id: <new job id>; dispatch with the returned task_file.`;
			return;
		}
		try {
			const receipt = await sender.send({
				jobId: result.verdict.job_id,
				message: reviseMessage(result.verdict),
			});
			result.revise_receipt = receipt.receipt;
			if (receipt.error) result.revise_error = receipt.error;
		} catch (error) {
			result.revise_error = (error as Error).message;
		}
	}
}

/** The worker handle `awaitVerdict` needs: an observed close and an event tap. */
export interface VerdictWorker {
	closed: Promise<unknown>;
	onEvent(listener: (event: { type: string }) => void): () => void;
}

export interface AwaitVerdictOptions {
	jobId: string;
	/** The reviewer's write-once verdict file (`.../verdict.json`). */
	verdictFile: string;
	/** Where the worker records an exhausted in-run repair budget. */
	rejectedFile: string;
	timeoutMs: number;
	worker: VerdictWorker;
}

/** The one terminating tool a `gate-reviewer` worker may call. */
const VERDICT_TOOL_NAME = terminatingToolForRole("gate-reviewer");

/**
 * Wait for a terminal fact, never for a guess. Any of these ends a review:
 * the write-once verdict appears, the worker writes its rejection file, the
 * run settles (a settled reviewer will never report without another prompt —
 * and a one-shot review does not send one), the process closes, or the
 * deadline passes.
 *
 * Event-driven, not polled: the wait wakes on `tool_execution_end` for the
 * verdict tool (the same shape `EnvelopeIntake.watch` keys on for
 * `report_result`, `src/intake.ts:114-128`), on `agent_settled`, and on the
 * worker closing. An event only says "look now" — `readVerdictFile` stays the
 * single source of truth, read fresh on every wake, because an event can race
 * a `.tmp` write's rename. A long-interval backstop poll (`BACKSTOP_POLL_INTERVAL_MS`)
 * still runs underneath so a missed event can never hang the wait to its full
 * timeout.
 *
 * Exported because a one-shot reviewer is a one-shot reviewer whatever it is
 * reading: the diff-review orchestrator (`src/diff-review.ts`) waits on its
 * own `review-<n>/verdict.json` through this exact function, so "no usable
 * verdict" means the same thing — and degrades the same way — in both ladders.
 */
export async function awaitVerdict(
	options: AwaitVerdictOptions,
): Promise<{ review?: GateReview; operational?: string }> {
	const { jobId, verdictFile, rejectedFile, timeoutMs, worker } = options;
	const deadline = Date.now() + timeoutMs;

	let exited = false;
	let settledAt: number | undefined;
	// At most one pending waiter at a time: the loop below only ever awaits one
	// promise per iteration, so overwriting this on each wake is safe — nothing
	// is ever dropped.
	let wake: (() => void) | undefined;
	const notify = () => wake?.();

	void worker.closed.then(() => {
		exited = true;
		notify();
	});
	const off = worker.onEvent((event) => {
		if (event.type === "agent_settled") {
			settledAt = Date.now();
			notify();
			return;
		}
		if (event.type === "tool_execution_end") {
			// Read defensively: this event carries the tool name as an untyped
			// field (the same pattern `EnvelopeIntake.watch` uses, src/intake.ts:116-118).
			const name = (event as { toolName?: unknown }).toolName;
			if (name === VERDICT_TOOL_NAME) notify();
		}
	});

	try {
		for (;;) {
			if (existsSync(verdictFile)) return readVerdictFile(jobId, verdictFile);
			if (existsSync(rejectedFile)) {
				return {
					operational:
						`reviewer exhausted its in-run verdict repairs (see ${rejectedFile}) — ` +
						"the model could not produce a schema-valid verdict",
				};
			}
			if (exited) return { operational: "reviewer exited without reporting a verdict" };
			// The verdict file is written before the tool result that settles the
			// run, so a short grace after settling is enough to see it.
			if (settledAt !== undefined && Date.now() - settledAt > SETTLE_GRACE_MS) {
				return { operational: "reviewer settled without reporting a verdict" };
			}
			if (Date.now() > deadline) {
				return { operational: `reviewer did not report a verdict within ${timeoutMs}ms` };
			}

			// Sleep until the next thing that could change the answer: the deadline,
			// the end of the settle grace (if we are in it), the backstop poll, or an
			// event waking us early.
			const waitCandidates = [deadline - Date.now(), BACKSTOP_POLL_INTERVAL_MS];
			if (settledAt !== undefined) waitCandidates.push(SETTLE_GRACE_MS - (Date.now() - settledAt));
			const waitMs = Math.max(0, Math.min(...waitCandidates));

			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					wake = undefined;
					resolve();
				}, waitMs);
				wake = () => {
					clearTimeout(timer);
					wake = undefined;
					resolve();
				};
			});
		}
	} finally {
		off();
	}
}

/** The reviewer's observation, or why there is none. Never a judgment. */
export function readVerdictFile(jobId: string, file: string): { review?: GateReview; operational?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { operational: `${file} is not valid JSON (${(error as Error).message})` };
	}
	const result = validate<VerdictRecord>(VerdictRecordSchema, parsed);
	if (!result.ok) {
		return { operational: `${file} violates the verdict contract: ${result.errors.join("; ")}` };
	}
	if (result.value.job_id !== jobId) {
		return { operational: `${file} reports ${result.value.job_id}, not ${jobId}` };
	}
	return { review: result.value.review };
}

/** The promote text: the reviewer's revisions, verbatim and bounded. */
export function reviseMessage(verdict: GateVerdict): string {
	const lines = [
		`Gate review of your artifact for ${verdict.job_id} (attempt ${verdict.attempt}): revise.`,
		"",
		"Revisions required:",
		...(verdict.revisions ?? []).map((revision) => `- ${revision}`),
		"",
		"Reasons given:",
		...verdict.reasons.map((reason) => `- ${reason}`),
		"",
		"Update the artifact in place at its predeclared path — the same file you already wrote — then reply here",
		"with one line naming what you changed. Only a changed artifact can be re-gated.",
		"A reply is enough: the artifact is the deliverable and the gate re-reads it from disk. Your envelope slot was",
		"reopened when this promote was delivered, so if the revision changes what your envelope said you may call",
		"report_result once more and it will be accepted — it is never refused and never silently dropped.",
		"This is the only revision available: the next verdict is pass or escalate.",
	];
	return lines.join("\n");
}
