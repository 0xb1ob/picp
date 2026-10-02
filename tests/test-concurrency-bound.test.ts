/**
 * cp-4wz: the suite's own internal concurrency multiplies against the fleet's.
 *
 * cp-diffgate-teardown-gate-btd's first post-rebase `npm test` failed with 12
 * timeouts at a host load average of ~240 while 7 workers shared the machine.
 * A clean re-run of the exact same commit, alone, was fully green (765 pass, 0
 * fail). Nothing was wrong with the code; the failures were the suite's own
 * wall-clock budgets losing a race against CPU contention that the suite
 * itself was making worse.
 *
 * `node --test`, given multiple files, runs them concurrently by default —
 * measured on this 12-core box, four trivial fixture files ran fully in
 * parallel with no flag at all (`availableParallelism() - 1` is the documented
 * default). This repo has ~40 test files, several of which spawn real `pi`
 * subprocesses. Left uncapped, a *single* worker's `npm test` already
 * saturates the box; multiply that by up to 10 workers (the fleet's spawn
 * cap, cp-qvw) and the box gets nowhere near enough scheduler time per
 * process, which is exactly what a load average of ~240 on ~12 cores means.
 *
 * The fix is `--test-concurrency` in the `test` script: it bounds how many
 * test *files* run at once within a single `npm test` invocation, which
 * bounds each worker's own contribution to system load without touching any
 * individual test's timeout value and without serializing the fleet (unlike
 * a host-wide lock, every worker still runs its own suite independently — it
 * is just less parallel internally). This file proves two things about that
 * choice:
 *
 *   1. the flag is present, bounded, and actually throttles concurrent test
 *      files (not just "not unlimited") — without needing 7 real workers.
 *   2. lowering internal concurrency does not blunt genuine timeout
 *      detection: a test that really hangs still fails, at the same
 *      concurrency setting the suite ships with.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "./harness/index.ts";

const FIXTURES = join(REPO_ROOT, "tests/fixtures");
const FIXTURE_BUDGET_MS = 120_000;

function packageTestScript(): string {
	const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	return pkg.scripts.test as string;
}

function configuredConcurrency(): number {
	const match = /--test-concurrency=(\d+)/.exec(packageTestScript());
	assert.ok(match, `the test script must set an explicit --test-concurrency: ${packageTestScript()}`);
	return Number(match[1]);
}

// ---------------------------------------------------------------------------
// 1. the flag is present, sane, and actually bounds concurrent files
// ---------------------------------------------------------------------------

test("the suite's own invocation caps internal test-file concurrency", () => {
	const n = configuredConcurrency();
	assert.ok(n >= 1, "--test-concurrency=0 is not a bound anyone would recognize");
	// Generous enough that a single, unshared worker is still fast; small
	// enough that the fleet's own spawn cap (10, cp-qvw) times this number
	// stays well clear of the ~240 load average that was actually observed.
	assert.ok(n <= 6, `--test-concurrency=${n} barely throttles anything below node's own default here`);
});

test(
	"--test-concurrency actually bounds how many fixture files run at once",
	{ timeout: FIXTURE_BUDGET_MS },
	() => {
		const n = configuredConcurrency();
		const scratch = mkdtempSync(join(tmpdir(), "cp-concurrency-"));
		const logPath = join(scratch, "log.csv");
		writeFileSync(logPath, "");

		const fixtureSrc = readFileSync(join(FIXTURES, "sleep-and-record.ts"), "utf8");
		// More files than the configured concurrency, so a true bound is
		// observable: if the runner ran them all at once, this test would see
		// more concurrent files than `n` at some instant.
		const fileCount = n + 4;
		const files: string[] = [];
		for (let i = 0; i < fileCount; i += 1) {
			const path = join(scratch, `sleep-${i}.ts`);
			writeFileSync(path, fixtureSrc);
			files.push(path);
		}

		try {
			const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
			const result = spawnSync(
				process.execPath,
				["--test", `--test-concurrency=${n}`, "--test-timeout=30000", "--test-force-exit", ...files],
				{
					cwd: REPO_ROOT,
					encoding: "utf8",
					timeout: FIXTURE_BUDGET_MS,
					env: { ...env, CP_CONCURRENCY_LOG: logPath, CP_LIVE_TESTS: "" },
				},
			);
			assert.equal(result.signal, null, `fixture run had to be killed:\nstdout:\n${result.stdout}`);
			assert.equal(result.status, 0, `fixture files were supposed to pass:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

			const lines = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [event, label, ts] = line.split(",");
					return { event: event as "start" | "end", label, ts: Number(ts) };
				});
			assert.equal(lines.length, fileCount * 2, `expected a start+end pair per file, got:\n${JSON.stringify(lines)}`);

			// Sweep-line: at every start/end instant, count files with a start
			// seen and no matching end yet.
			const active = new Set<string>();
			let maxConcurrent = 0;
			for (const { event, label } of lines.sort((a, b) => a.ts - b.ts)) {
				const key = label ?? "";
				if (event === "start") active.add(key);
				else active.delete(key);
				maxConcurrent = Math.max(maxConcurrent, active.size);
			}

			assert.ok(
				maxConcurrent <= n,
				`--test-concurrency=${n} did not bound the run: saw ${maxConcurrent} files active at once`,
			);
			assert.ok(
				maxConcurrent > 1,
				`expected genuine parallelism up to the bound, saw only ${maxConcurrent} concurrent file(s) — ` +
					"the assertion above would pass vacuously if the runner just serialized everything",
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	},
);

// ---------------------------------------------------------------------------
// 2. lowering concurrency does not blunt genuine timeout detection
// ---------------------------------------------------------------------------

test(
	"a test that genuinely hangs still fails at the suite's configured concurrency",
	{ timeout: FIXTURE_BUDGET_MS },
	() => {
		const n = configuredConcurrency();
		const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
		const started = Date.now();
		const result = spawnSync(
			process.execPath,
			["--test", `--test-concurrency=${n}`, "--test-timeout=5000", "--test-force-exit", join(FIXTURES, "hangs-inside-a-test.ts")],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				timeout: FIXTURE_BUDGET_MS,
				env: { ...env, CP_LIVE_TESTS: "" },
			},
		);
		const elapsedMs = Date.now() - started;

		assert.equal(result.signal, null, `the run had to be killed after ${elapsedMs}ms`);
		assert.notEqual(result.status, 0, `a genuinely hanging test must still fail the run:\n${result.stdout}`);
		assert.match(
			result.stdout,
			/test timed out after 5000ms/,
			`lowering concurrency must not mask a real hang:\n${result.stdout}`,
		);
	},
);
