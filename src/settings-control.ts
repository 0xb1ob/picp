/**
 * Settings over the operator socket (cp-7bsr PR2): the `settings` capability port the cp-bridge spreads into
 * `startDashboardControl` (src/dashboard-control.ts). `settings_get` reads the snapshot, the catalog and the audit
 * tail; `settings_apply` checks the frame's args strictly and runs the audited owner-file transaction
 * (src/settings-write.ts). The viewer only forwards; this runs in the operator's own session.
 */
import { resolve } from "node:path";
import { type Mode, SETTING_FIELDS } from "./contracts.ts";
import type { ControlPorts } from "./dashboard-control.ts";
import { readSettings } from "./settings.ts";
import { applySettings, readSettingsAudit, redact, type SettingsApplyResult, type SettingsWriteRequest } from "./settings-write.ts";

const REVISION_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PEER_MAX = 64;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

type Checked = { ok: true; request: SettingsWriteRequest; expected_revision: string | null; dry_run: boolean; request_id: string; peer: string | null } | { ok: false; error: string };

/** The frame's args, strictly: anything else is a 400 before the transaction runs. An `actor` in args is ignored. */
export function checkApplyArgs(args: Record<string, unknown>): Checked {
	const bad = (error: string): Checked => ({ ok: false, error });
	if (typeof args.dry_run !== "boolean") return bad("dry_run must be a boolean");
	if (args.expected_revision !== null && !(typeof args.expected_revision === "string" && REVISION_RE.test(args.expected_revision))) return bad("expected_revision must be a 64-hex revision or null");
	if (typeof args.request_id !== "string" || !REQUEST_ID_RE.test(args.request_id)) return bad("request_id must be 8-64 of [A-Za-z0-9_-]");
	if (args.peer !== null && !(typeof args.peer === "string" && args.peer.length <= PEER_MAX)) return bad(`peer must be a string of at most ${PEER_MAX} characters or null`);
	const base = { expected_revision: args.expected_revision as string | null, dry_run: args.dry_run, request_id: args.request_id, peer: args.peer as string | null };
	if (args.mode === "set") {
		if (!isObject(args.changes) || !Object.keys(args.changes).length) return bad("set needs changes: an object naming at least one key");
		if (args.keys !== undefined || args.section !== undefined || args.all !== undefined) return bad("set takes changes only");
		return { ok: true, request: { mode: "set", changes: args.changes }, ...base };
	}
	if (args.mode !== "restore") return bad('mode must be "set" or "restore"');
	if (args.changes !== undefined) return bad("restore takes no changes");
	const selectors = [args.keys, args.section, args.all].filter((value) => value !== undefined).length;
	if (selectors !== 1) return bad("restore takes exactly one of keys, section or all");
	if (args.keys !== undefined) {
		if (!Array.isArray(args.keys) || !args.keys.length || !args.keys.every((key) => typeof key === "string")) return bad("keys must be a non-empty array of setting keys");
		return { ok: true, request: { mode: "restore", keys: args.keys as string[] }, ...base };
	}
	if (args.section !== undefined) {
		if (typeof args.section !== "string" || !args.section) return bad("section must be a section id");
		return { ok: true, request: { mode: "restore", section: args.section }, ...base };
	}
	if (args.all !== true) return bad("all must be true");
	return { ok: true, request: { mode: "restore", all: true }, ...base };
}

export function settingsPorts(input: { target: () => { home: string; mode: Mode }; env?: NodeJS.ProcessEnv }): Required<Pick<ControlPorts, "settings">> {
	const env = () => input.env ?? process.env;
	return {
		settings: {
			get: () => {
				const home = resolve(input.target().home);
				try {
					return { snapshot: readSettings(home, env()), catalog: SETTING_FIELDS, audit: readSettingsAudit(home) };
				} catch (error) {
					throw new Error(redact(error instanceof Error ? error.message : String(error), home));
				}
			},
			apply: (args): SettingsApplyResult => {
				const home = resolve(input.target().home);
				try {
					const checked = checkApplyArgs(args);
					if (!checked.ok) return { status: 400, state: "refused", error: checked.error };
					const { ok: _ok, ...rest } = checked;
					return applySettings(home, { ...rest, actor: "dashboard", env: env() });
				} catch (error) {
					return { status: 500, state: "failed", error: redact(error instanceof Error ? error.message : String(error), home) };
				}
			},
		},
	};
}
