/** N2: a withheld `cp-verdict` keeps its review findings; its verdict and next step stay withheld. */
import { withProjectTag } from "./project-report.ts";
import type { WakeupCarrier, WakeupStamp } from "./wakeups.ts";

/** `details` flag on the findings stand-in: the one rewritten wake-up the parent's context hook keeps. */
export const WITHHELD_FINDINGS_KEY = "cp_withheld_findings";

/**
 * A fixed stand-in for a superseded verdict that carried reasons, else undefined. Built only from the message
 * itself, so every later request sees the same bytes; it never repeats the verdict, its directive or `next`.
 */
export function withheldVerdictFindings<T extends WakeupCarrier>(stamp: WakeupStamp, message: T): T | undefined {
	if (stamp.kind !== "verdict") return undefined;
	const details = message.details && typeof message.details === "object" ? (message.details as Record<string, unknown>) : {};
	const reasons = (details.verdict as { reasons?: unknown } | undefined)?.reasons;
	if (!Array.isArray(reasons) || reasons.length === 0) return undefined;
	const review = stamp.keys && stamp.keys.length >= 2 ? ` (${stamp.keys[0]} attempt ${stamp.keys[1]})` : "";
	const lines = [
		`WITHHELD VERDICT${stamp.job_id ? ` for ${stamp.job_id}` : ""}${review}: superseded before you read it.`,
		"Its verdict and next step are withheld; do not act on them. Its review findings, to relay only:",
		...reasons.map((reason) => `  - ${String(reason)}`),
	];
	const content = stamp.projects && stamp.projects.length > 0 ? withProjectTag(stamp.projects, lines.join("\n")) : lines.join("\n");
	return { ...message, content, details: { ...details, [WITHHELD_FINDINGS_KEY]: true } };
}

/** True for the findings stand-in `withheldVerdictFindings` built. */
export function isWithheldFindings(message: unknown): boolean {
	const details = (message as { details?: unknown } | null)?.details;
	return !!details && typeof details === "object" && (details as Record<string, unknown>)[WITHHELD_FINDINGS_KEY] === true;
}
