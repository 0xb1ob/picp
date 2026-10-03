/**
 * CI host-tool sentinel. The m2/m3/pipeline lease suites self-skip when
 * `treehouse` is missing, and node:test exits 0 on a skip — so on CI a missing
 * binary would look green. Under GITHUB_ACTIONS this fails closed instead;
 * off CI (laptops) the skip stays allowed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { treehouseAvailable } from "./harness/index.ts";

test("CI has treehouse on PATH so the lease suites run instead of skipping", () => {
	const available = treehouseAvailable();
	if (process.env.GITHUB_ACTIONS === "true" && !available) {
		assert.fail("treehouse is not on PATH; lease e2e would self-skip");
	}
	assert.equal(typeof available, "boolean");
});
