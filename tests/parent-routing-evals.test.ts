/**
 * The parent's classification corpus, checked for free (routing T6).
 *
 * What this file does and does not claim is the point of the task it comes
 * from, so it is worth saying twice:
 *
 *  - It proves **wiring and schema**: the corpus loads, every required scenario
 *    is labeled, and the deterministic advisor (`classifyIntake`) and the
 *    routing-input resolver (`resolveRoutingInputs`) still answer each case the
 *    way the corpus records. A change to a keyword list or to the per-axis
 *    overlay fails here.
 *  - It proves **nothing about a parent model's judgment**. Regexes are not a
 *    measurement of a model, and the corpus says so: `labels` are human ground
 *    truth, `deterministic` is code, and `live_trials` records that the paid
 *    parent-model trials have not been run.
 *
 * No model is called anywhere in this file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RISKS, SCOPES } from "../src/contracts.ts";
import {
	divergesFromLabels,
	EvalError,
	loadParentRoutingCorpus,
	PARENT_CORPUS_MAX_CASES,
	PARENT_CORPUS_MIN_CASES,
	PARENT_ROUTING_SCENARIOS,
	type ParentRoutingCase,
	validateParentRoutingCorpus,
} from "../src/evals.ts";
import { classifyIntake, INTAKE_MODES, resolveRoutingInputs } from "../src/pipeline.ts";
import { ALWAYS_AVAILABLE, DEFAULT_ROUTING_CONFIG, pickModel } from "../src/routing.ts";
import { loadProfile } from "../src/profiles.ts";
import { REPO_ROOT } from "./harness/index.ts";

const CORPUS_PATH = join(REPO_ROOT, "evals/parent-routing.json");
const CORPUS = loadParentRoutingCorpus(CORPUS_PATH);

type Given = NonNullable<ParentRoutingCase["given"]>;

function classify(item: ParentRoutingCase): string {
	const given = (item.given ?? {}) as Given;
	return classifyIntake({
		task: item.task,
		...(given.kind ? { kind: given.kind as "ship" | "research" } : {}),
		...(given.scope ? { scope: given.scope as "S" | "M" | "L" } : {}),
		...(given.risk ? { risk: given.risk as "low" | "high" } : {}),
	}).mode;
}

function routeInputs(item: ParentRoutingCase): ReturnType<typeof resolveRoutingInputs> {
	const given = (item.given ?? {}) as Given;
	return resolveRoutingInputs({
		text: item.task,
		...(given.scope ? { scope: given.scope as "S" | "M" | "L" } : {}),
		...(given.risk ? { risk: given.risk as "low" | "high" } : {}),
	});
}

function scratch(): { path: string; cleanup(): void } {
	const path = mkdtempSync(join(tmpdir(), "cp-parent-evals-"));
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// The corpus itself
// ---------------------------------------------------------------------------

test("the parent corpus is a bounded, fully labeled set of hand-written cases", () => {
	assert.ok(
		CORPUS.cases.length >= PARENT_CORPUS_MIN_CASES && CORPUS.cases.length <= PARENT_CORPUS_MAX_CASES,
		`corpus size ${CORPUS.cases.length} is outside ${PARENT_CORPUS_MIN_CASES}-${PARENT_CORPUS_MAX_CASES}`,
	);
	for (const scenario of PARENT_ROUTING_SCENARIOS) {
		assert.equal(CORPUS.cases.filter((item) => item.scenario === scenario).length, 1, `${scenario} needs exactly one case`);
	}
	// The vocabularies are the product's own, not a copy that can drift.
	assert.deepEqual([...INTAKE_MODES].sort(), ["pipeline", "qa", "single"]);
	for (const item of CORPUS.cases) {
		for (const scope of item.labels.scope) assert.ok((SCOPES as readonly string[]).includes(scope), `${item.id}: ${scope}`);
		for (const risk of item.labels.risk) assert.ok((RISKS as readonly string[]).includes(risk), `${item.id}: ${risk}`);
		for (const mode of item.labels.workflow) {
			assert.ok((INTAKE_MODES as readonly string[]).includes(mode), `${item.id}: ${mode}`);
		}
	}
	// Justified ambiguity is expressible and used: a corpus that forced one
	// answer per case would score a defensible choice as wrong.
	assert.ok(
		CORPUS.cases.some((item) => item.labels.workflow.length > 1),
		"no case allows more than one workflow — the ambiguity the labels exist to carry is missing",
	);
	assert.ok(CORPUS.cases.some((item) => item.labels.scope.length > 1));
});

test("workflow labels and resource labels are recorded as separate answers", () => {
	// The separation routing T6 asks for, asserted rather than assumed: neither
	// axis is derivable from the other in this corpus, so a reader cannot mistake
	// one for the other.
	const highRisk = CORPUS.cases.filter((item) => item.labels.risk.includes("high"));
	assert.ok(highRisk.length >= 3, "the corpus needs several high-impact cases");
	assert.ok(
		highRisk.some((item) => item.labels.workflow.includes("single")),
		"every high-impact case wants a pipeline — that is the keyword-to-pipeline conflation this corpus exists to refuse",
	);
	const pipelines = CORPUS.cases.filter((item) => item.labels.workflow.includes("pipeline"));
	assert.ok(
		pipelines.some((item) => item.labels.risk.every((risk) => risk === "low")),
		"no low-impact case wants a plan first — ambiguity, not impact, is what argues for a pipeline",
	);
});

test("every case says whether the deterministic answer is one a human would accept", () => {
	const diverging = CORPUS.cases.filter((item) => divergesFromLabels(item));
	for (const item of diverging) {
		assert.ok((item.divergence ?? "").length > 20, `${item.id} diverges from its labels without saying why`);
	}
	for (const item of CORPUS.cases) {
		if (divergesFromLabels(item)) continue;
		assert.equal(item.divergence, undefined, `${item.id} documents a divergence it does not have`);
	}
	// The keyword advisor really does disagree with human labels on some cases.
	// That is not a defect to hide: it is why classify is advisory, and why the
	// parent's own judgement is what a paid trial has to measure.
	assert.ok(diverging.length > 0, "no case exercises the advisory boundary");
});

// ---------------------------------------------------------------------------
// Wiring: the deterministic layer still answers what the corpus recorded
// ---------------------------------------------------------------------------

test("classifyIntake answers every case the way the corpus records", () => {
	for (const item of CORPUS.cases) {
		assert.equal(classify(item), item.deterministic.mode, `${item.id}: classifyIntake changed its answer`);
	}
});

test("resolveRoutingInputs answers every case the way the corpus records", () => {
	for (const item of CORPUS.cases) {
		const resolved = routeInputs(item);
		assert.deepEqual(
			{ scope: resolved.scope, risk: resolved.risk, provenance: resolved.provenance },
			{ scope: item.deterministic.scope, risk: item.deterministic.risk, provenance: item.deterministic.provenance },
			`${item.id}: routing inputs changed`,
		);
		// A defaulted axis carries no evidence, and an inferred one always does:
		// the record must never read as if somebody measured the default.
		const inferred = [resolved.provenance.scope, resolved.provenance.risk].filter((word) => word === "inferred").length;
		assert.equal(resolved.reasons.length, inferred, `${item.id}: ${resolved.reasons.length} reasons for ${inferred} inferred axes`);
	}
});

test("an explicit axis overrides only its own axis", () => {
	// cp-routing-provenance, pinned through the corpus: the cases that name one
	// axis are exactly the ones where the other must still be assessed.
	const scopeOnly = CORPUS.cases.find((item) => item.scenario === "scope-only-production-credentials") as ParentRoutingCase;
	const scopeResolved = routeInputs(scopeOnly);
	assert.equal(scopeResolved.provenance.scope, "explicit");
	assert.equal(scopeResolved.provenance.risk, "inferred");
	assert.equal(scopeResolved.risk, "high", "naming scope threw away the production-credential signal");

	const riskOnly = CORPUS.cases.find((item) => item.scenario === "risk-only-refactor") as ParentRoutingCase;
	const riskResolved = routeInputs(riskOnly);
	assert.equal(riskResolved.provenance.risk, "explicit");
	assert.equal(riskResolved.provenance.scope, "inferred");
});

test("the research case stays one job only because kind travels with it", () => {
	// The pass-through routing T6 added at the tool boundary, in policy terms:
	// with `kind`, research the operator asked for is one job; without it, the
	// investigation wording alone recommends a pipeline.
	const item = CORPUS.cases.find((scenario) => scenario.scenario === "standalone-research") as ParentRoutingCase;
	assert.equal(item.given?.kind, "research");
	assert.equal(classify(item), "single");
	assert.equal(classifyIntake({ task: item.task }).mode, "pipeline", "the case no longer demonstrates lost research intent");
});

test("a named model decides resources and nothing else", () => {
	const item = CORPUS.cases.find((scenario) => scenario.scenario === "model-override") as ParentRoutingCase;
	const override = item.given?.model as string;
	const profile = loadProfile(join(REPO_ROOT, "profiles"), "implementer");
	const picked = pickModel(
		{ profile, jobId: "cp-parent-eval", project: "demo", kind: "ship", override },
		DEFAULT_ROUTING_CONFIG,
	);
	assert.equal(picked.model, override);
	assert.equal(picked.source, "override");
	// The workflow answer is untouched by the model choice.
	assert.equal(classify(item), item.deterministic.mode);
	assert.equal(ALWAYS_AVAILABLE.isAvailable(override), true);
});

// ---------------------------------------------------------------------------
// The paid half, and the validator that keeps it honest
// ---------------------------------------------------------------------------

test("live parent-model trials are recorded as pending, with no quality claim", () => {
	assert.equal(CORPUS.live_trials.status, "pending_operator_approval");
	assert.match(CORPUS.live_trials.reason, /paid|approv/i);
	assert.equal(CORPUS.live_trials.results, undefined, "a pending corpus must not name a result file");
	// Nothing in the corpus carries a measured number: a metric nobody paid for
	// cannot be reported, and the schema has nowhere to put one.
	assert.doesNotMatch(JSON.stringify(CORPUS).replace(/"why":"[^"]*"/g, ""), /precision|recall|median|accuracy/i);
});

test("a corpus that loses a scenario, a label or a divergence note does not load", (t) => {
	const dir = scratch();
	t.after(() => dir.cleanup());
	const write = (value: unknown): string => {
		const path = join(dir.path, `corpus-${Math.random().toString(36).slice(2)}.json`);
		writeFileSync(path, JSON.stringify(value));
		return path;
	};

	const dropped = { ...CORPUS, cases: CORPUS.cases.filter((item) => item.scenario !== "model-override") };
	assert.throws(() => loadParentRoutingCorpus(write(dropped)), /no case covers required scenario model-override/);
	assert.throws(() => loadParentRoutingCorpus(write({ ...CORPUS, version: 2 })), EvalError);

	const first = CORPUS.cases[0] as ParentRoutingCase;
	assert.match(validateParentRoutingCorpus({ ...CORPUS, cases: [...CORPUS.cases, first] }).join("\n"), /duplicate case id/);
	assert.match(
		validateParentRoutingCorpus({ ...CORPUS, cases: CORPUS.cases.slice(0, 3) }).join("\n"),
		new RegExp(`must hold ${PARENT_CORPUS_MIN_CASES}-${PARENT_CORPUS_MAX_CASES} cases`),
	);
	assert.match(
		validateParentRoutingCorpus({ ...CORPUS, live_trials: { status: "measured", reason: "ran it" } }).join("\n"),
		/must name the result file/,
	);
	assert.match(
		validateParentRoutingCorpus({ ...CORPUS, live_trials: { status: "green", reason: "ran it" } }).join("\n"),
		/live_trials.status must be/,
	);

	// A label set that accepts nothing, and a divergence nobody wrote down: the
	// two ways this corpus could quietly stop being ground truth.
	const emptyLabels = CORPUS.cases.map((item) =>
		item === first ? { ...item, labels: { ...item.labels, workflow: [] } } : item,
	);
	assert.match(validateParentRoutingCorpus({ ...CORPUS, cases: emptyLabels }).join("\n"), /at least one accepted workflow/);

	const undocumented = CORPUS.cases.map((item) => {
		if (!divergesFromLabels(item)) return item;
		const { divergence: _dropped, ...rest } = item;
		return rest;
	});
	assert.match(validateParentRoutingCorpus({ ...CORPUS, cases: undocumented }).join("\n"), /`divergence` must say why/);
});
