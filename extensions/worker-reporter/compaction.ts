import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const POLICY_BLOCK = "worker-compaction-policy-block";
const policyBlocked = (entries: readonly SessionEntry[]) =>
	entries.some((entry) => entry.type === "custom" && entry.customType === POLICY_BLOCK);

/** picp-jan: keep a rejected transcript out of the summarizer, including after revival. */
export function registerWorkerCompactionGuard(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event) => {
		if (policyBlocked(event.branchEntries)) return { cancel: true };
	});
	pi.on("session_compact_failed", (event, ctx) => {
		if (event.aborted || !event.errorMessage || policyBlocked(ctx.sessionManager.getBranch())) return;
		if (!/\b(?:content_filter|content_policy_violation)\b|\b(?:blocked|rejected)\b[^\n]*\b(?:usage polic(?:y|ies)|content polic(?:y|ies)|terms of service|safety)\b/i.test(event.errorMessage)) return;
		// Non-context data: persist the error once without feeding the rejected content back to a model.
		// The active branch owns the guard; a fresh session has no marker, a resumed transcript does.
		pi.appendEntry(POLICY_BLOCK, {
			errorMessage: event.errorMessage,
			reason: event.reason,
			message: "Worker compaction stopped after a provider policy block; this transcript will not be sent to the summarizer again.",
		});
	});
}
