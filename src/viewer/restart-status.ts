/**
 * Restart session (cp-aqxl), the viewer's pure half: the route path, its window, the one accepted body, and the
 * session's `restart` status as the dashboard shows it. Reads and writes nothing; runs no command.
 */
import type { RestartStatus } from "./api-types.ts";

export const OPERATOR_RESTART_PATH = "/api/operator/restart";
/** At most one restart frame per 60 s per viewer. */
export const OPERATOR_RESTART_WINDOW_MS = 60_000;
export const RESTART_PREDATES = "this session's cp-bridge predates Restart session; restart it once by hand: /quit, then cp-operator -c";

/** Null when the body is exactly `{"restart": true}`, else the refusal. */
export function parseRestartBody(json: unknown): string | null {
	const value = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
	return value && Object.keys(value).length === 1 && value.restart === true ? null : 'body must be exactly {"restart": true}';
}

/** The bridge's `restart` status, validated; absent or malformed is an older bridge: unsupported, with the manual way. */
export function restartStatus(value: unknown): RestartStatus {
	const raw = value !== null && typeof value === "object" ? (value as Partial<Record<keyof RestartStatus, unknown>>) : undefined;
	if (!raw || typeof raw.supported !== "boolean" || !Array.isArray(raw.blockers)) return { supported: false, blockers: [], reason: RESTART_PREDATES };
	const blockers = raw.blockers.filter((line): line is string => typeof line === "string");
	return { supported: raw.supported, blockers, reason: typeof raw.reason === "string" ? raw.reason : null };
}
