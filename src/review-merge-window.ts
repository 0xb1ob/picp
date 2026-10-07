/** The complete verdict owns the clock; events and restarts never extend it. */
import { REVIEW_MERGE_WINDOW_MS } from "./contracts.ts";
import { readReviewPassVerdict, shaMatches } from "./merge-ask.ts";

export interface ReviewMergeWindow {
	head_sha: string;
	attempt: number;
	decided_at: string;
	review_resume_at: string;
}

export function readReviewMergeWindow(home: string, jobId: string, head: string, now = new Date()): ReviewMergeWindow | undefined {
	const pass = readReviewPassVerdict(home, jobId, head);
	if (!pass || !shaMatches(pass.head_sha, head)) return undefined;
	const deadline = Date.parse(pass.decided_at) + REVIEW_MERGE_WINDOW_MS;
	if (now.getTime() >= deadline) return undefined;
	return { head_sha: head, attempt: pass.attempt, decided_at: pass.decided_at, review_resume_at: new Date(deadline).toISOString() };
}
