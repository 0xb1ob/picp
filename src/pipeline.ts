/**
 * Pipeline orchestration — research → gate → **checkpoint** → implement.
 *
 * The shape is ported from command-post AGENTS.md §Pipeline, with the parts
 * that were prose ("the parent must remember to…") turned into a small state
 * machine over facts on disk:
 *
 *   two br issues + a dep link            (the ledger is the operator's view)
 *   state/pipelines/<research-id>.json    (the machine link between them)
 *   the planner's envelope, or its artifact alone (hung-planner recovery)
 *   state/runs/<research-id>/gate-<n>.json           (T20 decides)
 *   state/checkpoints/<ship-id>.json                 (a human authorizes)
 *   state/runs/<ship-id>/task.md                     (the artifact, by path)
 *
 * Three rules earn their place here, and each one is a bug somebody paid for:
 *
 *  1. **Evidence is not authorization.** A gate `pass` says the plan is good.
 *     It never says "ship it". The implementer is not dispatched until a
 *     journaled human decision exists (`Checkpoint`), and the record is written
 *     `pending` *before* anyone is asked, so a crash mid-question cannot look
 *     like a yes.
 *  2. **The parent never reads the artifact.** The hand-off is a path:
 *     `cp_artifact get` copies the body to `state/runs/<ship-id>/task.md` and
 *     dispatch reads it in code (`taskFile`). No body ever enters the parent's
 *     context, and (cp-n7w) none enters the implementer's *brief* either: the
 *     brief names the path and the worker reads it directly, so the
 *     credential guard scanning the brief never sees the artifact's text.
 *  3. **An implementation failure never re-runs the research.** The findings
 *     are not what broke (`mayRerunResearch`, T18); the same brief is
 *     re-dispatched from the same task file.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benignSenseAt, negatedAt } from "./risk-negation.ts";
import { recordAssessedRisk } from "./ledger-filter.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { AnsweredSink } from "./answered.ts";
import { CheckpointStore } from "./checkpoint.ts";
import { autoDecideCheckpoint, type MandateStore, type MandateUsageJob } from "./mandate.ts";
import { gateOverride, type EscalationStore, raiseForGate } from "./escalation.ts";
import {
	type Checkpoint,
	type Delivery,
	type Envelope,
	type EnvelopeRecord,
	type DiffReviewConfig,
	type DiffVerdict,
	DiffVerdictSchema,
	type GateVerdict,
	isoTimestamp,
	type JobKind,
	LAYOUT,
	paths,
	type PipelineRecord,
	PipelineRecordSchema,
	type PipelineState,
	type QualityConfig,
	type QualityReport,
	REVIEW_MAX_ATTEMPTS,
	type ReviewSurface,
	expectsPlannerBlockers,
	type GateFlags,
	PLANNER_BLOCKED_ROUND_CAP,
	plannerBlockedRoundAction,
	type JobRouting,
	type Risk,
	type RoutingProvenance,
	SCHEMA_VERSION,
	type SelfAssessment,
	type Scope,
	type TaskImpact,
	type ThinkingLevel,
	validate,
} from "./contracts.ts";
import { type DiffReviewWait, isDiffReviewWait } from "./diff-review.ts";
import { raisePlanApproval } from "./escalation.ts";
import type { Dispatcher, DispatchResult } from "./dispatch.ts";
import type { QuestionStore } from "./questions.ts";
import { ReviewApprovalStore } from "./review-approval.ts";
import { resolveFinalFix } from "./final-fix.ts";
import { readReviewPassVerdict } from "./merge-ask.ts";
import {
	isEnabled as qualityEnabled,
	isQualityWait,
	type QualityPass,
	qualityFixMessage,
	resolveQualityConfig,
} from "./quality.ts";
import { classifyRun, decideRecovery, mayRerunResearch, MAX_RECOVERY_ATTEMPTS } from "./failures.ts";
import type { FleetStore } from "./fleet.ts";
import {
	formatGate,
	type Gate,
	type GateNext,
	type GateResult,
	isGateWait,
	nextAction,
	readPriorAttempts,
	reviewCapExhausted,
} from "./gate.ts";
import { composeImplementationRouting, type ComposedRouting } from "./pipeline-risk.ts";
/** The composition moved to `src/pipeline-risk.ts`; re-exported so the public import path is unchanged. */
export { composeImplementationRouting };
import { atomicWriteJson } from "./json-store.ts";
import { ReviewRuns, type ReviewWait } from "./review-runs.ts";
import type { Ledger } from "./ledger.ts";
import { readEventLog } from "./run-artifacts.ts";
import { lastFiledEnvelopeFile } from "./supersede.ts";
import type { Teardown, TeardownResult } from "./teardown.ts";


function decisionReviseAt(home: string, researchId: string): string | undefined {
	const file = join(home, paths.runDir(researchId), "decision-revise.json");
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown };
		return typeof parsed.at === "string" ? parsed.at : undefined;
	} catch {
		return undefined;
	}
}

export class PipelineError extends Error {}

/**
 * The framing wrapped around a gated research artifact before it becomes an
 * implementer's task file (cp-pipeline-handoff-framing-dz9).
 *
 * The artifact is a specification, but it is written in a planner's own
 * first-person voice, read-only per that planner's brief — sentences like
 * "Not implementing the feature" or "no code was changed" are the previous
 * job describing *itself*, and an implementer that reads them as its own
 * instructions concludes (correctly, from its point of view) that it has been
 * handed a mis-routed research brief and reports blocked without touching the
 * tree. This wraps the artifact — never edits or summarises it — in framing
 * that says plainly what the document is, whose voice it is in, and what the
 * reader's job is, plus the ship job's own frozen scope (never inferred from
 * the plan's size: a gated design can span more than one ship job covers).
 */
export function frameImplementerTask(params: { researchId: string; shipId: string; scope: string; body: string }): string {
	const { researchId, shipId, scope, body } = params;
	return [
		`# Specification from ${researchId} — your job is to implement it`,
		"",
		`Everything below the "---" divider is a specification produced by ${researchId}, an earlier, read-only research job. It is the plan, not a status report: your job is to implement it.`,
		"",
		"That document is written in the planner's own first-person voice, describing a read-only run — sentences like \"I did not implement the feature\" or \"this research made no code changes\" describe what *that job* did (nothing, by design). They are not instructions to you, and they do not mean this job is also read-only. Read them as history, not as your brief.",
		"",
		`## Your scope for ${shipId}`,
		"",
		"This ship job's scope is frozen to the task below. The plan may cover more ground than that — implement the part of it this task covers, and treat anything beyond that boundary as out of scope: name it, do not absorb it.",
		"",
		scope,
		"",
		"---",
		"",
		body,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Classification (advisory, deterministic, overridable)
// ---------------------------------------------------------------------------

/**
 * `qa` (cp-u3o4) is the third, advisory mode: the intake looks like a question
 * whose deliverable is an answer a human reads once, not a plan an implementer
 * acts on and not a change. It recommends `cp_ask` (kind:research +
 * delivery:answer); it forces nothing, and `single`/`pipeline` are unchanged.
 */
export const INTAKE_MODES = ["single", "pipeline", "qa"] as const;
export type IntakeMode = (typeof INTAKE_MODES)[number];

export interface ClassifyInput {
	task: string;
	kind?: JobKind;
	scope?: Scope;
	risk?: Risk;
	/** Caller authorization: the operator can force either shape. */
	force?: IntakeMode;
}

export interface Classification {
	mode: IntakeMode;
	reasons: string[];
	forced: boolean;
}

/**
 * Signals that an intake is a **question**, not a job (cp-u3o4).
 *
 * Deliberately narrow, because the failure this must not have is calling real
 * research "a question": an interrogative opener or a trailing `?`, no verb
 * that asks for a change, and short. `QA_MAX_WORDS` is the whole of "small":
 * a question that takes a paragraph to ask is not a question with a one-screen
 * answer.
 */
const QA_OPENERS =
	/^\s*(what|where|which|who|whom|whose|when|why|how|is|are|does|do|did|can|could|should|would|will|has|have|was|were)\b/i;
const QA_ACTION_VERBS =
	/\b(implement|ship|fix|add|remove|delete|refactor|migrat\w*|rename|write|change|update|bump|revert|design|plan|investigate|audit|diagnose)\b/i;
const QA_MAX_WORDS = 40;

/**
 * Is this intake question-shaped? Pure and deterministic, so the recommendation
 * can be asserted in a test instead of trusted.
 */
export function looksLikeQuestion(task: string): { question: boolean; reasons: string[] } {
	const text = task.trim();
	const reasons: string[] = [];
	if (text.length === 0) return { question: false, reasons: ["empty task"] };
	const words = text.split(/\s+/).length;
	const interrogative = QA_OPENERS.test(text);
	const trailingQuestionMark = text.endsWith("?");
	if (!interrogative && !trailingQuestionMark) return { question: false, reasons: ["not phrased as a question"] };
	if (QA_ACTION_VERBS.test(text)) return { question: false, reasons: ["the task asks for a change or a plan, not an answer"] };
	if (words > QA_MAX_WORDS) return { question: false, reasons: [`the question is ${words} words — too long to have a glanceable answer`] };
	if (interrogative) reasons.push("the task opens with an interrogative");
	if (trailingQuestionMark) reasons.push("the task is phrased as a question");
	reasons.push("no change or plan is asked for");
	return { question: true, reasons };
}

/** Signals that a task is ambiguous or cross-cutting (ported wording). */
const PIPELINE_SIGNALS: ReadonlyArray<{ re: RegExp; why: string }> = Object.freeze([
	{ re: /\b(investigate|figure out|find out|diagnose|root cause|why (is|does|are)|audit|survey|explore)\b/i, why: "the task asks for an investigation, not a change" },
	{ re: /\b(somewhere|not sure|unclear|unknown|no idea|which files?)\b/i, why: "the caller does not know where the problem lives" },
	{ re: /\b(refactor|migrat|redesign|re-?architect|overhaul|rewrite)\w*\b/i, why: "the change is structural" },
	{ re: /\b(across|throughout|every|all) (the )?(files?|modules?|packages?|services?|call ?sites?)\b/i, why: "the change is cross-cutting" },
	{ re: /\b(design|plan|strategy|options|trade-?offs?|approach)\b/i, why: "the task asks for a plan before code" },
]);

/**
 * Signals that a task is risky in the routing sense: irreversible, or touching
 * things whose failure is not a rerun away (cp-rte). Separate list from
 * PIPELINE_SIGNALS on purpose — "I do not know where this lives" argues for a
 * plan, while "this deletes data" argues for a better model.
 */
export const RISK_SIGNALS: ReadonlyArray<{ re: RegExp; why: string }> = Object.freeze([
	{ re: /\b(migrat\w*|backfill|drop (the )?(table|column|index)|delete|destroy|truncate|purge)\b/i, why: "the task is destructive or irreversible" },
	{ re: /\b(force[- ]?push(es|ed|ing)?|rewrit(e|es|ing) ((the|shared|git|branch|public) )*history|rebase (the )?(main|master|trunk))\b/i, why: "the task rewrites shared history" },
	// Access work only: `authority`/`author` are ordinary prose, never credentials (bead b-qbi.2).
	{ re: /\b(secrets?|credentials?|tokens?|password|auth([nz]|entication|enticat(e[sd]?|ing)|ori[sz]ation|ori[sz](e[sd]?|ing))?|permissions?|access control)\b/i, why: "the task touches credentials or access" },
	{ re: /\b(payment|billing|invoice|charge|refund)\b/i, why: "the task touches money" },
	{ re: /\b(prod|production|live (system|site|traffic))\b/i, why: "the task names production" },
]);

/** Shared inference/warning filter: omit negations and Constraints/Non-goals
 * sections, retaining affirmative matches in signal order then text order. */
export function acceptedRiskMatches(text: string, alsoBenign?: (text: string, index: number, word: string) => boolean): Array<{ word: string; why: string }> {
	let excludedLevel: number | undefined;
	let fence: string | undefined;
	text = text.split("\n").map((line) => {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marker?.[1]) {
			if (fence) {
				if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2]?.trim()) fence = undefined;
			} else if (marker[1][0] !== "`" || !marker[2]?.includes("`")) {
				fence = marker[1];
			}
		}
		// Fenced examples are still risk evidence, but their headings are literal text.
		const heading = fence ? null : /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading?.[1] && heading[2]) {
			const level = heading[1].length;
			if (excludedLevel !== undefined && level <= excludedLevel) excludedLevel = undefined;
			if (excludedLevel === undefined && /^(constraints|non-goals):?$/i.test(heading[2])) excludedLevel = level;
		}
		return excludedLevel === undefined ? line : "";
	}).join("\n");
	const out: Array<{ word: string; why: string }> = [];
	for (const { re, why } of RISK_SIGNALS) {
		for (const match of text.matchAll(new RegExp(re.source, "gi"))) {
			const at = match.index ?? 0;
			if (!negatedAt(text, at, match[0]) && !benignSenseAt(text, at, match[0]) && !alsoBenign?.(text, at, match[0])) out.push({ word: match[0], why });
		}
	}
	return out;
}

/** Signals that splitting would be ceremony (ported: "do not split small jobs"). */
const SINGLE_SIGNALS: ReadonlyArray<{ re: RegExp; why: string }> = Object.freeze([
	{ re: /\b(typo|one-?liner?|one line|bump|rename|revert|comment|changelog|readme)\b/i, why: "the change is small and named" },
	{ re: /\b(add|fix|update|remove) (the )?\S+\.\w{1,5}\b/i, why: "the task names the file to change" },
]);

/**
 * Scope and risk inferred from a job's own words, for a caller that named
 * neither (cp-rte).
 *
 * Routing's rubric matches on `scope` and `risk`, and both defaulted to
 * `S`/`low` whenever a dispatch omitted them — so unlabelled work silently
 * routed as small, which is the failure mode nobody notices. This is the same
 * deterministic signal set the intake classifier already uses, read for a
 * different question, and it stays **advisory**: an explicit scope or risk from
 * the caller always wins, and the reasons travel with the answer.
 */
export function inferScopeAndRisk(task: string): {
	scope?: Scope;
	risk?: Risk;
	/** The one reason for `scope`, so a caller can keep it only for the axis it kept. */
	scopeReason?: string;
	/** The one reason for `risk`, same rule. */
	riskReason?: string;
	reasons: string[];
} {
	const reasons: string[] = [];
	let scope: Scope | undefined;
	let risk: Risk | undefined;
	let scopeReason: string | undefined;
	let riskReason: string | undefined;
	for (const signal of PIPELINE_SIGNALS) {
		if (!signal.re.test(task)) continue;
		// Structural or cross-cutting wording means the work is not small; it does
		// not tell us it is huge, so this says M and lets a human say L.
		scope = "M";
		scopeReason = `scope M: ${signal.why}`;
		reasons.push(scopeReason);
		break;
	}
	const accepted = acceptedRiskMatches(task)[0];
	if (accepted) {
		risk = "high";
		riskReason = `risk high: ${accepted.why}`;
		reasons.push(riskReason);
	}
	return {
		...(scope ? { scope } : {}),
		...(risk ? { risk } : {}),
		...(scopeReason ? { scopeReason } : {}),
		...(riskReason ? { riskReason } : {}),
		reasons,
	};
}

/**
 * Deterministic recommendation with its reasons. This is **advisory**: the
 * classifying agent (or the operator) can force either mode, and forcing wins.
 * What is *not* advisory is the pipeline's structure — two issues, a dep link,
 * a gate and a checkpoint — which this module enforces once a pipeline starts.
 */
export function classifyIntake(input: ClassifyInput): Classification {
	if (input.force) {
		return { mode: input.force, reasons: [`caller forced ${input.force}`], forced: true };
	}
	const reasons: string[] = [];
	// cp-u3o4: a question is recognised before anything else, because every other
	// branch here is about how much *work* the task is. `kind:ship` is never a
	// question, and an explicit scope/risk means the caller already sized it.
	if (input.kind !== "ship" && input.scope === undefined && input.risk === undefined) {
		const qa = looksLikeQuestion(input.task);
		if (qa.question) return { mode: "qa", reasons: qa.reasons, forced: false };
	}
	if (input.kind === "research") {
		return { mode: "single", reasons: ["kind:research is a single research job, not a pipeline"], forced: false };
	}
	if (input.scope === "L") reasons.push("scope L");
	if (input.risk === "high") reasons.push("risk high");
	for (const signal of PIPELINE_SIGNALS) {
		if (signal.re.test(input.task)) reasons.push(signal.why);
	}
	if (reasons.length > 0) return { mode: "pipeline", reasons, forced: false };

	const single = SINGLE_SIGNALS.filter((signal) => signal.re.test(input.task)).map((signal) => signal.why);
	return {
		mode: "single",
		reasons: single.length > 0 ? single : ["no ambiguity or cross-cutting signal: one worker is enough"],
		forced: false,
	};
}


/**
 * How to label a caller-supplied routing axis: one word for both, or one word
 * per axis. Per-axis exists because a pipeline handoff genuinely mixes sources
 * — the implementer's `scope` is the planner's measurement, while its `risk` is
 * the task's own known impact, retained from `cp_pipeline start` (routing T2).
 */
export type SuppliedBy = RoutingProvenance | { scope?: RoutingProvenance; risk?: RoutingProvenance };

function suppliedFor(suppliedBy: SuppliedBy | undefined, axis: "scope" | "risk"): RoutingProvenance {
	if (suppliedBy === undefined) return "explicit";
	if (typeof suppliedBy === "string") return suppliedBy;
	return suppliedBy[axis] ?? "explicit";
}

/**
 * Where routing's two axes came from, and what routing was actually given
 * (cp-routing-provenance). Exported because it IS the resolution boundary:
 * tests exercise this function, never a copy of the conditional it replaced.
 * `src/dispatch.ts` re-exports it, which is the import path callers use.
 *
 * The defect it fixes: inference used to be switched off wholesale the moment
 * *either* axis was supplied, so `scope: "M"` on a credential-rotation task
 * silently threw away every risk signal in the text and routed it as `M`/`low`.
 * Each axis is now assessed on its own and the caller's value is overlaid on
 * top of its own axis only.
 *
 * The `S`/`low` defaults are normalized here, once, instead of being
 * substituted invisibly inside `pickModel` — so the record can say a value was
 * `defaulted` rather than pretending somebody chose it.
 */
export function resolveRoutingInputs(input: {
	/** Everything the job says about itself: task text, title, description. */
	text: string;
	scope?: Scope;
	risk?: Risk;
	/** How to label a caller-supplied axis. A planner's measurement is `assessed`. */
	suppliedBy?: SuppliedBy;
}): { scope: Scope; risk: Risk; provenance: { scope: RoutingProvenance; risk: RoutingProvenance }; reasons: string[] } {
	const assessment = inferScopeAndRisk(input.text);
	const scopeFrom: RoutingProvenance =
		input.scope !== undefined
			? suppliedFor(input.suppliedBy, "scope")
			: assessment.scope !== undefined
				? "inferred"
				: "defaulted";
	const riskFrom: RoutingProvenance =
		input.risk !== undefined
			? suppliedFor(input.suppliedBy, "risk")
			: assessment.risk !== undefined
				? "inferred"
				: "defaulted";
	return {
		scope: input.scope ?? assessment.scope ?? "S",
		risk: input.risk ?? assessment.risk ?? "low",
		provenance: { scope: scopeFrom, risk: riskFrom },
		// Only the axes that were actually inferred keep their evidence: a reason
		// for an axis the caller named is evidence for a decision nothing made.
		reasons: [
			...(scopeFrom === "inferred" && assessment.scopeReason ? [assessment.scopeReason] : []),
			...(riskFrom === "inferred" && assessment.riskReason ? [assessment.riskReason] : []),
		],
	};
}

/** The routing facts as the fleet record and the run event both carry them. */
export function routingRecord(inputs: ReturnType<typeof resolveRoutingInputs>, thinking?: ThinkingLevel): JobRouting {
	return {
		scope: inputs.scope,
		risk: inputs.risk,
		...(thinking ? { thinking } : {}),
		// The legacy one-bit summary, kept honest: true when ANY axis was inferred.
		// `provenance` is what a reader should branch on.
		inferred: inputs.provenance.scope === "inferred" || inputs.provenance.risk === "inferred",
		provenance: inputs.provenance,
		...(inputs.reasons.length > 0 ? { reasons: inputs.reasons } : {}),
	};
}

/**
 * The task's own impact, frozen at `cp_pipeline start` (routing T2): the axes
 * the operator named, overlaid on what the original task text says about
 * itself. Never the planner's rewritten `Goal` — this is assessed from the task
 * the pipeline was started with, before anybody wrote a plan for it.
 */
export function taskImpactFrom(input: { text: string; scope?: Scope; risk?: Risk }): TaskImpact {
	return {
		routing: routingRecord(
			resolveRoutingInputs({
				text: input.text,
				...(input.scope ? { scope: input.scope } : {}),
				...(input.risk ? { risk: input.risk } : {}),
			}),
		),
		source: "start",
	};
}

// ---------------------------------------------------------------------------
// Pipeline store
// ---------------------------------------------------------------------------

export class PipelineStore {
	readonly home: string;

	constructor(home: string) {
		this.home = home;
	}

	file(researchId: string): string {
		return join(this.home, paths.pipelineFile(researchId));
	}

	get(researchId: string): PipelineRecord | undefined {
		const file = this.file(researchId);
		if (!existsSync(file)) return undefined;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new PipelineError(`${file} could not be read: ${(error as Error).message}`);
		}
		const parsed = validate<PipelineRecord>(PipelineRecordSchema, raw);
		if (!parsed.ok) {
			throw new PipelineError(`${file} violates the pipeline contract:\n  ${parsed.errors.join("\n  ")}`);
		}
		return parsed.value;
	}

	require(researchId: string): PipelineRecord {
		const record = this.get(researchId);
		if (!record) {
			throw new PipelineError(
				`no pipeline for ${researchId} — start one with cp_pipeline start, or drive the job with cp_dispatch alone`,
			);
		}
		return record;
	}

	write(record: PipelineRecord): PipelineRecord {
		const parsed = validate<PipelineRecord>(PipelineRecordSchema, record);
		if (!parsed.ok) {
			throw new PipelineError(`refusing to write an invalid pipeline record:\n  ${parsed.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file(record.research_id), record);
		return record;
	}

	setState(researchId: string, state: PipelineState, at: string = isoTimestamp()): PipelineRecord {
		const record = this.require(researchId);
		if (record.state === state) return record;
		return this.write({ ...record, state, updated_at: at });
	}

	/** The pipeline has acted on the quality report (spec 2026-09-05). Write-once. */
	setQualityActed(researchId: string, at: string = isoTimestamp()): PipelineRecord {
		const record = this.require(researchId);
		if (record.quality_acted_at !== undefined) return record;
		return this.write({ ...record, quality_acted_at: at, updated_at: at });
	}

	/**
	 * Reverse lookup by the ship job (cp-n10): the record file is keyed by the
	 * research job, but `/cp-authorize` and its error paths only ever have the
	 * ship id in hand. A directory scan, not an index — pipelines are few and
	 * this is off the hot path.
	 */
	findByShipId(shipId: string): PipelineRecord | undefined {
		return this.list().find((record) => record.ship_id === shipId);
	}

	/**
	 * Every pipeline record on disk (cp-80cv), for the callers that need the
	 * research → ship links rather than one record: `mergeAwaiting` reads them to
	 * tell a pipeline's research job from a standalone one. A directory scan for
	 * the same reason `findByShipId` was one — pipelines are few, and an index
	 * that can go stale is worse than a read. A record that will not parse is
	 * skipped, never thrown: a listing must not fail because one file is corrupt.
	 */
	list(): PipelineRecord[] {
		const dir = join(this.home, LAYOUT.pipelines);
		if (!existsSync(dir)) return [];
		const records: PipelineRecord[] = [];
		for (const name of readdirSync(dir).sort()) {
			if (!name.endsWith(".json")) continue;
			const researchId = name.slice(0, -".json".length);
			try {
				const record = this.get(researchId);
				if (record) records.push(record);
			} catch {
				continue;
			}
		}
		return records;
	}
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Asks a human. `undefined` means "could not ask" (no operator attached, dialog
 * dismissed) and leaves the checkpoint pending — not-now is not a no, and a
 * decline is a decision that goes on the record forever.
 */
export interface Authorizer {
	ask(checkpoint: Checkpoint): Promise<{ approved: boolean; by: string; note?: string } | undefined>;
}

/**
 * What one diff-review attempt decided, as `advance()` needs it: the persisted
 * verdict, and what the gate's own ladder says to do with it. No policy is
 * defined here or anywhere else in this module — `nextAction` (`src/gate.ts`)
 * is the single implementation, and this type only carries its answer.
 */
export interface DiffReviewOutcome {
	verdict: DiffVerdict;
	/** proceed | revise | retry | authorize | surface — `nextAction(verdict)`. */
	next: GateNext;
	/** `state/runs/<ship-id>/review-<attempt>.json`. */
	path: string;
	model?: string;
}

/**
 * The diff-review orchestrator (`DiffReview`, `src/diff-review.ts`) as the
 * pipeline needs it — deliberately narrow: `advance()` needs exactly two facts
 * from it and nothing about how either is produced.
 *
 *  - `headSha` is the freshness signal. A `DiffVerdict` records the commit it
 *    read, so "is this verdict still about the code we would ship" is a commit
 *    comparison, never a file mtime.
 *  - `review` is one attempt, with the revise cap, attempt numbering and the
 *    verdict ladder all owned by that module.
 *
 * `DiffReview` satisfies this structurally; a test can satisfy it with a stub.
 */
export interface DiffReviewer {
	headSha(jobId: string): Promise<string | undefined>;
	start(request: { jobId: string; model?: string; directive?: string }): Promise<DiffReviewOutcome | DiffReviewWait>;
}

/**
 * What the diff gate did to this advance. `held` present means the pipeline
 * stops here and this is the operator's answer; `held` absent means `done` is
 * allowed — either because the job never opted in (an empty step) or because a
 * fresh verdict said so.
 */
interface ReviewStep {
	held?: AdvanceResult;
	outcome?: DiffReviewOutcome;
	checkpoint?: Checkpoint;
	/** Appended to the `done` message, so the gate is visible in the outcome. */
	note?: string;
}

export interface PipelineOptions {
	home: string;
	ledger: Ledger;
	dispatcher: () => Dispatcher;
	gate: () => Gate;
	artifacts: ArtifactStore;
	fleet: FleetStore;
	teardown: Teardown;
	/** Present: a passed gate can ask the operator right away. */
	authorizer?: Authorizer;
	/**
	 * cp-answer-doesnt-wake: passed straight through to this runner's
	 * `CheckpointStore`, so an authorization granted here (`/cp-authorize`, the
	 * authorizer dialog, `/cp-decide approve`) wakes the parent like any other
	 * answer. A pipeline that is approved and then stalls is the failure mode.
	 */
	onAnswered?: AnsweredSink;
	/** The opt-in pre-gate panel (T22). Absent means the job never gets one. */
	quality?: () => QualityPass;
	/**
	 * The opt-in post-implementation diff gate (Stage D). Absent means `advance`
	 * cannot run a review itself: a record that asked for one is then held short
	 * of `done` until an out-of-band `cp_review` produces a fresh verdict, never
	 * waved through.
	 */
	review?: () => DiffReviewer;
	/** Home-wide quality defaults (`data/quality.json`), still off unless set. */
	qualityDefaults?: QualityConfig;
	/**
	 * The registry that makes a reviewer asynchronous (spec 2026-09-05). Absent:
	 * `advance` behaves as it did, waiting for each verdict inline.
	 */
	reviews?: ReviewRuns;
	/** Promote the planner when the quality pass asks for fixes. */
	send?: (jobId: string, message: string) => Promise<{ receipt: string; error?: string }>;
	now?: () => Date;
	/** Shared with CommandPost so a console approval is the same file the runner reads. */
	approvals?: ReviewApprovalStore;
	/** Shared or defaulted from `home`; an open `review` is not a hung planner. */
	questions?: QuestionStore;
	/** Operator-issued bounded authority; absent means every checkpoint stays pending. */
	mandates?: MandateStore;
	/** Gate escalate/policy writes here so the parent relays rather than composes. */
	escalations?: EscalationStore;
}

export interface StartRequest {
	title: string;
	project: string;
	task: string;
	/** Delivery of the ship job. The research job is always `pipeline`. */
	delivery?: Delivery;
	scope?: Scope;
	risk?: Risk;
	model?: string;
	base?: string;
	fetch?: boolean;
	/** Wall-clock override for both planner and implementer dispatches. */
	wallClockSeconds?: number;
	reasons?: string[];
	/** Slug hints for the two job ids. */
	slug?: string;
	/** Per-job opt-in for the pre-gate quality panel (T22). Off by default. */
	quality?: QualityConfig;
	/** Per-job opt-in for the post-implementation diff gate. Off by default. */
	review?: DiffReviewConfig;
}

export interface StartResult {
	research_id: string;
	ship_id: string;
	record: PipelineRecord;
	dispatch: DispatchResult;
}

export interface AdvanceResult {
	research_id: string;
	ship_id: string;
	state: PipelineState;
	/** What the caller should do now. */
	next: "wait" | "authorize" | "surface" | "done";
	message: string;
	gate?: GateResult;
	checkpoint?: Checkpoint;
	teardown?: TeardownResult;
	dispatch?: DispatchResult;
	/** True when the gate ran from an artifact with no envelope (ported). */
	hung_planner?: boolean;
	/** Present when this job opted into the pre-gate panel (T22). */
	quality?: QualityReport;
	/**
	 * Present when this advance ran a diff review (Stage D). A held pipeline that
	 * is replaying a verdict already on disk leaves this unset: nothing new was
	 * decided, and only the message says so.
	 */
	review?: DiffReviewOutcome;
	/** A reviewer is running for this job; act on its cp-verdict wake-up (spec 2026-09-05). */
	pending?: { surface: ReviewSurface; attempt: number; deadline: string };
}

export class PipelineRunner {
	readonly store: PipelineStore;
	readonly checkpoints: CheckpointStore;
	/**
	 * The second authorization's store (Stage D): the same `CheckpointStore`
	 * discipline against `paths.checkpointFile(shipId, "diff")`, so a flagged diff
	 * review can ask a human without touching — or inheriting the answer of — the
	 * pre-implementation checkpoint.
	 *
	 * It carries the same `onAnswered` sink as `checkpoints` (cp-khf). It could
	 * not before: the wake-up hardcoded the awaiting-row id
	 * `aw-checkpoint-<ship-id>`, which identifies the *pre-implementation* row, so
	 * reporting a diff answer under it would have resolved the wrong decision.
	 * `checkpointAwaitingId` is kind-aware now, so the diff answer carries
	 * `aw-checkpoint-<ship-id>.diff` and one decision still has one identity.
	 */
	readonly diffCheckpoints: CheckpointStore;
	readonly #options: PipelineOptions;
	readonly #approvals: ReviewApprovalStore;

	constructor(options: PipelineOptions) {
		this.#options = options;
		this.store = new PipelineStore(options.home);
		this.checkpoints = new CheckpointStore(options.home, options.onAnswered ? { onAnswered: options.onAnswered } : {});
		this.diffCheckpoints = new CheckpointStore(options.home, {
			kind: "diff",
			...(options.onAnswered ? { onAnswered: options.onAnswered } : {}),
		});
		this.#approvals = options.approvals ?? new ReviewApprovalStore(options.home);
	}

	#now(): string {
		return isoTimestamp((this.#options.now ?? (() => new Date()))());
	}

	#mandateJobs(): MandateUsageJob[] {
		const fleet = this.#options.fleet as { read?: () => { jobs: MandateUsageJob[] } };
		if (typeof fleet.read !== "function") return [];
		try {
			return fleet.read().jobs ?? [];
		} catch {
			return [];
		}
	}

	#mandateText(record: PipelineRecord): string {
		const frozen = join(this.#options.home, paths.originalTaskFile(record.research_id));
		if (!existsSync(frozen)) return "";
		try {
			return readFileSync(frozen, "utf8");
		} catch {
			return "";
		}
	}

	#tryMandate(
		store: CheckpointStore,
		checkpoint: Checkpoint,
		record: PipelineRecord,
		kind: "ship" | "diff",
		routing: ComposedRouting,
		/** The ship (plan) checkpoint's gate flags; the diff path is out of Job A's scope. */
		flags?: GateFlags,
	): Checkpoint {
		if (!this.#options.mandates) return checkpoint;
		const text = this.#mandateText(record);
		return autoDecideCheckpoint(
			store,
			checkpoint,
			{
				kind,
				jobId: record.ship_id,
				project: record.project,
				jobKind: "ship",
				...(flags ? { gateFlags: flags } : {}),
				...(routing.risk ? { risk: routing.risk } : {}),
				...(routing.inputsFrom.risk ? { riskProvenance: routing.inputsFrom.risk } : {}),
				...(text ? { text, pathHints: [text] } : {}),
				now: this.#now(),
				usageJobs: this.#mandateJobs(),
			},
			this.#options.mandates,
		);
	}

	/**
	 * Two br issues, dep-linked, and the planner dispatched. The ship issue
	 * is created **blocked**: `br ready` must never offer it before the research
	 * closes, and that is the ledger's job, not a convention.
	 */
	async start(request: StartRequest): Promise<StartResult> {
		const { ledger } = this.#options;
		const delivery: Delivery = request.delivery ?? "pr";
		// cp-u3o4: `answer` is the Q&A delivery and it names no ship job at all. The
		// tool schema already restricts the parameter to pr|local; this keeps it true
		// for every non-tool caller, in code, where the pipeline record is written.
		if (delivery === "answer") {
			throw new PipelineError(
				"delivery:answer is the Q&A path (cp_ask), not a pipeline delivery — a pipeline ends in a ship job, and an answer is not one",
			);
		}
		const title = request.title.trim();
		if (title.length === 0) throw new PipelineError("a pipeline needs a title");

		const research = await ledger.create({
			title: `research: ${title}`,
			project: request.project,
			delivery: "pipeline",
			kind: "research",
			description: request.task,
			...(request.risk ? { risk: request.risk } : {}),
			...(request.slug ? { slug: `${request.slug}-research` } : {}),
		});
		const ship = await ledger.create({
			title: `ship: ${title}`,
			project: request.project,
			delivery,
			kind: "ship",
			description: request.task,
			...(request.risk ? { risk: request.risk } : {}),
			...(request.slug ? { slug: `${request.slug}-ship` } : {}),
		});
		await ledger.addDep(ship.id, research.id);

		const at = this.#now();
		const record = this.store.write({
			schema_version: SCHEMA_VERSION,
			research_id: research.id,
			ship_id: ship.id,
			project: request.project,
			delivery,
			state: "researching",
			created_at: at,
			updated_at: at,
			...(request.wallClockSeconds !== undefined ? { wall_clock_seconds: request.wallClockSeconds } : {}),
			...(request.quality ? { quality: request.quality } : {}),
			...(request.review ? { review: request.review } : {}),
			...(request.reasons && request.reasons.length > 0 ? { reasons: request.reasons.slice(0, 10) } : {}),
			// routing T2: what the operator said about the work, plus what the task's
			// own words say, frozen here — before a planner exists to restate them.
			// Without this the axes reached the research dispatch and stopped there,
			// and the implementer was routed from the plan alone.
			task_impact: taskImpactFrom({
				text: [title, request.task].join("\n"),
				...(request.scope ? { scope: request.scope } : {}),
				...(request.risk ? { risk: request.risk } : {}),
			}),
		});

		const dispatch = await this.#options.dispatcher().dispatch({
			jobId: research.id,
			task: request.task,
			...(request.wallClockSeconds !== undefined ? { wallClockSeconds: request.wallClockSeconds } : {}),
			...(request.scope ? { scope: request.scope } : {}),
			...(request.risk ? { risk: request.risk } : {}),
			...(request.model ? { model: request.model } : {}),
			...(request.base ? { base: request.base } : {}),
			...(request.fetch === false ? { fetch: false } : {}),
		});
		return { research_id: research.id, ship_id: ship.id, record, dispatch };
	}

	/**
	 * One step of the machine, driven entirely by what is on disk. Safe to call
	 * repeatedly: every transition is guarded by the fact that produces it.
	 */
	async advance(researchId: string): Promise<AdvanceResult> {
		const record = this.store.require(researchId);
		if (record.superseded_by) {
			throw new PipelineError(
				`${researchId} was superseded by ${record.superseded_by} (cp_pipeline reanchor) — its artifact must never reach an ` +
					`implementer; advance ${record.superseded_by} instead.`,
			);
		}
		const { artifacts, fleet } = this.#options;

		// --- 0. the implementer already has it --------------------------------
		// Keyed on the SHIP job's facts, not on this record's state: once an
		// implementer exists, everything upstream is spent. Without this, a second
		// advance walks the whole ladder again on a settled record (the gate says
		// pass, the checkpoint is already approved) and reaches
		// `#dispatchImplementer` a second time. It also makes `done` reachable:
		// nothing else ever wrote the terminal state the contract documents.
		const shipJob = fleet.get(record.ship_id);
		if (shipJob) {
			if (shipJob.reported_at !== undefined || shipJob.phase === "done") {
				// Stage D of cp-diffgate-redo-hxb: the opt-in diff gate sits exactly
				// here, between "the implementer reported" and "the pipeline is done".
				// A record with `review` absent or false never enters it, and reaches
				// `done` on precisely the facts it did before this existed.
				const reviewed = await this.#reviewStep(record);
				if (reviewed.held) return reviewed.held;
				this.store.setState(researchId, "done", this.#now());
				return this.#step(record, "done", "done", `${record.ship_id}: implementer reported; the pipeline is done.${reviewed.note ?? ""}`, {
					...(reviewed.outcome ? { review: reviewed.outcome } : {}),
					...(reviewed.checkpoint ? { checkpoint: reviewed.checkpoint } : {}),
				});
			}
			this.store.setState(researchId, "implementing", this.#now());
			if (shipJob.phase === "failed") {
				return this.#step(
					record,
					"implementing",
					"surface",
					`${record.ship_id}: the implementer failed. Recover it with cp_pipeline recover (same brief, same task file); ` +
						"the research is not re-run.",
				);
			}
			return this.#step(record, "implementing", "wait", `${record.ship_id}: the implementer is working.`);
		}

		// --- 1. is there anything to gate yet? -------------------------------
		const job = fleet.get(researchId);
		const reported = job?.reported_at !== undefined;
		const hasArtifact = artifacts.has(researchId);
		if (!hasArtifact) {
			this.store.setState(researchId, "researching", this.#now());
			return this.#step(record, "researching", "wait", `${researchId}: no artifact yet — the planner is still working.`);
		}
		// A blocked planner envelope is questions for the parent, not a plan to gate.
		// Console plan review is gone (plan envelopes file immediately).
		const blocked = this.#plannerBlocked(researchId);
		if (blocked) {
			this.store.setState(researchId, "researching", this.#now());
			if (blocked === "escalate") {
				return this.#step(
					record,
					"researching",
					"surface",
					`${researchId}: blocked round exceeds ${PLANNER_BLOCKED_ROUND_CAP}. Escalated; do not gate and do not answer the blockers.`,
				);
			}
			return this.#step(
				record,
				"researching",
				"wait",
				`${researchId}: blocked on planner questions. Answer from the cp-envelope and cp_send; do not gate.`,
			);
		}
		// Ported hung-planner recovery: an artifact at the predeclared path
		// with no envelope is still evidence. Gate it; the missing envelope is a
		// worker problem, not a reason to redo the research.
		// "Never reported at all" — not "reported, then promoted": a supersession
		// clears `reported_at` on purpose and is not a hung planner.
		const hungPlanner = hasArtifact && !reported && (job?.supersessions ?? 0) === 0;

		// --- 2/3. a reviewer already running owns this step ---------------------
		const running = this.#pendingOn(researchId);
		if (running) return this.#waitOn(record, "gating", running, hungPlanner ? { hung_planner: true } : {});

		// --- 2. the optional panel, before the expensive gate -----------------
		const { report: quality, fresh, wait: qualityWait } = await this.#quality(record);
		if (qualityWait) return this.#waitOn(record, "gating", qualityWait, hungPlanner ? { hung_planner: true } : {});
		const qualityExtra = quality ? { quality } : {};
		if (quality && fresh && !quality.passed) {
			// One cheap pass, one cheap fix, then the real gate. The report is
			// write-once and only a *fresh* failure holds the job back: a second
			// advance proceeds to the gate whatever the panel thought, because the
			// panel is a pre-check, not a second gate with an unbounded loop.
			const promote = await this.#promote(researchId, qualityFixMessage(quality));
			this.store.setQualityActed(researchId, this.#now());
			this.store.setState(researchId, "gating", this.#now());
			return this.#step(
				record,
				"gating",
				"wait",
				`${researchId}: pre-gate quality pass asked for fixes${promote ? ` (${promote})` : ""}.`,
				{ ...qualityExtra, ...(hungPlanner ? { hung_planner: true } : {}) },
			);
		}

		// --- 3. the gate ------------------------------------------------------
		// A passing fresh report is acted on by going to the gate.
		if (quality && fresh) this.store.setQualityActed(researchId, this.#now());
		const prior = readPriorAttempts(this.#options.home, researchId);
		let last: GateVerdict | undefined = prior.decisions.at(-1);
		let gateResult: GateResult | undefined;
		// Three reasons to (re)gate, all facts: nothing has been judged yet, the
		// last attempt was an operational fault (the ladder retries on a different
		// model), or the artifact has changed since the last verdict — a revised
		// artifact is a new artifact, and the revise is only spent once it is judged.
		const artifact = artifacts.info(researchId);
		const revised =
			last?.verdict === "revise" && artifact.modified_at !== undefined && artifact.modified_at > last.decided_at;
		// A deciding-party revise re-gates only once the artifact moved after the request.
		const reviseAt = decisionReviseAt(this.#options.home, researchId);
		const changedAfterRevise =
			reviseAt !== undefined &&
			artifact.modified_at !== undefined &&
			artifact.modified_at > reviseAt &&
			(last === undefined || artifact.modified_at > last.decided_at);
		const needsGate =
			!last || (last.verdict === "escalate" && last.cause === "operational") || revised || changedAfterRevise;
		if (needsGate) {
			const started = await this.#options.gate().start({
				jobId: researchId,
				directive: `call cp_pipeline advance ${researchId}`,
			});
			if (isGateWait(started)) {
				return this.#waitOn(record, "gating", started, {
					...qualityExtra,
					...(hungPlanner ? { hung_planner: true } : {}),
				});
			}
			// The synchronous branch is reached only when `start` decided without a
			// reviewer (a spawn that could not run, or an attempt already decided).
			gateResult = started;
			last = gateResult.verdict;
		}
		if (!last) throw new PipelineError(`${researchId}: gate produced no decision`);

		if (last.verdict === "revise") {
			this.store.setState(researchId, "gating", this.#now());
			// Two different situations, and the operator must be able to tell them
			// apart: a verdict we just produced, or a revision already delivered whose
			// artifact has not moved. The second one looks like progress forever if it
			// keeps saying "the planner has it".
			if (gateResult) {
				return this.#step(
					record,
					"gating",
					"wait",
					`${researchId}: gate asked for one revision; the planner has it.\n${formatGate(gateResult)}`,
					{ ...qualityExtra, gate: gateResult, ...(hungPlanner ? { hung_planner: true } : {}) },
				);
			}
			// Replaying a revise verdict: check if the artifact changed since the verdict.
			const artifactChanged = artifact.modified_at !== undefined && artifact.modified_at > last.decided_at;
			if (artifactChanged) {
				return this.#step(
					record,
					"gating",
					"wait",
					`${researchId}: replaying gate attempt ${last.attempt} verdict from ${last.decided_at}. The artifact has changed since the verdict was made (modified ${artifact.modified_at} vs decided ${last.decided_at}). Run cp_gate <job-id> for a fresh review, or update the artifact if the changes were unintended.`,
					{ ...qualityExtra, ...(hungPlanner ? { hung_planner: true } : {}) },
				);
			}
			return this.#step(
				record,
				"gating",
				"wait",
				`${researchId}: replaying gate attempt ${last.attempt} verdict from ${last.decided_at}; the artifact has not changed yet. The revision is with the planner.`,
				{ ...qualityExtra, ...(hungPlanner ? { hung_planner: true } : {}) },
			);
		}
		// A `flagged` escalate is the one escalate shape that still reaches a
		// checkpoint: the reviewer found the plan sound on every quality criterion
		// and escalated only because a veto flag (destructive_scope and/or
		// scope_growth) is set. Everything else that escalates (a reviewer's own
		// judgment, an exhausted revise cap, an operational fault) keeps surfacing and never
		// reaches `#authorize` — that distinction is gate policy (T20/cp-n10), not
		// something this method may weaken.
		const flagged = last.verdict === "escalate" && last.cause === "flagged";
		const override = gateOverride(this.#options.escalations, last, artifact.modified_at);
		if (last.verdict === "escalate" && !flagged && !override) {
			this.store.setState(researchId, "escalated", this.#now());
			if (this.#options.escalations) {
				try {
					await raiseForGate(this.#options.escalations, last);
				} catch {
					// Surfacing still happens; the record is best-effort.
				}
			}
			if (gateResult) {
				return this.#step(
					record,
					"escalated",
					last.cause === "operational" ? "wait" : "surface",
					`${researchId}: gate escalated (cause ${last.cause}). ${
						last.cause === "operational" ? "Re-run cp_pipeline advance: the next attempt uses a different model." : "This is yours now."
					}\n${formatGate(gateResult)}`,
					{ ...qualityExtra, gate: gateResult, ...(hungPlanner ? { hung_planner: true } : {}) },
				);
			}
			// Replaying a terminal escalate: report it as a replay and check if artifact changed.
			const artifactChanged = artifact.modified_at !== undefined && artifact.modified_at > last.decided_at;
			const artifactWarning = artifactChanged
				? ` The artifact has changed since the verdict (modified ${artifact.modified_at} vs decided ${last.decided_at}). Run cp_gate <job-id> for a fresh review.`
				: "";
			const nextAction = last.cause === "operational" ? "wait" : "surface";
			const nextMsg = last.cause === "operational"
				? "Re-run cp_pipeline advance: the next attempt uses a different model."
				: "This is yours now.";
			return this.#step(
				record,
				"escalated",
				nextAction,
				`${researchId}: replaying gate attempt ${last.attempt} verdict from ${last.decided_at} (cause ${last.cause}). ${nextMsg}${artifactWarning}\n${last.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
				{ ...qualityExtra, ...(hungPlanner ? { hung_planner: true } : {}) },
			);
		}

		// --- 4. pass, flagged escalate or explicit override: retain the checkpoint --
		await this.#closeResearch(researchId, last);
		const checkpoint = await this.#authorize(record, last);
		if (checkpoint.decision !== "approved") {
			this.store.setState(researchId, "awaiting_authorization", this.#now());
			const flagNote = flagged
				? " The gate escalated on flags (see the checkpoint evidence); the reviewer otherwise found the plan sound."
				: "";
			let detail =
				checkpoint.decision === "declined"
					? `declined${checkpoint.note ? `: ${checkpoint.note}` : ""} — the ship job stays undispatched.`
					: `waiting for a human. Approve with /cp-authorize or cp_checkpoint; a passed gate is quality, never authorization.${flagNote}`;
			// If we're replaying the verdict, label it and check if the artifact changed.
			if (!gateResult) {
				const artifactChanged = artifact.modified_at !== undefined && artifact.modified_at > last.decided_at;
				const replayLabel = `[Replaying gate attempt ${last.attempt} verdict from ${last.decided_at}]${artifactChanged ? " The artifact has changed since the verdict; run cp_gate <job-id> for a fresh review." : ""} `;
				detail = replayLabel + detail;
			}
			return this.#step(record, "awaiting_authorization", checkpoint.decision === "declined" ? "surface" : "authorize", `${record.ship_id}: ${detail}`, {
				checkpoint,
				...qualityExtra,
				...(gateResult ? { gate: gateResult } : {}),
			});
		}

		// --- 5. return the research lease before the implementer takes one ----
		const teardown = await this.#tearDownResearch(researchId);
		if (teardown && !teardown.torn_down && teardown.failure) {
			return this.#step(
				record,
				"awaiting_authorization",
				"surface",
				`${researchId}: research teardown refused (${teardown.failure.code}: ${teardown.failure.message}). ` +
					`${teardown.failure.fix} Nothing was dispatched.`,
				{ teardown, checkpoint },
			);
		}

		// --- 6. hand the artifact over by path, never by context --------------
		const dispatch = await this.#dispatchImplementer(record);
		this.store.setState(researchId, "implementing", this.#now());
		const suggested = this.#selfAssessment(researchId)?.suggested_implementer_model;
		const mismatch =
			suggested && dispatch.model && suggested !== dispatch.model
				? ` The planner suggested ${suggested}; routing chose ${dispatch.model} (${dispatch.routing ?? "no routing line"}).`
				: "";
		let dispatchMsg = `${record.ship_id}: implementer dispatched with the artifact as its task file.${mismatch}${dispatch.risk_warning ? ` ${dispatch.risk_warning}` : ""}`;
		// If we're replaying a pass verdict, label it and check if the artifact changed.
		if (!gateResult && last.verdict === "pass") {
			const artifactChanged = artifact.modified_at !== undefined && artifact.modified_at > last.decided_at;
			dispatchMsg = `[Replaying gate attempt ${last.attempt} verdict from ${last.decided_at}]${artifactChanged ? ` The artifact has changed since the verdict; run cp_gate <job-id> for a fresh review.` : ""} ${dispatchMsg}`;
		}
		return this.#step(record, "implementing", "wait", dispatchMsg, {
			dispatch,
			checkpoint,
			...qualityExtra,
			...(teardown ? { teardown } : {}),
			...(gateResult ? { gate: gateResult } : {}),
			...(hungPlanner ? { hung_planner: true } : {}),
		});
	}

	/**
	 * The journaled human decision. Only this method writes one, and it refuses
	 * to overwrite an answer: an authorization is given once.
	 */
	async decide(shipId: string, approved: boolean, options: { by: string; note?: string }): Promise<Checkpoint> {
		return this.checkpoints.decide(shipId, approved, { ...options, at: this.#now() });
	}

	/**
	 * Re-anchor a pipeline to a replacement research job (cp-n10), without
	 * hand-editing state/. A superseded research job's plan must never reach an
	 * implementer, and the replacement must be re-gated from scratch — both are
	 * true here for free: the old record is marked `superseded_by` (and `advance`
	 * on it now refuses outright), and the new record is a fresh one keyed by
	 * `replacementResearchId`, so it carries no gate history and `advance` gates
	 * it as if for the first time.
	 *
	 * Only sound while researching, gating or escalated. A checkpoint
	 * (`awaiting_authorization`, pending or declined) or a dispatch
	 * (`implementing` / `done`) already rests on the old plan; swapping research
	 * then is a new pipeline (`cp_pipeline start`), not a re-anchor. Decline does
	 * not unlock this: the ship job's authorization is write-once and keyed by
	 * ship id, so `#authorize` would inherit the spent decision.
	 */
	async reanchor(researchId: string, replacementResearchId: string): Promise<PipelineRecord> {
		if (replacementResearchId === researchId) {
			throw new PipelineError(`reanchor needs a research job different from ${researchId}`);
		}
		const old = this.store.require(researchId);
		if (old.superseded_by) {
			throw new PipelineError(`${researchId} is already superseded by ${old.superseded_by} — reanchor that one instead`);
		}
		if (old.state === "awaiting_authorization" || old.state === "implementing" || old.state === "done") {
			const decision = old.state === "awaiting_authorization" ? this.checkpoints.get(old.ship_id)?.decision : undefined;
			if (decision === "declined") {
				throw new PipelineError(
					`${researchId} is already awaiting_authorization — the checkpoint was declined. ` +
						"A replacement plan is a new pipeline (cp_pipeline start), not a reanchor.",
				);
			}
			if (old.state === "awaiting_authorization") {
				throw new PipelineError(
					`${researchId} is already awaiting_authorization — a human decision is pending. ` +
						"Reanchor cannot pre-empt it; decline stops the pipeline, it does not unlock reanchor.",
				);
			}
			throw new PipelineError(
				`${researchId} is already ${old.state} — reanchor only applies while a pipeline is still researching, gating, ` +
					"or escalated. A dispatch already rests on the old plan; start a new pipeline (cp_pipeline start).",
			);
		}
		if (this.store.get(replacementResearchId)) {
			throw new PipelineError(`${replacementResearchId} already has a pipeline record — it cannot also replace ${researchId}`);
		}

		const at = this.#now();
		const replacement = this.store.write({
			schema_version: SCHEMA_VERSION,
			research_id: replacementResearchId,
			ship_id: old.ship_id,
			project: old.project,
			delivery: old.delivery,
			state: "researching",
			created_at: at,
			updated_at: at,
			...(old.wall_clock_seconds !== undefined ? { wall_clock_seconds: old.wall_clock_seconds } : {}),
			...(old.quality ? { quality: old.quality } : {}),
			...(old.review ? { review: old.review } : {}),
			// routing T2: the ship job is the same ship job, so its task's impact is
			// the same fact. A reanchor replaces the *plan*, and new planner
			// measurements are taken from the replacement's own envelope — but the
			// known impact is not a measurement anybody is redoing here. Changing it
			// is an explicit rescope, never a side effect of swapping the research.
			...(old.task_impact ? { task_impact: old.task_impact } : {}),
			reasons: [...(old.reasons ?? []), `re-anchored from ${researchId} (superseded)`].slice(0, 10),
		});
		this.store.write({ ...old, superseded_by: replacementResearchId, updated_at: at });

		// The ledger dep is the operator's view of what blocks the ship job; it
		// must name the replacement, not a research job nobody will ever advance.
		try {
			await this.#options.ledger.removeDep(old.ship_id, researchId);
		} catch {
			// Best-effort: the dep may already be gone (the research closed). The
			// pipeline record is the fact that governs `advance`, not the dep link.
		}
		await this.#options.ledger.addDep(old.ship_id, replacementResearchId).catch(() => undefined);

		return replacement;
	}

	/**
	 * Recovery for a failed implementer: same brief, same task file, bounded.
	 * The research job is never re-run — its findings are not what broke.
	 */
	async recoverShip(researchId: string): Promise<AdvanceResult> {
		const record = this.store.require(researchId);
		const shipId = record.ship_id;
		const job = this.#options.fleet.get(shipId);
		if (!job) throw new PipelineError(`${shipId} was never dispatched — nothing to recover`);
		const classification = classifyRun(readEventLog(this.#options.home, shipId));
		if (!classification) {
			return this.#step(record, record.state, "wait", `${shipId}: nothing to recover — no failure has been observed.`);
		}
		// The ported cross-role rule, asserted rather than remembered: recovery here
		// re-dispatches the implementer and never sends the planner back out.
		if (mayRerunResearch("implementer", "planner")) {
			throw new PipelineError(
				"invariant broken: an implementation failure must never re-run the research that preceded it",
			);
		}
		const attempts = job.failure?.attempt ?? 0;
		const decision = decideRecovery({
			class: classification.class,
			role: "implementer",
			attempts,
			maxAttempts: MAX_RECOVERY_ATTEMPTS,
		});
		if (decision.action === "escalate") {
			return this.#step(record, record.state, "surface", `${shipId}: ${classification.class} — ${decision.reason}`);
		}
		const dispatch = await this.#dispatchImplementer(record);
		return this.#step(record, "implementing", "wait", `${shipId}: re-dispatched from the same task file (${decision.reason}).`, {
			dispatch,
		});
	}

	// -- steps ---------------------------------------------------------------

	/**
	 * The panel, when this job opted in. `fresh` says whether this call is what
	 * produced the report — only a fresh failure holds the job back.
	 */
	async #quality(record: PipelineRecord): Promise<{ report?: QualityReport; fresh: boolean; wait?: ReviewWait }> {
		const config = resolveQualityConfig(this.#options.qualityDefaults, record.quality);
		if (!this.#options.quality || !qualityEnabled(config)) return { fresh: false };
		const pass = this.#options.quality();
		const existing = pass.read(record.research_id);
		// "Fresh" is "no advance has acted on it yet", not "this call wrote it":
		// the report is produced in the background now (spec 2026-09-05).
		if (existing) return { report: existing, fresh: record.quality_acted_at === undefined };
		const task = await this.#task(record.research_id);
		const started = await pass.start({
			jobId: record.research_id,
			task,
			config,
			directive: `call cp_pipeline advance ${record.research_id}`,
		});
		if (isQualityWait(started)) return { fresh: false, wait: started };
		// Decided inline (no registry): the report is new and nobody has acted on it.
		return { ...(started ? { report: started } : {}), fresh: started !== undefined };
	}

	/** The task the artifact was written for: the br description, verbatim. */
	async #task(researchId: string): Promise<string> {
		const issue = await this.#options.ledger.show(researchId).catch(() => undefined);
		const description = typeof issue?.description === "string" ? issue.description.trim() : "";
		return description.length > 0 ? description : (issue?.title ?? researchId);
	}

	/** Deciding-party revise. Next advance re-gates only if the artifact mtime moves past this stamp. */
	async revisePlan(researchId: string, text: string): Promise<string> {
		const message =
			`Revision requested on the filed plan: ${text}\n\n` +
			"Update the artifact. The envelope is already filed; a changed artifact is re-gated.";
		const sent = await this.#promote(researchId, message);
		atomicWriteJson(join(this.#options.home, paths.runDir(researchId), "decision-revise.json"), {
			schema_version: SCHEMA_VERSION,
			at: this.#now(),
			text: text.slice(0, 1000),
		});
		return sent ?? "no sender wired";
	}

	#pinApproval(researchId: string, artifactPath: string, by: string): void {
		try {
			this.#approvals.write({ jobId: researchId, questionSeq: 1, artifactPath, by, at: this.#now() });
		} catch {
			// A missing artifact cannot be pinned; the checkpoint decision still stands.
		}
	}

	async #raisePlanApproval(record: PipelineRecord, verdict: GateVerdict, artifactPath: string): Promise<void> {
		const store = this.#options.escalations;
		if (!store) return;
		const summary = this.#envelope(record.research_id)?.plan_summary;
		const decision = verdict.decision_summary ?? {
			would_make_wrong: "a requirement the artifact does not cover",
			verified: (verdict.reasons[0] ?? "gate passed").slice(0, 400),
		};
		const blocking = this.#blockingMandate();
		await raisePlanApproval(store, {
			researchId: record.research_id,
			shipId: record.ship_id,
			question: `Approve the plan for ${record.ship_id}? ${summary?.goal ?? record.ship_id}`.slice(0, 1000),
			evidence_paths: [artifactPath, paths.gateFile(record.research_id, verdict.attempt)],
			...(summary ? { plan_summary: summary } : {}),
			decision_summary: decision,
			...(blocking ?? {}),
		});
	}

	#blockingMandate(): { mandate_id: string; mandate_clause: string } | undefined {
		const hit = (this.#options.mandates?.list() ?? []).find(
			(mandate) => mandate.status === "active" && mandate.ask_on.includes("plan_approval"),
		);
		if (!hit) return undefined;
		return { mandate_id: hit.id, mandate_clause: `${hit.id}: ask_on includes plan_approval` };
	}

	#envelope(researchId: string): Envelope | undefined {
		const job = this.#options.fleet.get(researchId);
		const file = job
			? lastFiledEnvelopeFile(this.#options.home, job)
			: join(this.#options.home, paths.envelopeFile(researchId));
		if (!file || !existsSync(file)) return undefined;
		try {
			const record = JSON.parse(readFileSync(file, "utf8")) as EnvelopeRecord;
			return record.envelope as Envelope;
		} catch {
			return undefined;
		}
	}

	/** Best-effort promote; a dead planner is reported, never re-dispatched. */
	async #promote(jobId: string, message: string): Promise<string | undefined> {
		if (!this.#options.send) return undefined;
		try {
			const result = await this.#options.send(jobId, message);
			return `promote: ${result.receipt}${result.error ? ` (${result.error})` : ""}`;
		} catch (error) {
			return `promote failed: ${(error as Error).message}`;
		}
	}

	async #closeResearch(researchId: string, verdict: GateVerdict): Promise<void> {
		const issue = await this.#options.ledger.show(researchId).catch(() => undefined);
		if (!issue || issue.status === "closed") return;
		const label = verdict.verdict === "pass" ? "gate pass" : `gate escalate (${verdict.cause})`;
		const reason = `${label} (attempt ${verdict.attempt}, ${verdict.model ?? "unknown model"}): ${verdict.reasons.join("; ")}`;
		await this.#options.ledger.close(researchId, reason.slice(0, 900));
	}

	async #authorize(record: PipelineRecord, verdict: GateVerdict): Promise<Checkpoint> {
		const existing = this.checkpoints.get(record.ship_id);
		if (existing && existing.decision !== "pending") return existing;

		const artifact = this.#options.artifacts.info(record.research_id);
		const assessment = this.#selfAssessment(record.research_id);
		// routing T2: the same composition `#dispatchImplementer` will use, so the
		// human authorizes the assessment implementation actually gets — not the
		// planner's half of it.
		const routing = this.#composedRouting(record);
		// A flagged escalate: the reviewer found the plan sound apart from the
		// flags. The flags and its reasons travel into the question and the
		// evidence, verbatim, so the human authorizes with the danger in full view
		// — never a bare "pass".
		const flagged = verdict.verdict === "escalate" && verdict.cause === "flagged";
		const raisedFlags = (Object.keys(verdict.flags) as Array<keyof GateFlags>).filter((flag) => verdict.flags[flag]);
		let checkpoint =
			existing ??
			this.checkpoints.request({
				jobId: record.ship_id,
				researchId: record.research_id,
				question: flagged
					? `Authorize implementation of ${record.ship_id} (${record.project}, delivery ${record.delivery})? ` +
						`Gate escalated on ${raisedFlags.join(", ")} — the reviewer otherwise found the plan sound.`
					: `Authorize implementation of ${record.ship_id} (${record.project}, delivery ${record.delivery})?`,
				evidence: [
					flagged
						? `gate: escalate (flagged; attempt ${verdict.attempt}, ${verdict.model ?? "unknown model"}) — flags: ${raisedFlags.join(", ")}`
						: `gate: ${verdict.verdict}${verdict.cause ? ` (${verdict.cause}; operator override)` : ""} (attempt ${verdict.attempt}, ${verdict.model ?? "unknown model"})`,
					...verdict.reasons.slice(0, 5),
					`artifact: ${artifact.path} (${artifact.bytes} bytes, unread)`,
					...(assessment
						? [
								`planner: scope ${assessment.scope ?? "?"}, confidence ${assessment.confidence ?? "?"}` +
									`${assessment.destructive_scope ? ", destructive" : ""}${assessment.blocking_unknowns ? ", blocking unknowns" : ""}` +
									// cp-routing-provenance: an axis the assessment did not name is no
									// longer silently S/low — dispatch assesses it from the task on its
									// own. Say that, rather than printing a default nobody chose.
									` -> routing as scope ${routing.scope ?? "(inferred at dispatch)"} / risk ${routing.risk ?? "(inferred at dispatch)"}`,
							]
						: []),
					// Recorded, never obeyed: a worker does not choose its successor's
					// model. The operator sees the opinion next to the decision.
					...(assessment?.suggested_implementer_model
						? [
								`planner suggested model: ${assessment.suggested_implementer_model}` +
									(assessment.suggested_implementer_model_reason ? ` (${assessment.suggested_implementer_model_reason})` : "") +
									" (advisory; routing decides)",
							]
						: []),
					// routing T2: why the composed assessment is what it is. Present even
					// with no envelope at all — a hung planner does not erase what the task
					// is known to touch.
					...(routing.reasons.length > 0 ? [`routing: ${routing.reasons.join("; ")}`] : []),
				],
				at: this.#now(),
			});

		// Pinned to the artifact hash: a changed plan is never approved by an old decision.
		const approval = verdict.verdict === "pass" ? this.#approvals.read(record.research_id) : undefined;
		if (approval && this.#approvals.matches(record.research_id, artifact.path)) {
			return this.checkpoints.decide(record.ship_id, true, {
				by: approval.by,
				note: `approved for artifact ${approval.artifact_sha256.slice(0, 8)}`,
				at: this.#now(),
			});
		}

		checkpoint = this.#tryMandate(this.checkpoints, checkpoint, record, "ship", routing, verdict.flags);
		if (checkpoint.decision !== "pending") {
			if (checkpoint.decision === "approved" && verdict.verdict === "pass") {
				this.#pinApproval(record.research_id, artifact.path, checkpoint.decided_by ?? "mandate");
			}
			return checkpoint;
		}

		if (this.#options.escalations) {
			await this.#raisePlanApproval(record, verdict, artifact.path);
		}

		const authorizer = this.#options.authorizer;
		if (!authorizer) return checkpoint;
		const answer = await authorizer.ask(checkpoint);
		if (!answer) return checkpoint;
		return this.checkpoints.decide(record.ship_id, answer.approved, {
			by: answer.by,
			...(answer.note ? { note: answer.note } : {}),
			at: this.#now(),
		});
	}

	/**
	 * The diff gate (Stage D), at the one moment it can matter: the implementer
	 * has reported and the only thing left is to call the pipeline `done`.
	 *
	 * Opt-in, and the opt-in is the whole point: `review` absent or `false` returns
	 * an empty step, so nothing about a pipeline that never asked for a review
	 * changes. For `review.enabled === true`, `done` is not reachable until a
	 * verdict exists that is both
	 *
	 *  - **fresh** — `verdict.head_sha` is the ship branch's head *now*. A verdict
	 *    about a commit the branch has moved past is a verdict about code nobody
	 *    would ship (an artifact-mtime-shaped freshness test is the wrong signal
	 *    here: the subject is a commit, not a file), and
	 *  - **sufficient** — not an operational fault. `retry` is the reviewer
	 *    failing, not a judgment about the diff, so a fresh one still decides
	 *    nothing.
	 *
	 * Everything after that is `nextAction`'s ladder, imported verbatim: `pass`
	 * proceeds, `revise` belongs to the orchestrator's promote path and this only
	 * waits for it, a `flagged` escalate asks a human at a *second* checkpoint,
	 * `policy`/`operational_persistent` surface and `operational` retries. This
	 * method maps those five answers onto the pipeline's own vocabulary and states
	 * nothing about which verdict deserves which.
	 */
	async #reviewStep(record: PipelineRecord): Promise<ReviewStep> {
		if (record.review?.enabled !== true) return {};
		const shipId = record.ship_id;
		const running = this.#pendingOn(shipId);
		if (running) return { held: this.#waitOn(record, "implementing", running) };
		const reviewer = this.#options.review?.();

		// The verdicts already on disk, oldest first — the same reader the
		// orchestrator uses, pointed at the diff review's own files and schema, so
		// attempt numbering and the review cap have one implementation (typed back to `DiffVerdict`).
		// A truncated subject replays only as its own policy stop: never a pass, revise or authorizable flag.
		const prior = readPriorAttempts(this.#options.home, shipId, paths.reviewFile, DiffVerdictSchema, {
			capExhausted: reviewCapExhausted,
		});
		const last = prior.decisions.at(-1) as DiffVerdict | undefined;
		const head = reviewer ? await reviewer.headSha(shipId) : undefined;
		const matchingPass = head ? readReviewPassVerdict(this.#options.home, shipId, head) : undefined;
		const fresh = last !== undefined && head !== undefined && last.head_sha === head && (!last.diff_stat.truncated || last.cause === "policy");
		let verdict: DiffVerdict | undefined = matchingPass ?? (fresh && nextAction(last) !== "retry" ? last : undefined);
		let outcome: DiffReviewOutcome | undefined;

		if (!verdict) {
			if (!reviewer) {
				// Opted in, with nothing wired that can review: the honest outcome is a
				// hold naming the tool, never a `done` that skipped the gate it asked for.
				return {
					held: this.#reviewHold(
						record,
						"implementing",
						"wait",
						`${shipId}: review is on for this pipeline and no diff reviewer is wired into this runner. Run ` +
							`cp_review ${shipId}, then advance again — the pipeline holds short of done until a verdict for the ` +
							"branch's current head exists.",
					),
				};
			}
			if (head === undefined) {
				return {
					held: this.#reviewHold(
						record,
						"implementing",
						"wait",
						`${shipId}: cannot diff-review it — the branch's head does not resolve in the canonical clone (never ` +
							"pushed, or the clone cannot reach origin). Push the branch (or fix the clone's remote), then advance " +
							"again; the pipeline holds short of done until a review of the pushed head exists.",
					),
				};
			}
			if (prior.decisions.length >= REVIEW_MAX_ATTEMPTS) {
				// The branch spent its whole review budget and the head has moved since
				// the last verdict. Reviewing again is the loop the cap exists to stop,
				// so this is the operator's call, not another attempt.
				const spent = prior.decisions.at(-1) as DiffVerdict;
				// jje.3: the one operator-approved final fix may stand in for a pass, for its exact reported head only.
				const job = this.#options.fleet.get(shipId);
				const fix = job ? resolveFinalFix(this.#options.home, job, head) : undefined;
				if (fix?.state === "accepted") return { note: ` ${fix.reason}.` };
				return {
					held: this.#reviewHold(
						record,
						"escalated",
						"surface",
						`${shipId}: ${prior.decisions.length} diff reviews have run on this branch — the cap is ` +
							`${REVIEW_MAX_ATTEMPTS} (REVIEW_MAX_ATTEMPTS), and the pipeline does not reach done on it. This ` +
							`is yours now: the last verdict is ${paths.reviewFile(shipId, prior.decisions.length)} ` +
							`(attempt ${spent.attempt}, ${spent.verdict}${spent.cause ? `/${spent.cause}` : ""}).${fix && fix.state !== "none" ? ` ${fix.reason}` : ""}`,
					),
				};
			}
			const started = await reviewer.start({
				jobId: shipId,
				directive: `call cp_pipeline advance ${record.research_id}`,
				...(record.review.model ? { model: record.review.model } : {}),
			});
			if (isDiffReviewWait(started)) {
				return { held: this.#waitOn(record, "implementing", started) };
			}
			outcome = started;
			verdict = outcome.verdict;
		}

		const replay = outcome ? "" : ` [replaying diff review attempt ${verdict.attempt} from ${verdict.decided_at}]`;
		const subject = `${verdict.head_sha.slice(0, 12)} (${verdict.diff_stat.files} file(s))`;
		switch (nextAction(verdict)) {
			case "proceed":
				return {
					...(outcome ? { outcome } : {}),
					note: ` Diff review passed at ${subject}${replay}.`,
				};
			case "revise":
				// The orchestrator promoted the live implementer for one more commit on
				// the same branch. Nothing here chases it: a new head commit is what
				// makes the next advance review again — and it will keep doing that
				// until a review passes or the branch spends REVIEW_MAX_ATTEMPTS.
				return {
					...(outcome ? { outcome } : {}),
					held: this.#reviewHold(
						record,
						"implementing",
						"wait",
						`${shipId}: diff review ${verdict.attempt} of ${REVIEW_MAX_ATTEMPTS} asked for revisions at ` +
							`${subject}${replay}; the implementer has them. The fix is one more commit on the same branch — ` +
							"advance again once the head moves, and the pushed fix is reviewed again.",
						outcome,
					),
				};
			case "authorize": {
				// A flagged escalate: the reviewer found the diff sound apart from the
				// flags. That is the one escalate shape a human may still authorize, and
				// it is a *second* decision — the pre-implementation authorization was
				// about a plan, and it is already spent.
				const checkpoint = await this.#authorizeDiff(record, verdict);
				if (checkpoint.decision === "approved") {
					return {
						...(outcome ? { outcome } : {}),
						checkpoint,
						note: ` Diff review escalated on flags at ${subject}${replay}; ${checkpoint.decided_by ?? "a human"} authorized it.`,
					};
				}
				const detail =
					checkpoint.decision === "declined"
						? `declined${checkpoint.note ? `: ${checkpoint.note}` : ""} — the pipeline does not reach done.`
						: "waiting for a human. A diff review is evidence; accepting the diff is a decision, and this is its own " +
							"authorization, separate from the pre-implementation one.";
				return {
					...(outcome ? { outcome } : {}),
					checkpoint,
					held: this.#reviewHold(
						record,
						"awaiting_authorization",
						checkpoint.decision === "declined" ? "surface" : "authorize",
						`${shipId}: diff review escalated on flags at ${subject}${replay} — ${detail} The question is at ` +
							`${paths.checkpointFile(shipId, "diff")}; the pre-implementation checkpoint is untouched.`,
						outcome,
						checkpoint,
					),
				};
			}
			case "retry":
				return {
					...(outcome ? { outcome } : {}),
					held: this.#reviewHold(
						record,
						"implementing",
						"wait",
						`${shipId}: diff review hit an operational fault at ${subject}${replay} (cause ${verdict.cause}). Re-run ` +
							"cp_pipeline advance: the next attempt uses a different model.",
						outcome,
					),
				};
			default:
				return {
					...(outcome ? { outcome } : {}),
					held: this.#reviewHold(
						record,
						"escalated",
						"surface",
						`${shipId}: diff review escalated at ${subject}${replay} (cause ${verdict.cause}). This is yours now — the ` +
							`pipeline does not reach done on it.\n${verdict.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
						outcome,
					),
				};
		}
	}

	/** One held answer, with the record's state moved to match what is true. */
	#reviewHold(
		record: PipelineRecord,
		state: PipelineState,
		next: AdvanceResult["next"],
		message: string,
		outcome?: DiffReviewOutcome,
		checkpoint?: Checkpoint,
	): AdvanceResult {
		this.store.setState(record.research_id, state, this.#now());
		return this.#step(record, state, next, message, {
			...(outcome ? { review: outcome } : {}),
			...(checkpoint ? { checkpoint } : {}),
		});
	}

	/**
	 * The second authorization: same pattern as `#authorize` (written `pending`
	 * before anyone is asked, answered once, a dismissed dialog leaves it pending),
	 * a different question, and — the part that is not cosmetic — a different file.
	 *
	 * `paths.checkpointFile(shipId, "diff")` exists because `CheckpointStore.decide`
	 * refuses to overwrite an answer: sharing one record with the pre-implementation
	 * checkpoint would either make this question unanswerable or let it silently
	 * inherit an answer that was given about a plan, before any code existed.
	 */
	async #authorizeDiff(record: PipelineRecord, verdict: DiffVerdict): Promise<Checkpoint> {
		const shipId = record.ship_id;
		const existing = this.diffCheckpoints.get(shipId);
		if (existing && existing.decision !== "pending") return existing;

		const raised = (Object.keys(verdict.flags) as Array<keyof GateFlags>).filter((flag) => verdict.flags[flag]);
		const flags = raised.length > 0 ? raised.join(", ") : "flags";
		let checkpoint =
			existing ??
			this.diffCheckpoints.request({
				jobId: shipId,
				researchId: record.research_id,
				question:
					`Accept the diff ${shipId} pushed (${record.project}, delivery ${record.delivery})? The diff review ` +
					`escalated on ${flags} — the reviewer otherwise found the change sound. This is a second, ` +
					"post-implementation authorization; the pre-implementation one was about the plan and is already spent.",
				evidence: [
					`diff review: escalate (flagged; attempt ${verdict.attempt}, ${verdict.model ?? "unknown model"}) — flags: ${flags}`,
					...verdict.reasons.slice(0, 5),
					`subject: ${verdict.head_sha} (${verdict.diff_stat.files} file(s)${verdict.diff_stat.truncated ? ", truncated" : ""})`,
					// The diff body never travels: the verdict is the interface, and the
					// operator reads the branch itself if they want the code.
					`decision file: ${paths.reviewFile(shipId, verdict.attempt)} (verdict only; no diff text)`,
				],
				at: this.#now(),
			});

		const routing = this.#composedRouting(record);
		checkpoint = this.#tryMandate(this.diffCheckpoints, checkpoint, record, "diff", routing);
		if (checkpoint.decision !== "pending") return checkpoint;

		const authorizer = this.#options.authorizer;
		if (!authorizer) return checkpoint;
		const answer = await authorizer.ask(checkpoint);
		if (!answer) return checkpoint;
		return this.diffCheckpoints.decide(shipId, answer.approved, {
			by: answer.by,
			...(answer.note ? { note: answer.note } : {}),
			at: this.#now(),
		});
	}

	async #tearDownResearch(researchId: string): Promise<TeardownResult | undefined> {
		const job = this.#options.fleet.get(researchId);
		if (!job || job.phase === "done") return undefined;
		// issue #2: the one recorded exemption from unreported_live_worker — docs/contracts.md "Hung-planner recovery".
		return this.#options.teardown.teardown(researchId, { acceptUnreported: "pipeline hand-off: the planner's artifact passed the gate and the implementation is authorized" });
	}

	/**
	 * The hand-off: artifact -> task file -> brief, all in code. The artifact
	 * body reaches the file unmodified, but it is wrapped in framing that says
	 * what it is (a specification, not the reader's own words) and what this
	 * ship job's frozen scope is (cp-pipeline-handoff-framing-dz9) — without
	 * that, the planner's read-only voice reads as the implementer's own
	 * instructions.
	 */
	async #dispatchImplementer(record: PipelineRecord): Promise<DispatchResult> {
		const taskFile = join(this.#options.home, paths.taskFile(record.ship_id));
		this.#options.artifacts.get(record.research_id, taskFile);
		const body = readFileSync(taskFile, "utf8");
		// The ship job's own description is the scope boundary: it is the frozen
		// task this job was created for, never the plan's own (possibly larger)
		// footprint.
		const scope = await this.#task(record.ship_id);
		writeFileSync(taskFile, frameImplementerTask({ researchId: record.research_id, shipId: record.ship_id, scope, body }));
		// cp-rte: the planner measured the plan; routing decides what to spend on it.
		// A hung planner leaves no envelope at all — which (routing T2) removes the
		// plan's half of the composition and nothing else: what the task is known to
		// touch is not a measurement the planner was making.
		// cp-routing-provenance: these are the planner's measurements, not an
		// operator's instruction, so they are recorded as `assessed`. routing T2: the
		// task's own known impact is composed in beside them and can only raise risk,
		// so each axis carries the provenance of whichever source it actually came
		// from. An axis neither source names is left for dispatch to infer from the
		// ship job's own words — never emitted as a confident `low` from here.
		// riskkw (cp-yxgl review): the ledger's `risk:` label follows the assessed value — never a `defaulted` low.
		const routing = this.#composedRouting(record);
		await recordAssessedRisk(this.#options.ledger, record.ship_id, routing);
		return this.#options.dispatcher().dispatch({
			jobId: record.ship_id,
			taskFile,
			...(record.wall_clock_seconds !== undefined ? { wallClockSeconds: record.wall_clock_seconds } : {}),
			...(routing.scope ? { scope: routing.scope } : {}),
			...(routing.risk ? { risk: routing.risk } : {}),
			...(routing.recordedRisk ? { recordedRisk: routing.recordedRisk } : {}),
			inputsFrom: routing.inputsFrom,
		});
	}

	/**
	 * The task's known impact for this pipeline (routing T2), in strict order of
	 * how much the fact can be trusted:
	 *
	 *  1. `record.task_impact` — frozen at `start`, carried across a reanchor.
	 *  2. the research job's persisted `JobRouting` — for a record written before
	 *     (1) existed, this IS the effective input its research dispatch was given,
	 *     provenance included. A trustworthy fleet fact, reused rather than redone.
	 *  3. the frozen original task on disk (do8.3) — re-assessed from the words the
	 *     job was dispatched with, never from the planner's rewritten `Goal`.
	 *
	 * `undefined` means **nothing was recorded**, which leaves the axis to
	 * dispatch's own inference over the ship job's br title and description (which
	 * are the original task). That is a different thing from a read that failed: an
	 * `original-task.md` that exists and cannot be read throws, because "we could
	 * not look" must never be rendered as "there is no risk".
	 */
	#taskImpact(record: PipelineRecord): TaskImpact | undefined {
		if (record.task_impact) return record.task_impact;
		const routing = this.#options.fleet.get(record.research_id)?.routing;
		if (routing) return { routing, source: "fleet_routing" };
		const frozen = join(this.#options.home, paths.originalTaskFile(record.research_id));
		if (!existsSync(frozen)) return undefined;
		let text: string;
		try {
			text = readFileSync(frozen, "utf8");
		} catch (error) {
			throw new PipelineError(
				`${record.research_id}: the frozen original task at ${frozen} exists but cannot be read ` +
					`(${(error as Error).message}). Refusing to route ${record.ship_id} from it, because an unreadable task is ` +
					"not a low-risk one. Fix the file, or dispatch the ship job yourself with an explicit scope and risk.",
			);
		}
		if (text.trim().length === 0) return undefined;
		return { routing: taskImpactFrom({ text }).routing, source: "original_task" };
	}

	/** Live blocked planner envelope, or undefined. Does not start a gate. */
	#plannerBlocked(researchId: string): "answer" | "escalate" | undefined {
		const job = this.#options.fleet.get(researchId);
		if (!job || !expectsPlannerBlockers(job)) return undefined;
		const file = join(this.#options.home, paths.envelopeFile(researchId));
		if (!existsSync(file)) return undefined;
		try {
			const record = JSON.parse(readFileSync(file, "utf8")) as EnvelopeRecord;
			if (record.envelope?.status !== "blocked") return undefined;
			return plannerBlockedRoundAction((job.planner_blocked_rounds ?? 1) - 1);
		} catch {
			return undefined;
		}
	}

	/**
	 * The research envelope's self-assessment, or undefined if it never reported.
	 * Read through `lastFiledEnvelopeFile`, because a revise promote supersedes
	 * the envelope slot: what the planner measured survives the supersession and
	 * must keep routing the implementer.
	 */
	#selfAssessment(researchId: string): SelfAssessment | undefined {
		const job = this.#options.fleet.get(researchId);
		const file = job ? lastFiledEnvelopeFile(this.#options.home, job) : undefined;
		if (!file || !existsSync(file)) return undefined;
		try {
			const record = JSON.parse(readFileSync(file, "utf8")) as EnvelopeRecord;
			return record.envelope?.self_assessment as SelfAssessment | undefined;
		} catch {
			// Intake already validated this file; a read failure here must not stop a
			// dispatch that is otherwise authorized.
			return undefined;
		}
	}

	/** riskkw: the one composition every caller shares — the frozen task impact, the planner's `self_assessment`, and the gate's flags for that plan. */
	#composedRouting(record: PipelineRecord): ComposedRouting {
		const impact = this.#taskImpact(record);
		const assessment = this.#selfAssessment(record.research_id);
		const flags = readPriorAttempts(this.#options.home, record.research_id).decisions.at(-1)?.flags;
		return composeImplementationRouting({ ...(impact ? { task: impact } : {}), ...(assessment ? { assessment } : {}), ...(flags ? { flags } : {}) });
	}

	/** The one message for "a reviewer is running"; the ladder resumes on the next advance. */
	#waitOn(
		record: PipelineRecord,
		state: PipelineState,
		wait: ReviewWait,
		extra: Partial<AdvanceResult> = {},
	): AdvanceResult {
		this.store.setState(record.research_id, state, this.#now());
		return this.#step(
			record,
			state,
			"wait",
			`${record.research_id}: ${wait.surface} attempt ${wait.attempt} is running (deadline ${wait.deadline}). ` +
				"End the turn; its cp-verdict wake-up will say to advance again.",
			{ ...extra, pending: { surface: wait.surface, attempt: wait.attempt, deadline: wait.deadline } },
		);
	}

	/** A pending attempt for this job on any surface, from disk. */
	#pendingOn(jobId: string): ReviewWait | undefined {
		const pending = this.#options.reviews?.pendingFor(jobId)[0];
		if (!pending) return undefined;
		return {
			next: "wait",
			surface: pending.surface,
			attempt: pending.attempt,
			model: pending.model,
			deadline: pending.deadline,
			key: ReviewRuns.key(pending.job_id, pending.surface, pending.attempt),
		};
	}

	#step(
		record: PipelineRecord,
		state: PipelineState,
		next: AdvanceResult["next"],
		message: string,
		extra: Partial<AdvanceResult> = {},
	): AdvanceResult {
		return {
			research_id: record.research_id,
			ship_id: record.ship_id,
			state,
			next,
			message,
			...extra,
		};
	}
}

/** One operator line per advance. */
export function formatAdvance(result: AdvanceResult): string {
	const pending = result.pending
		? `\n  pending: ${result.pending.surface} attempt ${result.pending.attempt}, deadline ${result.pending.deadline}`
		: "";
	const bound = result.dispatch?.wall_clock_seconds;
	const dispatchBound = bound === undefined ? "" : `\n  ${result.dispatch!.job_id}: wall_clock_seconds=${bound}`;
	return `${result.research_id} -> ${result.ship_id} [${result.state}/${result.next}]\n${result.message}${pending}${dispatchBound}`;
}
