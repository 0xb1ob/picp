/**
 * Repo-derived merge permission (cp-e0c, answering br cp-x7i).
 *
 * The operator's answer, verbatim: "If a given repository allows merging
 * without force then assume you can merge, if repository does not allow to
 * merge due to minimum reviewers then just remind user that merge is
 * pending." `gh pr merge --help` gives *force* its exact mechanical meaning:
 * `--admin` ("Use administrator privileges to merge a pull request that does
 * not meet requirements"). So the rule this module implements is: merge only
 * when GitHub would accept the merge with no `--admin` and no ruleset bypass;
 * never rely on GitHub to refuse on its own, because this home's PAT reports
 * `current_user_can_bypass: "always"` on at least one active ruleset, which
 * means GitHub might well let a "BLOCKED" merge through if asked — the
 * refusal has to be ours, in code.
 *
 * `evaluateMergePermission` is the whole decision, as a pure function over one
 * allowlist: `mergeStateStatus` \u2208 {CLEAN, HAS_HOOKS} is `permitted`; anything
 * else is `pending` (the repo blocks it, for a nameable or unnameable reason),
 * `retry` (GitHub is still computing it), or `unreadable` (an absent,
 * empty or unrecognised value — never read as permission). The allowlist is
 * the whole rule, not a denylist, which is what keeps an unreadable signal
 * from ever becoming a merge: everything that isn't explicitly permitted
 * falls to a state a caller must treat as "do not merge".
 *
 * Two helpers exist purely to *obtain* facts, mirroring src/merge-ask.ts's
 * shape: `GH_PR_PERMISSION_FIELDS` for `gh pr view`, and
 * `ghBranchRulesArgs`/`parseBranchRules` for `gh api
 * repos/{owner}/{repo}/rules/branches/<base>` — readable in this home
 * (unlike classic `/branches/*\/protection`, which 403s) and used
 * **reason-only**: a 403 or a parse failure degrades the sentence a verdict
 * carries, never the verdict itself.
 */

/** The `gh pr view --json` fields this module reads, on top of integrate.ts's own. */
export const GH_PR_PERMISSION_FIELDS = [
	"state",
	"mergeable",
	"mergeStateStatus",
	"reviewDecision",
	"isDraft",
	"headRefOid",
	"autoMergeRequest",
] as const;

export type MergePermission = "permitted" | "pending" | "retry" | "unreadable";

export type MergePendingCause =
	| "reviews"
	| "checks"
	| "conflict"
	| "draft"
	| "behind"
	| "unstable"
	| "queue"
	| "unknown_block";

export interface MergePermissionVerdict {
	permission: MergePermission;
	cause?: MergePendingCause;
	/** One bounded, operator-facing line. */
	reason: string;
	merge_state_status?: string;
	review_decision?: string;
	/** Headline facts behind this verdict, for the audit trail. */
	facts: string[];
}

export interface MergePermissionPr {
	state?: string;
	isDraft?: boolean;
	mergeable?: string;
	mergeStateStatus?: string;
	reviewDecision?: string;
	headRefOid?: string;
	/** Non-null means auto-merge is armed — never something this tool arms or relies on. */
	autoMergeRequest?: unknown;
}

/** One rule row from `gh api repos/{owner}/{repo}/rules/branches/<base>`. */
export interface BranchRule {
	type: string;
	parameters?: Record<string, unknown>;
}

const PERMITTED_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS"]);
const REVIEW_BLOCKING = new Set(["REVIEW_REQUIRED", "CHANGES_REQUESTED"]);
const REASON_MAX_CHARS = 500;

function bounded(reason: string): string {
	return reason.length <= REASON_MAX_CHARS ? reason : `${reason.slice(0, REASON_MAX_CHARS - 1)}\u2026`;
}

function ruleParam(rule: BranchRule | undefined, key: string): unknown {
	return rule?.parameters?.[key];
}

/** The `pull_request` rule's required review count, when the rules were readable. */
function requiredReviewCount(rules: readonly BranchRule[] | undefined): number | undefined {
	const rule = (rules ?? []).find((entry) => entry.type === "pull_request");
	const count = ruleParam(rule, "required_approving_review_count");
	return typeof count === "number" ? count : undefined;
}

/** The `required_status_checks` rule's named contexts, when the rules were readable. */
function requiredCheckContexts(rules: readonly BranchRule[] | undefined): string | undefined {
	const rule = (rules ?? []).find((entry) => entry.type === "required_status_checks");
	if (!rule) return undefined;
	const checks = ruleParam(rule, "required_status_checks");
	if (!Array.isArray(checks)) return rule ? "" : undefined;
	const contexts = checks
		.map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).context : undefined))
		.filter((context): context is string => typeof context === "string" && context.length > 0);
	return contexts.join(", ");
}

function hasRequiredChecksRule(rules: readonly BranchRule[] | undefined): boolean {
	return (rules ?? []).some((entry) => entry.type === "required_status_checks");
}

/**
 * Does a readable branch rule *prove* the branch must be up to date with its
 * base before it merges (`strict_required_status_checks_policy: true`)? Only an
 * explicit `true` counts: unreadable rules (`undefined`) are never proof.
 */
export function rulesRequireUpToDate(rules: readonly BranchRule[] | undefined): boolean {
	return (rules ?? []).some(
		(entry) =>
			entry.type === "required_status_checks" && entry.parameters?.strict_required_status_checks_policy === true,
	);
}

/**
 * The whole permission decision, as one pure function. Everything else in this
 * module obtains the facts this reads.
 */
export function evaluateMergePermission(input: {
	branch: string;
	/** The head this decision concerns — the one CI was verified for. */
	headSha: string;
	pr: MergePermissionPr;
	/** Reason-only. `undefined` means the rules endpoint was not read or 403'd. */
	rules?: readonly BranchRule[];
}): MergePermissionVerdict {
	const head12 = input.headSha.slice(0, 12);
	const status = (input.pr.mergeStateStatus ?? "").trim().toUpperCase();
	const reviewDecision = input.pr.reviewDecision?.trim();
	const facts = [`mergeStateStatus=${status || "(absent)"}`];
	if (reviewDecision !== undefined) facts.push(`reviewDecision=${reviewDecision || "(none)"}`);

	const common = {
		merge_state_status: status || undefined,
		review_decision: reviewDecision,
		facts,
	};

	if (input.pr.isDraft === true) {
		return { permission: "pending", cause: "draft", reason: `${input.branch} is a draft PR and is never merged`, ...common };
	}

	// Checked before the allowlist, and regardless of mergeStateStatus: a
	// mergeability GitHub is still computing is never permission, even when the
	// merge state in the same response looks clean.
	const mergeable = (input.pr.mergeable ?? "").trim().toUpperCase();
	if (status === "UNKNOWN" || mergeable === "UNKNOWN") {
		return {
			permission: "retry",
			reason: `GitHub is still computing mergeability for ${head12}; nothing was mutated`,
			...common,
		};
	}

	if (PERMITTED_MERGE_STATES.has(status)) {
		return {
			permission: "permitted",
			reason: `GitHub reports mergeStateStatus=${status} at ${head12} \u2014 the merge is unforced`,
			...common,
		};
	}

	if (status === "BEHIND") {
		return {
			permission: "pending",
			cause: "behind",
			reason: `${input.branch} is behind its base and must be rebased before it can merge`,
			...common,
		};
	}

	if (status === "DIRTY") {
		return { permission: "pending", cause: "conflict", reason: `${input.branch} conflicts with its base`, ...common };
	}

	if (status === "DRAFT") {
		return { permission: "pending", cause: "draft", reason: `${input.branch} is a draft PR and is never merged`, ...common };
	}

	if (status === "UNSTABLE") {
		return {
			permission: "pending",
			cause: "unstable",
			reason: bounded(
				`GitHub reports mergeStateStatus=UNSTABLE at ${head12} \u2014 a non-required check may not be passing, and ` +
					"this home cannot read which one (the check-rollup 403s for this token), so it is treated as not permitted",
			),
			...common,
		};
	}

	if (status === "BLOCKED") {
		if (reviewDecision && REVIEW_BLOCKING.has(reviewDecision.toUpperCase())) {
			const count = requiredReviewCount(input.rules);
			return {
				permission: "pending",
				cause: "reviews",
				reason: bounded(
					`GitHub blocks this merge: ${count !== undefined ? `${count} approving review(s)` : "required review(s)"} ` +
						`still required (reviewDecision=${reviewDecision})`,
				),
				...common,
			};
		}
		if (hasRequiredChecksRule(input.rules)) {
			const contexts = requiredCheckContexts(input.rules);
			return {
				permission: "pending",
				cause: "checks",
				reason: bounded(`GitHub blocks this merge: required check(s)${contexts ? ` ${contexts}` : ""} not satisfied for ${head12}`),
				...common,
			};
		}
		return {
			permission: "pending",
			cause: "unknown_block",
			reason: `GitHub reports this merge BLOCKED and this home cannot read why (branch protection is 403 for this token)`,
			...common,
		};
	}

	// Absent, empty, or an unrecognised value: never permission. Field drift or
	// a token scope change must fail closed, not silently widen to "permitted".
	return {
		permission: "unreadable",
		reason: `mergeStateStatus is ${status ? `an unrecognised value (${status})` : "not reported"} for ${head12} \u2014 treated as not permitted`,
		...common,
	};
}

/**
 * `gh api repos/{owner}/{repo}/rules/branches/<base>` \u2014 the effective branch
 * rules, readable in this home (classic `/branches/*\/protection` is not). One
 * non-blocking call, and it is reason-only: `evaluateMergePermission` never
 * reads permission from it, only the cause text a `BLOCKED` verdict carries.
 */
export function ghBranchRulesArgs(base: string): string[] {
	return ["api", `repos/{owner}/{repo}/rules/branches/${base}`];
}

/** Tolerant of gh's field drift and of a 403 body: anything unexpected is `[]`. */
export function parseBranchRules(stdout: string): BranchRule[] {
	const text = stdout.trim();
	if (text.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const rules: BranchRule[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as Record<string, unknown>;
		const type = typeof row.type === "string" ? row.type : undefined;
		if (!type) continue;
		rules.push({
			type,
			...(row.parameters && typeof row.parameters === "object" ? { parameters: row.parameters as Record<string, unknown> } : {}),
		});
	}
	return rules;
}
