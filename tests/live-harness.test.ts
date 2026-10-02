/**
 * The live suite's scaffolding, tested for free.
 *
 * `tests/e2e/live.test.ts` only runs when an operator sets `CP_LIVE_TESTS=1` and
 * pays for it, so a bug in its *fixture* would be discovered at the worst
 * possible moment: after the money was spent. Everything in
 * `tests/harness/live.ts` that does not need a model is therefore exercised
 * here, in the normal (mock-only, free) suite.
 *
 * No model is called anywhere in this file.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths } from "../src/contracts.ts";
import { initialStatus } from "../src/run-artifacts.ts";
import { createScratchHome, treehouseAvailable } from "./harness/index.ts";
import {
	createLiveFixture,
	fakePrUrl,
	LIVE_JOB_BUDGET,
	LIVE_MODEL,
	LIVE_TOTAL_BUDGET,
	liveSkip,
	recordGateSpend,
	recordSpend,
	remoteHas,
	spendReport,
	totalTokens,
} from "./harness/live.ts";

const NEEDS_TOOLS = treehouseAvailable() ? false : "treehouse must be installed";

test("the live gate is closed unless the operator opens it", () => {
	// The whole safety property of the live suite: absent CP_LIVE_TESTS=1, every
	// scenario reports a skip reason instead of spending anything.
	const reason = liveSkip();
	if (process.env.CP_LIVE_TESTS === "1") {
		assert.ok(reason === false || typeof reason === "string");
	} else {
		assert.equal(typeof reason, "string");
		assert.match(reason as string, /CP_LIVE_TESTS=1/);
		assert.match(reason as string, /operator-run only/);
	}
	// A scenario that does not lease still needs the env gate, nothing more.
	if (process.env.CP_LIVE_TESTS !== "1") {
		assert.match(liveSkip({ needsLedger: false }) as string, /CP_LIVE_TESTS=1/);
	}
});

test("the live defaults are cheap and overridable", () => {
	assert.match(LIVE_MODEL, /haiku|CP_LIVE_MODEL/i, `default live model should be a cheap one, got ${LIVE_MODEL}`);
	// Wide enough for a revised research job (~94k measured), narrow enough that a
	// runaway still trips it.
	assert.ok(LIVE_JOB_BUDGET >= 100_000 && LIVE_JOB_BUDGET <= 250_000, `per-job budget looks wrong: ${LIVE_JOB_BUDGET}`);
	assert.ok(LIVE_TOTAL_BUDGET >= LIVE_JOB_BUDGET, "the suite total must be at least one job's budget");
});

test(
	"the fixture builds the state a real command post is in before its first dispatch",
	{ skip: NEEDS_TOOLS, timeout: 120_000 },
	async (t) => {
		const fixture = await createLiveFixture({ project: "fixture", files: { "README.md": "# fixture\n" } });
		t.after(async () => {
			await fixture.cleanup();
		});

		// A br workspace, a registered project, a canonical clone, and a pool that
		// points at a temp dir (the house rule that keeps ~/.treehouse clean).
		assert.ok(existsSync(join(fixture.home.path, ".pi-command-post/jobs.json")), "the ledger was not created");
		assert.deepEqual(fixture.post.registry.names(), ["fixture"]);
		// The registry canonicalizes symlinks (macOS /var -> /private/var), so the
		// clone path is compared through the registry, never rebuilt by hand.
		assert.equal(fixture.clone, fixture.post.registry.pathOf("fixture"));
		assert.ok(fixture.clone.endsWith(join(LAYOUT.projects, "fixture")), fixture.clone);
		assert.ok(existsSync(join(fixture.clone, ".git")), "the clone is missing");
		assert.ok(existsSync(join(fixture.clone, "README.md")), "the clone has no content");
		assert.ok(fixture.pool.root.startsWith("/"), "the treehouse pool must be an absolute temp path");
		assert.ok(!fixture.pool.root.includes("/.treehouse"), "the pool must not be the operator's own");

		// The remote helper reads the clone's origin, which is where a live worker
		// pushes; `main` exists, the job branch does not yet.
		assert.equal(remoteHas(fixture, fixture.repo.branch), true);
		assert.equal(remoteHas(fixture, "cp-not-a-branch"), false);

		// Preflight passes on this fixture, which is what makes a live dispatch
		// possible at all — asserted without a model.
		const check = await fixture.post.preflight.check({
			project: "fixture",
			jobId: "cp-live-fixture",
			model: LIVE_MODEL,
			fetch: false,
		});
		assert.equal(check.status, "ok", `preflight on the live fixture failed: ${JSON.stringify(check.findings)}`);
	},
);

test("the fixture cleans up after itself", { skip: NEEDS_TOOLS, timeout: 120_000 }, async () => {
	const fixture = await createLiveFixture({ project: "temp" });
	const { home, pool, repo } = fixture;
	await fixture.cleanup();
	assert.equal(existsSync(home.path), false, "the scratch home outlived the fixture");
	assert.equal(existsSync(pool.root), false, "the treehouse pool outlived the fixture");
	assert.equal(existsSync(repo.path), false, "the scratch repo outlived the fixture");
});

test("the PR url a delivery:pr scenario uses comes from the test, not a model", () => {
	const url = fakePrUrl("demo", "cp-live-c-42");
	assert.match(url, /^https:\/\/\S+$/, "delivery:pr requires an https url");
	assert.ok(url.includes("pi-command-post-live"), "the host names the suite, so nobody mistakes it for a real PR");
	// Deterministic: the same job always gets the same url, so a re-run of a
	// scenario asserts against the same value.
	assert.equal(fakePrUrl("demo", "cp-live-c-42"), url);
});

test("spend accounting reads the run projection and enforces both budgets", (t) => {
	// A scratch home, never this repo's: the accountant reads files, and a test
	// that writes into the operator's own state/ is a test that lies later.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const jobId = "cp-spend-fixture";
	mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });

	const write = (tokens: number): void => {
		const status = {
			...initialStatus(jobId, {}, "2026-08-27T12:00:00Z"),
			turns: 2,
			tool_calls: 3,
			usage: { input: tokens, output: 0, cache_read: 0, cache_write: 0, total_tokens: tokens, cost_usd: 0.01 },
		};
		writeFileSync(join(home.path, paths.statusFile(jobId)), JSON.stringify(status));
	};

	const before = totalTokens();
	write(10);
	const spend = recordSpend("harness/test", home.path, jobId);
	assert.equal(spend.tokens, 10);
	assert.equal(spend.turns, 2);
	assert.equal(spend.tools, 3);
	assert.equal(totalTokens(), before + 10, "the ledger accumulates across scenarios");
	assert.match(spendReport(), /harness\/test/);

	// Over the per-job budget: the scenario fails instead of the wallet.
	write(LIVE_JOB_BUDGET + 1);
	assert.throws(() => recordSpend("harness/test", home.path, jobId), /exceeded the per-job budget/);
});

test("a gate attempt is charged to the reviewer's own run, not to the job it reviews", (t) => {
	// The bug this pins (found by the first live (b) run): the gate shares the
	// research job's job id, so reading the *job's* status.json for a gate charged
	// the planner's tokens a second time and never showed the reviewer's.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const jobId = "cp-gate-fixture";
	const status = (tokens: number) => ({
		...initialStatus(jobId, {}, "2026-08-27T12:00:00Z"),
		turns: 1,
		tool_calls: 1,
		usage: { input: tokens, output: 0, cache_read: 0, cache_write: 0, total_tokens: tokens, cost_usd: 0.002 },
	});
	mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });
	writeFileSync(join(home.path, paths.statusFile(jobId)), JSON.stringify(status(5_000)));
	mkdirSync(join(home.path, paths.gateRunDir(jobId, 1)), { recursive: true });
	writeFileSync(join(home.path, paths.gateRunDir(jobId, 1), "status.json"), JSON.stringify(status(700)));

	const gate = recordGateSpend("harness/gate", home.path, jobId, 1);
	assert.equal(gate.tokens, 700, "the gate's spend is the reviewer's run, not the research job's");

	// A gate attempt that never spawned a reviewer reports zero rather than
	// borrowing the job's number.
	assert.equal(recordGateSpend("harness/gate-2", home.path, jobId, 2).tokens, 0);
});
