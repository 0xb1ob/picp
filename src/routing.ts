/**
 * Model routing: explicit override, first matching rubric row, else profile.
 * Each source confines its own candidate list; allowlist, pi auth and effective
 * effort gate every candidate before any lease. Explicit overrides never fall
 * back or change effort. Unknown model metadata is not a refusal.
 *
 * Capacity is advisory: after those gates, a complete admin snapshot ranks
 * providers by free slots; otherwise the reader uses the waiting fleet count,
 * then original candidate order when unknown or tied. No capacity score is a
 * refusal, and an existing worker never changes model mid-session.
 *
 * Diagnostics share the same predicates: duplicate/shadowed rubric rows,
 * effort drift, the session-start nudge and doctor cannot silently substitute
 * a model or an effort. See docs/contracts.md §Routing config.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type JobKind,
	type JobRouting,
	LAYOUT,
	type Risk,
	type RoutingConfig,
	type RoutingDecision,
	type RoutingProvenance,
	type RoutingRule,
	type Role,
	type ThinkingLevel,
	THINKING_LEVELS,
	type Scope,
	SCOPES,
	SCHEMA_VERSION,
	validate,
	normalizeLegacyRoles,
	type WorkerProfile,
	RoutingConfigSchema,
} from "./contracts.ts";
import { DEFAULT_BALANCE_MARGIN, formatQuota, type QuotaSnapshot } from "./quota.ts";
import type { CapacityReader, CapacityScore } from "./capacity.ts";
import { listProfiles } from "./profiles.ts";

/**
 * Why routing refused. The message says it in words; this says it in something
 * a caller can branch on, which is what a *diagnosis* needs: doctor prints a
 * different fix for "the allowlist refuses this model" than for "this provider
 * has no credentials", and guessing between them from prose would be the drift
 * this package refuses everywhere else.
 */
export type RoutingRefusal = "allowlist" | "availability" | "effort" | "exhausted";

/** Why one candidate was skipped. `exhausted` is about the list, never a member. */
export type CandidateRefusal = Exclude<RoutingRefusal, "exhausted">;

export class RoutingError extends Error {
	/** What was refused, when the thrower knew. */
	readonly refusal?: RoutingRefusal;
	/**
	 * The rubric row the refusal is about, when a row chose the model.
	 *
	 * It exists because a refused row is still an **exercised** row: without it,
	 * `doctor` could see only that `pickModel` threw, and reported a row whose
	 * model the allowlist rejects as "not exercised — register the project", which
	 * is advice about a problem that is not there.
	 */
	readonly rule?: string;
	constructor(message: string, about: { refusal?: RoutingRefusal; rule?: string } = {}) {
		super(message);
		if (about.refusal) this.refusal = about.refusal;
		if (about.rule) this.rule = about.rule;
	}
}

/**
 * No `data/routing.json` means "no routing policy configured yet", not "no
 * models allowed": the reachable models are then exactly the profile's own and
 * whatever the operator explicitly names. An `allow: []` **in the file** still
 * means nothing is allowed — that is an operator statement, and it fails closed.
 */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
	schema_version: SCHEMA_VERSION,
	allow: ["*/*"],
	rubric: [],
};

export function loadRoutingConfig(home: string): RoutingConfig {
	const file = join(home, LAYOUT.routingFile);
	if (!existsSync(file)) return DEFAULT_ROUTING_CONFIG;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new RoutingError(`${file} is not valid JSON (${(error as Error).message}); refusing to guess a model`);
	}
	// A config written for the old two-mechanism model is refused with the
	// migration, not silently ignored: `additionalProperties: false` would
	// otherwise reject it with a schema message that explains nothing (cp-cxt).
	if (typeof parsed === "object" && parsed !== null && "pins" in parsed) {
		throw new RoutingError(
			`${file} still has \`pins\`, which routing no longer has. Express each pin as a rubric row: ` +
				'{ id, role, project?, scope?, risk?, model }. A pin that named one job (`job_id`) becomes an ' +
				"explicit model override on that dispatch instead.",
		);
	}
	// A rubric row written against the old role name still routes: the legacy
	// word is mapped forward on read, exactly once, and never written back.
	const result = validate<RoutingConfig>(RoutingConfigSchema, normalizeLegacyRoles(parsed));
	if (!result.ok) {
		throw new RoutingError(`${file} violates the routing contract:\n  ${result.errors.join("\n  ")}`);
	}
	// A rubric id is a name for one row — it is what a routing decision prints as
	// `rule=` and what a `models.rubric` finding points at. Two rows wearing it
	// make that name a lie: first match wins, so one of them decides and the
	// other is invisible, and neither the run log nor a doctor finding can say
	// which. Refused at load, where every caller goes through (routing T5).
	const duplicates = duplicateRubricIds(result.value);
	if (duplicates.length > 0) {
		throw new RoutingError(`${file} ${describeDuplicateRubricIds(result.value, duplicates)}`);
	}
	return result.value;
}

// ---------------------------------------------------------------------------
// Policy lint (routing T5)
// ---------------------------------------------------------------------------

/** One id worn by more than one rubric row, with the rows that wear it. */
export interface DuplicateRubricId {
	id: string;
	/** Positions in `rubric[]`, in file order. */
	rows: number[];
}

export function duplicateRubricIds(config: RoutingConfig): DuplicateRubricId[] {
	const byId = new Map<string, number[]>();
	config.rubric.forEach((rule, index) => byId.set(rule.id, [...(byId.get(rule.id) ?? []), index]));
	return [...byId.entries()].filter(([, rows]) => rows.length > 1).map(([id, rows]) => ({ id, rows }));
}

/** The refusal's body: which id, which rows, and what each of them routes to. */
function describeDuplicateRubricIds(config: RoutingConfig, duplicates: readonly DuplicateRubricId[]): string {
	const detail = duplicates
		.map(
			({ id, rows }) =>
				`"${id}" at ${rows.map((row) => `rubric[${row}] -> ${config.rubric[row]?.model ?? "?"}`).join(" and ")}`,
		)
		.join("; ");
	return (
		`has ${duplicates.length} duplicate rubric id(s): ${detail}. ` +
		"A rubric id names one row — it is what a routing decision prints as `rule=` — so give each row its own id " +
		"(or delete the row you no longer want; first match wins, so the later one never fires)."
	);
}

/** A row that can never fire, and the earlier row that always takes it. */
export interface ShadowedRubricRow {
	id: string;
	row: number;
	/** The earlier row whose selector covers this one entirely. */
	by: string;
	byRow: number;
}

/**
 * Rows that are **provably** dead: every request this row matches, an earlier
 * row matches too, so first-match-wins means it can never decide anything.
 *
 * Proof only, never suspicion. The selector is four independent narrowings
 * (`role`, `project`, `scope`, `risk`) with "absent matches everything"
 * semantics, so "A covers B" is a containment check on each of them — nothing
 * is inferred from the models, the efforts or the notes. Partial overlap (two
 * rows sharing `S` while one also takes `M`) is intentional policy and is not
 * reported: it is how narrow-to-broad ordering is *supposed* to read.
 *
 * Nothing here reorders, rewrites or disables a row. Precedence is the
 * operator's, and a warning that silently changed it would be worse than the
 * dead row it was complaining about.
 */
export function shadowedRubricRows(config: RoutingConfig): ShadowedRubricRow[] {
	const shadowed: ShadowedRubricRow[] = [];
	config.rubric.forEach((rule, row) => {
		for (let earlier = 0; earlier < row; earlier += 1) {
			const before = config.rubric[earlier] as RoutingRule;
			if (!coversEntirely(before, rule)) continue;
			shadowed.push({ id: rule.id, row, by: before.id, byRow: earlier });
			return; // the first row that takes it is the one worth naming
		}
	});
	return shadowed;
}

/** Does every request `narrow` matches also match `broad`? */
function coversEntirely(broad: RoutingRule, narrow: RoutingRule): boolean {
	if (broad.role !== narrow.role) return false;
	if (broad.project !== undefined && broad.project !== narrow.project) return false;
	if (broad.risk !== undefined && broad.risk !== narrow.risk) return false;
	const broadScopes = broad.scope ?? SCOPES;
	const narrowScopes = narrow.scope ?? SCOPES;
	return narrowScopes.every((scope) => broadScopes.includes(scope));
}

/** One configured model/effort pair pi's own metadata says cannot be served. */
export interface EffortDrift {
	model: string;
	thinking: ThinkingLevel;
	/** What the model does serve. Empty means it does not reason at all. */
	supported: ThinkingLevel[];
	/** Every configured place that pair comes from (`rubric row x`, `profile y`). */
	sources: string[];
}

/**
 * Configured effort that has drifted away from what the model can serve
 * (routing T5), using T3's rule and nothing else.
 *
 * The pairs checked are the ones a dispatch would actually spawn: every
 * profile's own model+level, and every rubric row's model at the level that row
 * would apply (its own, else the profile's — routing narrows policy rather than
 * resetting what a row did not mention). Identical pairs from several sources
 * are ONE probe and one entry naming all of them, so a big rubric cannot turn
 * into a wall of duplicate findings.
 *
 * Nothing is called but the probe: no inference API, no auth refresh, no write.
 * And absent metadata stays absent — see `unserviceableEffort`.
 */
export function effortPolicyDrift(
	config: RoutingConfig,
	profiles: readonly WorkerProfile[],
	probe: ModelProbe,
): EffortDrift[] {
	const byPair = new Map<string, EffortDrift>();
	const check = (where: string, model: string, thinking?: ThinkingLevel): void => {
		if (!thinking) return;
		const key = `${model}\u0000${thinking}`;
		const known = byPair.get(key);
		if (known) {
			if (!known.sources.includes(where)) known.sources.push(where);
			return;
		}
		// A configured level is never an explicit override: nobody typed it for this
		// job, so a level that is merely inert on a non-reasoning model stays inert
		// here exactly as it does at dispatch.
		const supported = unserviceableEffort(model, thinking, probe, { explicit: false });
		if (supported) byPair.set(key, { model, thinking, supported, sources: [where] });
	};
	for (const profile of profiles) {
		const { name, role, model, thinking, fallbacks } = profile.frontmatter;
		check(`profile ${name}`, model, thinking);
		// A fallback candidate is a model a one-provider day will actually spawn, so
		// its effort is checked here too — the alternative is discovering the drift
		// on the day the preferred provider is the one that is down.
		for (const candidate of fallbacks ?? []) check(`profile ${name} fallback`, candidate, thinking);
		for (const rule of config.rubric) {
			if (rule.role !== role) continue;
			const level = rule.thinking ?? thinking;
			check(`rubric row ${rule.id}`, rule.model, level);
			for (const candidate of rule.fallbacks ?? []) check(`rubric row ${rule.id} fallback`, candidate, level);
		}
	}
	return [...byPair.values()];
}

/** Lines a nudge or a finding prints per drifted pair. */
export function describeEffortDrift(drift: EffortDrift): string {
	return (
		`${drift.sources.join(", ")} asks for thinking=${drift.thinking} on ${drift.model}, which it cannot serve ` +
		`(available: ${drift.supported.join(", ") || "(none — this model does not reason)"})`
	);
}

/** How many lint lines a startup nudge prints before it says "and N more". */
export const MAX_NUDGE_LINES = 5;

/**
 * A bounded, **self-counting** list.
 *
 * Two limits, and the count always describes what actually happened: at most
 * `max` items, and at most `cap` characters — items dropped for either reason
 * are in the `(+N more)`. A list truncated by length with a count that only
 * knew about `max` would be a number that is wrong precisely when the output
 * got big, which is the moment somebody reads it.
 *
 * The cap matters beyond tidiness here: `DoctorFindingSchema` bounds `what`,
 * `detail` and `fix`, and `validateDoctorReport` **refuses** a report that
 * breaks them — so an unbounded list would turn a long project list or a big
 * rubric into a crashed diagnosis rather than a long one.
 */
export function boundedList(
	items: readonly string[],
	options: { max?: number; cap?: number; separator?: string } = {},
): string {
	const max = options.max ?? MAX_NUDGE_LINES;
	const cap = options.cap ?? 2000;
	const separator = options.separator ?? "; ";
	const render = (shown: readonly string[]): string => {
		const hidden = items.length - shown.length;
		return `${shown.join(separator)}${hidden > 0 ? ` (+${hidden} more)` : ""}`;
	};
	let shown = items.slice(0, max);
	while (shown.length > 0 && render(shown).length > cap) shown = shown.slice(0, -1);
	// Even the bare count can overrun a very small cap: truncate rather than emit
	// something a contract would refuse.
	return render(shown).slice(0, cap);
}

export interface RoutingNudgeOptions {
	home: string;
	profilesDir: string;
	/**
	 * pi's registry probe. Absent means the effort half is not checked at all —
	 * a level nobody could ask about is not a level anybody may call wrong.
	 */
	probe?: ModelProbe;
}

/**
 * The one thing an operator wants to hear at startup and not at dispatch time:
 * this home's routing policy is refused, dead in places, or asks for effort a
 * model cannot serve (routing T5).
 *
 * `undefined` — and therefore silence — is the steady state. It reads files and
 * pi's own metadata; it calls no inference API, writes nothing, and never
 * rewrites the config it is reading.
 */
export function computeRoutingNudge(options: RoutingNudgeOptions): string | undefined {
	let config: RoutingConfig;
	try {
		config = loadRoutingConfig(options.home);
	} catch (error) {
		return [
			`routing: ${(error as Error).message.split("\n")[0] ?? "data/routing.json is not usable"}`,
			"dispatch refuses to guess a model, so every dispatch fails until this is fixed (`/doctor` for the whole picture)",
		].join("\n");
	}
	const lines: string[] = [];
	const shadowed = shadowedRubricRows(config);
	for (const row of shadowed.slice(0, MAX_NUDGE_LINES)) {
		lines.push(`rubric[${row.row}] "${row.id}" can never fire: rubric[${row.byRow}] "${row.by}" already matches everything it does`);
	}
	if (shadowed.length > MAX_NUDGE_LINES) lines.push(`(and ${shadowed.length - MAX_NUDGE_LINES} more shadowed row(s))`);
	if (options.probe) {
		let profiles: WorkerProfile[] = [];
		try {
			profiles = listProfiles(options.profilesDir);
		} catch {
			profiles = []; // an invalid profile is /doctor's finding, not this nudge's
		}
		const drift = effortPolicyDrift(config, profiles, options.probe);
		for (const pair of drift.slice(0, MAX_NUDGE_LINES)) lines.push(describeEffortDrift(pair));
		if (drift.length > MAX_NUDGE_LINES) lines.push(`(and ${drift.length - MAX_NUDGE_LINES} more drifted model/effort pair(s))`);
	}
	if (lines.length === 0) return undefined;
	return [
		"routing: this home's policy needs a look",
		...lines,
		"fix data/routing.json (nothing here changes precedence for you); `/doctor` reports the same checks in full",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Glob match over `provider/model-id`.
 *
 * T13 amendment: contracts said "minimatch"; this is a deliberate subset with
 * no dependency — `*` matches within one path segment, `**` matches across
 * segments, everything else is literal. That covers every pattern shape the
 * allowlist actually uses (`anthropic/*`, `*​/*`, `**`, exact refs) and cannot
 * surprise anyone with brace/negation semantics.
 */
export function matchesPattern(pattern: string, value: string): boolean {
	const escaped = pattern
		.split("")
		.map((char) => {
			if (char === "*") return "\u0000";
			return /[.+^${}()|[\]\\?]/.test(char) ? `\\${char}` : char;
		})
		.join("")
		.replace(/\u0000\u0000/g, "\u0001")
		.replace(/\u0000/g, "[^/]*")
		.replace(/\u0001/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

export function isAllowed(config: RoutingConfig, model: string): boolean {
	return config.allow.some((pattern) => matchesPattern(pattern, model));
}

// ---------------------------------------------------------------------------
// Availability probe
// ---------------------------------------------------------------------------

/** What routing needs from pi's model registry, and nothing more. */
export interface ModelProbe {
	/** Known to pi AND auth resolves. */
	isAvailable(model: string): boolean;
	/** Available refs, for error messages only. */
	available?(): string[];
	/**
	 * The effort levels this model can actually serve, or `undefined` when the
	 * probe cannot tell (cp-ot3b).
	 *
	 * `undefined` means *no evidence*, not *nothing supported*: routing refuses an
	 * effort it has been told the model cannot serve, and never on ignorance —
	 * the alternative would make every probe without a registry (tests,
	 * `--no-probe` diagnostics) refuse every effort the operator asked for, which
	 * is the downgrade-by-another-name this change exists to remove.
	 */
	supportedThinking?(model: string): ThinkingLevel[] | undefined;
}

/** Structural view of pi's `ctx.modelRegistry` (no import, no coupling). */
export interface PiModelRegistryLike {
	find(provider: string, modelId: string): PiModelLike | undefined;
	hasConfiguredAuth(model: { id?: string; provider?: string }): boolean;
	getAvailable?(): Array<{ id?: string; provider?: string }>;
}

/**
 * The part of pi's `Model` routing reads for effort support: `reasoning` says
 * whether the model thinks at all, and `thinkingLevelMap` maps pi's levels to
 * provider values with `null` marking a level the model does not support. A
 * level absent from the map is the provider's default for that level, i.e.
 * supported.
 */
export interface PiModelLike {
	id?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/**
 * Effort levels a pi model can serve, from its own metadata (cp-ot3b).
 * Exported for tests and for `doctor`.
 */
export function supportedThinkingFor(model: PiModelLike): ThinkingLevel[] {
	// A model that does not reason can serve exactly one level: none of it. pi
	// treats a level on such a model as inert, which is precisely the silent
	// downgrade an explicit override must not get.
	if (model.reasoning === false) return ["off"];
	const map = model.thinkingLevelMap;
	if (!map) return [...THINKING_LEVELS];
	return THINKING_LEVELS.filter((level) => map[level] !== null);
}

export function splitModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const at = ref.indexOf("/");
	if (at <= 0 || at === ref.length - 1) return undefined;
	return { provider: ref.slice(0, at), modelId: ref.slice(at + 1) };
}

/**
 * Availability = pi knows the model *and* the provider's auth is configured.
 * "Known but unauthenticated" is unavailable: a worker that cannot call its
 * model is a lease and a branch wasted.
 */
export function registryProbe(registry: PiModelRegistryLike): ModelProbe {
	return {
		isAvailable(ref: string): boolean {
			const parts = splitModelRef(ref);
			if (!parts) return false;
			const model = registry.find(parts.provider, parts.modelId);
			if (!model) return false;
			return registry.hasConfiguredAuth(model);
		},
		available(): string[] {
			const models = registry.getAvailable?.() ?? [];
			return models.map((model) => `${model.provider ?? "?"}/${model.id ?? "?"}`);
		},
		supportedThinking(ref: string): ThinkingLevel[] | undefined {
			const parts = splitModelRef(ref);
			if (!parts) return undefined;
			const model = registry.find(parts.provider, parts.modelId);
			if (!model) return undefined;
			return supportedThinkingFor(model);
		},
	};
}

/** Probe that says yes to everything: tests and `--no-probe` diagnostics only. */
export const ALWAYS_AVAILABLE: ModelProbe = { isAvailable: () => true };

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface RouteRequest {
	profile: WorkerProfile;
	jobId: string;
	project: string;
	kind: JobKind;
	/** Rubric inputs; ported defaults are S / low. */
	scope?: Scope;
	risk?: Risk;
	/** Caller-named model (rule 0). Authorization, but still allowlisted. */
	override?: string;
	/**
	 * Caller-named effort (cp-ot3b). Part of the same explicit override as
	 * `override`, and usable on its own: an operator who wants today's model at a
	 * different effort should not have to name the model to say so.
	 *
	 * Honoured over the rubric row's and the profile's level, or refused when the
	 * model cannot serve it. Never substituted.
	 */
	thinking?: ThinkingLevel;
}

interface Candidate {
	/** The preferred model: `candidates[0]`, kept as its own field for readers. */
	model: string;
	/** `[model, ...fallbacks]` for the picked source, in file order. */
	candidates: string[];
	source: RoutingDecision["source"];
	rule: string;
	/** Effort that comes with this pick (row's level, else the profile's). */
	thinking?: ThinkingLevel;
	/**
	 * Who named that effort. Not the same thing as `source`: an override can name
	 * a model and leave the effort to the profile, and a rubric row can name a
	 * model and no level. The capability refusal has to name the source of the
	 * *level* it is refusing, or it points at the wrong thing to fix.
	 */
	effortFrom?: "override" | "rubric" | "profile";
}

/** Where the effective effort came from, in words a refusal can print. */
function effortOrigin(request: RouteRequest, picked: Candidate): string {
	if (picked.effortFrom === "override") return "override";
	if (picked.effortFrom === "rubric") return `rubric row ${picked.rule}`;
	return `profile ${request.profile.frontmatter.name}`;
}

/** The pick, before availability is considered. Exported for tests. */
export function pickModel(request: RouteRequest, config: RoutingConfig): Candidate {
	const role: Role = request.profile.frontmatter.role;
	const scope: Scope = request.scope ?? "S";
	const risk: Risk = request.risk ?? "low";

	if (request.override) {
		// An override is one candidate, always: the caller named this model, so an
		// unusable one is their decision to revisit, not routing's to route around.
		requireAllowed(config, request.override, "override");
		// An override that names an effort keeps it; one that does not keeps today's
		// behaviour exactly (the profile's level), which is the backwards-compatible
		// half of cp-ot3b.
		const thinking = request.thinking ?? request.profile.frontmatter.thinking;
		return {
			model: request.override,
			candidates: [request.override],
			source: "override",
			rule: request.thinking ? "explicit override (model+effort)" : "explicit override",
			...(thinking ? { thinking } : {}),
			effortFrom: request.thinking ? "override" : "profile",
		};
	}

	for (const rule of config.rubric) {
		if (rule.role !== role) continue;
		// `project` narrows a row to one repository; absent matches every repo.
		if (rule.project !== undefined && rule.project !== request.project) continue;
		if (rule.scope && !rule.scope.includes(scope)) continue;
		if (rule.risk !== undefined && rule.risk !== risk) continue;
		const candidates = [rule.model, ...(rule.fallbacks ?? [])];
		// The row matched — it is exercised, whatever the allowlist then says about
		// its model, which is why the refusal carries the row's id.
		// A single-candidate row keeps the hard allowlist error it always had; a row
		// with fallbacks defers to the walk, where a disallowed candidate is skipped
		// with provenance (see `resolveModel`).
		if (candidates.length === 1) requireAllowed(config, rule.model, `rubric ${rule.id}`, rule.id);
		// A row that names no level leaves the profile's in force: routing narrows
		// policy, it does not silently reset the parts it did not mention.
		// A caller-named effort outranks the row's, the same way a caller-named
		// model outranks it: the exception belongs to the person making it.
		const thinking = request.thinking ?? rule.thinking ?? request.profile.frontmatter.thinking;
		return {
			model: rule.model,
			candidates,
			source: "rubric",
			rule: rule.id,
			...(thinking ? { thinking } : {}),
			effortFrom: request.thinking ? "override" : rule.thinking ? "rubric" : "profile",
		};
	}

	const profileModel = request.profile.frontmatter.model;
	const profileCandidates = [profileModel, ...(request.profile.frontmatter.fallbacks ?? [])];
	if (profileCandidates.length === 1) requireAllowed(config, profileModel, `profile ${request.profile.frontmatter.name}`);
	const profileThinking = request.thinking ?? request.profile.frontmatter.thinking;
	return {
		model: profileModel,
		candidates: profileCandidates,
		source: "profile",
		rule: `profile ${request.profile.frontmatter.name}`,
		...(profileThinking ? { thinking: profileThinking } : {}),
		effortFrom: request.thinking ? "override" : "profile",
	};
}

function requireAllowed(config: RoutingConfig, model: string, where: string, rule?: string): void {
	if (isAllowed(config, model)) return;
	throw new RoutingError(
		`${where} names ${model}, which the allowlist refuses (allow: ${config.allow.join(", ") || "(empty — nothing is allowed)"})`,
		{ refusal: "allowlist", ...(rule ? { rule } : {}) },
	);
}

/**
 * Full resolution: the picked source's candidates, walked in order through the
 * allowlist, the availability probe and the effort check, first one through
 * wins (pi-command-post-0a9).
 *
 * A **single**-candidate source — an override, or a row/profile with no
 * `fallbacks` — behaves exactly as it always did, down to the refusal kind and
 * the message: there is nothing to fall back to, and a caller who has to fix
 * auth is better served by the specific error than by a list of one. A
 * **multi**-candidate source records each skipped candidate with the gate that
 * skipped it and refuses only when every candidate is gone (`exhausted`).
 *
 * All of it runs before the lease, so a refusal still costs a message and
 * nothing else.
 */
export async function resolveWithCapacity(
	request: RouteRequest, config: RoutingConfig, probe: ModelProbe, reader?: Pick<CapacityReader, "read"> & Partial<Pick<CapacityReader, "quota">>,
): Promise<RoutingDecision> {
	const picked = pickModel(request, config);
	if (!reader || request.override) return resolveModel(request, config, probe);
	const configured = [...new Set(config.rubric.flatMap((row) => [row.model, ...(row.fallbacks ?? [])]).map((model) => splitModelRef(model)!.provider))];
	const quota = await reader.quota?.read(configured);
	const finish = (scores?: Record<string, CapacityScore>) => resolveModel(request, config, probe, scores, quota);
	if (picked.candidates.length < 2 || quota?.reason === "off:no admin key") return finish();
	const providers = [...new Set(picked.candidates
		.filter((model) => !candidateRefusal(model, request, picked, config, probe))
		.map((model) => splitModelRef(model)?.provider))];
	if (providers.includes(undefined) || providers.length < 2) return finish();
	let scores: Record<string, CapacityScore>;
	try {
		scores = await reader.read(providers as string[]);
	} catch {
		return finish();
	}
	const values = providers.map((provider) => scores[provider as string]);
	if (values.some((value) => !value || value.source === "unknown" || !Number.isFinite(value.score)) ||
		new Set(values.map((value) => value?.source)).size !== 1) return finish();
	return finish(scores);
}

function candidateRefusal(model: string, request: RouteRequest, picked: Candidate, config: RoutingConfig, probe: ModelProbe): CandidateRefusal | undefined {
	if (!isAllowed(config, model)) return "allowlist";
	if (!probe.isAvailable(model)) {
		if (picked.candidates.length === 1) throw unavailable(request, picked, model, probe);
		return "availability";
	}
	if (picked.thinking) {
		const explicit = picked.effortFrom === "override";
		if (picked.candidates.length === 1) {
			requireEffortServiceable(model, picked.thinking, probe, {
				explicit,
				where: effortOrigin(request, picked),
				...(picked.source === "rubric" ? { rule: picked.rule } : {}),
			});
		} else if (unserviceableEffort(model, picked.thinking, probe, { explicit })) return "effort";
	}
}

export function resolveModel(request: RouteRequest, config: RoutingConfig, probe: ModelProbe, scores?: Record<string, CapacityScore>, quota?: QuotaSnapshot): RoutingDecision {
	const picked = pickModel(request, config);
	const attempted: Array<{ model: string; refusal: CandidateRefusal }> = [];
	const eligible: string[] = [];

	for (const model of picked.candidates) {
		const refusal = candidateRefusal(model, request, picked, config, probe);
		if (refusal) {
			attempted.push({ model, refusal });
			continue;
		}
		if (scores || quota) {
			eligible.push(model);
			continue;
		}
		return {
			model,
			source: picked.source,
			rule: picked.rule,
			...(picked.thinking ? { thinking: picked.thinking } : {}),
			...(request.override ? { requested: request.override } : {}),
			...(request.thinking ? { requested_thinking: request.thinking } : {}),
			...(attempted.length > 0 ? { attempted } : {}),
		};
	}

	if (eligible.length > 0 && (scores || quota)) {
		const availableScores = scores ?? {};
		const provider = (model: string) => splitModelRef(model)?.provider ?? "";
		const capacityScore = (name: string) => {
			const entry = availableScores[name];
			return entry && entry.source !== "unknown" ? entry.score : -Infinity;
		};
		// Prefer free admin slots in rubric order, subject to quota balancing below.
		// When none is free, the most free wins (ties keep rubric order).
		const healthy = eligible.filter((model) => !quota?.providers.find((row) => row.provider === provider(model))?.tight);
		const ranked = healthy.length ? healthy : eligible;
		const free = ranked.filter((model) => availableScores[provider(model)]?.source === "admin" && capacityScore(provider(model)) > 0);
		let selected = free[0]
			?? ranked.reduce((best, model) => capacityScore(provider(model)) > capacityScore(provider(best)) ? model : best);
		const margin = quota?.balance_margin === undefined ? DEFAULT_BALANCE_MARGIN : quota.balance_margin;
		const weekly = (model: string) => quota?.providers.find((row) => row.provider === provider(model))?.seven_day;
		if (healthy.length && free.length > 1 && margin !== null && margin >= 0 && weekly(selected) !== undefined) {
			const lowest = free.reduce((best, model) => (weekly(model) ?? Infinity) < weekly(best)! ? model : best, selected);
			if (weekly(selected)! - weekly(lowest)! > margin) {
				quota = { ...quota!, balance_reason: `quota balance: ${provider(selected)} 7d=${weekly(selected)} vs ${provider(lowest)} 7d=${weekly(lowest)} (margin ${margin}) -> ${provider(lowest)}` };
				selected = lowest;
			}
		}
		const selectedScore = availableScores[provider(selected)];
		const source = selectedScore?.source;
		const capacity = source === "admin" || source === "fleet" ? {
			source,
			scores: [...new Set(eligible.map(provider))].map((name) => ({ provider: name.slice(0, 128), score: capacityScore(name) })),
			...(selectedScore?.source === "fleet" && selectedScore.reason ? { reason: selectedScore.reason } : {}),
		} : undefined;
		const skipped = attempted.filter(({ model }) => picked.candidates.indexOf(model) < picked.candidates.indexOf(selected));
		return {
			model: selected, source: picked.source, rule: picked.rule,
			...(picked.thinking ? { thinking: picked.thinking } : {}),
			...(request.thinking ? { requested_thinking: request.thinking } : {}),
			...(skipped.length ? { attempted: skipped } : {}),
			...(capacity ? { capacity } : {}),
			...(quota ? { quota } : {}),
		};
	}
	throw exhausted(request, picked, attempted, probe);
}

/** Today's availability refusal, for a source with nothing to fall back to. */
function unavailable(request: RouteRequest, picked: Candidate, model: string, probe: ModelProbe): RoutingError {
	return new RoutingError(
		`no available model for ${request.profile.frontmatter.role} job ${request.jobId}: ${model} (${picked.source}, ${picked.rule}) ` +
			`is not usable. A model must be in pi's registry with resolvable auth. This route has no other candidate: fix the auth, ` +
			`give the row or profile a \`fallbacks\` list, or route this role to a model you can reach in data/routing.json.${availableNote(probe)}`,
		{ refusal: "availability", ...(picked.source === "rubric" ? { rule: picked.rule } : {}) },
	);
}

/**
 * Every candidate refused, each named with the gate that refused it. The list is
 * the diagnosis: "authenticate a provider" is the wrong advice for a candidate
 * the operator's own allowlist rejects, and both can appear in one route.
 */
function exhausted(
	request: RouteRequest,
	picked: Candidate,
	attempted: ReadonlyArray<{ model: string; refusal: CandidateRefusal }>,
	probe: ModelProbe,
): RoutingError {
	const reasons = boundedList(
		attempted.map((entry) => `${entry.model} (${entry.refusal})`),
		{ max: 8, cap: 400, separator: ", " },
	);
	const where = picked.source === "rubric" ? `rubric row ${picked.rule}` : picked.rule;
	return new RoutingError(
		`no usable model for ${request.profile.frontmatter.role} job ${request.jobId}: every candidate for ${where} ` +
			`was refused — ${reasons}. Authenticate one of those providers (\`pi auth\`), widen \`allow\`, or edit the candidates ` +
			`in data/routing.json.${availableNote(probe)}`,
		{ refusal: "exhausted", ...(picked.source === "rubric" ? { rule: picked.rule } : {}) },
	);
}

function availableNote(probe: ModelProbe): string {
	return probe.available ? ` Available: ${probe.available().join(", ") || "(none)"}.` : "";
}

/**
 * An effort is honoured or refused, never quietly mapped to something the model
 * does serve (cp-ot3b, widened to every source by cp-reviewer-routing). The
 * refusal names what asked for the level, what was asked and what is available,
 * the way the allowlist's does — that shape is what let an operator find the
 * real model id after a bad one was refused.
 *
 * Two things it deliberately does not refuse:
 *
 *  - **no evidence** — a probe that cannot answer is ignorance, not proof of an
 *    unsupported level (see `ModelProbe.supportedThinking`);
 *  - **a model that does not reason at all**, for a level nobody explicitly
 *    asked for. pi treats a level on such a model as inert (contracts
 *    §RoutingRule.thinking), so a rubric row or a profile default that names one
 *    is a no-op rather than a config error — refusing there would ground every
 *    worker routed to a non-reasoning model. An *explicit* override is still
 *    refused, because a person asked for effort and would silently not get it.
 */
function requireEffortServiceable(
	model: string,
	thinking: ThinkingLevel,
	probe: ModelProbe,
	origin: { explicit: boolean; where: string; rule?: string },
): void {
	const supported = unserviceableEffort(model, thinking, probe, { explicit: origin.explicit });
	if (!supported) return;
	throw new RoutingError(
		`${origin.where} asks for thinking=${thinking}, which ${model} cannot serve ` +
			`(available: ${supported.join(", ") || "(none — this model does not reason)"}). ` +
			`Routing never substitutes an effort level: name a level this model serves, or route to a model that serves ${thinking}.`,
		{ refusal: "effort", ...(origin.rule ? { rule: origin.rule } : {}) },
	);
}

/**
 * The rule above as a **predicate**, so a diagnosis and a refusal can never
 * drift apart (routing T5): `resolveModel` refuses with it, and doctor and the
 * startup nudge report with it.
 *
 * Returns the levels the model *does* serve when `thinking` is one it provably
 * cannot, and `undefined` in the three cases that are not a fault: the level is
 * served, the probe cannot tell (ignorance is never evidence), or the level is
 * inert on a model that does not reason and nobody explicitly asked for it.
 */
export function unserviceableEffort(
	model: string,
	thinking: ThinkingLevel,
	probe: ModelProbe,
	options: { explicit?: boolean } = {},
): ThinkingLevel[] | undefined {
	const supported = probe.supportedThinking?.(model);
	// No evidence is not a refusal: see `ModelProbe.supportedThinking`.
	if (!supported || supported.includes(thinking)) return undefined;
	if (options.explicit !== true && doesNotReason(supported)) return undefined;
	return supported;
}

/**
 * Does this model do effort at all? Both shapes of "no" count, and they must:
 *
 *  - `["off"]` — what `supportedThinkingFor` returns for `reasoning: false`;
 *  - `[]`      — reachable two ways, and neither is exotic. A model whose
 *    `thinkingLevelMap` marks **every** level `null` (including `off`) filters
 *    down to nothing, and `ModelProbe` is a public interface any caller may
 *    implement — the refusal message has had an `(none — this model does not
 *    reason)` branch since cp-ot3b precisely because an empty answer arrives.
 *
 * Treating `[]` as "this level is unsupported" rather than "no effort at all"
 * would refuse every profile-supplied level on such a model, which is the one
 * outcome this exemption exists to prevent: every shipped profile carries a
 * level, so that refusal grounds the worker before its lease.
 */
function doesNotReason(supported: ThinkingLevel[]): boolean {
	return supported.every((level) => level === "off");
}

// ---------------------------------------------------------------------------
// Reviewer routing (cp-reviewer-routing)
// ---------------------------------------------------------------------------

/**
 * Where ONE axis of a *reviewer's* routing came from. A reviewer has no task
 * text of its own to infer from — it reviews somebody else's job — so its axes
 * are the subject's, or they are not known at all.
 *
 *  - `inherited` — the subject job's own recorded routing named this axis
 *  - `unknown`   — the subject has no recorded routing for it (a job dispatched
 *                  before `routing` was recorded, or no fleet record at all)
 */
export type ReviewerInputSource = "inherited" | "unknown";

export interface ReviewerRoutingInputs {
	/** Absent means unknown: routing's standing default decides, and says so. */
	scope?: Scope;
	risk?: Risk;
	provenance: { scope: ReviewerInputSource; risk: ReviewerInputSource };
	/** How the subject itself came by those axes, when it recorded that. */
	subject?: { scope: RoutingProvenance; risk: RoutingProvenance };
}

/** A reviewer's resolved route: the decision that will spawn, and its inputs. */
export interface ReviewerRoute {
	decision: RoutingDecision;
	inputs: ReviewerRoutingInputs;
}

/**
 * The scope/risk a reviewer routes with: the subject job's, per axis.
 *
 * The defect this fixes: the three reviewer surfaces passed neither axis, so
 * every reviewer routed at the standing `S`/`low` default and a rubric row
 * scoped to large or risky work could not fire at all. Reviewing an L/high ship
 * job is L/high work — the reviewer reads that diff — so the subject's axes are
 * the reviewer's, even though the reviewer itself only reads.
 *
 * A missing axis is `unknown`, never a measurement. Routing still needs a value
 * to match a rubric row on, and that value is its own documented default
 * (`S`/`low`, applied in `pickModel`) — but nothing here claims a legacy subject
 * with no recorded routing was measured small or low-risk. A known-high risk is
 * always carried through; only an axis nobody ever recorded falls back.
 */
export function reviewerRoutingInputs(subject?: { routing?: JobRouting }): ReviewerRoutingInputs {
	const routing = subject?.routing;
	return {
		...(routing?.scope ? { scope: routing.scope } : {}),
		...(routing?.risk ? { risk: routing.risk } : {}),
		provenance: {
			scope: routing?.scope ? "inherited" : "unknown",
			risk: routing?.risk ? "inherited" : "unknown",
		},
		...(routing?.provenance ? { subject: routing.provenance } : {}),
	};
}

/**
 * The `routing_resolved` payload for one reviewer spawn: the decision that was
 * actually spawned (model, source, rule, effort) beside the inputs it was given
 * and where each of them came from. Recorded once, by the surface that spawned
 * it.
 *
 * `attempt` is **optional because not every surface has one**. The gate and the
 * diff review number their attempts and pass that number; the quality panel does
 * not — it runs at most one panel per job, and its unit of work is the voter
 * slot, which `surface` already names (`quality/verify-1`). Stamping a constant
 * `attempt: 1` there would invent a numbering the panel does not have, and a
 * reader comparing two voters' events would see a field that never varies and
 * conclude the wrong thing about what it identifies. An absent field says "this
 * surface does not number attempts"; a fabricated one says something false.
 */
export function reviewerRoutingEvent(
	input: { surface: string; attempt?: number } & ReviewerRoute,
): Record<string, unknown> {
	const { decision, inputs } = input;
	return {
		surface: input.surface,
		...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
		model: decision.model,
		source: decision.source,
		rule: decision.rule,
		// The effective effort, and — separately — the one a caller asked for. Two
		// fields because `RoutingDecision` has two, under the names the contract
		// gives them (`RoutingDecisionSchema`): `requested` is the *model* an
		// override named, `requested_thinking` the *effort*. Emitting only the first
		// left a reader who parses fields rather than the prose `line` unable to see
		// that an effort was asked for at all.
		...(decision.thinking ? { thinking: decision.thinking } : {}),
		...(decision.requested ? { requested: decision.requested } : {}),
		...(decision.requested_thinking ? { requested_thinking: decision.requested_thinking } : {}),
		// Which candidates were skipped to get here, when any were. A reviewer that
		// ran on a fallback says so in its own event, not only in the prose `line`.
		...(decision.attempted ? { attempted: decision.attempted } : {}),
		...(decision.capacity ? { capacity: decision.capacity } : {}),
		...(decision.quota ? { quota: decision.quota } : {}),
		// The axes routing was actually given: absent means unknown, which is what
		// `provenance` says. A default is never recorded as a measurement.
		...(inputs.scope ? { scope: inputs.scope } : {}),
		...(inputs.risk ? { risk: inputs.risk } : {}),
		provenance: inputs.provenance,
		...(inputs.subject ? { subject_provenance: inputs.subject } : {}),
		line: formatRoutingDecision(decision),
	};
}

/** The line dispatch prints and the fleet stores. */
export function formatRoutingDecision(decision: RoutingDecision): string {
	const parts = [`source=${decision.source}`, `model=${decision.model}`, `rule=${decision.rule}`];
	if (decision.thinking) parts.push(`thinking=${decision.thinking}`);
	if (decision.requested && decision.requested !== decision.model) parts.push(`requested=${decision.requested}`);
	// cp-ot3b: an effort that differs from the one asked for must be legible at a
	// glance. `thinking=high` after an operator asked for xhigh was previously
	// noticeable only to someone comparing the line against what they typed.
	if (decision.requested_thinking) {
		if (decision.requested_thinking !== decision.thinking) {
			parts.push(`requested_thinking=${decision.requested_thinking}`, "effort=NOT-HONOURED");
		} else {
			parts.push("effort=override");
		}
	}
	if (decision.quota) parts.push(formatQuota(decision.quota));
	if (decision.capacity) {
		parts.push(`capacity=${decision.capacity.source}:${boundedList(decision.capacity.scores.map(({ provider, score }) => `${provider}=${score}`), { max: 5, cap: 160, separator: "," })}`);
		if (decision.capacity.reason) parts.push(`reason=${decision.capacity.reason}`);
	}
	// pi-command-post-0a9: a fallback is legible at a glance or it is the silent
	// downgrade cp-eff refused. Bounded, because this line goes into findings and
	// events whose schemas cap their strings.
	if (decision.attempted && decision.attempted.length > 0) {
		const skipped = boundedList(
			decision.attempted.map((entry) => `${entry.model}(${entry.refusal})`),
			{ max: 8, cap: 160, separator: "," },
		);
		parts.push(`attempted=${skipped}`);
	}
	return parts.join(" ");
}
