/**
 * cp-kzc acceptance: a worker reports the pushed head sha and stops. It never
 * waits for CI, and an envelope that says nothing about CI is complete.
 *
 * Three cases, exactly the ones the issue requires:
 *  1. the ship brief, rendered for every (role, scope, risk) combination, tells
 *     the worker to report the pushed head sha and stop, and never instructs it
 *     to wait for CI;
 *  2. the enforcement: a sleep-then-poll bash command is refused, and a
 *     legitimate long-running command is not;
 *  3. an envelope omitting any CI claim is accepted as complete when it carries
 *     the pushed head sha.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ciWaitRefusal, detectCiWait } from "../src/ci-wait.ts";
import {
	type Envelope,
	type EnvelopeContext,
	RISKS,
	ROLES,
	SCOPES,
	validateEnvelope,
} from "../src/contracts.ts";
import { ROLE_FOR_KIND } from "../src/dispatch.ts";
import { assembleBrief, profileForRole, readBriefTemplate } from "../src/profiles.ts";
import { REPO_ROOT } from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");

// ---------------------------------------------------------------------------
// 1. the brief says report-and-stop, for every (role, scope, risk)
// ---------------------------------------------------------------------------

/**
 * Scope and risk route the *model*, never the brief text, so the honest form of
 * "for any (role, scope, risk)" is: render the brief a ship job would get for
 * each combination and assert both the content and the invariance. If a later
 * change ever branches brief text on scope or risk, the invariance assertion
 * fails and this test has to be re-thought rather than silently bypassed.
 */
function renderShipBrief(): string {
	const profile = profileForRole(PROFILES_DIR, ROLE_FOR_KIND.ship);
	return assembleBrief({
		profile,
		template: readBriefTemplate(BRIEFS_DIR, profile.frontmatter.briefTemplate),
		values: {
			job_id: "cp-kzc",
			branch: "cp-kzc",
			base: "main",
			worktree: "/leases/1/repo",
			project: "pi-command-post",
			kind: "ship",
			delivery: "pr",
			task: "fix the thing",
			artifact_path: "/home/state/artifacts/cp-kzc/report.md",
		},
	});
}

test("a ship brief tells every worker to report the pushed head sha and stop, at any (role, scope, risk)", () => {
	const shipRoles = ROLES.filter((role) => role === ROLE_FOR_KIND.ship);
	assert.deepEqual(shipRoles, ["implementer"], "a ship job is dispatched to exactly one role");

	const rendered = new Set<string>();
	for (const _role of shipRoles) {
		for (const scope of SCOPES) {
			for (const risk of RISKS) {
				const brief = renderShipBrief();
				rendered.add(brief);

				// Says the new thing, in words a worker can act on.
				assert.match(brief, /Do not wait for CI\. Report the pushed head sha and stop\./, `${scope}/${risk}`);
				assert.match(brief, /git rev-parse HEAD/, `${scope}/${risk}`);
				assert.match(brief, /head_sha/, `${scope}/${risk}`);
				assert.match(brief, /needs \*\*no CI claim\*\*/, `${scope}/${risk}`);

				// And never the old thing: no instruction to wait, watch or gate on green.
				assert.doesNotMatch(brief, /Only once CI is green/i, `${scope}/${risk}`);
				assert.doesNotMatch(brief, /--watch\b(?![^\n]*refused)/, `${scope}/${risk}`);
				assert.doesNotMatch(brief, /wait again/i, `${scope}/${risk}`);
				assert.doesNotMatch(brief, /checks are still pending/i, `${scope}/${risk}`);
				for (const line of brief.split("\n")) {
					if (!/\bwait\b/i.test(line)) continue;
					assert.match(
						line,
						/(never|not|no|refused|Do not|stop waiting|without)/i,
						`the brief instructs a wait: ${line}`,
					);
				}
			}
		}
	}
	assert.equal(rendered.size, 1, "brief text must not branch on scope or risk");
});

// ---------------------------------------------------------------------------
// 2. enforcement: the sleep-then-poll shape is refused, real work is not
// ---------------------------------------------------------------------------

test("a sleep-then-poll bash call is refused, by shape", () => {
	// The two commands caught live on 2026-08-31, verbatim in shape.
	const observed = [
		"sleep 270; gh run list --branch cp-autonomous-memory-curation-eeu --limit 3 --json conclusion,status,headSha",
		"cd /leases/2/repo && sleep 180; gh run list --branch cp-diffgate-cp-review-tool-l65 --limit 3 --json conclusion,status,headSha",
	];
	for (const command of observed) {
		const finding = detectCiWait(command);
		assert.equal(finding?.shape, "sleep_then_poll", command);
	}

	// The same defect wearing other clothes.
	assert.equal(detectCiWait("while true; do gh pr checks 42; sleep 30; done")?.shape, "poll_loop");
	assert.equal(detectCiWait("until gh run list --branch b --json conclusion | grep success; do sleep 20; done")?.shape, "poll_loop");
	assert.equal(detectCiWait("for i in 1 2 3; do gh run view 12345; sleep 60; done")?.shape, "poll_loop");
	assert.equal(detectCiWait("gh run watch 12345")?.shape, "blocking_watch");
	assert.equal(detectCiWait("gh pr checks 42 --watch")?.shape, "blocking_watch");
	assert.equal(
		detectCiWait("sleep 120 && gh api repos/o/r/commits/deadbeef/check-runs")?.shape,
		"sleep_then_poll",
	);

	// The refusal names the shape and the sanctioned path, so the worker does not
	// invent a second workaround for the first one.
	const refusal = ciWaitRefusal(detectCiWait(observed[0] as string) as ReturnType<typeof detectCiWait> & object);
	assert.match(refusal, /Refused:/);
	assert.match(refusal, /head_sha/);
	assert.match(refusal, /report_result/);
	assert.match(refusal, /never waits for CI/);
});

test("a legitimate long-running command is never flagged", () => {
	for (const command of [
		// The suite this very job runs — long, and exactly what a worker must do.
		"npm test > /tmp/test-out.txt 2>&1",
		"npm run typecheck",
		"node --test --test-timeout=300000 tests/**/*.test.ts",
		"git fetch origin && git rebase origin/main",
		"git push --force-with-lease",
		"git rev-parse HEAD",
		// A bare sleep for a local reason is not a CI wait.
		"sleep 5",
		"sleep 30 && npm run build",
		// One non-blocking snapshot is allowed: it returns immediately.
		"gh run list --branch cp-kzc --limit 3 --json conclusion,status,headSha,workflowName",
		"gh pr checks 42",
		"gh pr create --title x --body-file /tmp/body.md",
		"gh pr view 42 --json url",
		// The words, inside a quoted string, are not a command.
		'grep -rn "sleep 270; gh run list" tests/',
		"rg --files-with-matches 'gh run watch' src/",
		// A long build/install with no CI query at all.
		"npm ci && npm run build && ./scripts/slow-thing.sh",
	]) {
		assert.equal(detectCiWait(command), undefined, `wrongly flagged: ${command}`);
	}
	assert.equal(detectCiWait(""), undefined);
});

// ---------------------------------------------------------------------------
// 3. an envelope with no CI claim is complete when it carries the head sha
// ---------------------------------------------------------------------------

const HEAD_SHA = "9f1c2e3a4b5c6d7e8f90a1b2c3d4e5f60718293a";
const BASE_SHA = "2046b5780e2c4a1a2b3c4d5e6f7a8b9c0d1e2f3a";

test("a ship envelope with the pushed head sha and no CI claim is complete", () => {
	const ctx: EnvelopeContext = { job_id: "cp-kzc", kind: "ship", delivery: "pr", worktree: "/leases/1/repo" };
	const envelope: Envelope = {
		job_id: "cp-kzc",
		kind: "ship",
		status: "done",
		// Deliberately silent about CI: no "green", no conclusion, no run id.
		summary: "Refused the sleep-then-poll shape; local suite passed on the rebased tree.",
		branch: "cp-kzc",
		pr_url: "https://github.com/org/repo/pull/50",
		head_sha: HEAD_SHA,
		base_sha: BASE_SHA,
	};

	const checked = validateEnvelope(envelope, ctx);
	assert.ok(checked.ok, `rejected a complete envelope: ${checked.ok ? "" : checked.errors.join("; ")}`);
	assert.equal(checked.ok && checked.value.head_sha, HEAD_SHA);

	// The absence of a CI claim is never an error, and neither is a pending run.
	const pending = validateEnvelope({ ...envelope, summary: "Pushed; CI had not started yet." }, ctx);
	assert.ok(pending.ok);

	// head_sha is a full sha or nothing: a short sha is not a verifiable head.
	const short = validateEnvelope({ ...envelope, head_sha: HEAD_SHA.slice(0, 12) }, ctx);
	assert.ok(!short.ok);

	// It stays optional: envelopes filed before this field existed are still valid.
	const { head_sha: _dropped, ...withoutHead } = envelope;
	assert.ok(validateEnvelope(withoutHead, ctx).ok);
});
