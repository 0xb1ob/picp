/**
 * cp-widget-test-hangs: the suite must always terminate.
 *
 * Two workers lost ~40 minutes to `tests/widget.test.ts` running forever. The
 * tests themselves were fine — they all passed and printed — but the file's
 * *process* never exited, because a throwing cleanup hook skipped the hook that
 * closed a spawned pi child, and a live child is a refed handle on the event
 * loop. A worker has no `timeout(1)` and no terminal, so "runs forever" is
 * indistinguishable from "still working": it wedges the worker.
 *
 * There are two independent classes of hang, and they need two different
 * defenses. This file pins both, because each one alone leaves a real hole:
 *
 *   1. a test that hangs *inside* a test  -> bounded by `--test-timeout`
 *   2. a process that outlives its tests  -> NOT bounded by `--test-timeout`
 *
 * Class 2 is what actually happened, and it is why `--test-timeout` alone would
 * not have saved either worker: measured on this machine, a finite
 * `--test-timeout=15000` let the leaking file run past 120s with no output at
 * all. `--test-force-exit` ends the same file in ~1s, which is why the suite is
 * invoked with both flags and why this file asserts both are still there.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "./harness/index.ts";

const FIXTURES = join(REPO_ROOT, "tests/fixtures");

/** Wall-clock ceiling for a fixture run. Generous; the point is that it ends. */
const FIXTURE_BUDGET_MS = 120_000;

function runFixture(fixture: string, extraArgs: string[] = []) {
	// `NODE_TEST_CONTEXT` is set by the runner that is running *this* file. Left
	// in place it makes the nested runner report to a parent that is not
	// listening: it exits 0 with no output, and the fixture silently never runs.
	const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;

	const started = Date.now();
	const result = spawnSync(
		process.execPath,
		// A small default here keeps this file fast; the fixture that needs longer
		// declares its own `{ timeout }`, which overrides the CLI value.
		["--test", "--test-timeout=5000", ...extraArgs, join(FIXTURES, fixture)],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			// The only hard bound available: spawnSync kills the child itself, so
			// this test can never become the thing it is testing against.
			timeout: FIXTURE_BUDGET_MS,
			env: { ...env, CP_LIVE_TESTS: "" },
		},
	);
	return { ...result, elapsedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Class 2: a process that outlives its tests
// ---------------------------------------------------------------------------

test(
	"a leaked rpc session behind a throwing cleanup hook cannot hold the runner open",
	{ timeout: 180_000 },
	() => {
		// Run it the way the suite itself is run. Without `--test-force-exit` this
		// same fixture ran past 120s and had to be killed — that measurement is
		// what justifies the flag being in `package.json`.
		const result = runFixture("leaks-rpc-session.ts", ["--test-force-exit"]);

		// `signal === null` is the assertion that matters: the runner exited on
		// its own rather than being killed by spawnSync's timeout.
		assert.equal(
			result.signal,
			null,
			`the test runner had to be killed after ${result.elapsedMs}ms — a leaked child still wedges the suite\n` +
				`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);

		// It must fail (the cleanup really did throw), not pass by vacuity: a
		// fixture that stopped exercising the broken shape would prove nothing.
		assert.notEqual(result.status, 0, `fixture was supposed to fail:\n${result.stdout}`);
		assert.match(result.stdout, /rm failed/, `fixture did not run the shape under test:\n${result.stdout}`);
	},
);

// ---------------------------------------------------------------------------
// Class 1: a test that hangs inside a test
// ---------------------------------------------------------------------------

test("a test that never resolves is failed by --test-timeout rather than awaited", { timeout: 180_000 }, () => {
	const result = runFixture("hangs-inside-a-test.ts");

	assert.equal(result.signal, null, `--test-timeout did not bound a hanging test (${result.elapsedMs}ms)`);
	assert.notEqual(result.status, 0, "a timed-out test must fail the run");
	assert.match(result.stdout, /test timed out after 5000ms/, `expected a timeout failure:\n${result.stdout}`);
	// 5s timeout + node startup, comfortably inside the budget.
	assert.ok(result.elapsedMs < FIXTURE_BUDGET_MS, `took ${result.elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// The invocation itself
// ---------------------------------------------------------------------------

test("the suite's own invocation is bounded, so no future test can wedge a worker", () => {
	const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	const script = pkg.scripts.test as string;

	const timeout = /--test-timeout=(\d+)/.exec(script);
	assert.ok(timeout, `the test script must set an explicit --test-timeout: ${script}`);
	const ms = Number(timeout[1]);
	// `--test-timeout=0` is the trap: it reads like a value and means "never".
	assert.ok(ms > 0, "--test-timeout=0 disables the timeout entirely — that is what wedged two workers");
	assert.ok(ms <= 900_000, `--test-timeout=${ms} is not a bound anyone would wait out`);

	// Class 2 needs its own flag; the timeout above does nothing for it.
	assert.ok(
		script.includes("--test-force-exit"),
		`the test script must set --test-force-exit, or a leaked handle hangs the suite forever: ${script}`,
	);
});
