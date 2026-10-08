/**
 * cp-kdow PR1: the settings catalog (src/contracts/settings.ts) and the read-only snapshot
 * (src/settings.ts). Values come from each owner's own loader; these tests pin the catalog's
 * defaults and ranges to those owners, the provenance/status rules, the revision, and that
 * reading never writes, never throws and never leaks a secret or the home path.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { homeWallClockSeconds, resolveJobHardBounds } from "../src/bounds.ts";
import { loadBudgetConfig } from "../src/budget-config.ts";
import {
	BudgetConfigSchema,
	ContractError,
	DEFAULT_BUDGET_CONFIG,
	DEFAULT_GATE_CONFIG,
	DEFAULT_JOB_TOOL_CALL_CAP,
	DEFAULT_JOB_WALL_CLOCK_SECONDS,
	DEFAULT_QUALITY_THRESHOLD,
	DEFAULT_QUALITY_VOTERS,
	GateConfigSchema,
	LAYOUT,
	MandateDefaultsSchema,
	QualityConfigSchema,
	RoutingConfigSchema,
	SETTING_FIELDS,
	SETTING_FILE_OWNERS,
	SETTING_KEYS,
	type SettingField,
	type SettingFileOwner,
	type SettingKey,
	type SettingsSnapshot,
	SettingsSnapshotSchema,
	validate,
	validateSettingValue,
} from "../src/contracts.ts";
import { DEFAULT_REVIEW_TIMEOUT_MS, resolveReviewTimeoutMs } from "../src/gate.ts";
import { DEFAULT_TOKEN_CEILING, loadMandateDefaults, loadTokenCeiling, SCAFFOLD_MANDATE_DEFAULTS } from "../src/mandate-defaults.ts";
import { OPERATOR_COMPACT_DEFAULT_TOKENS, operatorCompactThreshold, operatorModelSetting } from "../src/operator-compact.ts";
import { DEFAULT_PARENT_COMPACT_TOKENS, parentModelSetting, parentSettings } from "../src/parent-context.ts";
import { QUALITY_OFF } from "../src/quality.ts";
import { loadCapacityConfig } from "../src/quota.ts";
import { DEFAULT_ROUTING_CONFIG, loadRoutingConfig } from "../src/routing.ts";
import { readUpdateConfig } from "../src/service/update.ts";
import { readOwnerConsistently, readSettings } from "../src/settings.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const OWNER_FILE: Record<SettingFileOwner, string> = {
	"mandate-defaults": LAYOUT.mandateDefaultsFile,
	budgets: LAYOUT.budgetsFile,
	"worker-bounds": LAYOUT.workerBoundsFile,
	parent: `${LAYOUT.data}/parent.json`,
	operator: `${LAYOUT.data}/operator.json`,
	gate: LAYOUT.gateConfigFile,
	quality: `${LAYOUT.data}/quality.json`,
	capacity: `${LAYOUT.data}/capacity.json`,
	update: `${LAYOUT.data}/update.json`,
	routing: LAYOUT.routingFile,
};
const CAPACITY_MIN = { url: "https://gw.example/", path: "/x" };

function scratch(t: TestContext): string {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	return home.path;
}

const ownerFile = (home: string, owner: SettingFileOwner) => join(home, OWNER_FILE[owner]);
const write = (home: string, owner: SettingFileOwner, body: unknown) =>
	writeFileSync(ownerFile(home, owner), typeof body === "string" ? body : JSON.stringify(body));
const fieldOf = (key: SettingKey) => SETTING_FIELDS.find((field) => field.key === key) as SettingField;
const view = (snap: SettingsSnapshot, key: SettingKey) => snap.fields.find((field) => field.key === key);
const ownerOf = (snap: SettingsSnapshot, owner: SettingFileOwner) => snap.owners.find((row) => row.owner === owner);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function snapshot(home: string, env: NodeJS.ProcessEnv = {}): SettingsSnapshot {
	const snap = readSettings(home, env);
	const checked = validate(SettingsSnapshotSchema, snap);
	assert.ok(checked.ok, `snapshot violates SettingsSnapshotSchema: ${checked.ok ? "" : checked.errors.join("; ")}`);
	return snap;
}

test("(a) catalog: 31 unique keys in SETTING_KEYS order, every default valid, everything frozen", () => {
	assert.equal(SETTING_KEYS.length, 31);
	assert.deepEqual(SETTING_FIELDS.map((field) => field.key), [...SETTING_KEYS]);
	assert.equal(new Set(SETTING_KEYS).size, 31);
	assert.ok(Object.isFrozen(SETTING_FIELDS));
	for (const field of SETTING_FIELDS) {
		assert.ok(field.key.startsWith(`${field.section}.`), `${field.key} sits in section ${field.section}`);
		assert.ok(Object.isFrozen(field), `${field.key} is frozen`);
		if (Array.isArray(field.default)) assert.ok(Object.isFrozen(field.default), `${field.key} default is frozen`);
		const checked = validateSettingValue(field.key, field.default);
		assert.ok(checked.ok, `${field.key} default ${JSON.stringify(field.default)} fails its own schema`);
	}
	assert.deepEqual(validateSettingValue("nope.nothing", 1), { ok: false, errors: ["unknown setting nope.nothing"] });
	assert.equal(fieldOf("sessions.tool_call_cap").editable, false);
	assert.equal(fieldOf("models.allow").editable, false);
	for (const key of ["models.rubric", "models.parent", "models.operator"] as const) assert.equal(fieldOf(key).editable, true, key);
	assert.deepEqual(SETTING_KEYS.slice(SETTING_KEYS.indexOf("models.allow"), SETTING_KEYS.indexOf("models.allow") + 4), ["models.allow", "models.rubric", "models.parent", "models.operator"]);
});

test("(b) default parity: every catalog literal equals its owner's constant or loader", (t) => {
	for (const field of SETTING_FIELDS.filter((row) => row.owner === "mandate-defaults")) {
		assert.deepEqual(field.default, SCAFFOLD_MANDATE_DEFAULTS[field.file_key as keyof typeof SCAFFOLD_MANDATE_DEFAULTS], field.key);
	}
	assert.equal(fieldOf("grants.token_ceiling").default, DEFAULT_TOKEN_CEILING);
	for (const field of SETTING_FIELDS.filter((row) => row.owner === "budgets")) {
		assert.equal(field.default, DEFAULT_BUDGET_CONFIG[field.file_key as keyof typeof DEFAULT_BUDGET_CONFIG], field.key);
	}
	assert.equal(fieldOf("sessions.wall_clock_seconds").default, DEFAULT_JOB_WALL_CLOCK_SECONDS);
	assert.equal(fieldOf("sessions.tool_call_cap").default, DEFAULT_JOB_TOOL_CALL_CAP);
	assert.equal(fieldOf("sessions.parent_compact_at_tokens").default, DEFAULT_PARENT_COMPACT_TOKENS);
	assert.equal(fieldOf("sessions.operator_compact_at_tokens").default, OPERATOR_COMPACT_DEFAULT_TOKENS);
	assert.deepEqual(fieldOf("models.allow").default, DEFAULT_ROUTING_CONFIG.allow);
	assert.deepEqual(fieldOf("models.rubric").default, DEFAULT_ROUTING_CONFIG.rubric);
	assert.equal(fieldOf("models.parent").default, null);
	assert.equal(fieldOf("models.operator").default, null);
	assert.equal(fieldOf("review.timeout_ms").default, DEFAULT_REVIEW_TIMEOUT_MS);
	assert.equal(fieldOf("review.quality_verify").default, QUALITY_OFF.verify);
	assert.equal(fieldOf("review.quality_completeness").default, QUALITY_OFF.completeness);
	assert.equal(fieldOf("review.quality_voters").default, DEFAULT_QUALITY_VOTERS);
	assert.equal(fieldOf("review.quality_threshold").default, DEFAULT_QUALITY_THRESHOLD);

	const home = scratch(t);
	write(home, "capacity", CAPACITY_MIN);
	const quota = loadCapacityConfig(home).quota;
	assert.deepEqual(quota, { five_hour: 90, seven_day: 85, balance_margin: 10 });
	assert.deepEqual(
		{ five_hour: fieldOf("capacity.five_hour").default, seven_day: fieldOf("capacity.seven_day").default, balance_margin: fieldOf("capacity.balance_margin").default },
		quota,
	);
	assert.deepEqual(readUpdateConfig(join(scratch(t), LAYOUT.data)), {
		enabled: fieldOf("maintenance.update_enabled").default,
		interval_min: fieldOf("maintenance.update_interval_min").default,
	});
});

/** Boundary probes: in range, just out of range, non-integer, wrong type. */
function probes(field: SettingField): unknown[] {
	switch (field.type) {
		case "integer":
		case "number": {
			const step = field.type === "integer" ? 1 : 0.01;
			const low = field.minimum ?? field.exclusive_minimum ?? 0;
			const out: unknown[] = [low, low - step, low + 0.5, "12", null, true];
			if (field.exclusive_minimum !== undefined) out.push(field.exclusive_minimum + step);
			if (field.maximum !== undefined) out.push(field.maximum, field.maximum + step);
			return out;
		}
		case "nullable_number":
			return [null, 0, -1, 1.5, "abc", true];
		case "boolean":
			return [true, false, "true", 0, null];
		case "enum_list": {
			const one = field.enum?.[0] as string;
			return [[], [one], ["bogus"], Array(field.max_items ?? 1).fill(one), Array((field.max_items ?? 1) + 1).fill(one), one];
		}
		case "string_list":
			return [[], ["a/b"], [""], ["x".repeat(field.max_length ?? 1)], ["x".repeat((field.max_length ?? 1) + 1)], Array((field.max_items ?? 1) + 1).fill("a"), 5];
		case "model_ref":
			return [null, "a/b", "anthropic/claude-opus-5-5", "ab", "a/", "/b", "a b/c", "", `a/${"x".repeat(126)}`, `a/${"x".repeat(127)}`, 5, true];
		case "rubric": {
			const row = { id: "r1", role: "implementer", model: "a/b" };
			return [
				[], [row], [{ ...row, thinking: "high", fallbacks: ["c/d"], scope: ["S"], risk: "low", note: "n" }], [{ ...row, model: "" }], [{ ...row, extra: 1 }],
				[{ ...row, role: "researcher" }], [{ ...row, thinking: "huge" }], [{ ...row, fallbacks: Array(5).fill("c/d") }], Array((field.max_items ?? 1) + 1).fill(row), "x", null,
			];
		}
	}
}

test("(c) range agreement: validateSettingValue accepts exactly what the owner schema or loader accepts", (t) => {
	const schemas: Partial<Record<SettingFileOwner, { schema: unknown; base: object }>> = {
		"mandate-defaults": { schema: MandateDefaultsSchema, base: SCAFFOLD_MANDATE_DEFAULTS },
		budgets: { schema: BudgetConfigSchema, base: DEFAULT_BUDGET_CONFIG },
		gate: { schema: GateConfigSchema, base: DEFAULT_GATE_CONFIG },
		quality: { schema: QualityConfigSchema, base: {} },
		routing: { schema: RoutingConfigSchema, base: DEFAULT_ROUTING_CONFIG },
	};
	const home = scratch(t);
	const accepts = (load: () => unknown, expected: unknown) => {
		try {
			return load() === expected;
		} catch {
			return false;
		}
	};
	const loaders: Partial<Record<SettingFileOwner, (field: SettingField, value: unknown) => boolean>> = {
		"worker-bounds": (_field, value) => (write(home, "worker-bounds", { wall_clock_seconds: value }), accepts(() => homeWallClockSeconds(home), value)),
		parent: (field, value) =>
			field.file_key === "model"
				? (write(home, "parent", { compact_at_tokens: 200000, model: value }), parentModelSetting(home) === (value ?? undefined))
				: (write(home, "parent", { compact_at_tokens: value }), parentSettings(home).compact_at_tokens === value),
		operator: (field, value) =>
			field.file_key === "model"
				? (write(home, "operator", { compact_at_tokens: 200000, model: value }), operatorModelSetting(ownerFile(home, "operator")) === (value ?? undefined))
				: (write(home, "operator", { compact_at_tokens: value }), operatorCompactThreshold(ownerFile(home, "operator")) === value),
		capacity: (field, value) => {
			const key = (field.file_key as string).split(".")[1] as "five_hour";
			write(home, "capacity", { ...CAPACITY_MIN, quota: { [key]: value } });
			return accepts(() => loadCapacityConfig(home).quota[key], value);
		},
		update: (field, value) => {
			write(home, "update", { enabled: true, interval_min: 15, [field.file_key as string]: value });
			const config = readUpdateConfig(join(home, LAYOUT.data));
			return typeof config !== "string" && config[field.file_key as "enabled"] === value;
		},
	};
	let compared = 0;
	for (const field of SETTING_FIELDS) {
		if (field.owner === "env") continue;
		const owned = schemas[field.owner];
		const loader = loaders[field.owner];
		for (const value of probes(field)) {
			const expected = owned
				? validate(owned.schema, { ...owned.base, [field.file_key as string]: value }).ok
				: (loader as (field: SettingField, value: unknown) => boolean)(field, value);
			assert.equal(validateSettingValue(field.key, value).ok, expected, `${field.key} = ${JSON.stringify(value)}: catalog and owner disagree`);
			compared++;
		}
	}
	assert.ok(compared > 150, `only ${compared} probes ran`);
});

/** What each owner's loader answers for an absent file (capacity excluded: its loader cannot answer). */
function loaderValues(home: string): Partial<Record<SettingKey, unknown>> {
	const grants = loadMandateDefaults(home);
	const budgets = loadBudgetConfig(home);
	const update = readUpdateConfig(join(home, LAYOUT.data)) as { enabled: boolean; interval_min: number };
	return {
		"grants.expiry_hours": grants.expiry_hours,
		"grants.spend_usd": grants.spend_usd,
		"grants.spend_tokens": grants.spend_tokens,
		"grants.token_ceiling": loadTokenCeiling(home),
		"grants.job_cap": grants.job_cap,
		"grants.dispatch_parallelism": grants.dispatch_parallelism,
		"grants.allowed_actions": grants.allowed_actions,
		"grants.ask_on": grants.ask_on,
		"grants.exclude_paths": grants.exclude_paths,
		"budgets.per_job_tokens": budgets.per_job_tokens,
		"budgets.per_job_cost_usd": budgets.per_job_cost_usd,
		"budgets.warn_ratio": budgets.warn_ratio,
		"budgets.spawn_cap": budgets.spawn_cap,
		"sessions.wall_clock_seconds": resolveJobHardBounds(undefined, {}, home).wall_clock_seconds,
		"sessions.tool_call_cap": resolveJobHardBounds(undefined, {}).tool_call_cap,
		"sessions.parent_compact_at_tokens": parentSettings(home).compact_at_tokens,
		"sessions.operator_compact_at_tokens": operatorCompactThreshold(ownerFile(home, "operator")),
		"models.allow": loadRoutingConfig(home).allow,
		"models.rubric": loadRoutingConfig(home).rubric,
		"models.parent": parentModelSetting(home) ?? null,
		"models.operator": operatorModelSetting(ownerFile(home, "operator")) ?? null,
		"review.timeout_ms": resolveReviewTimeoutMs(home),
		"review.quality_verify": false,
		"review.quality_completeness": false,
		"review.quality_voters": DEFAULT_QUALITY_VOTERS,
		"review.quality_threshold": DEFAULT_QUALITY_THRESHOLD,
		"maintenance.update_enabled": update.enabled,
		"maintenance.update_interval_min": update.interval_min,
	};
}

test("(d) empty home: every owner absent; 28 fields ok from code at the loader's value; capacity disabled at its defaults", (t) => {
	const home = scratch(t);
	const snap = snapshot(home);
	assert.deepEqual(snap.owners.map((row) => row.owner), [...SETTING_FILE_OWNERS]);
	for (const row of snap.owners) {
		assert.deepEqual(row, { owner: row.owner, path: OWNER_FILE[row.owner], state: "absent", sha256: null });
	}
	const expected = loaderValues(home);
	assert.equal(Object.keys(expected).length, 28);
	for (const [key, value] of Object.entries(expected)) {
		assert.deepEqual(view(snap, key as SettingKey), { key, value, source: "code", status: "ok" }, key);
	}
	for (const key of ["capacity.five_hour", "capacity.seven_day", "capacity.balance_margin"] as const) {
		const row = view(snap, key);
		assert.equal(row?.value, fieldOf(key).default);
		assert.equal(row?.source, "code");
		assert.equal(row?.status, "disabled");
		assert.match(row?.diagnostic ?? "", /capacity\.json absent: quota reads are off/);
	}
	write(home, "capacity", CAPACITY_MIN);
	const configured = snapshot(home);
	assert.equal(ownerOf(configured, "capacity")?.state, "valid");
	assert.deepEqual(
		configured.fields.filter((row) => row.key.startsWith("capacity.")),
		[
			{ key: "capacity.five_hour", value: 90, source: "code", status: "ok" },
			{ key: "capacity.seven_day", value: 85, source: "code", status: "ok" },
			{ key: "capacity.balance_margin", value: 10, source: "code", status: "ok" },
		],
	);
});

test("(e) a valid override per owner: source file, status ok, the written value", (t) => {
	const home = scratch(t);
	const files: Record<SettingFileOwner, unknown> = {
		"mandate-defaults": { ...SCAFFOLD_MANDATE_DEFAULTS, job_cap: 7, token_ceiling: undefined },
		budgets: { ...DEFAULT_BUDGET_CONFIG, spawn_cap: 5 },
		"worker-bounds": { wall_clock_seconds: 120 },
		parent: { compact_at_tokens: 12345, model: "anthropic/claude-opus-5-5" },
		operator: { compact_at_tokens: 54321, model: "openai/gpt-5" },
		gate: { schema_version: 1, review_timeout_ms: 60_000 },
		quality: { verify: true, voters: 3 },
		capacity: { ...CAPACITY_MIN, quota: { five_hour: 70, balance_margin: null } },
		update: { enabled: true, interval_min: 30 },
		routing: { schema_version: 1, allow: ["anthropic/*"], rubric: [{ id: "small", role: "implementer", model: "anthropic/claude-haiku" }] },
	};
	for (const [owner, body] of Object.entries(files)) write(home, owner as SettingFileOwner, body);
	const snap = snapshot(home, { CP_JOB_WALL_CLOCK_SECONDS: "600" });
	for (const owner of SETTING_FILE_OWNERS) {
		const row = ownerOf(snap, owner);
		assert.equal(row?.state, "valid", owner);
		assert.equal(row?.sha256, sha(readFileSync(ownerFile(home, owner), "utf8")), owner);
	}
	const assertView = (key: SettingKey, value: unknown, source = "file") => assert.deepEqual(view(snap, key), { key, value, source, status: "ok" }, key);
	assertView("grants.job_cap", 7);
	assertView("grants.token_ceiling", DEFAULT_TOKEN_CEILING, "code");
	assertView("budgets.spawn_cap", 5);
	assertView("sessions.wall_clock_seconds", 120);
	assertView("sessions.parent_compact_at_tokens", 12345);
	assertView("sessions.operator_compact_at_tokens", 54321);
	assertView("review.timeout_ms", 60_000);
	assertView("review.quality_verify", true);
	assertView("review.quality_completeness", false, "code");
	assertView("review.quality_voters", 3);
	assertView("capacity.five_hour", 70);
	assertView("capacity.seven_day", 85, "code");
	assertView("capacity.balance_margin", null);
	assertView("maintenance.update_enabled", true);
	assertView("maintenance.update_interval_min", 30);
	assertView("models.allow", ["anthropic/*"]);
	assertView("models.rubric", [{ id: "small", role: "implementer", model: "anthropic/claude-haiku" }]);
	assertView("models.parent", "anthropic/claude-opus-5-5");
	assertView("models.operator", "openai/gpt-5");
	// The home file beats the env pins; the pins are provenance only and never move the revision.
	const pinned = snapshot(home, { CP_JOB_WALL_CLOCK_SECONDS: "600", CP_PARENT_MODEL: "env/parent", CP_OPERATOR_MODEL: "env/operator" });
	assert.deepEqual(view(pinned, "models.parent"), { key: "models.parent", value: "anthropic/claude-opus-5-5", source: "file", status: "ok" });
	assert.deepEqual(view(pinned, "models.operator"), { key: "models.operator", value: "openai/gpt-5", source: "file", status: "ok" });
	assert.equal(pinned.revision, snap.revision);
});

test("(f) an invalid owner file: the consumer's own behaviour, no throw, a redacted error", (t) => {
	const schemaInvalid: Record<SettingFileOwner, unknown> = {
		"mandate-defaults": { ...SCAFFOLD_MANDATE_DEFAULTS, job_cap: 0 },
		budgets: { ...DEFAULT_BUDGET_CONFIG, spawn_cap: 99 },
		"worker-bounds": { wall_clock_seconds: 0 },
		parent: { compact_at_tokens: 0 },
		operator: { compact_at_tokens: -1 },
		gate: { schema_version: 1, review_timeout_ms: 5 },
		quality: { voters: 9 },
		capacity: { ...CAPACITY_MIN, quota: { five_hour: 101 } },
		update: { enabled: true, interval_min: 0 },
		routing: { schema_version: 1, allow: "x", rubric: [] },
	};
	const expected = (key: SettingKey) => {
		if (key === "grants.token_ceiling") return { value: 0, source: "code", status: "fallback" };
		if (key === "sessions.operator_compact_at_tokens") return { value: OPERATOR_COMPACT_DEFAULT_TOKENS, source: "code", status: "fallback" };
		// No valid `model` key in the bytes: unset, exactly what the bridge and cp-operator read.
		if (key === "models.parent" || key === "models.operator") return { value: null, source: "code", status: "ok" };
		const disabled = ["parent", "capacity", "update"].includes(fieldOf(key).owner);
		return { value: null, source: "none", status: disabled ? "disabled" : "refused" };
	};
	for (const variant of ["bad-json", "schema"] as const) {
		const home = scratch(t);
		for (const owner of SETTING_FILE_OWNERS) write(home, owner, variant === "bad-json" ? "{nope" : schemaInvalid[owner]);
		const snap = snapshot(home);
		for (const row of snap.owners) {
			assert.equal(row.state, "invalid", `${variant} ${row.owner}`);
			assert.ok(row.error, `${variant} ${row.owner} names why`);
			assert.ok(!row.error.includes(home), `${variant} ${row.owner} error leaks the home path: ${row.error}`);
		}
		for (const field of SETTING_FIELDS) {
			if (field.owner === "env") continue;
			const row = view(snap, field.key);
			assert.deepEqual({ value: row?.value, source: row?.source, status: row?.status }, expected(field.key), `${variant} ${field.key}`);
		}
		assert.equal(loadTokenCeiling(home), 0);
		assert.equal(operatorCompactThreshold(ownerFile(home, "operator")), OPERATOR_COMPACT_DEFAULT_TOKENS);
	}
});

test("(g) env provenance: valid env is env, the home file beats it, a rejected value is code with a diagnostic", (t) => {
	const home = scratch(t);
	const snap = snapshot(home, { CP_JOB_WALL_CLOCK_SECONDS: "600", CP_JOB_TOOL_CALL_CAP: "50" });
	assert.deepEqual(view(snap, "sessions.wall_clock_seconds"), { key: "sessions.wall_clock_seconds", value: 600, source: "env", status: "ok" });
	assert.deepEqual(view(snap, "sessions.tool_call_cap"), { key: "sessions.tool_call_cap", value: 50, source: "env", status: "ok" });
	for (const raw of ["abc", "0", ""]) {
		const rejected = snapshot(home, { CP_JOB_WALL_CLOCK_SECONDS: raw, CP_JOB_TOOL_CALL_CAP: raw });
		for (const [key, value] of [["sessions.wall_clock_seconds", DEFAULT_JOB_WALL_CLOCK_SECONDS], ["sessions.tool_call_cap", DEFAULT_JOB_TOOL_CALL_CAP]] as const) {
			const row = view(rejected, key);
			assert.equal(row?.value, value, `${key}=${JSON.stringify(raw)}`);
			assert.equal(row?.source, "code");
			assert.match(row?.diagnostic ?? "", /is not a positive integer/);
		}
	}
	write(home, "worker-bounds", { wall_clock_seconds: 120 });
	const filed = snapshot(home, { CP_JOB_WALL_CLOCK_SECONDS: "600" });
	assert.deepEqual(view(filed, "sessions.wall_clock_seconds"), { key: "sessions.wall_clock_seconds", value: 120, source: "file", status: "ok" });
	assert.equal(resolveJobHardBounds(undefined, { CP_JOB_WALL_CLOCK_SECONDS: "600" }, home).wall_clock_seconds, 120);

	// Model pins: env when no file key, the file when valid, an invalid key is a fallback to the pin; never in the revision.
	const env = { CP_PARENT_MODEL: " env/parent ", CP_OPERATOR_MODEL: "env/operator" };
	const pins = snapshot(home, env);
	assert.deepEqual(view(pins, "models.parent"), { key: "models.parent", value: "env/parent", source: "env", status: "ok" });
	assert.deepEqual(view(pins, "models.operator"), { key: "models.operator", value: "env/operator", source: "env", status: "ok" });
	assert.equal(pins.revision, snapshot(home).revision);
	write(home, "parent", { compact_at_tokens: 200000, model: "not a model" });
	write(home, "operator", { model: "file/operator" });
	const mixed = snapshot(home, env);
	assert.deepEqual(view(mixed, "models.parent"), { key: "models.parent", value: "env/parent", source: "env", status: "fallback", diagnostic: "invalid model; ignored" });
	assert.deepEqual(view(mixed, "models.operator"), { key: "models.operator", value: "file/operator", source: "file", status: "ok" });
	assert.equal(parentModelSetting(home), undefined);
	assert.equal(operatorModelSetting(ownerFile(home, "operator")), "file/operator");
});

test("(h) revision: stable on an unchanged home, moves on bytes and env, not on an mtime-only touch", (t) => {
	const home = scratch(t);
	write(home, "budgets", DEFAULT_BUDGET_CONFIG);
	const first = snapshot(home);
	assert.equal(snapshot(home).revision, first.revision);
	const old = new Date(Date.now() - 60_000);
	utimesSync(ownerFile(home, "budgets"), old, old);
	assert.equal(snapshot(home).revision, first.revision, "an mtime-only touch keeps the revision");
	write(home, "budgets", { ...DEFAULT_BUDGET_CONFIG, spawn_cap: 4 });
	const changed = snapshot(home);
	assert.notEqual(changed.revision, first.revision);
	assert.notEqual(ownerOf(changed, "budgets")?.sha256, ownerOf(first, "budgets")?.sha256);
	assert.notEqual(snapshot(home, { CP_JOB_TOOL_CALL_CAP: "7" }).revision, changed.revision);
	assert.notEqual(snapshot(home, { CP_JOB_WALL_CLOCK_SECONDS: "7" }).revision, changed.revision);
});

test("(i) readOwnerConsistently: one rewrite mid-load is retried to valid; a file that never settles is unstable", (t) => {
	const home = scratch(t);
	const file = join(home, "owner.json");
	writeFileSync(file, "a");
	let calls = 0;
	const once = readOwnerConsistently(file, () => {
		if (calls++ === 0) writeFileSync(file, "b");
		return readFileSync(file, "utf8");
	});
	assert.deepEqual({ state: once.state, sha256: once.sha256, result: once.result }, { state: "valid", sha256: sha("b"), result: "b" });
	let n = 0;
	const never = readOwnerConsistently(file, () => writeFileSync(file, String(n++)));
	assert.equal(never.state, "unstable");
	assert.match(never.error ?? "", /changed while it was read/);
});

test("(j) no secrets: the gateway key, endpoint url/path and home path never enter the snapshot", (t) => {
	const home = scratch(t);
	write(home, "capacity", { url: "https://secret-gateway.example/", path: "/v1/secret-path", quota: { five_hour: 50 } });
	write(home, "gate", "{nope");
	const text = JSON.stringify(snapshot(home, { CP_GATEWAY_ADMIN_KEY: "sk-test-secret" }));
	for (const secret of ["sk-test-secret", "secret-gateway", "/v1/secret-path", home]) assert.ok(!text.includes(secret), `snapshot leaks ${secret}`);
	assert.match(text, /<home>/, "the gate error names the file with the home redacted");
});

function listing(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
		const path = join(entry.parentPath, entry.name);
		out.push(`${relative(root, path)}\t${statSync(path).mtimeMs}`);
	}
	return out.sort();
}

test("(k) no writes: the home's files and mtimes are identical before and after a read", (t) => {
	const empty = scratch(t);
	const before = listing(empty);
	snapshot(empty);
	assert.deepEqual(listing(empty), before);
	const full = scratch(t);
	write(full, "budgets", DEFAULT_BUDGET_CONFIG);
	write(full, "capacity", CAPACITY_MIN);
	write(full, "routing", "{nope");
	const filled = listing(full);
	snapshot(full, { CP_JOB_TOOL_CALL_CAP: "5" });
	assert.deepEqual(listing(full), filled);
});

function sourceFiles(dir: string): string[] {
	return readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts") && !name.includes("node_modules"))
		.map((name) => join(REPO_ROOT, dir, name));
}

const specifiers = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1] as string);

test("(l) import guard: only src/settings-control.ts and src/settings-write.ts import src/settings.ts; the contract imports only siblings", () => {
	const target = join(REPO_ROOT, "src/settings.ts");
	const allowlist: string[] = ["src/settings-control.ts", "src/settings-write.ts"];
	const importers = [...sourceFiles("src"), ...sourceFiles("extensions")].filter((file) =>
		specifiers(readFileSync(file, "utf8")).some((spec) => spec.startsWith(".") && resolve(dirname(file), spec) === target),
	);
	assert.deepEqual(importers.map((file) => relative(REPO_ROOT, file)).sort(), allowlist, "PR2's importers, named explicitly");
	const contract = specifiers(readFileSync(join(REPO_ROOT, "src/contracts/settings.ts"), "utf8"));
	assert.ok(contract.length > 0);
	for (const spec of contract) {
		assert.ok(spec === "typebox" || spec === "@earendil-works/pi-ai" || /^\.\/[\w-]+\.ts$/.test(spec), `src/contracts/settings.ts imports ${spec}`);
	}
});

test("(m) loadBudgetConfig keeps CommandPost.budgets()'s outcomes: default, ContractError, contract violation", (t) => {
	const home = scratch(t);
	assert.equal(loadBudgetConfig(home), DEFAULT_BUDGET_CONFIG);
	write(home, "budgets", "{nope");
	assert.throws(() => loadBudgetConfig(home), ContractError);
	write(home, "budgets", { ...DEFAULT_BUDGET_CONFIG, spawn_cap: 0 });
	assert.throws(() => loadBudgetConfig(home), (error: Error) => !(error instanceof ContractError) && error.message.includes("violates the budget contract"));
});
