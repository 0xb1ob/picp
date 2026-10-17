/**
 * Legacy grant-template helpers (src/schedule-grant.ts), kept read-only for the migrations, and the PR4 pin that no
 * fire mints a grant any more (docs/contracts.md *Native schedule migration*).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { liveFireBounds, synthesizedApproval, templateFromSeed } from "../src/schedule-grant.ts";
import { namesToken } from "../extensions/command-post/tools-schedule.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const T0 = new Date("2026-07-01T06:00:00Z");

test("live bounds: exclusions only grow, tokens clamp to the ceiling, an excluded kind refuses", () => {
	const home = createScratchHome();
	try {
		const s = new MandateStore(home.path, { now: () => T0 }).issue({
			projects: ["demo"], objective: "triage runs", expiry: "2026-07-03T00:00:00Z", spend_cap: { usd: 20, tokens: 2_000_000 }, job_cap: 3,
			at: "2026-07-01T00:00:00Z", schedule_grant: true, allowed_actions: ["plan", "implement"], exclusions: { paths: ["secrets/"], job_kinds: ["ship"] },
		});
		const made = templateFromSeed(s, synthesizedApproval(s, "cp_schedule add"), "2026-07-01T06:00:00Z");
		assert.ok(!("refusal" in made));
		const defaults = { ...loadMandateDefaults(home.path), exclude_paths: [".env"] };
		const live = liveFireBounds(made.template, { defaults, projectOverride: { exclude_paths: ["infra/"] }, ceiling: 500_000 }, "demo", "research", T0);
		assert.ok(!("refusal" in live));
		assert.deepEqual(live.input.exclusions?.paths, ["secrets/", ".env", "infra/"]);
		assert.equal(live.input.spend_cap.tokens, 500_000);
		assert.match(live.notes.join("; "), /clamped to the home's token_ceiling 500000/);
		assert.match(JSON.stringify(liveFireBounds(made.template, { defaults, ceiling: 500_000 }, "demo", "ship", T0)), /excludes ship jobs/);
		assert.match(JSON.stringify(liveFireBounds(made.template, { defaults, ceiling: 0 }, "demo", "research", T0)), /nothing to spend/);
	} finally {
		home.cleanup();
	}
});

test("PR4: no fire mints a grant — only the mandate store writes schedule_fire, and #fireOnce never issues one", () => {
	const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
	const writers = [...files(join(REPO_ROOT, "src")), ...files(join(REPO_ROOT, "extensions"))]
		.filter((file) => /\.ts$/.test(file) && /\bschedule_fire\s*:/.test(readFileSync(file, "utf8")))
		.map((file) => file.slice(REPO_ROOT.length + 1));
	assert.deepEqual(writers.sort(), ["src/contracts/mandates.ts", "src/mandate.ts"]);
	const source = readFileSync(join(REPO_ROOT, "src/scheduler.ts"), "utf8");
	const start = source.indexOf("async #fireOnce(");
	assert.ok(start > 0);
	assert.doesNotMatch(source.slice(start, source.indexOf("\n\t}\n", start)), /\.issue\(|#mint|grant_template/);
	assert.doesNotMatch(source, /async #mint\(|async move\(/, "the mint and move paths are gone");
});

test("run_now names a schedule only as a whole token", () => {
	assert.ok(namesToken("please run nightly now", "nightly", "i"));
	assert.ok(namesToken("Run NIGHTLY.", "nightly", "i"));
	assert.ok(!namesToken("run nightlyish now", "nightly", "i"));
	assert.ok(!namesToken("run sch-abc1234", "sch-abc123", ""));
	assert.ok(namesToken("fire sch-abc123 please", "sch-abc123", ""));
	assert.ok(namesToken("run (a+b) now", "(a+b)", "i"), "regex metacharacters are escaped");
});
