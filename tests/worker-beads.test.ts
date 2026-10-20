import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProfile } from "../src/profiles.ts";
import { referencedMaterial } from "../src/task-references.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

test("a worker's BEADS_DIR comes only from dispatch, never the home's .beads or the parent environment", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "worker-beads-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home"), worktree = join(root, "worktree"), project = join(root, "project", ".beads");
	for (const path of [home, worktree, project, join(home, ".beads")]) mkdirSync(path, { recursive: true });
	writeFileSync(join(home, ".beads/beads.db"), "");
	const parentEnv = { ...process.env, BEADS_DIR: "/stale/.beads", BEADS_DB: "/stale/.beads/beads.db" };
	const manager = new WorkerManager({ home, parentEnv, workerReporterPath: WORKER_REPORTER_EXTENSION });
	const request = {
		identity: { jobId: "cp-beads", kind: "ship" as const, delivery: "pr" as const, runDir: join(home, LAYOUT.runs, "cp-beads"), worktree },
		profile: loadProfile(join(REPO_ROOT, "profiles"), "implementer"), model: "mock/unused",
	};
	const env = manager.plan(request).env;
	assert.equal(env.BEADS_DIR, undefined, "neither the home's .beads nor a parent BEADS_DIR is inherited");
	assert.equal(env.BEADS_DB, undefined);
	assert.equal(manager.plan({ ...request, extraEnv: { BEADS_DIR: project } }).env.BEADS_DIR, project);
	assert.equal(await referencedMaterial({ task: "Read the requirements", prefix: "reference", home, clone: worktree, worktree }), "", "no BEADS_DIR line without a project database");
	const material = await referencedMaterial({ task: "Read the requirements", prefix: "reference", home, clone: worktree, worktree, beadsDb: join(project, "beads.db") });
	assert.match(material, /## Referenced material/);
	assert.ok(material.includes(join(project, "beads.db")));
	assert.match(material, /BEADS_DIR/);
	assert.match(material, /read-only/);

	await t.test("br CLI reads the project's database from the worktree", (t) => {
		const brEnv = { ...process.env };
		delete brEnv.BEADS_DIR;
		delete brEnv.BEADS_DB;
		try {
			execFileSync("br", ["--version"], { stdio: "ignore", env: brEnv });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return t.skip("br must be on PATH");
			throw error;
		}
		const projectRoot = join(root, "project");
		execFileSync("br", ["init", "--prefix", "reference"], { cwd: projectRoot, env: brEnv });
		const created = JSON.parse(execFileSync("br", ["create", "Project requirement", "--description", "Read this from the lease", "--json"], { cwd: projectRoot, env: brEnv, encoding: "utf8" }));
		const shown = JSON.parse(execFileSync("br", ["show", created.id, "--json", "--no-auto-import", "--no-auto-flush"], { cwd: worktree, env: manager.plan({ ...request, extraEnv: { BEADS_DIR: project } }).env, encoding: "utf8" }));
		assert.equal(shown[0].description, "Read this from the lease");
	});
});
