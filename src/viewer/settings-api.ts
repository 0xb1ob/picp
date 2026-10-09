/**
 * Settings over the dashboard (cp-7bsr PR2). `GET /api/settings` reads the snapshot, the catalog and the audit tail
 * through the operator session's control socket; `POST /api/settings/apply` and `POST /api/settings/restore` forward
 * one `settings_apply` frame there. The operator session validates, audits and writes the owner files
 * (src/settings-control.ts → src/settings-write.ts); this module writes nothing and imports no audit writer: an
 * operator-configuration change, never a decision, grant or authorization.
 *
 * Refusal order: the shared chain (`guarded`: method, --require-tailnet, rate, opt-out, Origin, Sec-Fetch-Site, JSON,
 * size), then the body shape (400), `If-Match` (required unless `dry_run`: missing 428, malformed 400), a live session
 * (409 `offline`), its CSRF token (403), then the frame. Each refusal here is one `refused` line (kind `settings`)
 * through `guarded`'s refuse; the session's own outcomes pass through with their status and its audit is the record.
 */
import type { IncomingMessage } from "node:http";
import type { SettingsResponse, SettingsWriteResponse } from "./api-types.ts";
import { type ControlRouteOptions, type ControlRouteResult, controlRequest, guarded, tokenMatches } from "./control-api.ts";
import { readControlConfig, readControlRecord } from "./control-files.ts";
import { operatorSession } from "./control-inbox.ts";
import { availableModels, type ModelList } from "./model-list.ts";

export const SETTINGS_PATH = "/api/settings";
export const SETTINGS_APPLY_PATH = "/api/settings/apply";
export const SETTINGS_RESTORE_PATH = "/api/settings/restore";

const SETTINGS_PREDATE = "the running operator session predates Settings; restart the operator session to load Settings";
const PASS_THROUGH = new Set([200, 400, 403, 409, 412, 500, 503]);
const REVISION_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

type Frame = { mode: "set"; changes: Record<string, unknown> } | { mode: "restore"; keys: string[] } | { mode: "restore"; section: string } | { mode: "restore"; all: true };

/** The body, exactly: `{changes, request_id, dry_run?}` to apply; one of `{keys}` / `{section}` / `{all:true}` plus the same to restore. */
export function parseSettingsBody(json: unknown, mode: "set" | "restore"): { ok: true; frame: Frame; request_id: string; dry_run: boolean } | { ok: false; reason: string } {
	if (!isObject(json)) return { ok: false, reason: "body must be a JSON object" };
	const allowed = mode === "set" ? ["changes", "request_id", "dry_run"] : ["keys", "section", "all", "request_id", "dry_run"];
	const extra = Object.keys(json).filter((key) => !allowed.includes(key));
	if (extra.length) return { ok: false, reason: `unknown field ${extra.join(", ")}` };
	if (typeof json.request_id !== "string" || !REQUEST_ID_RE.test(json.request_id)) return { ok: false, reason: "request_id must be 8-64 of [A-Za-z0-9_-]" };
	if (json.dry_run !== undefined && typeof json.dry_run !== "boolean") return { ok: false, reason: "dry_run must be a boolean" };
	const base = { request_id: json.request_id, dry_run: json.dry_run === true };
	if (mode === "set") {
		if (!isObject(json.changes) || !Object.keys(json.changes).length) return { ok: false, reason: "changes must be an object naming at least one setting key" };
		return { ok: true, frame: { mode, changes: json.changes }, ...base };
	}
	const selectors = ["keys", "section", "all"].filter((key) => json[key] !== undefined);
	if (selectors.length !== 1) return { ok: false, reason: "restore takes exactly one of keys, section or all" };
	if (json.keys !== undefined) {
		if (!Array.isArray(json.keys) || !json.keys.length || !json.keys.every((key) => typeof key === "string")) return { ok: false, reason: "keys must be a non-empty array of setting keys" };
		return { ok: true, frame: { mode, keys: json.keys as string[] }, ...base };
	}
	if (json.section !== undefined) {
		if (typeof json.section !== "string" || !json.section) return { ok: false, reason: "section must be a section id" };
		return { ok: true, frame: { mode, section: json.section }, ...base };
	}
	if (json.all !== true) return { ok: false, reason: "all must be true" };
	return { ok: true, frame: { mode, all: true }, ...base };
}

/** `If-Match: "<revision>"`, quotes optional: absent, malformed, or the 64-hex revision. */
export function parseIfMatch(header: string | string[] | undefined): { state: "absent" } | { state: "malformed" } | { state: "ok"; revision: string } {
	if (header === undefined) return { state: "absent" };
	const value = (Array.isArray(header) ? header.join(",") : header).trim().replace(/^"(.*)"$/, "$1");
	return REVISION_RE.test(value) ? { state: "ok", revision: value } : { state: "malformed" };
}

export function handleSettingsWrite(req: IncomingMessage, options: ControlRouteOptions, mode: "set" | "restore", now = new Date()): Promise<ControlRouteResult> {
	return guarded(req, options, now, "settings", async (json, { peer, refuse }) => {
		const body = parseSettingsBody(json, mode);
		if (!body.ok) return refuse(400, body.reason);
		const ifMatch = parseIfMatch(req.headers["if-match"]);
		if (ifMatch.state === "malformed") return refuse(400, "If-Match must be the 64-hex settings revision");
		if (ifMatch.state === "absent" && !body.dry_run) return refuse(428, "If-Match is required: send the revision you last read");
		const record = readControlRecord(options.stateDir);
		const session = operatorSession(options.stateDir);
		if (record.state !== "ok" || !session.running) return refuse(409, `no operator session is running (${session.reason}); start it to change settings`, undefined, { state: "offline" });
		if (!tokenMatches(req.headers["x-cp-control-token"], record.record.csrf)) return refuse(403, "control token missing or stale; reload the page");
		const reply = await controlRequest(record.record, "settings_apply", {
			...body.frame, expected_revision: ifMatch.state === "ok" ? ifMatch.revision : null, dry_run: body.dry_run, request_id: body.request_id, peer: peer?.slice(0, 64) ?? null,
		});
		if (reply.ok) {
			const result = reply.result as SettingsWriteResponse;
			if (isObject(result) && PASS_THROUGH.has(result.status)) return { status: result.status, body: result };
			return refuse(502, `the session answered with an unexpected settings status (${String(isObject(result) ? result.status : result)})`);
		}
		// An older cp-bridge has no settings op: our refused line is the only record.
		if (reply.status === 400 && /^unknown op/.test(reply.error)) return refuse(409, `unsupported: ${SETTINGS_PREDATE}`, undefined, { state: "refused" });
		return refuse(reply.status, reply.error);
	});
}

function settingsBase(now: Date): SettingsResponse {
	return { generated_at: now.toISOString(), enabled: false, running: false, supported: false, writable: false, reason: null, snapshot: null, catalog: null, audit: [] };
}

export async function handleSettingsStatus(_req: IncomingMessage, options: ControlRouteOptions, now = new Date(), listModels: () => Promise<ModelList> = availableModels): Promise<ControlRouteResult> {
	if (options.requireTailnet !== true) return { status: 403, body: { error: "Settings are served only under --require-tailnet" } };
	const config = readControlConfig(options.stateDir);
	if (config.state !== "on") return { status: 200, body: { ...settingsBase(now), reason: `Dashboard control is off: ${config.reason}` } };
	const record = readControlRecord(options.stateDir);
	const session = operatorSession(options.stateDir);
	if (record.state !== "ok" || !session.running) {
		return { status: 200, body: { ...settingsBase(now), enabled: true, reason: `Operator session offline: ${session.reason}` } };
	}
	const [reply, models] = await Promise.all([controlRequest(record.record, "settings_get", {}), listModels()]);
	if (!reply.ok) {
		if (reply.status === 400 && /^unknown op/.test(reply.error)) return { status: 200, body: { ...settingsBase(now), enabled: true, running: true, reason: SETTINGS_PREDATE } };
		return { status: 200, body: { ...settingsBase(now), enabled: true, reason: reply.error.replace(/^session not running/, "Session not running") } };
	}
	const result = reply.result as Partial<SettingsResponse>;
	return {
		status: 200,
		body: {
			...settingsBase(now), enabled: true, running: true, supported: true, writable: true,
			snapshot: isObject(result?.snapshot) ? (result.snapshot as SettingsResponse["snapshot"]) : null,
			catalog: Array.isArray(result?.catalog) ? result.catalog : null,
			audit: Array.isArray(result?.audit) ? result.audit : [],
			available_models: models.models, models_error: models.error,
		} satisfies SettingsResponse,
	};
}
