/**
 * Native routing S2: passive availability evidence from the SDK message stream (`sdk.d.ts` SDKRateLimitEvent and
 * SDKAssistantMessageError). Only known scalar fields are kept; auth or error text is never read, stored or logged.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** The windows that can block native selection; `overage` is never acted on and `unspecified` is a bare rate_limit. */
export const NATIVE_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "unspecified"] as const;
export type NativeWindow = (typeof NATIVE_WINDOWS)[number];
export const NATIVE_AUTH_CODES = ["authentication_failed", "oauth_org_not_allowed", "account_on_hold"] as const;
export type NativeAuthCode = (typeof NATIVE_AUTH_CODES)[number];
export const WINDOW_STATUSES = ["allowed", "allowed_warning", "rejected"] as const;

/** The run event the worker relays and the parent observer reads. */
export const OBSERVATION_EVENT = "native_observation";

export type NativeObservation =
	| { kind: "window"; window: NativeWindow; status: (typeof WINDOW_STATUSES)[number]; uuid?: string; resets_at?: number; utilization?: number }
	| { kind: "auth"; code: NativeAuthCode }
	| { kind: "lockdown"; code: "lockdown" }
	| { kind: "turn_ok"; family?: ModelFamily };

export type ModelFamily = "opus" | "sonnet";
/** The family a `seven_day_<family>` window binds, from a native model id; none for any other model. */
export const modelFamily = (model: string): ModelFamily | undefined => (/opus/.test(model) ? "opus" : /sonnet/.test(model) ? "sonnet" : undefined);

/** `resetsAt` is epoch seconds (the T3 adapter multiplies by 1000); anything else is no reset at all. */
export function resetMs(resetsAt: unknown): number | undefined {
	return typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt < 1e11 ? Math.round(resetsAt * 1000) : undefined;
}

/** One turn's normalizer: a `rate_limit` error marks "rejected, reset unknown" only when no rejected event named it. */
export function turnObserver(): (message: SDKMessage) => NativeObservation | undefined {
	let rejected = false;
	return (message) => {
		if (message.type === "rate_limit_event") {
			const info = message.rate_limit_info;
			const window = info.rateLimitType ?? "unspecified";
			if (!(NATIVE_WINDOWS as readonly string[]).includes(window) || !(WINDOW_STATUSES as readonly string[]).includes(info.status)) return undefined;
			rejected ||= info.status === "rejected";
			const reset = resetMs(info.resetsAt);
			const utilization = typeof info.utilization === "number" && Number.isFinite(info.utilization) ? info.utilization : undefined;
			return {
				kind: "window", window: window as NativeWindow, status: info.status,
				...(typeof message.uuid === "string" ? { uuid: message.uuid } : {}),
				...(reset === undefined ? {} : { resets_at: reset }), ...(utilization === undefined ? {} : { utilization }),
			};
		}
		if (message.type !== "assistant" || message.error === undefined) return undefined;
		if ((NATIVE_AUTH_CODES as readonly string[]).includes(message.error)) return { kind: "auth", code: message.error as NativeAuthCode };
		return message.error === "rate_limit" && !rejected ? { kind: "window", window: "unspecified", status: "rejected" } : undefined;
	};
}
