/**
 * The merge ask (cp-gmy) — never ask a human to merge a PR while that PR's CI
 * is still running for its current head.
 *
 * The parent repeatedly asked for merge approval on PRs whose runs were
 * unfinished, then had to bank the answer and wait anyway; one PR was approved
 * twice, six minutes apart, because the question outlived the state it was
 * asked in. The answer could not be acted on at the moment it was given, which
 * is the definition of a premature ask.
 *
 * So the rule is mechanical and it lives where an Awaiting-you row is
 * **created** (`AwaitingStore.declare`), not in prose the parent is trusted to
 * follow: a merge ask is raised only once CI has *finished for the head that
 * would merge*.
 *
 * **"CI has finished" is exactly the check the parent already does by hand
 * before every merge**, promoted from a merge precondition to an *ask*
 * precondition:
 *
 *  - a completed run exists for the branch, and
 *  - that run's `headSha` is the branch's current pushed head.
 *
 * A completed run on a superseded sha says nothing about the head that would
 * merge, so it does not count as finished. (`gh pr checks` 403s in this home;
 * `gh run list --branch <b> --json conclusion,status,headSha` is the query that
 * works, and it is the shape this module's default probe issues — once, never
 * in a loop.)
 *
 * Outcomes, and none of them is silence:
 *
 *  | CI for the current head | verdict | what happens |
 *  |---|---|---|
 *  | completed, green, and reviewed on that head | `raise` | the row is opened |
 *  | queued/in progress, or only superseded runs | `defer` | the row is stored `deferred` and re-reviewed on every render |
 *  | completed, not green | `refuse` | no merge ask at all — merging red is already forbidden; the failure is surfaced instead |
 *  | not determinable | `defer` (`ci: "unknown"`) | not asked; the `cp-ci` wake-up (or the next render) settles it (cp-1som) |
 *  | green, but no passing `cp_review` on that head | `defer` (`ci: "unreviewed"`) | not asked; run `cp_review` on the current head first (cp-1som) |
 *  | the job itself is gone | `orphaned` (`ci: "job_gone"`) | the row is kept and rendered as "job <id> is gone — answer or withdraw", never raised, never deleted (cp-to39) |
 *  | the merge already happened | `resolved` (`ci: "already_merged"`) | the row is closed, never raised: the question answered itself (cp-p1sh) |
 *
 * **Ignorance defers (cp-1som).** It used to raise: "the gate delays an ask on
 * evidence, never on ignorance" was written to stop a deferral eating a
 * question, and it produced the opposite failure — a ship ask on PRs #117, #118
 * and #119 whose CI was still `in_progress` when the operator answered it,
 * because the parent asked at envelope time and the gate had nothing to read
 * yet. A deferred row is not a lost row: it is stored, printed under the table
 * every turn, and re-reviewed on every render, with the `cp-ci` wake-up as the
 * trigger that a run finished — and that wake-up re-gates the deferred rows
 * itself (`src/deferred-recheck.ts`), so nothing waits on a parent turn. So an unreadable CI state now costs a later ask,
 * not a premature one — merging is the irreversible half of this decision.
 *
 * ## "What if it never becomes ready?" — two deliberate non-answers
 *
 * Both deferrals below are **unbounded on purpose**, and neither has an escape
 * hatch. A deferred row is never invisible (it is stored in
 * `state/awaiting.json`, listed by `list("deferred")`, printed under the status
 * block's table on every render, and re-reviewed by
 * `AwaitingStore.reviewDeferred` each time), so "it waits" is not "it is lost".
 * What is missing in each case is a **fact somebody produces**, and the row
 * raising itself on the absence of that fact is exactly the incident this
 * module exists to prevent:
 *
 *  - **`unreviewed` — a job whose current head has no `cp_review` pass never
 *    raises a merge ask, for as long as that is true.** Review is mandatory for
 *    `delivery:pr` (AGENTS.md §Fan out: every ship PR gets a `cp_review`, and
 *    running it is the parent's), so "nothing makes the review exist" has an
 *    answer: **the parent runs `cp_review <job-id>`**, and the passing verdict
 *    raises the row as it is delivered. There is deliberately no ask-without-review path — adding
 *    one would make the mandatory review optional in the one moment it matters.
 *  - **`unknown` — an unreadable CI state never raises, and waits for a fact,
 *    not a timeout.** The recovery is the `cp-ci` watch (docs/contracts.md §The
 *    CI/PR watch): it queries GitHub for the branch's current head on its own
 *    timer, and the observation it produces re-runs this gate over every
 *    deferred row before it wakes anybody. The event alone is enough
 *    — no operator action, no render, no re-declaration. What is *not* offered is a
 *    bypass: "we could not read CI" must never become "ask anyway", because the
 *    answer would be spent on a head nobody has read.
 *
 * **A deferral must be *releasable*, and one shape was not (cp-1som, review 2).**
 * Every fact this gate needs is resolved through the job's fleet record, and the
 * `cp-ci` watch iterates fleet records too — so a merge ask with **no `job_id`**
 * could never be released by anything: no branch, no head, no runs, no review,
 * and no watcher pass that would ever look at it. That row is now refused
 * *before it is stored* (`MERGE_ASK_NEEDS_JOB_REFUSAL`, in `AwaitingStore`),
 * which is the opposite of an escape hatch: nothing is asked about an unready
 * PR, and the parent is told to re-pass the row with the job it concerns. The
 * branch below (`raise`/`defer` on a job-less row) therefore only ever runs for
 * a row stored before that refusal existed.
 *
 * **A branch with no pushed head is a different case, and it is releasable.**
 * The job exists, so the watcher looks at it every tick and asks the *remote*
 * for the branch head (`gitRemoteHead`); the moment the branch is pushed the
 * head resolves, CI starts, and the `cp-ci` wake-up (or any later render)
 * re-gates the row. Nothing needs to remember it.
 *
 * **Deliberately NOT included: a stale base.** The parent also checks, before
 * merging, that a branch is not built on a superseded base. That condition is
 * not gated here — see docs/contracts.md §The merge ask for the reasoning: a
 * stale base is fixed by a rebase the parent can order without the operator,
 * while CI is a wait nobody can shorten, and a rebase changes the head, which
 * re-enters this gate through the front door anyway.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CiConfiguredState } from "./ci-configured.ts";
import {
	AWAITING_DECISION_MAX_CHARS,
	type DiffVerdict,
	DiffVerdictSchema,
	paths,
	REVIEW_MAX_ATTEMPTS,
	validate,
} from "./contracts.ts";
import { acceptedFinalFixHeads } from "./final-fix.ts";
import { isCompletePass } from "./review-subject.ts";

/** One row of `gh run list --json conclusion,status,headSha,workflowName,databaseId,attempt`. */
export interface CiRun {
	/** `queued` | `in_progress` | `completed` | anything gh grows later. */
	status: string;
	/** `success` | `failure` | … ; null while the run is not completed. */
	conclusion: string | null;
	headSha: string;
	/**
	 * The run's numeric id (`databaseId`). Stable across a re-run; `attempt` is what
	 * moves. Together they are the identity a `cp-ci` announcement is keyed on
	 * (pi-command-post-rerunwake-12z): a second attempt on the same head is a new
	 * fact and wakes once, the same attempt seen twice is not.
	 */
	databaseId?: number;
	/** 1 for the first attempt, incremented by `gh run rerun`; absent on older gh. */
	attempt?: number;
	workflowName?: string;
}

/** What the current head of a branch is, and how we know (or why we do not). */
export interface HeadResolution {
	sha?: string;
	/** Present when `sha` is absent: the operator-facing reason. */
	reason?: string;
}

/**
 * CI state for the head that would merge.
 *
 * `job_gone` is not a CI state at all (cp-to39): it is the one condition under
 * which there is no branch to ask about, because the job this row belongs to no
 * longer has a fleet record. It is kept distinct from `unknown` on purpose: both
 * hold the ask back (cp-1som), but `unknown` is a wait that a later render or a
 * `cp-ci` wake-up can end by itself, while a torn-down job never resolves and
 * needs a human to answer or withdraw the row.
 */
export type MergeAskCi =
	| "green"
	| "in_progress"
	| "superseded"
	| "failed"
	| "unknown"
	/**
	 * The repository has **no CI configured** and said so itself
	 * (cp-no-ci-repo-derived): no run will ever appear, so an absent run is not
	 * ignorance and the row is not held back for one. Never inferred from zero
	 * runs — see `src/ci-configured.ts`.
	 */
	| "no_ci"
	/** Green on this head, but no passing `cp_review` for it yet (cp-1som). */
	| "unreviewed"
	| "job_gone"
	| "already_merged";

/**
 * `orphaned` is neither a raise nor a defer-on-CI: the row is kept, visible and
 * answerable, but it is never promoted to an ask the operator cannot act on
 * (cp-to39). Nothing is deleted on this action.
 */
export type MergeAskAction = "raise" | "defer" | "refuse" | "orphaned" | "resolved";


export interface MergeAskVerdict {
	action: MergeAskAction;
	ci: MergeAskCi;
	/** One bounded line, operator-facing: it is rendered under the table. */
	reason: string;
	head?: string;
	run_head?: string;
	conclusion?: string;
}

/**
 * "This row's job no longer exists" — a *cause*, not an error message to
 * string-match (cp-to39). A probe's fact source (the project clone, the branch
 * name, the reported head) is resolved through the fleet record; when that
 * record is gone the branch cannot be named, so there is nothing to ask CI
 * about. Throwing this from a probe dependency is how that condition reaches
 * the gate distinctly from "we could not reach `gh`".
 */
export class MergeAskJobGoneError extends Error {
	/** Structural marker: survives duplicate module instances, unlike instanceof. */
	readonly mergeAskJobGone = true;
	readonly jobId: string;

	constructor(jobId: string, message?: string) {
		super(message ?? `no fleet record for ${jobId}`);
		this.name = "MergeAskJobGoneError";
		this.jobId = jobId;
	}
}

/** True for the cause above, however the error crossed a module boundary. */
export function isJobGoneError(error: unknown): error is MergeAskJobGoneError {
	return (
		error instanceof MergeAskJobGoneError ||
		(typeof error === "object" && error !== null && (error as { mergeAskJobGone?: unknown }).mergeAskJobGone === true)
	);
}

/**
 * Local, already-observed evidence that the merge a row asks about **has
 * already happened** (cp-p1sh) — the fields of a merge receipt
 * (`state/runs/<job-id>/merge.json`) this gate needs, and nothing else.
 *
 * Why the receipt and not `gh pr view`: the receipt is only ever written for a
 * PR GitHub itself reported as `MERGED` (`src/merges.ts`), so it *is* the
 * observation, not a claim about one — and it is a local file, so reading it
 * adds no network call to a render path. Its absence is deliberately **not**
 * evidence of anything: a row with no receipt falls straight through to the CI
 * rule below, exactly as before, which is what keeps ignorance out of this
 * cause.
 */
export interface MergeAskMergedEvidence {
	/** The merge commit GitHub named. A receipt without one is never written. */
	merge_commit_sha: string;
	pr_number?: number;
	pr_url?: string;
	head_sha?: string;
	merged_at?: string;
}

/**
 * "Is this row asking about a merge that already landed?" — the whole rule, as
 * a pure function over facts (cp-p1sh).
 *
 * A deferred merge ask had exactly one exit before this: CI finishing. So when
 * the PR merged *while the row was deferred* — repo-derived authority merges it
 * without consuming an operator turn — the row still raised itself afterwards
 * and asked a human to approve a merge whose commit already existed (cp-rud /
 * PR #69, cp-n1a / PR #70, both withdrawn by hand).
 *
 * Structural, never a string match: the caller hands over the receipt for this
 * row's job, and the only comparison made is PR **number** against PR number
 * (the receipt's own `pr_number`, or the number in its `pr_url` when the field
 * is absent — `receiptPrNumber`). A row that names a different PR than the
 * receipt does is not resolved by it: that is a fact about another delivery.
 *
 * Two absences, both deliberate:
 *
 *  - **A row that names no PR** is resolved by its own job's receipt. The row is
 *    keyed to a job, a job has one delivery, and the receipt is that delivery.
 *  - **A receipt that names no PR at all** (neither field parses) still resolves
 *    a row that names one, for the same reason: the caller looked the receipt up
 *    *by this row's job id*, so it is this job's merge either way. Nothing weaker
 *    is available to compare, and inventing a mismatch out of a missing field
 *    would reintroduce the ask this cause exists to close.
 */
export function evaluateAlreadyMerged(input: {
	jobId: string;
	/** The PR number the row's text names, when it names one. */
	prNumber?: string;
	evidence?: MergeAskMergedEvidence;
}): MergeAskVerdict | undefined {
	const evidence = input.evidence;
	if (!evidence || typeof evidence.merge_commit_sha !== "string" || evidence.merge_commit_sha.trim().length === 0) {
		return undefined;
	}
	const asked = input.prNumber?.trim();
	const named = receiptPrNumber(evidence);
	if (asked && named !== undefined && named !== asked) {
		// The receipt is about a different PR, so it says nothing about this row.
		return undefined;
	}
	const pr = named !== undefined ? `PR #${named}` : (evidence.pr_url ?? `${input.jobId}'s PR`);
	return verdict({
		action: "resolved",
		ci: "already_merged",
		reason: `${pr} already merged as ${short(evidence.merge_commit_sha)} — nothing left to approve`,
		...(evidence.head_sha ? { head: evidence.head_sha } : {}),
	});
}

/** The gate, as one injectable function. Hermetic in tests, `gh` in production. */
export type MergeAskProbe = (input: MergeAskSubject) => Promise<MergeAskVerdict>;

export interface MergeAskSubject {
	type: string;
	decision: string;
	subject?: string;
	job_id?: string;
}

/** Conclusions that mean "this run says the head is fine to merge". */
const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** A sha comparison that tolerates the short shas humans and gh both print. */
export function shaMatches(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const left = a.trim().toLowerCase();
	const right = b.trim().toLowerCase();
	if (left.length < 7 || right.length < 7) return false;
	return left.startsWith(right) || right.startsWith(left);
}

function short(sha: string | undefined): string {
	return sha ? sha.trim().slice(0, 7) : "?";
}

function bounded(reason: string): string {
	return reason.length <= AWAITING_DECISION_MAX_CHARS ? reason : `${reason.slice(0, AWAITING_DECISION_MAX_CHARS - 1)}…`;
}

function verdict(input: MergeAskVerdict): MergeAskVerdict {
	return { ...input, reason: bounded(input.reason) };
}

/**
 * The whole rule, as a pure function over facts. Everything else in this file
 * is about *obtaining* those facts.
 */
export function evaluateMergeAskCi(input: {
	branch: string;
	head: HeadResolution;
	runs: readonly CiRun[];
	/**
	 * cp-1som: the heads a `cp_review` has *passed* on, when the caller can
	 * supply them. Absent means "not part of this question" and the rule is
	 * exactly what it was — `readCiForHead` never passes it. `cp_integrate` has its
	 * own review gate before merge (`readReviewPassVerdict`), not this parameter.
	 */
	reviewedHeads?: readonly string[];
	/**
	 * cp-no-ci-repo-derived: what the repository itself said about having CI, when
	 * the caller asked. Only `"none"` changes anything, and only in the zero-runs
	 * branch below; absent, `"present"` and `"unreadable"` all leave the rule
	 * exactly as it was.
	 */
	ciConfigured?: CiConfiguredState;
}): MergeAskVerdict {
	const head = input.head.sha;
	if (!head) {
		return verdict({
			action: "defer",
			ci: "unknown",
			reason: `CI not checked: ${input.head.reason ?? `no pushed head known for ${input.branch}`}`,
		});
	}
	if (input.runs.length === 0) {
		// cp-no-ci-repo-derived: "no runs" is two conditions. A repository that
		// *positively* reports no workflows will never produce one, so deferring the
		// row waits for an event that cannot happen; anything less than that positive
		// answer is ignorance about CI and still defers, exactly as before.
		if (input.ciConfigured !== "none") {
			return verdict({
				action: "defer",
				ci: "unknown",
				reason: `no CI runs are observable for ${input.branch} on ${short(head)} — not asked until one is`,
				head,
			});
		}
		// The review precondition is untouched: no CI is not "no review".
		if (input.reviewedHeads && !input.reviewedHeads.some((sha) => shaMatches(sha, head))) {
			return verdict({
				action: "defer",
				ci: "unreviewed",
				reason: `no CI is configured for ${input.branch}, but no passing cp_review on ${short(head)} yet — review it, then ask`,
				head,
			});
		}
		return verdict({
			action: "raise",
			ci: "no_ci",
			reason: `no CI is configured for this repository — nothing will run on ${short(head)}`,
			head,
		});
	}
	const forHead = input.runs.filter((run) => shaMatches(run.headSha, head));
	if (forHead.length === 0) {
		const newest = input.runs[0];
		return verdict({
			action: "defer",
			ci: "superseded",
			reason: `no CI run has started on ${short(head)} yet (latest run is on ${short(newest?.headSha)})`,
			head,
			...(newest?.headSha ? { run_head: newest.headSha } : {}),
		});
	}
	const unfinished = forHead.filter((run) => run.status !== "completed");
	if (unfinished.length > 0) {
		const run = unfinished[0]!;
		return verdict({
			action: "defer",
			ci: "in_progress",
			reason: `CI is ${run.status} on ${short(head)}${run.workflowName ? ` (${run.workflowName})` : ""}`,
			head,
			run_head: run.headSha,
		});
	}
	const notGreen = forHead.filter((run) => !GREEN_CONCLUSIONS.has((run.conclusion ?? "").toLowerCase()));
	if (notGreen.length > 0) {
		const run = notGreen[0]!;
		const conclusion = run.conclusion ?? "no conclusion";
		return verdict({
			action: "refuse",
			ci: "failed",
			reason: `CI ${conclusion} on ${short(head)}${run.workflowName ? ` (${run.workflowName})` : ""} — merging red is forbidden`,
			head,
			run_head: run.headSha,
			conclusion,
		});
	}
	// cp-1som: green is necessary and not sufficient. A `delivery:pr` ship ask is
	// raised only once the diff has a passing review on *this* head, because a
	// revise moves the head and a review of a superseded diff says nothing about
	// the commit that would merge — the same rule the CI check above applies.
	if (input.reviewedHeads && !input.reviewedHeads.some((sha) => shaMatches(sha, head))) {
		return verdict({
			action: "defer",
			ci: "unreviewed",
			reason: `CI green on ${short(head)}, but no passing cp_review on that head yet — review it, then ask`,
			head,
			run_head: forHead[0]!.headSha,
			conclusion: "success",
		});
	}
	return verdict({
		action: "raise",
		ci: "green",
		reason: `CI green on ${short(head)}`,
		head,
		run_head: forHead[0]!.headSha,
		conclusion: "success",
	});
}

/**
 * "Has CI finished on this exact head, and with what conclusion?" — the one
 * shared answer to the one question three separate features need (cp-uug §9:
 * the merge ask, the integration tool and, when it lands, the wake trigger).
 * Three implementations of this query is the bad outcome; this is the function
 * they import instead, and `evaluateMergeAskCi` above is still the only rule.
 *
 * Pure: the caller supplies the runs (`ghRunListArgs` builds the one query) and
 * the head, so it is hermetic wherever it is used.
 */
export function readCiForHead(input: {
	branch: string;
	/** The branch's current *pushed* head. Absent means "not determinable". */
	headSha: string | undefined;
	runs: readonly CiRun[];
}): MergeAskVerdict {
	return evaluateMergeAskCi({
		branch: input.branch,
		head: input.headSha ? { sha: input.headSha } : { reason: `no pushed head known for ${input.branch}` },
		runs: input.runs,
	});
}

// ---------------------------------------------------------------------------
// Which rows this gate governs
// ---------------------------------------------------------------------------

/** `PR #47`, `pr 47`, `pull request #47`, or a bare `#47` — same shape awaiting.ts keys on. */
const PR_REFERENCE = /(?:\bpull request\s*#?\s*|\bpr\s*#?\s*|#)(\d+)/i;
const MERGE_VERB = /^\s*(?:please\s+)?merg(?:e|ing)\b/i;
/** cp-1som: "ship" is the word the parent actually used on #117–#119. */
const MERGE_WORD = /\b(?:merg(?:e|ed|ing)|ship(?:s|ped|ping)?)\b/i;

/**
 * Is this row a request to merge (or ship) a PR?
 *
 * Two shapes count, and both are narrow on purpose: "merge" as the leading verb
 * ("Merge PR #44 once its rebase lands green", "merge cp-gmy?"), or the word
 * "merge"/"ship" anywhere in a decision that **also names a PR** ("Ship cp-dlw7
 * (PR 119), drop it, or open a follow-up?"). A design question that merely
 * mentions merging two documents is not a merge ask, and an `authorization` row
 * never is — a checkpoint is decided by `CheckpointStore.decide` and never
 * enters the awaiting store at all.
 *
 * **Naming a PR is what makes a ship row a merge ask (cp-1som).** The ship/drop
 * row for finished *research* — "Ship cp-x, drop it, or open a follow-up?" —
 * names no PR because there is none, and it is deliberately out of scope: there
 * is no head to read CI for, so gating it would defer a question forever that
 * nothing could ever raise. A ship row that names a PR has a branch, a head and
 * a CI verdict, which is exactly what this gate needs.
 */
export function isMergeAsk(input: MergeAskSubject): boolean {
	if (input.type === "authorization") return false;
	const text = `${input.subject ?? ""} ${input.decision}`.trim();
	if (MERGE_VERB.test(input.subject ?? "") || MERGE_VERB.test(input.decision)) return true;
	return MERGE_WORD.test(text) && PR_REFERENCE.test(text);
}

/**
 * The PR a merge receipt is about, as a number, from the field or from the url
 * (cp-p1sh). `undefined` means the receipt names no PR number — which is not a
 * mismatch with anything; see `evaluateAlreadyMerged`.
 */
export function receiptPrNumber(evidence: MergeAskMergedEvidence): string | undefined {
	if (typeof evidence.pr_number === "number" && Number.isFinite(evidence.pr_number)) return String(evidence.pr_number);
	const fromUrl = evidence.pr_url?.match(/\/pull\/(\d+)/)?.[1];
	return fromUrl && fromUrl.length > 0 ? fromUrl : undefined;
}

/** The PR number a merge ask names, when it names one (for the notice line). */
export function mergeAskPrNumber(decision: string): string | undefined {
	return decision.match(PR_REFERENCE)?.[1];
}

// ---------------------------------------------------------------------------
// Building a probe from injected facts
// ---------------------------------------------------------------------------

export interface MergeAskProbeDeps {
	/** Completed and in-flight runs for a branch, newest first. */
	runs: (branch: string, jobId: string) => Promise<readonly CiRun[]>;
	/**
	 * cp-p1sh: the job's merge receipt, when one exists — local, already observed,
	 * and checked *before* CI, because a merge that has happened is not a question
	 * about CI any more. Omitted (or resolving to `undefined`) leaves the gate
	 * exactly as it was.
	 */
	merged?: (jobId: string) => Promise<MergeAskMergedEvidence | undefined> | MergeAskMergedEvidence | undefined;
	/** The branch's current pushed head, or why it is not known. */
	head: (branch: string, jobId: string) => Promise<HeadResolution>;
	/**
	 * cp-1som: the heads this job's `cp_review` has passed on
	 * (`state/runs/<job-id>/review-<n>.json`, `verdict: "pass"`). Local files, so
	 * it costs the render path no network call. Omitted leaves the review
	 * precondition out entirely.
	 */
	reviewedHeads?: (jobId: string) => Promise<readonly string[]> | readonly string[];
	/**
	 * cp-no-ci-repo-derived: what the repository says about having CI at all.
	 * Called **only** when the branch has zero runs, so the ordinary render path
	 * costs no extra network call. Omitted leaves the gate exactly as it was:
	 * zero runs defers.
	 */
	ciConfigured?: (jobId: string) => Promise<CiConfiguredState> | CiConfiguredState;
	/** Branch for a job. The contract is `branch === job id`, which is the default. */
	branch?: (jobId: string) => string;
}

/**
 * Assemble a probe. Every failure path here resolves to `defer` with
 * `ci: "unknown"` and the reason attached (cp-1som): a merge ask is raised on
 * *evidence that the head is mergeable*, so a broken `gh` costs a later ask
 * rather than a premature one. The row is stored, printed under the table every
 * turn and re-reviewed on every render, so nothing is lost by waiting — which is
 * not true of a merge answered against a head nobody has read.
 *
 * cp-nz95 asked whether the gate should apply at all to a row whose job has no
 * branch or PR. It does, and it now defers rather than raises: a job with no
 * pushed head yields `HeadResolution.reason`, and a row with no `job_id` has no
 * branch to read. Both are "we cannot tell whether this head is mergeable",
 * which is the case this gate exists to hold.
 */
export function createMergeAskProbe(deps: MergeAskProbeDeps): MergeAskProbe {
	const branchOf = deps.branch ?? ((jobId: string) => jobId);
	return async (input) => {
		if (!input.job_id) {
			// Unreachable for a newly declared row since cp-1som review 2 (the store
			// refuses it outright); kept for rows written before that, which are still
			// on disk, still printed, and answerable or withdrawable via /cp-decide.
			return verdict({
				action: "defer",
				ci: "unknown",
				reason: "CI not checked: this row names no job, so it has no branch — answer or withdraw it with cp_decide",
			});
		}
		const branch = branchOf(input.job_id);
		try {
			// cp-p1sh: first, and before any fact that needs a clone or the network — a
			// merge that already landed makes every CI question about it moot, and a
			// row that has to wait for `gh` to learn that is a row that can raise itself
			// into an ask nobody can act on in the meantime.
			const asked = mergeAskPrNumber(`${input.subject ?? ""} ${input.decision}`);
			const receipt = deps.merged ? await deps.merged(input.job_id) : undefined;
			const alreadyMerged = evaluateAlreadyMerged({
				jobId: input.job_id,
				...(asked ? { prNumber: asked } : {}),
				...(receipt ? { evidence: receipt } : {}),
			});
			if (alreadyMerged) return alreadyMerged;
			const head = await deps.head(branch, input.job_id);
			if (!head.sha) return evaluateMergeAskCi({ branch, head, runs: [] });
			const runs = await deps.runs(branch, input.job_id);
			const reviewedHeads = deps.reviewedHeads ? await deps.reviewedHeads(input.job_id) : undefined;
			// Only asked when there is nothing to read: a branch with runs already has
			// its answer, and this is a network call on a render path.
			const ciConfigured = runs.length === 0 && deps.ciConfigured ? await deps.ciConfigured(input.job_id) : undefined;
			return evaluateMergeAskCi({
				branch,
				head,
				runs,
				...(reviewedHeads ? { reviewedHeads } : {}),
				...(ciConfigured ? { ciConfigured } : {}),
			});
		} catch (error) {
			// cp-to39: a torn-down job is the one failure that must NOT become an ask.
			// It is not ignorance about CI — it is knowledge that the question names a
			// job that is gone, so raising it would produce an unanswerable merge ask
			// for a PR nobody can act on from here. The row is kept either way; see
			// AwaitingStore.reviewDeferred.
			if (isJobGoneError(error)) {
				return verdict({
					action: "orphaned",
					ci: "job_gone",
					reason: `job ${input.job_id} is gone — answer or withdraw (${(error as Error).message})`,
				});
			}
			return verdict({
				action: "defer",
				ci: "unknown",
				reason: `CI state unavailable for ${branch}: ${(error as Error).message}`,
			});
		}
	};
}

// ---------------------------------------------------------------------------
// The production facts: one `gh run list`, one `git rev-parse`/`ls-remote`
// ---------------------------------------------------------------------------

export type CommandRunner = (
	command: string,
	args: readonly string[],
	options: { cwd: string; timeoutMs: number },
) => Promise<string>;

export const runCommand: CommandRunner = (command, args, options) =>
	new Promise<string>((resolve, reject) => {
		execFile(
			command,
			[...args],
			{ cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`${command} ${args.join(" ")} failed: ${(stderr || (error as Error).message).trim().slice(0, 200)}`));
					return;
				}
				resolve(stdout.toString());
			},
		);
	});

/** Default timeout for the one CI query. A gate must never hang a render. */
export const MERGE_ASK_QUERY_TIMEOUT_MS = 15_000;
/** How many runs the query asks for: enough to see the newest per workflow. */
export const MERGE_ASK_RUN_LIMIT = 10;

/**
 * The **only** place `gh run list` is spelled out (cp-uug §9). `gh pr checks`
 * 403s in this home, so this is the query that actually works, and it is a
 * single non-blocking call — exactly the shape `src/ci-wait.ts` sanctions and
 * never the `--watch`/poll shapes it refuses.
 */
export function ghRunListArgs(branch: string, limit: number = MERGE_ASK_RUN_LIMIT): string[] {
	return ["run", "list", "--branch", branch, "--limit", String(limit), "--json", "conclusion,status,headSha,workflowName,databaseId,attempt"];
}

/**
 * `gh run list --branch <b> --limit N --json conclusion,status,headSha,workflowName`
 * — a single non-blocking query, exactly the shape `src/ci-wait.ts` sanctions
 * and never the `--watch`/poll shapes it refuses.
 */
export function ghCiRuns(options: { cwd: string; exec?: CommandRunner; timeoutMs?: number }): (branch: string) => Promise<CiRun[]> {
	const exec = options.exec ?? runCommand;
	return async (branch: string) => {
		const stdout = await exec("gh", ghRunListArgs(branch), {
			cwd: options.cwd,
			timeoutMs: options.timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS,
		});
		return parseCiRuns(stdout);
	};
}

/** Tolerant of gh's field drift: anything without a headSha is not a fact. */
export function parseCiRuns(stdout: string): CiRun[] {
	const text = stdout.trim();
	if (text.length === 0) return [];
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) return [];
	const runs: CiRun[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as Record<string, unknown>;
		const headSha = typeof row.headSha === "string" ? row.headSha : "";
		if (headSha.length === 0) continue;
		runs.push({
			status: typeof row.status === "string" ? row.status : "unknown",
			conclusion: typeof row.conclusion === "string" && row.conclusion.length > 0 ? row.conclusion : null,
			headSha,
			...(typeof row.databaseId === "number" ? { databaseId: row.databaseId } : {}),
			...(typeof row.attempt === "number" ? { attempt: row.attempt } : {}),
			...(typeof row.workflowName === "string" ? { workflowName: row.workflowName } : {}),
		});
	}
	return runs;
}

/**
 * The heads `cp_review` has returned a **pass** for (cp-1som), read from this
 * home's own `state/runs/<job-id>/review-<n>.json`. Local files only: no
 * network call belongs on a render path, and the verdict this home wrote is the
 * observation itself, never a claim about one.
 *
 * **This is a reader of an existing store, not a second one.** The writer is
 * `DiffReview.#persist` ([`src/diff-review.ts`](./diff-review.ts)), which
 * validates a `DiffVerdict` against `DiffVerdictSchema` and then
 * `atomicWriteJson`s it to `paths.reviewFile(jobId, attempt)` — the same path
 * function and the same schema this function uses, so a field rename or a moved
 * path cannot leave the two disagreeing silently: the schema refuses the file
 * and the compiler refuses the path. `verdict: "pass"` and `head_sha` are that
 * schema's own fields (`GateVerdictValueSchema` is `pass|revise|escalate`;
 * `head_sha` is "the branch commit this verdict reviewed").
 *
 * Tolerant by construction: an unreadable or contract-violating verdict file is
 * *no pass*, which holds a merge ask back rather than raising one on a review
 * nobody can read.
 *
 * **Every attempt slot is looked at, and a gap is not a stop.** The obvious
 * shape here is `readPriorAttempts`' — count up from 1 and `break` on the first
 * missing file — and it is wrong for *this* question. That function is counting
 * how many attempts a branch has spent, so a contiguous prefix is the answer it
 * needs; this one is asking whether **any** review passed on one specific sha,
 * and `review-1.json` being absent (hand-pruned, a partial restore, a write that
 * failed while a later one landed) would then hide the pass in `review-2.json`
 * and defer a merge ask that is genuinely ready. The scan is bounded by
 * `REVIEW_MAX_ATTEMPTS`, which is the same bound the review ladder itself
 * enforces, so looking at every slot costs at most five `existsSync` calls.
 */
export function readReviewPassHeads(home: string, jobId: string): string[] {
	const heads: string[] = [];
	for (let attempt = 1; attempt <= REVIEW_MAX_ATTEMPTS; attempt += 1) {
		const file = join(home, paths.reviewFile(jobId, attempt));
		if (!existsSync(file)) continue;
		try {
			// The writer's own schema, so "what cp_review writes" and "what this reads"
			// are one definition rather than two hand-kept-in-sync field lists.
			const parsed = validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(readFileSync(file, "utf8")));
			if (parsed.ok && isCompletePass(parsed.value)) heads.push(parsed.value.head_sha);
		} catch {
			// An unreadable verdict is not a pass.
		}
	}
	const dir = join(home, paths.runDir(jobId));
	try {
		for (const name of readdirSync(dir)) {
			if (!name.startsWith("review-equivalent-") || !name.endsWith(".json")) continue;
			try {
				const parsed = validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(readFileSync(join(dir, name), "utf8")));
				if (parsed.ok && isCompletePass(parsed.value) && parsed.value.equivalent_to) heads.push(parsed.value.head_sha);
			} catch {
				// An unreadable equivalence is not a pass.
			}
		}
	} catch {
		// A missing run directory has no passes.
	}
	// jje.3: a bound, unvoided operator-approved final fix head counts as reviewed (never a sixth review).
	heads.push(...acceptedFinalFixHeads(home, jobId));
	return heads;
}

/** A persisted, complete pass for this exact head, including patch-id equivalence. */
export function readReviewPassVerdict(home: string, jobId: string, head: string): DiffVerdict | undefined {
	for (let attempt = REVIEW_MAX_ATTEMPTS; attempt >= 1; attempt -= 1) {
		const file = join(home, paths.reviewFile(jobId, attempt));
		if (!existsSync(file)) continue;
		try {
			const parsed = validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(readFileSync(file, "utf8")));
			if (parsed.ok && isCompletePass(parsed.value) && shaMatches(parsed.value.head_sha, head)) return parsed.value;
		} catch {}
	}
	try {
		const parsed = validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(readFileSync(join(home, paths.reviewEquivalenceFile(jobId, head)), "utf8")));
		return parsed.ok && isCompletePass(parsed.value) ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The branch's current pushed head, asked of the remote (`git ls-remote`) so a
 * stale local clone cannot make a superseded sha look current. A worker's
 * reported `head_sha` is a better answer when it is available — it is the exact
 * commit the merge decision concerns — so the caller passes it first.
 */
export function gitRemoteHead(options: {
	cwd: string;
	exec?: CommandRunner;
	timeoutMs?: number;
	/** Used only when the remote cannot answer: a worker's reported `head_sha`. */
	fallback?: (jobId: string) => string | undefined;
}): (branch: string, jobId: string) => Promise<HeadResolution> {
	const exec = options.exec ?? runCommand;
	return async (branch: string, jobId: string) => {
		try {
			const stdout = await exec("git", ["ls-remote", "origin", `refs/heads/${branch}`], {
				cwd: options.cwd,
				timeoutMs: options.timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS,
			});
			const sha = stdout.trim().split(/\s+/)[0] ?? "";
			if (sha.length >= 7) return { sha };
		} catch {
			// Fall through to the reported head: the remote is authoritative when it
			// answers, but an unreachable remote must not become a deferred ask.
		}
		const reported = options.fallback?.(jobId)?.trim();
		if (reported && reported.length >= 7) return { sha: reported };
		return { reason: `${branch} has no pushed head on origin` };
	};
}
