/**
 * Guard fixture (um58 #17): a file that registers one real test.
 *
 * Fixtures drop the `.test` infix so the suite's own glob never picks them up;
 * the guard's test runs them explicitly (see `tests/test-file-guard.test.ts`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("the fixture's own test runs", () => {
	assert.equal(1, 1);
});
