/**
 * Restart session (cp-aqxl), the viewer's pure half: the route path, its window, the one accepted body, and the
 * session's `restart` status as the dashboard shows it. Reads and writes nothing; runs no command.
 */
import type { ParentRestartStatus, RestartStatus } from "./api-types.ts";

export const OPERATOR_RESTART_PATH = "/api/operator/restart";
/** At most one accepted restart per 60 s per viewer (a refused frame frees the window). */
export const OPERATOR_RESTART_WINDOW_MS = 60_000;
export const RESTART_PREDATES = "this session's cp-bridge predates Restart session; restart it once by hand: /quit, then cp-operator -c";

/** Null when the body is exactly `{"restart": true}` or `{"restart": true, "fresh": true}`, else the refusal. */
export function parseRestartBody(json: unknown): string | null {
	const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
	const keys = value ? Object.keys(value).length : 0;
	const ok = value?.restart === true && (keys === 1 || (keys === 2 && value.fresh === true));
	return ok ? null : 'body must be exactly {"restart": true} or {"restart": true, "fresh": true}';
}

/** The bridge's `restart` status, validated; absent or malformed is an older bridge: unsupported, with the manual way. */
export function restartStatus(value: unknown): RestartStatus {
	const raw = value !== null && typeof value === "object" ? (value as Partial<Record<keyof RestartStatus, unknown>>) : undefined;
	if (!raw || typeof raw.supported !== "boolean" || !Array.isArray(raw.blockers)) return { supported: false, blockers: [], reason: RESTART_PREDATES };
	const blockers = raw.blockers.filter((line): line is string => typeof line === "string");
	return { supported: raw.supported, blockers, reason: typeof raw.reason === "string" ? raw.reason : null };
}

export const PARENT_RESTART_PATH = "/api/parent/restart";
export const PARENT_RESTART_PREDATES = "this operator session's cp-bridge predates parent restart; restart the operator session once";

/** The mode when the body is exactly `{"restart": "resume"}` or `{"restart": "clean"}`, else null. */
export function parseParentRestartBody(json: unknown): "resume" | "clean" | null {
	const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
	return value && Object.keys(value).length === 1 && (value.restart === "resume" || value.restart === "clean") ? value.restart : null;
}

/** The bridge's `parent_restart` status, validated; absent or malformed (an older bridge) is undefined. */
export function parentRestartStatus(value: unknown): ParentRestartStatus | undefined {
	const raw = value !== null && typeof value === "object" ? (value as Partial<Record<keyof ParentRestartStatus, unknown>>) : undefined;
	if (!raw || typeof raw.safe !== "boolean" || typeof raw.reason !== "string") return undefined;
	return { safe: raw.safe, reason: raw.reason, last: typeof raw.last === "string" ? raw.last : null };
}
