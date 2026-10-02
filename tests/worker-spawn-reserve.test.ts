import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_BUDGET_CONFIG } from "../src/contracts.ts";
import { loadProfile } from "../src/profiles.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { createScratchHome, REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

test("held workers at the cap leave a bounded reserve for review and gate", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		budget: { ...DEFAULT_BUDGET_CONFIG, spawn_cap: 2 },
		piBin: join(REPO_ROOT, "tests/fixtures/fake-drain-worker.mjs"),
	});
	t.after(async () => {
		await manager.shutdownAll();
		home.cleanup();
	});
	const spawn = (key: string, profileName: string) => manager.spawn({
		key,
		identity: {
			jobId: key.split("#")[0]!, kind: "ship", delivery: "pr",
			worktree: home.path, runDir: home.path,
			// Caller identity cannot grant access to the reserve.
			role: "gate-reviewer",
		},
		profile: loadProfile(join(REPO_ROOT, "profiles"), profileName),
		model: "mock/unused",
		extraArgs: ["--no-session"],
	});
	for (const key of ["cp-held1", "cp-held2"]) {
		const managed = spawn(key, "implementer");
		await managed.worker.getState(15_000);
		const settled = managed.worker.waitForSettled(15_000);
		await managed.worker.prompt("finish");
		await settled;
	}
	assert.deepEqual(manager.quiesce(), { active: 2, busy: [] });
	for (const profile of ["implementer", "planner", "qa"]) {
		assert.throws(() => spawn(`cp-other#review-${profile}`, profile), /spawn cap reached/);
	}

	// These are the profile and slot shapes used by cp_review and cp_gate.
	spawn("cp-held1#review-1", "gate-reviewer");
	spawn("cp-held2#gate-1", "gate-reviewer");
	spawn("cp-held1#quality-1", "gate-reviewer");
	assert.equal(manager.active.length, 5);
	assert.throws(() => spawn("cp-held1#review-1", "gate-reviewer"), /already has a live worker/);
	assert.throws(() => spawn("cp-held2#review-2", "gate-reviewer"), /review reserve exhausted.*5\/5/);
	assert.throws(() => spawn("cp-fresh", "implementer"), /spawn cap reached.*reserved for gate-reviewer/);

	await manager.shutdown("cp-held1#review-1");
	spawn("cp-held2#review-2", "gate-reviewer");
	assert.equal(manager.active.length, 5, "observed reviewer close frees reserve capacity");
});
