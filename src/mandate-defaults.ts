/**
 * Mandate defaults (autonomy-programme-cur.2.5) — "fix example-infra #17" is a
 * complete mandate.
 *
 * `data/mandate-defaults.json` is the home-level knob an operator edits once;
 * an optional `mandate` object on a `data/projects.json` entry overrides it
 * per project; an explicit argument on `cp_mandate issue` overrides both.
 * `resolveMandateGrant` runs that ladder for every defaultable field and
 * records where each value came from, so `cp_mandate show` can say so.
 *
 * Same convention as `src/gate.ts`'s `loadGateConfig`: a missing file is "no
 * override configured" and falls back to the built-in default in memory —
 * only `scaffoldHome` (via `mandateDefaultsStep` in `src/scaffold.ts`) ever
 * writes the file, once, and never rewrites an existing one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type GrantScopePolicy,
	isoTimestamp,
	LAYOUT,
	type MandateAction,
	type MandateAskOn,
	MandateDefaultsSchema,
	type MandateDefaults,
	MANDATE_DEFAULTABLE_FIELDS,
	MandatePolicySchema,
	type MandateDefaultableField,
	type MandateFieldSource,
	type MandateProvenance,
	type ProjectMandateOverride,
	SCHEMA_VERSION,
	validate,
} from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";

export class MandateDefaultsError extends Error {}

/** How far the parent may raise a grant's token cap itself when the home file names no `token_ceiling`. */
export const DEFAULT_TOKEN_CEILING = 100_000_000;

/**
 * Scaffold values: 8h, $100, 10M non-cached tokens, 3 jobs, 3 at once, every action incl. merge, ask_on risk:high only.
 * 10M: the 2026-09-22/23 session's 22 jobs used 3.06M non-cached tokens in all (median job 0.10M, p90 0.26M,
 * max 0.71M) against 97.7M total (96.9% cache reads), at ~$6.25 per 1M non-cached — so 10M is ~3x the whole
 * session and ~14x its largest job (10M is ~$62 at that price, inside the $100 cap): a runaway guard, never the brake on a normal mission.
 */
export const SCAFFOLD_MANDATE_DEFAULTS: MandateDefaults = {
	schema_version: SCHEMA_VERSION,
	expiry_hours: 8,
	spend_usd: 100,
	spend_tokens: 10_000_000,
	token_ceiling: DEFAULT_TOKEN_CEILING,
	job_cap: 3,
	dispatch_parallelism: 3,
	allowed_actions: ["plan", "implement", "review", "repair", "merge"],
	ask_on: ["risk:high"],
	exclude_paths: [".github/workflows/", "secrets/", "**/.env*"],
	notes: {
		expiry_hours: "how long a grant stands before it must be re-issued; conservative so a stale mandate cannot outlive the work it was meant for",
		spend_usd: "USD spend cap across every job the grant covers, before it pauses and escalates",
		spend_tokens: "non-cached token cap (input + output + cache_write; cache reads excluded) across every job the grant covers; at the cap the grant pauses and the parent may raise it itself up to token_ceiling",
		token_ceiling: "the highest token cap the parent may raise a grant to on its own (journaled with a reason); reaching it, or the USD cap, escalates budget_exhausted to the operator",
		job_cap: "max jobs the grant covers (new dispatches only); a project-wide grant's cap also counts other mandates' jobs in the project, so prefer named job_ids with these defaults",
		dispatch_parallelism: "jobs under the grant that may run at once; set 1 for serial",
		allowed_actions: "every action a mandate may auto-decide; merge is granted by default and is gated only by the repository's own rules and ask_on — add ask_on: [\"risk:high\",\"merge\"] to require a human look before merge",
		ask_on: "still asks the operator for these even inside an active mandate; risk:high is the one this ships with",
		exclude_paths: "paths no mandate may auto-touch regardless of allowed_actions: CI workflows and secrets",
	},
};

/** Read `data/mandate-defaults.json`; the scaffold values when it does not exist yet. */
export function loadMandateDefaults(home: string): MandateDefaults {
	const file = join(home, LAYOUT.mandateDefaultsFile);
	if (!existsSync(file)) return SCAFFOLD_MANDATE_DEFAULTS;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new MandateDefaultsError(`${file} is not valid JSON (${(error as Error).message}); refusing to guess mandate defaults`);
	}
	const result = validate<MandateDefaults>(MandateDefaultsSchema, parsed);
	if (!result.ok) {
		throw new MandateDefaultsError(`${file} violates the mandate-defaults contract:\n  ${result.errors.join("\n  ")}`);
	}
	return result.value;
}

/**
 * The home's token ceiling. An unreadable defaults file yields 0 (fail closed): nothing is
 * parent-raisable and every token cap goes to the operator.
 */
export function loadTokenCeiling(home: string): number {
	try {
		return loadMandateDefaults(home).token_ceiling ?? DEFAULT_TOKEN_CEILING;
	} catch {
		return 0;
	}
}

/** Home-only keys: settable in the file, never a per-grant field with provenance. */
export const MANDATE_HOME_ONLY_FIELDS = ["token_ceiling"] as const;
const SETTABLE_FIELDS: readonly string[] = [...MANDATE_DEFAULTABLE_FIELDS, ...MANDATE_HOME_ONLY_FIELDS];

/** `cp_mandate defaults set <key> <value>` (and `/cp-mandate-defaults set`): atomic, journaled like every other store. */
export function setMandateDefault(home: string, key: string, rawValue: string): MandateDefaults {
	if (!SETTABLE_FIELDS.includes(key)) {
		throw new MandateDefaultsError(`unknown mandate default "${key}" \u2014 one of ${SETTABLE_FIELDS.join(", ")}`);
	}
	const current = loadMandateDefaults(home);
	const next: MandateDefaults = { ...current, [key]: parseDefaultValue(key as MandateDefaultableField | "token_ceiling", rawValue) };
	const result = validate<MandateDefaults>(MandateDefaultsSchema, next);
	if (!result.ok) {
		throw new MandateDefaultsError(`refusing to write an invalid mandate default:\n  ${result.errors.join("\n  ")}`);
	}
	atomicWriteJson(join(home, LAYOUT.mandateDefaultsFile), result.value);
	return result.value;
}

function parseDefaultValue(key: MandateDefaultableField | "token_ceiling", rawValue: string): unknown {
	if (key === "spend_usd" || key === "expiry_hours") {
		const value = Number(rawValue);
		if (!Number.isFinite(value)) throw new MandateDefaultsError(`${key} must be a number, got ${JSON.stringify(rawValue)}`);
		return value;
	}
	if (key === "spend_tokens" || key === "token_ceiling" || key === "job_cap" || key === "dispatch_parallelism") {
		const value = Number(rawValue);
		if (!Number.isInteger(value)) throw new MandateDefaultsError(`${key} must be an integer, got ${JSON.stringify(rawValue)}`);
		return value;
	}
	// allowed_actions, ask_on, exclude_paths: comma-separated lists.
	return rawValue
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function formatMandateDefaults(defaults: MandateDefaults): string {
	const lines = ["mandate defaults:"];
	for (const field of MANDATE_DEFAULTABLE_FIELDS) {
		const value = defaults[field];
		lines.push(`  ${field}: ${Array.isArray(value) ? value.join(", ") || "(none)" : value}`);
		if (defaults.notes[field]) lines.push(`    ${defaults.notes[field]}`);
	}
	lines.push(`  token_ceiling: ${defaults.token_ceiling ?? DEFAULT_TOKEN_CEILING}`);
	if (defaults.notes.token_ceiling) lines.push(`    ${defaults.notes.token_ceiling}`);
	lines.push(`  scope_policy: ${defaults.scope_policy ?? "project_wide_allowed"} (file-only)`);
	lines.push(`  deny_projects: ${defaults.deny_projects?.join(", ") || "(none)"} (file-only)`);
	return lines.join("\n");
}

/** File-only machine policy keys (cp-7re9): hand-edited in the file, never `defaults_set` or a Settings field. */
export const MANDATE_POLICY_FIELDS = ["scope_policy", "deny_projects"] as const;
export interface MandatePolicy {
	scope_policy: GrantScopePolicy;
	deny_projects: string[];
}

/**
 * The machine grant policy, read fresh per call. Lenient: only the two policy
 * keys are validated, so a bad grant-default field never blocks dispatch; an
 * unreadable file or an invalid policy key throws naming the file (fail closed).
 */
export function loadMandatePolicy(home: string): MandatePolicy {
	const file = join(home, LAYOUT.mandateDefaultsFile);
	if (!existsSync(file)) return { scope_policy: "project_wide_allowed", deny_projects: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new MandateDefaultsError(
			`${file} is not valid JSON (${(error as Error).message}); the machine policy (scope_policy, deny_projects) is unknown, refusing`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new MandateDefaultsError(`${file} must be a JSON object; the machine policy (scope_policy, deny_projects) is unknown, refusing`);
	}
	const record = parsed as Record<string, unknown>;
	const picked = Object.fromEntries(MANDATE_POLICY_FIELDS.filter((key) => key in record).map((key) => [key, record[key]]));
	const result = validate<Partial<MandatePolicy>>(MandatePolicySchema, picked);
	if (!result.ok) throw new MandateDefaultsError(`${file} scope_policy/deny_projects violate the contract: ${result.errors.join("; ")}`);
	return { scope_policy: result.value.scope_policy ?? "project_wide_allowed", deny_projects: result.value.deny_projects ?? [] };
}

/** Why `project` is closed to new dispatch, send, grant and mandate decision; undefined when it is open. */
export function projectDenial(home: string, project: string): string | undefined {
	try {
		if (!loadMandatePolicy(home).deny_projects.includes(project)) return undefined;
	} catch (error) {
		return `settings: ${(error as Error).message}; the project deny list is unknown, so ${project} is refused`;
	}
	return `settings: project ${project} is denied (${LAYOUT.mandateDefaultsFile} deny_projects); no new dispatch, send, grant or mandate decision there \u2014 a running worker is not stopped`;
}

/** Why `MandateStore.issue` must refuse this grant under the machine policy; undefined when it may proceed. */
export function grantPolicyRefusal(
	home: string,
	grant: { projects: readonly string[]; named: boolean; schedule: boolean },
): string | undefined {
	let policy: MandatePolicy;
	try {
		policy = loadMandatePolicy(home);
	} catch (error) {
		return (error as Error).message;
	}
	const denied = grant.projects.find((project) => policy.deny_projects.includes(project));
	if (denied !== undefined) return `${projectDenial(home, denied)}; grant issue refused`;
	if (policy.scope_policy === "named_jobs_only" && !grant.named && !grant.schedule) {
		return `settings: grants.scope_policy=named_jobs_only requires explicit job_ids; project-wide issue refused (${LAYOUT.mandateDefaultsFile})`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// The ladder: explicit -> project -> home
// ---------------------------------------------------------------------------

/** The subset of `cp_mandate issue` arguments that may be omitted and defaulted. */
export interface MandateIssueDefaultable {
	expiry?: string;
	spend_usd?: number;
	spend_tokens?: number;
	job_cap?: number;
	dispatch_parallelism?: number;
	allowed_actions?: MandateAction[];
	ask_on?: MandateAskOn[];
	exclude_paths?: string[];
}

export interface ResolvedMandateGrant {
	expiry: string;
	spend_cap: { usd: number; tokens: number };
	job_cap: number;
	dispatch_parallelism: number;
	allowed_actions: MandateAction[];
	ask_on: MandateAskOn[];
	exclude_paths: string[];
	provenance: MandateProvenance;
}

function pick<T>(
	field: MandateDefaultableField,
	explicit: T | undefined,
	project: T | undefined,
	home: T,
	provenance: MandateProvenance,
): T {
	if (explicit !== undefined) {
		provenance[field] = "explicit";
		return explicit;
	}
	if (project !== undefined) {
		provenance[field] = "project";
		return project;
	}
	provenance[field] = "home";
	return home;
}

/**
 * Resolve every defaultable `cp_mandate issue` field through the ladder, and
 * say where each landing value came from. `params.expiry` — an explicit ISO
 * timestamp — always wins over `expiry_hours` at any tier.
 */
export function resolveMandateGrant(
	params: MandateIssueDefaultable,
	defaults: MandateDefaults,
	projectOverride: ProjectMandateOverride | undefined,
	now: Date = new Date(),
): ResolvedMandateGrant {
	const provenance: MandateProvenance = {};
	let expiry: string;
	if (params.expiry) {
		provenance.expiry_hours = "explicit";
		expiry = params.expiry;
	} else {
		const hours = pick("expiry_hours", undefined, projectOverride?.expiry_hours, defaults.expiry_hours, provenance);
		expiry = isoTimestamp(new Date(now.getTime() + hours * 3_600_000));
	}
	return {
		expiry,
		spend_cap: {
			usd: pick("spend_usd", params.spend_usd, projectOverride?.spend_usd, defaults.spend_usd, provenance),
			tokens: pick("spend_tokens", params.spend_tokens, projectOverride?.spend_tokens, defaults.spend_tokens, provenance),
		},
		job_cap: pick("job_cap", params.job_cap, projectOverride?.job_cap, defaults.job_cap, provenance),
		dispatch_parallelism: pick(
			"dispatch_parallelism",
			params.dispatch_parallelism,
			projectOverride?.dispatch_parallelism,
			defaults.dispatch_parallelism,
			provenance,
		),
		allowed_actions: pick("allowed_actions", params.allowed_actions, projectOverride?.allowed_actions, defaults.allowed_actions, provenance),
		ask_on: pick("ask_on", params.ask_on, projectOverride?.ask_on, defaults.ask_on, provenance),
		exclude_paths: pick("exclude_paths", params.exclude_paths, projectOverride?.exclude_paths, defaults.exclude_paths, provenance),
		provenance,
	};
}

/**
 * Whether two projects' `mandate` overrides agree, for the multi-project tier of the ladder
 * (pi-command-post-autonomy-programme-cur.2.6). A plain `JSON.stringify(a) === JSON.stringify(b)`
 * is key-order sensitive — two overrides written with the same fields in a different order (e.g.
 * one project registered before `spend_usd` was added, the other after) compared unequal and fell
 * through to home even though every value agreed. Sorting keys first makes the comparison agree
 * with what the two overrides actually mean.
 */
export function sameProjectMandateOverride(a: ProjectMandateOverride | undefined, b: ProjectMandateOverride | undefined): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

// Re-exported so callers importing only this module never need contracts.ts for the type.
export type { MandateFieldSource };
