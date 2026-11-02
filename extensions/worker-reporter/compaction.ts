import { randomUUID } from "node:crypto";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { WORKER_COMPACTION_POLICY_BLOCK as POLICY_BLOCK } from "../../src/worker-session-policy.ts";

const policyBlocked = (entries: readonly SessionEntry[]) =>
	entries.some((entry) => entry.type === "custom" && entry.customType === POLICY_BLOCK);

export const COMPACTION_OBSERVATION = "worker-compaction-observation";

type Closure = "next_usage" | "superseded" | "session_replaced" | "shutdown";
interface Pending { attempt: string; entryId?: string; fromExtension?: boolean; retainedEstimate?: number | null }

/** picp-jan: keep a rejected transcript out of the summarizer, including after revival. */
export function registerWorkerCompactionGuard(pi: ExtensionAPI): void {
	registerCompactionTelemetry(pi);
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

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const REASONS: readonly string[] = ["manual", "threshold", "overflow"];

/**
 * Passive allowlisted records (numbers, booleans, enums, ids) per compaction attempt; never decides. A success's end
 * waits for the next assistant usage, so nothing lands right after a compaction entry; start without end = died.
 */
function registerCompactionTelemetry(pi: ExtensionAPI): void {
	let pending: Pending | undefined;
	const record = (data: Record<string, unknown>) => pi.appendEntry(COMPACTION_OBSERVATION, { v: 1, ...data });
	const closeSuccess = (closedBy: Closure, next: Record<string, number> | null, nextUnavailable: string | null) => {
		if (!pending) return;
		const { attempt, entryId = null, fromExtension = null, retainedEstimate = null } = pending;
		pending = undefined;
		if (entryId === null) return record({ attempt, phase: "end", outcome: "incomplete", closedBy });
		record({
			attempt, phase: "end", outcome: "compacted", closedBy, entryId, fromExtension,
			retainedEstimate, retainedEstimateUnavailable: retainedEstimate === null ? "sdk_context_unknown" : null,
			nextInput: next, nextInputUnavailable: nextUnavailable,
		});
	};
	pi.on("session_before_compact", (event, ctx) => {
		closeSuccess("superseded", null, "no_next_usage");
		const { enabled, reserveTokens, keepRecentTokens } = event.preparation.settings;
		const contextWindow = finite(ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow);
		const reserve = finite(reserveTokens);
		const threshold = contextWindow !== null && reserve !== null ? contextWindow - reserve : null;
		pending = { attempt: randomUUID() };
		record({
			attempt: pending.attempt, phase: "start", reason: REASONS.includes(event.reason) ? event.reason : "unknown", willRetry: event.willRetry === true,
			tokensBefore: finite(event.preparation.tokensBefore), enabled: enabled === true, reserveTokens: reserve,
			keepRecentTokens: finite(keepRecentTokens), contextWindow, threshold, thresholdRule: "context_tokens_gt_threshold",
			thresholdUnavailable: threshold === null ? "window_or_reserve_unknown" : null,
			settingsSourceUnavailable: "hook_exposes_resolved_values_only",
		});
	});
	pi.on("session_compact", (event, ctx) => {
		if (!pending || pending.entryId) return;
		pending.entryId = event.compactionEntry.id;
		pending.fromExtension = event.fromExtension;
		pending.retainedEstimate = finite(ctx.getContextUsage()?.tokens);
	});
	pi.on("session_compact_failed", (event) => {
		if (!pending || pending.entryId) return;
		const { attempt } = pending;
		pending = undefined;
		record({ attempt, phase: "end", outcome: event.aborted ? "cancelled" : "failed", willRetry: event.willRetry === true });
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		if (!pending?.entryId || message.role !== "assistant") return;
		const usage = message.usage;
		const parts = { input: finite(usage?.input), cacheRead: finite(usage?.cacheRead), cacheWrite: finite(usage?.cacheWrite) };
		const total = (parts.input ?? 0) + (parts.cacheRead ?? 0) + (parts.cacheWrite ?? 0);
		if (message.stopReason === "error" || message.stopReason === "aborted") closeSuccess("next_usage", null, "next_response_failed");
		else if (parts.input === null || total === 0) closeSuccess("next_usage", null, "next_usage_missing");
		else closeSuccess("next_usage", { input: parts.input, cacheRead: parts.cacheRead ?? 0, cacheWrite: parts.cacheWrite ?? 0, total }, null);
	});
	pi.on("session_shutdown", (event) => {
		closeSuccess(event.reason === "quit" || event.reason === "reload" ? "shutdown" : "session_replaced", null, "no_next_usage");
	});
}
