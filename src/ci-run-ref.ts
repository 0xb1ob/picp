/**
 * The source of a red CI fact (picp-wzq): which run failed on the head, and where to read it.
 * One rule for "the failing run", the same one `evaluateMergeAskCi` refuses on — a completed run
 * on that exact head whose conclusion is not green — so a `skipped` run is never blamed. The run
 * URL is derived from the PR URL (`https://github.com/<owner>/<repo>/pull/<n>`), so no extra query
 * and no change to the pinned `gh run list` fields; any other PR URL shape gives the id alone.
 */
import { type CiRun, GREEN_CONCLUSIONS, shaMatches } from "./merge-ask.ts";

export interface CiRunRef {
	run_id?: number;
	run_url?: string;
}

/** The first completed run on `head` whose conclusion is not green, or `undefined`. */
export function failedRunOn(runs: readonly CiRun[], head: string | undefined): CiRun | undefined {
	return runs.find((run) => shaMatches(run.headSha, head) && run.status === "completed" && !GREEN_CONCLUSIONS.has((run.conclusion ?? "").toLowerCase()));
}

/** The Actions URL of run `id` in the PR's repository, or `undefined` for a PR URL that is not github.com's. */
export function runUrl(prUrl: string | undefined, id: number): string | undefined {
	const repo = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(prUrl ?? "")?.[1];
	return repo ? `${repo}/actions/runs/${id}` : undefined;
}

/** The failing run's id and URL; empty when there is no failing run or it carries no `databaseId`. */
export function ciRunRef(runs: readonly CiRun[], head: string | undefined, prUrl: string | undefined): CiRunRef {
	const id = failedRunOn(runs, head)?.databaseId;
	if (id === undefined) return {};
	const url = runUrl(prUrl, id);
	return { run_id: id, ...(url ? { run_url: url } : {}) };
}

/** `""`, or ` (run <id>[ <url>])` to append to a CI fact. */
export function formatRunRef(ref: CiRunRef): string {
	return ref.run_id === undefined ? "" : ` (run ${ref.run_id}${ref.run_url ? ` ${ref.run_url}` : ""})`;
}

/** One bounded line naming a red fact's failing tests (src/ci-watch.ts reads them), or why none are named. */
export function failingTestsLine(fact: { failing_tests?: readonly string[]; failing_tests_unread?: string }): string {
	const tests = fact.failing_tests ?? [];
	if (tests.length === 0) return `failing tests: none named — ${fact.failing_tests_unread ?? "the failed log lists no failing test (a non-test step failed, or the log is cut)"}`;
	const shown = tests.slice(0, 10).join("; ");
	return `failing tests (${tests.length}): ${shown.length > 400 ? `${shown.slice(0, 400)}…` : shown}${tests.length > 10 ? `; +${tests.length - 10} more` : ""}`;
}
