/**
 * Settings read model (cp-kdow PR1): read model only; owners stay authoritative. Runtime callers:
 * src/settings-write.ts, src/settings-control.ts (allowlisted in tests/settings.test.ts).
 *
 * `readSettings` calls each owner's existing loader per call and reports every catalog field
 * (src/contracts/settings.ts) with its effective value, source and status, plus a fingerprint
 * per owner file. Nothing is cached (cp-sr5) and nothing is written.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homeWallClockSeconds, parsePositiveInt, resolveJobHardBounds } from "./bounds.ts";
import { loadBudgetConfig } from "./budget-config.ts";
import {
	DEFAULT_QUALITY_THRESHOLD,
	DEFAULT_QUALITY_VOTERS,
	isoTimestamp,
	LAYOUT,
	SETTING_FIELDS,
	SETTING_FILE_OWNERS,
	type SettingField,
	type SettingFieldView,
	type SettingFileOwner,
	type SettingKey,
	type SettingOwnerState,
	type SettingsOwnerStatus,
	type SettingsSnapshot,
	type SettingSource,
	type SettingValue,
	ReviewerModelSchema,
	type RoutingConfig,
	validate,
} from "./contracts.ts";
import { resolveReviewTimeoutMs } from "./gate.ts";
import { DEFAULT_TOKEN_CEILING, loadMandateDefaults, loadTokenCeiling } from "./mandate-defaults.ts";
import { operatorCompactThreshold } from "./operator-compact.ts";
import { parentSettings } from "./parent-context.ts";
import { loadQualityConfig, resolveQualityConfig } from "./quality.ts";
import { loadCapacityConfig } from "./quota.ts";
import { loadRoutingConfig } from "./routing.ts";
import { readUpdateConfig } from "./service/update.ts";

const ERROR_MAX = 500;
const ENV_KEYS = ["CP_JOB_WALL_CLOCK_SECONDS", "CP_JOB_TOOL_CALL_CAP"] as const;
const CAPACITY_ABSENT = "capacity.json absent: quota reads are off; these defaults apply once it is configured";

export interface OwnerRead<T> {
	state: SettingOwnerState;
	sha256: string | null;
	result?: T;
	error?: string;
	/** The bytes the result was loaded from, as text (valid/invalid only). */
	text?: string;
}

type Bytes = { bytes: Buffer | null } | { error: string };

function readBytes(file: string): Bytes {
	try {
		return { bytes: readFileSync(file) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null };
		return { error: `${file} is unreadable: ${message(error)}` };
	}
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sameBytes = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));

/**
 * Bytes, then `load()`, then the bytes again: equal means the result describes the hashed
 * bytes. A changed file is retried once, then reported `unstable`.
 */
export function readOwnerConsistently<T>(file: string, load: () => T): OwnerRead<T> {
	let last: OwnerRead<T> = { state: "unstable", sha256: null };
	for (let attempt = 0; attempt < 2; attempt++) {
		const before = readBytes(file);
		if ("error" in before) return { state: "invalid", sha256: null, error: before.error };
		let result: T | undefined;
		let error: string | undefined;
		try {
			result = load();
		} catch (thrown) {
			error = message(thrown);
		}
		const after = readBytes(file);
		if (!("error" in after) && sameBytes(before.bytes, after.bytes)) {
			if (before.bytes === null) return { state: "absent", sha256: null, result, error };
			const state = error === undefined ? "valid" : "invalid";
			return { state, sha256: digest(before.bytes), result, error, text: before.bytes.toString("utf8") };
		}
		const seen = "error" in after ? null : after.bytes;
		last = { state: "unstable", sha256: seen ? digest(seen) : null, error: `${file} changed while it was read twice in a row; read it again` };
	}
	return last;
}

type View = Omit<SettingFieldView, "key">;
type Settled = { read: OwnerRead<unknown>; views: Partial<Record<SettingKey, View>> };

/** An owner file's raw JSON, boxed so a literal `null` file still reads as parsed. */
type RawJson = { json: unknown };

function parsed(text: string | undefined): RawJson | undefined {
	if (text === undefined) return undefined;
	try {
		return { json: JSON.parse(text) };
	} catch {
		return undefined;
	}
}

/** The value at the dotted `key` of the owner file's raw JSON, when present. */
function at(raw: RawJson | undefined, key: string | undefined): RawJson | undefined {
	if (raw === undefined || key === undefined) return undefined;
	let value = raw.json;
	for (const part of key.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value) || !(part in value)) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return { json: value };
}

const fieldsOf = (owner: SettingFileOwner | "env") => SETTING_FIELDS.filter((field) => field.owner === owner);

/** The consumer's behaviour after an invalid or unstable owner file, per the catalog's `on_invalid`. */
function failed(field: SettingField, diagnostic?: string): View {
	const note = diagnostic === undefined ? {} : { diagnostic: diagnostic.slice(0, ERROR_MAX) };
	switch (field.on_invalid) {
		case "refuse":
			return { value: null, source: "none", status: "refused", ...note };
		case "disable":
			return { value: null, source: "none", status: "disabled", ...note };
		case "fail_closed":
			return { value: 0, source: "code", status: "fallback", ...note };
		case "default":
			return { value: field.default, source: "code", status: "fallback", ...note };
	}
}

/** Absent or valid: the loader's values, `file` where the raw JSON has the key. Otherwise `failed`. */
function settle(owner: SettingFileOwner, read: OwnerRead<unknown>, values: (result: never) => Partial<Record<SettingKey, SettingValue>>): Settled {
	const views: Settled["views"] = {};
	const usable = read.state === "absent" || read.state === "valid";
	const loaded = usable ? values(read.result as never) : {};
	const raw = parsed(read.text);
	for (const field of fieldsOf(owner)) {
		views[field.key] = usable
			? { value: loaded[field.key] ?? null, source: read.state === "valid" && at(raw, field.file_key) ? "file" : "code", status: "ok" }
			: failed(field, read.state === "unstable" ? read.error : undefined);
	}
	return { read, views };
}

/** The two `CP_JOB_*` values enter the revision; the two model pins below are read for provenance only (not writable). */
function envView(name: (typeof ENV_KEYS)[number], env: NodeJS.ProcessEnv): { source: SettingSource; diagnostic?: string } {
	const raw = env[name];
	if (parsePositiveInt(raw) !== undefined) return { source: "env" };
	if (raw === undefined) return { source: "code" };
	return { source: "code", diagnostic: `${name}=${JSON.stringify(raw).slice(0, 200)} is not a positive integer; the default applies` };
}

/** `models.parent`/`models.operator`: the owner file's valid `model` (file), else the env pin (env), else unset (code). */
function modelView(key: "models.parent" | "models.operator", read: OwnerRead<unknown>, env: NodeJS.ProcessEnv): View {
	const field = SETTING_FIELDS.find((row) => row.key === key) as SettingField;
	const raw = at(parsed(read.text), field.file_key);
	if (raw !== undefined && validate(ReviewerModelSchema, raw.json).ok) return { value: raw.json as string, source: "file", status: "ok" };
	const pinned = env[field.env as string]?.trim();
	const view: View = pinned ? { value: pinned, source: "env", status: "ok" } : { value: null, source: "code", status: "ok" };
	return raw === undefined ? view : { ...view, status: "fallback", diagnostic: "invalid model; ignored" };
}

type Owner = { file: (home: string) => string; read: (home: string, env: NodeJS.ProcessEnv, file: string) => Settled };

const dataFile = (name: string) => (home: string) => join(home, LAYOUT.data, name);

const OWNERS: Record<SettingFileOwner, Owner> = {
	"mandate-defaults": {
		file: (home) => join(home, LAYOUT.mandateDefaultsFile),
		read: (home, _env, file) => {
			const out = settle("mandate-defaults", readOwnerConsistently(file, () => loadMandateDefaults(home)), (d: ReturnType<typeof loadMandateDefaults>) => ({
				"grants.expiry_hours": d.expiry_hours,
				"grants.spend_usd": d.spend_usd,
				"grants.spend_tokens": d.spend_tokens,
				"grants.token_ceiling": d.token_ceiling ?? DEFAULT_TOKEN_CEILING,
				"grants.job_cap": d.job_cap,
				"grants.dispatch_parallelism": d.dispatch_parallelism,
				"grants.allowed_actions": [...d.allowed_actions],
				"grants.ask_on": [...d.ask_on],
				"grants.exclude_paths": [...d.exclude_paths],
			}));
			// The ceiling's own fail-closed reader decides its fallback, not the catalog.
			if (out.read.state === "invalid") out.views["grants.token_ceiling"] = { value: loadTokenCeiling(home), source: "code", status: "fallback" };
			return out;
		},
	},
	budgets: {
		file: (home) => join(home, LAYOUT.budgetsFile),
		read: (home, _env, file) =>
			settle("budgets", readOwnerConsistently(file, () => loadBudgetConfig(home)), (b: ReturnType<typeof loadBudgetConfig>) => ({
				"budgets.per_job_tokens": b.per_job_tokens,
				"budgets.per_job_cost_usd": b.per_job_cost_usd,
				"budgets.warn_ratio": b.warn_ratio,
				"budgets.spawn_cap": b.spawn_cap,
			})),
	},
	"worker-bounds": {
		file: (home) => join(home, LAYOUT.workerBoundsFile),
		read: (home, env, file) => {
			const read = readOwnerConsistently(file, () => ({ wall: resolveJobHardBounds(undefined, env, home).wall_clock_seconds, home: homeWallClockSeconds(home) }));
			const out = settle("worker-bounds", read, (r: { wall: number }) => ({ "sessions.wall_clock_seconds": r.wall }));
			const view = out.views["sessions.wall_clock_seconds"];
			if (view?.status === "ok" && read.result?.home === undefined) Object.assign(view, envView("CP_JOB_WALL_CLOCK_SECONDS", env));
			return out;
		},
	},
	parent: {
		file: dataFile("parent.json"),
		read: (home, env, file) => {
			const read = readOwnerConsistently(file, () => {
				const limit = parentSettings(home).compact_at_tokens;
				if (limit === undefined) throw new Error(`${file} needs compact_at_tokens as a positive safe integer in valid JSON; parent compaction is off until then`);
				return limit;
			});
			const out = settle("parent", read, (limit: number) => ({ "sessions.parent_compact_at_tokens": limit }));
			out.views["models.parent"] = modelView("models.parent", read, env);
			return out;
		},
	},
	operator: {
		file: dataFile("operator.json"),
		read: (_home, env, file) => {
			const read = readOwnerConsistently(file, () => operatorCompactThreshold(file));
			if (read.state === "valid") {
				const raw = parsed(read.text);
				const key = at(raw, "compact_at_tokens");
				if (raw === undefined) Object.assign(read, { state: "invalid", error: `${file} is not valid JSON; the default threshold applies` });
				else if (key !== undefined && key.json !== read.result) Object.assign(read, { state: "invalid", error: `${file} compact_at_tokens must be a positive safe integer; the default threshold applies` });
			}
			const out = settle("operator", read, (value: number) => ({ "sessions.operator_compact_at_tokens": value }));
			if (read.state === "invalid" && read.result !== undefined) out.views["sessions.operator_compact_at_tokens"] = { value: read.result, source: "code", status: "fallback" };
			out.views["models.operator"] = modelView("models.operator", read, env);
			return out;
		},
	},
	gate: {
		file: (home) => join(home, LAYOUT.gateConfigFile),
		read: (home, _env, file) => settle("gate", readOwnerConsistently(file, () => resolveReviewTimeoutMs(home)), (ms: number) => ({ "review.timeout_ms": ms })),
	},
	quality: {
		file: dataFile("quality.json"),
		read: (home, _env, file) =>
			settle("quality", readOwnerConsistently(file, () => resolveQualityConfig(loadQualityConfig(home))), (q: ReturnType<typeof resolveQualityConfig>) => ({
				"review.quality_verify": q.verify === true,
				"review.quality_completeness": q.completeness === true,
				"review.quality_voters": q.voters ?? DEFAULT_QUALITY_VOTERS,
				"review.quality_threshold": q.threshold ?? DEFAULT_QUALITY_THRESHOLD,
			})),
	},
	capacity: {
		file: dataFile("capacity.json"),
		read: (home, _env, file) => {
			// Only `quota` leaves the loader: the endpoint url/path never enter the snapshot.
			const read = readOwnerConsistently(file, () => (existsSync(file) ? loadCapacityConfig(home).quota : undefined));
			if (read.state === "absent") {
				const views: Settled["views"] = {};
				for (const field of fieldsOf("capacity")) views[field.key] = { value: field.default, source: "code", status: "disabled", diagnostic: CAPACITY_ABSENT };
				return { read, views };
			}
			return settle("capacity", read, (quota: ReturnType<typeof loadCapacityConfig>["quota"]) => ({
				"capacity.five_hour": quota.five_hour,
				"capacity.seven_day": quota.seven_day,
				"capacity.balance_margin": quota.balance_margin,
			}));
		},
	},
	update: {
		file: dataFile("update.json"),
		read: (home, _env, file) => {
			const read = readOwnerConsistently(file, () => {
				const config = readUpdateConfig(join(home, LAYOUT.data));
				if (typeof config === "string") throw new Error(config);
				return config;
			});
			return settle("update", read, (u: { enabled: boolean; interval_min: number }) => ({
				"maintenance.update_enabled": u.enabled,
				"maintenance.update_interval_min": u.interval_min,
			}));
		},
	},
	routing: {
		file: (home) => join(home, LAYOUT.routingFile),
		read: (home, _env, file) =>
			settle("routing", readOwnerConsistently(file, () => loadRoutingConfig(home)), (config: RoutingConfig) => ({ "models.allow": [...config.allow], "models.rubric": [...config.rubric] })),
	},
};

const redact = (text: string, home: string) => text.split(home).join("<home>").slice(0, ERROR_MAX);

/** One snapshot of every catalog field, read now. Never throws for a bad owner file; never writes. */
export function readSettings(home: string, env: NodeJS.ProcessEnv = process.env): SettingsSnapshot {
	const owners: SettingsOwnerStatus[] = [];
	const views: Partial<Record<SettingKey, View>> = {};
	for (const owner of SETTING_FILE_OWNERS) {
		const file = OWNERS[owner].file(home);
		const { read, views: settled } = OWNERS[owner].read(home, env, file);
		owners.push({ owner, path: relative(home, file), state: read.state, sha256: read.sha256, ...(read.error === undefined || read.state === "absent" ? {} : { error: redact(read.error, home) }) });
		Object.assign(views, settled);
	}
	const toolCap = resolveJobHardBounds(undefined, env).tool_call_cap;
	views["sessions.tool_call_cap"] = { value: toolCap, status: "ok", ...envView("CP_JOB_TOOL_CALL_CAP", env) };
	const fields = SETTING_FIELDS.map((field): SettingFieldView => {
		const view = views[field.key] ?? { value: null, source: "none", status: "disabled", diagnostic: "no reader for this field" };
		return { key: field.key, ...view, ...(view.diagnostic === undefined ? {} : { diagnostic: redact(view.diagnostic, home) }) };
	});
	const revision = createHash("sha256")
		.update(JSON.stringify({ owners: owners.map((o) => [o.owner, o.sha256]), env: ENV_KEYS.map((name) => [name, env[name] ?? null]) }))
		.digest("hex");
	return { schema_version: 1, revision, read_at: isoTimestamp(), owners, fields };
}
