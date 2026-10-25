import assert from "node:assert/strict";
import { test } from "node:test";
import {
	declarationTitles, deletedWithFeatureFindings, featureRemovedFindings, regressionFindings, retainedFindings,
} from "../scripts/test-migration-check.ts";

const exists = (path: string) => path === "src/kept.ts";

test("deleted-with-feature accepts a named remover and removed source modules, and needs no negative control", () => {
	assert.deepEqual(deletedWithFeatureFindings("tests/x.test.ts", "cp-remove-x (#12)", "tested `src/x.ts`", exists), []);
	assert.deepEqual(deletedWithFeatureFindings("tests/x.test.ts", "#12", "tested extensions/command-post/x.ts", exists), []);
});

test("deleted-with-feature rejects a phase-only owner, no cited module, and a module still in the tree", () => {
	assert.match(deletedWithFeatureFindings("tests/x.test.ts", "P1", "tested `src/x.ts`", exists).join("\n"), /must name the removing PR or job/);
	assert.match(deletedWithFeatureFindings("tests/x.test.ts", "#12", "feature retired", exists).join("\n"), /names no removed source module/);
	assert.match(deletedWithFeatureFindings("tests/x.test.ts", "#12", "src/x.ts, src/kept.ts", exists).join("\n"),
		/cites src\/kept\.ts, which still exists/);
});

test("retained accepts a note naming a kept test file, and rejects no note, the unit itself or a missing file", () => {
	const kept = (path: string) => path === "tests/decide.test.ts" || path === "tests/x.test.ts";
	assert.deepEqual(retainedFindings("tests/x.test.ts", "a", "moved verbatim to `tests/decide.test.ts` (owned by P10)", kept), []);
	assert.match(retainedFindings("tests/x.test.ts", "a", "", kept).join("\n"), /retained with no note naming where it is kept/);
	assert.match(retainedFindings("tests/x.test.ts", "a", "kept in tests/x.test.ts", kept).join("\n"), /names no kept test file in the tree \(got none\)/);
	assert.match(retainedFindings("tests/x.test.ts", "a", "moved to tests/gone.test.ts", kept).join("\n"), /\(got tests\/gone\.test\.ts\)/);
});

const known = new Set(["S1"]);

test("a negative-control row needs only scenario, control in words and failing assertion; no patch, sha or hash", () => {
	const lean = regressionFindings(["NC-1", "tests/x.test.ts", "S1", "drop the head guard in src/x.ts", "expected refusal"], known);
	assert.deepEqual(lean, { path: "tests/x.test.ts", findings: [] });
	const legacy = ["NC-2", "tests/y.test.ts", "not-a-sha", "S1", "NC-2", "not-a-hash", "expected refusal", ""];
	assert.deepEqual(regressionFindings(legacy, known), { path: "tests/y.test.ts", findings: [] });
});

test("a negative-control row rejects an unknown scenario, no control, no failing assertion and a wrong cell count", () => {
	const findings = regressionFindings(["NC-1", "tests/x.test.ts", "S9", "", ""], known).findings.join("\n");
	assert.match(findings, /unknown scenario S9/);
	assert.match(findings, /needs the control/);
	assert.match(findings, /needs a failing assertion/);
	assert.match(regressionFindings(["NC-1", "tests/x.test.ts", "S1", "c"], known).findings.join("\n"), /4 cells, expected/);
});

const source = (...titles: string[]) => titles.map((title) => `test(${JSON.stringify(title)}, () => {});`).join("\n");
const titles = () => ({
	base: declarationTitles("a.test.ts", source("kept", "removed one", "removed two")),
	tree: declarationTitles("a.test.ts", source("kept")),
});
const lost = new Map([["tests/a.test.ts", { before: 3, after: 1 }]]);

test("feature-removed accepts one note per lost declaration naming the remover", () => {
	const rows = [["tests/a.test.ts", "removed one", "cp-remove-x"], ["tests/a.test.ts", "removed two", "#12"]];
	assert.deepEqual(featureRemovedFindings(rows, lost, titles), []);
});

test("feature-removed rejects an uncovered loss, a missing remover, a duplicate, an unknown or a still-declared title", () => {
	const findings = featureRemovedFindings([
		["tests/a.test.ts", "removed one", "P1"],
		["tests/a.test.ts", "removed one", "#12"],
		["tests/a.test.ts", "never existed", "#12"],
		["tests/a.test.ts", "kept", "#12"],
	], lost, titles).join("\n");
	assert.match(findings, /"removed one" must name the removing PR or job/);
	assert.match(findings, /"removed one" listed twice/);
	assert.match(findings, /"never existed" is not a baseline declaration/);
	assert.match(findings, /"kept" is still declared/);
	assert.match(featureRemovedFindings([["tests/a.test.ts", "removed one", "#12"]], lost, titles).join("\n"),
		/3 → 1 declarations with no deletion record \(1 feature-removed note\(s\)\)/);
});
