import { type ProjectOf, projectGroupedLines } from "./project-report.ts";

export interface RecoveryCandidate {
	job_id: string;
	outcome: string;
	detail: string;
	resumable: boolean;
}

/** Under the 4000-char durable wake-up content bound. */
const RECOVERY_NOTICE_MAX_CHARS = 3900;

/** One restart-recovery notice; past the bound it lists a prefix of the candidates, then "...and N more". */
export function formatRecoveryNotice(candidates: readonly RecoveryCandidate[], projectOf?: ProjectOf): string {
	const row = (candidate: RecoveryCandidate) => `  ${candidate.job_id} ${candidate.outcome}${candidate.resumable ? " (resumable)" : ""}: ${candidate.detail}`;
	const render = (shown: readonly RecoveryCandidate[]): string => {
		const lines = [`RESTART RECOVERY — ${candidates.length} candidate(s)`];
		lines.push(...projectGroupedLines(shown, projectOf && ((candidate) => projectOf(candidate.job_id)), row));
		if (shown.length < candidates.length) lines.push(`  ...and ${candidates.length - shown.length} more (see /status, cp_revive / cp_teardown per job)`);
		const revive = shown.filter((candidate) => candidate.resumable).map((candidate) => candidate.job_id);
		const tear = shown.filter((candidate) => !candidate.resumable).map((candidate) => candidate.job_id);
		const next: string[] = [];
		if (revive.length > 0) next.push(`cp_revive ${revive.join(", ")}`);
		if (tear.length > 0) next.push(`cp_teardown ${tear.join(", ")}`);
		lines.push(`  next: ${next.join(" or ") || "cp_teardown the listed jobs"}.`);
		return lines.join("\n");
	};
	let shown = candidates.length;
	let text = render(candidates);
	while (text.length > RECOVERY_NOTICE_MAX_CHARS && shown > 1) {
		shown = Math.max(1, Math.min(shown - 1, Math.floor(shown * (RECOVERY_NOTICE_MAX_CHARS / text.length))));
		text = render(candidates.slice(0, shown));
	}
	return text.slice(0, RECOVERY_NOTICE_MAX_CHARS);
}
