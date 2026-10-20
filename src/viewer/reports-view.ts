/**
 * The Reports page's projection: every published web board, newest first, only the newest revision per job set,
 * then the newest job reports (`state/artifacts/<id>/report.md`, read by job-report.ts).
 *
 * A board is the read-only static page the viewer serves under `/boards/<slug>/`
 * (`boards.ts`). This module only re-shapes `listBoards` and `jobReports`; it writes nothing,
 * so the page stays a pure projection of recorded state.
 */
import { listBoards, type BoardWarn } from "./boards.ts";
import type { ReportItem, ReportsResponse } from "./api-types.ts";
import { jobReports } from "./job-report.ts";
import type { ViewerState } from "./sessions.ts";

/** Newest first, one card per job set: an older board for the same jobs is a superseded revision (cp-xslf, cp-xslf-rev2). A board naming no job is always listed. */
export function reportsView(state: ViewerState, warn: BoardWarn = () => {}, now = Date.now()): ReportsResponse {
	const seen = new Set<string>();
	return {
		generated_at: new Date(now).toISOString(),
		reports: listBoards(state, warn).filter((board) => {
			if (!board.job_ids.length) return true;
			const key = [...board.job_ids].sort().join(" ");
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}).map((board): ReportItem => ({ ...board, href: `/boards/${board.slug}/` })),
		job_reports: jobReports(state),
	};
}
