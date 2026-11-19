/**
 * C3: Codex usage-limit evidence from a run's own notifications, never an extra request. The merge and reset rules
 * follow T3's `codexUsageLimits.ts` at the pin (`mergeCodexRateLimits`, `codexUsageLimitResetAt`); the code is picp's.
 */
import { resetMs } from "./claude-observation.ts";
import type { RateLimitWindow, TokenUsageBreakdown } from "./codex-protocol.ts";

/** The one `codexErrorInfo` that is the usage limit (Q2): a rate limit or a 429 exhaustion stays an unclean end. */
export const USAGE_LIMIT = "usageLimitExceeded";

export interface CodexRateLimits { rateLimitReachedType?: string; primary?: RateLimitWindow; secondary?: RateLimitWindow }

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const code = (value: unknown): string | undefined => (typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined);

function window(value: unknown): RateLimitWindow | undefined {
	const w = record(value);
	if (typeof w?.usedPercent !== "number") return undefined;
	return { usedPercent: w.usedPercent, ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt } : {}) };
}

/** The main allowance after `update`: another `limitId` never replaces it, and a null never clears an earlier value. */
export function mergeCodexRateLimits(previous: CodexRateLimits | undefined, update: unknown): CodexRateLimits | undefined {
	const u = record(update);
	if (u === undefined || (typeof u.limitId === "string" && u.limitId !== "codex")) return previous;
	const reached = (typeof u.rateLimitReachedType === "string" ? u.rateLimitReachedType : undefined) ?? previous?.rateLimitReachedType;
	const primary = window(u.primary) ?? previous?.primary;
	const secondary = window(u.secondary) ?? previous?.secondary;
	return { ...(reached === undefined ? {} : { rateLimitReachedType: reached }), ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
}

/** A `codexErrorInfo` as a code (a string, or a one-key object's key); never the CLI's message text. */
export function codexErrorCode(info: unknown): string | undefined {
	if (info === undefined || info === null) return undefined;
	const keys = record(info) === undefined ? [] : Object.keys(info as object);
	return code(typeof info === "string" ? info : keys.length === 1 ? keys[0] : undefined) ?? "other";
}

/** A run's limit: a turn failed on the usage limit, or a reached type; the reset is the latest spent window's. */
export function codexLimit(result: { turnStatus?: string; codexErrorInfo?: unknown; rateLimits?: CodexRateLimits }): { reached: string; resets_at?: number } | undefined {
	const spent = result.turnStatus === "failed" && codexErrorCode(result.codexErrorInfo) === USAGE_LIMIT;
	const reached = spent ? USAGE_LIMIT : result.rateLimits?.rateLimitReachedType === undefined ? undefined : (code(result.rateLimits.rateLimitReachedType) ?? "other");
	if (reached === undefined) return undefined;
	const full = [result.rateLimits?.primary, result.rateLimits?.secondary].filter((w): w is RateLimitWindow => Number.isFinite(w?.usedPercent) && w!.usedPercent >= 100);
	const resets = full.map((w) => resetMs(w.resetsAt));
	if (resets.length === 0 || resets.some((each) => each === undefined)) return { reached };
	return { reached, resets_at: Math.max(...(resets as number[])) };
}

export type CodexTokenTotals = Required<TokenUsageBreakdown>;
export type CodexRunUsage =
	| { status: "complete"; input: number; cache_read: number; cache_write: number; output: number; reasoning: number; total: number; cost_unknown: true }
	| { status: "unavailable"; reason: string; cost_unknown: true };

export const ZERO_TOTALS: CodexTokenTotals = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
export const codexTotals = (b: TokenUsageBreakdown): CodexTokenTotals => ({ ...b, cacheWriteInputTokens: b.cacheWriteInputTokens ?? 0 });

/** One run's usage: the latest cumulative total minus its baseline. Unknown is `unavailable`, never 0 (D3: no USD). */
export function codexRunUsage(baseline: CodexTokenTotals | undefined, latest: CodexTokenTotals | undefined): CodexRunUsage {
	if (baseline === undefined) return { status: "unavailable", reason: "no baseline for the resumed thread", cost_unknown: true };
	if (latest === undefined) return { status: "unavailable", reason: "the CLI sent no token usage", cost_unknown: true };
	const d = Object.fromEntries(Object.keys(ZERO_TOTALS).map((k) => [k, latest[k as keyof CodexTokenTotals] - baseline[k as keyof CodexTokenTotals]])) as CodexTokenTotals;
	if (Object.values(d).some((n) => n < 0)) return { status: "unavailable", reason: "the totals went backwards", cost_unknown: true };
	return {
		status: "complete", input: d.inputTokens - d.cachedInputTokens, cache_read: d.cachedInputTokens, cache_write: d.cacheWriteInputTokens,
		output: d.outputTokens, reasoning: d.reasoningOutputTokens, total: d.totalTokens, cost_unknown: true,
	};
}
