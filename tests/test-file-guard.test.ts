/**
 * The suite's file-coverage guard (um58 #17, cp-pr8y) — the guard's own test.
 *
 * `npm test` loads `scripts/test-file-guard.ts` as a second reporter; this file
 * proves what matters against fixtures the suite's own glob never picks up (they
 * drop the `.test` infix, like the runner-bounds fixtures):
 *
 *   - a discovered file that registers nothing fails the run, and only it is named
 *   - a whole-suite skip counts as ran, whether it is a skipped child or a
 *     `describe.skip` that never reports one
 *   - a guard pattern that matches nothing fails instead of passing quietly
 *   - the pattern the guard globs is the one `npm test` passes to the runner
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TEST_FILE_GLOB } from "../scripts/test-file-guard.ts";
import { REPO_ROOT } from "./harness/index.ts";

const FIXTURES = "tests/fixtures/test-file-guard";

/** Wall-clock ceiling for a fixture run; the point is that it ends. */
const FIXTURE_BUDGET_MS = 60_000;

function runGuard(pattern: string, guardGlob = pattern) {
	// `NODE_TEST_CONTEXT` is set by the runner that is running *this* file. Left
	// in place it makes the nested runner report to a parent that is not
	// listening: it exits 0 with no output, and the fixture silently never runs.
	const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;

	return spawnSync(
		process.execPath,
		[
			"--test",
			"--test-force-exit",
			"--test-reporter=spec",
			"--test-reporter-destination=stdout",
			"--test-reporter=./scripts/test-file-guard.ts",
			"--test-reporter-destination=stdout",
			pattern,
		],
		{ cwd: REPO_ROOT, encoding: "utf8", env: { ...env, CP_TEST_FILE_GLOB: guardGlob }, timeout: FIXTURE_BUDGET_MS },
	);
}

test("a discovered file that produced no test fails the run, named and alone", () => {
	const result = runGuard(`${FIXTURES}/**/*.ts`);

	assert.notEqual(result.status, 0, `the guard must fail a run where a file produced nothing:\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, /produced-nothing\.ts/, `the silent file must be named:\n${result.stderr}`);
	assert.doesNotMatch(
		result.stderr,
		/with-tests\.ts|all-skipped\.ts|skipped-describe\.ts|skipped-with-reason\.ts|todo-with-reason\.ts/,
		`only the silent file is named:\n${result.stderr}`
	);
});

test("a file whose whole suite is skipped counts as ran, so the guard stays quiet", () => {
	const result = runGuard(`${FIXTURES}/ran/*.ts`);

	assert.equal(result.status, 0, `a skipped suite must not fail the guard:\n${result.stdout}\n${result.stderr}`);
	assert.doesNotMatch(result.stderr, /produced no test/, `skip is a reported test, not silence:\n${result.stderr}`);
	// The `describe.skip` fixture really ran and really reported nothing else:
	// its suite line is in the output with its children never started.
	assert.match(result.stdout, /skipped with describe\.skip[^\n]*# SKIP/, `the suite-level skip must have run:\n${result.stdout}`);
	// The reason-string forms: node reports the reason instead of `true`, and a
	// suite skipped or todo'd whole reports no child at all.
	assert.match(
		result.stdout,
		/skipped with a reason string[^\n]*# the conditional-skip form/,
		`a skip carrying a reason must count:\n${result.stdout}`
	);
	assert.match(result.stdout, /todo suite with a reason and no children[^\n]*# later/, `a todo carrying a reason must count:\n${result.stdout}`);
});

test("a guard pattern that matches nothing fails instead of passing quietly", () => {
	const result = runGuard(`${FIXTURES}/ran/*.ts`, `${FIXTURES}/nothing-here/*.ts`);

	assert.notEqual(result.status, 0, `an empty discovery set is silence, not a pass:\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, /found no test files/, `the broken pattern must be named:\n${result.stderr}`);
});

test("the guard checks exactly the pattern npm test gives the runner", () => {
	const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
	assert.ok(scripts.test?.includes(`"${TEST_FILE_GLOB}"`), `npm test must pass ${TEST_FILE_GLOB}: ${scripts.test}`);
	assert.doesNotMatch(scripts["test:one"] ?? "", /test-file-guard/, "a focused run stays unchanged");
});
