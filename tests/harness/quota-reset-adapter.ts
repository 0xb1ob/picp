/**
 * Test-only quota-reset fixture and decoder for the mock provider (P3 Milestone 1).
 * Product code must never import this: no real provider declares a reset capability, and only an e2e test
 * that passes this object explicitly can read a reset time off the mock's terminal error.
 */

import { MOCK_PROVIDER_ID, type MockProvider, type ScriptStep } from "./mock-provider.ts";

/** Synthetic, sanitized category: no real provider body, account or plan is reproduced. */
export const QUOTA_RESET_CATEGORY = "usage_limit_reached";
export const QUOTA_RESET_SCOPE = "account";

/** A usage-limit 429 naming an absolute reset instant in epoch seconds (UTC basis, provider clock). */
export function quotaResetError(resetsAt: Date, repeat = 1): ScriptStep {
	return {
		kind: "error",
		status: 429,
		type: QUOTA_RESET_CATEGORY,
		message: "You have reached your usage limit for this window.",
		repeat,
		fields: { scope: QUOTA_RESET_SCOPE, resets_at: Math.floor(resetsAt.getTime() / 1000) },
	};
}

export interface QuotaResetSignal {
	provider: string;
	model: string;
	status: number;
	category: string;
	scope: string;
	/** Absolute reset instant, epoch seconds; never a relative delay. */
	resetsAtEpochSeconds: number;
	resetsAtUtc: string;
}

/** The reset signal on one terminal assistant message, only for a model this mock instance served. */
export function decodeMockQuotaReset(provider: MockProvider, message: unknown): QuotaResetSignal | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const m = message as Record<string, unknown>;
	if (m.role !== "assistant" || m.stopReason !== "error" || m.api !== "openai-completions") return undefined;
	if (m.provider !== MOCK_PROVIDER_ID || typeof m.model !== "string" || !m.model.startsWith("script-")) return undefined;
	if (provider.requests(m.model.slice("script-".length)).length === 0) return undefined;
	const match = typeof m.errorMessage === "string" ? /^(\d{3}): (\{[\s\S]*\})$/.exec(m.errorMessage) : null;
	if (!match) return undefined;
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(match[2] as string) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const resetsAt = body.resets_at;
	if (body.type !== QUOTA_RESET_CATEGORY || typeof body.scope !== "string" || body.scope === "") return undefined;
	if (typeof resetsAt !== "number" || !Number.isSafeInteger(resetsAt) || resetsAt <= 0) return undefined;
	return {
		provider: m.provider,
		model: m.model,
		status: Number(match[1]),
		category: body.type,
		scope: body.scope,
		resetsAtEpochSeconds: resetsAt,
		resetsAtUtc: new Date(resetsAt * 1000).toISOString(),
	};
}
