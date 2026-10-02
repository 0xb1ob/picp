/**
 * `DoctorFindingSchema`'s own bounds, mirrored here because
 * `validateDoctorReport` **refuses** a report that breaks them: a long home
 * path, a long project name or a big rubric must produce a long finding, never
 * a crashed diagnosis. Shared by `doctor.ts` and the modules whose findings
 * join its report (src/service/status.ts), so none of them can bypass the cap.
 */
import type { DoctorFinding } from "./contracts.ts";

export const WHAT_MAX = 200;
export const DETAIL_MAX = 2000;
export const FIX_MAX = 500;
export const CHECK_MAX = 64;

/** A `check` that stays inside the contract: project names run to 64 chars on their own. */
export function cappedCheck(check: string): string {
	return check.length <= CHECK_MAX ? check : check.slice(0, CHECK_MAX);
}

/** A `fix` that stays inside the contract; the advice leads, so the tail is what goes. */
export function cappedFix(fix: string): string {
	return fix.length <= FIX_MAX ? fix : `${fix.slice(0, FIX_MAX - 3)}...`;
}

export function cappedWhat(text: string, detail?: string): { what: string; detail?: string } {
	if (text.length <= WHAT_MAX) return detail === undefined ? { what: text } : { what: text, detail };
	const full = detail === undefined ? text : `${text}\n${detail}`;
	return { what: `${text.slice(0, WHAT_MAX - 3)}...`, detail: full.slice(0, DETAIL_MAX) };
}

/** One whole finding held inside the contract: an over-long `what` overflows into `detail`, as `cappedWhat` does. */
export function cappedFinding(finding: DoctorFinding): DoctorFinding {
	const { what, detail } = cappedWhat(finding.what, finding.detail);
	return {
		...finding,
		check: cappedCheck(finding.check),
		what,
		...(detail === undefined ? {} : { detail: detail.slice(0, DETAIL_MAX) }),
		...(finding.fix === undefined ? {} : { fix: cappedFix(finding.fix) }),
	};
}
