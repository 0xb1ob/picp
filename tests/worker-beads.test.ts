import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProfile } from "../src/profiles.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

test("a worker never inherits a retired tracker database from the home's .beads or the parent environment", (t) => {
	const root = mkdtempSync(join(tmpdir(), "worker-beads-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home"), worktree = join(root, "worktree");
	for (const path of [home, worktree, join(home, ".beads")]) mkdirSync(path, { recursive: true });
	writeFileSync(join(home, ".beads/beads.db"), "");
	const parentEnv = { ...process.env, BEADS_DIR: "/stale/.beads", BEADS_DB: "/stale/.beads/beads.db" };
	const manager = new WorkerManager({ home, parentEnv, workerReporterPath: WORKER_REPORTER_EXTENSION });
	const env = manager.plan({
		identity: { jobId: "cp-beads", kind: "ship" as const, delivery: "pr" as const, runDir: join(home, LAYOUT.runs, "cp-beads"), worktree },
		profile: loadProfile(join(REPO_ROOT, "profiles"), "implementer"), model: "mock/unused",
	}).env;
	assert.equal(env.BEADS_DIR, undefined, "neither the home's .beads nor a parent BEADS_DIR is inherited");
	assert.equal(env.BEADS_DB, undefined);
});
