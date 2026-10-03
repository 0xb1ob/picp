import assert from "node:assert/strict";
import { test } from "node:test";
import { inferScopeAndRisk, resolveRoutingInputs } from "../src/pipeline.ts";
import { riskKeywords } from "../src/risk-warning.ts";
import { composeRoutingInputs } from "../src/dispatch-inputs.ts";
import type { DispatchRequest } from "../src/dispatch.ts";
import type { Job } from "../src/ledger.ts";

test("safety constraints do not infer or warn about high risk (dbn)", () => {
	for (const text of [
		"no migration",
		"never expose secrets or tokens",
		"no permission changes",
		"not touching production",
		"do not expose any credentials",
		"without exposing the secrets",
	]) {
		assert.equal(inferScopeAndRisk(text).risk, undefined, text);
		assert.deepEqual(riskKeywords(text), [], text);
	}
});

test("risk inference skips brief negations with up to three intervening words (bead nfm)", () => {
	for (const text of [
		"No migration is required",
		"No database migration",
		"No schema or data migration",
		"Never deploy to production",
		"Do not deploy to production",
		"Must not deploy to production",
		"Never directly modify production",
		"Do not perform a migration",
		"Must not change the billing configuration",
		"No changes to authentication",
		"Never change any user permissions",
		"Do not expose the credentials",
		"Must not force-push",
		"Don't deploy to production",
	]) {
		assert.equal(inferScopeAndRisk(text).risk, undefined, text);
		assert.deepEqual(riskKeywords(text), [], text);
	}
	for (const [text, words] of [
		["No database migration; deploy to production", ["production"]],
		["Never deploy to production but delete the table", ["delete"]],
		["No migration and rotate credentials", ["credentials"]],
		["No changes are planned for production", ["production"]],
		["No tests. Deploy to production", ["production"]],
		["Do not wait to purge the table", ["purge"]],
		["Deploy without tests to production", ["production"]],
	] as const) {
		assert.equal(inferScopeAndRisk(text).risk, "high", text);
		assert.deepEqual(riskKeywords(text), words, text);
	}
});

test("modified destructive actions after or remain risk evidence", () => {
	for (const [text, word] of [
		["No migration or bulk delete the table", "delete"],
		["No migration or permanently destroy the table", "destroy"],
		["No migration or immediately truncate the table", "truncate"],
		["No migration or quickly purge the table", "purge"],
		["No migration or bulk backfill the table", "backfill"],
		["No migration or immediately drop the table", "drop the table"],
		["No migration or immediately migrate the table", "migrate"],
	] as const) {
		assert.equal(inferScopeAndRisk(text).risk, "high", text);
		assert.deepEqual(riskKeywords(text), [word], text);
	}
	for (const text of ["No schema or data migration", "No migration or never bulk delete the table"]) {
		assert.equal(inferScopeAndRisk(text).risk, undefined, text);
		assert.deepEqual(riskKeywords(text), [], text);
	}
});

test("independent credential and access actions after or remain risk evidence", () => {
	for (const [text, words] of [
		["No migration or rotate credentials", ["credentials"]],
		["No migration or expose secrets", ["secrets"]],
		["No migration or grant permissions", ["permissions"]],
		["No migration or change authentication", ["authentication"]],
		["No migration or rotate secrets or tokens", ["secrets", "tokens"]],
	] as const) {
		assert.equal(inferScopeAndRisk(text).risk, "high", text);
		assert.deepEqual(riskKeywords(text), words, text);
	}
	for (const text of [
		"Never expose secrets or tokens",
		"No credentials or tokens",
		"No schema or data migration",
		"No data or database migration",
		"No migration or never rotate credentials",
	]) {
		assert.equal(inferScopeAndRisk(text).risk, undefined, text);
		assert.deepEqual(riskKeywords(text), [], text);
	}
});

test("excluded sections end at the next peer or parent heading (dbn)", () => {
	for (const heading of ["Constraints", "Non-goals"]) {
		const text = `# Dashboard\nRead-only view\n## ${heading}\nMigration and permission changes\n### Details\nProduction tokens\n`;
		assert.deepEqual(riskKeywords(text), [], heading);
		assert.equal(inferScopeAndRisk(text).risk, undefined, heading);
		for (const next of ["## Implementation", "# Implementation"]) {
			assert.deepEqual(riskKeywords(`${text}${next}\nRotate credentials`), ["credentials"]);
		}
		assert.deepEqual(riskKeywords(`Rotate credentials\n${text}`), ["credentials"]);
	}
});

test("fenced headings cannot open or close excluded sections (dbn)", () => {
	for (const fence of ["```", "~~~", "````", "~~~~"]) {
		for (const heading of ["Constraints", "Non-goals"]) {
			const text = `${fence}markdown\n## ${heading}\nproduction\n${fence}\nRotate credentials`;
			assert.deepEqual(riskKeywords(text), ["credentials", "production"], text);
			assert.equal(inferScopeAndRisk(text).risk, "high", text);
		}
		const excluded = `## Constraints\n${fence}\n## Implementation\n${fence}\nproduction`;
		assert.deepEqual(riskKeywords(excluded), [], excluded);
		assert.deepEqual(riskKeywords(`${fence}\nexample\n${fence}\n## Constraints\nproduction`), []);
	}
	for (const falseClose of ["~~~", "```", "```` trailing text"]) {
		const text = `\`\`\`\`markdown\n${falseClose}\n## Constraints\nproduction`;
		assert.deepEqual(riskKeywords(text), ["production"], text);
	}
	assert.deepEqual(riskKeywords("```\nexample\n````\n## Constraints\nproduction"), []);
});

test("positive evidence and recorded risk survive safety wording (dbn)", () => {
	assert.deepEqual(riskKeywords("Never expose secrets or tokens; rotate credentials"), ["credentials"]);
	assert.deepEqual(riskKeywords("No migration, but change production billing"), ["billing", "production"]);
	assert.deepEqual(riskKeywords("Never expose secrets or delete rows"), ["delete"]);
	assert.equal(inferScopeAndRisk("Expose secrets or tokens").risk, "high");
	for (const risk of ["low", "high"] as const) {
		for (const suppliedBy of ["explicit", "assessed"] as const) {
			const result = resolveRoutingInputs({ text: "## Constraints\nproduction migration", risk, suppliedBy });
			assert.equal(result.risk, risk);
			assert.equal(result.provenance.risk, suppliedBy);
		}
	}
});

test("riskkw-f10: the four refused jobs' keyword senses infer no risk", () => {
	for (const text of [
		"Doctor incorrectly calls the live .beads tracker database 'a frozen archive, safe to delete'. The bead body is authoritative for acceptance.",
		"stop advising users to delete .beads",
		"Keep tracker runSync running after backfill failure and test integration write-back",
		"Fix tracker-tick backfill failure skipping runSync and add the missing cp_integrate write-back test from PR #340 review.",
		"Fix src/trackers/backfill.ts for cp-tracker-backfill-sync-ne5t",
		"project-wide accounting includes $634.17 and 53.6M historical tokens from before the grant existed",
		"a grant's spend and token caps count usage attributable to that grant",
		"Hitting a token-cap raise within the ceiling",
		'"Context" means **context-window usage**: tokens currently in context against the model\'s window',
		"The bar turns amber at ≥70% and red at ≥90%, using existing colour tokens only.",
		"Show each worker's context tokens against its window",
	]) {
		assert.equal(inferScopeAndRisk(text).risk, undefined, text);
		assert.deepEqual(riskKeywords(text), [], text);
	}
	// Approval-sense "authorization" stays evidence: record risk on the job instead (riskkw-f10 U3).
	assert.deepEqual(
		riskKeywords("This stage only reads and plans; implementation follows a passing cp_gate and applicable risk authorization."),
		["authorization"],
	);
});

test("riskkw-f10: real risk wording stays high", () => {
	for (const text of [
		"Rotate the tokens",
		"Rotate the 2 leaked tokens",
		"Revoke 3 old tokens",
		"Implement token rotation",
		"Store API tokens in the request context",
		"hard-delete the rows",
		"Delete the stale user rows",
		"Run 'delete all rows' now",
		"Fix the delete path so it removes rows",
		"Backfill step: rewrite every row",
		"Backfill the accounts table and drop the legacy column",
		"stop advising deletion and delete the .beads directory",
		"Deploy to prod-us-east",
		"Edit config/credentials.yml",
		"Add src/migrations/002_drop_users.sql",
		"The alert says 'production credentials expired'; rotate them",
		"The runbook says 'purge the cache'; do it",
		"Delete the user's 'archive' folder",
	]) {
		assert.equal(inferScopeAndRisk(text).risk, "high", text);
	}
});

test("cp-wkv1: no-migration notes, plan evidence sections, spend tokens and audit remedies infer no risk", () => {
	for (const text of [
		"Migration: none — existing records keep their fields.",
		"Changelog entry with **Migration:** n/a.",
		"Include `Migration: none` in the changelog.",
		"## Goal\nAdd a status column to the report view.\n## Acceptance\n- Merge only with green CI and repository merge permission.\n## Test plan\n- Feed \"drop the legacy column\" and \"rotate credentials\" as fixtures.\n## Evidence\n- The access check reads the token from the record.\n## Unknowns/Blockers\n- Whether production uses it.\n## Self-assessment\n- destructive_scope: false; a schema migration was considered.",
		"Show cost/tokens/PR per job and spend: {usd, tokens}.",
		"Render spend.tokens / spend_cap.tokens on each card; usd and tokens include reviewers.",
		"Estimate the tokens and time spent before the first edit.",
		"Report estimated waste, in minutes, tokens and $ where computable.",
		"Add a context-tokens status line that counts noncached tokens.",
		"Read-only audit of the repository history. For each finding name the fix: delete/redact/rewrite history.",
		"Read-only reviewer audit, answer deliverable. Severity per finding, and fix (delete/redact/rewrite history).",
	]) {
		assert.equal(inferScopeAndRisk(text).risk, undefined, text);
		assert.deepEqual(riskKeywords(text), [], text);
	}
});

test("cp-wkv1: real operational risk stays high next to the new benign senses", () => {
	for (const [text, words] of [
		["Rotate the GitHub token", ["token"]],
		["Force-push main", ["force-push"]],
		["Drop the column", ["drop the column"]],
		["Delete the production database", ["delete", "production"]],
		["Change repo permissions", ["permissions"]],
		["## Goal\nDrop the column.\n## Acceptance\n- tests pass", ["drop the column"]],
		["## Acceptance\n- tests pass\n## Implementation\nDelete the production database", ["delete", "production"]],
		["Migration: rewrite every row of the accounts table", ["migration"]],
		["Migration: none of the old rows are kept", ["migration"]],
		["Fix: delete/redact/rewrite history", ["rewrite history"]],
		["Read-only audit first, then rewrite history on main", ["rewrite history"]],
		["keep backups read-only; run squash/rewrite history on main", ["rewrite history"]],
		["Read-only audit of the backups. Then run squash/rewrite history on main.", ["rewrite history"]],
		["Read-only audit first, then fix: squash/rewrite history on main", ["rewrite history"]],
		["Read-only audit of the repository. Name each fix: delete/redact/rewrite history. Then apply the fix.", ["rewrite history"]],
		["Report 1000 github-tokens per org", ["tokens"]],
		["Store API tokens, usd limits included", ["tokens"]],
		["Print the tokens and $GH_PAT", ["tokens"]],
	] as const) {
		assert.equal(inferScopeAndRisk(text).risk, "high", text);
		assert.deepEqual(riskKeywords(text), words, text);
	}
});

test("cp-wkv1: neither an excluded section at the end of the task nor an excluded-heading title swallows the job description", () => {
	const task = "## Goal\nAdd a report view.\n## Self-assessment\n- confidence: high";
	const issue = { id: "cp-test", title: "Add a report view", description: "Delete the production database", labels: [] } as unknown as Job;
	const inputs = composeRoutingInputs({} as DispatchRequest, issue, { forBrief: task, forInference: task });
	assert.equal(inputs.risk, "high");
	assert.equal(composeRoutingInputs({} as DispatchRequest, { ...issue, description: "Render it." }, { forBrief: task, forInference: task }).risk, "low");
	for (const title of ["Evidence", "Acceptance", "Test plan", "Unknowns/Blockers", "Self-assessment", "Constraints", "Non-goals"]) {
		const titled = { ...issue, title };
		assert.equal(composeRoutingInputs({} as DispatchRequest, titled, { forBrief: "Add a report view.", forInference: "Add a report view." }).risk, "high", title);
	}
});
