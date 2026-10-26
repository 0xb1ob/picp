/**
 * Retained (P16b): `validateSettingValue` against every owner's schema or loader, the frozen catalog, the import
 * guard, `readOwnerConsistently`'s self-rewriting loader and `loadBudgetConfig`'s ContractError: no e2e reaches them.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { homeWallClockSeconds } from "../src/bounds.ts";
import { loadBudgetConfig } from "../src/budget-config.ts";
import {
	BudgetConfigSchema,
	ContractError,
	DEFAULT_BUDGET_CONFIG,
	DEFAULT_GATE_CONFIG,
	GateConfigSchema,
	LAYOUT,
	MandateDefaultsSchema,
	QualityConfigSchema,
	RoutingConfigSchema,
	SETTING_FIELDS,
	SETTING_KEYS,
	type SettingField,
	type SettingFileOwner,
	type SettingKey,
	validate,
	validateSettingValue,
} from "../src/contracts.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "../src/mandate-defaults.ts";
import { operatorCompactThreshold, operatorModelSetting } from "../src/operator-compact.ts";
import { parentModelSetting, parentSettings } from "../src/parent-context.ts";
import { loadCapacityConfig } from "../src/quota.ts";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.ts";
import { readUpdateConfig } from "../src/service/update.ts";
import { loadViewerConfig } from "../src/viewer/host-config.ts";
import { readOwnerConsistently } from "../src/settings.ts";
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
	viewer: `${LAYOUT.data}/viewer.json`,
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
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("(a) catalog: 32 unique keys in SETTING_KEYS order, every default valid, everything frozen", () => {
	assert.equal(SETTING_KEYS.length, 32);
	assert.deepEqual(SETTING_FIELDS.map((field) => field.key), [...SETTING_KEYS]);
	assert.equal(new Set(SETTING_KEYS).size, 32);
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
		viewer: (_field, value) => (write(home, "viewer", { strict_host: value }), accepts(() => loadViewerConfig(ownerFile(home, "viewer")).strict_host, value)),
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
