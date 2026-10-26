/**
 * P11d: the two tests/pipeline.test.ts units no product surface reaches (docs/testing-migration/p11d.md names why);
 * every other case is tests/e2e/pipeline-run.test.ts or tests/e2e/pipeline-diff-gate.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, SCHEMA_VERSION } from "../src/contracts.ts";
import { type PipelineOptions, PipelineRunner, PipelineStore } from "../src/pipeline.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

/** Any dependency this path must not touch. Touching it fails the test. */
function forbidden(name: string): never {
	return new Proxy({}, { get: (_target, property) => { throw new Error(`the diff gate reached ${name}.${String(property)} — it must not`); } }) as never;
}

// CommandPost.pipeline() always wires `review: () => this.diffReviewModule()`, so no product runner lacks a reviewer.
test("diff gate: opted in with nothing that can review holds short of done and names the fix", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const at = isoTimestamp();
	const store = new PipelineStore(home.path);
	store.write({ schema_version: SCHEMA_VERSION, research_id: "cp-dg-unwired-research", ship_id: "cp-dg-unwired-ship", project: "demo",
		delivery: "pr", state: "implementing", created_at: at, updated_at: at, review: { enabled: true } });
	const shipJob = { job_id: "cp-dg-unwired-ship", project: "demo", kind: "ship", branch: "cp-dg-unwired-ship", phase: "held", reported_at: at };
	const unwired = new PipelineRunner({ home: home.path, fleet: { get: (jobId: string) => (jobId === shipJob.job_id ? shipJob : undefined) },
		ledger: forbidden("ledger"), dispatcher: () => forbidden("dispatcher"), gate: () => forbidden("gate"), artifacts: forbidden("artifacts"),
		teardown: forbidden("teardown") } as unknown as PipelineOptions);
	const held = await unwired.advance("cp-dg-unwired-research");
	assert.notEqual(held.state, "done", "an opt-in gate is never waved through");
	assert.equal(held.next, "wait");
	assert.match(held.message, /cp_review cp-dg-unwired-ship/);
	assert.equal(store.require("cp-dg-unwired-research").state, "implementing");
});

test("diff gate: the ladder is nextAction's, imported verbatim and never restated", () => {
	const source = readFileSync(join(REPO_ROOT, "src/pipeline.ts"), "utf8");
	const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*"\.\/gate\.ts";/.exec(source);
	assert.ok(importBlock, "src/pipeline.ts must import its verdict ladder from ./gate.ts");
	assert.match(importBlock[1] as string, /\bnextAction\b/);
	assert.doesNotMatch(source, /function nextAction\b/, "nextAction must not be re-declared in src/pipeline.ts");
});
