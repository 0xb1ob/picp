import assert from "node:assert/strict";
import { test } from "node:test";
import { declarationTitles, deletedWithFeatureFindings, featureRemovedFindings } from "../scripts/test-migration-check.ts";

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
