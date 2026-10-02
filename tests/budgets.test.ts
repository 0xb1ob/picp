/**
 * cp-sr5 acceptance: a raised budget must actually take effect, and a raise
 * the min(profile, config) clamp swallows must say so rather than appearing
 * to succeed.
 *
 * Three ways a raise silently failed to apply before this fix:
 *  1. Frozen into a running job at dispatch (documented, expected — not
 *     retested here).
 *  2. Silently clamped by min(profile budget, data/budgets.json) — covered by
 *     the doctor tests in tests/doctor.test.ts (`config.budget.<profile>`).
 *  3. `data/budgets.json` read once at parent (CommandPost) construction, so
 *     even a brand-new dispatch after the file changed got the stale ceiling
 *     until the parent restarted. That is what this file proves fixed: the
 *     composition root (`CommandPost`) must hand `WorkerManager`/`Sender` a
 *     getter, not a value, or this whole class of fix is undone by the one
 *     place that actually wires it up.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../src/command-post.ts";
import { DEFAULT_BUDGET_CONFIG, LAYOUT } from "../src/contracts.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

test("a budget raised after the parent started reaches the very next read, no restart (cp-sr5)", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });

	// No data/budgets.json yet: the fleet default applies, same as a fresh home.
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	assert.equal(post.manager.budgetConfig.per_job_tokens, DEFAULT_BUDGET_CONFIG.per_job_tokens);
	assert.equal(post.manager.spawnCap, DEFAULT_BUDGET_CONFIG.spawn_cap);

	// The operator's raise: written to disk with this *same* CommandPost
	// already constructed — exactly the "session already running" scenario in
	// the bug report, and the one a naive fix (reading once in the
	// constructor) would still fail.
	writeFileSync(
		join(home.path, LAYOUT.budgetsFile),
		JSON.stringify({
			schema_version: 1,
			per_job_tokens: 50_000_000,
			per_job_cost_usd: 100,
			warn_ratio: 0.8,
			spawn_cap: 12,
		}),
	);

	assert.equal(post.manager.budgetConfig.per_job_tokens, 50_000_000, "the raise must reach the same, already-live manager");
	assert.equal(post.manager.budgetConfig.per_job_cost_usd, 100);
	// spawn_cap is read from the same config the same way: confirming it is
	// not a second, separately-cached path (the brief asks this be checked).
	assert.equal(post.manager.spawnCap, 12, "spawn_cap must not be stale independently of the rest of the budget config");

	// CommandPost.budgets() itself — what dispatch, doctor and the Sender all
	// ultimately read from — must also see the raise without reconstruction.
	assert.equal(post.budgets().per_job_tokens, 50_000_000);
});

test("raising only data/budgets.json (not the profile) clamps nothing further; the profile's own ceiling is still the min() partner", () => {
	// This is the companion to the doctor-level clamp tests: from the
	// CommandPost side, budgets() itself must reflect a raise immediately, so
	// whatever reads it next (resolveJobBudget at dispatch, doctor's
	// effective-budget check) sees the true, current ceiling rather than a
	// snapshot from when the session started.
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.path, LAYOUT.budgetsFile),
		JSON.stringify({ schema_version: 1, per_job_tokens: 1000, per_job_cost_usd: 1, warn_ratio: 0.8, spawn_cap: 10 }),
	);
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	assert.equal(post.budgets().per_job_tokens, 1000);

	writeFileSync(
		join(home.path, LAYOUT.budgetsFile),
		JSON.stringify({ schema_version: 1, per_job_tokens: 90_000_000, per_job_cost_usd: 1, warn_ratio: 0.8, spawn_cap: 10 }),
	);
	assert.equal(post.budgets().per_job_tokens, 90_000_000, "a second raise on the same live CommandPost must also take effect");
	home.cleanup();
});
