import { type DiffVerdict, REVIEW_MAX_ATTEMPTS } from "./contracts.ts";

/**
 * The reviewer's own uncapped copy inside its run dir. Mirrors
 * `VERDICT_RAW_FILE` in `extensions/worker-reporter/index.ts` (src never imports
 * an extension); a test pins the two equal.
 */
export const REVIEWER_RAW_FILE = "verdict-raw.json";

/**
 * The promote text: the reviewer's revisions, verbatim and bounded. `rawPaths`
 * names the uncapped copies on disk, so a cut list is never the only copy the
 * implementer can reach.
 */
export function diffReviseMessage(verdict: DiffVerdict, rawPaths: readonly string[] = []): string {
	const remaining = Math.max(REVIEW_MAX_ATTEMPTS - verdict.attempt, 0);
	const lines = [
		`Diff review of ${verdict.job_id} at ${verdict.head_sha.slice(0, 12)} (attempt ${verdict.attempt}): revise.`,
		"",
		"Revisions required:",
		...(verdict.revisions ?? []).map((revision) => `- ${revision}`),
		"",
		"Reasons given:",
		...verdict.reasons.map((reason) => `- ${reason}`),
		"",
		...(rawPaths.length > 0
			? [
					"Uncapped reviewer feedback (read before fixing; the lists above may be cut):",
					...rawPaths.map((path) => `- ${path}`),
					"",
				]
			: []),
		`Fix this on the same branch (${verdict.job_id}) with one more commit and push it — never a second PR, never a new`,
		"branch. Run the project's checks before you push; then reply here with one line naming what you changed.",
		"Only a changed head commit can be re-reviewed. Your envelope slot was reopened when this promote was delivered,",
		"so if the fix changes what your envelope said you may call report_result once more and it will be accepted.",
		`This was review ${verdict.attempt} of ${REVIEW_MAX_ATTEMPTS} on this branch: the pushed fix is reviewed again, ` +
			`and ${remaining === 1 ? "1 review remains" : `${remaining} reviews remain`} before remaining findings go to the ` +
			"operator instead of back to you. Fix everything named above in this one commit.",
	];
	return lines.join("\n");
}
