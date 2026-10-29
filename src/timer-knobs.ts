/** Per-home env overrides for the delivery-retry, suppression and merge-window timers (milliseconds). */
import {
	CI_WATCH_DELIVERY_RETRY_SECONDS,
	PLAN_VIEW_IDLE_TIMEOUT_MS,
	REVIEW_MERGE_WINDOW_MS,
	VERDICT_DELIVERY_RETRY_SECONDS,
	VERDICT_SUPPRESSED_RETRY_MAX_SECONDS,
} from "./contracts.ts";

/** A positive finite number of seconds, else the default: a typo must not zero a timer. */
export function knobMs(name: string, defaultMs: number, env: NodeJS.ProcessEnv): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return defaultMs;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
	return Math.max(1, Math.floor(parsed * 1000));
}

/** `CP_VERDICT_DELIVERY_RETRY_SECONDS` (default 120). */
export function verdictDeliveryRetryMs(env: NodeJS.ProcessEnv = process.env): number {
	return knobMs("CP_VERDICT_DELIVERY_RETRY_SECONDS", VERDICT_DELIVERY_RETRY_SECONDS * 1000, env);
}

/** `CP_CI_WATCH_DELIVERY_RETRY_SECONDS` (default 120). */
export function ciWatchDeliveryRetryMs(env: NodeJS.ProcessEnv = process.env): number {
	return knobMs("CP_CI_WATCH_DELIVERY_RETRY_SECONDS", CI_WATCH_DELIVERY_RETRY_SECONDS * 1000, env);
}

/** `CP_REVIEW_SUPPRESSION_SECONDS` (default 1200): how long a withheld verdict stays eligible. */
export function reviewSuppressionMs(env: NodeJS.ProcessEnv = process.env): number {
	return knobMs("CP_REVIEW_SUPPRESSION_SECONDS", VERDICT_SUPPRESSED_RETRY_MAX_SECONDS * 1000, env);
}

/** `CP_REVIEW_MERGE_WINDOW_SECONDS` (default 30). */
export function reviewMergeWindowMs(env: NodeJS.ProcessEnv = process.env): number {
	return knobMs("CP_REVIEW_MERGE_WINDOW_SECONDS", REVIEW_MERGE_WINDOW_MS, env);
}

/** `CP_PLAN_VIEW_IDLE_SECONDS` (default 600): how long an untouched `/cp-plan` pager stays open. */
export function planViewIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return knobMs("CP_PLAN_VIEW_IDLE_SECONDS", PLAN_VIEW_IDLE_TIMEOUT_MS, env);
}
