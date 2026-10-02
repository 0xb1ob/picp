/**
 * The planner artifact contract (cp-planner-artifacts): a plan is executable
 * or it is not a plan.
 *
 * `RESEARCH_ARTIFACT_SECTIONS` is the one list; these tests hold the three
 * prompts that state it — the planner's brief, the gate rubric, the
 * completeness check — to that list, and hold `missingArtifactSections()` to
 * rejecting the four gaps that made past artifacts unusable: no approach, no
 * acceptance, no implementation sequence, no executable verification.
 *
 * The immutable boundaries (read-only, worktree, clean tree, terminal
 * `report_result`) are asserted here too, because a prompt rewrite is exactly
 * how they would get lost.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { missingArtifactSections, RESEARCH_ARTIFACT_SECTIONS } from "../src/contracts.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

/** A complete artifact, in the shape the brief asks for. */
const SECTION_BODY: Record<string, string> = {
	Goal: "Release the lease when teardown throws.",
	Acceptance: "`state/leases/<id>.json` is gone after a failed teardown.",
	"Non-goals": "No change to dispatch.",
	Evidence: "`src/leases.ts:120` `release()` returns before unlink.",
	Approach: "Unlink first, then return the worktree; rejected: a finally block in teardown.",
	"File list": "- `src/leases.ts` — in `release()` (L120), unlink before returning.",
	"Implementation order": "1. leases.ts, 2. teardown.ts caller, no interface change.",
	Constraints: "Lease files are read by /status; recovery is re-claiming the lease.",
	"Test plan": "- cwd repo root; `npm test -- tests/leases.test.ts`; expect pass — proves the file is gone.",
	"Unknowns/Blockers": "None.",
	"Self-assessment": "confidence: high\nscope: S\nblocking_unknowns: false\ndestructive_scope: false",
};

function artifact(omit: string[] = [], empty: string[] = []): string {
	return RESEARCH_ARTIFACT_SECTIONS.filter((section) => !omit.includes(section))
		.map((section) => `## ${section}\n${empty.includes(section) ? "" : SECTION_BODY[section]}\n`)
		.join("\n");
}

test("a complete artifact is missing nothing", () => {
	assert.deepEqual(missingArtifactSections(artifact()), []);
	// Heading style is not the contract: bold headings and trailing colons count.
	const bold = artifact().replaceAll(/^## (.+)$/gm, "**$1:**");
	assert.deepEqual(missingArtifactSections(bold), []);
});

test("an artifact missing approach, acceptance, sequence or verification is rejected", () => {
	for (const section of ["Approach", "Acceptance", "Implementation order", "Test plan"] as const) {
		assert.deepEqual(missingArtifactSections(artifact([section])), [section], `${section} must be required`);
	}
	assert.deepEqual(missingArtifactSections(""), [...RESEARCH_ARTIFACT_SECTIONS]);
});

test("a heading with nothing under it is a missing section", () => {
	// An empty Test plan is not executable verification, whatever the heading says.
	assert.deepEqual(missingArtifactSections(artifact([], ["Test plan"])), ["Test plan"]);
});

test("a section name is matched by its subject, not by its exact wording", () => {
	const renamed = artifact()
		.replace("## File list", "## File changes")
		.replace("## Test plan", "## Test commands")
		.replace("## Unknowns/Blockers", "## Unknowns");
	assert.deepEqual(missingArtifactSections(renamed), []);
});

test("a heading inside a fenced code block is content, not structure", () => {
	// A shell comment in a Test plan block must not open a "# npm" section and
	// strand every section written after it.
	const fenced = artifact().replace(
		SECTION_BODY["Test plan"] as string,
		"```bash\n# run the lease suite\nnpm test -- tests/leases.test.ts\n```",
	);
	assert.deepEqual(missingArtifactSections(fenced), []);
	// The fence is the only thing under the heading: still delivered.
	const onlyFence = artifact([], ["Test plan"]).replace("## Test plan\n", "## Test plan\n```bash\n# npm test\n```\n");
	assert.deepEqual(missingArtifactSections(onlyFence), []);
});

test("first-word matching: the whole first word must match, and a same-word decoy passes", () => {
	// The boundary, pinned in both directions.
	// Rejected: a heading that merely starts with the same letters. "Testing
	// environment" is not a test plan, and "Filesystem notes" is not a file list.
	const nearMiss = artifact()
		.replace("## Test plan", "## Testing environment")
		.replace("## File list", "## Filesystem notes");
	assert.deepEqual(missingArtifactSections(nearMiss), ["File list", "Test plan"]);

	// Accepted, deliberately: a heading whose first word is the same word. This
	// is what lets "Test commands" and "File changes" count, and the price is
	// that an unrelated "Test rig" counts too. The floor is mechanical; the gate
	// reviewer is what judges whether a section is real.
	const decoyed = artifact().replace("## Test plan", "## Test rig for the demo");
	assert.deepEqual(missingArtifactSections(decoyed), [], "a same-first-word heading is accepted by design");
});

test("every prompt lists all required sections, in order, in its required-sections block", () => {
	// `includes` alone would be satisfied by the word "Goal" anywhere in the
	// file, so the assertion is on the block that states the list, in order.
	const blocks: Array<[string, string]> = [
		["prompts/briefs/brief-research.md", "## Required sections, in this order"],
		["prompts/briefs/gate-rubric.md", "Required artifact sections, in this order"],
		["prompts/briefs/quality-completeness.md", "required sections exist"],
		["profiles/planner.md", "in the sections"],
	];
	for (const [path, marker] of blocks) {
		const text = read(path);
		const start = text.indexOf(marker);
		assert.ok(start >= 0, `${path} no longer states its required sections (looked for ${JSON.stringify(marker)})`);
		const block = text.slice(start);
		let previous = -1;
		for (const section of RESEARCH_ARTIFACT_SECTIONS) {
			const at = block.indexOf(section);
			assert.ok(at >= 0, `${path} does not name the required section "${section}" where it lists them`);
			assert.ok(at > previous, `${path} lists "${section}" out of contract order`);
			previous = at;
		}
	}
});

test("the planner brief demands executable detail and the method that produces it", () => {
	const brief = readFileSync(join(BRIEFS_DIR, "brief-research.md"), "utf8");
	// Method: trace before proposing, smallest existing pattern, ask only real
	// product decisions, check the task against the artifact before reporting.
	assert.match(brief, /caller/i);
	assert.match(brief, /smallest existing pattern/i);
	assert.match(brief, /product decision/i);
	assert.match(brief, /check every requirement of the task/i);
	// Executable verification: a command, a working directory, an expectation.
	assert.match(brief, /cwd/);
	assert.match(brief, /npm test/);
	assert.match(brief, /expected result/i);
});

test("booleans are true/false wherever an artifact self-assessment is described", () => {
	for (const path of [
		"prompts/briefs/brief-research.md",
		"prompts/briefs/gate-rubric.md",
		"profiles/planner.md",
		"docs/contracts.md",
	]) {
		assert.ok(!read(path).includes("yes|no"), `${path} still describes a boolean as yes|no`);
	}
	const brief = read("prompts/briefs/brief-research.md");
	assert.match(brief, /blocking_unknowns: true\|false/);
	assert.match(brief, /destructive_scope: true\|false/);
});

test("the immutable planner boundaries survive the rewrite", () => {
	const brief = read("prompts/briefs/brief-research.md");
	const profile = read("profiles/planner.md");
	// Read-only, inside the worktree, artifact outside it, clean tree, one
	// terminal report_result, no delegation.
	assert.match(brief, /You may not: change any file in this repository/);
	assert.match(brief, /Do not `cd` anywhere else/);
	assert.match(brief, /\$\{artifact_path\}/);
	assert.match(brief, /git status --porcelain/);
	assert.match(brief, /report_result/);
	assert.match(brief, /never goes into the envelope/i);
	assert.match(profile, /readOnly: true/);
	assert.match(profile, /Change no files in this repository/);
	assert.match(profile, /report_result` exactly once/);
	assert.match(profile, /Do not dispatch, spawn, or delegate/);
});

test("planner and QA briefs name real tools, forbid patch writers, and require a quoted heredoc", () => {
	for (const path of ["prompts/briefs/brief-research.md", "prompts/briefs/brief-qa.md"]) {
		const brief = read(path);
		// The tool list must name tools the profile actually grants — no `glob`,
		// which was never a real tool and pushed workers toward apply_patch/git apply.
		assert.match(brief, /`grep`, `find`, `ls` and `read` tools/, `${path} must name its real read tools`);
		assert.doesNotMatch(brief, /`glob`/, `${path} must not name the nonexistent glob tool`);
		assert.match(brief, /apply_patch/, `${path} must forbid apply_patch`);
		assert.match(brief, /git apply/, `${path} must forbid git apply`);
		// Single quoted heredoc: the delimiter is quoted so operator/task text with
		// `$` or backticks in it is never shell-expanded while writing the artifact.
		assert.match(brief, /<<'EOF'/, `${path} must show the quoted-heredoc form`);
		assert.doesNotMatch(brief, /<<EOF/, `${path} must not show an unquoted heredoc delimiter`);
	}
});

test("brief-ship names the npm ci recovery for a post-rebase TS2307/TS7016", () => {
	const ship = read("prompts/briefs/brief-ship.md");
	assert.match(ship, /TS2307/);
	assert.match(ship, /TS7016/);
	assert.match(ship, /npm ci/);
});
