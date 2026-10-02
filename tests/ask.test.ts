/**
 * cp-u3o4: the operator's door to the Q&A path, and the tool surface behind it.
 *
 * `/cp-ask <project> <question…>` is deterministic on purpose: it costs no
 * model turn to decide that a question is a question. This pins the parser
 * (a question is prose and must survive verbatim) and the tool-policy facts
 * that make the path safe — `cp_ask` is dispatch capability, and a worker
 * profile can never hold it.
 *
 * TUI behaviour is NOT covered here (cur-20260901-5): a green unit suite is
 * not evidence that the answer card renders. docs/contracts.md §Q&A answers
 * names the reproduction on a real pi TUI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAskArgs } from "../extensions/command-post/index.ts";
import { FLEET_MUTATING_TOOLS, WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";
import { listProfiles } from "../src/profiles.ts";
import { join } from "node:path";
import { REPO_ROOT } from "./harness/index.ts";

test("/cp-ask takes a project and then the question, verbatim", () => {
	assert.deepEqual(parseAskArgs("demo Where is the retry ladder configured?"), {
		project: "demo",
		question: "Where is the retry ladder configured?",
	});
	// A question is prose: flags, dashes and punctuation inside it are words.
	assert.deepEqual(parseAskArgs("demo Why does --json always notify?"), {
		project: "demo",
		question: "Why does --json always notify?",
	});
	assert.deepEqual(parseAskArgs("demo  which   module owns  the pool? --model anthropic/claude-sonnet-5"), {
		project: "demo",
		question: "which module owns the pool?",
		model: "anthropic/claude-sonnet-5",
	});
});

test("/cp-ask fails closed on a missing project, a missing question and a dangling flag", () => {
	assert.throws(() => parseAskArgs(""), /usage: \/cp-ask/);
	assert.throws(() => parseAskArgs("demo"), /needs a question about demo/);
	assert.throws(() => parseAskArgs("demo why? --model"), /--model needs a model ref/);
	assert.throws(() => parseAskArgs("--verbose demo why?"), /unknown argument/);
});

test("cp_ask is a parent-only tool, and no shipped profile holds it", () => {
	// Recursion guard: it creates a br issue and spawns a worker.
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_ask"));
	// It moves the fleet, so it needs this home's parent lock.
	assert.ok(FLEET_MUTATING_TOOLS.includes("cp_ask"));
	for (const profile of listProfiles(join(REPO_ROOT, "profiles"))) {
		assert.ok(!profile.frontmatter.tools.includes("cp_ask"), `${profile.frontmatter.name} must not hold cp_ask`);
	}
});
