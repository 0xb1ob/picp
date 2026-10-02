/**
 * autonomy-programme-cur.5.3 acceptance: "Eval corpus covers decide-vs-ask on
 * at least four escalation kinds." Deterministic and free, same convention as
 * evals/parent-routing.json's `deterministic` layer: `labels` (here `expect`)
 * are human ground truth, `operatorAction` is this repository's own code, and
 * this test proves the two still agree — not a model's judgement.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ESCALATION_KINDS } from "../src/contracts.ts";
import { operatorAction } from "../src/operator-note.ts";
import { REPO_ROOT } from "./harness/index.ts";

interface OperatorEvalCase {
	id: string;
	kind: string;
	in_scope?: boolean;
	expect: "ask" | "decide";
	why: string;
}

function loadCorpus(): OperatorEvalCase[] {
	const raw = JSON.parse(readFileSync(join(REPO_ROOT, "evals/operator-decide-vs-ask.json"), "utf8"));
	return raw.cases;
}

test("operator decide-vs-ask corpus covers at least four escalation kinds", () => {
	const cases = loadCorpus();
	const kinds = new Set(cases.map((c) => c.kind));
	assert.ok(kinds.size >= 4, `only ${kinds.size} distinct kinds`);
	for (const kind of kinds) assert.ok(ESCALATION_KINDS.includes(kind as never), `unknown escalation kind ${kind}`);
});

test("every case's expectation matches operatorAction (docs/contracts.md's own split)", () => {
	for (const c of loadCorpus()) {
		assert.equal(operatorAction(c.kind, c.in_scope), c.expect, `${c.id}: ${c.why}`);
	}
});

test("a risk:high escalation is always ask, in scope or not", () => {
	assert.equal(operatorAction("risk_high_irreversible", true), "ask");
	assert.equal(operatorAction("risk_high_irreversible", false), "ask");
});

test("an in-scope plan approval is the one decide case", () => {
	assert.equal(operatorAction("plan_approval", true), "decide");
	assert.equal(operatorAction("plan_approval", false), "ask");
});
