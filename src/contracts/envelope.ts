/** The `report_result` envelope (worker → parent), the planner artifact sections and envelope validation. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { type Delivery, isInside, IsoTimestampSchema, JobIdSchema, type JobKind, JobKindSchema, validate, type ValidationResult } from "./core.ts";
import type { Replace } from "./internal.ts";

/** Envelope summary is a headline, never a findings body. */
export const SUMMARY_MAX_LINES = 3;
export const SUMMARY_MAX_CHARS = 600;

/** Planner `plan_summary`: headlines, word-capped, never the artifact body. */
export const PLAN_SUMMARY_MAX_WORDS = 24;
export const PLAN_SUMMARY_APPROACH_MAX = 3;
export const PLAN_SUMMARY_ALT_MAX = 3;
export const PLAN_SUMMARY_CHOICE_MAX = 3;
export const PLAN_SUMMARY_ACCEPTANCE_MAX = 6;
export const PLAN_SUMMARY_TOUCHED_MAX = 12;
export const DECISION_SUMMARY_MAX_WORDS = 40;

/**
 * Blockers are actionable, not transcripts — but a real blocker is often a
 * multi-sentence explanation naming concrete operator steps (a revoked
 * credential, the exact command to run once it is fixed). 300 chars measured
 * too tight against real run logs (cp-48z: a genuine blocker ran 543 chars);
 * 1000 gives headroom for that shape without inviting a findings body — the
 * artifact still owns anything longer than a few sentences.
 */
export const BLOCKER_MAX_ITEMS = 10;
export const BLOCKER_MAX_CHARS = 1000;

/**
 * Planner questions are blockers, not a held console call (cur.3.1).
 * Three per envelope, each field one line. A fourth blocked envelope on the
 * same job escalates instead of being answered by the parent.
 */
export const PLANNER_BLOCKER_MAX_ITEMS = 3;
export const PLANNER_BLOCKER_FIELD_MAX_CHARS = 200;
export const PLANNER_BLOCKER_MAX_OPTIONS = 4;
export const PLANNER_BLOCKED_ROUND_CAP = 2;

/**
 * `suggested_implementer_model` is an identifier; the justification for it is
 * a separate, more generous field (real run logs show rationale up to ~175
 * chars once split from the id, e.g. "high-stakes incident-response runbook
 * with irreversible credential-revocation and live-restore steps; needs
 * strong judgment at each STOP point, not just mechanical execution").
 */
export const SUGGESTED_MODEL_MAX_CHARS = 80;
export const SUGGESTED_MODEL_REASON_MAX_CHARS = 240;

/** worker-reporter bounded repair: total attempts a worker gets per report. */
export const ENVELOPE_REPAIR_MAX_ATTEMPTS = 3;

/**
 * The sections a research artifact must carry, in order (cp-planner-artifacts).
 *
 * One source of truth for three prompts that used to restate the list by hand
 * — `prompts/briefs/brief-research.md` (what the planner writes),
 * `prompts/briefs/gate-rubric.md` (what the gate scores) and
 * `prompts/briefs/quality-completeness.md` (what the cheap panel checks) — plus
 * the tests that keep all three in sync. A plan that names a Goal and an
 * Evidence dump but no Approach, no Acceptance, no Implementation order and no
 * runnable verification is not executable, which is the failure this list
 * exists to make mechanical rather than tasteful.
 *
 * `missingArtifactSections()` has **no production caller**, deliberately. The
 * prompts state the list to the workers that write and score the artifact, and
 * `tests/planner-artifact.test.ts` is what holds prompts and checker to the
 * same list; the parent could not call it anyway, because the parent never
 * reads an artifact body. It is here, next to the list, so that "a section is
 * delivered only when something is written under it" is one testable
 * definition rather than eleven restatements of taste.
 */
export const RESEARCH_ARTIFACT_SECTIONS = [
	"Goal",
	"Acceptance",
	"Non-goals",
	"Evidence",
	"Approach",
	"File list",
	"Implementation order",
	"Constraints",
	"Test plan",
	"Unknowns/Blockers",
	"Self-assessment",
] as const;
export type ResearchArtifactSection = (typeof RESEARCH_ARTIFACT_SECTIONS)[number];

/** `## Goal`, `# Goal`, `**Goal**`, with or without a trailing colon. */
const ARTIFACT_HEADING_RE = /^\s{0,3}(?:#{1,6}|\*\*)\s*([^#*\n]+?)\s*\**\s*:?\s*$/;

/** ```` ``` ```` or ```` ~~~ ````, optionally indented and language-tagged. */
const CODE_FENCE_RE = /^\s{0,3}(```|~~~)/;

/**
 * First word, lowercased: "File list" and "File changes" are the same section.
 *
 * Deliberately forgiving in one direction only. A planner who writes "Test
 * commands" or "File changes" is not failed for wording; the whole first word
 * must still match, so "Testing environment" does not satisfy "Test plan", and
 * the accepted cost is that an unrelated "Test rig" would. That trade is on
 * purpose: this check is a floor for a machine, and the gate
 * reviewer — which reads the artifact for what it says, not for its headings —
 * is what judges whether a section is real. Pinned by test
 * (tests/planner-artifact.test.ts).
 */
function sectionKey(heading: string): string {
	return heading.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] ?? "";
}

/**
 * Which required sections an artifact does not actually deliver.
 *
 * A heading with nothing under it does not count: an empty `Test plan` is a
 * missing test plan, not a present one, which is what makes "executable
 * verification" checkable instead of aspirational.
 *
 * Fenced code is content, never structure: a `# npm test` comment inside a
 * block is a command a planner is showing, so it must not open a section and
 * strand everything under it.
 */
export function missingArtifactSections(text: string): ResearchArtifactSection[] {
	const filled = new Set<string>();
	let current: string | undefined;
	let fenced = false;
	for (const line of text.split("\n")) {
		if (CODE_FENCE_RE.test(line)) {
			fenced = !fenced;
			if (current !== undefined) filled.add(current);
			continue;
		}
		const heading = fenced ? null : ARTIFACT_HEADING_RE.exec(line);
		if (heading) {
			current = sectionKey(heading[1] as string);
			continue;
		}
		if (current !== undefined && line.trim().length > 0) filled.add(current);
	}
	return RESEARCH_ARTIFACT_SECTIONS.filter((section) => !filled.has(sectionKey(section)));
}

// ---------------------------------------------------------------------------
// Envelope — the `report_result` tool contract (worker → parent)
// ---------------------------------------------------------------------------

export const ScriptExitResultSchema = Type.Object(
	{
		job_id: JobIdSchema,
		status: StringEnum(["done", "failed"]),
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		signal: Type.Union([Type.String({ minLength: 1, maxLength: 40 }), Type.Null()]),
		timed_out: Type.Boolean(),
		reason: StringEnum(["success", "exit", "signal", "timeout", "spawn_error"]),
		summary: Type.String({ minLength: 1, maxLength: SUMMARY_MAX_CHARS }),
		artifact_path: Type.String({ minLength: 1, maxLength: 1000 }),
	},
	{ additionalProperties: false },
);
export type ScriptExitResult = Static<typeof ScriptExitResultSchema>;

/** Durable runner output, not a worker-authored report_result envelope. */
export const ScriptExitResultRecordSchema = Type.Object(
	{ schema_version: Type.Integer({ minimum: 1 }), job_id: JobIdSchema, result: ScriptExitResultSchema },
	{ additionalProperties: false },
);
export type ScriptExitResultRecord = Static<typeof ScriptExitResultRecordSchema>;

export function validateScriptExitResultRecord(value: unknown, jobId: string, worktree?: string): ValidationResult<ScriptExitResultRecord> {
	const shape = validate<ScriptExitResultRecord>(ScriptExitResultRecordSchema, value);
	if (!shape.ok) return shape;
	const errors = shape.value.job_id === jobId ? [] : [`job_id: must match ${jobId}`];
	const result = validateScriptExitResult(shape.value.result, jobId, worktree);
	if (!result.ok) errors.push(...result.errors);
	return errors.length ? { ok: false, errors } : shape;
}

export function validateScriptExitResult(value: unknown, jobId: string, worktree?: string): ValidationResult<ScriptExitResult> {
	const shape = validate<ScriptExitResult>(ScriptExitResultSchema, value);
	if (!shape.ok) return shape;
	const result = shape.value;
	const errors: string[] = [];
	if (result.job_id !== jobId) errors.push(`job_id: must match ${jobId}`);
	if (!result.artifact_path.startsWith("/") || (worktree && isInside(result.artifact_path, worktree))) {
		errors.push("artifact_path: must be absolute and outside the worktree");
	}
	if (result.summary.trim().split("\n").length > SUMMARY_MAX_LINES || FENCE_RE.test(result.summary) || HEADING_RE.test(result.summary)) {
		errors.push("summary: must be a bounded plain-prose headline, never output");
	}
	const { reason, status, exit_code: code, signal, timed_out: timedOut } = result;
	if (
		(reason === "success" && (status !== "done" || code !== 0 || signal !== null || timedOut)) ||
		(reason === "exit" && (status !== "failed" || code === null || code === 0 || signal !== null || timedOut)) ||
		(reason === "signal" && (status !== "failed" || code !== null || signal === null || timedOut)) ||
		(reason === "timeout" && (status !== "failed" || !timedOut)) ||
		(reason === "spawn_error" && (status !== "failed" || code !== null || signal !== null || timedOut))
	) errors.push("status/reason: must agree with observed exit_code, signal and timed_out");
	return errors.length ? { ok: false, errors } : shape;
}

export const SelfAssessmentSchema = Type.Object(
	{
		confidence: StringEnum(["high", "medium", "low"]),
		scope: StringEnum(["S", "M", "L"]),
		blocking_unknowns: Type.Boolean(),
		destructive_scope: Type.Boolean({
			description: "data migrations, deletions, force-pushes, schema changes",
		}),
		/**
		 * Identifier only, e.g. "claude-opus-4-6" — never read as an input (see
		 * pipeline.ts), but the pipeline DOES compare it against the routing
		 * decision verbatim, so a prose value here silently breaks that
		 * comparison. Workers naturally want to justify the suggestion too
		 * (real run logs show "claude-opus-4-6 (high-stakes incident-response
		 * runbook needing judgment at each STOP point)" at 191 chars against an
		 * old 120-char cap); that justification has its own field below instead
		 * of being crammed into the identifier.
		 */
		suggested_implementer_model: Type.Optional(
			Type.String({
				maxLength: SUGGESTED_MODEL_MAX_CHARS,
				description: 'A model identifier only, e.g. "claude-opus-4-6". Put the justification in suggested_implementer_model_reason, not here.',
			}),
		),
		suggested_implementer_model_reason: Type.Optional(
			Type.String({
				maxLength: SUGGESTED_MODEL_REASON_MAX_CHARS,
				description: "One sentence: why this model matters for the follow-on work (e.g. judgment-heavy, irreversible steps). Optional.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type Confidence = "high" | "medium" | "low";
export type SelfAssessment = Replace<
	Static<typeof SelfAssessmentSchema>,
	{ confidence: Confidence; scope: "S" | "M" | "L" }
>;

const PlanLine = Type.String({ minLength: 1, maxLength: 200 });

/**
 * Bounded headlines a deciding party can read without the artifact body.
 * Required on a completed research plan (`delivery` other than `answer`).
 */
export const PlanSummarySchema = Type.Object(
	{
		goal: PlanLine,
		approach: Type.Array(PlanLine, { minItems: 1, maxItems: PLAN_SUMMARY_APPROACH_MAX }),
		alternatives_rejected: Type.Optional(Type.Array(PlanLine, { maxItems: PLAN_SUMMARY_ALT_MAX })),
		unresolved_choices: Type.Optional(
			Type.Array(
				Type.Object(
					{ choice: PlanLine, default: PlanLine },
					{ additionalProperties: false },
				),
				{ maxItems: PLAN_SUMMARY_CHOICE_MAX },
			),
		),
		acceptance: Type.Array(PlanLine, { minItems: 1, maxItems: PLAN_SUMMARY_ACCEPTANCE_MAX }),
		risk: PlanLine,
		touched: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
			minItems: 1,
			maxItems: PLAN_SUMMARY_TOUCHED_MAX,
		}),
	},
	{ additionalProperties: false },
);
export type PlanSummary = Static<typeof PlanSummarySchema>;

/** What would make the plan wrong, and what the reviewer verified. Headlines. */
export const DecisionSummarySchema = Type.Object(
	{
		would_make_wrong: Type.String({ minLength: 1, maxLength: 400, description: `one line, at most ${DECISION_SUMMARY_MAX_WORDS} words` }),
		verified: Type.String({ minLength: 1, maxLength: 400, description: `one line, at most ${DECISION_SUMMARY_MAX_WORDS} words` }),
	},
	{ additionalProperties: false },
);
export type DecisionSummary = Static<typeof DecisionSummarySchema>;

/** A valid minimal summary tests and briefs can copy. */
export const MINIMAL_PLAN_SUMMARY: PlanSummary = {
	goal: "Ship the change.",
	approach: ["Use the existing helper."],
	acceptance: ["The suite passes."],
	risk: "Low; no data migration.",
	touched: ["src/intake.ts"],
};

export function wordCount(text: string): number {
	const trimmed = text.trim();
	return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

const TOUCHED_NAME_RE = /^[A-Za-z0-9_./@+-]+$/;

/** Word caps and "names only". Shape (counts) is the schema's job. */
export function planSummaryErrors(summary: PlanSummary): string[] {
	const errors: string[] = [];
	const line = (field: string, value: string) => {
		if (value.includes("\n")) errors.push(`${field}: one line`);
		else if (wordCount(value) > PLAN_SUMMARY_MAX_WORDS) {
			errors.push(`${field}: at most ${PLAN_SUMMARY_MAX_WORDS} words (got ${wordCount(value)})`);
		}
	};
	line("plan_summary.goal", summary.goal);
	summary.approach.forEach((row, i) => line(`plan_summary.approach[${i}]`, row));
	(summary.alternatives_rejected ?? []).forEach((row, i) => line(`plan_summary.alternatives_rejected[${i}]`, row));
	(summary.unresolved_choices ?? []).forEach((row, i) => {
		line(`plan_summary.unresolved_choices[${i}].choice`, row.choice);
		line(`plan_summary.unresolved_choices[${i}].default`, row.default);
	});
	summary.acceptance.forEach((row, i) => line(`plan_summary.acceptance[${i}]`, row));
	line("plan_summary.risk", summary.risk);
	summary.touched.forEach((name, i) => {
		if (!TOUCHED_NAME_RE.test(name)) {
			errors.push(`plan_summary.touched[${i}]: names only (a path or subsystem), got "${name}"`);
		}
	});
	return errors;
}

export function decisionSummaryErrors(summary: DecisionSummary): string[] {
	const errors: string[] = [];
	for (const field of ["would_make_wrong", "verified"] as const) {
		const value = summary[field];
		if (value.includes("\n") || wordCount(value) > DECISION_SUMMARY_MAX_WORDS) {
			errors.push(
				`decision_summary.${field}: one line, at most ${DECISION_SUMMARY_MAX_WORDS} words (got ${wordCount(value)})`,
			);
		}
	}
	return errors;
}

/** One planner question. Every field is one line; the artifact holds the rest. */
export const PlannerBlockerSchema = Type.Object(
	{
		question: Type.String({
			minLength: 1,
			maxLength: PLANNER_BLOCKER_FIELD_MAX_CHARS,
			description: "The decision, one line. A how-question the repo can answer is not a blocker.",
		}),
		why: Type.String({
			minLength: 1,
			maxLength: PLANNER_BLOCKER_FIELD_MAX_CHARS,
			description: "Why this matters for the plan, one line.",
		}),
		options: Type.Array(
			Type.String({
				minLength: 1,
				maxLength: PLANNER_BLOCKER_FIELD_MAX_CHARS,
				description: "One option, one line.",
			}),
			{ minItems: 1, maxItems: PLANNER_BLOCKER_MAX_OPTIONS },
		),
		recommended: Type.String({
			minLength: 1,
			maxLength: PLANNER_BLOCKER_FIELD_MAX_CHARS,
			description: "The option you recommend. Must equal one options entry.",
		}),
		assume_if_unanswered: Type.String({
			minLength: 1,
			maxLength: PLANNER_BLOCKER_FIELD_MAX_CHARS,
			description: "What you will assume if this stays unanswered, one line.",
		}),
	},
	{ additionalProperties: false },
);
export type PlannerBlocker = Static<typeof PlannerBlockerSchema>;

/** Ship/QA: a string. Planner: a PlannerBlocker. Cross-field policy picks which. */
export const BlockerSchema = Type.Union([
	Type.String({
		minLength: 1,
		maxLength: BLOCKER_MAX_CHARS,
		description: `One concrete blocker: what stopped you and what a human must do next, up to ${BLOCKER_MAX_CHARS} characters. If there is more to say than that, put the detail in the artifact and reference it here instead of truncating.`,
	}),
	PlannerBlockerSchema,
]);
export type EnvelopeBlocker = string | PlannerBlocker;

/**
 * Parameters of the worker-side `report_result` tool. This is the ONLY channel
 * a worker uses to finish a job. Prose envelopes do not exist.
 */
export const EnvelopeSchema = Type.Object(
	{
		job_id: JobIdSchema,
		kind: JobKindSchema,
		status: StringEnum(["done", "blocked"]),
		summary: Type.String({
			minLength: 1,
			maxLength: SUMMARY_MAX_CHARS,
			description: `1-${SUMMARY_MAX_LINES} lines, at most ${SUMMARY_MAX_CHARS} characters. Headline only — never the findings body.`,
		}),
		plan_summary: Type.Optional(PlanSummarySchema),
		pr_url: Type.Optional(Type.String({ maxLength: 500 })),
		branch: Type.Optional(Type.String({ maxLength: 200 })),
		artifact_path: Type.Optional(Type.String({ maxLength: 1000 })),
		base_sha: Type.Optional(
			Type.String({
				minLength: 40,
				maxLength: 40,
				description: "The full commit SHA of the base branch your brief names (origin/<base>, or the merge base) that this work was verified against. Optional but strongly recommended for ship jobs to make CI results self-describing.",
			}),
		),
		/**
		 * cp-kzc: the commit the worker actually pushed. This is what replaces a
		 * worker waiting for CI: the parent re-verifies CI against this sha before
		 * every merge, so a ship envelope carrying it is COMPLETE with no CI claim
		 * of any kind. A missing "CI green" line is not an incomplete job.
		 */
		head_sha: Type.Optional(
			Type.String({
				minLength: 40,
				maxLength: 40,
				description: "The full commit SHA you pushed (git rev-parse HEAD). Report it and stop — never wait for CI; the parent verifies CI against this sha before it merges.",
			}),
		),
		blockers: Type.Optional(
			Type.Array(BlockerSchema, {
				maxItems: BLOCKER_MAX_ITEMS,
				description:
					"Implementers: one string per item (exact path or command). Planners: objects " +
					"{question, why, options, recommended, assume_if_unanswered}, at most 3, each field one line.",
			}),
		),
		self_assessment: Type.Optional(SelfAssessmentSchema),
	},
	{ additionalProperties: false },
);
export type EnvelopeStatus = "done" | "blocked";
export type Envelope = Replace<
	Static<typeof EnvelopeSchema>,
	{ kind: JobKind; status: EnvelopeStatus; self_assessment?: SelfAssessment; blockers?: EnvelopeBlocker[] }
>;

/** Persisted at state/runs/<job-id>/envelope.json. */
export const EnvelopeRecordSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		received_at: IsoTimestampSchema,
		attempt: Type.Integer({ minimum: 1 }),
		envelope: EnvelopeSchema,
	},
	{ additionalProperties: false },
);
export type EnvelopeRecord = Static<typeof EnvelopeRecordSchema>;

export interface EnvelopeContext {
	/** The job the worker was dispatched for. A mismatch is a hard reject. */
	job_id: string;
	kind: JobKind;
	delivery: Delivery;
	/** When known, the envelope's artifact must live OUTSIDE this path. */
	worktree?: string;
}

const FENCE_RE = /```|~~~/;
const HEADING_RE = /^#{1,6}\s/m;

/** Research that is a plan, not a Q&A answer. Those blockers are questions. */
export function expectsPlannerBlockers(ctx: Pick<EnvelopeContext, "kind" | "delivery">): boolean {
	return ctx.kind === "research" && ctx.delivery !== "answer";
}

export function isPlannerBlocker(value: unknown): value is PlannerBlocker {
	return typeof value === "object" && value !== null && "question" in value;
}

/** `prior` is how many blocked planner envelopes this job already accepted. */
export function plannerBlockedRoundAction(prior: number): "answer" | "escalate" {
	return prior >= PLANNER_BLOCKED_ROUND_CAP ? "escalate" : "answer";
}

function bodyShaped(label: string, value: string): string | undefined {
	if (value.split("\n").length > 1) {
		return `${label}: at most 1 line — the body belongs in the artifact, not the envelope`;
	}
	if (FENCE_RE.test(value) || HEADING_RE.test(value)) {
		return `${label}: must be plain prose — no code fences, no markdown headings (envelope is never a body)`;
	}
	return undefined;
}

function plannerBlockerErrors(blockers: EnvelopeBlocker[]): string[] {
	const errors: string[] = [];
	if (blockers.length > PLANNER_BLOCKER_MAX_ITEMS) {
		errors.push(
			`blockers: at most ${PLANNER_BLOCKER_MAX_ITEMS} for a planner (got ${blockers.length}) — extra questions belong in the artifact, not the envelope`,
		);
	}
	for (const [index, blocker] of blockers.entries()) {
		const at = `blockers/${index}`;
		if (typeof blocker === "string" || !isPlannerBlocker(blocker)) {
			errors.push(
				`${at}: a planner blocker is an object {question, why, options, recommended, assume_if_unanswered}, not a string — the body belongs in the artifact, not the envelope`,
			);
			continue;
		}
		for (const field of ["question", "why", "recommended", "assume_if_unanswered"] as const) {
			const hit = bodyShaped(`${at}/${field}`, blocker[field]);
			if (hit) errors.push(hit);
		}
		for (const [optionIndex, option] of blocker.options.entries()) {
			const hit = bodyShaped(`${at}/options/${optionIndex}`, option);
			if (hit) errors.push(hit);
		}
		if (!blocker.options.includes(blocker.recommended)) {
			errors.push(`${at}/recommended: must equal one options entry, got "${blocker.recommended}"`);
		}
	}
	return errors;
}

/**
 * Full envelope contract: shape + cross-field policy.
 *
 * Fail-closed rules (all of them are contract, not taste):
 *  - identity: job_id and kind must match the dispatch record
 *  - summary is a headline: <= 3 lines, no code fences, no markdown headings
 *    (HARD RULE: the findings body never travels in the envelope)
 *  - research/done must name an artifact_path, absolute, outside the worktree
 *  - research must never carry a pr_url (research changes nothing)
 *  - ship/done must name a branch; delivery:pr additionally needs an https PR url
 *  - blocked must list at least one blocker
 *
 * What is deliberately NOT a rule (cp-kzc): a ship envelope never has to claim
 * a CI conclusion. `head_sha` is the pushed commit and the parent re-verifies CI
 * against it before merging, so an envelope with `head_sha` and no CI claim is
 * complete. Requiring a green claim here is what pushed workers into sleeping
 * inside a tool call until GitHub answered.
 */
export function validateEnvelope(value: unknown, ctx: EnvelopeContext): ValidationResult<Envelope> {
	const shape = validate<Envelope>(EnvelopeSchema, value);
	if (!shape.ok) return shape;
	const envelope = shape.value;
	const errors: string[] = [];

	if (envelope.job_id !== ctx.job_id) {
		errors.push(`job_id: must be "${ctx.job_id}" (the job you were dispatched for), got "${envelope.job_id}"`);
	}
	if (envelope.kind !== ctx.kind) {
		errors.push(`kind: must be "${ctx.kind}" for this job, got "${envelope.kind}"`);
	}

	const summaryLines = envelope.summary.trim().split("\n");
	if (summaryLines.length > SUMMARY_MAX_LINES) {
		errors.push(
			`summary: at most ${SUMMARY_MAX_LINES} lines (got ${summaryLines.length}) — the body belongs in the artifact, not the envelope`,
		);
	}
	if (FENCE_RE.test(envelope.summary) || HEADING_RE.test(envelope.summary)) {
		errors.push("summary: must be plain prose — no code fences, no markdown headings (envelope is never a body)");
	}
	if (envelope.plan_summary) errors.push(...planSummaryErrors(envelope.plan_summary));
	if (
		envelope.kind === "research" &&
		envelope.status === "done" &&
		ctx.delivery !== "answer" && ctx.delivery !== "board" &&
		!envelope.plan_summary
	) {
		errors.push(
			"plan_summary: required for a completed research plan — goal, approach, acceptance, risk, touched (headlines only)",
		);
	}

	if (envelope.status === "blocked") {
		if (!envelope.blockers || envelope.blockers.length === 0) {
			errors.push("blockers: required and non-empty when status is \"blocked\" — name what stopped you");
		} else if (expectsPlannerBlockers(ctx)) {
			errors.push(...plannerBlockerErrors(envelope.blockers));
		} else {
			for (const [index, blocker] of envelope.blockers.entries()) {
				if (typeof blocker !== "string") {
					errors.push(
						`blockers/${index}: a ${ctx.kind} blocker is one concrete string (path or command), not a question object`,
					);
				}
			}
		}
	}

	if (envelope.kind === "research") {
		if (envelope.pr_url !== undefined) {
			errors.push("pr_url: forbidden for kind \"research\" — research changes nothing and opens no PR");
		}
		if (envelope.status === "done") {
			if (!envelope.artifact_path) {
				errors.push("artifact_path: required for a completed research job — write findings to the predeclared path");
			} else if (!envelope.artifact_path.startsWith("/")) {
				errors.push(`artifact_path: must be absolute, got "${envelope.artifact_path}"`);
			} else if (ctx.worktree && isInside(envelope.artifact_path, ctx.worktree)) {
				errors.push(
					`artifact_path: must be outside the worktree ${ctx.worktree} so the tree stays clean, got "${envelope.artifact_path}"`,
				);
			}
		}
	}

	if (envelope.kind === "ship" && envelope.status === "done") {
		if (!envelope.branch) {
			errors.push("branch: required for a completed ship job");
		}
		if (ctx.delivery === "pr") {
			if (!envelope.pr_url) {
				errors.push("pr_url: required for delivery:pr — report the full https PR url");
			} else if (!/^https:\/\/\S+$/.test(envelope.pr_url)) {
				errors.push(`pr_url: must be a full https url, got "${envelope.pr_url}"`);
			}
		}
	}

	return errors.length === 0 ? { ok: true, value: envelope } : { ok: false, errors };
}
