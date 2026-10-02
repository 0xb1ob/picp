/**
 * T13 acceptance: the resolution table from command-post
 * reports/model-routing.md reproduced against the new config shape, and an
 * unavailable model falling back — or failing — *before* a lease exists.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	LAYOUT,
	type Risk,
	RISKS,
	type RoutingConfig,
	type RoutingDecision,
	type Scope,
	SCOPES,
	RoutingConfigSchema,
	RoutingDecisionSchema,
	SCHEMA_VERSION,
	type ThinkingLevel,
	THINKING_LEVELS,
	validate,
	type WorkerProfile,
} from "../src/contracts.ts";
import { CapacityReader } from "../src/capacity.ts";
import { resolveRoutingInputs } from "../src/dispatch.ts";
import { PROBE_COMBOS } from "../src/doctor.ts";
import { listProfiles, loadProfile } from "../src/profiles.ts";
import { scaffoldHome } from "../src/scaffold.ts";
// pi's own generated catalog — the same metadata `registryProbe` reads at
// runtime, imported by path because the package does not export it. A local file
// read: no network, no auth, no inference (pi-command-post-0a9).
import { MODELS } from "../node_modules/@earendil-works/pi-ai/dist/models.generated.js";
import {
	ALWAYS_AVAILABLE,
	computeRoutingNudge,
	DEFAULT_ROUTING_CONFIG,
	describeEffortDrift,
	type EffortDrift,
	effortPolicyDrift,
	formatRoutingDecision,
	isAllowed,
	loadRoutingConfig,
	matchesPattern,
	MAX_NUDGE_LINES,
	type ModelProbe,
	type PiModelLike,
	pickModel,
	registryProbe,
	resolveModel,
	resolveWithCapacity,
	shadowedRubricRows,
	splitModelRef,
	reviewerRoutingEvent,
	reviewerRoutingInputs,
	RoutingError,
	supportedThinkingFor,
	unserviceableEffort,
} from "../src/routing.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

function profileFor(role: "planner" | "implementer" | "gate-reviewer"): WorkerProfile {
	const name = role === "gate-reviewer" ? "gate-reviewer" : role;
	return loadProfile(PROFILES_DIR, name);
}

function probeFor(available: readonly string[]): ModelProbe {
	return { isAvailable: (model) => available.includes(model), available: () => [...available] };
}

/**
 * A shipped profile with its `fallbacks` dropped: the single-candidate shape.
 *
 * The shipped profiles carry a fallback ladder now (pi-command-post-0a9), and a
 * single-candidate source is a different, still-live contract — today's exact
 * refusal kinds and messages. Tests about that half say so with this, instead of
 * silently changing meaning the next time a profile gains a candidate.
 */
function withoutFallbacks(profile: WorkerProfile): WorkerProfile {
	const { fallbacks: _dropped, ...frontmatter } = profile.frontmatter;
	return { ...profile, frontmatter };
}

/** `provider/model-id` split back into the shape pi's registry hands out. */
function modelLike(ref: string, metadata: Omit<PiModelLike, "id" | "provider">): PiModelLike {
	const parts = splitModelRef(ref);
	assert.ok(parts, `${ref} is not a provider/model-id ref`);
	return { provider: parts.provider, id: parts.modelId, ...metadata };
}

/**
 * The ported rubric (reports/model-routing.md rows 1-8) expressed in the new
 * config shape. Row 0 (caller override) is rule 0 in resolution order; row 1
 * (gate operational retry) is an explicit override issued by the gate module,
 * not a rubric row — it depends on the previous attempt's cause, which is
 * gate state, not routing input.
 */
const PORTED_RUBRIC: RoutingConfig = {
	schema_version: SCHEMA_VERSION,
	allow: ["mock/*"],
	rubric: [
		{ id: "gate-reviewer", role: "gate-reviewer", model: "mock/composer-fast" },
		{ id: "research-ambiguous", role: "planner", scope: ["L"], model: "mock/grok-xhigh" },
		{ id: "research-bounded", role: "planner", scope: ["S", "M"], model: "mock/grok-high-fast" },
		{ id: "risky-ship", role: "implementer", risk: "high", model: "mock/grok-high" },
		{ id: "small-ship", role: "implementer", scope: ["S"], risk: "low", model: "mock/composer-fast" },
		{ id: "medium-large-ship", role: "implementer", scope: ["M", "L"], risk: "low", model: "mock/grok-high" },
	],
};

test("the ported rubric table resolves row by row, first match wins", () => {
	const rows: Array<{
		role: "planner" | "implementer" | "gate-reviewer";
		scope?: "S" | "M" | "L";
		risk?: "low" | "high";
		expected: string;
		rule: string;
	}> = [
		{ role: "gate-reviewer", expected: "mock/composer-fast", rule: "gate-reviewer" },
		{ role: "planner", scope: "L", expected: "mock/grok-xhigh", rule: "research-ambiguous" },
		{ role: "planner", scope: "S", expected: "mock/grok-high-fast", rule: "research-bounded" },
		{ role: "planner", scope: "M", expected: "mock/grok-high-fast", rule: "research-bounded" },
		{ role: "implementer", scope: "S", risk: "high", expected: "mock/grok-high", rule: "risky-ship" },
		{ role: "implementer", scope: "L", risk: "high", expected: "mock/grok-high", rule: "risky-ship" },
		{ role: "implementer", scope: "S", risk: "low", expected: "mock/composer-fast", rule: "small-ship" },
		{ role: "implementer", scope: "M", risk: "low", expected: "mock/grok-high", rule: "medium-large-ship" },
		{ role: "implementer", scope: "L", risk: "low", expected: "mock/grok-high", rule: "medium-large-ship" },
	];

	// The ported rubric covers core combinations. If this count drops, a combination
	// has been removed from the test and the suite must fail loudly.
	// Expected: 1 gate-reviewer + 3 planner combos + 5 implementer combos = 9 total.
	assert.equal(rows.length, 9, "rubric coverage regression: expected 9 combinations tested");

	let resolvedCount = 0;
	for (const row of rows) {
		const decision = resolveModel(
			{
				profile: profileFor(row.role),
				jobId: "cp-x",
				project: "demo",
				kind: row.role === "implementer" ? "ship" : "research",
				...(row.scope ? { scope: row.scope } : {}),
				...(row.risk ? { risk: row.risk } : {}),
			},
			PORTED_RUBRIC,
			ALWAYS_AVAILABLE,
		);
		assert.equal(
			decision.model,
			row.expected,
			`${row.role} scope=${row.scope ?? "-"} risk=${row.risk ?? "-"} resolved ${decision.model}`,
		);
		assert.equal(decision.rule, row.rule);
		assert.equal(decision.source, "rubric");
		resolvedCount++;
	}
	// Ensure the loop actually executed all rows (guard against missing loop body execution)
	assert.equal(resolvedCount, 9, "all 9 rubric combinations must be resolved");

	// ported defaults: scope S, risk low
	const defaults = resolveModel(
		{ profile: profileFor("implementer"), jobId: "cp-x", project: "demo", kind: "ship" },
		PORTED_RUBRIC,
		ALWAYS_AVAILABLE,
	);
	assert.equal(defaults.rule, "small-ship");
});

test("resolution order: override > rubric > profile, and project narrows a row", () => {
	// cp-cxt: pins are gone. A per-repo policy is a rubric row with `project`,
	// which means it still competes on scope/risk instead of short-circuiting them.
	const config: RoutingConfig = {
		...PORTED_RUBRIC,
		rubric: [
			{ id: "demo-research", role: "planner", project: "demo", model: "mock/project-row" },
			...PORTED_RUBRIC.rubric,
		],
	};
	const base = { profile: profileFor("planner"), jobId: "cp-x", project: "demo", kind: "research" as const };

	// 1. an explicit override still wins everything: it is the one-off exception,
	//    made by the person making it.
	const override = resolveModel({ ...base, override: "mock/chosen" }, config, ALWAYS_AVAILABLE);
	assert.equal(override.source, "override");
	assert.equal(override.model, "mock/chosen");

	// 2. the project row applies in that repo …
	const inDemo = resolveModel(base, config, ALWAYS_AVAILABLE);
	assert.equal(inDemo.source, "rubric");
	assert.equal(inDemo.rule, "demo-research");
	assert.equal(inDemo.model, "mock/project-row");

	// … and nowhere else: another repo falls through to the size-based rows.
	const elsewhere = resolveModel({ ...base, project: "elsewhere" }, config, ALWAYS_AVAILABLE);
	assert.equal(elsewhere.source, "rubric");
	assert.equal(elsewhere.rule, "research-bounded");

	// 3. order is narrow-to-broad, first match wins: the same row placed after the
	//    broad ones never fires.
	const shadowed: RoutingConfig = {
		...PORTED_RUBRIC,
		rubric: [...PORTED_RUBRIC.rubric, { id: "demo-research", role: "planner", project: "demo", model: "mock/project-row" }],
	};
	assert.equal(resolveModel(base, shadowed, ALWAYS_AVAILABLE).rule, "research-bounded");

	// 4. no rows at all: the profile default is the answer.
	const bare: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["*/*"], rubric: [] };
	const fromProfile = resolveModel(base, bare, ALWAYS_AVAILABLE);
	assert.equal(fromProfile.source, "profile");
	assert.equal(fromProfile.model, profileFor("planner").frontmatter.model);
});

test("the allowlist is a fail-closed gate on every source", () => {
	const strict: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["mock/allowed*"], rubric: [] };
	const base = { profile: withoutFallbacks(profileFor("planner")), jobId: "cp-x", project: "demo", kind: "research" as const };

	assert.throws(() => pickModel({ ...base, override: "mock/forbidden" }, strict), /allowlist refuses/);
	assert.throws(
		() => pickModel(base, { ...strict, rubric: [{ id: "r", role: "planner", model: "mock/forbidden" }] }),
		/rubric r names/,
	);
	// the profile default is not exempt either
	assert.throws(() => pickModel(base, strict), /profile planner names/);

	// pi-command-post-0a9: with a candidate list the allowlist is still a gate on
	// every candidate — it skips instead of throwing, and a list with nothing left
	// is refused as `exhausted`, naming the allowlist for each one. Fail-closed is
	// the property, not the exception type.
	const withFallbacks = { ...base, profile: profileFor("planner") };
	const exhausted = refusalOf(() => resolveModel(withFallbacks, strict, ALWAYS_AVAILABLE));
	assert.equal(exhausted.refusal, "exhausted");
	for (const candidate of [
		profileFor("planner").frontmatter.model,
		...(profileFor("planner").frontmatter.fallbacks ?? []),
	]) {
		assert.match(exhausted.message, new RegExp(`${candidate.replace(/[.]/g, "\\.")} \\(allowlist\\)`));
	}

	// an operator who writes allow: [] means it
	const nothing: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: [], rubric: [] };
	assert.throws(() => pickModel({ ...base, override: "mock/anything" }, nothing), /nothing is allowed/);
});

test("glob matching covers the shapes the allowlist actually uses", () => {
	assert.ok(matchesPattern("anthropic/*", "anthropic/claude-sonnet-5"));
	assert.ok(!matchesPattern("anthropic/*", "openai/gpt-5"));
	assert.ok(!matchesPattern("*/*", "bare-model-id"), "a ref without a provider is not a ref");
	assert.ok(matchesPattern("**", "anything/at/all"));
	assert.ok(matchesPattern("mock/exact-model", "mock/exact-model"));
	assert.ok(!matchesPattern("mock/exact-model", "mock/exact-model-2"));
	assert.ok(isAllowed(DEFAULT_ROUTING_CONFIG, "anthropic/claude-sonnet-5"));
});

test("an unavailable model is a refusal, not a quiet downgrade", () => {
	// A source with nothing to fall back to still refuses before the lease, so the
	// refusal costs a message; an automatic downgrade would cost a job run on a
	// model nobody chose, visible only in the run log (cp-eff, preserved for the
	// single-candidate case by pi-command-post-0a9).
	const profile = withoutFallbacks(profileFor("planner"));
	const config: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] };

	assert.throws(
		() => resolveModel({ profile, jobId: "cp-x", project: "demo", kind: "research" }, config, probeFor(["mock/other"])),
		/no available model for planner job cp-x/,
	);
	assert.throws(
		() => resolveModel({ profile, jobId: "cp-x", project: "demo", kind: "research" }, config, probeFor([])),
		/This route has no other candidate/,
	);

	// The reachable case is unchanged and says where the answer came from.
	const ok = resolveModel(
		{ profile, jobId: "cp-x", project: "demo", kind: "research" },
		config,
		probeFor([profile.frontmatter.model]),
	);
	assert.equal(ok.source, "profile");
	assert.equal(ok.model, profile.frontmatter.model);
});

test("a rubric row sets the effort level, and silence keeps the profile's", () => {
	// cp-eff: model and effort are one decision, so they live in one row.
	const profile = profileFor("implementer");
	const config: RoutingConfig = {
		schema_version: SCHEMA_VERSION,
		allow: ["**"],
		rubric: [
			{ id: "risky", role: "implementer", risk: "high", model: "mock/big", thinking: "xhigh" },
			{ id: "small", role: "implementer", scope: ["S"], model: "mock/small" },
		],
	};
	const base = { profile, jobId: "cp-x", project: "demo", kind: "ship" as const };
	const probe = probeFor(["mock/big", "mock/small", profile.frontmatter.model]);

	const risky = resolveModel({ ...base, risk: "high" }, config, probe);
	assert.equal(risky.model, "mock/big");
	assert.equal(risky.thinking, "xhigh", "the row's level wins");
	assert.match(formatRoutingDecision(risky), /thinking=xhigh/);

	// A row that names no level leaves the profile's in force: routing narrows
	// policy, it does not reset what it did not mention.
	const small = resolveModel({ ...base, scope: "S" }, config, probe);
	assert.equal(small.model, "mock/small");
	assert.equal(small.thinking, profile.frontmatter.thinking);

	// So does the profile default itself.
	const bare = resolveModel(base, { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] }, probe);
	assert.equal(bare.source, "profile");
	assert.equal(bare.thinking, profile.frontmatter.thinking);
});

// ---------------------------------------------------------------------------
// cp-ot3b: an explicit override carries the effort, and never downgrades it
// ---------------------------------------------------------------------------

/** A probe that also answers "which levels can this model serve?". */
function probeWithEfforts(models: Record<string, ThinkingLevel[]>): ModelProbe {
	return {
		isAvailable: (model) => model in models,
		available: () => Object.keys(models),
		supportedThinking: (model) => models[model],
	};
}

test("an override carries model AND effort, and both are honoured", () => {
	// The defect: `cp_dispatch` took a model and no effort, so an operator asking
	// for "fable at xhigh" got the model and the profile's `high`, silently.
	const profile = profileFor("planner");
	const config: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] };
	const base = { profile, jobId: "cp-x", project: "demo", kind: "research" as const };
	const probe = probeWithEfforts({ "mock/fable": [...THINKING_LEVELS] });

	const decision = resolveModel({ ...base, override: "mock/fable", thinking: "xhigh" }, config, probe);
	assert.equal(decision.model, "mock/fable");
	assert.equal(decision.source, "override");
	assert.equal(decision.thinking, "xhigh", "the effort the operator asked for, not the profile's");
	assert.equal(decision.requested_thinking, "xhigh");
	assert.notEqual(decision.thinking, profile.frontmatter.thinking, "the profile default must not win over an override");
	assert.match(formatRoutingDecision(decision), /thinking=xhigh effort=override/);

	// An effort override needs no model override: today's model at a different
	// effort is still an explicit instruction, and it outranks the rubric row.
	const withRubric: RoutingConfig = {
		schema_version: SCHEMA_VERSION,
		allow: ["**"],
		rubric: [{ id: "risky-any", role: "planner", risk: "high", model: "mock/fable", thinking: "high" }],
	};
	const effortOnly = resolveModel({ ...base, risk: "high", thinking: "xhigh" }, withRubric, probe);
	assert.equal(effortOnly.source, "rubric");
	assert.equal(effortOnly.rule, "risky-any", "the ladder's precedence is unchanged");
	assert.equal(effortOnly.model, "mock/fable");
	assert.equal(effortOnly.thinking, "xhigh", "the caller's effort outranks the row's");
});

test("an override with no effort keeps the profile's level, and claims nothing", () => {
	const profile = profileFor("planner");
	const config: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] };
	const probe = probeWithEfforts({ "mock/fable": [...THINKING_LEVELS] });

	const decision = resolveModel(
		{ profile, jobId: "cp-x", project: "demo", kind: "research", override: "mock/fable" },
		config,
		probe,
	);
	assert.equal(decision.thinking, profile.frontmatter.thinking, "the profile's level still stands");
	assert.equal(decision.requested_thinking, undefined, "nothing was requested, so nothing is claimed");
	assert.equal(decision.rule, "explicit override");
});

test("the EFFECTIVE effort is capability-checked, whichever source named it (cp-reviewer-routing)", () => {
	// The defect: only an explicitly requested level was checked, so a rubric row
	// or a profile default the model cannot serve reached the spawn and ran at
	// whatever the provider substituted — the silent downgrade cp-ot3b refused for
	// overrides, arriving through the other two doors.
	const profile = profileFor("planner");
	const level = profile.frontmatter.thinking as ThinkingLevel;
	const reasoningButCapped = THINKING_LEVELS.filter((each) => each !== level && each !== "off");
	const probe = probeWithEfforts({ "mock/capped": ["off", ...reasoningButCapped] });
	const base = { profile, jobId: "cp-x", project: "demo", kind: "research" as const };

	// From the profile.
	assert.throws(
		() => resolveModel({ ...base, override: "mock/capped" }, { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] }, probe),
		(error: RoutingError) => {
			assert.ok(error instanceof RoutingError);
			assert.match(error.message, new RegExp(`thinking=${level}`), "the refusal names the level that would have spawned");
			assert.match(error.message, /profile planner asks for/, "and which source named it");
			return true;
		},
	);

	// From a rubric row, with no override in sight.
	const rubric: RoutingConfig = {
		schema_version: SCHEMA_VERSION,
		allow: ["**"],
		rubric: [{ id: "reviews", role: "planner", model: "mock/capped", thinking: level }],
	};
	assert.throws(
		() => resolveModel(base, rubric, probe),
		(error: RoutingError) => {
			assert.match(error.message, /rubric row reviews asks for/);
			return true;
		},
	);

	// A level the row DOES name and the model DOES serve is untouched.
	const serviceable: RoutingConfig = {
		schema_version: SCHEMA_VERSION,
		allow: ["**"],
		rubric: [{ id: "reviews", role: "planner", model: "mock/capped", thinking: reasoningButCapped[0] as ThinkingLevel }],
	};
	assert.equal(resolveModel(base, serviceable, probe).thinking, reasoningButCapped[0]);

	// Ignorance is still not evidence: a probe that cannot answer refuses nothing.
	assert.equal(
		resolveModel({ ...base, override: "mock/unknown-support" }, { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] }, probeFor(["mock/unknown-support"])).thinking,
		level,
	);
});

test("a model that does not reason keeps its inert-level semantics, except when a human asks", () => {
	// pi treats an effort level on a `reasoning: false` model as inert
	// (contracts §RoutingRule.thinking), and every profile carries a level. If an
	// inherited level refused there, no worker could route to such a model at all.
	const profile = profileFor("gate-reviewer");
	const probe = probeWithEfforts({ "mock/no-reasoning": ["off"] });
	const config: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] };
	const base = { profile, jobId: "cp-x", project: "demo", kind: "research" as const };

	const inherited = resolveModel({ ...base, override: "mock/no-reasoning" }, config, probe);
	assert.equal(inherited.thinking, profile.frontmatter.thinking, "inert, not an error");

	// An explicit ask is a person expecting effort they would silently not get.
	assert.throws(
		() => resolveModel({ ...base, override: "mock/no-reasoning", thinking: "high" }, config, probe),
		/available: off/,
	);
});

test("an EMPTY supported-effort answer is 'no effort at all', not 'this level is unsupported'", () => {
	// Review finding (1). `[]` is not a hypothetical: `supportedThinkingFor`
	// returns it for a model whose `thinkingLevelMap` marks every level `null`
	// (including `off`), and `ModelProbe` is a public interface any caller may
	// implement. Read as "this level is unsupported", it would refuse every
	// profile-supplied level — and every shipped profile supplies one, so the
	// worker would be grounded before its lease for a model pi runs happily.
	assert.deepEqual(
		supportedThinkingFor({ id: "m", reasoning: true, thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map((level) => [level, null])) }),
		[],
		"a map that nulls every level, `off` included, leaves nothing — this is how [] is reached",
	);

	const config: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] };
	const probe = probeWithEfforts({ "mock/nothing": [] });
	for (const role of ["planner", "implementer", "gate-reviewer"] as const) {
		const profile = profileFor(role);
		const decision = resolveModel(
			{ profile, jobId: "cp-x", project: "demo", kind: "research", override: "mock/nothing" },
			config,
			probe,
		);
		assert.equal(decision.thinking, profile.frontmatter.thinking, `${role}: the profile's level stays inert, not refused`);
	}

	// A rubric row's level is inert there too — same reason, different source.
	const rubric: RoutingConfig = {
		schema_version: SCHEMA_VERSION,
		allow: ["**"],
		rubric: [{ id: "nothing", role: "planner", model: "mock/nothing", thinking: "xhigh" }],
	};
	assert.equal(
		resolveModel({ profile: profileFor("planner"), jobId: "cp-x", project: "demo", kind: "research" }, rubric, probe).thinking,
		"xhigh",
	);

	// And the human's own ask is still refused, with the message that branch has
	// carried since cp-ot3b.
	assert.throws(
		() =>
			resolveModel(
				{ profile: profileFor("planner"), jobId: "cp-x", project: "demo", kind: "research", override: "mock/nothing", thinking: "high" },
				config,
				probe,
			),
		/none — this model does not reason/,
	);
});

test("an effort the model cannot serve is refused, naming the ask and the alternatives", () => {
	const profile = profileFor("planner");
	const config: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] };
	const base = { profile, jobId: "cp-x", project: "demo", kind: "research" as const };
	const probe = probeWithEfforts({
		"mock/no-xhigh": ["off", "minimal", "low", "medium", "high"],
		"mock/dumb": ["off"],
		"mock/all": [...THINKING_LEVELS],
	});

	assert.throws(
		() => resolveModel({ ...base, override: "mock/no-xhigh", thinking: "xhigh" }, config, probe),
		(error: RoutingError) => {
			assert.ok(error instanceof RoutingError);
			assert.match(error.message, /thinking=xhigh/, "the refusal names what was asked");
			assert.match(error.message, /which mock\/no-xhigh cannot serve/);
			assert.match(error.message, /available: off, minimal, low, medium, high/, "and what is available");
			assert.match(error.message, /never substitutes an effort level/);
			return true;
		},
	);

	// A model that does not reason at all serves no effort but "off": inert is the
	// silent downgrade this refuses.
	assert.throws(() => resolveModel({ ...base, override: "mock/dumb", thinking: "high" }, config, probe), /available: off/);

	// The serviceable case is not disturbed.
	assert.equal(resolveModel({ ...base, override: "mock/all", thinking: "max" }, config, probe).thinking, "max");

	// A probe that cannot tell is ignorance, not evidence: the override is honoured.
	const blind = probeFor(["mock/unknown-support"]);
	assert.equal(
		resolveModel({ ...base, override: "mock/unknown-support", thinking: "xhigh" }, config, blind).thinking,
		"xhigh",
	);
});

test("a differing effort is visible in the routing line", () => {
	// The routing line is the only place an effort decision shows up, so a level
	// that is not the one asked for must say so in words, not by being compared
	// character by character against what the operator typed.
	const downgraded = formatRoutingDecision({
		model: "anthropic/claude-fable-5-1",
		source: "override",
		rule: "explicit override",
		thinking: "high",
		requested_thinking: "xhigh",
	});
	assert.match(downgraded, /thinking=high/);
	assert.match(downgraded, /requested_thinking=xhigh/);
	assert.match(downgraded, /effort=NOT-HONOURED/);

	const honoured = formatRoutingDecision({
		model: "anthropic/claude-fable-5-1",
		source: "override",
		rule: "explicit override (model+effort)",
		thinking: "xhigh",
		requested_thinking: "xhigh",
	});
	assert.match(honoured, /thinking=xhigh effort=override/);
	assert.ok(!honoured.includes("NOT-HONOURED"));

	// Nothing requested, nothing claimed: the pre-cp-ot3b line is unchanged.
	assert.equal(
		formatRoutingDecision({ model: "mock/m", source: "rubric", rule: "r", thinking: "medium" }),
		"source=rubric model=mock/m rule=r thinking=medium",
	);
});

test("effort support is read from pi's own model metadata", () => {
	assert.deepEqual(supportedThinkingFor({ id: "m", reasoning: false }), ["off"]);
	assert.deepEqual(supportedThinkingFor({ id: "m", reasoning: true }), [...THINKING_LEVELS], "no map means provider defaults");
	assert.deepEqual(
		supportedThinkingFor({ id: "m", reasoning: true, thinkingLevelMap: { xhigh: null, max: null, high: "high" } }),
		["off", "minimal", "low", "medium", "high"],
		"null marks a level the model does not support",
	);

	const probe = registryProbe({
		find: (provider, modelId) =>
			provider === "mock" && modelId === "capped" ? { provider, id: modelId, reasoning: true, thinkingLevelMap: { max: null } } : undefined,
		hasConfiguredAuth: () => true,
	});
	assert.ok(!probe.supportedThinking?.("mock/capped")?.includes("max"));
	assert.ok(probe.supportedThinking?.("mock/capped")?.includes("xhigh"));
	assert.equal(probe.supportedThinking?.("mock/absent"), undefined, "unknown model = no evidence");
	assert.equal(probe.supportedThinking?.("no-provider"), undefined);
});

// ---------------------------------------------------------------------------
// cp-reviewer-routing: a reviewer routes on its SUBJECT's axes
// ---------------------------------------------------------------------------

test("reviewer inputs are the subject's axes, per axis, and a missing one is unknown", () => {
	// Inherited: both axes come from the subject's own recorded routing.
	const inherited = reviewerRoutingInputs({
		routing: { scope: "L", risk: "high", inferred: false, provenance: { scope: "explicit", risk: "assessed" } },
	});
	assert.deepEqual(inherited.scope, "L");
	assert.deepEqual(inherited.risk, "high");
	assert.deepEqual(inherited.provenance, { scope: "inherited", risk: "inherited" });
	assert.deepEqual(inherited.subject, { scope: "explicit", risk: "assessed" }, "the subject's own provenance travels too");

	// Legacy: a job dispatched before routing was recorded claims nothing. The
	// standing S/low default still decides the route (pickModel), but no record
	// anywhere says this subject was MEASURED small or low-risk.
	const legacy = reviewerRoutingInputs({});
	assert.equal(legacy.scope, undefined);
	assert.equal(legacy.risk, undefined);
	assert.deepEqual(legacy.provenance, { scope: "unknown", risk: "unknown" });
	assert.equal(legacy.subject, undefined);
	assert.deepEqual(reviewerRoutingInputs(), legacy, "no fleet record at all is the same fact");

	// Half known is half claimed: a known-high risk is never overridden by the
	// other axis being missing.
	const half = reviewerRoutingInputs({ routing: { risk: "high", inferred: true } });
	assert.equal(half.scope, undefined);
	assert.equal(half.risk, "high");
	assert.deepEqual(half.provenance, { scope: "unknown", risk: "inherited" });
});

test("the recorded reviewer decision names the model, the effort and the inputs it was given", () => {
	const event = reviewerRoutingEvent({
		surface: "gate",
		attempt: 2,
		decision: { model: "mock/big", source: "rubric", rule: "reviews-large", thinking: "medium" },
		inputs: reviewerRoutingInputs({
			routing: { scope: "L", risk: "high", inferred: false, provenance: { scope: "explicit", risk: "inferred" } },
		}),
	});
	assert.deepEqual(event, {
		surface: "gate",
		attempt: 2,
		model: "mock/big",
		source: "rubric",
		rule: "reviews-large",
		thinking: "medium",
		scope: "L",
		risk: "high",
		provenance: { scope: "inherited", risk: "inherited" },
		subject_provenance: { scope: "explicit", risk: "inferred" },
		line: "source=rubric model=mock/big rule=reviews-large thinking=medium",
	});

	// An unknown axis is absent from the record, never defaulted into it.
	const legacy = reviewerRoutingEvent({
		surface: "review",
		attempt: 1,
		decision: { model: "mock/small", source: "profile", rule: "profile gate-reviewer" },
		inputs: reviewerRoutingInputs({}),
	});
	assert.equal(legacy.scope, undefined);
	assert.equal(legacy.risk, undefined);
	assert.deepEqual(legacy.provenance, { scope: "unknown", risk: "unknown" });

	// Nothing was requested in either case, so neither request field is claimed.
	// (`in`, not `=== undefined`: the point is that the key is absent, and the
	// deepEqual above already pins the whole shape of `event`.)
	assert.ok(!("requested" in event) && !("requested_thinking" in event));
	assert.ok(!("requested" in legacy) && !("requested_thinking" in legacy));
});

test("the recorded decision carries the requested effort under the contract's own field name", () => {
	// Review finding (attempt 2). `RoutingDecision` has TWO request fields
	// (`RoutingDecisionSchema`): `requested` is the model an override named,
	// `requested_thinking` the effort. The event emitted only the first, so a
	// reader parsing fields — rather than the prose `line` — could not see that an
	// effort had been asked for at all.
	const decision: RoutingDecision = {
		model: "mock/fable",
		source: "override",
		rule: "explicit override (model+effort)",
		thinking: "xhigh",
		requested: "mock/fable",
		requested_thinking: "xhigh",
	};
	const event = reviewerRoutingEvent({ surface: "gate", attempt: 1, decision, inputs: reviewerRoutingInputs({}) });

	// Effective and requested are separate facts, and both are present by name.
	assert.equal(event.thinking, "xhigh", "the effort that actually spawns");
	assert.equal(event.requested_thinking, "xhigh", "the effort that was asked for");
	assert.equal(event.requested, "mock/fable", "the model that was asked for");
	assert.ok("requested_thinking" in event, "the contract's name, not a near-miss like `requested`");
	assert.match(String(event.line), /thinking=xhigh effort=override/);

	// The model-only override: a requested model, and no claim about effort.
	const modelOnly = reviewerRoutingEvent({
		surface: "review",
		attempt: 3,
		decision: {
			model: "mock/fable",
			source: "override",
			rule: "explicit override",
			thinking: "high",
			requested: "mock/fable",
		},
		inputs: reviewerRoutingInputs({}),
	});
	assert.equal(modelOnly.thinking, "high", "the profile's level still spawned, and is still recorded");
	assert.equal(modelOnly.requested, "mock/fable");
	assert.equal(modelOnly.requested_thinking, undefined, "nothing asked, nothing claimed");
	assert.ok(!("requested_thinking" in modelOnly), "absent, never emitted as undefined");

	// End to end through the resolver, so the field cannot drift from what
	// `resolveModel` actually produces.
	const resolved = resolveModel(
		{
			profile: profileFor("gate-reviewer"),
			jobId: "cp-x",
			project: "demo",
			kind: "research",
			override: "mock/all",
			thinking: "max",
		},
		{ schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] },
		probeWithEfforts({ "mock/all": [...THINKING_LEVELS] }),
	);
	const live = reviewerRoutingEvent({ surface: "gate", attempt: 1, decision: resolved, inputs: reviewerRoutingInputs({}) });
	assert.equal(live.thinking, "max");
	assert.equal(live.requested_thinking, "max");
});

test("a reviewer routed on inherited axes fires the narrow row the subject would have", () => {
	const config: RoutingConfig = {
		schema_version: SCHEMA_VERSION,
		allow: ["**"],
		rubric: [
			{ id: "reviews-large", role: "gate-reviewer", scope: ["L"], risk: "high", model: "mock/big", thinking: "medium" },
			{ id: "reviews-default", role: "gate-reviewer", model: "mock/small", thinking: "low" },
		],
	};
	const profile = profileFor("gate-reviewer");
	const base = { profile, jobId: "cp-x", project: "demo", kind: "research" as const };
	const probe = probeWithEfforts({ "mock/big": [...THINKING_LEVELS], "mock/small": [...THINKING_LEVELS] });

	const subject = reviewerRoutingInputs({
		routing: { scope: "L", risk: "high", inferred: false, provenance: { scope: "assessed", risk: "assessed" } },
	});
	const scoped = resolveModel({ ...base, scope: subject.scope, risk: subject.risk }, config, probe);
	assert.equal(scoped.rule, "reviews-large");
	assert.equal(scoped.model, "mock/big");
	assert.equal(scoped.thinking, "medium", "the row's effort, not the profile's high");
	assert.notEqual(scoped.thinking, profile.frontmatter.thinking);

	// The pre-fix behaviour, kept as the contrast: no axes means the broad row.
	const unscoped = resolveModel(base, config, probe);
	assert.equal(unscoped.rule, "reviews-default");
});

test("nothing available fails loudly, before any lease could exist", () => {
	const config: RoutingConfig = { schema_version: SCHEMA_VERSION, allow: ["**"], rubric: [] };
	const request = { jobId: "cp-x", project: "demo", kind: "ship" as const };

	// One candidate: today's message, unchanged.
	assert.throws(
		() => resolveModel({ ...request, profile: withoutFallbacks(profileFor("implementer")) }, config, probeFor([])),
		(error: RoutingError) => {
			assert.match(error.message, /no available model for implementer job cp-x/);
			assert.match(error.message, /resolvable auth/);
			return true;
		},
	);

	// A ladder with every rung down is just as loud, and names every rung.
	const profile = profileFor("implementer");
	assert.throws(
		() => resolveModel({ ...request, profile }, config, probeFor([])),
		(error: RoutingError) => {
			assert.equal(error.refusal, "exhausted");
			assert.match(error.message, /no usable model for implementer job cp-x/);
			for (const candidate of [profile.frontmatter.model, ...(profile.frontmatter.fallbacks ?? [])]) {
				assert.ok(error.message.includes(`${candidate} (availability)`), `${candidate} must be named`);
			}
			return true;
		},
	);
});

test("availability means pi knows the model AND its auth resolves", () => {
	const models = [
		{ provider: "mock", id: "with-auth" },
		{ provider: "mock", id: "no-auth" },
	];
	const probe = registryProbe({
		find: (provider, modelId) => models.find((model) => model.provider === provider && model.id === modelId),
		hasConfiguredAuth: (model) => (model as { id?: string }).id === "with-auth",
		getAvailable: () => [models[0] as { provider: string; id: string }],
	});
	assert.equal(probe.isAvailable("mock/with-auth"), true);
	assert.equal(probe.isAvailable("mock/no-auth"), false, "known but unauthenticated is unavailable");
	assert.equal(probe.isAvailable("mock/unknown"), false);
	assert.equal(probe.isAvailable("no-provider"), false);
	assert.deepEqual(probe.available?.(), ["mock/with-auth"]);
});

test("routing config: missing file is permissive, present file is validated", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.deepEqual(loadRoutingConfig(home.path), DEFAULT_ROUTING_CONFIG);

	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const file = join(home.path, LAYOUT.routingFile);
	writeFileSync(file, JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [] }));
	assert.deepEqual(loadRoutingConfig(home.path).allow, ["mock/*"]);

	writeFileSync(file, "{ nope");
	assert.throws(() => loadRoutingConfig(home.path), /not valid JSON/);

	writeFileSync(file, JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "r" }] }));
	assert.throws(() => loadRoutingConfig(home.path), /violates the routing contract/);

	// cp-cxt: a config from the two-mechanism era is refused with the migration,
	// not with a schema message about an unexpected property.
	writeFileSync(
		file,
		JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [], pins: [{ match: {}, model: "mock/x" }] }),
	);
	assert.throws(() => loadRoutingConfig(home.path), /still has `pins`/);
	assert.throws(() => loadRoutingConfig(home.path), /Express each pin as a rubric row/);
});

// ---------------------------------------------------------------------------
// cp-default-rubric: the shipped default, defaults/routing.default.json
// ---------------------------------------------------------------------------

function loadShippedDefault(): RoutingConfig {
	const raw = JSON.parse(readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8"));
	const result = validate<RoutingConfig>(RoutingConfigSchema, raw);
	assert.ok(result.ok, `defaults/routing.default.json violates RoutingConfigSchema: ${!result.ok ? result.errors.join("; ") : ""}`);
	return (result as { ok: true; value: RoutingConfig }).value;
}

test("the shipped default rubric parses and validates against RoutingConfigSchema", () => {
	const config = loadShippedDefault();
	assert.equal(config.schema_version, SCHEMA_VERSION);
	assert.deepEqual(config.allow, ["*/*"]);
	// cp-routing-t4: six rows. The broad low-risk `research` catch-all is gone, so
	// ordinary planning falls through to the planner profile's own default.
	assert.equal(config.rubric.length, 6);
	assert.ok(
		!config.rubric.some((rule) => rule.role === "planner" && rule.risk === undefined && rule.scope === undefined),
		"no broad planner catch-all may return to the shipped template",
	);
	// Every model named is one this machine's `pi --list-models` actually has;
	// `claude-fable-5` is deliberately unused, so it must never appear here.
	for (const rule of config.rubric) {
		assert.match(rule.model, /^anthropic\/claude-(opus|sonnet|haiku)-/);
		assert.ok(!rule.model.includes("fable"), `${rule.id} must not name claude-fable-5`);
	}
});

test("the shipped default rubric: every (role, scope, risk) combination resolves as documented", () => {
	const config = loadShippedDefault();
	const OPUS = "anthropic/claude-opus-5-5";
	const SONNET = "anthropic/claude-sonnet-5-5";

	const rows: Array<{
		role: "planner" | "implementer" | "gate-reviewer";
		scope?: "S" | "M" | "L";
		risk?: "low" | "high";
		model: string;
		thinking: string;
		rule: string;
	}> = [
		// planner: risk high wins regardless of scope.
		{ role: "planner", risk: "high", scope: "S", model: OPUS, thinking: "xhigh", rule: "risky-any" },
		{ role: "planner", risk: "high", scope: "M", model: OPUS, thinking: "xhigh", rule: "risky-any" },
		{ role: "planner", risk: "high", scope: "L", model: OPUS, thinking: "xhigh", rule: "risky-any" },
		// planner, risk low: scope L is its own row. S/M no longer match any row —
		// they are covered by the profile-default test below (cp-routing-t4).
		{ role: "planner", risk: "low", scope: "L", model: OPUS, thinking: "high", rule: "research-big" },
		// implementer: risk high wins regardless of scope.
		{ role: "implementer", risk: "high", scope: "S", model: OPUS, thinking: "high", rule: "risky-ship" },
		{ role: "implementer", risk: "high", scope: "M", model: OPUS, thinking: "high", rule: "risky-ship" },
		{ role: "implementer", risk: "high", scope: "L", model: OPUS, thinking: "high", rule: "risky-ship" },
		// implementer, risk low: M/L share "big-ship", S is "small-ship".
		{ role: "implementer", risk: "low", scope: "M", model: OPUS, thinking: "medium", rule: "big-ship" },
		{ role: "implementer", risk: "low", scope: "L", model: OPUS, thinking: "medium", rule: "big-ship" },
		{ role: "implementer", risk: "low", scope: "S", model: SONNET, thinking: "high", rule: "small-ship" },
		// gate-reviewer: one row, scope/risk irrelevant.
		{ role: "gate-reviewer", scope: "S", risk: "low", model: OPUS, thinking: "high", rule: "reviews" },
		{ role: "gate-reviewer", scope: "L", risk: "high", model: OPUS, thinking: "high", rule: "reviews" },
	];

	// The rubric must cover at least all core combinations that still resolve from
	// a row. If this count drops, a combination has been removed and the suite must
	// fail loudly. Expected: 3 planner high-risk + 1 planner L/low + 3 implementer
	// high-risk + 3 implementer low-risk + 1 gate-reviewer = 11 core; plus 1
	// duplicate to verify gate-reviewer ignores scope/risk = 12 total. Planner
	// S/M low-risk is deliberately absent: it resolves from the profile now.
	assert.equal(rows.length, 12, "rubric coverage regression: expected 12 combinations tested");

	let resolvedCount = 0;
	for (const row of rows) {
		const decision = resolveModel(
			{
				profile: profileFor(row.role),
				jobId: "cp-x",
				project: "demo",
				kind: row.role === "implementer" ? "ship" : "research",
				...(row.scope ? { scope: row.scope } : {}),
				...(row.risk ? { risk: row.risk } : {}),
			},
			config,
			ALWAYS_AVAILABLE,
		);
		assert.equal(
			decision.model,
			row.model,
			`${row.role} scope=${row.scope ?? "-"} risk=${row.risk ?? "-"} resolved ${decision.model}, expected ${row.model}`,
		);
		assert.equal(decision.thinking, row.thinking, `${row.rule}: expected thinking=${row.thinking}`);
		assert.equal(decision.rule, row.rule);
		assert.equal(decision.source, "rubric");
		resolvedCount++;
	}
	// Ensure the loop actually executed all rows (guard against missing loop body execution)
	assert.equal(resolvedCount, 12, "all 12 rubric combinations must be resolved");
});

// ---------------------------------------------------------------------------
// Review finding (2): widening the effort check from `requested` to `effective`
// touched EVERY dispatch, not only reviewer spawns. Ordinary planner/implementer
// routing has to keep resolving — with the shipped profiles, whose own
// `thinking:` is now checked where it never was before.
// ---------------------------------------------------------------------------

/**
 * A probe over pi-shaped metadata: `reasoning`, and a `thinkingLevelMap` where
 * `null` marks an unsupported level. Built through `registryProbe` on purpose,
 * so the test exercises the same reader production uses.
 */
function metadataProbe(models: Record<string, PiModelLike>): ModelProbe {
	return registryProbe({
		find: (provider, modelId) => models[`${provider}/${modelId}`],
		hasConfiguredAuth: () => true,
		getAvailable: () => Object.values(models),
	});
}

test("ordinary (non-reviewer) routing still resolves with the shipped profiles and rubric", () => {
	const config = loadShippedDefault();
	const shipped = [...new Set(config.rubric.map((rule) => rule.model))];
	const profiles = ["planner", "implementer", "gate-reviewer", "qa"].map((name) => loadProfile(PROFILES_DIR, name));
	for (const profile of profiles) {
		assert.ok(profile.frontmatter.thinking, `${profile.frontmatter.name} must supply an effort for this test to mean anything`);
	}
	const everyModel = [...new Set([...shipped, ...profiles.map((profile) => profile.frontmatter.model)])];

	/** Every (profile, scope, risk) an ordinary dispatch can present. */
	const combinations = profiles.flatMap((profile) =>
		(SCOPES as readonly Scope[]).flatMap((scope) =>
			(RISKS as readonly Risk[]).map((risk) => ({ profile, scope, risk })),
		),
	);
	assert.equal(combinations.length, 24, "4 profiles x 3 scopes x 2 risks");

	const probes: Array<{ what: string; probe: ModelProbe }> = [
		// 1. A registry that reasons and maps every level: the ordinary case.
		{
			what: "full support",
			probe: metadataProbe(Object.fromEntries(everyModel.map((ref) => [ref, modelLike(ref, { reasoning: true })]))),
		},
		// 2. `reasoning: false` — what the mock provider and any non-thinking model
		//    report. Every shipped profile still supplies an effort here.
		{
			what: "reasoning: false",
			probe: metadataProbe(Object.fromEntries(everyModel.map((ref) => [ref, modelLike(ref, { reasoning: false })]))),
		},
		// 3. Every level nulled, `off` included — the `[]` answer of finding (1).
		{
			what: "no level serviceable",
			probe: metadataProbe(
				Object.fromEntries(
					everyModel.map((ref) => [
						ref,
						modelLike(ref, {
							reasoning: true,
							thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map((level) => [level, null])),
						}),
					]),
				),
			),
		},
		// 4. A probe with no metadata at all: ignorance, honoured as before.
		{ what: "no metadata", probe: probeFor(everyModel) },
	];

	for (const { what, probe } of probes) {
		for (const { profile, scope, risk } of combinations) {
			const decision = resolveModel(
				{
					profile,
					jobId: "cp-x",
					project: "demo",
					kind: profile.frontmatter.role === "implementer" ? "ship" : "research",
					scope,
					risk,
				},
				config,
				probe,
			);
			// The level is unchanged by the check: it is validated, never substituted.
			const expected =
				decision.source === "rubric"
					? (config.rubric.find((rule) => rule.id === decision.rule)?.thinking ?? profile.frontmatter.thinking)
					: profile.frontmatter.thinking;
			assert.equal(
				decision.thinking,
				expected,
				`${what}: ${profile.frontmatter.name} ${scope}/${risk} resolved thinking=${decision.thinking}`,
			);
		}
	}
});

test("a shipped profile's own effort IS checked now — and refuses on evidence, naming the profile", () => {
	// The other half of finding (2): the widening must actually bite on a model
	// that reasons and cannot serve the level, or it is only a no-op.
	const config = loadShippedDefault();
	// Single-candidate on purpose: this is about the *effort* gate naming the
	// profile, and a ladder would (correctly) skip to the next candidate instead.
	const planner = withoutFallbacks(loadProfile(PROFILES_DIR, "planner"));
	const level = planner.frontmatter.thinking as ThinkingLevel;
	const probe = metadataProbe({
		[planner.frontmatter.model]: modelLike(planner.frontmatter.model, {
			reasoning: true,
			thinkingLevelMap: { [level]: null },
		}),
	});
	// scope S / risk low: no shipped row matches a planner there, so the decision
	// (and the effort) is the profile's own.
	assert.throws(
		() => resolveModel({ profile: planner, jobId: "cp-x", project: "demo", kind: "research", scope: "S", risk: "low" }, config, probe),
		(error: RoutingError) => {
			assert.ok(error instanceof RoutingError);
			assert.match(error.message, new RegExp(`profile planner asks for thinking=${level}`));
			return true;
		},
	);
});

// ---------------------------------------------------------------------------
// cp-routing-t4: ordinary QA and ordinary planning separate through the
// *profiles*, not through a new routing dimension. No model override is passed
// here — an override would mask which source actually decided.
// ---------------------------------------------------------------------------

test("shipped default: ordinary QA and ordinary planning resolve from their own profile", () => {
	const config = loadShippedDefault();
	const qa = loadProfile(PROFILES_DIR, "qa");
	const planner = loadProfile(PROFILES_DIR, "planner");

	// The two profiles share a role and (today) a model, so equal model names
	// prove nothing about the source. `source`/`rule` are what prove it.
	const qaDecision = resolveModel(
		{ profile: qa, jobId: "cp-q", project: "demo", kind: "research", scope: "S", risk: "low" },
		config,
		ALWAYS_AVAILABLE,
	);
	assert.equal(qaDecision.source, "profile");
	assert.equal(qaDecision.rule, "profile qa");
	assert.equal(qaDecision.model, qa.frontmatter.model);
	assert.equal(qaDecision.thinking, "low");

	for (const scope of ["S", "M"] as const) {
		const decision = resolveModel(
			{ profile: planner, jobId: "cp-p", project: "demo", kind: "research", scope, risk: "low" },
			config,
			ALWAYS_AVAILABLE,
		);
		assert.equal(decision.source, "profile", `planner ${scope}/low must fall through to the profile`);
		assert.equal(decision.rule, "profile planner");
		assert.equal(decision.model, planner.frontmatter.model);
		assert.equal(decision.thinking, "medium");
	}
});

test("shipped default: the QA/planner split is the profile's, proven with distinct fixture models", () => {
	const config = loadShippedDefault();
	// Distinct models, so an assertion cannot pass by coincidence when the two
	// shipped profiles happen to name the same one.
	const qa = loadProfile(PROFILES_DIR, "qa");
	const planner = loadProfile(PROFILES_DIR, "planner");
	const fixture = (profile: WorkerProfile, model: string, thinking: ThinkingLevel): WorkerProfile => ({
		...profile,
		frontmatter: { ...profile.frontmatter, model, thinking },
	});

	const qaDecision = resolveModel(
		{
			profile: fixture(qa, "anthropic/claude-haiku-4-5", "low"),
			jobId: "cp-q",
			project: "demo",
			kind: "research",
			scope: "S",
			risk: "low",
		},
		config,
		ALWAYS_AVAILABLE,
	);
	assert.equal(qaDecision.model, "anthropic/claude-haiku-4-5");
	assert.equal(qaDecision.thinking, "low");

	const plannerDecision = resolveModel(
		{
			profile: fixture(planner, "anthropic/claude-sonnet-5", "medium"),
			jobId: "cp-p",
			project: "demo",
			kind: "research",
			scope: "M",
			risk: "low",
		},
		config,
		ALWAYS_AVAILABLE,
	);
	assert.equal(plannerDecision.model, "anthropic/claude-sonnet-5");
	assert.equal(plannerDecision.thinking, "medium");
	assert.notEqual(qaDecision.model, plannerDecision.model);

	// The narrow planner rows still win over the profile, and an explicit
	// override still wins over everything.
	const big = resolveModel(
		{ profile: fixture(planner, "anthropic/claude-sonnet-5", "medium"), jobId: "cp-p", project: "demo", kind: "research", scope: "L", risk: "low" },
		config,
		ALWAYS_AVAILABLE,
	);
	assert.equal(big.rule, "research-big");
	const risky = resolveModel(
		{ profile: fixture(qa, "anthropic/claude-haiku-4-5", "low"), jobId: "cp-q", project: "demo", kind: "research", scope: "S", risk: "high" },
		config,
		ALWAYS_AVAILABLE,
	);
	assert.equal(risky.rule, "risky-any");
	const overridden = resolveModel(
		{
			profile: planner,
			jobId: "cp-p",
			project: "demo",
			kind: "research",
			scope: "S",
			risk: "low",
			override: "anthropic/claude-opus-5",
			thinking: "xhigh",
		},
		config,
		ALWAYS_AVAILABLE,
	);
	assert.equal(overridden.source, "override");
	assert.equal(overridden.model, "anthropic/claude-opus-5");
	assert.equal(overridden.thinking, "xhigh");
});

// ---------------------------------------------------------------------------
// cp-routing-provenance: the axes are assessed independently
// ---------------------------------------------------------------------------

/**
 * Two planner rules, high-risk first and ordinary research second: the same
 * shape the rubric uses, small enough that which row won is the whole result.
 */
const TWO_RULES: RoutingConfig = {
	schema_version: SCHEMA_VERSION,
	allow: ["mock/*"],
	rubric: [
		{ id: "risky-research", role: "planner", risk: "high", model: "mock/grok-xhigh" },
		{ id: "research", role: "planner", model: "mock/grok-high-fast" },
	],
};

function routeAs(text: string, supplied: { scope?: Scope; risk?: Risk; suppliedBy?: "explicit" | "assessed" } = {}) {
	const inputs = resolveRoutingInputs({ text, ...supplied });
	const picked = pickModel(
		{ profile: profileFor("planner"), jobId: "cp-x", project: "demo", kind: "research", scope: inputs.scope, risk: inputs.risk },
		TWO_RULES,
	);
	return { ...inputs, model: picked.model, rule: picked.rule };
}

test("cp-routing-provenance: a supplied scope does not switch off the risk evidence", () => {
	// The defect: naming EITHER axis disabled inference for BOTH, so this
	// credential-rotation task routed as M/low and the ordinary research row won.
	const routed = routeAs("Rotate production credentials across services", { scope: "M" });
	assert.equal(routed.scope, "M");
	assert.equal(routed.risk, "high", "the risk signal survives a caller who named only scope");
	assert.deepEqual(routed.provenance, { scope: "explicit", risk: "inferred" });
	// b-qbi.2: plural `credentials` now matches, so the first reason is the credential one.
	assert.deepEqual(routed.reasons, ["risk high: the task touches credentials or access"]);
	assert.equal(routed.rule, "risky-research");
});

test("cp-routing-provenance: a supplied risk does not switch off the scope evidence", () => {
	const routed = routeAs("Refactor across all modules", { risk: "low" });
	assert.equal(routed.scope, "M", "the structural signal survives a caller who named only risk");
	assert.equal(routed.risk, "low");
	assert.deepEqual(routed.provenance, { scope: "inferred", risk: "explicit" });
	assert.deepEqual(routed.reasons, ["scope M: the change is structural"]);
	assert.equal(routed.rule, "research");
});

test("cp-routing-provenance: explicit values win their own axis and are never relabelled inferred", () => {
	// Same risky text, both axes named: the caller outranks every keyword, and
	// neither axis is marked inferred just because the other one could have been.
	const routed = routeAs("Rotate production credentials across services", { scope: "S", risk: "low" });
	assert.equal(routed.scope, "S");
	assert.equal(routed.risk, "low");
	assert.deepEqual(routed.provenance, { scope: "explicit", risk: "explicit" });
	assert.deepEqual(routed.reasons, [], "a reason for an axis nobody inferred is evidence for nothing");
	assert.equal(routed.rule, "research");
});

test("cp-routing-provenance: no signals and no axes is S/low, recorded as defaulted", () => {
	const routed = routeAs("Bump x to 2 in src/app.ts.");
	assert.equal(routed.scope, "S");
	assert.equal(routed.risk, "low");
	assert.deepEqual(
		routed.provenance,
		{ scope: "defaulted", risk: "defaulted" },
		"the standing default is a default, not somebody's decision",
	);
	assert.deepEqual(routed.reasons, []);
});

test("cp-routing-provenance: structural and risky wording with no axes infers both", () => {
	const routed = routeAs("Migrate the billing tables across every service");
	assert.equal(routed.scope, "M");
	assert.equal(routed.risk, "high");
	assert.deepEqual(routed.provenance, { scope: "inferred", risk: "inferred" });
	assert.equal(routed.reasons.length, 2, `expected one reason per inferred axis: ${routed.reasons.join(" | ")}`);
	assert.equal(routed.rule, "risky-research");
});

test("cp-routing-provenance: a planner's own measurement is assessed, not explicit", () => {
	// The pipeline hands the implementer the planner's self_assessment. That is a
	// measurement, not an operator instruction, and the record must say so — while
	// the axis the assessment did not name is still inferred on its own.
	const routed = routeAs("Rotate production credentials across services", { scope: "L", suppliedBy: "assessed" });
	assert.equal(routed.scope, "L");
	assert.deepEqual(routed.provenance, { scope: "assessed", risk: "inferred" });
});

// ---------------------------------------------------------------------------
// Routing T5: policy lint, effort drift and the startup nudge
// ---------------------------------------------------------------------------

function writeRoutingConfig(home: string, config: unknown): void {
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	writeFileSync(join(home, LAYOUT.routingFile), JSON.stringify(config));
}

function rubric(rows: RoutingConfig["rubric"]): RoutingConfig {
	return { schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: rows };
}

test("routing T5: two rows cannot wear one id — the refusal names both rows and their models", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeRoutingConfig(
		home.path,
		rubric([
			{ id: "ship", role: "implementer", scope: ["S"], model: "mock/small" },
			{ id: "other", role: "implementer", scope: ["M"], model: "mock/medium" },
			{ id: "ship", role: "implementer", scope: ["L"], model: "mock/large" },
		]),
	);
	assert.throws(
		() => loadRoutingConfig(home.path),
		(error: Error) => {
			assert.ok(error instanceof RoutingError);
			assert.match(error.message, /duplicate rubric id/);
			assert.match(error.message, /"ship" at rubric\[0\] -> mock\/small and rubric\[2\] -> mock\/large/);
			assert.match(error.message, /first match wins/);
			assert.doesNotMatch(error.message, /"other"/, "a row with its own id is not part of the collision");
			return true;
		},
	);

	// The refusal is at load, so every caller gets it — routing never decides a
	// model from a config whose `rule=` would name two different rows.
	writeRoutingConfig(home.path, rubric([{ id: "ship", role: "implementer", model: "mock/small" }]));
	assert.equal(loadRoutingConfig(home.path).rubric.length, 1);
});

test("routing T5: a fully covered row is shadowed; overlap and per-project narrowing are not", () => {
	const shadowed = shadowedRubricRows(
		rubric([
			{ id: "any-ship", role: "implementer", model: "mock/broad" },
			{ id: "dead", role: "implementer", scope: ["L"], risk: "high", model: "mock/never" },
			{ id: "planning", role: "planner", model: "mock/plan" },
		]),
	);
	assert.deepEqual(shadowed, [{ id: "dead", row: 1, by: "any-ship", byRow: 0 }]);

	// Deliberate overlap, both directions of narrowing, and a different role:
	// nothing here is provably dead, so nothing is reported.
	assert.deepEqual(
		shadowedRubricRows(
			rubric([
				{ id: "small", role: "implementer", scope: ["S"], model: "mock/small" },
				{ id: "small-and-medium", role: "implementer", scope: ["S", "M"], model: "mock/medium" },
				{ id: "risky", role: "implementer", risk: "high", model: "mock/risky" },
				{ id: "web", role: "implementer", project: "web", model: "mock/web" },
				{ id: "api", role: "implementer", project: "api", model: "mock/api" },
			]),
		),
		[],
	);

	// A broad row AFTER a per-project one is not shadowed by it: the project row
	// covers one repository, and the broad row still decides every other.
	assert.deepEqual(
		shadowedRubricRows(
			rubric([
				{ id: "web", role: "implementer", project: "web", model: "mock/web" },
				{ id: "any", role: "implementer", model: "mock/broad" },
			]),
		),
		[],
	);

	// The shipped default is clean: no row in it is dead.
	assert.deepEqual(shadowedRubricRows(loadShippedDefault()), []);
});

test("routing T5: effort drift is T3's rule applied to the configured policy, deduplicated by pair", () => {
	const profiles = [profileFor("planner"), profileFor("implementer"), profileFor("gate-reviewer")];
	const config = rubric([
		// Two rows, one pair: the same model at the same level is one probe.
		{ id: "risky-ship", role: "implementer", risk: "high", model: "mock/shallow", thinking: "xhigh" },
		{ id: "big-ship", role: "implementer", scope: ["L"], model: "mock/shallow", thinking: "xhigh" },
		// A row with no level of its own inherits the profile's — and that pair is
		// checked too, because that is the pair the spawn would use.
		{ id: "planning", role: "planner", model: "mock/shallow" },
	]);
	const shallow: ModelProbe = {
		isAvailable: () => true,
		supportedThinking: (model) => (model === "mock/shallow" ? ["off", "low"] : undefined),
	};

	const drift = effortPolicyDrift(config, profiles, shallow);
	assert.equal(drift.length, 2, `expected one entry per model/effort pair: ${drift.map((d) => `${d.model}@${d.thinking}`).join(", ")}`);
	const xhigh = drift.find((entry) => entry.thinking === "xhigh");
	assert.deepEqual(xhigh?.sources, ["rubric row risky-ship", "rubric row big-ship"], "one pair, every place it is configured");
	assert.deepEqual(xhigh?.supported, ["off", "low"]);
	const inherited = drift.find((entry) => entry.thinking === "medium");
	assert.deepEqual(inherited?.sources, ["rubric row planning"], "a row with no level of its own still spawns the profile's");
	assert.match(describeEffortDrift(xhigh as EffortDrift), /rubric row risky-ship, rubric row big-ship asks for thinking=xhigh/);

	// Ignorance is never evidence: a probe with no metadata reports no drift at
	// all, on exactly the same config (cp-ot3b / cp-reviewer-routing, T3).
	assert.deepEqual(effortPolicyDrift(config, profiles, ALWAYS_AVAILABLE), []);

	// And a model that does not reason keeps its inert-level semantics: a level
	// nobody explicitly asked for is not drift.
	const inert: ModelProbe = { isAvailable: () => true, supportedThinking: () => ["off"] };
	assert.deepEqual(effortPolicyDrift(config, profiles, inert), []);
});

test("routing T5: unserviceableEffort is the same predicate resolveModel refuses with", () => {
	const shallow: ModelProbe = { isAvailable: () => true, supportedThinking: () => ["low", "medium"] };
	assert.deepEqual(unserviceableEffort("mock/shallow", "xhigh", shallow), ["low", "medium"]);
	assert.equal(unserviceableEffort("mock/shallow", "low", shallow), undefined);
	assert.equal(unserviceableEffort("mock/shallow", "xhigh", ALWAYS_AVAILABLE), undefined, "no metadata is no refusal");
	// The non-reasoning exemption, and its one exception: an explicit request.
	const inert: ModelProbe = { isAvailable: () => true, supportedThinking: () => ["off"] };
	assert.equal(unserviceableEffort("mock/inert", "high", inert), undefined);
	assert.deepEqual(unserviceableEffort("mock/inert", "high", inert, { explicit: true }), ["off"]);

	// The refusal `resolveModel` raises is built from exactly this answer.
	assert.throws(
		() =>
			resolveModel(
				{
					profile: withoutFallbacks(profileFor("implementer")),
					jobId: "cp-x",
					project: "demo",
					kind: "ship",
					thinking: "xhigh",
				},
				{ ...DEFAULT_ROUTING_CONFIG, allow: ["**"] },
				shallow,
			),
		/cannot serve \(available: low, medium\)/,
	);
});

test("routing T5: the startup nudge is silent on a clean home and specific on a broken one", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const shallow: ModelProbe = {
		isAvailable: () => true,
		supportedThinking: (model) => (model === "mock/shallow" ? ["low"] : undefined),
	};

	// No config at all: nothing to say.
	assert.equal(computeRoutingNudge({ home: home.path, profilesDir: PROFILES_DIR, probe: shallow }), undefined);

	// A config that cannot be loaded is the loudest case: every dispatch fails.
	writeRoutingConfig(home.path, {
		schema_version: SCHEMA_VERSION,
		allow: ["mock/*"],
		rubric: [
			{ id: "ship", role: "implementer", model: "mock/a" },
			{ id: "ship", role: "implementer", model: "mock/b" },
		],
	});
	const refused = computeRoutingNudge({ home: home.path, profilesDir: PROFILES_DIR, probe: shallow });
	assert.match(refused ?? "", /duplicate rubric id/);
	assert.match(refused ?? "", /dispatch refuses to guess a model/);

	// A loadable config with a dead row and a drifted pair names both.
	writeRoutingConfig(
		home.path,
		rubric([
			{ id: "any-ship", role: "implementer", model: "mock/shallow", thinking: "xhigh" },
			{ id: "dead-ship", role: "implementer", scope: ["L"], model: "mock/other" },
		]),
	);
	const nudge = computeRoutingNudge({ home: home.path, profilesDir: PROFILES_DIR, probe: shallow });
	assert.match(nudge ?? "", /rubric\[1\] "dead-ship" can never fire: rubric\[0\] "any-ship"/);
	assert.match(nudge ?? "", /asks for thinking=xhigh on mock\/shallow/);
	assert.match(nudge ?? "", /nothing here changes precedence/);

	// Without a probe the effort half is not claimed at all — only the shadow is.
	const noProbe = computeRoutingNudge({ home: home.path, profilesDir: PROFILES_DIR });
	assert.match(noProbe ?? "", /can never fire/);
	assert.doesNotMatch(noProbe ?? "", /thinking=/);

	// The shipped default, read as a real home would: nothing to say.
	writeRoutingConfig(home.path, loadShippedDefault());
	assert.equal(computeRoutingNudge({ home: home.path, profilesDir: PROFILES_DIR }), undefined);
});

test("routing T5: over MAX_NUDGE_LINES the nudge prints five lines and counts the rest", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const shallow: ModelProbe = { isAvailable: () => true, supportedThinking: () => ["low"] };

	// Seven dead rows behind one broad row, and seven distinct drifted pairs:
	// both lists are over the bound, in one config.
	writeRoutingConfig(
		home.path,
		rubric([
			{ id: "any-ship", role: "implementer", model: "mock/shallow" },
			...Array.from({ length: 7 }, (_, index) => ({
				id: `dead-${index + 1}`,
				role: "implementer" as const,
				scope: ["L" as const],
				risk: "high" as const,
				model: `mock/never-${index + 1}`,
				thinking: "xhigh" as const,
			})),
		]),
	);
	const nudge = computeRoutingNudge({ home: home.path, profilesDir: PROFILES_DIR, probe: shallow });
	const lines = (nudge ?? "").split("\n");

	const shadowLines = lines.filter((line) => line.includes("can never fire"));
	assert.equal(shadowLines.length, MAX_NUDGE_LINES, `expected ${MAX_NUDGE_LINES} shadow lines: ${nudge}`);
	assert.ok(lines.includes("(and 2 more shadowed row(s))"), `the rest must be counted: ${nudge}`);

	const driftLines = lines.filter((line) => line.includes("asks for thinking="));
	assert.equal(driftLines.length, MAX_NUDGE_LINES, `expected ${MAX_NUDGE_LINES} drift lines: ${nudge}`);
	const counted = Number(/\(and (\d+) more drifted model\/effort pair\(s\)\)/.exec(nudge ?? "")?.[1] ?? "0");
	// The count describes the list: printed + counted is every pair the same
	// inputs drift on, derived here rather than hardcoded.
	const pairs = effortPolicyDrift(loadRoutingConfig(home.path), listProfiles(PROFILES_DIR), shallow);
	assert.ok(pairs.length > MAX_NUDGE_LINES, "the fixture must go over the bound to test it");
	assert.equal(driftLines.length + counted, pairs.length, `the count must describe the list: ${nudge}`);
});

/** The `RoutingError` a call throws, for asserting on its structured fields. */
function refusalOf(run: () => unknown): RoutingError {
	try {
		run();
	} catch (error) {
		assert.ok(error instanceof RoutingError, `expected a RoutingError, got ${String(error)}`);
		return error;
	}
	throw new assert.AssertionError({ message: "expected a RoutingError, but nothing was thrown" });
}

test("routing T5: a refusal says what it refused, and which row it was about", () => {
	const request = {
		profile: withoutFallbacks(profileFor("implementer")),
		jobId: "cp-x",
		project: "demo",
		kind: "ship" as const,
	};

	// The allowlist: the row FIRED and its model is refused. Both facts travel,
	// so a diagnosis can tell "this row was never reached" from "this row was
	// reached and its model is not allowed" without reading the prose.
	const allowlist = refusalOf(() =>
		pickModel(request, rubric([{ id: "web-ship", role: "implementer", model: "forbidden/model" }])),
	);
	assert.equal(allowlist.refusal, "allowlist");
	assert.equal(allowlist.rule, "web-ship");

	// Availability and effort carry the row too, when a row chose the model.
	const unavailable = refusalOf(() =>
		resolveModel(request, rubric([{ id: "web-ship", role: "implementer", model: "mock/unreachable" }]), {
			isAvailable: () => false,
			available: () => [],
		}),
	);
	assert.equal(unavailable.refusal, "availability");
	assert.equal(unavailable.rule, "web-ship");

	const effort = refusalOf(() =>
		resolveModel(request, rubric([{ id: "big-ship", role: "implementer", model: "mock/shallow", thinking: "xhigh" }]), {
			isAvailable: () => true,
			supportedThinking: () => ["low", "medium"],
		}),
	);
	assert.equal(effort.refusal, "effort");
	assert.equal(effort.rule, "big-ship");

	// A profile-sourced refusal names no row, because no row chose it.
	const fromProfile = refusalOf(() =>
		resolveModel(request, { ...DEFAULT_ROUTING_CONFIG, allow: ["**"] }, { isAvailable: () => false }),
	);
	assert.equal(fromProfile.refusal, "availability");
	assert.equal(fromProfile.rule, undefined);
});

// ---------------------------------------------------------------------------
// pi-command-post-0a9: ordered, capability-aware fallback within the picked
// source. Every gate still applies to every candidate; nothing is downgraded
// quietly, and what was skipped is part of the decision.
// ---------------------------------------------------------------------------

const LADDER: RoutingConfig = {
	schema_version: SCHEMA_VERSION,
	allow: ["mock/*"],
	rubric: [
		{
			id: "big-ship",
			role: "implementer",
			model: "mock/preferred",
			fallbacks: ["mock/second", "mock/third"],
			thinking: "high",
		},
	],
};

function shipRequest(overrides: Partial<Parameters<typeof resolveModel>[0]> = {}) {
	return {
		profile: withoutFallbacks(profileFor("implementer")),
		jobId: "cp-x",
		project: "demo",
		kind: "ship" as const,
		...overrides,
	};
}

test("quota puts the non-tight provider first, but keeps overrides and rubric ties", async (t) => {
	const config: RoutingConfig = { ...LADDER, allow: ["*/*"], rubric: [{ id: "quota", role: "implementer", model: "anthropic/opus", fallbacks: ["openai/sol"] }] };
	const scratch = createScratchHome();
	t.after(scratch.cleanup);
	mkdirSync(join(scratch.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(scratch.path, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://gateway.example", path: "/capacity" }));
	for (const [anthropic, openai, expected, margin, openaiUsed = 0] of [
		[20, 20, "anthropic/opus"], [50, 20, "openai/sol"], [28, 20, "anthropic/opus"],
		[30, 20, "anthropic/opus"], [31, 20, "openai/sol"],
		[86, 20, "openai/sol"], [86, 90, "anthropic/opus"],
		[undefined, 20, "anthropic/opus"], [50, undefined, "anthropic/opus"],
		[50, 20, "anthropic/opus", null], [50, 20, "anthropic/opus", -1],
		[50, 20, "anthropic/opus", 40], [28, 20, "openai/sol", 5],
		[50, 20, "anthropic/opus", undefined, 20],
	] as const) {
		writeFileSync(join(scratch.path, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://gateway.example", path: "/capacity", quota: { balance_margin: margin } }));
		const reader = new CapacityReader({ home: scratch.path, env: { CP_GATEWAY_ADMIN_KEY: "test" }, fetch: async (url) => {
			const path = new URL(String(url)).pathname;
			if (path === "/capacity") return Response.json({ code: 0, data: { enabled: true, timestamp: "2026-09-26T00:00:00Z", platform: { anthropic: { max_capacity: 5, current_in_use: 0, waiting_in_queue: 0 }, openai: { max_capacity: 20, current_in_use: openaiUsed, waiting_in_queue: 0 } } } });
			if (path.endsWith("/accounts")) return Response.json({ code: 0, data: { items: ["anthropic", "openai"].map((platform, id) => ({ id: id + 1, platform, status: "active", schedulable: true, type: "oauth", temp_unschedulable_until: null, overload_until: null })) } });
			const seven = path.includes("/1/") ? anthropic : openai;
			return Response.json(seven === undefined ? { code: 500 } : { code: 0, data: { five_hour: { utilization: 2 }, seven_day: { utilization: seven } } });
		} });
		const decision = await resolveWithCapacity(shipRequest(), config, ALWAYS_AVAILABLE, reader);
		assert.equal(decision.model, expected, `7d=${anthropic}/${openai}, margin=${margin}, used=${openaiUsed}`);
		if (expected === "openai/sol" && anthropic !== undefined && anthropic < 85) {
			assert.match(formatRoutingDecision(decision), /quota balance: anthropic 7d=.* vs openai 7d=.* -> openai/);
		}
		assert.deepEqual(reviewerRoutingEvent({ surface: "test", decision, inputs: reviewerRoutingInputs() }).quota, decision.quota);
		assert.equal((await resolveWithCapacity(shipRequest({ override: "anthropic/opus" }), config, ALWAYS_AVAILABLE, reader)).model, "anthropic/opus");
	}
	const reader = new CapacityReader({ home: scratch.path, env: {}, fetch: async () => { assert.fail("no gateway call without key"); } });
	const decision = await resolveWithCapacity(shipRequest(), config, ALWAYS_AVAILABLE, reader);
	assert.equal(decision.model, "anthropic/opus");
	assert.match(formatRoutingDecision(decision), /quota=off:no admin key/);
});

test("quota balance chooses the lowest free provider without mutating the shared snapshot", () => {
	const config: RoutingConfig = { ...LADDER, allow: ["*/*"], rubric: [{ id: "balance", role: "implementer", model: "anthropic/opus", fallbacks: ["openai/sol", "third/model"] }] };
	const scores = Object.fromEntries(["anthropic", "openai", "third"].map((name) => [name, { source: "admin" as const, score: 1 }]));
	for (const [seven, expected] of [[15, "third/model"], [20, "openai/sol"], [undefined, "openai/sol"]] as const) {
		const quota = { providers: [
			{ provider: "anthropic", five_hour: 2, seven_day: 50, tight: false },
			{ provider: "openai", five_hour: 2, seven_day: 20, tight: false },
			{ provider: "third", five_hour: 2, seven_day: seven, tight: false },
			{ provider: "unconfigured", five_hour: 0, seven_day: 0, tight: false },
		] };
		const decision = resolveModel(shipRequest(), config, ALWAYS_AVAILABLE, scores, quota);
		assert.equal(decision.model, expected);
		assert.ok(validate(RoutingDecisionSchema, decision).ok);
		assert.equal("balance_reason" in quota, false);
		assert.match(String(reviewerRoutingEvent({ surface: "test", decision, inputs: reviewerRoutingInputs() }).line), /quota balance:/);
		assert.equal(resolveModel(shipRequest(), config, ALWAYS_AVAILABLE, undefined, quota).model, "anthropic/opus");
		const fleet = Object.fromEntries(Object.keys(scores).map((name) => [name, { source: "fleet" as const, score: 0 }]));
		assert.equal(resolveModel(shipRequest(), config, ALWAYS_AVAILABLE, fleet, quota).model, "anthropic/opus");
	}
});

test("capacity ranks eligible providers, keeps ties and explicit overrides, and never treats zero as refused", async () => {
	const config: RoutingConfig = { ...LADDER, allow: ["*/*"], rubric: [{ id: "big-ship", role: "implementer", model: "anthropic/opus", fallbacks: ["openai/sol"], thinking: "high" }] };
	const request = shipRequest();
	const probe = probeFor(["anthropic/opus", "openai/sol"]);
	const reader = { read: async () => ({ anthropic: { source: "admin" as const, score: 0 }, openai: { source: "admin" as const, score: 8 } }) };
	const selected = await resolveWithCapacity(request, config, probe, reader);
	assert.equal(selected.model, "openai/sol");
	assert.deepEqual(selected.capacity, { source: "admin", scores: [{ provider: "anthropic", score: 0 }, { provider: "openai", score: 8 }] });
	assert.match(formatRoutingDecision(selected), /capacity=admin:anthropic=0,openai=8/);
	assert.equal((await resolveWithCapacity({ ...request, override: "anthropic/opus" }, config, probe, reader)).model, "anthropic/opus");
	assert.equal((await resolveWithCapacity(request, config, probe, { read: async () => ({ anthropic: { source: "admin" as const, score: 3 }, openai: { source: "admin" as const, score: 3 } }) })).model, "anthropic/opus");
	assert.equal((await resolveWithCapacity(request, config, probe, { read: async () => ({ anthropic: { source: "unknown" as const }, openai: { source: "unknown" as const } }) })).model, "anthropic/opus");
	assert.equal((await resolveWithCapacity(request, config, probeFor(["anthropic/opus"]), reader)).model, "anthropic/opus");
	// The preferred provider keeps the pick while it has any free slot, even when a fallback has more.
	const admin = (anthropic: number, openai: number) => ({ read: async () => ({ anthropic: { source: "admin" as const, score: anthropic }, openai: { source: "admin" as const, score: openai } }) });
	assert.equal((await resolveWithCapacity(request, config, probe, admin(1, 20))).model, "anthropic/opus");
	// Nobody free: the least oversubscribed wins.
	assert.equal((await resolveWithCapacity(request, config, probe, admin(-3, -1))).model, "openai/sol");
});

test("capacity auth rejection survives fleet fallback in the decision", async (t) => {
	const config: RoutingConfig = { ...LADDER, allow: ["*/*"], rubric: [{ id: "big-ship", role: "implementer", model: "anthropic/opus", fallbacks: ["openai/sol"], thinking: "high" }] };
	const scratch = createScratchHome();
	t.after(scratch.cleanup);
	const home = scratch.path;
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	writeFileSync(join(home, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://gateway.example", path: "/api/admin/capacity" }));
	const reader = new CapacityReader({ home, env: { CP_GATEWAY_ADMIN_KEY: "private-key" }, fleet: { read: () => ({ jobs: [
		{ phase: "waiting", worker: { model: "anthropic/opus" } },
		{ phase: "waiting", worker: { model: "anthropic/sonnet" } },
	] }) } as ConstructorParameters<typeof CapacityReader>[0]["fleet"], fetch: async () => new Response("private-key", { status: 401 }) });
	const decision = await resolveWithCapacity(shipRequest(), config, ALWAYS_AVAILABLE, reader);
	assert.equal(decision.model, "openai/sol");
	assert.deepEqual(decision.capacity, { source: "fleet", scores: [{ provider: "anthropic", score: -2 }, { provider: "openai", score: 0 }], reason: "capacity auth rejected" });
	assert.match(formatRoutingDecision(decision), /capacity auth rejected/);
});

test("ineligible third provider cannot invalidate capacity scores for two eligible providers", async () => {
	const config: RoutingConfig = { ...LADDER, allow: ["*/*"], rubric: [{ id: "big-ship", role: "implementer", model: "anthropic/opus", fallbacks: ["openai/sol", "absent/model"], thinking: "high" }] };
	const reader = { read: async (providers: string[]) => Object.fromEntries(providers.map((provider) => [provider,
		provider === "absent" ? { source: "unknown" as const } : { source: "admin" as const, score: provider === "openai" ? 8 : 0 },
	])) };
	const decision = await resolveWithCapacity(shipRequest(), config, probeFor(["anthropic/opus", "openai/sol"]), reader);
	assert.equal(decision.model, "openai/sol");
	assert.deepEqual(decision.capacity, { source: "admin", scores: [{ provider: "anthropic", score: 0 }, { provider: "openai", score: 8 }] });
});

test("capacity never crosses rubric or effort gates and fleet scores use the same comparison", async () => {
	const config: RoutingConfig = { ...LADDER, allow: ["*/*"], rubric: [{ id: "risky", role: "implementer", risk: "high", model: "anthropic/opus", fallbacks: ["openai/sol"], thinking: "high" }] };
	const request = shipRequest({ risk: "high" });
	const scores = { read: async () => ({ anthropic: { source: "fleet" as const, score: -6 }, openai: { source: "fleet" as const, score: -2 } }) };
	assert.equal((await resolveWithCapacity(request, config, ALWAYS_AVAILABLE, scores)).model, "openai/sol");
	assert.equal((await resolveWithCapacity(request, { ...config, allow: ["anthropic/*"] }, ALWAYS_AVAILABLE, scores)).model, "anthropic/opus");
	assert.equal((await resolveWithCapacity(request, config, { isAvailable: () => true, supportedThinking: (model) => model.startsWith("openai/") ? ["low"] : ["high"] }, scores)).model, "anthropic/opus");
	assert.equal((await resolveWithCapacity(request, config, ALWAYS_AVAILABLE, { read: async () => { throw new Error("gateway failed"); } })).model, "anthropic/opus");
});
test("fallback: the walk takes the first candidate that passes every gate", () => {
	// Preferred available: byte-identical to a row that never had a ladder.
	const first = resolveModel(shipRequest(), LADDER, probeFor(["mock/preferred", "mock/second"]));
	assert.deepEqual(first, { model: "mock/preferred", source: "rubric", rule: "big-ship", thinking: "high" });

	// Preferred unauthenticated: the next one runs, and says what it stepped over.
	const second = resolveModel(shipRequest(), LADDER, probeFor(["mock/second", "mock/third"]));
	assert.deepEqual(second, {
		model: "mock/second",
		source: "rubric",
		rule: "big-ship",
		thinking: "high",
		attempted: [{ model: "mock/preferred", refusal: "availability" }],
	});

	// Two down: order is the file's, not a preference of routing's.
	const third = resolveModel(shipRequest(), LADDER, probeFor(["mock/third"]));
	assert.equal(third.model, "mock/third");
	assert.deepEqual(third.attempted, [
		{ model: "mock/preferred", refusal: "availability" },
		{ model: "mock/second", refusal: "availability" },
	]);
});

test("fallback: a candidate that cannot serve the level in force is skipped, never downgraded", () => {
	// `mock/second` reasons but cannot do `high`: skipping it is the contract —
	// running it at `medium` would be the effort substitution routing refuses.
	const probe = metadataProbe({
		"mock/second": modelLike("mock/second", { reasoning: true, thinkingLevelMap: { high: null } }),
		"mock/third": modelLike("mock/third", { reasoning: true }),
	});
	const decision = resolveModel(shipRequest(), LADDER, probe);
	assert.equal(decision.model, "mock/third");
	assert.equal(decision.thinking, "high", "the effort in force is never substituted by a fallback");
	assert.deepEqual(decision.attempted, [
		{ model: "mock/preferred", refusal: "availability" },
		{ model: "mock/second", refusal: "effort" },
	]);
});

test("fallback: the allowlist gates every candidate — skipped in a list, refused hard without one", () => {
	const narrowed: RoutingConfig = { ...LADDER, allow: ["mock/third"] };
	const decision = resolveModel(shipRequest(), narrowed, ALWAYS_AVAILABLE);
	assert.equal(decision.model, "mock/third", "narrowing `allow` to one provider is how an operator says so");
	assert.deepEqual(decision.attempted, [
		{ model: "mock/preferred", refusal: "allowlist" },
		{ model: "mock/second", refusal: "allowlist" },
	]);

	// One candidate, disallowed: the hard configuration error it has always been.
	const single: RoutingConfig = {
		...narrowed,
		rubric: [{ id: "big-ship", role: "implementer", model: "mock/preferred", thinking: "high" }],
	};
	const refused = refusalOf(() => resolveModel(shipRequest(), single, ALWAYS_AVAILABLE));
	assert.equal(refused.refusal, "allowlist");
	assert.equal(refused.rule, "big-ship");
});

test("fallback: an exhausted list refuses, naming every candidate and its gate", () => {
	const probe: ModelProbe = {
		isAvailable: (model) => model !== "mock/preferred",
		available: () => ["mock/second", "mock/third"],
		supportedThinking: () => ["low"],
	};
	const refused = refusalOf(() => resolveModel(shipRequest(), LADDER, probe));
	assert.equal(refused.refusal, "exhausted");
	assert.equal(refused.rule, "big-ship");
	assert.match(refused.message, /mock\/preferred \(availability\)/);
	assert.match(refused.message, /mock\/second \(effort\)/);
	assert.match(refused.message, /mock\/third \(effort\)/);
	// The row is refused, never carried to the profile: a fallback stays inside
	// the source that was picked, or it runs a job on a model nobody chose for it.
	assert.ok(!refused.message.includes(profileFor("implementer").frontmatter.model));
});

test("fallback: an explicit override never falls back", () => {
	const request = shipRequest({ override: "mock/named-by-a-person" });
	const refused = refusalOf(() => resolveModel(request, LADDER, probeFor(["mock/second", "mock/third"])));
	assert.equal(refused.refusal, "availability", "an override is one candidate, by construction");
	// The refusal is about the model the caller named, not about a list; the
	// reachable refs are only the "Available:" hint every availability refusal has.
	assert.match(refused.message, /mock\/named-by-a-person \(override, explicit override\) is not usable/);
	assert.ok(!refused.message.includes("attempted"), "an override has no candidates to attempt");

	// Nor does a profile's own ladder rescue an override.
	const withProfileLadder = { ...request, profile: profileFor("implementer") };
	assert.equal(refusalOf(() => resolveModel(withProfileLadder, LADDER, probeFor([]))).refusal, "availability");

	// An override that IS available resolves with no `attempted` at all.
	const ok = resolveModel(request, LADDER, probeFor(["mock/named-by-a-person"]));
	assert.equal(ok.source, "override");
	assert.equal(ok.attempted, undefined);
});

test("fallback: a config with no fallbacks resolves exactly as it did before", () => {
	const noLadder: RoutingConfig = {
		...LADDER,
		rubric: [{ id: "big-ship", role: "implementer", model: "mock/preferred", thinking: "high" }],
	};
	const decision = resolveModel(shipRequest(), noLadder, probeFor(["mock/preferred"]));
	assert.deepEqual(decision, { model: "mock/preferred", source: "rubric", rule: "big-ship", thinking: "high" });
	assert.equal(formatRoutingDecision(decision), "source=rubric model=mock/preferred rule=big-ship thinking=high");
});

test("fallback: the printed line names what was stepped over, bounded", () => {
	const decision = resolveModel(shipRequest(), LADDER, probeFor(["mock/third"]));
	assert.equal(
		formatRoutingDecision(decision),
		"source=rubric model=mock/third rule=big-ship thinking=high attempted=mock/preferred(availability),mock/second(availability)",
	);
	// Model refs and enum words only: nothing here can carry a credential.
	assert.ok(!/[=][^ ]*key/i.test(formatRoutingDecision(decision)));

	const long: RoutingDecision = {
		model: "mock/third",
		source: "rubric",
		rule: "big-ship",
		attempted: Array.from({ length: 8 }, (_, index) => ({
			model: `mock/${"candidate".repeat(3)}-${index}`,
			refusal: "availability" as const,
		})),
	};
	const suffix = formatRoutingDecision(long).split("attempted=")[1] ?? "";
	assert.ok(suffix.length <= 160, `attempted= is bounded, got ${suffix.length} chars`);
	assert.match(suffix, /\(\+\d+ more\)/);
});

test("fallback: reviewer events and effort drift both see the candidates", () => {
	const decision = resolveModel(shipRequest(), LADDER, probeFor(["mock/second"]));
	const event = reviewerRoutingEvent({
		surface: "gate/1",
		decision,
		inputs: reviewerRoutingInputs(undefined),
	});
	assert.deepEqual(event.attempted, [{ model: "mock/preferred", refusal: "availability" }]);

	// A fallback candidate whose effort has drifted is reported before the day the
	// preferred provider is the one that is down.
	const profile = loadProfile(PROFILES_DIR, "implementer");
	const probe: ModelProbe = {
		isAvailable: () => true,
		supportedThinking: (model) => (model === "mock/third" ? ["low"] : undefined),
	};
	const drift = effortPolicyDrift(LADDER, [profile], probe);
	assert.deepEqual(
		drift.map((entry) => ({ model: entry.model, thinking: entry.thinking, sources: entry.sources })),
		[{ model: "mock/third", thinking: "high", sources: ["rubric row big-ship fallback"] }],
	);
});

// ---------------------------------------------------------------------------
// The installation contract: one authenticated provider is enough. Deterministic
// and paid-inference-free — the capability answers come from the same pi-ai
// registry metadata pi itself reads.
// ---------------------------------------------------------------------------

/** A probe that knows pi's registry but is authenticated for one provider only. */
function oneProviderProbe(provider: string): ModelProbe {
	const catalog = (MODELS as unknown as Record<string, Record<string, PiModelLike>>)[provider] ?? {};
	return registryProbe({
		find: (askedProvider, modelId) => (askedProvider === provider ? catalog[modelId] : undefined),
		hasConfiguredAuth: () => true,
		getAvailable: () => Object.entries(catalog).map(([id]) => ({ id, provider })),
	});
}

test("one authenticated provider is enough: every shipped route resolves under Anthropic or OpenAI alone", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	// The template as an operator gets it: copied by the scaffold, not hand-built.
	scaffoldHome({ home: home.path, env: { CP_HOME: home.path } });
	const config = loadRoutingConfig(home.path);
	const profiles = ["planner", "implementer", "qa", "gate-reviewer"].map((name) => loadProfile(PROFILES_DIR, name));

	for (const provider of ["anthropic", "openai"]) {
		const probe = oneProviderProbe(provider);
		// Every configured (model, effort) pair, not only the ones a route happens to reach.
		assert.deepEqual(effortPolicyDrift(config, profiles, probe), [], `${provider}: configured effort drift`);
		for (const profile of profiles) {
			for (const combo of PROBE_COMBOS) {
				const where = `${provider}: ${profile.frontmatter.name} ${combo.scope}/${combo.risk}`;
				const decision = resolveModel(
					{
						profile,
						jobId: "cp-x",
						project: "demo",
						kind: profile.frontmatter.role === "implementer" ? "ship" : "research",
						scope: combo.scope,
						risk: combo.risk,
					},
					config,
					probe,
				);
				assert.ok(decision.model.startsWith(`${provider}/`), `${where} resolved ${decision.model}`);
				assert.ok(probe.isAvailable(decision.model), `${where}: ${decision.model} must be reachable`);
				// The effort is the route's, and the selected model must serve it —
				// a one-provider day never buys availability with a silent downgrade.
				if (decision.thinking) {
					const supported = probe.supportedThinking?.(decision.model) ?? [];
					assert.ok(supported.includes(decision.thinking), `${where}: ${decision.model} cannot serve ${decision.thinking}`);
				}
			}
		}
	}
});

test("the shipped ladder is Anthropic-preferred: nothing changes when Anthropic is reachable", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	scaffoldHome({ home: home.path, env: { CP_HOME: home.path } });
	const config = loadRoutingConfig(home.path);
	for (const rule of config.rubric) {
		// small-ship (cp-zk0b) tries opus before the openai last resort; every other row ships exactly the openai one.
		assert.ok(rule.fallbacks && rule.fallbacks.length === (rule.id === "small-ship" ? 2 : 1), `${rule.id} fallbacks`);
		assert.match(rule.fallbacks?.at(-1) ?? "", /^openai\//);
	}
	// Every shipped candidate is a model this pi registry actually has.
	const registry = MODELS as unknown as Record<string, Record<string, PiModelLike>>;
	const profiles = ["planner", "implementer", "qa", "gate-reviewer"].map((name) => loadProfile(PROFILES_DIR, name));
	const refs = [
		...config.rubric.flatMap((rule) => [rule.model, ...(rule.fallbacks ?? [])]),
		...profiles.flatMap((profile) => [profile.frontmatter.model, ...(profile.frontmatter.fallbacks ?? [])]),
	];
	for (const ref of refs) {
		const parts = splitModelRef(ref);
		assert.ok(parts, `${ref} is not a provider/model-id ref`);
		assert.ok(registry[parts.provider]?.[parts.modelId], `${ref} is not in pi's model registry`);
	}
});
