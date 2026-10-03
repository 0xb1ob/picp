/**
 * CI host-tool sentinel. The m2/m3/pipeline lease suites self-skip when
 * `treehouse` is missing, and node:test exits 0 on a skip — so on CI a missing
 * binary would look green. Under GITHUB_ACTIONS this fails closed instead;
 * off CI (laptops) the skip stays allowed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { noModelAuthFinding, treehouseAvailable } from "./harness/index.ts";

test("CI has treehouse on PATH so the lease suites run instead of skipping", () => {
	const available = treehouseAvailable();
	if (process.env.GITHUB_ACTIONS === "true" && !available) {
		assert.fail("treehouse is not on PATH; lease e2e would self-skip");
	}
	assert.equal(typeof available, "boolean");
});

test("the CI no-model-auth tolerance covers only 'no authenticated model at all'", () => {
	const none =
		"no usable model for planner job cp-doctor: every candidate for profile planner was refused — " +
		"vendor-a/model-x (availability), vendor-b/model-y (availability). Authenticate one of those providers (`pi auth`), " +
		"widen `allow`, or edit the candidates in data/routing.json. Available: (none).";
	const single = "no available model for qa job cp-doctor: vendor-a/model-x (profile, qa) is not usable. A model must be in pi's registry with resolvable auth. Available: (none).";
	const finding = (detail: string, check = "models.planner", severity = "error") => ({ check, severity, detail });

	assert.equal(noModelAuthFinding(finding(none)), true, "every candidate unauthenticated, nothing available");
	assert.equal(noModelAuthFinding(finding(single)), true, "the one-candidate availability refusal");
	// Regressions that must still fail the live-doctor tests on CI:
	assert.equal(noModelAuthFinding(finding(none.replace("model-y (availability)", "model-y (allowlist)"))), false, "an allowlist refusal");
	assert.equal(noModelAuthFinding(finding(none.replace("model-x (availability)", "model-x (effort)"))), false, "an effort refusal");
	assert.equal(noModelAuthFinding(finding(none.replace("(none)", "vendor-c/model-z"))), false, "a model is authenticated, yet refused");
	assert.equal(noModelAuthFinding(finding("planner: profile parse failed")), false, "a non-auth models error");
	assert.equal(noModelAuthFinding(finding(none, "home.location")), false, "not a models.* check");
	assert.equal(noModelAuthFinding(finding(none, "models.planner", "warn")), false, "not an error");
	assert.equal(noModelAuthFinding({ check: "models.planner", severity: "error" }), false, "no detail");
});
