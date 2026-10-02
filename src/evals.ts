/**
 * Worker-prompt eval suite (do8.7).
 *
 * The do8 epic rewrote every worker prompt. This module is what makes the next
 * rewrite measurable instead of hopeful: a checked-in corpus of cases drawn
 * from real failures and representative happy paths, a runner that scores them
 * against a named **arm** (a prompt directory pair), and a stable
 * machine-readable result.
 *
 * Two kinds of case, deliberately kept apart:
 *
 *  - **contract** — deterministic. The claim is about the assembled prompt
 *    text itself ("the ship brief rebases onto the resolved base, not
 *    `origin/main`"), so it is scored with no model, for free, in CI.
 *  - **quality** — stochastic. The claim is about what a model *does* with the
 *    prompt, so it needs trials against a real model and it costs money.
 *    Nothing here calls a model unless an operator sets `CP_EVAL_LIVE=1`; with
 *    no transport, quality cases are recorded as `skipped` with the reason,
 *    which is why the checked-in result file is honest about what has not been
 *    measured yet.
 *
 * Everything is pure but the two edges (`loadCorpus`, the transports): rendering
 * and scoring take strings and return data, so the whole scorer is testable
 * without a model. Product code never imports from `tests/`.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BriefValues } from "./profiles.ts";
import { loadProfile, readBriefTemplate, renderTemplate } from "./profiles.ts";

export class EvalError extends Error {}

// ---------------------------------------------------------------------------
// Corpus shape
// ---------------------------------------------------------------------------

export type EvalRole = "planner" | "reviewer" | "implementer";
export type EvalKind = "contract" | "quality";
export type EvalSurface =
	| "planner-profile"
	| "research-brief"
	| "qa-brief"
	| "reviewer-profile"
	| "gate-rubric"
	| "diff-rubric"
	| "implementer-profile"
	| "ship-brief";

/** Which surfaces a role's cases may be scored against. */
export const ROLE_SURFACES: Record<EvalRole, readonly EvalSurface[]> = Object.freeze({
	planner: ["planner-profile", "research-brief", "qa-brief"],
	reviewer: ["reviewer-profile", "gate-rubric", "diff-rubric"],
	implementer: ["implementer-profile", "ship-brief"],
});

/**
 * The scenarios do8.7 requires the corpus to cover, per role. A corpus missing
 * one of these does not load: the eval's value is that it looked at the failure
 * modes somebody actually hit, and a silently dropped scenario is how a suite
 * turns into a green light for nothing.
 */
export const REQUIRED_SCENARIOS: Record<EvalRole, readonly string[]> = Object.freeze({
	planner: [
		"omitted-requirement",
		"stale-path",
		"invented-test-command",
		"excessive-scope",
		"genuine-unknown",
		"complete-executable-plan",
	],
	reviewer: [
		"pass-with-flag",
		"missing-section",
		"unscorable-input",
		"seeded-p0",
		"seeded-p1",
		"seeded-p2",
		"clean-diff",
		"style-only",
		"false-positive-trap",
	],
	implementer: [
		"task-file-handoff",
		"bug-regression",
		"docs-only",
		"non-main-base",
		"review-revision",
		"blocked-evidence",
		"clean-pushed-delivery",
		"exactly-once-report",
	],
});

/** do8.7: "Build 20-50 cases". Both bounds are enforced. */
export const CORPUS_MIN_CASES = 20;
export const CORPUS_MAX_CASES = 50;

export type Severity = "P0" | "P1" | "P2";

/** Human severity label → the rubric's own severity word. */
export const SEVERITY_WORD: Record<Severity, string> = Object.freeze({ P0: "high", P1: "medium", P2: "low" });

/**
 * One human-labeled defect in a reviewer case's subject. `match` is a regex
 * (case-insensitive) applied to each finding line the reviewer produced: the
 * label is the truth, the finding is the claim, and the pair is what makes
 * precision and recall computable at all.
 */
export interface DefectLabel {
	id: string;
	severity: Severity;
	/** Where the defect is, for the human reading the corpus. */
	where: string;
	match: string;
}

export interface EvalExpect {
	/** The verdict a correct reviewer returns (reviewer quality cases). */
	verdict?: "pass" | "revise" | "escalate";
	/** Flags a correct reviewer reports, independently of the verdict (do8.1). */
	flags?: Record<string, boolean>;
	/** Literal substrings the output must contain / must not contain. */
	includes?: string[];
	excludes?: string[];
	/** Requirements of the task the output must carry (task-coverage metric). */
	coverage?: string[];
	/** The output must cite at least one `path:line` (grounded-evidence metric). */
	evidence?: boolean;
	/**
	 * Human labels for a reviewer case. An empty array is meaningful: it is a
	 * clean / style-only / false-positive-trap case, where every finding is a
	 * false positive.
	 */
	labels?: DefectLabel[];
}

export interface EvalCase {
	id: string;
	role: EvalRole;
	scenario: string;
	kind: EvalKind;
	surface: EvalSurface;
	/** One line: the failure this case came from, or the happy path it pins. */
	why: string;
	/** What the worker is given to act on (quality cases only). */
	subject?: string;
	expect?: EvalExpect;
}

export interface EvalCorpus {
	version: number;
	cases: EvalCase[];
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Every structural rule of a corpus, as a list of errors (empty = valid). */
export function validateCorpus(value: unknown): string[] {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null) return ["corpus must be an object"];
	const corpus = value as Partial<EvalCorpus>;
	if (corpus.version !== 1) errors.push(`corpus version must be 1, got ${JSON.stringify(corpus.version)}`);
	if (!Array.isArray(corpus.cases)) return [...errors, "corpus.cases must be an array"];

	const cases = corpus.cases as EvalCase[];
	if (cases.length < CORPUS_MIN_CASES || cases.length > CORPUS_MAX_CASES) {
		errors.push(`corpus must hold ${CORPUS_MIN_CASES}-${CORPUS_MAX_CASES} cases, got ${cases.length}`);
	}
	const seen = new Set<string>();
	for (const item of cases) {
		const id = item?.id;
		if (typeof id !== "string" || !ID_RE.test(id)) {
			errors.push(`case id ${JSON.stringify(id)} must be kebab-case`);
			continue;
		}
		if (seen.has(id)) errors.push(`duplicate case id "${id}"`);
		seen.add(id);
		if (!(item.role in ROLE_SURFACES)) {
			errors.push(`${id}: unknown role ${JSON.stringify(item.role)}`);
			continue;
		}
		if (item.kind !== "contract" && item.kind !== "quality") {
			errors.push(`${id}: kind must be "contract" or "quality", got ${JSON.stringify(item.kind)}`);
		}
		if (!ROLE_SURFACES[item.role].includes(item.surface)) {
			errors.push(`${id}: surface ${JSON.stringify(item.surface)} is not a ${item.role} surface`);
		}
		if (typeof item.why !== "string" || item.why.trim().length === 0) {
			errors.push(`${id}: why must say which failure or happy path this case pins`);
		}
		if (!REQUIRED_SCENARIOS[item.role].includes(item.scenario)) {
			errors.push(`${id}: scenario "${item.scenario}" is not a required ${item.role} scenario`);
		}
		if (item.kind === "contract") {
			if (item.subject !== undefined) errors.push(`${id}: a contract case scores prompt text and takes no subject`);
			const expect = item.expect ?? {};
			if ((expect.includes?.length ?? 0) + (expect.excludes?.length ?? 0) === 0) {
				errors.push(`${id}: a contract case needs at least one includes/excludes assertion`);
			}
			if (expect.labels || expect.verdict || expect.flags) {
				errors.push(`${id}: verdict/flags/labels are model-quality expectations, not contract ones`);
			}
		} else {
			if (typeof item.subject !== "string" || item.subject.trim().length === 0) {
				errors.push(`${id}: a quality case needs the subject the worker acts on`);
			}
			if (item.expect === undefined) errors.push(`${id}: a quality case needs expectations`);
			if (item.expect?.labels && item.role !== "reviewer") {
				errors.push(`${id}: defect labels are reviewer ground truth; ${item.role} cases have none`);
			}
		}
		for (const pattern of item.expect?.coverage ?? []) {
			// Coverage patterns are regexes, compiled at scoring time. An invalid one
			// would throw mid-run — after a paid model call — so it is caught here,
			// where the fix is free.
			try {
				new RegExp(pattern, "i");
			} catch (error) {
				errors.push(`${id}: coverage pattern ${JSON.stringify(pattern)} is not a regex (${(error as Error).message})`);
			}
		}
		for (const label of item.expect?.labels ?? []) {
			if (!(label.severity in SEVERITY_WORD)) errors.push(`${id}: label ${label.id} has severity ${label.severity}`);
			try {
				new RegExp(label.match, "i");
			} catch {
				errors.push(`${id}: label ${label.id} match is not a regex: ${label.match}`);
			}
		}
	}

	// Every required scenario is covered by at least one case, for every role.
	for (const [role, scenarios] of Object.entries(REQUIRED_SCENARIOS) as [EvalRole, readonly string[]][]) {
		for (const scenario of scenarios) {
			if (!cases.some((item) => item?.role === role && item?.scenario === scenario)) {
				errors.push(`no case covers required scenario ${role}/${scenario}`);
			}
		}
	}
	return errors;
}

export function loadCorpus(path: string): EvalCorpus {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new EvalError(`${path}: cannot read corpus (${(error as Error).message})`);
	}
	const errors = validateCorpus(parsed);
	if (errors.length > 0) throw new EvalError(`${path}: invalid corpus\n  ${errors.join("\n  ")}`);
	return parsed as EvalCorpus;
}

// ---------------------------------------------------------------------------
// Parent classification corpus (routing T6)
// ---------------------------------------------------------------------------

/**
 * The **parent's** own choices, labeled by hand: which workflow a task wants
 * (`single` / `pipeline` / `qa`) and which resources it wants (`scope`,
 * `risk`). Same file layout, same `why`-per-case rule and the same live-money
 * gate as the worker-prompt corpus above — this is a second corpus, never a
 * second eval platform.
 *
 * Two layers, and the separation is the whole point (routing T6 §7):
 *
 *  - **`labels`** are human ground truth, and a set per axis rather than one
 *    value: several cases are legitimately ambiguous, and forcing one arbitrary
 *    answer would score a correct choice as wrong.
 *  - **`deterministic`** is what this repository's own code does with the case
 *    today — `classifyIntake` and `resolveRoutingInputs`. It is a wiring pin
 *    and a regression guard, and it is **not** a measurement of a parent
 *    model's judgment. Where it falls outside `labels`, the case must say so in
 *    `divergence`: the deterministic classifier is advisory, so a divergence is
 *    a documented fact about it, not a test failure to paper over.
 *
 * What a parent model actually passes to `cp_dispatch` / `cp_pipeline` is
 * measured only in a paid trial, and `live_trials` records whether that has
 * happened. Nothing here reports a quality number it did not measure.
 */
export const PARENT_ROUTING_SCENARIOS = Object.freeze([
	"ordinary-qa",
	"auth-comment-qa",
	"typo-in-auth-comment",
	"scope-only-production-credentials",
	"risk-only-refactor",
	"short-but-deep-concurrency-bug",
	"long-mechanical-rename",
	"broad-audit",
	"standalone-research",
	"fully-specified-high-risk-change",
	"ambiguous-low-risk-work",
	"pipeline-confidence-downgrade",
	"narrowed-scope-retained-impact",
	"model-override",
	"no-signal-defaults",
] as const);

export type ParentRoutingScenario = (typeof PARENT_ROUTING_SCENARIOS)[number];

/** routing T6: "approximately 15 hand-labeled cases", with room to grow. */
export const PARENT_CORPUS_MIN_CASES = PARENT_ROUTING_SCENARIOS.length;
export const PARENT_CORPUS_MAX_CASES = 25;

const WORKFLOW_MODES = ["single", "pipeline", "qa"] as const;
const SCOPE_WORDS = ["S", "M", "L"] as const;
const RISK_WORDS = ["low", "high"] as const;
const PROVENANCE_WORDS = ["explicit", "assessed", "inferred", "defaulted"] as const;

export interface ParentRoutingCase {
	id: string;
	scenario: string;
	/** The synthetic task text the parent would be classifying. */
	task: string;
	/** What the operator already settled, and the parent would pass through. */
	given?: { kind?: string; scope?: string; risk?: string; model?: string };
	/** Human ground truth: every answer a competent parent may give, and why. */
	labels: { workflow: string[]; scope: string[]; risk: string[]; why: string };
	/** What `classifyIntake` / `resolveRoutingInputs` do with this case today. */
	deterministic: {
		mode: string;
		scope: string;
		risk: string;
		provenance: { scope: string; risk: string };
	};
	/** Required when `deterministic` falls outside `labels`. */
	divergence?: string;
}

export interface ParentRoutingCorpus {
	version: number;
	/**
	 * Whether the parent model's own tool arguments have been measured.
	 * `pending_operator_approval` is an honest state, and the only one this
	 * repository can reach for free: trials cost money and are the operator's
	 * call. `measured` must name the result file that carries the model, prompt
	 * and package versions, the tool arguments and the cost metrics.
	 */
	live_trials: { status: string; reason: string; results?: string };
	cases: ParentRoutingCase[];
}

function subsetErrors(id: string, axis: string, values: unknown, allowed: readonly string[]): string[] {
	if (!Array.isArray(values) || values.length === 0) {
		return [`${id}: labels.${axis} must list at least one accepted ${axis}`];
	}
	return values
		.filter((value) => typeof value !== "string" || !allowed.includes(value))
		.map((value) => `${id}: labels.${axis} has ${JSON.stringify(value)}, which is not one of ${allowed.join(", ")}`);
}

/** Every structural rule of the parent corpus, as a list of errors (empty = valid). */
export function validateParentRoutingCorpus(value: unknown): string[] {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null) return ["corpus must be an object"];
	const corpus = value as Partial<ParentRoutingCorpus>;
	if (corpus.version !== 1) errors.push(`corpus version must be 1, got ${JSON.stringify(corpus.version)}`);
	const trials = corpus.live_trials;
	if (typeof trials !== "object" || trials === null) {
		errors.push("corpus.live_trials must say whether parent-model trials have been run");
	} else {
		if (trials.status !== "pending_operator_approval" && trials.status !== "measured") {
			errors.push(`live_trials.status must be "pending_operator_approval" or "measured", got ${JSON.stringify(trials.status)}`);
		}
		if (typeof trials.reason !== "string" || trials.reason.trim().length === 0) {
			errors.push("live_trials.reason must say why the trials are pending, or what was measured");
		}
		// A measured run is only a claim if the artifact behind it exists: model and
		// prompt versions, the tool arguments, the cost metrics.
		if (trials.status === "measured" && (typeof trials.results !== "string" || trials.results.trim().length === 0)) {
			errors.push('live_trials.status "measured" must name the result file it was measured into');
		}
	}
	if (!Array.isArray(corpus.cases)) return [...errors, "corpus.cases must be an array"];

	const cases = corpus.cases as ParentRoutingCase[];
	if (cases.length < PARENT_CORPUS_MIN_CASES || cases.length > PARENT_CORPUS_MAX_CASES) {
		errors.push(`corpus must hold ${PARENT_CORPUS_MIN_CASES}-${PARENT_CORPUS_MAX_CASES} cases, got ${cases.length}`);
	}
	const seen = new Set<string>();
	for (const item of cases) {
		const id = item?.id;
		if (typeof id !== "string" || !ID_RE.test(id)) {
			errors.push(`case id ${JSON.stringify(id)} must be kebab-case`);
			continue;
		}
		if (seen.has(id)) errors.push(`duplicate case id "${id}"`);
		seen.add(id);
		if (!PARENT_ROUTING_SCENARIOS.includes(item.scenario as ParentRoutingScenario)) {
			errors.push(`${id}: scenario "${item.scenario}" is not a required parent scenario`);
		}
		if (typeof item.task !== "string" || item.task.trim().length === 0) {
			errors.push(`${id}: task must be the text the parent would classify`);
		}
		const labels = item.labels;
		if (typeof labels !== "object" || labels === null) {
			errors.push(`${id}: labels are the human ground truth and cannot be omitted`);
			continue;
		}
		errors.push(...subsetErrors(id, "workflow", labels.workflow, WORKFLOW_MODES));
		errors.push(...subsetErrors(id, "scope", labels.scope, SCOPE_WORDS));
		errors.push(...subsetErrors(id, "risk", labels.risk, RISK_WORDS));
		if (typeof labels.why !== "string" || labels.why.trim().length === 0) {
			errors.push(`${id}: labels.why must say why these answers are the accepted ones`);
		}
		const deterministic = item.deterministic;
		if (typeof deterministic !== "object" || deterministic === null) {
			errors.push(`${id}: deterministic must record what classifyIntake/resolveRoutingInputs do with this case`);
			continue;
		}
		if (!WORKFLOW_MODES.includes(deterministic.mode as (typeof WORKFLOW_MODES)[number])) {
			errors.push(`${id}: deterministic.mode ${JSON.stringify(deterministic.mode)} is not a workflow mode`);
		}
		if (!SCOPE_WORDS.includes(deterministic.scope as (typeof SCOPE_WORDS)[number])) {
			errors.push(`${id}: deterministic.scope ${JSON.stringify(deterministic.scope)} is not a scope`);
		}
		if (!RISK_WORDS.includes(deterministic.risk as (typeof RISK_WORDS)[number])) {
			errors.push(`${id}: deterministic.risk ${JSON.stringify(deterministic.risk)} is not a risk`);
		}
		for (const axis of ["scope", "risk"] as const) {
			const word = deterministic.provenance?.[axis];
			if (!PROVENANCE_WORDS.includes(word as (typeof PROVENANCE_WORDS)[number])) {
				errors.push(`${id}: deterministic.provenance.${axis} ${JSON.stringify(word)} is not a provenance word`);
			}
		}
		// The one rule that keeps the two layers honest: a deterministic answer the
		// human labels do not accept is allowed (classify is advisory) and must be
		// written down, so nobody later "fixes" it by widening the label.
		if (divergesFromLabels(item) && (typeof item.divergence !== "string" || item.divergence.trim().length === 0)) {
			errors.push(
				`${id}: the deterministic answer (${deterministic.mode}/${deterministic.scope}/${deterministic.risk}) is outside the ` +
					"labels, so `divergence` must say why that is acceptable",
			);
		}
	}

	for (const scenario of PARENT_ROUTING_SCENARIOS) {
		if (!cases.some((item) => item?.scenario === scenario)) errors.push(`no case covers required scenario ${scenario}`);
	}
	return errors;
}

/**
 * Does the deterministic answer fall outside the human labels, on any axis?
 *
 * Defensive about the label lists because `validateParentRoutingCorpus` calls
 * it on input it has not finished validating: a validator that throws instead
 * of listing an error is a validator that cannot report the malformed field.
 */
export function divergesFromLabels(item: ParentRoutingCase): boolean {
	const accepts = (values: unknown, value: string): boolean => Array.isArray(values) && values.includes(value);
	const { labels, deterministic } = item;
	return (
		!accepts(labels.workflow, deterministic.mode) ||
		!accepts(labels.scope, deterministic.scope) ||
		!accepts(labels.risk, deterministic.risk)
	);
}

export function loadParentRoutingCorpus(path: string): ParentRoutingCorpus {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new EvalError(`${path}: cannot read corpus (${(error as Error).message})`);
	}
	const errors = validateParentRoutingCorpus(parsed);
	if (errors.length > 0) throw new EvalError(`${path}: invalid corpus\n  ${errors.join("\n  ")}`);
	return parsed as ParentRoutingCorpus;
}

// ---------------------------------------------------------------------------
// Arms and rendering
// ---------------------------------------------------------------------------

/**
 * One arm of the eval: a prompt directory pair and the model it would run
 * against. Shadowing old against new is two arms over the same corpus — point
 * the baseline arm at a worktree of the old ref (see docs/evals.md).
 */
export interface EvalArm {
	name: string;
	profilesDir: string;
	briefsDir: string;
	model: string;
}

/**
 * Fixed dispatch values every rendered brief uses. `base` is deliberately not
 * `main`: a ship brief that still hardcodes `origin/main` (do8.6) shows up as a
 * contract failure rather than as a silent pass.
 */
export const SAMPLE_VALUES: Required<BriefValues> = Object.freeze({
	job_id: "cp-eval-1",
	branch: "cp-eval-1",
	base: "trunk",
	worktree: "/leases/1/demo",
	task: "Sample task: fix the reported defect and cover it with a regression test.",
	artifact_path: "/home/state/runs/cp-eval-1/artifact.md",
	original_task: "**The original task (what was asked):**\n\n    original-task.md\n",
	review_context: "This is the first review on the branch; diff.md is the complete branch diff.",
	project: "demo",
	kind: "ship",
	delivery: "pr",
	lens: "completeness",
});

const SURFACE_FILES: Record<EvalSurface, { dir: "profiles" | "briefs"; name: string }> = Object.freeze({
	"planner-profile": { dir: "profiles", name: "planner" },
	"reviewer-profile": { dir: "profiles", name: "gate-reviewer" },
	"implementer-profile": { dir: "profiles", name: "implementer" },
	"research-brief": { dir: "briefs", name: "brief-research" },
	"qa-brief": { dir: "briefs", name: "brief-qa" },
	"ship-brief": { dir: "briefs", name: "brief-ship" },
	"gate-rubric": { dir: "briefs", name: "gate-rubric" },
	"diff-rubric": { dir: "briefs", name: "diff-review-rubric" },
});

/** The assembled prompt text for a surface, exactly as a worker would see it. */
export function renderSurface(arm: EvalArm, surface: EvalSurface, values: BriefValues = SAMPLE_VALUES): string {
	const spec = SURFACE_FILES[surface];
	if (!spec) throw new EvalError(`unknown surface "${surface}"`);
	if (spec.dir === "profiles") return loadProfile(arm.profilesDir, spec.name).systemPrompt;
	const template = readBriefTemplate(arm.briefsDir, spec.name);
	return renderTemplate(template, values, `${spec.name}.md`);
}

/**
 * The eval harness's one deviation from production, stated in the prompt so a
 * transcript shows it: `pi -p` has no `report_verdict`/`report_result` tool, so
 * a quality case asks for the same payload as a single JSON object.
 */
export const EVAL_OUTPUT_CONTRACT = [
	"## Eval harness output contract",
	"",
	"This is an offline evaluation. The tool you would normally finish with is",
	"not available here, so end your reply with one JSON object carrying exactly",
	"what that tool call would have carried, and nothing after it:",
	"",
	'    {"verdict": "pass|revise|escalate", "flags": {}, "reasons": [], "revisions": []}',
	"",
	"for a review, or",
	"",
	'    {"status": "done|blocked", "summary": "...", "artifact": "..."}',
	"",
	"for a planner or implementer case, where `artifact` is the document you",
	"would have written.",
].join("\n");

/** The whole prompt for a case: the surface, plus the subject for a quality case. */
export function renderCase(item: EvalCase, arm: EvalArm): string {
	const surface = renderSurface(arm, item.surface, { ...SAMPLE_VALUES, task: item.subject ?? SAMPLE_VALUES.task });
	if (item.kind === "contract") return surface;
	return [surface, EVAL_OUTPUT_CONTRACT, "## Subject", "", item.subject ?? ""].join("\n\n");
}

// ---------------------------------------------------------------------------
// Versions: what produced a result
// ---------------------------------------------------------------------------

export interface ArmVersions {
	arm: string;
	model: string;
	package_version: string;
	/** `<relative path>` → `sha256:<hex>` for every prompt file in the arm. */
	prompts: Record<string, string>;
}

function sha256(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function hashDir(dir: string, root: string, into: Record<string, string>): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir).sort()) {
		if (!entry.endsWith(".md")) continue;
		const path = join(dir, entry);
		into[relative(root, path) || path] = sha256(readFileSync(path, "utf8"));
	}
}

/**
 * Prompt/model/package versions for one arm (do8.7: "Record prompt/model/package
 * versions with each run"). Hashes, not mtimes: a result that cannot say which
 * prompt text produced it cannot support a rollout decision.
 */
export function armVersions(arm: EvalArm, options: { root?: string; packageVersion?: string } = {}): ArmVersions {
	const root = options.root ?? process.cwd();
	const prompts: Record<string, string> = {};
	hashDir(arm.profilesDir, root, prompts);
	hashDir(arm.briefsDir, root, prompts);
	return {
		arm: arm.name,
		model: arm.model,
		package_version: options.packageVersion ?? readPackageVersion(root),
		prompts,
	};
}

function readPackageVersion(root: string): string {
	try {
		return String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "unknown");
	} catch {
		return "unknown";
	}
}

// ---------------------------------------------------------------------------
// Transports: how a quality case reaches a model (or does not)
// ---------------------------------------------------------------------------

export interface CaseOutput {
	text: string;
	tokens?: number;
	tool_calls?: number;
}

export interface TransportInput {
	case: EvalCase;
	arm: EvalArm;
	prompt: string;
	trial: number;
}

export type EvalTransport = (input: TransportInput) => Promise<CaseOutput>;

/**
 * The money gate, in the shape `tests/harness/live.ts` already uses: a reason
 * string when the operator has not opened it, `false` when they have. Model
 * trials are paid work and are never run because a suite felt like it.
 */
export function liveEvalSkip(env: NodeJS.ProcessEnv = process.env): string | false {
	if (env.CP_EVAL_LIVE !== "1") {
		return "set CP_EVAL_LIVE=1 to run model-quality evals (operator-authorized: they call a real model and cost money)";
	}
	return false;
}

/**
 * Read a run's transcript into a scorable output.
 *
 * A `pi --mode json` run emits one JSON event per line, and those events carry
 * the two numbers the rollout gate needs: cumulative `usage` on assistant
 * messages, and one `tool_execution_start` per tool call. Anything that does
 * not parse as such a stream is treated as plain text with no measurement —
 * `undefined`, never `0`, because "nobody counted" and "it used no tokens" must
 * not read the same in a median.
 */
export function parseTranscript(stdout: string): CaseOutput {
	let events = 0;
	let toolCalls = 0;
	let settledTokens = 0;
	let inFlightTokens = 0;
	const chunks: string[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
			event = parsed as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof event.type !== "string") continue;
		events += 1;
		if (event.type === "tool_execution_start") toolCalls += 1;
		if (event.type === "message_update") {
			// Cumulative for the message still streaming: it replaces, never adds.
			inFlightTokens = usageTokens(event.usage) ?? inFlightTokens;
			continue;
		}
		if (event.type !== "message_end") continue;
		const message = event.message as Record<string, unknown> | undefined;
		if (message === undefined) continue;
		const tokens = usageTokens(message.usage);
		if (tokens !== undefined) {
			settledTokens += tokens;
			inFlightTokens = 0;
		}
		if (message.role === "assistant") chunks.push(messageText(message.content));
	}
	if (events === 0) return { text: stdout };
	const text = chunks.join("\n").trim();
	const total = settledTokens + inFlightTokens;
	return {
		// An event stream that carried no assistant text still has to be scorable:
		// fall back to the raw stream rather than scoring an empty string.
		text: text.length > 0 ? text : stdout,
		...(total > 0 ? { tokens: total } : {}),
		tool_calls: toolCalls,
	};
}

/** pi's own usage shape (`totalTokens`, or the parts when it is absent). */
function usageTokens(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const usage = value as Record<string, unknown>;
	const number = (key: string): number | undefined => (typeof usage[key] === "number" ? (usage[key] as number) : undefined);
	const total = number("totalTokens") ?? number("total_tokens");
	if (total !== undefined) return total;
	const parts = ["input", "output", "cacheRead", "cacheWrite"].map((key) => number(key));
	if (parts.every((part) => part === undefined)) return undefined;
	return parts.reduce((sum: number, part) => sum + (part ?? 0), 0);
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (typeof part !== "object" || part === null) return "";
			const text = (part as Record<string, unknown>).text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

/**
 * Replay a recorded run: `<dir>/<arm>/<case-id>.<trial>.txt` (or `.txt` without
 * the trial). This is how a paid run is scored again for free — the recordings
 * are the evidence, the scorer stays deterministic. A recording that is the raw
 * `pi --mode json` stream carries its tokens and tool calls with it; a plain
 * transcript scores the same, minus those two metrics.
 */
export function replayTransport(dir: string): EvalTransport {
	return async ({ case: item, arm, trial }) => {
		const candidates = [
			join(dir, arm.name, `${item.id}.${trial}.txt`),
			join(dir, arm.name, `${item.id}.txt`),
			join(dir, `${item.id}.${trial}.txt`),
			join(dir, `${item.id}.txt`),
		];
		const found = candidates.find((path) => existsSync(path));
		if (!found) throw new EvalError(`no recording for ${arm.name}/${item.id} trial ${trial} (looked in ${dir})`);
		return parseTranscript(readFileSync(found, "utf8"));
	};
}

/**
 * Wall-clock ceiling for one live case, in milliseconds. There is no GNU
 * `timeout` on every machine this runs on (and none on macOS), so the bound is
 * Node's own `execFileSync` option: a hang is killed by the runtime rather than
 * holding the run forever.
 */
export const EVAL_TIMEOUT_DEFAULT_MS = 600_000;

export function liveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.CP_EVAL_TIMEOUT_MS;
	if (raw === undefined || raw === "") return EVAL_TIMEOUT_DEFAULT_MS;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new EvalError(`CP_EVAL_TIMEOUT_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}`);
	}
	return value;
}

/**
 * A real headless model run, one prompt in, one transcript out. Refused unless
 * `CP_EVAL_LIVE=1`; `CP_EVAL_PI_BIN` points it at a stand-in so the plumbing is
 * exercised in the free suite without spending anything.
 *
 * `--mode json` rather than `-p`: the event stream is what carries usage and
 * tool calls, and a median the runner cannot populate is a rollout gate nobody
 * can apply.
 */
export function liveTransport(env: NodeJS.ProcessEnv = process.env): EvalTransport {
	return async ({ arm, prompt, case: item, trial }) => {
		const reason = liveEvalSkip(env);
		if (reason !== false) throw new EvalError(`live eval refused: ${reason}`);
		const bin = env.CP_EVAL_PI_BIN ?? "pi";
		const timeout = liveTimeoutMs(env);
		try {
			const stdout = execFileSync(
				bin,
				["--mode", "json", "--model", arm.model, "--no-extensions", "--no-skills", prompt],
				{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout, killSignal: "SIGKILL", env },
			);
			return parseTranscript(stdout);
		} catch (error) {
			throw new EvalError(liveFailure(error, { bin, caseId: item.id, trial, timeout }));
		}
	};
}

/** Every live failure says what died, what it cost, and what to do next. */
function liveFailure(error: unknown, ctx: { bin: string; caseId: string; trial: number; timeout: number }): string {
	const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; status?: number; stderr?: string | Buffer };
	const where = `${ctx.caseId} (trial ${ctx.trial})`;
	const stderr = String(failure.stderr ?? "")
		.trim()
		.split("\n")
		.slice(-5)
		.join("\n");
	const tail = stderr.length > 0 ? `\n  stderr: ${stderr}` : "";
	if (failure.code === "ETIMEDOUT" || failure.killed === true) {
		return `${where}: \`${ctx.bin}\` exceeded the ${ctx.timeout}ms budget and was killed; nothing was scored for this case. Raise CP_EVAL_TIMEOUT_MS, lower --trials, or score a recorded run with --replay.${tail}`;
	}
	if (failure.code === "ENOENT") {
		return `${where}: no \`${ctx.bin}\` on PATH — set CP_EVAL_PI_BIN to the pi binary you mean to run.${tail}`;
	}
	return `${where}: \`${ctx.bin}\` exited ${failure.status ?? "abnormally"}${failure.signal ? ` (signal ${failure.signal})` : ""}; nothing was scored for this case.${tail}`;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ParsedOutput {
	verdict?: string;
	flags: Record<string, boolean>;
	findings: string[];
	/** A terminal report is the JSON object the output contract asks for. */
	terminal: boolean;
	raw: string;
}

/**
 * Top-level `{...}` spans in a transcript, string-aware so a brace inside a
 * quoted reason does not split one. Nested objects (a `flags` map) are part of
 * their parent span, never candidates of their own — reading the inner one is
 * how a verdict goes missing from a report that clearly stated it.
 */
function topLevelObjects(text: string): string[] {
	const spans: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) spans.push(text.slice(start, index + 1));
		}
	}
	return spans;
}

/** The last top-level JSON object in a transcript, parsed defensively. */
export function parseOutput(text: string): ParsedOutput {
	const spans = topLevelObjects(text);
	for (let index = spans.length - 1; index >= 0; index--) {
		let value: unknown;
		try {
			value = JSON.parse(spans[index] as string);
		} catch {
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const object = value as Record<string, unknown>;
		return {
			...(typeof object.verdict === "string" ? { verdict: object.verdict } : {}),
			flags: asFlags(object.flags),
			findings: [...asStrings(object.reasons), ...asStrings(object.revisions), ...asStrings(object.findings)],
			terminal: typeof object.verdict === "string" || typeof object.status === "string",
			raw: text,
		};
	}
	return { flags: {}, findings: [], terminal: false, raw: text };
}

function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asFlags(value: unknown): Record<string, boolean> {
	if (typeof value !== "object" || value === null) return {};
	const flags: Record<string, boolean> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "boolean") flags[key] = item;
	}
	return flags;
}

/** Which metric a check feeds. One check, one bucket, so aggregation is a group-by. */
export type MetricBucket = "contract" | "terminal" | "coverage" | "evidence" | "expectation";

export interface Check {
	name: string;
	bucket: MetricBucket;
	ok: boolean;
	detail?: string;
}

export interface FindingScore {
	true_positives: number;
	false_positives: number;
	false_negatives: number;
	precision: number | null;
	recall: number | null;
	severity_matches: number;
	severity_scored: number;
}

/**
 * Precision and recall of a reviewer's findings against human labels.
 *
 * A label is matched by the first finding whose text matches its regex, and a
 * matched finding is consumed — two findings about one defect are one true
 * positive and one false positive, which is what "precision" has to mean if a
 * reviewer is not to be rewarded for repeating itself. Severity calibration is
 * scored only on matched pairs: a defect nobody found has no severity to grade.
 */
export function scoreFindings(labels: DefectLabel[], findings: string[]): FindingScore {
	const unmatched = [...findings];
	let truePositives = 0;
	let severityMatches = 0;
	let falseNegatives = 0;
	for (const label of labels) {
		const re = new RegExp(label.match, "i");
		const index = unmatched.findIndex((finding) => re.test(finding));
		if (index === -1) {
			falseNegatives += 1;
			continue;
		}
		const [finding] = unmatched.splice(index, 1);
		truePositives += 1;
		if ((finding ?? "").toLowerCase().includes(`severity: ${SEVERITY_WORD[label.severity]}`)) severityMatches += 1;
	}
	const falsePositives = unmatched.length;
	return {
		true_positives: truePositives,
		false_positives: falsePositives,
		false_negatives: falseNegatives,
		precision: truePositives + falsePositives === 0 ? null : truePositives / (truePositives + falsePositives),
		recall: truePositives + falseNegatives === 0 ? null : truePositives / (truePositives + falseNegatives),
		severity_matches: severityMatches,
		severity_scored: truePositives,
	};
}

export interface CaseResult {
	case_id: string;
	role: EvalRole;
	scenario: string;
	kind: EvalKind;
	trial: number;
	status: "passed" | "failed" | "skipped";
	/** Why a case was skipped — always the money gate, never a silent omission. */
	skipped_reason?: string;
	checks: Check[];
	findings?: FindingScore;
	tokens?: number;
	tool_calls?: number;
}

/** Score a contract case: the assertions are about the prompt text itself. */
export function scoreContractCase(item: EvalCase, prompt: string): Check[] {
	return textChecks(item.expect ?? {}, prompt, "contract");
}

function textChecks(expect: EvalExpect, text: string, bucket: MetricBucket): Check[] {
	const checks: Check[] = [];
	for (const needle of expect.includes ?? []) {
		checks.push({ name: `includes ${JSON.stringify(needle)}`, bucket, ok: text.includes(needle) });
	}
	for (const needle of expect.excludes ?? []) {
		checks.push({ name: `excludes ${JSON.stringify(needle)}`, bucket, ok: !text.includes(needle) });
	}
	return checks;
}

const PATH_LINE_RE = /[\w./-]+\.[a-z]{2,4}:\d+/;

/** Score a quality case's model output against its expectations and labels. */
export function scoreQualityCase(item: EvalCase, output: CaseOutput): { checks: Check[]; findings?: FindingScore } {
	const expect = item.expect ?? {};
	const parsed = parseOutput(output.text);
	const checks: Check[] = [
		{ name: "terminal report", bucket: "terminal", ok: parsed.terminal, detail: parsed.terminal ? undefined : "no terminal JSON report in the output" },
	];
	if (expect.verdict !== undefined) {
		checks.push({
			name: `verdict is ${expect.verdict}`,
			bucket: "expectation",
			ok: parsed.verdict === expect.verdict,
			detail: parsed.verdict === expect.verdict ? undefined : `got ${JSON.stringify(parsed.verdict)}`,
		});
	}
	for (const [flag, wanted] of Object.entries(expect.flags ?? {})) {
		checks.push({
			name: `flag ${flag} is ${wanted}`,
			bucket: "expectation",
			ok: parsed.flags[flag] === wanted,
			detail: parsed.flags[flag] === wanted ? undefined : `got ${JSON.stringify(parsed.flags[flag])}`,
		});
	}
	checks.push(...textChecks(expect, output.text, "expectation"));
	for (const requirement of expect.coverage ?? []) {
		checks.push({
			name: `covers ${JSON.stringify(requirement)}`,
			bucket: "coverage",
			ok: new RegExp(requirement, "i").test(output.text),
		});
	}
	if (expect.evidence) {
		checks.push({ name: "cites path:line evidence", bucket: "evidence", ok: PATH_LINE_RE.test(output.text) });
	}
	if (expect.labels === undefined) return { checks };
	const findings = scoreFindings(expect.labels, parsed.findings);
	checks.push({
		name: "no false positives",
		bucket: "expectation",
		ok: findings.false_positives === 0,
		detail: findings.false_positives === 0 ? undefined : `${findings.false_positives} unlabeled finding(s)`,
	});
	checks.push({
		name: "all labeled defects found",
		bucket: "expectation",
		ok: findings.false_negatives === 0,
		detail: findings.false_negatives === 0 ? undefined : `${findings.false_negatives} labeled defect(s) missed`,
	});
	return { checks, findings };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
	corpus: EvalCorpus;
	arm: EvalArm;
	/** Absent = contract-only: quality cases are recorded `skipped`, with the reason. */
	transport?: EvalTransport;
	/** Trials per quality case; contract cases are deterministic and run once. */
	trials?: number;
	role?: EvalRole;
	kind?: EvalKind;
	root?: string;
	packageVersion?: string;
}

export interface EvalMetrics {
	cases_scored: number;
	cases_passed: number;
	quality_skipped: number;
	/** Share of checks passed, per bucket. `null` when the bucket had no checks. */
	contract_compliance: number | null;
	terminal_report: number | null;
	task_coverage: number | null;
	grounded_evidence: number | null;
	/** Planner quality cases that passed on their first trial. */
	plan_first_pass: number | null;
	/** Implementer quality cases that passed every check. */
	implementation_verification: number | null;
	reviewer_precision: number | null;
	reviewer_recall: number | null;
	reviewer_severity_accuracy: number | null;
	median_tokens: number | null;
	median_tool_calls: number | null;
}

export interface EvalRunResult {
	version: 1;
	mode: "contract" | "model";
	trials: number;
	versions: ArmVersions;
	corpus: { version: number; cases: number; sha: string };
	metrics: EvalMetrics;
	by_role: Record<string, EvalMetrics>;
	cases: CaseResult[];
}

const NO_TRANSPORT =
	"model-quality evals need a transport: --replay <dir> for a recorded run, or CP_EVAL_LIVE=1 for a paid live run";

/**
 * Run one arm over the corpus. Deterministic in contract mode: same prompts in,
 * byte-identical result out, which is what makes the checked-in result file a
 * drift detector rather than a snapshot of a mood.
 */
export async function runEval(options: RunOptions): Promise<EvalRunResult> {
	const { corpus, arm } = options;
	const trials = Math.max(1, options.trials ?? 1);
	const selected = corpus.cases
		.filter((item) => (options.role ? item.role === options.role : true))
		.filter((item) => (options.kind ? item.kind === options.kind : true))
		.slice()
		.sort((a, b) => a.id.localeCompare(b.id));

	const results: CaseResult[] = [];
	for (const item of selected) {
		if (item.kind === "contract") {
			const checks = scoreContractCase(item, renderCase(item, arm));
			results.push({ ...base(item, 1), status: checks.every((check) => check.ok) ? "passed" : "failed", checks });
			continue;
		}
		if (!options.transport) {
			results.push({ ...base(item, 1), status: "skipped", skipped_reason: NO_TRANSPORT, checks: [] });
			continue;
		}
		for (let trial = 1; trial <= trials; trial++) {
			const prompt = renderCase(item, arm);
			const output = await options.transport({ case: item, arm, prompt, trial });
			const { checks, findings } = scoreQualityCase(item, output);
			results.push({
				...base(item, trial),
				status: checks.every((check) => check.ok) ? "passed" : "failed",
				checks,
				...(findings ? { findings } : {}),
				...(output.tokens === undefined ? {} : { tokens: output.tokens }),
				...(output.tool_calls === undefined ? {} : { tool_calls: output.tool_calls }),
			});
		}
	}

	const byRole: Record<string, EvalMetrics> = {};
	for (const role of Object.keys(ROLE_SURFACES).sort()) {
		const subset = results.filter((result) => result.role === role);
		if (subset.length > 0) byRole[role] = summarize(subset);
	}
	return {
		version: 1,
		mode: options.transport ? "model" : "contract",
		trials,
		versions: armVersions(arm, {
			...(options.root ? { root: options.root } : {}),
			...(options.packageVersion ? { packageVersion: options.packageVersion } : {}),
		}),
		corpus: { version: corpus.version, cases: selected.length, sha: sha256(JSON.stringify(corpus)) },
		metrics: summarize(results),
		by_role: byRole,
		cases: results,
	};
}

function base(item: EvalCase, trial: number): Omit<CaseResult, "status" | "checks"> {
	return { case_id: item.id, role: item.role, scenario: item.scenario, kind: item.kind, trial };
}

function rate(ok: number, total: number): number | null {
	return total === 0 ? null : round(ok / total);
}

function round(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function bucketRate(results: CaseResult[], bucket: MetricBucket): number | null {
	const checks = results.flatMap((result) => result.checks.filter((check) => check.bucket === bucket));
	return rate(checks.filter((check) => check.ok).length, checks.length);
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? (sorted[middle] as number) : round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

/** The metric table do8.7 asks for, computed over whatever actually ran. */
export function summarize(results: CaseResult[]): EvalMetrics {
	const scored = results.filter((result) => result.status !== "skipped");
	const quality = scored.filter((result) => result.kind === "quality");
	const planner = quality.filter((result) => result.role === "planner" && result.trial === 1);
	const implementer = quality.filter((result) => result.role === "implementer");
	const findings = scored.map((result) => result.findings).filter((score): score is FindingScore => score !== undefined);
	const sum = (pick: (score: FindingScore) => number): number => findings.reduce((total, score) => total + pick(score), 0);
	const truePositives = sum((score) => score.true_positives);
	const falsePositives = sum((score) => score.false_positives);
	const falseNegatives = sum((score) => score.false_negatives);
	return {
		cases_scored: scored.length,
		cases_passed: scored.filter((result) => result.status === "passed").length,
		quality_skipped: results.filter((result) => result.status === "skipped").length,
		contract_compliance: bucketRate(scored, "contract"),
		terminal_report: bucketRate(scored, "terminal"),
		task_coverage: bucketRate(scored, "coverage"),
		grounded_evidence: bucketRate(scored, "evidence"),
		plan_first_pass: rate(planner.filter((result) => result.status === "passed").length, planner.length),
		implementation_verification: rate(implementer.filter((result) => result.status === "passed").length, implementer.length),
		reviewer_precision: rate(truePositives, truePositives + falsePositives),
		reviewer_recall: rate(truePositives, truePositives + falseNegatives),
		reviewer_severity_accuracy: rate(sum((score) => score.severity_matches), sum((score) => score.severity_scored)),
		median_tokens: median(scored.map((result) => result.tokens).filter((value): value is number => value !== undefined)),
		median_tool_calls: median(scored.map((result) => result.tool_calls).filter((value): value is number => value !== undefined)),
	};
}

/** The on-disk form: two-space JSON with a trailing newline, and no wall clock. */
export function formatResult(result: EvalRunResult): string {
	return `${JSON.stringify(result, null, 2)}\n`;
}
