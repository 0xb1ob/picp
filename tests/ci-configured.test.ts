/**
 * cp-no-ci-repo-derived acceptance: "this repository has no CI" is a *positive*
 * finding, and every way of failing to establish it stays distinguishable.
 *
 * The operator directive is "if a given project has no CI checks, do NOT
 * require human approval, just merge". The hazard it creates is the one this
 * file pins: a `gh` that 403s, a network that drops, a command that dies
 * silently and output that will not parse all look like "nothing came back",
 * and reading any of them as "no CI" would merge unverified code — possibly
 * over a red run nobody could see.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CiConfiguredCause,
	ghCiConfigured,
	ghWorkflowsArgs,
	readCiConfigured,
} from "../src/ci-configured.ts";

const EMPTY = JSON.stringify({ total_count: 0, workflows: [] });
const ONE = JSON.stringify({ total_count: 1, workflows: [{ id: 7, name: "ci", state: "active" }] });

test("only an authoritative empty workflow list is 'no CI configured'", () => {
	const verdict = readCiConfigured({ status: 0, stdout: EMPTY, stderr: "" });
	assert.equal(verdict.state, "none");
	assert.equal(verdict.cause, "authoritative_empty");
	assert.equal(verdict.workflow_count, 0);
});

test("a repository that has workflows is 'present', however few runs it has produced", () => {
	const verdict = readCiConfigured({ status: 0, stdout: ONE, stderr: "" });
	assert.equal(verdict.state, "present");
	assert.equal(verdict.cause, "workflows_present");
	assert.equal(verdict.workflow_count, 1);
});

/**
 * The four outcomes the directive names, plus the two that complete the space.
 * Each is its own cause, and not one of them is `none`: an unreadable signal is
 * treated as "not permitted", never as permission.
 */
test("every way of not getting an answer is unreadable, and each is its own cause", () => {
	const cases: Array<[string, { status: number | null; stdout: string; stderr: string }, CiConfiguredCause]> = [
		["a 403", { status: 1, stdout: "", stderr: "gh: Resource not accessible by integration (HTTP 403)" }, "unauthorized"],
		["a 401", { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" }, "unauthorized"],
		["a network error", { status: 1, stdout: "", stderr: "dial tcp: lookup api.github.com: no such host" }, "command_failed"],
		["an empty stdout from a failed command", { status: 1, stdout: "", stderr: "" }, "failed_silently"],
		["a command killed by a signal", { status: null, stdout: "", stderr: "" }, "failed_silently"],
		["exit 0 with no stdout", { status: 0, stdout: "   \n", stderr: "" }, "empty_output"],
		["output that is not JSON", { status: 0, stdout: "<html>502 Bad Gateway</html>", stderr: "" }, "unparsable"],
		["JSON that is not an object", { status: 0, stdout: "[]", stderr: "" }, "unparsable"],
		["an object without the documented fields", { status: 0, stdout: '{"message":"Not Found"}', stderr: "" }, "unparsable"],
		// A first page that came back empty while total_count says otherwise is not
		// an authoritative zero; the two fields must agree.
		["a truncated page", { status: 0, stdout: JSON.stringify({ total_count: 3, workflows: [] }), stderr: "" }, "workflows_present"],
	];
	const causes = new Set<CiConfiguredCause>();
	for (const [label, result, cause] of cases) {
		const verdict = readCiConfigured(result);
		assert.equal(verdict.cause, cause, label);
		assert.notEqual(verdict.state, "none", `${label} must never read as "no CI configured"`);
		assert.ok(verdict.reason.length > 0, label);
		causes.add(verdict.cause);
	}
	// The directive's own requirement: four distinguishable outcomes, not one.
	for (const cause of ["unauthorized", "command_failed", "failed_silently", "unparsable"] as const) {
		assert.ok(causes.has(cause), `${cause} must be reachable and distinct`);
	}
});

test("the workflows question is one gh call, with gh's own owner/repo placeholders", () => {
	assert.deepEqual(ghWorkflowsArgs(), ["api", "repos/{owner}/{repo}/actions/workflows"]);
});

test("ghCiConfigured maps a throwing runner onto the same rule, 403 included", async () => {
	const ok = await ghCiConfigured({ cwd: "/tmp", timeoutMs: 1, exec: async () => EMPTY })();
	assert.equal(ok.state, "none");

	const forbidden = await ghCiConfigured({
		cwd: "/tmp",
		timeoutMs: 1,
		exec: async () => {
			throw new Error("gh api repos/{owner}/{repo}/actions/workflows failed: HTTP 403 (Resource not accessible)");
		},
	})();
	assert.equal(forbidden.state, "unreadable");
	assert.equal(forbidden.cause, "unauthorized");

	const dead = await ghCiConfigured({
		cwd: "/tmp",
		timeoutMs: 1,
		exec: async () => {
			throw new Error("spawn gh ENOENT");
		},
	})();
	assert.equal(dead.state, "unreadable");
	assert.equal(dead.cause, "command_failed");
});
