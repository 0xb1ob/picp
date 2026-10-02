/**
 * "Does this repository have CI at all?" — established **positively**, never
 * inferred from an absence (cp-no-ci-repo-derived).
 *
 * Operator directive, 2026-09-07: *"if a given project has no CI checks, do NOT
 * require human approval, just merge."* Before it, `cp_integrate` treated one
 * condition — zero observable runs for the branch — as the trigger for a
 * per-head human merge authorization. That condition conflates two materially
 * different states:
 *
 *  - **(a) the repository has no CI configured.** No workflow exists, so nothing
 *    will ever run on any head. Asking a human per head is pure friction, and it
 *    really happened (example-bot PRs #6 and #7 each spent an
 *    authorization on a repo with no CI at all).
 *  - **(b) CI could not be read.** `gh` 403'd, the token lacks scope, the
 *    network failed. Runs may exist, and they may be **red**.
 *
 * "Zero runs returned" is exactly what (b) also looks like, so it can never be
 * the test for (a). This module asks the repository what workflows it *has*
 * (`gh api repos/{owner}/{repo}/actions/workflows`) and only reports `none` for
 * an answer that parsed, came from a command that succeeded, and said zero. Every
 * other outcome is `unreadable`, which every caller must treat exactly as it
 * treated (b) before: an unreadable signal is never permission.
 *
 * The four outcomes the directive names are four distinct causes here, not one:
 * a 403 (`unauthorized`), a network or other command failure (`command_failed`),
 * an empty stdout from a failed command (`failed_silently`), and a genuine empty
 * workflow list (`authoritative_empty`). Two more exist for completeness: a
 * command that *succeeded* and printed nothing (`empty_output`) and one whose
 * output is not the JSON this endpoint documents (`unparsable`). Only
 * `authoritative_empty` ever yields `none`.
 *
 * ## What the probe can see: GitHub Actions, and nothing else
 *
 * The endpoint is `repos/{owner}/{repo}/actions/workflows`, so `none` means
 * **no Actions workflows**, which is not the same claim as "no CI anywhere". A
 * repository whose CI is an external provider (CircleCI, Jenkins, Buildkite,
 * any commit-status poster) has zero Actions workflows and is classified
 * `none`.
 *
 * Branch protection covers the required-check case: an external status that is
 * *required* and has not been posted leaves `mergeStateStatus` non-CLEAN, so
 * `evaluateMergePermission` reports `pending` and nothing merges. The residual
 * case is a **non-required** external check still in flight: GitHub can report
 * CLEAN while it runs, and this home merges without that signal.
 */

/** `none` is the only state that may relax anything; everything else is (b). */
export type CiConfiguredState = "none" | "present" | "unreadable";

export type CiConfiguredCause =
	/** The endpoint answered, and it answered zero. This is (a), positively. */
	| "authoritative_empty"
	/** The endpoint answered, and the repository has workflows. */
	| "workflows_present"
	/** HTTP 401/403: the token cannot see this repository's workflows. */
	| "unauthorized"
	/** A non-zero exit with a diagnostic — DNS, TLS, rate limit, gh not installed. */
	| "command_failed"
	/** A non-zero exit that printed nothing at all on either stream. */
	| "failed_silently"
	/** Exit 0 with no stdout: success is not an answer, and silence is not zero. */
	| "empty_output"
	/** Output that is not the documented `{total_count, workflows[]}` shape. */
	| "unparsable";

export interface CiConfiguredVerdict {
	state: CiConfiguredState;
	cause: CiConfiguredCause;
	/** One bounded, operator-facing line naming the evidence. */
	reason: string;
	/** Present only when the endpoint answered: how many workflows it named. */
	workflow_count?: number;
}

/**
 * The one query, spelled out in one place. `{owner}/{repo}` is `gh api`'s own
 * placeholder syntax, resolved from the cwd's remote — the same trick
 * `ghBranchRulesArgs` uses, so no caller has to parse a remote url.
 */
export function ghWorkflowsArgs(): string[] {
	return ["api", "repos/{owner}/{repo}/actions/workflows"];
}

const REASON_MAX_CHARS = 300;
/** `gh` prints `HTTP 403` / `HTTP 401` for exactly the case that must stay (b). */
const UNAUTHORIZED = /\bHTTP (401|403)\b|\bmust have admin\b|\bnot accessible by integration\b/i;

function bounded(reason: string): string {
	return reason.length <= REASON_MAX_CHARS ? reason : `${reason.slice(0, REASON_MAX_CHARS - 1)}\u2026`;
}

function firstLine(text: string): string {
	return (text.trim().split("\n")[0] ?? "").trim();
}

/**
 * The whole rule, as a pure function over one command result. Fail-closed by
 * construction: `none` is returned on exactly one path, and every `return`
 * before it is `unreadable` or `present`.
 */
export function readCiConfigured(result: { status: number | null; stdout: string; stderr: string }): CiConfiguredVerdict {
	const diagnostic = firstLine(result.stderr) || firstLine(result.stdout);
	if (result.status !== 0) {
		if (UNAUTHORIZED.test(`${result.stderr}\n${result.stdout}`)) {
			return {
				state: "unreadable",
				cause: "unauthorized",
				reason: bounded(`gh cannot read this repository's workflows (${diagnostic || "HTTP 401/403"}) \u2014 CI state is unknown, not absent`),
			};
		}
		if (diagnostic.length === 0) {
			return {
				state: "unreadable",
				cause: "failed_silently",
				reason: `gh exited ${result.status ?? "on a signal"} with no output when asked for this repository's workflows \u2014 CI state is unknown, not absent`,
			};
		}
		return {
			state: "unreadable",
			cause: "command_failed",
			reason: bounded(`could not ask this repository for its workflows (${diagnostic}) \u2014 CI state is unknown, not absent`),
		};
	}
	if (result.stdout.trim().length === 0) {
		return {
			state: "unreadable",
			cause: "empty_output",
			reason: "gh succeeded but printed nothing when asked for this repository's workflows \u2014 silence is not an authoritative zero",
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		return {
			state: "unreadable",
			cause: "unparsable",
			reason: bounded(`the workflows endpoint returned output this home cannot parse (${(error as Error).message})`),
		};
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { state: "unreadable", cause: "unparsable", reason: "the workflows endpoint returned no object" };
	}
	const { total_count: total, workflows } = parsed as { total_count?: unknown; workflows?: unknown };
	if (!Array.isArray(workflows) || typeof total !== "number" || !Number.isFinite(total)) {
		return {
			state: "unreadable",
			cause: "unparsable",
			reason: "the workflows endpoint answered without a numeric total_count and a workflows array",
		};
	}
	// Both fields must agree on zero. A truncated page (`total_count: 3` with an
	// empty first page) is not an authoritative empty list.
	if (total === 0 && workflows.length === 0) {
		return {
			state: "none",
			cause: "authoritative_empty",
			reason: "the repository's own workflows endpoint reports 0 workflows \u2014 no CI will ever run on any head",
			workflow_count: 0,
		};
	}
	return {
		state: "present",
		cause: "workflows_present",
		reason: `the repository has ${total} workflow(s) configured`,
		workflow_count: total,
	};
}

/**
 * The same question against a runner that *throws* on failure (the shape
 * `src/merge-ask.ts` uses on the render path). A throw is (b): the message
 * carries `gh`'s stderr, so a 403 is still classified as `unauthorized`.
 */
export function ghCiConfigured(options: {
	cwd: string;
	exec: (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<string>;
	timeoutMs: number;
}): () => Promise<CiConfiguredVerdict> {
	return async () => {
		try {
			const stdout = await options.exec("gh", ghWorkflowsArgs(), { cwd: options.cwd, timeoutMs: options.timeoutMs });
			return readCiConfigured({ status: 0, stdout, stderr: "" });
		} catch (error) {
			return readCiConfigured({ status: 1, stdout: "", stderr: (error as Error).message });
		}
	};
}
