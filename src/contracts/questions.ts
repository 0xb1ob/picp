/** Operator questions (T31) and the plan-review answer codec. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, normalizeLegacyRoles, type Role, RoleSchema, validate, type ValidationResult } from "./core.ts";
import type { Narrow } from "./internal.ts";

// ---------------------------------------------------------------------------
// Operator questions (T31) — state/runs/<job-id>/questions.jsonl
// ---------------------------------------------------------------------------

/** A worker may ask this much and no more: a question is not a conversation. */
export const QUESTION_MAX_CHARS = 600;
export const QUESTION_OPTION_MAX_CHARS = 120;
export const QUESTION_MAX_OPTIONS = 6;
export const QUESTION_ANSWER_MAX_CHARS = 1000;
/** Per job, per session. Past it the relay refuses and the worker reports. */
export const QUESTION_MAX_PER_JOB = 3;
/** A human is never load-bearing for a worker's liveness. Minutes, not hours. */
export const QUESTION_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * The dialog title a planner's `report_result` uses to ask for a plan review
 * (spec 2026-09-13, R2). A protocol constant shared by both sides of the
 * worker boundary: the relay treats a dialog with exactly this title, from a
 * planner. Plan review is an escalation now, not a dialog (cur.3.2).
 */
export const REVIEW_DIALOG_TITLE = "cp:plan-review";

/** The dialog methods a worker may use as a question. `review` is `report_result`'s. */
export const QUESTION_METHODS = ["select", "input", "confirm", "review"] as const;
export type QuestionMethod = (typeof QUESTION_METHODS)[number];

/** What the operator said about a held plan. */
export type ReviewAnswer = { kind: "approve" } | { kind: "revise"; text: string } | { kind: "ask"; text: string };

/** `approve` · `revise\n<text>` · `ask\n<text>`: the wire form of a review answer. */
export function encodeReviewAnswer(answer: ReviewAnswer): string {
	return answer.kind === "approve" ? "approve" : `${answer.kind}\n${answer.text}`;
}

/** The inverse. `undefined` for anything that is not exactly one of the three shapes. */
export function decodeReviewAnswer(value: unknown): ReviewAnswer | undefined {
	if (typeof value !== "string") return undefined;
	if (value === "approve") return { kind: "approve" };
	const newline = value.indexOf("\n");
	if (newline === -1) return undefined;
	const kind = value.slice(0, newline);
	const text = value.slice(newline + 1).trim();
	if (text.length === 0) return undefined;
	if (kind === "revise" || kind === "ask") return { kind, text };
	return undefined;
}

/**
 * `state/runs/<job-id>/review-approval.json` — the operator approved this
 * planner's plan at the console (spec 2026-09-13, R4). Pinned to the
 * artifact's sha256 so it can only ever authorize the plan the operator saw.
 */
export const ReviewApprovalSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		/** The `questions.jsonl` review exchange this approval answered. */
		question_seq: Type.Integer({ minimum: 1 }),
		artifact_sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		approved_at: IsoTimestampSchema,
		by: Type.String({ minLength: 1, maxLength: 120 }),
	},
	{ additionalProperties: false },
);
export type ReviewApproval = Static<typeof ReviewApprovalSchema>;
export function validateReviewApproval(value: unknown): ValidationResult<ReviewApproval> {
	return validate<ReviewApproval>(ReviewApprovalSchema, value);
}

/**
 * How an exchange ended. Only `answered` carries an operator's words; every
 * other outcome is the fail-closed path the worker's brief already knows —
 * write it down as an unknown and report.
 */
export const QUESTION_OUTCOMES = [
	/** The operator answered. */
	"answered",
	/** The operator dismissed the dialog. */
	"cancelled",
	/** Nobody answered inside the deadline. */
	"timeout",
	/** No operator is attached (headless parent, print mode, a test). */
	"no_operator",
	/** Policy said no: wrong role, cap reached, or an authorization attempt. */
	"refused",
	/**
	 * The worker died while its question was open (cp-9tq7).
	 *
	 * Before this outcome existed the closing line was written as `answered`
	 * with the answer silently dropped, which made "nobody ever got this
	 * planner's answer" indistinguishable from "the operator answered". It is
	 * its own outcome precisely because the two must never read the same.
	 */
	"worker_exited",
] as const;
export type QuestionOutcome = (typeof QUESTION_OUTCOMES)[number];
export const QuestionOutcomeSchema = StringEnum([...QUESTION_OUTCOMES]);

/**
 * One line of `questions.jsonl`. Append-only: an exchange is a fact that
 * happened, so nothing here is ever rewritten.
 *
 * The body of a job's findings never appears in these lines, and neither does
 * an authorization: an answer informs a worker, it never approves anything.
 * Only `/cp-authorize` and `/cp-decline` answer a checkpoint — except a
 * `review` exchange, whose `approve` answer is the console approval spec
 * 2026-09-13 journals as the checkpoint decision.
 */
export const QuestionRecordSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		/** Monotonic per job, so a cap is counted rather than estimated. */
		seq: Type.Integer({ minimum: 1 }),
		/** The worker's dialog id, correlated back over the RPC sub-protocol. */
		dialog_id: Type.String({ minLength: 1, maxLength: 200 }),
		role: RoleSchema,
		method: StringEnum([...QUESTION_METHODS]),
		question: Type.String({ minLength: 1, maxLength: QUESTION_MAX_CHARS }),
		options: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: QUESTION_OPTION_MAX_CHARS }), {
				maxItems: QUESTION_MAX_OPTIONS,
			}),
		),
		asked_at: IsoTimestampSchema,
		closed_at: Type.Optional(IsoTimestampSchema),
		outcome: QuestionOutcomeSchema,
		answer: Type.Optional(Type.String({ maxLength: QUESTION_ANSWER_MAX_CHARS })),
		/** A human, named. Never a model, and never "the parent". */
		answered_by: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
		/** Why a `refused` outcome was refused; the worker is told this verbatim. */
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
	},
	{ additionalProperties: false },
);
export type QuestionRecord = Narrow<Static<typeof QuestionRecordSchema>, "outcome", QuestionOutcome> & {
	role: Role;
	method: QuestionMethod;
};

export function validateQuestionRecord(value: unknown): ValidationResult<QuestionRecord> {
	return validate<QuestionRecord>(QuestionRecordSchema, normalizeLegacyRoles(value));
}

/**
 * Words that turn a question into an approval request. A worker may ask what to
 * build; it may not ask permission to ship — evidence is not authorization, and
 * a dialog is not a checkpoint.
 */
export const QUESTION_AUTHORIZATION_PATTERNS: readonly RegExp[] = Object.freeze([
	/\b(?:may|can|should|shall)\s+i\s+(?:go\s+ahead|proceed|continue|ship|merge|push|deploy|implement|start)\b/i,
	/\b(?:authori[sz]e|authori[sz]ation|approve|approval|sign\s*-?\s*off|permission)\b/i,
	/\bok(?:ay)?\s+to\s+(?:ship|merge|push|proceed|deploy|implement|continue)\b/i,
	/\bgo\s*\/\s*no\s*-?\s*go\b/i,
]);

/**
 * Is this question really an authorization request? Checked in code, because
 * "ask a human" and "get permission" are one keystroke apart and only one of
 * them is a checkpoint.
 */
export function looksLikeAuthorization(question: string): boolean {
	return QUESTION_AUTHORIZATION_PATTERNS.some((pattern) => pattern.test(question));
}

/**
 * The exact wording that made `looksLikeAuthorization` fire, quoted back to the
 * caller — or undefined when there is nothing quotable to show.
 *
 * A refusal that does not name what it objects to costs the caller a guessing
 * game (cp-nz95: three attempts to discover the trigger word by experiment), so
 * every message built on the predicate quotes the matched phrase and says what
 * to write instead.
 *
 * **Descriptive only, never the predicate.** `looksLikeAuthorization` is
 * deliberately still its own `.some(test)` over the same patterns, so improving
 * or failing to quote a trigger can never change *what is refused* — the two
 * cannot drift into disagreeing about strictness, only about wording. A match
 * that trims to nothing is exactly that case: still a refusal, just with no
 * phrase worth printing.
 */
export function authorizationTrigger(
	question: string,
	patterns: readonly RegExp[] = QUESTION_AUTHORIZATION_PATTERNS,
): string | undefined {
	for (const pattern of patterns) {
		// A /g or /y pattern carries `lastIndex` across calls, which would make this
		// function's answer depend on how often it had been called. Match against a
		// flagless copy instead: pure, re-entrant, and identical for the common case.
		const probe = pattern.global || pattern.sticky ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
		const match = question.match(probe);
		if (!match) continue;
		const trigger = match[0].trim();
		return trigger.length > 0 ? trigger : undefined;
	}
	return undefined;
}
