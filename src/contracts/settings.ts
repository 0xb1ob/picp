/**
 * Settings catalog (cp-kdow PR1) — the one typed list of the home's per-machine knobs, and the
 * closed shape of the read-only snapshot `readSettings` (src/settings.ts) returns. Import via
 * src/contracts.ts.
 *
 * Every field names its owner file (or env var); the owner's loader stays authoritative. Defaults
 * owned outside `contracts/` are literals here, each pinned against its owning constant by
 * tests/settings.test.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { IsoTimestampSchema, type ValidationResult, validate } from "./core.ts";
import { DEFAULT_BUDGET_CONFIG, DEFAULT_JOB_TOOL_CALL_CAP, DEFAULT_JOB_WALL_CLOCK_SECONDS } from "./limits.ts";
import { MANDATE_ACTIONS, MANDATE_ASK_ON } from "./mandates.ts";
import { DEFAULT_QUALITY_THRESHOLD, DEFAULT_QUALITY_VOTERS, GATE_REVIEW_TIMEOUT_MAX_MS, GATE_REVIEW_TIMEOUT_MIN_MS } from "./reviews.ts";

export const SETTING_SECTIONS = ["grants", "budgets", "sessions", "models", "review", "capacity", "maintenance"] as const;
export type SettingSection = (typeof SETTING_SECTIONS)[number];

/** Owner files in revision order; `env` is the one owner without a file. */
export const SETTING_OWNERS = [
	"mandate-defaults",
	"budgets",
	"worker-bounds",
	"parent",
	"operator",
	"gate",
	"quality",
	"capacity",
	"update",
	"routing",
	"env",
] as const;
export type SettingOwner = (typeof SETTING_OWNERS)[number];
export type SettingFileOwner = Exclude<SettingOwner, "env">;
export const SETTING_FILE_OWNERS = SETTING_OWNERS.filter((owner): owner is SettingFileOwner => owner !== "env");

export const SETTING_SOURCES = ["file", "env", "code", "none"] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

/** ok: applied now; fallback: the loader's value after an invalid input; disabled: feature off now; refused: the consumer refuses. */
export const SETTING_STATUSES = ["ok", "fallback", "disabled", "refused"] as const;
export type SettingStatus = (typeof SETTING_STATUSES)[number];

export const SETTING_OWNER_STATES = ["absent", "valid", "invalid", "unstable"] as const;
export type SettingOwnerState = (typeof SETTING_OWNER_STATES)[number];

export const SETTING_ON_INVALID = ["refuse", "fail_closed", "default", "disable"] as const;
export type SettingOnInvalid = (typeof SETTING_ON_INVALID)[number];

export const SETTING_APPLIES = [
	"next_grant",
	"next_token_raise",
	"next_dispatch",
	"next_spawn",
	"next_compaction_check",
	"next_review_attempt",
	"next_pipeline",
	"next_quota_read",
	"next_update_run",
] as const;
export type SettingApplies = (typeof SETTING_APPLIES)[number];

export const SETTING_VALUE_TYPES = ["integer", "number", "nullable_number", "boolean", "enum_list", "string_list"] as const;
export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];

export const SETTING_KEYS = [
	"grants.expiry_hours",
	"grants.spend_usd",
	"grants.spend_tokens",
	"grants.token_ceiling",
	"grants.job_cap",
	"grants.dispatch_parallelism",
	"grants.allowed_actions",
	"grants.ask_on",
	"grants.exclude_paths",
	"budgets.per_job_tokens",
	"budgets.per_job_cost_usd",
	"budgets.warn_ratio",
	"budgets.spawn_cap",
	"sessions.wall_clock_seconds",
	"sessions.tool_call_cap",
	"sessions.parent_compact_at_tokens",
	"sessions.operator_compact_at_tokens",
	"models.allow",
	"review.timeout_ms",
	"review.quality_verify",
	"review.quality_completeness",
	"review.quality_voters",
	"review.quality_threshold",
	"capacity.five_hour",
	"capacity.seven_day",
	"capacity.balance_margin",
	"maintenance.update_enabled",
	"maintenance.update_interval_min",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const SettingValueSchema = Type.Union([Type.Number(), Type.Boolean(), Type.Array(Type.String()), Type.Null()]);
export type SettingValue = Static<typeof SettingValueSchema>;

export interface SettingField {
	key: SettingKey;
	section: SettingSection;
	owner: SettingOwner;
	/** Key in the owner file; dotted for a nested key (`quota.five_hour`). */
	file_key?: string;
	env?: string;
	type: SettingValueType;
	minimum?: number;
	exclusive_minimum?: number;
	maximum?: number;
	enum?: readonly string[];
	min_items?: number;
	max_items?: number;
	max_length?: number;
	default: SettingValue;
	applies: SettingApplies;
	on_invalid: SettingOnInvalid;
	/** What the Settings write API may write. Routing (`models.allow`) and the env-only tool-call cap stay false (cp-7re9); the PR3 policy keys are owner-file keys outside the catalog, preserved by every write. */
	editable: boolean;
	label: string;
	help: string;
}

type FieldSpec = Omit<SettingField, "key" | "section" | "owner" | "applies" | "on_invalid" | "editable"> & Partial<Pick<SettingField, "applies" | "on_invalid" | "editable">>;

function group(section: SettingSection, owner: SettingOwner, base: Pick<SettingField, "applies" | "on_invalid">, specs: Record<string, FieldSpec>): SettingField[] {
	return Object.entries(specs).map(([name, spec]) => ({ key: `${section}.${name}` as SettingKey, section, owner, editable: true, ...base, ...spec }));
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

/** The 28 fields, in `SETTING_KEYS` order. */
export const SETTING_FIELDS: readonly SettingField[] = deepFreeze([
	...group("grants", "mandate-defaults", { applies: "next_grant", on_invalid: "refuse" }, {
		expiry_hours: { file_key: "expiry_hours", type: "number", minimum: 0.1, maximum: 720, default: 8, label: "Grant expiry (hours)", help: "How long a new grant stands before it must be re-issued." },
		spend_usd: { file_key: "spend_usd", type: "number", minimum: 0, default: 100, label: "Grant spend cap (USD)", help: "USD spend cap across every job a new grant covers." },
		spend_tokens: { file_key: "spend_tokens", type: "integer", minimum: 0, default: 10_000_000, label: "Grant token cap", help: "Non-cached token cap across every job a new grant covers." },
		token_ceiling: { file_key: "token_ceiling", type: "integer", minimum: 0, default: 100_000_000, applies: "next_token_raise", on_invalid: "fail_closed", label: "Token ceiling", help: "The highest token cap the parent may raise a grant to on its own; an unreadable defaults file means 0." },
		job_cap: { file_key: "job_cap", type: "integer", minimum: 1, default: 3, label: "Grant job cap", help: "Most jobs a new grant covers (new dispatches only)." },
		dispatch_parallelism: { file_key: "dispatch_parallelism", type: "integer", minimum: 1, maximum: 32, default: 3, label: "Dispatch parallelism", help: "Jobs under a grant that may run at once; 1 is serial." },
		allowed_actions: { file_key: "allowed_actions", type: "enum_list", enum: [...MANDATE_ACTIONS], min_items: 1, max_items: 8, default: [...MANDATE_ACTIONS], label: "Allowed actions", help: "Actions a new grant may auto-decide." },
		ask_on: { file_key: "ask_on", type: "enum_list", enum: [...MANDATE_ASK_ON], max_items: 16, default: ["risk:high"], label: "Ask on", help: "Still ask the operator for these inside an active grant." },
		exclude_paths: { file_key: "exclude_paths", type: "string_list", max_items: 32, max_length: 200, default: [".github/workflows/", "secrets/", "**/.env*"], label: "Excluded paths", help: "Paths no grant may auto-touch." },
	}),
	...group("budgets", "budgets", { applies: "next_dispatch", on_invalid: "refuse" }, {
		per_job_tokens: { file_key: "per_job_tokens", type: "integer", minimum: 1, default: DEFAULT_BUDGET_CONFIG.per_job_tokens, label: "Per-job token budget", help: "Token budget a dispatched job starts with." },
		per_job_cost_usd: { file_key: "per_job_cost_usd", type: "number", minimum: 0, default: DEFAULT_BUDGET_CONFIG.per_job_cost_usd, label: "Per-job cost budget (USD)", help: "USD budget a dispatched job starts with." },
		warn_ratio: { file_key: "warn_ratio", type: "number", minimum: 0, maximum: 1, default: DEFAULT_BUDGET_CONFIG.warn_ratio, label: "Budget warn ratio", help: "Fraction of a budget at which a warning fires." },
		spawn_cap: { file_key: "spawn_cap", type: "integer", minimum: 1, maximum: 32, default: DEFAULT_BUDGET_CONFIG.spawn_cap, applies: "next_spawn", label: "Spawn cap", help: "Most workers alive at once." },
	}),
	...group("sessions", "worker-bounds", { applies: "next_dispatch", on_invalid: "refuse" }, {
		wall_clock_seconds: { file_key: "wall_clock_seconds", env: "CP_JOB_WALL_CLOCK_SECONDS", type: "integer", minimum: 1, default: DEFAULT_JOB_WALL_CLOCK_SECONDS, label: "Job wall clock (seconds)", help: "Hard wall-clock bound per job, frozen at dispatch; the home file beats the env." },
	}),
	...group("sessions", "env", { applies: "next_dispatch", on_invalid: "default" }, {
		tool_call_cap: { env: "CP_JOB_TOOL_CALL_CAP", type: "integer", minimum: 1, default: DEFAULT_JOB_TOOL_CALL_CAP, editable: false, label: "Job tool-call cap", help: "Hard tool-call bound per job, from the env as observed by the reading process." },
	}),
	...group("sessions", "parent", { applies: "next_compaction_check", on_invalid: "disable" }, {
		parent_compact_at_tokens: { file_key: "compact_at_tokens", type: "integer", minimum: 1, maximum: SAFE_MAX, default: 200000, label: "Parent compaction threshold (tokens)", help: "Context size at which the parent compacts; an invalid file disables it." },
	}),
	...group("sessions", "operator", { applies: "next_compaction_check", on_invalid: "default" }, {
		operator_compact_at_tokens: { file_key: "compact_at_tokens", type: "integer", minimum: 1, maximum: SAFE_MAX, default: 200000, label: "Operator compaction threshold (tokens)", help: "Context size at which the operator session compacts; an invalid value keeps the default." },
	}),
	...group("models", "routing", { applies: "next_dispatch", on_invalid: "refuse" }, {
		allow: { file_key: "allow", type: "string_list", max_items: 64, default: ["*/*"], editable: false, label: "Allowed models", help: "Model patterns routing may pick; absent routing.json allows every model." },
	}),
	...group("review", "gate", { applies: "next_review_attempt", on_invalid: "refuse" }, {
		timeout_ms: { file_key: "review_timeout_ms", type: "integer", minimum: GATE_REVIEW_TIMEOUT_MIN_MS, maximum: GATE_REVIEW_TIMEOUT_MAX_MS, default: 300_000, label: "Review timeout (ms)", help: "How long one review attempt may take before it counts as operational." },
	}),
	...group("review", "quality", { applies: "next_pipeline", on_invalid: "refuse" }, {
		quality_verify: { file_key: "verify", type: "boolean", default: false, label: "Quality verify panel", help: "Run cheap voters on a research artifact before the gate." },
		quality_completeness: { file_key: "completeness", type: "boolean", default: false, label: "Quality completeness pass", help: "Ask whether a research artifact covers its task." },
		quality_voters: { file_key: "voters", type: "integer", minimum: 1, maximum: 5, default: DEFAULT_QUALITY_VOTERS, label: "Quality voters", help: "Panel size for the verify pass." },
		quality_threshold: { file_key: "threshold", type: "number", minimum: 0, maximum: 1, default: DEFAULT_QUALITY_THRESHOLD, label: "Quality threshold", help: "Fraction of sound votes the verify pass needs." },
	}),
	...group("capacity", "capacity", { applies: "next_quota_read", on_invalid: "disable" }, {
		five_hour: { file_key: "quota.five_hour", type: "number", minimum: 0, maximum: 100, default: 90, label: "Five-hour quota threshold (%)", help: "Five-hour window utilization at which a provider counts as tight." },
		seven_day: { file_key: "quota.seven_day", type: "number", minimum: 0, maximum: 100, default: 85, label: "Seven-day quota threshold (%)", help: "Seven-day window utilization at which a provider counts as tight." },
		balance_margin: { file_key: "quota.balance_margin", type: "nullable_number", default: 10, label: "Balance margin", help: "Balance margin before a provider counts as tight; null turns the balance check off." },
	}),
	...group("maintenance", "update", { applies: "next_update_run", on_invalid: "disable" }, {
		update_enabled: { file_key: "enabled", type: "boolean", default: false, label: "Automatic updates", help: "Whether the daemon updates this home on its own." },
		update_interval_min: { file_key: "interval_min", type: "number", exclusive_minimum: 0, default: 15, label: "Update interval (minutes)", help: "Minutes between automatic update checks." },
	}),
]);

const FIELD_BY_KEY = new Map<string, SettingField>(SETTING_FIELDS.map((field) => [field.key, field]));

/** A TypeBox schema for one field's value, built from its descriptor. */
export function settingValueSchema(field: SettingField): TSchema {
	const bounds = {
		...(field.minimum === undefined ? {} : { minimum: field.minimum }),
		...(field.exclusive_minimum === undefined ? {} : { exclusiveMinimum: field.exclusive_minimum }),
		...(field.maximum === undefined ? {} : { maximum: field.maximum }),
	};
	const items = {
		...(field.min_items === undefined ? {} : { minItems: field.min_items }),
		...(field.max_items === undefined ? {} : { maxItems: field.max_items }),
	};
	switch (field.type) {
		case "integer":
			return Type.Integer(bounds);
		case "number":
			return Type.Number(bounds);
		case "nullable_number":
			return Type.Union([Type.Number(bounds), Type.Null()]);
		case "boolean":
			return Type.Boolean();
		case "enum_list":
			return Type.Array(StringEnum([...(field.enum ?? [])]), items);
		case "string_list":
			return Type.Array(Type.String({ minLength: 1, ...(field.max_length === undefined ? {} : { maxLength: field.max_length }) }), items);
	}
}

/** Validate one value against its catalog field; an unknown key is refused. */
export function validateSettingValue(key: string, value: unknown): ValidationResult<SettingValue> {
	const field = FIELD_BY_KEY.get(key);
	if (!field) return { ok: false, errors: [`unknown setting ${key}`] };
	return validate<SettingValue>(settingValueSchema(field), value);
}

const SHA256_PATTERN = "^[0-9a-f]{64}$";

export const SettingFieldViewSchema = Type.Object(
	{
		key: StringEnum([...SETTING_KEYS]),
		value: SettingValueSchema,
		source: StringEnum([...SETTING_SOURCES]),
		status: StringEnum([...SETTING_STATUSES]),
		diagnostic: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ additionalProperties: false },
);
export type SettingFieldView = { key: SettingKey; value: SettingValue; source: SettingSource; status: SettingStatus; diagnostic?: string };

export const SettingsOwnerStatusSchema = Type.Object(
	{
		owner: StringEnum([...SETTING_FILE_OWNERS]),
		/** Runtime-root-relative. */
		path: Type.String({ minLength: 1 }),
		state: StringEnum([...SETTING_OWNER_STATES]),
		/** Of the owner file's bytes; null when absent. */
		sha256: Type.Union([Type.String({ pattern: SHA256_PATTERN }), Type.Null()]),
		/** Capped, with the home path redacted to `<home>`. */
		error: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ additionalProperties: false },
);
export type SettingsOwnerStatus = { owner: SettingFileOwner; path: string; state: SettingOwnerState; sha256: string | null; error?: string };

/** A per-call read model — never written, never cached. `read_at` is outside the revision. */
export const SettingsSnapshotSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		revision: Type.String({ pattern: SHA256_PATTERN }),
		read_at: IsoTimestampSchema,
		owners: Type.Array(SettingsOwnerStatusSchema, { maxItems: SETTING_FILE_OWNERS.length }),
		fields: Type.Array(SettingFieldViewSchema, { maxItems: SETTING_KEYS.length }),
	},
	{ additionalProperties: false },
);
export type SettingsSnapshot = { schema_version: 1; revision: string; read_at: string; owners: SettingsOwnerStatus[]; fields: SettingFieldView[] };
