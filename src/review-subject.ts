/**
 * What counts as diff-review evidence (reviewable-diff boundaries).
 *
 * A reviewer that saw only part of a diff has judged nothing about the rest:
 * an omitted path is diagnostic evidence, never a scoreable partial subject.
 * Every reader that turns a persisted verdict into permission (merge asks,
 * `cp_integrate`, teardown, pipeline replay, patch-id equivalence, delta base)
 * asks this module, so the rule has one definition.
 */
import { DIFF_REVIEW_MAX_BYTES, type DiffVerdict } from "./contracts.ts";

/** A pass counts only when its reviewer saw the whole subject. */
export function isCompletePass(verdict: DiffVerdict): boolean {
	return verdict.verdict === "pass" && verdict.diff_stat.truncated === false;
}

/** The orchestrator's `escalate`/`policy` reasons for a subject no reviewer may score. */
export function incompleteSubjectReasons(
	subject: { ok: true; files: number; omitted: readonly string[] } | { ok: false; files: number; cap: number },
): string[] {
	if (!subject.ok) {
		return [
			`diff spans ${subject.files} file(s), over the ${subject.cap}-file review cap ` +
				"(DIFF_REVIEW_MAX_STAT_FILES) — no reviewer was spawned and no diff was materialized",
			"split the job, or review it by hand: a diff this wide cannot be scored in one fresh-context pass",
		];
	}
	return [
		`diff omits ${subject.omitted.length} of ${subject.files} file(s) over the ${DIFF_REVIEW_MAX_BYTES}-byte ` +
			"review cap (DIFF_REVIEW_MAX_BYTES) — no reviewer was spawned: a partial diff is never scored",
		"stage it: code and tests in one PR, generated data in ordered follow-ups, each head reviewed in full",
		...subject.omitted.map((path) => `omitted: ${path}`.slice(0, 400)),
	];
}
