/**
 * P23b: the one declaration of tests/next.test.ts kept verbatim (V2): the `WORKER_FORBIDDEN_TOOLS` constant, which no
 * parent entry point reads back. tests/e2e/next-p23b.test.ts holds the rest; docs/testing-migration/p23b.md names it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";

test("cp_next is forbidden to workers", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_next"));
});
