/**
 * cp-e0c acceptance: the pure repo-derived merge permission rule.
 *
 * `evaluateMergePermission` is the whole decision as one allowlist; everything
 * else in `src/merge-permission.ts` only obtains facts for it. These tests are
 * hermetic — no `gh`, no filesystem — because the rule itself never touches
 * either.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectCiWait } from "../src/ci-wait.ts";
import {
	evaluateMergePermission,
	ghBranchRulesArgs,
	parseBranchRules,
	rulesRequireUpToDate,
} from "../src/merge-permission.ts";

const BRANCH = "cp-abc123";
const HEAD = "aaaaaaaaaaaa1111111111111111111111111111";

function verdictFor(mergeStateStatus: string | undefined, extra: Record<string, unknown> = {}) {
	return evaluateMergePermission({
		branch: BRANCH,
		headSha: HEAD,
		pr: { mergeStateStatus, mergeable: "MERGEABLE", ...extra },
	});
}

test("CLEAN and HAS_HOOKS are permitted \u2014 the whole allowlist", () => {
	assert.equal(verdictFor("CLEAN").permission, "permitted");
	assert.equal(verdictFor("HAS_HOOKS").permission, "permitted");
});

test("BLOCKED with a required review outstanding is pending, cause reviews", () => {
	const verdict = evaluateMergePermission({
		branch: BRANCH,
		headSha: HEAD,
		pr: { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" },
		rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
	});
	assert.equal(verdict.permission, "pending");
	assert.equal(verdict.cause, "reviews");
	assert.match(verdict.reason, /1 approving review/);
});

test("BLOCKED with CHANGES_REQUESTED is also cause reviews", () => {
	const verdict = evaluateMergePermission({
		branch: BRANCH,
		headSha: HEAD,
		pr: { mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" },
	});
	assert.equal(verdict.cause, "reviews");
});

test("BLOCKED with no review decision but a required-checks rule is cause checks", () => {
	const verdict = evaluateMergePermission({
		branch: BRANCH,
		headSha: HEAD,
		pr: { mergeStateStatus: "BLOCKED", reviewDecision: "" },
		rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }],
	});
	assert.equal(verdict.permission, "pending");
	assert.equal(verdict.cause, "checks");
	assert.match(verdict.reason, /test/);
});

test("BLOCKED with the rules unreadable (a 403) is cause unknown_block, never permission", () => {
	const verdict = evaluateMergePermission({
		branch: BRANCH,
		headSha: HEAD,
		pr: { mergeStateStatus: "BLOCKED", reviewDecision: "" },
		rules: undefined,
	});
	assert.equal(verdict.permission, "pending");
	assert.equal(verdict.cause, "unknown_block");
	assert.match(verdict.reason, /cannot read why/);
});

test("BEHIND, DIRTY and DRAFT are all pending, never permission", () => {
	assert.deepEqual(
		[verdictFor("BEHIND").permission, verdictFor("BEHIND").cause],
		["pending", "behind"],
	);
	assert.deepEqual([verdictFor("DIRTY").permission, verdictFor("DIRTY").cause], ["pending", "conflict"]);
	assert.deepEqual([verdictFor("DRAFT").permission, verdictFor("DRAFT").cause], ["pending", "draft"]);
	assert.equal(verdictFor("CLEAN", { isDraft: true }).cause, "draft", "isDraft always overrides, even if CLEAN");
});

test("UNSTABLE is pending \u2014 deliberately stricter than GitHub, because the check-rollup 403s", () => {
	const verdict = verdictFor("UNSTABLE");
	assert.equal(verdict.permission, "pending");
	assert.equal(verdict.cause, "unstable");
	assert.match(verdict.reason, /403/);
});

test("UNKNOWN (mergeStateStatus or mergeable) is retry, never a merge and never a checkpoint", () => {
	assert.equal(verdictFor("UNKNOWN").permission, "retry");
	assert.equal(evaluateMergePermission({ branch: BRANCH, headSha: HEAD, pr: { mergeStateStatus: "CLEAN", mergeable: "UNKNOWN" } }).permission, "retry");
});

test("absent, empty or an unrecognised mergeStateStatus is unreadable \u2014 never read as permission", () => {
	assert.equal(verdictFor(undefined).permission, "unreadable");
	assert.equal(verdictFor("").permission, "unreadable");
	assert.equal(verdictFor("SOME_NEW_VALUE_GH_INVENTED").permission, "unreadable");
});

test("parseBranchRules is tolerant of the real payload, empty arrays, non-JSON and a 403 body", () => {
	const real = JSON.stringify([
		{
			type: "required_status_checks",
			parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "test", integration_id: 15368 }] },
		},
		{ type: "pull_request", parameters: { required_approving_review_count: 0 } },
	]);
	const rules = parseBranchRules(real);
	assert.equal(rules.length, 2);
	assert.equal(rules[0]?.type, "required_status_checks");

	assert.deepEqual(parseBranchRules("[]"), []);
	assert.deepEqual(parseBranchRules(""), []);
	assert.deepEqual(parseBranchRules("not json at all"), []);
	assert.deepEqual(parseBranchRules(JSON.stringify({ message: "Resource not accessible by personal access token", status: "403" })), []);
});

test("rulesRequireUpToDate is proof only from an explicit strict required-checks rule", () => {
	const strict = (value: unknown) => [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: value } }];
	assert.equal(rulesRequireUpToDate(strict(true)), true);
	assert.equal(rulesRequireUpToDate(strict(false)), false);
	assert.equal(rulesRequireUpToDate(strict("true")), false, "a surprising value is not proof");
	assert.equal(rulesRequireUpToDate([{ type: "required_status_checks" }]), false);
	assert.equal(rulesRequireUpToDate([{ type: "pull_request", parameters: { strict_required_status_checks_policy: true } }]), false);
	assert.equal(rulesRequireUpToDate([]), false);
	assert.equal(rulesRequireUpToDate(undefined), false, "unreadable rules are never proof");
});

test("ghBranchRulesArgs names the rules endpoint gh can actually read here", () => {
	assert.deepEqual(ghBranchRulesArgs("main"), ["api", "repos/{owner}/{repo}/rules/branches/main"]);
});

test("no command this module can build is a blocking CI-wait shape", () => {
	assert.equal(detectCiWait(`gh ${ghBranchRulesArgs("main").join(" ")}`), undefined);
});
