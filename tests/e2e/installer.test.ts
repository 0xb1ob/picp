/**
 * Installer E2E (#375): the one-command bootstrap, cp-install, cp-daemon and the parent's doctor, run for real in a
 * disposable `--network none` Docker sandbox against the mock provider (tests/harness/install-sandbox.ts).
 * Opt-in with CP_INSTALL_E2E=1: CI's install-sandbox job runs it, `npm test` collects and skips it.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { buildImage, dockerUnavailable, formatRun, runScenario, SCENARIOS } from "../harness/install-sandbox.ts";

const skip = process.env.CP_INSTALL_E2E === "1" ? false : "opt-in: CP_INSTALL_E2E=1 (CI's install-sandbox job) or npm run e2e:install";

// Longest measured walls first, so three lanes finish together; SCENARIOS keeps the CLI's order.
const LONGEST_FIRST = ["compat", "rerun", "recovery", "fresh", "node-floor", "login", "root", "onboarding", "prompt", "prerequisites"] as const;
assert.deepEqual([...LONGEST_FIRST].sort(), [...SCENARIOS].sort());

describe("installer sandbox", { skip, concurrency: 3 }, () => {
	before(async () => {
		// A requested run without Docker fails: a silent skip here would be the only coverage going missing.
		assert.equal(dockerUnavailable(), undefined);
		await buildImage();
	}, { timeout: 1_800_000 });

	for (const scenario of LONGEST_FIRST) {
		test(scenario, { timeout: 900_000 }, async (t) => {
			const run = await runScenario(scenario);
			const report = formatRun(run);
			t.diagnostic(report);
			assert.deepEqual(run.result?.failures, [], report);
			assert.equal(run.exit, 0, report);
		});
	}
});
